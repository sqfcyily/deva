import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  TaskCreateInput,
  ResolveAutotaskResult,
  RewindApplyResult,
  RewindMode,
  RewindUndoResult
} from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import { useModels, findActive } from './models'
import { useWorkspace } from './workspace'

/**
 * 会话状态（渲染层）。
 * 真正的对话历史、工具执行、密钥与文件访问都在主进程闭环；对话历史「按项目绑定」并持久化，
 * 这里只：
 * 1) 维护「左侧会话列表 + 当前会话」，切项目/切会话时向主进程拉取清单 / 重建气泡；
 * 2) 采集用户输入（可带附件路径），带上「当前默认模型 + 当前项目根」发 chat:send；
 * 3) 订阅 chat:event 流，把富事件累积成可渲染的消息块（文本 / 思考 / 工具卡 / 权限卡 / 错误）。
 * 每个助手回合聚合为一条 assistant 消息，块按到达顺序排列。
 */

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

export type AttachKind = 'image' | 'document' | 'text'

/** ask_user 候选项（与 preload/主进程对齐）。 */
export interface AskOption {
  label: string
  description?: string
}

/** ask_user 单个问题：题干 + 候选项 + 是否多选 + 是否必答（与 preload/主进程对齐）。 */
export interface AskQuestion {
  question: string
  options: AskOption[]
  multi: boolean
  /** false=可跳过（允许空答）；缺省/true=必答。 */
  required?: boolean
}

/** 折叠 Task 卡内的子工具项（子智能体内部的一次工具调用，收纳进卡内不占主流）。 */
export interface SubagentChild {
  id: string
  name: string
  args: unknown
  status: ToolStatus
  summary?: string
}

/** 角色名片草稿（与 preload/主进程 AgentDraft 对齐）：propose_agent 参数归一化后的形状。 */
export interface AgentDraft {
  name: string
  desc: string
  model: string
  prompt: string
}

/**
 * 定时任务确认名片草稿（与 preload/主进程 AutotaskDraft 对齐）：create_task 参数归一化后的形状。
 * schedule 扁平化为恒有 at/cron/tz 字符串（不适用者为空串），便于编辑器双向绑定；tz 空 = 创建时按本地时区补。
 * 授权信封（人格/模型）不在草稿里——由用户在名片编辑并授权，此草稿只承载模型的建议部分。
 */
export interface AutotaskDraft {
  title: string
  prompt: string
  schedule: { kind: 'once' | 'recurring'; at: string; cron: string; tz: string }
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: ToolStatus; summary?: string }
  | {
      /**
       * 角色名片：propose_agent 的惰性提议。点名片打开预填的 PersonaEditor（接受/拒绝/关闭）。
       * status=pending 可点确认；accepted/rejected 为终态、不可再点。终态经 chat:resolve-proposal 持久化。
       */
      kind: 'agentcard'
      /** propose_agent 工具调用 id（= 终态边车键）。 */
      id: string
      draft: AgentDraft
      status: 'pending' | 'accepted' | 'rejected'
    }
  | {
      /**
       * 定时任务确认名片：create_task 的惰性提议。点名片编辑授权信封（日程/人格/模型/写入根/工具白名单/通知）
       * 后点「创建」才真正建任务与独占会话——「创建时批准、执行时零交互」的授权时刻。
       * status=pending 可编辑并创建/忽略；created/dismissed 为终态、只读展示。终态经 chat:resolve-autotask 持久化。
       */
      kind: 'autotaskcard'
      /** create_task 工具调用 id（= 终态边车键）。 */
      id: string
      draft: AutotaskDraft
      status: 'pending' | 'created' | 'dismissed'
      /** created 态指向已建任务（其独占会话 id 与之相同）；供「打开会话」跳转。 */
      taskId?: string
    }
  | {
      /**
       * 子智能体折叠 Task 卡：run_subagent 调用的「壳」。默认仅显示结论摘要（summary），
       * 内部工具调用（depth>0 事件）收纳进 children，可展开查看；嵌套权限请求不进此卡，照常浮出。
       */
      kind: 'subagent'
      /** run_subagent 工具调用 id（用于匹配其 depth=0 的 tool_result 壳结果）。 */
      id: string
      /** 子智能体显示名（取自调用参数 agent；省略预设时为空 → 展示为「通用子智能体」）。 */
      agent: string
      /** 任务标题（取自调用参数 description，3-5 字）：有则作卡片主标题，比固定的子智能体名有信息量。 */
      desc?: string
      /** 任务描述（取自调用参数 prompt，仅展开时预览）。 */
      task?: string
      status: ToolStatus
      /** 结论摘要（壳结果 summary，如「子智能体「X」已完成」）。 */
      summary?: string
      children: SubagentChild[]
    }
  | {
      kind: 'ask'
      key: string
      questions: AskQuestion[]
      /** 已答复的各题答案（answers[i] 对应 questions[i]）；未答为 undefined，此时展示可交互问答卡。 */
      answers?: string[]
    }
  | {
      /**
       * 计划审阅卡：exit_plan 提交的待批准计划。undecided（decided 缺省）可点「批准并执行/继续完善」；
       * decided 为终态、只读展示。批准（approve）即让主进程循环继续，按计划执行。
       * cancelled = 这次审阅已随回合结束（用户中断 / 重开对话回填）：主进程那把待决键已经解开，
       * 再点也无人接应，故不画按钮——否则留下的是一张点了没反应的「僵尸卡」。
       */
      kind: 'plan'
      key: string
      plan: string
      decided?: 'approve' | 'keep' | 'cancelled'
    }
  | {
      /**
       * 挂载工作区请求卡：未挂载工作区时，模型某次调用缺「相对路径基准」，主进程闸门暂停循环等用户处置。
       * undecided（decided 缺省）可点「挂载工作区/暂不挂载」；decided 为终态、只读展示。
       * **只活在本次运行的渲染态**（不落边车）：重开时那对 tool_use/tool_result 已把来龙去脉讲清楚。
       */
      kind: 'mount'
      key: string
      tool: string
      path: string
      decided?: 'mounted' | 'skipped'
      /** decided='mounted' 时的已挂载目录，供卡片展示。 */
      root?: string
    }
  | { kind: 'error'; message: string }
  /**
   * 回合终止 / 上下文压缩提示（非错误，弱化样式）。
   * truncated=达输出长度上限被截断；empty=通篇无可见回复；
   * compacted=较早历史已压缩为摘要；
   * restored=用检查点只回滚了代码（对话保留，下一条消息会告诉模型）；
   * aborted=用户中止了本轮（其上为中止前已产出的内容，重开仍在）。
   * 正文按 code 在渲染层翻译（随语言切换生效，不在 store 里定格文案）。
   * 只收主进程会落盘的那几种（与 DisplayBlock 同集）：不落盘的提示（尚未选择模型 / 无需压缩 /
   * 压缩失败 / 发送失败）一律走 toast——做成气泡重启即消失，前后不一致。
   */
  | {
      kind: 'notice'
      code: 'truncated' | 'empty' | 'refused' | 'compacted' | 'restored' | 'aborted'
    }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  /** 用户消息附件贴片（仅名称 + 类型，不含正文/base64）。 */
  attachments?: { name: string; kind: AttachKind }[]
}

/** 会话元信息（左侧列表用）。 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 绑定的 persona id（对话优先外壳：驱动列表头像/主题色）。旧壳会话缺省。 */
  personaId?: string
  /** 聚焦工作区绝对路径；null = 全机通用助手（无聚焦）。 */
  focusRoot?: string | null
  /** 本对话模型引用 `"providerId:modelId"`；空串/缺省 = 跟随全局默认。见 chat store 的 bindings.model。 */
  model?: string
}

/** send 接受的附件（路径给主进程读取，名称/类型用于本地乐观气泡）。 */
export interface SendAttachment {
  path: string
  name: string
  kind: AttachKind
}

/**
 * 流式活跃状态（供底部"工作状态指示器"用）。
 * elapsedSec 本轮已用秒数（在跳=还活着）；reconnecting 非 null 表示主进程正在自动重连
 * （真实信号，来自 reconnecting 事件，非猜测）。非 streaming 时归零。
 */
export interface StreamStatus {
  elapsedSec: number
  reconnecting: RecoveryStatus | null
}

/**
 * 单个会话的活动态快照（供左侧会话列表角标）。
 * streaming=该会话正有一轮在跑（可能在后台）；attention=有「待用户处理」项（未决权限 / 未答问答）——
 * 后台会话若触发授权/问询会阻塞在主进程等答复，靠此角标提示用户切回去处理，避免无声卡住。
 * unread=不在查看时有回合完成（含定时任务的后台运行），切进该会话即清除；仅存内存，重启不保留。
 */
export interface SessionLiveState {
  streaming: boolean
  attention: boolean
  unread: boolean
}

/** 与 preload/主进程 DisplayMessage 结构一致（渲染层结构化复述）。 */
type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }
  | {
      kind: 'notice'
      code: 'compacted' | 'truncated' | 'empty' | 'refused' | 'restored' | 'aborted'
    }
  | { kind: 'error'; message: string }
  | { kind: 'agentcard'; id: string; draft: AgentDraft; status: 'pending' | 'accepted' | 'rejected' }
  | {
      kind: 'autotaskcard'
      id: string
      draft: AutotaskDraft
      status: 'pending' | 'created' | 'dismissed'
      taskId?: string
    }
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] | null }
  | { kind: 'plan'; id: string; plan: string; decision: 'approve' | 'keep' | 'cancelled' }
