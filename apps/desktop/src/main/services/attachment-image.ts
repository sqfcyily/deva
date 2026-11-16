import { imageRef } from './chat-display'
import { getSession } from './chat-store'
import { thumbnailDataUrl } from './image-read'

/**
 * 对话记录里的图片附件：缩略图（full=false）或原图（full=true，点开看大图）。ref 即展示层附件上的
 * 「消息下标:内容块下标:指纹」（imageRef）——按轮删除 / 回滚 / 压缩后展示层整份重载，ref 随之更新；
 * 对不上（那里已不是这张图）返回 null，界面显示类型图标占位。电脑端（chat:attachment-image）与手机端共用。
 */
export function attachmentImage(sessionId: unknown, ref: unknown, full: unknown): string | null {
  if (typeof sessionId !== 'string' || typeof ref !== 'string') return null
  const at = /^(\d+):(\d+):/.exec(ref)
  const msg = at ? getSession(sessionId)?.messages[Number(at[1])] : undefined
  if (!at || msg?.role !== 'user' || typeof msg.content === 'string') return null
  const pi = Number(at[2])
  const part = msg.content[pi]
  if (part?.type !== 'image' || imageRef(Number(at[1]), pi, part.data) !== ref) return null
  if (full === true) return `data:${part.mediaType};base64,${part.data}`
  try {
    return thumbnailDataUrl(Buffer.from(part.data, 'base64'), part.mediaType)
  } catch {
    return null
  }
}
