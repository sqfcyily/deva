import { useState } from 'react'
import {
  PanelLeft,
  PanelBottom,
  Search,
  X,
  ChevronDown,
  Check,
  FolderOpen,
  FolderPlus,
  History
} from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { useWorkspace } from '../store/workspace'
import { viewShowsTerminal } from '../features/registry'

/**
 * 顶部标题栏。整体可拖拽（-webkit-app-region: drag），交互元素设为 no-drag。
 * 项目切换器：顶栏仅显示当前项目，点击弹出菜单，
 * 菜单内列出全部已打开项目（切换 / 关闭），底部提供「打开文件夹 / 新建项目」。
 * 右侧靠近系统原生窗口控件（Windows 由 titleBarOverlay 提供，故留白）。
 */
export function TitleBar(): React.JSX.Element {
  const { t } = useI18n()
  const { toggleSidebar, togglePanel, sidebarVisible, panelVisible, activeView } = useUI()
  const {
    projects,
    activeProjectId,
    activeProject,
    setActiveProject,
    closeProject,
    openFolder,
    recentProjects,
    openRecent,
    removeRecent
  } = useWorkspace()
  // 最近项目中「当前未打开」的部分（已打开的已在上方列出，避免重复）。
  const recentClosed = recentProjects.filter((r) => !projects.some((p) => p.path === r.path))
  const [menuOpen, setMenuOpen] = useState(false)
  const isWin = window.deva?.platform === 'win32'
  // 终端仅在对话/资源管理器/版本控制视图可用；其余视图禁用「打开终端」按钮。
  const terminalAllowed = viewShowsTerminal(activeView)

  const active = activeProject

  return (
    <header className="titlebar" style={isWin ? { paddingRight: 140 } : undefined}>
      <div className="titlebar__brand">
        <span className="titlebar__logo">D</span>
      </div>

      {/* 项目切换器（收起为当前项目，点击展开菜单） */}
      <div className="projswitch-wrap">
        <button
          className={`projswitch${menuOpen ? ' is-open' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          title={active?.path}
        >
          <span className="projswitch__name">{active?.name ?? t('status.noWorkspace')}</span>
          <ChevronDown size={14} className="projswitch__chevron" />
        </button>

        {menuOpen && (
          <>
            <div className="backdrop" onClick={() => setMenuOpen(false)} />
            <div className="projmenu">
              {projects.length > 0 && (
                <div className="projmenu__label">{t('titlebar.openProjectsLabel')}</div>
              )}
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`projmenu__item${p.id === activeProjectId ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveProject(p.id)
                    setMenuOpen(false)
                  }}
                >
                  <span className="projmenu__check">
                    {p.id === activeProjectId && <Check size={14} />}
                  </span>
                  <span className="projmenu__name" title={p.path}>
                    {p.name}
                  </span>
                  <button
                    className="projmenu__close"
                    title={t('titlebar.closeProject')}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeProject(p.id)
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}

              {recentClosed.length > 0 && (
                <>
                  {projects.length > 0 && <div className="projmenu__divider" />}
                  <div className="projmenu__label">{t('titlebar.recentLabel')}</div>
                  {recentClosed.map((r) => (
                    <div
                      key={r.path}
                      className="projmenu__item"
                      onClick={() => {
                        setMenuOpen(false)
                        void openRecent(r.path)
                      }}
                    >
                      <span className="projmenu__check">
                        <History size={14} />
                      </span>
                      <span className="projmenu__name" title={r.path}>
                        {r.name}
                      </span>
                      <button
                        className="projmenu__close"
                        title={t('titlebar.removeRecent')}
                        onClick={(e) => {
                          e.stopPropagation()
                          removeRecent(r.path)
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {(projects.length > 0 || recentClosed.length > 0) && (
                <div className="projmenu__divider" />
              )}
              <div
                className="projmenu__item"
                onClick={() => {
                  setMenuOpen(false)
                  void openFolder()
                }}
              >
                <span className="projmenu__check">
                  <FolderOpen size={14} />
                </span>
                <span className="projmenu__name">{t('titlebar.openFolder')}</span>
              </div>
              <div
                className="projmenu__item"
                onClick={() => {
                  setMenuOpen(false)
                  void openFolder()
                }}
              >
                <span className="projmenu__check">
                  <FolderPlus size={14} />
                </span>
                <span className="projmenu__name">{t('titlebar.newProject')}</span>
              </div>
            </div>
          </>
        )}
      </div>

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
