import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { promises as fs } from 'fs'
import { basename, join, resolve } from 'path'
import { assertInside, trustRoot } from './fs-guard'

/**
 * 工作区文件服务（主进程）。
 * 安全基线：所有读写都必须落在「已打开的项目根目录」之内，防止路径穿越。
 * 受信根集合与校验统一在 ./fs-guard，供 fs IPC 与 Agent 文件工具共享。
 * 详见 docs/architecture/security.md。
 */

export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

export interface OpenFolderResult {
  path: string
  name: string
}

export interface ReadFileResult {
  path: string
  content: string
  /** 超过大小上限，未加载内容 */
  tooLarge?: boolean
  /** 疑似二进制，未加载内容 */
  binary?: boolean
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2MB，超过则不加载正文

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function registerWorkspaceIpc(getWindow: () => BrowserWindow | null): void {
  // 打开文件夹对话框 → 选中目录登记为受信根
  ipcMain.handle('fs:open-folder', async (): Promise<OpenFolderResult | null> => {
    const win = getWindow()
    const opts: OpenDialogOptions = { properties: ['openDirectory'], title: '打开项目文件夹' }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const dir = resolve(res.filePaths[0])
    trustRoot(dir)
    return { path: dir, name: basename(dir) || dir }
  })

  // 按已知路径打开（无对话框）：供「记住最近项目」自动重开 / 点击历史项使用。
  // 与 fs:open-folder 同等信任语义——只信任真实存在的目录，登记受信根；
  // 路径失效（被删/移动/非目录）返回 null，渲染层据此从历史列表剔除。
  ipcMain.handle('fs:open-path', async (_e, dirPath: string): Promise<OpenFolderResult | null> => {
    if (typeof dirPath !== 'string' || dirPath.trim().length === 0) return null
    const dir = resolve(dirPath)
    try {
      const st = await fs.stat(dir)
      if (!st.isDirectory()) return null
    } catch {
      return null
    }
    trustRoot(dir)
    return { path: dir, name: basename(dir) || dir }
  })

  // 读取目录（单层，懒加载）：目录在前，随后按名排序
  ipcMain.handle('fs:read-dir', async (_e, dirPath: string): Promise<DirEntry[]> => {
    assertInside(dirPath)
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: DirEntry[] = dirents
      .filter((d) => d.isDirectory() || d.isFile())
      .map((d) => ({
        name: d.name,
        path: join(dirPath, d.name),
        type: d.isDirectory() ? 'dir' : 'file'
      }))
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  })

  // 读取文件正文（防御超大 / 二进制）
  ipcMain.handle('fs:read-file', async (_e, filePath: string): Promise<ReadFileResult> => {
    assertInside(filePath)
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_BYTES) return { path: filePath, content: '', tooLarge: true }
    const buf = await fs.readFile(filePath)
    if (looksBinary(buf)) return { path: filePath, content: '', binary: true }
    return { path: filePath, content: buf.toString('utf8') }
  })

  // 写入文件正文
  ipcMain.handle('fs:write-file', async (_e, filePath: string, content: string): Promise<{ ok: true }> => {
    assertInside(filePath)
    await fs.writeFile(filePath, content, 'utf8')
    return { ok: true }
  })
}
