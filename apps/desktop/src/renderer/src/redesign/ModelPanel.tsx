/**
 * 输入框工具条上的模型面板。
 *
 * 贴片：上下文占用圆环（服务商色，顶替原来的色点）+ 模型名；选了思考等级（非「默认」）再加「灯泡 + 档位」。
 * 圆环不配数字，百分比在悬停提示与面板里。没有读数（新对话、模型已删）时仍是服务商色点。
 * 面板一层到底、没有二级菜单，从上到下：本对话的上下文容量（一行「已用/窗口 (百分比)」、进度条与自动压缩竖线；
 * 新对话还没有读数时只写窗口、进度条为空）；全部模型按服务商分组平铺（ModelMenu.tsx），点一下即切换并收起；
 * 底部一排思考等级，点了不收起，可以接着换模型。换模型、换档都是「点贴片 + 点一下」。
 * 接近压缩也不变色、不提醒：压缩是自动的，不需要用户处理。
 *
 * 切换语义同原来的两个独立选择器：只改本对话并立即落库（setSessionModel / setSessionEffort），同时记为
 * 「最近使用」（setActiveModel / setActiveEffort），新对话未选时沿用最近使用。显示的是本对话生效模型：
 * 本对话已选 → 否则回落最近使用（与主进程 resolveModelRef 的兜底一致）。档位按该模型支持的档收敛显示
 * （clampEffort，与主进程实际发送的一致）；只能开、不能调档的模型唯一一档显示为「开启」。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, Lightbulb } from 'lucide-react'
import type { ContextUsage, EffortLevel } from '../../../preload'
import { useChatActions, useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { clampEffort, isToggleEffort, supportedEffortLevels, type EffortAdapter } from '../../../shared/effort'
import { formatTokens } from '../../../shared/context'
import { useI18n } from '../i18n/i18n'
import { ModelMenu, type ModelGroup } from './ModelMenu'
import { approxTokens, usagePercent, usageRatio, useContextUsage } from './context-usage'
import './model-panel.css'

export function ModelPanel(): React.JSX.Element {
  const { activeModel, providers, setActiveModel, activeEffort, setActiveEffort } = useModels()
  const { currentBinding, currentSessionId, sessions } = useChatState()
  const { setSessionModel, setSessionEffort } = useChatActions()
  const [open, setOpen] = useState(false)

  // 只列对话模型（purpose==='llm'）：决策模型（如 Jev）不生成文本，绝不可被选为对话模型。
  const groups: ModelGroup[] = providers
    .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0)
  const active = findActive(providers, currentBinding.model ?? null) ?? activeModel
  const modelRef = active ? `${active.provider.id}:${active.model.id}` : null
  const usage = useContextUsage(
    currentSessionId,
    modelRef,
    `${active?.model.contextWindow ?? ''}|${active?.model.maxOutput ?? ''}`,
    sessions.find((s) => s.id === currentSessionId)?.updatedAt
  )
  const effort = useEffort(active, currentBinding.effort ?? activeEffort)

  // Esc 收起面板。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const accent = active?.provider.accent ?? 'var(--fg-subtle)'

  return (
    <div className="model-pick cf-mp">
      <PanelChip
        active={active}
        accent={accent}
        usage={active && usage && usage.used != null ? usage : null}
        effort={effort}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="cf-mp__panel">
            <UsageSection usage={active ? usage : null} accent={accent} />
            <ModelMenu
              groups={groups}
              activePid={active?.provider.id ?? null}
              activeMid={active?.model.id ?? null}
              onPick={(pid, mid) => {
                // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话未选时的默认。
                setSessionModel(`${pid}:${mid}`)
                setActiveModel(pid, mid)
                setOpen(false)
              }}
            />
            {active && (
              <EffortSection
                effort={effort}
                onPick={(lv) => {
                  // 不收起：换完档常常接着换模型，换了模型这一排也会跟着变成新模型支持的档。
                  setSessionEffort(lv)
                  setActiveEffort(lv)
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

type Active = ReturnType<typeof findActive>

/**
 * 贴片：占用圆环（顶替服务商色点）+ 模型名 + 思考档；没有读数时仍是色点。圆环不配数字，
 * 已用/窗口与百分比写在悬停提示里，点开面板看详情。
 */
