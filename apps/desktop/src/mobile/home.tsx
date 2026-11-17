import { useEffect, useMemo, useRef, useState } from 'react'
import { AlarmClock, Archive, ArchiveRestore, ChevronLeft, Menu, Search, SquarePen, Trash2, X } from 'lucide-react'
import type { WebSession } from '../shared/remote-web'
import type { Filter, Store } from './App'
import { Avatar, SessionFace } from './avatar'
import { memberWaitLabel } from './member-asks'
import { InstallTip, LinkStatus } from './onboard'
import { SessionSheet } from './session-ops'
import { fmtListTime, t } from './strings'
import { SwipeRow } from './swipe'
import { TaskRows } from './tasks'

/** 对话属于哪个角色（没绑定角色的旧对话算默认角色，同电脑端）。 */
export function ownerOf(s: WebSession): string {
  return s.personaId ?? 'general'
}

export function filterTitle(store: Store, f: Filter): string {
  if (f.kind === 'tasks') return t('tasks')
  if (f.kind === 'archived') return t('archivedTitle')
  if (f.kind === 'persona') return store.personas.get(f.id)?.name ?? t('allChats')
  return t('allChats')
}

/**
 * 未读：最后一条是助手的回复，且比上次看过的时间新。看过的时间取手机本地记的与电脑记的（两端共用，
 * 任一端看过就算）中较晚的那个——在电脑上看过的，手机上不再显示红点。进行中 / 等你决定的不算未读。
 */
export function isUnread(s: WebSession, seen: Map<string, number>): boolean {
  if (s.busy || s.waiting || s.previewRole !== 'assistant') return false
  return s.updatedAt > Math.max(seen.get(s.id) ?? 0, s.readAt ?? 0)
}

/** 有定时任务：独立运行的任务对话，或绑定了任务的对话。 */
export function hasTasks(s: WebSession): boolean {
  return s.kind === 'task' || !!s.tasks?.length
}

/** 已归档的只在「已归档」里出现；「在会话中运行」的任务对话不进任何列表（从任务详情进入）。 */
export function matchFilter(s: WebSession, f: Filter): boolean {
  if (s.hidden) return false
  if (f.kind === 'archived') return !!s.archived
  if (s.archived) return false
  if (f.kind === 'tasks') return hasTasks(s)
  if (f.kind === 'persona') return ownerOf(s) === f.id
  return true
}

/** 左滑露出的按钮各宽 78px。 */
const ACT_W = 78
/** 左滑开着时列表滚动超过这么多才收起。 */
const SCROLL_CLOSE_PX = 10

