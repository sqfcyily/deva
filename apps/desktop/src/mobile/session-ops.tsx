import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, MailOpen, Trash2 } from 'lucide-react'
import type { WebModel, WebSession } from '../shared/remote-web'
import type { Store } from './App'
import { SessionFace } from './avatar'
import { isUnread } from './home'
import type { Link } from './link'
import { fmtListTime, t } from './strings'

/**
 * 对话操作：归档 / 取消归档、删除、切换模型，以及归档后的「撤销」提示条与长按弹出的操作面板。
 * 归档、删除先改本地列表再等电脑回执，失败了改回来并提示。
 */

export interface Snack {
  id: number
  text: string
  action: string
  run: () => void
}

export interface SessionOps {
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

  return { archive, remove, setModel, loadModels, snack, dismissSnack }
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
          <>
            <p className="sheet__warn">{t('deleteWarn')}</p>
            <button className="act is-danger" onClick={() => run(() => void store.ops.remove(s.id))}>
              <Trash2 size={22} strokeWidth={1.8} />
              {t('deleteChat')}
            </button>
            <button className="act" onClick={onClose}>
              <span className="act__pad" />
              {t('cancel')}
            </button>
          </>
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
