import { useEffect, useRef, useState } from 'react'

/**
 * 可拖动尺寸（左侧对话面板宽 / 输入框高）：拖拽手柄 + 上下限 + 落盘。
 * 持久化走 ~/.deva/config.json 的 `layout` 段（与主题/语言同处，getSync 首帧即可读到、不闪烁）；
 * config.set 是顶层浅合并，故写入时先合并现有 layout，两个尺寸互不覆盖。
 */

export interface Layout {
  /** 左侧对话面板宽（px）；缺省 = 默认宽。 */
  sidebarWidth?: number
  /** 输入框高度（px，文本区固定高、内容溢出框内滚动）；缺省 = COMPOSER_DEFAULT。 */
  composerHeight?: number
}

export const SIDEBAR_DEFAULT = 300
export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 480
/** 图标栏宽（与 .cf-body 首列一致）。 */
const ICONRAIL_W = 56
/** 右侧主区至少留出的宽度：窗口窄时面板上限随之收缩，不把对话区挤没。 */
const MAIN_MIN = 480

export const COMPOSER_MIN = 44
export const COMPOSER_DEFAULT = 80
export const COMPOSER_MAX = 400
/** 输入框最多占窗口高度的比例：窗口矮时上限随之收缩，消息区总能露出来。 */
const COMPOSER_MAX_RATIO = 0.45

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** 按当前窗口宽夹取面板宽：下限优先（极窄窗口宁可主区更窄，也不让面板小于下限）。 */
export function clampSidebar(w: number, viewportW: number): number {
  const hi = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewportW - ICONRAIL_W - MAIN_MIN))
  return clamp(Math.round(w), SIDEBAR_MIN, hi)
}

/** 按当前窗口高夹取输入框高：下限优先。 */
export function clampComposer(h: number, viewportH: number): number {
  const hi = Math.max(COMPOSER_MIN, Math.min(COMPOSER_MAX, Math.floor(viewportH * COMPOSER_MAX_RATIO)))
  return clamp(Math.round(h), COMPOSER_MIN, hi)
}

export function loadLayout(): Layout {
  try {
    const l = window.deva.config.getSync().layout
    return l && typeof l === 'object' ? (l as Layout) : {}
  } catch {
    return {}
  }
}

/** 写入一项尺寸；值为 undefined 即删除该项（恢复默认）。 */
export function saveLayout(patch: Layout): void {
  const next: Record<string, unknown> = { ...loadLayout(), ...patch }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
  void window.deva.config.set({ layout: next })
}

/** 窗口尺寸（resize 时刷新），供按窗口收缩上限。 */
export function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const on = (): void => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return vp
}

/**
 * 拖拽手柄。axis=x：向右拖变大；axis=y：向上拖变大（手柄在输入区顶边）。
 * 拖动中每帧回调 onChange（调用方负责夹取），松手 onCommit 落盘；双击 onReset 恢复默认。
 * 用 pointer capture：拖出手柄 / 越过 iframe 等元素也不会丢失事件。
 */
export function ResizeHandle({
  axis,
  value,
  onChange,
  onCommit,
  onReset,
  className,
  style,
  title
}: {
  axis: 'x' | 'y'
  value: number
  onChange: (v: number) => void
  onCommit: () => void
  onReset: () => void
  className?: string
  style?: React.CSSProperties
  title?: string
}): React.JSX.Element {
  const drag = useRef<{ start: number; base: number } | null>(null)
  const [active, setActive] = useState(false)

  // 拖动期间全局光标与禁选：鼠标移出手柄时光标不跳回箭头，也不会顺手选中一大片文字。
  useEffect(() => {
    if (!active) return
    const cls = axis === 'x' ? 'cf-resizing-x' : 'cf-resizing-y'
    document.body.classList.add(cls)
    return () => document.body.classList.remove(cls)
  }, [active, axis])

  return (
    <div
      className={`cf-resizer cf-resizer--${axis}${active ? ' is-active' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      title={title}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { start: axis === 'x' ? e.clientX : e.clientY, base: value }
        setActive(true)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const delta = (axis === 'x' ? e.clientX : e.clientY) - d.start
        onChange(axis === 'x' ? d.base + delta : d.base - delta)
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        setActive(false)
        onCommit()
      }}
      onPointerCancel={() => {
        drag.current = null
        setActive(false)
      }}
      onDoubleClick={onReset}
    />
  )
}
