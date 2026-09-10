import { useState } from 'react'
import {
  RefreshCw,
  MoreHorizontal,
  Check,
  Plus,
  Minus,
  Undo2,
  FileText,
  GitBranch as GitBranchIcon,
  ArrowUp,
  ArrowDown,
  DownloadCloud,
  UploadCloud,
  Copy
} from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useGit, type GitFileStatus, type GitFailReason } from '../../store/git'

/** 状态字母配色（对齐 VS Code 语义色）。 */
const STATUS_COLOR: Record<string, string> = {
  M: 'var(--warning)',
  A: 'var(--success)',
  U: 'var(--success)',
  D: 'var(--danger)',
  R: 'var(--accent)',
  C: 'var(--accent)',
  T: 'var(--warning)'
}

type Notice = { kind: 'error' | 'ok'; text: string } | null

/** 版本控制导航（真实 git，对标 VS Code 源代码管理面板）。 */
export function GitPanel(): React.JSX.Element {
  const { t } = useI18n()
  const git = useGit()
  const {
    available,
    hasProject,
    isRepo,
    status,
    loading,
    busy,
    selected,
    commitMessage,
    branches
  } = git

  const [menuOpen, setMenuOpen] = useState(false)
  const [menuMode, setMenuMode] = useState<'root' | 'branch' | 'clone'>('root')
  const [branchName, setBranchName] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [showIdentity, setShowIdentity] = useState(false)
  const [idName, setIdName] = useState('')
  const [idEmail, setIdEmail] = useState('')

  const branch = status?.branch ?? (status?.detached ? 'HEAD' : '')

  /** 把结构化失败原因翻成友好文案。 */
  function reasonText(reason?: GitFailReason, message?: string): string {
    switch (reason) {
      case 'auth':
        return t('git.authFailed')
      case 'network':
        return t('git.networkError')
      case 'rejected':
        return t('git.rejected')
      case 'conflict':
        return t('git.conflictError')
      case 'dirty':
        return t('git.dirtyError')
      case 'identity-needed':
        return t('git.identityNeeded')
      case 'no-git':
        return t('git.noGit')
      case 'empty':
        return t('git.commitEmpty')
      default:
        return message || t('chat.error')
    }
  }

  const closeMenu = (): void => {
    setMenuOpen(false)
    setMenuMode('root')
  }

  // ── 空态：无 git / 无项目 / 非仓库 ────────────────────────────────
  if (available === false) {
    return (
      <>
        <PanelHeader title={t('git.title')} />
        <div className="sidepanel__body">
          <div className="sidepanel__empty">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('git.noGit')}</div>
            {t('git.noGitHint')}
          </div>
        </div>
      </>
    )
  }

  if (!hasProject) {
    return (
      <>
        <PanelHeader title={t('git.title')} />
        <div className="sidepanel__body">
          <div className="sidepanel__empty">{t('git.noProject')}</div>
        </div>
      </>
    )
  }

  if (status && !isRepo) {
    return (
      <>
        <PanelHeader
          title={t('git.title')}
          actions={
            <button className="icon-btn" title={t('git.refresh')} onClick={() => void git.refresh()}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            </button>
          }
        />
        <div className="sidepanel__body">
          <div className="sidepanel__empty" style={{ paddingBottom: 8 }}>
            {t('git.notARepo')}
          </div>
          <button
            className="btn btn--primary btn--sm"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={() => void git.init()}
          >
            <GitBranchIcon size={14} />
            {t('git.initRepo')}
          </button>
        </div>
      </>
    )
  }

  // ── 正常仓库视图 ───────────────────────────────────────────────
  const conflicts = status?.conflicts ?? []
  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const canCommit = commitMessage.trim().length > 0 && staged.length > 0 && !busy

  const doCommit = async (): Promise<void> => {
    if (!commitMessage.trim()) {
      setNotice({ kind: 'error', text: t('git.commitEmpty') })
      return
    }
    const res = await git.commit()
    if (res.ok) {
      setNotice(null)
      setShowIdentity(false)
    } else if (res.reason === 'identity-needed') {
      setShowIdentity(true)
      setNotice(null)
    } else {
      setNotice({ kind: 'error', text: reasonText(res.reason, res.message) })
    }
  }

  const saveIdentity = async (): Promise<void> => {
    if (!idName.trim() && !idEmail.trim()) return
    await git.setIdentity(idName.trim(), idEmail.trim(), true)
    setShowIdentity(false)
    // 身份配好后自动重试提交
    void doCommit()
  }

  const remote = async (
    fn: () => Promise<{ ok: boolean; reason?: GitFailReason; message?: string }>,
    okText: string
  ): Promise<void> => {
    closeMenu()
    const res = await fn()
    setNotice(res.ok ? { kind: 'ok', text: okText } : { kind: 'error', text: reasonText(res.reason, res.message) })
  }

  // 克隆：成功即切到新项目（panel 随 repoDir 变化自刷新），无需成功提示；仅报错。
  const doClone = async (url: string): Promise<void> => {
    closeMenu()
    if (!url.trim()) return
    const res = await git.clone(url.trim())
    setNotice(res.ok ? null : { kind: 'error', text: reasonText(res.reason, res.message) })
  }

  const confirmDiscard = (files: GitFileStatus[]): void => {
    if (files.length === 0) return
    const msg =
      files.length === 1
        ? t('git.discardConfirm').replace('{name}', files[0].name)
        : t('git.discardConfirmMany').replace('{count}', String(files.length))
    if (window.confirm(msg)) void git.discard(files)
  }

  const openMenu = (): void => {
    if (!menuOpen) void git.loadBranches()
    setMenuOpen((v) => !v)
    setMenuMode('root')
  }

  // 文件行渲染（普通函数而非内嵌组件，避免每次父级重渲染导致整列 remount）
  const renderRow = (file: GitFileStatus, side: 'staged' | 'unstaged' | 'conflict'): React.JSX.Element => {
    const isSel = selected?.file.path === file.path && selected?.staged === (side === 'staged')
    const color = file.conflicted ? 'var(--danger)' : STATUS_COLOR[file.letter] ?? 'var(--fg-muted)'
    return (
      <div
        key={`${side}:${file.path}`}
        className={`list-row${isSel ? ' is-selected' : ''}`}
        title={file.rel}
        onClick={() => git.select(file, side === 'staged')}
      >
        <span className="list-row__icon">
          <FileText size={14} />
        </span>
        <span className="list-row__label">
          {file.name}
          {file.dir && <span className="gitrow__dir">{file.dir}</span>}
        </span>
        <span className="gitrow__actions" onClick={(e) => e.stopPropagation()}>
          {side === 'staged' ? (
            <button className="gitrow__btn" title={t('git.unstage')} disabled={busy} onClick={() => void git.unstage([file])}>
              <Minus size={14} />
            </button>
          ) : (
            <>
              <button className="gitrow__btn" title={t('git.discard')} disabled={busy} onClick={() => confirmDiscard([file])}>
                <Undo2 size={14} />
              </button>
              <button className="gitrow__btn" title={t('git.stage')} disabled={busy} onClick={() => void git.stage([file])}>
                <Plus size={14} />
              </button>
            </>
          )}
        </span>
        <span className="gitrow__letter" style={{ color }}>
          {file.letter}
        </span>
      </div>
    )
  }

  return (
    <>
      <PanelHeader
        title={t('git.title')}
        actions={
          <>
            <button className="icon-btn" title={t('git.refresh')} onClick={() => void git.refresh()}>
              <RefreshCw size={14} className={loading ? 'spin' : undefined} />
            </button>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className={`icon-btn${menuOpen ? ' is-active' : ''}`}
                title={t('git.more')}
                onClick={openMenu}
              >
                <MoreHorizontal size={16} />
              </button>
              {menuOpen && (
                <>
                  <div className="backdrop" onClick={closeMenu} />
                  <div className="gitmenu">
                    {menuMode === 'root' && (
                      <>
                        <button
                          className="projmenu__item"
                          disabled={busy}
                          onClick={() => void remote(git.pull, t('git.pulled'))}
                        >
                          <span className="projmenu__check">
                            <DownloadCloud size={15} />
                          </span>
                          <span className="projmenu__name">{t('git.pull')}</span>
                        </button>
                        <button
                          className="projmenu__item"
                          disabled={busy}
                          onClick={() => void remote(git.push, t('git.pushed'))}
                        >
                          <span className="projmenu__check">
                            <UploadCloud size={15} />
                          </span>
                          <span className="projmenu__name">{t('git.push')}</span>
                        </button>
                        <button
                          className="projmenu__item"
                          disabled={busy}
                          onClick={() => void remote(git.fetch, t('git.fetched'))}
                        >
                          <span className="projmenu__check">
                            <RefreshCw size={15} />
                          </span>
                          <span className="projmenu__name">{t('git.fetch')}</span>
                        </button>
                        <div className="projmenu__divider" />
                        <button
                          className="projmenu__item"
                          onClick={() => {
                            setBranchName('')
                            setMenuMode('branch')
                          }}
                        >
                          <span className="projmenu__check">
                            <GitBranchIcon size={15} />
                          </span>
                          <span className="projmenu__name">{t('git.createBranch')}</span>
                        </button>
                        {branches.length > 0 && <div className="projmenu__divider" />}
                        {branches.map((b) => (
                          <button
                            key={b.name}
                            className={`projmenu__item${b.current ? ' is-active' : ''}`}
                            disabled={busy || b.current}
                            onClick={() => {
                              closeMenu()
                              void git.checkout(b.name)
                            }}
                          >
                            <span className="projmenu__check">{b.current && <Check size={14} />}</span>
                            <span className="projmenu__name">{b.name}</span>
                          </button>
                        ))}
                        <div className="projmenu__divider" />
                        <button
                          className="projmenu__item"
                          onClick={() => {
                            setCloneUrl('')
                            setMenuMode('clone')
                          }}
                        >
                          <span className="projmenu__check">
                            <Copy size={15} />
                          </span>
                          <span className="projmenu__name">{t('git.clone')}</span>
                        </button>
                      </>
                    )}
                    {menuMode === 'branch' && (
                      <div className="gitmenu__form">
                        <input
                          className="input input--sm"
                          autoFocus
                          placeholder={t('git.newBranchName')}
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && branchName.trim()) {
                              closeMenu()
                              void git.createBranch(branchName.trim(), true)
                            } else if (e.key === 'Escape') setMenuMode('root')
                          }}
                        />
                        <div className="gitmenu__formrow">
                          <button className="btn btn--sm btn--ghost" onClick={() => setMenuMode('root')}>
                            {t('git.cancel')}
                          </button>
                          <button
                            className="btn btn--sm btn--primary"
                            disabled={!branchName.trim()}
                            onClick={() => {
                              closeMenu()
                              void git.createBranch(branchName.trim(), true)
                            }}
                          >
                            {t('git.create')}
                          </button>
                        </div>
                      </div>
                    )}
                    {menuMode === 'clone' && (
                      <div className="gitmenu__form">
                        <input
                          className="input input--sm"
                          autoFocus
                          placeholder={t('git.cloneUrl')}
                          value={cloneUrl}
                          onChange={(e) => setCloneUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && cloneUrl.trim()) void doClone(cloneUrl)
                            else if (e.key === 'Escape') setMenuMode('root')
                          }}
                        />
                        <div className="gitmenu__formrow">
                          <button className="btn btn--sm btn--ghost" onClick={() => setMenuMode('root')}>
                            {t('git.cancel')}
                          </button>
                          <button
                            className="btn btn--sm btn--primary"
                            disabled={!cloneUrl.trim()}
                            onClick={() => void doClone(cloneUrl)}
                          >
                            {t('git.clone').replace('…', '')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </span>
          </>
        }
      />

      <div className="sidepanel__body">
        {/* 提交区 */}
        <div style={{ padding: '8px 4px 4px' }}>
          <div className="composer__box" style={{ margin: 0, borderRadius: 'var(--radius-sm)', padding: 8 }}>
            <textarea
              className="composer__input"
              rows={2}
              placeholder={t('git.commitPlaceholder').replace('{branch}', branch || 'HEAD')}
              style={{ maxHeight: 96 }}
              value={commitMessage}
              onChange={(e) => git.setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) void doCommit()
              }}
            />
          </div>
          <button
            className="btn btn--primary btn--sm"
            style={{ marginTop: 8, width: '100%' }}
            disabled={!canCommit}
            onClick={() => void doCommit()}
          >
            <Check size={14} />
            {busy ? t('git.committing') : `${t('git.commit')}${branch ? ` (${branch})` : ''}`}
          </button>

          {/* ahead / behind */}
          {!!status && (status.ahead > 0 || status.behind > 0) && (
            <div className="gitsync">
              {status.behind > 0 && (
                <span className="gitsync__item" title={t('git.behind')}>
                  <ArrowDown size={12} />
                  {status.behind}
                </span>
              )}
              {status.ahead > 0 && (
                <span className="gitsync__item" title={t('git.ahead')}>
                  <ArrowUp size={12} />
                  {status.ahead}
                </span>
              )}
            </div>
          )}

          {/* 身份填写（提交返回 identity-needed 时出现） */}
          {showIdentity && (
            <div className="gitidentity">
              <div className="gitidentity__hint">{t('git.identityHint')}</div>
              <input
                className="input input--sm"
                placeholder={t('git.authorName')}
                value={idName}
                onChange={(e) => setIdName(e.target.value)}
              />
              <input
                className="input input--sm"
                placeholder={t('git.authorEmail')}
                value={idEmail}
                onChange={(e) => setIdEmail(e.target.value)}
              />
              <button
                className="btn btn--sm btn--primary"
                style={{ width: '100%' }}
                disabled={!idName.trim() || !idEmail.trim()}
                onClick={() => void saveIdentity()}
              >
                {t('git.saveIdentity')}
              </button>
            </div>
          )}

          {/* 结果 / 错误提示 */}
          {notice && (
            <div className={`gitnotice gitnotice--${notice.kind}`} onClick={() => setNotice(null)}>
              {notice.text}
            </div>
          )}
        </div>

        {/* 合并冲突 */}
        {conflicts.length > 0 && (
          <Group label={t('git.mergeChanges')} count={conflicts.length}>
            {conflicts.map((f) => renderRow(f, 'conflict'))}
          </Group>
        )}

        {/* 已暂存 */}
        {staged.length > 0 && (
          <Group
            label={t('git.stagedChanges')}
            count={staged.length}
            action={
              <button
                className="gitgroup__btn"
                title={t('git.unstageAll')}
                disabled={busy}
                onClick={() => void git.unstage(staged)}
              >
                <Minus size={14} />
              </button>
            }
          >
            {staged.map((f) => renderRow(f, 'staged'))}
          </Group>
        )}

        {/* 更改 */}
        {unstaged.length > 0 && (
          <Group
            label={t('git.changes')}
            count={unstaged.length}
            action={
              <>
                <button
                  className="gitgroup__btn"
                  title={t('git.discard')}
                  disabled={busy}
                  onClick={() => confirmDiscard(unstaged)}
                >
                  <Undo2 size={14} />
                </button>
                <button
                  className="gitgroup__btn"
                  title={t('git.stageAll')}
                  disabled={busy}
                  onClick={() => void git.stage(unstaged)}
                >
                  <Plus size={14} />
                </button>
              </>
            }
          >
            {unstaged.map((f) => renderRow(f, 'unstaged'))}
          </Group>
        )}

        {/* 干净：无更改 */}
        {isRepo &&
          conflicts.length === 0 &&
          staged.length === 0 &&
          unstaged.length === 0 &&
          !loading && <div className="sidepanel__empty">{t('git.noChanges')}</div>}
      </div>
    </>
  )
}

/** 更改分组：标题 + 计数 + 组级操作（hover 浮现）。 */
function Group({
  label,
  count,
  action,
  children
}: {
  label: string
  count: number
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="gitgroup">
      <div className="gitgroup__header">
        <span className="gitgroup__title">{label}</span>
        {action && <span className="gitgroup__actions">{action}</span>}
        <span className="gitgroup__count">{count}</span>
      </div>
      {children}
    </div>
  )
}
