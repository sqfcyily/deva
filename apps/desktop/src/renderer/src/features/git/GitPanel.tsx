import { FileText, Plus, RefreshCw, GitCommitHorizontal } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { gitChanges } from '../../mock/data'

const STATUS_COLOR: Record<string, string> = {
  M: 'var(--warning)',
  A: 'var(--success)',
  U: 'var(--success)',
  D: 'var(--danger)'
}

/** 版本控制导航。点击更改 → 中央 diff 视图。 */
export function GitPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedGitFile, selectGitFile } = useUI()

  return (
    <>
      <PanelHeader
        title={t('git.title')}
        actions={
          <>
            <button className="icon-btn" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button className="icon-btn" title="Stage all">
              <Plus size={16} />
            </button>
          </>
        }
      />
      <div className="sidepanel__body">
        <div style={{ padding: '8px 4px' }}>
          <div
            className="composer__box"
            style={{ margin: 0, borderRadius: 'var(--radius-sm)', padding: 8 }}
          >
            <textarea
              className="composer__input"
              rows={2}
              placeholder={t('git.message')}
              style={{ maxHeight: 80 }}
            />
          </div>
          <button className="btn btn--primary btn--sm" style={{ marginTop: 8, width: '100%' }}>
            <GitCommitHorizontal size={14} />
            {t('git.commit')} (main)
          </button>
        </div>

        <div className="sidepanel__title" style={{ padding: '10px 8px 4px' }}>
          {t('git.changes')} · {gitChanges.length}
        </div>
        {gitChanges.map((c) => (
          <div
            key={c.id}
            className={`list-row${c.id === selectedGitFile ? ' is-selected' : ''}`}
            onClick={() => selectGitFile(c.id)}
          >
            <span className="list-row__icon">
              <FileText size={14} />
            </span>
            <span className="list-row__label">
              {c.name}
              <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>{c.path}</span>
            </span>
            <span
              className="list-row__meta"
              style={{ color: STATUS_COLOR[c.status], fontWeight: 700 }}
            >
              {c.status}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
