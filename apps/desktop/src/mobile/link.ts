import { b64uDecode, b64uEncode, phoneFinish, phoneHello, type PhoneHi, type SecureChannel } from '../shared/remote-crypto'
import {
  FILE_CHUNK_BYTES,
  WEB_PROTOCOL_VERSION,
  type WebClientFrame,
  type WebFileKind,
  type WebModel,
  type WebPlainServerFrame,
  type WebPushSub,
  type WebServerFrame
} from '../shared/remote-web'
import { isEn, t } from './strings'

/**
 * 与电脑的连接（WebSocket，经中转或局域网都连 /d/<桌面 id>/ws）。
 *
 * 每次连上先做端到端加密握手（shared/remote-crypto.ts）：
 *   pair = 扫码带来的一次性配对票据；install = 添加到主屏幕时带来的安装票据；resume = 已保存的设备密钥。
 * 握手后发 hello；配对 / 安装成功时电脑先回 paired（设备 id + 密钥，交给上层存好，之后改用 resume），再回 ok。
 * 断线自动重连（间隔逐次拉长，页面在后台时不重连）；回到前台或网络恢复时立即重连。
 */

export type Auth = { kind: 'resume'; device: string; key: Uint8Array } | { kind: 'pair' | 'install'; id: string; secret: Uint8Array }

export type LinkPhase =
  | { kind: 'connecting'; step: 0 | 1 | 2 }
  | { kind: 'ready' }
  /** 中转说这台电脑的 Deva 不在线。 */
  | { kind: 'offline' }
  /** 票据过期 / 已用过（pairing），或设备已被移除（removed）。不再自动重连。 */
  | { kind: 'auth'; message: string; removed: boolean; pairing: boolean }
  | { kind: 'version'; message: string }

export interface LinkEvents {
  onPhase(p: LinkPhase): void
  onFrame(f: WebServerFrame): void
  /** 配对 / 安装成功：设备凭证（上层存进 vault）。 */
  onPaired(device: string, key: string): void
}

/**
 * 重连间隔：每次翻倍，封顶 1 分钟。每连一次，中转那头都算一次计费请求（Cloudflare 按连接次数计，免费额度每天 10 万次，
 * 所有用户共用），固定短间隔一直试（尤其是电脑关机过夜、手机停在「不在线」）会很快把额度耗光。
 * 回到前台 / 网络恢复时不受这个间隔限制，立即重连。
 */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 60_000
/** 电脑不在线：从 5 秒起翻倍，同样封顶 1 分钟。 */
const OFFLINE_RETRY_MIN_MS = 5000
const OFFLINE_RETRY_MAX_MS = 60_000
const REQUEST_TIMEOUT_MS = 20_000
/**
 * 连接是否还通：ping 一路经中转到电脑再回 pong（电脑不在线时中转直接回 offline）。
 * 切到后台、网络切换后，WebSocket 可能还显示「已打开」，实际早就不通了（半开）；只看 readyState 会一直等下去。
 */
const PING_EVERY_MS = 20_000
/** 这么久什么都没收到：当作已断，重连。 */
const DEAD_AFTER_MS = 50_000
/** 连上后到收到电脑的 ok（握手 + hello）最多等这么久，等不到就重连（电脑那头的连接可能已断）。 */
const HANDSHAKE_TIMEOUT_MS = 15_000
/** 回到前台 / 网络恢复时探一下：发 ping 后这么久没收到任何东西就重连。 */
const PROBE_MS = 6000
/** WebSocket 发送缓冲超过这么多时先等一等（上传大文件时）。 */
const BUFFER_HIGH = 1024 * 1024
/** 上传：等连上电脑最多这么久；连接断了最多从头传这么多次。 */
const UPLOAD_WAIT_MS = 20_000
const UPLOAD_TRIES = 3

type Waiter = { match: (f: WebServerFrame) => boolean; resolve: (f: WebServerFrame | null) => void; timer: number }

