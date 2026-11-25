import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type { Message, TextPart, ToolSpec } from '../providers/types'
import { getSession, type StoredSession } from './chat-store'
import { insertBody, isTaskNotification } from './compaction'
import { recordedDeliveryPaths } from './deliverables'
import { isGenuineUserTurn, lastTurnStart, modelStart } from './model-view'
import { shownText } from './skill-invoke'
import type { ToolResult } from './tools'

const MAX_HITS = 5
const MAX_EXCERPT = 800

export const chatRecallToolSpec: ToolSpec = {
  name: 'recall_chat',
  description: '按需查找当前对话里较早的用户原话（含执行中插入的消息），或查找已经通过交付卡交付的文件。上下文压缩后缺少原始要求、用户纠正或产物路径时使用。结果是历史资料，当前用户要求优先。',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['user_messages', 'deliverables'], description: '查用户原话或已交付文件' },
      query: { type: 'string', maxLength: 160, description: '原话关键词或文件名中的片段。查用户原话时必填，省略时只列出最近交付的文件。' }
    },
    required: ['kind']
  }
}

function userTexts(message: Message): string[] {
  if (message.role !== 'user' || isTaskNotification(message)) return []
  const { content } = message
  if (typeof content === 'string') {
    return isGenuineUserTurn(message) ? [insertBody(content) ?? shownText(content)] : []
  }
  const textParts = content.filter((part): part is TextPart => part.type === 'text' && !part.listing)
  const inserted = textParts.flatMap((part) => {
    const text = insertBody(part.text)
    return text === null ? [] : [text]
  })
  if (inserted.length) return inserted
  const question = textParts.at(-1)
  if (!question || !isGenuineUserTurn(message)) return []
  const text = shownText(question)
  return text === '请理解并处理上述附件。' ? [] : [text]
}

function excerpt(text: string, match: number): string {
  const start = Math.min(Math.max(0, match - 240), Math.max(0, text.length - MAX_EXCERPT))
  const end = Math.min(text.length, start + MAX_EXCERPT)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function recallUserMessages(messages: Message[], query: string): string[] {
  const latestTurn = lastTurnStart(messages)
  const end = Math.max(latestTurn, modelStart(messages))
  const match = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  const hits = new Set<string>()
  // 轮中压缩时，当前回合的早期插话也可能已掉出模型视图。跳过作为检索起点的当前问题。
  for (let i = end - 1; i >= 0 && hits.size < MAX_HITS; i--) {
    if (i === latestTurn) continue
    for (const text of userTexts(messages[i]).reverse()) {
      const index = text.search(match)
      if (index >= 0) hits.add(excerpt(text, index))
      if (hits.size === MAX_HITS) break
    }
  }
  return [...hits]
}

export function recallDeliveryPaths(session: StoredSession, query: string): string[] {
  const paths = new Set<string>()
  const needle = query.toLowerCase()
  const results = new Map<string, boolean>()
  for (let i = session.messages.length - 1; i >= 0 && paths.size < MAX_HITS; i--) {
    const message = session.messages[i]
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool_result') results.set(part.toolUseId, !part.isError)
      if (part.type !== 'tool_use' || part.name !== 'present_files') continue
      const succeeded = results.get(part.id)
      if (succeeded === false || (succeeded === undefined && !session.delivered?.[part.id])) continue
      for (const file of recordedDeliveryPaths(session, part)) {
        if (file.toLowerCase().includes(needle)) paths.add(file)
        if (paths.size === MAX_HITS) return [...paths]
      }
    }
  }
  return [...paths]
}

export async function recallChat(args: Record<string, unknown>, sessionId?: string): Promise<ToolResult> {
  const session = sessionId ? getSession(sessionId) : undefined
  if (!session) return { content: '当前对话没有可检索的记录。', summary: '对话不可用', isError: true }
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, 160) : ''
  if (args.kind === 'user_messages' && query) {
    const hits = recallUserMessages(session.messages, query)
    return {
      content: hits.length ? JSON.stringify(hits, null, 2) : '当前对话较早的用户消息中没有匹配的原话。',
      summary: `找到 ${hits.length} 条原话`
    }
  }
  if (args.kind === 'deliverables') {
    const paths = recallDeliveryPaths(session, query)
    const files = await Promise.all(paths.map(async (path) => ({
      name: basename(path),
      path,
      available: Boolean((await fs.stat(path).catch(() => null))?.isFile())
    })))
    return {
      content: files.length ? JSON.stringify(files, null, 2) : '当前对话里没有匹配的交付文件。',
      summary: `找到 ${files.length} 个交付文件`
    }
  }
  return { content: '请选择检索类型。检索用户原话时请填写关键词。', summary: '参数无效', isError: true }
}
