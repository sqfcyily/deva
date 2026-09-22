import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, AlertTriangle } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChat, type ChatBlock } from '../../store/chat'
import type { TaskCreateInput, TaskSchedule, PreviewScheduleResult, TaskRecord } from '../../../../preload'
import { buildCron, localDatetimeValue, parseRecur, type ScheduleMode } from './schedule'
import { TaskModelSelect, TaskPersonaSelect } from './TaskPickers'

/**
 * 定时任务确认名片（autotaskcard）——**唯一的授权时刻**。
 * 模型调 create_task 只写下建议草稿；此名片是可编辑信封（标题/指令/日程/人格/模型），
 * 用户核对并点「创建」才真正建任务与独占会话（`resolveAutotask('create', input)`）。
 * 创建后触发零交互，故授权在此一次性议定完毕（对齐「创建时批准、执行时零交互」铁律）；
 * 工具全放行（含 skill/mcp）、通知固定开启，唯凭据/系统/受保护目录与危险命令由密封策略静默拒绝——
 * 故名片不再有类型/写入根/工具白名单/通知开关。
 *
 * pending → 完整编辑表单；created/dismissed → 紧凑终态（编辑器卸载，表单态自然丢弃）。
 * cron 反解/拼装与 datetime-local 取值抽到 ./schedule（与任务编辑弹窗共用单一真源）。
 */

