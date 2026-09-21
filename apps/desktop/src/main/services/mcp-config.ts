import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getDevaHome, setConfig } from './config'
import { deleteSecretsByPrefix, getSecret } from './secrets'

/**
 * MCP 服务配置的读写（全局，`~/.deva/mcp.json`，与项目无关）。
 *
 * 设计：
 * - 服务清单存 `~/.deva/mcp.json` 的 `mcpServers` 映射（沿用 Claude Desktop 的键名，便于用户迁移/理解）。
 * - **身份 = 映射键（id）**，显示名 = `name`；id 稳定不改（改显示名只重写字段）。
 * - 启用态**不入 mcp.json**，集中存 `config.json` 的 `mcp.enabled[id]`，默认关（与 skills 一致）。
 * - **密钥零明文落盘**：env / headers 里的敏感值以 `{ secretRef }` 占位，真实值经 safeStorage 加密存
 *   `~/.deva/secrets.json`（键 `mcp:<id>:<field>`）。`{secretRef}` 占位本身非敏感，可回渲染层用于「已配置」展示。
 *
 * 安全：`~/.deva` 在 fs-guard 敏感硬地板内，Agent 自身文件工具读不到；MCP 配置由**主进程直读**（符合设计）。
 * 连接、子进程 spawn、密钥解密全部只发生在主进程（mcp.ts），明文永不出主进程。
 */

export type McpTransport = 'stdio' | 'sse' | 'http'

/** env / header 值：明文字符串（非敏感），或指向加密库的引用（真实值在 `mcp:<id>:<secretRef>`）。 */
export type McpValue = string | { secretRef: string }

export interface McpServerConfig {
  /** 映射键，稳定身份（选择 / 启用态 / 密钥前缀键）。 */
  id: string
  name: string
  description: string
  transport: McpTransport
  /** stdio：启动命令。 */
  command?: string
  /** stdio：命令参数。 */
  args?: string[]
  /** stdio：环境变量（值可为明文或 `{secretRef}`）。 */
  env?: Record<string, McpValue>
  /** sse / http：服务地址。 */
  url?: string
  /** sse / http：请求头（值可为明文或 `{secretRef}`）。 */
  headers?: Record<string, McpValue>
}

export interface McpServerInput {
  /** 有 id → 覆盖；无 id → 新建（据 name 生成稳定键）。 */
  id?: string
  name: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
  /** 可选：一并设置启用态（新建默认关）。 */
  enabled?: boolean
}

type StoredServer = Omit<McpServerConfig, 'id'>

function mcpFile(): string {
  return join(getDevaHome(), 'mcp.json')
}

/** 读取 mcp.json 的 mcpServers 映射（不存在 / 损坏 → 空，绝不抛错）。 */
function readAll(): Record<string, StoredServer> {
  try {
    const raw = readFileSync(mcpFile(), 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (servers && typeof servers === 'object') return servers as Record<string, StoredServer>
  } catch {
    /* 无文件 / 解析失败 → 空库 */
  }
  return {}
}

function writeAll(servers: Record<string, StoredServer>): void {
  try {
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: servers }, null, 2), 'utf8')
  } catch {
    /* 写失败：忽略，内存态仍可用（下次可重试） */
  }
}

/** 校验 id 安全（防 `..` / 分隔符逃逸；同时用作密钥前缀）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 据显示名生成安全、唯一的 id。 */
function makeId(name: string, existing: Record<string, StoredServer>): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'mcp'
  let id = base
  let n = 2
  while (existing[id]) id = `${base}-${n++}`
  return id
}

/** 规整 args：仅保留字符串项。 */
function cleanArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return []
  return args.filter((a): a is string => typeof a === 'string')
}

/** 规整 env / headers：丢弃空键；值保留明文字符串或合法 `{secretRef}`。 */
function cleanValueMap(map: unknown): Record<string, McpValue> {
  const out: Record<string, McpValue> = {}
  if (!map || typeof map !== 'object') return out
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    if (typeof v === 'string') out[key] = v
    else if (v && typeof v === 'object' && typeof (v as { secretRef?: unknown }).secretRef === 'string') {
      const ref = (v as { secretRef: string }).secretRef.trim()
      if (ref) out[key] = { secretRef: ref }
    }
  }
  return out
}

