import { memo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ActionValue, PromptView } from '../shared/remote-views'
import type { WebPersona, WebPromptMember } from '../shared/remote-web'
import { Avatar } from './avatar'
import type { Act } from './prompts'
import { isEn, t } from './strings'

/**
 * 交互卡（提问、计划、挂载、定时任务名片、角色名片），出现在对话末尾。按钮的 value 由电脑端 hub 生成，这里原样回传。
 */

/**
 * 卡片里的文案是电脑端按「一行一项」拼的纯文本（单个换行），按 Markdown 规则会被并成一段：
 * 代码块之外的单个换行补成硬换行。模型回复不做这个处理，按标准 Markdown 渲染。
 */
function hardBreaks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/)
  return parts.map((p, i) => (i % 2 ? p : p.replace(/([^\n])\n(?!\n)/g, '$1  \n'))).join('')
}

const MD_COMPONENTS: Components = { a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }

/** 正文没变就不重新解析（对话里每来一段新内容整页都会重新渲染，长对话里逐条重解析 Markdown 会卡）。 */
export const Markdown = memo(function Markdown({ text, breaks }: { text: string; breaks?: boolean }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {breaks ? hardBreaks(text) : text}
      </ReactMarkdown>
    </div>
  )
})

function Buttons({
  k,
  buttons,
  onAction
}: {
  k: string
  buttons: { label: string; value: ActionValue; primary?: boolean }[]
  onAction: Act
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (!buttons.length) return null
  return (
    <div className="card__btns">
      {buttons.map((b, i) => (
        <button
          key={i}
          className={`btn${b.primary ? ' btn--primary' : ' btn--ghost'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onAction(k, b.value)
            } finally {
              setBusy(false)
            }
          }}
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}

/** 长文本折叠（计划 / 任务指令 / 角色设定）。 */
function Fold({ text, limit = 600 }: { text: string; limit?: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const long = text.length > limit
  return (
    <div className="fold">
      <Markdown text={long && !open ? `${text.slice(0, limit)}…` : text} />
      {long && (
        <button className="linkbtn" onClick={() => setOpen((v) => !v)}>
          {open ? t('collapse') : t('expand')}
        </button>
      )}
    </div>
  )
}

function From({ who, label }: { who?: WebPersona; label: string }): React.JSX.Element {
  return (
    <div className="card__from">
      <Avatar persona={who} size={20} />
      {label}
    </div>
  )
}

/**
 * 一张还没处理的交互卡（处理之后收成一行回执，见 receipt.tsx）。
 * bare = 不要卡头（成员在等你的卡：上面的胶囊已写明谁在等什么，见 member-asks.tsx）；member = 为这位成员选文件夹。
 */
export function PromptCard({
  view,
  onAction,
  who,
  bare,
  member
}: {
  view: PromptView
  onAction: Act
  who?: WebPersona
  bare?: boolean
  member?: WebPromptMember
}): React.JSX.Element {
  const name = who?.name ?? 'Deva'
  switch (view.kind) {
    case 'ask':
      return <AskCard view={view} onAction={onAction} who={who} bare={bare} />
    case 'plan':
      return (
        <div className="card">
          {!bare && <From who={who} label={`${name} · 请审阅计划`} />}
          <Fold text={view.plan} limit={1500} />
          <Buttons
            k={view.key}
            buttons={[
              { label: '继续完善', value: { k: 'plan', key: view.key, d: 'keep' } },
              { label: '忽略', value: { k: 'plan', key: view.key, d: 'ignore' } },
              { label: '批准并执行', value: { k: 'plan', key: view.key, d: 'approve' }, primary: true }
            ]}
            onAction={onAction}
          />
        </div>
      )
    case 'mount':
      if (member) return <MemberMountCard view={view} member={member} onAction={onAction} />
      return (
        <div className="card">
          {!bare && <From who={who} label={`${name} · 需要一个文件夹`} />}
          {view.question && <div className="card__q">{view.question}</div>}
          <p>需要一个文件夹，但这个对话还没有挂载工作区。</p>
          <p className="muted">选择文件夹要在电脑上操作；也可以先跳过，让它继续在默认工作区里工作，或改用完整路径。</p>
          <Buttons k={view.key} buttons={[{ label: '暂不挂载', value: { k: 'mount', key: view.key } }]} onAction={onAction} />
        </div>
      )
    case 'autotask':
      return (
        <div className="card">
          <From who={who} label={`${name} · 确认定时任务`} />
          <div className="kv">
            <b className="kv__title">{view.title}</b>
            <div>
              <span className="k">日程</span>
              {view.schedule ? (
                <>
                  {view.schedule}
                  {view.nextRunAt && <span className="muted">（下次 {new Date(view.nextRunAt).toLocaleString()}）</span>}
                </>
              ) : (
                <span className="bad">{view.error ?? '日程无效'}</span>
              )}
            </div>
            <div>
              <span className="k">身份</span>
              {view.personaName}
            </div>
            <div>
              <span className="k">模型</span>
              {view.modelName}
            </div>
            <Fold text={view.prompt || '（空）'} limit={300} />
          </div>
          <Buttons
            k={view.key}
            buttons={[
              { label: '忽略', value: { k: 'autotask', sid: view.sessionId, tool: view.key, a: 'dismiss' } },
              { label: '创建任务', value: { k: 'autotask', sid: view.sessionId, tool: view.key, a: 'create' }, primary: true }
            ]}
            onAction={onAction}
          />
        </div>
      )
    case 'agent':
      return (
        <div className="card">
          <From who={who} label={`${name} · 新角色名片`} />
          <div className="kv">
            <b className="kv__title">{view.name}</b>
            {view.desc && <div className="muted">{view.desc}</div>}
            <Fold text={view.prompt || '（空）'} limit={300} />
          </div>
          <Buttons
            k={view.key}
            buttons={[
              { label: '不要', value: { k: 'agent', sid: view.sessionId, tool: view.key, a: 'reject' } },
              { label: '添加角色', value: { k: 'agent', sid: view.sessionId, tool: view.key, a: 'accept' }, primary: true }
            ]}
            onAction={onAction}
          />
        </div>
      )
  }
}

/**
 * 为成员选文件夹（同电脑端成员版选文件夹卡：问句 + 灰字说明「不限」的意思）。手机上只能选「不限」：
 * 新建成员 = 不指定文件夹，成员做到一半来要 = 改用完整路径。
 */
function MemberMountCard({
  view,
  member,
  onAction
}: {
  view: Extract<PromptView, { kind: 'mount' }>
  member: WebPromptMember
  onAction: Act
}): React.JSX.Element {
  return (
    <div className="card">
      <div className="card__q">{t('mPickQ', { name: member.name })}</div>
      <p className="muted">
        {member.isNew ? t('mNoLimitNone') : t('mNoLimitPaths', { name: member.name })}
        {isEn ? ' ' : ''}
        {t('mPickOnDesk')}
      </p>
      <Buttons k={view.key} buttons={[{ label: t('noLimit'), value: { k: 'mount', key: view.key }, primary: true }]} onAction={onAction} />
    </div>
  )
}

type AskView = Extract<PromptView, { kind: 'ask' }>

/**
 * 问答卡：每题按单选 / 多选列出选项，最后一行「自己输入…」点开原地变成输入框（同电脑端）；没有选项的题只有输入框。
 * 表单字段名与 hub 约定一致：q{i} = 选中项（多选为数组），q{i}_text = 自由文字。
 */
function AskCard({ view, onAction, who, bare }: { view: AskView; onAction: Act; who?: WebPersona; bare?: boolean }): React.JSX.Element {
  const [picks, setPicks] = useState<string[][]>(() => view.questions.map(() => []))
  const [texts, setTexts] = useState<string[]>(() => view.questions.map(() => ''))
  const [editing, setEditing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([])

  const toggle = (n: number, label: string, multi: boolean): void =>
    setPicks((p) => {
      const next = p.map((x) => x.slice())
      const cur = next[n]
      const i = cur.indexOf(label)
      if (multi) {
        if (i >= 0) cur.splice(i, 1)
        else cur.push(label)
      } else next[n] = i >= 0 ? [] : [label]
      return next
    })

  const setText = (n: number, v: string): void =>
    setTexts((l) => {
      const next = l.slice()
      next[n] = v
      return next
    })

  const complete = view.questions.every((q, n) => q.required === false || picks[n].length > 0 || texts[n].trim())
  const allOptional = view.questions.every((q) => q.required === false)

  const submit = async (): Promise<void> => {
    const form: Record<string, string | string[]> = {}
    view.questions.forEach((q, n) => {
      if (picks[n].length) form[`q${n}`] = q.multi ? picks[n] : picks[n][0]
      if (texts[n].trim()) form[`q${n}_text`] = texts[n].trim()
    })
    setBusy(true)
    try {
      await onAction(view.key, { k: 'ask', key: view.key }, form)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      {!bare && <From who={who} label={t('askFrom', { who: who?.name ?? 'Deva' })} />}
      {view.questions.map((q, n) => {
        const labels = [...new Set(q.options.map((o) => o.label))]
        const freeOnly = labels.length === 0
        const typed = texts[n].trim()
        return (
          <div key={n} className="ask__q">
            <div className="card__q">
              {view.questions.length > 1 ? `${n + 1}. ` : ''}
              {q.question}
              {q.multi && <span className="ask__tag">{t('multi')}</span>}
            </div>
            <div className="opts">
              {labels.map((label) => {
                const on = picks[n].includes(label)
                const desc = q.options.find((o) => o.label === label)?.description
                return (
                  <button
                    key={label}
                    type="button"
                    className={`opt${on ? ' is-on' : ''}${q.multi ? ' is-multi' : ''}`}
                    aria-pressed={on}
                    onClick={() => toggle(n, label, q.multi)}
                  >
                    <span className="opt__mark" />
                    <span className="opt__k">
                      <b>{label}</b>
                      {desc && <span>{desc}</span>}
                    </span>
                  </button>
                )
              })}
              {freeOnly || editing === n || typed ? (
                <div className={`opt opt--input${typed ? ' is-on' : ''}`}>
                  <textarea
                    ref={(el) => (inputs.current[n] = el)}
                    rows={1}
                    value={texts[n]}
                    placeholder={freeOnly ? t('freeText') : t('other')}
                    onChange={(e) => {
                      setText(n, e.target.value)
                      e.target.style.height = '0px'
                      e.target.style.height = `${e.target.scrollHeight}px`
                    }}
                    onBlur={() => setEditing(null)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="opt is-free"
                  onClick={() => {
                    setEditing(n)
                    window.setTimeout(() => inputs.current[n]?.focus(), 0)
                  }}
                >
                  <span className="opt__mark" />
                  <span className="opt__k">
                    <b>{t('other')}</b>
                  </span>
                </button>
              )}
            </div>
          </div>
        )
      })}
      <div className="card__btns">
        {allOptional && (
          <button className="btn btn--ghost" disabled={busy} onClick={() => void submit()}>
            {t('skip')}
          </button>
        )}
        <button className="btn btn--primary" disabled={!complete || busy} onClick={() => void submit()}>
          {t('submit')}
        </button>
      </div>
    </div>
  )
}
