import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import {
  WEB_PROTOCOL_VERSION,
  type WebClientFrame,
  type WebMessage,
  type WebPersona,
  type WebPrompt,
  type WebServerFrame,
  type WebSession
} from '../../../../shared/remote-web'
import type { DisplayMessage } from '../../../../shared/chat-protocol'
import type { ContentPart } from '../../../providers/types'
import { getChatRuntime } from '../../chat'
import { onChatEvent, onSessionsChanged, type ChatEventPayload } from '../../chat-bus'
import { loadDisplay } from '../../chat-display'
import { getSession, listSessions, type ChatSessionMeta, type StoredSession } from '../../chat-store'
import { resolveDefaultEffort, resolveDefaultModel, resolveModelRefOrNull } from '../../model-resolve'
import { getPersona, listPersonas } from '../../personas'
import {
  RETRY_TEXT,
  TOOL_HINTS,
  allowedPersonas,
  allows,
  createSessionFor,
  inScope,
  pickPersona,
  redeemPairCode,
  runningTurnOf,
  sessionWaiting
} from '../hub'
import { getBot, updateBot } from '../store'
import type {
  AdapterHost,
  ChannelId,
  ChatAddress,
  MessageHandle,
  NoticeView,
  PromptView,
  RemoteAdapter
} from '../types'
import type { Conn, ConnHandlers, ConnSink } from './conn'
import { startLanServer, type LanServer } from './server'
import { startRelayClient, type RelayClient, type RelayState } from './relay'

/**
 * 手机网页适配器：手机端是桌面 Deva 的 IM 形态——对话列表、角色、任意对话的历史与最终回复。
 *
 *  · 对话记录的真源是电脑上的对话文件：历史按需拉（loadDisplay 的展示投影，只取正文），进行中只推
 *    「正在做什么」一行状态，回合结束再推一次对话摘要，手机据此刷新。不经 hub 的私聊 ↔ 对话绑定。
 *  · hub 仍负责：配对码、交互卡（提问 / 计划 / 挂载 / 名片）的生成与决议、应用通知。没有私聊绑定时
 *    hub 把它们推到每个配对用户的「私聊」（chatId = 用户 id），这里原样转成帧。
 *  · 两种接入方式可同时开：内网直连（server.ts）与经中转（relay.ts）；连接统一长成 Conn。
 *  · 鉴权：扫码页用一次性配对码换长期 token；token 只存哈希（settings.tokens），用户被移除后失效。
 */

export interface WebAdapterOptions {
  port: number
  lan: boolean
  relay: { enabled: boolean; url: string; deskId: string; key: string }
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

/** 进行中的对话：状态行与回合 id。 */
interface Live {
  turnId: string
  status?: string
}

const HISTORY_PAGE = 40
const PREVIEW_CHARS = 80
/** 同一对话两次状态推送的最小间隔。 */
const PUSH_MIN_MS = 400

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export class WebAdapter implements RemoteAdapter, ConnSink {
  readonly platform = 'web' as const
  readonly minUpdateMs = 300
  readonly pageChars = 20_000

  private host: AdapterHost | null = null
  private conns = new Set<Conn>()
  private lan: LanServer | null = null
  private relay: RelayClient | null = null
  private status: WebStatus = { lan: 'off', relay: 'off' }
  private stopped = false
  private unsubscribe: (() => void)[] = []
  private live = new Map<string, Live>()
  private prompts = new Map<string, WebPrompt>()
  private previews = new Map<string, { updatedAt: number; text: string; role?: 'user' | 'assistant' }>()
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pushedAt = new Map<string, number>()
  private listTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0

  constructor(
    readonly id: ChannelId,
    private opts: WebAdapterOptions
  ) {}

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
    this.unsubscribe.push(
      onChatEvent((p) => this.onEvent(p)),
      onSessionsChanged(() => this.scheduleList())
    )
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
    for (const off of this.unsubscribe.splice(0)) off()
    for (const t of this.pushTimers.values()) clearTimeout(t)
    this.pushTimers.clear()
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = null
    this.relay?.close()
    this.relay = null
    const lan = this.lan
    this.lan = null
    for (const c of [...this.conns]) c.close()
    this.conns.clear()
    this.status = { lan: 'off', relay: 'off' }
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

  private onFrame(conn: Conn, f: WebClientFrame): void {
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
    switch (f.t) {
      case 'refresh':
        conn.send({ t: 'sessions', list: this.sessionList() })
        conn.send({ t: 'personas', list: this.personaList() })
        return
      case 'history':
        return this.history(conn, f.sid, f.before, f.limit)
      case 'send':
        return void this.sendText(conn, f.sid, f.text, f.cid)
      case 'stop':
        return this.stopTurn(f.sid)
      case 'new':
        return this.newSession(conn, f.rid, f.personaId)
      case 'action':
        return void this.action(conn, uid, f.rid, f.value, f.form)
    }
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
      bot: { name: this.opts.botName(), computer: hostname() },
      personas: [],
      sessions: this.sessionList(),
      prompts: [...this.prompts.values()].filter((p) => p.view.state === 'open')
    })
    // 角色带头像图片，体积可能不小：单独一帧，免得首帧太大。
    conn.send({ t: 'personas', list: this.personaList() })
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

