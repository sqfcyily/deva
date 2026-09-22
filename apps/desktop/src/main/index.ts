import { app, shell, BrowserWindow, ipcMain, nativeTheme, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getConfig, registerConfigIpc } from './services/config'
import { getAppIcon } from './services/tray-icon'
import { registerWorkspaceIpc } from './services/workspace'
import { registerSecretsIpc } from './services/secrets'
import { registerProviderIpc } from './services/provider'
import { registerChatIpc } from './services/chat'
import { registerSkillsIpc } from './services/skills'
import { registerAgentsIpc } from './services/agents'
import { ensureSeededPersonas, registerPersonasIpc } from './services/personas'
import {
  autoConnectEnabledServers,
  disconnectAllServers,
  registerMcpIpc
} from './services/mcp'
import { registerAttachmentsIpc } from './services/attachments'
import { registerTerminalIpc } from './services/terminal'
import { registerGitIpc } from './services/git'
import { registerClipboardIpc } from './services/clipboard'
import { registerTasksIpc } from './services/tasks'
import { startScheduler } from './services/scheduler'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
/** 关窗驻留托盘时，真正退出由此标志放行（before-quit / 托盘「退出」置 true）。 */
let isQuitting = false

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
    // 无边框 + 原生窗口控件叠加，做出干净的自定义顶栏（Windows / macOS）
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: '#00000000',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e4e4e7' : '#3a3a3d',
            height: 40
          }
        : undefined,
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 安全基线：见 docs/architecture/security.md
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

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
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 建系统托盘（幂等）：图标运行期生成（tray-icon.ts，无二进制资产）。
 * 菜单——显示 Deva / 定时任务概览〔直达 Tasks 标签〕/ 退出；左键切换窗口可见。
 * 菜单文案按启动时 config.locale 取中/英（运行时改语言需重启方更新，可接受）。
 */
function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(getAppIcon())
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
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.sqfcy.deva')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 渲染层通知主进程：主题变化时同步原生标题栏控件配色
  ipcMain.handle('window:set-overlay', (_evt, symbolColor: string) => {
    if (process.platform === 'win32' && mainWindow) {
      mainWindow.setTitleBarOverlay({ color: '#00000000', symbolColor, height: 40 })
    }
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('app:get-platform', () => process.platform)

  // 应用配置（~/.deva/config.json：主题/语言/模型等非敏感项，可 DEVA_HOME 覆盖）
  registerConfigIpc()

  // 工作区文件服务（打开文件夹 / 读目录 / 读写文件）
  registerWorkspaceIpc(() => mainWindow)

  // 密钥安全存储（safeStorage 加密，明文永不出主进程）
  registerSecretsIpc()

  // 服务商探针（连通性测试 / 拉取模型清单，复用密钥解密）
  registerProviderIpc()

  // 会话编排（Agent 主循环：流式 → 工具 → 权限 → 回灌）
  registerChatIpc(() => mainWindow)

  // 技能（Skills，全局 ~/.deva/skills/*/SKILL.md；渐进式披露，启用态入 config.json）
  registerSkillsIpc(() => mainWindow)

  // 子智能体（Subagents，全局 ~/.deva/agents/*.md；run_subagent 进程内递归派生，启用态入 config.json）
  registerAgentsIpc()

  // Agent 提示词（Personas，全局 ~/.deva/personas/*.md；已启用者追加进主智能体系统提示词，启用态入 config.json）
  // 首启种子：逐条种入默认角色（Deva / 小码酱 …，见 default-personas.ts），对话优先外壳默认身份；
  // 按 id 幂等 + 防删除后复活 + 将来新增默认角色可增量补种（守卫位 personas.seeded[id] 入 config）。
  ensureSeededPersonas()
  registerPersonasIpc()

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

  // 定时任务 / 自动任务（全局 ~/.deva/tasks.json；创建时批准、执行时零交互）。
  registerTasksIpc(() => mainWindow)

  createWindow()

  // 自动连接已启用的全局 MCP 服务（各自失败降级，不阻塞启动）。
  autoConnectEnabledServers()

  // 启动定时任务调度器（30s tick；关窗/隐藏照常触发。幂等：activate 重建窗口会刷新窗口取用器）。
  startScheduler(() => mainWindow)

  // 系统托盘：关窗驻留后仍可唤起；「定时任务概览」直达 Tasks 标签。
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  })
}

// 退出前断开全部 MCP 连接（清理 stdio 子进程，避免遗留孤儿进程）；并放行真正退出（关窗驻留托盘用）。
app.on('before-quit', () => {
  isQuitting = true
  void disconnectAllServers()
})

// 全部窗口关闭即退出（非 macOS）。注意：关窗驻留托盘时窗口仅隐藏而未销毁，本事件不会触发；
// 仅当 closeToTray 关闭（窗口真正关闭）时才走到这里。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
