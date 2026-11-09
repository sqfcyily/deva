import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, AlertTriangle, Pencil, ChevronUp } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChat, type ChatBlock } from '../../store/chat'
import { useExtensions } from '../../store/extensions'
import { useModels } from '../../store/models'
import { useTasks } from '../../store/tasks'
import type { TaskCreateInput, TaskSchedule, PreviewScheduleResult } from '../../../../preload'
import { ScheduleEditor } from './ScheduleEditor'
import { TaskModelSelect, TaskPersonaSelect } from './TaskPickers'

/**
 * 定时任务确认名片（autotaskcard）——**唯一的授权时刻**。
 * 模型调 create_task 只写下建议草稿；此名片是可编辑信封（标题/指令/日程/人格/模型），
 * 用户核对并点「创建」才真正建任务与独占会话（`resolveAutotask('create', input)`）。
 * 创建后触发零交互，故授权在此一次性议定完毕（对齐「创建时批准、执行时零交互」铁律）；
 * 工具全放行（含 skill/mcp）、读写与命令执行不设限、通知固定开启——
 * 故名片不再有类型/写入根/工具白名单/通知开关。
 *
 * 版式（对比稿 design/task-card.html 方案 A）：三个状态同一副骨架——表头（闹钟 + 「定时任务 ·」+ 标题，右侧编辑 /
 * 收起 / 已创建）+ 键值行（时间 / 执行 / 指令）+ 底栏按钮。pending 默认**摘要**，点「编辑」原地展开表单，
 * 日程无效 / 指令为空 / 创建失败时自动展开；created 换成灰底终态，dismissed 只剩一行。
 * 日程一栏整块交给 ./ScheduleEditor（与任务编辑弹窗共用同一控件，cron 反解/拼装再下沉 ./schedule 单一真源）。
 * 创建出来的任务独立运行：结果记在任务自己的对话里，完成后系统通知。
 */

/**
 * 创建结果 / 预览错误码 → 本地化 key。
 * 导出供管理页的手动新建表单共用（同一套主进程稳定错误码，文案不两处演化）。
 */
export function taskErrorKey(code: string): string {
  switch (code) {
    case 'invalid-tz':
      return 'tasks.errInvalidTz'
    case 'invalid-cron':
      return 'tasks.errInvalidCron'
    case 'invalid-once':
      return 'tasks.errInvalidOnce'
    case 'expired':
      return 'tasks.errExpired'
    case 'no-session':
      return 'tasks.errNoSession'
    case 'no-input':
      return 'tasks.errNoInput'
    case 'invalid-input':
      return 'tasks.errInvalidInput'
    default:
      return 'tasks.errGeneric'
  }
}

/** 模型显示名（服务商下的模型名）；空 / 已删 → 「全局默认」。 */
function useModelLabel(): (ref: string | null) => string {
  const { t } = useI18n()
  const { providers } = useModels()
  return (ref) => {
    const idx = ref ? ref.indexOf(':') : -1
    if (!ref || idx <= 0) return t('tasks.modelDefault')
    const prov = providers.find((x) => x.id === ref.slice(0, idx))
    return prov?.models.find((m) => m.id === ref.slice(idx + 1))?.name ?? t('tasks.modelDefault')
  }
}

/** 下次触发的短写法（月/日 时:分）；null = 不会再触发。 */
function useNextShort(): (ms: number | null) => string {
  const { t, locale } = useI18n()
  return (ms) =>
    ms == null
      ? t('tasks.previewNever')
      : new Date(ms).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
}

export function TaskConfirmCard({
  block,
  onOpen
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
  /** created 态「查看任务」：把任务记录 id 交给外壳定位（缺省 → 不显跳转）。 */
  onOpen?: (taskId: string) => void
}): React.JSX.Element {
  // 编辑器与终态各自无条件调用自身 hooks（分派在此，规避条件 hooks）。
  if (block.status === 'pending') return <TaskEditor block={block} />
  return <TaskTerminalCard block={block} onOpen={onOpen} />
}

/**
 * 已决终态：created（表头右上角「查看任务」+ 绿勾，下面时间 / 执行两行）/ dismissed（已忽略一行）。
 * 任务从 store 的列表实时取：改日程等即时反映；任务已删则只剩表头。
 */
