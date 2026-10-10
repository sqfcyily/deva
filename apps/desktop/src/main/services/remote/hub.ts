import { randomInt } from 'node:crypto'
import { onAppNotice, onChatEvent, type AppNotice, type ChatEventPayload } from '../chat-bus'
import { getChatRuntime, type ChatStreamEvent } from '../chat'
import { ensureSession, getSession, listSessions, save as saveSession } from '../chat-store'
import { getPersona, listPersonas, upsertPersona } from '../personas'
import { resolveDefaultModel, resolveModelRefOrNull } from '../model-resolve'
import { previewSchedule } from '../tasks'
import type { TaskCreateInput } from '../tasks-types'
import { paginate } from './paginate'
import { getChannelConfig, updateChannelConfig } from './store'
import type {
  ActionResult,
  AdapterHost,
  ChannelId,
  ChannelState,
  ChatAddress,
  InboundAction,
  InboundMessage,
  MessageHandle,
  NoticeView,
  PromptView,
  RemoteAdapter,
  TurnBlock,
  TurnPage,
  TurnStatus
} from './types'

/**
 * 远程通道中枢（平台无关）：会话总线 ⇄ 各 IM 适配器。
 *
 *  出站：订阅 chat-bus，把每一轮的流事件聚合成「回合视图」（正文 / 工具 / 子助手 / 状态），按平台限频
 *        节流、超长分页，推给**绑定了该对话**的 IM 私聊；问答 / 计划审阅 / 挂载请求另发交互卡。
 *        没有任何私聊跟随的对话若停下来等决定，交互卡推到已配对用户的私聊（人走开了也能拍板）。
 *  入站：鉴权（只认已配对用户）→ 指令（/new /list /use /stop …）或普通消息 → chatRuntime.send；
 *        卡片按钮 / 表单 → chatRuntime.answerAsk / decidePlan / answerMount。
 *
 *  手机端发起的回合与桌面端走同一入口（chatRuntime 即桌面 IPC 处理器背后的那组函数），落盘、检查点、
 *  安全闸门完全一致；桌面端把它当作「后台回合」，结束时从磁盘重载。
 */

// ───────── 通道注册 ─────────

interface Channel {
  adapter: RemoteAdapter
  state: ChannelState
  error?: string
}

const channels = new Map<ChannelId, Channel>()
const stateListeners = new Set<() => void>()

function notifyState(): void {
  for (const l of stateListeners) l()
}

/** 通道状态 / 配对用户变化时回调（index.ts 据此推给设置页）。 */
export function onHubChange(l: () => void): () => void {
  stateListeners.add(l)
  return () => stateListeners.delete(l)
}

export function channelState(id: ChannelId): { state: ChannelState; error?: string } {
  const c = channels.get(id)
  return c ? { state: c.state, error: c.error } : { state: 'off' }
}

export async function startChannel(adapter: RemoteAdapter): Promise<void> {
  await stopChannel(adapter.id)
  const ch: Channel = { adapter, state: 'connecting' }
  channels.set(adapter.id, ch)
  notifyState()
  const host: AdapterHost = {
    onMessage: (msg) => {
      // 平台回调要尽快返回（飞书长连接 3s 内要 ack），实际处理一律异步。
      void handleMessage(msg).catch((e) => console.warn('[remote] 处理消息失败：', errText(e)))
    },
    onAction: (a) => handleAction(a),
    onState: (state, error) => {
      if (channels.get(adapter.id) !== ch) return
      ch.state = state
      ch.error = error
      notifyState()
      if (state === 'connected') void greetPending(adapter)
    }
  }
  try {
    await adapter.start(host)
  } catch (e) {
    if (channels.get(adapter.id) === ch) {
      ch.state = 'error'
      ch.error = errText(e)
      notifyState()
    }
  }
}

/**
 * 扫码创建的机器人只知道扫码人的用户 id、还没有私聊：连上后主动打个招呼，
 * 顺带拿到私聊 chatId（通知要推到那里）。失败不要紧——用户先发消息时同样会补上。
 */
async function greetPending(adapter: RemoteAdapter): Promise<void> {
  for (const u of getChannelConfig(adapter.id).users) {
    if (u.chatId) continue
    try {
      const chatId = await adapter.openDirect(u.id, {
        tone: 'success',
        title: '已连接到 Deva',
        text: `你好！我已经连上你电脑上的 Deva，现在可以直接给我发消息了。\n\n${HELP}`
      })
      if (chatId) setUserChat(adapter.id, u.id, chatId)
    } catch (e) {
      console.warn('[remote] 主动发起私聊失败：', errText(e))
    }
  }
}

function setUserChat(id: ChannelId, userId: string, chatId: string): void {
  updateChannelConfig(id, (c) => ({
    ...c,
    users: c.users.map((u) => (u.id === userId ? { ...u, chatId } : u))
  }))
}

export async function stopChannel(id: ChannelId): Promise<void> {
  const ch = channels.get(id)
  if (!ch) return
  channels.delete(id)
  pairing.delete(id)
  notifyState()
  try {
    await ch.adapter.stop()
  } catch (e) {
    console.warn('[remote] 停止通道失败：', errText(e))
  }
}

export async function stopAllChannels(): Promise<void> {
  await Promise.all([...channels.keys()].map((id) => stopChannel(id)))
}

