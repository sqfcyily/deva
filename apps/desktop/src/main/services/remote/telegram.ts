import { net } from 'electron'
import type {
  ActionValue,
  AdapterHost,
  ChannelId,
  ChatAddress,
  MessageHandle,
  NoticeView,
  PromptView,
  RemoteAdapter,
  TurnBlock,
  TurnPage
} from './types'

/**
 * Telegram 适配器：Bot API + getUpdates 长轮询（无需公网 IP / Webhook）。
 *
 *  · 收：message（只认私聊里真人发的消息）、callback_query（内联按钮）。
 *  · 发：HTML 格式消息 + 内联键盘；回合视图用同一条消息原地编辑（editMessageText）实现流式效果。
 *
 * 与飞书卡片的差异由本文件消化：没有表单 → 问答卡改为「点选项（多选 / 多题时再点提交）」，选择状态暂存在适配器；
 * 按钮回传数据上限 64 字节 → 放得下的动作直接编码（重启后照样有效），放不下的存进内存表、只回传短号。
 *
 * 请求一律走 electron net.fetch（Chromium 网络栈，自动使用系统代理）。
 */

export interface TelegramOptions {
  token: string
}

/** 超过这个时长的消息不再执行：断线重连后补收的旧指令，可能早已不合时宜。 */
const STALE_MS = 5 * 60_000
/** 单条消息上限 4096 字符（按解析后的文本计；HTML 标签不计，这里按含标签保守估计）。 */
const MAX_TEXT = 4096

// ───────── Bot API ─────────

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number
  ) {
    super(message)
  }
}

interface ApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

/** 调一个 Bot API 方法。报错信息里绝不带 URL（里面有 Token）。 */
export async function tgCall<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let res: Response
  try {
    res = await net.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal
    })
  } catch (e) {
    if (opts.signal?.aborted) throw new TelegramError(-1, '已取消')
    if (timeout.aborted) throw new TelegramError(0, '连接 Telegram 超时')
    throw new TelegramError(0, `无法连接 Telegram：${(e as Error)?.message ?? e}`)
  }
  let body: ApiResponse<T>
  try {
    body = (await res.json()) as ApiResponse<T>
  } catch {
    throw new TelegramError(res.status, `Telegram 返回了无法识别的内容（HTTP ${res.status}）`)
  }
  if (!body.ok)
    throw new TelegramError(
      body.error_code ?? res.status,
      body.description ?? `HTTP ${res.status}`,
      body.parameters?.retry_after
    )
  return body.result as T
}

export interface TelegramMe {
  id: number
  username: string
  first_name: string
}

/** 校验 Token 并读机器人资料；Token 不对时给出人话。 */
export async function fetchTelegramMe(token: string): Promise<TelegramMe> {
  try {
    return await tgCall<TelegramMe>(token, 'getMe')
  } catch (e) {
    if (e instanceof TelegramError && (e.code === 401 || e.code === 404))
      throw new Error('Token 不正确，请从 @BotFather 重新复制。')
    throw e
  }
}

interface TgUser {
  id: number
  is_bot: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgMessage {
  message_id: number
  date: number
  chat: { id: number; type: string }
  from?: TgUser
  text?: string
}

interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: { message_id: number; chat: { id: number; type: string } }
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

type Keyboard = { text: string; callback_data: string }[][]

interface Rendered {
  html: string
  keyboard?: Keyboard
}

/** 回调里暂存的东西：放不下 64 字节的动作，或问答卡上的「勾选 / 提交」。 */
type Pending =
  | { t: 'act'; value: ActionValue; form?: Record<string, string | string[]> }
  | { t: 'pick'; key: string; q: number; o: number }
  | { t: 'submit'; key: string }

type AskView = Extract<PromptView, { kind: 'ask' }>

/** 问答卡的选择草稿（多选 / 多题时，提交前逐个勾选）。 */
interface AskDraft {
  view: AskView
  chat: ChatAddress
  picks: string[][]
}

const BOT_COMMANDS = [
  { command: 'new', description: '新建对话（可跟角色名）' },
  { command: 'list', description: '最近的对话' },
  { command: 'use', description: '切换到某个对话（跟序号）' },
  { command: 'stop', description: '停止正在进行的回复' },
  { command: 'status', description: '当前对话信息' },
  { command: 'help', description: '使用说明' }
]

export class TelegramAdapter implements RemoteAdapter {
  readonly platform = 'telegram' as const
  // 同一条消息的编辑频率在 1 次/秒左右是安全的；再快容易触发 429。
  readonly minUpdateMs = 1200
  // 单条 4096 字符，Markdown 转 HTML 会变长（转义、标签），正文留 3000。
  readonly pageChars = 3000

