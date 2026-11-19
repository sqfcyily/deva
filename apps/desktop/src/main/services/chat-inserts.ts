/**
 * 插入消息的附件：请求里附件的清洗，以及送达那一刻把附件读成内容块。待送达队列本身在 chat-turns.ts（pendingInserts）。
 *
 * 队列里只存路径、送达时才读：来不及送达改作下一轮发出、被停止后退回输入框、用户撤回，这三条路都要把附件
 * 原样带回去，存路径最省事；也免得几张图的 base64 在队列里一直占着内存。
 */
import type { ContentPart } from '../providers/types'
import type { InsertAttachment, TakenInserts } from '../../shared/chat-protocol'
import { ATTACHMENTS_ONLY_QUESTION, buildAttachmentPart } from './attachments'

const KINDS = new Set<InsertAttachment['kind']>(['image', 'document', 'text', 'folder', 'file'])

/** 请求里的附件按形状清洗、按路径去重（路径是否已授权由 buildAttachmentPart 在读取时把关）。 */
export function cleanInsertAttachments(raw: unknown): InsertAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: InsertAttachment[] = []
  const seen = new Set<string>()
  for (const a of raw as Partial<InsertAttachment>[]) {
    if (!a || typeof a.path !== 'string' || !a.path || seen.has(a.path)) continue
    seen.add(a.path)
    out.push({
      path: a.path,
      name: typeof a.name === 'string' && a.name ? a.name : a.path,
      kind: KINDS.has(a.kind as InsertAttachment['kind']) ? (a.kind as InsertAttachment['kind']) : 'file',
      ...(typeof a.size === 'number' ? { size: a.size } : {})
    })
  }
  return out
}

/** 送达模型的一批插入消息：用户原文（附上读不进去的附件的说明），以及排在它前面的附件内容块。 */
export interface InsertDelivery {
  text: string
  parts: ContentPart[]
}

/**
 * 把取走的插入消息读成可交给模型的内容：附件内容块在前，正文在后（同普通消息，见 chat-turns.ts startTurn）。
 * 只有附件没有文字时代填一句提问；读不进去的附件（文件已被删、PDF 遇上不支持的协议）写成说明附在正文后。
 */
export async function buildInsertDelivery(
  taken: TakenInserts,
  adapter: 'anthropic' | 'openai' | 'responses'
): Promise<InsertDelivery> {
  const parts: ContentPart[] = []
  const notes: string[] = []
  for (const a of taken.attachments) {
    const { part, note } = await buildAttachmentPart(a.path, adapter)
    if (part) parts.push(part)
    if (note) notes.push(note)
  }
  const body = taken.text || (parts.length ? ATTACHMENTS_ONLY_QUESTION : '')
  const text = [body, notes.length ? `（${notes.join('；')}）` : ''].filter(Boolean).join('\n')
  return { text, parts }
}
