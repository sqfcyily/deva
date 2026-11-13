import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { WebItem } from '../shared/remote-web'
import type { ActionValue, NoticeView, PromptView } from '../shared/remote-views'
import { t } from './link'

/**
 * 记录条目的渲染：用户气泡 / 回复气泡（Markdown）/ 通知卡 / 交互卡（提问、计划、挂载、定时任务、角色）。
 * 卡片按钮的 value 由电脑端 hub 生成，这里原样回传；按钮所在记录的 id 一并带上（指令回执用完即删）。
 */

type Act = (id: string, value: ActionValue, form?: Record<string, string | string[]>) => Promise<void>

/**
 * 通知 / 卡片里的文案是电脑端按「一行一项」拼的纯文本（单个换行），按 Markdown 规则会被并成一段：
 * 代码块之外的单个换行补成硬换行（行尾两个空格）。模型回复不做这个处理，按标准 Markdown 渲染。
 */
function hardBreaks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/)
  return parts.map((p, i) => (i % 2 ? p : p.replace(/([^\n])\n(?!\n)/g, '$1  \n'))).join('')
}

export function Markdown({ text, breaks }: { text: string; breaks?: boolean }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {breaks ? hardBreaks(text) : text}
      </ReactMarkdown>
    </div>
  )
}

export function ItemView({ item, onAction }: { item: WebItem; onAction: Act }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return <div className="bubble bubble--user">{item.text}</div>
    case 'reply':
      return (
        <div className="bubble bubble--reply">
          <Markdown text={item.text} />
          {item.note && <div className="note">{item.note}</div>}
        </div>
      )
    case 'notice':
      return <NoticeCard id={item.id} view={item.view} onAction={onAction} />
    case 'prompt':
      return <PromptCard id={item.id} view={item.view} onAction={onAction} />
  }
}