function liveAdapter(id: ChannelId): RemoteAdapter | null {
  const ch = channels.get(id)
  return ch && ch.state === 'connected' ? ch.adapter : null
}

// ───────── 配对 ─────────

const PAIR_TTL_MS = 10 * 60_000
const PAIR_MAX_FAILURES = 5
const pairing = new Map<ChannelId, { code: string; expiresAt: number; failures: number }>()

/** 生成一个新的 6 位邀请码（10 分钟有效，输错 5 次作废；新码生成即顶替旧码）。只在机器人面板显示。 */
export function issuePairCode(id: ChannelId): { code: string; expiresAt: number } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = Date.now() + PAIR_TTL_MS
  pairing.set(id, { code, expiresAt, failures: 0 })
  return { code, expiresAt }
}

/** 取消邀请：当前邀请码立即作废。 */
export function cancelPairCode(id: ChannelId): void {
  pairing.delete(id)
}

export function removePairedUser(id: ChannelId, userId: string): void {
  updateChannelConfig(id, (c) => {
    const gone = c.users.find((u) => u.id === userId)
    const bindings = { ...c.bindings }
    if (gone) delete bindings[gone.chatId]
    return { ...c, users: c.users.filter((u) => u.id !== userId), bindings }
  })
  notifyState()
}

function isAuthorized(id: ChannelId, userId: string): boolean {
  return getChannelConfig(id).users.some((u) => u.id === userId)
}

async function tryPair(msg: InboundMessage, code: string): Promise<void> {
  const id = msg.chat.channel
  const p = pairing.get(id)
  if (!p || p.expiresAt < Date.now()) {
    pairing.delete(id)
    return notice(msg.chat, {
      tone: 'warning',
      text: '配对码已过期或尚未生成。请在电脑端 Deva 的「机器人」面板里生成新的配对码。'
    })
  }
  if (code !== p.code) {
    p.failures++
    if (p.failures >= PAIR_MAX_FAILURES) pairing.delete(id)
    return notice(msg.chat, {
      tone: 'error',
      text:
        p.failures >= PAIR_MAX_FAILURES
          ? '配对码错误次数过多，已作废。请在电脑端重新生成。'
          : '配对码不正确，请核对后重发。'
    })
  }
  pairing.delete(id)
  updateChannelConfig(id, (c) => ({
    ...c,
    users: [
      ...c.users.filter((u) => u.id !== msg.user.id),
      { id: msg.user.id, name: msg.user.name, chatId: msg.chat.chatId, pairedAt: Date.now() }
    ]
  }))
  notifyState()
  await notice(msg.chat, { tone: 'success', title: '配对成功', text: `现在可以直接给我发消息了。\n\n${HELP}` })
}

// ───────── 绑定 ─────────

function chatKey(c: ChatAddress): string {
  return `${c.channel}:${c.chatId}`
}

function boundSession(chat: ChatAddress): string | null {
  const sid = getChannelConfig(chat.channel).bindings[chat.chatId]
  return sid && getSession(sid) ? sid : null
}

function bind(chat: ChatAddress, sessionId: string): void {
  updateChannelConfig(chat.channel, (c) => ({
    ...c,
    bindings: { ...c.bindings, [chat.chatId]: sessionId }
  }))
}

/** 当前跟随某对话的全部 IM 私聊（只算已连接的通道）。 */
function watchersOf(sessionId: string): ChatAddress[] {
  const out: ChatAddress[] = []
  for (const id of channels.keys()) {
    if (!liveAdapter(id)) continue
    for (const [chatId, sid] of Object.entries(getChannelConfig(id).bindings))
      if (sid === sessionId) out.push({ channel: id, chatId })
  }
  return out
}

/** 已配对用户的私聊（通知 / 无人跟随时的交互卡推到这里）。 */
function homeChats(): ChatAddress[] {
  const out: ChatAddress[] = []
  const seen = new Set<string>()
  for (const id of channels.keys()) {
    if (!liveAdapter(id)) continue
    for (const u of getChannelConfig(id).users) {
      if (!u.chatId) continue
      const c = { channel: id, chatId: u.chatId }
      if (seen.has(chatKey(c))) continue
      seen.add(chatKey(c))
      out.push(c)
    }
  }
  return out
}

function sessionTitle(sessionId: string): string {
  return getSession(sessionId)?.title || '新对话'
}

function personaName(sessionId: string): string {
  const pid = getSession(sessionId)?.personaId
  return (pid && getPersona(pid)?.name) || 'Deva'
}

// ───────── 出站：回合视图 ─────────

/** 一轮在某个私聊里的投递状态：每页一条平台消息，逐页记句柄与上次渲染签名（未变不重发）。 */
interface Post {
  chat: ChatAddress
  handles: (MessageHandle | undefined)[]
  rendered: string[]
  timer?: ReturnType<typeof setTimeout>
  lastFlush: number
  chain: Promise<void>
}

interface TurnTrack {
  turnId: string
  sessionId: string
  startedAt: number
  blocks: TurnBlock[]
  status: TurnStatus
  statusText?: string
  /** 远程发起的回合：立刻出一张「思考中」卡，让发消息的人知道已收到。桌面发起的有内容才发。 */
  eager: boolean
  posts: Map<string, Post>
  finished: boolean
}

const turns = new Map<string, TurnTrack>()
/** 对话 → 正在跑的回合（/stop 用）。 */
const sessionTurn = new Map<string, string>()

