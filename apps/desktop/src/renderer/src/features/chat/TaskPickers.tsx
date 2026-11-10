import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CalendarClock, ChevronDown, Check } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useModels } from '../../store/models'
import { useExtensions } from '../../store/extensions'
import { useChat, type SessionMeta } from '../../store/chat'
import { Select } from '../../components/Select'

/**
 * 任务表单内嵌的**受控**模型 / 人格选择器——镜像对话输入框 ModelPicker 的 chip + model-pick 菜单
 * （复用 app.css 的 model-pick / chip / model-pick__menu 类，零新增 CSS），供创建名片与编辑弹窗共用，
 * 使任务的模型/角色切换与对话内嵌选择器**同款交互**。
 *
 * 与对话 ModelPicker 的区别：这两个是**受控**的（value/onChange，不写全局 activeModel / 会话覆盖层）。
 * 模型选择器带一枚「全局默认」项（value=null）——未选时由主进程按 tasks.modelDefault 兜底解析。
 * 人格选择器**不设**「跟随默认」：定时任务在后台密封执行、无「当前对话」可跟随，故必须固定一个具体角色，
 * value 为 null（旧任务 / 创建卡默认）时自动落到首个已启用角色。菜单向上弹出（.model-pick__menu
 * bottom:calc(100%+8px)），恰在指令框工具条上方。
 */

