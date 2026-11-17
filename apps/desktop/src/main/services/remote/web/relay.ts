import WebSocket from 'ws'
import type { DeskToRelay, RelayToDesk } from '../../../../shared/remote-web'
import type { RawConn, RawHandlers, RawSink } from './conn'

/**
 * 经中转访问：桌面端主动外连中转（apps/relay，部署在 Cloudflare Workers 或自己的服务器上），
 * 中转把每部手机的连接包成「open / msg / close」信封转过来，这里拆成与内网直连同形的 Conn 交给适配器。
 *
 * 断线自动重连（1s 起指数退避到 30s）；中转拒绝密钥（401 / 403）时放慢到 60s 一次，状态标为错误。
 *
 * 心跳：每 20 秒发 'ping'（中转由运行时直接回 'pong'，见 apps/relay），45 秒没收到任何东西就当连接已断、
 * 断开重连。网络切换、电脑睡眠、代理 / 路由器静默丢掉空闲连接时 TCP 是半开的，两头都收不到关闭：
 * 不检查的话这边一直显示「已启用」，中转却把手机转给一条不通的连接，手机一直「连接中」。
 */

const PING_EVERY_MS = 20_000
const DEAD_AFTER_MS = 45_000
const LOST = '与中转的连接没有响应，正在重连'

export interface RelayClient {
  close(): void
}

export type RelayState = 'connecting' | 'on' | 'error'

export interface RelayOptions {
  url: string
  deskId: string
  key: string
  sink: RawSink
  onState(state: RelayState, error?: string): void
}

/** 把用户填的中转地址（http(s)://host[/path]）规范成 ws(s)://host[/path]，去掉末尾斜杠。 */
export function relayWsBase(url: string): string | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol === 'http:') u.protocol = 'ws:'
  else if (u.protocol === 'https:') u.protocol = 'wss:'
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null
  u.hash = ''
  u.search = ''
  return u.href.replace(/\/+$/, '')
}

/** 手机打开的页面地址（中转托管网页）。 */
export function relayPageUrl(url: string): string | null {
  const base = relayWsBase(url)
  if (!base) return null
  return base.replace(/^ws/, 'http') + '/'
}

export function startRelayClient(opts: RelayOptions): RelayClient {
  const base = relayWsBase(opts.url)
  let stopped = false
  let ws: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  const conns = new Map<string, { conn: RawConn; h: RawHandlers }>()

  if (!base) {
    opts.onState('error', '中转地址无效，应形如 https://relay.example.com')
    return { close: () => undefined }
  }
  const target = `${base}/desk/${encodeURIComponent(opts.deskId)}`

  const sendEnvelope = (env: DeskToRelay): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env))
  }

  const dropAll = (): void => {
    const all = [...conns.values()]
    conns.clear()
    for (const { h } of all) h.onClose()
  }

  const schedule = (delay: number): void => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      connect()
    }, delay)
  }

  const connect = (): void => {
    if (stopped) return
    opts.onState('connecting')
    let rejected = ''
    let lastRx = Date.now()
    let beat: ReturnType<typeof setInterval> | null = null
    const sock = new WebSocket(target, {
      headers: { authorization: `Bearer ${opts.key}` },
      handshakeTimeout: 15_000
    })
    ws = sock
    sock.on('unexpected-response', (_req, res) => {
      rejected =
        res.statusCode === 401 || res.statusCode === 403
          ? '中转拒绝了这台电脑的密钥（桌面 id 可能已被别的电脑占用）。'
          : `中转返回 HTTP ${res.statusCode}`
      sock.terminate()
    })
    sock.on('open', () => {
      attempt = 0
      lastRx = Date.now()
      opts.onState('on')
      // 电脑睡眠时定时器停走，醒来后第一跳就会发现很久没收到东西，立刻重连。
      beat = setInterval(() => {
        if (Date.now() - lastRx > DEAD_AFTER_MS) {
          rejected = LOST
          sock.terminate()
          return
        }
        if (sock.readyState === WebSocket.OPEN) sock.send('ping')
      }, PING_EVERY_MS)
    })
    sock.on('message', (data, isBinary) => {
      lastRx = Date.now()
      if (isBinary) return
      const text = data.toString()
      if (text === 'pong') return
      let env: RelayToDesk
      try {
        env = JSON.parse(text) as RelayToDesk
      } catch {
        return
      }
      if (!env || typeof env.c !== 'string') return
      if (env.t === 'open') {
        if (conns.has(env.c)) return
        const c = env.c
        const conn: RawConn = {
          via: 'relay',
          remote: `relay:${c}`,
          sendText: (text) => sendEnvelope({ t: 'msg', c, d: text }),
          close: () => {
            sendEnvelope({ t: 'close', c })
            const cur = conns.get(c)
            if (cur) {
              conns.delete(c)
              cur.h.onClose()
            }
          }
        }
        conns.set(c, { conn, h: opts.sink.attach(conn) })
      } else if (env.t === 'msg') {
        const cur = conns.get(env.c)
        if (!cur) return
        if (typeof env.d === 'string') cur.h.onText(env.d)
      } else if (env.t === 'close') {
        const cur = conns.get(env.c)
        if (!cur) return
        conns.delete(env.c)
        cur.h.onClose()
      }
    })
    sock.on('error', (e) => {
      if (!rejected) rejected = `连不上中转：${e.message}`
    })
    sock.on('close', () => {
      if (beat) clearInterval(beat)
      beat = null
      if (ws === sock) ws = null
      dropAll()
      if (stopped) return
      const auth = /密钥/.test(rejected)
      // 心跳发现的断线：多半一重连就好，按「连接中」显示，不闪「连接失败」。
      if (rejected === LOST) opts.onState('connecting')
      else opts.onState('error', rejected || '与中转的连接断开，正在重连')
      attempt++
      schedule(auth ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)))
    })
  }

  connect()
  return {
    close: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      dropAll()
      // 正常关闭（中转据此立刻通知手机「电脑离线」）；对方没响应时再强制断开。
      const cur = ws
      ws = null
      if (cur) {
        if (cur.readyState === WebSocket.OPEN) {
          cur.close(1000, 'stopped')
          setTimeout(() => cur.terminate(), 2000).unref()
        } else cur.terminate()
      }
    }
  }
}
