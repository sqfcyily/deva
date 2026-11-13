/**
 * 定时任务页：任务列表、详情与运行历史、新建 / 编辑表单。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  Clock,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type {
  PreviewScheduleResult,
  TaskRecord,
  TaskSchedule,
  TaskStatus
} from '../../../preload'
import { ScheduleEditor } from '../features/chat/ScheduleEditor'
import {
  RUN_CHAT_TITLE_DETAIL,
  TaskModelSelect,
  TaskPersonaSelect,
  TaskRunModeSelect,
  clipChatTitle
} from '../features/chat/TaskPickers'
import { taskErrorKey } from '../features/chat/TaskConfirmCard'
import { type SessionMeta, useChatState } from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useModels } from '../store/models'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { DragBar, DEFAULT_PERSONA_ID, useRelativeTime, fill, Avatar } from './shell-common'
import { ContextMenu } from './ContextMenu'
import { memberPersona } from './MemberBar'
import { AddMenu, GroupFace } from './Rail'

/* ============================ 定时任务标签页 ============================ */

/** 分组展示顺序：进行中 → 已暂停 → 出错 → 已完成。 */
const TASK_GROUP_ORDER: TaskStatus[] = ['active', 'paused', 'error', 'completed']

const TASK_GROUP_KEY: Record<TaskStatus, string> = {
  active: 'tasks.groupActive',
  paused: 'tasks.groupPaused',
  error: 'tasks.groupError',
  completed: 'tasks.groupCompleted'
}

