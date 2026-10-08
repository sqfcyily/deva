import { app, ipcMain, type BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ImagePart, ToolSpec } from '../providers/types'
import { prepareImage, sniffImageMime } from './image-read'
import type { ToolResult } from './tools'
import { registerMcpToolNames, unregisterMcpToolNames } from './tools'
import {
  deleteServer,
  getServerConfig,
  isEnabled,
  listServerConfigs,
  missingSecrets,
  onMcpConfigChange,
  resolveEnv,
  resolveHeaders,
  setEnabled,
  upsertServer,
  type McpServerConfig,
  type McpServerInput
} from './mcp-config'
import { hasSecret, setSecret } from './secrets'

/**
 * MCP 主机 / 客户端管理器（全部运行于主进程）。
 *
 * 职责：连接生命周期（stdio 子进程 / SSE / Streamable-HTTP）、工具发现、**命名空间化**、
 * `dispatchMcpTool` 路由、状态广播。发现到的工具并入 Agent 工具表（每轮 `getMcpToolSpecs()`），
 * 默认走 `ask` 权限闸门（tools.ts 的 `toolCategory` 已把注册过的 MCP 名归为 `mcp` 类）。
 *
 * 安全铁律：
 * - **结果恒作数据**：`tool_result` 一律当惰性数据（文本，外加图片块）回灌，不解析其中任何控制信号（防提示注入）。
 * - **失败降级绝不崩主进程**：ENOENT / 超时 / 鉴权失败 → `status='error'` + 明确中文 `lastError`。
 * - 子进程 spawn、密钥解密只在此层发生；命名空间名强制 `^[A-Za-z0-9_-]{1,64}$`（各家 API 通用约束）。
 */

/**
 * 运行期状态。用户只操作「启用」一个开关，连接由 `reconcile` 兑现，状态只读展示：
 * disconnected=未启用；needs_config=配置不完整；needs_secret=缺密钥（不起进程）；
 * connecting / connected / error=连接中 / 已连接 / 失败（可重试）。
 */
export type McpStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'needs_config'
  | 'needs_secret'

/** 发现到的单个工具：命名空间化名 + 原始名 + Agent 工具规格。 */
interface McpToolInfo {
  fqName: string
  origName: string
  spec: ToolSpec
}

/** 单个服务的运行期状态（不落盘；随连接/断开变化）。 */
interface Runtime {
  status: McpStatus
  toolCount: number
  lastError: string | null
  tools: McpToolInfo[]
  client: Client | null
  /** 连接代次：使过期连接的异步回调失效，避免污染新状态。 */
  gen: number
  /** needs_secret 时缺的字段名（env 变量名 / 请求头名）。 */
  missingSecrets: string[]
  /** 本次连上的时刻（判断断开前是否「稳定运行过」，决定自动重连计数是否清零）。 */
  connectedAt: number
}

/** 回渲染层的合并视图（配置 + 启用态 + 运行期状态）。 */
export interface McpServerView extends McpServerConfig {
  enabled: boolean
  scope: 'global'
  source: 'custom'
  status: McpStatus
  toolCount: number
  lastError: string | null
  missingSecrets: string[]
  /** 已发现工具的展示清单（原始名 + 命名空间化名 + 描述）。 */
  tools: { name: string; fqName: string; description: string }[]
}

const runtimes = new Map<string, Runtime>()
/** 命名空间名 → 目标服务 + 原始工具名（dispatchMcpTool 路由用）。 */
const routes = new Map<string, { serverId: string; origName: string }>()
/** 单调递增的连接代次发号器。 */
let genCounter = 0
/** 每服务的对账票号：对账中途（等密钥预检）被更晚的对账取代则放弃决策。 */
const tickets = new Map<string, number>()
/** 配置 / 密钥变更的防抖对账定时器（编辑框逐键落盘，不能每键都拉起一次子进程）。 */
const debounces = new Map<string, ReturnType<typeof setTimeout>>()
/** 意外断开后的自动重连进度。 */
const retries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> | null }>()
/** 应用退出中：不再发起任何连接。 */
let shuttingDown = false

