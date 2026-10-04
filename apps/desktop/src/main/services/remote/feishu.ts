import * as lark from '@larksuiteoapi/node-sdk'
import type {
  ActionValue,
  AdapterHost,
  ChannelId,
  ChatAddress,
  MessageHandle,
  NoticeView,
  PromptView,
  RemoteAdapter,
  ToolBlock,
  TurnPage
} from './types'
import { toolSummary } from './types'

/**
 * 飞书适配器：自建应用 + 事件「长连接」模式（WebSocket，无需公网 IP / 回调地址）。
 *
 *  · 收：im.message.receive_v1（只认私聊里真人发的消息）、card.action.trigger（卡片按钮 / 表单）。
 *  · 发：消息卡片 JSON 2.0；回合视图用同一条卡片原地更新（message.patch）实现流式效果。
 *
 * 只做「平台翻译」：不碰会话、不判鉴权、不解析指令——这些在 hub.ts。
 */

export interface FeishuOptions {
  appId: string
  appSecret: string
  /** feishu = 飞书（国内），lark = Lark（国际版）。 */
  domain: 'feishu' | 'lark'
}

type Card = Record<string, unknown>

/** 回调事件里我们用到的字段（SDK 未导出 card.action.trigger 的入参类型）。 */
interface RawCardEvent {
  operator?: { open_id?: string }
  context?: { open_chat_id?: string; open_message_id?: string }
  open_chat_id?: string
  action?: { value?: unknown; form_value?: Record<string, unknown> }
}

/** 超过这个时长的消息不再执行：断线重连后平台补投的旧指令，可能早已不合时宜。 */
const STALE_MS = 5 * 60_000

export class FeishuAdapter implements RemoteAdapter {
  readonly platform = 'feishu' as const
  // 同一条消息原地更新的频率上限约 5 QPS；1s 一次留足余量，也免得手机端刷屏抖动。
  readonly minUpdateMs = 1000
  // 卡片 JSON 上限 30KB，中文按 UTF-8 每字 3 字节计，正文留 6000 字，其余给工具列表与结构。
  readonly pageChars = 6000

  private client: lark.Client
  private ws: lark.WSClient | null = null
  private seen: string[] = []

  constructor(
    readonly id: ChannelId,
    private opts: FeishuOptions
  ) {
    this.client = feishuClient(opts)
  }

  private domain(): lark.Domain {
    return this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
  }

