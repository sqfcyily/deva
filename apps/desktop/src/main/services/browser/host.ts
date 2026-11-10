/**
 * 「Deva 浏览器」窗口：前台对话的网页都放在这一个窗口里（所有对话共用，标签上带角色头像）。
 *
 * 浏览器只给 Deva 用：不显示网址、不能输入网址（用户要自己看可以「在系统浏览器中打开」）。
 *
 * 窗口自身的 webContents 是浏览器的外框界面（标签条、状态条，渲染层 browser.html）；每个网页是一个
 * WebContentsView，叠放在外框下方，当前标签放在最上面。被盖住的视图照常渲染，所以别的对话可以同时在后台标签上操作。
 *
 * 收起（用户点窗口的关闭按钮）不是隐藏：隐藏的窗口不渲染，截图、点击、输入都会失效。收起时把窗口挪到所有
 * 屏幕之外继续显示、不进任务栏；配合启动时关掉 Chromium 的窗口遮挡检测（index.ts），屏幕外的窗口也照常渲染。
 *
 * 状态（标签、当前标签、Deva 正在做什么、等用户操作）经 browser:state 推给主窗口（输入框上方的胶囊）和外框界面。
 * 只推用户该看到的网页（见 visibleTabs）：Deva 在后台用的网页不出现在界面上。
 */
import {
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
  type MenuItemConstructorOptions,
  type Rectangle
} from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { getAppIcon } from '../tray-icon'
import { isEn } from '../../locale'
import { startLive, stopLive } from './live'
import {
  allPages,
  basePage,
  browserSession,
  closePage,
  closeSessionPages,
  currentBySession,
  markHostWindow,
  notifyPagesChanged,
  setInUseCheck,
  setPagesChangedListener,
  setWindowPageFactory,
  type BrowserPage
} from './pages'

import {
  BROWSER_CHROME,
  type BrowserHandoffReason,
  type BrowserUiState,
  type BrowserUiTab
} from '../../../shared/browser'

const TAB_BAR = BROWSER_CHROME.tabBar
const STATUS_BAR = BROWSER_CHROME.statusBar
const FRAME = BROWSER_CHROME.frame
const DEFAULT_SIZE = { width: 1180, height: 820 }
/**
 * 第一次展开的大小：宽高都取主窗口的同一比例（四周露出的边距成比例，看着是主窗口里居中的一个小一号的窗口）。
 * 宽度不低于 1024（再窄网站会换成手机 / 平板布局），高度不低于 600。主窗口不在时按它的默认尺寸算。
 */
const FIRST_RATIO = 0.85
const FIRST_MIN = { width: 1024, height: 600 }
const MAIN_DEFAULT = { width: 1280, height: 820 }
/** 收起且一个网页都没有时，过多久销毁窗口（外框界面本身也占一个渲染进程）；下次要用再建。 */
const EMPTY_WINDOW_DESTROY_MS = 20_000

export const HANDOFF_REASONS = ['login', 'captcha', 'upload', 'confirm', 'other'] as const
export type HandoffReason = BrowserHandoffReason
export type HandoffResponse = 'done' | 'skipped' | 'closed' | 'aborted' | 'timeout'
export type { BrowserUiState }

let win: BrowserWindow | null = null
let docked = true
let pinned = false
let quitting = false
let active: string | null = null
let savedBounds: Rectangle | null = null
const views = new Map<string, WebContentsView>()
const operating = new Map<string, { tab: string; action: string; label?: string; timer?: NodeJS.Timeout }>()
const handoffs = new Map<
  string,
  { tab: string; reason: HandoffReason; message: string; who?: string; finish: (r: HandoffResponse) => void }
>()
/** 主窗口胶囊上「固定」着的预览卡在看哪个标签（渲染层上报）。 */
let pinnedPreview: string | null = null

/**
 * 用户正在看 / 正在操作的网页：等用户操作中、浏览器窗口展开着且正显示、胶囊预览卡固定着看。
 * 闲置回收跳过它们，Deva 用 close_tab 也关不掉（会被告知用户正在看）。
 */
export function isPageInUse(p: BrowserPage): boolean {
  return (
    [...handoffs.values()].some((h) => h.tab === p.id) ||
    (p.kind === 'window' && p.id === active && !docked && !!win && !win.isDestroyed()) ||
    p.id === pinnedPreview
  )
}

