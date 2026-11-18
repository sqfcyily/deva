import { mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { streamChat } from '../providers'
import { writeFileAtomic } from './atomic-write'
import type { CompactModelConfig } from './compaction'
import {
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  formatMemoryLine,
  isMemoryType,
  listMemories,
  memoryLimits,
  memoryPath,
  memoryTypeLabel,
  memoryUsage,
  newMemoryId,
  normalizeBody,
  normalizeTitle,
  replaceMemories,
  scopeLabel,
  writeMemory,
  type MemoryEntry,
  type MemoryInput,
  type MemoryScope,
  type MemoryWriteResult
} from './memory'

/**
 * 记忆写满后的自动归纳（issue #61：原先写满只会拒写，旧条目永远不会消失）。
 *
 * 模型经 memory_write 写入、撞上条数或索引总字数上限时，不再直接拒写：先用当前对话的模型把已有条目归纳一遍
 *（规则借鉴 Claude Code 后台整理记忆的做法：同主题合并、新的取代矛盾的旧的、删过时与一次性的、相对日期换成
 * 具体日期），压到上限的七成左右，再照常写入新条目。新条目原文由 writeMemory 保存，不经模型改写。
 *
 * 安全：归纳前把当时的全部条目备份到记忆文件同目录的 memory-backups/（保留最近 5 份）；模型输出解析不了、
 * 有条目超长、或归纳后仍放不下新条目，一律放弃归纳、退回原来的拒写，记忆文件不动。
 */

/** 归纳后的目标用量：上限的七成，留出余量，免得之后每写一条都要再归纳一次。 */
const TARGET_RATIO = 0.7
/** 验收线：写入新条目后条数与字数都须低于上限的九成，否则视为没归纳到位（重试，仍不行就按原样拒写）。 */
const ACCEPT_RATIO = 0.9
const TIMEOUT_MS = 90_000
const MAX_TOKENS = 8192
const ATTEMPTS = 2
const KEEP_BACKUPS = 5

export interface ConsolidateStats {
  before: { count: number; used: number }
  after: { count: number; used: number }
  backup: string
}

type ConsolidateResult = ({ ok: true } & ConsolidateStats) | { ok: false; reason: string }

/** 同一份记忆文件同时只归纳一次：并发撞满的写入共用这一次的结果，之后各自重写。 */
const inflight = new Map<string, Promise<ConsolidateResult>>()

/**
 * 写入一条记忆；撞上限时先归纳再写（model 为空 = 不能调模型，按原样拒写）。
 * consolidated：发生过归纳（不论之后写没写成）；failure：归纳没成功的原因。
 */
export async function writeMemoryWithConsolidation(
  input: MemoryInput,
  id: string | undefined,
  scope: MemoryScope,
  model: CompactModelConfig | undefined,
  signal?: AbortSignal
): Promise<{ result: MemoryWriteResult; consolidated?: ConsolidateStats; failure?: string }> {
  const first = writeMemory(input, id, scope)
  if (first.ok || (first.code !== 'full' && first.code !== 'budget') || !model) return { result: first }
  const c = await consolidate(scope, input, id, model, signal)
  if (!c.ok) return { result: first, failure: c.reason }
  // 要更新的那条可能已被并进别的条目：那就按新增写入（新增须带类型，取原条目的）。
  const exists = id ? listMemories(scope).some((e) => e.id === id) : false
  const retry = exists || !id ? input : { type: input.type ?? 'user', ...input }
  return { result: writeMemory(retry, exists ? id : undefined, scope), consolidated: c }
}

function consolidate(
  scope: MemoryScope,
  incoming: MemoryInput,
  replacing: string | undefined,
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<ConsolidateResult> {
  const key = memoryPath(scope)
  const running = inflight.get(key)
  if (running) return running
  const p = run(scope, incoming, replacing, model, signal).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function run(
  scope: MemoryScope,
  incoming: MemoryInput,
  replacing: string | undefined,
  model: CompactModelConfig,
  signal?: AbortSignal
): Promise<ConsolidateResult> {
  const before = listMemories(scope)
  if (before.length === 0) return { ok: false, reason: '没有可归纳的条目' }
  const { system, user } = buildPrompt(scope, before, incoming, replacing)
  let reason = ''
  for (let i = 0; i < ATTEMPTS; i++) {
    if (signal?.aborted) return { ok: false, reason: '已中止' }
    let text: string
    try {
      text = await askMemoryModel(model, system, user, signal)
    } catch (e) {
      reason = (e as Error)?.message ?? String(e)
      continue
    }
    const parsed = parseEntries(text, scope, before, incoming)
    if (!parsed.ok) {
      reason = parsed.reason
      continue
    }
    const after = mergeConcurrent(before, parsed.entries, listMemories(scope))
    const backup = backupMemories(scope, listMemories(scope))
    replaceMemories(scope, after)
    return {
      ok: true,
      before: { count: before.length, used: memoryUsage(before) },
      after: { count: after.length, used: memoryUsage(after) },
      backup
    }
  }
  return { ok: false, reason: reason || '归纳没有产出可用结果' }
}

function buildPrompt(
  scope: MemoryScope,
  entries: MemoryEntry[],
  incoming: MemoryInput,
  replacing: string | undefined
): { system: string; user: string } {
  const lim = memoryLimits(scope)
  const targetChars = Math.floor(lim.budget * TARGET_RATIO)
  const targetCount = Math.floor(lim.maxEntries * TARGET_RATIO)
  const system = [
    '你负责整理用户的长期记忆。记忆已经写满，请在不丢失有用信息的前提下把它归纳精简，给即将写入的新记忆腾出空间。',
    '每条记忆有类型（user 用户 / feedback 做事方式 / project 进展 / reference 资料）、一句话标题和正文。',
    '',
    '规则：',
    `1. 同一主题的多条合并成一条。标题一句话，不超过 ${MEMORY_TITLE_MAX} 字；正文不超过 ${MEMORY_BODY_MAX} 字。`,
    '2. 前后矛盾的以更新日期较新的为准，删掉被取代的旧条目。',
    '3. 与「即将写入的新记忆」重复、或被它取代的旧条目直接删除。新记忆会另行原样保存，不要把它写进结果。',
    '4. 删除一次性的任务细节、已经结束的进展和明显过时的内容。',
    '5. 做事方式类（用户纠正过、确认过的做法）和明确表达过的偏好优先保留，正文里的「原因」「何时适用」不要删。',
    '6. 只能合并、精简、删除，不得编造原文没有的信息。「昨天」「上周」这类相对时间，按该条的更新日期换成具体日期。',
    '7. 保持原条目的语言。',
    `8. 结果的索引总长不超过 ${targetChars} 字、不超过 ${targetCount} 条（每条按「- [id] 类型 · 标题」一行计，正文不计）。`,
    '',
    '只输出 JSON，不要任何其他文字：',
    '{"entries":[{"id":"原条目 id 或 null","type":"user|feedback|project|reference","title":"…","body":"…"}]}',
    '保留或由旧条目改写、合并而来的条目，id 填它所来自的旧条目 id（合并时填其中更新日期最早的那条）；无法对应到旧条目的填 null。'
  ].join('\n')
  const day = (t: number): string => (t > 0 ? new Date(t).toISOString().slice(0, 10) : '日期不详')
  const show = (e: { type?: string; title?: string; body?: string }): string =>
    `${e.type && isMemoryType(e.type) ? memoryTypeLabel(e.type) : '类型不变'} · ${e.title ?? '（标题不变）'}${e.body ? `\n  正文：${e.body.replace(/\n/g, '\n  ')}` : ''}`
  const user = [
    `当前${scopeLabel(scope)}（${entries.length} 条，索引 ${memoryUsage(entries)} 字）：`,
    ...entries.map((e) => `- [${e.id}]（更新于 ${day(e.updatedAt)}）${show(e)}`),
    '',
    replacing ? `即将写入的新记忆（将改写 [${replacing}] 的原内容）：` : '即将写入的新记忆：',
    show(incoming)
  ].join('\n')
  return { system, user }
}

/** 单次调用对话模型，取完整文字输出（归纳与旧记忆整理共用）。 */
export async function askMemoryModel(
  model: CompactModelConfig,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<string> {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let text = ''
  let error = ''
  let broken = false
  try {
    for await (const ev of streamChat(
      { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
      {
        model: model.model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: MAX_TOKENS,
        signal: ctrl.signal
      }
    )) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'error') error = ev.error.message
      else if (ev.type === 'done' && ev.stopReason !== 'end_turn' && ev.stopReason !== 'stop') broken = true
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (error) throw new Error(error)
  if (ctrl.signal.aborted) throw new Error(signal?.aborted ? '已中止' : '请求超时')
  if (broken) throw new Error('输出不完整')
  return text
}

/** 从模型输出里取出 JSON 对象的 entries 数组；取不到返回 null。 */
export function parseJsonEntries(text: string): unknown[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  try {
    const raw = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null
    const list = (raw as { entries?: unknown } | null)?.entries
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

/** 解析并校验模型给出的条目；不合格（解析不了、有条目超长、写入新条目后仍接近上限）一律不用。 */
function parseEntries(
  text: string,
  scope: MemoryScope,
  before: MemoryEntry[],
  incoming: MemoryInput
): { ok: true; entries: MemoryEntry[] } | { ok: false; reason: string } {
  const lim = memoryLimits(scope)
  const list = parseJsonEntries(text)
  if (!list) return { ok: false, reason: '归纳结果不是有效的 JSON' }

  const byId = new Map(before.map((e) => [e.id, e]))
  const used = new Set<string>()
  const out: MemoryEntry[] = []
  const now = Date.now()
  const incomingTitle = normalizeTitle(incoming.title ?? '').toLowerCase()
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>
    const title = normalizeTitle(typeof o.title === 'string' ? o.title : '')
    const body = normalizeBody(typeof o.body === 'string' ? o.body : '')
    if (!title || title.toLowerCase() === incomingTitle) continue
    if (title.length > MEMORY_TITLE_MAX || body.length > MEMORY_BODY_MAX)
      return { ok: false, reason: '归纳后有条目超长' }
    if (out.some((e) => e.title.toLowerCase() === title.toLowerCase())) continue
    const old = typeof o.id === 'string' && !used.has(o.id) ? byId.get(o.id) : undefined
    const type = isMemoryType(o.type) ? o.type : (old?.type ?? 'user')
    if (old) {
      used.add(old.id)
      const same = old.title === title && old.body === body && old.type === type
      out.push(same ? old : { ...old, type, title, body, updatedAt: now })
    } else {
      out.push({ id: newMemoryId(scope, [...before, ...out]), type, title, body, createdAt: now, updatedAt: now })
    }
  }
  // 写入新条目后仍须低于上限的九成：只删一两条就交差，下一次写入马上又要归纳，白花调用。
  const room = formatMemoryLine({ id: 'x_00000000', type: incoming.type ?? 'user', title: incoming.title ?? '' }).length
  if (out.length + 1 > lim.maxEntries * ACCEPT_RATIO || memoryUsage(out) + room > lim.budget * ACCEPT_RATIO)
    return { ok: false, reason: '归纳后仍接近上限' }
  return { ok: true, entries: out }
}

/**
 * 归纳期间别的对话也可能改了记忆：期间新增的条目原样保留，期间被删掉的不再写回；
 * 期间改过内容的条目以归纳结果为准（影响很小，且归纳前已备份）。
 */
function mergeConcurrent(before: MemoryEntry[], result: MemoryEntry[], current: MemoryEntry[]): MemoryEntry[] {
  const was = new Set(before.map((e) => e.id))
  const now = new Set(current.map((e) => e.id))
  return [
    ...result.filter((e) => !was.has(e.id) || now.has(e.id)),
    ...current.filter((e) => !was.has(e.id))
  ]
}

/** 归纳前的全部条目存一份到记忆文件同目录的 memory-backups/，只留最近几份；返回备份路径。 */
function backupMemories(scope: MemoryScope, entries: MemoryEntry[]): string {
  const dir = join(dirname(memoryPath(scope)), 'memory-backups')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `memory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const body = {
    version: 2,
    ...(scope.kind === 'project' ? { root: scope.root } : scope.kind === 'role' ? { personaId: scope.personaId } : {}),
    entries
  }
  writeFileAtomic(file, JSON.stringify(body, null, 2))
  const all = readdirSync(dir)
    .filter((f) => /^memory-\d.+\.json$/.test(f))
    .sort()
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(dir, f), { force: true })
  return file
}
