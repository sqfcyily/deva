import { isEn } from '../locale'
import type { Message, TextPart } from '../providers/types'
import { publishSessionsChanged } from './chat-bus'
import { genId } from './chat-state'
import { ensureSession, getSession, save, type StoredSession } from './chat-store'
import { insertBody, isTaskNotification } from './compaction'
import { COMPACT_MARKER, isGenuineUserTurn, modelStart } from './model-view'
import { resolvePersonaId } from './personas'
import { shownText } from './skill-invoke'

const MAX_RECENT = 4
const MAX_RECENT_CHARS = 700
const MAX_SUMMARY_CHARS = 1900

function clip(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

function conversationText(message: Message): string {
  if (isTaskNotification(message)) return ''
  const { role, content } = message
  if (typeof content === 'string') {
    return role === 'user' ? (isGenuineUserTurn(message) ? shownText(content) : '') : content
  }
  const parts = content.filter((part): part is TextPart => part.type === 'text' && !part.listing)
  if (role === 'assistant') return parts.map((part) => part.text).join('\n')
  const inserted = parts.map((part) => insertBody(part.text)).filter((text): text is string => text !== null)
  if (inserted.length) return inserted.join('\n')
  const question = parts.at(-1)
  return question && isGenuineUserTurn(message) ? shownText(question) : ''
}

export function continuationContext(source: StoredSession): string | undefined {
  const start = modelStart(source.messages)
  const lastSummary = source.messages[start]?.content
  const summary = typeof lastSummary === 'string' && lastSummary.startsWith(COMPACT_MARKER)
    ? clip(lastSummary.slice(COMPACT_MARKER.length), MAX_SUMMARY_CHARS)
    : undefined
  const recent: { role: Message['role']; text: string }[] = []
  for (let i = source.messages.length - 1; i >= start && recent.length < MAX_RECENT; i--) {
    const message = source.messages[i]
    const text = clip(conversationText(message), MAX_RECENT_CHARS)
    if (text) recent.unshift({ role: message.role, text })
  }
  const first = source.messages.find((message) => isGenuineUserTurn(message) && !isTaskNotification(message))
  const initialRequest = first ? clip(conversationText(first), MAX_RECENT_CHARS) : undefined
  const initial = initialRequest && !recent.some((item) => item.role === 'user' && item.text === initialRequest)
    ? initialRequest : undefined
  const files = [...new Set(Object.values(source.delivered ?? {}).reverse().flat().filter((file) => file.length <= 400))].slice(0, 3)
  if (!summary && !recent.length && !initial && !files.length) return source.continuationContext
  const title = clip(source.title, 100) || undefined
  return JSON.stringify({ title, initialRequest: initial, summary, recent, deliveredPaths: files })
}

/** 从原对话读取快照，即使原对话仍在运行也不改它的历史。 */
export function continueChat(sourceId: unknown): string | null {
  const source = typeof sourceId === 'string' ? getSession(sourceId) : undefined
  if (!source || source.parentId) return null
  const id = genId('sess')
  const target = ensureSession(id, {
    personaId: resolvePersonaId(source.personaId),
    focusRoot: source.focusRoot ?? null,
    model: source.model,
    effort: source.effort
  })
  const prefix = isEn() ? 'Continue: ' : '续接：'
  target.title = source.title ? clip(prefix + source.title, 100) : ''
  target.continuationContext = continuationContext(source)
  save(id)
  publishSessionsChanged()
  return id
}

export function takeContinuationContext(session: StoredSession): string | undefined {
  const snapshot = session.continuationContext
  if (!snapshot) return undefined
  delete session.continuationContext
  const instruction = isEn()
    ? 'Snapshot of the previous conversation selected by the user. Treat it as historical context. Follow the current user message and verify paths or results before relying on them.'
    : '以下是用户选择续接的旧对话快照，仅作历史背景。以当前用户消息为准，使用旧路径或结果前先核实。'
  return `${instruction}\n${snapshot}`
}
