/**
 * 聊天 IPC 协议：主进程、preload 与渲染层共用的请求 / 展示消息 / 流事件类型。
 * 原先三处各抄一份，已出现漂移（如 preload 缺 insert 块），改为只在这里定义。
 * 只放类型，不引用主进程模块（渲染层的 web 编译也要读它）。
 */

import type { AgentDraft, AutotaskDraft } from './drafts'
import type { EffortLevel } from './effort'

// ── 被协议引用的小类型（原定义处已改为从这里再导出）──

/**
 * 归一化的终止原因。
 * 'refusal' = 模型拒绝作答、或被服务端内容策略拦截（OpenAI finish_reason 'content_filter' /
 * 智谱 'sensitive' / Anthropic stop_reason 'refusal'）。**必须与 end_turn 区分**：这类回合同样「自然结束且无正文」，
 * 混作 end_turn 会让空回合被一律归咎于「上下文接近上限」，给出完全错误的排查方向。
 * 'step_limit' / 'repeated' = 引擎层的终止原因（与 aborted / error 同属循环层，服务端不会给）：定时任务达到
 * 单次运行的步数上限 / 同一工具同参数同结果连续出现到上限（原地打转），收尾后停下（见 shared/limits.ts）。
 * 'degenerate' 同属引擎层：回复（正文或思考）陷入逐字复读，重试后仍如此，截掉复读段后停下（见 repetition.ts）。
 * **同样必须与 end_turn 区分**：任务没做完，运行记录须记失败而非成功，对话里也要留下说明。
 */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop'
  | 'refusal'
  | 'aborted'
  | 'error'
  | 'step_limit'
  | 'repeated'
  | 'degenerate'

export type CompactStatus = 'compacted' | 'none' | 'failed'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

/** 折叠后的一个清单（推给渲染层的形态）。 */
export interface TodoList {
  id: string
  title: string
  items: TodoItem[]
  createdAt: number
  updatedAt: number
}

/** 推给渲染层的状态：胶囊要显示的当前清单（无则 null）。较早的清单不展示，故不下发。 */
export interface TodoState {
  active: TodoList | null
}

/** 一次交接在主对话里的展示信息（见 chat.ts DisplayMessage.handoff）。 */
export interface HandoffInfo {
  /** 任务名。 */
  title: string
  /** 一句话摘要（居中一行上显示）。 */
  summary: string
  /** 全文（点开看）。 */
  content: string
  /** 需要主角色处理（已唤醒它）；false = 只是告知。 */
  needsAction: boolean
}

/** 成员一次任务的结局。 */
export type MemberRunStatus = 'done' | 'failed' | 'stopped'

/**
 * 要主智能体汇总的一组派发（同一主轮派出、report_to_me）的进度：主对话里显示「前端已完成」「2 位成员已完成」
 * 的居中提示（带已完成成员的头像），全部交差时整组消失、主智能体开始汇总。items 里已交差的在前（按交差先后），
 * 还在做的（running）在后；sid 是成员会话 id（渲染层据此画头像）。
 */
export type MemberProgressGroup = {
  items: { sid: string; name: string; status: MemberRunStatus | 'running' }[]
}

/** 成员会话里主智能体派来的任务（见 members.ts MEMBER_TASK_MARKER）：工作记录里画成「X 派来的任务」。 */
export interface MemberTask {
  owner: string
  title: string
  quote: string
  note: string
}

// ── 请求 ──

export type AdapterKind = 'anthropic' | 'openai' | 'responses'

export interface ChatModelConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
  model: string
}

