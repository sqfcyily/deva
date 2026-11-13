import { createHash, randomBytes } from 'node:crypto'
import { WEB_PROTOCOL_VERSION, type WebItem, type WebServerFrame } from '../../../../shared/remote-web'
import { redeemPairCode } from '../hub'
import { getBot, updateBot } from '../store'
import type {
  AdapterHost,
  ChannelId,
  ChatAddress,
  MessageHandle,
  NoticeView,
  PromptView,
  RemoteAdapter,
  ReplyView,
  TurnPage
} from '../types'
import type { Conn, ConnHandlers, ConnSink } from './conn'
import { ItemLog } from './log'
import { startLanServer, type LanServer } from './server'
import { startRelayClient, type RelayClient, type RelayState } from './relay'

/**
 * 手机网页适配器：把 hub 的视图原样（JSON）推给手机，手机端自己渲染；没有平台限频与消息体积限制。
 *
 *  · 一个配对用户 = 一个「私聊」（chatId 即用户 id），同一用户可以多台设备同时在线，记录与状态同步。
 *  · 两种接入方式可同时开：内网直连（自带 HTTP 服务，见 server.ts）与经中转（见 relay.ts）；
 *    不论从哪条路来，连接都长成 Conn，这里统一鉴权、收发。
 *  · 鉴权：扫码页用一次性配对码（hub 签发）换长期 token；token 只存哈希（settings.tokens），
 *    用户在面板上被移除后其 token 自然失效（校验时还要求用户仍在白名单）。
 */

export interface WebAdapterOptions {
  port: number
  lan: boolean
  relay: { enabled: boolean; url: string; deskId: string; key: string }
  /** 聊天记录文件。 */
  logFile: string
  botName: () => string
}

export interface WebStatus {
  lan: 'off' | 'on' | 'error'
  lanError?: string
  relay: 'off' | RelayState
  relayError?: string
}

interface TokenRecord {
  user: string
  at: number
}