function TaskTerminalCard({
  block,
  onOpen
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
  onOpen?: (taskId: string) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { personas } = useExtensions()
  const { tasks } = useTasks()
  const modelLabel = useModelLabel()
  const nextShort = useNextShort()
  const task = useMemo(
    () => (block.status === 'created' && block.taskId ? (tasks.find((x) => x.id === block.taskId) ?? null) : null),
    [tasks, block.status, block.taskId]
  )
  const [desc, setDesc] = useState('')
  const sig = task ? `${task.schedule.kind}|${task.schedule.at ?? ''}|${task.schedule.cron ?? ''}|${task.schedule.tz}` : ''
  // 日程的人读摘要（用户可能在编辑器改过日程，草稿不含这些）。
  useEffect(() => {
    if (!task) return
    let alive = true
    void window.deva.tasks
      .preview(task.schedule, locale, true)
      .then((p) => {
        if (alive && p.ok) setDesc(p.description)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, locale])

  if (block.status === 'dismissed') {
    return (
      <div className="autotaskcard autotaskcard--dismissed">
        <span className="autotaskcard__icon">
          <CalendarClock size={16} />
        </span>
        <span className="autotaskcard__done-text">{t('tasks.dismissed')}</span>
      </div>
    )
  }

  const title = task?.title || block.draft.title || t('tasks.cardTitle')
  // 执行身份：任务的角色（未指定 = 默认角色 Deva）。
  const personaName = personas.find((p) => p.id === task?.auth.personaId)?.name ?? t('tasks.personaNone')
  return (
    <div className="autotaskcard autotaskcard--card is-done">
      <div className="autotaskcard__chead">
        <CalendarClock size={15} />
        <span className="autotaskcard__kind">{t('tasks.cardTitle')} ·</span>
        <span className="autotaskcard__ctitle">{title}</span>
        {/* 右上角：「查看任务」+ 绿色对勾（悬停提示已创建），不另占一行 */}
        <span className="autotaskcard__headacts">
          {block.taskId && onOpen && (
            <button className="btn btn--ghost btn--sm" onClick={() => block.taskId && onOpen(block.taskId)}>
              {t('tasks.createdOpen')}
            </button>
          )}
          <span className="autotaskcard__ok" title={t('tasks.created')} aria-label={t('tasks.created')}>
            <Check size={15} />
          </span>
        </span>
      </div>
      {task && (
        <div className="autotaskcard__rows">
          <span className="autotaskcard__k">{t('tasks.rowTime')}</span>
          <span className="autotaskcard__v">
            {desc || task.schedule.cron || task.schedule.at || ''}
            <span className="autotaskcard__dim">
              {' '}
              · {t('tasks.previewNext')} {nextShort(task.nextRunAt)}
            </span>
          </span>
          <span className="autotaskcard__k">{t('tasks.rowExec')}</span>
          <span className="autotaskcard__v">
            {personaName} · {modelLabel(task.auth.modelRef)}
          </span>
        </div>
      )}
    </div>
  )
}

/** 待决态：摘要卡 ⇄ 完整可编辑授权信封（表单态在本组件，收起不丢改动）。 */
function TaskEditor({
  block
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { resolveAutotask, currentBinding } = useChat()
  const { personas } = useExtensions()
  const modelLabel = useModelLabel()
  const nextShort = useNextShort()

  const { draft } = block

  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)

  // 授权信封（默认取当前对话绑定：人格 / 模型）
  const [personaId, setPersonaId] = useState<string | null>(currentBinding.personaId ?? null)
  const [modelRef, setModelRef] = useState<string | null>(currentBinding.model ?? null)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 摘要 / 展开编辑：指令为空的草稿直接展开（摘要态无从补全）。
  const [editing, setEditing] = useState(() => !draft.prompt.trim())

  // 摘要态不挂 TaskPersonaSelect，故在此复刻其「null → 首个已启用角色」兜底，保证任务始终带具体角色。
  const enabledPersonas = useMemo(() => personas.filter((p) => p.enabled), [personas])
  useEffect(() => {
    if (personaId == null && enabledPersonas.length > 0) setPersonaId(enabledPersonas[0].id)
  }, [personaId, enabledPersonas])
  const personaName = enabledPersonas.find((p) => p.id === personaId)?.name ?? t('tasks.personaNone')

  // 创建时捕获的时区：草稿带则用（模型建议），否则本地时区。
  const tz = useMemo(
    () => draft.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    [draft.schedule.tz]
  )

  // 送 preview / create 的日程对象：由日程编辑器（ScheduleEditor）拼好后回填，初值取草稿 + 本卡时区。
  const [schedule, setSchedule] = useState<TaskSchedule>(() => ({ ...draft.schedule, tz }))

  // 实时预览（轻防抖）：人读摘要 + 下次触发；校验失败即时暴露（绝不留到触发时才失败）。
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
  const canConfirm = !busy && prompt.trim().length > 0 && !scheduleInvalid

  // 草稿日程无效 / 创建失败：自动展开到编辑态，问题字段直接可见可改。
  useEffect(() => {
    if (scheduleInvalid || err) setEditing(true)
  }, [scheduleInvalid, err])

  const confirm = async (): Promise<void> => {
    if (!canConfirm) return
    setBusy(true)
    setErr(null)
    const input: TaskCreateInput = {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      auth: { personaId, modelRef }
    }
    const res = await resolveAutotask(block.id, 'create', input)
    if (!res.ok) {
      setErr(taskErrorKey(res.error))
      setBusy(false)
    }
    // 成功：store 将本块打为 created → 重渲染切至终态卡（本编辑器卸载）。
  }

  const dismiss = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    await resolveAutotask(block.id, 'dismiss')
    // 成功：store 打为 dismissed → 切终态；失败则保持可编辑（放开 busy 供重试）。
    setBusy(false)
  }

  const actions = (
    <>
      <button className="btn btn--sm" disabled={busy} onClick={dismiss}>
        {t('tasks.dismiss')}
      </button>
      <button className="btn btn--primary btn--sm" disabled={!canConfirm} onClick={confirm}>
        <Check size={13} /> {t('tasks.confirm')}
      </button>
    </>
  )

  if (!editing) {
    return (
      <div className="autotaskcard autotaskcard--card is-pending">
        <div className="autotaskcard__chead">
          <CalendarClock size={15} />
          <span className="autotaskcard__kind">{t('tasks.cardTitle')} ·</span>
          <span className="autotaskcard__ctitle">{title.trim() || t('tasks.fTitlePlaceholder')}</span>
          <button className="btn btn--ghost btn--sm autotaskcard__headact" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil size={12} /> {t('tasks.edit')}
          </button>
        </div>
        <div className="autotaskcard__rows">
          <span className="autotaskcard__k">{t('tasks.rowTime')}</span>
          <span className="autotaskcard__v">
            {preview && preview.ok ? (
              <>
                {preview.description}
                <span className="autotaskcard__dim">
                  {' '}
                  · {t('tasks.previewNext')} {nextShort(preview.nextRunAt)}
                </span>
              </>
            ) : (
              <span className="autotaskcard__dim">…</span>
            )}
          </span>
          <span className="autotaskcard__k">{t('tasks.rowExec')}</span>
          <span className="autotaskcard__v">
            {personaName} · {modelLabel(modelRef)}
          </span>
          <span className="autotaskcard__k">{t('tasks.rowPrompt')}</span>
          <span className="autotaskcard__v is-clip" title={prompt}>
            {prompt}
          </span>
        </div>
        <div className="autotaskcard__cfoot">{actions}</div>
      </div>
    )
  }

  return (
    <div className="autotaskcard autotaskcard--card is-pending">
      <div className="autotaskcard__chead">
        <CalendarClock size={15} />
        <span className="autotaskcard__kind">{t('tasks.cardTitle')}</span>
        <button className="btn btn--ghost btn--sm autotaskcard__headact" disabled={busy} onClick={() => setEditing(false)}>
          <ChevronUp size={13} /> {t('tasks.collapse')}
        </button>
      </div>
      <div className="autotaskcard__form">
        {/* 标题 */}
        <label className="autotaskcard__field">
          <span className="autotaskcard__label">{t('tasks.fTitle')}</span>
          <input
            className="autotaskcard__input"
            value={title}
            placeholder={t('tasks.fTitlePlaceholder')}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        {/* 日程 */}
        <div className="autotaskcard__field">
          <span className="autotaskcard__label">{t('tasks.fSchedule')}</span>
          {/* 收起再展开会重挂编辑器：以当前日程为初值，保留已做的改动。 */}
          <ScheduleEditor initial={schedule} tz={tz} onChange={setSchedule} />

          {/* 日程预览：人读摘要 + 下次触发；无效即时提示。 */}
          <div className={`autotaskcard__preview${scheduleInvalid ? ' is-invalid' : ''}`}>
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
              <span className="autotaskcard__preview-dim">…</span>
            )}
          </div>
        </div>

        {/* 任务指令：与对话输入框同款内嵌盒（更高、不可拖），底部工具条内嵌人格 / 模型 chip 选择器。
            用 div 而非 label 包裹——盒内含可点 chip 按钮，label 会把点击错误转派给 textarea。 */}
        <div className="autotaskcard__field">
          <span className="autotaskcard__label">{t('tasks.fPrompt')}</span>
          <div className="cf-box cf-box--task">
            <textarea
              value={prompt}
              placeholder={t('tasks.fPromptPlaceholder')}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="cf-box__bar">
              <TaskPersonaSelect value={personaId} onChange={setPersonaId} />
              <TaskModelSelect value={modelRef} onChange={setModelRef} />
            </div>
          </div>
        </div>

        {err && (
          <div className="autotaskcard__err">
            <AlertTriangle size={13} />
            <span>{t(err)}</span>
          </div>
        )}

        <div className="autotaskcard__actions">{actions}</div>
      </div>
    </div>
  )
}
