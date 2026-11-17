import { basename } from 'node:path'
import type { DisplayMessage } from '../../../../shared/chat-protocol'
import { agentReceipt, askReceipt, autotaskReceipt, planReceipt } from '../../../../shared/remote-receipts'
import type { PromptView } from '../../../../shared/remote-views'
import type {
  WebAttachment,
  WebMessage,
  WebModel,
  WebPart,
  WebPersona,
  WebPromptMember,
  WebReceipt,
  WebSpeaker
} from '../../../../shared/remote-web'
import { listTasks } from '../../tasks'
import type { ContentPart } from '../../../providers/types'
import { getSession, type ChatSessionMeta, type StoredSession } from '../../chat-store'
import type { MemberRef } from '../../members'
import { AUTO_SHAPE, isAvatarShape } from '../../../../shared/avatar-shape'
import { ATTACHMENTS_ONLY_QUESTION } from '../../attachments'
import { getConfig } from '../../config'
import { resolveDefaultModel, resolveModelRefOrNull } from '../../model-resolve'
import { getPersona, listPersonas } from '../../personas'

/**
 * 电脑端数据 → 手机端视图：消息归约（只留正文、附件、交付文件与提示）、列表摘要、角色、成员。
 */

const PREVIEW_CHARS = 80

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

/**
 * 展示投影 → 手机端消息。助手的一轮按段拆开：两次工具调用之间写的话是一段（一个气泡），交付的文件、提示、处理过的
 * 交互卡的回执跟在它出现的位置；进行中插入的消息拆成一条用户消息排在中间。什么都不剩的返回空数组。
 * running = 这是进行中的那一轮：还没处理的计划在投影里和「审阅已结束」长得一样（都没有决定），这时不出回执。
 */
export function toWebMessages(m: DisplayMessage, index: number, running = false): WebMessage[] {
  const out: WebMessage[] = []
  const id = (): string => (out.length ? `${index}.${out.length}` : String(index))
  if (m.role === 'user') {
    if (m.quiet) return out
    let text = m.task ? [m.task.title, m.task.quote].filter(Boolean).join('\n') || m.text : m.text
    // 只发了附件：代填的那句提问不是用户说的，不显示（同手机上发出时的样子）。
    if (m.attachments.length && text === ATTACHMENTS_ONLY_QUESTION) text = ''
    if (!text.trim() && !m.attachments.length) return out
    const attachments: WebAttachment[] = m.attachments.map((a) => ({ name: a.name, kind: a.kind, ref: a.ref }))
    out.push({ id: id(), role: 'user', text, attachments: attachments.length ? attachments : undefined, notify: m.notify })
    return out
  }
  let parts: WebPart[] = []
  let texts: string[] = []
  const endText = (): void => {
    const text = texts.join('\n\n').trim()
    texts = []
    if (text) parts.push({ k: 'text', text })
  }
  const endReply = (last: boolean): void => {
    endText()
    if (parts.length) out.push({ id: id(), role: 'assistant', parts, durationMs: last ? m.durationMs : undefined })
    parts = []
  }
  const note = (text: string): void => {
    endText()
    parts.push({ k: 'note', text })
  }
  // 还没处理的卡片不出回执：手机上显示的是那张卡本身（对话末尾）。
  const receipt = (r: WebReceipt | null): void => {
    endText()
    if (r) parts.push(r)
  }
  for (const b of m.blocks) {
    if (b.kind === 'text') texts.push(b.text)
    else if (b.kind === 'insert') {
      endReply(false)
      if (b.text.trim()) out.push({ id: id(), role: 'user', text: b.text })
    } else if (b.kind === 'tool') {
      endText()
      if (b.name === 'present_files' && b.status === 'ok') {
        const paths = (b.args as { paths?: unknown } | null)?.paths
        if (Array.isArray(paths))
          paths.forEach((p, i) => {
            if (typeof p === 'string') parts.push({ k: 'file', file: { tool: b.id, index: i, name: basename(p) } })
          })
      }
    } else if (b.kind === 'notice') note(NOTICE_TEXT[b.code] ?? b.code)
    else if (b.kind === 'error') note(`出错：${b.message}`)
    else if (b.kind === 'compaction') note(b.steps ? `此前 ${b.steps} 步已压缩为摘要` : '较早的对话已压缩为摘要')
    else if (b.kind === 'agentcard') receipt(b.status === 'pending' ? null : agentReceipt(b.draft.name, b.status === 'accepted'))
    else if (b.kind === 'autotaskcard')
      receipt(b.status === 'pending' ? null : autotaskReceipt(b.draft.title, b.status === 'created'))
    // answers 缺省 = 还没回答（进行中）或从没回答过（旧记录），都不出回执。
    else if (b.kind === 'ask') receipt(b.answers === undefined ? null : askReceipt(b.questions, b.answers))
    else if (b.kind === 'plan') receipt(running && b.decision === 'cancelled' ? null : planReceipt(b.plan, b.decision))
    else endText()
  }
  endReply(true)
  return out
}

