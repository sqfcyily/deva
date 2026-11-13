import type {
  AskOption,
  AskQuestion,
  AskResponse,
  AttachmentChip,
  AutoRetryReason,
  ChatCompactRequest,
  ChatCreateSessionRequest,
  ChatInsertRequest,
  ChatInsertResult,
  ChatModelConfig,
  ChatRenameSessionRequest,
  ChatRewindApplyRequest,
  ChatSendRequest,
  ChatSetArchivedRequest,
  ChatSetEffortRequest,
  ChatSetFocusRequest,
  ChatSetModelRequest,
  ChatStreamEvent,
  DisplayMessage,
  MountResponse,
  PlanResponse,
  ResolveAutotaskResult
} from '../../shared/chat-protocol'
import { ipcMain, type BrowserWindow } from 'electron'
import { onChatEvent, onSessionsChanged, publishSessionsChanged } from './chat-bus'
import { statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import {
  isEffortLevel
} from '../providers/types'
import {
  pruneSubagents,
  removeSessionSubagents
} from './subagent-store'
import {
  resolveModelRef
} from './model-resolve'
import {
  createTask,
  releaseTasksOwnedBy,
  setTaskSessionPurger,
  syncTaskModel,
  type CreateTaskResult
} from './tasks'
import type { TaskCreateInput, TaskRecord } from './tasks-types'
import { trustRoot } from './fs-guard'
import { activeTodoList, todoUserCancelNote, todoState, type TodoState } from './todos'
import {
  deriveTitle,
  ensureSession,
  getSession,
  deleteSession as deleteStoredSession,
  listSessions,
  save as saveProject,
  setSessionArchived,
  type ChatSessionMeta,
  type StoredSession
} from './chat-store'
import { thumbnailDataUrl } from './image-read'
import { isEn } from '../locale'
import { closeSessionPages, setBrowserSessionBusyCheck, setSessionAborter } from './browser'
import {
  applyFiles,
  buildRestoreNote,
  planRewind,
  publicPreview,
  removeSessionCheckpoints,
  summarizeTurns,
  undoFiles,
  type RewindFile,
  type RewindStatus,
  type RewindTurnStat
} from './checkpoints'
import { isCompactionSummary, type CompactStatus } from './compaction'
import { turnRanges, turnToolIds } from './chat-history'
import {
  activeTurns,
  pendingAsk,
  pendingPlan,
  pendingMount,
  busySessions,
  busySince,
  backgroundSubagents,
  type RewindUndo,
  pendingUndo,
  collectBlobs,
  genId,
  getWindow,
  setWindowGetter,
  emit,
  compacting,
  rewinding,
  historyLocked
} from './chat-state'
import { imageRef, loadDisplay, displayOf } from './chat-display'
import { cancelBackground, wakeForNotices } from './background-tasks'
import { pendingHandoffs } from './chat-task-handoff'
import { memberDispatches, memberGroupDone, markMemberSetting, setMemberFolder, setOpenTasks } from './chat-members'
import {
  type ScheduledTurnResult,
  insertMessage,
  takeInserts,
  compactWithStatus,
  runScheduledTurn,
  sendMessage,
  abortTurn
} from './chat-turns'
export { hasActiveTurns, settleActiveTurns } from './chat-state'
export type { ScheduledTurnResult } from './chat-turns'

/**
 * 会话编排（Agent 主循环）。
 * 流式生成 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续，直至模型不再调用工具
 * （主轮、子智能体与定时任务都不设步数上限，对标 Claude Code 的 agentic loop）。
 * 对话历史只存主进程（sessions），渲染层仅发新用户文本；工具/密钥/文件访问都在主进程内闭环。
 */

// 聊天 IPC 协议类型定义在 shared/chat-protocol.ts；其它主进程模块仍可从这里取。
export type {
  AskOption,
  AskQuestion,
  AskResponse,
  AttachmentChip,
  AutoRetryReason,
  ChatInsertRequest,
  ChatInsertResult,
  ChatModelConfig,
  ChatSendRequest,
  ChatStreamEvent,
  DisplayMessage,
  MountResponse,
  PlanResponse,
  ResolveAutotaskResult
}

/** 用户自定的对话标题上限（列表里单行省略显示，再长也看不全）。 */
const TITLE_MAX = 100

/**
 * 按「轮」删除对话（同步删除模型上下文）。turnIndices 为 0 基轮下标集合（越界者忽略）。
 * 就地重写 s.messages，并同步：① 重锚/丢弃 notices 边车；② 清理按 toolUseId 记录的边车
 * （proposals/asks/summaries）——只保留仍存活的 tool_use。压缩摘要保留（全部轮都删时才一并清空）。
 * **边界安全**：整轮删除天然不切断 tool_use↔tool_result（一轮的工具调用与其结果同处该轮区间内），
 * 故删除后剩余序列不会出现「有 tool_use 无 tool_result」或反之的悬挂对。
 */
function deleteTurns(s: StoredSession, turnIndices: number[]): void {
  const ranges = turnRanges(s.messages)
  const del = new Set(turnIndices.filter((k) => Number.isInteger(k) && k >= 0 && k < ranges.length))
  if (del.size === 0) return

  const old = s.messages
  // 压缩摘要不随轮删除：它概括的是此前全部内容（两轮之间的摘要落在上一轮的区间末尾，轮内的在本轮中间），
  // 删掉会让模型退回去看更早、更长的原文。删轮只删原文，摘要不动。
  const toDelete = new Set<number>()
  for (const k of del)
    for (let i = ranges[k].start; i < ranges[k].end; i++) if (!isCompactionSummary(old[i])) toDelete.add(i)

  // 删空全部轮：连同前言（压缩摘要等预备区，不属任何轮）一并清空——否则残留孤立前言。
  // 仅「全部轮均被删」才清前言；否则前言随其后仍存活的首轮保留。
  if (del.size === ranges.length) {
    s.messages = []
    s.notices = []
    s.proposals = {}
    s.asks = {}
    s.summaries = {}
    s.delivered = {}
    s.plans = {}
    s.autotasks = {}
    s.todos = []
    s.todoCancelled = []
    s.todoCancelNote = undefined
    // 检查点记录同样按 toolUseId 归属，随轮一并清空（lastKnown / baselines 描述的是磁盘现状，保留）。
    s.checkpoints = {}
    s.background = {}
    s.durations = {}
    cancelBackground(s.id)
    pruneSubagents(s.id, new Set())
    s.updatedAt = Date.now()
    return
  }

  s.messages = old.filter((_, i) => !toDelete.has(i))

  // 待办清单：删掉被删轮里那几次写入的快照，折叠结果即回到删轮前。不能像其余边车那样「只留存活
  // tool_use」——被压缩掉的写入仍是清单现状，那样一删轮就把它们误清了。
  if (s.todos?.length) {
    const gone = new Set<string>()
    for (const i of toDelete) {
      const c = old[i].content
      if (typeof c !== 'string') for (const p of c) if (p.type === 'tool_use') gone.add(p.id)
    }
    s.todos = s.todos.filter((e) => !gone.has(e.id))
    if (s.todoCancelled?.length) {
      const live = new Set(s.todos.map((e) => e.listId))
      s.todoCancelled = s.todoCancelled.filter((x) => live.has(x))
    }
  }

  // 重锚 notices：after 语义 = 提示前方的消息条数（锚点消息下标 = after-1）。
  //  after=0（锚在最前）恒保留；锚点消息被删 → 丢弃该提示；否则新 after = 存活消息中「旧下标 < after」的条数。
  if (s.notices?.length) {
    const survivingBefore = (afterOld: number): number => {
      let c = 0
      for (let i = 0; i < afterOld && i < old.length; i++) if (!toDelete.has(i)) c++
      return c
    }
    s.notices = s.notices
      .filter((nt) => nt.after === 0 || !toDelete.has(nt.after - 1))
      .map((nt) => (nt.after === 0 ? nt : { ...nt, after: survivingBefore(nt.after) }))
  }

  // 清理按 toolUseId 的边车：只保留仍存活消息里出现的 tool_use id。
  const liveUseIds = new Set<string>()
  for (const m of s.messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_use') liveUseIds.add(p.id)
  }
  const prune = <T>(rec?: Record<string, T>): Record<string, T> | undefined => {
    if (!rec) return rec
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec)) if (liveUseIds.has(k)) out[k] = v
    return out
  }
  s.proposals = prune(s.proposals)
  s.asks = prune(s.asks)
  s.summaries = prune(s.summaries)
  s.delivered = prune(s.delivered)
  s.plans = prune(s.plans)
  // autotasks 边车随名片 tool_use 存活；删除对话轮不删已创建的定时任务本体（任务独立生命周期，经「定时任务」页管理）。
  s.autotasks = prune(s.autotasks)
  // 被删轮的检查点记录随之丢弃：它们的文件改动留在磁盘上，此后不再能经回滚撤回。
  s.checkpoints = prune(s.checkpoints)
  s.background = prune(s.background)
  s.durations = prune(s.durations)
  // 派发在被删轮次里、仍在后台跑的子智能体就地中止（不再通知）；创建或续聊发生在被删轮次的子智能体整条删除：
  // 删掉的内容模型不再看到，子智能体的上下文里也不该留着。
  cancelBackground(s.id, liveUseIds)
  pruneSubagents(s.id, liveUseIds)
  s.updatedAt = Date.now()
}

