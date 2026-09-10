import { useEffect, useRef, useState } from 'react'
import { Terminal as TerminalIcon, Plus, ChevronDown, X } from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { useTheme } from '../theme/ThemeContext'
import { TerminalInstance } from '../features/terminal/TerminalInstance'
import { xtermBg } from '../features/terminal/xtermTheme'

/** 可用 shell 配置（与 preload ShellProfile 结构一致，按既定模式在本层复述）。 */
interface ShellProfile {
  id: string
  label: string
  isDefault?: boolean
}

/** 一个终端页签。baseLabel 用于同名去歧义计数。 */
interface TermTab {
  id: string
  shellId: string | null
  title: string
  baseLabel: string
}

/**
 * 底部集成终端面板（类 VSCode）：多页签 + shell 选择下拉。
 * 每个页签一个独立 xterm+PTY，切换互不影响、进程各自保活；关闭面板即卸载全部终端。
 *
 * hidden：当前视图不显示终端时由父组件传入。此时用 CSS 隐藏而非卸载，
 * 终端会话跨页面切换保活；重新可见时 TerminalInstance 的 ResizeObserver 触发重排。
 */
export function BottomPanel({ hidden = false }: { hidden?: boolean }): React.JSX.Element {
  const { togglePanel } = useUI()
  const { t } = useI18n()
  const { resolved } = useTheme()

  const [profiles, setProfiles] = useState<ShellProfile[]>([])
  const [terms, setTerms] = useState<TermTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const seqRef = useRef(0)
  const initRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)

  /** 新建一个终端页签（profile 为空则用主进程默认 shell）。 */
  function addTerminal(profile?: ShellProfile): void {
    const rid = `rt${++seqRef.current}`
    const shellId = profile?.id ?? null
    const baseLabel = profile?.label ?? t('terminal.title')
    setTerms((prev) => {
      const dup = prev.filter((x) => x.baseLabel === baseLabel).length
      const title = dup === 0 ? baseLabel : `${baseLabel} (${dup + 1})`
      return [...prev, { id: rid, shellId, title, baseLabel }]
    })
    setActiveId(rid)
    setMenuOpen(false)
  }

  /** 关闭一个终端页签；若关的是当前活动页签，激活相邻者。 */
  function closeTerminal(rid: string): void {
    const idx = terms.findIndex((x) => x.id === rid)
    const next = terms.filter((x) => x.id !== rid)
    setTerms(next)
    if (activeId === rid) {
      setActiveId(next[idx]?.id ?? next[idx - 1]?.id ?? next[0]?.id ?? null)
    }
  }

  const defaultProfile = (): ShellProfile | undefined =>
    profiles.find((p) => p.isDefault) ?? profiles[0]

  // 挂载：取 shell 清单，并自动新建一个默认终端（idempotent 守卫抵御 StrictMode 双调用）。
  useEffect(() => {
    void window.deva.terminal.listShells().then((list) => {
      setProfiles(list)
      if (!initRef.current) {
        initRef.current = true
        addTerminal(list.find((p) => p.isDefault) ?? list[0])
      }
    })
    // 仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // shell 下拉：点击外部 / Esc 关闭。
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div className="bottompanel" style={hidden ? { display: 'none' } : undefined} aria-hidden={hidden || undefined}>
      <div className="bottompanel__tabs">
        <div className="termtabs">
          {terms.map((tab) => (
            <div
              key={tab.id}
              className={`termtab${tab.id === activeId ? ' is-active' : ''}`}
              onClick={() => setActiveId(tab.id)}
              title={tab.title}
            >
              <TerminalIcon size={13} />
              <span className="termtab__title">{tab.title}</span>
              <button
                className="termtab__close"
                title={t('terminal.killTerminal')}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="term-actions">
          <button className="icon-btn" title={t('terminal.newTerminal')} onClick={() => addTerminal(defaultProfile())}>
            <Plus size={15} />
          </button>
          <div className="term-newmenu" ref={menuRef}>
            <button className="icon-btn" title={t('terminal.selectShell')} onClick={() => setMenuOpen((o) => !o)}>
              <ChevronDown size={15} />
            </button>
            {menuOpen && (
              <div className="term-menu">
                {profiles.map((p) => (
                  <button key={p.id} className="term-menu__item" onClick={() => addTerminal(p)}>
                    <TerminalIcon size={13} />
                    <span>{p.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" title="Close" onClick={togglePanel}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="bottompanel__body" style={{ background: xtermBg(resolved) }}>
        {terms.length === 0 ? (
          <div className="term-empty">
            <button className="btn" onClick={() => addTerminal(defaultProfile())}>
              <Plus size={14} />
              <span>{t('terminal.newTerminal')}</span>
            </button>
          </div>
        ) : (
          terms.map((tab) => (
            <TerminalInstance
              key={tab.id}
              id={tab.id}
              shellId={tab.shellId}
              visible={tab.id === activeId}
              onExit={closeTerminal}
            />
          ))
        )}
      </div>
    </div>
  )
}