/** 手机新建对话的 id（格式见 PHONE_SID_RE）。getRandomValues 在局域网的 http 页面里也能用。 */
function newSessionId(): string {
  const r = crypto.getRandomValues(new Uint32Array(1))[0]
  return `sess_${Date.now().toString(36)}_${r.toString(36)}`
}

export interface FileResult {
  ok: boolean
  message?: string
  name?: string
  size?: number
  mime?: string
  kind?: WebFileKind
  text?: string
  truncated?: boolean
  blob?: Blob
}

export class Link {
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: number | null = null
  private ping: number | null = null
  private handshake: number | null = null
  /** 最近一次收到任何东西的时间。 */
  private lastRx = 0
  private seq = 0
  private waiters = new Set<Waiter>()
  private channel: SecureChannel | null = null
  private hi: { hi: PhoneHi; priv: Uint8Array } | null = null
  private phase: LinkPhase = { kind: 'connecting', step: 0 }
  private chunks = new Map<string, { parts: Uint8Array[]; total: number; got: number; onProgress?: (p: number) => void }>()

  constructor(
    readonly deskId: string,
    private auth: Auth,
    private ev: LinkEvents,
    private deviceName: string
  ) {}

  get ready(): boolean {
    return this.phase.kind === 'ready'
  }

  private setPhase(p: LinkPhase): void {
    this.phase = p
    this.ev.onPhase(p)
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 页面放在中转 / 局域网服务的根目录或子目录下：WebSocket 地址与页面同目录。
    const base = location.pathname.replace(/[^/]*$/, '')
    return `${proto}//${location.host}${base}d/${encodeURIComponent(this.deskId)}/ws`
  }

  start(): void {
    this.closed = false
    this.connect()
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('online', this.onVisible)
  }

  stop(): void {
    this.closed = true
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener('online', this.onVisible)
    this.clearTimers()
    this.ws?.close()
    this.ws = null
    for (const w of [...this.waiters]) this.settle(w, null)
  }

  /**
   * 回到前台 / 网络恢复：断着就不等退避立刻重连；看着连着的探一下是不是真的通（后台久了常是半开）；
   * 在线时告诉电脑页面是否在前台。
   */
  private onVisible = (): void => {
    if (this.closed) return
    const visible = document.visibilityState === 'visible'
    if (this.ready) this.send({ t: 'visible', visible })
    if (!visible) return
    if (this.phase.kind === 'auth' || this.phase.kind === 'version') return
    const ws = this.ws
    if (ws?.readyState === WebSocket.OPEN) return this.probe(ws)
    if (ws?.readyState === WebSocket.CONNECTING) return
    this.attempt = 0
    this.clearTimers()
    this.connect()
  }

  /** 发一个 ping，PROBE_MS 内什么都没收到就当已断、立刻重连。 */
  private probe(ws: WebSocket): void {
    const at = Date.now()
    ws.send('{"t":"ping"}')
    window.setTimeout(() => {
      if (this.ws === ws && this.lastRx < at) {
        this.attempt = 0
        this.abandon(ws)
      }
    }, PROBE_MS)
  }

  /** 不等浏览器的关闭握手（半开的连接上可能要等很久），直接丢开这条连接，按断线处理。 */
  private abandon(ws: WebSocket): void {
    if (this.ws !== ws) return
    ws.onopen = ws.onmessage = ws.onclose = null
    try {
      ws.close()
    } catch {
      /* 已断 */
    }
    this.onClosed(ws)
  }

