import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, resolve } from 'path'
import type { ContentPart } from '../providers/types'

/**
 * 附加文件服务（主进程）。
 * 用户经原生选择框「亲手挑选」的文件才可读取——与项目根守卫（fs-guard）不同：
 * 附件常在项目目录之外（桌面的 PDF、文档里的图片），因此不走 assertInside，
 * 改用「本会话白名单」闸门：只有刚被 pick 选中且体积/类型合规的绝对路径才允许后续读取，
 * 防止渲染层伪造任意路径读盘。大文件 base64 只在主进程内产生，绝不回传渲染层。
 */

export type AttachmentKind = 'image' | 'document' | 'text' | 'unsupported'

export interface PickedAttachment {
  path: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  /** 类型受支持且体积合规，可发给模型 */
  supported: boolean
  /** 不受支持时的原因（展示用） */
  reason?: string
}

/** 文本类附件注入模型时的前缀标记（供历史重建识别为「附件」而非提问正文）。 */
export const ATTACH_TEXT_PREFIX = '[附件文件] '

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

// 可作为纯文本注入的扩展名（代码 / 配置 / 文档源）。
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.php',
  '.swift', '.m', '.mm', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.gradle', '.properties',
  '.env', '.r', '.dart', '.lua', '.pl', '.dockerfile', '.makefile', '.cmake'
])

const MAX_IMAGE = 5 * 1024 * 1024 // 5MB
const MAX_PDF = 20 * 1024 * 1024 // 20MB（Anthropic 上限约 32MB，留余量）
const MAX_TEXT = 512 * 1024 // 512KB（避免文本注入撑爆上下文）

function classify(ext: string): AttachmentKind {
  const e = ext.toLowerCase()
  if (e in IMAGE_MIME) return 'image'
  if (e === '.pdf') return 'document'
  if (TEXT_EXT.has(e)) return 'text'
  return 'unsupported'
}

// 本会话内被用户明确选中且合规的绝对路径白名单。
const allowed = new Set<string>()

export function registerAttachmentsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('fs:pick-attachments', async (): Promise<PickedAttachment[]> => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '选择附加文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '支持的文件',
          extensions: [
            'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
            'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'csv', 'log',
            'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'html', 'css', 'scss', 'xml',
            'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql'
          ]
        },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return []

    const out: PickedAttachment[] = []
    for (const p of res.filePaths) {
      const abs = resolve(p)
      const name = basename(abs)
      const ext = extname(abs).toLowerCase()
      let size = 0
      try {
        size = (await fs.stat(abs)).size
      } catch {
        /* stat 失败：按 0 处理，读取阶段再兜底 */
      }
      const kind = classify(ext)
      let supported = kind !== 'unsupported'
      let reason: string | undefined
      if (kind === 'unsupported') reason = '暂不支持的文件类型'
      else if (kind === 'image' && size > MAX_IMAGE) {
        supported = false
        reason = '图片过大（>5MB）'
      } else if (kind === 'document' && size > MAX_PDF) {
        supported = false
        reason = 'PDF 过大（>20MB）'
      } else if (kind === 'text' && size > MAX_TEXT) {
        supported = false
        reason = '文本过大（>512KB）'
      }
      if (supported) allowed.add(abs)
      out.push({ path: abs, name, ext, size, kind, supported, reason })
    }
    return out
  })
}

/**
 * 把一个「已授权」的附件读成归一化内容块。
 * - 图片 → ImagePart（base64）
 * - PDF → 仅 Anthropic 协议给 DocumentPart（base64）；其它协议跳过并回一条说明
 * - 文本/代码 → 带前缀标记的 TextPart（注入正文）
 * 未授权 / 超限 / 读取失败 → 返回 note（不产出内容块）。
 */
export async function buildAttachmentPart(
  path: string,
  adapter: 'anthropic' | 'openai'
): Promise<{ part?: ContentPart; note?: string }> {
  const abs = resolve(path)
  const name = basename(abs)
  if (!allowed.has(abs)) return { note: `已忽略未授权文件：${name}` }
  const kind = classify(extname(abs).toLowerCase())
  try {
    if (kind === 'image') {
      const buf = await fs.readFile(abs)
      if (buf.length > MAX_IMAGE) return { note: `图片过大已忽略：${name}` }
      return {
        part: {
          type: 'image',
          mediaType: IMAGE_MIME[extname(abs).toLowerCase()],
          data: buf.toString('base64'),
          name
        }
      }
    }
    if (kind === 'document') {
      if (adapter !== 'anthropic')
        return { note: `PDF「${name}」需使用 Anthropic 协议的模型才能读取，本次已跳过` }
      const buf = await fs.readFile(abs)
      if (buf.length > MAX_PDF) return { note: `PDF 过大已忽略：${name}` }
      return {
        part: { type: 'document', mediaType: 'application/pdf', data: buf.toString('base64'), name }
      }
    }
    if (kind === 'text') {
      const buf = await fs.readFile(abs)
      if (buf.length > MAX_TEXT) return { note: `文本过大已忽略：${name}` }
      return {
        part: { type: 'text', text: `${ATTACH_TEXT_PREFIX}${name}\n\`\`\`\n${buf.toString('utf8')}\n\`\`\`` }
      }
    }
    return { note: `已忽略不支持的文件：${name}` }
  } catch {
    return { note: `读取失败已忽略：${name}` }
  }
}
