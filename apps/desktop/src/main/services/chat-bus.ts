import { EventEmitter } from 'node:events'
import type { ChatRemoteChange } from '../../shared/chat-protocol'
import type { ChatStreamEvent } from './chat'

/**
 * 主进程内部事件总线：会话流事件与应用级通知的唯一出口。
 * chat.ts 只管往总线上发，不关心谁在听——渲染层转发（registerChatIpc 内）是一个订阅者，
 * 远程通道（remote/hub.ts：飞书 / 以后的 Telegram …）是另一个。新增出口只需再订阅一次，不改编排层。
 *
 * 订阅者回调里绝不能抛错打断发布方（回合正在补结果 / 落盘），故 publish 逐个 try/catch 隔离。
 */

export interface ChatEventPayload {
  turnId: string
  sessionId: string
  event: ChatStreamEvent
}

/** 应用级通知（定时任务跑完 / 自动暂停 等）：系统通知之外，远程通道据此推送到手机。 */
export interface AppNotice {
  title: string
  body: string
  /** 关联的对话（远程端可一键切过去查看）。 */
  sessionId?: string
  /** 正文只是该对话刚结束那一轮回复的摘要（定时任务跑完）：已把那轮作为正常回复收到的私聊不必再推。 */
  echoesReply?: boolean
}

const bus = new EventEmitter()
// 订阅者数量随通道增长（渲染层 + 每个 IM 适配器），默认上限 10 会误报泄漏。
bus.setMaxListeners(50)

function subscribe<T>(topic: string, listener: (p: T) => void): () => void {
  const safe = (p: T): void => {
    try {
      listener(p)
    } catch (e) {
      console.warn(`[chat-bus] ${topic} 订阅者异常：`, (e as Error)?.message ?? e)
    }
  }
  bus.on(topic, safe)
  return () => bus.off(topic, safe)
}

export function publishChatEvent(p: ChatEventPayload): void {
  bus.emit('chat', p)
}

export function onChatEvent(listener: (p: ChatEventPayload) => void): () => void {
  return subscribe('chat', listener)
}

export function publishAppNotice(n: AppNotice): void {
  bus.emit('notice', n)
}

export function onAppNotice(listener: (n: AppNotice) => void): () => void {
  return subscribe('notice', listener)
}

/**
 * 对话清单在回合之外变了（手机上 /new 建出的空对话、删角色时定时任务对话改挂 Deva）。经回合新建的不必发：首轮 turn_start 已会让渲染层刷新列表。
 */
export function publishSessionsChanged(): void {
  bus.emit('sessions')
}

export function onSessionsChanged(listener: () => void): () => void {
  return subscribe<void>('sessions', listener)
}

/**
 * 一轮进行中又有一步落进了对话记录（助手这一步的正文与工具调用、工具结果，随即落盘）。
 * 流事件先于落盘发出，远程端要按对话记录补拉最新内容时，以这里为准。
 */
export function publishStepSaved(sessionId: string): void {
  bus.emit('step', sessionId)
}

export function onStepSaved(listener: (sessionId: string) => void): () => void {
  return subscribe<string>('step', listener)
}

/** 某对话被看过了（电脑或手机）：手机端据此刷新未读红点。source = 在哪一端看的。 */
export interface ReadChange {
  sessionId: string
  at: number
  source: 'desktop' | 'remote'
}

export function publishReadChanged(c: ReadChange): void {
  bus.emit('read', c)
}

export function onReadChanged(listener: (c: ReadChange) => void): () => void {
  return subscribe<ReadChange>('read', listener)
}

/** 手机等别的设备改了对话（看过 / 删除 / 归档 / 改模型）：转给渲染层同步（见 read-sync.ts）。 */
export function publishRemoteChange(c: ChatRemoteChange): void {
  bus.emit('remote', c)
}

export function onRemoteChange(listener: (c: ChatRemoteChange) => void): () => void {
  return subscribe<ChatRemoteChange>('remote', listener)
}