function ensureTrack(turnId: string, sessionId: string, eager: boolean): TurnTrack {
  let t = turns.get(turnId)
  if (!t) {
    t = {
      turnId,
      sessionId,
      startedAt: Date.now(),
      blocks: [],
      status: 'running',
      eager,
      posts: new Map(),
      finished: false
    }
    turns.set(turnId, t)
    sessionTurn.set(sessionId, turnId)
    for (const chat of watchersOf(sessionId)) addPost(t, chat)
  }
  if (eager && !t.eager) t.eager = true
  return t
}

function addPost(t: TurnTrack, chat: ChatAddress): void {
  const k = chatKey(chat)
  if (t.posts.has(k)) return
  t.posts.set(k, { chat, handles: [], rendered: [], lastFlush: 0, chain: Promise.resolve() })
}

const TOOL_LABELS: Record<string, string> = {
  read_file: '读取',
  list_dir: '列目录',
  glob: '查找文件',
  grep: '搜索',
  web_fetch: '读取网页',
  write_file: '写入',
  edit_file: '编辑',
  run_command: '运行命令',
  create_skill: '创建技能',
  memory_read: '读取记忆',
  memory_write: '写入记忆',
  memory_delete: '删除记忆',
  create_mcp: '配置 MCP'
}

function toolBrief(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  for (const k of ['command', 'path', 'pattern', 'url', 'query', 'name', 'key']) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) {
      const one = v.trim().replace(/\s+/g, ' ')
      return one.length > 80 ? `${one.slice(0, 80)}…` : one
    }
  }
  return ''
}

const RETRY_TEXT: Record<string, string> = {
  truncated: '回复被截断，正在续写',
  empty: '上一步没有输出，正在追问',
  context: '上下文超限，压缩后重试',
  output_limit: '输出预算超限，降档重试'
}

/** 把一个流事件并入回合视图。返回是否有可见变化。 */
function reduce(t: TurnTrack, ev: ChatStreamEvent): boolean {
  const b = t.blocks
  const last = b[b.length - 1]
  const content = (): void => {
    if (t.status === 'retrying' || t.status === 'waiting') t.status = 'running'
    t.statusText = undefined
  }
  switch (ev.type) {
    case 'text_delta':
      content()
      if (last?.kind === 'text') last.text += ev.text
      else b.push({ kind: 'text', text: ev.text })
      return true
    case 'thinking_delta':
      if (t.statusText === '思考中…') return false
      t.statusText = '思考中…'
      return true
    case 'tool_call': {
      content()
      if (ev.depth && ev.depth > 0) {
        const sub = b.find((x) => x.kind === 'subagent' && x.id === ev.parent)
        if (sub && sub.kind === 'subagent') sub.steps++
        return true
      }
      // 续聊（send_to_subagent）与新派出同样开子智能体卡；主进程已在事件参数里补上原类型与标题。
      if (ev.name === 'run_subagent' || ev.name === 'send_to_subagent') {
        const a = (ev.args ?? {}) as Record<string, unknown>
        b.push({
          kind: 'subagent',
          id: ev.id,
          agent: typeof a.agent === 'string' ? a.agent : ev.agent ?? '',
          desc: typeof a.description === 'string' ? a.description : '',
          steps: 0,
          status: 'running'
        })
      } else if (ev.name === 'propose_agent') {
        b.push({ kind: 'notice', text: '提议了一个新角色，请在下方名片上确认。' })
      } else if (ev.name === 'create_task') {
        b.push({ kind: 'notice', text: '提议了一个定时任务，请在下方名片上核对并创建。' })
      } else {
        b.push({
          kind: 'tool',
          id: ev.id,
          name: TOOL_LABELS[ev.name] ?? ev.name,
          brief: toolBrief(ev.args),
          status: 'running'
        })
      }
      return true
    }
    case 'tool_result': {
      if (ev.depth && ev.depth > 0) return false
      const x = b.find((y) => (y.kind === 'tool' || y.kind === 'subagent') && y.id === ev.id)
      if (!x || (x.kind !== 'tool' && x.kind !== 'subagent')) return false
      x.status = ev.isError ? 'error' : 'ok'
      if (x.kind === 'tool' && ev.isError) x.summary = ev.summary
      return true
    }
    case 'stream_reset': {
      // 与渲染层 dropStepPartial 同理：丢掉最后一个工具 / 子助手块之后的残缺正文，主进程会重跑该步。
      let i = b.length - 1
      while (i >= 0 && b[i].kind === 'text') i--
      b.splice(i + 1)
      return true
    }
    case 'reconnecting':
      t.status = 'retrying'
      t.statusText = `连接中断，正在重连（${ev.attempt}/${ev.max}）`
      return true
    case 'auto_retry':
      t.status = 'retrying'
      t.statusText = `${RETRY_TEXT[ev.reason] ?? '正在重试'}（${ev.attempt}/${ev.max}）`
      return true
    case 'error':
      b.push({ kind: 'error', text: ev.message })
      return true
    case 'compacted':
      if (ev.status !== 'compacted') return false
      b.push({ kind: 'notice', text: '较早的对话已压缩为摘要。' })
      return true
    default:
      return false
  }
}

function hasVisible(t: TurnTrack): boolean {
  return t.blocks.length > 0
}

