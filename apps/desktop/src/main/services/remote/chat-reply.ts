import { paginate } from './paginate'
import { getChannelConfig } from './store'
import type { ChannelId, ChatAddress, MessageHandle, RemoteAdapter, ReplyView, TurnBlock, TurnStatus } from './types'

/**
 * 聊天式回复（回复方式 =「仅最终结果」）：手机上像跟人聊天。
 *
 *  · 工作中只挂「正在输入」（Telegram 输入状态 / 飞书在你的消息上挂表情），工具、状态行、过渡文字一概不发；
 *    停下来等你决定时收起，作答后再挂上。
 *  · 回合结束发一条普通消息：最后一段正文（与 agent-loop 交差用的 finalText 同一段）。
 *    出错 / 停止 / 没有回复时，只对手机端参与了的私聊回一句。
 *  · 需要你处理的交互卡（提问、计划、挂载、名片）照常由 hub 另发。
 */

export function chatStyle(channel: ChannelId): boolean {
  return getChannelConfig(channel).replyMode === 'final'
}

/** 一轮在某个私聊里的聊天式投递状态（hub 的 Post 带着这几项）。 */
export interface ChatReplyPost {
  chat: ChatAddress
  /** 对同一私聊的平台调用排队执行（与流式卡片共用）。 */
  chain: Promise<void>
  /** 这一轮要回应的手机消息（飞书在上面挂「正在输入」表情）。 */
  anchors: MessageHandle[]
  typing: boolean
  /** 手机端参与了这一轮（发起、插入、作答、停止）：出错、停止、没有回复时也要回一句。 */
  asked: boolean
  /** 已决定发出最终回复（同步置位：hub 据此判断定时任务摘要是否重复）。 */
  replied: boolean
}

function queue(post: ChatReplyPost, fn: () => Promise<unknown>): void {
  post.chain = post.chain
    .then(fn)
    .then(() => undefined)
    .catch((e) => console.warn('[remote] 聊天式回复失败：', (e as Error)?.message ?? e))
}

function showTyping(adapter: RemoteAdapter, post: ChatReplyPost): void {
  post.typing = true
  const anchors = [...post.anchors]
  queue(post, () => adapter.startTyping(post.chat, anchors))
}

/** 手机端在这一轮里说了话（发起 / 插入 / 作答）：记下要回应的消息，挂上「正在输入」。 */
export function followTurn(adapter: RemoteAdapter, post: ChatReplyPost, anchor?: MessageHandle): void {
  post.asked = true
  if (anchor && !post.anchors.includes(anchor)) post.anchors.push(anchor)
  showTyping(adapter, post)
}

/** 作答后接着干：手机端参与了的私聊重新挂上「正在输入」。 */
export function resumeTyping(adapter: RemoteAdapter, post: ChatReplyPost): void {
  if (post.asked && !post.typing) showTyping(adapter, post)
}

export function hideTyping(adapter: RemoteAdapter, post: ChatReplyPost): void {
  if (!post.typing) return
  post.typing = false
  const anchors = [...post.anchors]
  queue(post, () => adapter.stopTyping(post.chat, anchors))
}

interface TurnOutcome {
  blocks: TurnBlock[]
  status: TurnStatus
  statusText?: string
}

/** 回合结束：收起「正在输入」，发最终回复（超长分几条发）。 */
export function deliverReply(adapter: RemoteAdapter, post: ChatReplyPost, turn: TurnOutcome): void {
  hideTyping(adapter, post)
  const view = composeReply(turn, post.asked)
  if (!view) return
  post.replied = true
  const pages = paginate([{ kind: 'text', text: view.text }], adapter.pageChars).map((p) =>
    p.map((b) => b.text).join('')
  )
  queue(post, async () => {
    for (let i = 0; i < pages.length; i++)
      await adapter.sendReply(post.chat, { text: pages[i], note: i === pages.length - 1 ? view.note : undefined })
  })
}

/** 这一轮发什么。asked = 手机端参与了：出错、停止、没有回复时回一句；否则只在有正文时转发。 */
export function composeReply(turn: TurnOutcome, asked: boolean): ReplyView | null {
  if (turn.status === 'aborted') return asked ? { text: '已停止。' } : null
  if (turn.status === 'error') {
    if (!asked) return null
    const err = turn.blocks.findLast((b) => b.kind === 'error')?.text ?? turn.statusText ?? '出错了'
    return { text: `没能完成：${err}` }
  }
  const text = turn.blocks.findLast((b) => b.kind === 'text' && b.text.trim())?.text.trim()
  if (text) return { text, note: turn.statusText }
  if (!asked) return null
  return { text: turn.statusText ?? '本轮没有产生回复。' }
}
