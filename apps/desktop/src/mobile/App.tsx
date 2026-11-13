import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WebMessage, WebNotice, WebPersona, WebPrompt, WebSession } from '../shared/remote-web'
import type { ActionValue } from '../shared/remote-views'
import { Link, t, type Hello, type LinkState } from './link'
import { ChatList, NewChatSheet } from './chats'
import { Contacts, PersonaProfile } from './contacts'
import { ChatPage } from './chat'
import { MeTab } from './me'

/**
 * 手机网页端：三个 tab（对话 / 角色 / 我）的 IM 形态。对话与角色列表来自电脑端，按帧增量更新；
 * 打开某个对话时按需拉历史。页面内导航用一层「栈」：列表 → 对话 / 角色资料，配合 history 让系统返回键可用。
 */

export type Tab = 'chats' | 'contacts' | 'me'

export interface Route {
  tab: Tab
  /** 打开的对话。 */
  chat?: string
  /** 打开的角色资料。 */
  profile?: string
  /** 只看定时任务的对话列表（从通讯录的入口进来）。 */
  tasks?: boolean
}

type Toast = { id: number; text: string; ok: boolean }

export interface Store {
  link: Link
  sessions: Map<string, WebSession>
  personas: Map<string, WebPersona>
  prompts: Map<string, WebPrompt>
  seen: Map<string, number>
  markSeen(sid: string): void
  act(key: string, value: ActionValue, form?: Record<string, string | string[]>): Promise<void>
  open(r: Partial<Route>): void
  back(): void
  toast(text: string, ok?: boolean): void
}

const SEEN_KEY = `deva.web.seen:${location.host}`

function loadSeen(): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

