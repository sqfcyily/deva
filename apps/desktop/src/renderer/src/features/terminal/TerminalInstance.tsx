import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '../../theme/ThemeContext'
import { DARK_THEME, LIGHT_THEME, xtermBg } from './xtermTheme'

/**
 * 单个集成终端：xterm.js 前端，经 window.deva.terminal.* 连到跑在 Utility Process
 * 里的 node-pty（真实 PTY）。由 BottomPanel 多路复用，一个页签一个实例。
 *
 * 生命周期（v1）：随实例挂载建 PTY、卸载即 dispose。非活动页签用 CSS 隐藏但保持
 * 挂载（PTY 存活、滚动历史保留）；重新可见时再 fit。进程退出经 onExit 上抛，由
 * 父组件移除该页签。cwd 由父组件按「该终端所属项目」传入（挂载时定格），无项目则
 * 主进程回退到用户主目录——隐藏保活的实例属于它自己的项目，故不能读全局活动项目。
 */
interface Props {
  /** 渲染层页签 id（用于 onExit 回传，非 PTY id）。 */
  id: string
  /** 选定的 shell 配置 id；空则用主进程默认 shell。 */
  shellId: string | null
  /** 该终端所属项目根路径；null 则主进程回退到用户主目录（挂载时定格）。 */
  cwd: string | null
  /** 是否为当前活动页签（隐藏页签仍挂载）。 */
  visible: boolean
  /** PTY 退出时回调（父组件据此移除页签）。 */
  onExit: (id: string) => void
}

export function TerminalInstance({ id, shellId, cwd, visible, onExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const disposedRef = useRef(false)

  const { resolved } = useTheme()

  // cwd 在挂载时定格（创建 PTY 只用一次）；onExit 可能每次 render 变，故用 ref 读最新值。
  const cwdRef = useRef<string | null>(cwd)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

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

    // PTY → 终端：按自身 ptyId 过滤（多实例共享同一组事件）。
    const offData = window.deva.terminal.onData(({ id: ptyId, data }) => {
      if (ptyId === ptyIdRef.current) term.write(data)
    })
    const offExit = window.deva.terminal.onExit(({ id: ptyId }) => {
      if (ptyId !== ptyIdRef.current) return
      ptyIdRef.current = null
      onExitRef.current(id) // 上抛给父组件移除页签（其卸载会 dispose）
    })

    // 终端 → PTY：键入转发。
    term.onData((d) => {
      if (ptyIdRef.current) window.deva.terminal.write(ptyIdRef.current, d)
    })

    // 右键（对标 Windows Terminal）：有选中→复制并取消选中；无选中→粘贴剪贴板文本；
    // 剪贴板为空则不动作。始终吞掉默认浏览器菜单。
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) {
        const sel = term.getSelection()
        if (sel) void window.deva.clipboard.writeText(sel)
        term.clearSelection()
        return
      }
      void window.deva.clipboard.readText().then((text) => {
        if (text) term.paste(text) // paste 会触发 onData → 转发给 PTY
      })
    }
    container.addEventListener('contextmenu', onContextMenu)

    // 首帧布局就绪后再 fit，并按实际行列创建 PTY。
    const raf = requestAnimationFrame(() => {
      if (disposedRef.current) return
      try {
        fit.fit()
      } catch {
        /* 容器尚无尺寸时忽略 */
      }
      void window.deva.terminal
        .create({ cols: term.cols, rows: term.rows, cwd: cwdRef.current, shellId })
        .then(({ id: ptyId }) => {
          if (disposedRef.current) {
            window.deva.terminal.dispose(ptyId)
            return
          }
          ptyIdRef.current = ptyId
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
      if (ptyIdRef.current) window.deva.terminal.resize(ptyIdRef.current, term.cols, term.rows)
    })
    ro.observe(container)

    return () => {
      disposedRef.current = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      container.removeEventListener('contextmenu', onContextMenu)
      offData()
      offExit()
      if (ptyIdRef.current) window.deva.terminal.dispose(ptyIdRef.current)
      ptyIdRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 仅挂载一次；主题/可见性由下方独立 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 变为可见：xterm 在 display:none 下测不到尺寸，重新可见须再 fit + 同步 PTY + 聚焦。
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* 忽略 */
      }
      if (ptyIdRef.current) window.deva.terminal.resize(ptyIdRef.current, term.cols, term.rows)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [visible])

  // 主题热切换：更新配色，不重建终端（保留会话与滚动历史）。
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolved === 'dark' ? DARK_THEME : LIGHT_THEME
  }, [resolved])

  return (
    <div
      className={`term-instance${visible ? '' : ' is-hidden'}`}
      ref={containerRef}
      style={{ background: xtermBg(resolved) }}
    />
  )
}
