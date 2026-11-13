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
  EffortLevel,
  MemberMeta,
  MemberProgressGroup,
  MemberTask,
  TaskCreateInput,
  ResolveAutotaskResult,
  RewindApplyResult,
  RewindMode,
  RewindUndoResult,
  TodoItem,
  TodoState
} from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import { useModels, findActive, hasUsableModel } from './models'
import { useWorkspace } from './workspace'
import { formatTokens } from '../../../shared/context'
import { normalizeAgentDraft, normalizeAutotaskDraft, type AgentDraft, type AutotaskDraft } from '../../../shared/drafts'
import type {
  AskOption,
  AskQuestion,
  ChatStreamEvent as StreamEvent,
  DisplayMessage,
  HandoffInfo
} from '../../../shared/chat-protocol'

/** 交互卡与交接的协议类型：与主进程共用 shared/chat-protocol.ts。 */
export type { AskOption, AskQuestion, HandoffInfo }

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

/** file = 只把位置交给模型的文件（Word 等读不进消息的格式、超过体积上限的）。 */
export type AttachKind = 'image' | 'document' | 'text' | 'folder' | 'file'

/** 用户消息上的附件贴片（名称 + 类型；文件夹另带绝对路径，供悬停显示）。 */
export interface AttachChip {
  name: string
  kind: AttachKind
  path?: string
  /** 文件大小（字节；文件夹没有）：附件卡片上显示「PDF · 1.2 MB」。 */
  size?: number
  /** 图片在对话记录里的位置（主进程重建时给出），取缩略图 / 原图用。 */
  ref?: string
  /** 刚发出、还没从主进程重载的图片：发送时的本地路径（已授权），取缩略图 / 原图用，不显示。 */
  file?: string
}

/** 折叠 Task 卡内的子工具项（子智能体内部的一次工具调用，收纳进卡内不占主流）。 */
export interface SubagentChild {
  id: string
  name: string
  args: unknown
  status: ToolStatus
  summary?: string
}

/** 名片草稿（角色 / 定时任务）：与主进程共用 shared/drafts.ts。 */
export type { AgentDraft, AutotaskDraft } from '../../../shared/drafts'

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
      /** 任务描述（取自调用参数 prompt；续聊卡取 message，仅展开时预览）。 */
      task?: string
      /** 续聊卡：send_to_subagent 给已派出的子智能体发的消息（标题前加「继续」）。 */
      continued?: boolean
      /** 后台运行（默认；主进程在展示参数里标 background）：派发它的那轮不等它，卡片独自运行到结束，运行中可单独停止。 */
      background?: boolean
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
      decided?: 'approve' | 'keep' | 'ignore' | 'cancelled'
      /** 选「继续完善」时用户在卡上写的回复（未写则缺省），已决态在卡上回显。 */
      feedback?: string
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
      /** 为成员选择文件夹（不是挂载本对话的工作区）：成员名。 */
      member?: string
      decided?: 'mounted' | 'skipped'
      /** decided='mounted' 时的已挂载目录，供卡片展示。 */
      root?: string
    }
  | {
      /**
       * 已完成的待办清单卡：todo_write 令清单全部完成时落在对话流里，可展开查看条目。
       * 纯展示（不进模型上下文）；重开时由主进程按 todos 边车在同一位置重建。
       */
      kind: 'todolist'
      /** 令清单完成的那次 todo_write 的 toolUseId。 */
      id: string
      title: string
      items: TodoItem[]
    }
  | {
      /**
       * 步骤边界（不渲染）：本步执行过不画卡的 todo_write，说明本步已提交。重连丢弃残缺尾部时以此为界，
       * 免得把本步已提交的正文一并丢掉（见 dropStepPartial）。只活在流式渲染态，重开不重建。
       */
      kind: 'step'
    }
  | { kind: 'error'; message: string }
  /**
   * 回合终止提示（非错误，弱化样式）。
   * truncated=达输出长度上限被截断；empty=通篇无可见回复；
   * restored=用检查点只回滚了代码（对话保留，下一条消息会告诉模型）；
   * aborted=用户中止了本轮（其上为中止前已产出的内容，重开仍在）。
   * 正文按 code 在渲染层翻译（随语言切换生效，不在 store 里定格文案）。
   * 只收主进程会落盘的那几种（与 DisplayBlock 同集）：不落盘的提示（尚未选择模型 / 无需压缩 /
   * 压缩失败 / 发送失败）一律走 toast——做成气泡重启即消失，前后不一致。
   */
  | {
      kind: 'notice'
      code: 'truncated' | 'empty' | 'refused' | 'restored' | 'aborted' | 'step_limit' | 'repeated' | 'degenerate'
    }
  /**
   * 压缩提示（只来自主进程重建），摘要正文默认折叠、点开才显示。steps 有值 = 一轮进行中压缩，是执行步骤里的
   * 一个节点（「此前 N 步已压缩为摘要」，不计入步数）；否则是两轮之间自成一条的分隔提示（first = 前面没有消息）。
   */
  | { kind: 'compaction'; summary: string; steps?: number; first?: boolean }
  /**
   * 回合进行中插入、已交给模型的消息：执行步骤里的一个节点，排在它送达时的两步之间（不计入步数）。
   * 送达前的消息不在这里，显示在输入框上方的胶囊里（见 pendingInserts）。
   */
  | { kind: 'insert'; text: string }

/** 成员会话里正等用户处理的交互卡（提问 / 计划 / 选文件夹）：主对话末尾以胶囊 + 卡片呈现，当场处理。 */
export type PendingCard = Extract<ChatBlock, { kind: 'ask' | 'plan' | 'mount' }>

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  /** 用户消息附件贴片（仅名称 + 类型，不含正文/base64）。 */
  attachments?: AttachChip[]
  /**
   * 后台任务通知（后台子智能体结束后主进程自动起的那一轮的起点）：仍占一个用户位（轮下标照常对齐），
   * 但展示为一行系统通知而非用户气泡，正文为通知标题。
   */
  notify?: boolean
  /** 成员交差的通知：不显示（其后主角色的回复就是交差内容），只留作一轮的起点（轮下标 / 跳转定位照常）。 */
  quiet?: boolean
  /** 成员会话里主智能体派来的任务：工作记录里画成「X 派来的任务」（用户原话 + 附注）。 */
  task?: MemberTask
  /**
   * 绑定的定时任务交来的结果：需要处理的画成居中一行「任务名 摘要」、点开看全文；只是告知的不显示这一行（quiet），
   * 其后那条回复以任务的身份显示（见 redesign/Conversation.tsx reportOf）。
   */
  handoff?: HandoffInfo
  /** 助手消息：本轮耗时（毫秒，主进程计时、扣除等用户处置的时间），工作过程折叠条据此显示「已处理 X」。 */
  durationMs?: number
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
  /** 本对话思考等级；缺省 = 尚未定格（打开时定格为「最近使用」）。见 chat store 的 bindings.effort。 */
  effort?: EffortLevel
  /** 已归档（不在左侧对话列表里显示）；缺省 = 未归档。 */
  archived?: boolean
  /** 项目成员名单（含已移除的）。成员会话本身不在 sessions 里，从这里找。 */
  members?: MemberMeta[]
  /** 成员会话所属的主对话 id（只出现在 store 内部的全部会话里，对外的 sessions 不含成员会话）。 */
  parentId?: string
}

/** send 接受的附件（路径给主进程读取，名称/类型用于本地乐观气泡）。 */
export interface SendAttachment {
  path: string
  name: string
  kind: AttachKind
  /** 文件大小（字节），乐观气泡的附件卡片显示用。 */
  size?: number
}

/**
 * 流式活跃状态（供底部"工作状态指示器"用）。
 * elapsedSec 本轮已用秒数（在跳=还活着）；reconnecting 非 null 表示主进程正在自动重连
 * （真实信号，来自 reconnecting 事件，非猜测）。非 streaming 时归零。
 */
export interface StreamStatus {
  elapsedSec: number
  reconnecting: RecoveryStatus | null
  /** 主进程正在压缩上下文（compacting 事件，真实信号）。 */
  compacting: boolean
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
  /** 正在进行的这一轮从何时开始（streaming 时才有）：成员卡片显示「正在做 · 38 秒」。 */
  startedAt?: number
}

/**
 * 接上一轮正等用户处理的回合（attachSession）：历史里重建出的提问卡没有答复（key 是调用 id，答了也没人接）、
 * 计划卡记作已取消——换成仍在等的那几张实时卡（pendingCards，key 能答复）。打开正等你回答的成员对话即此情形。
 */
