import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { useI18n } from '../i18n/i18n'

export type ToastVariant = 'default' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  title?: string
  message?: ReactNode
  variant?: ToastVariant
  /** 自动消失毫秒；默认 3500（带 action 时 8000，留足点击时间），传 0 则不自动消失（仅手动关闭）。 */
  duration?: number
  /** 行内操作按钮（如「撤销」）：点击后执行 onClick 并关闭该 toast。 */
  action?: { label: string; onClick: () => void }
}

interface ToastApi {
  /** 弹出一条 toast（右上角、窗口控件下方的浮层，自动堆叠、到时自动消失）。 */
  show: (opts: ToastOptions) => void
}

interface ToastItem extends ToastOptions {
  id: number
}

/** 单条 toast 的自动消失计时：handle 为空 = 已暂停（鼠标悬停中），remaining 为暂停时剩余毫秒。 */
interface ToastTimer {
  handle?: ReturnType<typeof setTimeout>
  remaining: number
  startedAt: number
}

/** 移出后至少再停留这么久，免得刚把鼠标挪开就消失。 */
const RESUME_MIN_MS = 1000

const ToastContext = createContext<ToastApi | null>(null)

/**
 * 全局轻量 toast 服务：非阻断的右上角浮层提示（让开窗口控件；右下角会压住对话输入框），取代成功场景下的确认框（用户无需点「关闭」）。
 * 命令式 API（useToast().show），可堆叠、到时自动消失，亦可手动关闭；与 DialogProvider 同挂根部。
 * 破坏性 / 需用户抉择的仍走 useDialog；toast 仅用于「已完成 / 已开始」这类知会性反馈。
 */
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ToastTimer>())
  const seq = useRef(0)

  const dismiss = useCallback((id: number): void => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    const tm = timers.current.get(id)
    if (tm) {
      clearTimeout(tm.handle)
      timers.current.delete(id)
    }
  }, [])

  const arm = useCallback(
    (id: number, ms: number): void => {
      timers.current.set(id, {
        handle: setTimeout(() => dismiss(id), ms),
        remaining: ms,
        startedAt: Date.now()
      })
    },
    [dismiss]
  )

  const show = useCallback(
    (opts: ToastOptions): void => {
      const id = ++seq.current
      setItems((prev) => [...prev, { id, ...opts }])
      const duration = opts.duration ?? (opts.action ? 8000 : 3500)
      if (duration > 0) arm(id, duration)
    },
    [arm]
  )

  // 悬停暂停：鼠标移入时停表、记下剩余时间；移出后按剩余时间续上（duration=0 的无计时条目不受影响）。
  const pause = useCallback((id: number): void => {
    const tm = timers.current.get(id)
    if (!tm?.handle) return
    clearTimeout(tm.handle)
    tm.handle = undefined
    tm.remaining -= Date.now() - tm.startedAt
  }, [])
  const resume = useCallback(
    (id: number): void => {
      const tm = timers.current.get(id)
      if (!tm || tm.handle) return
      arm(id, Math.max(tm.remaining, RESUME_MIN_MS))
    },
    [arm]
  )

  // 卸载时清空所有待触发定时器（防泄漏 / StrictMode 双挂）。
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((tm) => clearTimeout(tm.handle))
      map.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {items.length > 0 &&
        createPortal(
          <div className="toast-layer">
            {items.map((it) => (
              <ToastCard
                key={it.id}
                item={it}
                onClose={() => dismiss(it.id)}
                onPause={() => pause(it.id)}
                onResume={() => resume(it.id)}
              />
            ))}
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内使用')
  return ctx
}

function ToastCard({
  item,
  onClose,
  onPause,
  onResume
}: {
  item: ToastItem
  onClose: () => void
  onPause: () => void
  onResume: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const variant = item.variant ?? 'default'
  const Icon =
    variant === 'success'
      ? CheckCircle2
      : variant === 'warning' || variant === 'error'
        ? AlertTriangle
        : Info
  return (
    <div
      className={`toast toast--${variant}`}
      role="status"
      aria-live="polite"
      onMouseEnter={onPause}
      onMouseLeave={onResume}
    >
      <span className="toast__icon">
        <Icon size={18} />
      </span>
      <div className="toast__body">
        {item.title && <div className="toast__title">{item.title}</div>}
        {item.message != null && <div className="toast__msg">{item.message}</div>}
      </div>
      {item.action && (
        <button
          className="toast__action"
          onClick={() => {
            item.action?.onClick()
            onClose()
          }}
        >
          {item.action.label}
        </button>
      )}
      <button className="toast__close" title={t('common.close')} onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  )
}
