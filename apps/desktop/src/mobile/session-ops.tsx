import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, MailOpen, Trash2 } from 'lucide-react'
import type { WebModel, WebSession } from '../shared/remote-web'
import type { Store } from './App'
import { SessionFace } from './avatar'
import { isUnread } from './home'
import type { Link } from './link'
import { fmtListTime, t } from './strings'

/**
 * 对话操作：新建、归档 / 取消归档、删除、切换模型，以及归档后的「撤销」提示条与长按弹出的操作面板。
 * 新建、归档、删除都先改本地列表再等电脑回执，失败了改回来并提示。
 */

export interface Snack {
  id: number
  text: string
  action: string
  run: () => void
}

export interface SessionOps {
  /** 新建对话：立刻放上占位、返回对话 id（直接进入对话页），不等电脑回执；没连上返回 null。 */
  create(personaId: string): string | null
  /** 电脑发来的完整对话列表 → 本地列表：刚新建、电脑列表里还没有的对话保留占位。 */
  fromServer(list: WebSession[]): Map<string, WebSession>
  /** 电脑说某个对话没了：不再为它保留占位。 */
  gone(sid: string): void
  /** 换了电脑：清掉所有占位。 */
  reset(): void
  archive(sid: string, archived: boolean): Promise<void>
  remove(sid: string): Promise<void>
  setModel(sid: string, ref: string): Promise<boolean>
  loadModels(): Promise<WebModel[] | null>
  snack: Snack | null
  dismissSnack(): void
}

const SNACK_MS = 4000

export function useSessionOps(
  linkRef: { current: Link | null },
  sessionsRef: { current: Map<string, WebSession> },
  setSessions: (fn: (m: Map<string, WebSession>) => Map<string, WebSession>) => void,
  toast: (text: string, ok?: boolean) => void
): SessionOps {
  const [snack, setSnack] = useState<Snack | null>(null)
  const models = useRef<WebModel[] | null>(null)
  /** 手机刚新建、电脑列表里还没出现的对话（占位）。不留着的话，先到的旧列表会把它冲掉，对话页以为对话被删了而退回列表。 */
  const pending = useRef(new Map<string, WebSession>())

  useEffect(() => {
    if (!snack) return
    const id = window.setTimeout(() => setSnack((s) => (s?.id === snack.id ? null : s)), SNACK_MS)
    return () => window.clearTimeout(id)
  }, [snack])

  const put = useCallback(
    (s: WebSession | undefined, sid: string) =>
      setSessions((m) => {
        const next = new Map(m)
        if (s) next.set(sid, s)
        else next.delete(sid)
        return next
      }),
    [setSessions]
  )

  const create = useCallback(
    (personaId: string): string | null => {
      const c = linkRef.current?.createSession(personaId)
      if (!c) {
        toast(t('notConnected'), false)
        return null
      }
      const now = Date.now()
      // 同电脑端空对话的样子（标题「新对话」），电脑列表到了就换成真的那条。
      const draft: WebSession = { id: c.sid, title: t('newChat'), personaId, createdAt: now, updatedAt: now, preview: '', busy: false, waiting: false, kind: 'chat' }
      pending.current.set(c.sid, draft)
      put(draft, c.sid)
      void c.done.then((err) => {
        if (!err) return
        // 没建成：撤掉占位（停在这个对话页的会自动回到列表）。
        pending.current.delete(c.sid)
        put(undefined, c.sid)
        toast(err, false)
      })
      return c.sid
    },
    [linkRef, put, toast]
  )

  const fromServer = useCallback((list: WebSession[]): Map<string, WebSession> => {
    const m = new Map(list.map((s) => [s.id, s]))
    for (const [id, s] of pending.current) {
      if (m.has(id)) pending.current.delete(id)
      else m.set(id, s)
    }
    return m
  }, [])

  const gone = useCallback((sid: string) => void pending.current.delete(sid), [])
  const reset = useCallback(() => pending.current.clear(), [])

  const archive = useCallback(
    async (sid: string, archived: boolean): Promise<void> => {
      const l = linkRef.current
      const prev = sessionsRef.current.get(sid)
      if (!l || !prev) return
      if (archived && prev.busy) return toast(t('archiveBusy'), false)
      put({ ...prev, archived: archived || undefined }, sid)
      const r = await l.result((rid) => ({ t: 'archive', rid, sid, archived }))
      if (!r.ok) {
        put(prev, sid)
        return toast(r.message || t('errorTitle'), false)
      }
      if (archived)
        setSnack({ id: Date.now(), text: t('archivedSnack', { title: prev.title }), action: t('undo'), run: () => void archive(sid, false) })
    },
    [linkRef, sessionsRef, put, toast]
  )

  const remove = useCallback(
    async (sid: string): Promise<void> => {
      const l = linkRef.current
      const prev = sessionsRef.current.get(sid)
      if (!l) return
      pending.current.delete(sid)
      put(undefined, sid)
      const r = await l.result((rid) => ({ t: 'delete', rid, sid }))
      if (!r.ok) {
        if (prev) put(prev, sid)
        toast(r.message || t('errorTitle'), false)
      }
    },
    [linkRef, sessionsRef, put, toast]
  )

  const setModel = useCallback(
    async (sid: string, ref: string): Promise<boolean> => {
      const l = linkRef.current
      if (!l) return false
      const r = await l.result((rid) => ({ t: 'set_model', rid, sid, ref }))
      if (!r.ok) toast(r.message || t('errorTitle'), false)
      return r.ok
    },
    [linkRef, toast]
  )

  const loadModels = useCallback(async (): Promise<WebModel[] | null> => {
    const list = (await linkRef.current?.models()) ?? null
    if (list) models.current = list
    return list ?? models.current
  }, [linkRef])

  const dismissSnack = useCallback(() => setSnack(null), [])

  return { create, fromServer, gone, reset, archive, remove, setModel, loadModels, snack, dismissSnack }
}

