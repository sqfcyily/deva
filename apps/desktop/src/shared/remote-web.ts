import type { ActionValue, NoticeView, PromptView } from './remote-views'

/**
 * 手机网页端 ⇄ 桌面端的线上协议（JSON 帧，走 WebSocket）。
 *
 * 传输无关：内网直连时手机连桌面端自带的 HTTP 服务（/ws）；经中转时手机连中转、桌面端也连中转，
 * 中转只按桌面 id 原样转发帧（见 apps/relay）。两条路上跑的都是这同一套帧。
 *
 * 鉴权：连上后第一帧必须是 hello（带长期 token）或 pair（带电脑端二维码里的一次性配对码）。
 */

export const WEB_PROTOCOL_VERSION = 1

/** 聊天记录里的一条（桌面端按用户保存，手机端整段同步）。id 单调递增，原地更新同一 id 即覆盖。 */
export type WebItem =
  | { id: string; at: number; kind: 'user'; text: string }
  | { id: string; at: number; kind: 'reply'; text: string; note?: string }
  | { id: string; at: number; kind: 'notice'; view: NoticeView }
  | { id: string; at: number; kind: 'prompt'; view: PromptView }

export type WebClientFrame =
  | { t: 'hello'; v: number; token: string }
  | { t: 'pair'; v: number; code: string; name?: string }
  /** cid = 客户端临时 id，服务端用 sent 帧回对应的记录 id。 */
  | { t: 'send'; cid: string; text: string }
  /** id = 按钮所在记录的 id；rid = 请求 id，result 帧带回。 */
  | { t: 'action'; rid: string; id: string; value: ActionValue; form?: Record<string, string | string[]> }
  | { t: 'ping' }

export type WebServerFrame =
  /** hello 成功：当前用户、机器人名、最近的记录（整段覆盖本地）与「正在输入」状态。 */
  | { t: 'ok'; v: number; user: { id: string; name?: string }; bot: { name: string }; items: WebItem[]; typing: boolean }
  /** 配对成功：拿到长期 token，客户端存好后再发 hello。 */
  | { t: 'paired'; token: string }
  | { t: 'err'; code: 'unauthorized' | 'pair' | 'version' | 'bad_request'; message: string }
  | { t: 'item'; item: WebItem }
  | { t: 'remove'; id: string }
  | { t: 'typing'; on: boolean }
  | { t: 'sent'; cid: string; id: string }
  | { t: 'result'; rid: string; ok: boolean; message: string }
  /** 中转发出：这台电脑的 Deva 没连上中转。 */
  | { t: 'offline' }
  | { t: 'pong' }

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