  async start(host: AdapterHost): Promise<void> {
    host.onState('connecting')
    // 先校验凭据：长连接在凭据错误时只会在后台反复重试，用户看到的永远是「连接中」。
    const auth = await this.client.auth.v3.tenantAccessToken
      .internal({ data: { app_id: this.opts.appId, app_secret: this.opts.appSecret } })
      .catch((e) => {
        throw new Error(`无法连接飞书开放平台：${apiError(e)}`)
      })
    if (auth.code !== 0) throw new Error(`App ID 或 App Secret 不正确（${auth.code} ${auth.msg ?? ''}）`)

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': (data) => {
        this.onMessage(host, data)
      },
      'card.action.trigger': async (data: RawCardEvent) => this.onCard(host, data)
    })
    this.ws = new lark.WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.domain(),
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => host.onState('connected'),
      onReconnecting: () => host.onState('connecting'),
      onReconnected: () => host.onState('connected'),
      onError: (e) => host.onState('error', `长连接失败：${e.message}`)
    })
    await this.ws.start({ eventDispatcher: dispatcher })
  }

  async stop(): Promise<void> {
    this.ws?.close({ force: true })
    this.ws = null
  }

  // ───────── 收 ─────────

  private dedupe(id: string): boolean {
    if (this.seen.includes(id)) return true
    this.seen.push(id)
    if (this.seen.length > 500) this.seen.splice(0, 100)
    return false
  }

  private onMessage(
    host: AdapterHost,
    data: {
      sender: { sender_id?: { open_id?: string }; sender_type: string }
      message: { message_id: string; chat_id: string; chat_type: string; message_type: string; content: string; create_time: string }
    }
  ): void {
    const m = data.message
    if (this.dedupe(m.message_id)) return
    // 只认私聊：群里任何人都能 @ 机器人，而这里的每条消息都能驱动电脑执行命令。
    if (m.chat_type !== 'p2p' || data.sender.sender_type !== 'user') return
    const openId = data.sender.sender_id?.open_id
    if (!openId) return
    if (Date.now() - Number(m.create_time) > STALE_MS) return
    const text = extractText(m.message_type, m.content)
    host.onMessage({
      chat: { channel: this.id, chatId: m.chat_id },
      user: { id: openId },
      text: text ?? '',
      kind: text === null ? 'unsupported' : 'text'
    })
  }

  private async onCard(host: AdapterHost, d: RawCardEvent): Promise<Card> {
    const openId = d.operator?.open_id
    const chatId = d.context?.open_chat_id ?? d.open_chat_id
    const value = d.action?.value as ActionValue | undefined
    if (!openId || !chatId || !value || typeof value !== 'object' || typeof value.k !== 'string')
      return toast(false, '无法识别的操作')
    const form: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(d.action?.form_value ?? {}))
      if (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')))
        form[k] = v as string | string[]
    const r = await host.onAction({ chat: { channel: this.id, chatId }, user: { id: openId }, value, form })
    return toast(r.ok, r.message)
  }

  // ───────── 发 ─────────

  private async upsert(chat: ChatAddress, card: Card, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    const content = JSON.stringify(card)
    try {
      if (handle) {
        const r = await this.client.im.v1.message.patch({ path: { message_id: handle }, data: { content } })
        if (r.code !== 0) throw new Error(`${r.code} ${r.msg ?? ''}`)
        return handle
      }
      const r = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat.chatId, msg_type: 'interactive', content }
      })
      if (r.code !== 0) throw new Error(`${r.code} ${r.msg ?? ''}`)
      return r.data?.message_id
    } catch (e) {
      throw new Error(`飞书${handle ? '更新' : '发送'}消息失败：${apiError(e)}`)
    }
  }

  renderTurn(chat: ChatAddress, page: TurnPage, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    return this.upsert(chat, turnCard(page), handle)
  }

  renderPrompt(chat: ChatAddress, view: PromptView, handle?: MessageHandle): Promise<MessageHandle | undefined> {
    return this.upsert(chat, promptCard(view), handle)
  }

  async sendNotice(chat: ChatAddress, view: NoticeView): Promise<void> {
    await this.upsert(chat, noticeCard(view))
  }

  async openDirect(userId: string, view: NoticeView): Promise<string | undefined> {
    try {
      const r = await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: userId, msg_type: 'interactive', content: JSON.stringify(noticeCard(view)) }
      })
      if (r.code !== 0) throw new Error(`${r.code} ${r.msg ?? ''}`)
      return r.data?.chat_id
    } catch (e) {
      throw new Error(`飞书发起私聊失败：${apiError(e)}`)
    }
  }
}

function feishuClient(opts: FeishuOptions): lark.Client {
  return new lark.Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn
  })
}

/** 读机器人名称（列表里展示用）；拿不到返回空串，不影响使用。 */
export async function fetchFeishuBotName(opts: FeishuOptions): Promise<string> {
  try {
    const r = (await feishuClient(opts).request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as {
      code?: number
      bot?: { app_name?: string }
    }
    return r.code === 0 && typeof r.bot?.app_name === 'string' ? r.bot.app_name : ''
  } catch {
    return ''
  }
}

// ───────── 消息解析 ─────────

/** 文本 / 富文本消息取纯文本；其它类型（图片、文件 …）返回 null。 */
function extractText(type: string, raw: string): string | null {
  let c: unknown
  try {
    c = JSON.parse(raw)
  } catch {
    return null
  }
  const strip = (s: string): string => s.replace(/@_user_\d+/g, '').trim()
  if (type === 'text') {
    const t = (c as { text?: unknown }).text
    return typeof t === 'string' ? strip(t) : null
  }
  if (type === 'post') {
    // 富文本：{ title, content: [[{tag,text}…]…] }，旧版本外面还包一层语言键。
    const obj = c as Record<string, unknown>
    const body = (Array.isArray(obj.content) ? obj : Object.values(obj).find((v) => v && typeof v === 'object')) as
      | { title?: string; content?: unknown }
      | undefined
    if (!body || !Array.isArray(body.content)) return null
    const lines = (body.content as unknown[]).map((line) =>
      Array.isArray(line)
        ? line
            .map((n) => (n && typeof n === 'object' && typeof (n as { text?: unknown }).text === 'string' ? (n as { text: string }).text : ''))
            .join('')
        : ''
    )
    return strip([body.title ?? '', ...lines].filter(Boolean).join('\n'))
  }
  return null
}

function apiError(e: unknown): string {
  const data = (e as { response?: { data?: { code?: number; msg?: string } } })?.response?.data
  if (data && (data.code !== undefined || data.msg)) return `${data.code ?? ''} ${data.msg ?? ''}`.trim()
  return (e as Error)?.message ?? String(e)
}

// ───────── 卡片（JSON 2.0）─────────

type Template = 'blue' | 'green' | 'orange' | 'red' | 'grey' | 'yellow' | 'wathet'

function card(elements: unknown[], header?: { title: string; subtitle?: string; template: Template }): Card {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    ...(header
      ? {
          header: {
            title: { tag: 'plain_text', content: header.title },
            ...(header.subtitle ? { subtitle: { tag: 'plain_text', content: header.subtitle } } : {}),
            template: header.template
          }
        }
      : {}),
    body: { elements }
  }
}

