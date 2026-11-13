import {
  WEB_PROTOCOL_VERSION,
  parseWebPageParams,
  type WebClientFrame,
  type WebMessage,
  type WebNotice,
  type WebPersona,
  type WebPrompt,
  type WebServerFrame,
  type WebSession
} from '../shared/remote-web'
import type { ActionValue } from '../shared/remote-views'

/**
 * 与桌面端的连接（WebSocket）。内网直连时连本页所在主机的 /ws；经中转时（地址 # 里带 d=桌面 id）连中转的
 * /d/<桌面 id>/ws。token 存在 localStorage（按主机 + 桌面 id 区分），首次打开用 # 里的一次性配对码换 token。
 * 断线自动重连；每次连上都重新 hello，拿到完整的对话 / 角色列表。
 */

export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'ready' }
  /** 需要配对码（没有 token / token 失效 / 配对码错误）。 */
  | { kind: 'pair'; message?: string }
  /** 中转说这台电脑的 Deva 不在线。 */
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

export interface Hello {
  user: { id: string; name?: string }
  bot: { name: string; computer: string }
  sessions: WebSession[]
  prompts: WebPrompt[]
}

export interface LinkEvents {
  onState(state: LinkState): void
  onHello(h: Hello): void
  onSessions(list: WebSession[]): void
  onSession(s: WebSession): void
  onSessionGone(sid: string): void
  onPersonas(list: WebPersona[]): void
  onHistory(sid: string, messages: WebMessage[], start: number, total: number): void
  onPrompt(p: WebPrompt): void
  onNotice(n: WebNotice): void
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15_000
const REQUEST_TIMEOUT_MS = 20_000
const PING_EVERY_MS = 25_000

type Pending = { resolve: (v: unknown) => void; timer: number }

export class Link {
  readonly deskId: string | null
  private pairCode: string | null
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: number | null = null
  private ping: number | null = null
  private seq = 0
  private pending = new Map<string, Pending>()
  private offline = false

  constructor(private ev: LinkEvents) {
    const p = parseWebPageParams(location.hash)
    this.deskId = p.d ?? null
    this.pairCode = p.c ?? null
    // 配对码用过一次就该从地址栏消失（分享截图 / 收藏时不带着它）。
    if (p.c) history.replaceState(null, '', location.pathname + location.search + (p.d ? `#d=${encodeURIComponent(p.d)}` : ''))
  }

  get viaRelay(): boolean {
    return this.deskId !== null
  }

  private get tokenKey(): string {
    return `deva.web.token:${location.host}:${this.deskId ?? ''}`
  }

  private get token(): string | null {
    try {
      return localStorage.getItem(this.tokenKey)
    } catch {
      return null
    }
  }

  private set token(v: string | null) {
    try {
      if (v) localStorage.setItem(this.tokenKey, v)
      else localStorage.removeItem(this.tokenKey)
    } catch {
      /* 隐私模式等：本次会话内仍可用，刷新后要重新扫码 */
    }
  }

  /** 断开这台手机：丢掉 token（电脑端的白名单里仍有记录，要在电脑上移除）。 */
  forget(): void {
    this.token = null
  }

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = this.deskId ? `/d/${encodeURIComponent(this.deskId)}/ws` : '/ws'
    return `${proto}//${location.host}${path}`
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
  }

  /** 回到前台 / 网络恢复：不等退避，立刻重连。 */
  private onVisible = (): void => {
    if (document.visibilityState !== 'visible' || this.closed) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    this.attempt = 0
    this.clearTimers()
    this.connect()
  }

  /** 用户手动输入配对码。 */
  pair(code: string): void {
    this.pairCode = code.trim()
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.sendPair()
    else {
      this.attempt = 0
      this.clearTimers()
      this.connect()
    }
  }

  private sendPair(): void {
    if (this.pairCode) this.send({ t: 'pair', v: WEB_PROTOCOL_VERSION, code: this.pairCode, name: deviceName() })
  }

  // ───────── 请求 ─────────

  refresh(): void {
    this.send({ t: 'refresh' })
  }

  history(sid: string, before?: number): void {
    this.send({ t: 'history', sid, before })
  }

  stopTurn(sid: string): void {
    this.send({ t: 'stop', sid })
  }

  sendText(sid: string, text: string): Promise<{ ok: boolean; message?: string }> {
    const cid = `c${++this.seq}`
    return this.request(cid, { t: 'send', sid, text, cid }) as Promise<{ ok: boolean; message?: string }>
  }

  newSession(personaId?: string): Promise<{ sid?: string; error?: string }> {
    const rid = `r${++this.seq}`
    return this.request(rid, { t: 'new', rid, personaId }) as Promise<{ sid?: string; error?: string }>
  }

