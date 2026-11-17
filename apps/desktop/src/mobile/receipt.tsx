import { useLayoutEffect, useRef, useState } from 'react'
import { Check, Minus, RotateCcw } from 'lucide-react'
import { promptReceipt } from '../shared/remote-receipts'
import type { WebPersona, WebReceipt } from '../shared/remote-web'
import { Avatar } from './avatar'
import { Markdown, PromptCard } from './cards'
import type { Act, LivePrompt } from './prompts'
import { t } from './strings'

/**
 * 交互卡处理之后的一行回执：图标 + 灰字，你的选择加粗；计划、多个问题的问答点「查看」原地展开全文。
 * 绿色对勾 = 已回答 / 已批准 / 已创建，其余灰色（同电脑端交互卡终态的配色）。
 */
export function Receipt({ r }: { r: WebReceipt }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = r.tone === 'ok' ? Check : r.tone === 'redo' ? RotateCcw : Minus
  return (
    <>
      <div className={`rc rc--${r.tone}`}>
        <Icon size={14} strokeWidth={2.4} className="rc__ic" />
        <span>
          {r.text}
          {r.strong && <b>{r.strong}</b>}
          {r.detail && (
            <button className="linkbtn rc__more" onClick={() => setOpen((v) => !v)}>
              {open ? t('collapse') : t('receiptView')}
            </button>
          )}
        </span>
      </div>
      {open && r.detail && (
        <div className="fold rc__detail">
          <Markdown text={r.detail} />
        </div>
      )}
    </>
  )
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/**
 * 对话末尾的一张交互卡：没处理时是卡片；处理了（在手机上点的，或在电脑上处理的）原地收成一行回执，高度过渡、不跳。
 * cont = 接在一组回复后面：回执排进那一列、不出头像，和对话记录里那条一模一样，交接时看不出来（见 prompts.ts）。
 */
export function LivePromptSlot({
  p,
  onAction,
  who,
  seed,
  cont
}: {
  p: LivePrompt
  onAction: Act
  who?: WebPersona
  seed?: string
  cont: boolean
}): React.JSX.Element {
  const r = promptReceipt(p.view)
  const done = !!r
  const ref = useRef<HTMLDivElement>(null)
  /** 最近一次的高度（卡片里展开、输入时也会变）：收起时从它过渡到回执的高度。 */
  const last = useRef(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    last.current = el.offsetHeight
    const ro = new ResizeObserver(() => {
      if (!el.style.height) last.current = el.offsetHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !done) return
    const from = last.current
    const to = el.offsetHeight
    if (!from || from <= to || reducedMotion()) return
    el.style.height = `${from}px`
    void el.offsetHeight
    el.style.transition = 'height .28s cubic-bezier(.2,.8,.2,1)'
    el.style.height = `${to}px`
    const end = (): void => {
      el.style.height = ''
      el.style.transition = ''
    }
    const timer = window.setTimeout(end, 320)
    return () => {
      window.clearTimeout(timer)
      end()
    }
  }, [done])

  return (
    <div ref={ref} className={`pslot${r && cont ? ' is-cont' : ''}`}>
      {r ? (
        <div className="ga">
          {cont ? <span className="ga__sp" /> : <Avatar persona={who} seed={seed} size={34} />}
          <div className="ga__col rc-in">
            <Receipt r={r} />
          </div>
        </div>
      ) : (
        <PromptCard view={p.view} onAction={onAction} who={who} />
      )}
    </div>
  )
}