type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: AttachKind }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

/** 与 preload/主进程 ChatStreamEvent 结构一致（按既定模式在渲染层复述线缆类型）。 */
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      args: unknown
      depth?: number
      agent?: string
      parent?: string
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      summary: string
      isError: boolean
      depth?: number
      agent?: string
      parent?: string
    }
  | { type: 'ask_user'; key: string; questions: AskQuestion[] }
  | { type: 'plan_review'; key: string; plan: string }
  | { type: 'mount_request'; key: string; tool: string; path: string }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'reconnecting'; attempt: number; max: number }
  | { type: 'auto_retry'; reason: 'truncated' | 'empty' | 'context' | 'output_limit'; attempt: number; max: number }
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  | {
      type: 'compacted'
      scope: 'auto' | 'manual'
      status: 'compacted' | 'none' | 'failed'
      message?: string
    }
  | {
      type: 'interaction_resolved'
      key: string
      kind: 'ask' | 'plan' | 'mount'
      answers?: string[] | null
      decision?: 'approve' | 'keep' | null
      path?: string | null
    }
  | {
      type: 'card_resolved'
      card: 'agent' | 'autotask'
      toolUseId: string
      status: 'accepted' | 'rejected' | 'created' | 'dismissed'
      taskId?: string
    }
  | { type: 'done'; stopReason: string }

/**
 * 交互卡已在别处答复（手机端 / 本层自己的答复回执）：把同 key 的卡收成已决态。
 * 已是终态的卡原样返回（本层先行乐观落了态，或已收敛过），未命中的块保持引用不变。
 */
function resolveCard(
  blocks: ChatBlock[],
  ev: Extract<StreamEvent, { type: 'interaction_resolved' }>
): ChatBlock[] {
  return blocks.map((b) => {
    if (ev.kind === 'ask' && b.kind === 'ask' && b.key === ev.key && !b.answers)
      return { ...b, answers: ev.answers ?? [] }
    if (ev.kind === 'plan' && b.kind === 'plan' && b.key === ev.key && !b.decided)
      return { ...b, decided: ev.decision ?? ('cancelled' as const) }
    if (ev.kind === 'mount' && b.kind === 'mount' && b.key === ev.key && !b.decided)
      return { ...b, decided: ev.path ? ('mounted' as const) : ('skipped' as const), root: ev.path ?? undefined }
    return b
  })
}

/** 名片已在别处决议（手机端 / 本层自己的回执）：把同 id 的待决名片收成终态，已是终态的不动。 */
function resolveProposalCard(
  blocks: ChatBlock[],
  ev: Extract<StreamEvent, { type: 'card_resolved' }>
): ChatBlock[] {
  return blocks.map((b) => {
    if (b.kind === 'autotaskcard' && b.id === ev.toolUseId && b.status === 'pending')
      return ev.status === 'created' || ev.status === 'dismissed'
        ? { ...b, status: ev.status, taskId: ev.taskId }
        : b
    if (b.kind === 'agentcard' && b.id === ev.toolUseId && b.status === 'pending')
      return ev.status === 'accepted' || ev.status === 'rejected' ? { ...b, status: ev.status } : b
    return b
  })
}

interface ChatContextValue {
  sessions: SessionMeta[]
  currentSessionId: string
  messages: ChatMessage[]
  streaming: boolean
  /** 流式实时状态（底部工作指示器用；非 streaming 时为归零值）。 */
  streamStatus: StreamStatus
  /** 各会话的活动态（键=sessionId）：左侧列表据此显示「生成中 / 待处理」角标。 */
  sessionStates: Record<string, SessionLiveState>
  /** 返回是否真的发出；false（未选模型 / IPC 失败等，已 toast 提示）时调用方应把草稿放回输入框。 */
  send: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  stop: () => void
  /**
   * 新建空会话；对话优先外壳可传 personaId 绑定身份、focusRoot 预设聚焦、model 快照角色偏好模型
   * （旧壳零参调用行为不变）。model 在此刻定格（快照固定）：日后改角色偏好模型不影响本对话。
   */
  newSession: (personaId?: string, focusRoot?: string | null, model?: string) => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  /**
   * 批量删除对话（删除角色时一并清理其名下历史）。一次性中止各自在跑回合、逐条落盘删除、清绑定
   * 覆盖层，最后只刷新一次列表；若当前会话在其中，则切到最近一条或起新会话。空数组为无操作。
   */
  deleteSessions: (ids: string[]) => void
  /**
   * 按「轮」删除当前会话的部分对话（同步删除模型上下文）。turnIndices 为 0 基轮下标集合
   * （轮 = 一条真实用户消息起，直到下一条用户消息前的全部气泡；压缩摘要等前言不计入轮）。
   * 删除后以主进程重建的历史就地替换该会话消息，保证展示与落盘一致、重启不变。
   * 空集、或该会话正流式生成时为无操作（避免改写正被 Agent 循环原地改写的 messages）。
   */
  deleteTurns: (turnIndices: number[]) => Promise<void>
  /**
   * 检查点回滚当前会话：回到第 turn 轮开始之前（mode 见 RewindMode，force = 勾选覆盖的冲突文件）。
   * 成功后以主进程重建的历史就地替换消息。该会话正流式生成时直接回 busy，不发请求。
   */
  rewindApply: (turn: number, mode: RewindMode, force: string[]) => Promise<RewindApplyResult>
  /**
   * 撤销某会话的上次回滚（文件与对话一并换回）；缺省为当前会话。撤销入口在 toast 上、比面板活得久，
   * 期间用户可能已切走，故由调用方钉住回滚时的会话 id，免得撤到别的会话头上。
   */
  rewindUndo: (sessionId?: string) => Promise<RewindUndoResult>
  /** 当前对话的绑定（覆盖层优先于已落库真值）：驱动头像 / 工作区 chip / 模型选择器。 */
  currentBinding: { personaId?: string; focusRoot: string | null; model?: string }
  /**
   * 「草稿会话」：当前会话尚未落库（不在 sessions 里）但已绑定身份（有 personaId）时合成的一条会话元信息，
   * 供左侧列表即时呈现这条「空对话」——与角色开启新对话时立刻出现在聊天列表，内容可为空。
   * 首发落库后它进入 sessions、本值转为 null，列表项按同 id 无缝接管。无草稿时为 null。
   */
  draftSession: SessionMeta | null
  /** 挂载（path）/ 卸载（null）当前对话的聚焦工作区；path 须已受信（经 fs.openFolder）。 */
  mountFocus: (path: string | null) => void
  /**
   * 设置**当前对话**的模型引用 `"providerId:modelId"`（只改当前对话，不动全局默认）；空串 = 回落全局默认。
   * 覆盖层即时置位（驱动选择器显示），随下一次 send 落库到会话属性。见 bindings.model / SessionMeta.model。
   */
  setSessionModel: (modelRef: string) => void
  /** 回应 ask_user 询问（每题的选中项标签或自由输入），并把该问答卡就地收敛为已答态。 */
  respondAsk: (key: string, answers: string[]) => void
  /**
   * 回应 exit_plan 计划审阅（approve=批准并执行 / keep=继续完善），并把该计划卡就地收敛为已决态。
   * approve 后主进程循环继续、按计划执行；无渲染层临时态需清除。
   */
  respondPlan: (key: string, decision: 'approve' | 'keep') => void
  /**
   * 回应「请求挂载工作区」：path=用户已选目录（调用方须先经 fs.openFolder 受信）、null=暂不挂载。
   * 挂载成功时**同步更新本对话绑定覆盖层**（等价于 mountFocus）——否则下次 chat:send 会用旧覆盖层
   * 把主进程刚就地设好的 focusRoot 覆盖回去。就地把该卡收敛为终态。
   */
  respondMount: (key: string, path: string | null) => void
  /**
   * 落定角色名片终态（接受/拒绝）：就地把名片状态收敛为终态并持久化（防重开退回 pending / 重复建角色）。
   * 「接受」建角色的写入（personas:upsert）由编辑器直接发起，本方法只管名片状态与终态落库。
   */
  resolveProposal: (toolId: string, status: 'accepted' | 'rejected') => void
  /**
   * 落定定时任务确认名片：action='create' 携完整信封（TaskCreateInput，含日程 + 授权）创建任务与独占会话，
   * action='dismiss' 忽略。这是「创建时批准」的授权时刻——成功即持久化终态并就地收敛名片（created 带 taskId /
   * dismissed）；失败（日程非法 / 已过期等）不改名片状态，返回错误码供名片就地提示、用户改后重试。
   */
  resolveAutotask: (
    toolId: string,
    action: 'create' | 'dismiss',
    taskInput?: TaskCreateInput
  ) => Promise<ResolveAutotaskResult>
}

const ChatContext = createContext<ChatContextValue | null>(null)

/** 空闲态的流式状态（归零）。 */
/**
 * 状态横幅的恢复态：reason 缺省 / 'reconnect' = 断流重连；其余为引擎自愈（见主进程 auto_retry 事件）。
 */
