import { app, session, type Session } from 'electron'
import { isEn } from './locale'

/**
 * 统一出站 HTTP（主进程）：模型请求、模型清单、决策模型、web_fetch、MCP 的 HTTP/SSE 都走 httpFetch。
 *
 * 为什么用 Chromium 网络栈（session.fetch）而不是 Node 全局 fetch：
 *  · 连接由独立的网络服务进程发起。主进程里的 Winsock 被第三方 DLL 搞坏时（issue #35：毫秒级 connect UNKNOWN、
 *    inspector 监听一并消失）不受影响。
 *  · 证书走系统证书库：公司网络检查 HTTPS、IT 已把根证书装进系统时照样能连；Node 只认自带的根证书。
 *
 * 代理（对齐 Claude Code）：默认直连，认 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY 环境变量，不读系统代理。
 * 例外：没设环境变量代理、请求在送达服务器之前就失败（证书、拒绝连接、DNS、连接超时、代理类错误），且系统代理对该地址
 * 生效时，改走系统代理重试一次；成功则本次运行内该 origin 一律走系统代理（系统代理那头这样失败也会反过来试直连）。
 * 送达阶段不明的错误（连接重置等）不切换，免得同一请求被服务端处理两次。
 *
 * 连接数：Chromium 每个会话分区对同一主机最多 6 条 HTTP/1.1 连接（明文 http 中转、局域网服务都是 HTTP/1.1），
 * 超出的排队等前面的结束。每条线路开 POOL_SIZE 个内存分区轮流用，把上限放宽到 6×POOL_SIZE。
 *
 * 其他：不带 Cookie、不走 HTTP 缓存，与应用界面、内置浏览器的会话隔开。fetch 规范禁用的端口（如 6000、6665–6669、
 * 10080）Chromium 与 Node fetch 都拒绝（ERR_UNSAFE_PORT / bad port），只能给出说明。
 * 排查时设环境变量 DEVA_HTTP=node 整体切回 Node fetch。
 */

type Route = 'default' | 'system'

const POOL_SIZE = 4
const USE_NODE = (process.env.DEVA_HTTP ?? '').trim().toLowerCase() === 'node'

/** 请求一定没送达服务器的错误：可以换线路重发。 */
const PRE_DELIVERY =
  /^ERR_(CERT_\w+|SSL_\w+|BAD_SSL_CLIENT_AUTH_CERT|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|CONNECTION_FAILED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|ADDRESS_INVALID|PROXY_\w+|TUNNEL_CONNECTION_FAILED|SOCKS_\w+|MANDATORY_PROXY_CONFIGURATION_FAILED)$/

interface Pool {
  sessions: Session[]
  next: number
}

const pools = new Map<Route, Promise<Pool>>()
/** 本次运行内换过线路的 origin；没记录的走 default。 */
const routeByOrigin = new Map<string, Route>()

export async function httpFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input.href
  if (USE_NODE) return fetch(url, init)
  const origin = originOf(url)
  const first = routeByOrigin.get(origin) ?? 'default'
  try {
    return await viaChromium(first, url, init)
  } catch (e) {
    if (isAbort(e) || init.signal?.aborted) throw e
    const code = chromiumCode(e)
    if (!code || !PRE_DELIVERY.test(code) || !replayable(init.body)) throw e
    const other: Route = first === 'default' ? 'system' : 'default'
    if (other === 'system' && (envProxy() || !(await systemProxied(url)))) throw e
    try {
      const res = await viaChromium(other, url, init)
      routeByOrigin.set(origin, other)
      console.warn(`[http] ${origin}: ${first} 线路失败（${code}），改走 ${other} 线路`)
      return res
    } catch (e2) {
      if (isAbort(e2) || init.signal?.aborted) throw e2
      // 两条线路都不通：报第一条的错（通常更说明问题，如证书被换）。
      throw e
    }
  }
}

async function viaChromium(route: Route, url: string, init: RequestInit): Promise<Response> {
  const p = await pool(route)
  const ses = p.sessions[p.next++ % p.sessions.length]
  return ses.fetch(url, { ...init, credentials: 'omit', cache: 'no-store' })
}

function pool(route: Route): Promise<Pool> {
  let p = pools.get(route)
  if (!p) {
    p = createPool(route).catch((e) => {
      pools.delete(route)
      throw e
    })
    pools.set(route, p)
  }
  return p
}

async function createPool(route: Route): Promise<Pool> {
  await app.whenReady()
  const env = envProxy()
  const sessions: Session[] = []
  for (let i = 0; i < POOL_SIZE; i++) {
    // 无 persist: 前缀 = 纯内存分区，不落盘。
    const ses = session.fromPartition(`deva-http-${route}-${i}`)
    if (route === 'system') await ses.setProxy({ mode: 'system' })
    else if (env) await ses.setProxy({ mode: 'fixed_servers', proxyRules: env.rules, proxyBypassRules: env.bypass })
    else await ses.setProxy({ mode: 'direct' })
    sessions.push(ses)
  }
  return { sessions, next: 0 }
}

/** 系统代理对该地址是否生效（PAC / 例外列表都算在内）。 */
async function systemProxied(url: string): Promise<boolean> {
  const p = await pool('system')
  const rule = await p.sessions[0].resolveProxy(url).catch(() => 'DIRECT')
  return rule.split(';').some((s) => s.trim() !== '' && s.trim().toUpperCase() !== 'DIRECT')
}

// ───────────── 环境变量代理（同 Claude Code：HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY） ─────────────

let envCache: { rules: string; bypass: string } | null | undefined