function withLiveCards(msgs: ChatMessage[], cards: PendingCard[]): ChatMessage[] {
  const last = msgs[msgs.length - 1]
  if (!cards.length || last?.role !== 'assistant') return msgs
  const live = new Set(cards.map((c) => c.kind))
  const blocks = last.blocks.filter(
    (b) =>
      !(live.has('ask') && b.kind === 'ask' && b.answers === undefined) &&
      !(live.has('plan') && b.kind === 'plan' && b.decided === 'cancelled')
  )
  return [...msgs.slice(0, -1), { ...last, blocks: [...blocks, ...cards] }]
}

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
      return {
        ...b,
        decided: ev.decision ?? ('cancelled' as const),
        ...(ev.feedback ? { feedback: ev.feedback } : {})
      }
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
  /** 重命名对话（立即落库）；title 为空即恢复自动标题（由首条用户消息派生）。不改列表顺序。 */
  renameSession: (id: string, title: string) => void
  /** 归档 / 取消归档对话（立即落库）。不改列表顺序；在已归档的对话里发消息会由主进程自动取消归档。 */
  setArchived: (id: string, archived: boolean) => void
  /**
   * 批量删除对话（删除角色时一并清理其名下历史）。一次性中止各自在跑回合、逐条落盘删除、清绑定
   * 覆盖层，最后只刷新一次列表；若当前会话在其中，则切到最近一条或起新会话。空数组为无操作。
   */
  deleteSessions: (ids: string[]) => void
  /**
   * 按「轮」删除当前会话的部分对话（同步删除模型上下文）。turnIndices 为 0 基轮下标集合
   * （轮 = 一条真实用户消息起，直到下一条用户消息前的全部气泡；压缩摘要等前言不计入轮）。
   * 删除后以主进程重建的历史就地替换该会话消息，保证展示与落盘一致、重启不变。
   * 空集为无操作；该会话正在进行 / 压缩 / 回滚时不删（避免改写正被 Agent 循环原地改写的 messages）。
   * 返回是否已删。
   */
  deleteTurns: (turnIndices: number[]) => Promise<boolean>
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
  /** 当前对话的绑定（覆盖层优先于已落库真值）：驱动头像 / 工作区 chip / 模型与思考等级选择器。 */
  currentBinding: { personaId?: string; focusRoot: string | null; model?: string; effort?: EffortLevel }
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
  /** 设置**当前对话**的思考等级（只改当前对话，立即落库；不动全局「最近使用」，那由调用方另记）。 */
  setSessionEffort: (level: EffortLevel) => void
  /**
   * 各会话正等用户处理的交互卡（键=sessionId，见 PendingCard）：主对话据此在末尾为成员显示「在等你回答」的胶囊与卡片。
   * 卡片答复 / 在别处收敛 / 该会话本轮结束即移除。
   */
  pendingCards: Record<string, PendingCard[]>
  /**
   * 回应 ask_user 询问（每题的选中项标签或自由输入），并把该问答卡就地收敛为已答态。
   * sessionId 缺省为当前会话；在主对话里答成员的卡时传成员会话 id。
   */
  respondAsk: (key: string, answers: string[], sessionId?: string) => void
  /**
   * 回应 exit_plan 计划审阅（approve=批准并执行 / keep=继续完善），并把该计划卡就地收敛为已决态。
   * approve 后主进程循环继续、按计划执行；无渲染层临时态需清除。
   */
  respondPlan: (
    key: string,
    decision: 'approve' | 'keep' | 'ignore',
    feedback?: string,
    sessionId?: string
  ) => void
  /**
   * 回应「请求挂载工作区」：path=用户已选目录（调用方须先经 fs.openFolder 受信）、null=暂不挂载。
   * 挂载成功时**同步更新本对话绑定覆盖层**（等价于 mountFocus）——否则下次 chat:send 会用旧覆盖层
   * 把主进程刚就地设好的 focusRoot 覆盖回去。就地把该卡收敛为终态。
   */
  respondMount: (key: string, path: string | null, sessionId?: string) => void
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
  /** 当前会话的待办清单状态（输入框上方的进度胶囊 + 清单面板）。无进行中的清单时 active 为 null。 */
  todos: TodoState
  /** 手动取消当前会话的清单（不再进行）：胶囊收起，下一条消息告知模型。回合进行中主进程不受理。 */
  cancelTodoList: () => void
  /**
   * 停止当前会话里一个后台运行的子智能体（toolId = 其 Task 卡 id）。卡片随主进程的收尾事件定格「已停止」，
   * 结论随下一轮交给模型（不为此自动起一轮）。
   */
  stopSubagent: (toolId: string) => void
  /**
   * 移除主对话 sessionId 的一个成员（成员卡片「移除成员」）：不再派任务给它，进行中的任务中止，成员会话保留。
   * 名单随主进程的 sessions-changed 刷新。
   */
  removeMember: (sessionId: string, memberSessionId: string) => void
  /**
   * 回合进行中向当前会话插入一条消息：当前步骤结束后交给模型，来不及就在本轮结束后作为下一条发出。
   * 回合恰好已经结束则改走普通发送。返回是否发出（false 时原因已 toast，调用方把文字放回输入框）。
   */
  insert: (text: string) => Promise<boolean>
  /** 当前会话待送达的插入消息（输入框上方的胶囊），按插入先后。 */
  pendingInserts: string[]
  /** 当前（主）对话里还有成员在做、等主角色汇总的派发组（对话末尾的「前端、后端已完成」提示）。 */
  memberProgress: MemberProgressGroup[]
  /** 撤回当前会话全部待送达的插入消息，返回合并后的原文（已送达或没有则为空串）。 */
  withdrawInserts: () => Promise<string>
  /**
   * 订阅「插入消息被退回」（回合被停止或出错时还没送达）：(sessionId, 原文)。返回取消订阅函数。
   * 由输入框所在的外壳把原文放回对应会话的输入框。
   */
  onInsertsReturned: (cb: (sessionId: string, text: string) => void) => () => void
}

/*
 * 按变化频率拆成三份下发，使用方按需订阅：
 *  - actions：操作函数，引用恒定（内部转调最新一次渲染的实现），可放心传给 memo 组件、写进依赖数组；
 *  - state：对话列表、各会话活动态、当前绑定、交互卡、清单等，流式输出期间不变；
 *  - stream：当前对话的消息与流式状态，每帧都可能变。只有对话流本身需要订阅它。
 */
type ChatActionKey = {
  [K in keyof ChatContextValue]: ChatContextValue[K] extends (...args: never[]) => unknown ? K : never
}[keyof ChatContextValue]
export type ChatActions = Pick<ChatContextValue, ChatActionKey>
export type ChatState = Omit<ChatContextValue, ChatActionKey | 'messages' | 'streamStatus'>
export type ChatStream = Pick<ChatContextValue, 'messages' | 'streaming' | 'streamStatus'>

/** 全部操作函数名。写成 Record 是为了与 ChatContextValue 同步：漏一个、多一个都编译不过。 */
const ACTION_KEYS: Record<ChatActionKey, true> = {
  send: true,
  stop: true,
  newSession: true,
  selectSession: true,
  deleteSession: true,
  renameSession: true,
  setArchived: true,
  deleteSessions: true,
  deleteTurns: true,
  rewindApply: true,
  rewindUndo: true,
  mountFocus: true,
  setSessionModel: true,
  setSessionEffort: true,
  respondAsk: true,
  respondPlan: true,
  respondMount: true,
  resolveProposal: true,
  resolveAutotask: true,
  cancelTodoList: true,
  stopSubagent: true,
  removeMember: true,
  insert: true,
  withdrawInserts: true,
  onInsertsReturned: true
}

/** 引用恒定的操作函数：每次调用转给 ref 里最新一次渲染的实现。 */
function bindActions(ref: { readonly current: ChatContextValue }): ChatActions {
  const out: Partial<Record<ChatActionKey, unknown>> = {}
  for (const k of Object.keys(ACTION_KEYS) as ChatActionKey[])
    out[k] = (...args: unknown[]) => (ref.current[k] as (...a: unknown[]) => unknown)(...args)
  return out as ChatActions
}

const ChatActionsContext = createContext<ChatActions | null>(null)
const ChatStateContext = createContext<ChatState | null>(null)
const ChatStreamContext = createContext<ChatStream | null>(null)

/** 各会话「插入消息被退回」的订阅者（见 onInsertsReturned）。 */
const insertReturnListeners = new Set<(sessionId: string, text: string) => void>()
function onInsertsReturned(cb: (sessionId: string, text: string) => void): () => void {
  insertReturnListeners.add(cb)
  return () => {
    insertReturnListeners.delete(cb)
  }
}
const NO_INSERTS: string[] = []
const NO_PROGRESS: MemberProgressGroup[] = []

/** 空闲态的流式状态（归零）。 */
/**
 * 状态横幅的恢复态：reason 缺省 / 'reconnect' = 断流重连；其余为引擎自愈（见主进程 auto_retry 事件）。
 */