export interface RecoveryStatus {
  attempt: number
  max: number
  reason?: 'reconnect' | 'truncated' | 'empty' | 'context' | 'output_limit'
}

const IDLE_STATUS: StreamStatus = { elapsedSec: 0, reconnecting: null }

let seq = 0
function genId(prefix = 'm'): string {
  seq = (seq + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

/** 主进程重建的展示消息 → 渲染层气泡。 */
function displayToMessages(dms: DisplayMessage[]): ChatMessage[] {
  return dms.map((dm) => {
    if (dm.role === 'user') {
      return {
        id: genId(),
        role: 'user',
        blocks: dm.text ? [{ kind: 'text', text: dm.text }] : [],
        attachments: dm.attachments.length ? dm.attachments : undefined
      }
    }
    const blocks: ChatBlock[] = dm.blocks.map((b) => {
      if (b.kind === 'text') return { kind: 'text', text: b.text }
      if (b.kind === 'notice') return { kind: 'notice', code: b.code }
      // 历史回填：请求失败红框（原样复原错误文案）。
      if (b.kind === 'error') return { kind: 'error', message: b.message }
      // 历史回填：角色名片按持久化终态复原（pending/accepted/rejected）。
      if (b.kind === 'agentcard')
        return { kind: 'agentcard', id: b.id, draft: b.draft, status: b.status }
      // 历史回填：定时任务确认名片按持久化终态复原（pending/created/dismissed；created 带 taskId）。
      if (b.kind === 'autotaskcard')
        return { kind: 'autotaskcard', id: b.id, draft: b.draft, status: b.status, taskId: b.taskId }
      // 历史回填：ask_user 问答卡。answers=null（取消）归一为空数组作已答态（逐题回落「未作答」）；
      // string[] 原样复原为已答态；undefined（罕见的挂起态）保留可交互（其 respondAsk 对已结束的轮为无操作）。
      // key 用 toolUseId：稳定唯一，供极少数交互态复用（已答卡不使用 key）。
      if (b.kind === 'ask')
        return { kind: 'ask', key: b.id, questions: b.questions, answers: b.answers === null ? [] : b.answers }
      // 历史回填：exit_plan 计划卡。主进程已把 decision 归一为终态（approve/keep/cancelled），此处原样
      // 复原为只读展示——历史里的计划卡必定属于已结束的回合，画出按钮只会是点不动的摆设。
      if (b.kind === 'plan') return { kind: 'plan', key: b.id, plan: b.plan, decided: b.decision }
      const status: ToolStatus = b.status === 'error' ? 'error' : 'ok'
      // 历史回填：run_subagent 复原为折叠 Task 卡（内部子调用不入父历史，故 children 为空、仅存结论）。
      if (b.name === 'run_subagent') {
        const a = (b.args ?? {}) as { agent?: unknown; prompt?: unknown; description?: unknown }
        return {
          kind: 'subagent',
          id: b.id,
          agent: typeof a.agent === 'string' ? a.agent : '',
          desc: typeof a.description === 'string' ? a.description.trim() || undefined : undefined,
          task: typeof a.prompt === 'string' ? a.prompt : undefined,
          status,
          summary: b.summary,
          children: []
        }
      }
      return { kind: 'tool', id: b.id, name: b.name, args: b.args, status, summary: b.summary }
    })
    return { id: genId(), role: 'assistant', blocks }
  })
}

/**
 * 找到某个嵌套事件（depth>0）应归入的子智能体 Task 卡下标。
 * 优先按 parent —— 派生它的那次 run_subagent 调用 id：一轮里的多个子任务是**并行**跑的，
 * 它们的嵌套事件交织到达，唯有按 id 精确归属才不会串卡。
 * 缺 parent（异常/旧事件）时退回「最早一张仍在运行的卡」，仅作兜底。
 */
function subagentIndex(blocks: ChatBlock[], parent?: string): number {
  if (parent) {
    const i = blocks.findIndex((b) => b.kind === 'subagent' && b.id === parent)
    if (i >= 0) return i
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'subagent' && b.status === 'running') return i
  }
  return -1
}

/** 归一化 propose_agent 原始参数为角色草稿（实时路径；与主进程 normalizeAgentDraft 对齐）。 */
function normalizeAgentDraft(input: unknown): AgentDraft {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    name: str(a.name).trim(),
    desc: str(a.description).trim(),
    model: '',
    prompt: str(a.prompt)
  }
}

/** 归一化 create_task 原始参数为定时任务草稿（实时路径；与主进程 normalizeAutotaskDraft 对齐）。 */
function normalizeAutotaskDraft(input: unknown): AutotaskDraft {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const sched = (a.schedule && typeof a.schedule === 'object' ? a.schedule : {}) as Record<
    string,
    unknown
  >
  const schedKind = sched.kind === 'once' ? 'once' : 'recurring'
  return {
    title: str(a.title).trim(),
    prompt: str(a.prompt),
    schedule: {
      kind: schedKind,
      at: str(sched.at).trim(),
      cron: str(sched.cron).trim(),
      tz: str(sched.tz).trim()
    }
  }
}

/** 把一个流事件并入助手消息的块序列（纯函数，返回新数组）。 */
function reduceBlocks(blocks: ChatBlock[], ev: StreamEvent): ChatBlock[] {
  const next = blocks.slice()
  const last = next[next.length - 1]
  switch (ev.type) {
    case 'text_delta':
      if (last?.kind === 'text') next[next.length - 1] = { ...last, text: last.text + ev.text }
      else next.push({ kind: 'text', text: ev.text })
      return next
    case 'thinking_delta':
      if (last?.kind === 'thinking') next[next.length - 1] = { ...last, text: last.text + ev.text }
      else next.push({ kind: 'thinking', text: ev.text })
      return next
    case 'tool_call': {
      // 子智能体内部调用（depth>0）→ 收纳进 parent 指向的那张 Task 卡，不占主对话流。
      if (ev.depth && ev.depth > 0) {
        const si = subagentIndex(next, ev.parent)
        if (si >= 0) {
          const card = next[si] as Extract<ChatBlock, { kind: 'subagent' }>
          next[si] = {
            ...card,
            children: [...card.children, { id: ev.id, name: ev.name, args: ev.args, status: 'running' }]
          }
          return next
        }
        // 兜底：无开着的卡（异常）→ 退化为普通工具卡，避免事件丢失。
        next.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, status: 'running' })
        return next
      }
      // propose_agent（depth 0）→ 铸一张角色名片（惰性提议，待用户确认）。
      if (ev.name === 'propose_agent') {
        next.push({
          kind: 'agentcard',
          id: ev.id,
          draft: normalizeAgentDraft(ev.args),
          status: 'pending'
        })
        return next
      }
      // create_task（depth 0）→ 铸一张定时任务确认名片（惰性提议，待用户议定授权后创建）。
      if (ev.name === 'create_task') {
        next.push({
          kind: 'autotaskcard',
          id: ev.id,
          draft: normalizeAutotaskDraft(ev.args),
          status: 'pending'
        })
        return next
      }
      // run_subagent 的壳调用（depth 0）→ 开一张折叠 Task 卡。
      if (ev.name === 'run_subagent') {
        const a = (ev.args ?? {}) as { agent?: unknown; prompt?: unknown; description?: unknown }
        next.push({
          kind: 'subagent',
          id: ev.id,
          agent: typeof a.agent === 'string' ? a.agent : ev.agent ?? '',
          desc: typeof a.description === 'string' ? a.description.trim() || undefined : undefined,
          task: typeof a.prompt === 'string' ? a.prompt : undefined,
          status: 'running',
          children: []
        })
        return next
      }
      next.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, status: 'running' })
      return next
    }
    case 'tool_result': {
      // 子智能体内部结果（depth>0）→ 更新 parent 那张 Task 卡内对应子项状态。
      if (ev.depth && ev.depth > 0) {
        const si = subagentIndex(next, ev.parent)
        if (si >= 0) {
          const card = next[si] as Extract<ChatBlock, { kind: 'subagent' }>
          const j = card.children.findIndex((c) => c.id === ev.id)
          if (j >= 0) {
            const child = card.children[j]
            const status: ToolStatus =
              child.status === 'denied' ? 'denied' : ev.isError ? 'error' : 'ok'
            const children = card.children.slice()
            children[j] = { ...child, status, summary: status === 'denied' ? child.summary : ev.summary }
            next[si] = { ...card, children }
          }
        }
        return next
      }
      // run_subagent 壳结果（depth 0）→ 定格 Task 卡状态与结论摘要。
      const si = next.findIndex((b) => b.kind === 'subagent' && b.id === ev.id)
      if (si >= 0) {
        const card = next[si] as Extract<ChatBlock, { kind: 'subagent' }>
        next[si] = { ...card, status: ev.isError ? 'error' : 'ok', summary: ev.summary }
        return next
      }
      const i = next.findIndex((b) => b.kind === 'tool' && b.id === ev.id)
      if (i >= 0) {
        const b = next[i] as Extract<ChatBlock, { kind: 'tool' }>
        // 已被本地标记为 denied 的保持 denied（用户拒绝早于主进程回执到达）
        const status: ToolStatus =
          b.status === 'denied' ? 'denied' : ev.isError ? 'error' : 'ok'
        next[i] = { ...b, status, summary: status === 'denied' ? b.summary : ev.summary }
      }
      return next
    }
    case 'ask_user':
      next.push({ kind: 'ask', key: ev.key, questions: ev.questions })
      return next
    case 'plan_review':
      next.push({ kind: 'plan', key: ev.key, plan: ev.plan })
      return next
    case 'mount_request':
      next.push({ kind: 'mount', key: ev.key, tool: ev.tool, path: ev.path })
      return next
    case 'error':
      next.push({ kind: 'error', message: ev.message })
      return next
    case 'compacted':
      // 只有「已压缩」进气泡（主进程落盘了摘要前言，重开同形）；none / failed 由事件订阅处改弹 toast。
      if (ev.status !== 'compacted') return blocks
      next.push({ kind: 'notice', code: 'compacted' })
      return next
    default:
      return blocks
  }
}

