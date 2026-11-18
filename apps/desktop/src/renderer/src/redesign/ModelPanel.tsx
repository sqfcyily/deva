/**
 * 输入框工具条上的模型面板（对比稿 design/model-panel.html：模型菜单方案 C、贴片写法 ②）。
 *
 * 贴片：上下文占用圆环（服务商色，顶替原来的色点）+ 模型名；选了思考等级（非「默认」）再加「灯泡 + 档位」。
 * 圆环不配数字，百分比在悬停提示与面板里。没有读数（新对话、模型已删）时仍是服务商色点。
 * 面板：上半部分是本对话的上下文占用（百分比最多 100%、进度条与自动压缩竖线、已用 / 窗口、再用多少会压缩）；
 * 下半部分两行「模型」「思考等级」，悬停或点击向左弹出二级菜单（模型菜单见 ModelMenu.tsx）。
 * 接近压缩也不变色、不提醒：压缩是自动的，不需要用户处理。
 *
 * 切换语义同原来的两个独立选择器：只改本对话并立即落库（setSessionModel / setSessionEffort），同时记为
 * 「最近使用」（setActiveModel / setActiveEffort），新对话未选时沿用最近使用。显示的是本对话生效模型：
 * 本对话已选 → 否则回落最近使用（与主进程 resolveModelRef 的兜底一致）。档位按该模型支持的档收敛显示
 * （clampEffort，与主进程实际发送的一致）；只能开、不能调档的模型唯一一档显示为「开启」。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Cpu, Lightbulb } from 'lucide-react'
import type { ContextUsage, EffortLevel } from '../../../preload'
import { useChatActions, useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { clampEffort, isToggleEffort, supportedEffortLevels, type EffortAdapter } from '../../../shared/effort'
import { formatTokens } from '../../../shared/context'
import { useI18n } from '../i18n/i18n'
import { ModelMenu, type ModelGroup } from './ModelMenu'
import { approxTokens, usagePercent, usageRatio, useContextUsage } from './context-usage'
import './model-panel.css'

type Open = null | 'panel' | 'model' | 'effort'

/** 二级菜单向左弹出所需的宽度；面板左侧放不下时改为盖在面板上。 */
const SUB_ROOM = 290

