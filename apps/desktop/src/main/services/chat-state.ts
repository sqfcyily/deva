/**
 * 会话运行时状态：各会话的忙碌 / 压缩 / 回滚标记、等待用户回应的提问 / 计划 / 挂载、待撤销的回滚，
 * 以及几个模块共用的事件发送、编号与系统通知辅助。只被单个模块用到的状态留在该模块里。
 */
import type {
  ChatStreamEvent
} from '../../shared/chat-protocol'
import { type BrowserWindow } from 'electron'
import { publishChatEvent } from './chat-bus'
import {
  type Message
} from '../providers/types'
import { getPersona, resolvePersonaId } from './personas'
import { notifyNeedsInput, type PendingInput } from './reply-notify'
import { getSession, type StoredNotice, type StoredSession } from './chat-store'
import { gcBlobs, type CheckpointRec, type UndoFile } from './checkpoints'

/** 计划审阅的结果（PlanResponse 去掉键，feedback 已清洗：仅 keep 且非空时才有）。 */
export type PlanVerdict = { decision: 'approve' | 'keep' | 'ignore'; feedback?: string }

export const activeTurns = new Map<string, AbortController>()

/** 待用户答复的 ask_user 询问（键 → resolve + 所属轮次）；answers 为 null 表示取消/中止。 */
export const pendingAsk = new Map<
  string,
  { resolve: (answers: string[] | null) => void; turnId: string; sessionId: string }
>()

/** 待用户批准的 exit_plan 计划审阅（键 → resolve + 所属轮次）；null 表示取消/中止。 */
export const pendingPlan = new Map<
  string,
  { resolve: (verdict: PlanVerdict | null) => void; turnId: string; sessionId: string }
>()

/** 待用户处理的「请求挂载工作区」（键 → resolve + 所属轮次）；null 表示暂不挂载/取消/中止。 */
export const pendingMount = new Map<
  string,
  { resolve: (path: string | null) => void; turnId: string; sessionId: string }
>()

/** 各轮累计在等用户处置（作答 / 批准计划 / 挂载工作区）上的毫秒数：回合耗时要把它扣掉。轮结束即删。 */
export const turnWaitMs = new Map<string, number>()

/** 等用户处置的那段时间记到所属轮次上（见 turnWaitMs）。 */
export function timedWait<T>(turnId: string, wait: Promise<T>): Promise<T> {
  const t0 = Date.now()
  return wait.finally(() => turnWaitMs.set(turnId, (turnWaitMs.get(turnId) ?? 0) + Date.now() - t0))
}

/** 本轮耗时记进 durations 边车，键为本轮（turnStart 起）第一个 tool_use 的 id；没有工具调用则不记。 */
export function recordTurnDuration(s: StoredSession, turnStart: number, ms: number): void {
  for (let i = turnStart; i < s.messages.length; i++) {
    const m = s.messages[i]
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    const use = m.content.find((p) => p.type === 'tool_use')
    if (use && use.type === 'tool_use') {
      s.durations = { ...s.durations, [use.id]: ms }
      return
    }
  }
}

/**
 * 正在跑回合的会话 → 其 turnId（主轮与定时任务都登记）。activeTurns 按 turnId 做键、查不到会话，
 * 回滚 / 撤销 / blob GC 据此判断「会话忙」而拒绝执行，免得与进行中的回合互相改写；
 * 渲染层打开会话时也据此接上进行中的回合（chat:attach-session）。
 */
export const busySessions = new Map<string, string>()

/** 正在跑回合的会话 → 这一轮开始的时刻（member_status 据此报「已用多久」）。 */
export const busySince = new Map<string, number>()

/**
 * 后台运行中的子智能体（默认即后台，模型设 foreground 才前台），键 = 开出它的 run_subagent / send_to_subagent 调用 id（即其
 * Task 卡 id）。它们不属于任何回合：有自己的取消控制器，派发它的那一轮结束或被中止都不影响它；跑完后把结论
 * 作为通知交给主智能体（见 subagent-run.ts launchBackgroundSubagent、background-tasks.ts wakeForNotices）。
 */
export interface BackgroundSubagent {
  sessionId: string
  /** 子智能体 id（sub-xxxxxxxx）。 */
  subagentId: string
  controller: AbortController
  /** 所在轮次 / 会话被删而中止：派发它的那次调用已不在上下文里，结束时不再通知、不写边车。 */
  silent: boolean
  /** 用户在 Task 卡上停止了它：结论照常交给模型，但不为此自动起一轮（随下一轮带过去）。 */
  stoppedByUser: boolean
  /** 派出它的那一轮（turnId）：同一轮派出的是一组，最后一个结束时才唤醒主智能体一次（见 launchBackgroundSubagent）。 */
  group: string
}

export const backgroundSubagents = new Map<string, BackgroundSubagent>()

/**
 * 把待决的问答 / 计划审阅 / 挂载请求一律按「取消」解开：给了 turnId 只解该轮的，缺省解全部。
 * 否则被中止的回合会一直阻塞在 askUser / reviewPlan / requestMount 上，永远走不到收尾落盘。
 */
export function releasePending(turnId?: string): void {
  const mine = (p: { turnId: string }): boolean => turnId === undefined || p.turnId === turnId
  for (const [key, p] of pendingAsk)
    if (mine(p)) {
      pendingAsk.delete(key)
      p.resolve(null)
    }
  for (const [key, p] of pendingPlan)
    if (mine(p)) {
      pendingPlan.delete(key)
      p.resolve(null)
    }
  // 挂载请求按「未挂载」解开（循环内会先判 aborted 再收尾，不会被误记成用户拒绝）。
  for (const [key, p] of pendingMount)
    if (mine(p)) {
      pendingMount.delete(key)
      p.resolve(null)
    }
}