/**
 * 重连前丢弃「当前步骤」已画出的残缺尾部。
 * 一个回合里，前序步骤必以工具块收尾（有工具结果才会有下一步）；中途断流时残缺内容
 * 永远是最后一个工具块之后那段 thinking/text。故截到最后一个工具块为止即可，主进程
 * 会带着已提交历史重跑该步、把这段重新生成。无工具块则整条清空。
 */
function dropStepPartial(blocks: ChatBlock[]): ChatBlock[] {
  let lastTool = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    // 工具卡与子智能体 Task 卡都是「步骤边界」：其后才是本步残缺的 thinking/text 尾部。
    if (blocks[i].kind === 'tool' || blocks[i].kind === 'subagent') {
      lastTool = i
      break
    }
  }
  if (lastTool === blocks.length - 1) return blocks // 已在工具/Task 卡处收尾，无残缺
  return blocks.slice(0, lastTool + 1)
}

/** 本轮是否已有「可见回复」：正文/工具/子卡/问答/错误/提示任一即算；纯思考或全空不算。 */
function hasVisibleAnswer(blocks: ChatBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.kind === 'text' && b.text.trim() !== '') ||
      b.kind === 'tool' ||
      b.kind === 'subagent' ||
      b.kind === 'ask' ||
      b.kind === 'mount' ||
      b.kind === 'error' ||
      b.kind === 'notice'
  )
}

/**
 * 回合终止时按 stopReason 补一条「中断原因」提示（解决「不显示中断原因」）：
 * - max_tokens：回复达输出长度上限被截断——无论是否已有正文都提示，解释为何戛然而止；
 * - refusal：模型拒绝作答 / 被服务商内容策略拦截——有拒绝正文就不加提示（正文已自解释），
 *   通篇为空才补一条「被拒绝」。**绝不并入空回合**：那会把拒绝谎报成上下文问题，误导排查；
 * - 自然结束（end_turn/stop）却通篇无可见回复：本轮未产生回复（原因不确定，文案不臆断）；
 * - aborted（用户主动停止）：标一条「已中止」——中止前的半截内容会随历史保留，得看得出是被打断的；
 * - error（已另有红色错误块）不重复提示。
 * 与主进程 recordTurnNotice 同一套规则，故重开对话后所见一致。
 * 无需补提示时返回原数组引用（updateLastAssistant 据引用相等短路，不触发无谓重渲染）。
 */
function appendTerminalNotice(blocks: ChatBlock[], stopReason: string): ChatBlock[] {
  if (stopReason === 'aborted') return [...blocks, { kind: 'notice', code: 'aborted' }]
  if (stopReason === 'max_tokens') return [...blocks, { kind: 'notice', code: 'truncated' }]
  if (stopReason === 'refusal')
    return hasVisibleAnswer(blocks) ? blocks : [...blocks, { kind: 'notice', code: 'refused' }]
  if ((stopReason === 'end_turn' || stopReason === 'stop') && !hasVisibleAnswer(blocks))
    return [...blocks, { kind: 'notice', code: 'empty' }]
  return blocks
}

function updateLastAssistant(
  list: ChatMessage[],
  fn: (blocks: ChatBlock[]) => ChatBlock[]
): ChatMessage[] {
  if (list.length === 0) return list
  const last = list[list.length - 1]
  if (last.role !== 'assistant') return list
  const nextBlocks = fn(last.blocks)
  if (nextBlocks === last.blocks) return list
  const copy = list.slice()
  copy[copy.length - 1] = { ...last, blocks: nextBlocks }
  return copy
}

/** 末条是空助手位（如 /compact 预留的）则去掉；否则原样返回。 */
function dropEmptyAssistantTail(list: ChatMessage[]): ChatMessage[] {
  const last = list[list.length - 1]
  return last?.role === 'assistant' && last.blocks.length === 0 ? list.slice(0, -1) : list
}

/**
 * 回合终结（done）时收敛仍未决的交互卡：计划审阅 / 询问 / 挂载请求。
 * 这三张卡的按钮背后都是主进程里的一把待决键；回合一旦结束（正常收尾、出错，尤其是用户中断——
 * chat:abort 会把它们一律按「取消」解开），键已被删除，再点只会拿到 {ok:false}，可卡片看上去仍
 * 可点——这正是「点批准没有任何反应」的由来。故在此一并落终态，让 UI 与主进程的真实状态对齐。
 * 卡片可能落在非末条助手消息里（其后还有 tool_result 与收尾文本），故遍历全部助手消息。
 */
function settleOpenCards(list: ChatMessage[]): ChatMessage[] {
  let changed = false
  const next = list.map((m) => {
    if (m.role !== 'assistant') return m
    let touched = false
    const blocks = m.blocks.map((b) => {
      if (b.kind === 'plan' && !b.decided) {
        touched = true
        return { ...b, decided: 'cancelled' as const }
      }
      // 问答卡的终态是「已答」——空数组即逐题回落「未作答」，与主进程按取消回灌的语义一致。
      if (b.kind === 'ask' && !b.answers) {
        touched = true
        return { ...b, answers: [] }
      }
      if (b.kind === 'mount' && !b.decided) {
        touched = true
        return { ...b, decided: 'skipped' as const }
      }
      return b
    })
    if (!touched) return m
    changed = true
    return { ...m, blocks }
  })
  return changed ? next : list
}

/**
 * 单个会话的活动态（渲染层内存）。每个正在跑 / 正被查看的会话各持一份，按 sessionId 存进一张
 * Map——这样一个会话流式时，切到另一个会话仍能各看各的、各发各的，后台那轮继续把事件累进它自己这份。
 */
interface SessionRuntime {
  messages: ChatMessage[]
  streaming: boolean
  /** 本轮 turnId（stop / abort 用）；无进行中回合为 null。 */
  turnId: string | null
  /** 计时锚点：本轮开始时刻（供「已用秒数」）。 */
  startedAt: number
  /** 主进程 reconnecting 事件驱动的真实重连态（非猜测）；null=未在重连。 */
  reconnecting: RecoveryStatus | null
}

/** 空活动态（共享冻结常量作 patch 种子；任何真实变更都返回新对象，绝不原地改）。 */
const EMPTY_RUNTIME: SessionRuntime = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  streaming: false,
  turnId: null,
  startedAt: 0,
  reconnecting: null
})

/** 当前所视会话无活动态时对外暴露的空消息数组（稳定引用，避免每次渲染新建）。 */
const EMPTY_MESSAGES: ChatMessage[] = Object.freeze([]) as unknown as ChatMessage[]

/**
 * 该会话是否有「待用户处理」项（末条助手消息含未答问答 / 未决计划 / 未决挂载请求 /
 * 待确认的角色或定时任务名片）——供后台会话角标提示。
 */
function hasAttention(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  return last.blocks.some(
    (b) =>
      (b.kind === 'ask' && b.answers === undefined) ||
      (b.kind === 'plan' && !b.decided) ||
      (b.kind === 'mount' && !b.decided) ||
      ((b.kind === 'agentcard' || b.kind === 'autotaskcard') && b.status === 'pending')
  )
}