export interface ChatSendRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
  workspaceRoot: string | null
  /** 用户经原生选择框挑选的附件绝对路径（正文由主进程读取，base64 不经渲染层）。 */
  attachments?: string[]
  /**
   * 对话优先外壳：本对话绑定的 persona id（首发落库时绑定，一对话一身份）。
   * 缺省 = 不绑定（旧对话），本轮按默认角色执行。
   */
  personaId?: string
  /**
   * 本对话的聚焦工作区绝对路径；null/缺省 = 全机通用助手（无聚焦）。
   * 「挂载目录」是纯粹的对话属性：决定聚焦工作区、终端 cwd、权限作用域键，与「对话存哪里/列不列」无关
   * （对话已无分桶概念）。
   */
  focusRoot?: string | null
  /**
   * 本对话的模型引用 `"providerId:modelId"`；缺省 = 不改（沿用会话已存值）；空串 = 显式回落全局默认。
   * **快照固定 / 只改当前对话**：新建对话由渲染层带上角色偏好快照；聊天中切换模型即随本字段更新（仅本
   * 对话）。runTurn 经 resolveModelRef(session.model, model) 解析，删除的模型自动回落 model（全局默认）。
   */
  modelRef?: string
  /** 本对话生效的思考等级：发送时恒带上并落库（同 modelRef，防别处切换串到本对话）；缺省 = 不改。 */
  effort?: EffortLevel
}

/**
 * 回合进行中插入一条消息（见 chat:insert）：当前步骤结束、下一次请求模型之前交给模型；来不及（模型已在写
 * 最后的回复）就在本轮结束后作为普通消息发出。model 只在后一种情况下用作回落（同 chat:send）。
 */
export interface ChatInsertRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
}

/**
 * idle = 该对话此刻没有回合在跑（刚结束）：调用方改走普通发送；
 * busy = 正在跑的回合不接受插入（定时任务、压缩、回滚）；empty = 正文为空。
 */
export type ChatInsertResult = { ok: true } | { ok: false; reason: 'idle' | 'busy' | 'empty' }

/** 手动 /compact 请求：无用户文本、无后续模型轮，只压缩历史并回发结果事件。 */
export interface ChatCompactRequest {
  sessionId: string
  model: ChatModelConfig
  workspaceRoot: string | null
}

/**
 * 执行回滚（见 chat:rewind-apply）。mode：both=代码与对话 / conversation=仅对话 / code=仅代码。
 * force = 用户勾选「仍然覆盖」的冲突文件路径——主进程只认重算出的计划里确为冲突的那些。
 */
export interface ChatRewindApplyRequest {
  sessionId: string
  turn: number
  mode: 'both' | 'conversation' | 'code'
  force?: string[]
}

/** 立即建档一条空对话（对话优先外壳：绑定信息随之落库，首发前即持久化）。见 chat:create-session。 */
export interface ChatCreateSessionRequest {
  sessionId: string
  workspaceRoot: string | null
  personaId?: string
  focusRoot?: string | null
  modelRef?: string
}

/** 对话输入框切换本对话模型（立即落库，不等下一次发送）。见 chat:set-model。 */
export interface ChatSetModelRequest {
  sessionId: string
  modelRef: string
}

/** 对话输入框切换本对话思考等级（立即落库，不等下一次发送）。见 chat:set-effort。 */
export interface ChatSetEffortRequest {
  sessionId: string
  effort: EffortLevel
}

/** 挂载 / 卸载本对话的聚焦工作区（立即落库，不等下一次发送）。见 chat:set-focus。 */
export interface ChatSetFocusRequest {
  sessionId: string
  focusRoot: string | null
}

/** 重命名对话（立即落库）；title 为空即恢复自动标题。见 chat:rename-session。 */
export interface ChatRenameSessionRequest {
  sessionId: string
  title: string
}

/** 归档 / 取消归档对话（立即落库）。见 chat:set-archived。 */
export interface ChatSetArchivedRequest {
  sessionId: string
  archived: boolean
}

/**
 * chat:resolve-autotask 的返回：create 成功带已建任务 id；dismiss 成功；失败带稳定错误码（渲染层本地化）。
 * 错误码含 createTask 的全部码 + 编排层的 no-session / no-input。
 */