function Buttons({
  id,
  buttons,
  layout,
  onAction
}: {
  id: string
  buttons: { label: string; value: ActionValue; primary?: boolean }[]
  layout?: 'row' | 'column'
  onAction: Act
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  if (!buttons.length) return null
  return (
    <div className={`btns btns--${layout ?? 'row'}`}>
      {buttons.map((b, i) => (
        <button
          key={i}
          className={`btn${b.primary ? ' btn--primary' : ''}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onAction(id, b.value)
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

function NoticeCard({ id, view, onAction }: { id: string; view: NoticeView; onAction: Act }): React.JSX.Element {
  return (
    <div className={`card card--${view.tone ?? 'info'}`}>
      {view.title && <div className="card__title">{view.title}</div>}
      <Markdown text={view.text} breaks />
      <Buttons id={id} buttons={view.buttons ?? []} layout={view.buttonLayout} onAction={onAction} />
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

function Head({ title, sub }: { title: string; sub?: string }): React.JSX.Element {
  return (
    <div className="card__head">
      <div className="card__title">{title}</div>
      {sub && <div className="card__sub">{sub}</div>}
    </div>
  )
}

function PromptCard({ id, view, onAction }: { id: string; view: PromptView; onAction: Act }): React.JSX.Element {
  switch (view.kind) {
    case 'ask':
      return <AskCard id={id} view={view} onAction={onAction} />
    case 'plan': {
      const title =
        view.state === 'open'
          ? '请审阅计划'
          : view.state === 'approve'
            ? '计划已批准'
            : view.state === 'keep'
              ? '继续完善计划'
              : view.state === 'ignore'
                ? '计划已忽略'
                : '计划审阅已结束'
      return (
        <div className={`card card--prompt${view.state === 'open' ? '' : ' is-done'}`}>
          <Head title={title} sub={view.sessionTitle} />
          <Fold text={view.plan} limit={view.state === 'open' ? 1500 : 300} />
          {view.state === 'open' && (
            <Buttons
              id={id}
              buttons={[
                { label: '继续完善', value: { k: 'plan', key: view.key, d: 'keep' } },
                { label: '忽略', value: { k: 'plan', key: view.key, d: 'ignore' } },
                { label: '批准并执行', value: { k: 'plan', key: view.key, d: 'approve' }, primary: true }
              ]}
              onAction={onAction}
            />
          )}
        </div>
      )
    }
    case 'mount':
      return (
        <div className={`card card--prompt${view.state === 'open' ? '' : ' is-done'}`}>
          <Head title={view.state === 'open' ? '需要挂载工作区' : '工作区挂载'} sub={view.sessionTitle} />
          {view.state === 'open' ? (
            <>
              <p>
                这一步（<b>{view.tool}</b> {view.path && <code>{view.path}</code>}）需要一个工作区目录，但当前对话还没有挂载文件夹。
              </p>
              <p className="muted">挂载文件夹需要在电脑端选择；也可以先跳过，让它改用绝对路径。</p>
              <Buttons id={id} buttons={[{ label: '暂不挂载', value: { k: 'mount', key: view.key } }]} onAction={onAction} />
            </>
          ) : (
            <p className="muted">
              {view.state === 'mounted' ? (
                <>
                  已挂载：<code>{view.root}</code>
                </>
              ) : view.state === 'skipped' ? (
                '已跳过挂载。'
              ) : (
                '请求已结束。'
              )}
            </p>
          )}
        </div>
      )
    case 'autotask': {
      const open = view.state === 'open'
      return (
        <div className={`card card--prompt${open ? '' : ' is-done'}`}>
          <Head
            title={open ? '确认定时任务' : view.state === 'created' ? '定时任务已创建' : '已忽略这个定时任务'}
            sub={view.sessionTitle}
          />
          <div className="kv">
            <b>{view.title}</b>
            <div>
              <span className="k">日程</span>
              {view.schedule ? (
                <>
                  {view.schedule}
                  {view.nextRunAt && <span className="muted">（下次：{new Date(view.nextRunAt).toLocaleString()}）</span>}
                </>
              ) : (
                <span className="bad">{view.error ?? '日程无效'}</span>
              )}
            </div>
            <div>
              <span className="k">身份</span>
              {view.personaName}
              <span className="k k--inline">模型</span>
              {view.modelName}
            </div>
            <div className="k">任务指令</div>
            <Fold text={view.prompt || '（空）'} limit={400} />
          </div>
          {open && (
            <>
              <p className="muted">创建后到点自动运行，运行时不会再询问你。需要改日程、身份或模型，请在电脑端的名片上编辑。</p>
              <Buttons
                id={id}
                buttons={[
                  { label: '忽略', value: { k: 'autotask', sid: view.sessionId, tool: view.key, a: 'dismiss' } },
                  { label: '创建任务', value: { k: 'autotask', sid: view.sessionId, tool: view.key, a: 'create' }, primary: true }
                ]}
                onAction={onAction}
              />
            </>
          )}
        </div>
      )
    }
    case 'agent': {
      const open = view.state === 'open'
      return (
        <div className={`card card--prompt${open ? '' : ' is-done'}`}>
          <Head title={open ? '新角色名片' : view.state === 'accepted' ? '角色已添加' : '已拒绝这个角色'} sub={view.sessionTitle} />
          <div className="kv">
            <b>{view.name}</b>
            {view.desc && <div className="muted">{view.desc}</div>}
            <div className="k">角色设定</div>
            <Fold text={view.prompt || '（空）'} limit={400} />
          </div>
          {open && (
            <>
              <p className="muted">头像会自动生成，之后可以在电脑端修改。</p>
              <Buttons
                id={id}
                buttons={[
                  { label: '不要', value: { k: 'agent', sid: view.sessionId, tool: view.key, a: 'reject' } },
                  { label: '添加角色', value: { k: 'agent', sid: view.sessionId, tool: view.key, a: 'accept' }, primary: true }
                ]}
                onAction={onAction}
              />
            </>
          )}
        </div>
      )
    }
  }
}

type AskView = Extract<PromptView, { kind: 'ask' }>

/**
 * 问答卡：每题按单选 / 多选列出选项，并可附一行自由文字（没有选项的题只有文字框）。
 * 表单字段名与 hub 约定一致：q{i} = 选中项（多选为数组），q{i}_text = 自由文字。
 */
function AskCard({ id, view, onAction }: { id: string; view: AskView; onAction: Act }): React.JSX.Element {
  const [picks, setPicks] = useState<string[][]>(() => view.questions.map(() => []))
  const [texts, setTexts] = useState<string[]>(() => view.questions.map(() => ''))
  const [busy, setBusy] = useState(false)

  if (view.state !== 'open')
    return (
      <div className="card card--prompt is-done">
        <Head title={view.state === 'answered' ? '已回答' : '问题已结束'} sub={view.sessionTitle} />
        {view.questions.map((q, n) => (
          <div key={n} className="ask__q">
            <b>
              {n + 1}. {q.question}
            </b>
            <div className={view.answers?.[n] ? '' : 'muted'}>{view.answers?.[n] || '未作答'}</div>
          </div>
        ))}
      </div>
    )

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

  const complete = view.questions.every((q, n) => q.required === false || picks[n].length > 0 || texts[n].trim())

  const submit = async (): Promise<void> => {
    const form: Record<string, string | string[]> = {}
    view.questions.forEach((q, n) => {
      if (picks[n].length) form[`q${n}`] = q.multi ? picks[n] : picks[n][0]
      if (texts[n].trim()) form[`q${n}_text`] = texts[n].trim()
    })
    setBusy(true)
    try {
      await onAction(id, { k: 'ask', key: view.key }, form)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card card--prompt">
      <Head title="需要你的回答" sub={view.sessionTitle} />
      {view.questions.map((q, n) => {
        const labels = [...new Set(q.options.map((o) => o.label))]
        return (
          <div key={n} className="ask__q">
            <b>
              {view.questions.length > 1 ? `${n + 1}. ` : ''}
              {q.question}
            </b>
            <span className="ask__tags">
              {q.multi && <span>{t('multi')}</span>}
              <span>{q.required === false ? t('optional') : t('required')}</span>
            </span>
            {labels.map((label) => {
              const on = picks[n].includes(label)
              const desc = q.options.find((o) => o.label === label)?.description
              return (
                <button
                  key={label}
                  type="button"
                  className={`opt${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(n, label, q.multi)}
                >
                  <span className={`opt__mark${q.multi ? ' opt__mark--box' : ''}`} />
                  <span className="opt__body">
                    <span>{label}</span>
                    {desc && <span className="opt__desc">{desc}</span>}
                  </span>
                </button>
              )
            })}
            <input
              className="ask__text"
              placeholder={labels.length ? t('other') : t('freeText')}
              value={texts[n]}
              onChange={(e) =>
                setTexts((l) => {
                  const next = l.slice()
                  next[n] = e.target.value
                  return next
                })
              }
            />
          </div>
        )
      })}
      <div className="btns btns--row">
        <button className="btn btn--primary" disabled={!complete || busy} onClick={() => void submit()}>
          {t('submit')}
        </button>
      </div>
    </div>
  )
}