/** 发给手机的记录条数（整段同步，再多手机上也翻不到）。 */
const SYNC_ITEMS = 100

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export class WebAdapter implements RemoteAdapter, ConnSink {
  readonly platform = 'web' as const
  readonly minUpdateMs = 300
  readonly pageChars = 20_000

  private host: AdapterHost | null = null
  private log: ItemLog
  private conns = new Set<Conn>()
  private typing = new Set<string>()
  private lan: LanServer | null = null
  private relay: RelayClient | null = null
  private status: WebStatus = { lan: 'off', relay: 'off' }
  private stopped = false

  constructor(
    readonly id: ChannelId,
    private opts: WebAdapterOptions
  ) {
    this.log = new ItemLog(opts.logFile)
  }

  getStatus(): WebStatus {
    return { ...this.status }
  }

  async start(host: AdapterHost): Promise<void> {
    this.host = host
    this.stopped = false
    host.onState('connecting')
    if (!this.opts.lan && !this.opts.relay.enabled) {
      host.onState('error', '内网直连与中转都没有启用，手机无法连接。')
      return
    }
    if (this.opts.lan) {
      try {
        this.lan = await startLanServer(this.opts.port, this)
        this.status.lan = 'on'
        this.status.lanError = undefined
      } catch (e) {
        this.status.lan = 'error'
        this.status.lanError = (e as Error)?.message ?? String(e)
      }
    }
    if (this.opts.relay.enabled) {
      this.status.relay = 'connecting'
      this.relay = startRelayClient({
        url: this.opts.relay.url,
        deskId: this.opts.relay.deskId,
        key: this.opts.relay.key,
        sink: this,
        onState: (state, error) => {
          if (this.stopped) return
          this.status.relay = state
          this.status.relayError = state === 'error' ? error : undefined
          this.publishState()
        }
      })
    }
    this.publishState()
  }

  /** 任一接入方式可用即「已连接」；都不可用时报错（优先报内网的错，更常见也更好修）。 */
  private publishState(): void {
    if (!this.host || this.stopped) return
    const s = this.status
    if (s.lan === 'on' || s.relay === 'on') this.host.onState('connected')
    else if (s.relay === 'connecting') this.host.onState('connecting')
    else this.host.onState('error', s.lanError ?? s.relayError ?? '没有可用的接入方式。')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.relay?.close()
    this.relay = null
    const lan = this.lan
    this.lan = null
    for (const c of [...this.conns]) c.close()
    this.conns.clear()
    this.status = { lan: 'off', relay: 'off' }
    this.log.flush()
    if (lan) await lan.close()
  }

  // ───────── 连接与鉴权（ConnSink）─────────

  attach(conn: Conn): ConnHandlers {
    this.conns.add(conn)
    return {
      onFrame: (f) => {
        try {
          this.onFrame(conn, f)
        } catch (e) {
          console.warn('[remote/web] 处理帧失败：', (e as Error)?.message ?? e)
        }
      },
      onClose: () => {
        this.conns.delete(conn)
      }
    }
  }

  private onFrame(conn: Conn, f: Parameters<ConnHandlers['onFrame']>[0]): void {
    if (f.t === 'ping') return conn.send({ t: 'pong' })
    if (f.t === 'hello' || f.t === 'pair') {
      if (f.v !== WEB_PROTOCOL_VERSION) {
        conn.send({ t: 'err', code: 'version', message: '手机网页与电脑端 Deva 的版本不匹配，请刷新页面或更新 Deva。' })
        return conn.close()
      }
      if (f.t === 'hello') return this.hello(conn, f.token)
      return this.pair(conn, f.code, f.name)
    }
    const uid = conn.user
    if (!uid) {
      conn.send({ t: 'err', code: 'unauthorized', message: '尚未登录。' })
      return conn.close()
    }
    if (f.t === 'send') return this.inboundText(conn, uid, f.cid, f.text)
    if (f.t === 'action') return void this.inboundAction(conn, uid, f.rid, f.id, f.value, f.form)
  }

  private hello(conn: Conn, token: string): void {
    const uid = typeof token === 'string' && token ? this.userOfToken(token) : null
    if (!uid) {
      conn.send({ t: 'err', code: 'unauthorized', message: '登录已失效，请在电脑端重新扫码。' })
      return
    }
    conn.user = uid
    const me = getBot(this.id)?.users.find((u) => u.id === uid)
    conn.send({
      t: 'ok',
      v: WEB_PROTOCOL_VERSION,
      user: { id: uid, name: me?.name },
      bot: { name: this.opts.botName() },
      items: this.log.items(uid, SYNC_ITEMS),
      typing: this.typing.has(uid)
    })
  }

  private pair(conn: Conn, code: unknown, name: unknown): void {
    const c = typeof code === 'string' ? code.trim() : ''
    const uid = `u_${randomBytes(6).toString('hex')}`
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : '手机'
    const r = redeemPairCode(this.id, { id: uid, name: label }, uid, c)
    if (!r.ok) return conn.send({ t: 'err', code: 'pair', message: r.message })
    const token = randomBytes(32).toString('base64url')
    this.storeToken(token, uid)
    conn.send({ t: 'paired', token })
    // 打个招呼，顺带把使用说明放进记录里。
    this.push(uid, {
      id: this.log.next(uid),
      at: Date.now(),
      kind: 'notice',
      view: {
        tone: 'success',
        title: '已连接到 Deva',
        text: '直接发消息就能在当前对话里继续聊；底部的快捷按钮可以新建对话、切换对话或停止回复。'
      }
    })
  }

  private tokens(): Record<string, TokenRecord> {
    const raw = getBot(this.id)?.settings.tokens
    return raw && typeof raw === 'object' ? (raw as Record<string, TokenRecord>) : {}
  }

  private userOfToken(token: string): string | null {
    const rec = this.tokens()[sha256(token)]
    if (!rec || typeof rec.user !== 'string') return null
    const bot = getBot(this.id)
    return bot?.users.some((u) => u.id === rec.user) ? rec.user : null
  }

  private storeToken(token: string, uid: string): void {
    updateBot(this.id, (b) => {
      const tokens = { ...this.tokens() }
      // 顺手清掉已不在白名单的用户留下的 token。
      for (const [h, rec] of Object.entries(tokens)) if (!b.users.some((u) => u.id === rec.user)) delete tokens[h]
      tokens[sha256(token)] = { user: uid, at: Date.now() }
      return { ...b, settings: { ...b.settings, tokens } }
    })
  }

  // ───────── 入站 ─────────

  private inboundText(conn: Conn, uid: string, cid: unknown, text: unknown): void {
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) return
    const id = this.log.next(uid)
    this.push(uid, { id, at: Date.now(), kind: 'user', text: body })
    if (typeof cid === 'string') conn.send({ t: 'sent', cid, id })
    const me = getBot(this.id)?.users.find((u) => u.id === uid)
    this.host?.onMessage({
      chat: this.chat(uid),
      user: { id: uid, name: me?.name },
      text: body,
      kind: 'text',
      messageId: id,
      ref: id
    })
  }

  private async inboundAction(
    conn: Conn,
    uid: string,
    rid: unknown,
    id: unknown,
    value: unknown,
    form: unknown
  ): Promise<void> {
    const reply = (ok: boolean, message: string): void => {
      if (typeof rid === 'string') conn.send({ t: 'result', rid, ok, message })
    }
    if (!value || typeof value !== 'object' || typeof (value as { k?: unknown }).k !== 'string')
      return reply(false, '无效的操作。')
    const me = getBot(this.id)?.users.find((u) => u.id === uid)
    try {
      const r = await this.host!.onAction({
        chat: this.chat(uid),
        user: { id: uid, name: me?.name },
        value: value as Parameters<AdapterHost['onAction']>[0]['value'],
        messageId: typeof id === 'string' ? id : undefined,
        form: form && typeof form === 'object' ? (form as Record<string, string | string[]>) : undefined
      })
      reply(r.ok, r.message)
    } catch (e) {
      reply(false, (e as Error)?.message ?? String(e))
    }
  }

  // ───────── 出站（RemoteAdapter）─────────

  private chat(uid: string): ChatAddress {
    return { channel: this.id, chatId: uid }
  }

  private emit(uid: string, frame: WebServerFrame): void {
    for (const c of this.conns) if (c.user === uid) c.send(frame)
  }

  private push(uid: string, item: WebItem): string {
    this.log.put(uid, item)
    this.emit(uid, { t: 'item', item })
    return item.id
  }

  /** 流式卡片（回复方式切成「流式」时才会用到）：整轮正文合成一条回复、原地更新。 */
  async renderTurn(chat: ChatAddress, page: TurnPage, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    const uid = chat.chatId
    const text = page.blocks
      .map((b) => (b.kind === 'text' ? b.text : b.kind === 'notice' ? `> ${b.text}` : `> ⚠ ${b.text}`))
      .join('\n\n')
    const note =
      page.status === 'running' || page.status === 'retrying' || page.status === 'waiting'
        ? page.statusText ?? '正在处理…'
        : page.status === 'aborted'
          ? '已停止'
          : page.statusText
    const id = handle ?? this.log.next(uid)
    return this.push(uid, { id, at: this.log.get(uid, id)?.at ?? Date.now(), kind: 'reply', text, note })
  }

  async renderPrompt(chat: ChatAddress, view: PromptView, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    const uid = chat.chatId
    const id = handle ?? this.log.next(uid)
    return this.push(uid, { id, at: this.log.get(uid, id)?.at ?? Date.now(), kind: 'prompt', view })
  }

  async sendNotice(chat: ChatAddress, view: NoticeView): Promise<MessageHandle | undefined> {
    const uid = chat.chatId
    return this.push(uid, { id: this.log.next(uid), at: Date.now(), kind: 'notice', view })
  }

  async sendReply(chat: ChatAddress, view: ReplyView): Promise<MessageHandle | undefined> {
    const uid = chat.chatId
    return this.push(uid, { id: this.log.next(uid), at: Date.now(), kind: 'reply', text: view.text, note: view.note })
  }

  async startTyping(chat: ChatAddress): Promise<void> {
    if (this.typing.has(chat.chatId)) return
    this.typing.add(chat.chatId)
    this.emit(chat.chatId, { t: 'typing', on: true })
  }

  async stopTyping(chat: ChatAddress): Promise<void> {
    if (!this.typing.delete(chat.chatId)) return
    this.emit(chat.chatId, { t: 'typing', on: false })
  }

  async deleteMessage(chat: ChatAddress, handle: MessageHandle): Promise<void> {
    if (this.log.remove(chat.chatId, handle)) this.emit(chat.chatId, { t: 'remove', id: handle })
  }

  /** 网页端的「私聊」就是用户本身：直接把通知放进他的记录。 */
  async openDirect(userId: string, view: NoticeView): Promise<string | undefined> {
    await this.sendNotice(this.chat(userId), view)
    return userId
  }

  /** 用户被移除：断开他的连接并删掉记录（index.ts 在 remove-user 时调用）。 */
  dropUser(uid: string): void {
    for (const c of [...this.conns]) if (c.user === uid) c.close()
    this.typing.delete(uid)
    this.log.drop(uid)
  }
}
