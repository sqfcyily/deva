import { app, ipcMain, nativeImage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import type { DeliverableInfo } from '../../shared/deliverables'
import { getSession } from './chat-store'
import { roleHomeOf } from './role-home'

/**
 * 交付卡（present_files）的操作：查看文件信息与缩略图、用默认应用打开、在文件夹中显示。
 *
 * 渲染层只给「对话 id + 调用 id + 序号」，路径一律由主进程按该对话里那次 present_files 调用取
 *（会话边车 delivered）。这几个 IPC 因此只能作用于模型明确交付给用户的文件，不会变成任意路径的读取 / 打开口子。
 */

/**
 * 允许「用默认应用打开」的扩展名：成品类文件。可执行 / 脚本类（exe、bat、ps1、js、py、lnk …）
 * 用默认应用打开就等于运行，一律不放行，只能在文件夹中显示。
 */
const OPENABLE = new Set([
  // 网页 / 文本 / 数据
  '.html', '.htm', '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml',
  // 文档
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp', '.rtf', '.epub',
  // 图片
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif', '.heic',
  // 视频
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v',
  // 音频
  '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus',
  // 压缩包（系统打开即浏览内容）
  '.zip'
])

const THUMB_SIZE = 128

/**
 * 该对话里那次 present_files 调用交付的文件：取会话边车 delivered（已解析、去重）。
 * 边车缺失时回落历史里该调用参数中的绝对路径（早期版本把解析后的路径直接写进了参数，没有边车）。
 */
function deliveredPaths(sessionId: unknown, toolUseId: unknown): string[] {
  if (typeof sessionId !== 'string' || typeof toolUseId !== 'string') return []
  const s = getSession(sessionId)
  if (!s) return []
  const recorded = s.delivered?.[toolUseId]
  if (recorded) return recorded
  for (const m of s.messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const p of m.content) {
      if (p.type !== 'tool_use' || p.id !== toolUseId) continue
      if (p.name !== 'present_files') return []
      const paths = (p.input as { paths?: unknown } | null)?.paths
      return Array.isArray(paths)
        ? paths.filter((x): x is string => typeof x === 'string' && isAbsolute(x))
        : []
    }
  }
  return []
}

export function deliveredPath(sessionId: unknown, toolUseId: unknown, index: unknown): string | null {
  if (typeof index !== 'number' || !Number.isInteger(index)) return null
  return deliveredPaths(sessionId, toolUseId)[index] ?? null
}

async function isFile(p: string): Promise<boolean> {
  const st = await fs.stat(p).catch(() => null)
  return Boolean(st?.isFile())
}

export function registerDeliverablesIpc(): void {
  ipcMain.handle(
    'deliverables:inspect',
    async (_e, sessionId: unknown, toolUseId: unknown): Promise<DeliverableInfo[]> =>
      Promise.all(
        deliveredPaths(sessionId, toolUseId).map(async (p) => {
          const st = await fs.stat(p).catch(() => null)
          const home = roleHomeOf(dirname(p))
          return {
            path: p,
            name: basename(p),
            dir: dirname(p),
            size: st?.isFile() ? st.size : null,
            openable: OPENABLE.has(extname(p).toLowerCase()),
            ...(home ? { home } : {})
          }
        })
      )
  )

  // 缩略图走系统缩略图服务（Windows / macOS：docx、pdf、视频等都能出图），取不到就回落文件类型图标。
  ipcMain.handle(
    'deliverables:thumbnail',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<string | null> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !(await isFile(p))) return null
      try {
        const img = await nativeImage.createThumbnailFromPath(p, { width: THUMB_SIZE, height: THUMB_SIZE })
        if (!img.isEmpty()) return img.toDataURL()
      } catch {
        /* Linux 不支持 / 该类型没有缩略图 → 回落文件图标 */
      }
      try {
        const icon = await app.getFileIcon(p, { size: 'large' })
        return icon.isEmpty() ? null : icon.toDataURL()
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    'deliverables:open',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<{ ok: boolean }> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !OPENABLE.has(extname(p).toLowerCase()) || !(await isFile(p))) return { ok: false }
      // openPath 成功返回空串，失败（如没有关联的应用）返回错误描述
      return { ok: (await shell.openPath(p)) === '' }
    }
  )

  ipcMain.handle(
    'deliverables:reveal',
    async (_e, sessionId: unknown, toolUseId: unknown, index: unknown): Promise<{ ok: boolean }> => {
      const p = deliveredPath(sessionId, toolUseId, index)
      if (!p || !(await isFile(p))) return { ok: false }
      shell.showItemInFolder(p)
      return { ok: true }
    }
  )
}
