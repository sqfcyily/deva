import type { ActionValue, PromptView } from './remote-views'

/**
 * 手机网页端 ⇄ 桌面端的线上协议（JSON 帧，走 WebSocket）。
 *
 * 手机端是桌面 Deva 的 IM 形态：对话列表、角色（通讯录）、单个对话的历史与最终回复。对话记录的真源是
 * 电脑上的对话文件，手机按需拉取；进行中只推「正在做什么」一行状态，回合结束再推一次对话摘要，手机据此刷新。
 *
 * 传输无关：内网直连时手机连桌面端自带的 HTTP 服务（/ws）；经中转时手机连中转、桌面端也连中转，
 * 中转只按桌面 id 原样转发帧（见 apps/relay）。两条路上跑的都是这同一套帧。
 *
 * 鉴权：连上后第一帧必须是 hello（带长期 token）或 pair（带电脑端二维码里的一次性配对码）。
 */

export const WEB_PROTOCOL_VERSION = 2

/** 角色（通讯录里的一行）。avatar = Humation 参数（JSON 串，空 = 按 id 生成）；avatarImage = 上传的图片 data URI。 */
export interface WebPersona {
  id: string
  name: string
  description: string
  model: string
  avatar: string
  avatarImage: string
  enabled: boolean
}

/** 对话（列表里的一行）。busy = 正在处理；waiting = 停下来等你在卡片上决定；status = 进行中的一行提示。 */
export interface WebSession {
  id: string
  title: string
  personaId?: string
  createdAt: number
  updatedAt: number
  /** 最近一条消息的摘要（列表第二行）。 */
  preview: string
  /** 最近一条是谁说的（列表里给用户消息加「我：」）。 */
  previewRole?: 'user' | 'assistant'
  busy: boolean
  waiting: boolean
  status?: string
  /** task = 定时任务的对话（闹钟头像）。 */
  kind: 'chat' | 'task'
  focusRoot?: string | null
}

/** 对话里的一条消息（由桌面端的展示投影归约而来：只有正文，工具调用与过程不下发）。id = 在对话里的序号。 */
export type WebMessage =
  | { id: string; role: 'user'; text: string; attachments?: string[]; notify?: boolean }
  | { id: string; role: 'assistant'; text: string; notes?: string[]; durationMs?: number }

/** 需要你决定的交互卡（提问 / 计划 / 挂载 / 定时任务名片 / 角色名片），按 key 原地更新。 */
export interface WebPrompt {
  view: PromptView
  at: number
}

/** 一条通知（定时任务跑完 / 自动暂停 …），可关联到某个对话。 */
export interface WebNotice {
  id: string
  at: number
  title?: string
  text: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  sessionId?: string
}

export type WebClientFrame =
  | { t: 'hello'; v: number; token: string }
  | { t: 'pair'; v: number; code: string; name?: string }
  | { t: 'ping' }
  /** 重新拉对话列表与角色列表。 */
  | { t: 'refresh' }
  /** 某对话的历史：before = 只要序号小于它的（往前翻页），缺省取最新一页。 */
  | { t: 'history'; sid: string; before?: number; limit?: number }
  /** cid = 客户端临时 id，服务端用 sent 帧回结果。进行中的对话会作为插入送达。 */
  | { t: 'send'; sid: string; text: string; cid: string }
  | { t: 'stop'; sid: string }
  /** 新建对话（按角色）；rid 用 created 帧回。 */
  | { t: 'new'; rid: string; personaId?: string }
  /** 交互卡上的动作（key = 卡片 key；rid 用 result 帧回）。 */
  | { t: 'action'; rid: string; key: string; value: ActionValue; form?: Record<string, string | string[]> }

export type WebServerFrame =
  /** hello 成功：当前用户、机器人与电脑名、角色、对话列表、未决的交互卡。 */
  | {
      t: 'ok'
      v: number
      user: { id: string; name?: string }
      bot: { name: string; computer: string }
      personas: WebPersona[]
      sessions: WebSession[]
      prompts: WebPrompt[]
    }
  /** 配对成功：拿到长期 token，客户端存好后再发 hello。 */
  | { t: 'paired'; token: string }
  | { t: 'err'; code: 'unauthorized' | 'pair' | 'version' | 'bad_request'; message: string }
  | { t: 'pong' }
  /** 中转发出：这台电脑的 Deva 没连上中转。 */
  | { t: 'offline' }
  | { t: 'sessions'; list: WebSession[] }
  | { t: 'session'; s: WebSession }
  | { t: 'session_gone'; sid: string }
  | { t: 'personas'; list: WebPersona[] }
  /** start = 第一条的序号，total = 对话里的消息总数（messages[i].id = String(start + i)）。 */
  | { t: 'history'; sid: string; messages: WebMessage[]; start: number; total: number }
  | { t: 'sent'; cid: string; sid: string; ok: boolean; message?: string }
  | { t: 'created'; rid: string; sid?: string; error?: string }
  | { t: 'prompt'; p: WebPrompt }
  | { t: 'notice'; n: WebNotice }
  | { t: 'result'; rid: string; ok: boolean; message: string }

// ───────── 桌面端 ⇄ 中转 ─────────

/** 中转 → 桌面：某部手机连上 / 发来一帧（d 为原始 JSON 文本）/ 断开。c = 中转分配的连接 id。 */
export type RelayToDesk = { t: 'open'; c: string } | { t: 'msg'; c: string; d: string } | { t: 'close'; c: string }

/** 桌面 → 中转：给某连接回一帧 / 主动断开它。 */
export type DeskToRelay = { t: 'msg'; c: string; d: string } | { t: 'close'; c: string }

/** 手机网页地址里的参数（放在 # 后，不会发到服务器）：d = 桌面 id（经中转时），c = 一次性配对码。 */
export interface WebPageParams {
  d?: string
  c?: string
}

export function parseWebPageParams(hash: string): WebPageParams {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const d = p.get('d') ?? undefined
  const c = p.get('c') ?? undefined
  return { d: d || undefined, c: c || undefined }
}