let mainWindowGetter: () => BrowserWindow | null = () => null
let sessionAborter: (sessionId: string) => boolean = () => false

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  mainWindowGetter = fn
}
/** chat.ts 注入：停止某对话正在进行的回合（窗口里的「停止」）。 */
export function setSessionAborter(fn: (sessionId: string) => boolean): void {
  sessionAborter = fn
}

/* ───────── 状态推送 ───────── */

/**
 * 界面上显示哪些网页。浏览器默认在后台给 Deva 用，不打扰用户；只有这几种显示（胶囊、对话列表的地球标记、窗口标签条）：
 * - 用户要求看过的（show 弹出过，page.shown），一直显示到关掉；
 * - 正等用户操作的对话的全部网页（登录页弹出的新标签也要能切过去），等待结束后回到后台；
 * - 窗口展开着、正显示在用户眼前的那个；
 * - 胶囊上固定着看的那个。
 * Deva 在后台打开、操作的其余网页都不显示，它做了什么看执行步骤。
 */
function visibleTabs(): Set<string> {
  const open = !!win && !win.isDestroyed() && !docked
  const out = new Set<string>()
  for (const p of allPages()) {
    if (p.kind !== 'window') continue
    if (p.shown || handoffs.has(p.sessionId) || (open && p.id === active) || p.id === pinnedPreview) out.add(p.id)
  }
  return out
}

export function uiState(): BrowserUiState {
  const visible = visibleTabs()
  const tabs: BrowserUiTab[] = []
  for (const p of allPages()) {
    if (p.kind !== 'window' || p.wc.isDestroyed() || !visible.has(p.id)) continue
    const h = p.wc.navigationHistory
    const url = p.wc.getURL()
    tabs.push({
      id: p.id,
      sessionId: p.sessionId,
      personaId: p.personaId,
      title: p.wc.getTitle() && url !== 'about:blank' ? p.wc.getTitle() : '',
      url: url === 'about:blank' ? '' : url,
      loading: p.wc.isLoading(),
      canGoBack: h.canGoBack(),
      canGoForward: h.canGoForward()
    })
  }
  return {
    open: !!win && !win.isDestroyed() && !docked,
    pinned,
    active,
    tabs,
    // 当前标签、正在操作也只报显示着的网页：Deva 在后台网页上的操作不出现在胶囊上
    current: Object.fromEntries(Object.entries(currentBySession()).filter(([, tab]) => visible.has(tab))),
    operating: Object.fromEntries(
      [...operating]
        .filter(([, o]) => visible.has(o.tab))
        .map(([sid, o]) => [sid, { tab: o.tab, action: o.action, label: o.label }])
    ),
    handoff: Object.fromEntries(
      [...handoffs].map(([sid, h]) => [
        sid,
        { tab: h.tab, reason: h.reason, message: h.message, ...(h.who ? { who: h.who } : {}) }
      ])
    )
  }
}

let pushTimer: NodeJS.Timeout | null = null
/** 合并 60ms 内的多次变化再推送（加载过程中标题、网址会连续变）。 */
function push(): void {
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    const state = uiState()
    for (const w of [mainWindowGetter(), win])
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('browser:state', state)
  }, 60)
}

/* ───────── 窗口 ───────── */

/** 所有屏幕之外的位置（收起时放这里）。 */
function offscreenPoint(): { x: number; y: number } {
  const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width))
  return { x: right + 200, y: 0 }
}

function overlay(): Electron.TitleBarOverlay | undefined {
  const dark = nativeTheme.shouldUseDarkColors
  if (process.platform === 'win32')
    return { color: '#00000000', symbolColor: dark ? '#e4e4e7' : '#3a3a3d', height: TAB_BAR }
  if (process.platform === 'linux') return { color: dark ? '#252528' : '#f7f7f8', height: TAB_BAR }
  return undefined
}

let destroyTimer: NodeJS.Timeout | null = null

/** 窗口收起、且没有网页了：稍等一会儿（Deva 可能马上又开新网页）再销毁窗口。 */
function destroyWhenEmpty(): void {
  if (destroyTimer || quitting || !win || win.isDestroyed() || !docked || views.size) return
  destroyTimer = setTimeout(() => {
    destroyTimer = null
    if (quitting || !win || win.isDestroyed() || !docked || views.size) return
    // destroy() 不触发 close 事件（不会被拦成「收起」），closed 里会把 win 置空
    win.destroy()
    win = null
  }, EMPTY_WINDOW_DESTROY_MS)
}