export interface RecoveryStatus {
  attempt: number
  max: number
  reason?:
    | 'reconnect'
    | 'truncated'
    | 'empty'
    | 'context'
    | 'output_limit'
    | 'effort'
    | 'repetition'
    | 'output_fit'
}

const IDLE_STATUS: StreamStatus = { elapsedSec: 0, reconnecting: null, compacting: false }

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
        attachments: dm.attachments.length ? dm.attachments : undefined,
        ...(dm.notify ? { notify: true } : {}),
        ...(dm.quiet ? { quiet: true } : {}),
        ...(dm.task ? { task: dm.task } : {}),
        ...(dm.handoff ? { handoff: dm.handoff } : {})
      }
    }
    const blocks: ChatBlock[] = dm.blocks.map((b) => {
      if (b.kind === 'text') return { kind: 'text', text: b.text }
      if (b.kind === 'notice') return { kind: 'notice', code: b.code }
      if (b.kind === 'compaction')
        return {
          kind: 'compaction',
          summary: b.summary,
          ...(b.steps !== undefined ? { steps: b.steps } : {}),
          ...(b.first ? { first: true } : {})
        }
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
      if (b.kind === 'plan')
        return {
          kind: 'plan',
          key: b.id,
          plan: b.plan,
          decided: b.decision,
          ...(b.feedback ? { feedback: b.feedback } : {})
        }
      // 历史回填：已完成的待办清单卡（条目取自主进程 todos 边车里令其完成的那次快照）。
      if (b.kind === 'todolist') return { kind: 'todolist', id: b.id, title: b.title, items: b.items }
      // 历史回填：回合进行中插入的消息（执行步骤里的一个节点）。
      if (b.kind === 'insert') return { kind: 'insert', text: b.text }
      const status: ToolStatus = b.status === 'error' ? 'error' : b.status === 'running' ? 'running' : 'ok'
      // 历史回填：run_subagent / send_to_subagent 复原为折叠 Task 卡（内部子调用不入父历史，故 children
      // 为空、仅存结论）。
      if (isSubagentCall(b.name)) return subagentBlock(b.id, b.name, b.args, status, b.summary)
      return { kind: 'tool', id: b.id, name: b.name, args: b.args, status, summary: b.summary }
    })
    return {
      id: genId(),
      role: 'assistant',
      blocks,
      ...(dm.durationMs !== undefined ? { durationMs: dm.durationMs } : {})
    }
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
    // 后台运行的卡只认 parent（它的事件都带），不当兜底对象。
    if (b.kind === 'subagent' && b.status === 'running' && !b.background) return i
  }
  return -1
}

/** 会开子智能体 Task 卡的调用：新派出（run_subagent）或续聊已派出的子智能体（send_to_subagent）。 */
function isSubagentCall(name: string): boolean {
  return name === 'run_subagent' || name === 'send_to_subagent'
}

/**
 * 调用参数 → 子智能体 Task 卡（实时与历史回填共用）。续聊卡的任务正文取 message 并标 continued；
 * 它的 agent / description 由主进程从子智能体记录补进参数（见 chat-display.ts 的 withSubagentMeta）。
 * 是否后台运行同样由主进程补进参数（background，见 chat-display.ts 的 subagentDisplayArgs）：模型的原参数看不出来。
 */
function subagentBlock(
  id: string,
  name: string,
  args: unknown,
  status: ToolStatus,
  summary?: string
): ChatBlock {
  const a = (args ?? {}) as {
    agent?: unknown
    prompt?: unknown
    message?: unknown
    description?: unknown
    background?: unknown
  }
  const continued = name === 'send_to_subagent'
  const task = continued ? a.message : a.prompt
  return {
    kind: 'subagent',
    id,
    agent: typeof a.agent === 'string' ? a.agent : '',
    desc: typeof a.description === 'string' ? a.description.trim() || undefined : undefined,
    task: typeof task === 'string' ? task : undefined,
    ...(continued ? { continued: true } : {}),
    ...(a.background === true ? { background: true } : {}),
    status,
    summary,
    children: []
  }
}

/**
 * 后台子智能体的事件（bg）并入块序列：只更新**本段**里那张 Task 卡（嵌套事件按 parent，壳结果按 id），卡不在
 * 本段则原样返回。它不属于任何回合，卡可能落在任意一条历史消息里——绝不像实时事件那样兜底新建卡片。
 */
function reduceBackground(
  blocks: ChatBlock[],
  ev: Extract<StreamEvent, { type: 'tool_call' | 'tool_result' }>
): ChatBlock[] {
  const cardId = ev.depth && ev.depth > 0 ? ev.parent : ev.id
  if (!blocks.some((b) => b.kind === 'subagent' && b.id === cardId)) return blocks
  return reduceBlocks(blocks, ev)
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
      // run_subagent / send_to_subagent 的壳调用（depth 0）→ 开一张折叠 Task 卡。
      if (isSubagentCall(ev.name)) {
        next.push(subagentBlock(ev.id, ev.name, ev.args, 'running'))
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
    case 'todo_done':
      next.push({ kind: 'todolist', id: ev.id, title: ev.title, items: ev.items })
      return next
    case 'mount_request':
      next.push({ kind: 'mount', key: ev.key, tool: ev.tool, path: ev.path, ...(ev.member ? { member: ev.member } : {}) })
      return next
    case 'insert':
      next.push({ kind: 'insert', text: ev.text })
      return next
    case 'error':
      next.push({ kind: 'error', message: ev.message })
      return next
    // compacted 不进当前气泡：压缩中有状态行动效，成功后 done 时整份重载，较早的气泡收成一行「已压缩」
    // 提示（摘要折叠）；none / failed 由事件订阅处改弹 toast。
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
    // 工具卡、子智能体 Task 卡、已完成清单卡、步骤标记与插入的消息（随上一步结果送达）都是「步骤边界」：
    // 其后才是本步残缺的 thinking/text 尾部。
    const k = blocks[i].kind
    if (k === 'tool' || k === 'subagent' || k === 'todolist' || k === 'step' || k === 'insert') {
      lastTool = i
      break
    }
  }
  if (lastTool === blocks.length - 1) return blocks // 已在步骤边界处收尾，无残缺
  return blocks.slice(0, lastTool + 1)
}

/**
 * 本轮是否已有「可见回复」：正文/工具/子卡/问答/错误/提示任一即算；纯思考或全空不算。
 * 调过 todo_write（step / todolist）也算——与主进程「有工具调用即算」同义，否则只更新了清单的一轮会被误补空回合提示。
 */
function hasVisibleAnswer(blocks: ChatBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.kind === 'text' && b.text.trim() !== '') ||
      b.kind === 'tool' ||
      b.kind === 'step' ||
      b.kind === 'todolist' ||
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
 * - step_limit（定时任务达到步数上限）：标一条「已达到步数上限」——任务可能没做完；
 * - repeated（同一工具同参数同结果连续出现到上限，被停下）：标一条说明；
 * - degenerate（回复陷入逐字复读，重试后仍如此，被停下）：标一条说明；
 * - error（已另有红色错误块）不重复提示。
 * 与主进程 recordTurnNotice / runScheduledTurn 同一套规则，故重开对话后所见一致。
 * 无需补提示时返回原数组引用（updateLastAssistant 据引用相等短路，不触发无谓重渲染）。
 */
function appendTerminalNotice(blocks: ChatBlock[], stopReason: string): ChatBlock[] {
  if (stopReason === 'aborted') return [...blocks, { kind: 'notice', code: 'aborted' }]
  if (stopReason === 'step_limit') return [...blocks, { kind: 'notice', code: 'step_limit' }]
  if (stopReason === 'repeated') return [...blocks, { kind: 'notice', code: 'repeated' }]
  if (stopReason === 'degenerate') return [...blocks, { kind: 'notice', code: 'degenerate' }]
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

/** 给末条助手消息记下本轮耗时（done 事件带来）；末条不是助手消息或没有耗时则原样返回。 */
function setLastDuration(list: ChatMessage[], durationMs: number | undefined): ChatMessage[] {
  const last = list[list.length - 1]
  if (durationMs === undefined || !last || last.role !== 'assistant') return list
  const copy = list.slice()
  copy[copy.length - 1] = { ...last, durationMs }
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
  /** 主进程 compacting 事件驱动：正在压缩上下文。 */
  compacting: boolean
  /**
   * 本轮由别处发起（手机端 / 定时任务）、本层只是接上了它：中途接入时本步已流出的部分会缺失，
   * 故 done 时以主进程为准重载。
   */
  external: boolean
}

/** 空活动态（共享冻结常量作 patch 种子；任何真实变更都返回新对象，绝不原地改）。 */
const EMPTY_RUNTIME: SessionRuntime = Object.freeze({
  messages: Object.freeze([]) as unknown as ChatMessage[],
  streaming: false,
  turnId: null,
  startedAt: 0,
  reconnecting: null,
  compacting: false,
  external: false
})

/** 尚无待办清单的会话对外暴露的空状态（稳定引用）。 */
const EMPTY_TODOS: TodoState = Object.freeze({ active: null })

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

/** 两份会话活动态摘要内容是否相同（键集合与每条的各字段）。 */
function sameSessionStates(a: Record<string, SessionLiveState>, b: Record<string, SessionLiveState>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => {
    const x = a[k]
    const y = b[k]
    return (
      !!y &&
      x.streaming === y.streaming &&
      x.attention === y.attention &&
      x.unread === y.unread &&
      x.startedAt === y.startedAt
    )
  })
}

