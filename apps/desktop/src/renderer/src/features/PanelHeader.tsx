import type { ReactNode } from 'react'

/**
 * 侧边面板通用抬头：左标题、右操作区。
 * badge 用于标注作用域，如「全局」——表示该视图数据与项目无关、切换项目不变。
 */
export function PanelHeader({
  title,
  badge,
  actions
}: {
  title: string
  badge?: string
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="sidepanel__header">
      <span className="sidepanel__head-left">
        <span className="sidepanel__title">{title}</span>
        {badge && <span className="scope-badge">{badge}</span>}
      </span>
      {actions && <div style={{ display: 'flex', gap: 2 }}>{actions}</div>}
    </div>
  )
}
