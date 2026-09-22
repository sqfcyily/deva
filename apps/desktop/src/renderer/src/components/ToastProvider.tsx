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

export type ToastVariant = 'default' | 'success' | 'error'

export interface ToastOptions {
  title?: string
  message?: ReactNode
  variant?: ToastVariant
  /** 自动消失毫秒；默认 3500，传 0 则不自动消失（仅手动关闭）。 */
  duration?: number
}

interface ToastApi {
  /** 弹出一条 toast（右下角浮层，自动堆叠、到时自动消失）。 */
  show: (opts: ToastOptions) => void
}

interface ToastItem extends ToastOptions {
  id: number
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * 全局轻量 toast 服务：非阻断的右下角浮层提示，取代成功场景下的确认框（用户无需点「关闭」）。
 * 命令式 API（useToast().show），可堆叠、到时自动消失，亦可手动关闭；与 DialogProvider 同挂根部。
 * 破坏性 / 需用户抉择的仍走 useDialog；toast 仅用于「已完成 / 已开始」这类知会性反馈。
 */
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const seq = useRef(0)

  const dismiss = useCallback((id: number): void => {
    setItems((prev) => prev.filter((x) => x.id !== id))
    const tm = timers.current.get(id)
    if (tm) {
      clearTimeout(tm)
      timers.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (opts: ToastOptions): void => {
      const id = ++seq.current
      setItems((prev) => [...prev, { id, ...opts }])
      const duration = opts.duration ?? 3500
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration))
    },
    [dismiss]
  )

  // 卸载时清空所有待触发定时器（防泄漏 / StrictMode 双挂）。
  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((tm) => clearTimeout(tm))
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
              <ToastCard key={it.id} item={it} onClose={() => dismiss(it.id)} />
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
  onClose
}: {
  item: ToastItem
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const variant = item.variant ?? 'default'
  const Icon = variant === 'success' ? CheckCircle2 : variant === 'error' ? AlertTriangle : Info
  return (
    <div className={`toast toast--${variant}`} role="status" aria-live="polite">
      <span className="toast__icon">
        <Icon size={18} />
      </span>
      <div className="toast__body">
        {item.title && <div className="toast__title">{item.title}</div>}
        {item.message != null && <div className="toast__msg">{item.message}</div>}
      </div>
      <button className="toast__close" title={t('common.close')} onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  )
}
