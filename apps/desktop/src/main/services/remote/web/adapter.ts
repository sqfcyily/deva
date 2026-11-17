import { BrowserWindow, powerMonitor } from 'electron'
import { hostname } from 'node:os'
import { b64uEncode, formatTicket } from '../../../../shared/remote-crypto'
import {
  PHONE_SID_RE,
  WEB_PROTOCOL_VERSION,
  type WebClientFrame,
  type WebModel,
  type WebPrompt,
  type WebPushSub,
  type WebServerFrame,
  type WebSession
} from '../../../../shared/remote-web'
import { getChatRuntime } from '../../chat'
import { onChatEvent, onReadChanged, onSessionsChanged, onStepSaved, type ChatEventPayload } from '../../chat-bus'
import { markRead, readAtOf } from '../../read-sync'
import { loadDisplay } from '../../chat-display'
import { getSession, listSessions, type ChatSessionMeta } from '../../chat-store'
import { resolveDefaultEffort, resolveDefaultModel, resolveModelRefOrNull } from '../../model-resolve'
import { getPersona } from '../../personas'
import { listTasks, onTasksChanged } from '../../tasks'
import { RETRY_TEXT, TOOL_HINTS, createSessionFor, removePairedUser, runningTurnOf, sessionWaiting } from '../hub'
import type { AdapterHost, ChannelId, ChatAddress, MessageHandle, NoticeView, PromptView, RemoteAdapter } from '../types'
import type { Conn, ConnHandlers, ConnSink } from './conn'
import { createDevice, forgetDeviceKey, getDevice, issueTicket, listDevices, patchDevice } from './devices'
import { sendAttachmentImage, sendDelivered, takeUploads, uploadBegin, uploadCancel, uploadChunk, uploadEnd } from './files'
import { sendPush, vapidOf, type PushMessage } from './push'
import { taskAction, taskList } from './tasks'
import {
  lastUserMessageId,
  memberWaitText,
  modelList,
  personaList,
  previewOf,
  promptMember,
  sessionExtras,
  sessionModel,
  toWebRange,
  turnStartIndex
} from './views'

/**
 * Deva 手机版的电脑端：手机端是电脑上 Deva 的手机形态——对话列表、角色、任意对话的历史与最终回复、交互卡、交付文件。
 *
 *  · 连接由传输层（phone.ts 起的中转客户端 / 局域网服务）经安全层（secure.ts）握手后交到这里，收发的都是明文帧。
 *  · 对话记录的真源是电脑上的对话文件：历史按需拉（展示投影，只取正文），进行中只推「正在做什么」一行状态，
 *    回合结束再推一次对话摘要。
 *  · hub 负责交互卡（提问 / 计划 / 挂载 / 名片）的生成与决议、应用通知：按已配对用户（= 设备）推到 renderPrompt /
 *    sendNotice，这里转成帧发给该设备的连接；设备不在前台时改发推送。
 */

export interface PhoneAdapterOptions {
  deskId: string
  /** 设备增删改（面板刷新）。 */
  onDevicesChanged(): void
  /** 有手机扫码配对成功（面板上的二维码原地变成「已连接」）。 */
  onPaired(did: string): void
}

/** 进行中的对话：状态行与回合 id。 */
interface Live {
  turnId: string
  status?: string
  since: number
  /** 连接中断 / 自动重试的说明。 */
  retry?: string
  /** 上次推送之后又有了要给手机看的内容（正文、插入的消息、交付的文件），等这一步落盘再推（见 pushTurn）。 */
  dirty: boolean
}

const HISTORY_PAGE = 40
/** 同一对话两次状态推送的最小间隔。 */
const PUSH_MIN_MS = 400

/** 电脑这一两分钟没人操作，就算 Deva 窗口还在前台也当作人不在电脑前。 */
const AWAY_IDLE_SEC = 90

/** 用户正坐在电脑前看着 Deva（窗口在前台且最近有键鼠操作）：不往手机推「回复完成」。 */
function atDesktop(): boolean {
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
  if (!focused) return false
  try {
    return powerMonitor.getSystemIdleTime() < AWAY_IDLE_SEC
  } catch {
    return true
  }
}

export class PhoneAdapter implements RemoteAdapter, ConnSink {
  readonly platform = 'web' as const
  readonly minUpdateMs = 300
  readonly pageChars = 20_000

