import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspace } from '../../store/workspace'
import { useTheme } from '../../theme/ThemeContext'
import { useI18n } from '../../i18n/i18n'

/**
 * 集成终端视图：xterm.js 前端，经 window.deva.terminal.* 连到跑在
 * Utility Process 里的 node-pty（真实 PTY）。
 *
 * 生命周期（v1）：随底部面板「终端」标签挂载/卸载；卸载即 dispose 对应 PTY，
 * 重开是全新终端（无 scrollback 恢复）。cwd 取当前项目根，无项目则由主进程回退到用户主目录。
 */

// 明/暗两套配色，贴合应用主题 token（背景与暗色主背景 #1e1e20 对齐）。
const DARK_THEME: ITheme = {
  background: '#1e1e20',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#1e1e20',
  selectionBackground: '#3a3d41',
  black: '#1e1e20',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#f5f543',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#e5e5e5',
  brightBlack: '#7a7a7a',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff'
}

const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1e1e20',
  cursor: '#1e1e20',
  cursorAccent: '#ffffff',
  selectionBackground: '#c8dcf5',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#000000'
}

export function TerminalView(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const disposedRef = useRef(false)

  const { activeProject } = useWorkspace()
  const { resolved } = useTheme()
  const { t } = useI18n()

  // cwd 与退出文案在挂载时定格（effect 仅跑一次），故用 ref 读最新值。
  const cwdRef = useRef<string | null>(activeProject?.path ?? null)
  const exitLabelRef = useRef<string>(t('panel.terminalExited'))
  useEffect(() => {
    cwdRef.current = activeProject?.path ?? null
  }, [activeProject])
  useEffect(() => {
    exitLabelRef.current = t('panel.terminalExited')
  }, [t])

  // 挂载：建终端 → 连 PTY → 双向桥接 → 尺寸自适应。仅一次。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    disposedRef.current = false
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: resolved === 'dark' ? DARK_THEME : LIGHT_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // PTY → 终端：按 id 过滤（本视图仅一个会话）。
    const offData = window.deva.terminal.onData(({ id, data }) => {
      if (id === idRef.current) term.write(data)
    })
    const offExit = window.deva.terminal.onExit(({ id, exitCode }) => {
      if (id !== idRef.current) return
      term.write(`\r\n\x1b[90m[${exitLabelRef.current} ${exitCode}]\x1b[0m\r\n`)
      idRef.current = null
    })

    // 终端 → PTY：键入转发。
    term.onData((d) => {
      if (idRef.current) window.deva.terminal.write(idRef.current, d)
    })

    // 首帧布局就绪后再 fit，并按实际行列创建 PTY。
    const raf = requestAnimationFrame(() => {
      if (disposedRef.current) return
      try {
        fit.fit()
      } catch {
        /* 容器尚无尺寸时忽略 */
      }
      void window.deva.terminal
        .create({ cols: term.cols, rows: term.rows, cwd: cwdRef.current })
        .then(({ id }) => {
          if (disposedRef.current) {
            window.deva.terminal.dispose(id)
            return
          }
          idRef.current = id
          term.focus()
        })
    })

    // 容器尺寸变化 → 重新 fit 并同步 PTY 尺寸。
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* 忽略 */
      }
      if (idRef.current) window.deva.terminal.resize(idRef.current, term.cols, term.rows)
    })
    ro.observe(container)

    return () => {
      disposedRef.current = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      offData()
      offExit()
      if (idRef.current) window.deva.terminal.dispose(idRef.current)
      idRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 仅挂载一次；主题变化由下方独立 effect 热更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题热切换：更新配色，不重建终端（保留会话与滚动历史）。
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolved === 'dark' ? DARK_THEME : LIGHT_THEME
  }, [resolved])

  return (
    <div
      className="terminal"
      ref={containerRef}
      style={{ background: resolved === 'dark' ? DARK_THEME.background : LIGHT_THEME.background }}
    />
  )
}
