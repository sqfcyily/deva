import { useMemo, useState } from 'react'
import type { WebSession } from '../shared/remote-web'
import { Avatar } from './avatar'
import { fmtListTime, type Store } from './App'
import { t } from './link'

/** 对话列表：正在处理、等你决定的置顶，其余按最近活动。右上角 + 弹出角色列表新建。 */
export function ChatList({ store, tasksOnly, onNew }: { store: Store; tasksOnly: boolean; onNew: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = useMemo(() => {
    const all = [...store.sessions.values()].filter((s) => (tasksOnly ? s.kind === 'task' : true))
    const rank = (s: WebSession): number => (s.waiting ? 0 : s.busy ? 1 : 2)
    all.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    return q ? all.filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q)) : all
  }, [store.sessions, tasksOnly, q])

  return (
    <>
      <header className="top">
        {tasksOnly && (
          <button className="iconbtn iconbtn--plain" aria-label="back" onClick={store.back}>
            <svg className="ic" viewBox="0 0 24 24">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <h1 className="top__title">{tasksOnly ? t('tasks') : t('tabChats')}</h1>
        {!tasksOnly && (
          <button className="iconbtn" aria-label={t('newChat')} title={t('newChat')} onClick={onNew}>
            <svg className="ic" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </header>
      <div className="search">
        <svg className="ic ic--s" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input id="chat-search" value={query} placeholder={t('search')} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="scroll">
        {list.length === 0 ? (
          <div className="empty">{q ? t('noResult') : t('chatsEmpty')}</div>
        ) : (
          <div className="rows">
            {list.map((s) => (
              <SessionRow key={s.id} s={s} store={store} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function SessionRow({ s, store }: { s: WebSession; store: Store }): React.JSX.Element {
  const persona = s.personaId ? store.personas.get(s.personaId) : undefined
  const unread = s.previewRole === 'assistant' && s.updatedAt > (store.seen.get(s.id) ?? 0)
  const preview = s.busy ? s.status ?? t('busy') : s.preview
  return (
    <button className="row" onClick={() => store.open({ chat: s.id })}>
      <Avatar persona={persona} seed={s.personaId} task={s.kind === 'task'} busy={s.busy} />
      <span className="row__main">
        <span className="row__t">
          <b>{s.title}</b>
          <time>{fmtListTime(s.updatedAt)}</time>
        </span>
        <span className="row__s">
          <span className="by">{s.kind === 'task' ? t('task') : persona?.name ?? 'Deva'}</span>
          <span className="pv">
            {!s.busy && s.previewRole === 'user' && preview ? t('me') : ''}
            {preview}
          </span>
          {s.waiting ? (
            <span className="tag tag--warn">{t('waiting')}</span>
          ) : s.busy ? (
            <span className="tag">{t('busy')}</span>
          ) : unread ? (
            <span className="unread" />
          ) : null}
        </span>
      </span>
    </button>
  )
}

/** 右上角 +：选一个角色，直接进入新对话。 */
export function NewChatSheet({ store, onClose }: { store: Store; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const personas = [...store.personas.values()].filter((p) => p.enabled)
  const pick = async (pid: string): Promise<void> => {
    setBusy(true)
    const r = await store.link.newSession(pid)
    setBusy(false)
    if (r.sid) store.open({ tab: 'chats', chat: r.sid })
    else {
      store.toast(r.error ?? t('errorTitle'), false)
      onClose()
    }
  }
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__title">
          <b>{t('newChat')}</b>
          <span>{t('pickPersona')}</span>
        </div>
        <div className="sheet__list">
          {personas.map((p) => (
            <button key={p.id} className="ct" disabled={busy} onClick={() => void pick(p.id)}>
              <Avatar persona={p} size={40} />
              <span className="ct__who">
                <b>{p.name}</b>
                <span>{p.description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
