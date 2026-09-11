import { FolderGit2, Check, Terminal, Bell } from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { useWorkspace } from '../store/workspace'
import { viewShowsTerminal } from '../features/registry'

/** 底部状态栏：项目 / 就绪状态 / 终端开关 / 行列信息等。 */
export function StatusBar(): React.JSX.Element {
  const { t } = useI18n()
  const { togglePanel, panelVisible, activeView } = useUI()
  const { activeProject } = useWorkspace()
  // 终端开关与顶栏「打开终端」按钮同源 togglePanel，须同样按视图门禁——
  // 否则一个禁用、另一个仍可点，状态会不一致（且在非终端视图静默开隐藏终端）。
  const terminalAllowed = viewShowsTerminal(activeView)

  return (
    <footer className="statusbar">
      {activeProject && (
        <span className="statusbar__item" title={activeProject.path}>
          <FolderGit2 size={12} />
          {activeProject.name}
        </span>
      )}
      <span className="statusbar__item">
        <Check size={12} />
        {t('status.ready')}
      </span>
      <div className="statusbar__spacer" />
      <span
        className={`statusbar__item${terminalAllowed ? ' is-clickable' : ' is-disabled'}${
          panelVisible && terminalAllowed ? ' statusbar__accent' : ''
        }`}
        title={t('titlebar.togglePanel')}
        onClick={terminalAllowed ? togglePanel : undefined}
      >
        <Terminal size={12} />
        {t('terminal.title')}
      </span>
      <span className="statusbar__item">
        {t('status.ln')} 1, {t('status.col')} 1
      </span>
      <span className="statusbar__item">UTF-8</span>
      <span className="statusbar__item is-clickable">
        <Bell size={12} />
      </span>
    </footer>
  )
}
