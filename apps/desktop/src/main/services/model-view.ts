import type { Message } from '../providers/types'

/**
 * 对话记录里「模型实际看到的部分」。压缩不删消息（见 compaction.ts），只在边界插入一条摘要；发给模型的
 * 内容、要不要压缩、对话文件怎么拆分存盘（chat-store.ts）都按这里截取。
 * 叶子模块：只依赖消息类型，compaction.ts 与 chat-store.ts 都引用它而不互相引用。
 */

/** 摘要消息的标记前缀：极不可能被用户键入；发给模型时据此截取、界面上据此画压缩提示。 */
export const COMPACT_MARKER = '⟦deva:compaction⟧'

/**
 * 引擎自愈引导消息的标记前缀（输出被截断后续写、空回合追问等）。这类 user 消息由主进程注入，
 * 不是用户说的话：不算一轮起点、不渲染成用户气泡、不进压缩转录。
 */
export const AUTO_MARKER = '⟦deva:auto⟧'

/** 该消息是否为压缩摘要。 */
export function isCompactionSummary(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(COMPACT_MARKER)
}

/** 该消息是否为引擎注入的自愈引导（见 AUTO_MARKER）。 */
export function isAutoNudge(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(AUTO_MARKER)
}

export function hasToolResult(m: Message): boolean {
  return typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result')
}

/**
 * 真实用户轮：role=user 且不含 tool_result（工具结果回灌消息不算），也不是压缩摘要——
 * 轮中压缩会把摘要放在本轮中间，摘要若算作轮起点，下次压缩就会把它当成「本轮请求」保留、
 * 而把真正的请求原文压掉。
 */
export function isGenuineUserTurn(m: Message): boolean {
  return m.role === 'user' && !hasToolResult(m) && !isCompactionSummary(m) && !isAutoNudge(m)
}

/** 最后一轮（一轮进行中即当前这轮）的起点：最后一条真实用户消息的下标，没有则 -1。 */
export function lastTurnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isGenuineUserTurn(messages[i])) return i
  return -1
}

/**
 * 模型实际看到的部分：从最后一条压缩摘要起（start），一轮进行中压缩的还要在前面带上那一轮的
 * 请求原文（head，否则 -1）。没压缩过时 start = 0。
 * 由消息结构判断、不需额外字段：两轮之间压缩，摘要紧挨着保留部分的第一条真实用户消息；一轮进行中压缩，
 * 摘要插在这一轮中间，后面紧跟的是助手消息，这一轮的请求在摘要之前。旧版压缩直接删掉了早期消息
 * （摘要在最前，或轮内时紧跟在本轮请求之后），按同一规则得到的仍是原来发给模型的那些。
 */
export function modelRange(messages: Message[]): { head: number; start: number } {
  let s = -1
  for (let i = messages.length - 1; i >= 0; i--)
    if (isCompactionSummary(messages[i])) {
      s = i
      break
    }
  if (s < 0) return { head: -1, start: 0 }
  const next = messages[s + 1]
  if (!next || isGenuineUserTurn(next)) return { head: -1, start: s }
  return { head: lastTurnStart(messages.slice(0, s)), start: s }
}

/** 对话记录里从哪条起仍会发给模型（一轮进行中压缩时，那一轮的请求原文在它之前另行带上）。 */
export function modelStart(messages: Message[]): number {
  return modelRange(messages).start
}

/**
 * 模型视图最早用到的那条消息的下标（有 head 即 head）：它之前的消息已不发给模型，对话文件把这一段
 * 拆到单独的文件里存（见 chat-store.ts），每步只重写之后的部分。
 */
export function modelFirst(messages: Message[]): number {
  const { head, start } = modelRange(messages)
  return head >= 0 ? head : start
}

/**
 * 发给模型的消息（见 modelRange）。没压缩过时原样返回同一个数组；否则是新数组，但消息对象与记录共享
 * ——要改写某条消息须改记录本身（如 attachListing 换掉末条），这里的视图下次重算即可。
 */
export function modelMessages(messages: Message[]): Message[] {
  const { head, start } = modelRange(messages)
  if (head < 0 && start === 0) return messages
  const tail = messages.slice(start)
  return head >= 0 ? [messages[head], ...tail] : tail
}
