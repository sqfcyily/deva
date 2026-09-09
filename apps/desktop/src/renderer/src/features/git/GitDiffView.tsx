import { GitBranch } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { gitChanges, gitDiffs } from '../../mock/data'

/**
 * 中央 diff 视图：展示当前选中更改的行级差异（统一视图，演示数据）。
 */
export function GitDiffView(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedGitFile } = useUI()
  const change = gitChanges.find((c) => c.id === selectedGitFile)
  const lines = selectedGitFile ? gitDiffs[selectedGitFile] : undefined

  if (!change || !lines) {
    return (
      <div className="placeholder">
        <GitBranch size={40} className="placeholder__icon" />
        <div className="placeholder__hint">{t('git.selectHint')}</div>
      </div>
    )
  }

  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'del').length

  return (
    <div className="contentview">
      <div className="contentview__header">
        <span className="contentview__path">
          {change.path}/<b>{change.name}</b>
        </span>
        <span className="contentview__spacer" />
        <span style={{ color: 'var(--diff-add-fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          +{added}
        </span>
        <span style={{ color: 'var(--diff-del-fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          -{removed}
        </span>
      </div>
      <div className="contentview__body">
        <div className="diffview">
          {lines.map((l, i) => (
            <div key={i} className={`diffview__line ${l.type}`}>
              <span className="diffview__no">{l.oldNo ?? ''}</span>
              <span className="diffview__no">{l.newNo ?? ''}</span>
              <span className="diffview__sign">
                {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
              </span>
              <span className="diffview__text">{l.text || ' '}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
