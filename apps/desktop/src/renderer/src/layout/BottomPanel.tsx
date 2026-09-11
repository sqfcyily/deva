import { useEffect, useRef, useState } from 'react'
import { Terminal as TerminalIcon, Plus, ChevronDown, X } from 'lucide-react'
import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { useTheme } from '../theme/ThemeContext'
import { useWorkspace } from '../store/workspace'
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

/** 空分组的稳定引用（避免每次渲染新建 [] 触发下游抖动）。 */
const EMPTY_TERMS: TermTab[] = []
/** 无项目时的分组键（cwd 回退到用户主目录）。 */
const NO_PROJECT = ''

/**
 * 底部集成终端面板（类 VSCode）：多页签 + shell 选择下拉。
 * 每个页签一个独立 xterm+PTY，切换互不影响、进程各自保活；关闭面板即卸载全部终端。
 *
 * 终端「按项目分组」：termsByProject[项目路径] 各自一组页签，切项目即切换到该项目的
 * 终端集合。非当前项目的终端实例仍保持挂载（CSS 隐藏保活，PTY 与滚动历史不丢），
 * 与既有隐藏页签保活机制一致。每个项目首次在可见面板下无终端时自动建一个默认终端；
 * 用户手动清空后不再自动重建（按项目集合记忆）。
 *
 * hidden：当前视图不显示终端时由父组件传入。此时用 CSS 隐藏而非卸载，
 * 终端会话跨页面切换保活；重新可见时 TerminalInstance 的 ResizeObserver 触发重排。
 */
export function BottomPanel({ hidden = false }: { hidden?: boolean }): React.JSX.Element {
  const { togglePanel } = useUI()
  const { t } = useI18n()
  const { resolved } = useTheme()
  const { activeProject } = useWorkspace()

  const pid = activeProject?.path ?? NO_PROJECT

  const [profiles, setProfiles] = useState<ShellProfile[]>([])
  const [termsByProject, setTermsByProject] = useState<Record<string, TermTab[]>>({})
  const [activeIdByProject, setActiveIdByProject] = useState<Record<string, string | null>>({})
  const [menuOpen, setMenuOpen] = useState(false)

  const seqRef = useRef(0)
  // 已自动建过默认终端的项目集合（每项目仅一次，手动清空后不重建）；ref 跨 StrictMode 保活。
  const autoInitedRef = useRef<Set<string>>(new Set())
  // termsByProject 的最新快照——供 closeTerminal 定位「退出终端」所属项目（可能是非活动项目的保活终端）。
  const termsRef = useRef(termsByProject)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    termsRef.current = termsByProject
  }, [termsByProject])

  // 当前活动项目的终端分组 / 活动页签（派生自分片）。
  const terms = termsByProject[pid] ?? EMPTY_TERMS
  const activeId = activeIdByProject[pid] ?? null

  /** 在「当前活动项目」组内新建一个终端页签（profile 为空则用主进程默认 shell）。 */
  function addTerminal(profile?: ShellProfile): void {
    const rid = `rt${++seqRef.current}`
    const shellId = profile?.id ?? null
    const baseLabel = profile?.label ?? t('terminal.title')
    setTermsByProject((prev) => {
      const cur = prev[pid] ?? []
      const dup = cur.filter((x) => x.baseLabel === baseLabel).length
      const title = dup === 0 ? baseLabel : `${baseLabel} (${dup + 1})`
      return { ...prev, [pid]: [...cur, { id: rid, shellId, title, baseLabel }] }
    })
    setActiveIdByProject((prev) => ({ ...prev, [pid]: rid }))
    setMenuOpen(false)
  }

  /**
   * 关闭一个终端页签；若关的是所属组的活动页签，激活相邻者。
   * 经快照定位所属项目——退出的可能是非活动项目的保活终端（onExit 上抛）。
   */
  function closeTerminal(rid: string): void {
    const snap = termsRef.current
    const owner = Object.keys(snap).find((k) => snap[k].some((x) => x.id === rid))
    if (owner === undefined) return
    const group = snap[owner]
    const idx = group.findIndex((x) => x.id === rid)
    const nextGroup = group.filter((x) => x.id !== rid)
    setTermsByProject((prev) => ({ ...prev, [owner]: nextGroup }))
    setActiveIdByProject((prev) =>
      prev[owner] === rid
        ? { ...prev, [owner]: nextGroup[idx]?.id ?? nextGroup[idx - 1]?.id ?? nextGroup[0]?.id ?? null }
        : prev
    )
  }

  const defaultProfile = (): ShellProfile | undefined =>
    profiles.find((p) => p.isDefault) ?? profiles[0]

  // 挂载：取 shell 清单（自动建默认终端交由下方按项目的 effect 处理）。
  useEffect(() => {
    void window.deva.terminal.listShells().then(setProfiles)
  }, [])

  // 逐项目自动建默认终端：面板可见 + 当前项目首次 + 该组无终端 + shell 已就绪。
  // 用户随后手动清空不再重建（autoInitedRef 记忆已初始化的项目）。
  useEffect(() => {
    if (hidden || profiles.length === 0) return
    if (autoInitedRef.current.has(pid)) return
    if ((termsByProject[pid]?.length ?? 0) > 0) {
      autoInitedRef.current.add(pid)
      return
    }
    autoInitedRef.current.add(pid)
    addTerminal(defaultProfile())
    // addTerminal/defaultProfile 依赖当前渲染闭包；仅在下列输入变化时评估。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, hidden, profiles])

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
              onClick={() => setActiveIdByProject((prev) => ({ ...prev, [pid]: tab.id }))}
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
        {/* 所有项目的终端实例都保持挂载：非当前项目/非活动页签用 is-hidden 保活。 */}
        {Object.entries(termsByProject).flatMap(([owner, group]) =>
          group.map((tab) => (
            <TerminalInstance
              key={tab.id}
              id={tab.id}
              shellId={tab.shellId}
              cwd={owner || null}
              visible={owner === pid && tab.id === activeId}
              onExit={closeTerminal}
            />
          ))
        )}
        {terms.length === 0 && (
          <div className="term-empty">
            <button className="btn" onClick={() => addTerminal(defaultProfile())}>
              <Plus size={14} />
              <span>{t('terminal.newTerminal')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