export function ModelPanel(): React.JSX.Element {
  const { activeModel, providers, setActiveModel, activeEffort, setActiveEffort } = useModels()
  const { currentBinding, currentSessionId, sessions } = useChatState()
  const { setSessionModel, setSessionEffort } = useChatActions()
  const [open, setOpen] = useState<Open>(null)
  const [narrow, setNarrow] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

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

  // 二级菜单打开时量一下左侧余量：窗口太窄放不下就盖在面板上。
  useLayoutEffect(() => {
    if (open !== 'model' && open !== 'effort') return
    const left = popRef.current?.getBoundingClientRect().left ?? SUB_ROOM
    setNarrow(left < SUB_ROOM)
  }, [open])

  // Esc：二级菜单 → 回到面板；面板 → 收起。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen((o) => (o === 'model' || o === 'effort' ? 'panel' : null))
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
        open={!!open}
        onToggle={() => setOpen((o) => (o ? null : 'panel'))}
      />
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(null)} />
          <div ref={popRef} className={`cf-mp__pop${narrow ? ' is-narrow' : ''}`}>
            <div className="cf-mp__panel">
              <UsageSection usage={active ? usage : null} accent={accent} />
              <PanelRows open={open} setOpen={setOpen} active={active} accent={accent} effort={effort} />
            </div>
            {open === 'model' && (
              <ModelMenu
                groups={groups}
                activePid={active?.provider.id ?? null}
                activeMid={active?.model.id ?? null}
                onPick={(pid, mid) => {
                  // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话未选时的默认。
                  setSessionModel(`${pid}:${mid}`)
                  setActiveModel(pid, mid)
                  setOpen(null)
                }}
              />
            )}
            {open === 'effort' && effort.levels.length > 0 && (
              <EffortMenu
                effort={effort}
                onPick={(lv) => {
                  setSessionEffort(lv)
                  setActiveEffort(lv)
                  setOpen(null)
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
 * 百分比与已用 / 窗口写在悬停提示里，点开面板看详情。
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
    usage && `${t('chat.panel.context')} ${percentText(t, usage)}（${usedText(t, usage)}）`
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

/** 面板下半部分：「模型」「思考等级」两行，悬停或点击打开对应的二级菜单。模型不支持思考等级时灰显。 */
function PanelRows({
  open,
  setOpen,
  active,
  accent,
  effort
}: {
  open: Open
  setOpen: React.Dispatch<React.SetStateAction<Open>>
  active: Active
  accent: string
  effort: EffortInfo
}): React.JSX.Element {
  const { t } = useI18n()
  const toggle = (sub: 'model' | 'effort'): void => setOpen((o) => (o === sub ? 'panel' : sub))
  return (
    <div className="cf-mp__rows">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open === 'model'}
        className={`model-pick__item cf-mp__row${open === 'model' ? ' is-on' : ''}`}
        onMouseEnter={() => setOpen('model')}
        onClick={() => toggle('model')}
      >
        <Cpu size={14} className="cf-mp__icon" />
        <span className="cf-mp__key">{t('chat.model')}</span>
        <span className="cf-mp__val">
          {active && <span className="chip__dot" style={{ background: accent }} />}
          <span className="cf-mp__valtext">{active ? active.model.name : t('chat.selectModel')}</span>
          <ChevronRight size={13} />
        </span>
      </button>
      {effort.levels.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === 'effort'}
          className={`model-pick__item cf-mp__row${open === 'effort' ? ' is-on' : ''}`}
          onMouseEnter={() => setOpen('effort')}
          onClick={() => toggle('effort')}
        >
          <Lightbulb size={14} className="cf-mp__icon" />
          <span className="cf-mp__key">{t('chat.effort.title')}</span>
          <span className="cf-mp__val">
            <span className="cf-mp__valtext">{effort.nameOf(effort.current)}</span>
            <ChevronRight size={13} />
          </span>
        </button>
      ) : (
        active && (
          <div
            className="model-pick__item cf-mp__row is-disabled"
            aria-disabled="true"
            onMouseEnter={() => setOpen('panel')}
          >
            <Lightbulb size={14} className="cf-mp__icon" />
            <span className="cf-mp__key">{t('chat.effort.title')}</span>
            <span className="cf-mp__val">
              <span className="cf-mp__valtext">{t('chat.effort.unsupported')}</span>
            </span>
          </div>
        )
      )}
    </div>
  )
}

type T = (key: string) => string

/** 「50%」（最多 100%）；估算值写「约 50%」。 */
function percentText(t: T, u: ContextUsage): string {
  const p = usagePercent(u)
  return u.estimated ? t('chat.panel.approx').replace('{n}', p) : p
}

/** 「已用 128K / 窗口 256K」：已用照实写（可能超过窗口），估算值加「约」。 */
function usedText(t: T, u: ContextUsage): string {
  const used = approxTokens(u.used ?? 0)
  return t('chat.panel.used')
    .replace('{used}', u.estimated ? t('chat.panel.approx').replace('{n}', used) : used)
    .replace('{window}', formatTokens(u.window))
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

/** 面板上半部分：上下文占用。没有读数时只写一句提示。 */
function UsageSection({ usage, accent }: { usage: ContextUsage | null; accent: string }): React.JSX.Element {
  const { t } = useI18n()
  if (!usage || usage.used == null) return <div className="cf-mp__empty">{t('chat.panel.empty')}</div>
  const tick = usage.trigger != null && usage.window > 0 ? Math.min(1, usage.trigger / usage.window) : null
  const left = usage.trigger != null ? usage.trigger - usage.used : null
  // 超出窗口（多见于换到窗口小的模型）：百分比封顶 100%，这里说明下次发送会先压缩。
  const note =
    usage.used >= usage.window && usage.trigger != null
      ? t('chat.panel.over')
      : usage.estimated
        ? t('chat.panel.estimated')
        : left == null
          ? ''
          : left < 1000
            ? t('chat.panel.soon')
            : t('chat.panel.left').replace('{n}', approxTokens(left))
  return (
    <div className="cf-mp__usage">
      <div className="cf-mp__top">
        <span className="cf-mp__title">{t('chat.panel.context')}</span>
        <span className="cf-mp__big">{percentText(t, usage)}</span>
      </div>
      <div className="cf-mp__bar">
        <div className="cf-mp__fill" style={{ width: `${(usageRatio(usage) * 100).toFixed(1)}%`, background: accent }} />
        {tick != null && <span className="cf-mp__tick" style={{ left: `${(tick * 100).toFixed(1)}%` }} />}
      </div>
      {tick != null && (
        <div className="cf-mp__ticklabel">
          <span style={{ left: `${(tick * 100).toFixed(1)}%` }}>{t('chat.panel.autoCompact')}</span>
        </div>
      )}
      <div className="cf-mp__line">{usedText(t, usage)}</div>
      {note && <div className="cf-mp__note">{note}</div>}
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

/** 思考等级二级菜单：各档与一行说明。 */
function EffortMenu({
  effort,
  onPick
}: {
  effort: EffortInfo
  onPick: (lv: EffortLevel) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const options: EffortLevel[] = ['default', ...effort.levels]
  return (
    <div className="cf-mp__sub" role="menu">
      <div className="model-pick__group-head">
        <span className="cf-mp__subtitle">{t('chat.effort.title')}</span>
      </div>
      <div className="cf-mp__list">
        {options.map((lv) => {
          const on = lv === effort.current
          return (
            <button
              key={lv}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              className={`model-pick__item${on ? ' is-active' : ''}`}
              onClick={() => onPick(lv)}
            >
              <span className="model-pick__name cf-mp__lv">
                <span>{effort.nameOf(lv)}</span>
                <span className="cf-mp__hint">{effort.hintOf(lv)}</span>
              </span>
              <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
