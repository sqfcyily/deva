import type { ActionValue, NoticeView, PromptView, ReplyView, TurnPage } from '../../../shared/remote-views'

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

export type Platform = 'feishu' | 'telegram' | 'web'

/** 一个「通道」= 用户添加的一个机器人实例（同一平台可以有多个），id 由 Deva 生成。 */
export type ChannelId = string

/** 某机器人的一个会话（私聊）。chatId 为平台原生 id（飞书 chat_id / Telegram chat.id）。 */
export interface ChatAddress {
  channel: ChannelId
  chatId: string
}

/** 平台上的发信人。id 为平台内稳定用户 id（飞书 open_id / Telegram user.id），用作配对白名单键。 */
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
  /** 这条消息本身的句柄（指令消息用完后由 hub 删掉）；平台不允许机器人删用户消息时留空。 */
  messageId?: MessageHandle
  /** 这条消息的平台 id（「正在输入」提示挂在它上面，见 startTyping）；与 messageId 不同，不表示能删。 */
  ref?: MessageHandle
}

/**
 * 卡片按钮 / 表单提交带回的动作（适配器把平台回调解成此形状）。
 * 按钮的 value 由 hub 生成（见 ActionValue），适配器只负责原样塞进按钮、回调时原样还回来。
 */
export interface InboundAction {
  chat: ChatAddress
  user: RemoteUser
  value: ActionValue
  /** 按钮所在的那条消息。 */
  messageId?: MessageHandle
  /** 表单字段（问答卡提交时）：字段名 → 文本或多选数组。 */
  form?: Record<string, string | string[]>
}

/** 动作处理结果：适配器据此给出平台内的即时反馈（飞书 toast / Telegram 按钮提示）。 */
export interface ActionResult {
  ok: boolean
  message: string
}

// ───────── 出站视图（定义在 shared/remote-views.ts，手机网页端共用）─────────

export type { ActionValue, NoticeView, PromptView, ReplyView, TurnBlock, TurnPage, TurnStatus } from '../../../shared/remote-views'

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
  sendNotice(chat: ChatAddress, view: NoticeView): Promise<MessageHandle | undefined>
  /** 发一条聊天式回复（普通消息，不是卡片；超长由 hub 先分好段，一段一条）。 */
  sendReply(chat: ChatAddress, view: ReplyView): Promise<MessageHandle | undefined>
  /**
   * 显示「正在输入」：Telegram 用输入状态（持续刷新到 stopTyping）；飞书没有输入状态接口，改在 anchors
   * （这一轮要回应的用户消息）上挂表情回应。可重复调用：已经挂上的不重复挂。
   */
  startTyping(chat: ChatAddress, anchors: MessageHandle[]): Promise<void>
  /** 收起 startTyping 的提示。失败不抛错。 */
  stopTyping(chat: ChatAddress, anchors: MessageHandle[]): Promise<void>
  /** 删除一条消息（指令与回执用完即删）。失败抛错，由 hub 忽略。 */
  deleteMessage(chat: ChatAddress, handle: MessageHandle): Promise<void>
  /** 按用户 id 主动发起私聊（扫码创建后机器人先打招呼），返回该私聊的 chatId。 */
  openDirect(userId: string, view: NoticeView): Promise<string | undefined>
}