  private clearTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    this.clearLive()
  }

  /** 这条连接上的心跳与握手计时。 */
  private clearLive(): void {
    if (this.ping !== null) window.clearInterval(this.ping)
    this.ping = null
    if (this.handshake !== null) window.clearTimeout(this.handshake)
    this.handshake = null
  }

  private connect(): void {
    if (this.closed) return
    this.ws?.close()
    this.clearLive()
    this.channel = null
    if (this.phase.kind !== 'offline') this.setPhase({ kind: 'connecting', step: 0 })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch {
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      const a = this.auth
      this.hi = phoneHello(a.kind, a.kind === 'resume' ? a.device : a.id)
      ws.send(JSON.stringify(this.hi.hi))
      this.lastRx = Date.now()
      this.ping = window.setInterval(() => {
        if (Date.now() - this.lastRx > DEAD_AFTER_MS) return this.abandon(ws)
        if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}')
      }, PING_EVERY_MS)
      // 电脑那头的连接不通时中转照样接受手机，只是没人回话：等不到 ok 就重连。
      this.handshake = window.setTimeout(() => {
        this.handshake = null
        if (this.ws === ws && !this.ready) this.abandon(ws)
      }, HANDSHAKE_TIMEOUT_MS)
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      this.lastRx = Date.now()
      if (typeof e.data !== 'string') return
      let f: WebPlainServerFrame
      try {
        f = JSON.parse(e.data) as WebPlainServerFrame
      } catch {
        return
      }
      this.onPlain(f)
    }
    ws.onclose = () => this.onClosed(ws)
    ws.onerror = () => undefined
  }

  private onClosed(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.ws = null
    this.channel = null
    this.clearLive()
    for (const w of [...this.waiters]) this.settle(w, null)
    if (this.closed || this.phase.kind === 'auth' || this.phase.kind === 'version') return
    this.scheduleReconnect()
  }

  /**
   * 隔一段时间再连（间隔见 RECONNECT_* / OFFLINE_RETRY_*）。页面在后台时不连：通知走 Web Push，后台用不上这条连接，
   * 回到前台时 onVisible 会立即重连。
   */
  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return
    const offline = this.phase.kind === 'offline'
    if (!offline) this.setPhase({ kind: 'connecting', step: 0 })
    if (document.visibilityState === 'hidden') return
    const [min, max] = offline ? [OFFLINE_RETRY_MIN_MS, OFFLINE_RETRY_MAX_MS] : [RECONNECT_MIN_MS, RECONNECT_MAX_MS]
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 6))
    this.attempt++
    this.timer = window.setTimeout(() => {
      this.timer = null
      // 等的时候切到了后台：留到回前台时再连。
      if (document.visibilityState === 'hidden') return
      this.connect()
    }, delay)
  }

  private onPlain(f: WebPlainServerFrame): void {
    switch (f.t) {
      case 'pong':
        return
      case 'offline': {
        this.setPhase({ kind: 'offline' })
        // 中转发完 offline 会断开，但这个关闭不一定送得到（刚接入就断的那种），只等 onclose 会一直卡在「不在线」：
        // 自己丢开，按「不在线」的间隔重试。
        const ws = this.ws
        if (ws) this.abandon(ws)
        return
      }
      case 'err':
        if (f.code === 'version') return this.setPhase({ kind: 'version', message: f.message })
        if (f.code === 'auth')
          return this.setPhase({ kind: 'auth', message: f.message, removed: !!f.removed, pairing: this.auth.kind !== 'resume' })
        return
      case 'hi': {
        if (!this.hi || this.channel) return this.ws?.close()
        const a = this.auth
        const secret = a.kind === 'resume' ? a.key : a.secret
        const ch = phoneFinish(this.hi.hi, this.hi.priv, secret, f)
        if (!ch) {
          // 对面不知道密钥：不是我们的电脑（或中转在捣乱）。按凭证失效处理。
          return this.setPhase({
            kind: 'auth',
            message: a.kind === 'resume' ? t('removedLead') : t('expiredLead'),
            removed: a.kind === 'resume',
            pairing: a.kind !== 'resume'
          })
        }
        this.channel = ch
        this.setPhase({ kind: 'connecting', step: 1 })
        const standalone =
          window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
        this.send({ t: 'hello', v: WEB_PROTOCOL_VERSION, name: this.deviceName, kind: standalone ? 'standalone' : 'browser' })
        return
      }
      case 'x': {
        const payload = this.channel?.open(f) as WebServerFrame | undefined
        if (!payload) return this.ws?.close()
        this.onFrame(payload)
        return
      }
    }
  }

  private onFrame(f: WebServerFrame): void {
    switch (f.t) {
      case 'paired':
        // 之后的重连改用设备密钥。
        {
          const key = b64uDecode(f.key)
          if (key) this.auth = { kind: 'resume', device: f.device, key }
          this.ev.onPaired(f.device, f.key)
        }
        return
      case 'ok':
        this.attempt = 0
        if (this.handshake !== null) window.clearTimeout(this.handshake)
        this.handshake = null
        this.setPhase({ kind: 'connecting', step: 2 })
        this.ev.onFrame(f)
        this.setPhase({ kind: 'ready' })
        if (document.visibilityState !== 'visible') this.send({ t: 'visible', visible: false })
        return
      case 'removed':
        this.setPhase({ kind: 'auth', message: t('removedLead'), removed: true, pairing: false })
        this.ws?.close()
        return
      case 'file_chunk': {
        const c = this.chunks.get(f.rid)
        if (!c) return
        const bytes = b64uDecode(f.data)
        if (!bytes || f.seq !== c.parts.length) {
          this.chunks.delete(f.rid)
          return
        }
        c.parts.push(bytes)
        c.got += bytes.length
        c.onProgress?.(c.total ? c.got / c.total : 0)
        break
      }
      default:
        break
    }
    for (const w of [...this.waiters]) if (w.match(f)) this.settle(w, f)
    this.ev.onFrame(f)
  }

  private settle(w: Waiter, f: WebServerFrame | null): void {
    if (!this.waiters.delete(w)) return
    window.clearTimeout(w.timer)
    w.resolve(f)
  }

  /** 等一帧（超时 / 断线返回 null）。 */
  private wait(match: (f: WebServerFrame) => boolean, ms = REQUEST_TIMEOUT_MS): Promise<WebServerFrame | null> {
    return new Promise((resolve) => {
      const w: Waiter = { match, resolve, timer: 0 }
      w.timer = window.setTimeout(() => this.settle(w, null), ms)
      this.waiters.add(w)
    })
  }

  send(f: WebClientFrame): boolean {
    const ws = this.ws
    const ch = this.channel
    if (!ws || ws.readyState !== WebSocket.OPEN || !ch) return false
    ws.send(JSON.stringify(ch.seal(f)))
    return true
  }

  private id(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${(++this.seq).toString(36)}`
  }

  // ───────── 请求 ─────────

  refresh(): void {
    this.send({ t: 'refresh' })
  }

  /** 历史：缺省取最新一页；before = 往前翻一页；from = 补拉从这条到最后。 */
  /** 不带 before = 最新一页，同时告诉电脑正看着这个对话（进行中的新内容会直接推来）。 */
  history(sid: string, opts: { before?: number } = {}): void {
    this.send({ t: 'history', sid, before: opts.before })
  }

  /** 可选的模型列表（取不到返回 null）。 */
  async models(): Promise<WebModel[] | null> {
    const rid = this.id('m')
    const r = this.wait((f) => f.t === 'models' && f.rid === rid)
    if (!this.send({ t: 'models', rid })) return null
    const f = await r
    return f && f.t === 'models' ? f.list : null
  }

  stopTurn(sid: string): void {
    this.send({ t: 'stop', sid })
  }

  /** at = 这条消息在对话记录里的 id（电脑回执给出；插入进行中这一轮的没有）。 */
  async sendText(sid: string, text: string, files?: string[]): Promise<{ ok: boolean; message?: string; at?: string }> {
    const cid = this.id('c')
    const r = this.wait((f) => f.t === 'sent' && f.cid === cid)
    if (!this.send({ t: 'send', sid, text, cid, files: files?.length ? files : undefined })) return { ok: false, message: t('notConnected') }
    const f = await r
    return f && f.t === 'sent' ? { ok: f.ok, message: f.message, at: f.at } : { ok: false, message: t('timeout') }
  }

  /**
   * 新建对话：对话 id 在手机上先定好，不等电脑回执就能进入对话页、接着发消息（帧按顺序到达，电脑先建好再处理后面的）。
   * done = 电脑的回执：null = 建好了，否则是出错原因。没连上返回 null。
   */
  createSession(personaId?: string): { sid: string; done: Promise<string | null> } | null {
    const sid = newSessionId()
    const rid = this.id('r')
    const r = this.wait((f) => f.t === 'created' && f.rid === rid)
    if (!this.send({ t: 'new', rid, personaId, sid })) return null
    return { sid, done: r.then((f) => (f && f.t === 'created' ? (f.error ?? null) : t('timeout'))) }
  }

  async result(frame: (rid: string) => WebClientFrame): Promise<{ ok: boolean; message: string }> {
    const rid = this.id('a')
    const r = this.wait((f) => f.t === 'result' && f.rid === rid)
    if (!this.send(frame(rid))) return { ok: false, message: t('notConnected') }
    const f = await r
    return f && f.t === 'result' ? { ok: f.ok, message: f.message } : { ok: false, message: t('timeout') }
  }

  async installTicket(): Promise<string | null> {
    const rid = this.id('i')
    const r = this.wait((f) => f.t === 'install' && f.rid === rid)
    if (!this.send({ t: 'install', rid })) return null
    const f = await r
    return f && f.t === 'install' ? f.ticket : null
  }

  setPush(sub: WebPushSub | null): Promise<{ ok: boolean; message: string }> {
    return this.result((rid) => ({ t: 'push', rid, sub }))
  }

  async image(sid: string, ref: string): Promise<string | null> {
    const rid = this.id('g')
    const r = this.wait((f) => f.t === 'image' && f.rid === rid)
    if (!this.send({ t: 'image', rid, sid, ref })) return null
    const f = await r
    return f && f.t === 'image' ? f.uri : null
  }

  /** 取交付文件：文字直接返回；字节分块收齐后拼成 Blob。 */
  async file(sid: string, tool: string, index: number, onProgress?: (p: number) => void): Promise<FileResult> {
    const rid = this.id('f')
    const head = this.wait((f) => f.t === 'file' && f.rid === rid, 30_000)
    this.chunks.set(rid, { parts: [], total: 0, got: 0, onProgress })
    if (!this.send({ t: 'file', rid, sid, tool, index })) {
      this.chunks.delete(rid)
      return { ok: false, message: t('notConnected') }
    }
    const h = await head
    if (!h || h.t !== 'file') {
      this.chunks.delete(rid)
      return { ok: false, message: t('timeout') }
    }
    if (!h.ok || !h.chunks) {
      this.chunks.delete(rid)
      return { ok: h.ok, message: h.message, name: h.name, size: h.size, mime: h.mime, kind: h.kind, text: h.text, truncated: h.truncated }
    }
    const c = this.chunks.get(rid)!
    c.total = h.size ?? 0
    // 块之间留足时间（慢网络上 30 MB 也能取完），超过 30 秒没有新块算失败。
    while (c.parts.length < h.chunks) {
      const before = c.parts.length
      await this.wait((f) => f.t === 'file_chunk' && f.rid === rid, 30_000)
      if (c.parts.length === before) {
        this.chunks.delete(rid)
        return { ok: false, message: t('timeout') }
      }
    }
    this.chunks.delete(rid)
    return {
      ok: true,
      name: h.name,
      size: h.size,
      mime: h.mime,
      kind: h.kind,
      blob: new Blob(c.parts as BlobPart[], { type: h.mime || 'application/octet-stream' })
    }
  }

  /** 等连上电脑（已连上立即返回）。等不到、凭证失效、已停止或被取消返回 false。 */
  private async whenReady(ms: number, signal?: AbortSignal): Promise<boolean> {
    const until = Date.now() + ms
    while (!this.ready) {
      if (this.closed || signal?.aborted || this.phase.kind === 'auth' || this.phase.kind === 'version' || Date.now() > until) return false
      await new Promise((res) => setTimeout(res, 150))
    }
    return true
  }

  /**
   * 上传。选文件 / 拍照时页面被系统的选择器盖住、退到后台，回来时连接常常已断或正在重连：先等连上再传，
   * 传到一半断了就等重连后从头再传一次（电脑端按 uid 记，每次用新的 uid），不直接报「还没连上电脑」。
   */
  async upload(blob: Blob, name: string, onProgress: (p: number) => void, signal?: AbortSignal): Promise<{ uid?: string; message?: string }> {
    let last: { uid?: string; message?: string } = { message: t('notConnected') }
    for (let i = 0; i < UPLOAD_TRIES; i++) {
      if (!(await this.whenReady(UPLOAD_WAIT_MS, signal))) return signal?.aborted ? { message: t('cancel') } : last
      onProgress(0)
      const r = await this.uploadOnce(blob, name, onProgress, signal)
      if (!r.lost || signal?.aborted) return r
      last = r
    }
    return last
  }

  /** 传一次：begin → 等 ready → 分块（按发送缓冲节流）→ end → 等 done。成功返回上传 id；lost = 连接断了（可重传）。 */
  private async uploadOnce(
    blob: Blob,
    name: string,
    onProgress: (p: number) => void,
    signal?: AbortSignal
  ): Promise<{ uid?: string; message?: string; lost?: boolean }> {
    const uid = this.id('u')
    const ready = this.wait((f) => f.t === 'upload' && f.uid === uid)
    if (!this.send({ t: 'up_begin', uid, name, size: blob.size, mime: blob.type })) return { message: t('notConnected'), lost: true }
    const r = await ready
    if (!r || r.t !== 'upload') return { message: t('timeout'), lost: true }
    if (r.state !== 'ready') return { message: r.message }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let seq = 0
    for (let off = 0; off < bytes.length; off += FILE_CHUNK_BYTES) {
      if (signal?.aborted) {
        this.send({ t: 'up_cancel', uid })
        return { message: t('cancel') }
      }
      while (this.ws && this.ws.bufferedAmount > BUFFER_HIGH) await new Promise((res) => setTimeout(res, 50))
      if (!this.send({ t: 'up_chunk', uid, seq: seq++, data: b64uEncode(bytes.subarray(off, off + FILE_CHUNK_BYTES)) }))
        return { message: t('notConnected'), lost: true }
      onProgress(Math.min(1, (off + FILE_CHUNK_BYTES) / Math.max(1, bytes.length)))
      // 让出主线程：加密与 base64 都在这里做，大文件别把界面卡住。
      await new Promise((res) => setTimeout(res, 0))
    }
    const done = this.wait((f) => f.t === 'upload' && f.uid === uid && f.state !== 'ready', 60_000)
    if (!this.send({ t: 'up_end', uid })) return { message: t('notConnected'), lost: true }
    const d = await done
    if (d && d.t === 'upload' && d.state === 'done') return { uid }
    return d && d.t === 'upload' ? { message: d.message } : { message: t('timeout'), lost: true }
  }
}

/** 配对时报给电脑端的设备名（电脑上「已连接的手机」里显示）。 */
export function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) {
    // 例：Mozilla/5.0 (Linux; Android 14; 23013RK75C Build/…) → 23013RK75C 不好认，统一叫 Android 手机。
    return 'Android'
  }
  // 电脑上用浏览器打开网页版（不方便扫码时的「在浏览器中打开」）。
  if (/Macintosh/.test(ua)) return isEn ? 'Mac browser' : 'Mac 浏览器'
  if (/Windows/.test(ua)) return isEn ? 'Windows browser' : 'Windows 浏览器'
  if (/Linux/.test(ua)) return isEn ? 'Linux browser' : 'Linux 浏览器'
  return t('phone')
}
