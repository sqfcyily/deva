import { useCallback, useRef, useState } from 'react'
import type { WebMessage } from '../shared/remote-web'
import type { CachedHistory } from './cache'
import type { Link } from './link'
import { t } from './strings'

/**
 * 发件箱：点发送后消息立刻显示在对话末尾（同 IM），不等电脑回执与对话记录同步。
 * 电脑收下并记进对话后，按内容对上新出现的那条用户消息，换成真的那条；发送失败的留在原处，可重发或删除。
 */

/** 已上传好的附件（照片带本机预览）。 */
export interface OutFile {
  uid: string
  name: string
  preview?: string
}

export interface Outgoing {
  id: string
  sid: string
  text: string
  files: OutFile[]
  state: 'sending' | 'sent' | 'failed'
  error?: string
  /** 发的时候这一轮还在进行：作为插入送达，要等它被交给模型才出现在对话记录里。 */
  insert: boolean
  /** 发的时候对话里已有的用户消息（对上新出现的那条时排除它们，免得和之前一模一样的话对上）。 */
  known: Set<string>
  ackAt?: number
}

export interface Outbox {
  outbox: Map<string, Outgoing[]>
  send(sid: string, text: string, files: OutFile[], insert: boolean): void
  retry(sid: string, id: string): void
  discard(sid: string, id: string): void
  /** 收到某对话的历史后调用：对上的移走；这一轮已结束仍没对上的插入改为未送达。 */
  reconcile(sid: string, h: CachedHistory, busy: boolean): void
}

/** 回执之后多久还没在对话记录里出现、且这一轮已结束，就不再等（见 reconcile）。 */
const SETTLE_MS = 1500

function release(o: Outgoing): void {
  for (const f of o.files) if (f.preview) URL.revokeObjectURL(f.preview)
}

function same(m: Extract<WebMessage, { role: 'user' }>, o: Outgoing): boolean {
  if (o.text.trim()) return m.text.trim() === o.text.trim()
  return !m.text.trim() && (m.attachments?.length ?? 0) === o.files.length
}

export function useOutbox(
  linkRef: { current: Link | null },
  histRef: { current: Map<string, CachedHistory> },
  toast: (text: string, ok?: boolean) => void
): Outbox {
  const [outbox, setOutbox] = useState<Map<string, Outgoing[]>>(new Map())
  const ref = useRef(outbox)
  ref.current = outbox
  const seq = useRef(0)

  const update = useCallback((sid: string, fn: (list: Outgoing[]) => Outgoing[]) => {
    setOutbox((m) => {
      const cur = m.get(sid) ?? []
      const next = fn(cur)
      if (next === cur) return m
      const out = new Map(m)
      if (next.length) out.set(sid, next)
      else out.delete(sid)
      return out
    })
  }, [])

  const patch = useCallback(
    (sid: string, id: string, p: Partial<Outgoing>) => update(sid, (l) => l.map((o) => (o.id === id ? { ...o, ...p } : o))),
    [update]
  )

  const deliver = useCallback(
    async (o: Outgoing) => {
      const l = linkRef.current
      const r = l ? await l.sendText(o.sid, o.text, o.files.map((f) => f.uid)) : { ok: false, message: t('notConnected') }
      if (r.ok) patch(o.sid, o.id, { state: 'sent', ackAt: Date.now(), error: undefined })
      else {
        patch(o.sid, o.id, { state: 'failed', error: r.message || t('sendFailed') })
        toast(r.message || t('sendFailed'), false)
      }
    },
    [linkRef, patch, toast]
  )

  const send = useCallback(
    (sid: string, text: string, files: OutFile[], insert: boolean) => {
      const known = new Set((histRef.current.get(sid)?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.id))
      const o: Outgoing = { id: `o${Date.now().toString(36)}${++seq.current}`, sid, text, files, state: 'sending', insert, known }
      update(sid, (l) => [...l, o])
      void deliver(o)
    },
    [histRef, update, deliver]
  )

  const retry = useCallback(
    (sid: string, id: string) => {
      const o = ref.current.get(sid)?.find((x) => x.id === id)
      if (!o || o.state !== 'failed') return
      const next: Outgoing = { ...o, state: 'sending', error: undefined }
      patch(sid, id, { state: 'sending', error: undefined })
      void deliver(next)
    },
    [patch, deliver]
  )

  const discard = useCallback(
    (sid: string, id: string) =>
      update(sid, (l) => {
        const o = l.find((x) => x.id === id)
        if (o) release(o)
        return l.filter((x) => x.id !== id)
      }),
    [update]
  )

  const reconcile = useCallback(
    (sid: string, h: CachedHistory, busy: boolean) =>
      update(sid, (list) => {
        if (!list.length) return list
        const users = h.messages.filter((m): m is Extract<WebMessage, { role: 'user' }> => m.role === 'user')
        const used = new Set<string>()
        const keep: Outgoing[] = []
        let changed = false
        for (const o of list) {
          if (o.state === 'failed') {
            keep.push(o)
            continue
          }
          const hit = users.find((m) => !used.has(m.id) && !o.known.has(m.id) && same(m, o))
          if (hit) {
            used.add(hit.id)
            release(o)
            changed = true
            continue
          }
          // 这一轮已结束仍没对上：插入的没赶上这一轮（电脑端没把它交给模型）；普通消息多半是显示文字有出入，不再挂着。
          if (!busy && o.state === 'sent' && o.ackAt && Date.now() - o.ackAt > SETTLE_MS) {
            changed = true
            if (o.insert) keep.push({ ...o, state: 'failed', error: t('insertMissed') })
            else release(o)
            continue
          }
          keep.push(o)
        }
        return changed ? keep : list
      }),
    [update]
  )

  return { outbox, send, retry, discard, reconcile }
}
