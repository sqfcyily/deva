import type { TextPart } from '../providers/types'

/**
 * 「/技能名」显式触发（见 chat-turns.ts startTurn）：发给模型的正文是技能全文 + 用户的原话，气泡显示的则是
 * 用户实际打的字（TextPart.display）。正文的格式与旧记录的还原放在一处，改格式时两边一起改。
 * 叶子模块：只依赖消息类型。
 */

const HEAD = '（用户通过 '
const BLOCK_END = '\n===== 指令结束 ====='
const LEAD_REST = '\n\n用户补充：'
const INLINE_REST = '\n\n用户的消息：'

/**
 * 发给模型的正文。body = 技能全文（含技能目录说明）；rest = 用户原话里除开头那个 /技能名 之外的部分；
 * lead = 原话是否以某个技能的 /技能名 开头（是则它已从 rest 里剥掉，否则 rest 就是原话）。
 */
export function skillInvocationText(skills: { name: string; body: string }[], rest: string, lead: boolean): string {
  const names = skills.map((s) => s.name)
  return (
    `${HEAD}${names.map((n) => `/${n}`).join('、')} 显式激活了技能${names.map((n) => `「${n}」`).join('')}，请严格据下述指令完成本次任务）\n` +
    skills.map((s) => `===== 技能指令：${s.name} =====\n${s.body}${BLOCK_END}`).join('\n') +
    (rest ? `${lead ? LEAD_REST : INLINE_REST}${rest}` : '')
  )
}

/**
 * 旧记录（没存 display）里技能展开过的正文 → 用户的原话；不是展开过的正文给 null。
 * 开头的 /技能名 已被剥掉、只知道是第一个技能，按「/技能名 补充」拼回。结尾可能还带附件说明「\n（…）」，原样保留。
 */
function legacyShown(text: string): string | null {
  if (!text.startsWith(HEAD)) return null
  const first = /^\/([^\s、]+)/.exec(text.slice(HEAD.length))?.[1]
  const end = text.lastIndexOf(BLOCK_END)
  if (!first || end < 0) return null
  const after = text.slice(end + BLOCK_END.length)
  if (after.startsWith(INLINE_REST)) return after.slice(INLINE_REST.length)
  if (after.startsWith(LEAD_REST)) return `/${first} ${after.slice(LEAD_REST.length)}`
  return `/${first}${after}`
}

/**
 * 用户消息正文（字符串消息，或提问正文块）在气泡里显示的文字：有 display 用它，旧记录里技能展开过的
 * 还原原话，其余原样。
 */
export function shownText(p: TextPart | string): string {
  if (typeof p === 'string') return legacyShown(p) ?? p
  return p.display ?? legacyShown(p.text) ?? p.text
}
