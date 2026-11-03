import { app, shell, BrowserWindow, ipcMain, nativeTheme, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getConfig, registerConfigIpc } from './services/config'
import { getAppIcon, getTrayIcon } from './services/tray-icon'
import { registerWorkspaceIpc } from './services/workspace'
import { registerSecretsIpc } from './services/secrets'
import { registerProviderIpc } from './services/provider'
import { hasActiveTurns, registerChatIpc, settleActiveTurns } from './services/chat'
import { listSessions } from './services/chat-store'
import { sweepCheckpoints } from './services/checkpoints'
import { sweepSubagents } from './services/subagent-store'
import { sweepMedia } from './services/media-store'
import { registerSkillsIpc, startSkillsWatcher } from './services/skills'
import { ensureSeededPersonas, pruneOrphanExtRoles, registerPersonasIpc } from './services/personas'
import { registerProfileIpc } from './services/profile'
import { registerMemoryIpc } from './services/memory'
import {
  autoConnectEnabledServers,
  disconnectAllServers,
  registerMcpIpc
} from './services/mcp'
import { registerAttachmentsIpc } from './services/attachments'
import { registerTerminalIpc } from './services/terminal'
import { registerGitIpc } from './services/git'
import { registerClipboardIpc } from './services/clipboard'
import { registerDeliverablesIpc } from './services/deliverables'
import { registerTasksIpc } from './services/tasks'
import { startScheduler } from './services/scheduler'
import { registerRemoteIpc, stopAllChannels } from './services/remote'
import { registerUpdaterIpc } from './services/updater'
import { registerToastIdentity } from './services/portable'
import { integrateAppImage } from './services/appimage'
import {
  disposeAllPages,
  isBrowserHostWindow,
  registerBrowserIpc,
  setMainWindowGetter
} from './services/browser'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 关窗驻留托盘时，真正退出由此标志放行（before-quit / 托盘「退出」置 true）。 */
let isQuitting = false

/**
 * Linux 密钥存储后端：Electron 只按 `XDG_CURRENT_DESKTOP` 的**硬编码白名单**挑后端
 * （GNOME / XFCE / X-Cinnamon / Deepin / Pantheon / UKUI / unity），其余一律落到 `basic_text`。
 * 而 `basic_text` 下 `safeStorage.isEncryptionAvailable()` 恒为 false，API 密钥就存不进去
 * （见 services/secrets.ts：宁可拒绝也不明文落盘）。
 *
 * 问题是 niri / sway / Hyprland 这类独立合成器都不在白名单里——用户明明装了 gnome-keyring、
 * 钥匙环也解锁了，Electron 却根本不问它。故在 app ready 之前显式补一个 `--password-store`
 * 绕过白名单；用户自己传了同名参数则完全尊重（不覆盖）。
 */
function ensureLinuxPasswordStore(): void {
  if (process.platform !== 'linux') return
  if (app.commandLine.hasSwitch('password-store')) return
  const desktop =
    `${process.env.XDG_CURRENT_DESKTOP ?? ''} ${process.env.XDG_SESSION_DESKTOP ?? ''}`.toLowerCase()
  const isKde = desktop.includes('kde') || desktop.includes('plasma')
  // KWallet 5 / 6 的接口不通用，按会话版本选；KDE_SESSION_VERSION 由 Plasma 自己设置
  const kdeBackend = process.env.KDE_SESSION_VERSION === '5' ? 'kwallet5' : 'kwallet6'
  app.commandLine.appendSwitch('password-store', isKde ? kdeBackend : 'gnome-libsecret')
}

// 必须早于 app ready：Chromium 在初始化 OSCrypt 时读一次，之后再改就没用了
ensureLinuxPasswordStore()

// 内置浏览器：收起的「Deva 浏览器」窗口挪在屏幕外继续运行（隐藏的窗口不渲染，Deva 没法截图、点击、输入）。
// Chromium 默认会把完全看不见的窗口判为被遮挡而停止绘制，这里关掉这项检测（实测关掉后屏幕外窗口照常工作）。
// 代价：Deva 窗口被别的程序挡住时也照常绘制，界面基本静止，影响很小。须早于 app ready。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

/** 明暗主题下的窗口控件叠加配色（与 tokens.css 的 --bg / --fg 对齐）。 */
const OVERLAY_SYMBOL = { light: '#3a3a3d', dark: '#e4e4e7' } as const
const OVERLAY_BG = { light: '#ffffff', dark: '#1e1e20' } as const

