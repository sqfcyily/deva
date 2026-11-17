import { randomUUID } from 'node:crypto'
import type { RawData, WebSocket } from 'ws'

/**
 * 按桌面 id 配对电脑与手机、原样转发帧（规则与 apps/relay 的 Durable Object 相同）：
 *
 *  · 每个桌面 id 一个房间：一条电脑连接 + 若干手机连接。手机在电脑那头对应一个连接 id（c），
 *    用「open / msg / close」信封转发（协议见 apps/desktop/src/shared/remote-web.ts 的 RelayToDesk / DeskToRelay）。
 *  · 同一桌面只保留最新的电脑连接（Deva 重启 / 网络切换后的新连接顶掉旧的），已挂着的手机补发 open 给新连接。
 *  · 电脑不在线时手机收到 offline 并被断开（4503），手机端稍后重试。
 *  · 'ping' 原样回 'pong'（Cloudflare 版由运行时自动应答，电脑端据此判断中转是否还通）。
 */

/** 单帧上限（字符数），与 apps/relay 相同。 */
export const MAX_FRAME = 1024 * 1024
const OFFLINE = JSON.stringify({ t: 'offline' })
/**
 * 电脑每 20 秒发一次 'ping'。这么久没收到电脑的任何消息就当它已断：网络切换、电脑睡眠、
 * 路由器静默丢掉空闲连接时 TCP 是半开的，不检查的话手机的帧会转进一条没人回的连接。
 */
const DESK_STALE_MS = 60_000
/** 一台电脑最多同时挂多少条手机连接。 */
const MAX_PHONES = 32
/** 对方收得太慢、发送缓冲积压超过这么多时断开它，免得占满服务器内存。 */
const MAX_BUFFERED = 32 * 1024 * 1024

interface Room {
  desk: WebSocket | null
  /** 电脑最近一次发来消息（含 ping）的时间。 */
  deskSeen: number
  phones: Map<string, WebSocket>
}

type DeskEnvelope = { t?: unknown; c?: unknown; d?: unknown }

export class Relay {
  private readonly rooms = new Map<string, Room>()

  addDesk(id: string, ws: WebSocket): void {
    let room = this.rooms.get(id)
    if (!room) {
      room = { desk: null, deskSeen: 0, phones: new Map() }
      this.rooms.set(id, room)
    }
    const old = room.desk
    room.desk = ws
    room.deskSeen = Date.now()
    if (old) closeQuietly(old, 4000, 'replaced')
    ws.on('message', (data, isBinary) => this.fromDesk(id, ws, data, isBinary))
    ws.on('close', () => this.deskGone(id, ws))
    // 已经在等的手机：补发 open，电脑据此建立连接对象。
    for (const c of room.phones.keys()) send(ws, JSON.stringify({ t: 'open', c }))
  }

  addPhone(id: string, ws: WebSocket): void {
    const room = this.rooms.get(id)
    const desk = room && this.liveDesk(room)
    if (!room || !desk) return offline(ws)
    if (room.phones.size >= MAX_PHONES) return closeQuietly(ws, 1013, 'too many connections')
    const c = randomUUID()
    room.phones.set(c, ws)
    ws.on('message', (data, isBinary) => this.fromPhone(id, c, ws, data, isBinary))
    ws.on('close', () => this.phoneGone(id, c, ws))
    send(desk, JSON.stringify({ t: 'open', c }))
  }

  /** 断开心跳停了的电脑连接（关闭回调里再通知手机）。定时调用。 */
  sweep(): void {
    const now = Date.now()
    for (const room of this.rooms.values()) if (room.desk && now - room.deskSeen > DESK_STALE_MS) room.desk.terminate()
  }

  /** 在线的电脑连接；心跳停了的顺手断开。 */
  private liveDesk(room: Room): WebSocket | null {
    const desk = room.desk
    if (!desk || desk.readyState !== desk.OPEN) return null
    if (Date.now() - room.deskSeen > DESK_STALE_MS) {
      desk.terminate()
      return null
    }
    return desk
  }

  private fromDesk(id: string, ws: WebSocket, data: RawData, isBinary: boolean): void {
    const room = this.rooms.get(id)
    // 已被新连接顶掉的旧连接：不再转发。
    if (!room || room.desk !== ws) return
    room.deskSeen = Date.now()
    if (isBinary) return
    const text = data.toString()
    if (text === 'ping') return send(ws, 'pong')
    if (text.length > MAX_FRAME) return closeQuietly(ws, 1009, 'frame too large')
    let env: DeskEnvelope
    try {
      env = JSON.parse(text) as DeskEnvelope
    } catch {
      return
    }
    if (!env || typeof env !== 'object' || typeof env.c !== 'string') return
    const phone = room.phones.get(env.c)
    if (!phone) return
    if (env.t === 'msg' && typeof env.d === 'string') send(phone, env.d)
    else if (env.t === 'close') closeQuietly(phone, 1000, 'closed by desk')
  }

  private fromPhone(id: string, c: string, ws: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) return
    const text = data.toString()
    if (text === 'ping') return send(ws, 'pong')
    if (text.length > MAX_FRAME) return closeQuietly(ws, 1009, 'frame too large')
    const room = this.rooms.get(id)
    const desk = room && this.liveDesk(room)
    if (!desk) return offline(ws)
    send(desk, JSON.stringify({ t: 'msg', c, d: text }))
  }

  private deskGone(id: string, ws: WebSocket): void {
    const room = this.rooms.get(id)
    // 被新连接顶掉的旧连接：手机仍挂在新连接上，不打扰。
    if (!room || room.desk !== ws) return
    room.desk = null
    const phones = [...room.phones.values()]
    room.phones.clear()
    for (const p of phones) offline(p)
    this.rooms.delete(id)
  }

  private phoneGone(id: string, c: string, ws: WebSocket): void {
    const room = this.rooms.get(id)
    if (!room || room.phones.get(c) !== ws) return
    room.phones.delete(c)
    const desk = this.liveDesk(room)
    if (desk) send(desk, JSON.stringify({ t: 'close', c }))
  }
}

function send(ws: WebSocket, text: string): void {
  if (ws.readyState !== ws.OPEN) return
  if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate()
  ws.send(text)
}

/** 告诉手机电脑不在线并断开（手机端按「不在线」的间隔重试）。 */
function offline(ws: WebSocket): void {
  send(ws, OFFLINE)
  closeQuietly(ws, 4503, 'desk offline')
}

/** 关掉一条连接；已经在关 / 已断的会抛错，忽略。 */
export function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    /* 已断 */
  }
}
