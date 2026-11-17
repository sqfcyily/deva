import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlarmClock, ChevronLeft, MoreHorizontal } from 'lucide-react'
import type { WebDelivered, WebMessage, WebPart, WebPersona } from '../shared/remote-web'
import type { Store } from './App'
import { Avatar, MemberFace, SessionFace } from './avatar'
import { Markdown } from './cards'
import { ChatMenu } from './chat-menu'
import { Composer } from './composer'
import { AttachmentCard, AttachmentThumb, FileCard } from './files'
import { MemberAsks } from './member-asks'
import { LinkStatus } from './onboard'
import type { Outgoing } from './outbox'
import { promptSid } from './prompts'
import { LivePromptSlot, Receipt } from './receipt'
import { fmtDuration, t } from './strings'

/**
 * 对话页（同 IM）：你发的消息在右侧气泡；助手的一轮按段拆成多条回复，左侧头像 + 气泡，写完一段就出现一段。
 * 执行步骤不显示，进行中只在最后显示三个跳动的点（连不上电脑时点停下）。标题栏只放头像和标题，
 * 角色、文件夹、模型等在右上角「更多」里。消息从顶部往下排；发出的消息立刻显示，电脑收下后换成对话记录里那条。
 * 历史按页拉（先显示本机缓存），滚到顶自动往前翻；进行中写完一段电脑就把这一轮推来。
 * 进入对话之后新到的气泡淡入，停在底部时平滑跟到底。
 */
