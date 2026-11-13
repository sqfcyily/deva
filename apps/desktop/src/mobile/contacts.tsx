import { useMemo, useState } from 'react'
import type { WebPersona } from '../shared/remote-web'
import { Avatar } from './avatar'
import { fmtListTime, type Store } from './App'
import { t } from './link'

/** 角色页（通讯录）：顶部固定入口，然后一行一个角色；已停用的灰显在最后。 */
export function Contacts({ store }: { store: Store }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const { enabled, disabled } = useMemo(() => {
    const all = [...store.personas.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    // 顺序与电脑端角色列表一致（用户自己排的），不另行排序。
    return { enabled: all.filter((p) => p.enabled), disabled: all.filter((p) => !p.enabled) }
  }, [store.personas, q])
  const taskCount = useMemo(() => [...store.sessions.values()].filter((s) => s.kind === 'task').length, [store.sessions])

  return (
    <>
      <header className="top">
        <h1 className="top__title">{t('tabContacts')}</h1>
      </header>
      <div className="search">
        <svg className="ic ic--s" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input id="persona-search" value={query} placeholder={t('search')} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="scroll">
        {!q && (
          <button className="entry" onClick={() => store.open({ tab: 'chats', tasks: true })}>
            <span className="entry__sq">
              <svg className="ic" viewBox="0 0 24 24">
                <circle cx="12" cy="13" r="8" />
                <path d="M12 9v4l2 2M5 3 2 6M19 3l3 3" />
              </svg>
            </span>
            <b>{t('tasks')}</b>
            <span className="entry__n">{taskCount}</span>
            <Chevron />
          </button>
        )}
        {enabled.length === 0 && disabled.length === 0 && <div className="empty">{t('noResult')}</div>}
        {enabled.map((p) => (
          <PersonaRow key={p.id} p={p} store={store} />
        ))}
        {disabled.length > 0 && <div className="idx">{t('disabled')}</div>}
        {disabled.map((p) => (
          <PersonaRow key={p.id} p={p} store={store} dim />
        ))}
      </div>
    </>
  )
}

function Chevron(): React.JSX.Element {
  return (
    <svg className="ic ic--s chev" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function PersonaRow({ p, store, dim }: { p: WebPersona; store: Store; dim?: boolean }): React.JSX.Element {
  const busy = useMemo(() => [...store.sessions.values()].some((s) => s.personaId === p.id && s.busy), [store.sessions, p.id])
  return (
    <button className={`ct${dim ? ' is-dim' : ''}`} onClick={() => store.open({ profile: p.id })}>
      <Avatar persona={p} size={40} busy={busy} />
      <span className="ct__who">
        <b>{p.name}</b>
        <span>{p.description}</span>
      </span>
      {busy && <span className="ct__st">{t('busy')}</span>}
    </button>
  )
}

/** 角色资料：简介、模型、最近对话，底部「发消息」（有对话就继续最近的，没有就新建）。 */
export function PersonaProfile({ store, personaId }: { store: Store; personaId: string }): React.JSX.Element {
  const p = store.personas.get(personaId)
  const [busy, setBusy] = useState(false)
  const chats = useMemo(
    () => [...store.sessions.values()].filter((s) => s.personaId === personaId).sort((a, b) => b.updatedAt - a.updatedAt),
    [store.sessions, personaId]
  )
  const create = async (): Promise<void> => {
    setBusy(true)
    const r = await store.link.newSession(personaId)
    setBusy(false)
    if (r.sid) store.open({ tab: 'chats', chat: r.sid })
    else store.toast(r.error ?? t('errorTitle'), false)
  }
  const model = p?.model ? p.model.slice(p.model.indexOf(':') + 1) : t('followDefault')
  return (
    <>
      <header className="top">
        <button className="iconbtn iconbtn--plain" aria-label="back" onClick={store.back}>
          <svg className="ic" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="top__title" />
      </header>
      <div className="scroll prof">
        <div className="prof__head">
          <Avatar persona={p} seed={personaId} size={72} />
          <div className="prof__who">
            <b>{p?.name ?? personaId}</b>
            <span>
              {t('model')} {model}
            </span>
            <span>{p?.avatarImage ? t('avatarCustom') : t('avatarAuto')}</span>
          </div>
        </div>
        {p?.description && <div className="prof__desc">{p.description}</div>}
        <div className="kvs">
          {chats.slice(0, 3).map((s, i) => (
            <button key={s.id} className="kvrow" onClick={() => store.open({ tab: 'chats', chat: s.id })}>
              <span className="k">{i === 0 ? t('recentChats') : ''}</span>
              <span className="v">
                {s.title} · {s.busy ? t('busy') : fmtListTime(s.updatedAt)}
                <Chevron />
              </span>
            </button>
          ))}
          <div className="kvrow">
            <span className="k">{t('allChats')}</span>
            <span className="v">{chats.length}</span>
          </div>
        </div>
        <div className="prof__foot">
          {chats[0] && (
            <button className="btn btn--ghost" onClick={() => store.open({ tab: 'chats', chat: chats[0].id })}>
              {t('continueLast')}
            </button>
          )}
          <button className="btn btn--primary" disabled={busy || !p?.enabled} onClick={() => void create()}>
            <svg className="ic" viewBox="0 0 24 24">
              <path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z" />
            </svg>
            {chats[0] ? t('newChat') : t('message')}
          </button>
        </div>
      </div>
    </>
  )
}
