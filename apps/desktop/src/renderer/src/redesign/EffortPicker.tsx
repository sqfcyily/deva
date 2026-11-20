/**
 * 输入框工具条上的思考等级贴片（在模型贴片后面）。只在本对话生效模型支持思考等级时出现。
 *
 * 贴片：灯泡 + 档位；「默认」只放灯泡。点开一列档位，每档带一行说明，点一下即切换并收起。
 * 档位按该模型支持的档收敛显示（clampEffort，与主进程实际发送的一致）；对话里存的是用户原选，
 * 换回支持该档的模型即恢复。只能开、不能调档的模型唯一一档显示为「开启」。
 */
import { Check, Lightbulb } from 'lucide-react'
import type { EffortLevel } from '../../../preload'
import type { findActive } from '../store/models'
import { clampEffort, isToggleEffort, supportedEffortLevels, type EffortAdapter } from '../../../shared/effort'
import { useI18n } from '../i18n/i18n'

type Active = ReturnType<typeof findActive>

export function EffortPicker({
  active,
  stored,
  open,
  onToggle,
  onPick
}: {
  /** 本对话生效模型。 */
  active: Active
  /** 本对话存的档位（尚未定格时为「最近使用」）。 */
  stored: EffortLevel
  open: boolean
  onToggle: () => void
  onPick: (lv: EffortLevel) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  // 对话模型的 adapter 必属三协议之一。
  const adapter = active?.provider.adapter as EffortAdapter | undefined
  const modelId = active?.model.id
  const levels = adapter && modelId ? supportedEffortLevels(adapter, modelId) : []
  if (!adapter || !modelId || levels.length === 0) return null
  const toggle = isToggleEffort(adapter, modelId)
  const nameOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.on') : t(`chat.effort.levels.${lv}`)
  const hintOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.onHint') : t(`chat.effort.hints.${lv}`)
  const current = clampEffort(adapter, modelId, stored)
  const title = `${t('chat.effort.title')}：${nameOf(current)}`
  const options: EffortLevel[] = ['default', ...levels]
  return (
    <div className="model-pick">
      <button
        className={`chip cf-mp__effort${open ? ' is-open' : ''}`}
        type="button"
        title={open ? undefined : title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Lightbulb size={13} />
        {current !== 'default' && <span className="chip__label">{nameOf(current)}</span>}
      </button>
      {open && (
        <div className="model-pick__menu" role="menu" aria-label={t('chat.effort.title')}>
          {options.map((lv) => {
            const on = lv === current
            return (
              <button
                key={lv}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={`model-pick__item${on ? ' is-active' : ''}`}
                onClick={() => onPick(lv)}
              >
                <span className="model-pick__name cf-mp__eftext">
                  <span>{nameOf(lv)}</span>
                  <span className="cf-mp__efhint">{hintOf(lv)}</span>
                </span>
                <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