/** 受控模型选择器。value 为 `"providerId:modelId"` 或 null（= 跟随默认）。 */
export function TaskModelSelect({
  value,
  onChange
}: {
  value: string | null
  onChange: (ref: string | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { providers } = useModels()
  const [open, setOpen] = useState(false)

  // 任务的写作模型只取对话模型（purpose==='llm'）；决策模型（Jev）不生成文本，排除。
  const groups = useMemo(
    () =>
      providers
        .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
        .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
        .filter((g) => g.models.length > 0),
    [providers]
  )

  // 当前所选模型的展示信息（含服务商品牌色点）；空 / 非法 / 已删除 → null（chip 显「跟随默认」）。
  const selected = useMemo(() => {
    if (!value) return null
    const idx = value.indexOf(':')
    if (idx <= 0) return null
    const pid = value.slice(0, idx)
    const mid = value.slice(idx + 1)
    const p = providers.find((x) => x.id === pid)
    const m = p?.models.find((x) => x.id === mid)
    if (p && m) return { pid, mid, name: m.name, accent: p.accent }
    return null
  }, [value, providers])

  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={t('tasks.fModel')}
        onClick={() => setOpen((v) => !v)}
      >
        {selected && <span className="chip__dot" style={{ background: selected.accent }} />}
        <span className="chip__label">{selected ? selected.name : t('tasks.modelDefault')}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            {/* 跟随默认（清空覆盖，交主进程按 tasks.modelDefault 兜底） */}
            <button
              role="menuitemradio"
              aria-checked={value == null}
              className={`model-pick__item${value == null ? ' is-active' : ''}`}
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
            >
              <span className="model-pick__name">{t('tasks.modelDefault')}</span>
              {value == null && <Check size={14} className="model-pick__check" />}
            </button>
            {groups.length === 0 && <div className="model-pick__empty">{t('chat.noModel')}</div>}
            {groups.map(({ p, models }) => (
              <div key={p.id} className="model-pick__group">
                <div className="model-pick__group-head">
                  <span className="model-pick__dot" style={{ background: p.accent }} />
                  <span className="model-pick__group-name">{p.name}</span>
                </div>
                {models.map((m) => {
                  const active = selected?.pid === p.id && selected?.mid === m.id
                  const ref = `${p.id}:${m.id}`
                  return (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={active}
                      className={`model-pick__item${active ? ' is-active' : ''}`}
                      title={m.name}
                      onClick={() => {
                        onChange(ref)
                        setOpen(false)
                      }}
                    >
                      <span className="model-pick__name">{m.name}</span>
                      {active && <Check size={14} className="model-pick__check" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 运行方式菜单里最多列出的会话数（按最近更新）；当前选中的会话不在其中时另外补上。 */
const RUN_MODE_MAX_CHATS = 12

/** 「在「X」中运行」里会话名的显示宽度上限（按半角计，中文等全角字符算 2）：运行方式贴片 / 任务详情。 */
export const RUN_CHAT_TITLE_CHIP = 14
export const RUN_CHAT_TITLE_DETAIL = 24

/** 占两格的字符：中日韩文字与标点、谚文、全角符号，以及表情等增补平面字符（高位代理）。 */
const WIDE_CHAR =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud800-\udbff]/

/**
 * 会话名过长时截短，留出「在「」中运行」的位置，整句不被截掉：按显示宽度算（中日韩与全角字符算 2，其余算 1），
 * 超出 max 时截到 max 以内并补「…」。完整名字由调用方放在悬停提示里。
 */
export function clipChatTitle(name: string, max: number): string {
  const units = (c: string): number => (WIDE_CHAR.test(c) ? 2 : 1)
  const chars = Array.from(name)
  if (chars.reduce((n, c) => n + units(c), 0) <= max) return name
  let used = 0
  let out = ''
  for (const c of chars) {
    // 留 1 格给省略号（省略号本身按 1 计，与半角同宽）。
    if (used + units(c) > max - 1) break
    used += units(c)
    out += c
  }
  return `${out.trimEnd()}…`
}

/** 「独立运行」在下拉框里的值（会话 id 不会是空串）。 */
const RUN_ALONE = ''

/**
 * 受控运行方式选择器（编辑定时任务的弹窗里，排在角色 / 模型前面）。value 为会话 id（= 在该会话中运行）或 null
 * （= 独立运行，默认）。用统一下拉框（同技能 / MCP 的「可用角色」）：第一项「独立运行」，其下「在会话中运行」一组列出
 * 最近的普通会话（不含成员会话、任务自己的对话、已归档的），每行是会话头像 + 标题 + 第二行（挂了文件夹写文件夹名，
 * 否则写角色名，同左侧对话列表）。收起态做成与角色 / 模型同款的贴片。浮层渲染到 body，不会被弹窗的滚动区裁掉。
 * 会话删除后主进程把任务改回独立运行，这里拿不到该会话时同样按独立运行显示。
 */
export function TaskRunModeSelect({
  value,
  taskSessionId,
  faceOf,
  onChange
}: {
  value: string | null
  /** 任务自己的对话 id（编辑态）：不能选它本身。 */
  taskSessionId?: string
  /** 会话头像（同左侧对话列表：有成员时是群组头像），size 为边长。 */
  faceOf: (session: SessionMeta, size: number) => ReactNode
  onChange: (sessionId: string | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { sessions } = useChat()
  const { personas } = useExtensions()

  const chats = useMemo(() => {
    const usable = sessions
      .filter((s) => !s.id.startsWith('task-') && s.id !== taskSessionId && !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RUN_MODE_MAX_CHATS)
    const cur = value ? sessions.find((s) => s.id === value) : undefined
    return cur && !usable.some((s) => s.id === cur.id) ? [cur, ...usable] : usable
  }, [sessions, taskSessionId, value])
  const current = value ? sessions.find((s) => s.id === value) : undefined
  const titleOf = (title: string): string => title || t('chat.untitled')
  // 第二行：挂了文件夹写文件夹名，否则写角色名（同左侧对话列表）。
  const subOf = (s: SessionMeta): string | undefined => {
    if (s.focusRoot) return s.focusRoot.split(/[\\/]/).filter(Boolean).pop()
    return personas.find((p) => p.id === s.personaId)?.name
  }

  const display = current ? (
    <>
      <span className="select__lead">
        <span className="select-ava">{faceOf(current, 16)}</span>
      </span>
      <span className="select__label">
        {t('tasks.runInChatNamed').replace('{name}', clipChatTitle(titleOf(current.title), RUN_CHAT_TITLE_CHIP))}
      </span>
    </>
  ) : (
    <>
      <span className="select__lead">
        <span className="select-icon">
          <CalendarClock size={13} />
        </span>
      </span>
      <span className="select__label">{t('tasks.runAlone')}</span>
    </>
  )

  return (
    <Select<string>
      inline
      className="select--chip"
      menuClassName="select-menu--runmode"
      aria-label={t('tasks.fRunMode')}
      value={current ? current.id : RUN_ALONE}
      display={display}
      onChange={(v) => onChange(v === RUN_ALONE ? null : v)}
      items={[
        {
          value: RUN_ALONE,
          label: t('tasks.runAlone'),
          sub: t('tasks.runAloneHint'),
          lead: (
            <span className="select-icon">
              <CalendarClock size={14} />
            </span>
          )
        },
        // 没有可选的会话：只剩「独立运行」一项，不留空的分组标题。
        ...(chats.length
          ? [
              { separator: true as const },
              { group: t('tasks.runInChat') },
              ...chats.map((s) => ({
                value: s.id,
                label: titleOf(s.title),
                sub: subOf(s),
                lead: <span className="select-ava">{faceOf(s, 26)}</span>
              }))
            ]
          : [])
      ]}
    />
  )
}

/** 受控人格选择器。value 为 personaId 或 null（= 跟随默认）。 */
export function TaskPersonaSelect({
  value,
  onChange
}: {
  value: string | null
  onChange: (id: string | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { personas } = useExtensions()
  const [open, setOpen] = useState(false)

  const enabled = useMemo(() => personas.filter((p) => p.enabled), [personas])
  // 当前所选人格（含身份主题色点）；空 / 已删除 / 已停用 → null（chip 显中性占位）。
  const selected = useMemo(() => (value ? enabled.find((p) => p.id === value) ?? null : null), [
    value,
    enabled
  ])

  // 无「跟随默认」项：value 为 null（旧任务 / 创建卡当前对话无绑定）时，自动落到首个已启用角色，
  // 使任务始终携带一个具体角色。已选中即不再触发（onChange 为父层 setState，引用稳定，无循环）。
  useEffect(() => {
    if (value == null && enabled.length > 0) onChange(enabled[0].id)
  }, [value, enabled, onChange])

  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={t('tasks.fPersona')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chip__label">{selected ? selected.name : t('tasks.personaNone')}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            {enabled.map((p) => {
              const active = value === p.id
              return (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={active}
                  className={`model-pick__item${active ? ' is-active' : ''}`}
                  title={p.name}
                  onClick={() => {
                    onChange(p.id)
                    setOpen(false)
                  }}
                >
                  <span className="model-pick__name">{p.name}</span>
                  {active && <Check size={14} className="model-pick__check" />}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