  private host: AdapterHost | null = null
  private conns = new Set<Conn>()
  private stopped = false
  private unsubscribe: (() => void)[] = []
  private live = new Map<string, Live>()
  private prompts = new Map<string, WebPrompt>()
  /** 已为哪些「卡片 key|设备」发过推送（同一张卡只推一次）。 */
  private promptPushed = new Set<string>()
  private previews = new Map<string, { updatedAt: number; text: string; role?: 'user' | 'assistant' }>()
  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pushedAt = new Map<string, number>()
  private listTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0
  /** 从手机发起的回合（对话 id）：结束时一定推送，不管电脑前有没有人。 */
  private fromPhone = new Set<string>()

  constructor(
    readonly id: ChannelId,
    private opts: PhoneAdapterOptions
  ) {}

  async start(host: AdapterHost): Promise<void> {
    this.host = host
    this.stopped = false
    this.unsubscribe.push(
      onChatEvent((p) => this.onEvent(p)),
      onSessionsChanged(() => this.scheduleList()),
      onStepSaved((sid) => this.onStepSaved(sid)),
      // 在电脑或手机上看过了：手机的未读红点跟着变。
      onReadChanged((c) => this.pushSession(c.sessionId)),
      onTasksChanged(() => this.scheduleList())
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const off of this.unsubscribe.splice(0)) off()
    for (const t of this.pushTimers.values()) clearTimeout(t)
    this.pushTimers.clear()
    if (this.listTimer) clearTimeout(this.listTimer)
    this.listTimer = null
    for (const c of [...this.conns]) c.close()
    this.conns.clear()
  }

  /** 设备被移除（电脑上点了移除）：断开它的连接。 */
  dropDevice(did: string): void {
    for (const c of [...this.conns])
      if (c.device === did) {
        c.send({ t: 'removed' })
        c.close()
      }
  }

  /** 设备增删改：通知面板（子类可在此做别的，如按设备启停通道）。 */
  protected devicesChanged(): void {
    this.opts.onDevicesChanged()
  }

  /** 在线的设备 id。 */
  onlineDevices(): Set<string> {
    return new Set([...this.conns].map((c) => c.device).filter((d): d is string => !!d))
  }

  // ───────── 连接（ConnSink）─────────

  attach(conn: Conn): ConnHandlers {
    this.conns.add(conn)
    return {
      onFrame: (f) => {
        void this.onFrame(conn, f as WebClientFrame).catch((e) =>
          console.warn('[remote/web] 处理帧失败：', (e as Error)?.message ?? e)
        )
      },
      onClose: () => {
        this.conns.delete(conn)
        if (conn.device) patchDevice(this.id, conn.device, { lastSeen: Date.now() })
      }
    }
  }

  private async onFrame(conn: Conn, f: WebClientFrame): Promise<void> {
    if (f.t === 'hello') return this.hello(conn, f)
    const did = conn.device
    if (!did) return conn.close()
    switch (f.t) {
      case 'refresh':
        conn.send({ t: 'sessions', list: this.sessionList() })
        conn.send({ t: 'personas', list: personaList() })
        conn.send({ t: 'tasks', list: taskList() })
        return
      case 'history':
        return this.history(conn, f.sid, f.before, f.limit)
      case 'send':
        return this.sendText(conn, did, f)
      case 'stop':
        return this.stopTurn(f.sid)
      case 'new':
        return this.newSession(conn, f.rid, f.personaId, f.sid)
      case 'action':
        return this.action(conn, did, f.rid, f.value, f.form)
      case 'up_begin':
        return uploadBegin(did, f, conn.send)
      case 'up_chunk':
        return uploadChunk(did, f, conn.send)
      case 'up_end':
        return uploadEnd(did, f.uid, conn.send)
      case 'up_cancel':
        return uploadCancel(did, f.uid)
      case 'file':
        return sendDelivered(f, conn.send)
      case 'image':
        return sendAttachmentImage(f, conn.send)
      case 'install': {
        // 添加到主屏幕前：发一张安装票据，主屏幕图标首次打开时用它换自己的设备凭证。
        if (typeof f.rid !== 'string') return
        const t = issueTicket('install')
        return conn.send({ t: 'install', rid: f.rid, ticket: formatTicket(t.id, t.secret) })
      }
      case 'push':
        return this.setPush(conn, did, f.rid, f.sub)
      case 'visible':
        conn.visible = f.visible === true
        return
      case 'rename':
        return this.rename(conn, did, f.rid, f.name)
      case 'read':
        if (typeof f.sid === 'string') markRead(f.sid, 'remote')
        return
      case 'archive':
        return this.archive(conn, f.rid, f.sid, f.archived)
      case 'delete':
        return this.remove(conn, f.rid, f.sid)
      case 'models':
        if (typeof f.rid === 'string') conn.send({ t: 'models', rid: f.rid, list: modelList() })
        return
      case 'set_model':
        return this.setModel(conn, f.rid, f.sid, f.ref)
      case 'task':
        if (typeof f.rid === 'string') conn.send({ t: 'result', rid: f.rid, ...taskAction(f.id, f.action) })
        return
      case 'bye':
        return this.bye(did)
    }
  }