export type ResolveAutotaskResult =
  | { ok: true; status: 'created'; taskId: string }
  | { ok: true; status: 'dismissed' }
  | {
      ok: false
      error:
        | 'invalid-input'
        | 'invalid-tz'
        | 'invalid-cron'
        | 'invalid-once'
        | 'expired'
        | 'no-session'
        | 'no-input'
    }

// ── 展示消息（主进程从对话记录重建，渲染层据此画气泡）──

/** 用户消息上的附件贴片（名称 + 类型；文件夹另带绝对路径，供悬停显示）。 */
export interface AttachmentChip {
  name: string
  /** file = 只把位置交给模型的文件（见 attachments.ts ATTACH_PATH_PREFIX），带 path。 */
  kind: 'image' | 'document' | 'text' | 'folder' | 'file'
  path?: string
  /** 文件大小（字节；文件夹没有）：附件卡片上显示「PDF · 1.2 MB」。 */
  size?: number
  /**
   * 图片在对话记录里的位置「消息下标:内容块下标:指纹」（见 imageRef）：界面据此取缩略图与原图
   * （chat:attachment-image），不随展示消息回传 base64。
   */
  ref?: string
}

/** 重建历史用的展示消息（主进程从 provider Message[] 归约，去掉 base64 负载）。 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  /** status=running 仅见于仍在后台运行的子智能体 Task 卡（见 backgroundSubagents）。 */
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error' | 'running'; summary?: string }
  /**
   * 弱化提示气泡：truncated=达输出上限被截断 / empty=通篇无回复 / restored=仅回滚了代码 /
   * aborted=用户中止了本轮（由 StoredNotice 边车还原）。
   */
  | {
      kind: 'notice'
      code: 'truncated' | 'empty' | 'refused' | 'restored' | 'aborted' | 'step_limit' | 'repeated' | 'degenerate'
    }
  /**
   * 压缩提示（由 messages 里的摘要标记还原），摘要正文默认折叠。两轮之间压缩：自成一条，分隔线 +「以上对话
   * 已压缩为摘要」（first = 前面没有任何消息，旧版压缩删掉了原文，改写「较早的对话已压缩为摘要」）。
   * 一轮进行中压缩：steps 有值，是这一轮执行步骤里的一个节点（「此前 N 步已压缩为摘要」）。
   */
  | { kind: 'compaction'; summary: string; steps?: number; first?: boolean }
  /** 请求失败红框：由 StoredNotice 边车还原（原样展示错误文案）。 */
  | { kind: 'error'; message: string }
  /** 角色名片：propose_agent 的提议。status 终态（accepted/rejected）由 StoredSession.proposals 边车持久化。 */
  | { kind: 'agentcard'; id: string; draft: AgentDraft; status: 'pending' | 'accepted' | 'rejected' }
  /**
   * 定时任务确认名片：create_task 的提议。status 终态（created/dismissed）由 StoredSession.autotasks 边车持久化，
   * taskId 记已创建任务 id（供名片「打开该任务会话」跳转）。pending = 待用户在名片里议定授权后创建。
   */
  | {
      kind: 'autotaskcard'
      id: string
      draft: AutotaskDraft
      status: 'pending' | 'created' | 'dismissed'
      taskId?: string
    }
  /**
   * ask_user 询问：重建为问答卡。问题从 tool_use 入参重解析，答案由 StoredSession.asks 边车还原。
   * answers 有值（含空数组）= 已答/已取消（渲染为「已答态·逐题回述」，不可交互）；
   * null = 取消/中止（渲染层归一为空数组作已答态）；undefined = 从未答复（罕见：闭应用于问询挂起时）。
   */
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] | null }
  /**
   * exit_plan 计划卡：重建为**已决**的计划审阅卡。计划正文从 tool_use 入参（input.plan）还原，
   * decision 由 StoredSession.plans 边车还原：'approve'/'keep' = 用户的决定；'cancelled' = 中止 / 未决。
   * **恒为终态、绝不留「待批准」**：历史重建只发生在回合结束之后，主进程的 pendingPlan 待决键早已随
   * 回合解开删除（且重建卡用的是 toolUseId，本就与那把键不同名），此时若还画出按钮，点了必然石沉大海。
   * feedback = 选「继续完善」时用户在卡上写的回复（边车同记）；未写则缺省。
   */
  | {
      kind: 'plan'
      id: string
      plan: string
      decision: 'approve' | 'keep' | 'ignore' | 'cancelled'
      feedback?: string
    }
  /**
   * 已完成的待办清单卡：画在令清单全部完成的那次 todo_write 处，条目取自 todos 边车里该次写入的快照。
   * 其余 todo_write 调用在对话流里不画（进度只在输入框上方的胶囊里显示）。
   */
  | { kind: 'todolist'; id: string; title: string; items: TodoItem[] }
  /** 回合进行中插入的消息（见 INSERT_MARKER）：执行步骤里的一个节点，排在它送达时的两步之间。 */
  | { kind: 'insert'; text: string }