const md = (content: string): Card => ({ tag: 'markdown', content })
const grey = (s: string): string => `<font color='grey'>${s}</font>`
const plain = (content: string): Card => ({ tag: 'plain_text', content })

function button(label: string, value: ActionValue, type: 'primary' | 'default' | 'danger' = 'default'): Card {
  return { tag: 'button', text: plain(label), type, behaviors: [{ type: 'callback', value }] }
}

function buttonRow(buttons: Card[]): Card {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] }))
  }
}

function toast(ok: boolean, content: string): Card {
  return { toast: { type: ok ? 'success' : 'error', content } }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n\n${grey('…（内容较长，完整内容请在电脑端查看）')}` : s
}

/** 行内代码里不能出现反引号。 */
const code = (s: string): string => (s ? ` \`${s.replace(/`/g, "'")}\`` : '')

function toolLine(b: ToolBlock): string {
  const icon = b.status === 'running' ? '⏳' : b.status === 'ok' ? '✅' : '❌'
  if (b.kind === 'subagent') {
    const desc = b.desc ? ` ${b.desc}` : ''
    return `${icon} 子助手「${b.agent || '通用'}」${desc} ${grey(`· ${b.steps} 步`)}`
  }
  const err = b.status === 'error' && b.summary ? ` ${grey(`— ${b.summary.slice(0, 120)}`)}` : ''
  return `${icon} **${b.name}**${code(b.brief)}${err}`
}

/** 连续的工具块：只露一行摘要，明细默认折叠。 */
function toolElements(run: ToolBlock[]): Card[] {
  return [
    {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'markdown', content: grey(toolSummary(run)) } },
      elements: [md(run.map(toolLine).join('\n'))]
    }
  ]
}

const STATUS: Record<TurnPage['status'], { text: string; template: Template }> = {
  running: { text: '⏳ 进行中…', template: 'blue' },
  waiting: { text: '⏸ 等待你的决定（见下方卡片）', template: 'orange' },
  retrying: { text: '🔄 正在重试…', template: 'yellow' },
  done: { text: '✅ 完成', template: 'green' },
  aborted: { text: '⏹ 已停止', template: 'grey' },
  error: { text: '❌ 出错了', template: 'red' }
}

function turnCard(p: TurnPage): Card {
  const els: Card[] = []
  let run: ToolBlock[] = []
  const flushRun = (): void => {
    if (run.length) els.push(...toolElements(run))
    run = []
  }
  for (const b of p.blocks) {
    if (b.kind === 'tool' || b.kind === 'subagent') {
      run.push(b)
      continue
    }
    flushRun()
    if (b.kind === 'text') {
      if (b.text.trim()) els.push(md(b.text))
    } else if (b.kind === 'notice') els.push(md(grey(b.text)))
    else els.push(md(`<font color='red'>⚠ ${b.text.slice(0, 600)}</font>`))
  }
  flushRun()

  const st = STATUS[p.status]
  const subtitle = p.index > 0 ? `${p.sessionTitle}（续 ${p.index + 1}）` : p.sessionTitle
  if (!p.last) return card(els.length ? els : [md(' ')], { title: p.personaName, subtitle, template: 'wathet' })

  const final = p.status === 'done' || p.status === 'aborted' || p.status === 'error'
  if (!els.length) els.push(md(grey(final ? '（没有内容）' : '正在思考…')))
  const status = [p.statusText && !final ? p.statusText : st.text, final ? `用时 ${p.elapsedSec}s` : '', final ? p.statusText : '']
    .filter(Boolean)
    .join(' · ')
  els.push({ tag: 'hr' })
  els.push(md(grey(status)))
  if (!final) els.push(buttonRow([button('停止', { k: 'stop', turn: p.turnId }, 'danger')]))
  return card(els, { title: p.personaName, subtitle, template: st.template })
}

