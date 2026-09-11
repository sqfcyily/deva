/**
 * 系统剪贴板 IPC 桥（主进程侧）。
 *
 * 为什么走主进程：渲染层在 `sandbox:true` 且未设 permission handler 下，
 * `navigator.clipboard.readText()`（读）不可靠；此处用 Electron 原生 `clipboard`
 * 模块在主进程读写，经白名单 `deva.clipboard` 暴露，读/写都稳定。
 *
 * 仅接触纯文本；不落盘、不持久化——只是系统剪贴板的即时读写中继。
 * 典型用途：终端右键「有选中即复制、无选中即粘贴」（对标 Windows Terminal）。
 */
import { clipboard, ipcMain } from 'electron'

export function registerClipboardIpc(): void {
  // 读取剪贴板纯文本（无内容时 Electron 返回空串）。
  ipcMain.handle('clipboard:read-text', (): string => clipboard.readText())

  // 写入剪贴板纯文本。
  ipcMain.handle('clipboard:write-text', (_e, text: unknown): { ok: true } => {
    clipboard.writeText(typeof text === 'string' ? text : String(text))
    return { ok: true }
  })
}
