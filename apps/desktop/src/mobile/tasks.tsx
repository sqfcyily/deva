import { useState } from 'react'
import { CalendarClock, Check, ChevronLeft, ChevronRight, Info, MessageCircle, Minus, Pause, Play, RotateCcw, Trash2, X, type LucideIcon } from 'lucide-react'
import type { WebTask, WebTaskAction, WebTaskRunStatus, WebTaskStatus } from '../shared/remote-web'
import type { Store } from './App'
import { Avatar } from './avatar'
import { t } from './strings'

/**
 * 定时任务：抽屉「定时任务」的任务列表 + 任务详情（对比稿 design/mobile-tasks.html 方案 A，同电脑端「定时任务」页）。
 * 第一版不做编辑和运行历史：详情里能暂停 / 恢复、立即运行、删除，「查看对话」进入任务的对话看每次运行的内容。
 */

/** 任务时间：今天 / 明天 / 昨天 09:00，一周内写星期，更早或更晚写月/日。 */
export function fmtWhen(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  const dayOf = (offset: number): string => {
    const x = new Date(now)
    x.setDate(now.getDate() + offset)
    return x.toDateString()
  }
  const day = d.toDateString()
  if (day === dayOf(0)) return `${t('today')} ${time}`
  if (day === dayOf(1)) return `${t('tomorrow')} ${time}`
  if (day === dayOf(-1)) return `${t('yesterday')} ${time}`
  const days = (d.getTime() - now.getTime()) / 86_400_000
  if (days > 0 && days < 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${time}`
}

/**
 * 任务图标：同电脑端「定时任务」页（CalendarClock；进行中主题色 / 出错红 / 已完成绿 / 已暂停灰）。
 * 列表里只给图标上色、底色一律浅灰；详情大图标（lg）底色也按状态着色。
 */
function TaskTile({ status, lg }: { status: WebTaskStatus; lg?: boolean }): React.JSX.Element {
  return (
    <span className={`ttile${lg ? ' ttile--lg' : ''} is-${status}`}>
      <CalendarClock size={lg ? 32 : 22} strokeWidth={1.8} />
    </span>
  )
}

const RUN_ICON: Record<WebTaskRunStatus, LucideIcon> = { ok: Check, error: X, skipped: Minus, aborted: Info }

/** 运行结果：同宽线框圆（同电脑端 RunStatusIcon）。 */
function RunIcon({ status }: { status: WebTaskRunStatus }): React.JSX.Element {
  const Icon = RUN_ICON[status]
  return (
    <span className={`rsi rsi--${status}`} title={t(`run_${status}`)} aria-label={t(`run_${status}`)}>
      <Icon size={10} strokeWidth={3} />
    </span>
  )
}

/** 首页在「定时任务」下列的是任务（不是对话）：点开进任务详情。q = 搜索词（已转小写）。 */
export function TaskRows({ store, q }: { store: Store; q: string }): React.JSX.Element {
  const list = q ? store.tasks.filter((x) => x.title.toLowerCase().includes(q) || x.schedule.toLowerCase().includes(q)) : store.tasks
  if (!list.length) return <div className="empty">{q ? t('noResult') : store.ready ? t('tasksEmpty') : ''}</div>
  return (
    <div className="rows">
      {list.map((x) => (
        <button key={x.id} className={`row trow${x.status === 'active' ? '' : ' is-dim'}`} onClick={() => store.open({ name: 'task', id: x.id })}>
          <TaskTile status={x.status} />
          <span className="row__main">
            <span className="row__top">
              <span className="row__title">{x.title}</span>
              {x.status === 'active' ? (
                x.nextRunAt && <span className="row__time">{fmtWhen(x.nextRunAt)}</span>
              ) : (
                <span className={`tst tst--${x.status}`}>{t(`task_${x.status}`)}</span>
              )}
            </span>
            <span className="row__sub">
              <span className="row__pv">{x.schedule}</span>
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** 任务详情：图标 + 名称 + 状态，一排圆形操作，信息卡，「查看对话」。删除先在底部确认。 */
export function TaskPage({ store, id }: { store: Store; id: string }): React.JSX.Element {
  const task = store.tasks.find((x) => x.id === id)
  const [busy, setBusy] = useState<WebTaskAction | null>(null)
  const [confirm, setConfirm] = useState(false)

  const act = async (action: WebTaskAction): Promise<void> => {
    const link = store.link
    if (!link || busy) return
    setBusy(action)
    const r = await link.result((rid) => ({ t: 'task', rid, id, action }))
    setBusy(null)
    if (!r.ok) return store.toast(r.message, false)
    // 立即运行：message 非空 = 已经在运行（不是错误）。
    if (action === 'run') store.toast(r.message || t('taskStarted'))
    if (action === 'delete') store.back()
  }

  return (
    <div className="page">
      <header className="tb">
        <button className="ib" aria-label="back" onClick={store.back}>
          <ChevronLeft size={26} strokeWidth={1.8} />
        </button>
      </header>
      {!task ? (
        <div className="empty">{t('taskGone')}</div>
      ) : (
        <div className="scroll">
          <div className="task__hero">
            <TaskTile status={task.status} lg />
            <b>{task.title}</b>
            <span className={`tchip is-${task.status}`}>
              <i />
              {t(`task_${task.status}`)}
            </span>
          </div>
          <div className="task__acts">
            {task.status === 'active' ? (
              <ActBtn icon={Pause} label={t('taskPause')} busy={busy === 'pause'} disabled={!store.ready} onClick={() => void act('pause')} />
            ) : (
              // 一次性任务已完成：再置为进行中也不会触发（同电脑端不给「恢复」）。
              task.status !== 'completed' && (
                <ActBtn icon={RotateCcw} label={t('taskResume')} busy={busy === 'resume'} disabled={!store.ready} onClick={() => void act('resume')} />
              )
            )}
            <ActBtn icon={Play} label={t('taskRunNow')} busy={busy === 'run'} disabled={!store.ready} onClick={() => void act('run')} />
            <ActBtn icon={Trash2} label={t('taskDelete')} danger busy={busy === 'delete'} disabled={!store.ready} onClick={() => setConfirm(true)} />
          </div>
          <TaskInfo store={store} task={task} />
          {task.sessionId && (
            <div className="info">
              <button className="info__r" onClick={() => store.open({ name: 'chat', sid: task.sessionId! })}>
                <MessageCircle size={18} className="task__chatic" />
                <span className="info__v">{t('taskViewChat')}</span>
                <ChevronRight size={17} className="info__go" />
              </button>
            </div>
          )}
        </div>
      )}
      {task && confirm && (
        <div className="dim" onClick={() => setConfirm(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="task__del">
              <b>{t('taskDeleteTitle', { name: task.title })}</b>
            </div>
            <p className="sheet__warn">{task.owner ? t('taskDeleteOwned') : t('taskDeleteAlone')}</p>
            <div className="sheet__pair">
              <button className="btn" onClick={() => setConfirm(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn btn--danger"
                onClick={() => {
                  setConfirm(false)
                  void act('delete')
                }}
              >
                {t('taskDeleteOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ActBtn({
  icon: Icon,
  label,
  danger,
  busy,
  disabled,
  onClick
}: {
  icon: LucideIcon
  label: string
  danger?: boolean
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className={`task__act${danger ? ' is-danger' : ''}${busy ? ' is-busy' : ''}`} disabled={disabled || busy} onClick={onClick}>
      <span className="task__actc">{busy ? <span className="spin" /> : <Icon size={21} strokeWidth={1.9} />}</span>
      {label}
    </button>
  )
}

/** 信息卡：日程 / 下次 / 上次 / 角色 / 模型 / 运行方式（同电脑端任务详情）。 */
function TaskInfo({ store, task }: { store: Store; task: WebTask }): React.JSX.Element {
  const persona = store.personas.get(task.personaId ?? 'general')
  return (
    <div className="info">
      <Row k={t('taskSchedule')}>{task.schedule}</Row>
      {task.status === 'active' && <Row k={t('taskNext')}>{task.nextRunAt ? fmtWhen(task.nextRunAt) : t('taskNextNever')}</Row>}
      <Row k={t('taskLast')}>
        {task.lastRun ? (
          <>
            <RunIcon status={task.lastRun.status} />
            {fmtWhen(task.lastRun.at)}
          </>
        ) : (
          t('taskLastNever')
        )}
      </Row>
      <Row k={t('persona')}>
        <Avatar persona={persona} seed={task.personaId} size={22} />
        {persona?.name ?? 'Deva'}
      </Row>
      <Row k={t('model')}>{task.model ?? t('taskModelDefault')}</Row>
      <Row k={t('taskRunMode')}>{task.owner ? t('taskRunIn', { name: task.owner.title }) : t('taskRunAlone')}</Row>
    </div>
  )
}

function Row({ k, children }: { k: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="info__r">
      <span className="info__k">{k}</span>
      <span className="info__v task__v">{children}</span>
    </div>
  )
}