function scheduleFlush(t: TurnTrack, immediate = false): void {
  if (!t.eager && !hasVisible(t)) return
  for (const post of t.posts.values()) {
    const adapter = liveAdapter(post.chat.channel)
    if (!adapter) continue
    // 「仅最终结果」：中途的内容变化不推，只推开场卡、等待决定与终态（这几处都走 immediate）。
    if (!immediate && getChannelConfig(post.chat.channel).replyMode === 'final') continue
    if (post.timer) {
      if (!immediate) continue
      clearTimeout(post.timer)
      post.timer = undefined
    }
    const wait = immediate ? 0 : Math.max(0, post.lastFlush + adapter.minUpdateMs - Date.now())
    post.timer = setTimeout(() => {
      post.timer = undefined
      flushPost(t, post, adapter)
    }, wait)
  }
}

function flushPost(t: TurnTrack, post: Post, adapter: RemoteAdapter): void {
  post.lastFlush = Date.now()
  post.chain = post.chain
    .then(async () => {
      const pages = paginate(t.blocks, adapter.pageChars)
      for (let i = 0; i < pages.length; i++) {
        const last = i === pages.length - 1
        const page: TurnPage = {
          turnId: t.turnId,
          sessionTitle: sessionTitle(t.sessionId),
          personaName: personaName(t.sessionId),
          index: i,
          last,
          blocks: pages[i],
          status: last ? t.status : 'done',
          statusText: last ? t.statusText : undefined,
          elapsedSec: Math.round((Date.now() - t.startedAt) / 1000)
        }
        // 签名不含耗时：仅内容 / 状态变化才重发（耗时只在终态显示，随终态那次一起更新）。
        const sig = JSON.stringify({ ...page, elapsedSec: 0 })
        if (post.rendered[i] === sig) continue
        const h = await adapter.renderTurn(post.chat, page, post.handles[i])
        if (h) post.handles[i] = h
        post.rendered[i] = sig
      }
    })
    .catch((e) => console.warn('[remote] 推送回合失败：', errText(e)))
}

function finishTurn(t: TurnTrack, stopReason: string): void {
  t.finished = true
  t.status = stopReason === 'aborted' ? 'aborted' : stopReason === 'error' ? 'error' : 'done'
  t.statusText =
    stopReason === 'max_tokens'
      ? '回复达到长度上限被截断'
      : stopReason === 'refusal'
        ? '模型拒绝回答或被内容策略拦截'
        : undefined
  if (t.status === 'done' && !hasVisible(t) && t.eager) t.blocks.push({ kind: 'notice', text: '本轮没有产生回复。' })
  if (sessionTurn.get(t.sessionId) === t.turnId) sessionTurn.delete(t.sessionId)
  // 回合结束仍未决的交互卡：主进程已按取消解开，卡片收成「已结束」。
  // 名片（定时任务 / 角色）不随回合结束：回合早已收尾，名片仍待用户决议。
  for (const [key, p] of prompts)
    if (p.turnId === t.turnId && !isCard(p.view)) {
      cancelPrompt(p.view)
      renderPrompt(p)
      prompts.delete(key)
    }
  scheduleFlush(t, true)
  // 终态那次投递还在排队（posts 的 chain / timer 持有 t），稍后再释放跟踪表项即可。
  setTimeout(() => turns.delete(t.turnId), 60_000)
}

// ───────── 出站：交互卡 ─────────

interface PromptPost {
  chat: ChatAddress
  handle?: MessageHandle
  chain: Promise<void>
}

interface PromptTrack {
  view: PromptView
  turnId: string
  sessionId: string
  posts: PromptPost[]
}

const prompts = new Map<string, PromptTrack>()

/** 名片类（定时任务 / 角色）：不阻塞对话、不随回合结束作废。其余是暂停回合等答复的交互卡。 */
function isCard(v: PromptView): v is Extract<PromptView, { kind: 'autotask' | 'agent' }> {
  return v.kind === 'autotask' || v.kind === 'agent'
}