function promptCard(v: PromptView): Card {
  const subtitle = v.sessionTitle
  if (v.kind === 'ask') {
    if (v.state !== 'open') {
      const lines = v.questions.map((q, i) => {
        const a = v.answers?.[i]
        return `**${i + 1}. ${q.question}**\n${a ? a : grey('未作答')}`
      })
      return card([md(lines.join('\n\n'))], {
        title: v.state === 'answered' ? '已回答' : '问题已结束',
        subtitle,
        template: v.state === 'answered' ? 'green' : 'grey'
      })
    }
    const fields: Card[] = []
    v.questions.forEach((q, i) => {
      const tags = [q.multi ? '可多选' : '', q.required === false ? '可跳过' : ''].filter(Boolean)
      const descs = q.options.filter((o) => o.description).map((o) => `- **${o.label}**：${o.description}`)
      fields.push(
        md(`**${i + 1}. ${q.question}**${tags.length ? ` ${grey(`（${tags.join('，')}）`)}` : ''}${descs.length ? `\n${descs.join('\n')}` : ''}`)
      )
      const labels = [...new Set(q.options.map((o) => o.label))]
      if (labels.length)
        fields.push({
          tag: q.multi ? 'multi_select_static' : 'select_static',
          name: `q${i}`,
          placeholder: plain('请选择'),
          width: 'fill',
          options: labels.map((l) => ({ text: plain(l), value: l }))
        })
      fields.push({
        tag: 'input',
        name: `q${i}_text`,
        placeholder: plain(labels.length ? '或者自己输入' : '请输入'),
        width: 'fill'
      })
    })
    fields.push({
      tag: 'button',
      name: 'submit',
      text: plain('提交'),
      type: 'primary',
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: { k: 'ask', key: v.key } satisfies ActionValue }]
    })
    const hint = v.questions.length === 1 ? [md(grey('也可以直接回复一条文字消息作为答案。'))] : []
    return card([{ tag: 'form', name: 'ask', elements: fields }, ...hint], {
      title: '需要你的回答',
      subtitle,
      template: 'orange'
    })
  }

  if (v.kind === 'plan') {
    if (v.state !== 'open') {
      const head =
        v.state === 'approve'
          ? { title: '计划已批准', template: 'green' as const }
          : v.state === 'keep'
            ? { title: '继续完善计划', template: 'blue' as const }
            : { title: '计划审阅已结束', template: 'grey' as const }
      return card(
        [
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'markdown', content: grey('查看计划') } },
            elements: [md(clip(v.plan, 6000))]
          }
        ],
        { ...head, subtitle }
      )
    }
    return card(
      [
        md(clip(v.plan, 6000)),
        { tag: 'hr' },
        buttonRow([
          button('批准并执行', { k: 'plan', key: v.key, d: 'approve' }, 'primary'),
          button('继续完善', { k: 'plan', key: v.key, d: 'keep' })
        ])
      ],
      { title: '请审阅计划', subtitle, template: 'orange' }
    )
  }

  if (v.kind === 'autotask') {
    const when = v.schedule
      ? `${v.schedule}${v.nextRunAt ? grey(`（下次：${new Date(v.nextRunAt).toLocaleString('zh-CN', { hour12: false })}）`) : ''}`
      : `<font color='red'>${v.error ?? '日程无效'}</font>`
    const info = md(
      [
        `**${v.title}**`,
        `${grey('日程')}　${when}`,
        `${grey('身份')}　${v.personaName}　${grey('模型')}　${v.modelName}`
      ].join('\n')
    )
    const detail: Card = {
      tag: 'collapsible_panel',
      expanded: v.state === 'open' && v.prompt.length <= 200,
      header: { title: { tag: 'markdown', content: grey('任务指令') } },
      elements: [md(clip(v.prompt || '（空）', 3000))]
    }
    if (v.state !== 'open')
      return card([info, detail], {
        title: v.state === 'created' ? '定时任务已创建' : '已忽略这个定时任务',
        subtitle,
        template: v.state === 'created' ? 'green' : 'grey'
      })
    return card(
      [
        info,
        detail,
        md(grey('创建后到点自动运行，运行时不会再询问你。需要改日程、身份或模型，请在电脑端的名片上编辑。')),
        buttonRow([
          button('创建任务', { k: 'autotask', sid: v.sessionId, tool: v.key, a: 'create' }, 'primary'),
          button('忽略', { k: 'autotask', sid: v.sessionId, tool: v.key, a: 'dismiss' })
        ])
      ],
      { title: '确认定时任务', subtitle, template: 'orange' }
    )
  }

  if (v.kind === 'agent') {
    const info = md([`**${v.name}**`, v.desc ? grey(v.desc) : ''].filter(Boolean).join('\n'))
    const detail: Card = {
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'markdown', content: grey('角色设定') } },
      elements: [md(clip(v.prompt || '（空）', 3000))]
    }
    if (v.state !== 'open')
      return card([info, detail], {
        title: v.state === 'accepted' ? '角色已添加' : '已拒绝这个角色',
        subtitle,
        template: v.state === 'accepted' ? 'green' : 'grey'
      })
    return card(
      [
        info,
        detail,
        md(grey('头像会自动生成，之后可以在电脑端修改。')),
        buttonRow([
          button('添加角色', { k: 'agent', sid: v.sessionId, tool: v.key, a: 'accept' }, 'primary'),
          button('不要', { k: 'agent', sid: v.sessionId, tool: v.key, a: 'reject' })
        ])
      ],
      { title: '新角色名片', subtitle, template: 'orange' }
    )
  }

  if (v.state !== 'open')
    return card(
      [md(v.state === 'mounted' ? `已挂载：${code(v.root ?? '')}` : grey(v.state === 'skipped' ? '已跳过挂载。' : '请求已结束。'))],
      { title: '工作区挂载', subtitle, template: v.state === 'mounted' ? 'green' : 'grey' }
    )
  return card(
    [
      md(
        `这一步（**${v.tool}**${code(v.path)}）需要一个工作区目录，但当前对话还没有挂载文件夹。\n\n` +
          grey('挂载文件夹需要在电脑端选择；也可以先跳过，让它改用绝对路径。')
      ),
      buttonRow([button('暂不挂载', { k: 'mount', key: v.key })])
    ],
    { title: '需要挂载工作区', subtitle, template: 'orange' }
  )
}

