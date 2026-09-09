import { FolderGit2, Check, Cpu, Bell } from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { useModels } from '../store/models'
import { useWorkspace } from '../store/workspace'

/** 底部状态栏：项目 / 就绪状态 / 模型 / 行列信息等。 */
export function StatusBar(): React.JSX.Element {
  const { t } = useI18n()
  const { togglePanel } = useUI()
  const { activeModel } = useModels()
  const { activeProject } = useWorkspace()

  return (
    <footer className="statusbar">
      {activeProject && (
        <span className="statusbar__item is-clickable" title={activeProject.path}>
          <FolderGit2 size={12} />
          {activeProject.name}
        </span>
      )}
      <span className="statusbar__item">
        <Check size={12} />
        {t('status.ready')}
      </span>
      <div className="statusbar__spacer" />
      <span className="statusbar__item is-clickable" onClick={togglePanel}>
        <Cpu size={12} />
        {activeModel?.model.name ?? t('status.model')}
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