/**
 * 窗口控件叠加（Window Controls Overlay）参数；macOS 返回 undefined（红绿灯由系统绘制）。
 * - Windows：透明底 + 显式 symbolColor，图标颜色随主题即时切换（见 window:set-overlay）。
 * - Linux：不支持透明叠加区与 symbolColor（Electron 按 color 自动算对比色），只能用实色底，
 *   所以跟着主题给底色，否则深色主题下会顶一条白条。
 */
function overlayOptions(
  dark: boolean
): { color: string; symbolColor?: string; height: number } | undefined {
  if (process.platform === 'win32') {
    return { color: '#00000000', symbolColor: dark ? OVERLAY_SYMBOL.dark : OVERLAY_SYMBOL.light, height: 40 }
  }
  if (process.platform === 'linux') {
    return { color: dark ? OVERLAY_BG.dark : OVERLAY_BG.light, height: 40 }
  }
  return undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: getAppIcon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
    // 无边框 + 原生窗口控件叠加，做出干净的自定义顶栏（Windows / Linux；macOS 用红绿灯）
    titleBarStyle: 'hidden',
    // Linux 也支持 Window Controls Overlay：不给它就只有无边框窗口、没有任何 min/max/close 按钮。
    // 与 Windows 的差别：Linux 不支持透明叠加区，也不支持 symbolColor（Electron 按 color 自动算对比色），
    // 故这里用与标题栏底色一致的实色。
    titleBarOverlay: overlayOptions(nativeTheme.shouldUseDarkColors),
    // macOS 红绿灯整组约 54px 宽：在 72px 宽的图标栏内水平居中，垂直居中于栏顶预留的 40px（见 redesign.css .has-traffic-lights）
    trafficLightPosition: { x: 9, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：见 docs/architecture/security.md
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // 关掉 Chromium 拼写检查：输入多是中文夹杂模型名 / 代码 / 路径，满屏红波浪线只是噪音（也没做纠错菜单）
      spellcheck: false
    }
  })

  // 首显兜底：show:false 时窗口只靠 ready-to-show 显示，一旦该事件没触发（渲染层加载失败 / 崩溃 /
  // 部分 Windows 机器上首帧迟迟不来），窗口会一直隐藏，而托盘照常建好——表现为「启动后只在托盘」。
  // 故 ready-to-show / did-finish-load / 加载失败 / 渲染进程退出 / 超时 任一先到即显示（仅一次）。
  const win = mainWindow
  let shown = false
  const revealOnce = (reason: string): void => {
    if (shown || win.isDestroyed()) return
    shown = true
    if (reason !== 'ready-to-show') console.warn(`[window] 首显兜底触发：${reason}`)
    win.show()
  }
  win.once('ready-to-show', () => revealOnce('ready-to-show'))
  win.webContents.once('did-finish-load', () => revealOnce('did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[window] 页面加载失败 ${code} ${desc} ${url}`)
    revealOnce('did-fail-load')
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程退出：', details.reason)
    revealOnce('render-process-gone')
  })
  setTimeout(() => revealOnce('timeout'), 5000)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    // 内置浏览器的离屏网页也是窗口：主窗口真正关闭时一并关掉，否则 window-all-closed 不会触发、应用退不出去。
    disposeAllPages()
  })
  // macOS 全屏时系统隐藏红绿灯：通知渲染层收起图标栏为它预留的位置
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen', false))

  // 关窗驻留托盘：调度器在窗口隐藏时照常触发（关窗 ≠ 退出）。
  // win32 默认开启（config.closeToTray 显式为 false 时才真退出）；其它平台默认真退出（仅显式 true 才驻留）。
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    const pref = getConfig().closeToTray
    const stay = process.platform === 'win32' ? pref !== false : pref === true
    if (stay) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 外链一律走系统浏览器，且拦截应用内导航
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 编辑上下文菜单：Electron 默认不给可编辑元素任何原生右键菜单（故对话输入框无法右键粘贴）。
  // 这里补一个最小编辑菜单——可编辑处给 剪切/复制/粘贴/全选（按 editFlags 灰显不可用项，走原生
  // role 直接操作系统剪贴板）；非编辑但有选区时给 复制/全选。其余情形不弹菜单（保持干净）。
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const win = mainWindow
    if (!win) return
    const en = getConfig().locale === 'en'
    const L = en
      ? { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }
      : { cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选' }
    const { isEditable, editFlags } = params
    const hasSelection = params.selectionText.trim().length > 0
    const template: Electron.MenuItemConstructorOptions[] = []
    if (isEditable) {
      template.push(
        { role: 'cut', label: L.cut, enabled: editFlags.canCut },
        { role: 'copy', label: L.copy, enabled: editFlags.canCopy },
        { role: 'paste', label: L.paste, enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: L.selectAll }
      )
    } else if (hasSelection) {
      template.push(
        { role: 'copy', label: L.copy, enabled: editFlags.canCopy },
        { type: 'separator' },
        { role: 'selectAll', label: L.selectAll }
      )
    }
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 显示 / 唤起主窗口（不存在则重建；隐藏 / 最小化则恢复并聚焦）。 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 建系统托盘（幂等）：图标运行期生成（tray-icon.ts，无二进制资产；macOS 为单色模板图）。
 * 菜单——显示 Deva / 定时任务概览〔直达 Tasks 标签〕/ 退出；左键切换窗口可见。
 * 菜单文案按启动时 config.locale 取中/英（运行时改语言需重启方更新，可接受）。
 */
function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(getTrayIcon())
  } catch {
    tray = null // 极端环境建托盘失败：静默降级（不影响调度 / 通知 / 主功能）
    return
  }
  const en = getConfig().locale === 'en'
  const L = en
    ? { show: 'Show Deva', tasks: 'Scheduled tasks', quit: 'Quit' }
    : { show: '显示 Deva', tasks: '定时任务概览', quit: '退出' }
  tray.setToolTip('Deva')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: L.show, click: showMainWindow },
      {
        label: L.tasks,
        click: () => {
          showMainWindow()
          mainWindow?.webContents.send('tasks:navigate', { pane: 'tasks' })
        }
      },
      { type: 'separator' },
      {
        label: L.quit,
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
    else showMainWindow()
  })
}