/** 是否有进行中的回合（对话 / 定时任务 / 手动压缩）或后台运行中的子智能体。 */
export function hasActiveTurns(): boolean {
  return activeTurns.size > 0 || busySessions.size > 0 || backgroundSubagents.size > 0
}

/** 应用正在退出：不再为后台任务通知自动起轮。 */
export let shuttingDown = false

/**
 * 退出应用前调用：中止全部进行中的回合并等它们走完收尾（补齐工具结果、记「已中止」、落盘），
 * 最多等 timeoutMs。不等就退出，回合的 finally 根本来不及跑——这一轮已产出的内容就丢了。
 * 超时照样返回：逐步落盘已把中止前的每一步写进磁盘，残留的悬空 tool_use 由下次载入时自愈。
 */
export async function settleActiveTurns(timeoutMs: number): Promise<void> {
  if (!hasActiveTurns()) return
  shuttingDown = true
  for (const c of activeTurns.values()) c.abort()
  // 后台子智能体同样中止并落盘它的记录；按 silent 处理：退出途中不该再为它起一轮。
  for (const b of backgroundSubagents.values()) {
    b.silent = true
    b.controller.abort()
  }
  releasePending()
  const deadline = Date.now() + timeoutMs
  while (hasActiveTurns() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50))
}

/**
 * 上次回滚的撤销快照（内存态，重启即失）：回滚前的文件字节 + 对话相关字段。
 * 在该会话下一次 chat:send / 手动压缩 / 定时任务触发 / 删除 / 重置时失效——之后撤销会把新内容一并抹掉。
 */
export interface RewindUndo {
  files: UndoFile[]
  state: {
    messages: Message[]
    notices: StoredNotice[] | undefined
    proposals: StoredSession['proposals']
    asks: StoredSession['asks']
    summaries: StoredSession['summaries']
    delivered: StoredSession['delivered']
    background: StoredSession['background']
    durations: StoredSession['durations']
    plans: StoredSession['plans']
    autotasks: StoredSession['autotasks']
    todos: StoredSession['todos']
    todoCancelled: StoredSession['todoCancelled']
    checkpoints: Record<string, CheckpointRec[]> | undefined
    lastKnown: StoredSession['lastKnown']
    restoreNote: string | undefined
    lastInputTokens: number | undefined
  }
}

export const pendingUndo = new Map<string, RewindUndo>()

/** 回收本会话不再被引用的 blob：会话忙或有待撤销的回滚（快照里的记录仍引用旧 blob）时跳过。 */
export function collectBlobs(s: StoredSession): void {
  if (busySessions.has(s.id) || pendingUndo.has(s.id)) return
  void gcBlobs(s).catch((e) => console.warn('[checkpoints] GC 失败：', e))
}

let idCounter = 0

export function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

/** 对话所属角色的显示名（未绑定或角色已不存在 = 默认角色）。 */
export function personaName(s: StoredSession | undefined): string {
  return getPersona(resolvePersonaId(s?.personaId))?.name ?? 'Deva'
}

let windowGetter: () => BrowserWindow | null = () => null

/** 主窗口（registerChatIpc 时注入）：系统通知据此判断窗口是否在前台。 */
export function getWindow(): BrowserWindow | null {
  return windowGetter()
}

export function setWindowGetter(fn: () => BrowserWindow | null): void {
  windowGetter = fn
}

export function emit(turnId: string, sessionId: string, event: ChatStreamEvent): void {
  publishChatEvent({ turnId, sessionId, event })
}

/** 正在手动压缩（/compact）的会话：期间不为后台任务通知起轮，免得与压缩同时改写 messages。 */
export const compacting = new Set<string>()

/** 正在执行回滚 / 撤销的会话：防同一会话的两次回滚交错，期间也不起轮。 */
export const rewinding = new Set<string>()

/**
 * 会话的历史正被改写：回合进行中、手动压缩中、回滚 / 撤销中。三者互斥，删轮也须等它们结束——
 * 回合一直往起轮时拿到的那个 messages 数组里追加，删轮 / 回滚会把 s.messages 换成新数组，交错的话
 * 落盘的是新数组，这一轮的输出就丢了。渲染层发起前也会检查，但挡不住主进程自己起的轮（定时任务、
 * 手机端消息、后台子智能体结束后的唤醒、成员交差），故以主进程这里为准。
 */
export function historyLocked(sessionId: string): boolean {
  return busySessions.has(sessionId) || compacting.has(sessionId) || rewinding.has(sessionId)
}

/** 手机端发起、仍在进行的回合：回复与交互卡都推到手机，桌面不再弹系统通知。 */
export const remoteTurns = new Set<string>()

/** 系统通知标题：对话绑定的角色名，回落对话标题、Deva。成员会话用成员名。 */
export function notifyTitle(sessionId: string): string {
  const s = getSession(sessionId)
  if (s?.parentId) {
    const ref = getSession(s.parentId)?.members?.find((m) => m.sessionId === sessionId)
    if (ref) return ref.name
  }
  const p = s?.personaId ? getPersona(resolvePersonaId(s.personaId)) : null
  return p?.name || s?.title || 'Deva'
}

/**
 * 回合停下来等用户处理：用户没在看 Deva 时弹系统通知（手机端发起的回合交互卡已推到手机）。
 * 成员会话的提问 / 计划在主对话里以通知行显示，点通知打开主对话。
 */
export function notifyPending(turnId: string, sessionId: string, input: PendingInput): void {
  if (remoteTurns.has(turnId)) return
  const target = getSession(sessionId)?.parentId ?? sessionId
  notifyNeedsInput(getWindow, { sessionId: target, title: notifyTitle(sessionId), input })
}
