import { createHash } from 'crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, rmSync, type Dirent } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import { writeFileAtomic } from './chat-store'
import type { Message, ToolSpec } from '../providers/types'

/**
 * 子智能体记录（落盘）：供 send_to_subagent 给已派出的子智能体继续发消息，它保留自己的上下文。
 *
 * 存储：`<DEVA_HOME>/data/subagents/<会话 id>/<子智能体 id>.json`，每会话另有 `_index.json` 只存
 * 元信息（剪枝 / 补全卡片标题时不必解析大文件）。system / tools 随记录定格：续聊时上下文自洽，
 * fork 还能与主对话共享提示缓存前缀。每会话至多 MAX_PER_SESSION 条，超出淘汰最久未用的非忙记录。
 *
 * 生命周期：删会话 / 清空对话 → 整目录删除；按轮删除 / 回滚恢复对话 → 创建或续聊发生在被删轮次的
 * 记录整条删除（删掉的内容模型不再看到）；压缩不剪枝。启动清扫删掉已不存在会话的目录。
 */

export interface SubagentRecord {
  id: string
  sessionId: string
  /** 子智能体类型名：General / Explore / Plan / fork。 */
  agent: string
  /** 派发时的任务卡标题（run_subagent 的 description）。 */
  description: string
  /** 创建它的 run_subagent 调用 id。 */
  originToolId: string
  /** 创建及每次续聊的调用 id：任一所在轮次被删，整条记录随之删除。 */
  toolIds: string[]
  /** 派发时的工作目录：续聊时若已变化，在消息前提示新的基准。 */
  workspaceRoot: string | null
  system: string
  tools: ToolSpec[]
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export type SubagentMeta = Pick<SubagentRecord, 'id' | 'agent' | 'description' | 'toolIds' | 'updatedAt'>

const MAX_PER_SESSION = 20
/** 启动清扫：刚建的目录可能属于清扫开始后才新建的会话，留一小时宽限。 */
const SWEEP_GRACE_MS = 3600 * 1000
const INDEX_FILE = '_index.json'

/** id 来自渲染层或模型：只保留白名单字符，杜绝路径穿越（与 chat-store 的 safeId 同一规则）。 */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

function subagentsRoot(): string {
  return join(getDevaHome(), 'data', 'subagents')
}

/** 会话目录；安全化后为空 → null（绝不能退化成根目录本身，否则删会话 = 删全部）。 */
function sessionDir(sessionId: string): string | null {
  const name = safeName(sessionId)
  return name ? join(subagentsRoot(), name) : null
}

function recordFile(sessionId: string, id: string): string | null {
  const dir = sessionDir(sessionId)
  const name = safeName(id)
  return dir && name ? join(dir, `${name}.json`) : null
}

const records = new Map<string, SubagentRecord>()
const indexes = new Map<string, Map<string, SubagentMeta>>()
const busy = new Set<string>()

const key = (sessionId: string, id: string): string => `${sessionId}/${id}`

/** 由创建它的 run_subagent 调用 id 确定性地派生子智能体 id（重开对话时可据此反查卡片标题）。 */
export function subagentIdFor(toolUseId: string): string {
  return 'sub-' + createHash('sha256').update(toolUseId).digest('hex').slice(0, 8)
}

function loadIndex(sessionId: string): Map<string, SubagentMeta> {
  const cached = indexes.get(sessionId)
  if (cached) return cached
  const map = new Map<string, SubagentMeta>()
  const dir = sessionDir(sessionId)
  if (dir) {
    try {
      const list = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8')) as SubagentMeta[]
      if (Array.isArray(list)) for (const m of list) if (m && typeof m.id === 'string') map.set(m.id, m)
    } catch {
      /* 无索引 / 损坏：视作空，记录文件留给清扫或下次覆盖 */
    }
  }
  indexes.set(sessionId, map)
  return map
}

function persistIndex(sessionId: string): void {
  const dir = sessionDir(sessionId)
  if (!dir) return
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileAtomic(join(dir, INDEX_FILE), JSON.stringify([...loadIndex(sessionId).values()], null, 2))
  } catch (e) {
    console.warn('[subagents] 索引写入失败：', e)
  }
}

/** 为新派出的子智能体分配 id：确定性派生，极罕见的冲突时加序号后缀。 */
export function newSubagentId(sessionId: string, originToolId: string): string {
  const base = subagentIdFor(originToolId)
  const index = loadIndex(sessionId)
  let id = base
  for (let n = 2; index.has(id); n++) id = `${base}-${n}`
  return id
}

