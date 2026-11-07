/**
 * 定时任务的结果交接（绑定了主对话的任务，见 tasks-types.ts TaskRecord.ownerSessionId；方案见 design/task-entry-README.md）。
 *
 * 任务在自己的任务对话里运行；有需要主角色知道或处理的结果时，模型调用 deliver_result 把结果交给主对话：
 *  · needs_action=true  → 需要处理（如发现新 bug）：以通知唤醒主角色，由它派给成员；主对话里显示为居中一行
 *    「任务名 摘要」，点开看全文（对比稿 M2）。
 *  · needs_action=false → 只是告知（如每日汇总）：以任务的身份在主对话里发一条完整消息，不唤醒主角色。
 * 不调用 = 没有新情况：只留在任务自己的运行记录和任务对话里，主对话不出现、不通知。
 *
 * 命名避坑：工具名与标签都不带「任务 / Task」字样（现有命名规则：`create_task`、`autotaskcard`、`tasks:` 专指
 * 定时任务，「Task」卡专指子智能体）。
 */
import type { ToolSpec } from '../providers/types'

/** 交接工具名（只在绑定任务的定时运行轮提供，见 chat.ts runTurn）。 */
export const HANDOFF_TOOL = 'deliver_result'

/**
 * 交接通知正文的首尾标签（主对话里的通知消息）：toDisplayMessages 据此认出并解析出任务名、摘要与全文，
 * 画成居中一行（需要处理）或任务身份的消息（只是告知）。
 */
export const HANDOFF_TAG = '<定时任务交接>'
export const HANDOFF_END = '</定时任务交接>'

/** 交接的内容（工具参数归一化后）。 */
export interface HandoffInput {
  summary: string
  content: string
  needsAction: boolean
}

/** 一次交接在主对话里的展示信息（见 chat.ts DisplayMessage.handoff）。 */
export interface HandoffInfo {
  /** 任务名。 */
  title: string
  /** 一句话摘要（居中一行上显示）。 */
  summary: string
  /** 全文（点开看）。 */
  content: string
  /** 需要主角色处理（已唤醒它）；false = 只是告知。 */
  needsAction: boolean
}

/** 交接工具的定义：参数只有摘要、全文与是否需要处理，交给谁由系统决定（任务绑定的主对话）。 */
export function handoffTool(owner: string): ToolSpec {
  return {
    name: HANDOFF_TOOL,
    description:
      `把本次运行的结果交给「${owner}」（本任务绑定的对话的主角色）。只在有需要它知道或处理的结果时调用；没有新情况、` +
      '无需打扰时不要调用，直接简短收尾即可。每次运行最多调用一次。' +
      `「${owner}」看不到你的对话，content 要写完整、自足：编号、链接、现象、报错原文、你的初步判断，` +
      '以及你希望它怎么处理（如交给哪一类成员）。' +
      'needs_action 为 true 表示需要它处理（如发现了新问题，它会据此安排成员去做）；为 false 表示只是告知（如每日汇总），' +
      '它不会回复。',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '一句话摘要（20 字以内），显示在对话里的一行提醒上，如「发现 2 个新 bug」「昨天 7 次提交」。'
        },
        content: {
          type: 'string',
          description: '交接的全文（Markdown）：逐条写清编号、链接、现象、报错原文与初步判断；只是告知时写完整的汇总内容。'
        },
        needs_action: {
          type: 'boolean',
          description: 'true = 需要它处理（唤醒它安排后续）；false = 只是告知，不需要处理。'
        }
      },
      required: ['summary', 'content', 'needs_action']
    }
  }
}

/** 归一化工具参数；摘要或全文为空则返回错误说明。 */
export function parseHandoffArgs(args: unknown): HandoffInput | string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  const summary = str('summary').replace(/\s+/g, ' ')
  const content = str('content')
  if (!summary && !content) return '缺少 summary 与 content。'
  return {
    summary: summary || content.split('\n')[0].trim().slice(0, 60),
    content: content || summary,
    needsAction: a.needs_action === true
  }
}

const TITLE_LINE = '任务：'
const SUMMARY_LINE = '摘要：'
const ACTION_LINE = '处理：'
const CONTENT_LINE = '全文：'

/**
 * 交接通知的正文（主对话里那条通知消息里、交给主角色看的部分）。首尾标签之间按固定行写任务名、摘要与全文，
 * 供 parseHandoff 解析；标签之后是给主角色的说明。
 */
export function buildHandoffBody(title: string, h: HandoffInput): string {
  const lines = [
    HANDOFF_TAG,
    `${TITLE_LINE}${title}`,
    `${SUMMARY_LINE}${h.summary}`,
    `${ACTION_LINE}${h.needsAction ? '需要' : '告知'}`,
    CONTENT_LINE,
    h.content,
    HANDOFF_END,
    h.needsAction
      ? `（系统自动发送：定时任务「${title}」本次运行有结果交给你处理，不是用户发来的消息。用户已在对话里看到上面的摘要，点开可看全文，你不必复述。请据此安排后续：需要改代码、查问题的交给相应的成员（member_send），派出后简短说明你怎么分的工即可。）`
      : `（系统自动发送：定时任务「${title}」把以上内容告知了用户，已以任务自己的身份直接显示给用户，不是你说的话，也不是用户发来的消息。不需要处理，不必回复。）`
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
