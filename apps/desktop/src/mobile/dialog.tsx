import { useEffect, useRef, useState } from 'react'
import { t } from './strings'

/**
 * 居中的小对话框（取代浏览器自带的 prompt / confirm：样式、深浅色与应用一致）。
 * 有 input 时是输入框（打开即聚焦并全选，回车提交，空的不能提交）；没有就是确认框。点遮罩 = 取消。
 */
export function Dialog({
  title,
  message,
  input,
  confirmLabel,
  danger,
  onConfirm,
  onCancel
}: {
  title: string
  message?: string
  input?: { value: string; placeholder?: string; maxLength?: number }
  confirmLabel: string
  danger?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(input?.value ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])
  const ok = !input || !!value.trim()
  const submit = (): void => {
    if (ok) onConfirm(value.trim())
  }
  return (
    <div className="dim dim--center" onClick={onCancel}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="dlg__k">
          <b>{title}</b>
          {message && <p>{message}</p>}
          {input && (
            <input
              ref={ref}
              className="dlg__in"
              value={value}
              placeholder={input.placeholder}
              maxLength={input.maxLength}
              enterKeyHint="done"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') onCancel()
              }}
            />
          )}
        </div>
        <div className="dlg__btns">
          <button onClick={onCancel}>{t('cancel')}</button>
          <button className={danger ? 'is-danger' : 'is-primary'} disabled={!ok} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
