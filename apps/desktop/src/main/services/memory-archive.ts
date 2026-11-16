import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'path'
import { type MemoryScope, archiveFilePath } from './memory-paths'

/**
 * 遗忘区（archive）：记忆写满时**不删除**，而是整条搬到这里，主记忆里只留一行索引。
 *
 * 为什么单独一个文件而不是塞进 `memory.json`：`memory.json` 的条目会**随消息注入上下文**，
 * 有总字数预算（全局 4000 / 项目 3000）。归档内容要是留在同一个文件里，它照样吃预算，归档就等于没归档。
 * 拆出来以后归档区可以无限增长（冷数据不进上下文），主文件体积恒定。
 *
 * 三件事：
 *  ① **迁出**：`archiveEntries()` 把给定条目原文搬进遗忘区（保留原 id / 时间戳 / 埋点信号），
 *     并给一个新的归档 id `a_` 前缀，便于 `memory_recall` 精确定位。
 *  ② **索引**：`syncArchiveIndex()` 在主记忆里维护**一行**索引（id `m_archive` / `p_archive`），
 *     只说「有 N 条已归档、大概是什么主题、用 memory_recall 查」——不逐条列出（那会吃掉腾出来的预算）。
 *  ③ **取回**：`searchArchive()` 按关键词或 id 前缀查，返回完整原文。
 *
 * 依赖方向：本文件只依赖 `memory-paths.ts`，**不依赖 `memory.ts`**——
 * `memory.ts` 反过来要调本文件（写满自动迁出），若互相 import 会成环。
 */

/** 记忆条目形状（与 `memory.ts` 的 `MemoryEntry` 结构一致；此处重复定义只为避开循环依赖）。 */
export interface EntryShape {
  id: string
  content: string
  createdAt: number
  updatedAt: number
  /** 上次被注入进上下文的时间戳。 */
  lastSeenAt?: number
  /** 被注入进上下文的次数。 */
  seenCount?: number
}

/** 遗忘区条目：原条目全部字段 + 归档元信息。 */
export interface ArchiveEntry extends EntryShape {
  /** 归档后固定 id：`a_` + 8 位十六进制（与 m_ / p_ 区分，`memory_delete` 不会误定位到它）。 */
  id: string
  /** 归档前的 id（追溯用；原条目已从主记忆移除）。 */
  originalId: string
  /** 原作用域。 */
  fromScope: 'global' | 'project'
  /** 归档时刻。 */
  archivedAt: number
  /** 为什么被搬走：超出预算 / 超出条目数 / 由模型主动整理。 */
  reason: 'budget' | 'entries' | 'manual'
}

/** 索引条目的固定 id：全局 `m_archive`、项目 `p_archive`。 */
export const ARCHIVE_INDEX_ID = { global: 'm_archive', project: 'p_archive' } as const

/** 读遗忘区全部条目（文件不存在 / 损坏视为空，绝不抛错）。 */
export function listArchive(scope: MemoryScope): ArchiveEntry[] {
  const p = archiveFilePath(scope)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { entries?: unknown }
    if (!Array.isArray(parsed?.entries)) return []
    return parsed.entries.filter(
      (e): e is ArchiveEntry =>
        !!e && typeof (e as ArchiveEntry).id === 'string' && typeof (e as ArchiveEntry).content === 'string'
    )
  } catch {
    return []
  }
}

function saveArchive(scope: MemoryScope, entries: ArchiveEntry[]): void {
  const p = archiveFilePath(scope)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  const body = { version: 1, entries }
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
  renameSync(tmp, p)
}

function newArchiveId(taken: Set<string>): string {
  let id = ''
  do id = `a_${randomBytes(4).toString('hex')}`
  while (taken.has(id))
  return id
}

/** 把一批主记忆条目搬进遗忘区。原文完整保留，不截断、不改写。 */
export function archiveEntries(
  scope: MemoryScope,
  victims: EntryShape[],
  reason: ArchiveEntry['reason'] = 'budget'
): ArchiveEntry[] {
  if (victims.length === 0) return []
  const existing = listArchive(scope)
  const taken = new Set(existing.map((e) => e.id))
  const now = Date.now()
  const added: ArchiveEntry[] = []
  for (const v of victims) {
    const rec: ArchiveEntry = {
      id: newArchiveId(taken),
      originalId: v.id,
      fromScope: scope.kind === 'project' ? 'project' : 'global',
      content: v.content,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      ...(v.lastSeenAt ? { lastSeenAt: v.lastSeenAt } : {}),
      ...(v.seenCount ? { seenCount: v.seenCount } : {}),
      archivedAt: now,
      reason
    }
    taken.add(rec.id)
    added.push(rec)
  }
  saveArchive(scope, [...existing, ...added])
  return added
}

/**
 * 淘汰排序：给每个条目一个「该搬走的程度」排名，**排名小的先搬**。
 *
 * 排序键（依次比较）：
 *  ① 最近 3 天内被更新过 → 排到最后（那是用户/模型刚动过的，不该最先丢）；
 *  ② `lastUse = lastSeenAt ?? createdAt` 早的优先（从没被注入过的老条目最该走）；
 *  ③ `seenCount` 少的优先（同样时间下，用得少的先走）；
 *  ④ `createdAt` 早的优先。
 *
 * 索引条目（`m_archive` / `p_archive`）永不入选。
 */
