import type { AskQuestion } from '../chat'

/**
 * 远程通道契约（平台无关）。
 *
 * 分层：
 *  · hub.ts（平台无关）：订阅会话总线、按 IM 会话 ↔ Deva 对话的绑定聚合回合视图、解析指令、鉴权配对、
 *    把答复回送 chatRuntime。所有业务规则只写一次。
 *  · 各平台适配器（feishu.ts，以后的 telegram.ts …）：只负责「连上平台 / 收消息 / 把视图渲染成该平台的
 *    消息并发送或更新」。不碰会话、不做鉴权判定、不解析指令。
 *
 * 新增平台 = 实现一个 RemoteAdapter + 在 index.ts 的 ADAPTERS 里登记，hub 不用改。
 */

export type Platform = 'feishu'

/** 一个「通道」= 用户添加的一个机器人实例（同一平台可以有多个），id 由 Deva 生成。 */
export type ChannelId = string

/** 某机器人的一个会话（私聊）。chatId 为平台原生 id（飞书 chat_id）。 */
export interface ChatAddress {
  channel: ChannelId
  chatId: string
}

/** 平台上的发信人。id 为平台内稳定用户 id（飞书 open_id），用作配对白名单键。 */
export interface RemoteUser {
  id: string
  name?: string
}

export interface InboundMessage {
  chat: ChatAddress
  user: RemoteUser
  /** 纯文本（适配器已去掉 @ 提及等平台标记）；非文本消息为空串 + kind 标明。 */
  text: string
  kind: 'text' | 'unsupported'
}

/**
 * 卡片按钮 / 表单提交带回的动作（适配器把平台回调解成此形状）。
 * 按钮的 value 由 hub 生成（见 ActionValue），适配器只负责原样塞进按钮、回调时原样还回来。
 */
export interface InboundAction {
  chat: ChatAddress
  user: RemoteUser
  value: ActionValue
  /** 表单字段（问答卡提交时）：字段名 → 文本或多选数组。 */
  form?: Record<string, string | string[]>
}

export type ActionValue =
  | { k: 'ask'; key: string }
  | { k: 'plan'; key: string; d: 'approve' | 'keep' }
  | { k: 'mount'; key: string }
  | { k: 'use'; sid: string }
  /** 名片决议：带 sid + 工具调用 id，处理时从会话历史里取草稿（无状态，重启后按钮照样有效）。 */
  | { k: 'autotask'; sid: string; tool: string; a: 'create' | 'dismiss' }
  | { k: 'agent'; sid: string; tool: string; a: 'accept' | 'reject' }
  | { k: 'stop'; turn: string }

/** 动作处理结果：适配器据此给出平台内的即时反馈（飞书 toast）。 */
export interface ActionResult {
  ok: boolean
  message: string
}

// ───────── 出站视图（hub 产出，适配器渲染）─────────

export type TurnBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      /** 一句话参数摘要（路径 / 命令 …），已截短。 */
      brief: string
      status: 'running' | 'ok' | 'error'
      summary?: string
    }
  | { kind: 'subagent'; id: string; agent: string; desc: string; steps: number; status: 'running' | 'ok' | 'error' }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }

export type TurnStatus = 'running' | 'waiting' | 'retrying' | 'done' | 'aborted' | 'error'

/**
 * 一轮回复的实时视图。内容过长时 hub 分页（每页一条平台消息），适配器只渲染单页。
 * 只有末页带状态与操作按钮；前面的页是已定格的正文。
 */
export interface TurnPage {
  turnId: string
  sessionTitle: string
  personaName: string
  index: number
  /** 是否末页（显示状态、耗时、停止按钮）。 */
  last: boolean
  blocks: TurnBlock[]
  status: TurnStatus
  /** 状态补充（重连进度 / 中断原因 …）。 */
  statusText?: string
  elapsedSec: number
}

export type PromptView =
  | {
      kind: 'ask'
      key: string
      sessionTitle: string
      questions: AskQuestion[]
      state: 'open' | 'answered' | 'cancelled'
      answers?: string[]
    }
  | {
      kind: 'plan'
      key: string
      sessionTitle: string
      plan: string
      state: 'open' | 'approve' | 'keep' | 'cancelled'
    }
  | {
      kind: 'mount'
      key: string
      sessionTitle: string
      tool: string
      path: string
      state: 'open' | 'mounted' | 'skipped' | 'cancelled'
      root?: string
    }
  /** 定时任务确认名片（key = create_task 的工具调用 id）。 */
  | {
      kind: 'autotask'
      key: string
      sessionId: string
      sessionTitle: string
      title: string
      prompt: string
      /** 日程人读摘要；日程无效时为 null，error 给原因。 */
      schedule: string | null
      nextRunAt: number | null
      personaName: string
      modelName: string
      state: 'open' | 'created' | 'dismissed'
      error?: string
    }
  /** 角色名片（key = propose_agent 的工具调用 id）。 */
  | {
      kind: 'agent'
      key: string
      sessionId: string
      sessionTitle: string
      name: string
      desc: string
      prompt: string
      state: 'open' | 'accepted' | 'rejected'
    }

/** 一条通知（指令回执 / 定时任务完成 …）。buttons 为可选的快捷动作。 */
export interface NoticeView {
  title?: string
  text: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  buttons?: { label: string; value: ActionValue; primary?: boolean }[]
  /** row = 按钮横排一行（少量快捷动作）；column = 每个按钮独占一行、撑满宽度（列表选择）。 */
  buttonLayout?: 'row' | 'column'
}

/** 适配器发出的消息句柄（平台 message_id），供后续原地更新。 */
export type MessageHandle = string

export type ChannelState = 'off' | 'connecting' | 'connected' | 'error'

/** hub 交给适配器的回调与运行环境。 */
export interface AdapterHost {
  onMessage(msg: InboundMessage): void
  onAction(action: InboundAction): Promise<ActionResult>
  onState(state: ChannelState, error?: string): void
}

export interface RemoteAdapter {
  readonly id: ChannelId
  readonly platform: Platform
  /** 两次原地更新同一条消息的最小间隔（平台限频）。 */
  readonly minUpdateMs: number
  /** 单页正文的字符预算（平台消息体积上限换算，hub 据此分页）。 */
  readonly pageChars: number
  start(host: AdapterHost): Promise<void>
  stop(): Promise<void>
  /** 发新消息（返回句柄）或原地更新（给了 handle）。失败抛错，由 hub 记日志。 */
  renderTurn(chat: ChatAddress, page: TurnPage, handle?: MessageHandle): Promise<MessageHandle | undefined>
  renderPrompt(chat: ChatAddress, view: PromptView, handle?: MessageHandle): Promise<MessageHandle | undefined>
  sendNotice(chat: ChatAddress, view: NoticeView): Promise<void>
  /** 按用户 id 主动发起私聊（扫码创建后机器人先打招呼），返回该私聊的 chatId。 */
  openDirect(userId: string, view: NoticeView): Promise<string | undefined>
}