function PanelChip({
  active,
  accent,
  usage,
  effort,
  open,
  onToggle
}: {
  active: Active
  accent: string
  usage: ContextUsage | null
  effort: EffortInfo
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const levelName = effort.current !== 'default' ? effort.nameOf(effort.current) : ''
  const title = [
    active ? active.model.name : t('chat.selectModel'),
    levelName && `${t('chat.effort.title')}：${levelName}`,
    usage && `${t('chat.panel.context')} ${usageText(t, usage)}`
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      className={`chip cf-mp__chip${open ? ' is-open' : ''}`}
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
    >
      {usage ? (
        <ContextRing ratio={usageRatio(usage)} color={accent} />
      ) : (
        active && <span className="chip__dot" style={{ background: accent }} />
      )}
      <span className="chip__label">{active ? active.model.name : t('chat.selectModel')}</span>
      {levelName && (
        <span className="cf-mp__eff">
          <Lightbulb size={13} />
          {levelName}
        </span>
      )}
      <ChevronDown size={13} className="chip__caret" />
    </button>
  )
}

type T = (key: string) => string

/**
 * 「199K/1M (19.9%)」：已用照实写（可能超过窗口），百分比最多 100%，估算值前面加「约」。
 * 还没有读数（新对话）时只写窗口「1M」。
 */
function usageText(t: T, u: ContextUsage): string {
  if (u.used == null) return formatTokens(u.window)
  const text = t('chat.panel.usage')
    .replace('{used}', approxTokens(u.used))
    .replace('{window}', formatTokens(u.window))
    .replace('{pct}', usagePercent(u))
  return u.estimated ? t('chat.panel.approx').replace('{n}', text) : text
}

/** 占用圆环：灰色底圈 + 服务商色弧（从 12 点顺时针）。 */
function ContextRing({ ratio, color }: { ratio: number; color: string }): React.JSX.Element {
  const r = 5.25
  const c = 2 * Math.PI * r
  const len = ratio * c
  return (
    <svg className="cf-mp__ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="cf-mp__ring-track" cx="7" cy="7" r={r} fill="none" strokeWidth="1.75" />
      {len > 0.01 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeDasharray={`${len.toFixed(2)} ${c.toFixed(2)}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  )
}

/**
 * 面板顶部：上下文容量。一行「上下文容量 …… 199K/1M (19.9%)」加进度条（竖线标出自动压缩的位置）。
 * 新对话还没有读数：右侧只写窗口，进度条是空的。模型解析不了（已删）时整段不显示。
 * 不另写说明文字：估算值只在数字前加「约」；超出窗口时百分比封顶 100%，下次发送会自动先压缩。
 */
function UsageSection({ usage, accent }: { usage: ContextUsage | null; accent: string }): React.JSX.Element | null {
  const { t } = useI18n()
  if (!usage) return null
  const tick = usage.trigger != null && usage.window > 0 ? Math.min(1, usage.trigger / usage.window) : null
  return (
    <div className="cf-mp__usage">
      <div className="cf-mp__top">
        <span className="cf-mp__title">{t('chat.panel.context')}</span>
        <span className="cf-mp__big">{usageText(t, usage)}</span>
      </div>
      <div className="cf-mp__bar">
        <div className="cf-mp__fill" style={{ width: `${(usageRatio(usage) * 100).toFixed(1)}%`, background: accent }} />
        {tick != null && (
          <span
            className="cf-mp__tick"
            title={t('chat.panel.autoCompact')}
            style={{ left: `${(tick * 100).toFixed(1)}%` }}
          />
        )}
      </div>
    </div>
  )
}

interface EffortInfo {
  levels: EffortLevel[]
  current: EffortLevel
  nameOf: (lv: EffortLevel) => string
  hintOf: (lv: EffortLevel) => string
}

/** 本对话生效模型支持的思考档与当前档（不支持时 levels 为空、current 为 default）。 */
function useEffort(active: Active, stored: EffortLevel): EffortInfo {
  const { t } = useI18n()
  // 对话模型的 adapter 必属三协议之一。
  const adapter = active?.provider.adapter as EffortAdapter | undefined
  const modelId = active?.model.id
  const levels = adapter && modelId ? supportedEffortLevels(adapter, modelId) : []
  const toggle = !!adapter && !!modelId && isToggleEffort(adapter, modelId)
  const current: EffortLevel =
    adapter && modelId && levels.length > 0 ? clampEffort(adapter, modelId, stored) : 'default'
  return {
    levels,
    current,
    nameOf: (lv) => (toggle && lv !== 'default' ? t('chat.effort.on') : t(`chat.effort.levels.${lv}`)),
    hintOf: (lv) => (toggle && lv !== 'default' ? t('chat.effort.onHint') : t(`chat.effort.hints.${lv}`))
  }
}


/**
 * 面板底部：思考等级一排（「默认」+ 该模型支持的档），点一下即切换。标题右侧写悬停档（否则当前档）的一行说明。
 * 模型不支持思考等级时只写「不支持」。
 */
function EffortSection({
  effort,
  onPick
}: {
  effort: EffortInfo
  onPick: (lv: EffortLevel) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [hover, setHover] = useState<EffortLevel | null>(null)
  if (effort.levels.length === 0)
    return (
      <div className="cf-mp__effort">
        <div className="cf-mp__efhead">
          <span className="cf-mp__title">{t('chat.effort.title')}</span>
          <span className="cf-mp__efhint">{t('chat.effort.unsupported')}</span>
        </div>
      </div>
    )
  const options: EffortLevel[] = ['default', ...effort.levels]
  // 换了模型后悬停的档可能已不在列表里。
  const shown = hover && options.includes(hover) ? hover : effort.current
  return (
    <div className="cf-mp__effort">
      <div className="cf-mp__efhead">
        <span className="cf-mp__title">{t('chat.effort.title')}</span>
        <span className="cf-mp__efhint" title={effort.hintOf(shown)}>
          {effort.hintOf(shown)}
        </span>
      </div>
      <div className="cf-mp__segs" role="radiogroup" aria-label={t('chat.effort.title')}>
        {options.map((lv) => {
          const on = lv === effort.current
          return (
            <button
              key={lv}
              type="button"
              role="radio"
              aria-checked={on}
              title={effort.hintOf(lv)}
              className={`cf-mp__seg${on ? ' is-on' : ''}`}
              onMouseEnter={() => setHover(lv)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(lv)}
              onBlur={() => setHover(null)}
              onClick={() => onPick(lv)}
            >
              {effort.nameOf(lv)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
