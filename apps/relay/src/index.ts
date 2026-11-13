import { DurableObject } from 'cloudflare:workers'

/**
 * Deva 手机网页中转：把手机与电脑上的 Deva 之间的 WebSocket 帧原样互转，不解析内容。
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
/** 单帧上限（与桌面端 MAX_FRAME_BYTES 一致）。 */
const MAX_FRAME = 256 * 1024
const OFFLINE = JSON.stringify({ t: 'offline' })

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

export class Desk extends DurableObject<Env> {
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
      for (const ws of this.ctx.getWebSockets('desk')) ws.close(4000, 'replaced')
      this.ctx.acceptWebSocket(server, ['desk'])
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

  private desk(): WebSocket | undefined {
    return this.ctx.getWebSockets('desk')[0]
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
      // 被新连接顶掉的旧桌面连接：手机仍挂在新连接上，不打扰。（关闭回调期间正在关的这条可能仍在列表里，要排除。）
      if (this.ctx.getWebSockets('desk').some((s) => s !== ws)) return
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