/** 创建结果 / 预览错误码 → 本地化 key。 */
function errKey(code: string): string {
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

export function TaskConfirmCard({
  block,
  onOpen
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
  /** created 态「打开任务会话」：把任务记录 id 交给外壳定位其独占会话（缺省 → 不显跳转）。 */
  onOpen?: (taskId: string) => void
}): React.JSX.Element {
  // 编辑器与终态各自无条件调用自身 hooks（分派在此，规避条件 hooks）。
  if (block.status === 'pending') return <TaskEditor block={block} />
  return <TaskTerminalCard block={block} onOpen={onOpen} />
}

/** 已决终态：created（含跳转独占会话）/ dismissed（已忽略）。 */
function TaskTerminalCard({
  block,
  onOpen
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
  onOpen?: (taskId: string) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const [task, setTask] = useState<TaskRecord | null>(null)
  const [desc, setDesc] = useState('')

  // created：拉取真实任务（用户可能在编辑器改过日程/标题，草稿不含这些），据其日程取人读摘要。
  useEffect(() => {
    if (block.status !== 'created' || !block.taskId) return
    let alive = true
    void window.deva.tasks
      .get(block.taskId)
      .then(async (tk) => {
        if (!alive || !tk) return
        setTask(tk)
        const p = await window.deva.tasks.preview(tk.schedule, locale).catch(() => null)
        if (alive && p && p.ok) setDesc(p.description)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [block.status, block.taskId, locale])

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
  return (
    <div className="autotaskcard autotaskcard--created">
      <span className="autotaskcard__icon">
        <CalendarClock size={16} />
      </span>
      <div className="autotaskcard__done-body">
        <span className="autotaskcard__done-title">
          <Check size={13} /> {t('tasks.created')}『{title}』
        </span>
        {desc && <span className="autotaskcard__done-sub">{desc}</span>}
      </div>
      {block.taskId && onOpen && (
        <button
          className="btn btn--sm"
          onClick={() => block.taskId && onOpen(block.taskId)}
        >
          {t('tasks.createdOpen')}
        </button>
      )}
    </div>
  )
}

/** 待决态：完整可编辑授权信封。 */
function TaskEditor({
  block
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { resolveAutotask, currentBinding } = useChat()

  const { draft } = block

  const [title, setTitle] = useState(draft.title)
  const [prompt, setPrompt] = useState(draft.prompt)

  // 日程编辑器（对齐 1.png：一次性 + 各周期合并为单个模式下拉，控件同行）
  const onceInit = useMemo(
    () => draft.schedule.at || localDatetimeValue(new Date(Date.now() + 3600_000)),
    [draft.schedule.at]
  )
  const [onceDate, setOnceDate] = useState(onceInit.slice(0, 10))
  const [onceTime, setOnceTime] = useState(onceInit.slice(11, 16) || '10:00')
  const initRecur = useMemo(() => parseRecur(draft.schedule.cron), [draft.schedule.cron])
  const [mode, setMode] = useState<ScheduleMode>(
    draft.schedule.kind === 'once' ? 'once' : initRecur.mode
  )
  const [time, setTime] = useState(initRecur.time)
  const [dow, setDow] = useState(initRecur.dow)
  const [hourlyMin, setHourlyMin] = useState(initRecur.min)
  const [everyN, setEveryN] = useState(initRecur.n)
  const [dom, setDom] = useState(initRecur.dom)
  const [customCron, setCustomCron] = useState(initRecur.custom)

  // 授权信封（默认取当前对话绑定：人格 / 模型）
  const [personaId, setPersonaId] = useState<string | null>(currentBinding.personaId ?? null)
  const [modelRef, setModelRef] = useState<string | null>(currentBinding.model ?? null)

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 创建时捕获的时区：草稿带则用（模型建议），否则本地时区。
  const tz = useMemo(
    () => draft.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    [draft.schedule.tz]
  )

  const cron = useMemo(
    () => (mode === 'once' ? '' : buildCron(mode, time, dow, hourlyMin, everyN, dom, customCron)),
    [mode, time, dow, hourlyMin, everyN, dom, customCron]
  )

  // 送 preview / create 的日程对象（只带适用字段 + 恒有 tz）。
  const schedule = useMemo<TaskSchedule>(
    () =>
      mode === 'once'
        ? { kind: 'once', at: `${onceDate}T${onceTime}`, tz }
        : { kind: 'recurring', cron, tz },
    [mode, onceDate, onceTime, cron, tz]
  )

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
      setErr(errKey(res.error))
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

  const weekdayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

  return (
    <div className="autotaskcard autotaskcard--edit">
      <div className="autotaskcard__head">
        <span className="autotaskcard__head-icon">
          <CalendarClock size={15} />
        </span>
        {t('tasks.cardTitle')}
      </div>
      <div className="autotaskcard__hint">{t('tasks.cardHint')}</div>

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
        <div className="autotaskcard__sched-row">
          <select
            className="autotaskcard__input autotaskcard__sched-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ScheduleMode)}
          >
            <option value="once">{t('tasks.schedOnce')}</option>
            <option value="everyN">{t('tasks.recurEveryN')}</option>
            <option value="hourly">{t('tasks.recurHourly')}</option>
            <option value="daily">{t('tasks.recurDaily')}</option>
            <option value="weekly">{t('tasks.recurWeekly')}</option>
            <option value="monthly">{t('tasks.recurMonthly')}</option>
            <option value="custom">{t('tasks.recurCustom')}</option>
          </select>

          {mode === 'once' && (
            <>
              <input
                type="date"
                className="autotaskcard__input"
                value={onceDate}
                onChange={(e) => setOnceDate(e.target.value)}
              />
              <input
                type="time"
                className="autotaskcard__input"
                value={onceTime}
                onChange={(e) => setOnceTime(e.target.value)}
              />
            </>
          )}

          {mode === 'weekly' && (
            <select
              className="autotaskcard__input"
              value={dow}
              onChange={(e) => setDow(parseInt(e.target.value, 10))}
            >
              {weekdayKeys.map((k, i) => (
                <option key={k} value={i}>
                  {t(`tasks.weekday.${k}`)}
                </option>
              ))}
            </select>
          )}

          {mode === 'monthly' && (
            <>
              <span className="autotaskcard__row-label">{t('tasks.fDayOfMonth')}</span>
              <input
                type="number"
                min={1}
                max={31}
                className="autotaskcard__input autotaskcard__input--num"
                value={dom}
                onChange={(e) =>
                  setDom(Math.max(1, Math.min(31, parseInt(e.target.value, 10) || 1)))
                }
              />
            </>
          )}

          {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
            <input
              type="time"
              className="autotaskcard__input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}

          {mode === 'hourly' && (
            <>
              <span className="autotaskcard__row-label">{t('tasks.fMinute')}</span>
              <input
                type="number"
                min={0}
                max={59}
                className="autotaskcard__input autotaskcard__input--num"
                value={hourlyMin}
                onChange={(e) => setHourlyMin(parseInt(e.target.value, 10) || 0)}
              />
            </>
          )}

          {mode === 'everyN' && (
            <>
              <span className="autotaskcard__row-label">{t('tasks.fEveryN')}</span>
              <input
                type="number"
                min={1}
                className="autotaskcard__input autotaskcard__input--num"
                value={everyN}
                onChange={(e) => setEveryN(parseInt(e.target.value, 10) || 1)}
              />
            </>
          )}

          {mode === 'custom' && (
            <input
              className="autotaskcard__input autotaskcard__input--mono"
              value={customCron}
              placeholder="0 10 * * *"
              onChange={(e) => setCustomCron(e.target.value)}
            />
          )}
        </div>

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

      <div className="autotaskcard__actions">
        <button className="btn btn--sm" disabled={busy} onClick={dismiss}>
          {t('tasks.dismiss')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={!canConfirm} onClick={confirm}>
          <Check size={13} /> {t('tasks.confirm')}
        </button>
      </div>
    </div>
  )
}