export function ChatProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { activeModel, providers, activeEffort, ready: modelsReady } = useModels()
  const { activeProject } = useWorkspace()
  // 流事件订阅只挂载一次，经 ref 读当前语言的 t（切语言不必重订阅）。
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // 主进程交来的全部会话，含成员会话（带 parentId，见 SessionMeta.parentId）。成员会话不进左侧列表，
  // 对外只给 sessions（不含成员会话）；打开成员对话时它的模型 / 思考等级 / 文件夹从这里读。
  const [allSessions, setSessions] = useState<SessionMeta[]>([])
  const sessions = useMemo(() => allSessions.filter((s) => !s.parentId), [allSessions])
  // 初始会话清单是否已载入完成。首次 listSessions resolve 后置 true 并恒保持；
  // 渲染层据此区分「加载中」与「确认无对话」，避免启动瞬间闪现空态。
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  // 各会话正等用户处理的交互卡（见 PendingCard）：不论本层是否缓存 / 流式该会话都记，成员的卡由此在主对话里出现。
  const [pendingCards, setPendingCards] = useState<Record<string, PendingCard[]>>({})
  const pendingCardsRef = useRef(pendingCards)
  pendingCardsRef.current = pendingCards
  const dropPendingCard = useCallback((sid: string, key?: string): void => {
    setPendingCards((prev) => {
      const list = prev[sid]
      if (!list) return prev
      const left = key === undefined ? [] : list.filter((c) => c.key !== key)
      if (left.length === list.length) return prev
      const next = { ...prev }
      if (left.length) next[sid] = left
      else delete next[sid]
      return next
    })
  }, [])
  // 各会话活动态（键=sessionId）。ref 供事件回调 / 命令同步读写（不受渲染闭包过期影响），state 驱动渲染。
  const [runtimes, setRuntimes] = useState<Map<string, SessionRuntime>>(() => new Map())
  // 会话绑定覆盖层（对话优先外壳）：persona / 聚焦工作区，在会话**首发落库前**只存渲染态，首发时随
  // chat:send 一并绑定；已落库会话的 mount/unmount 也先写此层，随下次 chat:send 更新到主进程。
  // 与 SessionMeta（已落库真值）叠加读出 currentBinding，覆盖层优先（承载尚未落库/刚变更的值）。
  const [bindings, setBindings] = useState<
    Map<
      string,
      {
        personaId?: string
        focusRoot?: string | null
        model?: string
        effort?: EffortLevel
        createdAt?: number
      }
    >
  >(() => new Map())
  // 未读会话（键=sessionId）：不在查看时有回合完成即记入，切进该会话即清除。
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set())
  // 别处发起、正在进行的回合（键=sessionId；定时任务 / 手机端）：turn_start 记入、done 移除。本层没缓存的
  // 会话没有 runtime，列表头像的忙碌动效靠它；不然要点开（attachSession 建了 runtime）才看得到。
  const [bgStreaming, setBgStreaming] = useState<ReadonlySet<string>>(() => new Set())
  // 别处发起的回合何时开始（键=sessionId）：随 bgStreaming 一同增删，sessionStates 据此给出 startedAt。
  const bgStartedRef = useRef(new Map<string, number>())
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
      patch: {
        personaId?: string
        focusRoot?: string | null
        model?: string
        effort?: EffortLevel
        createdAt?: number
      }
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

  // 从主进程载入会话并建活动态；若该会话正有一轮在跑（手机端 / 定时任务发起，或本层切走前发起），就地接上：
  // 置流式、记 turnId，此后的流事件照本地回合拼进末条助手气泡，发送键随之变为停止。
  // 载入期间已切走 / 已有活动态生成 → 丢弃结果（绝不冲掉实时内容）。
  const attachSession = useCallback(
    async (sid: string): Promise<void> => {
      const { messages, turnId, startedAt } = await window.deva.chat.attachSession(sid)
      if (sessionIdRef.current !== sid || runtimesRef.current.has(sid)) return
      const msgs = displayToMessages(messages as DisplayMessage[])
      if (!turnId) {
        patchRuntime(sid, (r) => ({ ...r, messages: msgs }))
        return
      }
      // 本轮已完成的步骤在历史里（末条即本轮助手消息）；尚无助手输出时补一个空助手位承接流事件。
      const tail: ChatMessage[] =
        msgs[msgs.length - 1]?.role === 'assistant' ? [] : [{ id: genId(), role: 'assistant', blocks: [] }]
      patchRuntime(sid, (r) => ({
        ...r,
        messages: withLiveCards([...msgs, ...tail], pendingCardsRef.current[sid] ?? []),
        streaming: true,
        turnId,
        // 后台跑了一阵才打开（如成员对话）：计时从这一轮真正开始的时刻算，不从打开时归零。
        startedAt: startedAt ?? bgStartedRef.current.get(sid) ?? Date.now(),
        reconnecting: null,
        compacting: false,
        external: true
      }))
    },
    [patchRuntime]
  )

  // 各会话的待办清单状态（键=sessionId）：todos 事件推送、切到会话时拉取。本窗口收得到所有会话的事件，
  // 故缓存不会过期。ref 供事件回调 / 拉取回调同步读（判定拉取期间事件是否已先到）。
  const [todoStates, setTodoStates] = useState<Map<string, TodoState>>(() => new Map())
  const todoStatesRef = useRef(todoStates)
  const setTodoState = useCallback((sid: string, st: TodoState): void => {
    const map = new Map(todoStatesRef.current)
    map.set(sid, st)
    todoStatesRef.current = map
    setTodoStates(map)
  }, [])

  // 各会话待送达的插入消息（键=sessionId）：只由主进程的 inserts 事件更新（插入 / 送达 / 撤回 / 回合结束都会推）。
  const [insertStates, setInsertStates] = useState<Map<string, string[]>>(() => new Map())
  const setInsertState = useCallback((sid: string, pending: string[]): void => {
    setInsertStates((prev) => {
      if (!pending.length && !prev.has(sid)) return prev
      const map = new Map(prev)
      if (pending.length) map.set(sid, pending)
      else map.delete(sid)
      return map
    })
  }, [])

  // 各主对话等汇总的成员进度（键=sessionId）：只由主进程的 member_progress 事件更新（派出、交差时都推）。
  const [progressStates, setProgressStates] = useState<Map<string, MemberProgressGroup[]>>(() => new Map())
  const setProgressState = useCallback((sid: string, groups: MemberProgressGroup[]): void => {
    setProgressStates((prev) => {
      if (!groups.length && !prev.has(sid)) return prev
      const map = new Map(prev)
      if (groups.length) map.set(sid, groups)
      else map.delete(sid)
      return map
    })
  }, [])

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

  // 打开列表第一条：最近更新、且未归档的对话（已归档的不在列表里，不能跳进去），载入其历史；
  // 一条都没有则起惰性新会话（右侧转「快速开启」）。启动 / 切项目，以及当前对话被删除或归档后都走这里。
  // 已有活动态（如后台正在流式的会话）不重载，避免冲掉实时累积的内容。
  const openFirstSession = useCallback(
    (list: SessionMeta[]): void => {
      const first = list
        .filter((s) => !s.archived && !s.parentId)
        .reduce<SessionMeta | null>((a, s) => (a && a.updatedAt >= s.updatedAt ? a : s), null)
      if (!first) {
        startFresh()
        return
      }
      setCurrent(first.id)
      if (!runtimesRef.current.has(first.id)) void attachSession(first.id)
    },
    [startFresh, attachSession]
  )

  // 切项目：重载会话清单 + 打开列表第一条（无则起新会话）。
  useEffect(() => {
    const path = activeProject?.path ?? null
    projectPathRef.current = path
    let cancelled = false
    void (async () => {
      const list = await window.deva.chat.listSessions(path)
      if (cancelled || projectPathRef.current !== path) return
      setSessions(list)
      openFirstSession(list)
    })()
    return () => {
      cancelled = true
    }
  }, [activeProject?.path, openFirstSession])

  // 订阅主进程流事件（挂载一次）。按 payload.sessionId 路由进对应会话的活动态——
  // 不再丢弃「非当前会话」事件：后台那轮照常累积，切回去即见其实时流。
  useEffect(() => {
    // 本回合内压缩成功过的会话（done 时消费）。
    const compactedSids = new Set<string>()
    // 本回合 /compact 已有结果的会话（成功 / 无需压缩 / 失败；done 时消费：结果已走 toast，撤掉为它预留的空助手位）。
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
          compacting: false,
          messages: displayToMessages(dms as DisplayMessage[])
        }))
      })()
    }

    // 正文 / 思考增量按帧合并：每个 token 一条事件，逐条 setState 会让整棵组件树每个 token 重渲染一次。
    // 同一会话的增量先排队，下一帧一次并入；窗口在后台时 rAF 不跑，另有 250ms 计时兜底（后台计时器
    // 会被降频，但总会跑）。该会话的其它事件到达时先把排着的并入，保证事件先后顺序不变。
    const pendingDeltas = new Map<string, StreamEvent[]>()
    let deltaFrame = 0
    let deltaTimer: ReturnType<typeof setTimeout> | null = null
    const flushDeltas = (sid: string): void => {
      const evs = pendingDeltas.get(sid)
      if (!evs) return
      pendingDeltas.delete(sid)
      patchRuntime(sid, (r) => {
        const messages = updateLastAssistant(r.messages, (blocks) => evs.reduce(reduceBlocks, blocks))
        if (messages === r.messages && r.reconnecting === null) return r
        return { ...r, messages, reconnecting: null }
      })
    }
    const flushAllDeltas = (): void => {
      if (deltaFrame) cancelAnimationFrame(deltaFrame)
      if (deltaTimer) clearTimeout(deltaTimer)
      deltaFrame = 0
      deltaTimer = null
      for (const sid of [...pendingDeltas.keys()]) flushDeltas(sid)
    }
    const queueDelta = (sid: string, ev: StreamEvent): void => {
      const q = pendingDeltas.get(sid)
      if (q) q.push(ev)
      else pendingDeltas.set(sid, [ev])
      if (!deltaFrame) deltaFrame = requestAnimationFrame(flushAllDeltas)
      if (!deltaTimer) deltaTimer = setTimeout(flushAllDeltas, 250)
    }

    const unsub = window.deva.chat.onEvent((payload) => {
      const sid = payload.sessionId
      const ev = payload.event as StreamEvent
      const isDelta = ev.type === 'text_delta' || ev.type === 'thinking_delta'
      if (!isDelta) flushDeltas(sid)

      // 本渲染层是否正为该会话流式一轮 = 建过「用户气泡 + 空助手位」脚手架：本层 send/compact 发起的，
      // 或别处发起、经 turn_start / attachSession 接上的。只有这样的会话才能把流事件正确拼进气泡；
      // 其余是本层没缓存的后台回合 —— 内容以主进程 + 磁盘为唯一真源，绝不在此凑合拼装。
      const localStreaming = runtimesRef.current.get(sid)?.streaming === true

      // 交互卡另记一份到 pendingCards（不 return，照常并入气泡）：成员会话的卡没人打开着看，主对话靠它在末尾显示胶囊与卡片。
      if (ev.type === 'ask_user' || ev.type === 'plan_review' || ev.type === 'mount_request') {
        const card: PendingCard =
          ev.type === 'ask_user'
            ? { kind: 'ask', key: ev.key, questions: ev.questions }
            : ev.type === 'plan_review'
              ? { kind: 'plan', key: ev.key, plan: ev.plan }
              : { kind: 'mount', key: ev.key, tool: ev.tool, path: ev.path, ...(ev.member ? { member: ev.member } : {}) }
        setPendingCards((prev) => ({
          ...prev,
          [sid]: [...(prev[sid] ?? []).filter((c) => c.key !== card.key), card]
        }))
      }
      if (ev.type === 'interaction_resolved') dropPendingCard(sid, ev.key)
      if (ev.type === 'done') dropPendingCard(sid)

      // 成员交差已记进主对话、以成员的身份显示（会话级，主对话空闲时才发）：同一条新回复，不在看就记未读；缓存着该对话
      // 就以主进程为准重载。正流式时（刚发出新一轮、主进程还没登记忙）等这一轮 done 时再重载。
      if (ev.type === 'member_report') {
        void refreshSessions()
        if (sessionIdRef.current !== sid) setUnread((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)))
        const r = runtimesRef.current.get(sid)
        if (r?.streaming) compactedSids.add(sid)
        else if (r) reloadIntoRuntime(sid)
        return
      }

      // 后台子智能体的过程与结局不属于任何回合（turnId 为空串）：按卡片 id 在全部消息里就地更新那张 Task 卡。
      // 没缓存该会话就不管——打开时从主进程重载，卡片状态以边车为准（子步骤不落盘，重载后只剩结论）。
      if ((ev.type === 'tool_call' || ev.type === 'tool_result') && ev.bg) {
        if (runtimesRef.current.has(sid)) patchCardBlocks(sid, (blocks) => reduceBackground(blocks, ev))
        return
      }

      // 回合开始。本层自己发起的已建好脚手架（send 尚未返回、turnId 未回填）→ 跳过。别处发起的
      //（手机端 / 定时任务）当本地回合呈现：缓存着该会话就补用户气泡 + 空助手位并置流式；没缓存但正在看
      //（还在载入）→ 经 attachSession 接上；都不是 → 不建空壳，打开时由 attachSession 接上。
      if (ev.type === 'turn_start') {
        void refreshSessions() // 新会话 / 标题 / 排序
        if (localStreaming) return
        if (!bgStartedRef.current.has(sid)) bgStartedRef.current.set(sid, Date.now())
        setBgStreaming((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)))
        if (runtimesRef.current.has(sid)) {
          const [userMsg] = displayToMessages([{ role: 'user', ...ev.user }])
          patchRuntime(sid, (r) => ({
            ...r,
            messages: [...r.messages, userMsg, { id: genId(), role: 'assistant', blocks: [] }],
            streaming: true,
            turnId: payload.turnId,
            startedAt: Date.now(),
            reconnecting: null,
            compacting: false,
            external: true
          }))
        } else if (sessionIdRef.current === sid) void attachSession(sid)
        return
      }

      // 名片决议不属于回合（名片在回合结束后仍可操作）：只要本层缓存着该会话就就地收敛；
      // 没缓存的不必管——下次打开从磁盘重载，边车里已是终态。
      if (ev.type === 'card_resolved') {
        if (runtimesRef.current.has(sid)) patchCardBlocks(sid, (blocks) => resolveProposalCard(blocks, ev))
        return
      }

      // 待办清单状态是会话级的（按轮删除 / 回滚 / 手动取消后也会推，此时 turnId 为空串）：不论本层是否
      // 正流式该会话，一律记下最新值，胶囊据此显示。
      if (ev.type === 'todos') {
        setTodoState(sid, ev.state)
        // 本层正流式的这一轮调了 todo_write：记一个步骤边界（它不画卡，重连丢残缺尾部时别把本步正文一并丢掉）。
        if (localStreaming && payload.turnId) patchMessages(sid, (b) => [...b, { kind: 'step' }])
        return
      }

      // 待送达的插入消息与退回的插入消息同样是会话级的：不论本层是否正流式该会话都要处理。
      if (ev.type === 'inserts') {
        setInsertState(sid, ev.pending)
        return
      }
      // 成员进度同样是会话级的。
      if (ev.type === 'member_progress') {
        setProgressState(sid, ev.groups)
        return
      }
      if (ev.type === 'inserts_returned') {
        for (const cb of insertReturnListeners) cb(sid, ev.text)
        return
      }

      // 本回合压缩成功（自动或 /compact）：主进程在对话记录里插了一条摘要（消息一条没删），轮下标不变，但压缩
      // 提示要画出来，图片附件按消息下标定位的 ref 也在插入点之后整体后移一位。先记下，done 时以主进程为准重载。
      // 手动 /compact 另弹 toast：边界在保留部分之前，常在可视区以上，看不到提示；并撤掉预留的空助手位。
      if (ev.type === 'compacted' && ev.status === 'compacted') {
        compactedSids.add(sid)
        if (ev.scope === 'manual' && localStreaming) {
          compactDropSids.add(sid)
          toast.show({ message: tRef.current('chat.notice.compactDone') })
        }
      }

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
        bgStartedRef.current.delete(sid)
        setBgStreaming((prev) => {
          if (!prev.has(sid)) return prev
          const next = new Set(prev)
          next.delete(sid)
          return next
        })
        // 不在查看的会话完成了一轮（本层发起后切走的 / 定时任务等后台回合）→ 记未读。
        // compactDrop（/compact）没有新内容，不算。
        if (sessionIdRef.current !== sid && !compactDrop)
          setUnread((prev) => (prev.has(sid) ? prev : new Set(prev).add(sid)))
        if (localStreaming) {
          const external = runtimesRef.current.get(sid)?.external === true
          patchRuntime(sid, (r) => ({
            ...r,
            streaming: false,
            turnId: null,
            reconnecting: null,
            compacting: false,
            // /compact：撤掉预留的空助手位（结果已 toast，不补空回合提示）。否则先收敛仍未决的
            // 交互卡（用户中断时最常见），再据终止原因补「中断说明」：截断/空回合给出可见提示，正常回合原样短路。
            messages: compactDrop
              ? dropEmptyAssistantTail(r.messages)
              : setLastDuration(
                  updateLastAssistant(settleOpenCards(r.messages), (b) =>
                    appendTerminalNotice(b, ev.stopReason)
                  ),
                  ev.durationMs
                )
          }))
          // 压缩过：以主进程为准重载（画出压缩提示、刷新图片 ref）。主进程在发 done 后同步补记终态提示并落盘，
          // 早于本层 loadSession 请求到达，故重载拿到的已含本轮 notices。
          // 别处发起、本层中途接上的一轮：接入前已流出的部分不在气泡里，同样以主进程为准重载。
          if (compacted || external) reloadIntoRuntime(sid)
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

      // 未接上的后台回合，中途事件一律忽略：本层无脚手架可拼，内容以主进程为准、打开时由 attachSession
      // 接上。仅本层正流式的会话才继续处理下列实时事件。
      if (!localStreaming) return

      // 主进程真实信号：正在压缩上下文（底部状态行换成「正在压缩」），结束时成对收起。
      if (ev.type === 'compacting') {
        patchRuntime(sid, (r) => (r.compacting === ev.active ? r : { ...r, compacting: ev.active }))
        return
      }
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
        // 自愈用到的上限与模型设置不符（窗口实际更小 / 所设输出上限被拒）：横幅转瞬即逝，另弹 toast
        // 说明实际值并指向模型设置，用户才知道该去改哪里。
        if (ev.limit && (ev.reason === 'context' || ev.reason === 'output_limit'))
          toast.show({
            variant: 'warning',
            message: tRef.current(
              ev.reason === 'context'
                ? 'chat.notice.contextLimitLearned'
                : 'chat.notice.outputLimitRejected'
            ).replace('{n}', formatTokens(ev.limit)),
            duration: 8000
          })
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
      // 内容事件：并入消息；若正处于重连横幅则收起（任何真实内容到达即视为"已恢复"）。增量按帧合并（见上）。
      if (isDelta) {
        queueDelta(sid, ev)
        return
      }
      patchRuntime(sid, (r) => {
        const messages = updateLastAssistant(r.messages, (blocks) => reduceBlocks(blocks, ev))
        if (messages === r.messages && r.reconnecting === null) return r
        return { ...r, messages, reconnecting: null }
      })
    })
    return () => {
      unsub()
      flushAllDeltas()
    }
  }, [
    refreshSessions,
    patchRuntime,
    patchMessages,
    patchCardBlocks,
    dropRuntime,
    attachSession,
    toast,
    setTodoState,
    setInsertState,
    setProgressState,
    dropPendingCard
  ])

  // 切到某会话时拉取其待办清单（此后的变化走 todos 事件）。拉取期间事件已先到则以事件为准。
  useEffect(() => {
    const sid = currentSessionId
    if (!sid || todoStatesRef.current.has(sid)) return
    window.deva.chat
      .todos(sid)
      .then((st) => {
        if (!todoStatesRef.current.has(sid)) setTodoState(sid, st)
      })
      .catch(() => undefined)
  }, [currentSessionId, setTodoState])

  // 回合之外新建的对话（手机上 /new，还没发消息）：没有 turn_start 可借，主进程单独通知刷新列表。
  useEffect(() => window.deva.chat.onSessionsChanged(() => void refreshSessions()), [refreshSessions])

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
          reconnecting: viewed.reconnecting,
          compacting: viewed.compacting
        }
      : IDLE_STATUS

  // 各会话活动态摘要（左侧列表角标用）；仅 runtimes / 未读集 / 后台进行中集变化时重算。
  // 后台回合没缓存 runtime（进行中靠 bgStreaming，完成后 runtime 也会被丢弃），这类会话单独补一条。
  const sessionStatesRef = useRef<Record<string, SessionLiveState> | null>(null)
  const sessionStates = useMemo<Record<string, SessionLiveState>>(() => {
    const out: Record<string, SessionLiveState> = {}
    for (const [id, r] of runtimes) {
      const streaming = r.streaming || bgStreaming.has(id)
      out[id] = {
        streaming,
        attention: hasAttention(r.messages),
        unread: unread.has(id),
        ...(streaming ? { startedAt: r.streaming && r.startedAt ? r.startedAt : bgStartedRef.current.get(id) } : {})
      }
    }
    for (const id of bgStreaming)
      if (!out[id])
        out[id] = { streaming: true, attention: false, unread: unread.has(id), startedAt: bgStartedRef.current.get(id) }
    for (const id of unread)
      if (!out[id]) out[id] = { streaming: false, attention: false, unread: true }
    // 成员在等用户处理：成员会话与它所属的主对话都算待处理（列表里主对话亮「待处理」）。
    for (const [id, cards] of Object.entries(pendingCards)) {
      if (!cards.length) continue
      const parent = allSessions.find((s) => s.id === id)?.parentId
      for (const k of parent ? [id, parent] : [id])
        out[k] = out[k] ? { ...out[k], attention: true } : { streaming: false, attention: true, unread: unread.has(k) }
    }
    // runtimes 随流式输出每帧都变，摘要却很少变：内容相同就沿用上一份，免得订阅它的列表每帧重渲染。
    const prev = sessionStatesRef.current
    if (prev && sameSessionStates(prev, out)) return prev
    sessionStatesRef.current = out
    return out
  }, [runtimes, unread, bgStreaming, pendingCards, allSessions])

  /** 该会话是不是成员会话（见 SessionMeta.parentId）。 */
  const isMemberSession = (id: string): boolean => allSessions.some((s) => s.id === id && !!s.parentId)

  // 当前对话的绑定读出（覆盖层优先于已落库 SessionMeta）：驱动对话优先外壳的头像 / 工作区 chip。
  // 覆盖层承载「尚未落库」（新会话首发前）或「刚 mount/unmount」的值；落库真值来自 listSessions。
  const currentBinding = useMemo<{
    personaId?: string
    focusRoot: string | null
    model?: string
    effort?: EffortLevel
  }>(
    () => {
      const meta = allSessions.find((s) => s.id === currentSessionId)
      const ov = bindings.get(currentSessionId)
      const personaId = ov?.personaId ?? meta?.personaId
      const focusRoot =
        ov && ov.focusRoot !== undefined ? ov.focusRoot : (meta?.focusRoot ?? null)
      // model：覆盖层优先（尚未落库的快照/刚切换）；否则落库真值。均缺省 = undefined（跟随全局默认）。
      const model = ov && ov.model !== undefined ? ov.model : meta?.model
      const effort = ov?.effort ?? meta?.effort
      return { personaId, focusRoot: focusRoot ?? null, model, effort }
    },
    [currentSessionId, allSessions, bindings]
  )

  // 当前对话尚无自己的模型（新建时角色没设偏好模型、旧版本遗留对话等）→ 把此刻显示的
  // 生效模型（即全局「最近使用」）定格为本对话模型并落库。否则它会一直隐式跟随全局：在别的对话里一切换，
  // 这里也跟着变（只有存过模型的对话不受影响，表现为「部分对话被连带切换」）。
  // 惰性未建档的会话主进程查不到会跳过，覆盖层随首发 modelRef 落库。
  // 定时任务对话除外：它的模型与任务两边同步，没有模型 = 任务选了「跟随默认」（运行时用的正是全局最近使用，
  // 与此处显示一致）。在这里定格会顺带把任务改成固定模型，只是打开看一眼就改了用户的设置。
  useEffect(() => {
    const sid = currentSessionId
    // 成员会话也不定格：没亲自选过就跟随主对话（派任务时同步），在这里定格会被当成「用户选过」。
    if (!sid || currentBinding.model || !activeModel || sid.startsWith('task-') || isMemberSession(sid)) return
    const ref = `${activeModel.provider.id}:${activeModel.model.id}`
    setBinding(sid, { model: ref })
    if (allSessions.some((s) => s.id === sid))
      void (async () => {
        await window.deva.chat.setModel({ sessionId: sid, modelRef: ref })
        await refreshSessions()
      })()
    // 已定格的对话 currentBinding.model 非空、首行即返回，activeModel 之后再变也不会改写它；
    // 依赖 activeModel 只为启动时配置晚于会话载入的情形（届时再补定格）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, currentBinding.model, activeModel])

  // 思考等级同理：当前对话尚无自己的等级 → 把此刻显示的「最近使用」定格为本对话等级并落库，免得在别的
  // 对话里一切换、这里也跟着变。须等模型配置载入（ready）：此前 activeEffort 还是初值 'default'，会误定格。
  useEffect(() => {
    const sid = currentSessionId
    if (!sid || currentBinding.effort || !modelsReady || isMemberSession(sid)) return
    setBinding(sid, { effort: activeEffort })
    if (allSessions.some((s) => s.id === sid))
      void (async () => {
        await window.deva.chat.setEffort({ sessionId: sid, effort: activeEffort })
        await refreshSessions()
      })()
    // 已定格的对话首行即返回，activeEffort 之后再变也不会改写它。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, currentBinding.effort, modelsReady])

  // 草稿会话：当前会话尚未落库（不在 sessions 里）但已绑定身份（有 personaId）→ 合成一条会话元信息，
  // 让左侧聊天列表在首发前就显示这条「空对话」。首发后主进程惰性建档、refreshSessions 把同 id 的真值并入
  // sessions，本值随之转 null，列表项按 id 无缝接管（草稿标题「未命名」→ 真实标题）。
  const draftSession = useMemo<SessionMeta | null>(() => {
    const id = currentSessionId
    if (!id) return null
    if (allSessions.some((s) => s.id === id)) return null // 已落库，无需草稿（成员会话同理）
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
      model: ov.model,
      effort: ov.effort
    }
  }, [currentSessionId, allSessions, bindings])

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
      const meta = allSessions.find((s) => s.id === sid)
      const sessionModelRef = ov && ov.model !== undefined ? ov.model : meta?.model
      const model = findActive(providers, sessionModelRef ?? null) ?? activeModel

      // 未选模型：只弹 toast，对话流不动（不加用户气泡、不留红框）。一个可用模型都没有时，
      // 对话区正显示「接入模型」引导卡，提示改为指向它（而非让新用户去翻设置页）。
      const noModel = (): false => {
        const msg = hasUsableModel(providers) ? t('chat.noModel') : t('chat.setup.noModel')
        toast.show({ variant: 'warning', message: msg, duration: 6000 })
        return false
      }
      const sendFailed = (msg: string): false => {
        // 主进程 handler 抛的错经 IPC 传回时带着「Error invoking remote method 'chat:xxx': Error: 」前缀，去掉只留原因。
        const reason = msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
        toast.show({ variant: 'error', title: t('chat.error'), message: reason, duration: 8000 })
        return false
      }

      // 手动 /compact：不加用户气泡（该指令不该留在历史里），只挂一个助手提示位，
      // 直接请主进程压缩历史；结果（成功 / 无需压缩 / 失败）经 compacted 事件弹 toast，并撤掉这个助手位。
      if (body.toLowerCase() === '/compact' && atts.length === 0) {
        if (!model) return noModel()
        patchRuntime(sid, (r) => ({
          ...r,
          messages: [...r.messages, { id: genId(), role: 'assistant', blocks: [] }],
          streaming: true,
          turnId: null,
          startedAt: Date.now(),
          reconnecting: null,
          compacting: false,
          external: false
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
        // 文件夹与只给位置的文件带上绝对路径（贴片悬停显示，同主进程重建；这两种重建后没有大小，这里也不写）；
        // 图片记下本地路径（file）供取缩略图 / 原图——重载后改由主进程给的 ref 定位。其余文件的路径是临时落盘位置，不带。
        attachments: atts.length
          ? atts.map((a) => ({
              name: a.name,
              kind: a.kind,
              ...(a.size !== undefined && a.kind !== 'folder' && a.kind !== 'file' ? { size: a.size } : {}),
              ...(a.kind === 'folder' || a.kind === 'file' ? { path: a.path } : {}),
              ...(a.kind === 'image' ? { file: a.path } : {})
            }))
          : undefined
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
        reconnecting: null,
        compacting: false,
        external: false
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
          modelRef: `${model.provider.id}:${model.model.id}`,
          // 本对话思考等级：同 modelRef 恒记下这一轮实际使用的等级（尚未定格则取「最近使用」）。
          effort: binding?.effort ?? meta?.effort ?? activeEffort
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

    // 回合进行中插入（见 ChatContextValue.insert）。模型只在来不及送达、改作下一轮发出时用作回落，解析同 send。
    const insert = async (text: string): Promise<boolean> => {
      const sid = sessionIdRef.current
      const body = text.trim()
      if (!body) return false
      const ov = bindingsRef.current.get(sid)
      const meta = allSessions.find((s) => s.id === sid)
      const sessionModelRef = ov && ov.model !== undefined ? ov.model : meta?.model
      const model = findActive(providers, sessionModelRef ?? null) ?? activeModel
      if (!model) {
        const msg = hasUsableModel(providers) ? t('chat.noModel') : t('chat.setup.noModel')
        toast.show({ variant: 'warning', message: msg, duration: 6000 })
        return false
      }
      try {
        const r = await window.deva.chat.insert({
          sessionId: sid,
          text: body,
          model: {
            adapter: model.provider.adapter as 'anthropic' | 'openai' | 'responses',
            providerId: model.provider.id,
            baseURL: model.provider.apiHost,
            model: model.model.id
          }
        })
        if (r.ok) return true
        // 回合恰好已经结束：照常发出，开始新的一轮。
        if (r.reason === 'idle') return send(body)
        if (r.reason === 'busy') toast.show({ variant: 'warning', message: t('chat.insert.busy') })
        return false
      } catch (e) {
        toast.show({ variant: 'error', title: t('chat.error'), message: (e as Error)?.message ?? String(e), duration: 8000 })
        return false
      }
    }

    const withdrawInserts = async (): Promise<string> => {
      try {
        return (await window.deva.chat.withdrawInserts(sessionIdRef.current)).text
      } catch {
        return ''
      }
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
      // 成员会话的文件夹以主进程为准（挂 / 卸同时写回主对话的成员名单）：不写覆盖层，随刷新取落库值。
      if (!isMemberSession(sid)) setBinding(sid, { focusRoot: path })
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
        const r = await window.deva.chat.setModel({ sessionId: sid, modelRef })
        await refreshSessions()
        // 已落库：撤掉覆盖层里的模型，此后以主进程为准——定时任务对话的模型还会被任务表单改（两边同步），
        // 覆盖层留着会把那次改动挡住。期间又切了别的模型（覆盖层已不是这个值）就不动，等那次落库再撤。
        if (r.ok && bindingsRef.current.get(sid)?.model === modelRef) {
          const { model: _persisted, ...rest } = bindingsRef.current.get(sid) ?? {}
          const map = new Map(bindingsRef.current)
          map.set(sid, rest)
          bindingsRef.current = map
          setBindings(map)
        }
      })()
    }

    // 设置当前对话思考等级：同 setSessionModel——覆盖层即时置位，立即落库（惰性未建档的会话随首发落库）。
    const setSessionEffort = (level: EffortLevel): void => {
      const sid = sessionIdRef.current
      setBinding(sid, { effort: level })
      void (async () => {
        await window.deva.chat.setEffort({ sessionId: sid, effort: level })
        await refreshSessions()
      })()
    }

    const selectSession = (id: string): void => {
      if (id === sessionIdRef.current) return
      setCurrent(id)
      // 已有活动态（正在流式或此前已载入）→ 直接呈现，绝不重载冲掉实时内容。
      if (runtimesRef.current.has(id)) return
      void attachSession(id)
    }

    const deleteSession = (id: string): void => {
      // 删除正在跑的会话：主进程删除时先中止其回合（含本层没打开过的后台回合），这里只移除其活动态。
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
        // 删的是当前会话：打开列表第一条（不含已归档）或起新会话。
        if (id === sessionIdRef.current) openFirstSession(list)
      })()
    }

    // 重命名：非空的新名字先就地显示（免得旧标题闪一下），再以主进程落盘后回传的最终标题为准
    // （空 → 恢复的自动标题）。只改这一项，不重新拉列表、不重排。
    const renameSession = (id: string, title: string): void => {
      const setTitle = (next: string): void =>
        setSessions((list) => list.map((s) => (s.id === id ? { ...s, title: next } : s)))
      const typed = title.replace(/\s+/g, ' ').trim()
      if (typed) setTitle(typed)
      void (async () => {
        const r = await window.deva.chat.renameSession({ sessionId: id, title })
        if (r) setTitle(r.title)
      })()
    }

    // 归档 / 取消归档：先就地改标记（列表立刻移走 / 移回），再落盘；失败（尚未建档）则以主进程清单为准。
    // 归档的是当前对话：右侧随之离开，与删除一样打开列表第一条。归档即清掉它的未读（取消归档也不恢复）。
    const setArchived = (id: string, archived: boolean): void => {
      setSessions((list) =>
        list.map((s) => (s.id === id ? { ...s, archived: archived || undefined } : s))
      )
      if (archived)
        setUnread((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      if (archived && id === sessionIdRef.current)
        openFirstSession(sessions.filter((s) => s.id !== id))
      void (async () => {
        const r = await window.deva.chat.setArchived({ sessionId: id, archived })
        if (!r.ok) void refreshSessions()
      })()
    }

    // 批量删除（删角色时清其名下全部对话）：逐条落盘删除（主进程顺带中止在跑回合）→ 清绑定覆盖层 →
    // 只刷新一次列表；当前会话若在删除集内，打开列表第一条或起新会话。与单条 deleteSession 同语义，
    // 但合并刷新、避免 N 条并发各自 listSessions/切换互相打架。
    const deleteSessions = (ids: string[]): void => {
      if (ids.length === 0) return
      const idSet = new Set(ids)
      // 正在跑的回合由主进程删除时一并中止（见 deleteSession）。
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
        // 删的集合含当前会话：打开列表第一条（不含已归档）或起新会话。
        if (idSet.has(sessionIdRef.current)) openFirstSession(list)
      })()
    }

    // 按「轮」删除当前会话的部分对话（同步删上下文）。主进程重写 messages 并重建展示气泡，此处就地替换。
    // 流式中不删（该会话正被 Agent 循环原地改写 messages）；主进程另有同样的检查（挡住主进程自己起的轮），
    // 被拒时回 null。删的必是当前会话（选择态只在当前对话内）。返回是否已删。
    const deleteTurns = async (turnIndices: number[]): Promise<boolean> => {
      if (turnIndices.length === 0) return false
      const id = sessionIdRef.current
      if (runtimesRef.current.get(id)?.streaming) return false
      const path = projectPathRef.current
      const dms = await window.deva.chat.deleteTurns(id, path, turnIndices)
      if (!dms) return false
      if (sessionIdRef.current !== id) return true
      patchRuntime(id, (r) => ({ ...r, messages: displayToMessages(dms) }))
      // updatedAt 变了 → 刷新左侧列表使排序即时更新（标题不重算，保持稳定）。
      const list = await window.deva.chat.listSessions(path)
      if (projectPathRef.current !== path) return true
      setSessions(list)
      return true
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

    const respondAsk = (key: string, answers: string[], sessionId?: string): void => {
      const sid = sessionId ?? sessionIdRef.current
      void window.deva.chat.respondAsk({ key, answers })
      dropPendingCard(sid, key)
      patchCardBlocks(sid, (blocks) =>
        blocks.map((b) => (b.kind === 'ask' && b.key === key ? { ...b, answers } : b))
      )
    }

    const respondPlan = (
      key: string,
      decision: 'approve' | 'keep' | 'ignore',
      feedback?: string,
      sessionId?: string
    ): void => {
      const sid = sessionId ?? sessionIdRef.current
      dropPendingCard(sid, key)
      const fb = decision === 'keep' ? feedback?.trim() || undefined : undefined
      // 计划卡属当前所视会话 → 就地收敛为已决态（连同回复一起回显）。
      patchCardBlocks(sid, (blocks) =>
        blocks.map((b) =>
          b.kind === 'plan' && b.key === key
            ? { ...b, decided: decision, ...(fb ? { feedback: fb } : {}) }
            : b
        )
      )
      // 主进程回 {ok:false} = 这把待决键已经没人接了（回合早已结束）→ 把卡片改记为「已取消」，
      // 而不是留一个看起来生效、实则什么都没发生的「已批准」。
      void (async () => {
        const r = await window.deva.chat.respondPlan({ key, decision, ...(fb ? { feedback: fb } : {}) })
        if (r?.ok) return
        patchCardBlocks(sid, (blocks) =>
          blocks.map((b) =>
            b.kind === 'plan' && b.key === key ? { ...b, decided: 'cancelled' as const } : b
          )
        )
      })()
    }

    const respondMount = (key: string, path: string | null, sessionId?: string): void => {
      const sid = sessionId ?? sessionIdRef.current
      void window.deva.chat.respondMount({ key, path })
      // 主进程已就地把 session.focusRoot 设为该目录；渲染层覆盖层必须同步，否则下次 send 会覆盖回去。
      // 为成员选的文件夹不是本对话的工作区、成员会话的文件夹写回名单（主进程处理），都不动覆盖层。
      const forMember =
        isMemberSession(sid) ||
        (pendingCards[sid] ?? []).some((c) => c.kind === 'mount' && c.key === key && c.member) ||
        runtimesRef.current
          .get(sid)
          ?.messages.some((m) => m.blocks.some((b) => b.kind === 'mount' && b.key === key && b.member))
      dropPendingCard(sid, key)
      if (path && !forMember) setBinding(sid, { focusRoot: path })
      patchCardBlocks(sid, (blocks) =>
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

    const cancelTodoList = (): void => {
      const sid = sessionIdRef.current
      if (!sid) return
      window.deva.chat
        .cancelTodoList(sid)
        .then((st) => setTodoState(sid, st))
        .catch(() => undefined)
    }

    const stopSubagent = (toolId: string): void => {
      const sid = sessionIdRef.current
      if (!sid) return
      void window.deva.chat.stopSubagent(sid, toolId).catch(() => undefined)
    }

    const removeMember = (sessionId: string, memberSessionId: string): void => {
      void window.deva.chat.removeMember(sessionId, memberSessionId).catch(() => undefined)
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
      renameSession,
      setArchived,
      deleteSessions,
      deleteTurns,
      rewindApply,
      rewindUndo,
      currentBinding,
      draftSession,
      mountFocus,
      setSessionModel,
      setSessionEffort,
      pendingCards,
      respondAsk,
      respondPlan,
      respondMount,
      resolveProposal,
      resolveAutotask,
      todos: todoStates.get(currentSessionId) ?? EMPTY_TODOS,
      cancelTodoList,
      stopSubagent,
      removeMember,
      insert,
      pendingInserts: insertStates.get(currentSessionId) ?? NO_INSERTS,
      memberProgress: progressStates.get(currentSessionId) ?? NO_PROGRESS,
      withdrawInserts,
      onInsertsReturned
    }
  }, [
    sessions,
    allSessions,
    pendingCards,
    dropPendingCard,
    currentSessionId,
    todoStates,
    setTodoState,
    insertStates,
    progressStates,
    messages,
    streaming,
    streamStatus,
    sessionStates,
    currentBinding,
    draftSession,
    activeModel,
    activeEffort,
    providers,
    t,
    toast,
    startFresh,
    openFirstSession,
    setBinding,
    refreshSessions,
    patchRuntime,
    patchMessages,
    patchCardBlocks,
    dropRuntime
  ])

  // 拆开下发（见 ChatActions）。ref 在渲染时更新：子组件本次渲染里拿到的操作函数，转调的就是本次渲染的实现。
  const latest = useRef(value)
  latest.current = value
  const actions = useMemo(() => bindActions(latest), [])
  const state = useMemo<ChatState>(
    () => ({
      sessions: value.sessions,
      currentSessionId: value.currentSessionId,
      streaming: value.streaming,
      sessionStates: value.sessionStates,
      currentBinding: value.currentBinding,
      draftSession: value.draftSession,
      pendingCards: value.pendingCards,
      todos: value.todos,
      pendingInserts: value.pendingInserts,
      memberProgress: value.memberProgress
    }),
    [
      value.sessions,
      value.currentSessionId,
      value.streaming,
      value.sessionStates,
      value.currentBinding,
      value.draftSession,
      value.pendingCards,
      value.todos,
      value.pendingInserts,
      value.memberProgress
    ]
  )
  const stream = useMemo<ChatStream>(
    () => ({ messages: value.messages, streaming: value.streaming, streamStatus: value.streamStatus }),
    [value.messages, value.streaming, value.streamStatus]
  )

  return (
    <ChatActionsContext.Provider value={actions}>
      <ChatStateContext.Provider value={state}>
        <ChatStreamContext.Provider value={stream}>
          {children}
        </ChatStreamContext.Provider>
      </ChatStateContext.Provider>
    </ChatActionsContext.Provider>
  )
}

/** 操作函数（引用恒定）。 */
export function useChatActions(): ChatActions {
  const ctx = useContext(ChatActionsContext)
  if (!ctx) throw new Error('useChatActions 必须在 ChatProvider 内使用')
  return ctx
}

/** 流式输出期间不变的状态（对话列表、活动态、当前绑定、交互卡、清单等）。 */
export function useChatState(): ChatState {
  const ctx = useContext(ChatStateContext)
  if (!ctx) throw new Error('useChatState 必须在 ChatProvider 内使用')
  return ctx
}

/** 当前对话的消息与流式状态（每帧都可能变）。 */
export function useChatStream(): ChatStream {
  const ctx = useContext(ChatStreamContext)
  if (!ctx) throw new Error('useChatStream 必须在 ChatProvider 内使用')
  return ctx
}
