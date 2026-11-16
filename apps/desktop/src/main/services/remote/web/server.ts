import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { MAX_FRAME_CHARS } from '../../../../shared/remote-web'
import type { RawConn, RawSink } from './conn'

/**
 * 内网直连：桌面端自带的 HTTP 服务。托管手机网页（构建产物 out/mobile）并在 /ws 上接 WebSocket。
 * 监听全部网卡（手机在同一 Wi-Fi 下扫码即连）；页面只走相对路径，经中转或反代时同样可用。
 */

export interface LanServer {
  port: number
  close(): Promise<void>
}

const PING_EVERY_MS = 30_000

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json'
}

/** 手机网页的静态目录（electron-vite 把主进程打到 out/main，网页构建到 out/mobile）。 */
export function mobileRoot(): string {
  return resolve(join(__dirname, '..', 'mobile'))
}

/** 本机可供局域网访问的 IPv4 地址（常见的家用 / 办公网段排前面）。 */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue
      // 169.254 = 没拿到 DHCP 的自动地址，手机连不上；WSL / Hyper-V 的虚拟网卡也常用它
      if (i.address.startsWith('169.254.')) continue
      out.push(i.address)
    }
  const rank = (a: string): number =>
    a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b))
}

export function startLanServer(port: number, sink: RawSink): Promise<LanServer> {
  const root = mobileRoot()
  const server: Server = createServer((req, res) => serveStatic(root, req, res))
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_CHARS * 3 })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    // 页面与经中转时一样连 /d/<桌面 id>/ws（局域网只有这一台电脑，不看 id）；/ws 是旧地址。
    if (path !== '/ws' && !/^\/d\/[\w-]{1,64}\/ws$/.test(path)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req, sink))
  })

  return new Promise((resolvePromise, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      reject(
        new Error(
          e.code === 'EADDRINUSE'
            ? `端口 ${port} 已被占用，请换一个端口。`
            : e.code === 'EACCES'
              ? `没有权限监听端口 ${port}，请换一个 1024 以上的端口。`
              : `启动内网服务失败：${e.message}`
        )
      )
    })
    server.listen(port, '0.0.0.0', () => {
      server.removeAllListeners('error')
      server.on('error', (e) => console.warn('[remote/web] 内网服务错误：', (e as Error).message))
      resolvePromise({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of wss.clients) ws.terminate()
            wss.close()
            server.close(() => done())
            // 已建立的 keep-alive 连接会让 close 等很久：直接掐断。
            server.closeAllConnections?.()
          })
      })
    })
  })
}

function accept(ws: WebSocket, req: IncomingMessage, sink: RawSink): void {
  const remote = req.socket.remoteAddress ?? '?'
  const conn: RawConn = {
    via: 'lan',
    remote,
    sendText: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text)
    },
    close: (code) => ws.close(code ?? 1000)
  }
  const h = sink.attach(conn)
  let alive = true
  const ping = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, PING_EVERY_MS)
  ws.on('pong', () => (alive = true))
  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(4400, 'binary not allowed')
    h.onText(data.toString())
  })
  ws.on('close', () => {
    clearInterval(ping)
    h.onClose()
  })
  ws.on('error', () => undefined)
}

const NOT_BUILT = 'Deva 手机网页尚未构建（out/mobile 缺失）。'

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  let path: string
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0])
  } catch {
    res.writeHead(400).end()
    return
  }
  if (path === '/' || path === '') path = '/index.html'
  // 拼完再 resolve，确保落在 root 之内（防 ../ 穿越）。
  const file = resolve(join(root, normalize(path)))
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  let target = file
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // 静态资源缺失 404；其余未知路径回首页（单页应用，以后加前端路由也不用改）。
    if (extname(path)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(path === '/index.html' ? NOT_BUILT : 'Not found')
      return
    }
    target = join(root, 'index.html')
    if (!existsSync(target)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end(NOT_BUILT)
      return
    }
  }
  const ext = extname(target)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff'
  })
  if (req.method === 'HEAD') return void res.end()
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res)
}
