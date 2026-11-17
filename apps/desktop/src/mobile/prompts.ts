import { useCallback, useRef, useState } from 'react'
import type { ActionValue, PromptView } from '../shared/remote-views'
import type { WebPrompt } from '../shared/remote-web'
import type { Link } from './link'
import { t } from './strings'

/**
 * 对话末尾的交互卡（问答、计划、挂载、定时任务、角色名片）。
 *
 * 点了按钮立刻按你的选择收成一行回执，不等电脑；电脑没收下（断线、卡片已在别处结束）就恢复原卡并提示。
 * 电脑那边是先把结果写进对话记录、再发出「已处理」，所以确认之后收到的、包含这一轮末尾的历史里已经有这条回执：
 * 这时撤掉末尾这条，由对话记录里的那条接着显示在原处（文案同一套，见 shared/remote-receipts.ts）。
 * 挂载请求不进对话记录，回执显示到下一段内容到来。
 *
 * 成员在等你的卡（member，显示在主对话末尾，见 member-asks.tsx）不在主对话记录里：同电脑端，处理完的留着回执，
 * 等主对话里这一批都处理完（没有还开着的成员卡）再停一会儿，一起收起、移除。
 */

export interface LivePrompt extends WebPrompt {
  /** 电脑确认已处理（本机先行收起、电脑还没确认的没有）。 */
  done?: boolean
  /** 成员卡：这一批都处理完了，正在收起（随后移除）。 */
  leaving?: boolean
}

/** 卡片显示在哪个对话：成员的卡在主对话里。 */
export const promptSid = (p: WebPrompt): string => p.member?.sid ?? p.view.sessionId

/** 成员卡全部处理完后，回执再停留多久一起收起；收起过渡的时长（同电脑端 MemberAsks）。 */
const MEMBER_HOLD_MS = 1100
export const MEMBER_OUT_MS = 300

export type Act = (key: string, value: ActionValue, form?: Record<string, string | string[]>) => Promise<void>

export interface Prompts {
  prompts: Map<string, LivePrompt>
  /** 连上时电脑给的整份。 */
  reset(list: WebPrompt[]): void
  /** 电脑推来的一张（新出现的，或已处理的）。 */
  update(p: WebPrompt): void
  /** 收到某对话包含末尾的历史：电脑确认过的回执交给对话记录。 */
  settle(sid: string): void
  act: Act
}

/** 按你的选择先行收起的样子（同电脑端 hub 的处理：多选与自己输入的用「、」连起来）。 */
function resolved(view: PromptView, value: ActionValue, form: Record<string, string | string[]> = {}): PromptView | null {
  if (value.k === 'ask' && view.kind === 'ask') {
    const answers = view.questions.map((_, i) => {
      const sel = form[`q${i}`]
      const picks = Array.isArray(sel) ? sel : sel ? [sel] : []
      const custom = typeof form[`q${i}_text`] === 'string' ? (form[`q${i}_text`] as string).trim() : ''
      return [...picks, ...(custom ? [custom] : [])].join('、')
    })
    return { ...view, state: 'answered', answers }
  }
  if (value.k === 'plan' && view.kind === 'plan') return { ...view, state: value.d }
  if (value.k === 'mount' && view.kind === 'mount') return { ...view, state: 'skipped' }
  if (value.k === 'autotask' && view.kind === 'autotask') return { ...view, state: value.a === 'create' ? 'created' : 'dismissed' }
  if (value.k === 'agent' && view.kind === 'agent') return { ...view, state: value.a === 'accept' ? 'accepted' : 'rejected' }
  return null
}

export function usePrompts(linkRef: { current: Link | null }, toast: (text: string, ok?: boolean) => void): Prompts {
  const [prompts, setPrompts] = useState<Map<string, LivePrompt>>(new Map())
  const ref = useRef(prompts)
  ref.current = prompts

  const reset = useCallback((list: WebPrompt[]) => setPrompts(new Map(list.map((p) => [p.view.key, p]))), [])

  // 某主对话的成员卡处理完一张：到时候还没有开着的，就一起收起再移除（期间又来了一张就作罢，等它处理完再来）。
  const sweep = useCallback((sid: string) => {
    window.setTimeout(() => {
      const list = [...ref.current.values()].filter((p) => p.member?.sid === sid)
      if (!list.length || list.some((p) => p.view.state === 'open')) return
      const keys = new Set(list.map((p) => p.view.key))
      setPrompts((m) => {
        const next = new Map(m)
        for (const k of keys) {
          const p = next.get(k)
          if (p && p.view.state !== 'open') next.set(k, { ...p, leaving: true })
        }
        return next
      })
      window.setTimeout(
        () =>
          setPrompts((m) => {
            const next = new Map(m)
            for (const k of keys) if (next.get(k)?.leaving) next.delete(k)
            return next
          }),
        MEMBER_OUT_MS
      )
    }, MEMBER_HOLD_MS)
  }, [])

  const update = useCallback(
    (p: WebPrompt) => {
      const open = p.view.state === 'open'
      // 已处理的、手上却没有这张（先行收起后已经收走了）：电脑的确认来晚了，不再加回来。
      if (!open && !ref.current.has(p.view.key)) return
      setPrompts((m) => (open || m.has(p.view.key) ? new Map(m).set(p.view.key, open ? p : { ...p, done: true }) : m))
      if (p.member && !open) sweep(p.member.sid)
    },
    [sweep]
  )

  const settle = useCallback(
    (sid: string) =>
      setPrompts((m) => {
        const gone = [...m.values()].filter((p) => p.done && !p.member && p.view.sessionId === sid)
        if (!gone.length) return m
        const next = new Map(m)
        for (const p of gone) next.delete(p.view.key)
        return next
      }),
    []
  )

  const act = useCallback<Act>(
    async (key, value, form) => {
      const l = linkRef.current
      if (!l) return
      const before = ref.current.get(key)
      const view = before ? resolved(before.view, value, form) : null
      if (before && view) {
        setPrompts((m) => new Map(m).set(key, { ...before, view }))
        if (before.member) sweep(before.member.sid)
      }
      const r = await l.result((rid) => ({ t: 'action', rid, key, value, form }))
      if (r.ok) return
      // 电脑没收下：还是先行收起的样子（电脑没推来别的结果）就恢复原卡。
      if (before && view)
        setPrompts((m) => (m.get(key)?.view === view ? new Map(m).set(key, before) : m))
      toast(r.message || t('sendFailed'), false)
    },
    [linkRef, toast, sweep]
  )

  return { prompts, reset, update, settle, act }
}