/**
 * 定时任务密封执行器（模块级桥接）：scheduler 经 runScheduledTask 跨模块直调。registerChatIpc 运行时
 * 才挂上 chat-turns.ts 的 runScheduledTurn——此前事件订阅与窗口尚未就绪，调用即抛错，
 * 由 scheduler 捕获记一次错误运行（绝不崩）。
 */
let scheduledRunner: ((task: TaskRecord) => Promise<ScheduledTurnResult>) | null = null
export function runScheduledTask(task: TaskRecord): Promise<ScheduledTurnResult> {
  if (!scheduledRunner)
    return Promise.reject(new Error('chat runtime 尚未就绪（registerChatIpc 未运行）'))
  return scheduledRunner(task)
}

/**
 * 会话编排的对外入口（模块级桥接，同 scheduledRunner）：桌面 IPC 处理器与远程通道调用的是同一组函数，
 * 故手机端发起的回合、作答的问答卡，与桌面端走完全相同的路径（落盘 / 检查点 / 权限闸门一致）。
 */
export interface ChatRuntime {
  send(req: ChatSendRequest): Promise<{ turnId: string }>
  /** 回合进行中插入一条消息（见 ChatInsertRequest）。 */
  insert(req: ChatInsertRequest): ChatInsertResult
  abort(turnId: string): void
  answerAsk(r: AskResponse): boolean
  decidePlan(r: PlanResponse): boolean
  answerMount(r: MountResponse): boolean
  /** 角色名片终态（接受时角色本体由调用方先行创建）。 */
  resolveProposal(sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): boolean
  /** 定时任务确认名片：create 即授权建任务，dismiss 忽略。 */
  resolveAutotask(
    sessionId: string,
    toolUseId: string,
    action: 'create' | 'dismiss',
    input?: TaskCreateInput
  ): ResolveAutotaskResult
  /** 会话是否正有回合在跑（对话 / 定时任务）。 */
  isBusy(sessionId: string): boolean
}
let chatRuntime: ChatRuntime | null = null
export function getChatRuntime(): ChatRuntime | null {
  return chatRuntime
}

