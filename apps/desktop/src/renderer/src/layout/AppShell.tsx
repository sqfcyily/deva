import { TitleBar } from './TitleBar'
import { ActivityBar } from './ActivityBar'
import { SidePanel } from './SidePanel'
import { BottomPanel } from './BottomPanel'
import { StatusBar } from './StatusBar'
import { useUI } from '../store/ui'
import { getContribution, defaultViewId, viewShowsTerminal } from '../features/registry'

/**
 * 三行栅格：TitleBar（浏览器式，内含常驻项目 tab 条）/ 主体 / StatusBar。
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
  const { panelVisible, activeView } = useUI()
  // 终端仅在「贴着项目」的视图显示；切到其他视图时隐藏但保持挂载——
  // 面板一旦打开就随 panelVisible 常驻，PTY 会话与滚动历史跨页面切换不丢，
  // 只有用户显式关闭面板（panelVisible=false）才卸载销毁。
  const terminalAllowed = viewShowsTerminal(activeView)

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
          {panelVisible && <BottomPanel hidden={!terminalAllowed} />}
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