/** 从会话历史里取某次工具调用的原始参数（名片草稿）。 */
function toolInput(sessionId: string, toolUseId: string): Record<string, unknown> | null {
  for (const m of getSession(sessionId)?.messages ?? []) {
    if (typeof m.content === 'string') continue
    for (const p of m.content)
      if (p.type === 'tool_use' && p.id === toolUseId)
        return p.input && typeof p.input === 'object' ? (p.input as Record<string, unknown>) : {}
  }
  return null
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** create_task 草稿 → 建任务入参（与桌面名片默认值一致：身份 / 模型取本对话绑定，时区缺省取本机）。 */
function autotaskInput(sessionId: string, raw: Record<string, unknown>): TaskCreateInput {
  const sched = (raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}) as Record<string, unknown>
  const s = getSession(sessionId)
  return {
    title: str(raw.title),
    prompt: str(raw.prompt),
    schedule: {
      kind: sched.kind === 'once' ? 'once' : 'recurring',
      at: str(sched.at) || undefined,
      cron: str(sched.cron) || undefined,
      tz: str(sched.tz) || Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    auth: { personaId: s?.personaId ?? null, modelRef: s?.model || null }
  }
}

function autotaskView(sessionId: string, toolUseId: string, raw: Record<string, unknown>): PromptView {
  const input = autotaskInput(sessionId, raw)
  const pv = previewSchedule(input.schedule, 'zh-CN')
  const prior = getSession(sessionId)?.autotasks?.[toolUseId]
  const ref = input.auth.modelRef ?? ''
  return {
    kind: 'autotask',
    key: toolUseId,
    sessionId,
    sessionTitle: sessionTitle(sessionId),
    title: input.title || '定时任务',
    prompt: input.prompt,
    schedule: pv.ok ? pv.description : null,
    nextRunAt: pv.ok ? pv.nextRunAt : null,
    personaName: personaName(sessionId),
    modelName: ref ? ref.slice(ref.indexOf(':') + 1) : '跟随默认',
    state: prior?.status ?? 'open',
    error: pv.ok ? undefined : TASK_ERRORS[pv.error] ?? pv.error
  }
}

function agentView(sessionId: string, toolUseId: string, raw: Record<string, unknown>): PromptView {
  return {
    kind: 'agent',
    key: toolUseId,
    sessionId,
    sessionTitle: sessionTitle(sessionId),
    name: str(raw.name) || '新角色',
    desc: str(raw.description),
    prompt: str(raw.prompt),
    state: getSession(sessionId)?.proposals?.[toolUseId] ?? 'open'
  }
}

const TASK_ERRORS: Record<string, string> = {
  'invalid-input': '任务内容不完整',
  'invalid-tz': '时区无效',
  'invalid-cron': '周期日程无效',
  'invalid-once': '执行时间无效或已过去',
  expired: '执行时间已过去',
  'no-session': '对话已不存在',
  'no-input': '任务内容不完整'
}

function openPrompt(turnId: string, sessionId: string, view: PromptView): void {
  const watchers = watchersOf(sessionId)
  const chats = watchers.length ? watchers : homeChats()
  const p: PromptTrack = {
    view,
    turnId,
    sessionId,
    posts: chats.map((chat) => ({ chat, chain: Promise.resolve() }))
  }
  prompts.set(view.key, p)
  renderPrompt(p)
}

function renderPrompt(p: PromptTrack): void {
  const view = { ...p.view } as PromptView
  for (const post of p.posts) {
    const adapter = liveAdapter(post.chat.channel)
    if (!adapter) continue
    post.chain = post.chain
      .then(async () => {
        const h = await adapter.renderPrompt(post.chat, view, post.handle)
        if (h) post.handle = h
      })
      .catch((e) => console.warn('[remote] 推送交互卡失败：', errText(e)))
  }
}

function cancelPrompt(v: PromptView): void {
  if (v.state === 'open') v.state = 'cancelled'
}

/** 名片在某一端（桌面 / 手机）被决议：同步收起各处的同一张名片。 */
function applyCardResolution(
  sessionId: string,
  ev: Extract<ChatStreamEvent, { type: 'card_resolved' }>
): void {
  const p = prompts.get(ev.toolUseId)
  if (!p || p.sessionId !== sessionId) return
  const v = p.view
  if (v.kind === 'autotask' && (ev.status === 'created' || ev.status === 'dismissed')) {
    v.state = ev.status
    v.error = undefined
  } else if (v.kind === 'agent' && (ev.status === 'accepted' || ev.status === 'rejected')) v.state = ev.status
  else return
  renderPrompt(p)
  prompts.delete(ev.toolUseId)
}

function applyResolution(ev: Extract<ChatStreamEvent, { type: 'interaction_resolved' }>): void {
  const p = prompts.get(ev.key)
  if (!p) return
  const v = p.view
  if (v.kind === 'ask') {
    v.state = ev.answers ? 'answered' : 'cancelled'
    v.answers = ev.answers ?? undefined
  } else if (v.kind === 'plan') {
    v.state = ev.decision ?? 'cancelled'
  } else if (v.kind === 'mount') {
    v.state = ev.path ? 'mounted' : 'skipped'
    v.root = ev.path ?? undefined
  } else return
  renderPrompt(p)
  prompts.delete(ev.key)
  const t = turns.get(p.turnId)
  if (t && t.status === 'waiting') {
    t.status = 'running'
    t.statusText = undefined
    scheduleFlush(t)
  }
}

// ───────── 总线订阅 ─────────

function onBusEvent({ turnId, sessionId, event }: ChatEventPayload): void {
  if (channels.size === 0) return
  if (event.type === 'interaction_resolved') return applyResolution(event)
  if (event.type === 'card_resolved') return applyCardResolution(sessionId, event)
  // 回合开始只为桌面窗口补用户气泡；手机端的回合视图在首个内容事件时建立。
  if (event.type === 'usage' || event.type === 'turn_start') return
  // 桌面手动 /compact 也走回合事件，但不是一轮对话：不推。
  if (event.type === 'compacted' && event.scope === 'manual') return

  if (event.type === 'done') {
    const t = turns.get(turnId)
    if (t) finishTurn(t, event.stopReason)
    return
  }

  const t = ensureTrack(turnId, sessionId, false)
  // 名片：模型提议定时任务 / 新角色 → 另发一张可在手机上决议的名片（回合照常继续）。
  if (
    event.type === 'tool_call' &&
    !event.depth &&
    (event.name === 'create_task' || event.name === 'propose_agent')
  ) {
    const raw = (event.args && typeof event.args === 'object' ? event.args : {}) as Record<string, unknown>
    openPrompt(
      turnId,
      sessionId,
      event.name === 'create_task' ? autotaskView(sessionId, event.id, raw) : agentView(sessionId, event.id, raw)
    )
  }
  if (event.type === 'ask_user' || event.type === 'plan_review' || event.type === 'mount_request') {
    t.status = 'waiting'
    t.statusText = '等待你的决定'
    const title = sessionTitle(sessionId)
    openPrompt(
      turnId,
      sessionId,
      event.type === 'ask_user'
        ? { kind: 'ask', key: event.key, sessionTitle: title, questions: event.questions, state: 'open' }
        : event.type === 'plan_review'
          ? { kind: 'plan', key: event.key, sessionTitle: title, plan: event.plan, state: 'open' }
          : {
              kind: 'mount',
              key: event.key,
              sessionTitle: title,
              tool: event.tool,
              path: event.path,
              state: 'open'
            }
    )
    scheduleFlush(t, true)
    return
  }
  if (reduce(t, event)) scheduleFlush(t)
}

/** 该对话最近一轮是否已作为正常回复推到了这个私聊（回合结束后跟踪表项还保留一分钟）。 */
function replied(sessionId: string, chat: ChatAddress): boolean {
  let last: TurnTrack | undefined
  for (const t of turns.values()) if (t.sessionId === sessionId) last = t
  return !!last && last.finished && hasVisible(last) && last.posts.has(chatKey(chat))
}

function onNotice(n: AppNotice): void {
  if (channels.size === 0) return
  const sid = n.sessionId
  for (const chat of homeChats()) {
    // 已在该对话里：那轮回复已按正常回复推到这里，摘要不再重复推；其余通知（如自动暂停）照发，只是不带「切换」按钮。
    const here = !!sid && boundSession(chat) === sid
    if (sid && here && n.echoesReply && replied(sid, chat)) continue
    void notice(chat, {
      title: n.title,
      text: n.body,
      buttons: sid && !here ? [{ label: '切换到此对话', value: { k: 'use', sid } }] : undefined
    })
  }
}

let wired = false
/** 挂上总线订阅（幂等）。 */
export function initHub(): void {
  if (wired) return
  wired = true
  onChatEvent(onBusEvent)
  onAppNotice(onNotice)
}

// ───────── 入站：消息与指令 ─────────

const HELP = [
  '直接发消息 = 在当前对话里继续聊（没有对话会自动新建）。',
  '',
  '/new [角色名] — 新建对话',
  '/list — 最近的对话',
  '/use 序号 — 切换到某个对话',
  '/stop — 停止正在进行的回复',
  '/status — 当前对话信息',
  '/help — 显示本帮助'
].join('\n')

/** /list 最多列出的对话数（每个一枚按钮；再多手机上要翻很久，按最近活跃截取）。 */
const LIST_MAX = 20

/** 每个私聊最近一次 /list 的结果（/use 序号 据此解析）。 */
const lastLists = new Map<string, string[]>()

async function notice(chat: ChatAddress, view: NoticeView): Promise<void> {
  const adapter = liveAdapter(chat.channel)
  if (!adapter) return
  try {
    await adapter.sendNotice(chat, view)
  } catch (e) {
    console.warn('[remote] 发送通知失败：', errText(e))
  }
}

async function handleMessage(msg: InboundMessage): Promise<void> {
  const text = msg.text.trim()
  if (!isAuthorized(msg.chat.channel, msg.user.id)) {
    const m = /^\/pair\s+(\d{6})$/.exec(text)
    if (m) return tryPair(msg, m[1])
    return notice(msg.chat, {
      tone: 'warning',
      title: '尚未配对',
      text: '请让机器人的主人在电脑端 Deva 的「机器人」面板里生成邀请码，然后在这里发送：\n/pair 邀请码'
    })
  }
  // 扫码创建时还不知道私聊 chatId（主动打招呼也可能失败）：用户第一次发消息时补上。
  const me = getChannelConfig(msg.chat.channel).users.find((u) => u.id === msg.user.id)
  if (me && !me.chatId) setUserChat(msg.chat.channel, msg.user.id, msg.chat.chatId)
  if (msg.kind === 'unsupported' || !text)
    return notice(msg.chat, { tone: 'warning', text: '暂时只支持文字消息。' })

  const cmd = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text)
  if (cmd && (await runCommand(msg.chat, cmd[1].toLowerCase(), (cmd[2] ?? '').trim()))) return
  // 其余斜杠开头的（/技能名 …）原样交给对话，与桌面输入框行为一致。
  await sendToSession(msg.chat, text)
}

