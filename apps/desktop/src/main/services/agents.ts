import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getDevaHome, setConfig } from './config'
import { fmArray, fmScalar, fmString, parseFrontmatter } from './frontmatter'

/**
 * 子智能体（Subagents）服务：发现 / 解析 / 读写 `~/.deva/agents/<id>.md`（全局，与项目无关）。
 *
 * 设计（对标 Claude Code 的 subagent / Task）：
 * - **身份 = 文件名去扩展名（id），显示名 = frontmatter `name`**。文件名恒定不改（改显示名只重写 frontmatter），
 *   故重命名不触发文件搬迁，UI 的「id 稳定 / name 可编辑」模型天然成立。
 * - 启用态**不入 .md**（避免手改正文时误触），集中存 `config.json` 的 `agents.enabled[id]`，默认关。
 * - `<id>.md` = frontmatter（name/description/model/tools）+ 正文（prompt，即子智能体系统提示词）。
 *   `model` 为空 = 「跟随主对话」（继承父轮模型）；非空为模型引用 `"providerId:modelId"`（见 model-resolve.ts）。
 *   `tools` 为空 = 允许全部内置工具；非空为白名单（内置工具名 / 已连接 MCP 名的子集）。
 *
 * 运行期（chat.ts 同进程直接调用，无需 IPC）：
 * - `enabledAgentSummaries()`：把「已启用」子智能体的 name+description 注入 `run_subagent` 工具描述（枚举）。
 * - `getEnabledAgentByName()`：`run_subagent` 派生时按 agent 名取完整定义（model/tools/prompt）。
 *
 * 安全：`~/.deva` 在 fs-guard 的敏感硬地板内，Agent 自身文件工具读不到；子智能体配置由**主进程直读**（符合设计）。
 * 子智能体的每一次嵌套工具调用照常过权限闸门——`tools` 白名单只是**收窄**可见工具，绝不放宽闸门。
 */

export interface AgentRecord {
  /** 文件名（去 .md），稳定身份（选择/启用态键）。 */
  id: string
  /** frontmatter name，显示名，`run_subagent` 的 agent 参数据此匹配（缺省回落 id）。 */
  name: string
  description: string
  /** 模型引用 `"providerId:modelId"`；空串 = 跟随主对话（继承父轮模型）。 */
  model: string
  /** 工具白名单（内置 / MCP 名）；空数组 = 允许全部内置工具。 */
  tools: string[]
  /** .md 正文 = 子智能体系统提示词。 */
  prompt: string
  enabled: boolean
}

export interface AgentUpsertInput {
  /** 有 id → 覆盖该文件；无 id → 新建（据 name 生成稳定文件名）。 */
  id?: string
  name: string
  description?: string
  model?: string
  tools?: string[]
  prompt?: string
  /** 可选：一并设置启用态（新建默认关）。 */
  enabled?: boolean
}

function agentsDir(): string {
  return join(getDevaHome(), 'agents')
}

function agentFile(id: string): string {
  return join(agentsDir(), `${id}.md`)
}

/** 读取 config.json 的 agents.enabled 映射（不存在则空）。 */
function enabledMap(): Record<string, boolean> {
  const agents = getConfig().agents
  const enabled = (agents as { enabled?: unknown })?.enabled
  if (enabled && typeof enabled === 'object') return enabled as Record<string, boolean>
  return {}
}

function writeEnabledMap(map: Record<string, boolean>): void {
  const agents = getConfig().agents
  const base = agents && typeof agents === 'object' ? (agents as Record<string, unknown>) : {}
  setConfig({ agents: { ...base, enabled: map } })
}

/** 校验文件名安全（防 `..` / 分隔符逃逸）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 据显示名生成安全、唯一的文件名 id。 */
function makeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'agent'
  let id = base
  let n = 2
  while (existsSync(agentFile(id))) {
    id = `${base}-${n++}`
  }
  return id
}

function parseAgent(id: string, raw: string, enabled: boolean): AgentRecord {
  const { data, body } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || id
  return {
    id,
    name,
    description: fmString(data, 'description'),
    model: fmString(data, 'model'),
    tools: fmArray(data, 'tools'),
    prompt: body.trim(),
    enabled
  }
}

