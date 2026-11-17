import { existsSync, readFileSync } from 'node:fs'
import { STATUS_CODES, createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { DeskKeys } from './keys'
import { MAX_FRAME, Relay, closeQuietly } from './relay'
import { serveStatic } from './static'

/**
 * Deva 手机版中转（Node.js 版）：协议与 apps/relay（Cloudflare Workers）完全相同，部署在自己的服务器上，
 * 不受 Workers 每日请求额度限制。
 *
 *  · 电脑连 /desk/<桌面 id>（Authorization: Bearer <桌面密钥>），手机连 /d/<桌面 id>/ws。
 *  · 帧是端到端加密的密文，中转只按桌面 id 配对、原样转发，不解析内容。
 *  · 顺带托管手机网页（PUBLIC_DIR）；目录不存在时只当中转用。
 *  · 配对状态在进程内存里：同一个地址后面只能运行一个实例。
 *
 * 配置全部走环境变量，见 README.md。
 */

const ID = /^[A-Za-z0-9_-]{8,64}$/
/** 协议层心跳：两轮之间没回 pong 的连接直接断开（手机锁屏、断网后留下的半开连接）。 */
const HEARTBEAT_MS = 30_000

interface Config {
  port: number
  host: string | undefined
  dataDir: string
  publicDir: string
  tls: { cert: Buffer; key: Buffer } | null
}

type Route = { kind: 'desk' | 'phone'; id: string }

function fail(message: string): never {
  console.error(`[relay] ${message}`)
  process.exit(1)
}

function loadConfig(): Config {
  const env = (name: string): string | undefined => process.env[name]?.trim() || undefined
  const port = Number(env('PORT') ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT 无效：${env('PORT')}`)
  const certFile = env('TLS_CERT')
  const keyFile = env('TLS_KEY')
  if (!certFile !== !keyFile) fail('TLS_CERT 与 TLS_KEY 要同时设置')
  let tls: Config['tls'] = null
  if (certFile && keyFile) {
    try {
      tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    } catch (e) {
      fail(`读取证书失败：${(e as Error).message}`)
    }
  }
  return {
    port,
    host: env('HOST'),
    // 数据目录按工作目录算（重新构建会清空 dist/，数据不能放在脚本旁边）；网页随脚本一起发布，按脚本所在目录算。
    dataDir: resolve(env('DATA_DIR') ?? 'data'),
    publicDir: resolve(env('PUBLIC_DIR') ?? join(__dirname, 'public')),
    tls
  }
}

function pathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0]
}

function route(path: string): Route | null {
  const desk = /^\/desk\/([^/]+)$/.exec(path)
  if (desk) return { kind: 'desk', id: desk[1] }
  const phone = /^\/d\/([^/]+)\/ws$/.exec(path)
  if (phone) return { kind: 'phone', id: phone[1] }
  return null
}

/** 拒绝 WebSocket 握手：回一个普通 HTTP 响应后断开（电脑端据状态码区分「密钥不对」与其他错误）。 */
function reject(socket: Duplex, status: number, message: string): void {
  socket.once('finish', () => socket.destroy())
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
      'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  )
}

function main(): void {
  const cfg = loadConfig()
  let keys: DeskKeys
  try {
    keys = new DeskKeys(cfg.dataDir)
  } catch (e) {
    fail(`读取桌面登记失败（${cfg.dataDir}）：${(e as Error).message}`)
  }
  const relay = new Relay()
  // maxPayload 按字节算，MAX_FRAME 按字符算（UTF-8 最多 3 字节一个字符）；按字符的上限在 relay.ts 里检查。
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME * 3 })
  const alive = new WeakSet<WebSocket>()
  const track = (ws: WebSocket): void => {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    ws.on('error', () => undefined)
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = pathOf(req)
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok')
      return
    }
    if (route(path)) {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' }).end('expected websocket')
      return
    }
    serveStatic(cfg.publicDir, req, res)
  }
  const server: Server = cfg.tls ? createHttpsServer(cfg.tls, onRequest) : createHttpServer(onRequest)

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined)
    const r = route(pathOf(req))
    if (!r) return reject(socket, 404, 'not found')
    if (!ID.test(r.id)) return reject(socket, 400, 'bad desk id')
    if (r.kind === 'phone') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws)
        relay.addPhone(r.id, ws)
      })
      return
    }
    const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!key) return reject(socket, 401, 'missing key')
    const verdict = keys.verify(r.id, key)
    if (verdict === 'forbidden') return reject(socket, 403, 'forbidden')
    if (verdict === 'error') return reject(socket, 503, 'storage unavailable')
    wss.handleUpgrade(req, socket, head, (ws) => {
      track(ws)
      relay.addDesk(r.id, ws)
    })
  })

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
    relay.sweep()
  }, HEARTBEAT_MS)

  server.once('error', (e: NodeJS.ErrnoException) =>
    fail(
      e.code === 'EADDRINUSE'
        ? `端口 ${cfg.port} 已被占用`
        : e.code === 'EACCES'
          ? `没有权限监听端口 ${cfg.port}（1024 以下的端口需要 root 或 CAP_NET_BIND_SERVICE）`
          : `启动失败：${e.message}`
    )
  )
  server.listen({ port: cfg.port, host: cfg.host }, () => {
    server.removeAllListeners('error')
    server.on('error', (e) => console.warn(`[relay] 服务错误：${e.message}`))
    const page = existsSync(join(cfg.publicDir, 'index.html')) ? cfg.publicDir : `未托管（${cfg.publicDir} 下没有 index.html）`
    console.log(`[relay] 已启动：${cfg.tls ? 'https' : 'http'}://${cfg.host ?? '*'}:${cfg.port}`)
    console.log(`[relay] 手机网页：${page}`)
    console.log(`[relay] 桌面登记：${join(cfg.dataDir, 'desks.json')}（${keys.size} 台）`)
  })

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    clearInterval(heartbeat)
    // 电脑和手机收到 1001 后各自按退避重连，服务重启回来就能接上。
    for (const ws of wss.clients) closeQuietly(ws, 1001, 'server restarting')
    server.close(() => process.exit(0))
    server.closeAllConnections()
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
