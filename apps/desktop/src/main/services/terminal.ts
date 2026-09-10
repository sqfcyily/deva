/**
 * 终端 IPC 桥（主进程侧）。
 *
 * 职责：fork 一个持有 node-pty 的 Utility Process（见 pty-host.ts），在
 * 渲染层 ↔ Utility Process 之间中继消息。主进程本身不加载原生模块。
 *
 * 通道：
 *   渲染层 → 主：terminal:create（invoke，回 {id}）/ input / resize / dispose（send）
 *   主 → 渲染层：terminal:data / terminal:exit（webContents.send）
 *
 * 生命周期：Utility Process 惰性单例，首次 create 时 fork；整体退出时给所有
 * 活跃会话补发 exit 并清空，下次 create 再重启（refork）。
 */
import { BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { detectShells, resolveShell } from './shells'

/** 渲染层传入的建终端参数（结构化复述，与 preload 对齐）。 */
interface CreateOptions {
  cols: number
  rows: number
  cwd: string | null
  shellId?: string | null
}

/** 宿主 → 主 的出站消息（与 pty-host.ts 的 OutboundMessage 对齐）。 */
type HostMessage =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; error?: string }

export function registerTerminalIpc(getWindow: () => BrowserWindow | null): void {
  let child: UtilityProcess | null = null
  let ready = false
  let seq = 0
  const activeIds = new Set<string>()
  const pending: Record<string, unknown>[] = []

  /** 把待发消息冲刷给 Utility Process；未就绪时留在 pending，spawn 后再发。 */
  function flush(): void {
    if (!child || !ready) return
    for (const m of pending) child.postMessage(m)
    pending.length = 0
  }

  function send(msg: Record<string, unknown>): void {
    pending.push(msg)
    flush()
  }

  function ensureChild(): void {
    if (child) return
    ready = false
    const host = utilityProcess.fork(join(__dirname, 'pty-host.js'))
    child = host

    // Utility Process 起来后再冲刷排队消息，避免早发丢失（MessagePort 就绪前）。
    host.on('spawn', () => {
      ready = true
      flush()
    })

    host.on('message', (msg: HostMessage) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      if (msg?.type === 'data') {
        win.webContents.send('terminal:data', { id: msg.id, data: msg.data })
      } else if (msg?.type === 'exit') {
        activeIds.delete(msg.id)
        win.webContents.send('terminal:exit', { id: msg.id, exitCode: msg.exitCode })
      }
    })

    // 宿主整体退出（崩溃/被杀）：给所有活跃会话补发 exit，复位状态以便下次重启。
    host.on('exit', () => {
      const win = getWindow()
      for (const id of activeIds) {
        win?.webContents.send('terminal:exit', { id, exitCode: -1 })
      }
      activeIds.clear()
      pending.length = 0
      child = null
      ready = false
    })
  }

  // 已装 shell 清单：只回 id/label/isDefault，绝对路径与 args 留在主进程。
  ipcMain.handle('terminal:list-shells', () =>
    detectShells().map(({ id, label, isDefault }) => ({ id, label, isDefault }))
  )

  ipcMain.handle('terminal:create', (_evt, opts: CreateOptions): { id: string } => {
    ensureChild()
    const id = `t${++seq}`
    activeIds.add(id)
    const { path: shellPath, args: shellArgs } = resolveShell(opts.shellId ?? null)
    send({ type: 'create', id, cols: opts.cols, rows: opts.rows, cwd: opts.cwd, shellPath, shellArgs })
    return { id }
  })

  ipcMain.on('terminal:input', (_evt, id: string, data: string) => {
    send({ type: 'input', id, data })
  })

  ipcMain.on('terminal:resize', (_evt, id: string, cols: number, rows: number) => {
    send({ type: 'resize', id, cols, rows })
  })

  ipcMain.on('terminal:dispose', (_evt, id: string) => {
    activeIds.delete(id)
    send({ type: 'dispose', id })
  })
}
