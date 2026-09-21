import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { Modal } from './Modal'
import { useI18n } from '../i18n/i18n'

export interface ConfirmOptions {
  title?: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  /** danger 用于删除 / 丢弃等破坏性操作，确认按钮渲染为红色。 */
  variant?: 'default' | 'danger'
}

export interface PromptOptions {
  title?: string
  message?: ReactNode
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
  /** 校验输入是否可提交；默认要求去空格后非空。 */
  validate?: (value: string) => boolean
}

interface DialogApi {
  /** 居中确认框。resolve(true) 确认、resolve(false) 取消。 */
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  /** 居中单行输入框。resolve(去空格后的值) 确认、resolve(null) 取消。 */
  prompt: (opts: PromptOptions) => Promise<string | null>
}

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }

const DialogContext = createContext<DialogApi | null>(null)
const TITLE_ID = 'deva-dialog-title'

/**
 * 全局对话框服务：以命令式 API 取代原生 window.confirm / 各处自绘输入框，
 * 统一走居中模态、复用现有 .btn/.input 与设计 token，保证明暗主题一致。
 * 同一时刻仅一个对话框（用户驱动、不会叠加）。
 */
export function DialogProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [req, setReq] = useState<Request | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setReq({ kind: 'confirm', opts, resolve })),
    []
  )
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => setReq({ kind: 'prompt', opts, resolve })),
    []
  )

  const api = useMemo<DialogApi>(() => ({ confirm, prompt }), [confirm, prompt])

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req?.kind === 'confirm' && (
        <ConfirmView
          req={req}
          onDone={(v) => {
            req.resolve(v)
            setReq(null)
          }}
        />
      )}
      {req?.kind === 'prompt' && (
        <PromptView
          req={req}
          onDone={(v) => {
            req.resolve(v)
            setReq(null)
          }}
        />
      )}
    </DialogContext.Provider>
  )
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return ctx
}

function ConfirmView({
  req,
  onDone
}: {
  req: Extract<Request, { kind: 'confirm' }>
  onDone: (v: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { opts } = req
  return (
    <Modal open onClose={() => onDone(false)} labelledBy={opts.title ? TITLE_ID : undefined}>
      {opts.title && (
        <h2 id={TITLE_ID} className="modal__title">
          {opts.title}
        </h2>
      )}
      {opts.message != null && <div className="modal__body">{opts.message}</div>}
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={() => onDone(false)}>
          {opts.cancelText ?? t('common.cancel')}
        </button>
        <button
          className={`btn ${opts.variant === 'danger' ? 'btn--danger' : 'btn--primary'}`}
          autoFocus
          onClick={() => onDone(true)}
        >
          {opts.confirmText ?? t('common.confirm')}
        </button>
      </div>
    </Modal>
  )
}

function PromptView({
  req,
  onDone
}: {
  req: Extract<Request, { kind: 'prompt' }>
  onDone: (v: string | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { opts } = req
  const [value, setValue] = useState(opts.defaultValue ?? '')
  const valid = opts.validate ? opts.validate(value) : value.trim().length > 0
  return (
    <Modal open onClose={() => onDone(null)} labelledBy={opts.title ? TITLE_ID : undefined}>
      {opts.title && (
        <h2 id={TITLE_ID} className="modal__title">
          {opts.title}
        </h2>
      )}
      {opts.message != null && <div className="modal__body">{opts.message}</div>}
      <div className="modal__field">
        {opts.label && <label className="modal__label">{opts.label}</label>}
        <input
          className="input"
          autoFocus
          placeholder={opts.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) onDone(value.trim())
          }}
        />
      </div>
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={() => onDone(null)}>
          {opts.cancelText ?? t('common.cancel')}
        </button>
        <button className="btn btn--primary" disabled={!valid} onClick={() => onDone(value.trim())}>
          {opts.confirmText ?? t('common.confirm')}
        </button>
      </div>
    </Modal>
  )
}