// ── 启用态（config.json 的 mcp.enabled）──────────────────────────────────────

function enabledMap(): Record<string, boolean> {
  const mcp = getConfig().mcp
  const enabled = (mcp as { enabled?: unknown })?.enabled
  if (enabled && typeof enabled === 'object') return enabled as Record<string, boolean>
  return {}
}

function writeEnabledMap(map: Record<string, boolean>): void {
  const mcp = getConfig().mcp
  const base = mcp && typeof mcp === 'object' ? (mcp as Record<string, unknown>) : {}
  setConfig({ mcp: { ...base, enabled: map } })
}

export function isEnabled(id: string): boolean {
  return enabledMap()[id] === true
}

export function setEnabled(id: string, enabled: boolean): void {
  if (!isSafeId(id)) return
  const map = enabledMap()
  map[id] = enabled === true
  writeEnabledMap(map)
}

// ── 读写 ──────────────────────────────────────────────────────────────────

export function listServerConfigs(): McpServerConfig[] {
  const servers = readAll()
  const out: McpServerConfig[] = []
  for (const [id, s] of Object.entries(servers)) {
    if (!isSafeId(id) || !s || typeof s !== 'object') continue
    out.push({ id, ...s })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function getServerConfig(id: string): McpServerConfig | null {
  if (!isSafeId(id)) return null
  const s = readAll()[id]
  if (!s || typeof s !== 'object') return null
  return { id, ...s }
}

/** 新建或覆盖一个 MCP 服务配置，返回最终记录。 */
export function upsertServer(input: McpServerInput): McpServerConfig {
  const name = (input.name || '').trim() || '未命名 MCP'
  let id = input.id && isSafeId(input.id) ? input.id : ''
  const isNew = !id
  const servers = readAll()
  if (!id) id = makeId(name, servers)

  const transport: McpTransport =
    input.transport === 'sse' || input.transport === 'http' ? input.transport : 'stdio'
  const rec: StoredServer = {
    name,
    description: (input.description ?? '').trim(),
    transport
  }
  if (transport === 'stdio') {
    rec.command = (input.command ?? '').trim()
    rec.args = cleanArgs(input.args)
    rec.env = cleanValueMap(input.env)
  } else {
    rec.url = (input.url ?? '').trim()
    rec.headers = cleanValueMap(input.headers)
  }

  servers[id] = rec
  writeAll(servers)

  if (typeof input.enabled === 'boolean') setEnabled(id, input.enabled)
  else if (isNew) setEnabled(id, false)

  return { id, ...rec }
}

/** 删除一个服务：清 mcp.json 条目、启用态、以及其全部密钥（`mcp:<id>:` 前缀）。 */
export function deleteServer(id: string): void {
  if (!isSafeId(id)) return
  const servers = readAll()
  if (id in servers) {
    delete servers[id]
    writeAll(servers)
  }
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    writeEnabledMap(map)
  }
  void deleteSecretsByPrefix(`mcp:${id}:`)
}

// ── 连接期：把 `{secretRef}` 解密为可用的明文 env / headers（仅主进程内使用）──────

async function resolveValueMap(
  id: string,
  map: Record<string, McpValue> | undefined
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!map) return out
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string') {
      if (v) out[k] = v
    } else if (v && typeof v.secretRef === 'string') {
      const val = await getSecret(`mcp:${id}:${v.secretRef}`)
      if (val) out[k] = val // 未配置 / 解密失败 → 跳过该项（绝不注入空值）
    }
  }
  return out
}

/** 解析 stdio 的环境变量（明文 + 解密后的密钥）。 */
export function resolveEnv(cfg: McpServerConfig): Promise<Record<string, string>> {
  return resolveValueMap(cfg.id, cfg.env)
}

/** 解析 sse / http 的请求头（明文 + 解密后的密钥）。 */
export function resolveHeaders(cfg: McpServerConfig): Promise<Record<string, string>> {
  return resolveValueMap(cfg.id, cfg.headers)
}