export function getSubagentMeta(sessionId: string, id: string): SubagentMeta | undefined {
  return loadIndex(sessionId).get(id)
}

/** 读取完整记录（内存缓存优先，按需读盘）；不存在 / 已被清理 → undefined。 */
export function loadSubagent(sessionId: string, id: string): SubagentRecord | undefined {
  if (!loadIndex(sessionId).has(id)) return undefined
  const cached = records.get(key(sessionId, id))
  if (cached) return cached
  const file = recordFile(sessionId, id)
  if (!file) return undefined
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as SubagentRecord
    if (!rec || !Array.isArray(rec.messages)) return undefined
    records.set(key(sessionId, id), rec)
    return rec
  } catch {
    return undefined
  }
}

/** 落盘一条记录并更新索引；写盘失败只告警，绝不影响本轮。 */
export function saveSubagent(rec: SubagentRecord): void {
  rec.updatedAt = Date.now()
  records.set(key(rec.sessionId, rec.id), rec)
  const index = loadIndex(rec.sessionId)
  index.set(rec.id, {
    id: rec.id,
    agent: rec.agent,
    description: rec.description,
    toolIds: [...rec.toolIds],
    updatedAt: rec.updatedAt
  })
  const file = recordFile(rec.sessionId, rec.id)
  if (file) {
    try {
      const dir = sessionDir(rec.sessionId) as string
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileAtomic(file, JSON.stringify(rec))
    } catch (e) {
      console.warn('[subagents] 记录写入失败：', e)
    }
  }
  enforceCap(rec.sessionId, rec.id)
  persistIndex(rec.sessionId)
}

function dropRecord(sessionId: string, id: string): void {
  records.delete(key(sessionId, id))
  loadIndex(sessionId).delete(id)
  const file = recordFile(sessionId, id)
  if (file) {
    try {
      rmSync(file, { force: true })
    } catch {
      /* 删除失败静默：启动清扫兜底 */
    }
  }
}

/** 超出上限时淘汰最久未用的记录（正在运行的与刚写入的那条除外）。 */
function enforceCap(sessionId: string, keepId: string): void {
  const index = loadIndex(sessionId)
  if (index.size <= MAX_PER_SESSION) return
  const victims = [...index.values()]
    .filter((m) => m.id !== keepId && !busy.has(key(sessionId, m.id)))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  for (const m of victims) {
    if (index.size <= MAX_PER_SESSION) break
    dropRecord(sessionId, m.id)
  }
}

export function isSubagentBusy(sessionId: string, id: string): boolean {
  return busy.has(key(sessionId, id))
}

export function setSubagentBusy(sessionId: string, id: string, on: boolean): void {
  if (on) busy.add(key(sessionId, id))
  else busy.delete(key(sessionId, id))
}

/**
 * 按轮删除 / 回滚恢复对话后调用：创建或续聊发生在已删轮次（其调用 id 不在 liveToolIds 里）的
 * 记录整条删除。liveToolIds = 会话里仍存在的全部 tool_use id。
 */
export function pruneSubagents(sessionId: string, liveToolIds: Set<string>): void {
  const index = loadIndex(sessionId)
  let changed = false
  for (const m of [...index.values()]) {
    if (busy.has(key(sessionId, m.id))) continue
    if (m.toolIds.some((t) => !liveToolIds.has(t))) {
      dropRecord(sessionId, m.id)
      changed = true
    }
  }
  if (changed) persistIndex(sessionId)
}

/** 删会话 / 清空对话：整目录删除并清掉内存缓存。 */
export function removeSessionSubagents(sessionId: string): void {
  for (const id of loadIndex(sessionId).keys()) records.delete(key(sessionId, id))
  indexes.delete(sessionId)
  const dir = sessionDir(sessionId)
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删除失败静默：启动清扫兜底 */
  }
}

/** 启动清扫（异步，不阻塞启动）：已不存在的会话目录整个删掉。liveIds = 当前全部会话 id。 */
export async function sweepSubagents(liveIds: Iterable<string>): Promise<void> {
  const live = new Set<string>()
  for (const id of liveIds) live.add(safeName(id))
  let dirs: Dirent[]
  try {
    dirs = await fsp.readdir(subagentsRoot(), { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name || live.has(d.name)) continue
    const p = join(subagentsRoot(), d.name)
    try {
      if ((await fsp.stat(p)).mtimeMs < now - SWEEP_GRACE_MS)
        await fsp.rm(p, { recursive: true, force: true })
    } catch {
      /* 单个目录失败不影响其余 */
    }
  }
}
