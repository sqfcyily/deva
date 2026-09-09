import { useUI } from '../store/ui'
import { getContribution } from '../features/registry'

/**
 * 侧边面板容器。内容随活动视图切换，作为该视图的导航。
 * 贡献未声明 Sidebar（如设置）时无侧边导航，此处折叠、中央区占满。
 */
export function SidePanel(): React.JSX.Element {
  const { activeView, sidebarVisible } = useUI()
  const Sidebar = getContribution(activeView)?.Sidebar
  const collapsed = !sidebarVisible || !Sidebar

  return (
    <aside className={`sidepanel${collapsed ? ' is-collapsed' : ''}`}>
      {Sidebar && <Sidebar />}
    </aside>
  )
}
