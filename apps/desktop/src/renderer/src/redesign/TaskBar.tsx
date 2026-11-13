/**
 * 对话里的定时任务入口，任务 / 成员工作记录的头部，以及交接通知行。
 */
import { useEffect, useRef, useState } from 'react'
import {
  AlarmClock,
  Loader2,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  Clock,
  Pause,
  Pencil,
  Play,
  Trash2
} from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type {
  TaskRecord
} from '../../../preload'
import { Markdown } from '../features/chat/Markdown'
import { type HandoffInfo, type SessionLiveState } from '../store/chat'
import { useI18n } from '../i18n/i18n'
import {
  formatDuration
} from '../features/chat/blocks'
import { fill, useShortTime, Avatar } from './shell-common'
import { useSchedulePreview } from './TasksPane'
import { Conversation } from './Conversation'

/* ---------------- 绑定在本对话上的定时任务（对比稿 design/task-entry.html 方案 A + M2） ---------------- */

/**
 * 定时任务以自己的身份在对话里发言时的头像（对比稿 design/task-avatar-badge.html 方案 D）：任务所用角色的头像，
 * 右下角压一枚方形角标——半透明遮罩托着绿色日历钟（同定时任务页里已完成任务的图标）。不挂悬停提示：名字旁边写着任务名。
 */
export function TaskSpeakerFace({ persona, size }: { persona?: Persona; size: number }): React.JSX.Element {
  return (
    <span className="cf-taskface" style={{ '--sz': `${size}px` } as React.CSSProperties}>
      <Avatar persona={persona} size={size} plain />
      <span className="cf-taskface__badge" aria-hidden="true">
        <CalendarClock size={13} strokeWidth={2.4} />
      </span>
    </span>
  )
}

/**
 * 标题栏成员入口旁的定时任务入口（对比稿 design/task-entry.html 方案 A）：「闹钟 N」，同成员入口的写法，不放状态点。
 * 点开下拉：顶部「N 个定时任务」；每行同管理面板的任务行（状态色图标、任务名、第二行触发时间），右侧下次运行时间
 * （正在运行时是转圈 + 用时，暂停时写「已暂停」），悬停换成「立即运行」「暂停 / 继续」「删除」。点整行进入任务对话。
 */