async function runCommand(chat: ChatAddress, name: string, arg: string): Promise<boolean> {
  switch (name) {
    case 'help':
    case 'start':
      await notice(chat, { title: 'Deva 使用说明', text: HELP })
      return true
    case 'pair':
      await notice(chat, { text: '你已经配对过了。' })
      return true
    case 'new': {
      const persona = pickPersona(arg)
      if (arg && !persona) {
        const names = listPersonas()
          .filter((p) => p.enabled)
          .map((p) => p.name)
        await notice(chat, {
          tone: 'warning',
          text: `没有找到角色「${arg}」。可用角色：${names.join('、') || '（无）'}`
        })
        return true
      }
      createSession(chat, persona?.id)
      await notice(chat, {
        tone: 'success',
        text: `已新建对话${persona ? `（角色：${persona.name}）` : ''}，直接发消息开始吧。`
      })
      return true
    }
    case 'list': {
      const all = listSessions()
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const list = all.slice(0, LIST_MAX)
      lastLists.set(chatKey(chat), list.map((s) => s.id))
      if (!list.length) {
        await notice(chat, { text: '还没有任何对话，直接发消息即可新建。' })
        return true
      }
      const cur = boundSession(chat)
      const more = all.length > list.length ? `，下面是最近的 ${list.length} 个` : ''
      await notice(chat, {
        title: '对话列表',
        text: `共 ${all.length} 个对话${more}。点一下即可切换（也可以发送 /use 序号）。`,
        buttonLayout: 'column',
        buttons: list.map((s, i) => {
          const p = (s.personaId && getPersona(s.personaId)?.name) || 'Deva'
          return {
            // 截断交给客户端按屏宽处理（单行省略），这里只防极端长标题撑大卡片。
            label: `${i + 1}. ${truncate(s.title || '新对话', 80)} · ${p}${s.id === cur ? '（当前）' : ''}`,
            value: { k: 'use', sid: s.id },
            primary: s.id === cur
          }
        })
      })
      return true
    }
    case 'use': {
      const list = lastLists.get(chatKey(chat)) ?? []
      const n = Number(arg)
      const sid = Number.isInteger(n) && n >= 1 ? list[n - 1] : arg
      if (!sid || !getSession(sid)) {
        await notice(chat, { tone: 'warning', text: '找不到这个对话。先发 /list 看看序号。' })
        return true
      }
      await useSession(chat, sid)
      return true
    }
    case 'stop': {
      const sid = boundSession(chat)
      const turnId = sid ? sessionTurn.get(sid) : undefined
      const rt = getChatRuntime()
      if (!sid || !turnId || !rt || !rt.isBusy(sid)) {
        await notice(chat, { text: '当前没有进行中的回复。' })
        return true
      }
      rt.abort(turnId)
      return true
    }
    case 'status': {
      const sid = boundSession(chat)
      if (!sid) {
        await notice(chat, { text: '当前没有绑定对话，直接发消息会自动新建。' })
        return true
      }
      const s = getSession(sid)
      const model = s?.model ? s.model.slice(s.model.indexOf(':') + 1) : '跟随默认'
      const busy = getChatRuntime()?.isBusy(sid) ? '进行中' : '空闲'
      await notice(chat, {
        title: '当前对话',
        text: `${sessionTitle(sid)}\n角色：${personaName(sid)}\n模型：${model}\n状态：${busy}${
          s?.focusRoot ? `\n工作区：${s.focusRoot}` : ''
        }`
      })
      return true
    }
    default:
      return false
  }
}

