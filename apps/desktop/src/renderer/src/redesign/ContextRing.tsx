/**
 * 输入框工具条上的上下文圆环（在模型贴片前面）：本对话占当前模型上下文窗口的比例。
 *
 * 平时只是一个不带数字的灰色圆环，悬停提示写「上下文容量 128K/256K (50.0%)」；点开是一张小卡片：
 * 同一行数字加进度条（与圆环同一种灰，不用服务商色），竖线标出自动压缩的位置。接近压缩也不变色、不提醒：压缩是自动的，不需要用户处理。
 * 卡片优先以圆环为中心弹出；超出窗口时往里挪，左右各留 8px。
 * 没有读数（新对话、模型已删）时由 ModelPanel 整个不渲染。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ContextUsage } from '../../../preload'
import { formatTokens } from '../../../shared/context'
import { useI18n } from '../i18n/i18n'
import { approxTokens, usagePercent, usageRatio } from './context-usage'

type T = (key: string) => string

/** 「199K/1M (19.9%)」：已用照实写（可能超过窗口），百分比最多 100%，估算值前面加「约」。 */
function usageText(t: T, u: ContextUsage): string {
  const text = t('chat.panel.usage')
    .replace('{used}', approxTokens(u.used ?? 0))
    .replace('{window}', formatTokens(u.window))
    .replace('{pct}', usagePercent(u))
  return u.estimated ? t('chat.panel.approx').replace('{n}', text) : text
}

export function ContextRing({
  usage,
  open,
  onToggle
}: {
  usage: ContextUsage
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const text = usageText(t, usage)
  const title = `${t('chat.panel.context')} ${text}`
  const tick = usage.trigger != null && usage.window > 0 ? Math.min(1, usage.trigger / usage.window) : null
  const cardRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)

  // 打开时按居中位置量一次，超出窗口就往里挪；收起时归零，下次打开仍从居中量起。
  useLayoutEffect(() => {
    if (!open) {
      setShift(0)
      return
    }
    const el = cardRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const edge = 8
    const over = r.right - (window.innerWidth - edge)
    const under = edge - r.left
    setShift(over > 0 ? -over : under > 0 ? under : 0)
  }, [open])
  return (
    <div className="model-pick">
      <button
        className={`chip cf-mp__ringbtn${open ? ' is-open' : ''}`}
        type="button"
        title={open ? undefined : title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Ring ratio={usageRatio(usage)} />
      </button>
      {open && (
        <div
          ref={cardRef}
          className="cf-mp__card"
          role="dialog"
          aria-label={t('chat.panel.context')}
          style={{ transform: `translateX(calc(-50% + ${shift}px))` }}
        >
          <div className="cf-mp__top">
            <span className="cf-mp__title">{t('chat.panel.context')}</span>
            <span className="cf-mp__big">{text}</span>
          </div>
          <div className="cf-mp__bar">
            <div className="cf-mp__fill" style={{ width: `${(usageRatio(usage) * 100).toFixed(1)}%` }} />
            {tick != null && (
              <span
                className="cf-mp__tick"
                title={t('chat.panel.autoCompact')}
                style={{ left: `${(tick * 100).toFixed(1)}%` }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 灰色占用圆环：底圈 + 弧（从 12 点顺时针）。 */
function Ring({ ratio }: { ratio: number }): React.JSX.Element {
  const r = 6
  const c = 2 * Math.PI * r
  const len = ratio * c
  return (
    <svg className="cf-mp__ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="cf-mp__ring-track" cx="8" cy="8" r={r} fill="none" strokeWidth="2" />
      {len > 0.01 && (
        <circle
          className="cf-mp__ring-arc"
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${len.toFixed(2)} ${c.toFixed(2)}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}