const TONE: Record<NonNullable<NoticeView['tone']>, Template> = {
  info: 'blue',
  success: 'green',
  warning: 'orange',
  error: 'red'
}

function noticeCard(v: NoticeView): Card {
  const els: Card[] = [md(clip(v.text, 6000))]
  const list = v.buttons ?? []
  // 竖排：按钮组件文字只能居中，列表项改用可点击的交互容器，内容才能左对齐（回调与按钮相同）。
  if (list.length && v.buttonLayout === 'column')
    els.push(
      ...list.map((b) => ({
        tag: 'interactive_container',
        width: 'fill',
        height: 'auto',
        has_border: true,
        border_color: b.primary ? 'blue' : 'grey',
        corner_radius: '8px',
        padding: '8px 12px 8px 12px',
        behaviors: [{ type: 'callback', value: b.value }],
        // 单行显示，超出由客户端按屏宽截成「…」（markdown 组件不支持限行，故用纯文本）。
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'plain_text',
              content: b.label,
              text_align: 'left',
              text_color: b.primary ? 'blue' : 'default',
              lines: 1
            }
          }
        ]
      }))
    )
  else if (list.length)
    els.push(buttonRow(list.map((b) => button(b.label, b.value, b.primary ? 'primary' : 'default'))))
  return card(els, v.title ? { title: v.title, template: TONE[v.tone ?? 'info'] } : undefined)
}
