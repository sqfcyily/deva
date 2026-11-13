/**
 * 回合编排：发起一轮（用户发送 / 定时任务 / 通知唤醒）、轮前与轮中压缩、进行中插话、中止与收尾落盘。
 */
import type {
  ChatInsertRequest,
  ChatInsertResult,
  ChatModelConfig,
  ChatSendRequest
} from '../../shared/chat-protocol'
import {
  isEffortLevel,
  type ContentPart,
  type Message,
  type StopReason,
  type ToolSpec
} from '../providers/types'
import { REPEAT_STOP, TASK_MAX_STEPS } from '../../shared/limits'
import {
  toolSpecs,
  buildPlanTool,
  buildTodoTool,
  type ToolContext
} from './tools'
import { loadSkillInstructionsByName } from './skills'
import { buildToolSearchTool, fitToolSearch, skillToolUsages, unknownUsages } from './tool-search'
import { readMainTool, replyTaskTool, reportToMainTool, rootLabel } from './members'
import { MEMBER_EXCLUDED, MEMBER_FOLDER_ONLY, UNATTENDED_EXCLUDED } from './tool-catalog'
import { slashTokens } from '../../shared/slash'
import { memoryPromptSection } from './memory'
import { loadProjectDoc, projectDocPromptSection } from './project-doc'
import { DEFAULT_PERSONA_ID, getPersona, resolvePersonaId } from './personas'
import {
  resolveDefaultEffort,
  resolveDefaultModel,
  resolveModelRef,
  resolveModelRefOrNull
} from './model-resolve'
import {
  findTaskBySession
} from './tasks'
import type { TaskRecord } from './tasks-types'
import {
  handoffTool
} from './handoff'
import { getMcpToolSpecs } from './mcp'
import { notifyReplyDone } from './reply-notify'
import { applyTodoWrite, todoReminderText, todoResultText, todoState } from './todos'
import {
  deriveTitle,
  ensureSession,
  getSession,
  save as saveProject,
  setSessionArchived,
  type StoredSession
} from './chat-store'
import {
  buildAttachmentPart
} from './attachments'
import { isEn } from '../locale'
import { clearBrowserOperating, markBrowserTurnEnded } from './browser'
import {
  createRecorder,
  enforceCap
} from './checkpoints'
import {
  compactSession,
  lastTurnStart,
  modelMessages,
  modelStart,
  needsCompaction,
  type CompactModelConfig
} from './compaction'
import { clearStaleToolResults } from './tool-results'
import { repairDanglingToolUses, turnToolIds } from './chat-history'
import {
  degenerateMessage
} from './loop-support'
import {
  activeTurns,
  turnWaitMs,
  recordTurnDuration,
  busySessions,
  busySince,
  backgroundSubagents,
  releasePending,
  shuttingDown,
  pendingUndo,
  collectBlobs,
  genId,
  personaName,
  getWindow,
  emit,
  historyLocked,
  remoteTurns,
  notifyTitle,
  notifyPending
} from './chat-state'
import { toDisplayMessages } from './chat-display'
import {
  systemPrompt,
  sealedSystemPrompt,
  memberSystemPrompt,
  buildSkillTool,
  buildSubagentTool,
  buildSendToSubagentTool,
  mainTurnMemberTools,
  skillDirNote
} from './chat-prompts'
import { pendingNotices, takeNotices, wakeForNotices } from './background-tasks'
import { pendingHandoffs, deliverResult, finishInform, taskAsks, reportTaskAsk } from './chat-task-handoff'
import {
  memberDispatches,
  markDispatchesDelivered,
  deliveredDispatchIds,
  memberToMain,
  pendingMemberReports,
  commitMemberReports,
  memberListing,
  resumeMemberTask,
  noteMemberDirectTask,
  mainMemberTool,
  memberSideTool,
  reportMemberTurn,
  handleMentions
} from './chat-members'
import { runAgentLoop } from './agent-loop'

/**
 * 回合进行中用户插入、还没交给模型的消息（键 = sessionId，按插入先后）。去向：
 *  · 回合还有下一步 → 当前步骤结束后随工具结果一并交给模型（几条合并成一段，见 INSERT_MARKER）；
 *  · 回合正常结束时仍未送达（模型已在写最后的回复）→ 合并成一条普通消息发出，自动开始下一轮；
 *  · 回合被停止或出错 → 不再发出，原文退回渲染层的输入框（inserts_returned）。
 * 用户也可以在送达前撤回（chat:withdraw-inserts）。
 */
interface PendingInsert {
  text: string
  /** 插入时的模型：来不及送达、改作下一轮发出时，本对话模型解析不了就用它（同 chat:send）。 */
  model: ChatModelConfig
  /** 从手机端插入的（改作下一轮发出时，全是手机端的才按手机端发起处理）。 */
  fromRemote: boolean
  /** 主智能体派给成员、插进它当前工作的任务：member_send 的调用 id（取走时据此记为已送达，见 markDispatchesDelivered）。 */
  dispatchId?: string
}

const pendingInserts = new Map<string, PendingInsert[]>()

/** 回合由谁发起：桌面输入框 / 手机端 / 调度器（定时任务）。只有调度器发起的是无人值守（见 runTurn）。 */
/**
 * 一轮由谁发起：desktop 桌面 / remote 手机端 / schedule 定时任务调度器 / member 主智能体给成员派任务（见 members.ts）。
 * 成员会话的轮次不论由谁发起，一律按无人值守处理（见 runTurn 的 isMember）。
 */
type TurnTrigger = 'desktop' | 'remote' | 'schedule' | 'member'

/** 一轮的结果（runTurn 返回；定时任务据此记运行历史）。 */
export interface TurnOutcome {
  stopReason: StopReason
  /** 最后一段助手正文。 */
  text: string
  /** 失败原因（出错时）。 */
  errorMessage?: string
  /** 被中止的原因（只记能区分的：对话被删除）；手动停止与退出应用不记，后者看 shuttingDown。 */
  abortCause?: 'deleted'
  /** 绑定任务的定时运行轮：本轮交给主角色的结果（见 handoff.ts）；没交接则缺省。 */
  handoff?: { summary: string; needsAction: boolean }
}

/** 定时任务运行一次的结果（返回给 scheduler 以构造运行记录）。 */
export interface ScheduledTurnResult {
  stopReason: StopReason
  /** 末轮可见文本（供 scheduler 派生运行摘要）。 */
  text: string
  /** 失败原因（stopReason 为 'error'、'step_limit'、'repeated' 或 'degenerate' 时）；被中止时为中止说明（记进运行历史的摘要）。 */
  errorMessage?: string
  /** 绑定任务这次交给主角色的结果（见 handoff.ts）；没交接（没有新情况）则缺省。 */
  handoff?: { summary: string; needsAction: boolean }
}

