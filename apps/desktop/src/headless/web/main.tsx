import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerAction } from '../../renderer/src/redesign/ComposerAction'
import '../../renderer/src/styles/tokens.css'
import '../../renderer/src/redesign/redesign.css'
import './web.css'

type Row = { id: string; title: string }
type Message = { role: 'user' | 'assistant'; text: string }
type View = Row & { messages: Message[]; revision: number; active: string | null }
type Index = { sessions: Row[]; model: string }
type Scope = { id?: string; read: number; reading?: boolean; sending?: boolean; stopping?: boolean }
type Preview = { id: string; messages: Message[]; reply: string }

const chinese = /^zh\b/i.test(navigator.language)
const t = (en: string, zh: string) => chinese ? zh : en
const sessionsPath = '/api/sessions'
const path = (id: string) => `${sessionsPath}/${encodeURIComponent(id)}`
const selectedKey = 'deva.selected-session'
const encoder = new TextEncoder()
const maxMessageBytes = 8 * 1024 // Headless service text limit, measured after trimming.
function selection(id?: string | null) {
  try {
    if (id === undefined) return sessionStorage.getItem(selectedKey)
    if (id) sessionStorage.setItem(selectedKey, id)
    else sessionStorage.removeItem(selectedKey)
  } catch { /* Storage is optional. */ }
  return null
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
async function request(url: string, body?: object, signal?: AbortSignal) {
  const res = await fetch(url, {
    signal, cache: 'no-store', credentials: 'same-origin', redirect: 'error',
    ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  if (!res.ok) {
    const error = (await res.json().catch(() => null))?.error
    throw new HttpError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`)
  }
  return res
}
const expired = (error: unknown) => error instanceof HttpError && error.status === 401
const reason = (error: unknown) => error instanceof HttpError ? error.message : t('Connection or response error.', '连接或响应异常。')
async function readTurn(res: Response, delta: (text: string) => void) {
  const reader = res.headers.get('content-type')?.startsWith('application/x-ndjson') && res.body?.getReader()
  if (reader) {
    const decoder = new TextDecoder()
    let tail = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        const lines = (tail + decoder.decode(value, { stream: !done })).split('\n')
        tail = done ? '' : lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event?.type === 'delta' && typeof event.text === 'string') delta(event.text)
          else if (event?.type === 'done' && (event.reason === 'complete' || event.reason === 'stopped')) return event.reason
          else if (event?.type === 'error' && typeof event.error === 'string') throw new HttpError(200, event.error)
          else throw new Error('Invalid NDJSON event')
        }
        if (done) break
      }
    } finally { void reader.cancel().catch(() => {}) }
  }
  throw new Error('Missing terminal event')
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')
}

function App() {
  const [index, setIndex] = useState<Index | null>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const busy = useRef(false)
  async function open(token?: string) {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    setError('')
    try {
      if (token !== undefined) {
        await request('/api/login', { token })
        token = undefined
        setIndex(undefined)
      }
      setIndex(await (await request(sessionsPath)).json())
    } catch (cause) {
      if (expired(cause)) setIndex(null)
      if (token !== undefined) setError(t('Sign-in failed. Check the token and try again.', '登录失败，请核对令牌后重试。'))
      else if (!expired(cause)) setError(reason(cause))
    } finally { busy.current = false; setLoading(false) }
  }
  useEffect(() => { void open() }, [])
  if (index) return <Chat initial={index} signOut={() => setIndex(null)} />
  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const token = String(new FormData(form).get('token') ?? '')
    form.reset()
    if (token) void open(token)
  }
  return <main className="web-login"><h1>Deva</h1>
    {index === null ? <form onSubmit={login}>
      <label htmlFor="token">{t('Access token', '访问令牌')}</label>
      <input id="token" name="token" type="password" autoComplete="off" required data-testid="login-token" />
      <ComposerAction type="submit" label={loading ? t('Signing in…', '登录中…') : t('Sign in', '登录')} disabled={loading} data-testid="login" />
    </form> : loading ? <p role="status">{t('Loading…', '载入中…')}</p> :
      <button className="web-secondary" onClick={() => void open()}>{t('Retry', '重试')}</button>}
    {error && <p role="alert">{error}</p>}
  </main>
}

function Chat({ initial, signOut }: { initial: Index; signOut: () => void }) {
  const [index, setIndex] = useState(initial)
  const [view, setView] = useState<View | null>(null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [working, setWorking] = useState(false)
  const [reading, setReading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [navigation, setNavigation] = useState<'new' | 'logout' | ''>('')
  const nav = useRef(false)
  const scope = useRef<Scope>({ read: 0 })
  const [life] = useState(() => new AbortController())
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const current = (s: Scope) => scope.current === s && !life.signal.aborted
  const get = async <T,>(url: string, body?: object): Promise<T> => (await request(url, body, life.signal)).json()
  function saved(s: Scope, next: View) {
    s.id = next.id
    selection(next.id)
    setView(next)
    const row = { id: next.id, title: next.title }
    setIndex((prev) => ({ ...prev, sessions: prev.sessions.some((v) => v.id === row.id)
      ? prev.sessions.map((v) => v.id === row.id ? row : v) : [row, ...prev.sessions] }))
  }
  async function sync(s: Scope, note = '') {
    if (!s.id) return
    const serial = ++s.read
    s.reading = true
    setReading(true)
    try {
      const next = await get<View>(path(s.id))
      if (current(s) && s.read === serial) { saved(s, next); setNotice(note) }
    } catch (error) {
      if (expired(error) && !life.signal.aborted) signOut()
      else if (current(s) && s.read === serial) { setView(null); setNotice([note, reason(error)].filter(Boolean).join(' ')) }
    } finally {
      if (current(s) && s.read === serial) { s.reading = false; setReading(false) }
    }
  }
  function select(id?: string) {
    const s = scope.current = { id, read: 0 }
    selection(id ?? null)
    follow.current = true
    setView(null); setDraft(''); setNotice(''); setPreview(null); setWorking(false); setReading(false); setStopping(false)
    if (id) void sync(s)
    return s
  }
  useEffect(() => {
    const id = selection()
    if (initial.sessions.some((row) => row.id === id)) select(id!)
    return () => life.abort()
  }, [])
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [view, preview])
  async function navigate(kind: 'new' | 'logout') {
    if (nav.current) return
    nav.current = true
    setNavigation(kind)
    const s = scope.current
    setNotice('')
    try {
      if (kind === 'logout') { await get('/api/logout', {}); selection(null); signOut() }
      else { const next = await get<View>(sessionsPath, {}); if (current(s)) saved(select(), next) }
    } catch (error) {
      if (expired(error) && !life.signal.aborted) signOut()
      else if (current(s)) {
        setNotice(reason(error))
        if (kind === 'new') {
          const next = await get<Index>(sessionsPath).catch((cause: unknown) => {
            if (expired(cause) && !life.signal.aborted) signOut()
          })
          if (next && current(s)) setIndex(next)
        }
      }
    } finally { nav.current = false; setNavigation('') }
  }
  const text = draft.trim(), overLimit = encoder.encode(text).length > maxMessageBytes
  async function send() {
    const s = scope.current
    if (!view || s.id !== view.id || s.sending || s.stopping || s.reading || nav.current || view.active || !text || overLimit || !index.model) return
    s.sending = true
    setWorking(true); setNotice(''); setDraft('')
    follow.current = true
    let note = '', accepted = false
    try {
      const turnId = uuid()
      const res = await request(`${path(view.id)}/turns`, { text, revision: view.revision, turnId }, life.signal)
      accepted = true
      if (current(s)) setPreview({ id: turnId, messages: [...view.messages, { role: 'user', text }], reply: '' })
      const result = await readTurn(res, (part) => {
        if (current(s)) setPreview((prev) => prev && { ...prev, reply: prev.reply + part })
      })
      if (result === 'stopped') note = t('Reply stopped.', '回复已停止。')
    } catch (error) {
      if (expired(error) && !life.signal.aborted) { signOut(); return }
      if (!(error instanceof HttpError) || accepted || error.status >= 500) note = t('Reply interrupted. Check the saved history.', '回复中断，请查看已保存的记录。')
      if (error instanceof HttpError) note = `${note} ${error.message}`.trim()
      if (current(s) && !accepted && error instanceof HttpError && error.status >= 400 && error.status < 500) setDraft(draft)
    }
    if (current(s)) {
      await sync(s, note)
      if (current(s)) { s.sending = false; setPreview(null); setWorking(false) }
    }
  }
  const active = preview?.id ?? view?.active
  async function stop() {
    const s = scope.current
    if (!s.id || !active || s.stopping || nav.current) return
    s.stopping = true
    setStopping(true)
    let note = t('Stop requested.', '已请求停止。'), failed = false
    try { await get(`${path(s.id)}/stop`, { turnId: active }) }
    catch (error) {
      if (expired(error) && !life.signal.aborted) { signOut(); return }
      note = reason(error)
      failed = true
    }
    if (current(s)) {
      if (s.sending && !failed) setNotice(note)
      else await sync(s, note)
      if (current(s)) { s.stopping = false; setStopping(false) }
    }
  }
  const id = scope.current.id
  const messages = preview ? [...preview.messages, ...(preview.reply ? [{ role: 'assistant', text: preview.reply } as const] : [])] : view?.messages ?? []
  return <div className="cf-shell web-chat">
    <aside className="cf-rail" aria-label={t('Sessions', '会话')}>
      <header className="cf-rail__top"><strong>Deva</strong><button className="web-secondary" data-testid="new-session" disabled={!!navigation}
        onClick={() => void navigate('new')}>{navigation === 'new' ? t('Creating…', '新建中…') : t('+ New', '＋ 新建')}</button></header>
      <nav className="cf-list" aria-label={t('Session history', '会话历史')}>{index.sessions.map((row) =>
        <button type="button" key={row.id} className={`cf-thread${id === row.id ? ' is-active' : ''}`} aria-current={id === row.id || undefined}
          data-testid="session-row" disabled={!!navigation} onClick={() => { if (!nav.current && id !== row.id) select(row.id) }}>{row.title}</button>)}</nav>
    </aside>
    <main className="cf-conv">
      <header className="cf-conv__head"><h1>{view?.title || t('Chat', '对话')}</h1>
        {id && <button className="web-secondary" disabled={reading || working || !!navigation} onClick={() => void sync(scope.current)}>{t('Refresh', '刷新')}</button>}
        <button className="web-secondary" data-testid="logout" disabled={!!navigation} onClick={() => void navigate('logout')}>
          {navigation === 'logout' ? t('Signing out…', '退出中…') : t('Sign out', '退出')}</button></header>
      <div className="cf-msgs" ref={scroll} onScroll={(e) => {
        const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
      }}><div className="cf-msgs__inner">
        {!messages.length && <p className="web-muted">{reading ? t('Loading…', '载入中…') : view ? t('Send a message to begin.', '发送消息以开始对话。') : !id ? t('Select a session or create a new one.', '选择会话或新建会话。') : ''}</p>}
        {messages.map(({ role, text }, n) => <article className={`cf-msg${role === 'user' ? ' is-user' : ''}`} data-testid="message" data-role={role} key={n}>
          <div className="cf-msg__body"><div className="cf-msg__head"><span className="cf-msg__name">{role === 'user' ? t('You', '你') : 'Deva'}</span></div>
            <div className="cf-msg__text">{text}</div></div></article>)}
      </div></div>
      <div className="cf-composer"><div className="cf-composer__inner">
        {notice && <p className="web-notice" role="status">{notice}</p>}
        {(view || preview) && <form className="cf-box" onSubmit={(e) => { e.preventDefault(); void send() }}>
          <textarea aria-label={t('Message', '消息')} placeholder={t('Message Deva', '给 Deva 发消息')} data-testid="composer" value={draft}
            readOnly={working || !!navigation} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send() }
            }} />
          <div className="cf-box__bar"><span className="web-muted">{active || working ? t('Reply in progress…', '正在回复…') :
            overLimit ? t('Message exceeds 8 KiB.', '消息超过 8 KiB。') : index.model || t('No model configured on the server.', '服务端尚未配置模型。')}</span>
            {active ? <ComposerAction stop label={t('Stop', '停止')} data-testid="stop" disabled={stopping || !!navigation} onClick={() => void stop()} /> :
              <ComposerAction type="submit" label={t('Send', '发送')} data-testid="send" disabled={working || reading || stopping || !!navigation || !text || overLimit || !index.model} />}</div>
        </form>}
      </div></div>
    </main>
  </div>
}

const theme = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => { document.documentElement.dataset.theme = theme.matches ? 'dark' : 'light' }
document.documentElement.lang = chinese ? 'zh-CN' : 'en'
applyTheme()
theme.addEventListener('change', applyTheme)
createRoot(document.getElementById('root')!).render(<App />)
