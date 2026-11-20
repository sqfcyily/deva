/**
 * 输入框工具条右侧的模型区：上下文圆环、模型、思考等级三个贴片，各自弹出一个只做一件事的菜单，同一时间只开一个。
 *
 * - 上下文圆环（ContextRing.tsx）：灰色、不带数字，点开看已用/窗口与进度条；没有读数（新对话、模型已删）时不出现。
 * - 模型：只写模型名（不放服务商色点）；点开是全部模型按服务商分组平铺（ModelMenu.tsx），点一下即切换并收起。
 * - 思考等级（EffortPicker.tsx）：灯泡 + 档位；模型不支持思考等级时不出现。
 *
 * 切换语义：只改本对话并立即落库（setSessionModel / setSessionEffort），同时记为「最近使用」
 * （setActiveModel / setActiveEffort），新对话未选时沿用最近使用。显示的是本对话生效模型：
 * 本对话已选 → 否则回落最近使用（与主进程 resolveModelRef 的兜底一致）。
 */
import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useChatActions, useChatState } from '../store/chat'
import { findActive, useModels } from '../store/models'
import { useI18n } from '../i18n/i18n'
import { ContextRing } from './ContextRing'
import { EffortPicker } from './EffortPicker'
import { ModelMenu, type ModelGroup } from './ModelMenu'
import { useContextUsage } from './context-usage'
import './model-panel.css'

type Menu = 'context' | 'model' | 'effort'

export function ModelPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel, providers, setActiveModel, activeEffort, setActiveEffort } = useModels()
  const { currentBinding, currentSessionId, sessions } = useChatState()
  const { setSessionModel, setSessionEffort } = useChatActions()
  const [open, setOpen] = useState<Menu | null>(null)
  const toggle = (m: Menu): void => setOpen((o) => (o === m ? null : m))

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
  const hasUsage = !!active && !!usage && usage.used != null

  // 换了对话就收起；读数没了（如删轮后）时，开着的卡片也跟着收起。
  useEffect(() => setOpen(null), [currentSessionId])
  useEffect(() => {
    if (!hasUsage) setOpen((o) => (o === 'context' ? null : o))
  }, [hasUsage])

  // Esc 收起。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const modelName = active ? active.model.name : t('chat.selectModel')
  return (
    <div className="cf-mp">
      {open && <div className="model-pick__backdrop" onClick={() => setOpen(null)} />}
      {hasUsage && usage && (
        <ContextRing usage={usage} open={open === 'context'} onToggle={() => toggle('context')} />
      )}
      <div className="model-pick">
        <button
          className={`chip cf-mp__model${open === 'model' ? ' is-open' : ''}`}
          type="button"
          title={open === 'model' ? undefined : modelName}
          aria-label={modelName}
          aria-haspopup="menu"
          aria-expanded={open === 'model'}
          onClick={() => toggle('model')}
        >
          <span className="chip__label">{modelName}</span>
          <ChevronDown size={13} className="chip__caret" />
        </button>
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
      </div>
      <EffortPicker
        active={active}
        stored={currentBinding.effort ?? activeEffort}
        open={open === 'effort'}
        onToggle={() => toggle('effort')}
        onPick={(lv) => {
          setSessionEffort(lv)
          setActiveEffort(lv)
          setOpen(null)
        }}
      />
    </div>
  )
}
