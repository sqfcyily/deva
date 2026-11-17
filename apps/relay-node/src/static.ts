import { createReadStream, statSync, type Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * 托管手机网页（apps/desktop 构建出的 out/mobile）。规则与电脑端局域网服务
 * （apps/desktop/src/main/services/remote/web/server.ts）相同：带哈希的 /assets/ 长期缓存，其余每次校验；
 * 没有扩展名的未知路径回首页。
 */

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

const NO_PAGE = '这台中转没有托管手机网页。'

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
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
  let st = fileStat(target)
  if (!st) {
    if (extname(path)) return plain(res, 404, path === '/index.html' ? NO_PAGE : 'Not found')
    target = join(root, 'index.html')
    st = fileStat(target)
    if (!st) return plain(res, 404, NO_PAGE)
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': target === file && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target)
    .on('error', () => res.destroy())
    .pipe(res)
}

function fileStat(p: string): Stats | null {
  try {
    const s = statSync(p)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text)
}
