/**
 * 后台子智能体：登记、取消，结束后的通知排队，以及会话空闲时为通知起一轮让模型汇总。
 */
import type {
  ChatModelConfig
} from '../../shared/chat-protocol'
import { getSession, save as saveProject } from './chat-store'
import { isEn } from '../locale'
import {
  NOTIFY_MARKER
} from './compaction'
import { repairDanglingToolUses } from './chat-history'
import { backgroundSubagents, shuttingDown, pendingUndo, genId, historyLocked } from './chat-state'
import { commitHandoffs } from './chat-task-handoff'
import { commitMemberReports } from './chat-members'
import { emitTurnStart, runTurn } from './chat-turns'

/** 已有结论（未被用户停止）、还在等同组其余几个的后台子智能体组：最后一个哪怕是被停止的也照样唤醒。 */
export const bgGroupsWaiting = new Set<string>()

/**
 * 待交给主智能体的后台任务通知（键 = sessionId，按到达先后）。投递时机，先到先得：
 *  · 该会话正有一轮在跑 → 下一步请求前随工具结果一并带上；
 *  · 会话空闲且 wake → 立即自动起一轮（消息以 NOTIFY_MARKER 开头）；
 *  · 都不满足（用户停止的 / 起不了轮）→ 随用户下一条消息带上。
 */
interface PendingNotice {
  /** 对应的 Task 卡 id：所在轮次被删时据此撤回。 */
  toolUseId: string
  /** 展示用一句话标题（自动起轮时作通知行的文案）。 */
  headline: string
  /** 交给模型的通知正文。 */
  body: string
  /** 会话空闲时是否为它自动起一轮。 */
  wake: boolean
  /** 派发时的模型：自动起轮时本对话模型解析不了就用它。 */
  model: ChatModelConfig
  /** 内容已直接显示给用户（成员交差、用户直接跟成员说的话）：主智能体不必转述。 */
  shown?: boolean
  /** 派发它的那一轮是手机端发起的：为它自动起的一轮同样按手机端算（全是这种通知时）。 */
  remote?: boolean
  /** 后台子智能体的结局：一次唤醒带着好几个时，通知行合写成一句「3 个后台子智能体已完成」（见 notifyHeadline）。 */
  subagent?: 'done' | 'failed' | 'stopped'
}

export const pendingNotices = new Map<string, PendingNotice[]>()

/**
 * 中止某会话的后台子智能体（keep 中的调用 id 除外），一律按 silent 处理。用于删会话 / 清空 / 按轮删除 /
 * 回滚：派发它的调用已不在上下文里，它的结论也就无处可交。连同已排队、尚未投递的通知一并撤回。
 */
export function cancelBackground(sessionId: string, keep?: Set<string>): void {
  for (const [id, b] of backgroundSubagents)
    if (b.sessionId === sessionId && !keep?.has(id)) {
      b.silent = true
      b.controller.abort()
    }
  const queue = pendingNotices.get(sessionId)
  if (!queue) return
  const left = keep ? queue.filter((n) => keep.has(n.toolUseId)) : []
  if (left.length) pendingNotices.set(sessionId, left)
  else pendingNotices.delete(sessionId)
}

/** 取走某会话全部待投递的通知，拼成交给模型的一段文本（没有则 null）。 */
export function takeNotices(sessionId: string): string | null {
  const queue = pendingNotices.get(sessionId)
  if (!queue?.length) return null
  pendingNotices.delete(sessionId)
  return noticeText(queue)
}

function noticeText(queue: PendingNotice[]): string {
  const tail = queue.every((n) => n.shown)
    ? '\n\n（以上是系统自动发送的通知，不是用户发来的消息。这些内容用户已经直接看到，不必转述；需要据此安排下一步时再用。）'
    : '\n\n（以上是系统自动发送的后台任务通知，不是用户发来的消息。请据此继续推进原来的任务；结论里对用户要紧的部分，记得转述给用户（标明已直接显示给用户的除外）。）'
  return queue.map((n) => n.body).join('\n\n') + tail
}

/**
 * 自动起轮时通知行的文案：各条标题用「；」连起来。全是后台子智能体（同组一起交回）时合写成一句，
 * 免得一行里排三个「后台子智能体「…」已完成」；各自的结局在它们的 Task 卡上。
 */
function notifyHeadline(queue: PendingNotice[]): string {
  if (queue.length > 1 && queue.every((n) => n.subagent)) {
    const n = queue.length
    const allDone = queue.every((x) => x.subagent === 'done')
    if (isEn()) return `${n} background subagents ${allDone ? 'finished' : 'ended'}`
    return `${n} 个后台子智能体${allDone ? '已完成' : '已结束'}`
  }
  return queue.map((n) => n.headline).join('；')
}

/** 后台子智能体 Task 卡的状态落边车（background + summaries），重开对话时据此还原。 */
export function setBackgroundState(
  sessionId: string,
  toolUseId: string,
  state: 'running' | 'ok' | 'error',
  summary: string
): void {
  const s = getSession(sessionId)
  if (!s) return
  s.background = { ...s.background, [toolUseId]: state }
  s.summaries = { ...s.summaries, [toolUseId]: summary }
  saveProject(sessionId)
}

export function enqueueNotice(sessionId: string, n: PendingNotice): void {
  const queue = pendingNotices.get(sessionId)
  if (queue) queue.push(n)
  else pendingNotices.set(sessionId, [n])
  wakeForNotices(sessionId)
}

/**
 * 会话空闲且队列里有要唤醒的通知 → 自动起一轮（对标 Claude Code 的 task-notification）：全部排队的通知
 * 合成一条 NOTIFY_MARKER 开头的 user 消息（展示为一行系统通知），主智能体据此接着干。会话忙时什么都不做：
 * 回合会在下一步带上通知、结束时再调本函数；手动压缩 / 回滚结束时同样会再调一次。
 */
export function wakeForNotices(sessionId: string): void {
  if (shuttingDown) return
  commitMemberReports(sessionId)
  // 绑定任务交来的结果：需要处理的在此起一轮（起了就不再看下面的通知队列，它们随那一轮带上）。
  commitHandoffs(sessionId)
  const queue = pendingNotices.get(sessionId)
  if (!queue?.some((n) => n.wake)) return
  if (historyLocked(sessionId)) return
  pendingNotices.delete(sessionId)
  const session = getSession(sessionId)
  if (!session) return
  repairDanglingToolUses(session)
  session.messages.push({
    role: 'user',
    content: `${NOTIFY_MARKER}${notifyHeadline(queue)}\n${noticeText(queue)}`
  })
  // 新消息落进历史后，撤销上次回滚会把它一并抹掉——撤销快照就此失效（同 chat:send）。
  pendingUndo.delete(sessionId)
  session.updatedAt = Date.now()
  saveProject(sessionId)
  const turnId = genId('turn')
  emitTurnStart(turnId, sessionId, session.messages)
  // 模型以本对话存的为准（runTurn 内解析）；解析不了才用派发时那一轮的模型。
  // 唤醒它的全是手机端发起的那几轮派出的任务：这一轮也按手机端算（同手机端插入的消息，见 flushInserts）。
  const remote = queue.filter((n) => n.wake).every((n) => n.remote)
  void runTurn(sessionId, turnId, queue[queue.length - 1].model, null, remote ? 'remote' : 'desktop')
}
