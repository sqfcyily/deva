import { PanelLeft, PanelBottom, Search } from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { ProjectTabs } from './ProjectTabs'
import { viewShowsTerminal } from '../features/registry'

/**
 * 顶部标题栏（浏览器式）：品牌标识 + **常驻项目 tab 条**（窗口最顶部，一行内）+
 * 右侧窗口动作（搜索 / 侧栏 / 底部面板开关）。整体可拖拽（-webkit-app-region: drag），
 * tab / 动作等交互元素设为 no-drag；品牌与中部空白留作拖拽区。
 * 右侧靠近系统原生窗口控件（Windows 由 titleBarOverlay 提供，故留白）。
 */
export function TitleBar(): React.JSX.Element {
  const { t } = useI18n()
  const { toggleSidebar, togglePanel, sidebarVisible, panelVisible, activeView } = useUI()
  const isWin = window.deva?.platform === 'win32'
  // 终端仅在对话/资源管理器/版本控制视图可用；其余视图禁用「打开终端」按钮。
  const terminalAllowed = viewShowsTerminal(activeView)

  return (
    <header className="titlebar" style={isWin ? { paddingRight: 140 } : undefined}>
      <div className="titlebar__brand">
        <span className="titlebar__logo">D</span>
      </div>

      <ProjectTabs />

      <div className="titlebar__spacer" />

      <div className="titlebar__actions">
        <button className="icon-btn" title={t('titlebar.search')}>
          <Search size={16} />
        </button>
        <button
          className={`icon-btn${sidebarVisible ? ' is-active' : ''}`}
          title={t('titlebar.toggleSidebar')}
          onClick={toggleSidebar}
        >
          <PanelLeft size={16} />
        </button>
        <button
          className={`icon-btn${panelVisible && terminalAllowed ? ' is-active' : ''}`}
          title={t('titlebar.togglePanel')}
          onClick={togglePanel}
          disabled={!terminalAllowed}
        >
          <PanelBottom size={16} />
        </button>
      </div>
    </header>
  )
}
