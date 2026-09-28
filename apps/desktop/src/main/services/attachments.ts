import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promises as fs } from 'fs'
import { basename, extname, join, resolve } from 'path'
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

/**
 * 粘贴附件的落盘目录。粘贴来的只有字节、没有路径（截图尤其如此），故由主进程写到这里再走同一套
 * 白名单——渲染层只交内容、从不交路径，「不能伪造任意路径读盘」的不变式不变。
 * 白名单是内存态、随重启清空，上次运行留下的文件已无用：注册 IPC 时整目录清掉。
 * 发送时内容即转成 base64 块进历史，文件只需活到发送前。
 */
const PASTE_DIR = join(tmpdir(), 'deva-paste')

/** 统一的类型/体积判定：合规者登记白名单。选择框与粘贴两路共用，限额只此一处。 */
function inspect(abs: string, size: number): PickedAttachment {
  const name = basename(abs)
  const ext = extname(abs).toLowerCase()
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
  return { path: abs, name, ext, size, kind, supported, reason }
}

/** 粘贴文件名：剥掉路径与 Windows 非法字符；截图等无名/通用名（image.png）按时间戳重命名。 */
function pasteName(raw: string, mime: string): string {
  const clean = basename(raw || '').replace(/[<>:"/|?*\x00-\x1f]/g, '_').trim()
  // 「.」「..」会让 join 退回上级目录：与无名同样处理。
  if (clean && !/^\.+$/.test(clean) && !/^image\.\w+$/i.test(clean)) return clean
  const ext = extname(clean) || (mime.startsWith('image/') ? `.${mime.slice(6).replace('jpeg', 'jpg')}` : '')
  // 本地时间（toISOString 是 UTC，文件名里的时刻会与用户所见差时区）。
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  return `粘贴-${ts}${ext}`
}

export function registerAttachmentsIpc(getWindow: () => BrowserWindow | null): void {
  void fs.rm(PASTE_DIR, { recursive: true, force: true }).catch(() => {})

  // 粘贴（截图 / 资源管理器里复制的文件）：渲染层交文件名 + 字节，超 PDF 上限的大文件渲染层不读、
  // 只交体积（data=null），由此处统一给出「过大」判定，免得几百 MB 过一遍 IPC。
  ipcMain.handle(
    'fs:paste-attachment',
    async (
      _e,
      file: { name: string; mime: string; size: number; data: Uint8Array | null }
    ): Promise<PickedAttachment> => {
      const name = pasteName(file.name, file.mime || '')
      // 每次粘贴独占一个子目录：同名文件（如两张 image.png）互不覆盖，名字仍保持原样展示。
      const abs = join(PASTE_DIR, randomUUID(), name)
      if (!file.data) return inspect(abs, file.size)
      const pre = inspect(abs, file.data.byteLength)
      if (!pre.supported) return pre
      await fs.mkdir(join(abs, '..'), { recursive: true })
      await fs.writeFile(abs, file.data)
      return pre
    }
  )

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
      let size = 0
      try {
        size = (await fs.stat(abs)).size
      } catch {
        /* stat 失败：按 0 处理，读取阶段再兜底 */
      }
      out.push(inspect(abs, size))
    }
    return out
  })
}

/**
 * 把一个「已授权」的附件读成归一化内容块。
 * - 图片 → ImagePart（base64）
 * - PDF → Anthropic（document 块）与 OpenAI Responses（input_file）可原生读取，给 DocumentPart；
 *   仅 OpenAI Chat Completions 无 PDF 通道，跳过并回一条说明
 * - 文本/代码 → 带前缀标记的 TextPart（注入正文）
 * 未授权 / 超限 / 读取失败 → 返回 note（不产出内容块）。
 */
export async function buildAttachmentPart(
  path: string,
  adapter: 'anthropic' | 'openai' | 'responses'
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
      // 仅 OpenAI Chat Completions 无 PDF 通道；Anthropic 与 OpenAI Responses 均可原生读取。
      if (adapter === 'openai')
        return { note: `PDF「${name}」需使用 Anthropic 或 OpenAI Responses 协议的模型才能读取，本次已跳过` }
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
