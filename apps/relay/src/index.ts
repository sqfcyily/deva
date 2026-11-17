import { DurableObject } from 'cloudflare:workers'

/**
 * Deva 手机版中转：把手机与电脑上的 Deva 之间的 WebSocket 帧原样互转，不解析内容（帧是端到端加密的密文，
 * 中转只看得到握手公钥与密文）。
 *
 *  · 桌面端连 /desk/<桌面 id>（Authorization: Bearer <桌面密钥>）。密钥首次连接时登记（存哈希），之后必须一致。
 *  · 手机连 /d/<桌面 id>/ws。每部手机在桌面端那头对应一个连接 id（c），用「open / msg / close」信封转发。
 *  · 每个桌面 id 一个 Durable Object；两头都用可休眠的 WebSocket，没有消息经过时几乎不计费。
 *  · 手机网页本身由 Workers 静态资源托管（wrangler.toml 的 [assets]）。
 *
 * 线上协议见 apps/desktop/src/shared/remote-web.ts（RelayToDesk / DeskToRelay）。
 */

export interface Env {
  DESK: DurableObjectNamespace<Desk>
  ASSETS: Fetcher
}

const ID = /^[A-Za-z0-9_-]{8,64}$/
/** 单帧上限：Cloudflare WebSocket 单条消息 1 MiB（帧是加密后的密文，分块上传 / 下载每块远小于此）。 */
const MAX_FRAME = 1024 * 1024
const OFFLINE = JSON.stringify({ t: 'offline' })
/**
 * 桌面端心跳：桌面每 20 秒发一条 'ping'，由运行时直接回 'pong'（自动应答，不唤醒 DO、不计费）。
 * 这么久没 ping 的桌面连接按已断处理：网络切换、电脑睡眠、代理 / 路由器静默丢掉空闲连接时，TCP 是半开的，
 * 两头都收不到关闭，不检查的话手机会一直等一个不会回话的桌面（一直「连接中」）。
 */
const DESK_STALE_MS = 60_000

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const desk = /^\/desk\/([^/]+)$/.exec(url.pathname)
    const phone = /^\/d\/([^/]+)\/ws$/.exec(url.pathname)
    const id = desk?.[1] ?? phone?.[1]
    if (id !== undefined) {
      if (!ID.test(id)) return new Response('bad desk id', { status: 400 })
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
        return new Response('expected websocket', { status: 426 })
      return env.DESK.get(env.DESK.idFromName(id)).fetch(req)
    }
    if (url.pathname === '/healthz') return new Response('ok')
    return env.ASSETS.fetch(req)
  }
} satisfies ExportedHandler<Env>

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

interface PhoneAttachment {
  c: string
}

/** 桌面连接接入的时间（还没 ping 过时按它算活着）。 */
interface DeskAttachment {
  at: number
}

export class Desk extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    if (url.pathname.startsWith('/desk/')) {
      const key = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
      if (!key) return new Response('missing key', { status: 401 })
      const hash = await sha256(key)
      const stored = await this.ctx.storage.get<string>('keyHash')
      if (!stored) await this.ctx.storage.put('keyHash', hash)
      else if (stored !== hash) return new Response('forbidden', { status: 403 })
      // 同一桌面只保留最新的一条连接（Deva 重启 / 网络切换后的新连接顶掉旧的）。
      for (const ws of this.ctx.getWebSockets('desk')) closeQuietly(ws, 4000, 'replaced')
      this.ctx.acceptWebSocket(server, ['desk'])
      server.serializeAttachment({ at: Date.now() } satisfies DeskAttachment)
      // 已经在等的手机：补发 open，桌面端据此建立连接对象。
      for (const ws of this.ctx.getWebSockets('phone')) {
        const a = ws.deserializeAttachment() as PhoneAttachment | null
        if (a) server.send(JSON.stringify({ t: 'open', c: a.c }))
      }
      return new Response(null, { status: 101, webSocket: client })
    }

    const c = crypto.randomUUID()
    this.ctx.acceptWebSocket(server, ['phone', `c:${c}`])
    server.serializeAttachment({ c } satisfies PhoneAttachment)
    const desk = this.desk()
    if (desk) desk.send(JSON.stringify({ t: 'open', c }))
    else {
      // 桌面端不在线：告诉手机并断开，手机端稍后重试。
      server.send(OFFLINE)
      server.close(4503, 'desk offline')
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 在线的桌面连接：心跳正常的里面最新接入的一条（except = 正在关的那条，不算）。
   *
   * 同一桌面可能挂着不止一条：旧连接断在半路（半开）时，「顶掉旧连接」的关闭送不到对面，旧连接会一直留在列表里。
   * 不能只取第一条——那多半正是最老、早就不通的那条：以前手机的帧被转进去没人回（一直「连接中」），
   * 加了心跳判断后又会把明明在线的电脑说成不在线。心跳停了的顺手关掉。
   */
  private desk(except?: WebSocket): WebSocket | undefined {
    let best: WebSocket | undefined
    let bestAt = -1
    for (const ws of this.ctx.getWebSockets('desk')) {
      if (ws === except) continue
      const at = (ws.deserializeAttachment() as DeskAttachment | null)?.at ?? 0
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0
      if (ws.readyState !== WebSocket.OPEN || Date.now() - Math.max(at, pinged) > DESK_STALE_MS) {
        closeQuietly(ws, 4001, 'stale')
        continue
      }
      if (at > bestAt) {
        best = ws
        bestAt = at
      }
    }
    return best
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string') return
    if (msg.length > MAX_FRAME) return ws.close(1009, 'frame too large')
    const tags = this.ctx.getTags(ws)
    if (tags.includes('desk')) {
      let env: { t?: string; c?: string; d?: string }
      try {
        env = JSON.parse(msg)
      } catch {
        return
      }
      if (typeof env.c !== 'string') return
      const target = this.ctx.getWebSockets(`c:${env.c}`)[0]
      if (!target) return
      if (env.t === 'msg' && typeof env.d === 'string') target.send(env.d)
      else if (env.t === 'close') target.close(1000, 'closed by desk')
      return
    }
    const a = ws.deserializeAttachment() as PhoneAttachment | null
    if (!a) return
    const desk = this.desk()
    if (!desk) {
      ws.send(OFFLINE)
      ws.close(4503, 'desk offline')
      return
    }
    desk.send(JSON.stringify({ t: 'msg', c: a.c, d: msg }))
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws)
  }

  private gone(ws: WebSocket): void {
    const tags = this.ctx.getTags(ws)
    if (tags.includes('desk')) {
      // 被新连接顶掉的旧桌面连接：手机仍挂在新连接上，不打扰。（关闭回调期间正在关的这条可能仍在列表里，要排除；
      // 列表里残留的半开旧连接不算在线。）
      if (this.desk(ws)) return
      for (const p of this.ctx.getWebSockets('phone')) {
        try {
          p.send(OFFLINE)
          p.close(4503, 'desk offline')
        } catch {
          /* 已断 */
        }
      }
      return
    }
    const a = ws.deserializeAttachment() as PhoneAttachment | null
    if (a) this.desk()?.send(JSON.stringify({ t: 'close', c: a.c }))
  }
}

/** 关掉一条连接；已经在关 / 已断的会抛错，忽略。 */
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    /* 已断 */
  }
}