/** 展示投影 [start, end) → 手机端消息。running = 对话正在进行（投影的最后一条就是进行中的那一轮）。 */
export function toWebRange(all: DisplayMessage[], start: number, end: number, running: boolean, sid?: string): WebMessage[] {
  const out: WebMessage[] = []
  for (let i = start; i < end; i++) {
    const report = sid ? reportOf(all, i, sid) : undefined
    const list = toWebMessages(report?.msg ?? all[i], i, running && i === all.length - 1)
    if (report) for (const m of list) if (m.role === 'assistant') m.from = report.from
    out.push(...list)
  }
  return out
}

/**
 * 成员交差的回复（同电脑端 Conversation reportOf）：前一条是不显示的成员通知、本条正文以通知的标题（「前端已完成：任务」）
 * 开头。手机上画成该成员说的话——去掉标题行，带上成员的名字和头像；成员按标题开头的名字认（名单里最长的那个前缀，
 * 含已移除的）。绑定的定时任务只是告知的那条同理，以任务的身份显示。认不出是谁、或其后是主角色自己写的回复
 * （开头对不上标题）时返回 undefined，照常显示。成员对话里不这样处理（那里的通知不是成员交差）。
 */
function reportOf(all: DisplayMessage[], i: number, sid: string): { msg: DisplayMessage; from: WebSpeaker } | undefined {
  const m = all[i]
  const prev = all[i - 1]
  if (m?.role !== 'assistant' || prev?.role !== 'user' || !prev.quiet) return undefined
  const headline = prev.text.trim()
  const first = m.blocks[0]
  if (!headline || first?.kind !== 'text' || !first.text.startsWith(headline)) return undefined
  const s = getSession(sid)
  if (!s || s.parentId) return undefined
  let from: WebSpeaker | undefined
  if (prev.handoff && !prev.handoff.needsAction) {
    const title = prev.handoff.title.trim()
    const tasks = listTasks()
    const task = tasks.find((x) => x.ownerSessionId === sid && x.title === title) ?? tasks.find((x) => x.title === title)
    from = { name: title, personaId: task?.auth.personaId || 'general', task: true }
  } else {
    const lower = headline.toLowerCase()
    const who = (s.members ?? [])
      .filter((x) => lower.startsWith(x.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (who) from = memberFace(who)
  }
  if (!from) return undefined
  const text = first.text.slice(headline.length).replace(/^\s+/, '')
  // 只有标题、没有结论：留着标题那句，不出一条空回复。
  if (!text && m.blocks.length === 1) return { msg: m, from }
  return { msg: { ...m, blocks: text ? [{ ...first, text }, ...m.blocks.slice(1)] : m.blocks.slice(1) }, from }
}

/**
 * 刚发出的那条用户消息在手机端消息里的 id（发送回执带给手机，手机按它把先显示出来的那条换成真的，不按内容去猜）。
 * 刚起的这一轮，展示投影里最后一条用户消息就是它；用户消息不拆分，id 就是它的序号。
 */
export function lastUserMessageId(all: DisplayMessage[]): string | undefined {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (m.role === 'user' && !m.notify && !m.quiet) return String(i)
  }
  return undefined
}

/** 进行中这一轮在展示投影里从哪条起：最后一条用户消息（含后台通知起的一轮）。 */
export function turnStartIndex(all: DisplayMessage[]): number {
  for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') return i
  return Math.max(0, all.length - 1)
}

/** 列表第二行：最近一条有正文的消息（用户或助手），去掉标记与多余空白。 */
export function previewOf(s: StoredSession): { text: string; role?: 'user' | 'assistant' } {
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

type WebMember = { id: string; name: string; avatar?: string; personaId?: string }

/**
 * 挂载的文件夹名与项目成员（列表的群组头像、对话页标题下的说明），同电脑端 memberPersona：
 * 已移除的成员不算；用户 @ 加入的角色用角色本身的名字与头像；主智能体创建的成员以成员会话 id 为种子，
 * 形状用创建时存下的（老成员没存，按旧取法 'auto'）。
 */
export function sessionExtras(m: ChatSessionMeta): { folder?: string; members?: WebMember[] } {
  const folder = typeof m.focusRoot === 'string' && m.focusRoot.trim() ? basename(m.focusRoot.replace(/[\\/]+$/, '')) : undefined
  const members = (m.members ?? []).filter((x) => !x.removed).map(memberFace)
  return { folder, members: members.length ? members : undefined }
}

function memberFace(x: MemberRef): WebMember {
  const own = x.origin === 'mention' ? getPersona(x.personaId) : null
  if (own) return { id: own.id, name: own.name, avatar: own.avatar, personaId: own.id }
  return { id: x.sessionId, name: x.name, avatar: JSON.stringify({ shape: isAvatarShape(x.shape) ? x.shape : AUTO_SHAPE }) }
}

/**
 * 成员在等你处理的卡该显示在哪个主对话、署谁的名（同电脑端 MemberAsks）：成员会话里的提问 / 计划 / 选文件夹 → 它的主对话；
 * 主角色建成员时为新成员选文件夹（主对话自己的卡，带成员名）→ isNew。其余的卡返回 undefined（照常显示在自己的对话里）。
 */
export function promptMember(view: PromptView): WebPromptMember | undefined {
  const s = getSession(view.sessionId)
  if (s?.parentId) {
    const main = getSession(s.parentId)
    const ref = main?.members?.find((x) => x.sessionId === s.id)
    if (!main) return undefined
    if (!ref) return { sid: main.id, name: s.title || '成员', id: s.id }
    return { sid: main.id, ...memberFace(ref) }
  }
  if (view.kind === 'mount' && view.member) return { sid: view.sessionId, name: view.member, isNew: true }
  return undefined
}

/** 推送通知与胶囊同一句：只写谁在等什么（同电脑端，不写问题的具体内容）。 */
export function memberWaitText(view: PromptView, m: WebPromptMember): string {
  if (view.kind === 'ask') return `${m.name}在等你回答`
  if (view.kind === 'plan') return `${m.name}在等你批准计划`
  return m.isNew ? `新成员${m.name}在等你选择文件夹` : `${m.name}在等你选择文件夹`
}

/** 手机端能看到的角色：已启用的全部角色（手机版是主人自己的设备，不按回复范围过滤）。 */
export function personaList(): WebPersona[] {
  return listPersonas(true).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    model: p.model,
    avatar: p.avatar,
    avatarImage: p.avatarImage,
    enabled: p.enabled
  }))
}