  action(key: string, value: ActionValue, form?: Record<string, string | string[]>): Promise<{ ok: boolean; message: string }> {
    const rid = `a${++this.seq}`
    return this.request(rid, { t: 'action', rid, key, value, form }) as Promise<{ ok: boolean; message: string }>
  }

  private request(id: string, frame: WebClientFrame): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: t('timeout'), message: t('timeout') })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      if (!this.send(frame)) {
        window.clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: t('notConnected'), message: t('notConnected') })
      }
    })
  }

  private settle(id: string, value: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    window.clearTimeout(p.timer)
    p.resolve(value)
  }

  private send(f: WebClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(f))
    return true
  }

  // ───────── 连接 ─────────

  private clearTimers(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    if (this.ping !== null) window.clearInterval(this.ping)
    this.ping = null
  }

  private connect(): void {
    if (this.closed) return
    this.ws?.close()
    this.ev.onState({ kind: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch (e) {
      this.ev.onState({ kind: 'error', message: (e as Error).message })
      return this.scheduleReconnect()
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.attempt = 0
      const token = this.token
      if (token) this.send({ t: 'hello', v: WEB_PROTOCOL_VERSION, token })
      else if (this.pairCode) this.sendPair()
      else this.ev.onState({ kind: 'pair' })
      this.ping = window.setInterval(() => this.send({ t: 'ping' }), PING_EVERY_MS)
    }
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== 'string') return
      let f: WebServerFrame
      try {
        f = JSON.parse(e.data) as WebServerFrame
      } catch {
        return
      }
      this.onFrame(f)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.ping !== null) window.clearInterval(this.ping)
      this.ping = null
      if (this.closed) return
      this.scheduleReconnect()
    }
    ws.onerror = () => undefined
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer !== null) return
    // 没有 token 又没有配对码：等用户输入，不空转重连。
    if (!this.token && !this.pairCode) return
    if (!this.offline) this.ev.onState({ kind: 'connecting' })
    const delay = this.offline ? 5000 : Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt, 4))
    this.attempt++
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private onFrame(f: WebServerFrame): void {
    switch (f.t) {
      case 'ok':
        this.offline = false
        this.pairCode = null
        this.ev.onHello({ user: f.user, bot: f.bot, sessions: f.sessions, prompts: f.prompts })
        if (f.personas.length) this.ev.onPersonas(f.personas)
        this.ev.onState({ kind: 'ready' })
        return
      case 'paired':
        this.token = f.token
        this.pairCode = null
        this.send({ t: 'hello', v: WEB_PROTOCOL_VERSION, token: f.token })
        return
      case 'err':
        if (f.code === 'unauthorized') {
          this.token = null
          if (this.pairCode) this.sendPair()
          else this.ev.onState({ kind: 'pair' })
        } else if (f.code === 'pair') {
          this.pairCode = null
          this.ev.onState({ kind: 'pair', message: f.message })
        } else if (f.code === 'version') this.ev.onState({ kind: 'error', message: f.message })
        return
      case 'offline':
        this.offline = true
        this.ev.onState({ kind: 'offline' })
        return
      case 'sessions':
        return this.ev.onSessions(f.list)
      case 'session':
        return this.ev.onSession(f.s)
      case 'session_gone':
        return this.ev.onSessionGone(f.sid)
      case 'personas':
        return this.ev.onPersonas(f.list)
      case 'history':
        return this.ev.onHistory(f.sid, f.messages, f.start, f.total)
      case 'prompt':
        return this.ev.onPrompt(f.p)
      case 'notice':
        return this.ev.onNotice(f.n)
      case 'sent':
        return this.settle(f.cid, { ok: f.ok, message: f.message })
      case 'created':
        return this.settle(f.rid, { sid: f.sid, error: f.error })
      case 'result':
        return this.settle(f.rid, { ok: f.ok, message: f.message })
      case 'pong':
        return
    }
  }
}

/** 配对时报给电脑端的设备名（面板「可以使用的账号」里显示）。 */
export function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return t('phone')
}

// ───────── 极简文案（界面壳子两种语言；对话内容由电脑端生成，与其界面语言一致）─────────

const EN = /^en\b/i.test(navigator.language)

