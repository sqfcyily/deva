import { ipcMain, type BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolSpec } from '../providers/types'
import type { ToolResult } from './tools'
import { registerMcpToolNames, unregisterMcpToolNames } from './tools'
import {
  deleteServer,
  getServerConfig,
  isEnabled,
  listServerConfigs,
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
 * - **结果恒作数据**：`tool_result` 一律当惰性文本回灌，不解析其中任何控制信号（防提示注入）。
 * - **失败降级绝不崩主进程**：ENOENT / 超时 / 鉴权失败 → `status='error'` + 明确中文 `lastError`。
 * - 子进程 spawn、密钥解密只在此层发生；命名空间名强制 `^[A-Za-z0-9_-]{1,64}$`（各家 API 通用约束）。
 */

export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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
}

/** 回渲染层的合并视图（配置 + 启用态 + 运行期状态）。 */
export interface McpServerView extends McpServerConfig {
  enabled: boolean
  scope: 'global'
  source: 'custom'
  status: McpStatus
  toolCount: number
  lastError: string | null
  /** 已发现工具的展示清单（原始名 + 命名空间化名 + 描述）。 */
  tools: { name: string; fqName: string; description: string }[]
}

const runtimes = new Map<string, Runtime>()
/** 命名空间名 → 目标服务 + 原始工具名（dispatchMcpTool 路由用）。 */
const routes = new Map<string, { serverId: string; origName: string }>()
/** 单调递增的连接代次发号器。 */
let genCounter = 0

const CONNECT_TIMEOUT = 30_000
const DISPATCH_TIMEOUT = 60_000
const TEXT_CAP = 30_000

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

/** 连接（或重连）一个服务；无论成败都返回其最新视图，绝不抛错。 */
export async function connectServer(id: string): Promise<McpServerView | null> {
  const cfg = getServerConfig(id)
  if (!cfg) return null

  // 先断开旧连接（幂等；会 bump gen 使旧回调失效）。
  await disconnectServer(id)

  const myGen = ++genCounter
  const rt: Runtime = {
    status: 'connecting',
    toolCount: 0,
    lastError: null,
    tools: [],
    client: null,
    gen: myGen
  }
  runtimes.set(id, rt)
  broadcast(id)

  try {
    const transport = await buildTransport(cfg)
    const client = new Client({ name: 'deva', version: '0.1.0' }, { capabilities: {} })
    // 意外断开（子进程退出 / 网络掉线）→ 置 error，反注册工具，绝不崩。
    client.onclose = (): void => {
      const cur = runtimes.get(id)
      if (!cur || cur.gen !== myGen) return
      if (cur.status === 'connected') {
        unregisterMcpToolNames(cur.tools.map((t) => t.fqName))
        for (const t of cur.tools) routes.delete(t.fqName)
        cur.status = 'error'
        cur.lastError = '连接已断开（服务进程退出或网络中断）。'
        cur.tools = []
        cur.toolCount = 0
        cur.client = null
        broadcast(id)
      }
    }

    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    // 连接期间若被更晚的 connect/disconnect 取代 → 放弃本次结果。
    if (runtimes.get(id)?.gen !== myGen) {
      await client.close().catch(() => {})
      return viewOf(cfg)
    }

    const listed = await client.listTools()
    const used = new Set<string>()
    const tools: McpToolInfo[] = []
    for (const t of listed.tools) {
      const fqName = makeFqName(id, t.name, used)
      tools.push({ fqName, origName: t.name, spec: toSpec(cfg, fqName, t) })
    }

    rt.client = client
    rt.tools = tools
    rt.toolCount = tools.length
    rt.status = 'connected'
    rt.lastError = null
    registerMcpToolNames(tools.map((t) => t.fqName))
    for (const t of tools) routes.set(t.fqName, { serverId: id, origName: t.origName })
    broadcast(id)
    return viewOf(cfg)
  } catch (e) {
    const cur = runtimes.get(id)
    if (cur && cur.gen === myGen) {
      cur.status = 'error'
      cur.lastError = friendlyError(e)
      cur.tools = []
      cur.toolCount = 0
      cur.client = null
      broadcast(id)
    }
    return getServerConfig(id) ? viewOf(cfg) : null
  }
}

/** 断开一个服务（幂等）：反注册工具、关闭 client、置 disconnected。 */
export async function disconnectServer(id: string): Promise<void> {
  const rt = runtimes.get(id)
  if (!rt) return
  rt.gen = ++genCounter // 使任何在途连接 / onclose 回调失效
  const client = rt.client
  unregisterMcpToolNames(rt.tools.map((t) => t.fqName))
  for (const t of rt.tools) routes.delete(t.fqName)
  rt.status = 'disconnected'
  rt.tools = []
  rt.toolCount = 0
  rt.client = null
  rt.lastError = null
  if (client) {
    try {
      await client.close()
    } catch {
      /* 关闭异常忽略（子进程可能已退出） */
    }
  }
  broadcast(id)
}

/** 断开全部（app 退出时清理 stdio 子进程，避免遗留孤儿进程）。 */
export async function disconnectAllServers(): Promise<void> {
  await Promise.all([...runtimes.keys()].map((id) => disconnectServer(id)))
}

/** 启动时自动连接所有「已启用」的服务（失败各自降级，不互相阻塞）。 */
export function autoConnectEnabledServers(): void {
  for (const cfg of listServerConfigs()) {
    if (isEnabled(cfg.id)) void connectServer(cfg.id)
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

/** 展平 MCP 的 content[]（文本拼接；非文本内容以占位符表示）；文本上限 TEXT_CAP。 */
function flattenResult(result: RawCallResult): ToolResult {
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const b of result.content) {
      if (!b || typeof b !== 'object') continue
      const block = b as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'image')
        parts.push(`[图片内容：${(block.mimeType as string) ?? 'image'}，已省略]`)
      else if (block.type === 'audio') parts.push('[音频内容，已省略]')
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
    isError
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
  ipcMain.handle('mcp:remove', async (_e, id: string): Promise<{ ok: true }> => {
    await disconnectServer(id)
    deleteServer(id)
    runtimes.delete(id)
    return { ok: true }
  })
  ipcMain.handle(
    'mcp:set-enabled',
    async (_e, id: string, enabled: boolean): Promise<{ ok: true }> => {
      setEnabled(id, Boolean(enabled))
      if (enabled) void connectServer(id)
      else await disconnectServer(id)
      return { ok: true }
    }
  )
  ipcMain.handle('mcp:connect', (_e, id: string): Promise<McpServerView | null> => connectServer(id))
  ipcMain.handle('mcp:disconnect', async (_e, id: string): Promise<{ ok: true }> => {
    await disconnectServer(id)
    return { ok: true }
  })
  // 测试 = 连接一次并返回结果视图（成功即保持连接；失败置 error）。
  ipcMain.handle('mcp:test', (_e, id: string): Promise<McpServerView | null> => connectServer(id))
  // 写入 / 更新某服务的某密钥字段（写后即用，明文永不回渲染层）。
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
      return setSecret(`mcp:${id}:${f}`, typeof value === 'string' ? value : '')
    }
  )
  ipcMain.handle('mcp:has-secret', (_e, id: string, field: string): Promise<boolean> =>
    hasSecret(`mcp:${id}:${(field ?? '').trim()}`)
  )
}