interface ConfigProvider {
  id?: unknown
  name?: unknown
  enabled?: unknown
  purpose?: unknown
  models?: unknown
}
interface ConfigModel {
  id?: unknown
  name?: unknown
  enabled?: unknown
}

/** 可在对话里选用的模型：已启用的对话服务商 × 已启用的模型（同电脑端输入框的模型选择器）。 */
export function modelList(): WebModel[] {
  const out: WebModel[] = []
  try {
    const raw = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(raw.providers) ? (raw.providers as ConfigProvider[]) : []
    for (const p of providers) {
      if (!p || typeof p.id !== 'string' || p.enabled !== true || (p.purpose ?? 'llm') !== 'llm') continue
      const provider = typeof p.name === 'string' && p.name ? p.name : p.id
      for (const m of Array.isArray(p.models) ? (p.models as ConfigModel[]) : []) {
        if (!m || typeof m.id !== 'string' || !m.id || m.enabled !== true) continue
        out.push({ ref: `${p.id}:${m.id}`, name: typeof m.name === 'string' && m.name ? m.name : m.id, provider })
      }
    }
  } catch {
    /* 配置读不出：当作没有可选的模型 */
  }
  return out
}

/** 对话发消息时实际用的模型（同 adapter.sendText 的取法：对话自己的 → 角色的 → 最近使用的）及其显示名。 */
export function sessionModel(m: ChatSessionMeta, models: WebModel[] = modelList()): { model?: string; modelName?: string } {
  const persona = m.personaId ? getPersona(m.personaId) : null
  const r = resolveModelRefOrNull(m.model) ?? resolveModelRefOrNull(persona?.model) ?? resolveDefaultModel()
  if (!r) return {}
  const ref = `${r.providerId}:${r.model}`
  return { model: ref, modelName: models.find((x) => x.ref === ref)?.name ?? r.model }
}