/** 绝对本地时间（简短）：用于「下次触发 / 上次运行」展示，跟随界面语言。 */
function fmtAbs(ts: number, locale: 'zh-CN' | 'en'): string {
  try {
    return new Date(ts).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

/**
 * 定时任务标签页——「左列表 + 右详情」双栏（对齐角色页）：TasksPane 作容器，持有当前选中任务的
 * 本地态 viewTaskId；左侧 TasksRail 按状态分组列出任务（名称 + 人读日程），右侧 TaskDetail 展示选中
 * 任务的完整信息与操作，未选中则给出空态。真值来自 useTasks（订阅 tasks:changed），所有变更委托主进程 IPC。
 *
 * 新建两路（搜索框旁的 + 菜单，布局同角色花名册）：手动 → 本面 TaskFormModal 直填并经 tasks:create 落盘；
 * 通过对话 → 交外壳新建对话并预填引导语，仍走模型 create_task + 确认名片。两路同一条主进程创建通路与
 * 同一套授权语义（创建即批准、触发时零交互），手动填表本身即用户亲自确认，不再另加一道名片。
 */
export function TasksPane({
  target,
  onTargetConsumed,
  onAddByChat,
  onOpenChat
}: {
  /** 外部导航意图（对话里「查看任务」）：非空则挂载即选中该任务；消费后经 onTargetConsumed 回清。 */
  target: string | null
  onTargetConsumed: () => void
  /** 「通过对话添加」：新建对话 + 预填引导语（实现于外壳，同「通过对话添加角色」）。 */
  onAddByChat: () => void
  /** 打开某对话并切到对话页（运行历史的「查看对话」打开任务对话）。 */
  onOpenChat: (sessionId: string) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { tasks, create, setStatus, runNow, update, remove } = useTasks()
  // 详情「运行方式」行里的会话名（在会话中运行的任务）。
  const { sessions: chatSessions } = useChatState()
  const chatTitle = (task: TaskRecord): string | null => {
    if (!task.ownerSessionId) return null
    const s = chatSessions.find((x) => x.id === task.ownerSessionId)
    return s ? s.title || t('chat.untitled') : null
  }
  // 任务对话在不在（运行历史标题右侧的「查看对话」，对比稿 design/task-run-view.html 方案 A）：对话要到第一次运行才建，
  // 被用户删了则下次运行重建；不在时什么都不显示（用户定：不显示「对话已删除」）。
  const hasChat = (task: TaskRecord): boolean => chatSessions.some((x) => x.id === task.sessionId)
  const { providers } = useModels()
  const { personas } = useExtensions()
  const dialog = useDialog()
  const toast = useToast()

  // 当前选中的任务（右侧显示其详情）。态存于本组件——切走再回本 tab 复位到未选中空态。
  // 初值取外部 target：从对话「查看任务」切入时本组件恰新挂载，直接落在目标任务详情。
  const [viewTaskId, setViewTaskId] = useState<string | null>(target)
  // 正在编辑的任务 id（非空 → 弹出编辑弹窗）。存 id 而非记录：编辑期间任务经广播刷新亦从最新列表派生。
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  // 手动新建表单是否打开（与编辑弹窗互斥：同一 TaskFormModal，task=null 即新建态）。
  const [creating, setCreating] = useState(false)
  // target 变化（再次从对话点「查看任务」而本组件未卸载时）→ 改选目标并回清父层意图。
  useEffect(() => {
    if (target) {
      setViewTaskId(target)
      onTargetConsumed()
    }
    // 仅以 target 为触发源：消费后父层置 null，不因 onTargetConsumed 引用变动而重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // 按状态分组，组内按下次触发升序（无下次的排后），再按创建时间降序。左列表据此分段。
  const groups = useMemo(() => {
    const g: Record<TaskStatus, TaskRecord[]> = {
      active: [],
      paused: [],
      completed: [],
      error: []
    }
    for (const task of tasks) g[task.status].push(task)
    const byNext = (a: TaskRecord, b: TaskRecord): number => {
      const an = a.nextRunAt ?? Number.POSITIVE_INFINITY
      const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY
      if (an !== bn) return an - bn
      return b.createdAt - a.createdAt
    }
    ;(Object.keys(g) as TaskStatus[]).forEach((k) => g[k].sort(byNext))
    return g
  }, [tasks])

  // 选中任务从列表实时派生（引用被删/刷新即自动兜底为 null → 右侧回落空态，无需手动清选中）。
  const viewTask = useMemo(
    () => tasks.find((x) => x.id === viewTaskId) ?? null,
    [tasks, viewTaskId]
  )
  // 编辑目标同样从列表派生：编辑中若任务被删（广播刷新）则记录消失 → 弹窗自然关闭。
  const editTask = useMemo(
    () => tasks.find((x) => x.id === editTaskId) ?? null,
    [tasks, editTaskId]
  )

  // 人格名：未指定 / 引用已删 → 显示默认角色 Deva（执行时同样回落 Deva，见主进程 runScheduledTurn）。
  const personaName = (id: string | null): string => {
    const p =
      personas.find((x) => x.id === id) ?? personas.find((x) => x.id === DEFAULT_PERSONA_ID)
    return p?.name ?? t('tasks.personaNone')
  }
  // 模型完整名（服务商 · 模型）；空 / 已删则回落默认标签。
  const modelLabel = (ref: string | null): string => {
    if (!ref) return t('tasks.modelDefault')
    const idx = ref.indexOf(':')
    if (idx > 0) {
      const p = providers.find((x) => x.id === ref.slice(0, idx))
      const m = p?.models.find((x) => x.id === ref.slice(idx + 1))
      if (p && m) return `${p.name} · ${m.name}`
    }
    return ref
  }

  const doRunNow = (task: TaskRecord): void => {
    void (async () => {
      const res = await runNow(task.id)
      if (res.ok && res.already) {
        // 同一任务已在运行 / 排队：主进程没有重复入队，只知会一下（不是错误）。
        const running = res.already === 'running'
        toast.show({
          title: t(running ? 'tasks.runNowAlreadyRunning' : 'tasks.runNowAlreadyQueued'),
          message: t(running ? 'tasks.runNowAlreadyRunningHint' : 'tasks.runNowAlreadyQueuedHint')
        })
      } else if (res.ok) {
        // ok:true 表示已成功派发进调度器串行队列（非「已完成」）——非阻断 toast 知会「已开始运行」，
        // 实际结果稍后落入运行历史，用户无需点确认。
        toast.show({
          title: t('tasks.runNowStarted'),
          message: t('tasks.runNowStartedHint'),
          variant: 'success'
        })
      } else {
        // 失败仍走阻断式确认框（需用户知悉原因）。
        await dialog.confirm({
          title: t('tasks.runNowFailed'),
          message: res.reason || '',
          confirmText: t('common.close')
        })
      }
    })()
  }
  const doDelete = (task: TaskRecord): void => {
    const name = task.title || t('chat.untitled')
    const heading = locale === 'en' ? `Delete task “${name}”?` : `删除定时任务 ${name} ？`
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        // 绑定了对话的任务连任务对话一起删（见主进程 tasks.ts deleteTask）。
        message: t(task.ownerSessionId ? 'tasks.deleteBoundConfirm' : 'tasks.deleteConfirm'),
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      // 删除后不必手动清 viewTaskId：viewTask 由 tasks 派生，记录消失即回落空态。
      if (ok) await remove(task.id)
    })()
  }

  return (
    <>
      <TasksRail
        groups={groups}
        viewTaskId={viewTask?.id ?? null}
        onSelect={setViewTaskId}
        onDelete={doDelete}
        onAddManual={() => setCreating(true)}
        onAddByChat={onAddByChat}
      />
      {viewTask ? (
        <TaskDetail
          key={viewTask.id}
          task={viewTask}
          personaName={personaName(viewTask.auth.personaId)}
          modelLabel={modelLabel(viewTask.auth.modelRef)}
          onEdit={() => setEditTaskId(viewTask.id)}
          onSetStatus={(s) => void setStatus(viewTask.id, s)}
          onRunNow={() => doRunNow(viewTask)}
          onDelete={() => doDelete(viewTask)}
          chatTitle={chatTitle(viewTask)}
          onOpenChat={hasChat(viewTask) ? () => onOpenChat(viewTask.sessionId) : null}
        />
      ) : (
        <TasksEmpty hasTasks={tasks.length > 0} />
      )}
      {creating && (
        <TaskFormModal
          task={null}
          onClose={() => setCreating(false)}
          onSubmit={async ({ ownerSessionId, ...input }) => {
            const res = await create({ ...input, ...(ownerSessionId ? { ownerSessionId } : {}) })
            // 失败：回错误 key 给表单就地提示（不关弹窗）；成功：关表单并直选新任务（列表由广播刷新）。
            if (!res.ok) return taskErrorKey(res.error)
            setCreating(false)
            setViewTaskId(res.task.id)
            return null
          }}
        />
      )}
      {editTask && (
        <TaskFormModal
          key={editTask.id}
          task={editTask}
          onClose={() => setEditTaskId(null)}
          onSubmit={async (input) => {
            await update({ id: editTask.id, ...input })
            setEditTaskId(null)
            return null
          }}
        />
      )}
    </>
  )
}

/**
 * 日程人读摘要：按 schedule 签名 + 语言向主进程 schedule.ts 求权威描述，抽成 hook 供左列表行与
 * 右详情共用。无效日程回落提示文案，请求失败回落空串（由调用方兜底显示 cron/at 原串）。
 *
 * 传 allowPast=true：这里展示的都是**已创建任务**（已完成的一次性任务其墙钟必然已过），
 * 一次性时间过去但日程合法时仍取人读摘要，绝不把「已执行完毕」误标为「日程无效」。
 */
export function useSchedulePreview(schedule: TaskSchedule): string {
  const { t, locale } = useI18n()
  const [desc, setDesc] = useState('')
  const sig = `${schedule.kind}|${schedule.at ?? ''}|${schedule.cron ?? ''}|${schedule.tz}`
  useEffect(() => {
    let alive = true
    void window.deva.tasks
      .preview(schedule, locale, true)
      .then((res) => {
        if (!alive) return
        setDesc(res.ok ? res.description : t('tasks.previewInvalid'))
      })
      .catch(() => {
        if (alive) setDesc('')
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, locale])
  return desc
}

/**
 * 左列表列（对齐角色花名册 .cf-rail）：顶部搜索 + 并排「添加任务」入口（按标题过滤），
 * 下方按状态分组列出任务行。tasks tab 下由本列 + 右详情共同占据列表列与右侧内容整块。
 */
function TasksRail({
  groups,
  viewTaskId,
  onSelect,
  onDelete,
  onAddManual,
  onAddByChat
}: {
  groups: Record<TaskStatus, TaskRecord[]>
  viewTaskId: string | null
  onSelect: (id: string) => void
  /** 右键菜单「删除」委托（含破坏性确认，实现于 TasksPane.doDelete）。 */
  onDelete: (task: TaskRecord) => void
  /** 「添加任务」→ 打开手动新建表单（TasksPane 持有弹窗态）。 */
  onAddManual: () => void
  /** 「通过对话添加」→ 新建对话并预填引导语（由外壳实现，同「通过对话添加角色」）。 */
  onAddByChat: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  // 右键菜单（对齐花名册/会话行）：定位光标处，携选中任务；点删除走 onDelete 的破坏性确认。
  const [menu, setMenu] = useState<{ x: number; y: number; task: TaskRecord } | null>(null)
  const q = query.trim().toLowerCase()
  // 按标题过滤后的分组（空词返回全部）；同时算总数以区分「全空」与「搜索无结果」。
  const shown = useMemo(() => {
    const out = {} as Record<TaskStatus, TaskRecord[]>
    let total = 0
    ;(Object.keys(groups) as TaskStatus[]).forEach((k) => {
      const list = q ? groups[k].filter((x) => (x.title || '').toLowerCase().includes(q)) : groups[k]
      out[k] = list
      total += list.length
    })
    return { out, total }
  }, [groups, q])
  const allEmpty = (Object.keys(groups) as TaskStatus[]).every((k) => groups[k].length === 0)

  return (
    <aside className="cf-rail">
      <div className="cf-rail__top">
        <div className="cf-search">
          <Search className="cf-search__icon" size={14} />
          <input
            className="cf-search__input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            aria-label={t('tasks.searchPlaceholder')}
          />
          {query && (
            <button
              className="cf-search__clear"
              title={t('common.close')}
              aria-label={t('common.close')}
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <AddMenu
          manualLabel={t('tasks.addTask')}
          chatLabel={t('tasks.addByChat')}
          onManual={onAddManual}
          onByChat={onAddByChat}
        />
      </div>

      <div className="cf-list">
        {allEmpty ? (
          <div className="cf-empty">{t('tasks.paneEmpty')}</div>
        ) : shown.total === 0 ? (
          <div className="cf-empty">{t('cf.searchNoResults')}</div>
        ) : (
          TASK_GROUP_ORDER.filter((k) => shown.out[k].length > 0).map((k) => (
            <section key={k} className="cf-trailgroup">
              <div className="cf-tasks__grouphd">
                {t(TASK_GROUP_KEY[k])}
                <span className="cf-tasks__count">{shown.out[k].length}</span>
              </div>
              {shown.out[k].map((task) => (
                <TaskRailRow
                  key={task.id}
                  task={task}
                  active={viewTaskId === task.id}
                  onClick={() => onSelect(task.id)}
                  onContext={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, task })
                  }}
                />
              ))}
            </section>
          ))
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t('tasks.actDelete'),
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => onDelete(menu.task)
            }
          ]}
        />
      )}
    </aside>
  )
}

/** 左列表单个任务行（对齐 .cf-prow）：类型图标（按状态着色）| 标题 / 人读日程。 */
function TaskRailRow({
  task,
  active,
  onClick,
  onContext
}: {
  task: TaskRecord
  active: boolean
  onClick: () => void
  /** 右键唤起删除菜单（阻默认系统菜单，定位到光标）。 */
  onContext: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const desc = useSchedulePreview(task.schedule)
  return (
    <button
      className={`cf-trow${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      <span className={`cf-trow__icon is-${task.status}`} title={t('tasks.cardTitle')}>
        <CalendarClock size={16} />
      </span>
      <div className="cf-trow__main">
        <div className="cf-trow__title">{task.title || t('chat.untitled')}</div>
        <div className="cf-trow__sched">
          <Clock size={11} />
          <span className="cf-trow__schedtext">
            {desc || task.schedule.cron || task.schedule.at || ''}
          </span>
        </div>
      </div>
    </button>
  )
}

/** 任务详情运行历史默认展示的条数（最近 N 次），超出折叠在「展开全部」后。 */
const HISTORY_PREVIEW = 5

type TaskRunStatus = TaskRecord['runs'][number]['status']

/**
 * 运行状态图标的圆内符号（圆框共用）：对勾 / 叉 / i（中止）/ 双箭头（追赶跳过）。
 * 中止与对话里「已停止本轮回复」的提示同一个图标（lucide Info）、同为黄色，两处说的是同一件事。
 */
const RUN_ICON_MARK: Record<TaskRunStatus, React.ReactNode> = {
  ok: <path d="m9 12 2 2 4-4" />,
  error: (
    <>
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  aborted: (
    <>
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  skipped: (
    <>
      <path d="m8 9 3 3-3 3" />
      <path d="m13 9 3 3-3 3" />
    </>
  )
}

/**
 * 运行状态图标（任务详情「上次」与运行历史共用，对比稿 design/run-status-icons.html 方案 A）：同宽线框圆形，
 * 文字徽标长短不一会把后面的摘要挤得对不齐。悬停显示状态文字，失败时连同原因。
 */
function RunStatusIcon({
  status,
  label,
  detail
}: {
  status: TaskRunStatus
  label: string
  detail?: string
}): React.JSX.Element {
  const title = detail ? `${label}：${detail}` : label
  return (
    <span className={`cf-runicon is-${status}`} role="img" aria-label={title} title={title}>
      <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        {RUN_ICON_MARK[status]}
      </svg>
    </span>
  )
}

/**
 * 右详情面（对齐角色资料卡 .cf-profile）：展示选中任务的类型/状态、日程与运行信息、运行历史，
 * 以及操作（编辑·暂停/恢复·立即运行·删除）。任务指令不在此展示，点「编辑」查看。
 * 日程人读摘要经 useSchedulePreview 权威求值。
 */
function TaskDetail({
  task,
  personaName,
  modelLabel,
  onEdit,
  onSetStatus,
  onRunNow,
  onDelete,
  chatTitle,
  onOpenChat
}: {
  task: TaskRecord
  personaName: string
  modelLabel: string
  onEdit: () => void
  onSetStatus: (status: TaskStatus) => void
  onRunNow: () => void
  onDelete: () => void
  /** 完成后通知的那个对话的标题（绑定任务才有）。 */
  chatTitle: string | null
  /** 打开任务对话（停在最新一轮，即最近一次运行）；任务对话不在（还没运行过 / 被删了）为 null，不显示入口。 */
  onOpenChat: (() => void) | null
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const rel = useRelativeTime()
  const desc = useSchedulePreview(task.schedule)

  const lastRun = task.runs.length > 0 ? task.runs[task.runs.length - 1] : undefined
  const runKey = (s: TaskRunStatus): string =>
    s === 'ok'
      ? 'tasks.runOk'
      : s === 'skipped'
        ? 'tasks.runSkipped'
        : s === 'aborted'
          ? 'tasks.runAborted'
          : 'tasks.runError'
  // 运行历史按时间降序（最近在上）。
  const history = useMemo(() => [...task.runs].reverse(), [task.runs])
  // 默认只列最近 HISTORY_PREVIEW 次，超出时给「展开全部」开关（组件按 task.id 取 key，切任务即复位收起）。
  const [historyAll, setHistoryAll] = useState(false)
  const shownHistory = historyAll ? history : history.slice(0, HISTORY_PREVIEW)

  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-profile">
        <div className="cf-profile__inner cf-tdetail">
          <div className={`cf-tdetail__icon is-${task.status}`}>
            <CalendarClock size={30} />
          </div>
          <div className="cf-profile__name">{task.title || t('chat.untitled')}</div>
          <div className="cf-tdetail__tags">
            <span className={`cf-tdetail__status is-${task.status}`}>
              {t(TASK_GROUP_KEY[task.status])}
            </span>
          </div>

          <div className="cf-profile__meta">
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fSchedule')}</span>
              <span className="cf-profile__v">
                {desc || task.schedule.cron || task.schedule.at || ''}
              </span>
            </div>
            {task.status === 'active' && (
              <div className="cf-profile__row">
                <span className="cf-profile__k">{t('tasks.previewNext')}</span>
                <span className="cf-profile__v">
                  {task.nextRunAt ? fmtAbs(task.nextRunAt, locale) : t('tasks.nextNever')}
                </span>
              </div>
            )}
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.lastRun')}</span>
              <span className="cf-profile__v">
                {/* 时间与状态都取运行历史的最后一条（含「立即运行」）：task.lastRunAt 只在按日程触发时更新，
                    拿它配最后一条的状态会对不上。 */}
                {lastRun ? (
                  <>
                    {rel(lastRun.firedAt)}
                    <RunStatusIcon
                      status={lastRun.status}
                      label={t(runKey(lastRun.status))}
                      detail={lastRun.error}
                    />
                  </>
                ) : (
                  t('tasks.lastNever')
                )}
              </span>
            </div>
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fPersona')}</span>
              <span className="cf-profile__v">{personaName}</span>
            </div>
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fModel')}</span>
              <span className="cf-profile__v">{modelLabel}</span>
            </div>
            {/* 运行方式：独立运行，或在某个会话中运行（在「编辑」里改） */}
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fRunMode')}</span>
              <span className="cf-profile__v cf-tdetail__chat" title={chatTitle ?? undefined}>
                {chatTitle
                  ? fill(t('tasks.runInChatNamed'), { name: clipChatTitle(chatTitle, RUN_CHAT_TITLE_DETAIL) })
                  : t('tasks.runAlone')}
              </span>
            </div>
          </div>

          <div className="cf-tdetail__actions">
            <button className="cf-tdetail__act" onClick={onEdit}>
              <Pencil size={15} /> {t('tasks.actEdit')}
            </button>
            {task.status === 'active' ? (
              <button className="cf-tdetail__act" onClick={() => onSetStatus('paused')}>
                <Pause size={15} /> {t('tasks.actPause')}
              </button>
            ) : task.status === 'completed' ? null : (
              // completed 为一次性任务已触发的终态（nextRunAt=null），置回 active 不产生任何后续触发，
              // 故不给「恢复」按钮；仅 paused / error 可恢复调度。
              <button className="cf-tdetail__act" onClick={() => onSetStatus('active')}>
                <RotateCcw size={15} /> {t('tasks.actResume')}
              </button>
            )}
            <button className="cf-tdetail__act" onClick={onRunNow}>
              <Play size={15} /> {t('tasks.actRunNow')}
            </button>
            <button className="cf-tdetail__act cf-tdetail__act--danger" onClick={onDelete}>
              <Trash2 size={15} /> {t('tasks.actDelete')}
            </button>
          </div>

          <div className="cf-tdetail__section">
            {/* 标题右侧：一个任务只有一个对话，每次运行在里面追加一轮，所以只放一个入口，不逐行放。 */}
            <div className="cf-tdetail__sechead">
              <div className="cf-profile__convs-label">{t('tasks.runHistory')}</div>
              {onOpenChat && (
                <button type="button" className="cf-tdetail__chatlink" onClick={onOpenChat}>
                  <MessageCircle size={13} />
                  {t('tasks.viewChat')}
                  <ChevronRight size={13} />
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <div className="cf-empty">{t('tasks.historyEmpty')}</div>
            ) : (
              <div className="cf-truns">
                {shownHistory.map((run, i) => (
                  <div key={i} className="cf-trun">
                    <span className="cf-trun__time">{fmtAbs(run.firedAt, locale)}</span>
                    <RunStatusIcon status={run.status} label={t(runKey(run.status))} detail={run.error} />
                    {(run.summary || run.error) && (
                      <span className="cf-trun__msg">{run.summary || run.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {history.length > HISTORY_PREVIEW && (
              <button
                type="button"
                className="cf-trun__more"
                onClick={() => setHistoryAll((v) => !v)}
                aria-expanded={historyAll}
              >
                {historyAll
                  ? t('tasks.historyCollapse')
                  : t('tasks.historyShowAll').replace('{n}', String(history.length))}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 会话头像（同左侧对话列表）：有成员时是群组头像（GroupFace 按 38px 排好，整体缩到 size），否则是会话角色的头像。
 * 用在定时任务「运行方式」的会话列表里。
 */
function SessionFace({ session, size }: { session: SessionMeta; size: number }): React.JSX.Element {
  const { personas } = useExtensions()
  const owner = personas.find((p) => p.id === session.personaId)
  const members = (session.members ?? [])
    .filter((m) => !m.removed)
    .map((m) => memberPersona(m, personas, owner))
    .filter((p): p is Persona => !!p)
  if (members.length)
    return (
      <span className="cf-sessface" style={{ zoom: size / 38 }}>
        <GroupFace people={owner ? [owner, ...members] : members} />
      </span>
    )
  return <Avatar persona={owner} size={size} plain />
}

/**
 * 任务表单弹窗（复用 .cf-modal is-editor 编辑器骨架）——**新建 / 编辑共用一套表单**：标题/指令/日程/人格/模型。
 * 与创建确认名片同构：日程 cron 反解/拼装走共享 ../features/chat/schedule，实时 preview 校验并给人读摘要；
 * 落盘走 tasks.create / tasks.update（主进程校验日程、算首次或重算下次触发、完成/错误态改日程即重激活），
 * 成功后由 tasks:changed 刷新；失败带稳定错误码就地提示（弹窗不关，供用户改后重试）。
 * 编辑保留原任务时区（只换墙钟/cron），新建取本地时区。
 */
export function TaskFormModal({
  task,
  hideRunMode,
  onClose,
  onSubmit
}: {
  /** 既有任务 → 编辑态；null → 手动新建（空表单 + 每天 10:00 默认日程）。 */
  task: TaskRecord | null
  /** 不显示运行方式（从任务对话标题栏打开时：改到别的对话会让「返回」回到那个对话）。提交时运行方式保持原样。 */
  hideRunMode?: boolean
  onClose: () => void
  /** 提交：成功返回 null（由调用方关闭弹窗），失败返回错误文案 key（就地提示，不关弹窗）。 */
  onSubmit: (input: {
    title: string
    prompt: string
    schedule: TaskSchedule
    auth: { personaId: string | null; modelRef: string | null }
    /** 运行方式：会话 id = 在该会话中运行，null = 独立运行。 */
    ownerSessionId: string | null
  }) => Promise<string | null>
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const creating = task == null

  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')

  // 新建默认：人格 null → TaskPersonaSelect 自动落到首个已启用角色；模型 null → 全局默认。
  const [personaId, setPersonaId] = useState<string | null>(task?.auth.personaId ?? null)
  const [modelRef, setModelRef] = useState<string | null>(task?.auth.modelRef ?? null)
  // 运行方式：默认独立运行；在会话中运行 = 结果交给那个会话（见 TaskRunModeSelect）。
  const [ownerId, setOwnerId] = useState<string | null>(task?.ownerSessionId ?? null)

  const [saving, setSaving] = useState(false)
  // 提交失败的错误文案 key（主进程稳定错误码 → 本地化）；再次提交前清空。
  const [err, setErr] = useState<string | null>(null)

  // 编辑保留原任务时区（改日程只换墙钟/cron）；新建 / 缺失兜底本地时区。
  const tz = useMemo(
    () => task?.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    [task]
  )

  // 新建默认日程：每天 10:00 —— 即 ScheduleEditor 对空 cron 的预设，这里写成具体 cron，
  // 使首帧日程即合法（免得 preview 尚未回来就点「创建任务」被主进程判 invalid-cron）。
  const initialSchedule = useMemo<TaskSchedule>(
    () => (task ? { ...task.schedule, tz } : { kind: 'recurring', cron: '0 10 * * *', tz }),
    [task, tz]
  )

  // 送 preview / create / update 的日程对象：由日程编辑器（ScheduleEditor）拼好后回填。
  const [schedule, setSchedule] = useState<TaskSchedule>(initialSchedule)

  // 实时预览（轻防抖）：人读摘要 + 下次触发；严格校验（不 allowPast），把日程改到过去即时暴露为无效。
  const [preview, setPreview] = useState<PreviewScheduleResult | null>(null)
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void window.deva.tasks
        .preview(schedule, locale)
        .then((r) => {
          if (alive) setPreview(r)
        })
        .catch(() => {
          if (alive) setPreview(null)
        })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [schedule, locale])

  const nextText = (ms: number | null): string =>
    ms == null
      ? t('tasks.previewNever')
      : new Date(ms).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')

  const scheduleInvalid = preview != null && !preview.ok
  const canSubmit = !saving && prompt.trim().length > 0 && !scheduleInvalid

  const heading = creating ? t('tasks.createTitle') : t('tasks.editTitle')

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    setErr(null)
    try {
      const failed = await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        auth: { personaId, modelRef },
        ownerSessionId: ownerId
      })
      // 成功（null）→ 由调用方关闭弹窗；失败 → 就地提示，表单保持可改。
      if (failed) setErr(failed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cf-modal__backdrop" onClick={onClose}>
      <div
        className="cf-modal is-editor"
        role="dialog"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">{heading}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cf-editor">
          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fTitle')}</label>
            <input
              className="cf-input"
              value={title}
              placeholder={t('tasks.fTitlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fSchedule')}</label>
            <ScheduleEditor initial={initialSchedule} tz={tz} onChange={setSchedule} />

            {/* 日程预览：人读摘要 + 下次触发；无效即时提示（阻断保存）。 */}
            <div className={`cf-schedprev${scheduleInvalid ? ' is-invalid' : ''}`}>
              {scheduleInvalid ? (
                <>
                  <AlertTriangle size={13} />
                  <span>{t('tasks.previewInvalid')}</span>
                </>
              ) : preview && preview.ok ? (
                <span>
                  {preview.description} · {t('tasks.previewNext')}：{nextText(preview.nextRunAt)}
                </span>
              ) : (
                <span>…</span>
              )}
            </div>
          </div>

          {/* 任务指令：与对话输入框同款内嵌盒（更高、不可拖），底部工具条内嵌运行方式 / 人格 / 模型 chip 选择器。 */}
          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fPrompt')}</label>
            <div className="cf-box cf-box--task">
              <textarea
                value={prompt}
                placeholder={t('tasks.fPromptPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="cf-box__bar">
                {!hideRunMode && (
                  <TaskRunModeSelect
                    value={ownerId}
                    taskSessionId={task?.sessionId}
                    faceOf={(s, size) => <SessionFace session={s} size={size} />}
                    onChange={setOwnerId}
                  />
                )}
                <TaskPersonaSelect value={personaId} onChange={setPersonaId} />
                <TaskModelSelect value={modelRef} onChange={setModelRef} />
              </div>
            </div>
          </div>

          {/* 提交失败（主进程校验未过）：复用日程预览的红字行就地提示，弹窗保持打开。 */}
          {err && (
            <div className="cf-schedprev is-invalid">
              <AlertTriangle size={13} />
              <span>{t(err)}</span>
            </div>
          )}

          <div className="cf-editor__actions">
            <button className="cf-btn" onClick={onClose}>
              {t('cf.cancel')}
            </button>
            <button className="cf-btn is-primary" disabled={!canSubmit} onClick={submit}>
              {creating ? t('tasks.confirm') : t('cf.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** tasks tab 右侧空态（未选中任务时）：对齐角色页 RosterEmpty。 */
function TasksEmpty({ hasTasks }: { hasTasks: boolean }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('tasks.paneTitle')}</div>
          <div className="cf-quick__hint">
            {hasTasks ? t('tasks.detailEmpty') : t('tasks.paneHint')}
          </div>
        </div>
      </div>
    </main>
  )
}
