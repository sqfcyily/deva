/**
 * 模型面板里的模型列表：全部「已启用服务商 × 已启用模型」按服务商分组平铺，点一下即切换，不分层。
 *
 * 列表自己滚动；打开时把当前模型滚到可见范围中间。每个模型右侧写上下文窗口（模型详情页填的值，否则自动值）：
 * 换到窗口小的模型，占用会跳高甚至马上压缩，先看到心里有数。
 */
import { useLayoutEffect, useRef } from 'react'
import { Check } from 'lucide-react'
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
  const listRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // 只在打开时定位一次：直接改列表的 scrollTop（scrollIntoView 可能连带滚动外层）。
  useLayoutEffect(() => {
    const list = listRef.current
    const item = activeRef.current
    if (!list || !item) return
    list.scrollTop = item.offsetTop - (list.clientHeight - item.offsetHeight) / 2
  }, [])

  if (groups.length === 0)
    return (
      <div className="cf-mp__list" role="menu">
        <div className="model-pick__empty">{t('chat.noModel')}</div>
      </div>
    )

  return (
    <div ref={listRef} className="cf-mp__list" role="menu" aria-label={t('chat.selectModel')}>
      {groups.map(({ p, models }) => (
        <div key={p.id} className="model-pick__group">
          <div className="model-pick__group-head">
            <span className="model-pick__dot" style={{ background: p.accent }} />
            <span className="model-pick__group-name">{p.name}</span>
          </div>
          {models.map((m) => {
            const on = p.id === activePid && m.id === activeMid
            return (
              <button
                key={m.id}
                ref={on ? activeRef : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={`model-pick__item${on ? ' is-active' : ''}`}
                title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
                onClick={() => onPick(p.id, m.id)}
              >
                <span className="model-pick__name">{m.name}</span>
                <span className="cf-mp__win">{formatTokens(m.contextWindow ?? autoContextWindow(m.id))}</span>
                <span className="cf-mp__check">{on && <Check size={14} className="model-pick__check" />}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