/** 默认角色 Deva 的固定 id（种子角色，与桌面端默认身份一致）；按 id 绑定，用户改名不受影响。 */
const DEFAULT_PERSONA_ID = 'general'

/** 按名称 / id 找已启用角色；未指定角色（空名）固定用默认角色 Deva，不挑列表里的第一个。 */
function pickPersona(name: string): { id: string; name: string } | null {
  if (!name) return getPersona(DEFAULT_PERSONA_ID)
  const all = listPersonas().filter((p) => p.enabled)
  const lower = name.toLowerCase()
  return all.find((p) => p.name.toLowerCase() === lower || p.id === name) ?? null
}

function genSessionId(): string {
  return `sess_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`
}

function createSession(chat: ChatAddress, personaId?: string): string {
  const sid = genSessionId()
  const persona = personaId ? getPersona(personaId) : null
  // 与桌面「新建对话」同形：立即建档（左侧列表可见），模型快照角色偏好（空 = 跟随默认）。
  ensureSession(sid, { personaId, focusRoot: null, model: persona?.model || undefined })
  saveSession(sid)
  bind(chat, sid)
  return sid
}

async function useSession(chat: ChatAddress, sid: string): Promise<void> {
  bind(chat, sid)
  const tail = lastAssistantText(sid)
  const busy = getChatRuntime()?.isBusy(sid)
  await notice(chat, {
    tone: 'success',
    title: `已切换到「${sessionTitle(sid)}」`,
    text: [
      `角色：${personaName(sid)}${busy ? '　·　正在进行中' : ''}`,
      tail ? `\n最近一条回复：\n${truncate(tail, 1500)}` : ''
    ].join('')
  })
  // 切到一个正停在交互卡上的对话：把卡补发到这个私聊。
  for (const p of prompts.values())
    if (p.sessionId === sid && !p.posts.some((x) => chatKey(x.chat) === chatKey(chat))) {
      const post: PromptPost = { chat, chain: Promise.resolve() }
      p.posts.push(post)
      renderPrompt(p)
    }
  const turnId = sessionTurn.get(sid)
  const t = turnId ? turns.get(turnId) : undefined
  if (t && !t.finished) {
    addPost(t, chat)
    scheduleFlush(t, true)
  }
}

function lastAssistantText(sid: string): string {
  const msgs = getSession(sid)?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
    if (text.trim()) return text.trim()
  }
  return ''
}

