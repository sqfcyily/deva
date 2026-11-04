/**
 * 清单随消息下发（对标 Claude Code 的 skill_listing / deferred_tools_delta 附件）：技能清单、记忆条目，
 * 以及复杂工具首次用到时的详细用法（toolGuidePart）。
 *
 * 提示缓存按前缀字节匹配，渲染顺序是 tools → system → messages：这类会变的清单若写在工具描述或系统提示词里，
 * 装一个技能、记一条记忆，下一轮整段历史都得重新写缓存。故工具描述与系统提示词只写固定说明，清单改为
 * **文字块附在消息里**下发：首次给完整清单，之后与已告知的不一致时只发增量（新增 / 更新 / 移除）。
 * 块随消息落盘，后续请求原样重放，已缓存的前缀一字不动。
 *
 * **已告知状态不另存，从历史折叠得出**（按序叠加各块的 listed / removed）：压缩把早先的块摘要掉、按轮删除
 * 或回滚删掉含块的那轮之后，折叠结果自然缺了这部分，下一次请求即把缺的补发——无需任何边车同步。
 * 每块在 TextPart.listing 上带结构化记录，折叠不解析文案；适配器只发 text，这个字段不会发给模型。
 * 工具结果本身已把变化告诉了模型时（memory_write / memory_delete），记录挂在该 tool_result 上，同样计入折叠，
 * 免得紧接着再重复告知一遍。
 */
import { createHash } from 'node:crypto'
import type { ContentPart, ListingKind, ListingRecord, Message, TextPart } from '../providers/types'
import { isAutoNudge, isCompactionSummary, isTaskNotification } from './compaction'
import {
  GLOBAL_SCOPE,
  MEMORY_BUDGET_CHARS,
  PROJECT_MEMORY_BUDGET_CHARS,
  formatMemoryLine,
  listMemories,
  type MemoryEntry
} from './memory'

/** 内容摘要：内容变了即视为更新，需重新告知。 */
function digestOf(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 12)
}

/** 历史里某类清单已告知的条目：键 → 内容摘要。 */
function announced(history: Message[], kind: ListingKind): Map<string, string> {
  const known = new Map<string, string>()
  for (const m of history) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const p of m.content) {
      const rec = p.type === 'text' || p.type === 'tool_result' ? p.listing : undefined
      if (!rec || rec.kind !== kind) continue
      for (const s of rec.listed) known.set(s.key, s.digest)
      for (const k of rec.removed ?? []) known.delete(k)
    }
  }
  return known
}

interface ListingDiff<T> {
  /** 历史里还没告知过任何条目（首次，或被压缩 / 删轮抹掉了）：用完整清单的措辞。 */
  initial: boolean
  /** 新增或内容有更新的条目。 */
  listed: T[]
  /** 已告知过、如今不在了的键。 */
  removed: string[]
  record: ListingRecord
}

/** 当前条目与历史里已告知的差异；一致则返回 null。 */
function diffListing<T>(
  history: Message[],
  kind: ListingKind,
  items: T[],
  key: (t: T) => string,
  content: (t: T) => string
): ListingDiff<T> | null {
  const known = announced(history, kind)
  const listed = items.filter((t) => known.get(key(t)) !== digestOf(content(t)))
  const keys = new Set(items.map(key))
  const removed = [...known.keys()].filter((k) => !keys.has(k))
  if (!listed.length && !removed.length) return null
  return {
    initial: known.size === 0,
    listed,
    removed,
    record: {
      kind,
      listed: listed.map((t) => ({ key: key(t), digest: digestOf(content(t)) })),
      ...(removed.length ? { removed } : {})
    }
  }
}

/**
 * 请求模型前调用：build 据历史算出清单块（无差异给 null），附到历史末条——它是这次请求才首次发出的那条
 * user 消息（用户提问 / 工具结果），附上去不碰已缓存的前缀。已告知过则 build 给 null，故重连重发时调用多少次都一样。
 * 末条是带标记的字符串消息（压缩摘要 / 自愈引导 / 后台通知）时不附：它们靠字符串前缀识别，改成块数组就
 * 认不出了——留给下一条消息（多为下一步的工具结果）。
 */
export function attachListing(history: Message[], build: (history: Message[]) => TextPart | null): void {
  const i = history.length - 1
  const last = history[i]
  if (!last || last.role !== 'user') return
  if (isCompactionSummary(last) || isAutoNudge(last) || isTaskNotification(last)) return
  const part = build(history)
  if (!part) return
  let content: ContentPart[]
  if (typeof last.content === 'string') content = [part, { type: 'text', text: last.content }]
  // 工具结果消息：协议要求 tool_result 块在前，文字跟在后面（同后台任务通知）。
  else if (last.content.some((p) => p.type === 'tool_result')) content = [...last.content, part]
  // 用户提问：放最前，提问正文仍是最后一个 text 块（展示层只取它作气泡正文）。
  else content = [part, ...last.content]
  // 换新对象而不就地改：fork 的历史与主对话共享消息对象，按不可变对待。
  history[i] = { ...last, content }
}

// ── 技能清单 ──────────────────────────────────────────────────────────────────

type SkillSummary = { name: string; description: string }

function skillLine(s: SkillSummary): string {
  return `- ${s.name}${s.description ? `：${s.description}` : ''}`
}

