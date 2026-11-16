import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, MoreHorizontal } from 'lucide-react'
import type { WebMessage, WebPersona } from '../shared/remote-web'
import type { Store } from './App'
import { Avatar, SessionFace } from './avatar'
import { Markdown, PromptCard } from './cards'
import { ChatMenu } from './chat-menu'
import { Composer } from './composer'
import { AttachmentThumb, FileCard } from './files'
import { Banner } from './onboard'
import type { Outgoing } from './outbox'
import { fmtDuration, t } from './strings'

/**
 * 对话页（同 IM）：你发的消息在右侧气泡；助手的一轮按段拆成多条回复，左侧头像 + 气泡，写完一段就出现一段。
 * 执行步骤不显示，进行中只在最后显示三个跳动的点（连不上电脑时点停下）。标题栏只放头像和标题，
 * 角色、文件夹、模型等在右上角「更多」里。消息从顶部往下排；发出的消息立刻显示，电脑收下后换成对话记录里那条。
 * 历史按页拉（先显示本机缓存），滚到顶自动往前翻；进行中有新内容只补拉最后几条。
 */
export function ChatPage({ store, sid }: { store: Store; sid: string }): React.JSX.Element {
  const session = store.sessions.get(sid)
  const persona = session ? store.personas.get(session.personaId ?? 'general') : undefined
  const history = store.hist.get(sid)
  const outgoing = store.outbox.get(sid) ?? []
  const prompts = useMemo(
    () => [...store.prompts.values()].filter((p) => p.view.sessionId === sid).sort((a, b) => a.at - b.at),
    [store.prompts, sid]
  )
  const [menu, setMenu] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const loadingOlder = useRef(false)
  const histRef = useRef(history)
  histRef.current = history

  // 进入 / 对话有更新：拉最新一页；看过的记为已读。
  const updatedAt = session?.updatedAt ?? 0
  const { link, ready } = store
  useEffect(() => {
    if (ready) link?.history(sid)
  }, [link, ready, sid, updatedAt])
  // 进行中又写完一条回复：只补拉最后几条。
  const rev = session?.rev ?? 0
  useEffect(() => {
    if (!ready || !rev) return
    const h = histRef.current
    link?.history(sid, h ? { from: Math.max(0, h.total - 1) } : {})
  }, [link, ready, sid, rev])
  // 看着这个对话（页面在前台）：记为已读；锁屏 / 切到后台时来的新回复，等回到前台再算看过。
  useEffect(() => {
    const seen = (): void => {
      if (document.visibilityState === 'visible') store.markSeen(sid)
    }
    seen()
    document.addEventListener('visibilitychange', seen)
    return () => document.removeEventListener('visibilitychange', seen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, updatedAt, ready])

  // 对话在别处被删除了：回到列表（刚新建、列表还没同步到的不算）。
  const known = useRef(false)
  if (session) known.current = true
  useEffect(() => {
    if (!session && known.current && ready) store.back()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, ready])

  const busy = session?.busy ?? false
  const typing = busy && !session?.waiting
  const firstId = history?.messages[0]?.id
  const prevTop = useRef<{ id?: string; height: number } | null>(null)

  // 往前翻页后保持视线位置；在底部时新内容到达自动贴底。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const p = prevTop.current
    if (p && p.id !== firstId) {
      el.scrollTop += el.scrollHeight - p.height
      prevTop.current = null
      loadingOlder.current = false
      return
    }
    if (stick.current) el.scrollTop = el.scrollHeight
  }, [firstId, history, outgoing.length, typing, prompts.length, session?.retry])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 120 && history && history.start > 0 && !loadingOlder.current && ready) {
      loadingOlder.current = true
      prevTop.current = { id: firstId, height: el.scrollHeight }
      link?.history(sid, { before: history.start })
    }
  }

  const messages = history?.messages ?? []
  const last = messages[messages.length - 1]
  // 进行中的点接在最后一组回复下面；最后是你发的消息时另起一组。
  const dotsInLast = typing && !outgoing.length && last?.role === 'assistant'
  const empty = history && history.total === 0 && !busy && !prompts.length && !outgoing.length

  return (
    <div className="page page--chat">
      <header className="tb tb--sub">
        <button className="ib" aria-label="back" onClick={store.back}>
          <ChevronLeft size={26} strokeWidth={1.8} />
        </button>
        {session && <SessionFace s={session} personas={store.personas} size={36} still />}
        <b className="tb__title">{session?.title ?? ''}</b>
        <button className="ib" aria-label={t('more')} disabled={!session} onClick={() => setMenu(true)}>
          <MoreHorizontal size={23} strokeWidth={1.8} />
        </button>
      </header>
      <Banner store={store} />
      <div className="scroll msgs" ref={listRef} onScroll={onScroll}>
        {history && history.start > 0 && <div className="msgs__more">{ready ? <span className="spin" /> : t('loadMore')}</div>}
        {empty && <div className="empty">{t('chatEmpty')}</div>}
        {messages.map((m) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} m={m} store={store} sid={sid} />
          ) : (
            <Reply
              key={m.id}
              m={m}
              persona={persona}
              seed={session?.personaId}
              store={store}
              sid={sid}
              dots={dotsInLast && m === last ? <Dots stalled={!ready} retry={session?.retry} /> : null}
            />
          )
        )}
        {outgoing.map((o) => (
          <OutgoingMessage key={o.id} o={o} store={store} />
        ))}
        {typing && !dotsInLast && (
          <div className="ga">
            <Avatar persona={persona} seed={session?.personaId} size={34} />
            <div className="ga__col">
              <Dots stalled={!ready} retry={session?.retry} />
            </div>
          </div>
        )}
        {prompts.map((p) => (
          <PromptCard key={p.view.key} view={p.view} onAction={store.act} who={persona} />
        ))}
        <div className="msgs__pad" />
      </div>
      <Composer store={store} sid={sid} busy={busy} waiting={!!session?.waiting} onSent={() => (stick.current = true)} />
      {menu && session && <ChatMenu store={store} s={session} onClose={() => setMenu(false)} />}
    </div>
  )
}

