import { useEffect, useRef, useState } from 'react'

/**
 * 可左滑的列表行（同微信）：左滑露出右侧按钮，点别处或右滑收回；长按（电脑浏览器里右键）弹出操作面板。
 * 只接管横向拖动，竖向滚动交给浏览器（touch-action: pan-y）。点按一律走 click，拖动、长按之后的那次 click 拦掉。
 */

const LONG_PRESS_MS = 480
/** 手指移动超过这么多才算拖动（也就不再是点按 / 长按）。 */
const SLOP = 8

interface Gesture {
  x: number
  y: number
  id: number
  mode: 'idle' | 'h' | 'v'
  timer: number
}

export function SwipeRow({
  open,
  width,
  actions,
  onOpen,
  onClose,
  onTap,
  onLongPress,
  children
}: {
  open: boolean
  /** 右侧按钮的总宽度。 */
  width: number
  actions: React.ReactNode
  onOpen(): void
  onClose(): void
  onTap(): void
  onLongPress(): void
  children: React.ReactNode
}): React.JSX.Element {
  const [drag, setDrag] = useState<number | null>(null)
  const g = useRef<Gesture | null>(null)
  /** 刚拖动过 / 长按过：接下来那次 click 不算点按。 */
  const swallow = useRef(false)

  useEffect(() => () => window.clearTimeout(g.current?.timer), [])

  const base = open ? -width : 0
  const x = drag ?? base

  const longPress = (): void => {
    swallow.current = true
    onLongPress()
  }

  return (
    <div className="swipe">
      <div className="swipe__acts" style={{ width }} aria-hidden={!open}>
        {actions}
      </div>
      <div
        className={`swipe__row${drag !== null ? ' is-drag' : ''}`}
        style={{ transform: x ? `translateX(${x}px)` : undefined }}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => {
          swallow.current = false
          if (e.button !== 0) return
          window.clearTimeout(g.current?.timer)
          const timer = window.setTimeout(() => {
            if (g.current?.mode !== 'idle') return
            g.current = null
            navigator.vibrate?.(8)
            longPress()
          }, LONG_PRESS_MS)
          g.current = { x: e.clientX, y: e.clientY, id: e.pointerId, mode: 'idle', timer }
        }}
        onPointerMove={(e) => {
          const s = g.current
          if (!s || s.id !== e.pointerId) return
          const dx = e.clientX - s.x
          const dy = e.clientY - s.y
          if (s.mode === 'idle') {
            if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
            window.clearTimeout(s.timer)
            s.mode = Math.abs(dx) > Math.abs(dy) && (dx < 0 || open) ? 'h' : 'v'
            if (s.mode === 'h') {
              swallow.current = true
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* 指针已经抬起等：不捕获也能拖 */
              }
            }
          }
          if (s.mode === 'h') setDrag(Math.max(-width - 24, Math.min(0, base + dx)))
        }}
        onPointerUp={() => {
          const s = g.current
          if (!s) return
          window.clearTimeout(s.timer)
          g.current = null
          if (s.mode !== 'h') return
          setDrag(null)
          if (x < -width / 2) onOpen()
          else onClose()
        }}
        onPointerCancel={() => {
          window.clearTimeout(g.current?.timer)
          g.current = null
          setDrag(null)
        }}
        onClick={() => {
          if (swallow.current) {
            swallow.current = false
            return
          }
          if (open) onClose()
          else onTap()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onTap()
        }}
        onContextMenu={(e) => {
          // 电脑浏览器右键；安卓长按也会触发（这时计时器可能还没到点）。
          e.preventDefault()
          if (swallow.current) return
          window.clearTimeout(g.current?.timer)
          g.current = null
          longPress()
        }}
      >
        {children}
      </div>
    </div>
  )
}