export function pickEvictionVictims<Entry extends EntryShape>(
  entries: Entry[],
  indexId: string,
  needChars: number,
  needSlots: number
): Entry[] {
  const now = Date.now()
  const FRESH_MS = 3 * 24 * 60 * 60 * 1000
  const rank = (e: EntryShape): number[] => [
    now - e.updatedAt < FRESH_MS ? 1 : 0,
    e.lastSeenAt ?? e.createdAt,
    e.seenCount ?? 0,
    e.createdAt
  ]
  const cmp = (a: Entry, b: Entry): number => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    return 0
  }
  const candidates = entries.filter((e) => e.id !== indexId).sort(cmp)
  const victims: Entry[] = []
  let freedChars = 0
  for (const e of candidates) {
    if (freedChars >= needChars && victims.length >= needSlots) break
    victims.push(e)
    // 与被注入时的口径一致：整行（含 id 前缀）都是预算的一部分
    freedChars += `- [${e.id}] ${e.content}`.length
  }
  return victims
}

/**
 * 维护主记忆里的那**一行**索引。返回改过的条目数组（未变则原样返回同一引用）。
 *
 * 内容刻意简短：只说「有 N 条、什么主题、怎么查」，不逐条列举——逐条列会吃光腾出来的预算。
 * 主题取归档条目最近 3 条的开头几个字。
 */
export function syncArchiveIndex<Entry extends EntryShape>(
  entries: Entry[],
  scope: MemoryScope
): Entry[] {
  const indexId = ARCHIVE_INDEX_ID[scope.kind === 'project' ? 'project' : 'global']
  const archived = listArchive(scope)
  const hit = entries.find((e) => e.id === indexId)

  if (archived.length === 0) {
    // 遗忘区空了：把索引条目一并去掉，别留一行「有 0 条已归档」占预算。
    return hit ? entries.filter((e) => e.id !== indexId) : entries
  }

  const topics = archived
    .slice(-3)
    .map((e) => e.content.slice(0, 10).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const text = `遗忘区有 ${archived.length} 条已归档记忆（${topics.join(' / ')}…），需要时用 memory_recall 按关键词或 id 查看原文`
  if (hit && hit.content === text) return entries
  const now = Date.now()
  if (hit) {
    hit.content = text
    hit.updatedAt = now
    return entries
  }
  return [...entries, { id: indexId, content: text, createdAt: now, updatedAt: now } as Entry]
}

/**
 * 按关键词 / id 前缀在遗忘区里查。不区分大小写，命中 `content` 或 `id` 都算。
 * 返回命中的完整原文（调用方负责截断以免回灌过长）。
 */
export function searchArchive(scope: MemoryScope, query: string): ArchiveEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return listArchive(scope).filter(
    (e) => e.id.toLowerCase().startsWith(q) || e.content.toLowerCase().includes(q)
  )
}

/** 遗忘区统计（面板显示用）。 */
export function archiveStats(scope: MemoryScope): { count: number; chars: number } {
  const entries = listArchive(scope)
  return {
    count: entries.length,
    chars: entries.reduce((n, e) => n + e.content.length, 0)
  }
}

/** 从遗忘区移除一条（面板「取回」用：原文已写回主记忆，归档副本即可删掉）。 */
export function removeArchiveEntry(scope: MemoryScope, archiveId: string): boolean {
  const entries = listArchive(scope)
  const kept = entries.filter((e) => e.id !== archiveId)
  if (kept.length === entries.length) return false
  saveArchive(scope, kept)
  return true
}

/**
 * 合并：把多条原文**全部搬进遗忘区**（一条不丢），再生成一条合并后的新条目。
 *
 * 为什么原文必须全进归档（踩坑结论）：调研到的失败案例里，最典型的是「合并把关键信息揉没了」
 * —— 一旦新的合并文本漏掉某个限定（如「本项目」三个字），那条信息就永久消失，且无法追溯。
 * 所以合并**永不原地覆盖**：新条目带 `mergedFrom` 来源 id 列表，旧条全部以 `reason:'manual'`
 * 落进遗忘区，随时能用 `memory_recall` 取回原文对照。
 *
 * 返回新的主记忆条目（调用方负责写回 memory.json 并维护索引）。
 */
export function mergeIntoOne(
  scope: MemoryScope,
  sources: EntryShape[],
  content: string
): { entry: EntryShape; moved: ArchiveEntry[] } {
  // 先把原文全部归档（一条不丢）
  const moved = archiveEntries(scope, sources, 'manual')
  const now = Date.now()
  const earliest = sources.reduce((n, s) => Math.min(n, s.createdAt), now)
  const totalSeen = sources.reduce((n, s) => n + (s.seenCount ?? 0), 0)
  const latestSeen = sources.reduce((n, s) => Math.max(n, s.lastSeenAt ?? 0), 0)
  const entry: EntryShape = {
    id: `m_merged_${randomBytes(3).toString('hex')}`,
    content,
    createdAt: earliest,
    updatedAt: now,
    ...(latestSeen ? { lastSeenAt: latestSeen } : {}),
    ...(totalSeen ? { seenCount: totalSeen } : {})
  }
  return { entry, moved }
}
