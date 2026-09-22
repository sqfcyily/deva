import { useMemo, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useModels } from '../../store/models'
import { useExtensions } from '../../store/extensions'

/**
 * 任务表单内嵌的**受控**模型 / 人格选择器——镜像对话输入框 ModelPicker 的 chip + model-pick 菜单
 * （复用 app.css 的 model-pick / chip / model-pick__menu 类，零新增 CSS），供创建名片与编辑弹窗共用，
 * 使任务的模型/角色切换与对话内嵌选择器**同款交互**。
 *
 * 与对话 ModelPicker 的区别：这两个是**受控**的（value/onChange，不写全局 activeModel / 会话覆盖层），
 * 且各带一枚「跟随默认」项（value=null）——任务未选模型/人格时由主进程按 tasks.modelDefault /
 * tasks.personaDefault 兜底解析。菜单向上弹出（.model-pick__menu bottom:calc(100%+8px)），恰在指令框工具条上方。
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

  const groups = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
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
  // 当前所选人格（含身份主题色点）；空 / 已删除 / 已停用 → null（chip 显「跟随默认」）。
  const selected = useMemo(() => (value ? enabled.find((p) => p.id === value) ?? null : null), [
    value,
    enabled
  ])

  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={t('tasks.fPersona')}
        onClick={() => setOpen((v) => !v)}
      >
        {selected && <span className="chip__dot" style={{ background: selected.color }} />}
        <span className="chip__label">{selected ? selected.name : t('tasks.personaDefault')}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            {/* 跟随默认（清空覆盖，交主进程按 tasks.personaDefault 兜底） */}
            <button
              role="menuitemradio"
              aria-checked={value == null}
              className={`model-pick__item${value == null ? ' is-active' : ''}`}
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
            >
              <span className="model-pick__name">{t('tasks.personaDefault')}</span>
              {value == null && <Check size={14} className="model-pick__check" />}
            </button>
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
                  <span className="model-pick__dot" style={{ background: p.color }} />
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