  /** 用户被移除：断开他的连接（index.ts 在 remove-user 时调用）。 */
  dropUser(uid: string): void {
    for (const c of [...this.conns]) if (c.user === uid) c.close()
  }

  // ───────── 列表与历史 ─────────

  private personaList(): WebPersona[] {
    const allowed = new Set(allowedPersonas(this.id).map((p) => p.id))
    const all = getBot(this.id)?.scope.mode === 'all'
    return listPersonas(true)
      .filter((p) => (p.enabled ? allowed.has(p.id) : all))
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        model: p.model,
        avatar: p.avatar,
        avatarImage: p.avatarImage,
        enabled: p.enabled
      }))
  }

  private sessionList(): WebSession[] {
    return listSessions()
      .filter((s) => !s.archived && !s.parentId && allows(this.id, s))
      .map((m) => this.sessionView(m))
  }

  private sessionView(m: ChatSessionMeta): WebSession {
    const live = this.live.get(m.id)
    const pv = this.preview(m.id, m.updatedAt)
    return {
      id: m.id,
      title: m.title || '新对话',
      personaId: m.personaId,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      preview: pv.text,
      previewRole: pv.role,
      busy: !!live || (getChatRuntime()?.isBusy(m.id) ?? false),
      waiting: sessionWaiting(m.id),
      status: live?.status,
      kind: m.id.startsWith('task-') ? 'task' : 'chat',
      focusRoot: m.focusRoot
    }
  }

  private preview(sid: string, updatedAt: number): { text: string; role?: 'user' | 'assistant' } {
    const hit = this.previews.get(sid)
    if (hit && hit.updatedAt === updatedAt) return hit
    const s = getSession(sid)
    const pv = s ? previewOf(s) : { text: '' }
    this.previews.set(sid, { updatedAt, ...pv })
    return pv
  }

  private history(conn: Conn, sid: unknown, before: unknown, limit: unknown): void {
    if (typeof sid !== 'string' || !getSession(sid) || !inScope(this.id, sid))
      return conn.send({ t: 'err', code: 'bad_request', message: '这个对话不存在或不在机器人的回复范围内。' })
    const all = loadDisplay(sid)
    const end = typeof before === 'number' && before >= 0 ? Math.min(before, all.length) : all.length
    const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : HISTORY_PAGE
    const start = Math.max(0, end - n)
    const messages: WebMessage[] = []
    for (let i = start; i < end; i++) {
      const m = toWebMessage(all[i], String(i))
      if (m) messages.push(m)
    }
    conn.send({ t: 'history', sid, messages, start, total: all.length })
  }

  // ───────── 发送 / 停止 / 新建 / 卡片动作 ─────────

  private async sendText(conn: Conn, sid: unknown, text: unknown, cid: unknown): Promise<void> {
    const id = typeof sid === 'string' ? sid : ''
    const reply = (ok: boolean, message?: string): void => {
      if (typeof cid === 'string') conn.send({ t: 'sent', cid, sid: id, ok, message })
    }
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) return reply(false, '消息为空。')
    const rt = getChatRuntime()
    if (!rt) return reply(false, 'Deva 还没准备好，请稍后再试。')
    const session = getSession(id)
    if (!session || !inScope(this.id, id)) return reply(false, '这个对话不存在或不在机器人的回复范围内。')
    if (sessionWaiting(id)) return reply(false, '对话正在等你在卡片上决定，请先处理卡片。')
    const persona = session.personaId ? getPersona(session.personaId) : null
    const model =
      resolveModelRefOrNull(session.model) ?? resolveModelRefOrNull(persona?.model) ?? resolveDefaultModel()
    if (!model) return reply(false, '还没有可用的模型，请先在电脑端的设置里配置并选定模型。')

    // 对话正在进行：与桌面一样插入当前这一轮，当前步骤结束后交给模型。
    if (rt.isBusy(id)) {
      const r = rt.insert({ sessionId: id, text: body, model })
      if (r.ok) return reply(true, '已插入进行中的任务，当前步骤结束后送达。')
      return reply(false, r.reason === 'busy' ? '上一轮还在进行中，稍后再试。' : '没能插入这条消息。')
    }
    try {
      await rt.send({
        sessionId: id,
        text: body,
        model,
        workspaceRoot: null,
        modelRef: `${model.providerId}:${model.model}`,
        effort: session.effort ?? resolveDefaultEffort()
      })
      reply(true)
    } catch (e) {
      reply(false, (e as Error)?.message ?? String(e))
    }
  }

  private stopTurn(sid: unknown): void {
    if (typeof sid !== 'string') return
    const turnId = runningTurnOf(sid) ?? this.live.get(sid)?.turnId
    if (turnId) getChatRuntime()?.abort(turnId)
  }

  private newSession(conn: Conn, rid: unknown, personaId: unknown): void {
    const reply = (sid?: string, error?: string): void => {
      if (typeof rid === 'string') conn.send({ t: 'created', rid, sid, error })
    }
    let pid: string | undefined
    if (typeof personaId === 'string' && personaId) {
      if (!allowedPersonas(this.id).some((p) => p.id === personaId)) return reply(undefined, '这个角色已不可用。')
      pid = personaId
    } else {
      const def = pickPersona(this.id, '')
      if (!def && getBot(this.id)?.scope.mode === 'personas')
        return reply(undefined, '回复范围内没有可用的角色，请在电脑端「机器人」里调整回复范围。')
      pid = def?.id
    }
    const sid = createSessionFor(this.id, pid)
    reply(sid)
    this.scheduleList()
  }

  private async action(
    conn: Conn,
    uid: string,
    rid: unknown,
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
        form: form && typeof form === 'object' ? (form as Record<string, string | string[]>) : undefined
      })
      reply(r.ok, r.message)
    } catch (e) {
      reply(false, (e as Error)?.message ?? String(e))
    }
  }

  // ───────── 会话总线：进行中的状态与结束 ─────────

  private onEvent({ turnId, sessionId, event }: ChatEventPayload): void {
    if (this.stopped || this.conns.size === 0 || !inScope(this.id, sessionId)) return
    const set = (status?: string): void => {
      const cur = this.live.get(sessionId)
      if (cur && cur.status === status) return
      this.live.set(sessionId, { turnId, status })
      this.pushSession(sessionId)
    }
    switch (event.type) {
      case 'turn_start':
        return set('正在处理…')
      case 'tool_call':
        if (event.depth || event.bg) return
        return set(`${TOOL_HINTS[event.name] ?? '正在调用工具'}…`)
      case 'ask_user':
      case 'plan_review':
      case 'mount_request':
        return set('等待你的决定')
      case 'interaction_resolved':
        return set('正在处理…')
      case 'reconnecting':
        return set(`连接中断，正在重连（${event.attempt}/${event.max}）`)
      case 'auto_retry':
        return set(`${RETRY_TEXT[event.reason] ?? '正在重试'}（${event.attempt}/${event.max}）`)
      case 'error':
        return set(undefined)
      case 'done':
        this.live.delete(sessionId)
        this.previews.delete(sessionId)
        this.pushSession(sessionId, true)
        // 落盘与标题更新可能晚于 done 事件：稍后再推一次。
        setTimeout(() => this.pushSession(sessionId, true), 600)
        return
      default:
        return
    }
  }

  /** 推某对话的最新摘要（限频；immediate 跳过限频）。 */
  private pushSession(sid: string, immediate = false): void {
    if (this.stopped) return
    const wait = immediate ? 0 : Math.max(0, (this.pushedAt.get(sid) ?? 0) + PUSH_MIN_MS - Date.now())
    const cur = this.pushTimers.get(sid)
    if (cur) {
      if (!immediate) return
      clearTimeout(cur)
    }
    this.pushTimers.set(
      sid,
      setTimeout(() => {
        this.pushTimers.delete(sid)
        this.pushedAt.set(sid, Date.now())
        const m = listSessions().find((s) => s.id === sid)
        if (!m || m.archived || m.parentId || !allows(this.id, m)) return this.broadcast({ t: 'session_gone', sid })
        this.broadcast({ t: 'session', s: this.sessionView(m) })
      }, wait)
    )
  }

  /** 对话列表变了（新建 / 删除 / 归档 / 改标题）：整份重推（去抖）。 */
  private scheduleList(): void {
    if (this.stopped || this.listTimer) return
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      if (this.conns.size) this.broadcast({ t: 'sessions', list: this.sessionList() })
    }, 300)
  }

  private broadcast(frame: WebServerFrame): void {
    for (const c of this.conns) if (c.user) c.send(frame)
  }

  private emit(uid: string, frame: WebServerFrame): void {
    for (const c of this.conns) if (c.user === uid) c.send(frame)
  }

  private chat(uid: string): ChatAddress {
    return { channel: this.id, chatId: uid }
  }

  // ───────── RemoteAdapter：hub 推来的交互卡与通知 ─────────

  /** 回合卡片 / 聊天式回复 / 正在输入 / 删消息：网页端不经 hub 的私聊绑定，这些永远不会被调用。 */
  async renderTurn(): Promise<MessageHandle | undefined> {
    return undefined
  }
  async sendReply(): Promise<MessageHandle | undefined> {
    return undefined
  }
  async startTyping(): Promise<void> {}
  async stopTyping(): Promise<void> {}
  async deleteMessage(): Promise<void> {}

  async renderPrompt(chat: ChatAddress, view: PromptView): Promise<MessageHandle | undefined> {
    const p: WebPrompt = { view, at: this.prompts.get(view.key)?.at ?? Date.now() }
    if (view.state === 'open') this.prompts.set(view.key, p)
    else this.prompts.delete(view.key)
    this.emit(chat.chatId, { t: 'prompt', p })
    this.pushSession(view.sessionId)
    return view.key
  }

  async sendNotice(chat: ChatAddress, view: NoticeView): Promise<MessageHandle | undefined> {
    const id = `n${++this.seq}`
    this.emit(chat.chatId, {
      t: 'notice',
      n: { id, at: Date.now(), title: view.title, text: view.text, tone: view.tone, sessionId: view.sessionId }
    })
    return id
  }

  /** 网页端的「私聊」就是用户本身。 */
  async openDirect(userId: string, view: NoticeView): Promise<string | undefined> {
    await this.sendNotice(this.chat(userId), view)
    return userId
  }
}