/** 两个工作目录是否同一处（去掉末尾分隔符、不分大小写）。 */
function sameRoot(a: string | null, b: string | null): boolean {
  const norm = (p: string | null): string => (p ?? '').replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 广播回合开始：本轮用户消息（历史末条）按展示形态带出，与重载后看到的气泡一致。 */
export function emitTurnStart(turnId: string, sessionId: string, history: Message[]): void {
  // 已归档的对话开始新一轮（发消息 / 定时任务运行 / 后台任务通知）即移回列表：渲染层收到 turn_start
  // 会重拉列表，故须在发出前落盘。
  if (getSession(sessionId)?.archived) setSessionArchived(sessionId, false)
  // 只转换末条，但图片 ref 要指向它在整份记录里的位置（末条下标）。
  const [user] = toDisplayMessages(history.slice(-1), {}, [], {}, {}, {}, {}, [], undefined, {}, {}, history.length - 1)
  if (user?.role === 'user') emit(turnId, sessionId, { type: 'turn_start', user })
}

/** 接受插入的回合（对话的主轮，见 runTurn）。定时任务、压缩、回滚期间都不在其中。 */
const insertableTurns = new Set<string>()

/** 推送某会话待送达的插入消息（插入 / 送达 / 撤回 / 回合结束后）。 */
function emitInserts(sessionId: string): void {
  emit('', sessionId, { type: 'inserts', pending: (pendingInserts.get(sessionId) ?? []).map((e) => e.text) })
}

/**
 * 回合进行中插入一条消息（桌面 chat:insert 与手机端共用）。见 ChatInsertRequest / pendingInserts。
 * dispatchId：主智能体派给成员的任务插进成员当前的工作（见 chat-members.ts sendToMember）。
 */
export function insertMessage(req: ChatInsertRequest, fromRemote = false, dispatchId?: string): ChatInsertResult {
  const text = req.text.trim()
  if (!text) return { ok: false, reason: 'empty' }
  const turnId = busySessions.get(req.sessionId)
  if (!turnId) return { ok: false, reason: 'idle' }
  if (!insertableTurns.has(turnId)) return { ok: false, reason: 'busy' }
  const entry: PendingInsert = { text, model: req.model, fromRemote, ...(dispatchId ? { dispatchId } : {}) }
  const queue = pendingInserts.get(req.sessionId)
  if (queue) queue.push(entry)
  else pendingInserts.set(req.sessionId, [entry])
  emitInserts(req.sessionId)
  return { ok: true }
}

/** 取走某会话全部待送达的插入消息，合并成一段原文（没有则 null）。 */
export function takeInserts(sessionId: string): string | null {
  const queue = pendingInserts.get(sessionId)
  if (!queue?.length) return null
  pendingInserts.delete(sessionId)
  emitInserts(sessionId)
  const dispatched = queue.flatMap((e) => (e.dispatchId ? [e.dispatchId] : []))
  if (dispatched.length) markDispatchesDelivered(sessionId, dispatched)
  return queue.map((e) => e.text).join('\n\n')
}

/**
 * 回合收尾时仍未送达的插入消息：正常结束 → 合并成一条普通消息发出，自动开始下一轮（返回 true）；
 * 被停止 / 出错 / 正在退出 → 退回输入框。须在解除忙状态之后调用（发出走的是 sendMessage）。
 */
function flushInserts(sessionId: string, endReason: StopReason): boolean {
  const queue = pendingInserts.get(sessionId)
  if (!queue?.length) return false
  const text = takeInserts(sessionId) as string
  const giveBack = (): void => emit('', sessionId, { type: 'inserts_returned', text })
  if (endReason === 'aborted' || endReason === 'error' || shuttingDown) {
    giveBack()
    return false
  }
  // 没有附件时 sendMessage 在起轮之前不会让出执行权：返回时下一轮已经开始，会话又是忙的。
  sendMessage(
    { sessionId, text, model: queue[queue.length - 1].model, workspaceRoot: null },
    queue.every((e) => e.fromRemote)
  ).catch(giveBack)
  return true
}

/**
 * compactSession + 「正在压缩」状态：真正开始请求摘要时发 compacting(active)，结束不论结果补发收尾；
 * 无可压的那次什么都不发（轮中每步都可能查一次，界面不该跟着闪）。
 */
export async function compactWithStatus(
  turnId: string,
  sessionId: string,
  args: Parameters<typeof compactSession>[0]
): ReturnType<typeof compactSession> {
  let started = false
  try {
    return await compactSession({
      ...args,
      onStart: () => {
        started = true
        emit(turnId, sessionId, { type: 'compacting', active: true })
      }
    })
  } finally {
    if (started) emit(turnId, sessionId, { type: 'compacting', active: false })
  }
}

/**
 * 轮中压缩钩子（AgentLoopArgs.compact）：主轮与定时任务共用。compactSession 只往
 * session.messages 里插入一条摘要（不删消息），循环手里的 history 仍是同一个数组。
 *  · 无可压（none）静默返回——判定便宜，下一步照常再查；
 *  · 失败：发事件供渲染层弱提示 + 记日志，且本轮不再尝试（每步都重试摘要会反复白付费用、拖慢每一步）；
 *  · 中止：什么都不发，交给循环自己收尾。
 * 成功后回调 onCompacted 供调用方复位本轮的用量读数 / 轮起点。
 */
function midTurnCompactor(
  turnId: string,
  sessionId: string,
  session: StoredSession,
  model: CompactModelConfig,
  controller: AbortController,
  onCompacted: () => void
): () => Promise<boolean> {
  let gaveUp = false
  return async () => {
    if (gaveUp) return false
    try {
      const r = await compactWithStatus(turnId, sessionId, {
        session,
        model,
        signal: controller.signal,
        midTurn: true
      })
      if (r.status === 'none') return false
      if (r.status === 'failed') {
        if (controller.signal.aborted) return false
        emit(turnId, sessionId, { type: 'compacted', scope: 'auto', status: r.status, message: r.message })
        console.warn('[compaction] 轮中自动压缩失败：', r.message)
        gaveUp = true
        return false
      }
      emit(turnId, sessionId, { type: 'compacted', scope: 'auto', status: r.status })
      onCompacted()
      return true
    } catch (e) {
      /* 压缩自身抛错（极少）：历史未动，本轮照常，且不再尝试 */
      console.warn('[compaction] 轮中自动压缩异常：', (e as Error)?.message ?? e)
      gaveUp = true
      return false
    }
  }
}

/**
 * 主轮（depth 0）薄封装：建控制器/上下文、定格技能快照、调 runAgentLoop，
 * 由本封装发终态 `done`（嵌套子轮不发 done），并在 finally 落盘。
 */
export async function runTurn(
  sessionId: string,
  turnId: string,
  config: ChatModelConfig,
  workspaceRoot: string | null,
  trigger: TurnTrigger = 'desktop'
): Promise<TurnOutcome> {
  const fromRemote = trigger === 'remote'
  // 调度器发起（定时任务）：无人值守，不能停下等用户——工具表、系统提示词、步数上限随之调整，其余与普通对话完全相同。
  const scheduled = trigger === 'schedule'
  const controller = new AbortController()
  const startedAt = Date.now()
  // 登记为忙之前只取收尾（catch / finally）也要用的几项，它们都不会抛错：ensureSession 读盘失败自行容错，
  // resolveModelRef 解析不了即回落。其余准备（角色、工具表、项目说明、压缩……）一律放在登记之后的 try 里——
  // 登记后在 try 外抛错，finally 不执行，这个对话会一直停在「正在进行中」，渲染层也收不到 done。
  const session = ensureSession(sessionId)
  // 成员会话（见 members.ts）：身份、职责与文件夹取主对话名单里的那一项。成员可以直接问用户、提交计划（卡片在主对话里
  // 以通知行出现），结论在本轮结束时交回主对话（见 reportMemberTurn）。
  const isMember = !!session.parentId
  // 主角色用 member_send 转给定时任务的问题（见 askTask）：任务在自己的对话里回答，本轮结束时交回主对话
  // （见 reportTaskAsk）。用户在任务对话里插话、接着起的那一轮仍算在内（看登记，不看 trigger）。
  const taskAsk = !isMember && !scheduled ? taskAsks.get(sessionId) : undefined
  // 无人值守：定时任务，以及它回答转来的问题（用户不在任务对话里）。不弹提问 / 计划 / 挂载卡，不提醒回复完成。
  // 成员会话不提醒回复完成（结论交回主对话）。
  const unattended = scheduled || !!taskAsk
  // 本轮实际模型（对话优先外壳·快照固定/只改当前对话）：以**本对话**存的 model 为准（新建时快照角色偏好、
  // 聊天中切换即更新），经 resolveModelRef 解析——空/非法/模型已被删除都回落 config（chat:send 带上的全局
  // 默认）。故：同角色的多个对话可各用不同模型，改角色偏好模型不影响已建对话，删模型自动回归默认。
  // 提前解析，以便压缩按本轮实际模型的上下文窗口判定/摘要。角色不参与模型选择（快照已固定于会话）。
  const turnModel = resolveModelRef(session.model, config)

  // 完整对话记录：本轮的消息都追加在它末尾；发给模型的部分由 runAgentLoop 每步用 modelMessages 截取。
  // 压缩只往里插入摘要，轮前 / 轮中压缩后 history 依然是同一个数组，所以可以在压缩之前就取。
  const history = session.messages
  // 本轮起点：用于判定本轮是否产出可见回复。轮前压缩后重取（见下方 try）；轮中压缩会在本轮中间插入摘要，
  // 届时重新定位（见 compact）。
  let turnStart = history.length
  // 本轮真实输入 token（用于压缩触发判定）：runAgentLoop 每收到一次 usage 即回调，取最后一次。
  let lastInput = 0
  // 本轮提示缓存命中 / 写入量（纯观测，不参与判定），同样取最后一次。
  let lastCacheRead = 0
  let lastCacheWrite = 0
  // 本轮如何结束（finally 据此决定要不要为排队的后台任务通知接着起一轮、要不要提醒回复已完成）。
  let endReason: StopReason = 'error'
  // 本轮最后一段助手正文 / 失败原因：回复完成提醒的通知正文。
  let replyText = ''
  let replyError: string | undefined

  // 本轮是否产出「可见回复」：本轮新增的任一 assistant 消息含非空正文或工具调用即算。
  // 与渲染层 hasVisibleAnswer 同义——决定自然结束却空回合时是否补「空回合」提示。
  const turnProducedVisible = (): boolean => {
    for (let i = turnStart; i < history.length; i++) {
      const m = history[i]
      if (m.role !== 'assistant') continue
      const parts: ContentPart[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      for (const p of parts) {
        if (p.type === 'text' && p.text.trim() !== '') return true
        if (p.type === 'tool_use') return true
      }
    }
    return false
  }

  // 终态提示持久化（错误红框 / 截断 / 空回合）→ session.notices 边车，重开对话即可重建。
  // 镜像渲染层的 error 事件 + appendTerminalNotice：error 只记红框（不再叠空回合提示），
  // max_tokens 记截断，refusal（模型拒绝 / 内容策略拦截）无正文时记「被拒绝」——绝不并进空回合，
  // 否则会把一次拒绝谎报成「上下文接近上限」；自然结束却无可见回复才记空回合；
  // aborted（用户主动停止）记「已中止」——中止前产出的半截内容已随历史落盘，重开后须看得出
  // 这一轮是被打断的，而不是模型只答了这么多；repeated（原地打转被停下）记一条说明。
  const recordTurnNotice = (stopReason: StopReason, errorMessage?: string): void => {
    const after = history.length
    const notices = (session.notices ??= [])
    if (stopReason === 'error') notices.push({ after, kind: 'error', message: errorMessage })
    else if (stopReason === 'aborted') notices.push({ after, kind: 'notice', code: 'aborted' })
    else if (stopReason === 'repeated') notices.push({ after, kind: 'notice', code: 'repeated' })
    else if (stopReason === 'degenerate') notices.push({ after, kind: 'notice', code: 'degenerate' })
    else if (stopReason === 'step_limit') notices.push({ after, kind: 'notice', code: 'step_limit' })
    else if (stopReason === 'max_tokens') notices.push({ after, kind: 'notice', code: 'truncated' })
    // 拒绝：模型给了拒绝正文就无须再加提示（正文自己解释了），只在通篇为空时补一条。
    else if (stopReason === 'refusal') {
      if (!turnProducedVisible()) notices.push({ after, kind: 'notice', code: 'refused' })
    }
    else if ((stopReason === 'end_turn' || stopReason === 'stop') && !turnProducedVisible())
      notices.push({ after, kind: 'notice', code: 'empty' })
  }

  // 本轮耗时：起轮到此刻，扣掉等用户处置的时间；记进 durations 边车（finally 一并落盘）并随 done 发出。
  const finishDuration = (): number => {
    const ms = Math.max(0, Date.now() - startedAt - (turnWaitMs.get(turnId) ?? 0))
    turnWaitMs.delete(turnId)
    recordTurnDuration(session, turnStart, ms)
    return ms
  }

  activeTurns.set(turnId, controller)
  busySessions.set(sessionId, turnId)
  busySince.set(sessionId, startedAt)
  insertableTurns.add(turnId)
  if (fromRemote) remoteTurns.add(turnId)

  try {
    const parentSession = session.parentId ? getSession(session.parentId) : undefined
    const memberRef = parentSession?.members?.find((m) => m.sessionId === sessionId)
    const mainRoot = parentSession?.focusRoot ?? null
    const askOwner = taskAsk ? getSession(taskAsk.mainId) : undefined
    // 绑定了主对话的定时任务（见 handoff.ts）：本轮提供交接工具，系统提示词说明结果交给谁。主对话已删则按独立任务跑。
    const boundTask = scheduled ? findTaskBySession(sessionId) : null
    const ownerSession = boundTask?.ownerSessionId ? getSession(boundTask.ownerSessionId) : undefined
    const handoffOwner = ownerSession ? personaName(ownerSession) : null
    // 聚焦工作区：本对话若挂载文件夹，用它作有效根（受信/在工作区内判定、终端 cwd、系统提示词聚焦、
    // 权限模式键均据此）；未挂载 → 回落 workspaceRoot（对话优先外壳恒 null，即全机通用助手）。
    const effectiveRoot = session.focusRoot ?? workspaceRoot
    // signal 随 chat:abort 触发 → run_command 中止并杀掉子进程树。
    // canPromptUser：手机端发起的对话与定时任务，用户不在电脑前，不能弹窗请他在网页上亲自操作（browser 的 handoff）。
    // 成员会话可以请（同成员提问）：不弹浏览器窗口，主对话输入框上方出一行「前端 需要你登录 · 去处理」，用户没在看
    // Deva 时弹系统通知（点开主对话）。
    const ctx: ToolContext = {
      workspaceRoot: effectiveRoot,
      signal: controller.signal,
      sessionId,
      canPromptUser: !taskAsk && (trigger === 'desktop' || trigger === 'member'),
      // 成员会话：全局记忆只读（用户本人的通用偏好由主角色记），项目私有记忆可写。
      ...(isMember
        ? {
            globalMemoryReadonly: true,
            memberHandoff: {
              name: memberRef?.name ?? notifyTitle(sessionId),
              notify: (reason: string) => notifyPending(turnId, sessionId, { kind: 'browser', reason })
            }
          }
        : {})
    }

    // 本轮的角色：决定注入哪条角色设定、能用哪些技能 / MCP（未绑定、或绑定的角色已不存在 = 默认角色）。
    // persona 只用于系统提示词单身份注入，不参与模型选择。
    const rolePersonaId = resolvePersonaId(session.personaId)
    ctx.personaId = rolePersonaId
    const persona = getPersona(rolePersonaId)

    // 提示缓存已过期：先把较早的大块工具结果换成占位（原文存文件，不调模型）。缓存反正要重建，此时改写历史
    // 不多花钱；缓存还热时不动（见 tool-results.ts）。清掉的往往足以让下面的摘要压缩不必发生。
    try {
      const cleared = clearStaleToolResults(session, turnModel, modelStart(session.messages))
      if (cleared)
        console.info(`[context] 缓存已过期，清理了 ${cleared.cleared} 个较早的工具结果（约 ${cleared.tokens} token）`)
    } catch (e) {
      /* 清理失败（极少）：历史可能只改了一部分，均为合法内容，本轮照常 */
      console.warn('[context] 清理旧工具结果异常：', (e as Error)?.message ?? e)
    }

    // 自动压缩：接近上下文窗口时，先把较早历史摘要替换，再进入本轮（一轮进行中另有逐步检查，见 compact）。
    // 失败 / 无需压缩都发事件供渲染层弱提示，且绝不阻断本轮（宁可这一轮不压也要照常回答）。
    if (!controller.signal.aborted && needsCompaction(session, turnModel)) {
      try {
        const r = await compactWithStatus(turnId, sessionId, { session, model: turnModel, signal: controller.signal })
        // 失败原因落主进程日志：渲染层虽已展示，但后台回合（定时任务）无人盯着，日志是唯一痕迹。
        if (r.status === 'failed') console.warn('[compaction] 自动压缩失败：', r.message)
        if (r.status !== 'none')
          emit(turnId, sessionId, {
            type: 'compacted',
            scope: 'auto',
            status: r.status,
            message: r.message
          })
      } catch (e) {
        /* 压缩自身抛错（极少）：忽略，历史未动，本轮照常 */
        console.warn('[compaction] 自动压缩异常：', (e as Error)?.message ?? e)
      }
    }
    // 轮前压缩把摘要插在本轮请求之前：轮起点随之后移。
    turnStart = history.length

    // 本轮 persona 快照（仅主智能体）：只注入本对话角色**这一条**身份提示词——未绑定的旧对话、或绑定的角色
    // 已不存在，都用默认角色（与对话列表显示一致），不叠加其它角色。子智能体一律不注入（有自己的系统提示词，避免串味）。
    const personas = persona && persona.prompt.trim() ? [{ name: persona.name, prompt: persona.prompt }] : []
    // run_subagent 恒提供：内置子智能体（通用 / Explore / Plan）枚举进工具描述，无需任何用户配置。
    const subagentTool = buildSubagentTool()
    // 每轮定格：内置工具 + exit_plan（计划先行）+ skill（描述固定，技能清单随消息下发）+
    // run_subagent / send_to_subagent + 当前已连接、对本角色开放的 MCP 工具。exit_plan 仅主轮提供（子智能体的 buildSubagentTools 不含它）。
    // 内置工具不按角色收窄：所有角色均可按需调用（每个调用仍照常过同一道权限闸门，零提权）；按角色收窄的只有技能与 MCP。
    const turnTools: ToolSpec[] = [
      ...toolSpecs,
      buildPlanTool(),
      buildTodoTool(),
      buildSkillTool(),
      // 查看按需加载工具（browser、create_* 等，见 tool-search.ts）的完整用法；这几个工具在各类对话里至少剩 browser。
      buildToolSearchTool(),
      subagentTool,
      buildSendToSubagentTool(),
      // 项目成员：主对话的交互轮提供 create_member / member_send / member_stop，成员会话提供 read_main / report_to_main /
      // reply_task；定时任务都不给。
      ...(isMember
        ? [readMainTool(), reportToMainTool(), replyTaskTool()]
        : unattended
          ? handoffOwner
            ? [handoffTool(handoffOwner)]
            : []
          : mainTurnMemberTools()),
      ...getMcpToolSpecs(rolePersonaId)
    ]
    // tool_search 的可选工具名按筛选后的工具表收窄（成员会话没有 create_* 等）。
    const tools = fitToolSearch(
      isMember
        ? turnTools.filter(
            (t) => !MEMBER_EXCLUDED.has(t.name) && (effectiveRoot !== null || !MEMBER_FOLDER_ONLY.has(t.name))
          )
        : unattended
          ? turnTools.filter((t) => !UNATTENDED_EXCLUDED.has(t.name))
          : turnTools
    )
    // 项目说明在轮开头快照进 system：本轮中途改 AGENTS.md 不改 system（提示缓存前缀稳定），下一轮生效。
    // 成员负责子文件夹时，项目根目录（主对话工作目录）的 AGENTS.md 也一并读入，近者在后。
    const projectDoc = [
      ...(isMember && mainRoot && !sameRoot(mainRoot, effectiveRoot)
        ? projectDocPromptSection(loadProjectDoc(mainRoot))
        : []),
      ...projectDocPromptSection(loadProjectDoc(effectiveRoot))
    ]

    // 主轮 = depth 0：可问询（定时任务除外）、可派生子智能体、由本封装发终态 done（嵌套调用不发 done）。
    const { stopReason, errorMessage, text } = await runAgentLoop({
      turnId,
      sessionId,
      history,
      // 记忆在 system 里只有固定的规则段，条目随消息下发（见 listing.ts），记忆增删改不动 system。
      // 定时任务换用无人值守版（不提问、不等确认），记忆只读。
      system: isMember
        ? memberSystemPrompt({
            member: memberRef ?? {
              sessionId,
              name: session.title || '成员',
              origin: 'created',
              personaId: rolePersonaId,
              root: null,
              duty: '',
              addedAt: 0
            },
            owner: personaName(parentSession),
            workspaceRoot: effectiveRoot,
            folder: effectiveRoot ? rootLabel(effectiveRoot, mainRoot) : '未指定（需要时用户会为你选择，或使用绝对路径）',
            personas,
            // 全局记忆只读；有文件夹时可读写该文件夹的项目私有记忆。
            memory: memoryPromptSection({ writable: false, projectWritable: true, root: effectiveRoot }),
            projectDoc
          })
        : unattended
        ? sealedSystemPrompt(
            effectiveRoot,
            personas,
            memoryPromptSection({ writable: false, root: effectiveRoot }),
            projectDoc,
            handoffOwner
              ? { owner: handoffOwner }
              : taskAsk
                ? { owner: askOwner ? personaName(askOwner) : 'Deva', asked: true }
                : undefined
          )
        : systemPrompt(
            effectiveRoot,
            personas,
            memoryPromptSection({ writable: true, root: effectiveRoot }),
            projectDoc
          ),
      tools,
      personaId: rolePersonaId,
      model: turnModel,
      effort: session.effort,
      ctx,
      controller,
      // 定时任务无人值守：设步数上限，免得兜圈子一直跑（见 shared/limits.ts）。成员不设上限（同子智能体），
      // 原地打转检测照常生效。
      maxSteps: unattended ? TASK_MAX_STEPS : undefined,
      depth: 0,
      interactive: !unattended,
      allowAskUser: !unattended,
      allowSubagents: true,
      // 项目成员：主对话的交互轮附成员名单、受理成员工具；成员会话受理 read_main / report_to_main / reply_task。
      listMembers: !unattended && !isMember ? () => memberListing(sessionId) : undefined,
      memberTool: isMember
        ? (tc) => memberSideTool(sessionId, tc)
        : !unattended
          ? (tc) => mainMemberTool(sessionId, tc, turnModel, turnId)
          : boundTask && ownerSession
            ? (tc) => Promise.resolve(deliverResult(boundTask, ownerSession.id, tc, turnModel, turnId))
            : undefined,
      onUsage: (n, read, write) => {
        if (n > 0) lastInput = n
        lastCacheRead = read
        lastCacheWrite = write
        // 缓存最后一次被用到的时刻：下一轮据此判断缓存是否已过期（随本轮收尾落盘）。
        session.lastRequestAt = Date.now()
      },
      // ask_user 答复 / 工具摘要 → 展示边车（按 toolUseId），供重开还原问答卡与工具卡摘要。
      // 只挂主轮：子智能体的嵌套调用不传这两个回调，其工具/问询不会污染父对话边车。
      // 在内存 session 上就地累积，本轮 finally 的 saveProject 一并落盘。
      onAskAnswered: (id, answers) => {
        ;(session.asks ??= {})[id] = { answers }
      },
      onToolSummary: (id, summary) => {
        ;(session.summaries ??= {})[id] = summary
      },
      // exit_plan 决定 → plans 边车（按 toolUseId），供重开还原计划卡的已决态。
      onPlanDecided: (id, decision, feedback) => {
        ;(session.plans ??= {})[id] = { decision, ...(feedback ? { feedback } : {}) }
      },
      // todo_write → todos 边车（写入日志），推送进度；令清单全部完成的那次另发 todo_done 落卡。
      // cancel → 记进已取消集合，胶囊收起。字段一律整体重新赋值（不原地改）：回滚撤销快照存的是引用。
      onTodoWrite: (id, input) => {
        const r = applyTodoWrite(session.todos, session.todoCancelled, id, input, Date.now())
        if ('error' in r) return { content: r.error, isError: true }
        if ('cancel' in r) {
          if (!r.cancel) return { content: '当前没有进行中的待办清单，无需取消。', isError: false }
          session.todoCancelled = [...(session.todoCancelled ?? []), r.cancel]
          emit(turnId, sessionId, { type: 'todos', state: todoState(session.todos, session.todoCancelled) })
          return { content: '已取消当前待办清单。', isError: false }
        }
        session.todos = [...(session.todos ?? []), r]
        // 已取消的清单又被写入（条目有重合）：模型恢复了这项任务，重新显示。
        if (session.todoCancelled?.includes(r.listId))
          session.todoCancelled = session.todoCancelled.filter((x) => x !== r.listId)
        emit(turnId, sessionId, { type: 'todos', state: todoState(session.todos, session.todoCancelled) })
        if (r.done) emit(turnId, sessionId, { type: 'todo_done', id, title: r.title, items: r.items })
        return { content: todoResultText(r), isError: false }
      },
      // 文件检查点（供回滚）：同一个记录器透传给子智能体，seq 全局递增。
      recorder: createRecorder(session),
      // 后台子智能体在本轮期间结束：通知随下一步的工具结果交给模型。
      takeNotices: () => takeNotices(sessionId),
      // 用户在本轮进行中插入的消息：同样随下一步的工具结果交给模型。
      takeInserts: () => takeInserts(sessionId),
      // 逐步落盘：长回合中途崩溃 / 强退，已完成的步骤仍在磁盘上。
      onStep: () => saveProject(sessionId),
      // 轮中压缩：旧读数作废（别让 finally 把压缩前的大数存成下轮触发依据）；轮起点重新定位到本轮请求之后
      // （摘要插在本轮中间，不是轮起点；被并入摘要的步骤都带工具调用，不影响「是否产出可见回复」的判定）。
      compact: midTurnCompactor(turnId, sessionId, session, turnModel, controller, () => {
        lastInput = 0
        turnStart = lastTurnStart(history) + 1
      })
    })
    emit(turnId, sessionId, { type: 'done', stopReason, durationMs: finishDuration() })
    // 终态提示持久化（须在 finally 落盘前执行）：错误红框 / 截断 / 空回合入 notices 边车。
    recordTurnNotice(stopReason, errorMessage)
    endReason = stopReason
    replyText = text
    replyError = errorMessage
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    emit(turnId, sessionId, { type: 'error', kind: 'unknown', message })
    emit(turnId, sessionId, { type: 'done', stopReason: 'error', durationMs: finishDuration() })
    recordTurnNotice('error', message)
    replyError = message
  } finally {
    activeTurns.delete(turnId)
    remoteTurns.delete(turnId)
    turnWaitMs.delete(turnId)
    // 记录本轮真实输入 token 作为下轮压缩触发依据（比字符估算准，天然覆盖图片/工具）。
    // 缓存命中/写入量是纯观测字段（不参与任何判定），与 token 数同源同步——本轮没拿到真实
    // 用量（如秒中止）就整体不动，免得用 0 覆盖掉上一轮的有效读数。
    if (lastInput > 0) {
      session.lastInputTokens = lastInput
      session.lastCacheRead = lastCacheRead
      session.lastCacheWrite = lastCacheWrite
    }
    // 检查点保留上限：只保留最近若干轮的备份，更早的释放 blob（元信息保留，回滚时如实显示备份缺失）。
    enforceCap(session, turnToolIds(session.messages))
    // 兜底：循环抛异常跳出时，历史里可能留着没有结果的 tool_use（正常 / 中止路径已在循环内补齐）。
    // 落盘前补上，别把一条下一次请求必 400 的会话写进磁盘。
    repairDanglingToolUses(session)
    // 本轮对 history 的原地改写落盘（一对话一文件：只重写这一条）；更新时间用于左侧列表排序
    session.updatedAt = Date.now()
    saveProject(sessionId)
    busySessions.delete(sessionId)
    busySince.delete(sessionId)
    // 本轮结束：浏览器窗口 / 胶囊上的「正在操作」立即收起（不等空闲计时）；后台网页从此刻起按短时限计时
    clearBrowserOperating(sessionId)
    markBrowserTurnEnded(sessionId)
    insertableTurns.delete(turnId)
    collectBlobs(session)
    // 还有来不及送达的插入消息、本轮又是正常结束：马上作为下一轮发出（见 flushInserts），这一轮不算回复完成。
    const continues =
      endReason !== 'aborted' &&
      endReason !== 'error' &&
      !shuttingDown &&
      (pendingInserts.get(sessionId)?.length ?? 0) > 0
    // 一件事只提醒一次：本轮派出的成员还在做（结论或汇总到了再提醒）、还有后台子智能体在跑（它结束后起的那一轮
    // 再提醒）、已有要唤醒的通知（马上接着汇总）、有排着的成员交差（记进对话时自带提醒）——这一轮结束都不提醒。
    // 出错照常提醒。
    const awaitsFollowUp =
      endReason !== 'error' &&
      ([...memberDispatches.values()].some((list) => list.some((d) => d.group === turnId)) ||
        [...backgroundSubagents.values()].some(
          (b) => b.sessionId === sessionId && !b.silent && !b.stoppedByUser
        ) ||
        (pendingNotices.get(sessionId)?.some((n) => n.wake) ?? false) ||
        (pendingMemberReports.get(sessionId)?.length ?? 0) > 0 ||
        (pendingHandoffs.get(sessionId)?.length ?? 0) > 0)
    // 用户没在看 Deva 时弹系统通知提醒回复已完成。不提醒：手机端发起的（回复已推到手机）、定时任务（调度器
    // 按任务另发通知）、用户按了停止的、退出途中被中止的、马上接着下一轮的。
    if (
      endReason !== 'aborted' &&
      !fromRemote &&
      !unattended &&
      !isMember &&
      !shuttingDown &&
      !continues &&
      !awaitsFollowUp
    )
      notifyReplyDone(getWindow, {
        sessionId,
        title: notifyTitle(sessionId),
        text: replyText,
        error: endReason === 'error' ? (replyError ?? '') : undefined
      })
    // 成员会话：本轮已送达的派发（须在 flushInserts 取走插入之前看：来不及送达的派来的任务，改作下一轮发出，
    // 留给下一轮的最终回复交差）。
    const memberDelivered = isMember ? deliveredDispatchIds(sessionId) : null
    // 来不及送达的插入消息：正常结束就接着发出，停止 / 出错则退回输入框。
    const continued = flushInserts(sessionId, endReason)
    // 本轮进行中交差的成员：现在把那几行记进主对话（排在本轮回复之后）。
    if (!continued) commitMemberReports(sessionId)
    // 本轮最后一步之后才结束的后台子智能体：它们的通知还在队列里，现在为它们起一轮（插入消息已起了一轮的，
    // 通知随那条消息一并带上）。用户刚按了停止就不起——通知留着，随下一条消息带给模型。
    if (endReason !== 'aborted' && !continued) wakeForNotices(sessionId)
    // 成员会话：结论交回主对话（会话被删的不交）。插入的消息接着起了一轮的：本轮已送达的派发由本轮的最终回复交差，
    // 其余的（含用户直接说的话）等那一轮结束再交。
    if (isMember && !continued) {
      if (abortCauses.get(turnId) !== 'deleted') reportMemberTurn(session, endReason, replyText, replyError, turnModel)
      else memberToMain.delete(sessionId)
    } else if (isMember && memberDelivered?.size)
      reportMemberTurn(session, endReason, replyText, replyError, turnModel, memberDelivered)
    // 定时任务回答完转来的问题：回答交回主对话（任务对话被删的不交）。
    if (taskAsk && !continued) {
      if (abortCauses.get(turnId) !== 'deleted') reportTaskAsk(session, endReason, replyText, replyError)
      else taskAsks.delete(sessionId)
    }
  }
  const abortCause = abortCauses.get(turnId)
  abortCauses.delete(turnId)
  const handoff = finishInform(turnId, endReason, replyText)
  return { stopReason: endReason, text: replyText, errorMessage: replyError, abortCause, handoff }
}

/**
 * 定时任务运行一次 = 由调度器代用户发出任务指令，回合本身就是普通对话的回合（startTurn → runTurn，
 * trigger 'schedule' 只开关无人值守必需的差异，见 runTurn）。这里只做调度器特有的准备与结果换算：
 *  · 模型：任务的模型（严格解析）→ 回落全局默认；两者皆无则记错误、不建对话；
 *  · 对话正忙（用户正在任务对话里聊、或手机端发起的回合未完）→ 本次不运行，记错误（照常退避重试）；
 *  · 角色 / 模型以任务为准写进对话（两边同步，见 tasks.ts updateTask 与 chat:set-model）；首次运行用任务标题作对话标题；
 *  · 思考等级以对话为准，对话从没定格过（从没打开过）→ 用全局最近使用，同手机端发起；
 *  · 步数上限 / 原地打转被停下 → 换算成失败原因，供 scheduler 记运行历史。
 */
export async function runScheduledTurn(task: TaskRecord): Promise<ScheduledTurnResult> {
  const { auth, sessionId } = task
  const fail = (message: string): ScheduledTurnResult => ({ stopReason: 'error', text: '', errorMessage: message })

  // 先于 ensureSession 检查：首次运行时就此返回的话，不必在内存里留一条空对话。
  const turnModel = resolveModelRefOrNull(auth.modelRef) ?? resolveDefaultModel()
  if (!turnModel)
    return fail(
      isEn()
        ? 'No default model is available, so the scheduled task could not run. Choose a default model in Settings.'
        : '未配置可用的默认模型，无法执行定时任务（请在设置中选定默认模型）。'
    )
  if (historyLocked(sessionId))
    return fail(
      isEn()
        ? 'The task’s chat was busy with another reply, so this run was skipped.'
        : '任务对话正在进行中，本次未运行。'
    )

  // 角色：任务未指定或角色已删 → 默认角色 Deva（删角色时任务已改绑 Deva，这里兜旧数据与手动删文件）。
  const personaId =
    ((auth.personaId ? getPersona(auth.personaId) : null) ?? getPersona(DEFAULT_PERSONA_ID))?.id ??
    DEFAULT_PERSONA_ID
  // 空串 = 跟随全局默认（任务的 modelRef 为 null）。
  const session = ensureSession(sessionId, { personaId, model: auth.modelRef ?? '' })
  // 对话的角色一次性绑定（ensureSession 不覆盖）；任务改过角色时以任务为准。
  if (session.personaId !== personaId) session.personaId = personaId
  if (!session.title) session.title = task.title || deriveTitle(task.prompt)

  let out: TurnOutcome
  try {
    const { done } = await startTurn(
      {
        sessionId,
        text: task.prompt,
        model: turnModel,
        workspaceRoot: null,
        effort: session.effort ?? resolveDefaultEffort()
      },
      'schedule'
    )
    out = await done
  } catch (e) {
    return fail((e as Error)?.message ?? String(e))
  }
  // 被中止：写一句说明进运行历史（否则那一行只有图标）。
  if (out.stopReason === 'aborted')
    return {
      ...out,
      errorMessage:
        out.abortCause === 'deleted'
          ? isEn()
            ? 'The task’s chat was deleted, so this run was stopped.'
            : '任务对话已删除，本次运行已停止。'
          : shuttingDown
            ? isEn()
              ? 'The app quit, so this run was interrupted.'
              : '应用退出，本次运行被中断。'
            : isEn()
              ? 'Stopped manually.'
              : '已手动停止本次运行。'
    }
  if (out.stopReason === 'step_limit')
    return {
      ...out,
      errorMessage: isEn()
        ? `Reached the step limit for a single run (${TASK_MAX_STEPS} steps); the task may be unfinished.`
        : `已达到单次运行的步数上限（${TASK_MAX_STEPS} 步），任务可能未完成。`
    }
  if (out.stopReason === 'repeated')
    return {
      ...out,
      errorMessage: isEn()
        ? `The same tool was called ${REPEAT_STOP} times in a row with identical arguments and results, so the run was stopped; the task may be unfinished.`
        : `同一工具以相同参数连续调用 ${REPEAT_STOP} 次且结果不变，已停止，任务可能未完成。`
    }
  if (out.stopReason === 'degenerate') return { ...out, errorMessage: degenerateMessage() }
  return out
}

/**
 * 发送用户消息 → 启动一轮（fire-and-forget），返回 turnId。桌面（chat:send）与远程通道共用此入口。
 * 同一会话同时只能有一轮：两轮并发会交错改写同一份 messages。桌面层本就不会在流式中再发，
 * 这道闸主要拦「手机端正在跑、桌面又发了一条」（或反过来）——抛错由调用方转成提示。
 */
export async function sendMessage(payload: ChatSendRequest, fromRemote = false): Promise<{ turnId: string }> {
  const { turnId } = await startTurn(payload, fromRemote ? 'remote' : 'desktop')
  return { turnId }
}

/**
 * 发出一条用户消息并起一轮（sendMessage 与定时任务共用）：消息组装、标题、落盘、turn_start 都在这里。
 * 返回 turnId 与本轮结束时兑现的结果（定时任务据此记运行历史；桌面 / 手机端不等它）。
 */
async function startTurn(
  payload: ChatSendRequest,
  trigger: TurnTrigger
): Promise<{ turnId: string; done: Promise<TurnOutcome> }> {
  const busyError = (): Error => new Error('这个对话正在进行中（可能由手机端或定时任务发起），请等它结束后再发。')
  if (historyLocked(payload.sessionId)) throw busyError()
  const {
    sessionId,
    text,
    model,
    workspaceRoot,
    attachments,
    personaId,
    focusRoot,
    modelRef,
    effort
  } = payload
  // 首发绑定 persona / 聚焦工作区 / 本对话模型与思考等级（ensureSession：personaId 一次性绑定，focusRoot、
  // model 与 effort 可后续更新——model 承载「新建快照角色偏好 + 聊天中切换」，显式提供即落库，仅影响本对话）。
  const session = ensureSession(sessionId, {
    personaId,
    focusRoot,
    model: modelRef,
    effort: isEffortLevel(effort) ? effort : undefined
  })
  // 发送前自愈：旧版本 / 崩溃遗留的悬空 tool_use 会让这次请求直接 400（此后每次都 400）。
  // 回合进行中不碰——那时的「悬空」是工具正在执行，不是残缺。
  if (!busySessions.has(sessionId)) repairDanglingToolUses(session)
  const history = session.messages

  // 「/技能名」显式触发（消息开头或正文中间，认法见 shared/slash.ts）：命中本对话角色可用的技能 → 把完整正文
  // 预置进本条消息（这一轮即生效）；开头的那个从原话里剥掉（同以前），正文中间的留在原话里（是句子的一部分）。
  // 未命中的原样保留（用户可能只是打了个斜杠），不做任何处理。
  let effectiveText = text
  // 技能接着要用的按需加载工具的用法（见 tool-search.ts）：作为正文之前的独立块一并带上，省得模型再查一步。
  let slashUsages: ReturnType<typeof skillToolUsages> = null
  const activated: { loaded: NonNullable<ReturnType<typeof loadSkillInstructionsByName>>; start: number; end: number }[] =
    []
  for (const tk of slashTokens(text)) {
    // 成员会话没有创建类工具：/create-agent 等不展开（同技能清单，见 runAgentLoop 的 hasTool）。
    const loaded = loadSkillInstructionsByName(
      tk.name,
      resolvePersonaId(session.personaId),
      session.parentId ? (n) => !MEMBER_EXCLUDED.has(n) : undefined
    )
    if (loaded && !activated.some((x) => x.loaded.name === loaded.name)) activated.push({ loaded, ...tk })
  }
  if (activated.length) {
    const lead = activated.find((x) => x.start === text.length - text.trimStart().length)
    const rest = (lead ? text.slice(0, lead.start) + text.slice(lead.end) : text).trim()
    const names = activated.map((x) => x.loaded.name)
    effectiveText =
      `（用户通过 ${names.map((n) => `/${n}`).join('、')} 显式激活了技能${names.map((n) => `「${n}」`).join('')}，请严格据下述指令完成本次任务）\n` +
      activated
        .map(
          ({ loaded }) =>
            `===== 技能指令：${loaded.name} =====\n${skillDirNote(loaded.dir)}${loaded.instructions}\n===== 指令结束 =====`
        )
        .join('\n') +
      (rest ? `\n\n${lead ? '用户补充' : '用户的消息'}：${rest}` : '')
    // 成员会话不提供创建类工具，那几个的用法不附。
    const usable = [...new Set(activated.flatMap((x) => x.loaded.allowedTools))].filter(
      (n) => !session.parentId || !MEMBER_EXCLUDED.has(n)
    )
    slashUsages = skillToolUsages(usable, unknownUsages(modelMessages(history), new Set(usable)))
  }

  // 构建本条用户消息：附件内容块在前，提问正文（最后一个 text 块）在后
  const parts: ContentPart[] = []
  const notes: string[] = []
  if (attachments?.length) {
    for (const path of attachments) {
      const { part, note } = await buildAttachmentPart(path, model.adapter)
      if (part) parts.push(part)
      if (note) notes.push(note)
    }
  }
  // 读附件期间另一端可能抢先起了一轮：落历史前再确认一次。
  if (historyLocked(sessionId)) throw busyError()
  const question = effectiveText.trim() || (parts.length ? '请理解并处理上述附件。' : '')
  const questionText = notes.length ? `${question}\n（${notes.join('；')}）` : question
  // 「仅恢复代码」后的首条消息：把回滚说明作为**第一个**独立 text 块带给模型（展示层只取最后一个
  // text 块作气泡正文，故用户看不到它），用一次即清。
  if (session.restoreNote) {
    parts.unshift({ type: 'text', text: session.restoreNote })
    session.restoreNote = undefined
  }
  // 待办清单的两类提醒，同样作为问题正文之前的独立 text 块（气泡里看不到）：用户在面板里手动取消过清单
  // → 告知模型别再写回它（用一次即清）；上一轮留下未完成的清单（多为任务被暂停）→ 提醒模型继续就更新、
  // 不再进行就传 cancel 取消。
  if (session.todoCancelNote) {
    parts.push({ type: 'text', text: session.todoCancelNote })
    session.todoCancelNote = undefined
  }
  const todoNote = todoReminderText(session.todos, session.todoCancelled)
  if (todoNote) parts.push({ type: 'text', text: todoNote })
  // 还没投递的后台任务通知（用户亲手停止的子智能体，或上一轮被中止后留下的）：同样是正文之前的独立 text 块。
  const bgNote = takeNotices(sessionId)
  if (bgNote) parts.push({ type: 'text', text: bgNote })
  // 用户 @ 了角色或成员（主对话的交互轮）：还不是成员的角色加入名单，并请主智能体把这条消息交给它们。
  const mentionNote = !session.parentId && trigger !== 'schedule' ? handleMentions(session, text) : null
  if (mentionNote) parts.push(mentionNote)
  if (slashUsages) parts.push({ type: 'text', text: slashUsages.text, listing: slashUsages.listing })
  // 用户直接在成员会话里交代事情：名单上记下它在做什么（成员卡片显示任务标题）。派来的上一项任务还没做完的，
  // 这一轮算接着做它（任务标题不变，完成后交回主对话，见 resumeMemberTask）。
  if (session.parentId && !resumeMemberTask(session, model)) noteMemberDirectTask(session, text)
  if (parts.length) {
    parts.push({ type: 'text', text: questionText })
    history.push({ role: 'user', content: parts })
  } else {
    history.push({ role: 'user', content: questionText })
  }
  // 新消息落进历史后，撤销上次回滚会把它一并抹掉——撤销快照就此失效。
  pendingUndo.delete(sessionId)

  // 首条用户文本派生会话标题
  if (!session.title) session.title = deriveTitle(text) || deriveTitle(questionText)
  session.updatedAt = Date.now()
  saveProject(sessionId)

  const turnId = genId('turn')
  emitTurnStart(turnId, sessionId, history)
  const done = runTurn(sessionId, turnId, model, workspaceRoot, trigger)
  return { turnId, done }
}

// 中止某一轮的原因（键 = turnId）：随 runTurn 的结果交出（定时任务据此写运行历史的说明），交出即删。
const abortCauses = new Map<string, 'deleted'>()

// 中止某一轮：取消流并把该轮的待决问答/计划审阅一律按取消解开
export function abortTurn(turnId: string, cause?: 'deleted'): void {
  if (cause && activeTurns.has(turnId)) abortCauses.set(turnId, cause)
  activeTurns.get(turnId)?.abort()
  // 待决问答回灌「用户取消了本次询问」，计划审阅记取消，挂载请求按「未挂载」解开。
  releasePending(turnId)
}