/** 推送某会话待办清单的状态（按轮删除 / 回滚 / 用户手动取消之后；不属于任何回合步骤，turnId 为空串）。 */
function emitTodos(s: StoredSession): void {
  emit('', s.id, { type: 'todos', state: todoState(s.todos, s.todoCancelled) })
}

// 持久化角色名片的终态（接受/拒绝）。名片本体随 Message[] 存活，但终态无处落，
// 故用 StoredSession.proposals 边车按 toolUseId 记录——重开不再退回 pending、不会重复建角色。
// 桌面与手机端（remote/hub.ts）共用；决议后广播 card_resolved，另一端据此把名片收成终态。
function resolveProposal(sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): boolean {
  const s = getSession(sessionId)
  if (!s) return false
  s.proposals = { ...s.proposals, [toolUseId]: status }
  saveProject(sessionId)
  emit('', sessionId, { type: 'card_resolved', card: 'agent', toolUseId, status })
  return true
}

// 定时任务确认名片的决议——**唯一的授权时刻**（对标 chat:resolve-proposal，但兼建任务本体）。
// create：即在此刻用用户在名片里议定的完整信封调 createTask（创建=授权，此后触发零交互）；成功才落 autotasks
//         边车 {created, taskId} 并存会话；失败不落边车（名片留待用户修正后重试）。
// dismiss：记 {dismissed}，名片转紧凑「已忽略」态，不建任何任务。
// 幂等：同名片重复 create 直接回已建任务（防双提交造双任务）。任务本体持久化于主进程 tasks.json（渲染层写不进）。
function resolveAutotask(
  sessionId: string,
  toolUseId: string,
  action: 'create' | 'dismiss',
  taskInput?: TaskCreateInput
): ResolveAutotaskResult {
  const s = getSession(sessionId)
  if (!s) return { ok: false, error: 'no-session' }

  // 幂等：已创建过则回既有 taskId，绝不重复建任务。
  const prior = s.autotasks?.[toolUseId]
  if (prior?.status === 'created' && prior.taskId)
    return { ok: true, status: 'created', taskId: prior.taskId }

  if (action === 'dismiss') {
    s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'dismissed' } }
    saveProject(sessionId)
    emit('', sessionId, { type: 'card_resolved', card: 'autotask', toolUseId, status: 'dismissed' })
    return { ok: true, status: 'dismissed' }
  }

  // action === 'create'
  if (!taskInput || typeof taskInput !== 'object') return { ok: false, error: 'no-input' }
  // 记下在哪个对话里创建；创建出来独立运行，不绑定这个对话。
  const res: CreateTaskResult = createTask({ ...taskInput, originSessionId: sessionId })
  if (!res.ok) return { ok: false, error: res.error }
  s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'created', taskId: res.task.id } }
  saveProject(sessionId)
  emit('', sessionId, {
    type: 'card_resolved',
    card: 'autotask',
    toolUseId,
    status: 'created',
    taskId: res.task.id
  })
  return { ok: true, status: 'created', taskId: res.task.id }
}

/** 删除一个会话的全部痕迹：中止进行中的回合、后台子智能体、网页，删对话文件、检查点与子智能体记录。 */
function purgeSession(sessionId: string): void {
  // 正在进行的回合先中止（本机发起 / 手机端 / 定时任务一视同仁）：不然它在后台照常调模型、执行工具，
  // 结果却写不回已删除的对话。渲染层不必先发 abort——没打开过的对话它根本不知道回合 id。
  const turnId = busySessions.get(sessionId)
  if (turnId) abortTurn(turnId, 'deleted')
  cancelBackground(sessionId)
  closeSessionPages(sessionId)
  deleteStoredSession(sessionId)
  pendingUndo.delete(sessionId)
  removeSessionCheckpoints(sessionId)
  removeSessionSubagents(sessionId)
  memberDispatches.delete(sessionId)
  pendingHandoffs.delete(sessionId)
  for (const [g, rec] of memberGroupDone) if (rec.mainId === sessionId) memberGroupDone.delete(g)
}

// 用户对权限请求的答复
// 用户对 ask_user 询问的答复（每题的选中项标签或自由输入；null 视为取消）
// 三类答复：先到者生效（键随即删除，后到的一律 false），并广播 interaction_resolved 让其余端收卡。
function answerAsk(payload: AskResponse): boolean {
  const p = pendingAsk.get(payload.key)
  if (!p) return false
  pendingAsk.delete(payload.key)
  p.resolve(payload.answers)
  emit(p.turnId, p.sessionId, {
    type: 'interaction_resolved',
    key: payload.key,
    kind: 'ask',
    answers: payload.answers
  })
  return true
}