export function ChatPage({ store, sid }: { store: Store; sid: string }): React.JSX.Element {
  const session = store.sessions.get(sid)
  const persona = session ? store.personas.get(session.personaId ?? 'general') : undefined
  const history = store.hist.get(sid)
  const outgoing = store.outbox.get(sid) ?? []
  // 这个对话的交互卡：自己的排在末尾；成员在等你的（显示在主对话里，见 member-asks.tsx）排在最后，不挡主对话的输入和进度。
  const [prompts, memberAsks] = useMemo(() => {
    const all = [...store.prompts.values()].filter((p) => promptSid(p) === sid).sort((a, b) => a.at - b.at)
    return [all.filter((p) => !p.member), all.filter((p) => p.member)]
  }, [store.prompts, sid])
  const [menu, setMenu] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** 正在自动平滑滚到底：途中的滚动事件不算「离开了底部」。 */
  const auto = useRef(false)
  const loadingOlder = useRef(false)

  // 进入 / 对话有更新（一轮开始或结束、在别处改过）：拉最新一页。这也告诉电脑正看着这个对话，进行中的新内容会直接推来。
  const updatedAt = session?.updatedAt ?? 0
  const { link, ready, open } = store
  useEffect(() => {
    if (ready) link?.history(sid)
  }, [link, ready, sid, updatedAt])
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
  const messages = history?.messages ?? []
  const firstId = messages[0]?.id
  const last = messages[messages.length - 1]
  const prevTop = useRef<{ id?: string; height: number } | null>(null)

  // 序号不小于它的消息里新出现的气泡要淡入：页面第一次显示出内容时定下（那时已有的、往前翻出来的都不动）。
  const [enterFrom, setEnterFrom] = useState<number | null>(null)
  useEffect(() => {
    if (enterFrom === null && history) setEnterFrom(last ? Number(last.id) : 0)
  }, [enterFrom, history, last])

  // 往前翻页后保持视线位置；在底部时新内容到达跟到底（刚进来、或落下超过一屏时直接到底）。
  // 在画出来之前就调好位置：不然刚进来会先画出最上面那几条、下一帧才跳到底。
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const p = prevTop.current
    if (p && p.id !== firstId) {
      el.scrollTop += el.scrollHeight - p.height
      prevTop.current = null
      loadingOlder.current = false
      return
    }
    if (!stick.current) return
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop
    if (gap < 2) return
    if (enterFrom === null || gap > el.clientHeight || reducedMotion()) el.scrollTop = el.scrollHeight
    else {
      auto.current = true
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [firstId, history, outgoing.length, typing, prompts.length, memberAsks.length, session?.retry, enterFrom])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    if (gap < 80) {
      stick.current = true
      if (gap < 2) auto.current = false
    } else if (!auto.current) stick.current = false
    if (el.scrollTop < 120 && history && history.start > 0 && !loadingOlder.current && ready) {
      loadingOlder.current = true
      prevTop.current = { id: firstId, height: el.scrollHeight }
      link?.history(sid, { before: history.start })
    }
  }
  // 手指 / 滚轮一动就是自己在滚：不再当作自动滚动。
  const takeOver = (): void => {
    auto.current = false
  }

  const openFile = useCallback((file: WebDelivered) => open({ name: 'file', sid, file }), [open, sid])

  // 进行中的点接在最后一组回复下面；最后是你发的消息时另起一组；刚处理完的交互卡（末尾的回执）之后接在回执下面。
  // 交互卡还开着时在等你，不显示。
  // 最后一条是成员 / 定时任务说的话时不算：主角色的点和卡另起一组，不接在别人的头像下面。
  const lastIsReply = !outgoing.length && last?.role === 'assistant' && !last.from
  const cardOpen = prompts.some((p) => p.view.state === 'open')
  const dotsInLast = typing && lastIsReply && !prompts.length
  const empty = history && history.total === 0 && !busy && !prompts.length && !memberAsks.length && !outgoing.length

  return (
    <div className="page page--chat">
      <header className="tb tb--sub">
        <button className="ib" aria-label="back" onClick={store.back}>
          <ChevronLeft size={26} strokeWidth={1.8} />
        </button>
        {session && <SessionFace s={session} personas={store.personas} size={36} still />}
        <div className="tb__tw">
          <b className="tb__title">{session?.title ?? ''}</b>
          <LinkStatus store={store} />
        </div>
        <button className="ib" aria-label={t('more')} disabled={!session} onClick={() => setMenu(true)}>
          <MoreHorizontal size={23} strokeWidth={1.8} />
        </button>
      </header>
      <div className="scroll msgs" ref={listRef} onScroll={onScroll} onTouchStart={takeOver} onWheel={takeOver}>
        {history && history.start > 0 && <div className="msgs__more">{ready ? <span className="spin" /> : t('loadMore')}</div>}
        {empty && <div className="empty">{t('chatEmpty')}</div>}
        {/* 本机没有缓存、电脑的那一页还没到：三个跳动的点占位（稍等片刻才出现，缓存秒到时不闪）；连不上电脑时点停下。 */}
        {!history && !outgoing.length && (
          <div className={`msgs__wait${ready ? '' : ' is-stalled'}`} aria-hidden>
            <i />
            <i />
            <i />
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'user') return <UserMessage key={m.id} m={m} store={store} sid={sid} />
          const here = dotsInLast && m === last
          return (
            <Reply
              key={m.id}
              m={m}
              persona={persona}
              personas={store.personas}
              seed={session?.personaId}
              enter={enterFrom !== null && Number(m.id) >= enterFrom}
              onOpen={openFile}
              dots={here}
              stalled={here && !ready}
              retry={here ? session?.retry : undefined}
            />
          )
        })}
        {outgoing.map((o) => (
          <OutgoingMessage key={o.id} o={o} store={store} />
        ))}
        {prompts.map((p) => (
          <LivePromptSlot key={p.view.key} p={p} onAction={store.act} who={persona} seed={session?.personaId} cont={lastIsReply} />
        ))}
        {typing && !dotsInLast && !cardOpen && (
          <Typing
            persona={persona}
            seed={session?.personaId}
            cont={prompts.length > 0}
            enter={enterFrom !== null}
            stalled={!ready}
            retry={session?.retry}
          />
        )}
        <MemberAsks list={memberAsks} personas={store.personas} onAction={store.act} />
        <div className="msgs__pad" />
      </div>
      <Composer store={store} sid={sid} busy={busy} waiting={!!session?.waiting} onSent={() => (stick.current = true)} />
      {menu && session && <ChatMenu store={store} s={session} onClose={() => setMenu(false)} />}
    </div>
  )
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
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

/**
 * 回复还没来时的三个点单独一组：你的消息之后带头像；刚处理完的交互卡之后接在回执那一列（cont）。
 * 进入对话之后才出现的淡入。
 */
