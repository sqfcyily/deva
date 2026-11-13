/**
 * 定时任务的结果交接（绑定了主对话的任务，见 tasks-types.ts TaskRecord.ownerSessionId；方案见 design/task-entry-README.md）。
 *
 * 任务在自己的任务对话里运行；有需要主角色知道或处理的结果时，模型调用 deliver_result 把结果交给主对话：
 *  · needs_action=true  → 需要处理（如发现新 bug）：以通知唤醒主角色，由它派给成员；主对话里显示为居中一行
 *    「任务名 摘要」，点开看全文（对比稿 M2）。
 *  · needs_action=false → 只是告知（如提醒、每日汇总）：本轮结束后把任务的最终回复**原文**以任务的身份发进主对话，
 *    不唤醒主角色。不让模型另写一份 content——再总结一遍只会丢信息，最终回复本身就是整理好的结果。
 * 不调用 = 没有新情况：只留在任务自己的运行记录和任务对话里，主对话不出现、不通知（调度器也不弹通知，见
 * scheduler.ts notifyForRun）。所以提醒、日报这类每次都要让用户看到的，每次都得交——工具说明与系统提示词都写明了。
 *
 * 在会话中运行的任务对主角色来说相当于成员（见 chat-task-handoff.ts askTask）：随成员名单下发，主角色可用 member_send 把用户的
 * 追问转给它（它在自己的对话里回答，回答同样以任务身份发进主对话）、用 member_status 看它最近一次发来的全文。
 * 所以只是告知的长内容不必留在主角色的上下文里：发给模型时换成一行占位（见 stubLongInforms），全文只给用户看。
 *
 * 命名避坑：工具名与标签都不带「任务 / Task」字样（现有命名规则：`create_task`、`autotaskcard`、`tasks:` 专指
 * 定时任务，「Task」卡专指子智能体）。
 */
import type { HandoffInfo } from '../../shared/chat-protocol'
import type { Message, ToolSpec } from '../providers/types'

/** 交接工具名（只在绑定任务的定时运行轮提供，见 chat-turns.ts runTurn）。 */
export const HANDOFF_TOOL = 'deliver_result'

/**
 * 交接通知正文的首尾标签（主对话里的通知消息）：toDisplayMessages 据此认出并解析出任务名、摘要与全文，
 * 画成居中一行（需要处理）或任务身份的消息（只是告知）。
 */
export const HANDOFF_TAG = '<定时任务交接>'
export const HANDOFF_END = '</定时任务交接>'

/**
 * 交接的内容（工具参数归一化后）。只是告知的：调用时 summary 可能为空、content 只是兜底（模型自己填了才有），
 * 本轮结束时由 chat.ts 换成最终回复原文（见 finishInform）。
 */
export interface HandoffInput {
  summary: string
  content: string
  needsAction: boolean
}

export type { HandoffInfo } from '../../shared/chat-protocol'

/** 交接工具的定义：参数只有摘要、全文与是否需要处理，交给谁由系统决定（任务绑定的主对话）。 */
export function handoffTool(owner: string): ToolSpec {
  return {
    name: HANDOFF_TOOL,
    description:
      `把本次运行的结果交到「${owner}」的对话里（用户在那里看结果，「${owner}」是那个对话的主角色）。` +
      '你在任务对话里写的内容用户平时看不到，也没有系统通知，要让用户看到就必须调用本工具。' +
      '提醒、日报、定期汇总这类用户要按时看到的，每次都调用；巡检、监控这类查有没有新情况的，没有新情况时不要调用，' +
      '直接简短收尾即可。每次运行最多调用一次。' +
      'needs_action 为 false 表示只让用户知道（提醒、日报、汇总）：不用填 content，先调用本工具，再把要给用户看的完整内容' +
      `写成你的最终回复——这条回复会原文以本任务的身份发到对话里，「${owner}」不会回复。` +
      `needs_action 为 true 表示需要「${owner}」处理（如发现了新问题，它会据此安排成员去做）：它看不到你的对话，` +
      'content 要写完整、自足：编号、链接、现象、报错原文、你的初步判断，以及你希望它怎么处理（如交给哪一类成员）。',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '一句话摘要（20 字以内），显示在对话里的一行提醒上，如「发现 2 个新 bug」「昨天 7 次提交」。'
        },
        content: {
          type: 'string',
          description:
            'needs_action 为 true 时必填：交接的全文（Markdown），逐条写清编号、链接、现象、报错原文与初步判断。' +
            '为 false 时不填，发给用户的是你随后的最终回复原文。'
        },
        needs_action: {
          type: 'boolean',
          description: 'true = 需要它处理（唤醒它安排后续）；false = 只让用户知道，不需要处理。'
        }
      },
      required: ['summary', 'needs_action']
    }
  }
}

/**
 * 归一化工具参数。需要处理的：摘要与全文都空则返回错误说明。只是告知的不校验（发出去的是最终回复，摘要缺了
 * 届时取回复首行），content 原样留作兜底。
 */
export function parseHandoffArgs(args: unknown): HandoffInput | string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  const summary = str('summary').replace(/\s+/g, ' ')
  const content = str('content')
  const needsAction = a.needs_action === true
  if (!needsAction) return { summary, content, needsAction }
  if (!summary && !content) return '缺少 summary 与 content。'
  return {
    summary: summary || headOf(content),
    content: content || summary,
    needsAction
  }
}

/** 一段 Markdown 的首个非空行（去掉标题井号），截到 60 字，作缺省摘要。 */
export function headOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.replace(/^#+\s*/, '').trim().slice(0, 60)
}