const STR = {
  phone: ['手机', 'Phone'],
  timeout: ['操作超时，请重试。', 'Timed out, please try again.'],
  notConnected: ['尚未连接到电脑。', 'Not connected to the computer.'],
  connecting: ['连接中…', 'Connecting…'],
  ready: ['已连接', 'Connected'],
  offline: ['电脑上的 Deva 不在线', 'Deva on the computer is offline'],
  offlineHint: ['请确认电脑上的 Deva 正在运行并已连上中转，连上后这里会自动恢复。', 'Make sure Deva is running on the computer and connected to the relay. This page reconnects automatically.'],
  disconnected: ['连接断开，正在重连…', 'Disconnected, reconnecting…'],
  pairTitle: ['连接到电脑上的 Deva', 'Connect to Deva on your computer'],
  pairLead: ['在电脑端 Deva 的「机器人」面板里点「显示二维码」，用手机扫码；或把二维码下方的配对码输入在这里。', 'Open the Bots panel in Deva on your computer, tap “Show QR code” and scan it, or type the pairing code shown under it here.'],
  pairPlaceholder: ['6 位配对码', '6-digit code'],
  pairSubmit: ['连接', 'Connect'],
  tabChats: ['对话', 'Chats'],
  tabContacts: ['角色', 'Personas'],
  tabMe: ['我', 'Me'],
  search: ['搜索', 'Search'],
  newChat: ['新对话', 'New chat'],
  pickPersona: ['选一个角色', 'Pick a persona'],
  chatsEmpty: ['还没有对话。点右上角 + 开始。', 'No chats yet. Tap + to start one.'],
  noResult: ['没有匹配的结果', 'No matches'],
  busy: ['处理中', 'Working'],
  waiting: ['等你决定', 'Needs you'],
  me: ['我：', 'Me: '],
  task: ['定时任务', 'Scheduled task'],
  tasks: ['定时任务', 'Scheduled tasks'],
  disabled: ['已停用', 'Disabled'],
  model: ['模型', 'Model'],
  followDefault: ['跟随默认', 'Default'],
  workspace: ['工作区', 'Workspace'],
  noWorkspace: ['未挂载', 'Not mounted'],
  recentChats: ['最近对话', 'Recent chats'],
  allChats: ['全部对话', 'All chats'],
  message: ['发消息', 'Message'],
  continueLast: ['继续上一个', 'Continue last'],
  avatarCustom: ['头像：你上传的图片', 'Avatar: your uploaded image'],
  avatarAuto: ['头像：自动生成', 'Avatar: generated'],
  composer: ['发消息…', 'Message…'],
  composerBusy: ['发消息，会插到这一轮里…', 'Message (inserted into this turn)…'],
  send: ['发送', 'Send'],
  stop: ['停止', 'Stop'],
  loadMore: ['查看更早的消息', 'Load earlier messages'],
  chatEmpty: ['还没有消息，发一条开始吧。', 'No messages yet. Say something.'],
  idle: ['空闲', 'Idle'],
  submit: ['提交', 'Submit'],
  other: ['其他 / 补充说明', 'Other / notes'],
  freeText: ['在此输入答案', 'Type your answer'],
  required: ['必答', 'Required'],
  optional: ['可跳过', 'Optional'],
  multi: ['可多选', 'Multiple'],
  expand: ['展开', 'Expand'],
  collapse: ['收起', 'Collapse'],
  errorTitle: ['出错了', 'Something went wrong'],
  computer: ['电脑', 'Computer'],
  viaLan: ['内网直连', 'Local network'],
  viaRelay: ['经中转', 'Via relay'],
  thisPhone: ['这台手机', 'This phone'],
  pairedAs: ['在电脑上显示为', 'Shown on the computer as'],
  notifications: ['通知', 'Notifications'],
  notifHint: ['回复完成、需要你决定时提醒', 'Alert when a reply finishes or needs you'],
  notifNeedHttps: ['浏览器要求 HTTPS 才能通知；经中转访问时可用', 'Browser notifications need HTTPS; available via relay'],
  notifDenied: ['已被浏览器拒绝，请在浏览器设置里允许', 'Blocked by the browser; allow it in browser settings'],
  addToHome: ['添加到主屏幕', 'Add to home screen'],
  addToHomeHint: ['像 App 一样打开', 'Open it like an app'],
  addToHomeIos: ['Safari 分享菜单 → 添加到主屏幕', 'Safari share menu → Add to Home Screen'],
  addToHomeAndroid: ['浏览器菜单 → 添加到主屏幕 / 安装应用', 'Browser menu → Add to Home screen / Install app'],
  disconnect: ['断开这台手机', 'Disconnect this phone'],
  disconnectHint: ['需要重新扫码才能再连', 'Scan again to reconnect'],
  version: ['协议版本', 'Protocol'],
  yesterday: ['昨天', 'Yesterday'],
  inserted: ['已插入', 'Inserted'],
  noticeOpen: ['查看', 'Open']
} as const

export type StrKey = keyof typeof STR

export function t(key: StrKey): string {
  return STR[key][EN ? 1 : 0]
}
