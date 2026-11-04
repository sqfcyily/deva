/**
 * 内置浏览器的网页登记与宿主。
 *
 * 两种宿主（kind）：
 * - window：前台对话（用户在电脑前）的网页，是「Deva 浏览器」窗口里的一个 WebContentsView（见 host.ts）。用户打开
 *   窗口看到的就是 Deva 正在操作的同一个页面；窗口收起时挪到屏幕外继续渲染。
 * - offscreen：定时任务、手机端发起的对话用的网页，放在离屏渲染的 BrowserWindow 里，从不显示。
 * 实测（Win11 / Electron 33）：普通窗口一旦隐藏或从未显示，截图失败、点击输入也不生效，所以两种宿主都必须「在渲染」。
 *
 * 网页按对话（sessionId）归属：每个对话有自己的标签与「当前标签」；登录状态所有对话共用一个持久化分区，
 * 与系统里的 Chrome / Edge 互不影响。
 */
import { app, BrowserWindow, session, type Session, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join, parse } from 'path'
import { DIALOG_SHIM } from './page-scripts'

export const BROWSER_PARTITION = 'persist:deva-browser'
/** 网页视口尺寸（CSS 像素）。 */
export const VIEWPORT = { width: 1280, height: 800 }
/** 每个对话最多同时开的网页数；超出时关掉最久没用的。每个网页是一个独立的渲染进程，上限从严。 */
const MAX_PAGES_PER_SESSION = 3
/** 全部对话合计上限。 */
const MAX_PAGES_TOTAL = 6
/** 弹给用户看过的网页闲置多久自动关闭（登录状态存在分区里，关掉后重开不用重新登录）。 */
export const IDLE_CLOSE_MS = 10 * 60_000
/**
 * 没弹给用户看过的网页（后台网页）：对话没有进行中的回合后，闲置多久关闭。用户看不到后台网页，也就不知道它还占着
 * 内存，所以不靠模型自觉关，由这里兜底；留几分钟是给「需要搜索什么吗？」这类收尾后用户马上接着说的情况。
 * 回合进行中仍按 IDLE_CLOSE_MS（模型可能在做别的步骤，回头还要用）。
 */
export const BACKGROUND_CLOSE_MS = 3 * 60_000
/** 回收检查间隔。 */
const REAP_INTERVAL_MS = 30_000
const CDP_TIMEOUT_MS = 15_000

export interface BrowserPage {
  /** 标签编号（p1、p2…），在本次运行内唯一，模型用它切换 / 关闭标签。 */
  id: string
  sessionId: string
  /** 打开它的对话所属角色（窗口标签上显示其头像）。 */
  personaId?: string
  kind: 'window' | 'offscreen'
  wc: WebContents
  /** 关掉宿主（离屏窗口销毁 / 从浏览器窗口移除视图并关闭）。 */
  dispose: () => void
  lastUsed: number
  /**
   * 用户要求看过（browser 的 show 弹给用户看）。浏览器默认在后台给 Deva 用，界面上不显示；
   * 弹给用户看过的网页此后一直显示在胶囊里，直到关掉（见 host.ts visibleTabs）。
   */
  shown: boolean
  /** 尚未告知模型的事件（弹出新标签、下载完成等），下次返回结果时附上后清空。 */
  notices: string[]
  /** CDP 是否已初始化（attach + 对话框接管）。 */
  cdpReady: boolean
  /**
   * 初始的 about:blank 加载完成：网页第一次导航之前渲染进程还没建起来，CDP 命令与 executeJavaScript 都不会有响应，
   * 所以新建时先载入空白页，初始化 CDP 前等它完成。
   */
  ready: Promise<void>
  /** 进行中的文档 / 接口请求（requestId → 开始时间），判断页面是否稳定用；图片、脚本、统计上报不计。 */
  inflight: Map<string, number>
}

/**
 * 网页的细滚动条（同 Deva 界面：8px、圆角、轨道透明）。滑块用半透明中性灰，浅色、深色网页上都看得清。
 * 只用 ::-webkit-scrollbar：网站若设了标准的 scrollbar-width / scrollbar-color，Chromium 会以网站的为准。
 */
const SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.45); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.7); background-clip: content-box; }
::-webkit-scrollbar-corner { background: transparent; }
`

/** 计入「页面还在加载数据」的请求类型。 */
const TRACKED_TYPES = new Set(['Document', 'XHR', 'Fetch'])

const pages = new Map<string, BrowserPage>()
/** 对话 → 当前标签。 */
const current = new Map<string, string>()
let seq = 0
let sessionReady: Session | null = null
let reaper: NodeJS.Timeout | null = null
/** 本模块与 host.ts 创建的宿主窗口：主进程其他地方按「全部窗口」判断时要排除它们（见 isBrowserHostWindow）。 */
const hostWindows = new WeakSet<BrowserWindow>()
export function markHostWindow(win: BrowserWindow): void {
  hostWindows.add(win)
}

/** 前台网页（浏览器窗口里的视图）的工厂，由 host.ts 注入；没注入时（如测试）一律用离屏。 */
let windowPageFactory: ((id: string, sessionId: string, personaId?: string) => BrowserPage) | null = null
export function setWindowPageFactory(fn: typeof windowPageFactory): void {
  windowPageFactory = fn
}

/** 正在用、不能按闲置回收的网页（等用户操作中、窗口展开着且正显示的标签），由 host.ts 注入。 */
let inUse: (page: BrowserPage) => boolean = () => false
export function setInUseCheck(fn: typeof inUse): void {
  inUse = fn
}

/** 对话是否有进行中的回合（含它的后台子智能体），由 chat.ts 注入；没注入时（如测试）视为没有。 */
let sessionBusy: (sessionId: string) => boolean = () => false
export function setSessionBusyCheck(fn: typeof sessionBusy): void {
  sessionBusy = fn
}

/** 闲置多久关闭：后台网页在对话没有进行中的回合后按 BACKGROUND_CLOSE_MS，其余按 IDLE_CLOSE_MS。 */
function idleLimit(p: BrowserPage): number {
  return !p.shown && !sessionBusy(p.sessionId) ? BACKGROUND_CLOSE_MS : IDLE_CLOSE_MS
}

/** 对话的回合结束：后台网页从此刻起计时（回合里很久没用的，也留足收尾后用户接着说的时间）。 */
export function markTurnEnded(sessionId: string): void {
  const now = Date.now()
  for (const p of pages.values()) if (p.sessionId === sessionId && !p.shown) p.lastUsed = Math.max(p.lastUsed, now)
}

/** 网页增删、当前标签变化、标题 / 网址 / 加载状态变化时通知（浏览器窗口与胶囊据此刷新）。 */
let changed: () => void = () => {}
export function setPagesChangedListener(fn: () => void): void {
  changed = fn
}
export function notifyPagesChanged(): void {
  changed()
}

/** 全部网页（按打开先后）。 */
export function allPages(): BrowserPage[] {
  return [...pages.values()]
}

/** 是否还有进行中的数据请求；超过 staleMs 仍未结束的（长轮询、推送流）不算。 */
export function hasPendingRequests(page: BrowserPage, staleMs = 4_000): boolean {
  const now = Date.now()
  for (const [id, t] of page.inflight) {
    if (now - t <= staleMs) return true
    page.inflight.delete(id)
  }
  return false
}

export function isBrowserHostWindow(win: BrowserWindow): boolean {
  return hostWindows.has(win)
}

/** 浏览器专用会话：去掉 UA 里的 Electron / 应用名标记（不少网站据此拦截或降级），拒绝一切权限请求，下载存到「下载」目录。 */
export function browserSession(): Session {
  if (sessionReady) return sessionReady
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.setUserAgent(
    ses
      .getUserAgent()
      .replace(/\s(Electron|@?deva[\w./-]*)\/\S+/gi, '')
      .trim()
  )
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (_e, item, wc) => {
    const page = [...pages.values()].find((p) => p.wc === wc)
    const target = uniquePath(app.getPath('downloads'), item.getFilename() || 'download')
    item.setSavePath(target)
    item.once('done', (_ev, state) => {
      if (!page) return
      page.notices.push(
        state === 'completed' ? `已下载文件：${target}` : `文件下载未完成（${state}）：${item.getFilename()}`
      )
    })
  })
  sessionReady = ses
  return ses
}

function uniquePath(dir: string, name: string): string {
  const { name: base, ext } = parse(name)
  let p = join(dir, name)
  for (let i = 1; existsSync(p); i++) p = join(dir, `${base} (${i})${ext}`)
  return p
}

function startReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    const now = Date.now()
    for (const p of [...pages.values()]) {
      // 正在用的网页从「不再用」那一刻起重新计时
      if (inUse(p)) p.lastUsed = now
      else if (now - p.lastUsed > idleLimit(p)) closePage(p.id)
    }
  }, REAP_INTERVAL_MS)
  reaper.unref?.()
}

/**
 * 新建一个网页（空白），设为该对话的当前标签。visible：用户在电脑前（前台对话），放进浏览器窗口；
 * 否则（定时任务、手机端）放进离屏窗口。
 */
export function createPage(sessionId: string, visible = false, personaId?: string): BrowserPage {
  enforceLimits(sessionId)
  const id = `p${++seq}`
  const page = visible && windowPageFactory ? windowPageFactory(id, sessionId, personaId) : createOffscreenPage(id, sessionId, personaId)
  // 新窗口（target=_blank / window.open）：不另开系统窗口，作为本对话的新标签打开并切过去。
  page.wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^file:/i.test(url)) {
      setImmediate(() => {
        if (!pages.has(page.id)) return
        const next = createPage(sessionId, page.kind === 'window', page.personaId)
        void ensureCdp(next)
          .then(() => next.wc.loadURL(url))
          .catch(() => {})
        page.notices.push(`页面打开了新标签 ${next.id}（${url}），已切换到该标签。`)
        next.notices.push(`本标签由 ${page.id} 打开。`)
      })
    }
    return { action: 'deny' }
  })
  page.wc.on('destroyed', () => forget(page.id))
  pages.set(page.id, page)
  current.set(sessionId, page.id)
  startReaper()
  changed()
  return page
}

/** 网页的公共字段（两种宿主共用）。 */
export function basePage(
  id: string,
  sessionId: string,
  personaId: string | undefined,
  kind: BrowserPage['kind'],
  wc: WebContents,
  dispose: () => void
): BrowserPage {
  wc.setAudioMuted(kind === 'offscreen')
  // 网页滚动条换成和 Deva 界面一致的细滚动条。以「用户样式表」注入：优先级低于网站自己的样式，网站自定义过滚动条的保留原样。
  // 每个新文档加载完注入一次（换页后旧样式随文档失效）
  wc.on('dom-ready', () => {
    void wc.insertCSS(SCROLLBAR_CSS, { cssOrigin: 'user' }).catch(() => {})
  })
  // 初始化用的 about:blank 不留在历史里：第一次真正导航后删掉，否则网页第一页也能「后退」到一片空白
  const dropBlank = (): void => {
    const h = wc.navigationHistory
    if (h.length() > 1 && h.getActiveIndex() > 0 && h.getEntryAtIndex(0)?.url === 'about:blank') {
      h.removeEntryAtIndex(0)
      wc.off('did-navigate', dropBlank)
    }
  }
  wc.on('did-navigate', dropBlank)
  return {
    id,
    sessionId,
    personaId,
    kind,
    wc,
    dispose,
    lastUsed: Date.now(),
    shown: false,
    notices: [],
    cdpReady: false,
    inflight: new Map(),
    ready: wc.loadURL('about:blank').then(
      () => {},
      () => {}
    )
  }
}

function createOffscreenPage(id: string, sessionId: string, personaId?: string): BrowserPage {
  const win = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      session: browserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  hostWindows.add(win)
  win.webContents.setFrameRate(10)
  return basePage(id, sessionId, personaId, 'offscreen', win.webContents, () => {
    if (!win.isDestroyed()) win.destroy()
  })
}

function forget(id: string): void {
  const p = pages.get(id)
  if (!p) return
  pages.delete(id)
  if (current.get(p.sessionId) === id) {
    const rest = sessionPages(p.sessionId)
    if (rest.length) current.set(p.sessionId, rest[rest.length - 1].id)
    else current.delete(p.sessionId)
  }
  changed()
}

function enforceLimits(sessionId: string): void {
  const own = sessionPages(sessionId)
  if (own.length >= MAX_PAGES_PER_SESSION) closePage(lru(own).id)
  const all = [...pages.values()]
  if (all.length >= MAX_PAGES_TOTAL) closePage(lru(all).id)
}

/** 最久没用的网页；正在用的（如等用户登录）尽量不选。 */
function lru(list: BrowserPage[]): BrowserPage {
  const idle = list.filter((p) => !inUse(p))
  return (idle.length ? idle : list).reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b))
}

/** 某对话的全部标签（按打开先后）。 */
export function sessionPages(sessionId: string): BrowserPage[] {
  return [...pages.values()].filter((p) => p.sessionId === sessionId)
}

export function currentPage(sessionId: string): BrowserPage | null {
  const id = current.get(sessionId)
  const p = id ? pages.get(id) : undefined
  return p && !p.wc.isDestroyed() ? p : null
}

export function getPage(sessionId: string, id: string): BrowserPage | null {
  const p = pages.get(id)
  return p && p.sessionId === sessionId && !p.wc.isDestroyed() ? p : null
}

export function setCurrent(page: BrowserPage): void {
  const was = current.get(page.sessionId)
  current.set(page.sessionId, page.id)
  page.lastUsed = Date.now()
  if (was !== page.id) changed()
}

/** 各对话的当前标签（给界面用）。 */
export function currentBySession(): Record<string, string> {
  return Object.fromEntries(current)
}

export function closePage(id: string): void {
  const p = pages.get(id)
  if (!p) return
  forget(id)
  p.dispose()
}

/** 对话被删除时关掉它的全部网页。 */
export function closeSessionPages(sessionId: string): void {
  for (const p of sessionPages(sessionId)) closePage(p.id)
}

/** 退出 / 主窗口真正关闭时调用：离屏窗口也算窗口，不关掉会让应用无法正常退出。 */
export function disposeAllPages(): void {
  for (const p of [...pages.values()]) closePage(p.id)
  if (reaper) clearInterval(reaper)
  reaper = null
}

/**
 * attach CDP 并接管 JS 对话框（之后每个新文档都先装上接管脚本，当前文档补装一次）。
 * 须在加载网址之前调用，否则第一个页面里的 alert 会弹原生对话框。
 */
export async function ensureCdp(page: BrowserPage): Promise<void> {
  if (page.cdpReady) return
  await timed(page.ready, 'about:blank')
  if (page.cdpReady) return
  const dbg = page.wc.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  page.cdpReady = true
  dbg.on('message', (_e, method, params: { requestId?: string; type?: string }) => {
    if (method === 'Network.requestWillBeSent') {
      if (params.requestId && TRACKED_TYPES.has(params.type ?? '')) page.inflight.set(params.requestId, Date.now())
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if (params.requestId) page.inflight.delete(params.requestId)
    }
  })
  await timed(dbg.sendCommand('Network.enable'), 'Network.enable')
  await timed(dbg.sendCommand('Page.enable'), 'Page.enable')
  await timed(dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM }), 'addScript')
  await timed(page.wc.executeJavaScript(DIALOG_SHIM), 'shim').catch(() => {})
}

function timed<T>(p: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`浏览器初始化超时（${what}）`)), ms)
    })
  ]).finally(() => timer && clearTimeout(timer))
}

/** 带超时的 CDP 调用。 */
export async function cdp<T = Record<string, unknown>>(
  page: BrowserPage,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_TIMEOUT_MS
): Promise<T> {
  await ensureCdp(page)
  const dbg = page.wc.debugger
  let timer: NodeJS.Timeout | undefined
  try {
    return (await Promise.race([
      dbg.sendCommand(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`浏览器操作超时（${method}）`)), timeoutMs)
      })
    ])) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}
