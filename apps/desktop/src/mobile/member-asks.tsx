import { useState } from 'react'
import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import type { WebPersona } from '../shared/remote-web'
import { MemberFace } from './avatar'
import { PromptCard } from './cards'
import type { Act, LivePrompt } from './prompts'
import { t } from './strings'

/**
 * 成员在等你处理的事（同电脑端 MemberAsks，对比稿 design/member-ask-inline.html 方案 A）：主对话末尾每件一枚居中胶囊
 * 「后端在等你回答」，只写谁在等什么，不写问题 / 计划的具体内容。最早一件在胶囊下直接展开卡片，其余收着，点胶囊展开 / 收起。
 * 处理完胶囊换成回执「✓ 已回答后端」留在原位，下一件自动展开；这一批都处理完后约 1 秒一起收起（见 prompts.ts）。
 * 出现、展开、收起都是高度过渡，不跳。手机上看不到成员的对话，所以没有「打开对话」；成员在网页上等你登录这类要在电脑上处理，
 * 这里不列。
 */

/** 胶囊上的一句：谁在等什么。 */
export function memberWaitLabel(p: LivePrompt): string {
  const name = p.member?.name ?? ''
  if (p.view.kind === 'ask') return t('mWaitAsk', { name })
  if (p.view.kind === 'plan') return t('mWaitPlan', { name })
  return t(p.member?.isNew ? 'mWaitPick' : 'mWaitMount', { name })
}

/** 处理完的回执（ok = 绿色对勾）；没处理就结束了（取消 / 中止 / 在别处撤掉）的没有回执，直接收起。 */
function memberReceipt(p: LivePrompt): { text: string; ok: boolean } | null {
  const name = p.member?.name ?? ''
  const v = p.view
  if (v.kind === 'ask' && v.state === 'answered') {
    const answered = (v.answers ?? []).some((a) => a.trim())
    return { text: t(answered ? 'mDoneAsk' : 'mDoneAskSkip', { name }), ok: answered }
  }
  if (v.kind === 'plan' && v.state !== 'open' && v.state !== 'cancelled')
    return {
      text: t(v.state === 'approve' ? 'mDoneApprove' : v.state === 'keep' ? 'mDoneKeep' : 'mDoneIgnore', { name }),
      ok: v.state !== 'ignore'
    }
  if (v.kind === 'mount' && (v.state === 'mounted' || v.state === 'skipped'))
    return v.state === 'mounted'
      ? { text: t('mDonePick', { name }), ok: true }
      : { text: t(p.member?.isNew ? 'mDoneNoLimit' : 'mDoneNoMount', { name }), ok: false }
  return null
}

/** 高度过渡的折叠块（grid 行 1fr ↔ 0fr，收起时淡出）。 */
function Fold({ open, className, children }: { open: boolean; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`mfold${open ? '' : ' is-shut'}${className ? ` ${className}` : ''}`} aria-hidden={!open}>
      <div className="mfold__in">{children}</div>
    </div>
  )
}

export function MemberAsks({
  list,
  personas,
  onAction
}: {
  list: LivePrompt[]
  personas: Map<string, WebPersona>
  onAction: Act
}): React.JSX.Element | null {
  // 展开的那件：undefined = 自动（最早一件还在等的），null = 你收起了，字符串 = 你点开的那件（处理完了按自动处理）。
  const [open, setOpen] = useState<string | null | undefined>(undefined)
  if (!list.length) return null
  const pending = list.filter((p) => p.view.state === 'open')
  const openId =
    open === null ? null : open && pending.some((p) => p.view.key === open) ? open : (pending[0]?.view.key ?? null)

  return (
    <div className="masks">
      {list.map((p) => {
        const id = p.view.key
        const m = p.member!
        const done = p.view.state !== 'open'
        const receipt = done ? memberReceipt(p) : null
        const isOpen = !done && openId === id
        return (
          <Fold key={id} className="mask" open={!p.leaving && (!done || !!receipt)}>
            {receipt ? (
              <span className={`mask__pill is-done${receipt.ok ? ' is-ok' : ''}`}>
                <Check size={13} strokeWidth={2.4} />
                <span className="mask__text">{receipt.text}</span>
              </span>
            ) : (
              <button
                className={`mask__pill${isOpen ? ' is-open' : ''}`}
                aria-expanded={isOpen}
                onClick={() => !done && setOpen(isOpen ? null : id)}
              >
                {m.isNew ? (
                  <span className="mask__icon">
                    <FolderOpen size={11} />
                  </span>
                ) : (
                  <MemberFace m={m} personas={personas} size={18} />
                )}
                <span className="mask__text">{memberWaitLabel(p)}</span>
                <ChevronDown size={14} className="mask__chev" />
              </button>
            )}
            {/* 卡片常驻（收起只是折叠）：收起再展开时，作答到一半的选择还在。 */}
            <Fold open={isOpen} className="mask__fold">
              <PromptCard view={p.view} onAction={onAction} bare member={p.view.kind === 'mount' ? m : undefined} />
            </Fold>
          </Fold>
        )
      })}
    </div>
  )
}