/** 进行中：三个跳动的点。连不上电脑时停下（看得出不是在等回复）；模型连接中断 / 重试时旁边写一句。 */
function Dots({ stalled, retry }: { stalled: boolean; retry?: string }): React.JSX.Element {
  return (
    <div className={`bb bb--dots${stalled ? ' is-stalled' : ''}`} aria-label={t('busy')}>
      <i />
      <i />
      <i />
      {retry && <span>{retry}</span>}
    </div>
  )
}

function UserMessage({ m, store, sid }: { m: Extract<WebMessage, { role: 'user' }>; store: Store; sid: string }): React.JSX.Element {
  if (m.notify) return <div className="sys">{m.text}</div>
  const images = m.attachments?.filter((a) => a.kind === 'image' && a.ref) ?? []
  const others = m.attachments?.filter((a) => !(a.kind === 'image' && a.ref)) ?? []
  return (
    <div className="u-wrap">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((a) => (
            <AttachmentThumb key={a.ref} store={store} sid={sid} refId={a.ref!} name={a.name} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="atts">
          {others.map((a, i) => (
            <span key={i} className="att">
              {a.name}
            </span>
          ))}
        </div>
      )}
      {m.text && <div className="u">{m.text}</div>}
    </div>
  )
}

/** 发出去还没出现在对话记录里的消息：发送中稍等片刻才显示转圈；失败的写明原因，可重发或删除。 */
function OutgoingMessage({ o, store }: { o: Outgoing; store: Store }): React.JSX.Element {
  const images = o.files.filter((f) => f.preview)
  const others = o.files.filter((f) => !f.preview)
  return (
    <div className={`u-wrap is-${o.state}`}>
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((f) => (
            <span key={f.uid} className="thumb">
              <img src={f.preview} alt={f.name} />
            </span>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="atts">
          {others.map((f) => (
            <span key={f.uid} className="att">
              {f.name}
            </span>
          ))}
        </div>
      )}
      {o.text && (
        <div className="u-line">
          {o.state === 'sending' && <span className="spin u-spin" />}
          <div className="u">{o.text}</div>
        </div>
      )}
      {o.state === 'failed' && (
        <div className="u-fail">
          <span>{o.error}</span>
          <button onClick={() => store.outboxOps.retry(o.sid, o.id)}>{t('resend')}</button>
          <button onClick={() => store.outboxOps.discard(o.sid, o.id)}>{t('delete')}</button>
        </div>
      )}
    </div>
  )
}

/** 助手的一条回复：头像 + 一列气泡（每段正文一个），交付文件与提示按出现的先后穿插；一轮的最后一条下面写用时。 */
function Reply({
  m,
  persona,
  seed,
  store,
  sid,
  dots
}: {
  m: Extract<WebMessage, { role: 'assistant' }>
  persona?: WebPersona
  seed?: string
  store: Store
  sid: string
  dots: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ga">
      <Avatar persona={persona} seed={seed} size={34} />
      <div className="ga__col">
        {m.parts.map((p, i) =>
          p.k === 'text' ? (
            <div key={i} className="bb">
              <Markdown text={p.text} />
            </div>
          ) : p.k === 'file' ? (
            <FileCard key={i} file={p.file} onOpen={() => store.open({ name: 'file', sid, file: p.file })} />
          ) : (
            <div key={i} className="note">
              {p.text}
            </div>
          )
        )}
        {dots}
        {!dots && m.durationMs ? <div className="ga__meta">{t('doneMeta', { d: fmtDuration(m.durationMs) })}</div> : null}
      </div>
    </div>
  )
}