export function TaskBar({
  tasks,
  sessionStates,
  onOpen,
  onRun,
  onToggle,
  onDelete
}: {
  tasks: TaskRecord[]
  sessionStates: Record<string, SessionLiveState>
  onOpen: (task: TaskRecord) => void
  onRun: (task: TaskRecord) => void
  onToggle: (task: TaskRecord) => void
  onDelete: (task: TaskRecord) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [at, setAt] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const open = at !== null
  // 收起规则同成员列表（见 MemberBar）。
  useEffect(() => {
    if (!open) return
    const close = (): void => setAt(null)
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    document.body.classList.add('cf-pop-open')
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
      document.body.classList.remove('cf-pop-open')
    }
  }, [open])
  const anyBusy = tasks.some((x) => sessionStates[x.sessionId]?.streaming)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open || !anyBusy) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [open, anyBusy])
  if (!tasks.length) return null
  const countText = fill(t(tasks.length === 1 ? 'cf.task.countOne' : 'cf.task.count'), { n: String(tasks.length) })
  return (
    <div className="cf-members" ref={ref}>
      <button
        type="button"
        className={`cf-members__entry${open ? ' is-open' : ''}`}
        aria-label={countText}
        aria-expanded={open}
        onClick={(e) => setAt(open ? null : e.currentTarget.offsetLeft)}
      >
        {/* 入口用闹钟，与左侧对话行右下角的定时任务徽标一致；点开后的列表行与任务对话才用日历钟 */}
        <AlarmClock size={15} />
        {tasks.length}
      </button>
      {open && (
        <div className="cf-members__dd" style={{ left: at }}>
          <div className="cf-members__head">{countText}</div>
          {tasks.map((task) => (
            <TaskBarRow
              key={task.id}
              task={task}
              busy={!!sessionStates[task.sessionId]?.streaming}
              startedAt={sessionStates[task.sessionId]?.startedAt}
              onOpen={() => {
                setAt(null)
                onOpen(task)
              }}
              onRun={() => onRun(task)}
              onToggle={() => onToggle(task)}
              onDelete={() => {
                setAt(null)
                onDelete(task)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 闹钟列表里的一行（同管理面板的任务行：状态色图标、标题、第二行触发时间）：不写下次运行时间，右侧只在暂停时写「已暂停」，
 * 悬停换成「立即运行」「暂停 / 继续」「删除」（删除先弹确认框）。点整行进入任务对话。
 * 正在运行时第二行的触发时间换成「转圈 + 已运行时长」（同成员列表第二行的工作中）。
 */
function TaskBarRow({
  task,
  busy,
  startedAt,
  onOpen,
  onRun,
  onToggle,
  onDelete
}: {
  task: TaskRecord
  busy: boolean
  startedAt?: number
  onOpen: () => void
  onRun: () => void
  onToggle: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const desc = useSchedulePreview(task.schedule)
  const paused = task.status === 'paused' || task.status === 'error'
  // 一次性任务跑完是终态（nextRunAt=null），暂停 / 继续都没有意义，不给按钮（同定时任务页详情）
  const done = task.status === 'completed'
  const title = task.title || t('chat.untitled')
  return (
    <div className="cf-members__row">
      {/* 悬停时按钮浮在行尾会盖住名字末尾（名字过长平时也会截断），提示里给全名 */}
      <button type="button" className="cf-members__open" title={title} onClick={onOpen}>
        <span className={`cf-trow__icon is-${task.status}`}>
          <CalendarClock size={16} />
        </span>
        <span className="cf-members__main">
          {/* 「已暂停」和名字放在同一行里，才能与名字对齐 */}
          <span className="cf-members__line">
            <span className="cf-members__name">{title}</span>
            {paused && <span className="cf-members__next">{t('cf.task.paused')}</span>}
          </span>
          <span className="cf-members__sub">
            {busy ? (
              <>
                <Loader2 size={11} className="spin cf-members__now" />
                <span className="cf-members__time">
                  {startedAt
                    ? formatDuration(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), t)
                    : t('cf.task.running')}
                </span>
              </>
            ) : (
              <>
                <Clock size={11} />
                <span className="cf-members__text">{desc || task.schedule.cron || task.schedule.at || ''}</span>
              </>
            )}
          </span>
        </span>
      </button>
      <span className="cf-members__acts">
        {!paused && (
          <button
            type="button"
            className="cf-members__ib"
            title={t('cf.task.runNow')}
            aria-label={t('cf.task.runNow')}
            disabled={busy}
            onClick={onRun}
          >
            <Play size={13} />
          </button>
        )}
        {!done && (
          <button
            type="button"
            className="cf-members__ib"
            title={t(paused ? 'cf.task.resume' : 'cf.task.pause')}
            aria-label={t(paused ? 'cf.task.resume' : 'cf.task.pause')}
            onClick={onToggle}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
        )}
        <button
          type="button"
          className="cf-members__ib is-danger"
          title={t('cf.task.delete')}
          aria-label={t('cf.task.delete')}
          onClick={onDelete}
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
}

/** 任务对话的标题栏（仿 MemberLogHead）：「← 主角色」返回，日历钟图标、任务名、运行中 / 已暂停胶囊、日程与下次运行时间；右侧立即运行 / 暂停 / 编辑。 */
export function TaskLogHead({
  view,
  streaming,
  onRun,
  onToggle,
  onEdit
}: {
  view: NonNullable<Parameters<typeof Conversation>[0]['taskView']>
  streaming: boolean
  onRun: () => void
  onToggle: () => void
  onEdit: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const when = useShortTime()
  const { task } = view
  const desc = useSchedulePreview(task.schedule)
  const ownerName = view.owner?.name ?? 'Deva'
  const paused = task.status === 'paused' || task.status === 'error'
  const next =
    streaming || paused
      ? ''
      : task.nextRunAt != null
        ? fill(t('cf.task.next'), { time: when(task.nextRunAt) })
        : t('tasks.nextNever')
  return (
    <>
      <button type="button" className="cf-back" onClick={view.onBack} title={fill(t('cf.member.back'), { owner: ownerName })}>
        <ChevronLeft size={16} />
        <span>{ownerName}</span>
        {view.backAlert && <span className="cf-back__dot" aria-hidden="true" />}
      </button>
      <span className="cf-members__sep" aria-hidden="true" />
      {/* 标题栏里只放图标本身，不带列表行那种灰底方块 */}
      <CalendarClock size={18} className="cf-conv__ticon" aria-hidden="true" />
      <span className="cf-conv__mname" title={task.prompt}>
        {task.title}
      </span>
      {streaming ? (
        <span className="cf-mcard__pill is-busy">
          <i aria-hidden="true" />
          {t('cf.task.running')}
        </span>
      ) : paused ? (
        <span className="cf-mcard__pill">{t('cf.task.paused')}</span>
      ) : null}
      <span className="cf-conv__tsub">{[desc, next].filter(Boolean).join(' · ')}</span>
      <div className="cf-conv__hacts">
        {!paused && (
          <button type="button" className="cf-members__ib" title={t('cf.task.runNow')} disabled={streaming} onClick={onRun}>
            <Play size={13} />
          </button>
        )}
        {/* 一次性任务跑完是终态，不给暂停 / 继续（同对话标题栏的定时任务列表） */}
        {task.status !== 'completed' && (
          <button type="button" className="cf-members__ib" title={t(paused ? 'cf.task.resume' : 'cf.task.pause')} onClick={onToggle}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </button>
        )}
        <button type="button" className="cf-members__ib" title={t('cf.task.edit')} onClick={onEdit}>
          <Pencil size={13} />
        </button>
      </div>
    </>
  )
}

/**
 * 定时任务交来要处理的结果（对比稿 M2）：居中一行灰底「日历钟 任务名 摘要」，点开是带任务名的全文框。
 * 图标用绿色日历钟（同任务发言头像的角标、定时任务页里已完成任务的图标）。
 */
export function HandoffNotice({ handoff }: { handoff: HandoffInfo }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="cf-handoff">
      <button
        type="button"
        className={`cf-handoff__pill${open ? ' is-open' : ''}`}
        aria-expanded={open}
        title={t(open ? 'cf.task.collapse' : 'cf.task.expand')}
        onClick={() => setOpen((v) => !v)}
      >
        <CalendarClock size={15} className="cf-handoff__ic" aria-hidden="true" />
        <span className="cf-handoff__text">
          <b>{handoff.title}</b> {handoff.summary}
        </span>
        <ChevronDown size={12} className="cf-handoff__chev" />
      </button>
      {open && (
        <div className="cf-handoff__box">
          <div className="cf-handoff__who">
            <CalendarClock size={14} className="cf-handoff__ic" aria-hidden="true" />
            {handoff.title}
          </div>
          <Markdown text={handoff.content} />
        </div>
      )}
    </div>
  )
}

/**
 * 成员对话的标题栏：「← 主角色」返回主对话，后面是成员头像与名字（文件夹在输入框的 chip 上）。
 * 工作中不加「工作中」标签：头像的扫光已经表示在工作（同成员列表，见 MemberBar）。
 */
export function MemberLogHead({
  view,
  streaming
}: {
  view: NonNullable<Parameters<typeof Conversation>[0]['memberView']>
  streaming: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const { meta, persona } = view.entry
  const ownerName = view.owner?.name ?? 'Deva'
  return (
    <>
      <button
        type="button"
        className="cf-back"
        onClick={view.onBack}
        title={fill(t('cf.member.back'), { owner: ownerName })}
      >
        <ChevronLeft size={16} />
        <span>{ownerName}</span>
        {view.backAlert && <span className="cf-back__dot" aria-hidden="true" />}
      </button>
      <span className="cf-members__sep" aria-hidden="true" />
      <Avatar persona={persona} size={24} busy={streaming} />
      <span className="cf-conv__mname" title={meta.duty || undefined}>
        {meta.name}
      </span>
    </>
  )
}