/** 列出所有子智能体（扫描 agents 目录下每个 `<id>.md`）。解析失败的文件跳过，绝不抛错。 */
export function listAgents(): AgentRecord[] {
  const dir = agentsDir()
  if (!existsSync(dir)) return []
  const map = enabledMap()
  const out: AgentRecord[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const id = entry.slice(0, -3)
    if (!isSafeId(id)) continue
    try {
      const raw = readFileSync(agentFile(id), 'utf8')
      out.push(parseAgent(id, raw, map[id] === true))
    } catch {
      /* 读失败 → 跳过该文件 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function getAgent(id: string): AgentRecord | null {
  if (!isSafeId(id)) return null
  try {
    const raw = readFileSync(agentFile(id), 'utf8')
    return parseAgent(id, raw, enabledMap()[id] === true)
  } catch {
    return null
  }
}

/** 组装 agent.md 文本（frontmatter + 正文）。 */
function composeAgentMd(input: {
  name: string
  description: string
  model: string
  tools: string[]
  prompt: string
}): string {
  const lines = ['---', `name: ${fmScalar(input.name)}`]
  if (input.description) lines.push(`description: ${fmScalar(input.description)}`)
  if (input.model) lines.push(`model: ${fmScalar(input.model)}`)
  if (input.tools.length) lines.push(`tools: [${input.tools.map(fmScalar).join(', ')}]`)
  lines.push('---', '', input.prompt.trim(), '')
  return lines.join('\n')
}

/** 新建或覆盖一个子智能体，返回最终记录。 */
export function upsertAgent(input: AgentUpsertInput): AgentRecord {
  const name = (input.name || '').trim() || '未命名子智能体'
  let id = input.id && isSafeId(input.id) ? input.id : ''
  const isNew = !id
  if (!id) id = makeId(name)

  const md = composeAgentMd({
    name,
    description: (input.description ?? '').trim(),
    model: (input.model ?? '').trim(),
    tools: (input.tools ?? []).filter((t) => typeof t === 'string' && t.trim()),
    prompt: input.prompt ?? ''
  })

  try {
    mkdirSync(agentsDir(), { recursive: true })
    writeFileSync(agentFile(id), md, 'utf8')
  } catch {
    /* 写失败：返回内存态记录，UI 仍可用（下次可重试） */
  }

  // 启用态：新建默认关；显式传入则以传入为准。
  if (typeof input.enabled === 'boolean') setAgentEnabled(id, input.enabled)
  else if (isNew) setAgentEnabled(id, false)

  return (
    getAgent(id) ?? {
      id,
      name,
      description: (input.description ?? '').trim(),
      model: (input.model ?? '').trim(),
      tools: input.tools ?? [],
      prompt: input.prompt ?? '',
      enabled: input.enabled === true
    }
  )
}

export function deleteAgent(id: string): void {
  if (!isSafeId(id)) return
  try {
    rmSync(agentFile(id), { force: true })
  } catch {
    /* 忽略删除失败 */
  }
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    writeEnabledMap(map)
  }
}

export function setAgentEnabled(id: string, enabled: boolean): void {
  if (!isSafeId(id)) return
  const map = enabledMap()
  map[id] = enabled === true
  writeEnabledMap(map)
}

// ── 运行期（chat.ts 直接调用）───────────────────────────────────────────────

/** 已启用子智能体的 name+description 摘要，用于 `run_subagent` 工具的 agent 枚举与描述。 */
export function enabledAgentSummaries(): { name: string; description: string }[] {
  return listAgents()
    .filter((a) => a.enabled)
    .map((a) => ({ name: a.name, description: a.description }))
}

/** 是否存在已启用子智能体（决定是否向模型提供 run_subagent 工具）。 */
export function hasEnabledAgents(): boolean {
  return listAgents().some((a) => a.enabled)
}

/**
 * 按显示名（大小写不敏感）取**已启用**子智能体的完整定义。
 * 供 `run_subagent` 工具派生；未命中返回 null。
 */
export function getEnabledAgentByName(name: string): AgentRecord | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  for (const a of listAgents()) {
    if (!a.enabled) continue
    if (a.name.toLowerCase() === wanted || a.id.toLowerCase() === wanted) return a
  }
  return null
}

/** 子智能体读写 IPC（全局；启用态入 config.json）。 */
export function registerAgentsIpc(): void {
  ipcMain.handle('agents:list', (): AgentRecord[] => listAgents())
  ipcMain.handle('agents:get', (_e, id: string): AgentRecord | null => getAgent(id))
  ipcMain.handle('agents:upsert', (_e, input: AgentUpsertInput): AgentRecord => upsertAgent(input))
  ipcMain.handle('agents:remove', (_e, id: string): { ok: true } => {
    deleteAgent(id)
    return { ok: true }
  })
  ipcMain.handle('agents:set-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setAgentEnabled(id, Boolean(enabled))
    return { ok: true }
  })
}
