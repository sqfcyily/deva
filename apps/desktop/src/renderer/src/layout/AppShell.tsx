import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'
import { useUI } from '../store/ui'
import { getContribution, defaultViewId } from '../features/registry'

/**
 * 三行栅格：TitleBar / 主体 / StatusBar。
 * 主体三列：ActivityBar / SidePanel / 中央工作区（含底部面板）。
 * 中央区内容由当前活动视图决定，具体组件来自功能贡献注册表；
 * 未知视图回退到默认贡献（首个，通常是「对话」）。
 */
function CenterView(): React.JSX.Element | null {
  const { activeView } = useUI()
  const Center = (getContribution(activeView) ?? getContribution(defaultViewId))?.Center
  return Center ? <Center /> : null
}

export function AppShell(): React.JSX.Element {
  const { panelVisible } = useUI()

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-body">
        <ActivityBar />
        <SidePanel />
        <div className="workarea">
          <div className="workarea__main">
            <CenterView />
          </div>
          {panelVisible && <BottomPanel />}
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
