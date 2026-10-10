import { EventEmitter } from 'node:events'
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
