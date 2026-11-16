import { ipcMain, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatRemoteChange } from '../../shared/chat-protocol'
import { writeFileAtomic } from './atomic-write'
import { onRemoteChange, publishReadChanged, publishRemoteChange } from './chat-bus'
import { getSession } from './chat-store'
import { getDevaHome } from './config'

/**
 * 多端已读：每个对话最后被看过的时间（电脑或手机，任一端看过就算）。两端的未读红点都以它为准——
 * 在电脑上看过的，手机上不再显示红点；在手机上看过的，电脑上的红点也消掉。
 * 存在 DEVA_HOME/read-state.json（只存时间戳，按对话 id），写盘去抖；对话删除时一并删掉。
 */

type Source = 'desktop' | 'remote'

const SAVE_DELAY_MS = 1500

let cache: Map<string, number> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function file(): string {
  return join(getDevaHome(), 'read-state.json')
}

function state(): Map<string, number> {
  if (cache) return cache
  cache = new Map()
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'number' && Number.isFinite(v)) cache.set(k, v)
    }
  } catch {
    /* 文件坏了：当作都没看过，下次写盘覆盖 */
  }
  return cache
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileAtomic(file(), JSON.stringify(Object.fromEntries(state())))
    } catch (e) {
      console.warn('[read-sync] 保存已读状态失败：', (e as Error)?.message ?? e)
    }
  }, SAVE_DELAY_MS)
}

/** 某对话最后被看过的时间（从没看过 / 不知道返回 undefined）。 */
export function readAtOf(sessionId: string): number | undefined {
  return state().get(sessionId)
}

/**
 * 记一次「看过了」。上次看过之后对话没有新内容就什么都不做（不写盘、不通知），
 * 所以电脑窗口反复切换焦点也不会一直往手机推。
 */
export function markRead(sessionId: string, source: Source): void {
  const s = getSession(sessionId)
  if (!s) return
  const prev = state().get(sessionId)
  if (prev !== undefined && prev >= s.updatedAt) return
  const at = Date.now()
  state().set(sessionId, at)
  scheduleSave()
  publishReadChanged({ sessionId, at, source })
  if (source === 'remote') publishRemoteChange({ sessionId, kind: 'read' })
}

/** 对话删除后清掉它的记录。 */
export function forgetRead(sessionId: string): void {
  if (state().delete(sessionId)) scheduleSave()
}

/** 渲染层：报告「正在看这个对话」；收别处的改动（手机上看过 / 删除 / 归档 / 改模型）。 */
export function registerReadSyncIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('chat:mark-read', (_e, sessionId: unknown): { ok: true } => {
    if (typeof sessionId === 'string' && sessionId) markRead(sessionId, 'desktop')
    return { ok: true }
  })
  onRemoteChange((c: ChatRemoteChange) => {
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send('chat:remote-change', c)
  })
}