export function App(): React.JSX.Element {
  const [state, setState] = useState<LinkState>({ kind: 'connecting' })
  const [hello, setHello] = useState<Hello | null>(null)
  const [sessions, setSessions] = useState<Map<string, WebSession>>(new Map())
  const [personas, setPersonas] = useState<Map<string, WebPersona>>(new Map())
  const [prompts, setPrompts] = useState<Map<string, WebPrompt>>(new Map())
  const [seen, setSeen] = useState<Map<string, number>>(loadSeen)
  const [route, setRoute] = useState<Route>({ tab: 'chats' })
  const [sheet, setSheet] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [notices, setNotices] = useState<WebNotice[]>([])
  const [hist, setHist] = useState<Map<string, { messages: WebMessage[]; start: number; total: number }>>(new Map())
  const linkRef = useRef<Link | null>(null)
  const routeRef = useRef(route)
  routeRef.current = route
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const toast = useCallback((text: string, ok = true) => {
    const id = Date.now() + Math.random()
    setToasts((l) => [...l, { id, text, ok }])
    window.setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 2600)
  }, [])

  // 系统通知：回复完成 / 需要你决定时，页面不在前台才弹。
  const notify = useCallback((title: string, body: string) => {
    try {
      if (localStorage.getItem('deva.web.notify') !== '1') return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      if (document.visibilityState === 'visible') return
      new Notification(title, { body, tag: title })
    } catch {
      /* 不支持通知 */
    }
  }, [])

  useEffect(() => {
    const link = new Link({
      onState: setState,
      onHello: (h) => {
        setHello(h)
        setSessions(new Map(h.sessions.map((s) => [s.id, s])))
        setPrompts(new Map(h.prompts.map((p) => [p.view.key, p])))
      },
      onSessions: (list) => setSessions(new Map(list.map((s) => [s.id, s]))),
      onSession: (s) =>
        setSessions((m) => {
          const prev = m.get(s.id)
          const next = new Map(m)
          next.set(s.id, s)
          if (prev?.busy && !s.busy) notify(s.title, s.preview)
          if (!prev?.waiting && s.waiting) notify(s.title, t('waiting'))
          return next
        }),
      onSessionGone: (sid) =>
        setSessions((m) => {
          const next = new Map(m)
          next.delete(sid)
          return next
        }),
      onPersonas: (list) => setPersonas(new Map(list.map((p) => [p.id, p]))),
      onHistory: (sid, messages, start, total) =>
        setHist((m) => {
          const next = new Map(m)
          const cur = m.get(sid)
          // 往前翻页：拼到前面；否则（最新一页）整段覆盖尾部，保留已有的更早部分。
          if (cur && start + messages.length <= cur.start) next.set(sid, { messages: [...messages, ...cur.messages], start, total })
          else if (cur && cur.start < start) {
            const keep = cur.messages.filter((x) => Number(x.id) < start)
            next.set(sid, { messages: [...keep, ...messages], start: cur.start, total })
          } else next.set(sid, { messages, start, total })
          return next
        }),
      onPrompt: (p) =>
        setPrompts((m) => {
          const next = new Map(m)
          if (p.view.state === 'open') next.set(p.view.key, p)
          else {
            next.set(p.view.key, p)
            // 已决议的卡片留一会儿让人看到结果，然后收起。
            window.setTimeout(
              () =>
                setPrompts((m2) => {
                  if (m2.get(p.view.key)?.view.state === 'open') return m2
                  const n2 = new Map(m2)
                  n2.delete(p.view.key)
                  return n2
                }),
              4000
            )
          }
          return next
        }),
      onNotice: (n) => {
        setNotices((l) => [...l.slice(-19), n])
        notify(n.title ?? 'Deva', n.text)
        if (!n.sessionId || routeRef.current.chat !== n.sessionId) toast(n.title ? `${n.title}：${n.text}` : n.text, n.tone !== 'error')
      }
    })
    linkRef.current = link
    link.start()
    return () => {
      link.stop()
      linkRef.current = null
    }
  }, [notify, toast])

  // 系统返回键：出栈。
  useEffect(() => {
    const onPop = (): void => setRoute((r) => (r.chat || r.profile || r.tasks ? { tab: r.tab } : r))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = useCallback((r: Partial<Route>) => {
    setRoute((cur) => {
      const next: Route = { tab: r.tab ?? cur.tab, chat: r.chat, profile: r.profile, tasks: r.tasks }
      if (next.chat || next.profile || next.tasks) history.pushState({ deva: 1 }, '')
      return next
    })
    setSheet(false)
  }, [])

  const back = useCallback(() => {
    if (history.state?.deva) history.back()
    else setRoute((r) => ({ tab: r.tab }))
  }, [])

  const markSeen = useCallback((sid: string) => {
    const s = sessionsRef.current.get(sid)
    const at = s?.updatedAt ?? Date.now()
    setSeen((m) => {
      if ((m.get(sid) ?? 0) >= at) return m
      const next = new Map(m)
      next.set(sid, at)
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(next)))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const act = useCallback(
    async (key: string, value: ActionValue, form?: Record<string, string | string[]>) => {
      const link = linkRef.current
      if (!link) return
      const r = await link.action(key, value, form)
      toast(r.message, r.ok)
    },
    [toast]
  )

  const store = useMemo<Store | null>(
    () =>
      linkRef.current
        ? { link: linkRef.current, sessions, personas, prompts, seen, markSeen, act, open, back, toast }
        : null,
    [sessions, personas, prompts, seen, markSeen, act, open, back, toast]
  )

  if (state.kind === 'pair') return <PairScreen message={state.message} onSubmit={(code) => linkRef.current?.pair(code)} />
  if (!store || !hello)
    return (
      <div className="app">
        <div className="splash">
          <div className="splash__logo">D</div>
          <div className="muted">{state.kind === 'error' ? state.message : state.kind === 'offline' ? t('offline') : t('connecting')}</div>
          {state.kind === 'offline' && <div className="muted small">{t('offlineHint')}</div>}
        </div>
      </div>
    )

  const banner =
    state.kind === 'offline' ? (
      <div className="banner is-offline">
        <b>{t('offline')}</b>
        <span>{t('offlineHint')}</span>
      </div>
    ) : state.kind === 'error' ? (
      <div className="banner is-error">
        <b>{t('errorTitle')}</b>
        <span>{state.message}</span>
      </div>
    ) : state.kind === 'connecting' ? (
      <div className="banner">{t('disconnected')}</div>
    ) : null

  let page: React.JSX.Element
  if (route.chat) {
    const s = sessions.get(route.chat)
    page = (
      <ChatPage
        store={store}
        sid={route.chat}
        session={s}
        history={hist.get(route.chat)}
        ready={state.kind === 'ready'}
        banner={banner}
      />
    )
  } else if (route.profile) {
    page = <PersonaProfile store={store} personaId={route.profile} />
  } else {
    const body =
      route.tab === 'chats' || route.tasks ? (
        <ChatList store={store} tasksOnly={!!route.tasks} onNew={() => setSheet(true)} />
      ) : route.tab === 'contacts' ? (
        <Contacts store={store} />
      ) : (
        <MeTab store={store} hello={hello} state={state} notices={notices} />
      )
    page = (
      <>
        {body}
        {banner}
        <nav className="tabs">
          {(['chats', 'contacts', 'me'] as Tab[]).map((tab) => (
            <button key={tab} className={`tab${route.tab === tab ? ' is-on' : ''}`} onClick={() => setRoute({ tab })}>
              <TabIcon tab={tab} />
              {t(tab === 'chats' ? 'tabChats' : tab === 'contacts' ? 'tabContacts' : 'tabMe')}
              {tab === 'chats' && <Badge sessions={sessions} seen={seen} />}
            </button>
          ))}
        </nav>
      </>
    )
  }

  return (
    <div className="app">
      {page}
      {sheet && <NewChatSheet store={store} onClose={() => setSheet(false)} />}
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

function Badge({ sessions, seen }: { sessions: Map<string, WebSession>; seen: Map<string, number> }): React.JSX.Element | null {
  let n = 0
  for (const s of sessions.values()) if (s.waiting || (s.updatedAt > (seen.get(s.id) ?? 0) && s.previewRole === 'assistant')) n++
  return n ? <span className="badge">{n > 99 ? '99+' : n}</span> : null
}

function TabIcon({ tab }: { tab: Tab }): React.JSX.Element {
  if (tab === 'chats')
    return (
      <svg className="ic" viewBox="0 0 24 24">
        <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />
      </svg>
    )
  if (tab === 'contacts')
    return (
      <svg className="ic" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="4" />
        <path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7" />
      </svg>
    )
  return (
    <svg className="ic" viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  )
}

function PairScreen({ message, onSubmit }: { message?: string; onSubmit: (code: string) => void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const valid = /^\d{6}$/.test(code)
  return (
    <div className="app">
      <form
        className="pair"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) onSubmit(code)
        }}
      >
        <div className="splash__logo">D</div>
        <h1 className="pair__title">{t('pairTitle')}</h1>
        <p className="pair__lead">{t('pairLead')}</p>
        <input
          id="pair-code"
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
    </div>
  )
}

/** 列表里的时间：今天只显示时分，昨天写「昨天」，更早写月日。 */
export function fmtListTime(at: number): string {
  const d = new Date(at)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('yesterday')
  return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
