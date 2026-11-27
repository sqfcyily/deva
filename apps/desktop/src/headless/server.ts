import { readFileSync, readdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockHome, options, sessions } from './access'
import { ChatError, createTextChat } from './chat'

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
const fail = (status: number, code: string): never => { throw new HttpError(status, code) }
const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data))
}
async function body(req: IncomingMessage, keys: string[], limit = 52 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') || (req.headers['content-encoding'] ?? 'identity') !== 'identity') fail(415, 'json_required')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) fail(413, 'limit')
    chunks.push(chunk)
  }
  let obj
  try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { fail(400, 'invalid_request') }
  if (!obj || Array.isArray(obj) || typeof obj !== 'object' || Object.keys(obj).length !== keys.length || !keys.every(k => Object.hasOwn(obj, k))) fail(400, 'invalid_request')
  return obj
}

// Serve the immutable build, not paths supplied by clients. Only the public login page and its assets are unauthenticated.
function assets() {
  const dir = fileURLToPath(new URL('./web/', import.meta.url))
  const files = new Map<string, { type: string; bytes: Buffer }>()
  files.set('/', { type: 'text/html; charset=utf-8', bytes: readFileSync(join(dir, 'index.html')) })
  const types: Record<string, string> = { js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png' }
  for (const name of readdirSync(join(dir, 'assets'))) {
    const ext = /^[\w.-]+\.(js|css|woff2|svg|png)$/u.exec(name)?.[1]
    if (ext) files.set(`/assets/${name}`, { type: types[ext], bytes: readFileSync(join(dir, 'assets', name)) })
  }
  return files
}

function start() {
  const { host, port, site, owner, provider } = options()
  const pages = assets(); lockHome() // FD remains open for the lifetime of this dedicated CLI process.
  const auth = sessions(owner, site.protocol === 'https:'), chat = createTextChat(provider)
  let closing = false
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, maxHeaderSize: 8192 }, async (req, res) => {
    const path = req.url ?? '', method = req.method
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
    try {
      if (closing) fail(503, 'closing')
      if (path === '/healthz' && method === 'GET') return json(res, 200, { ok: true })
      if (req.headersDistinct.host?.length !== 1 || req.headers.host !== site.host ||
          (req.headers.origin !== undefined && req.headers.origin !== site.origin) || req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'origin')
      const page = pages.get(path)
      if (page && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': page.type, 'Content-Length': page.bytes.length }); res.end(method === 'HEAD' ? undefined : page.bytes); return
      }
      if (!path.startsWith('/api/') || path.includes('?')) fail(404, 'missing')
      if (method !== 'GET' && method !== 'POST') fail(405, 'method')
      if (method === 'POST' && req.headers.origin !== site.origin) fail(403, 'origin')
      if (method === 'POST' && path === '/api/login') {
        const { token } = await body(req, ['token'], 1024)
        const cookie = auth.login(token) ?? fail(401, 'auth')
        res.setHeader('Set-Cookie', cookie); return json(res, 200, { ok: true })
      }
      const session = auth.current(req) ?? fail(401, 'auth')
      // A slow request body may outlive this login, a closed connection or shutdown.
      const input = async (keys: string[]) => {
        const data = await body(req, keys)
        if (auth.current(req) !== session) fail(401, 'auth')
        if (closing || res.destroyed) fail(503, 'closing')
        return data
      }
      if (method === 'POST' && path === '/api/logout') {
        await input([]); res.setHeader('Set-Cookie', auth.logout(req)); return json(res, 200, { ok: true })
      }
      if (path === '/api/sessions') {
        if (method === 'GET') return json(res, 200, { model: provider.model, sessions: chat.list() })
        await input([]); return json(res, 201, chat.create())
      }
      const match = /^\/api\/sessions\/(web_[0-9a-f-]{36})(?:\/(turns|stop))?$/u.exec(path)
      if (!match) return fail(404, 'missing')
      const [, sid, action] = match
      if (!action && method === 'GET') return json(res, 200, chat.read(sid))
      if (method !== 'POST' || !action) fail(405, 'method')
      if (action === 'stop') {
        const { turnId } = await input(['turnId']); if (typeof turnId !== 'string') return fail(400, 'invalid_request')
        chat.stop(sid, turnId); return json(res, 200, { ok: true })
      }
      const { text, revision, turnId } = await input(['text', 'revision', 'turnId'])
      if (typeof text !== 'string' || typeof revision !== 'number' || typeof turnId !== 'string') return fail(400, 'invalid_request')
      const turn = chat.begin(sid, { text, revision, turnId })
      session.aborts.add(turn.abort); res.once('close', turn.abort)
      const expiry = setTimeout(turn.abort, Math.max(0, session.expires - Date.now()))
      try {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders()
        res.setTimeout(120_000, () => res.destroy())
        const reason = await turn.run(delta => new Promise<void>((done, reject) => {
          if (res.destroyed || auth.current(req) !== session) { turn.abort(); reject(new Error('closed')); return }
          res.write(JSON.stringify({ type: 'delta', text: delta }) + '\n', err => err ? reject(err) : done())
        }))
        if (!res.destroyed && auth.current(req) === session) res.end(JSON.stringify({ type: 'done', reason }) + '\n')
        else res.destroy()
      } finally { turn.abort(); clearTimeout(expiry); session.aborts.delete(turn.abort); res.off('close', turn.abort) }
    } catch (err) {
      if (res.destroyed) return
      const known = err instanceof HttpError || err instanceof ChatError
      const code = known ? err.code : 'internal'
      if (res.headersSent) res.end(JSON.stringify({ type: 'error', error: code }) + '\n')
      else { res.setHeader('Connection', 'close'); json(res, known ? err.status : 500, { error: code }) }
    }
  })
  server.maxConnections = 64
  server.once('error', () => { console.error('Deva Web could not listen on the configured address'); process.exitCode = 1 })
  server.listen(port, host, () => console.log(`Deva Web listening on ${site.origin}`))
  function shutdown() {
    if (closing) return
    closing = true; chat.close(); server.close(); server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 4000).unref()
  }
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
}

try { start() } catch (err) {
  const message = err instanceof Error ? err.message : ''
  // Only our setting/directory diagnostics are safe for deployment logs; never print URLs, prompts or secrets.
  console.error(/^(Invalid DEVA_|Invalid model configuration|Web data directory is busy|An empty or previously initialized)/u.test(message) ? message : 'Deva Web startup failed: check the settings, data directory and web build')
  process.exitCode = 1
}
