/**
 * 胶囊预览卡的实时画面：对网页开 CDP Page.startScreencast，网页有变化才推一帧（缩小的 JPEG），转发给主窗口（browser:live-frame）。
 * 同一时间只给一个标签推（主窗口同一时间只有一张预览卡）；每帧回执后 Chromium 才推下一帧，这里把回执间隔压到不少于
 * MIN_INTERVAL_MS，动画、视频页面也不会刷爆 IPC。预览卡收起、主窗口最小化时渲染层会调 stopLive。
 *
 * 实测（Win11 / Electron 33）：收起到屏幕外的浏览器窗口照常推帧；静止页面 3 秒只推 1 帧；480 宽每帧一两 KB 到几十 KB。
 */
import type { BrowserWindow } from 'electron'
import { allPages, cdp, type BrowserPage } from './pages'
import type { BrowserLiveFrame } from '../../../shared/browser'

/** 两帧之间至少隔多久（毫秒）：看操作过程 10 帧每秒足够。 */
const MIN_INTERVAL_MS = 100
/** 推送的画面尺寸上限（预览卡约 360 CSS 像素宽，按 2 倍屏留余量）。 */
const MAX_SIZE = { maxWidth: 640, maxHeight: 400 }

interface Watching {
  page: BrowserPage
  onMessage: (e: unknown, method: string, params: Record<string, unknown>) => void
  onDestroyed: () => void
  ackTimers: Set<NodeJS.Timeout>
}
let watching: Watching | null = null

/**
 * 开始推某个标签的画面给 target（主窗口）；已在推别的标签则先停掉。返回是否开成功（标签不存在、CDP 失败为 false）。
 */
export async function startLive(tabId: string, target: () => BrowserWindow | null): Promise<boolean> {
  if (watching?.page.id === tabId) return true
  stopLive()
  const page = allPages().find((p) => p.id === tabId)
  if (!page || page.wc.isDestroyed()) return false
  /** 下一个回执最早什么时候发。Chromium 允许同时有两帧没回执，所以回执要排队、彼此隔开，不能都按上一帧算。 */
  let nextAck = 0
  const w: Watching = {
    page,
    ackTimers: new Set(),
    onMessage: (_e, method, params) => {
      if (method !== 'Page.screencastFrame' || watching !== w) return
      const t = target()
      if (t && !t.isDestroyed() && !t.webContents.isDestroyed()) {
        const frame: BrowserLiveFrame = { tab: tabId, data: String(params.data ?? '') }
        t.webContents.send('browser:live-frame', frame)
      }
      const at = Math.max(Date.now(), nextAck)
      nextAck = at + MIN_INTERVAL_MS
      const timer = setTimeout(() => {
        w.ackTimers.delete(timer)
        if (watching === w && !page.wc.isDestroyed())
          void page.wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      }, at - Date.now())
      w.ackTimers.add(timer)
    },
    onDestroyed: () => {
      if (watching === w) clear()
    }
  }
  watching = w
  page.wc.debugger.on('message', w.onMessage)
  page.wc.once('destroyed', w.onDestroyed)
  try {
    await cdp(page, 'Page.startScreencast', { format: 'jpeg', quality: 70, ...MAX_SIZE })
    return watching === w
  } catch {
    if (watching === w) clear()
    return false
  }
}

/** 停止推送（预览卡收起、换标签、主窗口最小化）。 */
export function stopLive(): void {
  const w = watching
  if (!w) return
  clear()
  if (!w.page.wc.isDestroyed()) void w.page.wc.debugger.sendCommand('Page.stopScreencast').catch(() => {})
}

function clear(): void {
  const w = watching
  if (!w) return
  watching = null
  for (const timer of w.ackTimers) clearTimeout(timer)
  w.ackTimers.clear()
  if (!w.page.wc.isDestroyed()) {
    w.page.wc.debugger.off('message', w.onMessage)
    w.page.wc.off('destroyed', w.onDestroyed)
  }
}

/** 正在推哪个标签（测试用）。 */
export function liveTab(): string | null {
  return watching?.page.id ?? null
}