// 单实例锁：第二个实例只唤起既有窗口后自行退出。
// 无锁 = 二次启动会再起一个调度器 → 同一任务被两个进程「双触发」，故此为正确性要求（非可选）。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // 再次双击图标：无论既有窗口是隐藏在托盘、最小化还是已被销毁，都要把界面唤起来。
  // 窗口尚未建好（仍在 whenReady 初始化中）时跳过，createWindow 随后会自行首显。
  app.on('second-instance', () => {
    if (!app.isReady()) return
    showMainWindow()
  })

  app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.sqfcy.deva')
  // 便携版没有开始菜单快捷方式：注册通知显示名与图标，否则通知标题是原始 ID（须早于第一条通知）
  registerToastIdentity('dev.sqfcy.deva')
  // Linux AppImage：把 desktop 入口与图标写到用户目录，启动器里才找得到 Deva（后台进行，不阻塞启动）
  void integrateAppImage()
  // Linux X11：窗口的 WM_CLASS 取自应用名（默认是 package.json 的 @deva/desktop），与 deva.desktop 的
  // StartupWMClass=deva 对不上，任务栏就归不到 Deva 图标下（Wayland 的 app_id 取 desktopName，不受影响）。
  // 必须在 ready 之后改：应用名同时决定 userData 目录与钥匙环里加密密钥的条目名（application=@deva/desktop），
  // ready 前改会换目录、找不到原密钥，已存的 API 密钥就解不开了；ready 后两者都已定下，只影响之后建的窗口。
  if (process.platform === 'linux') app.setName('deva')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 渲染层通知主进程：主题变化时同步原生标题栏控件配色。
  // 参数是渲染层算好的 symbolColor（Windows 用）；Linux 不吃 symbolColor，改按明暗换实色底。
  ipcMain.handle('window:set-overlay', (_evt, symbolColor: string) => {
    if (!mainWindow) return
    if (process.platform === 'win32') {
      mainWindow.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 40 })
    } else if (process.platform === 'linux') {
      const dark = symbolColor === OVERLAY_SYMBOL.dark
      mainWindow.setTitleBarOverlay({ color: dark ? OVERLAY_BG.dark : OVERLAY_BG.light, height: 40 })
    }
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-fullscreen', () => mainWindow?.isFullScreen() ?? false)
  ipcMain.handle('app:get-platform', () => process.platform)

  // 应用配置（~/.deva/config.json：主题/语言/模型等非敏感项，可 DEVA_HOME 覆盖）
  registerConfigIpc()

  // 工作区文件服务（打开文件夹 / 读目录 / 读写文件）
  registerWorkspaceIpc(() => mainWindow)

  // 密钥安全存储（safeStorage 加密，明文永不出主进程）
  registerSecretsIpc()

  // 服务商探针（拉取模型清单，复用密钥解密）
  registerProviderIpc()

  // 会话编排（Agent 主循环：流式 → 工具 → 权限 → 回灌）
  registerChatIpc(() => mainWindow)

  // 远程通道 / 手机端（飞书等 IM 机器人；默认关闭，需在设置里开启并配对）。订阅会话总线，须在 chat 之后。
  registerRemoteIpc(() => mainWindow)

  // 检查点清扫（异步不阻塞启动）：删已不存在会话的备份目录、超 30 天的 blob 与残留临时文件
  void sweepCheckpoints(listSessions().map((m) => m.id)).catch((e) =>
    console.warn('[checkpoints] 清扫失败：', e)
  )
  // 子智能体记录清扫：删掉已不存在会话的记录目录
  void sweepSubagents(listSessions().map((m) => m.id)).catch((e) =>
    console.warn('[subagents] 清扫失败：', e)
  )
  // 图片 / PDF blob 清扫：删掉已无任何对话或子智能体记录引用的文件
  void sweepMedia().catch((e) => console.warn('[media] 清扫失败：', e))

  // 技能（Skills，全局 ~/.deva/skills/*/SKILL.md；渐进式披露，启用态入 config.json）
  registerSkillsIpc(() => mainWindow)
  startSkillsWatcher(() => mainWindow)

  // Agent 提示词（Personas，全局 ~/.deva/personas/*.md；已启用者追加进主智能体系统提示词，启用态入 config.json）
  // 首启种子：逐条种入默认角色（Deva / 小码酱 …，见 default-personas.ts），对话优先外壳默认身份；
  // 按 id 幂等 + 防删除后复活 + 将来新增默认角色可增量补种（守卫位 personas.seeded[id] 入 config）。
  // 每次启动顺带检查默认提示词：升级后有新版、且用户没改过（基线 personas.seededPrompt[id]）→ 换成新版。
  ensureSeededPersonas()
  // 技能 / MCP 的可用角色里已不存在的角色：剔除，都没了的改回所有角色并停用（须在 MCP 自动连接之前）。
  pruneOrphanExtRoles()
  registerPersonasIpc()
  registerProfileIpc()
  registerMemoryIpc()

  // MCP 服务（全局 ~/.deva/mcp.json；主进程内起真实客户端，工具命名空间化后并入 Agent 工具表，默认 ask 过闸）
  registerMcpIpc(() => mainWindow)

  // 附加文件（原生选择框 + 白名单闸门，base64 只在主进程）
  registerAttachmentsIpc(() => mainWindow)

  // 集成终端（node-pty 跑在独立 Utility Process，主进程仅中继）
  registerTerminalIpc(() => mainWindow)

  // Git 源代码管理（调用系统 git，对标 VS Code；凭据交系统 GCM）
  registerGitIpc()

  // 系统剪贴板（原生 clipboard，供终端右键复制/粘贴——sandbox 下比 navigator.clipboard 可靠）
  registerClipboardIpc()

  // 交付卡（present_files）：文件信息与缩略图、用默认应用打开、在文件夹中显示（只作用于该对话里交付的文件）
  registerDeliverablesIpc()

  // 定时任务 / 自动任务（全局 ~/.deva/tasks.json；创建时批准、执行时零交互）。
  registerTasksIpc(() => mainWindow)

  // 检查更新（设置 → 关于；只在用户点按钮时检查，Windows exe 安装的可应用内下载并覆盖安装）
  registerUpdaterIpc(() => mainWindow)

  // 内置浏览器的登录窗口挂在主窗口上
  setMainWindowGetter(() => mainWindow)
  registerBrowserIpc()

  createWindow()

  // 自动连接已启用的全局 MCP 服务（各自失败降级，不阻塞启动）。
  autoConnectEnabledServers()

  // 启动定时任务调度器（30s tick；关窗/隐藏照常触发。幂等：activate 重建窗口会刷新窗口取用器）。
  startScheduler(() => mainWindow)

  // 系统托盘：关窗驻留后仍可唤起；「定时任务概览」直达 Tasks 标签。
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter((w) => !isBrowserHostWindow(w)).length === 0) createWindow()
  })
  })
}

// 退出前：有进行中的回合先拦下退出，中止它们并等收尾落盘（最多 3s）后再真正退出——
// 否则回合的 finally 来不及跑，这一轮已产出的内容会丢。随后断开全部 MCP 连接（清理 stdio
// 子进程，避免遗留孤儿进程）；并放行真正退出（关窗驻留托盘用）。
let turnsSettled = false
let settling = false
app.on('before-quit', (e) => {
  isQuitting = true
  if (!turnsSettled && hasActiveTurns()) {
    e.preventDefault()
    if (settling) return
    settling = true
    void settleActiveTurns(3000).finally(() => {
      turnsSettled = true
      app.quit()
    })
    return
  }
  void disconnectAllServers()
  void stopAllChannels()
  disposeAllPages()
})

// 全部窗口关闭即退出（非 macOS）。注意：关窗驻留托盘时窗口仅隐藏而未销毁，本事件不会触发；
// 仅当 closeToTray 关闭（窗口真正关闭）时才走到这里。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