function Typing({
  persona,
  seed,
  cont,
  enter,
  stalled,
  retry
}: {
  persona?: WebPersona
  seed?: string
  cont: boolean
  enter: boolean
  stalled: boolean
  retry?: string
}): React.JSX.Element {
  const [fresh] = useState(enter)
  return (
    <div className={`ga${cont ? ' is-cont' : ''}${fresh ? ' is-new' : ''}`}>
      {cont ? <span className="ga__sp" /> : <Avatar persona={persona} seed={seed} size={34} />}
      <div className="ga__col">
        <Dots stalled={stalled} retry={retry} />
      </div>
    </div>
  )
}

/**
 * 对话记录里你的消息。不淡入：多数是替换发出时先显示的那条（见 OutgoingMessage）。
 * store 每次都是新对象，只比缩略图用得到的连接与电脑。
 */
const UserMessage = memo(
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
              <AttachmentCard key={i} name={a.name} kind={a.kind} />
            ))}
          </div>
        )}
        {m.text && <div className="u">{m.text}</div>}
      </div>
    )
  },
  (a, b) =>
    a.m === b.m && a.sid === b.sid && a.store.link === b.store.link && a.store.ready === b.store.ready && a.store.deskId === b.store.deskId
)

/** 发出去还没出现在对话记录里的消息：发送中稍等片刻才显示转圈；失败的写明原因，可重发或删除。 */
function OutgoingMessage({ o, store }: { o: Outgoing; store: Store }): React.JSX.Element {
  const images = o.files.filter((f) => f.preview)
  const others = o.files.filter((f) => !f.preview)
  return (
    <div className={`u-wrap is-out is-${o.state}`}>
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
            <AttachmentCard key={f.uid} name={f.name} />
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

/**
 * 助手的一条回复：头像 + 一列气泡（每段正文一个），交付文件与提示按出现的先后穿插；一轮的最后一条下面写用时。
 * 内容没变的（mergeHistory 沿用原对象）不重新渲染。
 */
const Reply = memo(function Reply({
  m,
  persona,
  personas,
  seed,
  enter,
  onOpen,
  dots,
  stalled,
  retry
}: {
  m: Extract<WebMessage, { role: 'assistant' }>
  persona?: WebPersona
  personas: Map<string, WebPersona>
  seed?: string
  /** 现在新挂上的气泡要淡入。 */
  enter: boolean
  onOpen: (file: WebDelivered) => void
  /** 进行中的点接在这条下面。 */
  dots: boolean
  stalled: boolean
  retry?: string
}): React.JSX.Element {
  // 成员交差 / 定时任务告知的那条：是它在说话，画它的头像，气泡上面写它的名字（同电脑端）。
  const from = m.from
  return (
    <div className="ga">
      {!from ? (
        <Avatar persona={persona} seed={seed} size={34} />
      ) : from.task ? (
        <Avatar persona={personas.get(from.personaId ?? 'general')} seed={from.personaId} size={34} />
      ) : (
        <MemberFace m={from} personas={personas} size={34} />
      )}
      <div className="ga__col">
        {from && (
          <div className="ga__who">
            {from.task && <AlarmClock size={12} />}
            {from.name}
          </div>
        )}
        {m.parts.map((p, i) => (
          <Part key={i} p={p} enter={enter} onOpen={onOpen} />
        ))}
        {dots && <Dots stalled={stalled} retry={retry} />}
        {!dots && m.durationMs ? <div className="ga__meta">{t('doneMeta', { d: fmtDuration(m.durationMs) })}</div> : null}
      </div>
    </div>
  )
})

/**
 * 回复里的一段正文 / 一个交付文件 / 一行提示 / 一行回执。要不要淡入在挂上时定下，之后不变（已显示的不会再闪一次）。
 * 回执不淡入：它接替的是末尾那条已经显示着的（见 receipt.tsx）。
 */
function Part({ p, enter, onOpen }: { p: WebPart; enter: boolean; onOpen: (file: WebDelivered) => void }): React.JSX.Element {
  const [fresh] = useState(enter)
  if (p.k === 'receipt') return <Receipt r={p} />
  const cls = fresh ? ' is-new' : ''
  if (p.k === 'text')
    return (
      <div className={`bb${cls}`}>
        <Markdown text={p.text} />
      </div>
    )
  if (p.k === 'file') return <FileCard file={p.file} onOpen={() => onOpen(p.file)} className={fresh ? 'is-new' : undefined} />
  return <div className={`note${cls}`}>{p.text}</div>
}
