import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  open: boolean
  /** 请求关闭（点击遮罩 / 按 Esc）。由调用方决定关闭语义（通常等价于取消）。 */
  onClose: () => void
  /** 卡片宽度（px），默认 420。 */
  width?: number
  /** 关联标题元素 id，供无障碍读屏。 */
  labelledBy?: string
  children: ReactNode
}

/**
 * 居中模态基座：Portal 挂到 body、半透明遮罩、圆角卡片、入场动画。
 * 仅负责「容器 + 关闭交互」，内容（标题/正文/按钮）由上层组合。
 * 主题通过 :root 上的 CSS 变量级联，Portal 到 body 同样生效，无需额外处理。
 */
export function Modal({
  open,
  onClose,
  width = 420,
  labelledBy,
  children
}: ModalProps): React.JSX.Element | null {
  // 捕获阶段拦截 Esc：抢在各功能面板自己的 Esc 处理之前关闭本模态。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="modal__backdrop"
      // 用 mousedown 且校验 target，避免「卡片内按下、拖到遮罩松开」误触关闭。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="modal__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={{ width }}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