export type DisplayMessage =
  | {
      role: 'user'
      text: string
      attachments: AttachmentChip[]
      /** 后台任务通知（见 NOTIFY_MARKER）：展示为一行系统通知而非用户气泡，text 为其标题。 */
      notify?: true
      /**
       * 成员交差的通知（含 <成员通知>）：不显示（其后主角色的回复就是交差内容），只留作一轮的起点。
       */
      quiet?: true
      /**
       * 成员会话里主智能体派来的任务（见 members.ts MEMBER_TASK_MARKER）：工作记录里画成「X 派来的任务」
       * （任务说明；旧记录还有用户原话），而不是用户气泡。text 为任务说明。
       */
      task?: MemberTask
      /**
       * 绑定的定时任务交来的结果（见 handoff.ts）：需要处理的画成居中一行「任务名 摘要」、点开看全文（其后是主角色
       * 的回复）；只是告知的不显示这一行（quiet），其后那条回复以任务的身份显示。
       */
      handoff?: HandoffInfo
    }
  /** durationMs：本轮耗时（来自 durations 边车），工作过程折叠条据此显示「已处理 X」；未记录则缺省。 */
  | { role: 'assistant'; blocks: DisplayBlock[]; durationMs?: number }

// ── 交互卡 ──

/** ask_user 的候选项（description 为可选补充说明）。 */
export interface AskOption {
  label: string
  description?: string
}

/** ask_user 的单个问题：题干 + 候选项 + 是否多选 + 是否必答。 */
export interface AskQuestion {
  question: string
  options: AskOption[]
  /** true=多选（可勾多项）；false=单选。 */
  multi: boolean
  /** false=可跳过（允许空答，回灌「未作答」交由模型合理默认）；缺省/true=必答。 */
  required: boolean
}

export interface AskResponse {
  key: string
  /** 用户对每个问题的答复（answers[i] 对应 questions[i]，选中项或自由输入）；null 表示取消/中止。 */
  answers: string[] | null
}

/** 用户对 exit_plan 计划审阅的决定：approve=批准并执行 / keep=继续完善。 */
export interface PlanResponse {
  key: string
  decision: 'approve' | 'keep' | 'ignore'
  /** 选「继续完善」时在卡上直接写的回复；缺省 / 空 = 未写，等用户下一条消息再给。 */
  feedback?: string
}

/** 用户对「请求挂载工作区」的回应：path=已选目录（渲染层已经 fs.openFolder 受信）；null=暂不挂载。 */
export interface MountResponse {
  key: string
  path: string | null
}

// ── 流事件（主进程 → 渲染层 / 远程通道）──

/**
 * repetition：回复陷入逐字复读，丢弃本步重试（上下文长时先压缩，见 runAgentLoop 自愈⑤）；
 * output_fit：服务商默认的输出预留让输入 + 预留超窗，改为显式发送输出预算重发（自愈⑥）。
 */
export type AutoRetryReason =
  | 'truncated'
  | 'empty'
  | 'context'
  | 'output_limit'
  | 'effort'
  | 'repetition'
  | 'output_fit'