export function ChatProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { activeModel, providers } = useModels()
  const { activeProject } = useWorkspace()
  // 流事件订阅只挂载一次，经 ref 读当前语言的 t（切语言不必重订阅）。
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const [sessions, setSessions] = useState<SessionMeta[]>([])
  // 初始会话清单是否已载入完成。首次 listSessions resolve 后置 true 并恒保持；
  // 渲染层据此区分「加载中」与「确认无对话」，避免启动瞬间闪现空态。
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  // 各会话活动态（键=sessionId）。ref 供事件回调 / 命令同步读写（不受渲染闭包过期影响），state 驱动渲染。
  const [runtimes, setRuntimes] = useState<Map<string, SessionRuntime>>(() => new Map())
  // 会话绑定覆盖层（对话优先外壳）：persona / 聚焦工作区，在会话**首发落库前**只存渲染态，首发时随
  // chat:send 一并绑定；已落库会话的 mount/unmount 也先写此层，随下次 chat:send 更新到主进程。
  // 与 SessionMeta（已落库真值）叠加读出 currentBinding，覆盖层优先（承载尚未落库/刚变更的值）。
  const [bindings, setBindings] = useState<
    Map<string, { personaId?: string; focusRoot?: string | null; model?: string; createdAt?: number }>
  >(() => new Map())
  // 未读会话（键=sessionId）：不在查看时有回合完成即记入，切进该会话即清除。
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set())
  // 每秒自增以触发重渲染，刷新当前所视会话「已用秒数」（不绑定变量，仅需其副作用）。
  const [, setTick] = useState(0)

  const runtimesRef = useRef(runtimes)
  const sessionIdRef = useRef<string>('')
  const projectPathRef = useRef<string | null>(null)
  const bindingsRef = useRef(bindings)

  const setCurrent = (id: string): void => {
    sessionIdRef.current = id
    setCurrentSessionId(id)
    setUnread((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // 绑定覆盖层唯一写入口：读 ref → 合并 patch → 换新 Map 提交（ref 与 state 同步，事件回调可同步读最新值）。
  const setBinding = useCallback(
    (
      sid: string,
      patch: { personaId?: string; focusRoot?: string | null; model?: string; createdAt?: number }
    ): void => {
      const cur = bindingsRef.current.get(sid) ?? {}
      const map = new Map(bindingsRef.current)
      map.set(sid, { ...cur, ...patch })
      bindingsRef.current = map
      setBindings(map)
    },
    []
  )

  // 会话活动态的唯一写入口：读 ref → 产出新态 → 引用不变则短路（不触发重渲染）→ 否则换新 Map 提交。
  // ref 与 state 同步更新，保证事件回调里的后续读取拿到最新值。
  const patchRuntime = useCallback(
    (sid: string, fn: (r: SessionRuntime) => SessionRuntime): void => {
      const cur = runtimesRef.current.get(sid) ?? EMPTY_RUNTIME
      const next = fn(cur)
      if (next === cur) return
      const map = new Map(runtimesRef.current)
      map.set(sid, next)
      runtimesRef.current = map
      setRuntimes(map)
    },
    []
  )

  // 只改某会话消息序列的便捷 patch（复用 updateLastAssistant 的引用短路，无变更则不提交）。
  const patchMessages = useCallback(
    (sid: string, mutate: (blocks: ChatBlock[]) => ChatBlock[]): void => {
      patchRuntime(sid, (r) => {
        const messages = updateLastAssistant(r.messages, mutate)
        return messages === r.messages ? r : { ...r, messages }
      })
    },
    [patchRuntime]
  )

  // 就地收敛「任意助手消息」里的名片终态——不限末条助手消息。
  // 缘由：create_task / propose_agent 是惰性名片，工具即刻回 tool_result、Agent 循环继续，模型常追加收尾
  // 文本；重开后 toDisplayMessages 按真实消息边界重建，名片落在**非末条**助手消息里（其后还有 tool_result
  // 用户消息 / 收尾文本助手消息）。此时 updateLastAssistant 只改末条 → 名片永远匹配不到、UI 不收敛（而主进程
  // 边车已落终态），表现为「忽略无效 / 创建成功但名片仍在」。故名片决议须遍历所有助手消息。
  // 按块引用逐一比对：仅真正含目标块的那条消息换新对象，其余保持原引用（避免整列无谓重渲染）。
  const patchCardBlocks = useCallback(
    (sid: string, mutate: (blocks: ChatBlock[]) => ChatBlock[]): void => {
      patchRuntime(sid, (r) => {
        let changed = false
        const messages = r.messages.map((m) => {
          if (m.role !== 'assistant') return m
          const nextBlocks = mutate(m.blocks)
          const same =
            nextBlocks.length === m.blocks.length &&
            nextBlocks.every((b, i) => b === m.blocks[i])
          if (same) return m
          changed = true
          return { ...m, blocks: nextBlocks }
        })
        return changed ? { ...r, messages } : r
      })
    },
    [patchRuntime]
  )

  const dropRuntime = useCallback((sid: string): void => {
    if (!runtimesRef.current.has(sid)) return
    const map = new Map(runtimesRef.current)
    map.delete(sid)
    runtimesRef.current = map
    setRuntimes(map)
  }, [])

  // 拉取当前项目会话清单（左侧只列真实已落盘的会话）。
  const refreshSessions = useCallback(async (): Promise<void> => {
    const path = projectPathRef.current
    const list = await window.deva.chat.listSessions(path)
    if (projectPathRef.current !== path) return // 项目已切换，丢弃过期结果
    setSessions(list)
  }, [])

  // 起一个全新的空会话：切换当前会话（新 id 无活动态 → 视图自然空）。
  // 对话优先外壳可传 personaId（绑定身份）/ focusRoot（聚焦工作区）/ model（**快照**角色偏好模型）→ 存进
  // 覆盖层。model 在此刻定格：日后改角色偏好模型不影响本对话（快照固定）。
  //
  // 落盘时机分两路：
  //  · 绑定身份（传了 personaId）—— 对话优先外壳「与角色开启新对话」：**立即** createSession 落盘 + 刷新
  //    左侧，空对话就此成为真实持久化会话（重启仍在）；覆盖层 + draftSession 仅作落盘完成前的即时占位，
  //    refreshSessions 后同 id 真值并入 sessions、draftSession 转 null，无缝接管。
  //  · 零参调用（旧 AppShell 的 newSession()、启动/删空后的兜底）—— 仍走**惰性**建档：不落盘、不进左侧，
  //    待用户首次 chat:send 时主进程再建档。故删空左侧后不会被自动重建一条空会话（右侧转「快速开启」空态）。
  const startFresh = useCallback(
    (personaId?: string, focusRoot?: string | null, model?: string): void => {
      const id = genId('sess')
      if (personaId !== undefined || focusRoot !== undefined || model !== undefined) {
        const map = new Map(bindingsRef.current)
        // createdAt 定格新建时刻：驱动草稿会话在左侧列表的相对时间与排序（落盘完成前即以「空对话」呈现）。
        map.set(id, { personaId, focusRoot, model, createdAt: Date.now() })
        bindingsRef.current = map
        setBindings(map)
      }
      setCurrent(id)
      // 绑定身份 → 立即落盘并刷新左侧（空对话跨重启存活）。
      if (personaId !== undefined) {
        void (async () => {
          await window.deva.chat.createSession({
            sessionId: id,
            workspaceRoot: projectPathRef.current,
            personaId,
            focusRoot: focusRoot ?? null,
            modelRef: model
          })
          await refreshSessions()
        })()
      }
    },
    [refreshSessions]
  )

  // 切项目：重载会话清单 + 载入最近一条到其活动态（无则起新会话）。
  // 已有活动态（如后台正在流式的会话）不重载，避免冲掉实时累积的内容。
  useEffect(() => {
    const path = activeProject?.path ?? null
    projectPathRef.current = path
    let cancelled = false
    void (async () => {
      const list = await window.deva.chat.listSessions(path)
      if (cancelled || projectPathRef.current !== path) return
      setSessions(list)
      if (list.length) {
        const id = list[0].id
        setCurrent(id)
        if (!runtimesRef.current.has(id)) {
          const dms = await window.deva.chat.loadSession(id, path)
          if (cancelled || sessionIdRef.current !== id || runtimesRef.current.has(id)) return
          patchRuntime(id, (r) => ({ ...r, messages: displayToMessages(dms as DisplayMessage[]) }))
        }
      } else {
        startFresh()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProject?.path, startFresh, patchRuntime])

  // 订阅主进程流事件（挂载一次）。按 payload.sessionId 路由进对应会话的活动态——
  // 不再丢弃「非当前会话」事件：后台那轮照常累积，切回去即见其实时流。
  useEffect(() => {
    // 本回合内压缩成功过的会话（done 时消费）。
    const compactedSids = new Set<string>()
    // 本回合 /compact 无需压缩或压缩失败的会话（done 时消费：结果已走 toast，撤掉为它预留的空助手位）。
    const compactDropSids = new Set<string>()
    // 从主进程重载某会话并整份替换其 runtime 消息（后台回合完成 / 本轮压缩过后的权威回填）。
    const reloadIntoRuntime = (sid: string): void => {
      void (async () => {
        const dms = await window.deva.chat.loadSession(sid, projectPathRef.current)
        // 期间本层又起了新一轮（已建脚手架）→ 绝不覆盖其实时内容。
        if (runtimesRef.current.get(sid)?.streaming) return
        // 期间切走 → 丢掉陈旧 runtime（selectSession 不重载已缓存的 runtime），下次打开自会从主进程重载。
        if (sessionIdRef.current !== sid) {
          dropRuntime(sid)
          return
        }
        patchRuntime(sid, (r) => ({
          ...r,
          streaming: false,
          turnId: null,
          reconnecting: null,
          messages: displayToMessages(dms as DisplayMessage[])
        }))
      })()
    }

    const unsub = window.deva.chat.onEvent((payload) => {
      const sid = payload.sessionId
      const ev = payload.event as StreamEvent

      // 本渲染层是否正为该会话流式一轮 = 经 send/compact 建过「用户气泡 + 空助手位」脚手架。
      // 只有这样的会话才能把流事件正确拼进气泡。否则是**后台回合**（典型：调度器触发的定时任务在
      // 主进程内闭环执行），本层从未建脚手架 —— 其内容以主进程 + 磁盘为唯一真源，绝不在此凑合拼装。
      const localStreaming = runtimesRef.current.get(sid)?.streaming === true

      // 名片决议不属于回合（名片在回合结束后仍可操作）：只要本层缓存着该会话就就地收敛；
      // 没缓存的不必管——下次打开从磁盘重载，边车里已是终态。
      if (ev.type === 'card_resolved') {
        if (runtimesRef.current.has(sid)) patchCardBlocks(sid, (blocks) => resolveProposalCard(blocks, ev))
        return
      }

      // 本回合压缩成功（自动或 /compact）：主进程历史已改写为「摘要 + 近期轮」，本层气泡却仍是全量，
      // 两边的轮下标因此错开被压掉的轮数，回滚 / 删轮会落到错的轮上。先记下，done 时以主进程为准重载。
      if (ev.type === 'compacted' && ev.status === 'compacted') compactedSids.add(sid)

      // 无可压（只有手动会发 none）/ 压缩失败（自动或手动）：弹 toast 知会，不进对话流——这两条
      // 主进程都不落盘，做成气泡重启即消失，前后不一致；且历史都没动，不值得占一轮对话位。
      // 失败原因原文作 toast 正文：成因差别极大（密钥失效、连接中断、模型没吐正文），只说「失败」无从下手。
      if (ev.type === 'compacted' && ev.status !== 'compacted') {
        if (!localStreaming) return
        if (ev.scope === 'manual') compactDropSids.add(sid)
        if (ev.status === 'none')
          toast.show({ variant: 'warning', message: tRef.current('chat.notice.compactNone') })
        else
          toast.show({
            variant: 'error',
            title: tRef.current('chat.notice.compactFailed'),
            message: ev.message || undefined,
            duration: ev.message ? 8000 : undefined
          })
        return
      }

      if (ev.type === 'done') {
        const compacted = compactedSids.delete(sid)
        const compactDrop = compactDropSids.delete(sid)
        // 不在查看的会话完成了一轮（本层发起后切走的 / 定时任务等后台回合）→ 记未读。
        // compactDrop（/compact 无可压或失败）没有新内容，不算。
        if (sessionIdRef.current !== sid && !compactDrop)
          setUnread((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)))
        if (localStreaming) {
          patchRuntime(sid, (r) => ({
            ...r,
            streaming: false,
            turnId: null,
            reconnecting: null,
            // /compact 无需压缩 / 失败：撤掉预留的空助手位（结果已 toast，不补空回合提示）。否则先收敛仍未决的
            // 交互卡（用户中断时最常见），再据终止原因补「中断说明」：截断/空回合给出可见提示，正常回合原样短路。
            messages: compactDrop
              ? dropEmptyAssistantTail(r.messages)
              : updateLastAssistant(settleOpenCards(r.messages), (b) =>
                  appendTerminalNotice(b, ev.stopReason)
                )
          }))
          // 与重开同形：早期气泡当场收成一个摘要气泡。主进程在发 done 后同步补记终态提示并落盘，
          // 早于本层 loadSession 请求到达，故重载拿到的已含本轮 notices。
          if (compacted) reloadIntoRuntime(sid)
        } else {
          // 后台回合完成：主进程已落盘。绝不留下 messages:[] 的空壳 runtime 遮蔽已落盘内容
          //（此前正是它令定时任务生成的对话「打开是空的、重启才出现」）。正在查看 → 立刻从主进程
          // 重载回填；未查看 → 丢弃任何陈旧/空 runtime，下次 selectSession 自会从主进程重载。
          if (sessionIdRef.current === sid) reloadIntoRuntime(sid)
          else dropRuntime(sid)
        }
        void refreshSessions() // 标题/排序可能已更新
        return
      }

      // 后台回合的中途事件一律忽略：本层无脚手架可拼（强拼只会污染陈旧 runtime 或凭空造出空壳），
      // 内容以主进程为准、done 时统一重载。仅本层正流式的会话才继续处理下列实时事件。
      if (!localStreaming) return

      // 主进程真实信号：断流后正在自动重连（展示"连接中断，正在重连"横幅）。
      if (ev.type === 'reconnecting') {
        patchRuntime(sid, (r) => ({ ...r, reconnecting: { attempt: ev.attempt, max: ev.max } }))
        return
      }
      // 引擎自愈（截断续写 / 空回合追问 / 压缩重试）：同一条状态横幅，文案按 reason 区分。
      if (ev.type === 'auto_retry') {
        patchRuntime(sid, (r) => ({
          ...r,
          reconnecting: { attempt: ev.attempt, max: ev.max, reason: ev.reason }
        }))
        return
      }
      // 重连即将重跑当前步骤：丢弃这一步已画出的残缺尾部，避免重复内容。
      if (ev.type === 'stream_reset') {
        patchMessages(sid, dropStepPartial)
        return
      }
      if (ev.type === 'usage') return
      // 交互卡在手机端被答复：卡可能不在末条助手消息里，按 key 全量查找收敛。
      if (ev.type === 'interaction_resolved') {
        patchCardBlocks(sid, (blocks) => resolveCard(blocks, ev))
        return
      }
      // 内容事件：并入消息；若正处于重连横幅则收起（任何真实内容到达即视为"已恢复"）。
      patchRuntime(sid, (r) => {
        const messages = updateLastAssistant(r.messages, (blocks) => reduceBlocks(blocks, ev))
        if (messages === r.messages && r.reconnecting === null) return r
        return { ...r, messages, reconnecting: null }
      })
    })
    return unsub
  }, [refreshSessions, patchRuntime, patchMessages, patchCardBlocks, dropRuntime, toast])

  const viewed = runtimes.get(currentSessionId)
  const viewedStreaming = viewed?.streaming ?? false

  // 流式计时器：仅当前所视会话流式时每秒触发重渲染刷新「已用秒数」（后台会话的秒数无人看，不必计）。
  useEffect(() => {
    if (!viewedStreaming) return
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000)
    return () => window.clearInterval(id)
  }, [viewedStreaming, currentSessionId])

  // 对外暴露「当前所视会话」的那一份活动态（messages/streaming/streamStatus）。
  const messages = viewed?.messages ?? EMPTY_MESSAGES
  const streaming = viewedStreaming
  // streamStatus 在渲染作用域即时算（每次渲染读新的 Date.now()）：流式期间 setTick 每秒触发渲染 → 秒数走动。
  const streamStatus: StreamStatus =
    viewed && viewed.streaming
      ? {
          elapsedSec: Math.max(0, Math.floor((Date.now() - viewed.startedAt) / 1000)),
          reconnecting: viewed.reconnecting
        }
      : IDLE_STATUS

  // 各会话活动态摘要（左侧列表角标用）；仅 runtimes / 未读集变化时重算。
  // 后台回合完成后 runtime 会被丢弃，故未读会话可能没有 runtime，单独补一条。
  const sessionStates = useMemo<Record<string, SessionLiveState>>(() => {
    const out: Record<string, SessionLiveState> = {}
    for (const [id, r] of runtimes)
      out[id] = { streaming: r.streaming, attention: hasAttention(r.messages), unread: unread.has(id) }
    for (const id of unread)
      if (!out[id]) out[id] = { streaming: false, attention: false, unread: true }
    return out
  }, [runtimes, unread])

  // 当前对话的绑定读出（覆盖层优先于已落库 SessionMeta）：驱动对话优先外壳的头像 / 工作区 chip。
  // 覆盖层承载「尚未落库」（新会话首发前）或「刚 mount/unmount」的值；落库真值来自 listSessions。
  const currentBinding = useMemo<{ personaId?: string; focusRoot: string | null; model?: string }>(
    () => {
      const meta = sessions.find((s) => s.id === currentSessionId)
      const ov = bindings.get(currentSessionId)
      const personaId = ov?.personaId ?? meta?.personaId
      const focusRoot =
        ov && ov.focusRoot !== undefined ? ov.focusRoot : (meta?.focusRoot ?? null)
      // model：覆盖层优先（尚未落库的快照/刚切换）；否则落库真值。均缺省 = undefined（跟随全局默认）。
      const model = ov && ov.model !== undefined ? ov.model : meta?.model
      return { personaId, focusRoot: focusRoot ?? null, model }
    },
    [currentSessionId, sessions, bindings]
  )

  // 草稿会话：当前会话尚未落库（不在 sessions 里）但已绑定身份（有 personaId）→ 合成一条会话元信息，
  // 让左侧聊天列表在首发前就显示这条「空对话」。首发后主进程惰性建档、refreshSessions 把同 id 的真值并入
  // sessions，本值随之转 null，列表项按 id 无缝接管（草稿标题「未命名」→ 真实标题）。
  const draftSession = useMemo<SessionMeta | null>(() => {
    const id = currentSessionId
    if (!id) return null
    if (sessions.some((s) => s.id === id)) return null // 已落库，无需草稿
    const ov = bindings.get(id)
    if (!ov?.personaId) return null // 无绑定身份 → 不作草稿展示（如启动初未绑定的裸空会话）
    const ts = ov.createdAt ?? Date.now()
    return {
      id,
      title: '',
      createdAt: ts,
      updatedAt: ts,
      personaId: ov.personaId,
      focusRoot: ov.focusRoot ?? null,
      model: ov.model
    }
  }, [currentSessionId, sessions, bindings])

  const value = useMemo<ChatContextValue>(() => {
    // 返回是否真的发出：false = 未发出（空输入 / 本会话正忙 / 未选模型 / IPC 失败），调用方据此把草稿放回。
    // 未发出的原因一律走 toast、不进对话流——这些提示主进程不落盘，做成气泡重启即消失，前后不一致。
    const send = async (text: string, attachments?: SendAttachment[]): Promise<boolean> => {
      const sid = sessionIdRef.current
      const body = text.trim()
      const atts = attachments ?? []
      // 只挡「本会话」正在进行的回合——别的会话流式与否，都不影响此处发送（多对话并行的关键）。
      if ((!body && atts.length === 0) || runtimesRef.current.get(sid)?.streaming) return false

      // 生效模型：优先「本对话已选」——绑定覆盖层的 model（刚在对话里切换、尚未落库）或已落库会话属性的
      // model，均为引用 `"pid:mid"`；解析不到（未选 / 已删除）再回落全局默认 activeModel。
      // 修复：此前只认全局默认（activeModel），用户在对话里选过模型但从未在「设置 › 模型」设默认时，
      // activeModel 为空即误报「尚未选择模型」。现按会话生效模型判定，与顶部模型选择器显示保持一致。
      const ov = bindingsRef.current.get(sid)
      const meta = sessions.find((s) => s.id === sid)
      const sessionModelRef = ov && ov.model !== undefined ? ov.model : meta?.model
      const model = findActive(providers, sessionModelRef ?? null) ?? activeModel

      // 未选模型：只弹 toast，对话流不动（不加用户气泡、不留红框）。
      const noModel = (): false => {
        toast.show({ variant: 'warning', message: t('chat.noModel'), duration: 6000 })
        return false
      }
      const sendFailed = (msg: string): false => {
        toast.show({ variant: 'error', title: t('chat.error'), message: msg, duration: 8000 })
        return false
      }

      // 手动 /compact：不加用户气泡（该指令不该留在历史里），只挂一个助手提示位，
      // 直接请主进程压缩历史；压缩成功经 compacted 事件回到该助手气泡，
      // none / failed 则改弹 toast 并撤掉这个助手位。
      if (body.toLowerCase() === '/compact' && atts.length === 0) {
        if (!model) return noModel()
        patchRuntime(sid, (r) => ({
          ...r,
          messages: [...r.messages, { id: genId(), role: 'assistant', blocks: [] }],
          streaming: true,
          turnId: null,
          startedAt: Date.now(),
          reconnecting: null
        }))
        try {
          const { turnId } = await window.deva.chat.compact({
            sessionId: sid,
            model: {
              // 对话模型（选择器已按 purpose 过滤），adapter 必属 LLM 三协议之一。
              adapter: model.provider.adapter as 'anthropic' | 'openai' | 'responses',
              providerId: model.provider.id,
              baseURL: model.provider.apiHost,
              model: model.model.id
            },
            workspaceRoot: projectPathRef.current
          })
          patchRuntime(sid, (r) => ({ ...r, turnId }))
          void refreshSessions()
          return true
        } catch (e) {
          // 请求没发出去：撤掉预留的空助手位，原因走 toast。
          patchRuntime(sid, (r) => ({
            ...r,
            streaming: false,
            turnId: null,
            messages: dropEmptyAssistantTail(r.messages)
          }))
          return sendFailed((e as Error)?.message ?? String(e))
        }
      }

      const blocks: ChatBlock[] = body ? [{ kind: 'text', text: body }] : []
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        blocks,
        attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind })) : undefined
      }

      if (!model) return noModel()

      // 乐观追加用户气泡 + 空助手位，并置本会话为流式（计时锚点随置流写入，避免首帧秒数为负）。
      const placeholderId = genId()
      patchRuntime(sid, (r) => ({
        ...r,
        messages: [...r.messages, userMsg, { id: placeholderId, role: 'assistant', blocks: [] }],
        streaming: true,
        turnId: null,
        startedAt: Date.now(),
        reconnecting: null
      }))
      // 绑定覆盖层：首发时把 persona / 聚焦工作区带上（主进程 ensureSession：personaId 一次性绑定、
      // focusRoot 可挂/卸更新）。旧壳无覆盖层 → 二者 undefined → 主进程走兼容分支，逐字节不变。
      const binding = bindingsRef.current.get(sid)
      try {
        const { turnId } = await window.deva.chat.send({
          sessionId: sid,
          text: body,
          model: {
            // 对话模型（选择器已按 purpose 过滤），adapter 必属 LLM 三协议之一。
            adapter: model.provider.adapter as 'anthropic' | 'openai' | 'responses',
            providerId: model.provider.id,
            baseURL: model.provider.apiHost,
            model: model.model.id
          },
          workspaceRoot: projectPathRef.current,
          attachments: atts.length ? atts.map((a) => a.path) : undefined,
          personaId: binding?.personaId,
          focusRoot: binding?.focusRoot,
          // 本对话模型：恒记下这一轮实际使用的模型（上面解析出的生效模型）。发过消息的对话从此都有自己的
          // 模型，不再隐式跟随全局「最近使用」——否则在别的对话里切换模型会连带改掉它。未发过消息的空对话
          // 仍跟随最近使用（即新对话默认）。所选模型已被删除时这里记下的是回落后的实际模型。
          modelRef: `${model.provider.id}:${model.model.id}`
        })
        patchRuntime(sid, (r) => ({ ...r, turnId }))
        // 主进程发送时已惰性建档并落盘：立即刷新左侧，让新会话即时出现并高亮
        void refreshSessions()
        return true
      } catch (e) {
        // 请求没发出去（主进程未收下这轮、也就没落盘）：撤回乐观追加的用户气泡与空助手位，
        // 原因走 toast，草稿由调用方放回输入框——否则气泡只活到重启，与磁盘不一致。
        patchRuntime(sid, (r) => ({
          ...r,
          streaming: false,
          turnId: null,
          messages: r.messages.filter((m) => m.id !== userMsg.id && m.id !== placeholderId)
        }))
        return sendFailed((e as Error)?.message ?? String(e))
      }
    }

    const stop = (): void => {
      const turnId = runtimesRef.current.get(sessionIdRef.current)?.turnId
      if (turnId) void window.deva.chat.abort(turnId)
    }

    // 新建 / 切换 / 删除随时可用——即使别的会话正在流式（这正是多对话并行的关键）。
    // 对话优先外壳可传 personaId 绑定身份、focusRoot 预设聚焦、model 快照角色偏好模型；旧壳零参调用行为不变。
    const newSession = (personaId?: string, focusRoot?: string | null, model?: string): void => {
      startFresh(personaId, focusRoot, model)
    }

    // 挂载 / 卸载当前对话的聚焦工作区（path 应已由调用方经 fs.openFolder 受信；null = 卸载回全机通用助手）：
    // 覆盖层即时置位驱动界面，同时立即落库——否则首条消息若从飞书等远程通道发出，主进程读不到这次挂载。
    // 尚未建档的惰性会话由主进程跳过，仍随首发 chat:send 经 ensureSession 落库。
    const mountFocus = (path: string | null): void => {
      const sid = sessionIdRef.current
      setBinding(sid, { focusRoot: path })
      void (async () => {
        await window.deva.chat.setFocus({ sessionId: sid, focusRoot: path })
        await refreshSessions()
      })()
    }

    // 设置当前对话模型（只改当前对话）：覆盖层即时置位驱动选择器，同时立即落库到会话属性——不等下一次
    // 发送，否则切了没发、重启即回到旧模型。尚未建档的惰性会话由主进程跳过，仍随首发的 modelRef 落库。
    // 不触碰全局 activeModel（那是未选过模型的对话的兜底默认）。
    const setSessionModel = (modelRef: string): void => {
      const sid = sessionIdRef.current
      setBinding(sid, { model: modelRef })
      void (async () => {
        await window.deva.chat.setModel({ sessionId: sid, modelRef })
        await refreshSessions()
      })()
    }

    const selectSession = (id: string): void => {
      if (id === sessionIdRef.current) return
      setCurrent(id)
      // 已有活动态（正在流式或此前已载入）→ 直接呈现，绝不重载冲掉实时内容。
      if (runtimesRef.current.has(id)) return
      void (async () => {
        const dms = await window.deva.chat.loadSession(id, projectPathRef.current)
        // 载入期间可能已切走 / 已有活动态生成 → 丢弃过期结果。
        if (sessionIdRef.current !== id || runtimesRef.current.has(id)) return
        patchRuntime(id, (r) => ({ ...r, messages: displayToMessages(dms as DisplayMessage[]) }))
      })()
    }

    const deleteSession = (id: string): void => {
      // 删除正在跑的会话：先中止其回合，再落盘删除并移除其活动态。
      const turnId = runtimesRef.current.get(id)?.turnId
      if (turnId) void window.deva.chat.abort(turnId)
      void (async () => {
        await window.deva.chat.deleteSession(id, projectPathRef.current)
        dropRuntime(id)
        // 一并清掉该会话的绑定覆盖层（若有），避免残留。
        if (bindingsRef.current.has(id)) {
          const map = new Map(bindingsRef.current)
          map.delete(id)
          bindingsRef.current = map
          setBindings(map)
        }
        const path = projectPathRef.current
        const list = await window.deva.chat.listSessions(path)
        if (projectPathRef.current !== path) return
        setSessions(list)
        if (id !== sessionIdRef.current) return
        // 删的是当前会话：切到最近一条（载入其历史）或起新会话。
        if (list.length) {
          const nid = list[0].id
          setCurrent(nid)
          if (runtimesRef.current.has(nid)) return
          const dms = await window.deva.chat.loadSession(nid, path)
          if (sessionIdRef.current !== nid || runtimesRef.current.has(nid)) return
          patchRuntime(nid, (r) => ({ ...r, messages: displayToMessages(dms as DisplayMessage[]) }))
        } else {
          startFresh()
        }
      })()
    }

    // 批量删除（删角色时清其名下全部对话）：中止各自在跑回合 → 逐条落盘删除 → 清绑定覆盖层 →
    // 只刷新一次列表；当前会话若在删除集内，切到最近一条或起新会话。与单条 deleteSession 同语义，
    // 但合并刷新、避免 N 条并发各自 listSessions/切换互相打架。
    const deleteSessions = (ids: string[]): void => {
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (const id of ids) {
        const turnId = runtimesRef.current.get(id)?.turnId
        if (turnId) void window.deva.chat.abort(turnId)
      }
      void (async () => {
        const path = projectPathRef.current
        for (const id of ids) {
          await window.deva.chat.deleteSession(id, path)
          dropRuntime(id)
        }
        // 一并清掉这些会话的绑定覆盖层（若有）。
        if (ids.some((id) => bindingsRef.current.has(id))) {
          const map = new Map(bindingsRef.current)
          for (const id of ids) map.delete(id)
          bindingsRef.current = map
          setBindings(map)
        }
        if (projectPathRef.current !== path) return
        const list = await window.deva.chat.listSessions(path)
        if (projectPathRef.current !== path) return
        setSessions(list)
        if (!idSet.has(sessionIdRef.current)) return
        // 删的集合含当前会话：切到最近一条（载入其历史）或起新会话。
        if (list.length) {
          const nid = list[0].id
          setCurrent(nid)
          if (runtimesRef.current.has(nid)) return
          const dms = await window.deva.chat.loadSession(nid, path)
          if (sessionIdRef.current !== nid || runtimesRef.current.has(nid)) return
          patchRuntime(nid, (r) => ({ ...r, messages: displayToMessages(dms as DisplayMessage[]) }))
        } else {
          startFresh()
        }
      })()
    }

    // 按「轮」删除当前会话的部分对话（同步删上下文）。主进程重写 messages 并重建展示气泡，此处就地替换。
    // 流式中不删（该会话正被 Agent 循环原地改写 messages）；删的必是当前会话（选择态只在当前对话内）。
    const deleteTurns = async (turnIndices: number[]): Promise<void> => {
      if (turnIndices.length === 0) return
      const id = sessionIdRef.current
      if (runtimesRef.current.get(id)?.turnId) return
      const path = projectPathRef.current
      const dms = await window.deva.chat.deleteTurns(id, path, turnIndices)
      if (sessionIdRef.current !== id) return
      patchRuntime(id, (r) => ({ ...r, messages: displayToMessages(dms as DisplayMessage[]) }))
      // updatedAt 变了 → 刷新左侧列表使排序即时更新（标题不重算，保持稳定）。
      const list = await window.deva.chat.listSessions(path)
      if (projectPathRef.current !== path) return
      setSessions(list)
    }

    // 检查点回滚 / 撤销：与 deleteTurns 同形——主进程改写历史并重建展示气泡，此处就地替换并刷新列表排序。
    // 已切走但仍有活动态缓存的会话也要替换：selectSession 见缓存即直接呈现、不重载，不换就会显示旧历史。
    const applyRewound = async (id: string, dms: DisplayMessage[]): Promise<void> => {
      if (sessionIdRef.current === id || runtimesRef.current.has(id))
        patchRuntime(id, (r) => ({ ...r, messages: displayToMessages(dms) }))
      const path = projectPathRef.current
      const list = await window.deva.chat.listSessions(path)
      if (projectPathRef.current !== path) return
      setSessions(list)
    }

    const rewindApply = async (
      turn: number,
      mode: RewindMode,
      force: string[]
    ): Promise<RewindApplyResult> => {
      const id = sessionIdRef.current
      if (runtimesRef.current.get(id)?.turnId) return { ok: false, error: 'busy' }
      const res = await window.deva.chat.rewindApply({ sessionId: id, turn, mode, force })
      if (res.ok) await applyRewound(id, res.messages as DisplayMessage[])
      return res
    }

    const rewindUndo = async (sessionId?: string): Promise<RewindUndoResult> => {
      const id = sessionId ?? sessionIdRef.current
      if (runtimesRef.current.get(id)?.turnId) return { ok: false, error: 'busy' }
      const res = await window.deva.chat.rewindUndo(id)
      if (res.ok) await applyRewound(id, res.messages as DisplayMessage[])
      return res
    }

    const respondAsk = (key: string, answers: string[]): void => {
      void window.deva.chat.respondAsk({ key, answers })
      patchCardBlocks(sessionIdRef.current, (blocks) =>
        blocks.map((b) => (b.kind === 'ask' && b.key === key ? { ...b, answers } : b))
      )
    }

    const respondPlan = (key: string, decision: 'approve' | 'keep'): void => {
      const sid = sessionIdRef.current
      // 计划卡属当前所视会话 → 就地收敛为已决态。
      patchCardBlocks(sid, (blocks) =>
        blocks.map((b) => (b.kind === 'plan' && b.key === key ? { ...b, decided: decision } : b))
      )
      // 主进程回 {ok:false} = 这把待决键已经没人接了（回合早已结束）→ 把卡片改记为「已取消」，
      // 而不是留一个看起来生效、实则什么都没发生的「已批准」。
      void (async () => {
        const r = await window.deva.chat.respondPlan({ key, decision })
        if (r?.ok) return
        patchCardBlocks(sid, (blocks) =>
          blocks.map((b) =>
            b.kind === 'plan' && b.key === key ? { ...b, decided: 'cancelled' as const } : b
          )
        )
      })()
    }

    const respondMount = (key: string, path: string | null): void => {
      void window.deva.chat.respondMount({ key, path })
      // 主进程已就地把 session.focusRoot 设为该目录；渲染层覆盖层必须同步，否则下次 send 会覆盖回去。
      if (path) setBinding(sessionIdRef.current, { focusRoot: path })
      patchCardBlocks(sessionIdRef.current, (blocks) =>
        blocks.map((b) =>
          b.kind === 'mount' && b.key === key
            ? { ...b, decided: path ? 'mounted' : 'skipped', root: path ?? undefined }
            : b
        )
      )
    }

    const resolveProposal = (toolId: string, status: 'accepted' | 'rejected'): void => {
      const sid = sessionIdRef.current
      // 就地把名片收敛为终态（名片属当前所视会话；惰性名片重开后不在末条助手消息里，故遍历全部）。
      patchCardBlocks(sid, (blocks) =>
        blocks.map((b) => (b.kind === 'agentcard' && b.id === toolId ? { ...b, status } : b))
      )
      // 持久化终态边车：重开不退回 pending，接受态不会被再次接受成重复角色。
      void window.deva.chat.resolveProposal(sid, toolId, status)
    }

    const resolveAutotask = async (
      toolId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ): Promise<ResolveAutotaskResult> => {
      const sid = sessionIdRef.current
      const res = await window.deva.chat.resolveAutotask(sid, toolId, action, taskInput)
      // 仅成功才收敛终态（名片属当前所视会话）：created 带 taskId 供跳转、dismissed 只读。
      // 失败（invalid-cron / expired 等）保持 pending，让用户在名片里改日程/授权后重试。
      if (res.ok) {
        // 惰性名片：重开后名片落在非末条助手消息里，故遍历全部助手消息就地收敛（否则忽略/创建后名片不消失）。
        patchCardBlocks(sid, (blocks) =>
          blocks.map((b) =>
            b.kind === 'autotaskcard' && b.id === toolId
              ? {
                  ...b,
                  status: res.status,
                  taskId: res.status === 'created' ? res.taskId : b.taskId
                }
              : b
          )
        )
      }
      return res
    }

    return {
      sessions,
      currentSessionId,
      messages,
      streaming,
      streamStatus,
      sessionStates,
      send,
      stop,
      newSession,
      selectSession,
      deleteSession,
      deleteSessions,
      deleteTurns,
      rewindApply,
      rewindUndo,
      currentBinding,
      draftSession,
      mountFocus,
      setSessionModel,
      respondAsk,
      respondPlan,
      respondMount,
      resolveProposal,
      resolveAutotask
    }
  }, [
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamStatus,
    sessionStates,
    currentBinding,
    draftSession,
    activeModel,
    providers,
    t,
    toast,
    startFresh,
    setBinding,
    refreshSessions,
    patchRuntime,
    patchMessages,
    patchCardBlocks,
    dropRuntime
  ])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat 必须在 ChatProvider 内使用')
  return ctx
}