  private ac: AbortController | null = null
  private offset = 0
  private username = ''
  private pending = new Map<string, Pending>()
  private seq = 0
  private drafts = new Map<string, AskDraft>()

  constructor(
    readonly id: ChannelId,
    private opts: TelegramOptions
  ) {}

  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return tgCall<T>(this.opts.token, method, params, { signal: this.ac?.signal, timeoutMs })
  }

  async start(host: AdapterHost): Promise<void> {
    host.onState('connecting')
    this.ac = new AbortController()
    // 先校验 Token：轮询在 Token 错误时只会反复失败，用户看到的永远是「连接中」。
    const me = await fetchTelegramMe(this.opts.token)
    this.username = me.username
    // 设过 Webhook 的机器人收不到 getUpdates（409），先清掉。
    await this.call('deleteWebhook', { drop_pending_updates: false })
    void this.call('setMyCommands', { commands: BOT_COMMANDS }).catch(() => undefined)
    host.onState('connected')
    void this.poll(host, this.ac.signal)
  }

  async stop(): Promise<void> {
    this.ac?.abort()
    this.ac = null
  }

  private async poll(host: AdapterHost, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    let healthy = true
    while (!signal.aborted) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
          65_000
        )
        if (signal.aborted) return
        if (!healthy) host.onState('connected')
        healthy = true
        backoff = 1000
        for (const u of updates) {
          this.offset = u.update_id + 1
          try {
            if (u.message) this.onMessage(host, u.message)
            else if (u.callback_query) void this.onCallback(host, u.callback_query)
          } catch (e) {
            console.warn('[remote] Telegram 处理更新失败：', (e as Error)?.message ?? e)
          }
        }
      } catch (e) {
        if (signal.aborted) return
        const err = e as TelegramError
        if (err.code === 401 || err.code === 404) {
          host.onState('error', 'Token 已失效（可能在 @BotFather 里重置过），请删除后重新添加。')
          return
        }
        healthy = false
        host.onState(
          err.code === 409 ? 'error' : 'connecting',
          err.code === 409 ? '这个机器人正被其他程序占用（例如另一台电脑上的 Deva），正在重试…' : err.message
        )
        const wait = err.retryAfter ? err.retryAfter * 1000 : err.code === 409 ? 15_000 : backoff
        backoff = Math.min(backoff * 2, 30_000)
        await sleep(wait, signal)
      }
    }
  }

  // ───────── 收 ─────────

  private onMessage(host: AdapterHost, m: TgMessage): void {
    // 只认私聊：群里任何人都能给机器人发消息，而这里的每条消息都能驱动电脑执行命令。
    if (m.chat.type !== 'private' || !m.from || m.from.is_bot) return
    if (Date.now() - m.date * 1000 > STALE_MS) return
    // /cmd@本机器人 → /cmd（私聊里客户端一般不加，从命令菜单点选时可能会加）。图片等带说明的消息也算不支持。
    const text = m.text === undefined ? null : stripMention(m.text, this.username)
    host.onMessage({
      chat: { channel: this.id, chatId: String(m.chat.id) },
      user: { id: String(m.from.id), name: userName(m.from) },
      text: text ?? '',
      kind: text === null ? 'unsupported' : 'text'
    })
  }

  private async onCallback(host: AdapterHost, q: TgCallbackQuery): Promise<void> {
    const reply = (text: string, alert = false): Promise<unknown> =>
      this.call('answerCallbackQuery', { callback_query_id: q.id, text: text.slice(0, 190), show_alert: alert }).catch(
        () => undefined
      )
    const msg = q.message
    if (!msg || msg.chat.type !== 'private' || !q.data) return void reply('无法识别的操作')
    const chat: ChatAddress = { channel: this.id, chatId: String(msg.chat.id) }
    const user = { id: String(q.from.id), name: userName(q.from) }
    const p = this.decode(q.data)
    if (!p) return void reply('按钮已失效，请重新操作（Deva 重启过）。', true)

    if (p.t === 'pick') {
      const d = this.drafts.get(p.key)
      if (!d || d.view.state !== 'open') return void reply('这个问题已经结束了。')
      const question = d.view.questions[p.q]
      const label = optionLabels(question)[p.o]
      if (!question || label === undefined) return void reply('无法识别的选项')
      const cur = d.picks[p.q]
      d.picks[p.q] = cur.includes(label)
        ? cur.filter((x) => x !== label)
        : question.multi
          ? [...cur, label]
          : [label]
      void reply(d.picks[p.q].includes(label) ? `已选：${label}` : `已取消：${label}`)
      await this.upsert(d.chat, askRendered(d, (x) => this.encode(x)), String(msg.message_id)).catch((e) =>
        console.warn('[remote] Telegram 更新问答失败：', (e as Error)?.message ?? e)
      )
      return
    }

    let value: ActionValue
    let form: Record<string, string | string[]> | undefined
    if (p.t === 'submit') {
      const d = this.drafts.get(p.key)
      if (!d) return void reply('这个问题已经结束了。')
      value = { k: 'ask', key: p.key }
      form = Object.fromEntries(d.picks.map((ps, i) => [`q${i}`, ps]))
    } else {
      value = p.value
      form = p.form
    }
    const r = await host.onAction({ chat, user, value, form })
    await reply(r.message, !r.ok)
  }

  // ───────── 回调数据编码 ─────────

  private encode(p: Pending): string {
    if (p.t === 'act' && !p.form) {
      const json = `j${JSON.stringify(p.value)}`
      if (Buffer.byteLength(json) <= 64) return json
    }
    const id = (++this.seq).toString(36)
    this.pending.set(id, p)
    if (this.pending.size > 3000) for (const k of [...this.pending.keys()].slice(0, 500)) this.pending.delete(k)
    return `p${id}`
  }

  private decode(data: string): Pending | null {
    if (data.startsWith('p')) return this.pending.get(data.slice(1)) ?? null
    if (data.startsWith('j')) {
      try {
        const value = JSON.parse(data.slice(1)) as ActionValue
        return value && typeof value === 'object' && typeof value.k === 'string' ? { t: 'act', value } : null
      } catch {
        return null
      }
    }
    return null
  }

  private act(value: ActionValue, form?: Record<string, string | string[]>): string {
    return this.encode({ t: 'act', value, form })
  }

  // ───────── 发 ─────────

  private async upsert(chat: ChatAddress, r: Rendered, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    const markup = { inline_keyboard: r.keyboard ?? [] }
    const plain = htmlToPlain(r.html)
    // 超长（转 HTML 后膨胀）或 HTML 解析失败（模型输出的 Markdown 嵌套不规整）→ 退回纯文本。
    const variants: { text: string; parse_mode?: 'HTML' }[] =
      r.html.length <= MAX_TEXT ? [{ text: r.html, parse_mode: 'HTML' }, { text: clipPlain(plain) }] : [{ text: clipPlain(plain) }]
    let last: unknown
    for (const v of variants) {
      try {
        if (handle) {
          await this.call('editMessageText', {
            chat_id: chat.chatId,
            message_id: Number(handle),
            ...v,
            link_preview_options: { is_disabled: true },
            reply_markup: markup
          })
          return handle
        }
        const m = await this.call<TgMessage>('sendMessage', {
          chat_id: chat.chatId,
          ...v,
          link_preview_options: { is_disabled: true },
          ...(r.keyboard?.length ? { reply_markup: markup } : {})
        })
        return String(m.message_id)
      } catch (e) {
        const err = e as TelegramError
        if (handle && /message is not modified/i.test(err.message)) return handle
        last = e
        if (!(err.code === 400 && /parse entities|can't find end/i.test(err.message))) break
      }
    }
    throw new Error(`Telegram ${handle ? '更新' : '发送'}消息失败：${(last as Error)?.message ?? last}`)
  }

  renderTurn(chat: ChatAddress, page: TurnPage, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    return this.upsert(chat, turnRendered(page, (v) => this.act(v)), handle)
  }

  renderPrompt(chat: ChatAddress, view: PromptView, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    if (view.kind === 'ask') {
      if (view.state !== 'open') {
        this.drafts.delete(view.key)
        return this.upsert(chat, askRendered({ view, chat, picks: [] }, (p) => this.encode(p)), handle)
      }
      const prev = this.drafts.get(view.key)
      const d: AskDraft = { view, chat, picks: prev?.picks ?? view.questions.map(() => []) }
      this.drafts.set(view.key, d)
      return this.upsert(chat, askRendered(d, (p) => this.encode(p)), handle)
    }
    return this.upsert(chat, promptRendered(view, (v) => this.act(v)), handle)
  }

  async sendNotice(chat: ChatAddress, view: NoticeView): Promise<void> {
    await this.upsert(chat, noticeRendered(view, (v) => this.act(v)))
  }

  /** Telegram 私聊的 chat_id 就是对方的用户 id；对方必须先点过 Start，否则机器人无法主动发消息。 */
  async openDirect(userId: string, view: NoticeView): Promise<string | undefined> {
    await this.upsert({ channel: this.id, chatId: userId }, noticeRendered(view, (v) => this.act(v)))
    return userId
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
}

function userName(u: TgUser): string | undefined {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return full || (u.username ? `@${u.username}` : undefined)
}

function stripMention(text: string, username: string): string {
  if (!username) return text.trim()
  return text.replace(new RegExp(`^(/\\w+)@${username}\\b`, 'i'), '$1').trim()
}

// ───────── Markdown → Telegram HTML ─────────

/** Telegram HTML 只认 & < > 三个实体（属性值里再加引号）。 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function clipPlain(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 40)}\n…（内容较长，完整内容请在电脑端查看）` : s
}

/** 行内：代码先抽走（里面不再解析），其余转义后转粗体 / 斜体 / 删除线 / 链接。 */
function inline(s: string): string {
  const codes: string[] = []
  const held = s.replace(/`([^`\n]+)`/g, (_, c: string) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  return esc(held)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/__(?=\S)([^_\n]*?\S)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<s>$1</s>')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)])
}

/**
 * 模型输出的 Markdown 转成 Telegram 支持的 HTML 子集。尽力而为：标题 → 粗体、列表 → 圆点、
 * 引用 → blockquote、代码块 → pre；表格等无对应格式的原样保留。转出来不合法时 upsert 会退回纯文本。
 */
export function mdToHtml(md: string): string {
  const out: string[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let quote: string[] = []
  const flushQuote = (): void => {
    if (quote.length) out.push(`<blockquote>${quote.join('\n')}</blockquote>`)
    quote = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```\s*([\w+-]*)/.exec(line)
    if (fence) {
      flushQuote()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i])
      const lang = fence[1] ? ` class="language-${fence[1]}"` : ''
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      quote.push(inline(q[1]))
      continue
    }
    flushQuote()
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) out.push(`<b>${inline(h[1].replace(/\s*#+\s*$/, ''))}</b>`)
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('──────────')
    else {
      const li = /^(\s*)[-*+]\s+(.*)$/.exec(line)
      out.push(li ? `${li[1]}• ${inline(li[2])}` : inline(line))
    }
  }
  flushQuote()
  return out.join('\n')
}