const CONNECT_TIMEOUT = 30_000
const DISPATCH_TIMEOUT = 60_000
const TEXT_CAP = 30_000
const RECONCILE_DEBOUNCE = 800
/** 自动重连：首次 1s，逐次翻倍；远程最多 5 次，stdio 最多 2 次（进程反复崩溃时别一直拉起）。 */
const RETRY_BASE = 1_000
const RETRY_MAX_REMOTE = 5
const RETRY_MAX_STDIO = 2
/** 连上后稳定运行超过此时长才断开 → 视为新故障，重连计数清零。 */
const STABLE_MS = 60_000

let sendStatus: (view: McpServerView) => void = () => {}

// ── 命名空间化 ──────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  const out = s.replace(/[^A-Za-z0-9_-]/g, '_')
  return out || '_'
}

/** 4 位稳定短哈希（截断时防碰撞）。 */
function hash4(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 4).padStart(4, '0')
}

/** `sanitize(id)__sanitize(tool)`，强制 `^[A-Za-z0-9_-]{1,64}$`；超长截断+hash，同名加 `_n`。 */
function makeFqName(serverId: string, toolName: string, used: Set<string>): string {
  let base = `${sanitize(serverId)}__${sanitize(toolName)}`
  if (base.length > 64) base = `${base.slice(0, 59)}_${hash4(base)}`
  let name = base
  let n = 2
  while (used.has(name)) {
    const suffix = `_${n++}`
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`
  }
  used.add(name)
  return name
}

// ── 视图构建 ────────────────────────────────────────────────────────────────

function viewOf(cfg: McpServerConfig): McpServerView {
  const rt = runtimes.get(cfg.id)
  return {
    ...cfg,
    enabled: isEnabled(cfg.id),
    scope: 'global',
    source: 'custom',
    status: rt?.status ?? 'disconnected',
    toolCount: rt?.toolCount ?? 0,
    lastError: rt?.lastError ?? null,
    missingSecrets: rt?.missingSecrets ?? [],
    tools:
      rt?.tools.map((t) => ({
        name: t.origName,
        fqName: t.fqName,
        description: t.spec.description
      })) ?? []
  }
}

function broadcast(id: string): void {
  const cfg = getServerConfig(id)
  if (cfg) sendStatus(viewOf(cfg))
}

export function listServers(): McpServerView[] {
  return listServerConfigs().map(viewOf)
}

// ── 连接 / 断开 ──────────────────────────────────────────────────────────────

function toSpec(cfg: McpServerConfig, fqName: string, t: Tool): ToolSpec {
  const base = (t.description ?? '').trim()
  const desc = `[MCP:${cfg.name}] ${base || t.name}`.slice(0, 1024)
  const schema =
    t.inputSchema && typeof t.inputSchema === 'object'
      ? (t.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} }
  return { name: fqName, description: desc, inputSchema: schema }
}

async function buildTransport(cfg: McpServerConfig): Promise<Transport> {
  if (cfg.transport === 'stdio') {
    const command = (cfg.command ?? '').trim()
    if (!command) throw new Error('未配置启动命令（command）')
    const env = await resolveEnv(cfg)
    const hasEnv = Object.keys(env).length > 0
    // 传 env 会**替换**（而非合并）默认安全 env，故须并入 getDefaultEnvironment（含 PATH，否则 npx/node 找不到）。
    return new StdioClientTransport({
      command,
      args: cfg.args ?? [],
      env: hasEnv ? { ...getDefaultEnvironment(), ...env } : undefined,
      stderr: 'ignore'
    })
  }
  const url = (cfg.url ?? '').trim()
  if (!url) throw new Error('未配置服务地址（url）')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`服务地址无效：${url}`)
  }
  const headers = await resolveHeaders(cfg)
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined
  if (cfg.transport === 'sse') {
    return new SSEClientTransport(parsed, { requestInit })
  }
  return new StreamableHTTPClientTransport(parsed, { requestInit })
}

/** 把底层错误映射为明确的中文提示（绝不把栈/英文原文直接示人）。 */
function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  if (/ENOENT/i.test(msg))
    return '找不到启动命令（ENOENT）：请检查 command 是否已安装、是否在系统 PATH 中。'
  if (/EACCES/i.test(msg)) return '无权限执行启动命令（EACCES）：请检查文件权限。'
  if (/ECONNREFUSED/i.test(msg))
    return '连接被拒绝：请检查服务地址与端口是否正确、服务是否已启动。'
  if (/ETIMEDOUT|timed?\s*out|timeout/i.test(msg)) return '连接超时：服务无响应，请检查地址或稍后重试。'
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return '无法解析服务地址：请检查域名是否正确、网络是否可用。'
  if (/\b401\b|\b403\b|Unauthorized|Forbidden/i.test(msg))
    return '鉴权失败（401/403）：请检查密钥 / 令牌是否正确、是否已配置。'
  return `连接失败：${msg}`
}

/** 配置是否足以发起连接；不足则返回说明（→ needs_config，不当作连接失败）。 */
function configProblem(cfg: McpServerConfig): string | null {
  if (cfg.transport === 'stdio') return (cfg.command ?? '').trim() ? null : '未配置启动命令（command）。'
  const url = (cfg.url ?? '').trim()
  if (!url) return '未配置服务地址（url）。'
  try {
    new URL(url)
  } catch {
    return `服务地址无效：${url}`
  }
  return null
}

/** 撤下某运行态已注册的工具名与路由（不改状态）。 */
function dropTools(rt: Runtime): void {
  unregisterMcpToolNames(rt.tools.map((t) => t.fqName))
  for (const t of rt.tools) routes.delete(t.fqName)
}

/**
 * 同步切到一个非连接态：bump 代次（使在途连接与 onclose 失效）、撤工具，再异步关旧 client。
 * 状态在调用当刻即生效，故后发的对账总能盖过先发的。
 */
function settle(
  id: string,
  status: Exclude<McpStatus, 'connecting' | 'connected'>,
  lastError: string | null = null,
  missing: string[] = []
): void {
  const old = runtimes.get(id)
  if (old) dropTools(old)
  runtimes.set(id, {
    status,
    toolCount: 0,
    lastError,
    tools: [],
    client: null,
    gen: ++genCounter,
    missingSecrets: missing,
    connectedAt: 0
  })
  broadcast(id)
  void old?.client?.close().catch(() => {})
}

/** 建立连接并发现工具；成败都只落状态、绝不抛错。返回是否连上。 */
async function connect(id: string, cfg: McpServerConfig): Promise<boolean> {
  const old = runtimes.get(id)
  if (old) dropTools(old)
  const myGen = ++genCounter
  const rt: Runtime = {
    status: 'connecting',
    toolCount: 0,
    lastError: null,
    tools: [],
    client: null,
    gen: myGen,
    missingSecrets: [],
    connectedAt: 0
  }
  runtimes.set(id, rt)
  broadcast(id)
  if (old?.client) await old.client.close().catch(() => {})
  // 任一 await 之后都可能已被更晚的对账 / 断开取代 → 放弃本次结果（不注册工具、关掉自己的 client）。
  const stale = (): boolean => runtimes.get(id)?.gen !== myGen
  if (stale()) return false

  let client: Client | null = null
  try {
    const transport = await buildTransport(cfg)
    if (stale()) return false
    const c = new Client({ name: 'deva', version: app.getVersion() }, { capabilities: {} })
    client = c
    // 意外断开（子进程退出 / 网络掉线）→ 置 error、撤工具，并按退避自动重连。
    c.onclose = (): void => {
      const cur = runtimes.get(id)
      if (!cur || cur.gen !== myGen || cur.status !== 'connected') return
      const lived = Date.now() - cur.connectedAt
      cur.client = null
      settle(id, 'error', '连接已断开（服务进程退出或网络中断）。')
      scheduleRetry(id, lived)
    }

    await c.connect(transport, { timeout: CONNECT_TIMEOUT })
    if (stale()) {
      await c.close().catch(() => {})
      return false
    }
    const listed = await c.listTools()
    if (stale()) {
      await c.close().catch(() => {})
      return false
    }

    const used = new Set<string>()
    const tools: McpToolInfo[] = []
    for (const t of listed.tools) {
      const fqName = makeFqName(id, t.name, used)
      tools.push({ fqName, origName: t.name, spec: toSpec(cfg, fqName, t) })
    }
    rt.client = c
    rt.tools = tools
    rt.toolCount = tools.length
    rt.status = 'connected'
    rt.lastError = null
    rt.connectedAt = Date.now()
    registerMcpToolNames(tools.map((t) => t.fqName))
    for (const t of tools) routes.set(t.fqName, { serverId: id, origName: t.origName })
    broadcast(id)
    return true
  } catch (e) {
    // 已起的 client（如 listTools 失败时子进程仍在）一并关掉，免留孤儿进程。
    void client?.close().catch(() => {})
    if (stale()) return false
    rt.status = 'error'
    rt.lastError = friendlyError(e)
    broadcast(id)
    return false
  }
}

/**
 * 对账——连接的唯一入口：让运行态与「期望」一致。
 * 期望 = 已启用 且 配置完整 且 密钥齐全 → 连上（已连则按最新配置重连）；否则落到对应的非连接态。
 * 因此「未启用却已连接」不可能出现，「启用了却没连」也总有可见原因（待配置 / 待填密钥 / 失败）。
 * `keepRetry` 仅供自动重连自身调用（保留重试计数）；用户操作 / 配置变更一律清零重来。
 */
async function reconcile(id: string, keepRetry = false): Promise<boolean> {
  cancelDebounce(id)
  if (!keepRetry) clearRetry(id)
  const ticket = (tickets.get(id) ?? 0) + 1
  tickets.set(id, ticket)
  if (shuttingDown) return false

  const cfg = getServerConfig(id)
  if (!cfg) {
    forget(id)
    return false
  }
  if (!isEnabled(id)) {
    settle(id, 'disconnected')
    return false
  }
  const problem = configProblem(cfg)
  if (problem) {
    settle(id, 'needs_config', problem)
    return false
  }
  const missing = await missingSecrets(cfg)
  if (tickets.get(id) !== ticket || shuttingDown) return false
  if (missing.length) {
    settle(id, 'needs_secret', null, missing)
    return false
  }
  return connect(id, cfg)
}

function cancelDebounce(id: string): void {
  const t = debounces.get(id)
  if (t) clearTimeout(t)
  debounces.delete(id)
}

/** 防抖对账（配置 / 密钥逐键落盘时用）。 */
function scheduleReconcile(id: string): void {
  cancelDebounce(id)
  debounces.set(
    id,
    setTimeout(() => {
      debounces.delete(id)
      void reconcile(id)
    }, RECONCILE_DEBOUNCE)
  )
}

function clearRetry(id: string): void {
  const r = retries.get(id)
  if (r?.timer) clearTimeout(r.timer)
  retries.delete(id)
}

/**
 * 意外断开后按退避自动重连。刚连上就断则累计次数（防「崩溃—拉起」死循环），
 * 稳定运行过 STABLE_MS 再断则清零重计。用尽次数后停在 error，等用户点「重试」。
 */
function scheduleRetry(id: string, livedMs: number): void {
  const cfg = getServerConfig(id)
  if (!cfg || !isEnabled(id) || shuttingDown) return
  const r = retries.get(id) ?? { attempt: 0, timer: null }
  if (livedMs >= STABLE_MS) r.attempt = 0
  const max = cfg.transport === 'stdio' ? RETRY_MAX_STDIO : RETRY_MAX_REMOTE
  const rt = runtimes.get(id)
  if (r.attempt >= max) {
    retries.delete(id)
    if (rt) {
      rt.lastError = `${rt.lastError ?? '连接已断开。'}（已自动重连 ${max} 次仍未成功）`
      broadcast(id)
    }
    return
  }
  const delay = RETRY_BASE * 2 ** r.attempt
  r.attempt++
  retries.set(id, r)
  if (rt) {
    rt.lastError = `${rt.lastError ?? '连接已断开。'}${delay / 1000} 秒后自动重连（第 ${r.attempt}/${max} 次）…`
    broadcast(id)
  }
  r.timer = setTimeout(() => {
    r.timer = null
    void reconcile(id, true).then((ok) => {
      if (!ok && runtimes.get(id)?.status === 'error') scheduleRetry(id, 0)
    })
  }, delay)
}

/** 彻底撤掉某服务的运行态（删除服务时）：作废在途对账 / 定时器，撤工具，关 client。 */
function forget(id: string): void {
  tickets.set(id, (tickets.get(id) ?? 0) + 1)
  cancelDebounce(id)
  clearRetry(id)
  const rt = runtimes.get(id)
  if (!rt) return
  rt.gen = ++genCounter
  dropTools(rt)
  runtimes.delete(id)
  void rt.client?.close().catch(() => {})
}

// 配置写入层的变更 → 对账：启停立即兑现；连接字段变更防抖（未启用则无需理会）。
onMcpConfigChange((id, change) => {
  if (change.enabled) void reconcile(id)
  else if (change.connection && isEnabled(id)) scheduleReconcile(id)
})

/** 断开全部（app 退出时清理 stdio 子进程，避免遗留孤儿进程）。此后不再发起任何连接。 */
export async function disconnectAllServers(): Promise<void> {
  shuttingDown = true
  for (const t of debounces.values()) clearTimeout(t)
  debounces.clear()
  for (const r of retries.values()) if (r.timer) clearTimeout(r.timer)
  retries.clear()
  const closing: Promise<void>[] = []
  for (const rt of runtimes.values()) {
    rt.gen = ++genCounter
    dropTools(rt)
    if (rt.client) closing.push(rt.client.close().catch(() => {}))
    rt.client = null
    rt.status = 'disconnected'
    rt.tools = []
    rt.toolCount = 0
  }
  await Promise.all(closing)
}

/** 启动时对账所有「已启用」的服务（失败各自降级，不互相阻塞）。 */
export function autoConnectEnabledServers(): void {
  for (const cfg of listServerConfigs()) {
    if (isEnabled(cfg.id)) void reconcile(cfg.id)
  }
}

// ── 工具分发 ────────────────────────────────────────────────────────────────

/** 本轮可用的全部 MCP 工具规格（仅已连接服务贡献；供 chat.ts 每轮合并进工具表）。 */
export function getMcpToolSpecs(): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const rt of runtimes.values()) {
    if (rt.status === 'connected') for (const t of rt.tools) specs.push(t.spec)
  }
  return specs
}

/** MCP 调用返回结构（只取所需字段，避免深耦合 SDK 联合类型）。 */
interface RawCallResult {
  content?: unknown
  isError?: boolean
}

/** 单次 MCP 结果最多附带的图片数（防止失控的服务一次塞满上下文）。 */
const MAX_RESULT_IMAGES = 8

/** MCP 图片块 → 可发送的 ImagePart；无数据 / 不认得 / 超限只给占位说明。 */
function mcpImage(block: Record<string, unknown>): { part?: ImagePart; note: string } {
  const declared = typeof block.mimeType === 'string' ? block.mimeType : 'image'
  if (typeof block.data !== 'string') return { note: `[图片内容：${declared}，无数据，已省略]` }
  const buf = Buffer.from(block.data, 'base64')
  // 以魔数为准：服务声明的 mimeType 与字节不符时，照发会被服务商 400。
  const mime = sniffImageMime(buf)
  if (!mime) return { note: `[图片内容：${declared}，格式不受支持，已省略]` }
  const img = prepareImage(buf, mime)
  if (!img.ok) return { note: `[图片内容：${declared}，${img.reason}，已省略]` }
  return { part: img.part, note: `[图片：${mime}，已随本结果附上]` }
}

/** 展平 MCP 的 content[]（文本拼接；图片随结果附上，其余非文本内容以占位符表示）；文本上限 TEXT_CAP。 */
function flattenResult(result: RawCallResult): ToolResult {
  const parts: string[] = []
  const images: ImagePart[] = []
  if (Array.isArray(result.content)) {
    for (const b of result.content) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'image') {
        if (images.length >= MAX_RESULT_IMAGES) {
          parts.push(`[图片内容：超过单次 ${MAX_RESULT_IMAGES} 张上限，已省略]`)
          continue
        }
        const { part, note } = mcpImage(block)
        if (part) images.push(part)
        parts.push(note)
      } else if (block.type === 'audio') parts.push('[音频内容，已省略]')
      else if (block.type === 'resource_link') parts.push(`[资源链接：${(block.uri as string) ?? ''}]`)
      else if (block.type === 'resource') {
        const r = block.resource as { text?: unknown; uri?: unknown } | undefined
        if (r && typeof r.text === 'string') parts.push(r.text)
        else parts.push(`[资源：${(r?.uri as string) ?? ''}]`)
      }
    }
  }
  let text = parts.join('\n').trim() || '（工具返回空内容）'
  let cut = false
  if (text.length > TEXT_CAP) {
    text = text.slice(0, TEXT_CAP)
    cut = true
  }
  const isError = result.isError === true
  return {
    content: text + (cut ? `\n…（内容过长已截断，上限 ${TEXT_CAP} 字符）` : ''),
    summary: isError ? '返回错误' : parts.length ? `${parts.length} 段内容` : '已返回',
    isError,
    ...(images.length ? { images } : {})
  }
}

/**
 * 调用一个命名空间化的 MCP 工具。带 60s 超时与取消信号；**结果恒作数据**回传。
 * 服务已断开 / 未连接 / 调用失败 → 返回 isError 的 tool_result（父轮据此继续，绝不崩）。
 */
export async function dispatchMcpTool(
  fqName: string,
  args: unknown,
  signal?: AbortSignal
): Promise<ToolResult> {
  const route = routes.get(fqName)
  if (!route)
    return { content: `MCP 工具「${fqName}」不可用（服务可能已断开）。`, summary: '工具不可用', isError: true }
  const rt = runtimes.get(route.serverId)
  if (!rt || !rt.client || rt.status !== 'connected')
    return { content: `MCP 服务未连接，无法调用「${route.origName}」。`, summary: '未连接', isError: true }

  try {
    const result = (await rt.client.callTool(
      { name: route.origName, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { signal, timeout: DISPATCH_TIMEOUT }
    )) as RawCallResult
    return flattenResult(result)
  } catch (e) {
    if (signal?.aborted) return { content: '调用已中止。', summary: '已中止', isError: true }
    const msg = (e as Error)?.message ?? String(e)
    return { content: `MCP 工具调用失败：${msg}`, summary: '调用失败', isError: true }
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────

export function registerMcpIpc(getWindow: () => BrowserWindow | null): void {
  sendStatus = (view): void => {
    getWindow()?.webContents.send('mcp:status', view)
  }

  ipcMain.handle('mcp:list', (): McpServerView[] => listServers())
  ipcMain.handle('mcp:get', (_e, id: string): McpServerConfig | null => getServerConfig(id))
  ipcMain.handle('mcp:upsert', (_e, input: McpServerInput): McpServerConfig => upsertServer(input))
  ipcMain.handle('mcp:remove', (_e, id: string): { ok: true } => {
    forget(id)
    deleteServer(id)
    return { ok: true }
  })
  // 启停即兑现：setEnabled 经配置变更通知触发对账（连上 / 断开）。
  ipcMain.handle('mcp:set-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setEnabled(id, Boolean(enabled))
    return { ok: true }
  })
  // 重试 = 按当前配置重新对账一次（失败后的手动入口；未启用时只会落到「未启用」，不会连上）。
  ipcMain.handle('mcp:retry', async (_e, id: string): Promise<McpServerView | null> => {
    await reconcile(id)
    const cfg = getServerConfig(id)
    return cfg ? viewOf(cfg) : null
  })
  // 写入 / 更新某服务的某密钥字段（写后即用，明文永不回渲染层）；已启用则防抖重连以用上新值。
  ipcMain.handle(
    'mcp:set-secret',
    async (
      _e,
      id: string,
      field: string,
      value: string
    ): Promise<{ ok: boolean; available: boolean }> => {
      const f = (field ?? '').trim()
      if (!f) return { ok: false, available: true }
      const r = await setSecret(`mcp:${id}:${f}`, typeof value === 'string' ? value : '')
      if (r.ok && isEnabled(id)) scheduleReconcile(id)
      return r
    }
  )
  ipcMain.handle('mcp:has-secret', (_e, id: string, field: string): Promise<boolean> =>
    hasSecret(`mcp:${id}:${(field ?? '').trim()}`)
  )
}