/** 发往渲染层的富事件（比 provider 的 StreamEvent 多了工具执行/权限阶段）。 */
export type ChatStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /**
   * depth>0 + agent + parent：本事件来自某子智能体（渲染层据此折叠进 parent 指向的那张
   * 「子智能体任务」卡）。parent = 派生它的那次 run_subagent 调用 id —— 多个子智能体**并行**跑时，
   * 唯有按 id 归属才不会把彼此的嵌套事件串进同一张卡。
   * bg：来自后台运行的子智能体，不属于任何回合（turnId 为空串），Task 卡可能在任意一条历史消息里。
   */
  | {
      type: 'tool_call'
      id: string
      name: string
      args: unknown
      depth?: number
      agent?: string
      parent?: string
      bg?: true
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      summary: string
      isError: boolean
      /** depth>0 + agent + parent：来自子智能体的工具结果（折叠进 parent 那张 Task 卡）。 */
      depth?: number
      agent?: string
      parent?: string
      /** 后台子智能体：嵌套结果，或（depth 0）它结束时给自己那张 Task 卡定格的壳结果。 */
      bg?: true
    }
  /** 征求决策/澄清：暂停循环，向用户抛出一个或多个问题，等其一次性作答后回灌为 tool_result。 */
  | { type: 'ask_user'; key: string; questions: AskQuestion[] }
  /** 计划审阅：exit_plan 提交计划，暂停循环等用户批准（approve=批准后按计划执行 / keep=继续完善 / 取消）。 */
  | { type: 'plan_review'; key: string; plan: string }
  /**
   * 待办清单的整体状态（会话级）：每次 todo_write 后、以及按轮删除 / 回滚 / 收起清单后推送。
   * 后几种不属于任何回合，turnId 为空串。
   */
  | { type: 'todos'; state: TodoState }
  /** 本次 todo_write 令清单全部完成：在对话流里落一张「已完成清单」卡（与重开时同形）。 */
  | { type: 'todo_done'; id: string; title: string; items: TodoItem[] }
  /**
   * 请求挂载工作区：本次工具调用缺相对路径基准（未挂载 + 写入类相对路径 / 扫描类省略 path），
   * 暂停循环等用户一键挂载。tool/path 仅供卡片说明「为什么需要」。**不是模型发起的工具**——
   * 由权限闸门前置判定生成（判据见 tools.needsWorkspaceMount），故模型既不占工具槽也无从滥用。
   */
  /** member：为成员选择它负责的文件夹（create_member 的 pick_folder），而不是挂载本对话的工作区。 */
  | { type: 'mount_request'; key: string; tool: string; path: string; member?: string }
  /** 用量。input 为总提示 token（含缓存命中/写入）；cacheRead/cacheWrite 供观测缓存是否生效。 */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  /** 连接中断、正在自动重连（transient；attempt/max 供 UI 显示进度）。 */
  | { type: 'reconnecting'; attempt: number; max: number }
  /** 重连前置：丢弃本步骤已画出的残缺尾部，随后重新流式（无法无缝续传，只能重发本步）。 */
  | { type: 'stream_reset' }
  /**
   * 引擎正在自愈（transient，同 reconnecting 一样显示为状态横幅，任何真实内容到达即收起）：
   * truncated=输出撞上长度上限，已引导模型续写 / 拆小；empty=上一步无任何输出，已追问；
   * context=上下文超限，已压缩后重试；output_limit=输出预算超出模型允许范围，已降档重发；
   * effort=模型 / 网关不认所选思考等级，已去掉该参数重发。
   * limit：context 时 = 报错里解析出的真实窗口（比配置小才带）；output_limit 时 = 降档后的输出上限
   * （仅当被拒的是用户在模型详情页填的值才带）。渲染层据此弹 toast，提示去模型设置里改。
   */
  | { type: 'auto_retry'; reason: AutoRetryReason; attempt: number; max: number; limit?: number }
  | { type: 'error'; kind: string; message: string }
  /**
   * 上下文压缩结果（自动或手动 /compact）。渲染层据此在助手气泡追加软提示块；
   * status: compacted=已压缩 / none=无需压缩 / failed=失败（历史未动）。
   */
  | { type: 'compacted'; scope: 'auto' | 'manual'; status: CompactStatus; message?: string }
  /**
   * 正在压缩上下文（自动、轮中或手动 /compact）：真正开始请求摘要时发 active=true，结束（不论结果）发
   * active=false，成对出现；无可压的那次不发。渲染层据此把底部状态行换成「正在压缩」。结果另见 compacted。
   */
  | { type: 'compacting'; active: boolean }
  /**
   * 某张交互卡（问答 / 计划审阅 / 挂载请求）已被答复——不论答复来自桌面还是远程通道（飞书等）。
   * 同一张卡可能同时显示在多端：先到的答复生效，其余端据此把卡收成已决态，免得留下点了没反应的卡。
   * 回合中止时的批量取消不发此事件（各端在 done 时自行收敛）。
   */
  | {
      type: 'interaction_resolved'
      key: string
      kind: 'ask' | 'plan' | 'mount'
      answers?: string[] | null
      decision?: 'approve' | 'keep' | 'ignore' | null
      /** 计划卡「继续完善」时附的回复。 */
      feedback?: string
      path?: string | null
    }
  /**
   * 角色名片 / 定时任务确认名片已决议（桌面或手机端）。不属于任何回合（名片在回合结束后仍可操作），
   * 故以空 turnId 发出；各端按 sessionId + toolUseId 把同一张名片收成终态。
   */
  | {
      type: 'card_resolved'
      card: 'agent' | 'autotask'
      toolUseId: string
      status: 'accepted' | 'rejected' | 'created' | 'dismissed'
      taskId?: string
    }
  /**
   * 回合开始（总是本轮第一个事件）：带上本轮的用户消息。桌面、手机端、定时任务发起的回合都发——
   * 各端据此把「别处发起的一轮」当本地回合呈现（用户气泡 + 流式 + 可停止）；自己发起的按 turnId 认出并跳过。
   */
  | {
      type: 'turn_start'
      /**
       * notify：本轮由后台任务通知自动发起（见 NOTIFY_MARKER），text 为通知标题；
       * task：成员会话里主智能体派来的任务（见 DisplayMessage）。
       */
      user: {
        text: string
        attachments: AttachmentChip[]
        notify?: true
        quiet?: true
        task?: MemberTask
        handoff?: HandoffInfo
      }
    }
  /** 插入的消息已随本步工具结果交给模型（回合事件）：渲染层在执行步骤里添一个节点。 */
  | { type: 'insert'; text: string }
  /**
   * 该对话待送达的插入消息有变（会话级，以空 turnId 发出）：插入、送达、撤回、回合结束时都发。
   * pending 为各条原文，空数组 = 没有待送达的。
   */
  | { type: 'inserts'; pending: string[] }
  /**
   * 回合被停止或出错，待送达的插入消息不再发出（会话级，空 turnId）：渲染层把 text 放回该对话的输入框。
   */
  | { type: 'inserts_returned'; text: string }
  /** durationMs：本轮耗时（扣除等用户处置的时间），渲染层据此给工作过程折叠条显示「已处理 X」。 */
  | { type: 'done'; stopReason: StopReason; durationMs?: number }
  /**
   * 成员交差已记进主对话、以成员的身份显示（会话级，空 turnId；见 commitMemberReports）：渲染层从主进程重载该对话。
   */
  | { type: 'member_report' }
  /**
   * 主对话里要汇总的成员派发组的进度（会话级，空 turnId；见 emitMemberProgress）：派出、交差时都发，
   * 空数组 = 没有在等的组。渲染层据此在对话末尾显示「前端、后端已完成」。
   */
  | { type: 'member_progress'; groups: MemberProgressGroup[] }
