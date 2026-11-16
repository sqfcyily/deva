import { closeSync, existsSync, mkdirSync, openSync, promises as fs, rmSync, statSync, writeSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { b64uDecode, b64uEncode } from '../../../../shared/remote-crypto'
import {
  FILE_CHUNK_BYTES,
  MAX_DOWNLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  type WebFileKind,
  type WebServerFrame
} from '../../../../shared/remote-web'
import { stageUploadedFile } from '../../attachments'
import { attachmentImage } from '../../attachment-image'
import { getDevaHome } from '../../config'
import { deliveredPath } from '../../deliverables'
import { officeText } from '../../office-text'

/**
 * 手机端的文件收发：
 *  · 上传（照片 / 文件）：分块写到 DEVA_HOME/uploads/<日期>/，收齐后按附件规则登记白名单，发消息时按上传 id 取路径；
 *    读不进消息的（docx、大文件 …）只把位置交给模型，所以落在不会被清掉的目录里。
 *  · 下载：只能取模型用 present_files 交付的文件（按对话 + 调用 id + 序号定位，同电脑端交付卡），
 *    文本 / Markdown / Office 文档直接给文字，图片与其他文件分块给字节。
 */

type Send = (frame: WebServerFrame) => void

interface Upload {
  device: string
  name: string
  size: number
  path: string
  fd: number | null
  received: number
  seq: number
  done: boolean
  at: number
}

/** 收齐的上传保留多久（够用户写完消息再发）。 */
const UPLOAD_KEEP_MS = 2 * 60 * 60_000
const MAX_PENDING_UPLOADS = 20

const uploads = new Map<string, Upload>()

function uploadDir(): string {
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const dir = join(getDevaHome(), 'uploads', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 文件名：去掉路径与非法字符；重名加序号。 */
function uniquePath(dir: string, raw: string): string {
  const clean = basename(raw || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120)
  const name = clean && !/^\.+$/.test(clean) ? clean : `手机上传-${Date.now()}`
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let p = join(dir, name)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

function closeUpload(u: Upload): void {
  if (u.fd !== null) {
    try {
      closeSync(u.fd)
    } catch {
      /* ignore */
    }
    u.fd = null
  }
}

function dropUpload(uid: string, removeFile: boolean): void {
  const u = uploads.get(uid)
  if (!u) return
  uploads.delete(uid)
  closeUpload(u)
  if (removeFile) rmSync(u.path, { force: true })
}

function sweepUploads(): void {
  const now = Date.now()
  for (const [uid, u] of uploads) if (now - u.at > UPLOAD_KEEP_MS) dropUpload(uid, !u.done)
}

export function uploadBegin(device: string, f: { uid: unknown; name: unknown; size: unknown }, send: Send): void {
  sweepUploads()
  const uid = typeof f.uid === 'string' && /^[\w-]{4,40}$/.test(f.uid) ? f.uid : ''
  if (!uid) return
  const fail = (message: string): void => send({ t: 'upload', uid, state: 'failed', message })
  const size = typeof f.size === 'number' && Number.isFinite(f.size) ? Math.floor(f.size) : -1
  if (size < 0) return fail('文件大小无效。')
  if (size > MAX_UPLOAD_BYTES) return fail(`文件太大，手机上传上限 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB。`)
  if (uploads.has(uid)) return fail('重复的上传。')
  if ([...uploads.values()].filter((u) => !u.done).length >= MAX_PENDING_UPLOADS) return fail('同时上传的文件太多。')
  let path: string
  let fd: number
  try {
    path = uniquePath(uploadDir(), typeof f.name === 'string' ? f.name : '')
    fd = openSync(path, 'w')
  } catch (e) {
    return fail(`电脑上无法保存文件：${(e as Error)?.message ?? e}`)
  }
  uploads.set(uid, { device, name: basename(path), size, path, fd, received: 0, seq: 0, done: false, at: Date.now() })
  send({ t: 'upload', uid, state: 'ready' })
}

export function uploadChunk(device: string, f: { uid: unknown; seq: unknown; data: unknown }, send: Send): void {
  const uid = typeof f.uid === 'string' ? f.uid : ''
  const u = uploads.get(uid)
  if (!u || u.device !== device || u.done || u.fd === null) return
  const bytes = typeof f.data === 'string' ? b64uDecode(f.data) : null
  if (f.seq !== u.seq || !bytes || u.received + bytes.length > u.size) {
    dropUpload(uid, true)
    return send({ t: 'upload', uid, state: 'failed', message: '上传的数据不完整，请重试。' })
  }
  try {
    writeSync(u.fd, bytes)
  } catch (e) {
    dropUpload(uid, true)
    return send({ t: 'upload', uid, state: 'failed', message: `写入失败：${(e as Error)?.message ?? e}` })
  }
  u.seq++
  u.received += bytes.length
  u.at = Date.now()
}

export function uploadEnd(device: string, uidRaw: unknown, send: Send): void {
  const uid = typeof uidRaw === 'string' ? uidRaw : ''
  const u = uploads.get(uid)
  if (!u || u.device !== device) return
  closeUpload(u)
  if (u.received !== u.size) {
    dropUpload(uid, true)
    return send({ t: 'upload', uid, state: 'failed', message: '上传的数据不完整，请重试。' })
  }
  stageUploadedFile(u.path, u.size)
  u.done = true
  u.at = Date.now()
  send({ t: 'upload', uid, state: 'done' })
}

export function uploadCancel(device: string, uidRaw: unknown): void {
  const uid = typeof uidRaw === 'string' ? uidRaw : ''
  const u = uploads.get(uid)
  if (u && u.device === device) dropUpload(uid, true)
}

/** 发消息时：上传 id → 文件路径（只认这台设备自己传完的）。有任何一个对不上返回 null。 */
export function takeUploads(device: string, ids: unknown): string[] | null {
  if (ids === undefined) return []
  if (!Array.isArray(ids) || ids.length > MAX_PENDING_UPLOADS) return null
  const paths: string[] = []
  for (const id of ids) {
    const u = typeof id === 'string' ? uploads.get(id) : undefined
    if (!u || u.device !== device || !u.done) return null
    paths.push(u.path)
  }
  for (const id of ids) uploads.delete(id as string)
  return paths
}

// ───────── 下载 / 预览 ─────────

const MARKDOWN = new Set(['.md', '.markdown'])
const TEXT = new Set([
  '.txt', '.log', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.xml', '.html', '.htm', '.css',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.php',
  '.rb', '.swift', '.sh', '.ps1', '.bat', '.sql', '.vue', '.svelte', '.lua', '.dart', '.r', '.env'
])
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
/** 文字预览最多给这么多字符（更长的标「已截断」，完整内容在电脑上看）。 */
const MAX_TEXT_CHARS = 400_000

async function sendBytes(rid: string, buf: Buffer, head: Omit<Extract<WebServerFrame, { t: 'file' }>, 't' | 'rid' | 'ok' | 'chunks'>, send: Send): Promise<void> {
  const chunks = Math.max(1, Math.ceil(buf.length / FILE_CHUNK_BYTES))
  send({ t: 'file', rid, ok: true, ...head, chunks })
  for (let i = 0; i < chunks; i++) {
    send({ t: 'file_chunk', rid, seq: i, data: b64uEncode(buf.subarray(i * FILE_CHUNK_BYTES, (i + 1) * FILE_CHUNK_BYTES)) })
    // 让出事件循环：大文件分块之间不霸占主进程。
    if (i % 4 === 3) await new Promise((r) => setImmediate(r))
  }
}

/** 交付文件：按扩展名给文字或字节。 */
export async function sendDelivered(f: { rid: unknown; sid: unknown; tool: unknown; index: unknown }, send: Send): Promise<void> {
  const rid = typeof f.rid === 'string' ? f.rid : ''
  if (!rid) return
  const fail = (message: string): void => send({ t: 'file', rid, ok: false, message })
  const path = deliveredPath(f.sid, f.tool, f.index)
  if (!path) return fail('找不到这个文件，可能对话已被修改。')
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return fail('这个文件已经不在了。')
    size = st.size
  } catch {
    return fail('这个文件已经不在了，可能被移动或删除。')
  }
  const name = basename(path)
  const ext = extname(path).toLowerCase()
  try {
    if (MARKDOWN.has(ext) || TEXT.has(ext)) {
      const buf = await readHead(path, MAX_TEXT_CHARS * 3)
      const text = buf.toString('utf8')
      const kind: WebFileKind = MARKDOWN.has(ext) ? 'markdown' : 'text'
      const truncated = size > buf.length || text.length > MAX_TEXT_CHARS
      return send({ t: 'file', rid, ok: true, name, size, kind, text: text.slice(0, MAX_TEXT_CHARS), truncated })
    }
    if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
      if (size > MAX_DOWNLOAD_BYTES) return fail('文件太大，请在电脑上打开。')
      const text = officeText(await fs.readFile(path), ext)
      if (text !== null)
        return send({
          t: 'file',
          rid,
          ok: true,
          name,
          size,
          mime: MIME[ext],
          kind: 'text',
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS
        })
    }
    if (size > MAX_DOWNLOAD_BYTES) return fail(`文件超过 ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB，请在电脑上打开。`)
    const buf = await fs.readFile(path)
    const image = IMAGE_MIME[ext]
    await sendBytes(rid, buf, { name, size, mime: image ?? MIME[ext] ?? 'application/octet-stream', kind: image ? 'image' : 'binary' }, send)
  } catch (e) {
    fail(`读取失败：${(e as Error)?.message ?? e}`)
  }
}

async function readHead(path: string, max: number): Promise<Buffer> {
  const h = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const { bytesRead } = await h.read(buf, 0, max, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await h.close()
  }
}

/** 对话里图片附件的缩略图 / 原图。 */
export function sendAttachmentImage(f: { rid: unknown; sid: unknown; ref: unknown }, send: Send): void {
  if (typeof f.rid !== 'string') return
  // 只给缩略图（长边不超过 960）：原图可能好几 MB，超过单帧上限。
  send({ t: 'image', rid: f.rid, uri: attachmentImage(f.sid, f.ref, false) })
}