function ensureWindow(): BrowserWindow {
  if (destroyTimer) {
    clearTimeout(destroyTimer)
    destroyTimer = null
  }
  if (win && !win.isDestroyed()) return win
  const off = offscreenPoint()
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    ...DEFAULT_SIZE,
    ...off,
    minWidth: 480,
    minHeight: 360,
    show: false,
    skipTaskbar: true,
    title: isEn() ? 'Deva Browser' : 'Deva 浏览器',
    icon: getAppIcon(),
    backgroundColor: dark ? '#252528' : '#f7f7f8',
    titleBarStyle: 'hidden',
    titleBarOverlay: overlay(),
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  markHostWindow(win)
  docked = true
  const w = win
  w.on('close', (e) => {
    if (quitting) return
    // 关闭 = 收起到胶囊：网页继续在后台运行
    e.preventDefault()
    dock()
  })
  w.on('closed', () => {
    if (win === w) win = null
  })
  w.on('resize', layout)
  w.on('focus', push)
  const onTheme = (): void => {
    if (!w.isDestroyed()) {
      const o = overlay()
      if (o) w.setTitleBarOverlay(o)
    }
  }
  nativeTheme.on('updated', onTheme)
  w.on('closed', () => nativeTheme.off('updated', onTheme))
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    void w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/browser.html`).catch(() => {})
  else void w.loadFile(join(__dirname, '../renderer/browser.html')).catch(() => {})
  // 屏幕外也要「显示着」：隐藏的窗口不渲染网页
  w.showInactive()
  return w
}

/**
 * 外框占的高度（顶部标签条，有状态条时再加一条）。等用户操作的提示条在该对话的任一标签上都显示（如登录页点「扫码登录」
 * 开了新标签，用户在新标签里也能点「完成，继续」）；「正在操作」只在 Deva 正在操作的那个标签上显示。外框须同一规则。
 */
function chromeHeight(): number {
  const tab = active
  const sid = tab ? allPages().find((p) => p.id === tab)?.sessionId : undefined
  const strip = !!sid && (handoffs.has(sid) || operating.get(sid)?.tab === tab)
  return TAB_BAR + (strip ? STATUS_BAR : 0)
}

/** 所有网页视图叠放在外框下方，当前标签在最上面。 */
function layout(): void {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getContentSize()
  const top = chromeHeight()
  const bounds = { x: FRAME, y: top, width: Math.max(0, w - FRAME * 2), height: Math.max(0, h - top - FRAME) }
  for (const v of views.values()) v.setBounds(bounds)
  if (active && views.has(active)) win.contentView.addChildView(views.get(active)!)
}

/** 显示器增减 / 分辨率变化后，系统可能把屏幕外的窗口挪回可见区域：收起状态下重新挪出去。 */
function repositionIfDocked(): void {
  if (win && !win.isDestroyed() && docked) {
    const off = offscreenPoint()
    win.setPosition(off.x, off.y)
  }
}

/**
 * 本次运行第一次展开时的位置大小（之后记住用户拖动后的）：主窗口等比缩小（FIRST_RATIO），在主窗口上居中，
 * 四周露出一圈 Deva，不把它整个盖住。主窗口最小化 / 不在时，按主窗口默认尺寸算、在屏幕上居中。
 */
function firstBounds(main: BrowserWindow | null, w: BrowserWindow): Rectangle {
  const mainOk = !!main && !main.isDestroyed() && !main.isMinimized()
  const ref = mainOk ? main.getBounds() : null
  const area = screen.getDisplayMatching(ref ?? w.getBounds()).workArea
  const base = ref ?? MAIN_DEFAULT
  const size = (k: 'width' | 'height'): number =>
    Math.min(area[k] - 40, Math.max(FIRST_MIN[k], Math.round(base[k] * FIRST_RATIO)))
  const width = size('width')
  const height = size('height')
  const box = ref ?? area
  const x = box.x + Math.round((box.width - width) / 2)
  const y = box.y + Math.round((box.height - height) / 2)
  // 夹回屏幕工作区之内
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height),
    width,
    height
  }
}

/** 展开窗口并切到某个标签。focus=false 时不抢焦点（如 Deva 自己弹出时）。 */
export function showWindow(tab?: string | null, focus = true): void {
  const w = ensureWindow()
  if (tab && views.has(tab)) active = tab
  if (docked) {
    const main = mainWindowGetter()
    const b = savedBounds ?? firstBounds(main, w)
    w.setBounds(b)
    w.setSkipTaskbar(false)
    docked = false
    if (pinned) w.setAlwaysOnTop(true, 'floating')
  }
  if (focus) {
    w.show()
    w.focus()
  } else w.showInactive()
  layout()
  push()
}

/** 收起：挪到屏幕外继续运行。 */
export function dock(): void {
  if (!win || win.isDestroyed() || docked) return
  const focused = win.isFocused()
  if (!win.isMinimized() && !win.isMaximized() && !win.isFullScreen()) savedBounds = win.getBounds()
  if (win.isMaximized()) win.unmaximize()
  if (win.isMinimized()) win.restore()
  win.setAlwaysOnTop(false)
  win.setSkipTaskbar(true)
  const off = offscreenPoint()
  win.setPosition(off.x, off.y)
  // 只是挪到屏幕外、窗口仍是激活的：把焦点交还给下一个窗口（Windows 上 blur 会激活下一个可见窗口），
  // 否则键盘输入还落在看不见的网页上
  if (focused) win.blur()
  docked = true
  // 等用户操作时收起窗口不算结束：用户可能要临时去别处找账号密码。等待只由「完成，继续」/「跳过」/ 停止 / 超时 /
  // 关掉那个网页结束；收起后胶囊上仍是「去处理」，点了回到窗口
  push()
  destroyWhenEmpty()
}

export function setPinned(on: boolean): void {
  pinned = on
  if (win && !win.isDestroyed() && !docked) win.setAlwaysOnTop(on, 'floating')
  push()
}

export function activateTab(tab: string): void {
  if (!views.has(tab)) return
  active = tab
  layout()
  push()
}

/** 应用退出：真正销毁窗口（不再拦关闭）。 */
export function destroyWindow(): void {
  quitting = true
  for (const h of handoffs.values()) h.finish('aborted')
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

/* ───────── 网页视图 ───────── */

function createWindowPage(id: string, sessionId: string, personaId?: string): BrowserPage {
  const w = ensureWindow()
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  views.set(id, view)
  w.contentView.addChildView(view)
  // 新标签切到前面（同微信：点链接开新标签即显示新标签）。窗口打开着、而用户正看着别的对话的网页时不抢
  const shownSession = active ? allPages().find((p) => p.id === active)?.sessionId : undefined
  if (!active || docked || shownSession === sessionId) active = id
  layout()
  const wc = view.webContents
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const)
    wc.on(ev as 'did-stop-loading', push)
  return basePage(id, sessionId, personaId, 'window', wc, () => {
    views.delete(id)
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view)
    if (!wc.isDestroyed()) wc.close()
    if (active === id) {
      const rest = [...views.keys()]
      active = rest.length ? rest[rest.length - 1] : null
    }
    // 关掉的是某个对话正在等用户操作的标签
    for (const h of handoffs.values()) if (h.tab === id) h.finish('closed')
    layout()
    push()
    // 最后一个标签关掉：窗口跟着关（同微信）。收起后没有网页，稍后销毁
    if (!views.size && !docked && !quitting) dock()
    else destroyWhenEmpty()
  })
}

/* ───────── Deva 正在操作 / 等用户操作 ───────── */

/** 动作开始：外框出状态条与边框、胶囊显示「正在…」。返回 true 表示状态条刚出现（网页高度变了，动作前稍等）。 */
export function beginOperating(page: BrowserPage, action: string, label?: string): boolean {
  if (page.kind !== 'window') return false
  const prev = operating.get(page.sessionId)
  if (prev?.timer) clearTimeout(prev.timer)
  const stripBefore = chromeHeight()
  operating.set(page.sessionId, { tab: page.id, action, label })
  const changedLayout = chromeHeight() !== stripBefore
  if (changedLayout) layout()
  push()
  return changedLayout
}

/** 补上动作的对象（如定位到元素后才知道的元素名）。 */
export function updateOperating(page: BrowserPage, label: string): void {
  const o = operating.get(page.sessionId)
  if (o && o.tab === page.id) {
    o.label = label
    push()
  }
}

/** 动作结束：状态条留一会儿（连续操作时不闪），空闲几秒后收起。 */
export function endOperating(page: BrowserPage, idleMs = 6_000): void {
  const o = operating.get(page.sessionId)
  if (!o) return
  if (o.timer) clearTimeout(o.timer)
  o.timer = setTimeout(() => {
    if (operating.get(page.sessionId) === o) {
      operating.delete(page.sessionId)
      layout()
      push()
    }
  }, idleMs)
}

/** 本轮结束（或被停止）：立刻收起该对话的「正在操作」。 */
export function clearOperating(sessionId: string): void {
  const o = operating.get(sessionId)
  if (!o) return
  if (o.timer) clearTimeout(o.timer)
  operating.delete(sessionId)
  layout()
  push()
}

/**
 * 请用户在网页上亲自操作：展开窗口、切到该标签、外框出提示条（「完成，继续」「跳过」），等用户处理。
 * 用户操作的就是 Deva 正在用的同一个页面，完成后不需要重新加载。
 * opts.show = false：不弹窗口（成员会话：由主对话末尾的胶囊提醒，用户点「去处理」再打开）；
 * opts.who：提示条上署谁的名字（成员名；缺省用标签所属角色的名字）。
 */
export function requestHandoff(
  page: BrowserPage,
  reason: HandoffReason,
  message: string,
  signal?: AbortSignal,
  opts: { show?: boolean; who?: string; timeoutMs?: number } = {}
): Promise<HandoffResponse> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000
  const existing = handoffs.get(page.sessionId)
  if (existing) existing.finish('aborted')
  clearOperating(page.sessionId)
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: HandoffResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (handoffs.get(page.sessionId)?.finish === finish) handoffs.delete(page.sessionId)
      layout()
      push()
      resolve(r)
    }
    const onAbort = (): void => finish('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    handoffs.set(page.sessionId, { tab: page.id, reason, message, ...(opts.who ? { who: opts.who } : {}), finish })
    if (opts.show === false) {
      // 不弹窗口：只更新外框（窗口正显示该对话的标签时出提示条）并推送状态，主窗口据此显示通知行
      layout()
      push()
    } else showWindow(page.id, true)
  })
}

/** 该对话正等用户在网页上操作（member_status 报成员状态用）。 */
export function hasHandoff(sessionId: string): boolean {
  return handoffs.has(sessionId)
}

/** 外框 / 胶囊上的按钮：完成或跳过。 */
export function respondHandoff(sessionId: string, answer: 'done' | 'skip'): void {
  handoffs.get(sessionId)?.finish(answer === 'done' ? 'done' : 'skipped')
}

export function closeSessionHandoff(sessionId: string): void {
  handoffs.get(sessionId)?.finish('aborted')
  clearOperating(sessionId)
}

/* ───────── IPC ───────── */

function pageById(id: unknown): BrowserPage | undefined {
  return typeof id === 'string' ? allPages().find((p) => p.id === id && p.kind === 'window') : undefined
}

let registered = false
export function registerBrowserIpc(): void {
  if (registered) return
  registered = true
  setWindowPageFactory(createWindowPage)
  // 闲置回收跳过：等用户操作中的网页、窗口展开着且正显示的标签
  setInUseCheck(isPageInUse)
  // screen 只能在 app ready 之后用，故在这里（启动后调用）才挂监听
  screen.on('display-added', repositionIfDocked)
  screen.on('display-removed', repositionIfDocked)
  screen.on('display-metrics-changed', repositionIfDocked)
  setPagesChangedListener(() => {
    layout()
    push()
  })
  ipcMain.handle('browser:state', () => uiState())
  // 打开窗口：指定标签，或某个对话的当前标签
  ipcMain.handle('browser:open', (_e, opts: { tab?: string; sessionId?: string } = {}) => {
    const tab = opts.tab ?? (opts.sessionId ? currentBySession()[opts.sessionId] : undefined)
    showWindow(tab ?? null, true)
    return { ok: true }
  })
  ipcMain.handle('browser:dock', () => {
    dock()
    return { ok: true }
  })
  // 关闭某对话的全部网页（列表里的「全部关闭」）；正等用户操作时不关
  ipcMain.handle('browser:close-session', (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || handoffs.has(sessionId)) return { ok: false }
    closeSessionPages(sessionId)
    return { ok: true }
  })
  // 胶囊预览卡「固定」着看哪个标签（null = 没有固定）：用户正在看，Deva 关不掉、闲置也不回收
  ipcMain.handle('browser:preview-pinned', (_e, tab: string | null) => {
    pinnedPreview = typeof tab === 'string' ? tab : null
    // 固定着看的网页算显示中：取消固定后若已不该显示（如等待已结束），胶囊随之收起
    push()
    return { ok: true }
  })
  // 胶囊预览卡的实时画面：开 / 停（帧经 browser:live-frame 推给主窗口）
  ipcMain.handle('browser:live-start', (_e, tab: string) =>
    pageById(tab) ? startLive(String(tab), mainWindowGetter) : false
  )
  ipcMain.handle('browser:live-stop', () => {
    stopLive()
    return { ok: true }
  })
  ipcMain.handle('browser:pin', (_e, on: boolean) => {
    setPinned(on === true)
    return { ok: true }
  })
  ipcMain.handle('browser:activate', (_e, tab: string) => {
    activateTab(tab)
    return { ok: true }
  })
  ipcMain.handle('browser:close-tab', (_e, tab: string) => {
    if (pageById(tab)) closePage(tab)
    return { ok: true }
  })
  ipcMain.handle('browser:nav', (_e, tab: string, what: 'back' | 'forward' | 'reload' | 'stop') => {
    const p = pageById(tab)
    if (!p) return { ok: false }
    const h = p.wc.navigationHistory
    if (what === 'back' && h.canGoBack()) h.goBack()
    else if (what === 'forward' && h.canGoForward()) h.goForward()
    else if (what === 'reload') p.wc.reload()
    else if (what === 'stop') p.wc.stop()
    return { ok: true }
  })
  // 标签条上的「⋯」：前进 / 刷新 / 复制链接 / 在系统浏览器中打开。用系统原生菜单（应用内的弹层会被网页视图盖住）；
  // 文案由外框按界面语言传入。菜单关闭后才返回，外框据此显示按钮的按下状态。
  ipcMain.handle('browser:menu', (_e, tab: string, labels: Record<string, string>, at: { x: number; y: number }) => {
    const p = pageById(tab)
    if (!p || !win || win.isDestroyed()) return { ok: false }
    const text = (k: string): string => (typeof labels?.[k] === 'string' ? labels[k] : k)
    const wc = p.wc
    const url = wc.getURL()
    const web = /^https?:/i.test(url)
    const h = wc.navigationHistory
    const alive = (): boolean => !wc.isDestroyed()
    const items: MenuItemConstructorOptions[] = [
      { label: text('forward'), enabled: h.canGoForward(), click: () => alive() && h.canGoForward() && h.goForward() },
      wc.isLoading()
        ? { label: text('stopLoading'), click: () => alive() && wc.stop() }
        : { label: text('reload'), click: () => alive() && wc.reload() },
      { type: 'separator' },
      { label: text('copyLink'), enabled: web, click: () => clipboard.writeText(url) },
      { label: text('openExternal'), enabled: web, click: () => void shell.openExternal(url) }
    ]
    const w = win
    return new Promise((resolve) => {
      Menu.buildFromTemplate(items).popup({
        window: w,
        x: Math.round(Number(at?.x) || 0),
        y: Math.round(Number(at?.y) || 0),
        callback: () => resolve({ ok: true })
      })
    })
  })
  // 胶囊悬停预览：网页当前画面（宽 480）
  ipcMain.handle('browser:thumbnail', async (_e, tab: string) => {
    const p = pageById(tab)
    if (!p) return null
    try {
      const img = await p.wc.capturePage()
      if (img.isEmpty()) return null
      return img.resize({ width: 480, quality: 'good' }).toDataURL()
    } catch {
      return null
    }
  })
  ipcMain.handle('browser:handoff', (_e, sessionId: string, answer: 'done' | 'skip') => {
    respondHandoff(sessionId, answer)
    return { ok: true }
  })
  ipcMain.handle('browser:stop', (_e, sessionId: string) => {
    const ok = sessionAborter(sessionId)
    clearOperating(sessionId)
    return { ok }
  })
  // 外框界面载入后拉一次状态
  ipcMain.handle('browser:ready', () => {
    push()
    return uiState()
  })
}

/** 状态有变时由外部调用（如 browser 工具切换了当前标签）。 */
export function refreshUi(): void {
  notifyPagesChanged()
}
