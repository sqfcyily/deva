import type { CompactModelConfig } from './compaction'
import { askMemoryModel, parseJsonEntries } from './memory-consolidate'
import {
  MEMORY_TITLE_MAX,
  finishMemoryTidy,
  isMemoryType,
  listMemories,
  memoryPath,
  memoryTidyState,
  normalizeTitle,
  scopeLabel,
  type MemoryEntry,
  type MemoryScope
} from './memory'

/**
 * 旧版记忆的一次性整理（方案 design/memory-v2-plan.html 第 9 节）。
 *
 * 旧版每条只有一句话；读到时 memory.ts 已按规则转换（标题取第一句、正文保留原文、类型暂记为「用户」）并标记待整理。
 * 这里在之后的对话里用当轮模型补上类型与更好的标题：正文始终保留原文，模型只给类型和标题。后台进行，不等它，
 * 也不影响本轮；整理完的变化随下一步的【记忆更新】告知模型。失败了下一轮再试，累计失败 3 次即放弃、保留规则转换的结果。
 * 整理期间被改过或删掉的条目不覆盖（以用户 / 模型的新改动为准）。
 */

const MAX_TRIES = 3

/** 同一份记忆文件同时只整理一次。 */
const inflight = new Set<string>()

/** 对给出的各层检查是否待整理，有就在后台整理（不等待、不抛错）。 */
export function tidyPendingMemories(scopes: MemoryScope[], model: CompactModelConfig | undefined): void {
  if (!model) return
  for (const scope of scopes) {
    const key = memoryPath(scope)
    if (inflight.has(key)) continue
    const state = memoryTidyState(scope)
    if (!state.pending) continue
    inflight.add(key)
    void tidy(scope, model, state.tries)
      .catch((e) => console.warn(`[memory] 整理旧记忆失败（${scopeLabel(scope)}）：`, (e as Error)?.message ?? e))
      .finally(() => inflight.delete(key))
  }
}

async function tidy(scope: MemoryScope, model: CompactModelConfig, tries: number): Promise<void> {
  const before = listMemories(scope)
  if (before.length === 0) return finishMemoryTidy(scope, null, true)
  const system = [
    '你负责把用户旧版的长期记忆整理成新格式。旧版每条只有一句话；新版每条有类型和一句话标题，原文会原样保留为正文，你不用改写原文。',
    '',
    '类型（四选一）：',
    '- user：用户本人的身份、职责、熟悉什么、偏好。',
    '- feedback：用户纠正过或确认过的做事方式（规则、要求、「做法 + 原因」）。',
    '- project：进行中的工作、决定、截止日期。',
    '- reference：外部资料或工具在哪、怎么用（网址、路径、看板、本机工具）。',
    '',
    `标题：一句话概括这条记忆，不超过 ${Math.min(40, MEMORY_TITLE_MAX)} 字，只看标题就能判断它和什么任务相关；保持原文的语言；不得编造原文没有的信息。`,
    '',
    '只输出 JSON，不要任何其他文字，每条旧记忆一项，id 原样照抄：',
    '{"entries":[{"id":"…","type":"user|feedback|project|reference","title":"…"}]}'
  ].join('\n')
  const user = [`旧版${scopeLabel(scope)}（${before.length} 条）：`, ...before.map((e) => `- [${e.id}] ${e.body || e.title}`)].join('\n')

  let result: MemoryEntry[] | null = null
  try {
    const list = parseJsonEntries(await askMemoryModel(model, system, user))
    if (list) result = apply(before, list)
  } catch (e) {
    console.warn(`[memory] 整理旧记忆的请求失败（${scopeLabel(scope)}）：`, (e as Error)?.message ?? e)
  }
  if (!result) return finishMemoryTidy(scope, null, tries + 1 >= MAX_TRIES)
  // 整理期间被改过或删掉的不覆盖：只更新仍在、且没被改过的条目。
  const byId = new Map(result.map((e) => [e.id, e]))
  const was = new Map(before.map((e) => [e.id, e.updatedAt]))
  const merged = listMemories(scope).map((cur) => (was.get(cur.id) === cur.updatedAt ? (byId.get(cur.id) ?? cur) : cur))
  finishMemoryTidy(scope, merged, true)
}

/** 校验模型给出的类型与标题，套到原条目上；一条都对不上视为失败。 */
function apply(before: MemoryEntry[], list: unknown[]): MemoryEntry[] | null {
  const byId = new Map(before.map((e) => [e.id, e]))
  const out = new Map<string, MemoryEntry>()
  const titles = new Set<string>()
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>
    const old = typeof o.id === 'string' ? byId.get(o.id) : undefined
    if (!old || out.has(old.id)) continue
    const title = normalizeTitle(typeof o.title === 'string' ? o.title : '')
    const key = title.toLowerCase()
    // 标题不合格或与别条撞名：保留规则转换的标题，类型照用。
    const okTitle = title && title.length <= MEMORY_TITLE_MAX && !titles.has(key)
    if (okTitle) titles.add(key)
    out.set(old.id, {
      ...old,
      type: isMemoryType(o.type) ? o.type : old.type,
      title: okTitle ? title : old.title
    })
  }
  if (out.size === 0) return null
  return before.map((e) => out.get(e.id) ?? e)
}
