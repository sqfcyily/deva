/**
 * 检查更新（设置 → 关于 →「检查更新」）。只在用户点按钮时检查，不在后台自动检查。
 *
 * 检查：查 GitHub 上最新的正式版（预发布版不算），和本机版本比较。来源见 latestRelease：先问 API，不行再读网页。
 * 有新版时按安装方式分两种（见 shared/update.ts 的 UpdateMode）：
 *  - Windows 上用 exe 装的：electron-updater 读 Release 里的 latest.yml，应用内下载（校验 sha512），
 *    点「重启并安装」后静默覆盖安装并自动重开；下好了没点，下次退出时也会装上；
 *  - Windows 便携版（zip 解压运行的）：在浏览器里打开新版 zip 的直链，用户解压替换；
 *  - 其他情形（mac 包没正式签名做不了自动安装、开发模式）：在浏览器里打开对应安装包的直链。
 *
 * 网络都走 Chromium 网络栈：查 API 用 httpFetch（同模型请求，先直连，直连不通才走系统代理）；读网页、下载
 * （net.fetch / net.request，electron-updater 内部也用 net.request）走系统代理。
 */
import { app, ipcMain, net, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import type { UpdateMode, UpdateRelease, UpdateState } from '../../shared/update'
import { httpFetch } from '../http'
import { settleActiveTurns } from './chat'
import { installedByNsis, isPortable } from './portable'

const LATEST_API = 'https://api.github.com/repos/sqfcyily/deva/releases/latest'
const RELEASES = 'https://github.com/sqfcyily/deva/releases'
const TIMEOUT_MS = 15_000

interface GithubRelease {
  tag_name: string
  /** state：uploaded = 已传完；open = 还在上传 */
  assets?: { name: string; state?: string }[]
}

/** 最新正式版。 */
interface LatestRelease {
  tag: string
  /** 这个文件是否已传完、可以下载。 */
  hasFile: (name: string) => Promise<boolean>
}

let getWindow: () => BrowserWindow | null = () => null
let state: UpdateState = { phase: 'idle' }
/** 最近一次查到的新版；下载失败后「重试」直接用它，不用重新检查。 */
let found: { release: UpdateRelease; mode: UpdateMode; installerUrl: string | null } | null = null
/** 首次下载时才配置（也就只有 Windows exe 安装的会用到）。 */
let updater: AppUpdater | null = null

function setState(next: UpdateState): void {
  state = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('update:state', state)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 比较 x.y.z[-pre]。x.y.z 相同时正式版比预发布版新（0.5.0 > 0.5.0-beta.1），
 * 装了预发布版的用户才能收到同号正式版的更新；都是预发布版时按后缀比较（beta.2 > beta.1）。
 */
function compareVersions(a: string, b: string): number {
  const [ca, preA = ''] = a.split(/-(.*)/)
  const [cb, preB = ''] = b.split(/-(.*)/)
  const pa = ca.split('.').map(Number)
  const pb = cb.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return Math.sign(d)
  }
  if (preA === preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return Math.sign(preA.localeCompare(preB, 'en', { numeric: true }))
}

/**
 * 是否经 exe 安装程序装的。开发模式、便携版（zip 解压运行）都不是——这些情形交给 electron-updater
 * 会另装出一份 Deva。
 */
function canAutoInstall(): boolean {
  return process.platform === 'win32' && app.isPackaged && installedByNsis()
}

/**
 * Linux 的安装方式：AppImage 运行时会带上 APPIMAGE 环境变量；deb 固定装在 /opt/Deva（见 electron-builder 的 deb 目标）。
 * 都不是（开发模式、自己解压的 linux-unpacked）返回 null。
 */
function linuxPackage(): 'appimage' | 'deb' | null {
  if (!app.isPackaged) return null
  if (process.env.APPIMAGE) return 'appimage'
  if (process.execPath.startsWith('/opt/Deva/')) return 'deb'
  return null
}

/** 本机该下载的文件名（安装包 / 便携版 zip / AppImage / deb）；没有对应文件的情形返回 null（只能打开 Release 页面）。 */
function installerName(version: string): string | null {
  if (process.platform === 'win32')
    return isPortable() ? `Deva-${version}-portable.zip` : `Deva-${version}-setup.exe`
  if (process.platform === 'darwin') {
    // x64 版经 Rosetta 跑在 Apple 芯片上时 process.arch 也是 x64，改推原生的 arm64 包
    const arm = process.arch === 'arm64' || app.runningUnderARM64Translation
    return `Deva-${version}-${arm ? 'arm64' : 'x64'}.dmg`
  }
  // Linux：按安装方式给同类包，文件名带架构（见 electron-builder.yml 的 linux.artifactName）。
  // 注意 electron-builder 用的是各格式自己的架构名：AppImage 的 x64 叫 x86_64、deb 叫 amd64，arm64 都不变，
  // 不是 Windows/macOS 那套 x64。下载后由用户自己替换 / 安装，不做应用内自动安装。
  if (process.platform === 'linux') {
    const pkg = linuxPackage()
    if (pkg === 'deb') return `Deva-${version}-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.deb`
    if (pkg === 'appimage') {
      const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'i386' : 'x86_64'
      return `Deva-${version}-${arch}.AppImage`
    }
  }
  return null
}

/**
 * 先问 API：一次请求连文件列表一起拿到，平时又快又稳。但未登录时每个 IP 每小时只有 60 次，代理的出口 IP 多人共用，
 * 额度常被用光而返回 403（issue #39），所以 API 走 httpFetch 先直连、用自己的 IP。API 还是不行时改读网页（不占这个额度，
 * electron-updater 的 GitHub 源也这么读），不过网页的 releases/latest 有时十几秒才回、甚至 504，只作后备。
 * 两边都不行时报网页那边的错。
 */
async function latestRelease(): Promise<LatestRelease> {
  try {
    return await latestFromApi()
  } catch (e) {
    console.warn('[updater] GitHub API unavailable, falling back to the web page:', errorText(e))
    return await latestFromWeb()
  }
}

async function latestFromApi(): Promise<LatestRelease> {
  const res = await httpFetch(LATEST_API, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const data = (await res.json()) as GithubRelease
  const uploaded = new Set((data.assets ?? []).filter((a) => a.state !== 'open').map((a) => a.name))
  return { tag: data.tag_name, hasFile: async (name) => uploaded.has(name) }
}

/** 网页地址带 Accept: application/json 时跳转到最新正式版，并返回含 tag_name 的 JSON（没有文件列表）。 */
async function latestFromWeb(): Promise<LatestRelease> {
  const res = await net.fetch(`${RELEASES}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const tag = ((await res.json()) as { tag_name?: unknown }).tag_name
  if (typeof tag !== 'string' || !tag) throw new Error('GitHub: tag_name missing')
  return { tag, hasFile: (name) => assetReady(tag, name) }
}

/**
 * 该版本的 Release 里这个文件是否已传完、可以下载。只问 github.com：有文件时回 302 跳到下载服务器（不跟过去），
 * 没有或还在上传时回 404。
 */
function assetReady(tag: string, name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'HEAD',
      url: `${RELEASES}/download/${tag}/${encodeURIComponent(name)}`,
      redirect: 'manual'
    })
    const timer = setTimeout(() => {
      req.abort()
      reject(new Error('GitHub: request timed out'))
    }, TIMEOUT_MS)
    // 先到的结果为准；不调 followRedirect，请求随即取消，之后的 error 事件落到已定的 Promise 上不起作用
    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      fn()
    }
    req.on('redirect', () => settle(() => resolve(true)))
    req.on('response', (res) => {
      const code = res.statusCode
      settle(() =>
        code === 404 ? resolve(false) : code < 300 ? resolve(true) : reject(new Error(`GitHub HTTP ${code}`))
      )
    })
    req.on('error', (e) => settle(() => reject(e)))
    req.end()
  })
}

async function check(): Promise<void> {
  // 正在下载 / 已下好时不重查，免得把进度或「重启并安装」冲掉
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded')
    return
  setState({ phase: 'checking' })
  try {
    const { tag, hasFile } = await latestRelease()
    const version = tag.replace(/^v/, '')
    if (compareVersions(version, app.getVersion()) <= 0) {
      found = null
      setState({ phase: 'latest' })
      return
    }
    const mode: UpdateMode = canAutoInstall() ? 'auto' : isPortable() ? 'portable' : 'manual'
    // 发版时常是先在网页上发布 Release、CI 几分钟后才把安装包传上来：本机要用的文件传完之前不算有新版，
    // 免得用户点了下载却下不到（Windows 自动更新还要 latest.yml）
    const name = installerName(version)
    const ready =
      name === null ||
      (await Promise.all([hasFile(name), mode === 'auto' ? hasFile('latest.yml') : true])).every(Boolean)
    if (!ready) {
      found = null
      setState({ phase: 'latest' })
      return
    }
    const release = { version, pageUrl: `${RELEASES}/tag/${tag}` }
    const installerUrl = name ? `${RELEASES}/download/${tag}/${encodeURIComponent(name)}` : null
    found = { release, mode, installerUrl }
    setState({ phase: 'available', release, mode, file: name })
  } catch (e) {
    setState({ phase: 'error', stage: 'check', message: errorText(e) })
  }
}

function getUpdater(): AppUpdater {
  if (updater) return updater
  updater = autoUpdater
  updater.autoDownload = false
  // 当前是预发布版时 electron-updater 默认打开它、改读 feed 里最新的一个（可能又是预发布版），
  // 和 check() 读的 releases/latest（只有正式版）对不上；固定只升正式版
  updater.allowPrerelease = false
  // 下好了没点「重启并安装」：下次退出时静默装上（不自动重开）
  updater.autoInstallOnAppQuit = true
  updater.on('download-progress', (p) => {
    const percent = Math.floor(p.percent)
    if (state.phase === 'downloading' && percent !== state.percent) setState({ ...state, percent })
  })
  // 出错时 electron-updater 既 reject 又 emit('error')；没人监听 'error' 会被当成未捕获异常
  updater.on('error', (e) => console.warn('[updater]', e.message))
  return updater
}

async function download(): Promise<void> {
  if (!found || state.phase === 'downloading' || state.phase === 'downloaded') return
  const { release, mode, installerUrl } = found
  if (mode !== 'auto') {
    await shell.openExternal(installerUrl ?? release.pageUrl)
    return
  }
  setState({ phase: 'downloading', release, percent: 0 })
  try {
    const u = getUpdater()
    // electron-updater 得先自己查一遍（读 Release 里的 latest.yml）才能下载
    const r = await u.checkForUpdates()
    if (!r || compareVersions(r.updateInfo.version, app.getVersion()) <= 0)
      throw new Error('latest.yml not found in this release')
    await u.downloadUpdate()
    setState({ phase: 'downloaded', release })
  } catch (e) {
    setState({ phase: 'error', stage: 'download', message: errorText(e), release })
  }
}

async function install(): Promise<void> {
  if (state.phase !== 'downloaded' || !updater) return
  // 先把进行中的回合收尾落盘：quitAndInstall 会立刻拉起安装程序，安装程序一两秒后就强杀还没退出的 Deva，
  // 等不到 before-quit 里那 3 秒收尾
  await settleActiveTurns(3000)
  // 静默安装 + 装完自动重开
  updater.quitAndInstall(true, true)
}

export function registerUpdaterIpc(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
  ipcMain.handle('update:get-state', (): UpdateState => state)
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:download', () => download())
  ipcMain.handle('update:install', () => install())
}
