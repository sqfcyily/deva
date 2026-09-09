import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  FileCode,
  FileJson,
  FileText,
  FileType,
  type LucideIcon
} from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useWorkspace } from '../../store/workspace'

/** 按扩展名挑一个更贴切的文件图标（纯装饰）。 */
function iconForFile(name: string): LucideIcon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (['json'].includes(ext)) return FileJson
  if (['md', 'markdown', 'txt', 'yml', 'yaml', 'xml', 'html', 'css'].includes(ext)) return FileText
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp'].includes(ext)) return FileType
  return FileCode
}

/** 文件树导航。真实目录，懒加载；点击文件 → 中央编辑器打开。 */
export function ExplorerPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { activeProject, tree, toggleDir, openFile, openFolder, activePath } = useWorkspace()

  if (!activeProject) {
    return (
      <>
        <PanelHeader title={t('explorer.title')} />
        <div className="sidepanel__body">
          <div className="side-empty">
            <div className="side-empty__hint">{t('explorer.empty')}</div>
            <button className="btn btn--soft" onClick={() => void openFolder()}>
              <FolderPlus size={14} />
              {t('titlebar.openFolder')}
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <PanelHeader title={activeProject.name} />
      <div className="sidepanel__body">
        {tree.map((n) => {
          const selected = n.type === 'file' && n.path === activePath
          const Icon = n.type === 'file' ? iconForFile(n.name) : null
          return (
            <div
              key={n.path}
              className={`list-row${selected ? ' is-selected' : ''}`}
              style={{ paddingLeft: 8 + n.depth * 14 }}
              onClick={() => (n.type === 'dir' ? void toggleDir(n.path) : void openFile(n.path))}
            >
              {n.type === 'dir' ? (
                <>
                  <span className="list-row__icon">
                    {n.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </span>
                  <span className="list-row__icon" style={{ color: 'var(--accent)' }}>
                    {n.expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                  </span>
                </>
              ) : (
                <>
                  <span className="list-row__icon" style={{ width: 13 }} />
                  <span className="list-row__icon">{Icon && <Icon size={14} />}</span>
                </>
              )}
              <span className="list-row__label">{n.name}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}
