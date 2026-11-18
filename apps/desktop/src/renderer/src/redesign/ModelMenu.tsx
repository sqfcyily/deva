/**
 * 模型面板的「模型」二级菜单（对比稿 design/model-panel.html 方案 C：逐层进入）。
 *
 * 打开即列当前模型所在服务商的全部已启用模型；顶部「全部服务商」回到服务商列表，点某个服务商进入它的模型。
 * 当前模型所在的服务商不在可选范围（服务商或模型已停用、尚未选过模型）时，直接显示服务商列表。
 * 只有一个服务商时不显示「全部服务商」。每个模型右侧写上下文窗口（模型详情页填的值，否则自动值）：
 * 换到窗口小的模型，占用会跳高甚至马上压缩，先看到心里有数。
 */
import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ModelDef, Provider } from '../mock/models'
import { autoContextWindow, formatTokens } from '../../../shared/context'
import { useI18n } from '../i18n/i18n'

export interface ModelGroup {
  p: Provider
  models: ModelDef[]
}

export function ModelMenu({
  groups,
  activePid,
  activeMid,
  onPick
}: {
  groups: ModelGroup[]
  activePid: string | null
  activeMid: string | null
  onPick: (pid: string, mid: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [pid, setPid] = useState<string | null>(() =>
    groups.some((g) => g.p.id === activePid) ? activePid : groups.length === 1 ? groups[0].p.id : null
  )
  const group = pid ? groups.find((g) => g.p.id === pid) : undefined

  if (groups.length === 0)
    return (
      <div className="cf-mp__sub" role="menu">
        <div className="model-pick__empty">{t('chat.noModel')}</div>
      </div>
    )

  if (!group)
    return (
      <div className="cf-mp__sub" role="menu">
        <div className="model-pick__group-head">
          <span className="cf-mp__subtitle">{t('chat.panel.providers')}</span>
        </div>
        <div className="cf-mp__list">
          {groups.map(({ p, models }) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              className={`model-pick__item cf-mp__prov${p.id === activePid ? ' has-cur' : ''}`}
              onClick={() => setPid(p.id)}
            >
              <span className="model-pick__dot" style={{ background: p.accent }} />
              <span className="model-pick__name">{p.name}</span>
              <span className="cf-mp__count">{models.length}</span>
              <ChevronRight size={13} className="cf-mp__chev" />
            </button>
          ))}
        </div>
      </div>
    )

  return (
    <div className="cf-mp__sub" role="menu">
      {groups.length > 1 && (
        <>
          <button type="button" className="cf-mp__back" onClick={() => setPid(null)}>
            <ChevronLeft size={14} />
            {t('chat.panel.allProviders')}
          </button>
          <div className="cf-mp__sep" />
        </>
      )}
      <div className="model-pick__group-head">
        <span className="model-pick__dot" style={{ background: group.p.accent }} />
        <span className="model-pick__group-name">{group.p.name}</span>
      </div>
      <div className="cf-mp__list">
        {group.models.map((m) => {
          const on = group.p.id === activePid && m.id === activeMid
          return (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              className={`model-pick__item${on ? ' is-active' : ''}`}
              title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
              onClick={() => onPick(group.p.id, m.id)}
            >
              <span className="model-pick__name">{m.name}</span>
              <span className="cf-mp__win">{formatTokens(m.contextWindow ?? autoContextWindow(m.id))}</span>
              <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