function decidePlan(payload: PlanResponse): boolean {
  const p = pendingPlan.get(payload.key)
  if (!p) return false
  pendingPlan.delete(payload.key)
  // 回复要回灌进模型上下文：只认「继续完善」附带的非空字符串。
  const feedback =
    payload.decision === 'keep' && typeof payload.feedback === 'string'
      ? payload.feedback.trim() || undefined
      : undefined
  p.resolve({ decision: payload.decision, ...(feedback ? { feedback } : {}) })
  emit(p.turnId, p.sessionId, {
    type: 'interaction_resolved',
    key: payload.key,
    kind: 'plan',
    decision: payload.decision,
    ...(feedback ? { feedback } : {})
  })
  return true
}

// 用户对「请求挂载工作区」的回应：path=已选目录 / null=暂不挂载。
// 只认真实存在的目录，并（幂等）登记受信根。渲染层传来的路径出自 fs.openFolder（系统目录对话框，
// 已 trustRoot），这里的 trustRoot 只是兜底。拿不到有效目录一律按「暂不挂载」处置。
// 远程通道只会传 null（目录只能在桌面的系统对话框里选，手机端无从提供可信路径）。
function answerMount(payload: MountResponse): boolean {
  const p = pendingMount.get(payload.key)
  if (!p) return false
  pendingMount.delete(payload.key)
  const raw = typeof payload.path === 'string' ? payload.path.trim() : ''
  let dir: string | null = null
  if (raw) {
    const abs = resolvePath(raw)
    try {
      if (statSync(abs).isDirectory()) {
        trustRoot(abs)
        dir = abs
      }
    } catch {
      dir = null
    }
  }
  p.resolve(dir)
  emit(p.turnId, p.sessionId, { type: 'interaction_resolved', key: payload.key, kind: 'mount', path: dir })
  return true
}