const TITLE_LINE = '任务：'
const SUMMARY_LINE = '摘要：'
const ACTION_LINE = '处理：'
const CONTENT_LINE = '全文：'

/**
 * 交接通知的正文（主对话里那条通知消息里、交给主角色看的部分）。首尾标签之间按固定行写任务名、摘要与全文，
 * 供 parseHandoff 解析；标签之后是给主角色的说明。
 * 只是告知的不写全文：原文就是紧跟的下一条（以任务身份显示的那条回复），写两遍白占主对话的上下文。
 */
export function buildHandoffBody(title: string, h: HandoffInput): string {
  const lines = [
    HANDOFF_TAG,
    `${TITLE_LINE}${title}`,
    `${SUMMARY_LINE}${h.summary}`,
    `${ACTION_LINE}${h.needsAction ? '需要' : '告知'}`,
    CONTENT_LINE,
    ...(h.needsAction ? [h.content] : []),
    HANDOFF_END,
    h.needsAction
      ? `（系统自动发送：定时任务「${title}」本次运行有结果交给你处理，不是用户发来的消息。用户已在对话里看到上面的摘要，点开可看全文，你不必复述。请据此安排后续：需要改代码、查问题的交给相应的成员（member_send），派出后简短说明你怎么分的工即可。）`
      : `（系统自动发送：定时任务「${title}」以自己的身份直接发给了用户一条消息，下一条就是它的原文，不是你说的话，也不是用户发来的消息。不需要处理，不必回复。）`
  ]
  return lines.join('\n')
}

/** 从通知消息正文里解析出交接信息（不含交接标签则 null）。 */
export function parseHandoff(text: string): HandoffInfo | null {
  const start = text.indexOf(HANDOFF_TAG)
  if (start < 0) return null
  const end = text.indexOf(HANDOFF_END, start)
  const inner = text.slice(start + HANDOFF_TAG.length, end < 0 ? undefined : end)
  const lines = inner.split('\n')
  let title = ''
  let summary = ''
  let needsAction = false
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith(TITLE_LINE)) title = l.slice(TITLE_LINE.length).trim()
    else if (l.startsWith(SUMMARY_LINE)) summary = l.slice(SUMMARY_LINE.length).trim()
    else if (l.startsWith(ACTION_LINE)) needsAction = l.slice(ACTION_LINE.length).trim() === '需要'
    else if (l === CONTENT_LINE) {
      i++
      break
    }
  }
  const content = lines.slice(i).join('\n').trim()
  return { title, summary, content, needsAction }
}

// ── 只是告知的长内容：主角色上下文里只留占位 ──────────────────────────────────────

/** 只是告知的原文超过这么多字，发给模型时才换成占位：短的（如一句提醒）原文本身就是摘要，换了省不了什么。 */
const INFORM_INLINE_MAX = 1000

/** 消息里的文字（多个 text 块拼起来）。 */
function textOf(m: Message): string {
  return typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/**
 * 主对话里每次「只是告知」：[i] 不显示的交接通知、[i+1] 以任务身份显示的回复「任务名：摘要」+ 原文
 * （见 chat-task-handoff.ts commitHandoffs）。逐对回调，给出解析出的交接信息与原文（去掉标题行）。
 */
function eachInform(
  history: Message[],
  visit: (i: number, h: HandoffInfo, head: string, body: string) => void
): void {
  for (let i = 0; i + 1 < history.length; i++) {
    const note = history[i]
    if (note.role !== 'user' || typeof note.content !== 'string' || !note.content.includes(HANDOFF_TAG)) continue
    const h = parseHandoff(note.content)
    const reply = history[i + 1]
    if (!h || h.needsAction || reply.role !== 'assistant') continue
    const head = `${h.title}：${h.summary}`
    const text = textOf(reply)
    if (!text.startsWith(head)) continue
    visit(i, h, head, text.slice(head.length).trim())
  }
}

/**
 * 发给模型前（只影响这次请求与摘要压缩，历史不动）：只是告知的原文超过 INFORM_INLINE_MAX 字时，
 * 回复换成「标题 + 一行说明」，用户在界面上照样看全文。早先版本的交接通知里也写着全文，一并去掉。
 * 写法固定（只取决于这条消息本身），每次请求换出来的字节一样，不破坏提示缓存。
 */
export function stubLongInforms(history: Message[]): Message[] {
  let out: Message[] | null = null
  eachInform(history, (i, h, head, body) => {
    const note = history[i] as Message & { content: string }
    if (h.content) {
      out ??= history.slice()
      const at = note.content.indexOf(HANDOFF_TAG)
      out[i] = {
        role: 'user',
        content: note.content.slice(0, at) + buildHandoffBody(h.title, { summary: h.summary, content: '', needsAction: false })
      }
    }
    if (body.length <= INFORM_INLINE_MAX) return
    out ??= history.slice()
    out[i + 1] = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            `${head}\n\n（定时任务「${h.title}」发给用户的这条消息共 ${body.length} 字，用户在对话里看得到全文，` +
            `你的上下文里只留了这个标题。用户问起其中的内容时，用 member_send 转给「${h.title}」，由它回答；` +
            `需要它最近一次发来的全文（如转给别的成员）时，用 member_status 查看「${h.title}」。）`
        }
      ]
    }
  })
  return out ?? history
}

/** 某个任务最近一次以自己身份发进主对话的原文（不含标题行；没有则空串）。member_status 据此给出全文。 */
export function lastInformBody(history: Message[], title: string): string {
  let last = ''
  eachInform(history, (_i, h, _head, body) => {
    if (h.title === title) last = body
  })
  return last
}