/** 底部的撤销提示条（归档后 4 秒）。 */
export function SnackBar({ snack, onDone }: { snack: Snack | null; onDone: () => void }): React.JSX.Element | null {
  if (!snack) return null
  return (
    <div className="snack" role="status">
      <span>{snack.text}</span>
      <button
        onClick={() => {
          onDone()
          snack.run()
        }}
      >
        {snack.action}
      </button>
    </div>
  )
}

/** 删除对话的二次确认（长按面板、对话页「更多」共用）：说明 + 「取消 | 删除对话」同一排，取消在左（同 Dialog）。 */
export function DeleteConfirm({ onCancel, onDelete }: { onCancel: () => void; onDelete: () => void }): React.JSX.Element {
  return (
    <>
      <p className="sheet__warn">{t('deleteWarn')}</p>
      <div className="sheet__pair">
        <button className="btn" onClick={onCancel}>
          {t('cancel')}
        </button>
        <button className="btn btn--danger" onClick={onDelete}>
          {t('deleteChat')}
        </button>
      </div>
    </>
  )
}

/** 长按对话行弹出的操作面板：顶部写明是哪个对话；删除要再确认一次。 */
export function SessionSheet({ store, s, onClose }: { store: Store; s: WebSession; onClose: () => void }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const persona = store.personas.get(s.personaId ?? 'general')
  const unread = isUnread(s, store.seen)
  const run = (fn: () => void): void => {
    onClose()
    fn()
  }
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__who">
          <SessionFace s={s} personas={store.personas} size={40} still />
          <span className="sheet__whok">
            <b>{s.title}</b>
            <span>
              {persona?.name ?? 'Deva'} · {fmtListTime(s.updatedAt)}
            </span>
          </span>
        </div>
        {confirm ? (
          <DeleteConfirm onCancel={onClose} onDelete={() => run(() => void store.ops.remove(s.id))} />
        ) : (
          <>
            {s.archived ? (
              <button className="act" onClick={() => run(() => void store.ops.archive(s.id, false))}>
                <ArchiveRestore size={22} strokeWidth={1.8} />
                {t('unarchive')}
              </button>
            ) : (
              <button className={`act${s.busy ? ' is-off' : ''}`} onClick={() => run(() => void store.ops.archive(s.id, true))}>
                <Archive size={22} strokeWidth={1.8} />
                {t('archive')}
                {s.busy && <small>{t('archiveBusyShort')}</small>}
              </button>
            )}
            {unread && (
              <button className="act" onClick={() => run(() => store.markSeen(s.id))}>
                <MailOpen size={22} strokeWidth={1.8} />
                {t('markRead')}
              </button>
            )}
            <button className="act is-danger" onClick={() => setConfirm(true)}>
              <Trash2 size={22} strokeWidth={1.8} />
              {t('deleteChat')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