/** 当前已启用技能与历史里已告知的差异，生成一块技能清单；一致则返回 null。 */
export function skillListingPart(history: Message[], skills: SkillSummary[]): TextPart | null {
  // 同名（大小写不敏感）只留第一个，与 loadSkillInstructionsByName 的命中一致；否则同名两项轮流不一致，每步都会重发。
  const seen = new Set<string>()
  const current = skills.filter((s) => {
    const k = s.name.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const d = diffListing(history, 'skills', current, (s) => s.name, (s) => s.description)
  if (!d) return null

  const lines: string[] = []
  if (d.initial) {
    lines.push('【可用技能】以下技能可通过 skill 工具加载（传入其名称 name）；用户也可用「/技能名」显式触发：', ...d.listed.map(skillLine))
  } else {
    lines.push('【技能清单更新】')
    if (d.listed.length) lines.push('以下技能现已可用（新增或描述有更新），可通过 skill 工具加载：', ...d.listed.map(skillLine))
    if (d.removed.length) lines.push(`以下技能已不再可用，不要再调用：${d.removed.join('、')}`)
  }
  lines.push('（以上由系统自动附带，不是用户发来的消息；技能再有增减或更新时会另行告知，以最近的告知为准。）')
  return { type: 'text', text: lines.join('\n'), listing: d.record }
}

// ── 记忆条目 ──────────────────────────────────────────────────────────────────

/** 按预算截取（写入已按总量拒超，正常不会截断；这里兜底手改文件 / 旧数据）。 */
function withinBudget(entries: MemoryEntry[], budget: number): { kept: MemoryEntry[]; omitted: number } {
  const kept: MemoryEntry[] = []
  let used = 0
  for (const e of entries) {
    const len = formatMemoryLine(e).length
    if (used + len > budget) break
    kept.push(e)
    used += len
  }
  return { kept, omitted: entries.length - kept.length }
}

/**
 * 当前记忆（全局 + 已挂载工作区的项目私有记忆）与历史里已告知的差异，生成一块记忆清单；一致则返回 null。
 * root 取工具上下文的实时工作区：轮中挂载 / 切换后，新工作区的项目记忆随下一步附上，旧工作区的记作不再适用。
 */
export function memoryListingPart(history: Message[], root: string | null): TextPart | null {
  const g = withinBudget(listMemories(GLOBAL_SCOPE), MEMORY_BUDGET_CHARS)
  const p = root
    ? withinBudget(listMemories({ kind: 'project', root }), PROJECT_MEMORY_BUDGET_CHARS)
    : { kept: [], omitted: 0 }
  const items = [
    ...g.kept.map((entry) => ({ entry, project: false })),
    ...p.kept.map((entry) => ({ entry, project: true }))
  ]
  const d = diffListing(history, 'memory', items, (i) => i.entry.id, (i) => i.entry.content)
  if (!d) return null

  const lines = [
    d.initial
      ? '【记忆条目】以下是当前已记住的记忆（方括号里是 id，供 memory_write 更新、memory_delete 删除）：'
      : '【记忆更新】'
  ]
  const tag = d.initial ? '' : '（新增或内容有更新）'
  const globals = d.listed.filter((i) => !i.project)
  const projects = d.listed.filter((i) => i.project)
  if (globals.length) lines.push(`全局记忆${tag}：`, ...globals.map((i) => formatMemoryLine(i.entry)))
  if (projects.length) lines.push(`项目私有记忆${tag}（${root}）：`, ...projects.map((i) => formatMemoryLine(i.entry)))
  if (d.removed.length) lines.push(`以下记忆已删除或不再适用于当前工作区，不要再遵循：${d.removed.join('、')}`)
  const omitted = g.omitted + p.omitted
  if (omitted) lines.push(`（另有 ${omitted} 条超出预算未列出，可用 memory_read 查看全部；记忆偏多时请合并或清理过时条目。）`)
  lines.push('（以上由系统自动附带，不是用户发来的消息；记忆再有变化时会另行告知，以最近的告知为准。）')
  return { type: 'text', text: lines.join('\n'), listing: d.record }
}

/** memory_write 成功：工具结果里已写明该条，记为已告知（挂在 tool_result 上）。 */
export function memoryWrittenRecord(entry: MemoryEntry): ListingRecord {
  return { kind: 'memory', listed: [{ key: entry.id, digest: digestOf(entry.content) }] }
}

/** memory_delete 成功：工具结果里已写明删除，记为已告知。 */
export function memoryDeletedRecord(id: string): ListingRecord {
  return { kind: 'memory', listed: [], removed: [id] }
}

// ── 工具详细用法 ──────────────────────────────────────────────────────────────

/**
 * 复杂工具的详细用法，首次用到时随该步结果附上一次（同技能：平时只有描述，用时才加载正文）。
 * 工具描述只留决定「用不用、选哪个动作」所需的内容，其余放这里：工具表不变，提示缓存前缀不受影响。
 * 已告知状态同样从历史折叠：压缩 / 删轮抹掉后，下次再用到时自动补发；用法文案改了（摘要变）也会重发。
 * 只在末条消息带着该工具本步的结果时给出，否则返回 null。
 */
export function toolGuidePart(history: Message[], tool: string, guide: string): TextPart | null {
  const last = history[history.length - 1]
  if (!last || last.role !== 'user' || typeof last.content === 'string') return null
  const ids = new Set<string>()
  for (const p of last.content) if (p.type === 'tool_result') ids.add(p.toolUseId)
  if (!ids.size) return null
  // 本步结果对应的调用在紧挨着的上一条助手消息里
  const prev = history[history.length - 2]
  const used =
    prev?.role === 'assistant' &&
    typeof prev.content !== 'string' &&
    prev.content.some((p) => p.type === 'tool_use' && p.name === tool && ids.has(p.id))
  if (!used) return null
  const digest = digestOf(guide)
  if (announced(history, 'guide').get(tool) === digest) return null
  return {
    type: 'text',
    text: `${guide}\n（以上是 ${tool} 工具的详细用法，由系统在你首次用到它时自动附带，不是用户发来的消息。）`,
    listing: { kind: 'guide', listed: [{ key: tool, digest }] }
  }
}
