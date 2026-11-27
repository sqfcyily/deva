import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'

const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]'].includes(host)
const digest = (s: string) => createHash('sha256').update(s).digest()
function setting(name: string): never { throw new Error(`Invalid ${name}`) }
function address(value: string, name: string) {
  try { return new URL(value) } catch { return setting(name) }
}

export function options(env = process.env) {
  const host = env.DEVA_HOST ?? '127.0.0.1', port = Number(env.DEVA_PORT ?? 8787)
  if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) setting('DEVA_HOST / DEVA_PORT')
  const site = address(env.DEVA_ORIGIN ?? `http://127.0.0.1:${port}`, 'DEVA_ORIGIN')
  if (site.href !== `${site.origin}/` || !(site.protocol === 'https:' || site.protocol === 'http:' && loopback(site.hostname))) setting('DEVA_ORIGIN')
  const key = env.DEVA_WEB_TOKEN ?? ''
  if (key.trim() !== key || !/^[A-Za-z0-9_-]{32,128}$/u.test(key)) setting('DEVA_WEB_TOKEN (32–128 base64url characters)')
  const model = env.DEVA_MODEL ?? '', apiKey = env.DEVA_MODEL_API_KEY ?? ''
  if (!model.trim() || model !== model.trim() || model.length > 256 || apiKey.length > 8192 || /[\x00-\x1f\x7f]/u.test(model + apiKey)) setting('model configuration')
  const base = address(env.DEVA_MODEL_BASE_URL ?? '', 'DEVA_MODEL_BASE_URL')
  const privateIPv4 = isIP(base.hostname) === 4 && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(base.hostname)
  const privateHost = /^[a-z\d-]+$/iu.test(base.hostname) || privateIPv4 || /^\[f[cd][\da-f]{2}:/iu.test(base.hostname)
  if (base.username || base.password || base.search || base.hash || !(base.protocol === 'https:' || base.protocol === 'http:' && (loopback(base.hostname) || (!apiKey && privateHost)))) setting('DEVA_MODEL_BASE_URL')
  return { host, port, site, owner: digest(key), provider: { baseURL: base.href, model, apiKey } }
}

// Only one Linux writer may own this dedicated native data directory. An existing desktop
// home is not a Web data volume. flock on an inherited open file description dies with Node.
export function lockHome(): number {
  const home = process.env.DEVA_HOME || join(homedir(), '.deva-web')
  if (process.platform !== 'linux' || !isAbsolute(home) || resolve(home) === '/') setting('DEVA_HOME')
  mkdirSync(home, { mode: 0o700, recursive: true })
  if (realpathSync(home) !== resolve(home)) setting('DEVA_HOME')
  const fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0) setting('DEVA_HOME (owner-only directory required)')
    const locked = spawnSync('/usr/bin/flock', ['-n', '-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], env: {}, timeout: 2000 })
    if (locked.status !== 0) throw new Error('Web data directory is busy or locking is unavailable')
    const marker = join(home, '.deva-web-v1'), signature = 'deva-web-v1\n'
    const foreign = () => new Error('An empty or previously initialized Web data directory is required')
    let saved = lstatSync(marker, { throwIfNoEntry: false })
    if (!saved) {
      const dir = opendirSync(home)
      try { if (dir.readSync()) throw foreign() } finally { dir.closeSync() }
      writeFileSync(marker, signature, { mode: 0o600, flag: 'wx' }); saved = lstatSync(marker)
    }
    if (!saved.isFile() || saved.size !== signature.length || saved.nlink !== 1 || saved.uid !== stat.uid || readFileSync(marker, 'utf8') !== signature) throw foreign()
    process.env.DEVA_HOME = realpathSync(home)
    return fd
  } catch (err) { closeSync(fd); throw err }
}

type Session = { expires: number; aborts: Set<() => void> }
export function sessions(owner: Buffer, secure: boolean) {
  const users = new Map<string, Session>(), name = secure ? '__Host-deva_web' : 'deva_web'
  const cookie = (id: string, seconds: number) => `${name}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`
  const forget = (id: string) => { const s = users.get(id); users.delete(id); for (const stop of s?.aborts ?? []) stop() }
  const idOf = (req: IncomingMessage) => {
    const fields = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`))
    return fields.length === 1 ? fields[0].slice(name.length + 1) : ''
  }
  return {
    login(value: unknown) {
      if (typeof value !== 'string' || !timingSafeEqual(owner, digest(value))) return null
      for (const [id, s] of users) if (s.expires <= Date.now()) forget(id)
      if (users.size >= 16) forget(users.keys().next().value!)
      const id = randomBytes(32).toString('base64url'); users.set(id, { expires: Date.now() + 8 * 3600_000, aborts: new Set() })
      return cookie(id, 8 * 3600)
    },
    current(req: IncomingMessage) {
      const id = idOf(req), s = users.get(id)
      if (s && s.expires > Date.now()) return s
      if (s) forget(id)
      return null
    },
    logout(req: IncomingMessage) { forget(idOf(req)); return cookie('', 0) }
  }
}