  private async hello(conn: Conn, f: Extract<WebClientFrame, { t: 'hello' }>): Promise<void> {
    if (conn.device) return
    if (f.v !== WEB_PROTOCOL_VERSION) {
      conn.send({ t: 'err', code: 'bad_request', message: '手机网页与电脑端 Deva 的版本不匹配，请刷新页面或更新电脑上的 Deva。' })
      return conn.close()
    }
    const kind = f.kind === 'standalone' ? 'standalone' : 'browser'
    const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 40) : '手机'
    let did: string
    if (conn.auth.kind === 'resume') {
      if (!getDevice(this.id, conn.auth.id)) {
        conn.send({ t: 'removed' })
        return conn.close()
      }
      did = conn.auth.id
      patchDevice(this.id, did, { lastSeen: Date.now(), kind, via: conn.via })
    } else {
      const made = await createDevice(this.id, name, kind, conn.via)
      if (!made) {
        conn.send({ t: 'err', code: 'bad_request', message: '电脑上的系统密钥存储不可用，无法安全保存这台手机的凭证。' })
        return conn.close()
      }
      did = made.id
      conn.send({ t: 'paired', device: did, key: b64uEncode(made.key) })
      if (conn.auth.kind === 'pair') this.opts.onPaired(did)
    }
    conn.device = did
    this.devicesChanged()
    const vapid = await vapidOf(this.id)
    conn.send({
      t: 'ok',
      v: WEB_PROTOCOL_VERSION,
      desk: { id: this.opts.deskId, computer: hostname() },
      device: { id: did, name: getDevice(this.id, did)?.name ?? name },
      sessions: this.sessionList(),
      prompts: [...this.prompts.values()].filter((p) => p.view.state === 'open'),
      vapid: vapid?.pub ?? null
    })
    // 角色带头像图片，体积可能不小：单独一帧，免得首帧太大。
    conn.send({ t: 'personas', list: personaList() })
    conn.send({ t: 'tasks', list: taskList() })
  }

  // ───────── 列表与历史 ─────────

  /**
   * 同电脑端的对话列表：「在会话中运行」的定时任务，任务对话不进列表（从所在对话进入），所在对话上打闹钟图标；
   * 独立运行的任务对话照常列出。
   */
  private taskIndex(): { hidden: Set<string>; owned: Map<string, string[]> } {
    const hidden = new Set<string>()
    const owned = new Map<string, string[]>()
    for (const t of listTasks()) {
      if (!t.ownerSessionId) continue
      hidden.add(t.sessionId)
      owned.set(t.ownerSessionId, [...(owned.get(t.ownerSessionId) ?? []), t.title])
    }
    return { hidden, owned }
  }

  /**
   * 发给手机的对话：成员会话不发。「在会话中运行」的任务对话照发但标 hidden——不进列表，从任务详情「查看对话」进入
   * （同电脑端）；已归档的带上标记，手机在「已归档」里列出。
   */
  private visible(m: ChatSessionMeta): boolean {
    return !m.parentId
  }

  private sessionList(): WebSession[] {
    const { hidden, owned } = this.taskIndex()
    const models = modelList()
    return listSessions()
      .filter((s) => this.visible(s))
      .map((m) => this.sessionView(m, owned.get(m.id), models, hidden.has(m.id)))
  }

  private sessionView(m: ChatSessionMeta, tasks?: string[], models?: WebModel[], hidden = false): WebSession {
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
      since: live?.since,
      retry: live?.retry,
      readAt: readAtOf(m.id),
      archived: m.archived || undefined,
      hidden: hidden || undefined,
      kind: m.id.startsWith('task-') ? 'task' : 'chat',
      tasks: tasks?.length ? tasks : undefined,
      ...sessionExtras(m),
      ...sessionModel(m, models)
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

  /**
   * 历史：before = 往前翻一页；没有 = 最新一页。要最新一页说明手机正看着这个对话：记在连接上，
   * 进行中有了新内容直接推给它（见 pushTurn）。
   */
  private history(conn: Conn, sid: unknown, before: unknown, limit: unknown): void {
    if (typeof sid !== 'string' || !getSession(sid))
      return conn.send({ t: 'err', code: 'gone', message: '这个对话不存在或已被删除。' })
    const all = loadDisplay(sid)
    const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 200) : HISTORY_PAGE
    const older = typeof before === 'number' && before >= 0
    if (!older) conn.viewing = sid
    const end = older ? Math.min(before, all.length) : all.length
    const start = Math.max(0, end - n)
    const messages = toWebRange(all, start, end, getChatRuntime()?.isBusy(sid) ?? false, sid)
    conn.send({ t: 'history', sid, messages, start, end, total: all.length })
  }

  /**
   * 进行中这一轮有了新内容（用户消息已落进记录、又写完一段、插入的消息已送达、交付了文件）：把这一轮（从它的
   * 用户消息起）直接推给正看着这个对话的手机，不让手机收到通知再来拉一趟。
   */
  private pushTurn(sid: string): void {
    const to = [...this.conns].filter((c) => c.device && c.viewing === sid)
    if (!to.length) return
    const all = loadDisplay(sid)
    const start = turnStartIndex(all)
    const messages = toWebRange(all, start, all.length, getChatRuntime()?.isBusy(sid) ?? false, sid)
    const frame: WebServerFrame = { t: 'history', sid, messages, start, end: all.length, total: all.length, live: true }
    for (const c of to) c.send(frame)
  }

  // ───────── 发送 / 停止 / 新建 / 卡片动作 ─────────

  private async sendText(conn: Conn, did: string, f: Extract<WebClientFrame, { t: 'send' }>): Promise<void> {
    const id = typeof f.sid === 'string' ? f.sid : ''
    const reply = (ok: boolean, message?: string, at?: string): void => {
      if (typeof f.cid === 'string') conn.send({ t: 'sent', cid: f.cid, sid: id, ok, message, at })
    }
    const body = typeof f.text === 'string' ? f.text.trim() : ''
    const rt = getChatRuntime()
    if (!rt) return reply(false, 'Deva 还没准备好，请稍后再试。')
    const session = getSession(id)
    if (!session) return reply(false, '这个对话不存在或已被删除。')
    if (sessionWaiting(id)) return reply(false, '对话正在等你在卡片上决定，请先处理卡片。')
    const busy = rt.isBusy(id)
    if (busy && f.files?.length) return reply(false, '这一轮还在进行中，带附件的消息请等这一轮结束后再发。')
    const files = takeUploads(did, f.files)
    if (!files) return reply(false, '附件已失效，请重新添加。')
    if (!body && !files.length) return reply(false, '消息为空。')
    const persona = session.personaId ? getPersona(session.personaId) : null
    const model =
      resolveModelRefOrNull(session.model) ?? resolveModelRefOrNull(persona?.model) ?? resolveDefaultModel()
    if (!model) return reply(false, '还没有可用的模型，请先在电脑端的设置里配置并选定模型。')

    // 对话正在进行：与电脑上一样插入当前这一轮，当前步骤结束后交给模型。
    if (busy) {
      const r = rt.insert({ sessionId: id, text: body, model })
      if (r.ok) return reply(true, '已插入进行中的这一轮。')
      return reply(false, r.reason === 'busy' ? '上一轮还在进行中，稍后再试。' : '没能插入这条消息。')
    }
    try {
      await rt.send({
        sessionId: id,
        text: body,
        model,
        workspaceRoot: null,
        modelRef: `${model.providerId}:${model.model}`,
        effort: session.effort ?? resolveDefaultEffort(),
        attachments: files.length ? files : undefined
      })
      this.fromPhone.add(id)
      reply(true, undefined, lastUserMessageId(loadDisplay(id)))
    } catch (e) {
      reply(false, (e as Error)?.message ?? String(e))
    }
  }

  private stopTurn(sid: unknown): void {
    if (typeof sid !== 'string') return
    const turnId = runningTurnOf(sid) ?? this.live.get(sid)?.turnId
    if (turnId) getChatRuntime()?.abort(turnId)
  }

  private newSession(conn: Conn, rid: unknown, personaId: unknown, sid: unknown): void {
    if (typeof rid !== 'string') return
    // 对话 id 由手机先定好（手机不等回执就进入对话页）。id 会用作对话文件名：格式不对的一律不收。
    if (typeof sid !== 'string' || !PHONE_SID_RE.test(sid)) return conn.send({ t: 'created', rid, error: '无效的对话编号。' })
    // 已经建过（同一请求重发）：直接回成功。
    if (getSession(sid)) return conn.send({ t: 'created', rid, sid })
    let pid: string | undefined
    if (typeof personaId === 'string' && personaId) {
      const p = getPersona(personaId)
      if (!p || !p.enabled) return conn.send({ t: 'created', rid, error: '这个角色已不可用。' })
      pid = personaId
    }
    createSessionFor(this.id, pid, sid)
    conn.send({ t: 'created', rid, sid })
    this.scheduleList()
  }

  private async action(conn: Conn, did: string, rid: unknown, value: unknown, form: unknown): Promise<void> {
    const reply = (ok: boolean, message: string): void => {
      if (typeof rid === 'string') conn.send({ t: 'result', rid, ok, message })
    }
    if (!value || typeof value !== 'object' || typeof (value as { k?: unknown }).k !== 'string')
      return reply(false, '无效的操作。')
    try {
      const r = await this.host!.onAction({
        chat: this.chat(did),
        user: { id: did, name: getDevice(this.id, did)?.name },
        value: value as Parameters<AdapterHost['onAction']>[0]['value'],
        form: form && typeof form === 'object' ? (form as Record<string, string | string[]>) : undefined
      })
      reply(r.ok, r.message)
    } catch (e) {
      reply(false, (e as Error)?.message ?? String(e))
    }
  }

  // ───────── 对话：归档 / 删除 / 切换模型 ─────────

  private archive(conn: Conn, rid: unknown, sid: unknown, archived: unknown): void {
    if (typeof rid !== 'string' || typeof sid !== 'string') return
    const rt = getChatRuntime()
    const on = archived === true
    if (on && rt?.isBusy(sid)) return conn.send({ t: 'result', rid, ok: false, message: '进行中的对话不能归档。' })
    const ok = !!rt?.setArchived(sid, on)
    conn.send({ t: 'result', rid, ok, message: ok ? '' : '没能归档这个对话，请稍后再试。' })
  }

  private remove(conn: Conn, rid: unknown, sid: unknown): void {
    if (typeof rid !== 'string' || typeof sid !== 'string') return
    const rt = getChatRuntime()
    if (!rt || !getSession(sid)) return conn.send({ t: 'result', rid, ok: false, message: '这个对话不存在或已被删除。' })
    rt.deleteSession(sid)
    this.live.delete(sid)
    conn.send({ t: 'result', rid, ok: true, message: '' })
  }

  private setModel(conn: Conn, rid: unknown, sid: unknown, ref: unknown): void {
    if (typeof rid !== 'string' || typeof sid !== 'string') return
    const reply = (ok: boolean, message = ''): void => conn.send({ t: 'result', rid, ok, message })
    if (typeof ref !== 'string' || !modelList().some((m) => m.ref === ref)) return reply(false, '这个模型已不可用。')
    if (!getChatRuntime()?.setModel(sid, ref)) return reply(false, '这个对话不存在或已被删除。')
    reply(true)
    this.pushSession(sid, true)
  }

  // ───────── 设备：推送订阅 / 改名 / 断开 ─────────

  private setPush(conn: Conn, did: string, rid: unknown, sub: unknown): void {
    const reply = (ok: boolean, message = ''): void => {
      if (typeof rid === 'string') conn.send({ t: 'result', rid, ok, message })
    }
    if (sub === null) {
      patchDevice(this.id, did, { push: undefined })
      return reply(true)
    }
    const s = sub as WebPushSub
    if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string')
      return reply(false, '推送订阅无效。')
    if (!/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000) return reply(false, '推送订阅无效。')
    patchDevice(this.id, did, { push: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } } })
    reply(true)
  }

  private rename(conn: Conn, did: string, rid: unknown, name: unknown): void {
    const n = typeof name === 'string' ? name.trim().slice(0, 40) : ''
    if (typeof rid !== 'string') return
    if (!n) return conn.send({ t: 'result', rid, ok: false, message: '名字不能为空。' })
    patchDevice(this.id, did, { name: n })
    this.devicesChanged()
    conn.send({ t: 'result', rid, ok: true, message: '' })
  }

  private async bye(did: string): Promise<void> {
    await removeDevice(this.id, did)
    this.dropDevice(did)
    this.devicesChanged()
  }

  // ───────── 推送 ─────────

  /** 给不在前台的设备推通知（电脑前有人时 skipIfDesk 的不推）。 */
  private notifyDevices(msg: Omit<PushMessage, 'deskId'>, opts: { only?: string; skipIfDesk?: boolean } = {}): void {
    if (opts.skipIfDesk && atDesktop()) return
    for (const d of listDevices(this.id)) {
      const dev = d as { id: string; push?: WebPushSub }
      if (!dev.push || (opts.only && dev.id !== opts.only)) continue
      if ([...this.conns].some((c) => c.device === dev.id && c.visible)) continue
      void sendPush(this.id, dev.push, { ...msg, deskId: this.opts.deskId }).then((r) => {
        if (r === 'gone') patchDevice(this.id, dev.id, { push: undefined })
      })
    }
  }

  // ───────── 会话总线：进行中的状态与结束 ─────────

  private onEvent({ turnId, sessionId, event }: ChatEventPayload): void {
    if (this.stopped) return
    const cur = this.live.get(sessionId)
    const mine = cur?.turnId === turnId ? cur : undefined
    /** 改这一轮的进行中状态；有变化就推给手机（now = 不等限频）。 */
    const touch = (patch: Partial<Live>, now = false): void => {
      const base: Live = mine ?? { turnId, since: Date.now(), dirty: false }
      const next = { ...base, ...patch }
      this.live.set(sessionId, next)
      if (!mine || next.status !== base.status || next.retry !== base.retry) this.pushSession(sessionId, now)
    }
    switch (event.type) {
      case 'turn_start':
        // 本轮的用户消息已在对话记录里：马上推给正看着的手机（别处发起的一轮也立刻看到这条消息）。
        touch({ status: '正在处理…', retry: undefined, dirty: false }, true)
        return this.pushTurn(sessionId)
      case 'text_delta':
        if (mine) {
          mine.dirty = true
          if (mine.retry) touch({ retry: undefined })
        }
        return
      case 'insert':
        if (mine) mine.dirty = true
        return
      case 'tool_call':
        if (event.depth || event.bg) return
        if (mine && event.name === 'present_files') mine.dirty = true
        return touch({ status: `${TOOL_HINTS[event.name] ?? '正在调用工具'}…`, retry: undefined })
      case 'ask_user':
      case 'plan_review':
      case 'mount_request':
        return touch({ status: '等待你的决定', retry: undefined })
      case 'interaction_resolved':
        return touch({ status: '正在处理…', retry: undefined })
      case 'reconnecting':
        return touch({ retry: `连接中断，正在重连（${event.attempt}/${event.max}）` })
      case 'auto_retry':
        return touch({ retry: `${RETRY_TEXT[event.reason] ?? '正在重试'}（${event.attempt}/${event.max}）` })
      case 'error':
        return touch({ status: undefined, retry: undefined })
      case 'done':
        this.live.delete(sessionId)
        this.previews.delete(sessionId)
        this.pushSession(sessionId, true)
        // 落盘与标题更新可能晚于 done 事件：稍后再推一次，并据此发「回复完成」推送。
        setTimeout(() => {
          this.pushSession(sessionId, true)
          this.notifyDone(sessionId)
        }, 600)
        return
      default:
        return
    }
  }

  /** 这一步已落进对话记录：上一步以来有新的正文 / 插入的消息 / 交付的文件，就推给正看着的手机。 */
  private onStepSaved(sid: string): void {
    const l = this.live.get(sid)
    if (this.stopped || !l?.dirty) return
    l.dirty = false
    this.pushTurn(sid)
  }

  private notifyDone(sid: string): void {
    const phoneTurn = this.fromPhone.delete(sid)
    const m = listSessions().find((s) => s.id === sid)
    if (!m || m.parentId || m.archived) return
    const pv = this.preview(sid, m.updatedAt)
    if (pv.role !== 'assistant' || !pv.text) return
    const persona = m.personaId ? getPersona(m.personaId) : null
    this.notifyDevices(
      { title: m.title || '新对话', body: `${persona?.name ?? 'Deva'}：${pv.text}`, sid, tag: sid },
      { skipIfDesk: !phoneTurn }
    )
  }

  /** 推某对话的最新摘要（限频；immediate 跳过限频）。 */
  private pushSession(sid: string, immediate = false): void {
    if (this.stopped || !this.conns.size) return
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
        const { hidden, owned } = this.taskIndex()
        if (!m || !this.visible(m)) return this.broadcast({ t: 'session_gone', sid })
        this.broadcast({ t: 'session', s: this.sessionView(m, owned.get(m.id), undefined, hidden.has(m.id)) })
      }, wait)
    )
  }

  /** 对话列表变了（新建 / 删除 / 归档 / 改标题）：整份重推（去抖）。 */
  private scheduleList(): void {
    if (this.stopped || this.listTimer) return
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      if (!this.conns.size) return
      this.broadcast({ t: 'sessions', list: this.sessionList() })
      // 任务的状态、所在对话的标题、任务对话在不在都会跟着变：一并重发（很小）。
      this.broadcast({ t: 'tasks', list: taskList() })
    }, 300)
  }

  private broadcast(frame: WebServerFrame): void {
    for (const c of this.conns) if (c.device) c.send(frame)
  }

  private emit(did: string, frame: WebServerFrame): void {
    for (const c of this.conns) if (c.device === did) c.send(frame)
  }

  private chat(did: string): ChatAddress {
    return { channel: this.id, chatId: did }
  }

  // ───────── RemoteAdapter：hub 推来的交互卡与通知 ─────────

  /** 回合卡片 / 聊天式回复 / 正在输入 / 删消息：手机版不经 hub 的私聊绑定，这些永远不会被调用。 */
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
    const prev = this.prompts.get(view.key)
    // 成员在等你的卡显示在主对话里（手机上看不到成员对话），通知也点进主对话。
    const member = prev?.member ?? promptMember(view)
    const p: WebPrompt = { view, at: prev?.at ?? Date.now(), ...(member ? { member } : {}) }
    if (view.state === 'open') this.prompts.set(view.key, p)
    else this.prompts.delete(view.key)
    this.emit(chat.chatId, { t: 'prompt', p })
    const sid = member?.sid ?? view.sessionId
    this.pushSession(sid)
    const mark = `${view.key}|${chat.chatId}`
    if (view.state !== 'open') this.promptPushed.delete(mark)
    else if (!this.promptPushed.has(mark)) {
      this.promptPushed.add(mark)
      const title = member ? getSession(sid)?.title || '新对话' : view.sessionTitle || 'Deva'
      this.notifyDevices(
        { title, body: member ? memberWaitText(view, member) : promptText(view), sid, tag: sid },
        { only: chat.chatId, skipIfDesk: !this.fromPhone.has(sid) }
      )
    }
    return view.key
  }

  async sendNotice(chat: ChatAddress, view: NoticeView): Promise<MessageHandle | undefined> {
    const id = `n${++this.seq}`
    this.emit(chat.chatId, {
      t: 'notice',
      n: { id, at: Date.now(), title: view.title, text: view.text, tone: view.tone, sessionId: view.sessionId }
    })
    this.notifyDevices(
      { title: view.title || 'Deva', body: view.text, sid: view.sessionId, tag: view.sessionId ?? id },
      { only: chat.chatId }
    )
    return id
  }

  /** 手机版的「私聊」就是设备本身。 */
  async openDirect(userId: string, view: NoticeView): Promise<string | undefined> {
    await this.sendNotice(this.chat(userId), view)
    return userId
  }
}

/** 交互卡的推送正文。 */
function promptText(view: PromptView): string {
  switch (view.kind) {
    case 'ask':
      return `想问你：${view.questions[0]?.question ?? '有问题需要你回答'}`
    case 'plan':
      return '计划写好了，等你批准'
    case 'mount':
      return '需要你选一个文件夹'
    case 'autotask':
      return `请确认定时任务「${view.title}」`
    case 'agent':
      return `请确认新角色「${view.name}」`
  }
}

/** 移除设备：hub 删白名单与绑定，再删设备密钥。 */
export async function removeDevice(botId: ChannelId, did: string): Promise<void> {
  removePairedUser(botId, did)
  await forgetDeviceKey(botId, did)
}
