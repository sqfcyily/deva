/**
 * 检查更新（设置 → 关于 →「检查更新」）。只在用户点按钮时检查，不在后台自动检查。
 *
 * 检查：读 GitHub 的 releases/latest（预发布版这个接口本就不返回），和本机版本比较。
 * 有新版时按安装方式分两种（见 shared/update.ts 的 UpdateMode）：
 *  - Windows 上用 exe 装的：electron-updater 读 Release 里的 latest.yml，应用内下载（校验 sha512），
 *    点「重启并安装」后静默覆盖安装并自动重开；下好了没点，下次退出时也会装上；
 *  - Windows 便携版（zip 解压运行的）：在浏览器里打开新版 zip 的直链，用户解压替换；
 *  - 其他情形（mac 包没正式签名做不了自动安装、开发模式）：在浏览器里打开对应安装包的直链。
 *
 * 网络都走 Chromium 网络栈（net.fetch，electron-updater 内部用 net.request），自动使用系统代理。
 */
import { app, ipcMain, net, shell, type BrowserWindow } from 'electron'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import type { UpdateMode, UpdateRelease, UpdateState } from '../../shared/update'
import { settleActiveTurns } from './chat'
import { installedByNsis, isPortable } from './portable'

const LATEST_API = 'https://api.github.com/repos/sqfcyily/deva/releases/latest'

interface GithubAsset {
  name: string
  browser_download_url: string
  /** uploaded = 已传完；open = 还在上传 */
  state?: string
}

interface GithubRelease {
  tag_name: string
  html_url: string
  assets?: GithubAsset[]
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

async function check(): Promise<void> {
  // 正在下载 / 已下好时不重查，免得把进度或「重启并安装」冲掉
  if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded')
    return
  setState({ phase: 'checking' })
  try {
    const res = await net.fetch(LATEST_API, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
    const data = (await res.json()) as GithubRelease
    const version = data.tag_name.replace(/^v/, '')
    if (compareVersions(version, app.getVersion()) <= 0) {
      found = null
      setState({ phase: 'latest' })
      return
    }
    const mode: UpdateMode = canAutoInstall() ? 'auto' : isPortable() ? 'portable' : 'manual'
    // 发版时常是先在网页上发布 Release、CI 几分钟后才把安装包传上来：本机要用的文件传完之前不算有新版，
    // 免得用户点了下载却下不到（Windows 自动更新还要 latest.yml）
    const uploaded = (data.assets ?? []).filter((a) => a.state !== 'open')
    const name = installerName(version)
    const installer = name ? uploaded.find((a) => a.name === name) : undefined
    const ready =
      name === null ||
      (installer !== undefined && (mode !== 'auto' || uploaded.some((a) => a.name === 'latest.yml')))
    if (!ready) {
      found = null
      setState({ phase: 'latest' })
      return
    }
    const release = { version, pageUrl: data.html_url }
    found = { release, mode, installerUrl: installer?.browser_download_url ?? null }
    setState({ phase: 'available', release, mode, file: installer?.name ?? null })
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
