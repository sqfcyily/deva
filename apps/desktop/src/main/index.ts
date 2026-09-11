import { app, shell, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerConfigIpc } from './services/config'
import { registerWorkspaceIpc } from './services/workspace'
import { registerSecretsIpc } from './services/secrets'
import { registerProviderIpc } from './services/provider'
import { registerChatIpc } from './services/chat'
import { registerSkillsIpc } from './services/skills'
import { registerAgentsIpc } from './services/agents'
import {
  autoConnectEnabledServers,
  disconnectAllServers,
  registerMcpIpc
} from './services/mcp'
import { registerAttachmentsIpc } from './services/attachments'
import { registerPermissionsIpc } from './services/permissions'
import { registerTerminalIpc } from './services/terminal'
import { registerGitIpc } from './services/git'
import { registerClipboardIpc } from './services/clipboard'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
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

  // 外链一律走系统浏览器，且拦截应用内导航
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

  // MCP 服务（全局 ~/.deva/mcp.json；主进程内起真实客户端，工具命名空间化后并入 Agent 工具表，默认 ask 过闸）
  registerMcpIpc(() => mainWindow)

  // 附加文件（原生选择框 + 白名单闸门，base64 只在主进程）
  registerAttachmentsIpc(() => mainWindow)

  // 权限模式（按项目，集中存于 ~/.deva/permissions.json）
  registerPermissionsIpc()

  // 集成终端（node-pty 跑在独立 Utility Process，主进程仅中继）
  registerTerminalIpc(() => mainWindow)

  // Git 源代码管理（调用系统 git，对标 VS Code；凭据交系统 GCM）
  registerGitIpc()

  // 系统剪贴板（原生 clipboard，供终端右键复制/粘贴——sandbox 下比 navigator.clipboard 可靠）
  registerClipboardIpc()

  createWindow()

  // 自动连接已启用的全局 MCP 服务（各自失败降级，不阻塞启动）。
  autoConnectEnabledServers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前断开全部 MCP 连接（清理 stdio 子进程，避免遗留孤儿进程）。
app.on('before-quit', () => {
  void disconnectAllServers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