// ───────── 渲染 ─────────

const i = (s: string): string => `<i>${s}</i>`
const b = (s: string): string => `<b>${s}</b>`
const code = (s: string): string => (s ? ` <code>${esc(s)}</code>` : '')
const fold = (s: string): string => `<blockquote expandable>${s}</blockquote>`

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n\n…（内容较长，完整内容请在电脑端查看）` : s
}

function head(title: string, subtitle?: string, icon?: string): string {
  return `${icon ? `${icon} ` : ''}${b(esc(title))}${subtitle ? ` · ${i(esc(subtitle))}` : ''}`
}

type ToolBlock = Extract<TurnBlock, { kind: 'tool' | 'subagent' }>

function toolLine(t: ToolBlock): string {
  const icon = t.status === 'running' ? '⏳' : t.status === 'ok' ? '✅' : '❌'
  if (t.kind === 'subagent')
    return `${icon} 子助手「${esc(t.agent || '通用')}」${t.desc ? ` ${esc(t.desc)}` : ''} ${i(`· ${t.steps} 步`)}`
  const err = t.status === 'error' && t.summary ? ` ${i(`— ${esc(t.summary.slice(0, 120))}`)}` : ''
  return `${icon} ${b(esc(t.name))}${code(t.brief)}${err}`
}

/** 连续的工具块合成一段；太长时只露最近几步，其余收进可展开的引用。 */
function toolSection(run: ToolBlock[]): string {
  const SHOW = 6
  const lines = run.map(toolLine)
  if (lines.length <= SHOW + 2) return lines.join('\n')
  const hidden = lines.slice(0, lines.length - SHOW)
  return `${fold(`${i(`前面还有 ${hidden.length} 个步骤`)}\n${hidden.join('\n')}`)}\n${lines.slice(-SHOW).join('\n')}`
}

const STATUS: Record<TurnPage['status'], string> = {
  running: '⏳ 进行中…',
  waiting: '⏸ 等待你的决定（见下方消息）',
  retrying: '🔄 正在重试…',
  done: '✅ 完成',
  aborted: '⏹ 已停止',
  error: '❌ 出错了'
}

function turnRendered(p: TurnPage, act: (v: ActionValue) => string): Rendered {
  const parts: string[] = []
  let run: ToolBlock[] = []
  const flushRun = (): void => {
    if (run.length) parts.push(toolSection(run))
    run = []
  }
  for (const blk of p.blocks) {
    if (blk.kind === 'tool' || blk.kind === 'subagent') {
      run.push(blk)
      continue
    }
    flushRun()
    if (blk.kind === 'text') {
      if (blk.text.trim()) parts.push(mdToHtml(blk.text))
    } else if (blk.kind === 'notice') parts.push(i(esc(blk.text)))
    else parts.push(`⚠ ${esc(blk.text.slice(0, 600))}`)
  }
  flushRun()

  const subtitle = p.index > 0 ? `${p.sessionTitle}（续 ${p.index + 1}）` : p.sessionTitle
  const title = head(p.personaName, subtitle)
  if (!p.last) return { html: [title, ...parts].join('\n\n') }

  const final = p.status === 'done' || p.status === 'aborted' || p.status === 'error'
  if (!parts.length) parts.push(i(final ? '（没有内容）' : '正在思考…'))
  const status = [
    p.statusText && !final ? p.statusText : STATUS[p.status],
    final ? `用时 ${p.elapsedSec}s` : '',
    final ? p.statusText : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    html: [title, ...parts, i(esc(status))].join('\n\n'),
    keyboard: final ? undefined : [[{ text: '⏹ 停止', callback_data: act({ k: 'stop', turn: p.turnId }) }]]
  }
}

function optionLabels(q: AskView['questions'][number] | undefined): string[] {
  return q ? [...new Set(q.options.map((o) => o.label))] : []
}

/**
 * 问答卡。没有表单：
 *  · 单题单选 → 点选项即提交；
 *  · 多选 / 多题 → 点选项勾选（再点取消），最后点「提交」；
 *  · 单题时也可以直接回复一条文字作为答案（hub 处理）。
 */
function askRendered(d: AskDraft, enc: (p: Pending) => string): Rendered {
  const v = d.view
  if (v.state !== 'open') {
    const lines = v.questions.map((q, n) => {
      const a = v.answers?.[n]
      return `${b(`${n + 1}. ${esc(q.question)}`)}\n${a ? esc(a) : i('未作答')}`
    })
    return { html: [head(v.state === 'answered' ? '已回答' : '问题已结束', v.sessionTitle, v.state === 'answered' ? '✅' : '⏹'), ...lines].join('\n\n') }
  }
  const multiQ = v.questions.length > 1
  const instant = !multiQ && v.questions[0] && !v.questions[0].multi
  const keyboard: Keyboard = []
  const sections = v.questions.map((q, n) => {
    const tags = [q.multi ? '可多选' : '', q.required === false ? '可跳过' : ''].filter(Boolean)
    const descs = q.options.filter((o) => o.description).map((o) => `• ${b(esc(o.label))}：${esc(o.description ?? '')}`)
    const labels = optionLabels(q)
    labels.forEach((label, o) => {
      const on = d.picks[n]?.includes(label)
      const text = `${on ? '✅ ' : ''}${multiQ ? `${n + 1}. ` : ''}${label}`
      const data = instant
        ? enc({ t: 'act', value: { k: 'ask', key: v.key }, form: { q0: label } })
        : enc({ t: 'pick', key: v.key, q: n, o })
      keyboard.push([{ text, callback_data: data }])
    })
    const picked = d.picks[n]?.length ? `\n已选：${esc(d.picks[n].join('、'))}` : ''
    const noOpts = !labels.length && multiQ ? `\n${i('（这一题需要输入文字，请在电脑端作答）')}` : ''
    return `${b(`${n + 1}. ${esc(q.question)}`)}${tags.length ? ` ${i(`（${tags.join('，')}）`)}` : ''}${descs.length ? `\n${descs.join('\n')}` : ''}${picked}${noOpts}`
  })
  if (!instant) keyboard.push([{ text: '提交', callback_data: enc({ t: 'submit', key: v.key }) }])
  const hint = multiQ ? [] : [i('也可以直接回复一条文字消息作为答案。')]
  return { html: [head('需要你的回答', v.sessionTitle, '❓'), ...sections, ...hint].join('\n\n'), keyboard }
}

function promptRendered(v: Exclude<PromptView, { kind: 'ask' }>, act: (v: ActionValue) => string): Rendered {
  const btn = (text: string, value: ActionValue): { text: string; callback_data: string } => ({
    text,
    callback_data: act(value)
  })

  if (v.kind === 'plan') {
    if (v.state !== 'open') {
      const t =
        v.state === 'approve'
          ? head('计划已批准', v.sessionTitle, '✅')
          : v.state === 'keep'
            ? head('继续完善计划', v.sessionTitle, '✏️')
            : head('计划审阅已结束', v.sessionTitle, '⏹')
      return { html: `${t}\n\n${fold(esc(clip(v.plan, 2500)))}` }
    }
    return {
      html: `${head('请审阅计划', v.sessionTitle, '📋')}\n\n${mdToHtml(clip(v.plan, 3000))}`,
      keyboard: [
        [
          btn('✅ 批准并执行', { k: 'plan', key: v.key, d: 'approve' }),
          btn('✏️ 继续完善', { k: 'plan', key: v.key, d: 'keep' })
        ]
      ]
    }
  }

  if (v.kind === 'autotask') {
    const when = v.schedule
      ? `${esc(v.schedule)}${v.nextRunAt ? i(`（下次：${new Date(v.nextRunAt).toLocaleString('zh-CN', { hour12: false })}）`) : ''}`
      : `⚠ ${esc(v.error ?? '日程无效')}`
    const info = [
      b(esc(v.title)),
      `${i('日程')}　${when}`,
      `${i('身份')}　${esc(v.personaName)}　${i('模型')}　${esc(v.modelName)}`,
      `${i('任务指令')}\n${fold(esc(clip(v.prompt || '（空）', 2000)))}`
    ].join('\n')
    if (v.state !== 'open')
      return {
        html: `${head(v.state === 'created' ? '定时任务已创建' : '已忽略这个定时任务', v.sessionTitle, v.state === 'created' ? '✅' : '⏹')}\n\n${info}`
      }
    return {
      html: `${head('确认定时任务', v.sessionTitle, '⏰')}\n\n${info}\n\n${i('创建后到点自动运行，运行时不会再询问你。需要改日程、身份或模型，请在电脑端的名片上编辑。')}`,
      keyboard: [
        [
          btn('创建任务', { k: 'autotask', sid: v.sessionId, tool: v.key, a: 'create' }),
          btn('忽略', { k: 'autotask', sid: v.sessionId, tool: v.key, a: 'dismiss' })
        ]
      ]
    }
  }

  if (v.kind === 'agent') {
    const info = [
      b(esc(v.name)),
      v.desc ? i(esc(v.desc)) : '',
      `${i('角色设定')}\n${fold(esc(clip(v.prompt || '（空）', 2000)))}`
    ]
      .filter(Boolean)
      .join('\n')
    if (v.state !== 'open')
      return {
        html: `${head(v.state === 'accepted' ? '角色已添加' : '已拒绝这个角色', v.sessionTitle, v.state === 'accepted' ? '✅' : '⏹')}\n\n${info}`
      }
    return {
      html: `${head('新角色名片', v.sessionTitle, '🧑')}\n\n${info}\n\n${i('头像会自动生成，之后可以在电脑端修改。')}`,
      keyboard: [
        [
          btn('添加角色', { k: 'agent', sid: v.sessionId, tool: v.key, a: 'accept' }),
          btn('不要', { k: 'agent', sid: v.sessionId, tool: v.key, a: 'reject' })
        ]
      ]
    }
  }

  if (v.state !== 'open')
    return {
      html: `${head('工作区挂载', v.sessionTitle, v.state === 'mounted' ? '✅' : '⏹')}\n\n${
        v.state === 'mounted' ? `已挂载：${code(v.root ?? '')}` : i(v.state === 'skipped' ? '已跳过挂载。' : '请求已结束。')
      }`
    }
  return {
    html:
      `${head('需要挂载工作区', v.sessionTitle, '📁')}\n\n` +
      `这一步（${b(esc(v.tool))}${code(v.path)}）需要一个工作区目录，但当前对话还没有挂载文件夹。\n\n` +
      i('挂载文件夹需要在电脑端选择；也可以先跳过，让它改用绝对路径。'),
    keyboard: [[btn('暂不挂载', { k: 'mount', key: v.key })]]
  }
}

const TONE: Record<NonNullable<NoticeView['tone']>, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌'
}

function noticeRendered(v: NoticeView, act: (v: ActionValue) => string): Rendered {
  const body = mdToHtml(clip(v.text, 3000))
  const html = v.title ? `${TONE[v.tone ?? 'info']} ${b(esc(v.title))}\n\n${body}` : body
  const list = (v.buttons ?? []).map((x) => ({ text: x.label, callback_data: act(x.value) }))
  if (!list.length) return { html }
  // 竖排：每个按钮独占一行（列表选择）；横排：一行放下（少量快捷动作）。
  return { html, keyboard: v.buttonLayout === 'column' ? list.map((x) => [x]) : [list] }
}
