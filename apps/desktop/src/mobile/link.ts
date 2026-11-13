import {
  WEB_PROTOCOL_VERSION,
  parseWebPageParams,
  type WebClientFrame,
  type WebItem,
  type WebServerFrame
} from '../shared/remote-web'
import type { ActionValue } from '../shared/remote-views'

/**
 * 与桌面端的连接（WebSocket）。内网直连时连本页所在主机的 /ws；经中转时（地址 # 里带 d=桌面 id）连中转的
 * /d/<桌面 id>/ws。token 存在 localStorage（按主机 + 桌面 id 区分），首次打开用 # 里的一次性配对码换 token。
 * 断线自动重连；每次连上都重新 hello，拿整段记录覆盖本地。
 */

export type LinkState =
  | { kind: 'connecting' }
  | { kind: 'ready' }
  /** 需要配对码（没有 token / token 失效 / 配对码错误）。 */
  | { kind: 'pair'; message?: string }
  /** 中转说这台电脑的 Deva 不在线。 */
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

export interface Snapshot {
  user: { id: string; name?: string }
  bot: { name: string }
  items: WebItem[]
  typing: boolean
}

export interface LinkEvents {
  onState(state: LinkState): void
  onSnapshot(s: Snapshot): void
  onItem(item: WebItem): void
  onRemove(id: string): void
  onTyping(on: boolean): void
  onSent(cid: string, id: string): void
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 15_000
const ACTION_TIMEOUT_MS = 20_000
const PING_EVERY_MS = 25_000

export class Link {
  readonly deskId: string | null
  private pairCode: string | null
  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: number | null = null
  private ping: number | null = null
  private seq = 0
  private pending = new Map<string, { resolve: (r: { ok: boolean; message: string }) => void; timer: number }>()

  constructor(private ev: LinkEvents) {
    const p = parseWebPageParams(location.hash)
    this.deskId = p.d ?? null
    this.pairCode = p.c ?? null
    // 配对码用过一次就该从地址栏消失（分享截图 / 收藏时不带着它）。
    if (p.c || p.d) history.replaceState(null, '', location.pathname + location.search + (p.d ? `#d=${encodeURIComponent(p.d)}` : ''))
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ t: 'pair', v: WEB_PROTOCOL_VERSION, code: this.pairCode, name: deviceName() })
    else {
      this.attempt = 0
      this.clearTimers()
      this.connect()
    }
  }

  sendText(text: string): string {
    const cid = `c${++this.seq}`
    this.send({ t: 'send', cid, text })
    return cid
  }

  action(id: string, value: ActionValue, form?: Record<string, string | string[]>): Promise<{ ok: boolean; message: string }> {
    const rid = `r${++this.seq}`
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(rid)
        resolve({ ok: false, message: t('timeout') })
      }, ACTION_TIMEOUT_MS)
      this.pending.set(rid, { resolve, timer })
      if (!this.send({ t: 'action', rid, id, value, form })) {
        window.clearTimeout(timer)
        this.pending.delete(rid)
        resolve({ ok: false, message: t('notConnected') })
      }
    })
  }

  private send(f: WebClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(f))
    return true
  }

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
      else if (this.pairCode) this.send({ t: 'pair', v: WEB_PROTOCOL_VERSION, code: this.pairCode, name: deviceName() })
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

  private offline = false

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
        this.ev.onSnapshot({ user: f.user, bot: f.bot, items: f.items, typing: f.typing })
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
          if (this.pairCode) this.send({ t: 'pair', v: WEB_PROTOCOL_VERSION, code: this.pairCode, name: deviceName() })
          else this.ev.onState({ kind: 'pair' })
        } else if (f.code === 'pair') {
          this.pairCode = null
          this.ev.onState({ kind: 'pair', message: f.message })
        } else this.ev.onState({ kind: 'error', message: f.message })
        return
      case 'offline':
        this.offline = true
        this.ev.onState({ kind: 'offline' })
        return
      case 'item':
        return this.ev.onItem(f.item)
      case 'remove':
        return this.ev.onRemove(f.id)
      case 'typing':
        return this.ev.onTyping(f.on)
      case 'sent':
        return this.ev.onSent(f.cid, f.id)
      case 'result': {
        const p = this.pending.get(f.rid)
        if (!p) return
        this.pending.delete(f.rid)
        window.clearTimeout(p.timer)
        p.resolve({ ok: f.ok, message: f.message })
        return
      }
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
  composer: ['发消息…', 'Message…'],
  send: ['发送', 'Send'],
  typing: ['正在输入…', 'Typing…'],
  cmdNew: ['新对话', 'New chat'],
  cmdList: ['对话列表', 'Chats'],
  cmdStop: ['停止', 'Stop'],
  cmdStatus: ['当前对话', 'Status'],
  cmdHelp: ['帮助', 'Help'],
  submit: ['提交', 'Submit'],
  other: ['其他 / 补充说明', 'Other / notes'],
  freeText: ['在此输入答案', 'Type your answer'],
  required: ['必答', 'Required'],
  optional: ['可跳过', 'Optional'],
  multi: ['可多选', 'Multiple'],
  expand: ['展开', 'Expand'],
  collapse: ['收起', 'Collapse'],
  empty: ['还没有消息。直接发一条，就会在电脑上的当前对话里继续聊。', 'No messages yet. Send one to continue the current chat on your computer.'],
  errorTitle: ['出错了', 'Something went wrong'],
  retry: ['重试', 'Retry']
} as const

export type StrKey = keyof typeof STR

export function t(key: StrKey): string {
  return STR[key][EN ? 1 : 0]
}