// ───────── 消息归约 ─────────

const NOTICE_TEXT: Record<string, string> = {
  truncated: '回复达到长度上限被截断',
  empty: '本轮没有产生回复',
  refused: '模型拒绝回答或被内容策略拦截',
  restored: '已回滚了代码改动',
  aborted: '已停止',
  step_limit: '达到单次运行的步数上限',
  repeated: '相同的工具调用连续多次没有进展，已停止',
  degenerate: '模型输出陷入重复，已停止'
}

/** 展示投影 → 手机端消息：只保留正文与提示，工具卡丢掉；什么都不剩的消息返回 null。 */
function toWebMessage(m: DisplayMessage, id: string): WebMessage | null {
  if (m.role === 'user') {
    if (m.quiet) return null
    const text = m.task ? [m.task.title, m.task.quote].filter(Boolean).join('\n') || m.text : m.text
    if (!text.trim() && !m.attachments.length) return null
    return {
      id,
      role: 'user',
      text,
      attachments: m.attachments.length ? m.attachments.map((a) => a.name) : undefined,
      notify: m.notify
    }
  }
  const texts: string[] = []
  const notes: string[] = []
  for (const b of m.blocks) {
    if (b.kind === 'text') texts.push(b.text)
    else if (b.kind === 'notice') notes.push(NOTICE_TEXT[b.code] ?? b.code)
    else if (b.kind === 'error') notes.push(`出错：${b.message}`)
    else if (b.kind === 'compaction') notes.push(b.steps ? `此前 ${b.steps} 步已压缩为摘要` : '较早的对话已压缩为摘要')
    else if (b.kind === 'agentcard')
      notes.push(`角色名片「${b.draft.name || '新角色'}」· ${b.status === 'accepted' ? '已添加' : b.status === 'rejected' ? '已拒绝' : '待确认'}`)
    else if (b.kind === 'autotaskcard')
      notes.push(`定时任务「${b.draft.title || '定时任务'}」· ${b.status === 'created' ? '已创建' : b.status === 'dismissed' ? '已忽略' : '待确认'}`)
  }
  const text = texts.join('\n\n').trim()
  if (!text && !notes.length) return null
  return { id, role: 'assistant', text, notes: notes.length ? notes : undefined, durationMs: m.durationMs }
}

/** 列表第二行：最近一条有正文的消息（用户或助手），去掉标记与多余空白。 */
function previewOf(s: StoredSession): { text: string; role?: 'user' | 'assistant' } {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i]
    const parts: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    const text = parts
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text' && !p.listing)
      .map((p) => p.text)
      .join(' ')
      .replace(/<[^>]{1,80}>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    return { text: text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text, role: m.role }
  }
  return { text: '' }
}
