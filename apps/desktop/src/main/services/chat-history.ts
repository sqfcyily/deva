/**
 * 对话记录的按轮操作：划分轮次、按轮删除（连同各边车）、补齐悬空的工具调用。
 */

import {
  type ContentPart, type Message
} from '../providers/types'
import {
  type StoredSession
} from './chat-store'
import {
  isAutoNudge,
  isCompactionSummary
} from './compaction'

/**
 * 一条 provider 消息是否为「一轮的起点」（= 一条真实用户消息，恰好对应展示层一个用户气泡）。
 * 排除：assistant 消息；压缩摘要（带标记的 user 字符串消息，展示为 assistant 气泡）；
 * 工具结果回灌消息（user 角色但含 tool_result，展示层并入上一条 assistant、不单独成气泡）。
 * 与 toDisplayMessages 的判定同源，故「数用户气泡」在渲染层与主进程逐一对齐——轮下标据此天然一致。
 */
function isTurnStart(m: Message): boolean {
  if (m.role !== 'user') return false
  if (isCompactionSummary(m)) return false
  if (isAutoNudge(m)) return false
  if (typeof m.content === 'string') return true
  return !m.content.some((p) => p.type === 'tool_result')
}

/**
 * 把 messages 划分为「轮」区间（end 独占）。第 k 个区间 = 第 k 轮（0 基，与展示层用户气泡序一致）：
 * 从某轮起点起、直到下一轮起点前的全部消息（含该轮的工具调用与其结果）都归入本轮。
 * 首个轮起点之前的消息（如压缩摘要前言）不属于任何轮、不在返回区间内——故按轮删不会误删前言。
 */
export function turnRanges(messages: Message[]): { start: number; end: number }[] {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (isTurnStart(messages[i])) starts.push(i)
  const ranges: { start: number; end: number }[] = []
  for (let k = 0; k < starts.length; k++)
    ranges.push({ start: starts[k], end: k + 1 < starts.length ? starts[k + 1] : messages.length })
  return ranges
}

/** 自愈补上的占位结果正文：回合在工具执行中被打断，工具可能跑了一半，结果未知。 */
export const DANGLING_RESULT = '此工具调用未完成（回合意外中断），结果未知；如有需要请重新执行。'

/**
 * 修补历史里的悬空 tool_use（有调用、无结果）。服务商要求每个 tool_use 之后紧跟其 tool_result，
 * 缺一个，此后每次请求都会被 400 拒收，对话就此「坏死」。来源：进程在工具执行中被强退 / 崩溃
 * （逐步落盘会把「调用已发出、结果未回灌」的中间态写进磁盘）、工具执行抛异常、以及本修复之前
 * 中止回合留下的旧数据。
 * 做法：缺的结果补一条占位 tool_result。下一条已是回灌消息就并入其 tool_result 区段（Anthropic
 * 要求 tool_result 排在最前）；否则紧随其后插一条独立回灌消息——**绝不并入用户文本消息**：
 * 含 tool_result 的 user 消息在展示层不成气泡，会把用户那句话吞掉。插入使其后消息下标 +1，
 * notices 边车的 after 锚点同步平移。ask_user / exit_plan 缺边车时记「取消」，免得重开后凭空
 * 多出一张可交互的卡。
 * **只能在会话空闲时调用**：进行中的回合里，悬空 tool_use 是「工具正在执行」的正常中间态。
 * 返回是否有改动（调用方据此决定是否落盘）。
 */
export function repairDanglingToolUses(s: StoredSession): boolean {
  let changed = false
  const msgs = s.messages
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const uses = m.content.filter(
      (p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use'
    )
    if (uses.length === 0) continue
    const next = msgs[i + 1] as Message | undefined
    const nextParts = next && next.role === 'user' && typeof next.content !== 'string' ? next.content : null
    const have = new Set<string>()
    if (nextParts) for (const p of nextParts) if (p.type === 'tool_result') have.add(p.toolUseId)
    const missing = uses.filter((u) => !have.has(u.id))
    if (missing.length === 0) continue

    const fill: ContentPart[] = missing.map((u) => ({
      type: 'tool_result',
      toolUseId: u.id,
      content: DANGLING_RESULT,
      isError: true
    }))
    for (const u of missing) {
      if (u.name === 'ask_user') (s.asks ??= {})[u.id] ??= { answers: null }
      else if (u.name === 'exit_plan') (s.plans ??= {})[u.id] ??= { decision: null }
      else (s.summaries ??= {})[u.id] ??= '未完成'
    }
    if (next && nextParts && have.size > 0) {
      // 已是回灌消息：补在其 tool_result 区段之后、其余部分之前。
      let cut = 0
      nextParts.forEach((p, k) => {
        if (p.type === 'tool_result') cut = k + 1
      })
      next.content = [...nextParts.slice(0, cut), ...fill, ...nextParts.slice(cut)]
    } else {
      msgs.splice(i + 1, 0, { role: 'user', content: fill })
      // 锚在该 assistant 之后的提示随之后移，排到补上的回灌消息之后（回灌消息先回填工具卡状态）。
      if (s.notices?.length)
        s.notices = s.notices.map((nt) => (nt.after > i ? { ...nt, after: nt.after + 1 } : nt))
    }
    changed = true
  }
  return changed
}

/** 每轮的全部 tool_use id（第 k 项 = 第 k 轮，与 turnRanges 同序）：检查点按 toolUseId 归属，据此反查到轮。 */
export function turnToolIds(messages: Message[]): string[][] {
  return turnRanges(messages).map(({ start, end }) => {
    const ids: string[] = []
    for (let i = start; i < end; i++) {
      const c = messages[i].content
      if (typeof c !== 'string') for (const p of c) if (p.type === 'tool_use') ids.push(p.id)
    }
    return ids
  })
}
