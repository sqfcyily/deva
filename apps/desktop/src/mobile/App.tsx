import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebItem } from '../shared/remote-web'
import type { ActionValue } from '../shared/remote-views'
import { Link, t, type LinkState, type Snapshot } from './link'
import { ItemView, Markdown } from './cards'

/**
 * 手机网页端主界面：像聊天软件一样的一列消息 + 底部输入框。
 * 记录由电脑端保存，每次连上整段同步（见 link.ts）；本地只维护一份数组，按 id 覆盖 / 删除。
 */

type Toast = { id: number; text: string; ok: boolean }

export function App(): React.JSX.Element {
  const [state, setState] = useState<LinkState>({ kind: 'connecting' })
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [items, setItems] = useState<WebItem[]>([])
  const [typing, setTyping] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const linkRef = useRef<Link | null>(null)

  const toast = useCallback((text: string, ok = true) => {
    const id = Date.now() + Math.random()
    setToasts((l) => [...l, { id, text, ok }])
    window.setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 2600)
  }, [])

  useEffect(() => {
    const link = new Link({
      onState: setState,
      onSnapshot: (s) => {
        setSnap(s)
        setItems(s.items)
        setTyping(s.typing)
      },
      onItem: (item) =>
        setItems((list) => {
          const i = list.findIndex((x) => x.id === item.id)
          if (i >= 0) {
            const next = list.slice()
            next[i] = item
            return next
          }
          return [...list, item]
        }),
      onRemove: (id) => setItems((list) => list.filter((x) => x.id !== id)),
      onTyping: setTyping,
      onSent: () => undefined
    })
    linkRef.current = link
    link.start()
    return () => {
      link.stop()
      linkRef.current = null
    }
  }, [])

  const send = useCallback((text: string) => {
    const body = text.trim()
    if (!body || !linkRef.current) return false
    linkRef.current.sendText(body)
    return true
  }, [])

  const act = useCallback(
    async (id: string, value: ActionValue, form?: Record<string, string | string[]>) => {
      const link = linkRef.current
      if (!link) return
      const r = await link.action(id, value, form)
      toast(r.message, r.ok)
    },
    [toast]
  )

  const viaRelay = linkRef.current?.viaRelay ?? false
  const ready = state.kind === 'ready'

  return (
    <div className="app">
      <header className="top">
        <div className="top__name">{snap?.bot.name ?? 'Deva'}</div>
        <div className={`top__state is-${state.kind}`}>
          <span className="dot" />
          {state.kind === 'ready' ? t('ready') : state.kind === 'offline' ? t('offline') : state.kind === 'connecting' ? t('connecting') : state.kind === 'pair' ? '' : t('errorTitle')}
        </div>
      </header>

      {state.kind === 'pair' ? (
        <PairScreen message={state.message} onSubmit={(code) => linkRef.current?.pair(code)} />
      ) : (
        <>
          <Timeline items={items} typing={typing} onAction={act} />
          {state.kind === 'offline' && (
            <div className="banner is-offline">
              <b>{t('offline')}</b>
              <span>{t('offlineHint')}</span>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="banner is-error">
              <b>{t('errorTitle')}</b>
              <span>{state.message}</span>
            </div>
          )}
          {state.kind === 'connecting' && snap && <div className="banner">{t('disconnected')}</div>}
          <Composer disabled={!ready} onSend={send} viaRelay={viaRelay} />
        </>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast${x.ok ? '' : ' is-error'}`}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function PairScreen({ message, onSubmit }: { message?: string; onSubmit: (code: string) => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const valid = /^\d{6}$/.test(code)
  return (
    <form
      className="pair"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit(code)
      }}
    >
      <div className="pair__logo">D</div>
      <h1 className="pair__title">{t('pairTitle')}</h1>
      <p className="pair__lead">{t('pairLead')}</p>
      <input
        className="pair__input"
        inputMode="numeric"
        pattern="\d*"
        maxLength={6}
        autoComplete="one-time-code"
        placeholder={t('pairPlaceholder')}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      {message && <div className="pair__error">{message}</div>}
      <button className="btn btn--primary pair__btn" type="submit" disabled={!valid}>
        {t('pairSubmit')}
      </button>
    </form>
  )
}

/** 相邻两条相隔超过这个时长就插一行时间。 */
const TIME_GAP_MS = 5 * 60_000

function Timeline({
  items,
  typing,
  onAction
}: {
  items: WebItem[]
  typing: boolean
  onAction: (id: string, value: ActionValue, form?: Record<string, string | string[]>) => Promise<void>
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 用户没有往上翻时，新消息来了自动贴底。
  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const lastId = items[items.length - 1]?.id
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastId, typing, items])

  const rows = useMemo(() => {
    const out: { item: WebItem; time?: string }[] = []
    let prev = 0
    for (const item of items) {
      const gap = item.at - prev > TIME_GAP_MS
      out.push({ item, time: gap ? fmtTime(item.at) : undefined })
      prev = item.at
    }
    return out
  }, [items])

  return (
    <div className="timeline" ref={ref} onScroll={onScroll}>
      {items.length === 0 && !typing && <div className="empty">{t('empty')}</div>}
      {rows.map(({ item, time }) => (
        <div key={item.id} className={`row row--${item.kind}`}>
          {time && <div className="time">{time}</div>}
          <ItemView item={item} onAction={onAction} />
        </div>
      ))}
      {typing && (
        <div className="row row--reply">
          <div className="bubble bubble--typing" aria-label={t('typing')}>
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      <div className="timeline__pad" />
    </div>
  )
}

function fmtTime(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? hm : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`
}

const QUICK: { label: () => string; cmd: string }[] = [
  { label: () => t('cmdNew'), cmd: '/new' },
  { label: () => t('cmdList'), cmd: '/list' },
  { label: () => t('cmdStop'), cmd: '/stop' },
  { label: () => t('cmdStatus'), cmd: '/status' }
]

function Composer({
  disabled,
  onSend
}: {
  disabled: boolean
  onSend: (text: string) => boolean
  viaRelay: boolean
}): React.JSX.Element {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)

  // 输入框随内容长高（最多约 6 行）。
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const submit = (): void => {
    if (disabled) return
    if (onSend(text)) setText('')
  }

  return (
    <div className="composer">
      <div className="quick">
        {QUICK.map((q) => (
          <button key={q.cmd} className="chip" disabled={disabled} onClick={() => onSend(q.cmd)}>
            {q.label()}
          </button>
        ))}
      </div>
      <div className="composer__row">
        <textarea
          ref={ta}
          className="composer__input"
          rows={1}
          placeholder={t('composer')}
          value={text}
          disabled={disabled}
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 桌面浏览器里 Enter 发送、Shift+Enter 换行；手机键盘的 Enter 通常是换行，用按钮发。
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="composer__send" disabled={disabled || !text.trim()} onClick={submit} aria-label={t('send')}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path d="M3 11.5 20 4l-4 16-4.5-6.5L3 11.5z" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export { Markdown }