/** 首页：对话列表。等你决定的排最前，其次是进行中的，其余按最近活动。左滑归档 / 删除，长按弹出操作面板。 */
export function Home({ store }: { store: Store }): React.JSX.Element {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  /** 左滑打开着的那一行（同时只开一行）与它是否已点过一次删除。 */
  const [swiped, setSwiped] = useState<{ id: string; confirm: boolean } | null>(null)
  const [sheet, setSheet] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const { filter } = store

  /** 上一次排好的顺序（左滑开着时沿用）。 */
  const order = useRef<string[]>([])
  const holding = swiped !== null
  // 有成员在等你的主对话（卡片显示在主对话里）：同「等你决定」排在前面。
  const memberWaits = useMemo(
    () => new Set([...store.prompts.values()].filter((p) => p.member && p.view.state === 'open').map((p) => p.member!.sid)),
    [store.prompts]
  )
  const list = useMemo(() => {
    const rank = (s: WebSession): number => (s.waiting || memberWaits.has(s.id) ? 0 : s.busy ? 1 : 2)
    const all = [...store.sessions.values()].filter((s) => matchFilter(s, filter))
    all.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    // 左滑开着时不重排：有对话在跑会不停更新时间、换位置，开着的那一行会从手指下挪走，点「删除」就点空了。
    // 沿用上次的顺序，新出现的排在最后；收起后再按正常顺序排。
    if (holding) {
      const pos = new Map(order.current.map((id, i) => [id, i]))
      all.sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    }
    order.current = all.map((s) => s.id)
    return q ? all.filter((s) => s.title.toLowerCase().includes(q) || s.preview.toLowerCase().includes(q)) : all
  }, [store.sessions, filter, q, holding, memberWaits])

  // 列表真的滚动了才收起左滑开着的那一行：列表更新、浏览器校正滚动位置会带来一两像素的滚动，不能算。
  const scrollRef = useRef<HTMLDivElement>(null)
  const openTop = useRef(0)
  const swipedId = swiped?.id
  useEffect(() => {
    if (swipedId) openTop.current = scrollRef.current?.scrollTop ?? 0
  }, [swipedId])

  const compose = (): void => {
    // 在某个角色的列表里：直接用这个角色新建（不等电脑回执，立刻进入对话页）。
    if (filter.kind === 'persona') {
      const sid = store.ops.create(filter.id)
      if (sid) store.open({ name: 'chat', sid })
      return
    }
    store.setOverlay('new')
  }

  return (
    <div className="page">
      <header className="tb">
        {filter.kind === 'archived' ? (
          <button className="ib" aria-label={t('allChats')} onClick={() => store.setFilter({ kind: 'all' })}>
            <ChevronLeft size={26} strokeWidth={1.8} />
          </button>
        ) : (
          <button className="ib" aria-label={t('allChats')} onClick={() => store.setOverlay('drawer')}>
            <Menu size={23} strokeWidth={1.8} />
          </button>
        )}
        {searching ? (
          <div className="tb__search">
            <Search size={16} />
            <input
              ref={input}
              value={query}
              placeholder={filter.kind === 'tasks' ? t('searchTasks') : t('search')}
              enterKeyHint="search"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : (
          <div className="tb__tw">
            <h1 className="tb__t">{filterTitle(store, filter)}</h1>
            <LinkStatus store={store} />
          </div>
        )}
        <button
          className="ib"
          aria-label={t('search')}
          onClick={() => {
            if (searching) {
              setSearching(false)
              setQuery('')
            } else {
              setSearching(true)
              window.setTimeout(() => input.current?.focus(), 0)
            }
          }}
        >
          {searching ? <X size={22} strokeWidth={1.8} /> : <Search size={22} strokeWidth={1.8} />}
        </button>
        {!searching && filter.kind !== 'archived' && filter.kind !== 'tasks' && (
          <button className="ib" aria-label={t('newChat')} disabled={!store.ready} onClick={compose}>
            <SquarePen size={22} strokeWidth={1.8} />
          </button>
        )}
      </header>
      <div
        ref={scrollRef}
        className="scroll"
        onScroll={(e) => {
          if (swiped && Math.abs(e.currentTarget.scrollTop - openTop.current) > SCROLL_CLOSE_PX) setSwiped(null)
        }}
      >
        <InstallTip store={store} />
        {filter.kind === 'tasks' ? (
          <TaskRows store={store} q={q} />
        ) : list.length === 0 ? (
          <div className="empty">
            {q ? t('noResult') : store.sessions.size === 0 ? (store.ready ? t('chatsEmpty') : '') : t('filterEmpty')}
          </div>
        ) : (
          <div className="rows">
            {list.map((s) => (
              <SessionRow
                key={s.id}
                s={s}
                store={store}
                open={swiped?.id === s.id}
                confirm={swiped?.id === s.id && swiped.confirm}
                otherOpen={!!swiped && swiped.id !== s.id}
                setSwiped={setSwiped}
                onSheet={() => {
                  setSwiped(null)
                  setSheet(s.id)
                }}
              />
            ))}
          </div>
        )}
      </div>
      {sheet && store.sessions.get(sheet) && <SessionSheet store={store} s={store.sessions.get(sheet)!} onClose={() => setSheet(null)} />}
    </div>
  )
}

function SessionRow({
  s,
  store,
  open,
  confirm,
  otherOpen,
  setSwiped,
  onSheet
}: {
  s: WebSession
  store: Store
  open: boolean
  confirm: boolean
  /** 别的行左滑开着：这次点按只收起它（同微信）。 */
  otherOpen: boolean
  setSwiped: (v: { id: string; confirm: boolean } | null) => void
  onSheet: () => void
}): React.JSX.Element {
  const unread = isUnread(s, store.seen)
  const ask = s.waiting
    ? [...store.prompts.values()].find((p) => !p.member && p.view.sessionId === s.id && p.view.state === 'open')
    : undefined
  // 成员在等你：第二行同胶囊，只写谁在等什么。
  const memberAsk = s.waiting
    ? undefined
    : [...store.prompts.values()].find((p) => p.member?.sid === s.id && p.view.state === 'open')
  const waiting = s.waiting || !!memberAsk
  const askText = ask?.view.kind === 'ask' ? ask.view.questions[0]?.question : memberAsk ? memberWaitLabel(memberAsk) : undefined
  const close = (): void => setSwiped(null)
  const actions = confirm ? (
    <button
      className="swipe__act is-del is-wide"
      onClick={() => {
        close()
        void store.ops.remove(s.id)
      }}
    >
      {t('confirmDelete')}
    </button>
  ) : (
    <>
      <button
        className={`swipe__act is-arch${!s.archived && s.busy ? ' is-off' : ''}`}
        onClick={() => {
          close()
          void store.ops.archive(s.id, !s.archived)
        }}
      >
        {s.archived ? <ArchiveRestore size={21} strokeWidth={1.8} /> : <Archive size={21} strokeWidth={1.8} />}
        {s.archived ? t('unarchive') : t('archive')}
      </button>
      <button className="swipe__act is-del" onClick={() => setSwiped({ id: s.id, confirm: true })}>
        <Trash2 size={21} strokeWidth={1.8} />
        {t('delete')}
      </button>
    </>
  )
  return (
    <SwipeRow
      open={open}
      width={ACT_W * 2}
      actions={actions}
      onOpen={() => setSwiped({ id: s.id, confirm: false })}
      onClose={close}
      onTap={() => (otherOpen ? close() : store.open({ name: 'chat', sid: s.id }))}
      onLongPress={onSheet}
    >
      <span className="row">
      <SessionFace s={s} personas={store.personas} size={50} dot={unread} />
      <span className="row__main">
        <span className="row__top">
          <span className="row__title">{s.title}</span>
          <time className="row__time">{fmtListTime(s.updatedAt)}</time>
        </span>
        <span className="row__sub">
          <span className="row__pv">
            {waiting ? (
              <>
                <span className="flag">{t('waitingFlag')}</span> {askText ?? s.preview}
              </>
            ) : s.busy ? (
              s.status ?? t('busy')
            ) : (
              <>
                {s.previewRole === 'user' && s.preview && <span className="me">{t('me')}</span>}
                {s.preview}
              </>
            )}
          </span>
          {hasTasks(s) && <AlarmClock size={14} className="row__task" />}
        </span>
      </span>
      </span>
    </SwipeRow>
  )
}

/** 新对话：选一个角色，直接进入（不等电脑回执）。 */
export function NewChatSheet({ store, onClose }: { store: Store; onClose: () => void }): React.JSX.Element {
  const personas = [...store.personas.values()].filter((p) => p.enabled)
  const pick = (pid: string): void => {
    const sid = store.ops.create(pid)
    if (sid) store.open({ name: 'chat', sid })
    else onClose()
  }
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__t">
          <b>{t('newChat')}</b>
          <span>{t('pickPersona')}</span>
        </div>
        <div className="sheet__list">
          {personas.map((p) => (
            <button key={p.id} className="prow" onClick={() => pick(p.id)}>
              <Avatar persona={p} size={44} />
              <span className="prow__k">
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