async function sendToSession(chat: ChatAddress, text: string): Promise<void> {
  const rt = getChatRuntime()
  if (!rt) return notice(chat, { tone: 'error', text: 'Deva 还没准备好，请稍后再试。' })
  let sid = boundSession(chat)
  if (!sid) sid = createSession(chat, pickPersona('')?.id)

  // 对话正停在交互卡上：单题问答直接把这条消息当答案；其余情况引导去卡片上操作。
  for (const p of prompts.values()) {
    if (p.sessionId !== sid || p.view.state !== 'open' || isCard(p.view)) continue
    if (p.view.kind === 'ask' && p.view.questions.length === 1) {
      if (!rt.answerAsk({ key: p.view.key, answers: [text] }))
        await notice(chat, { tone: 'warning', text: '这个问题已经结束了。' })
      return
    }
    return notice(chat, {
      tone: 'warning',
      text:
        p.view.kind === 'plan'
          ? '对话正在等你审阅计划，请在计划卡片上选择「批准并执行」或「继续完善」。'
          : p.view.kind === 'ask'
            ? '对话正在等你回答几个问题，请在卡片里逐题作答后提交。'
            : '对话正在等你处理工作区挂载请求，请在卡片上操作。'
    })
  }

  if (rt.isBusy(sid))
    return notice(chat, { tone: 'warning', text: '上一轮还在进行中。发送 /stop 可以停止它。' })

  const session = getSession(sid)
  const persona = session?.personaId ? getPersona(session.personaId) : null
  const model =
    resolveModelRefOrNull(session?.model) ?? resolveModelRefOrNull(persona?.model) ?? resolveDefaultModel()
  if (!model)
    return notice(chat, { tone: 'error', text: '还没有可用的模型，请先在电脑端的设置里配置并选定模型。' })

  try {
    const { turnId } = await rt.send({
      sessionId: sid,
      text,
      model,
      workspaceRoot: null,
      // 与桌面同：记下这一轮实际使用的模型，此后本对话固定用它。
      modelRef: `${model.providerId}:${model.model}`
    })
    const t = ensureTrack(turnId, sid, true)
    addPost(t, chat)
    scheduleFlush(t, true)
  } catch (e) {
    await notice(chat, { tone: 'error', text: errText(e) })
  }
}

// ───────── 入站：卡片动作 ─────────

async function handleAction(a: InboundAction): Promise<ActionResult> {
  if (!isAuthorized(a.chat.channel, a.user.id)) return { ok: false, message: '未配对的用户无法操作。' }
  const rt = getChatRuntime()
  if (!rt) return { ok: false, message: 'Deva 还没准备好。' }
  const v = a.value
  switch (v.k) {
    case 'ask': {
      const p = prompts.get(v.key)
      if (!p || p.view.kind !== 'ask' || p.view.state !== 'open')
        return { ok: false, message: '这个问题已经结束了。' }
      const answers: string[] = []
      const form = a.form ?? {}
      for (let i = 0; i < p.view.questions.length; i++) {
        const sel = form[`q${i}`]
        const picks = Array.isArray(sel) ? sel : sel ? [sel] : []
        const custom = typeof form[`q${i}_text`] === 'string' ? (form[`q${i}_text`] as string).trim() : ''
        const answer = [...picks, ...(custom ? [custom] : [])].join('、')
        if (!answer && p.view.questions[i].required !== false)
          return { ok: false, message: `第 ${i + 1} 题还没有回答。` }
        answers.push(answer)
      }
      return rt.answerAsk({ key: v.key, answers })
        ? { ok: true, message: '已提交' }
        : { ok: false, message: '这个问题已经结束了。' }
    }
    case 'plan':
      return rt.decidePlan({ key: v.key, decision: v.d })
        ? { ok: true, message: v.d === 'approve' ? '已批准，开始执行' : '好的，继续完善计划' }
        : { ok: false, message: '这份计划已经结束了。' }
    case 'mount':
      return rt.answerMount({ key: v.key, path: null })
        ? { ok: true, message: '已跳过挂载' }
        : { ok: false, message: '这个请求已经结束了。' }
    case 'use':
      if (!getSession(v.sid)) return { ok: false, message: '这个对话已经不存在了。' }
      void useSession(a.chat, v.sid)
      return { ok: true, message: '已切换' }
    case 'stop':
      rt.abort(v.turn)
      return { ok: true, message: '已停止' }
    case 'autotask': {
      const raw = toolInput(v.sid, v.tool)
      if (!raw) return { ok: false, message: '找不到这张名片对应的对话。' }
      if (getSession(v.sid)?.autotasks?.[v.tool]) return { ok: false, message: '这张名片已经处理过了。' }
      const r = rt.resolveAutotask(v.sid, v.tool, v.a, v.a === 'create' ? autotaskInput(v.sid, raw) : undefined)
      if (!r.ok) return { ok: false, message: `创建失败：${TASK_ERRORS[r.error] ?? r.error}` }
      return { ok: true, message: r.status === 'created' ? '定时任务已创建' : '已忽略' }
    }
    case 'agent': {
      const raw = toolInput(v.sid, v.tool)
      if (!raw) return { ok: false, message: '找不到这张名片对应的对话。' }
      if (getSession(v.sid)?.proposals?.[v.tool]) return { ok: false, message: '这张名片已经处理过了。' }
      if (v.a === 'accept') {
        // 与桌面「接受」同：建角色并启用（头像由 id 确定性生成，之后可在电脑上改）。
        upsertPersona({
          name: str(raw.name) || '新角色',
          description: str(raw.description),
          prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
          avatar: '',
          model: '',
          enabled: true
        })
      }
      rt.resolveProposal(v.sid, v.tool, v.a === 'accept' ? 'accepted' : 'rejected')
      return { ok: true, message: v.a === 'accept' ? '角色已添加' : '已拒绝' }
    }
  }
}

// ───────── 小工具 ─────────

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}