function envProxy(): { rules: string; bypass: string } | null {
  if (envCache !== undefined) return envCache
  const get = (k: string): string => (process.env[k] ?? process.env[k.toLowerCase()] ?? '').trim()
  const all = proxyUri(get('ALL_PROXY'))
  const https = proxyUri(get('HTTPS_PROXY')) ?? all
  const http = proxyUri(get('HTTP_PROXY')) ?? all
  const noProxy = get('NO_PROXY')
  if ((!https && !http) || noProxy === '*') return (envCache = null)
  const rules = [https && `https=${https}`, http && `http=${http}`].filter(Boolean).join(';')
  return (envCache = { rules, bypass: bypassRules(noProxy) })
}

/** 环境变量里的代理地址 → Chromium 代理规则里的一项（不收账号密码，故去掉）。 */
function proxyUri(v: string): string | null {
  if (!v) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`)
    const raw = u.protocol.slice(0, -1).toLowerCase()
    const scheme = raw === 'socks5h' || raw === 'socks' ? 'socks5' : raw === 'socks4a' ? 'socks4' : raw
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return null
    const port = u.port || (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '1080')
    return `${scheme}://${u.hostname}:${port}`
  } catch {
    return null
  }
}

/** NO_PROXY → Chromium 例外规则。按 curl 习惯，`example.com` 与 `.example.com` 都含子域名。 */
function bypassRules(v: string): string {
  const out: string[] = []
  for (const raw of v.split(/[,\s]+/)) {
    const e = raw.trim()
    if (!e) continue
    if (e.includes('/') || e.startsWith('[') || e.startsWith('<') || /^\d+(\.\d+){3}(:\d+)?$/.test(e)) {
      out.push(e)
      continue
    }
    const host = e.replace(/^\*?\./, '')
    out.push(host, `*.${host}`)
  }
  return out.join(',')
}

// ───────────── 错误说明 ─────────────

/** 网络错误 → 给用户看的说明 + 原始错误码。非网络错误（如流空闲超时）原样返回 message。 */
export function describeNetError(e: unknown): string {
  const err = e as (Error & { cause?: unknown }) | undefined
  const msg = String(err?.message ?? e)
  const code = chromiumCode(e)
  if (code) {
    const text = explain(code)
    return text ? withCode(text, code) : msg
  }
  // Node fetch（DEVA_HTTP=node）：真实原因在 cause 里，message 只有 "fetch failed"。
  const cause = err?.cause as
    | { code?: unknown; syscall?: unknown; address?: unknown; port?: unknown; message?: unknown }
    | undefined
  if (err?.name === 'TypeError' && cause && typeof cause === 'object') {
    const c = cause.code ? String(cause.code) : ''
    const where = cause.address ? `${cause.address}${cause.port ? `:${cause.port}` : ''}` : ''
    const causeMsg = typeof cause.message === 'string' ? cause.message : ''
    // 没有错误码的 cause（如 undici 的 "bad port"）把它的 message 当错误码展示。
    const detail = [c, cause.syscall, where].filter(Boolean).join(' ') || causeMsg
    const text = explain(c || causeMsg) ?? msg
    return detail ? withCode(text, detail) : text
  }
  return msg
}

function withCode(text: string, code: string): string {
  return isEn() ? `${text} (${code})` : `${text}（${code}）`
}

const EXPLAIN: [RegExp, string, string][] = [
  [
    /^(ERR_CERT_\w+|ERR_BAD_SSL_CLIENT_AUTH_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_\w+|ERR_TLS_CERT_ALTNAME_INVALID)$/,
    '证书校验失败：服务器证书不受信任，常见于公司网络在检查 HTTPS 流量',
    'Certificate verification failed: the server certificate is not trusted, which often means the network is inspecting HTTPS traffic'
  ],
  [/^ERR_SSL_\w+$/, 'TLS 握手失败', 'TLS handshake failed'],
  [
    /^ERR_(PROXY_\w+|TUNNEL_CONNECTION_FAILED|SOCKS_\w+|MANDATORY_PROXY_CONFIGURATION_FAILED)$/,
    '经代理连接失败：请检查代理是否在运行',
    'Could not connect through the proxy; check that it is running'
  ],
  [
    /^(ERR_CONNECTION_REFUSED|ECONNREFUSED)$/,
    '连接被拒绝：该地址和端口上没有服务在监听',
    'Connection refused: nothing is listening on that address and port'
  ],
  [/^(ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN)$/, '域名解析失败', 'Could not resolve the host name'],
  [/^(ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/, '连接超时', 'Connection timed out'],
  [/^(ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ENETUNREACH)$/, '网络未连接或已切换', 'No network connection, or the network changed'],
  [/^(ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH)$/, '目标地址不可达', 'The address is unreachable'],
  [
    /^(ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ECONNRESET|EPIPE|UND_ERR_SOCKET)$/,
    '连接被中断',
    'The connection was interrupted'
  ],
  [/^ERR_HTTP2_\w+$/, 'HTTP/2 连接出错', 'HTTP/2 connection error'],
  [
    /^(ERR_UNSAFE_PORT|bad port)$/,
    '该端口出于安全原因被禁止访问（如 6000、10080），请让服务改用其他端口',
    'This port is blocked for security reasons (e.g. 6000, 10080); run the service on a different port'
  ]
]

function explain(code: string): string | null {
  if (!code) return null
  const hit = EXPLAIN.find(([re]) => re.test(code))
  return hit ? (isEn() ? hit[2] : hit[1]) : null
}

function chromiumCode(e: unknown): string | undefined {
  return /net::(ERR_[A-Z0-9_]+)/.exec(String((e as Error)?.message ?? ''))?.[1]
}

function isAbort(e: unknown): boolean {
  return (e as Error)?.name === 'AbortError'
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** 请求体能否原样重发（流式请求体只能读一次）。 */
function replayable(body: RequestInit['body']): boolean {
  return (
    body == null ||
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData
  )
}
