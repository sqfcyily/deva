import { useEffect, useRef, useState } from 'react'
import { GitBranch, Plus, Minus, Undo2 } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useGit, type GitDiffLine } from '../../store/git'

/**
 * 中央 diff 视图：展示当前选中更改的行级差异（真实 git，经 window.deva.git.diff）。
 * 差异侧由 useGit().selected 决定：staged=index↔HEAD，未暂存=worktree↔index，未跟踪=整文件新增。
 */
export function GitDiffView(): React.JSX.Element {
  const { t } = useI18n()
  const git = useGit()
  const { selected, repoDir, busy } = git

  const [lines, setLines] = useState<GitDiffLine[] | null>(null)
  const [loading, setLoading] = useState(false)
  // 每次请求打标，回来时若已过期（选中变了）则丢弃，避免竞态错渲染。
  const reqRef = useRef(0)

  const selPath = selected?.file.path ?? null
  const selStaged = selected?.staged ?? false
  const selUntracked = selected?.file.untracked ?? false

  useEffect(() => {
    if (!repoDir || !selPath) {
      setLines(null)
      return
    }
    const seq = ++reqRef.current
    setLoading(true)
    void (async () => {
      try {
        const d = await window.deva.git.diff(repoDir, selPath, {
          staged: selStaged,
          untracked: selUntracked
        })
        if (reqRef.current === seq) setLines(d)
      } catch {
        if (reqRef.current === seq) setLines([])
      } finally {
        if (reqRef.current === seq) setLoading(false)
      }
    })()
    // status 刷新后同一文件对象会替换，故也依赖 git.status 触发重取。
  }, [repoDir, selPath, selStaged, selUntracked, git.status])

  if (!selected) {
    return (
      <div className="placeholder">
        <GitBranch size={40} className="placeholder__icon" />
        <div className="placeholder__hint">{t('git.selectHint')}</div>
      </div>
    )
  }

  const file = selected.file
  const added = lines?.filter((l) => l.type === 'add').length ?? 0
  const removed = lines?.filter((l) => l.type === 'del').length ?? 0

  return (
    <div className="contentview">
      <div className="contentview__header">
        <span className="contentview__path">
          {file.dir ? `${file.dir}/` : ''}
          <b>{file.name}</b>
        </span>
        <span className="contentview__spacer" />
        <span style={{ color: 'var(--diff-add-fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          +{added}
        </span>
        <span style={{ color: 'var(--diff-del-fg)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          -{removed}
        </span>
        <span style={{ width: 8 }} />
        {selected.staged ? (
          <button
            className="icon-btn"
            title={t('git.unstage')}
            disabled={busy}
            onClick={() => void git.unstage([file])}
          >
            <Minus size={15} />
          </button>
        ) : (
          <>
            <button
              className="icon-btn"
              title={t('git.discard')}
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('git.discardConfirm').replace('{name}', file.name)))
                  void git.discard([file])
              }}
            >
              <Undo2 size={15} />
            </button>
            <button
              className="icon-btn"
              title={t('git.stage')}
              disabled={busy}
              onClick={() => void git.stage([file])}
            >
              <Plus size={15} />
            </button>
          </>
        )}
      </div>
      <div className="contentview__body">
        {loading && lines === null ? (
          <div className="sidepanel__empty">…</div>
        ) : lines && lines.length > 0 ? (
          <div className="diffview">
            {lines.map((l, i) => (
              <div key={i} className={`diffview__line ${l.type}`}>
                <span className="diffview__no">{l.type === 'hunk' ? '' : l.oldNo ?? ''}</span>
                <span className="diffview__no">{l.type === 'hunk' ? '' : l.newNo ?? ''}</span>
                <span className="diffview__sign">
                  {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
                </span>
                <span className="diffview__text">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="sidepanel__empty">{t('git.diffEmpty')}</div>
        )}
      </div>
    </div>
  )
}
