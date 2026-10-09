import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, AlertTriangle, Pencil, ChevronUp } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChat, type ChatBlock } from '../../store/chat'
import { useExtensions } from '../../store/extensions'
import { useModels } from '../../store/models'
import type { TaskCreateInput, TaskSchedule, PreviewScheduleResult, TaskRecord } from '../../../../preload'
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
 * pending → 默认**摘要卡**（标题 + 日程/下次/角色/模型一行 + 指令单行省略，一键创建）；点「编辑」原地展开
 * 完整编辑表单，日程无效 / 指令为空 / 创建失败时自动展开。created/dismissed → 紧凑终态（编辑器卸载，表单态自然丢弃）。
 * 日程一栏整块交给 ./ScheduleEditor（与任务编辑弹窗共用同一控件，cron 反解/拼装再下沉 ./schedule 单一真源）。
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

/** 待决态：摘要卡 ⇄ 完整可编辑授权信封（表单态在本组件，收起不丢改动）。 */
function TaskEditor({
  block
}: {
  block: Extract<ChatBlock, { kind: 'autotaskcard' }>
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { resolveAutotask, currentBinding } = useChat()
  const { personas } = useExtensions()
  const { providers } = useModels()

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
  const personaName =
    enabledPersonas.find((p) => p.id === personaId)?.name ?? t('tasks.personaNone')
  const modelName = useMemo(() => {
    const idx = modelRef ? modelRef.indexOf(':') : -1
    if (!modelRef || idx <= 0) return t('tasks.modelDefault')
    const prov = providers.find((x) => x.id === modelRef.slice(0, idx))
    return (
      prov?.models.find((m) => m.id === modelRef.slice(idx + 1))?.name ?? t('tasks.modelDefault')
    )
  }, [modelRef, providers, t])

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

  // 摘要行用短格式（月/日 时:分），完整格式留给展开态的预览条。
  const nextShort = (ms: number | null): string =>
    ms == null
      ? t('tasks.previewNever')
      : new Date(ms).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })

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
    <div className="autotaskcard__actions">
      <button className="btn btn--sm" disabled={busy} onClick={dismiss}>
        {t('tasks.dismiss')}
      </button>
      <button className="btn btn--primary btn--sm" disabled={!canConfirm} onClick={confirm}>
        <Check size={13} /> {t('tasks.confirm')}
      </button>
    </div>
  )

  if (!editing) {
    const meta = [
      preview && preview.ok
        ? `${preview.description} · ${t('tasks.previewNext')} ${nextShort(preview.nextRunAt)}`
        : '…',
      personaName,
      modelName
    ].join(' · ')
    return (
      <div className="autotaskcard autotaskcard--summary">
        <span className="autotaskcard__head-icon">
          <CalendarClock size={15} />
        </span>
        <div className="autotaskcard__sum-body">
          <div className="autotaskcard__sum-title">{title.trim() || t('tasks.cardTitle')}</div>
          <div className="autotaskcard__sum-meta">{meta}</div>
          <div className="autotaskcard__sum-prompt" title={prompt}>
            {prompt}
          </div>
        </div>
        <div className="autotaskcard__sum-side">
          <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil size={12} /> {t('tasks.edit')}
          </button>
          {actions}
        </div>
      </div>
    )
  }

  return (
    <div className="autotaskcard autotaskcard--edit">
      <div className="autotaskcard__head">
        <span className="autotaskcard__head-icon">
          <CalendarClock size={15} />
        </span>
        {t('tasks.cardTitle')}
        <button
          className="btn btn--ghost btn--sm autotaskcard__collapse"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          <ChevronUp size={13} /> {t('tasks.collapse')}
        </button>
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

      {actions}
    </div>
  )
}
