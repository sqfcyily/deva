import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebMessage, WebSession } from '../shared/remote-web'
import { Avatar } from './avatar'
import { Markdown, PromptCard } from './cards'
import type { Store } from './App'
import { t } from './link'

/**
 * 对话页：和电脑上同一个对话。历史按页拉取（最新一页，往上翻更早）；对话摘要一变（回合结束 / 发了消息）
 * 就重新拉最新一页合并进来。进行中显示输入指示和一行「正在做什么」；需要你决定的卡片贴在最下面。
 */
export function ChatPage({
  store,
  sid,
  session,
  history,
  ready,
  banner
}: {
  store: Store
  sid: string
  session?: WebSession
  history?: { messages: WebMessage[]; start: number; total: number }
  ready: boolean
  banner: React.ReactNode
}): React.JSX.Element {
  const { link } = store
  const persona = session?.personaId ? store.personas.get(session.personaId) : undefined
  const prompts = useMemo(
    () => [...store.prompts.values()].filter((p) => p.view.sessionId === sid).sort((a, b) => a.at - b.at),
    [store.prompts, sid]
  )
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  // 进入 / 对话有更新：拉最新一页；看过的记为已读。
  const updatedAt = session?.updatedAt ?? 0
  useEffect(() => {
    if (ready) link.history(sid)
  }, [link, sid, ready, updatedAt])
  useEffect(() => {
    store.markSeen(sid)
  }, [store, sid, updatedAt])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }
  const count = history?.messages.length ?? 0
  const lastId = history?.messages[count - 1]?.id
  const busy = session?.busy ?? false
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastId, count, busy, prompts.length])

  // 输入框随内容长高（最多约 6 行）。
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || sending || !ready) return
    setSending(true)
    const r = await link.sendText(sid, body)
    setSending(false)
    if (r.ok) {
      setText('')
      stick.current = true
      if (r.message) store.toast(r.message)
      link.history(sid)
    } else store.toast(r.message ?? t('errorTitle'), false)
  }

  const statusText = session?.waiting ? t('waiting') : session?.busy ? session.status ?? t('busy') : t('idle')

  return (
    <>
      <header className="top top--chat">
        <button className="iconbtn iconbtn--plain" aria-label="back" onClick={store.back}>
          <svg className="ic" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <Avatar persona={persona} seed={session?.personaId} task={session?.kind === 'task'} busy={busy} size={32} />
        <div className="top__who">
          <b>{session?.title ?? ''}</b>
          <span>
            <span className={`dot${session?.waiting ? ' dot--warn' : busy ? ' dot--busy' : ''}`} />
            {session?.kind === 'task' ? t('task') : persona?.name ?? 'Deva'} · {statusText}
          </span>
        </div>
      </header>
      <div className="scroll msgs" ref={listRef} onScroll={onScroll}>
        {history && history.start > 0 && (
          <button className="linkbtn linkbtn--center" onClick={() => link.history(sid, history.start)}>
            {t('loadMore')}
          </button>
        )}
        {history && history.total === 0 && !busy && <div className="empty">{t('chatEmpty')}</div>}
        {history?.messages.map((m) => <MessageView key={m.id} m={m} persona={persona} store={store} seed={session?.personaId} task={session?.kind === 'task'} />)}
        {prompts.map((p) => (
          <div key={p.view.key} className="m m--card">
            <PromptCard view={p.view} onAction={store.act} />
          </div>
        ))}
        {busy && !session?.waiting && (
          <div className="m">
            <Avatar persona={persona} seed={session?.personaId} task={session?.kind === 'task'} size={28} />
            <div className="bubble bubble--typing" aria-label={t('busy')}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {busy && session?.status && !session.waiting && <div className="steps">{session.status}</div>}
        <div className="msgs__pad" />
      </div>
      {banner}
      <div className="composer">
        <textarea
          id="composer"
          ref={ta}
          className="composer__input"
          rows={1}
          placeholder={busy ? t('composerBusy') : t('composer')}
          value={text}
          disabled={!ready}
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 桌面浏览器里 Enter 发送、Shift+Enter 换行；手机键盘的 Enter 通常是换行，用按钮发。
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy && !text.trim() ? (
          <button className="composer__send is-stop" disabled={!ready} onClick={() => link.stopTurn(sid)} aria-label={t('stop')}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button className="composer__send" disabled={!ready || sending || !text.trim()} onClick={() => void send()} aria-label={t('send')}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
              <path d="M3 11.5 20 4l-4 16-4.5-6.5L3 11.5z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
    </>
  )
}

function MessageView({
  m,
  persona,
  seed,
  task,
  store
}: {
  m: WebMessage
  persona?: ReturnType<Store['personas']['get']>
  seed?: string
  task?: boolean
  store: Store
}): React.JSX.Element {
  void store
  if (m.role === 'user')
    return (
      <div className={`m m--me${m.notify ? ' m--notify' : ''}`}>
        <div className="bubble bubble--user">
          {m.text}
          {m.attachments && m.attachments.length > 0 && (
            <div className="atts">
              {m.attachments.map((a, i) => (
                <span key={i} className="att">
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  return (
    <div className="m">
      <Avatar persona={persona} seed={seed} task={task} size={28} />
      <div className="bubble bubble--reply">
        {m.text && <Markdown text={m.text} />}
        {m.notes?.map((n, i) => (
          <div key={i} className="note">
            {n}
          </div>
        ))}
      </div>
    </div>
  )
}
