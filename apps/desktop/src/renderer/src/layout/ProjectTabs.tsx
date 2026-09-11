import { useEffect, useRef, useState } from 'react'
import { Folder, X, Plus, ChevronDown, FolderOpen, History, Check } from 'lucide-react'
import { useWorkspace } from '../store/workspace'
import { useI18n } from '../i18n/i18n'

/**
 * 顶部常驻项目 tab 条（浏览器式，嵌在标题栏一行内）：一项目一 tab，当前高亮，
 * 可一键切换 / 关闭；tab 多时横向滚动（活动 tab 自动 scrollIntoView）。右侧 `+`
 * 打开文件夹、`⌄` 溢出菜单列「打开的项目」（全部已开、当前打勾，可点切换 / ✕关——
 * 即便滚出屏幕也能直达）+「最近但未打开」的项目 + 打开文件夹。
 * 始终渲染——即便零项目，`+` / `⌄` 也在，保证任何时候都能新开项目。
 * 数据全部来自 WorkspaceProvider，切 tab 即 setActiveProject——文件树 / Git /
 * Chat / 编辑器标签 / 终端随之整体切换。
 */
export function ProjectTabs(): React.JSX.Element {
  const { t } = useI18n()
  const {
    projects,
    activeProjectId,
    setActiveProject,
    closeProject,
    openFolder,
    recentProjects,
    openRecent,
    removeRecent
  } = useWorkspace()
  const [menuOpen, setMenuOpen] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)

  // 最近项目中「当前未打开」的部分（已打开的以 tab 呈现，避免重复）。
  const recentClosed = recentProjects.filter((r) => !projects.some((p) => p.path === r.path))

  // 当前 tab 变化时滚动进可视区（tab 多到横向溢出时）。
  useEffect(() => {
    stripRef.current?.querySelector('.projtab.is-active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    })
  }, [activeProjectId])

  // Ctrl+Tab / Ctrl+Shift+Tab 在已打开项目间循环切换。
  useEffect(() => {
    if (projects.length < 2) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !e.ctrlKey) return
      e.preventDefault()
      const idx = projects.findIndex((p) => p.id === activeProjectId)
      const base = idx < 0 ? 0 : idx
      const n = projects.length
      const next = e.shiftKey ? (base - 1 + n) % n : (base + 1) % n
      setActiveProject(projects[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projects, activeProjectId, setActiveProject])

  return (
    <div className="projtabs">
      <div className="projtabs__strip" ref={stripRef}>
        {projects.map((p) => (
          <div
            key={p.id}
            className={`projtab${p.id === activeProjectId ? ' is-active' : ''}`}
            title={p.path}
            onClick={() => setActiveProject(p.id)}
          >
            <Folder size={14} className="projtab__icon" />
            <span className="projtab__name">{p.name}</span>
            <button
              className="projtab__close"
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
      </div>

      <div className="projtabs__actions">
        <button
          className="icon-btn"
          title={t('titlebar.openFolder')}
          onClick={() => void openFolder()}
        >
          <Plus size={16} />
        </button>
        <div className="projtabs__more-wrap">
          <button
            className={`icon-btn${menuOpen ? ' is-active' : ''}`}
            title={t('projtabs.more')}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <ChevronDown size={16} />
          </button>
          {menuOpen && (
            <>
              <div className="backdrop" onClick={() => setMenuOpen(false)} />
              <div className="projmenu projmenu--right">
                {projects.length > 0 && (
                  <>
                    <div className="projmenu__label">{t('projtabs.openLabel')}</div>
                    {projects.map((p) => (
                      <div
                        key={p.id}
                        className={`projmenu__item${p.id === activeProjectId ? ' is-active' : ''}`}
                        onClick={() => {
                          setMenuOpen(false)
                          setActiveProject(p.id)
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
                    <div className="projmenu__divider" />
                  </>
                )}
                {recentClosed.length > 0 && (
                  <>
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
                    <div className="projmenu__divider" />
                  </>
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