export function registerChatIpc(getWin: () => BrowserWindow | null): void {
  setWindowGetter(getWin)
  // 渲染层只是总线的一个订阅者（远程通道是另一个，见 remote/hub.ts）。
  // 退出收尾期间窗口可能已销毁：此时回合仍在补结果 / 落盘，事件丢掉即可，绝不能因 send 抛错打断收尾。
  onChatEvent((p) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('chat:event', p)
  })
  onSessionsChanged(() => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('chat:sessions-changed')
  })
  // 挂上模块级桥接，供 scheduler.ts 经 runScheduledTask 跨模块直调（registerChatIpc 运行即就绪）。
  scheduledRunner = runScheduledTurn

  ipcMain.handle('chat:send', (_e, payload: ChatSendRequest) => sendMessage(payload))

  // 回合进行中插入消息（见 insertMessage）；撤回全部待送达的，返回合并后的原文供放回输入框。
  ipcMain.handle('chat:insert', (_e, payload: ChatInsertRequest): ChatInsertResult => insertMessage(payload))
  ipcMain.handle('chat:withdraw-inserts', (_e, sessionId: string): { text: string } => ({
    text: takeInserts(sessionId) ?? ''
  }))

  /* 说明：persona 绑定与聚焦工作区都已由 ensureSession 落在 session 上，runTurn 内直接读取 —— 见其实现。 */

  // 手动压缩（输入框 /compact）：立即压缩历史，只回发 compacted + done，无后续模型轮。
  ipcMain.handle(
    'chat:compact',
    async (_e, payload: ChatCompactRequest): Promise<{ turnId: string }> => {
      const { sessionId, model } = payload
      // 历史正被改写（见 historyLocked）：不压，请求直接失败，渲染层撤掉占位并提示原因。
      if (historyLocked(sessionId))
        throw new Error(
          isEn()
            ? 'This chat is busy right now. Try compacting again when it finishes.'
            : '这个对话正在进行中，请等它结束后再压缩。'
        )
      const turnId = genId('turn')
      const controller = new AbortController()
      activeTurns.set(turnId, controller)
      compacting.add(sessionId)
      try {
        const session = getSession(sessionId)
        let status: CompactStatus = 'none'
        let message: string | undefined
        if (session) {
          // 与 runTurn 同源：按**本对话**模型（快照固定）压缩——窗口与摘要模型都用它，删除则回落 model。
          const r = await compactWithStatus(turnId, sessionId, {
            session,
            model: resolveModelRef(session.model, model),
            signal: controller.signal
          })
          status = r.status
          message = r.message
          if (status === 'failed') console.warn('[compaction] 手动压缩失败：', message)
          if (status === 'compacted') {
            // 压缩不删消息，被压的轮照样能回滚（检查点保留）；撤销快照是改写前的整份历史，随之作废。
            pendingUndo.delete(sessionId)
            saveProject(sessionId)
          }
        }
        emit(turnId, sessionId, { type: 'compacted', scope: 'manual', status, message })
      } catch (e) {
        emit(turnId, sessionId, {
          type: 'compacted',
          scope: 'manual',
          status: 'failed',
          message: (e as Error)?.message ?? String(e)
        })
      } finally {
        activeTurns.delete(turnId)
        compacting.delete(sessionId)
        emit(turnId, sessionId, { type: 'done', stopReason: 'end_turn' })
        // 压缩期间结束的后台子智能体：此刻再为它们起轮。
        wakeForNotices(sessionId)
      }
      return { turnId }
    }
  )

  // 立即建档一条空对话（对话优先外壳：与角色开启新对话时即落盘，重启仍在）。
  // 与 chat:send 的惰性建档同源（ensureSession + saveProject），差别只在「首发前就落盘」——
  // 让空对话作为真实持久化会话进入左侧列表、跨重启存活。旧 AppShell 不调用此接口，仍走惰性路径。
  ipcMain.handle(
    'chat:create-session',
    (_e, payload: ChatCreateSessionRequest): { ok: true } => {
      const { sessionId, personaId, focusRoot, modelRef } = payload
      ensureSession(sessionId, { personaId, focusRoot, model: modelRef })
      saveProject(sessionId)
      return { ok: true }
    }
  )

  // 对话输入框切换模型：立即落库到本对话（此前只写渲染层覆盖层、随下一次发送才落库，切了没发重启即丢）。
  // 尚未建档的惰性会话查不到 → 不建档，模型仍由覆盖层随首发落库。不改 updatedAt（换模型不算新活动）。
  // ok = 对话已建档、已落库（渲染层据此撤掉本地覆盖层，此后以主进程为准）；惰性未建档的返回 false。
  // 任务对话里切换模型 = 改任务的模型（两边同步，见 tasks.ts syncTaskModel）。
  ipcMain.handle('chat:set-model', (_e, payload: ChatSetModelRequest): { ok: boolean } => {
    const session = getSession(payload.sessionId)
    if (!session) return { ok: false }
    session.model = payload.modelRef
    saveProject(payload.sessionId)
    syncTaskModel(payload.sessionId, payload.modelRef)
    // 成员会话：用户亲自选了模型，此后派任务不再按主对话覆盖。
    markMemberSetting(session, 'modelSet')
    return { ok: true }
  })

  // 对话输入框切换思考等级：同 set-model——立即落库到本对话，惰性未建档的会话跳过（随首发落库），不改 updatedAt。
  ipcMain.handle('chat:set-effort', (_e, payload: ChatSetEffortRequest): { ok: true } => {
    const session = getSession(payload.sessionId)
    if (session && isEffortLevel(payload.effort)) {
      session.effort = payload.effort
      saveProject(payload.sessionId)
      markMemberSetting(session, 'effortSet')
    }
    return { ok: true }
  })

  // 挂载 / 卸载聚焦工作区：立即落库到本对话。此前只写渲染层覆盖层、随下一次桌面发送才落库——
  // 挂载后首条消息若来自远程通道（飞书等，不带 focusRoot），这一轮就读不到工作区；切了没发重启也会丢。
  // 惰性会话同 set-model：查不到则不建档，仍由覆盖层随首发落库。不改 updatedAt。
  ipcMain.handle('chat:set-focus', (_e, payload: ChatSetFocusRequest): { ok: true } => {
    const session = getSession(payload.sessionId)
    if (session?.parentId) {
      setMemberFolder(session, payload.focusRoot)
      return { ok: true }
    }
    if (session) {
      session.focusRoot = payload.focusRoot
      saveProject(payload.sessionId)
    }
    return { ok: true }
  })

  // 重命名对话：写入标题并落盘（索引随之刷新），回传最终标题。清空即恢复自动标题——同首发时的派生规则，
  // 取首条用户消息（展示用原文，不含随消息附带的提醒）。会话对象全局缓存为同一份，回合进行中改名也不会被
  // 这一轮后续落盘冲掉；自动派生只在标题为空时写，不会覆盖用户起的名字。不改 updatedAt（改名不算新活动，
  // 列表顺序不变）。尚未建档的惰性会话查不到 → null。
  ipcMain.handle(
    'chat:rename-session',
    (_e, payload: ChatRenameSessionRequest): { title: string } | null => {
      const session = getSession(payload.sessionId)
      if (!session) return null
      let title = String(payload.title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
      if (!title) {
        const first = displayOf(session).find((m) => m.role === 'user' && !m.notify)
        if (first?.role === 'user')
          title = deriveTitle(first.text) || deriveTitle(first.attachments.map((a) => a.name).join(' '))
      }
      session.title = title
      saveProject(payload.sessionId)
      return { title }
    }
  )

  // 归档 / 取消归档：只改这一个标记并落盘，不动 updatedAt（列表顺序不变）。尚未建档的惰性会话回 ok:false。
  // 进行中的对话不能归档（界面上菜单已灰显；这里兜住菜单打开后回合才开始的情形，返回 false 渲染层即按清单复原）。
  ipcMain.handle('chat:set-archived', (_e, payload: ChatSetArchivedRequest): { ok: boolean } => ({
    ok:
      !(payload.archived === true && busySessions.has(payload.sessionId)) &&
      setSessionArchived(payload.sessionId, payload.archived === true)
  }))

  // 左侧会话列表：一次列全部（对话无项目/分桶概念）。IPC 仍收 workspaceRoot 以兼容渲染层调用签名，忽略即可。
  ipcMain.handle(
    'chat:list-sessions',
    (_e, _workspaceRoot: string | null): ChatSessionMeta[] => {
      // 成员会话（见 members.ts，带 parentId）也一并交出：渲染层不列进左侧列表，但打开成员对话时要读它的模型、
      // 思考等级与文件夹；它的文件夹同样要在下面登记受信根（输入框的 git 小部件要用）。
      const list = listSessions()
      // 重开后恢复「已挂载项目」的受信根：trustRoot 是内存态、随重启清空（见 fs-guard），而 focusRoot 是
      // 持久化的对话属性——若不在此重新登记，重启后带挂载目录的会话一渲染就调 git:status / fs:*，其首行
      // assertInside 因根未受信而抛「拒绝访问」，表现为「git 丢失 + Error occurred in handler for 'git:status'」。
      // 这是渲染层能拿到 focusRoot 的最早时刻（渲染任何对话 / GitWidget 前必先经此列表），在此登记即无竞态。
      // 语义等同 IDE 重开时恢复已打开的项目文件夹（受信根只约束渲染层 IPC，与 Agent 文件工具无关）。
      for (const m of list) {
        if (typeof m.focusRoot === 'string' && m.focusRoot.trim()) trustRoot(m.focusRoot)
      }
      return list
    }
  )

  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, _workspaceRoot: string | null): DisplayMessage[] => loadDisplay(sessionId)
  )

  // 对话记录里的图片附件：缩略图（full=false）或原图（full=true，点开看大图）。ref 即展示层附件上的
  // 「消息下标:内容块下标:指纹」（imageRef）——按轮删除 / 回滚 / 压缩后展示层整份重载，ref 随之更新；
  // 对不上（那里已不是这张图）返回 null，界面显示类型图标占位。
  ipcMain.handle(
    'chat:attachment-image',
    (_e, sessionId: unknown, ref: unknown, full: unknown): string | null => {
      if (typeof sessionId !== 'string' || typeof ref !== 'string') return null
      const at = /^(\d+):(\d+):/.exec(ref)
      const msg = at ? getSession(sessionId)?.messages[Number(at[1])] : undefined
      if (!at || msg?.role !== 'user' || typeof msg.content === 'string') return null
      const pi = Number(at[2])
      const part = msg.content[pi]
      if (part?.type !== 'image' || imageRef(Number(at[1]), pi, part.data) !== ref) return null
      if (full === true) return `data:${part.mediaType};base64,${part.data}`
      try {
        return thumbnailDataUrl(Buffer.from(part.data, 'base64'), part.mediaType)
      } catch {
        return null
      }
    }
  )

  // 载入历史 + 进行中回合的 turnId（无则 null），同一时刻取出：渲染层据此接上别处发起、仍在跑的一轮——
  // 此后到达的流事件都晚于这份快照，不会漏掉 done 而永远停在「进行中」。
  ipcMain.handle(
    'chat:attach-session',
    (
      _e,
      sessionId: string
    ): { messages: DisplayMessage[]; turnId: string | null; startedAt: number | null } => ({
      messages: loadDisplay(sessionId),
      turnId: busySessions.get(sessionId) ?? null,
      // 进行中这一轮的开始时刻：渲染层中途接上时据此续上计时，而不是从接上那一刻重新算。
      startedAt: busySince.get(sessionId) ?? null
    })
  )

  ipcMain.handle(
    'chat:resolve-proposal',
    (_e, sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): { ok: boolean } => ({
      ok: resolveProposal(sessionId, toolUseId, status)
    })
  )

  ipcMain.handle(
    'chat:resolve-autotask',
    (
      _e,
      sessionId: string,
      toolUseId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ): ResolveAutotaskResult => resolveAutotask(sessionId, toolUseId, action, taskInput)
  )
  // 删绑定任务时连任务对话一起删（tasks.ts deleteTask）：正在跑的一轮由 purgeSession 中止。
  setTaskSessionPurger(purgeSession)

  // 删除某会话（含会话级授权）。id 全局唯一 → 按 id 删。主对话连同它的成员会话一并删除；在它里面运行的定时任务
  // 改为独立运行（任务与任务对话保留，任务对话回到左侧列表）。
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, _workspaceRoot: string | null): { ok: true } => {
      const members = getSession(sessionId)?.members ?? []
      purgeSession(sessionId)
      for (const m of members) purgeSession(m.sessionId)
      releaseTasksOwnedBy(sessionId)
      return { ok: true }
    }
  )

  // 移除成员（成员卡片的「移除成员」）：不再派任务给它，正在进行的任务中止；成员会话保留（可从名单里恢复）。
  // 主智能体经下一次随消息下发的名单更新得知。
  ipcMain.handle(
    'chat:remove-member',
    (_e, sessionId: string, memberSessionId: string): { ok: boolean } => {
      const main = getSession(sessionId)
      const ref = main?.members?.find((m) => m.sessionId === memberSessionId && !m.removed)
      if (!main || !ref) return { ok: false }
      ref.removed = true
      setOpenTasks(ref, [])
      saveProject(sessionId)
      const turnId = busySessions.get(memberSessionId)
      if (turnId) abortTurn(turnId)
      publishSessionsChanged()
      return { ok: true }
    }
  )

  // 内置浏览器：对话有进行中的回合或后台子智能体时，后台网页不按短时限回收（见 browser/pages.ts BACKGROUND_CLOSE_MS）
  setBrowserSessionBusyCheck(
    (sessionId) => busySessions.has(sessionId) || [...backgroundSubagents.values()].some((b) => b.sessionId === sessionId)
  )

  // 内置浏览器窗口里的「停止」：按对话停止它正在进行的回合
  setSessionAborter((sessionId) => {
    const turnId = busySessions.get(sessionId)
    if (!turnId) return false
    abortTurn(turnId)
    return true
  })

  ipcMain.handle('chat:abort', (_e, turnId: string): { ok: true } => {
    abortTurn(turnId)
    return { ok: true }
  })

  // 停止一个后台运行的子智能体（Task 卡上的停止键）。toolUseId = 开出它的那次调用 id（即卡片 id）。
  // 它照常收尾：Task 卡定格「已停止」，结论（含停止前的输出）随下一轮交给模型，但不为此自动起一轮。
  ipcMain.handle(
    'chat:stop-subagent',
    (_e, sessionId: string, toolUseId: string): { ok: boolean } => {
      const b = backgroundSubagents.get(toolUseId)
      if (!b || b.sessionId !== sessionId) return { ok: false }
      b.stoppedByUser = true
      b.controller.abort()
      return { ok: true }
    }
  )

  // 按「轮」删除对话（同步删上下文）。id 全局唯一 → 按 id。turnIndices 为 0 基轮下标集合。
  // 返回删除后重建的展示气泡，供渲染层就地替换——保证展示与落盘一致、重启不变。
  // 历史正被改写（见 historyLocked）时不删，回 null，渲染层提示稍后再删。
  ipcMain.handle(
    'chat:delete-turns',
    (
      _e,
      sessionId: string,
      _workspaceRoot: string | null,
      turnIndices: number[]
    ): DisplayMessage[] | null => {
      const s = getSession(sessionId)
      if (!s) return []
      if (historyLocked(sessionId)) return null
      deleteTurns(s, Array.isArray(turnIndices) ? turnIndices : [])
      // 撤销上次回滚会把刚删掉的轮复活，快照就此失效；被删轮的 blob 随之可回收。
      pendingUndo.delete(sessionId)
      saveProject(sessionId)
      collectBlobs(s)
      emitTodos(s)
      return displayOf(s)
    }
  )

  // 待办清单：渲染层切到某会话时拉取当前状态（此后的变化都走 todos 事件推送）。
  ipcMain.handle('chat:todos', (_e, sessionId: string): TodoState => {
    const s = getSession(sessionId)
    return todoState(s?.todos, s?.todoCancelled)
  })

  // 用户在面板里手动取消当前清单（不再进行）：胶囊收起，并在下一条消息里告知模型（todoCancelNote）。
  // 回合进行中不受理——模型正在推进它，取消了也会被立刻写回；界面上此时按钮不可点，先停止任务再取消。
  ipcMain.handle('chat:todo-cancel', (_e, sessionId: string): TodoState => {
    const s = getSession(sessionId)
    if (!s) return { active: null }
    const cur = activeTodoList(s.todos, s.todoCancelled)
    if (cur && !busySessions.has(sessionId)) {
      s.todoCancelled = [...(s.todoCancelled ?? []), cur.id]
      s.todoCancelNote = todoUserCancelNote(cur)
      saveProject(sessionId)
      emitTodos(s)
    }
    return todoState(s.todos, s.todoCancelled)
  })

  // ───────── 检查点回滚（对标 Claude Code /rewind）─────────
  // 只由用户在回滚面板里触发、不经工具闸门，故自守两条：路径只来自记录、链接跳过
  // （见 checkpoints.planRewind）。每次执行都在主进程重算计划，不信任渲染层回传的预览。

  // 回滚面板列表屏：每轮自身的改动量（文件数 / +N −M / 是否跑过命令）+ 能否撤销上次回滚。
  ipcMain.handle(
    'chat:rewind-list',
    (_e, sessionId: string): { turns: RewindTurnStat[]; canUndo: boolean } => {
      const s = getSession(sessionId)
      if (!s) return { turns: [], canUndo: false }
      return { turns: summarizeTurns(s, turnToolIds(s.messages)), canUndo: pendingUndo.has(sessionId) }
    }
  )

  // 回滚面板详情屏：回到第 turn 轮之前要动哪些文件（动作 / 状态 / +N −M）与哪些命令的影响撤不回。
  ipcMain.handle(
    'chat:rewind-preview',
    async (
      _e,
      sessionId: string,
      turn: number
    ): Promise<{ files: RewindFile[]; commands: string[] } | null> => {
      const s = getSession(sessionId)
      if (!s) return null
      const turns = turnToolIds(s.messages)
      if (!Number.isInteger(turn) || turn < 0 || turn >= turns.length) return null
      return publicPreview(await planRewind(s, turns.slice(turn).flat(), s.focusRoot ?? null))
    }
  )

  // 执行回滚：回到第 turn 轮开始之前。代码类模式恢复文件，对话类模式删掉第 turn 轮起的全部轮。
  ipcMain.handle(
    'chat:rewind-apply',
    async (
      _e,
      req: ChatRewindApplyRequest
    ): Promise<
      | {
          ok: true
          messages: DisplayMessage[]
          restored: string[]
          skipped: { rel: string; reason: RewindStatus | 'error' }[]
        }
      | { ok: false; error: 'no-session' | 'busy' | 'bad-turn' }
    > => {
      const s = getSession(req.sessionId)
      if (!s) return { ok: false, error: 'no-session' }
      if (historyLocked(s.id)) return { ok: false, error: 'busy' }
      const turns = turnToolIds(s.messages)
      const k = req.turn
      if (!Number.isInteger(k) || k < 0 || k >= turns.length) return { ok: false, error: 'bad-turn' }
      const withCode = req.mode === 'both' || req.mode === 'code'
      const withConversation = req.mode === 'both' || req.mode === 'conversation'

      rewinding.add(s.id)
      try {
        // 撤销快照：deleteTurns 对这些字段一律整体重新赋值（不原地改），故存引用即可；
        // lastKnown 会被 applyFiles 原地更新，须拷一份。
        const undo: RewindUndo = {
          files: [],
          state: {
            messages: s.messages,
            notices: s.notices,
            proposals: s.proposals,
            asks: s.asks,
            summaries: s.summaries,
            delivered: s.delivered,
            background: s.background,
            durations: s.durations,
            plans: s.plans,
            autotasks: s.autotasks,
            todos: s.todos,
            todoCancelled: s.todoCancelled,
            checkpoints: s.checkpoints,
            lastKnown: s.lastKnown ? { ...s.lastKnown } : undefined,
            restoreNote: s.restoreNote,
            lastInputTokens: s.lastInputTokens
          }
        }

        let restored: string[] = []
        let skipped: { rel: string; reason: RewindStatus | 'error' }[] = []
        if (withCode) {
          const plan = await planRewind(s, turns.slice(k).flat(), s.focusRoot ?? null)
          const force = new Set((req.force ?? []).filter((p): p is string => typeof p === 'string'))
          const r = await applyFiles(s, plan, force)
          restored = r.restored
          skipped = r.skipped
          undo.files = r.undo
        }

        if (withConversation) {
          deleteTurns(
            s,
            Array.from({ length: turns.length - k }, (_, i) => k + i)
          )
          // 实测输入量描述的是删轮前的长历史，留着会让下一轮误触发压缩；清掉即回落字符估算。
          s.lastInputTokens = undefined
        } else if (restored.length) {
          // 仅恢复代码：对话还记着被撤销的改动——下一条消息把回滚说明带给模型，并在对话流里留一条提示。
          const note = buildRestoreNote(restored)
          s.restoreNote = s.restoreNote ? `${s.restoreNote}\n\n${note}` : note
          s.notices = [
            ...(s.notices ?? []),
            { after: s.messages.length, kind: 'notice', code: 'restored' }
          ]
        }

        if (withConversation || restored.length) pendingUndo.set(s.id, undo)
        s.updatedAt = Date.now()
        saveProject(s.id)
        if (withConversation) emitTodos(s)
        return { ok: true, messages: displayOf(s), restored, skipped }
      } finally {
        rewinding.delete(s.id)
        // 回滚期间结束的后台子智能体：此刻再为它们起轮。推迟一拍，让回滚结果先于新一轮的事件到达渲染层
        //（渲染层拿到结果会整份替换气泡）。
        setTimeout(() => wakeForNotices(s.id), 0)
      }
    }
  )

  // 撤销上次回滚：文件写回回滚前的字节（只动回滚后未再被改过的），对话状态整体换回快照。
  ipcMain.handle(
    'chat:rewind-undo',
    async (
      _e,
      sessionId: string
    ): Promise<
      | { ok: true; messages: DisplayMessage[]; restored: string[]; skipped: string[] }
      | { ok: false; error: 'no-undo' | 'busy' }
    > => {
      const s = getSession(sessionId)
      const undo = pendingUndo.get(sessionId)
      if (!s || !undo) return { ok: false, error: 'no-undo' }
      if (historyLocked(sessionId)) return { ok: false, error: 'busy' }
      rewinding.add(sessionId)
      try {
        pendingUndo.delete(sessionId)
        const r = await undoFiles(undo.files)
        Object.assign(s, undo.state)
        s.updatedAt = Date.now()
        saveProject(sessionId)
        collectBlobs(s)
        emitTodos(s)
        return { ok: true, messages: displayOf(s), restored: r.restored, skipped: r.skipped }
      } finally {
        rewinding.delete(sessionId)
        setTimeout(() => wakeForNotices(sessionId), 0)
      }
    }
  )

  ipcMain.handle('chat:ask-response', (_e, payload: AskResponse): { ok: boolean } => ({
    ok: answerAsk(payload)
  }))

  ipcMain.handle('chat:plan-response', (_e, payload: PlanResponse): { ok: boolean } => ({
    ok: decidePlan(payload)
  }))

  ipcMain.handle('chat:mount-response', (_e, payload: MountResponse): { ok: boolean } => ({
    ok: answerMount(payload)
  }))

  // 挂上模块级桥接，供远程通道（remote/hub.ts）跨模块直调——与桌面 IPC 走同一套入口。
  chatRuntime = {
    send: (req) => sendMessage(req, true),
    insert: (req) => insertMessage(req, true),
    abort: abortTurn,
    answerAsk,
    decidePlan,
    answerMount,
    resolveProposal,
    resolveAutotask,
    isBusy: (sessionId) => busySessions.has(sessionId)
  }
}
