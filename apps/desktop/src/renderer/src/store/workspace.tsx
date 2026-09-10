import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

/**
 * 工作区状态（真实数据，经 window.deva.fs 走主进程）。
 * - 项目：可多开的真实文件夹，顶部切换。
 * - 文件树：按需懒加载（展开目录时才读取其子项），以绝对路径为键，天然支持多项目。
 * - 编辑器：多标签，跟踪脏状态，Ctrl+S 写回磁盘。
 * - 记忆最近项目：启动自动重开上次的活动项目；历史列表可一键再开（上限可设，存 ~/.deva/config.json）。
 *   自动重开经 window.deva.fs.openPath（无对话框但同样登记受信根），否则文件读写会被主进程受信根校验拒绝。
 */

export interface Project {
  id: string // 绝对路径即唯一 id
  name: string
  path: string
}

/** 历史打开过的项目（最近在前）。 */
export interface RecentProject {
  path: string
  name: string
  openedAt: number
}

export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

export interface FlatNode extends DirEntry {
  depth: number
  expanded: boolean
}

export interface Tab {
  path: string
  name: string
}

type FileState = 'ok' | 'binary' | 'tooLarge'

const DEFAULT_RECENT_LIMIT = 10
const RECENT_LIMIT_MIN = 1
const RECENT_LIMIT_MAX = 50

/** 持久化在 config.json 的 workspace 段。 */
interface WorkspacePersisted {
  recent?: RecentProject[]
  last?: string | null
  recentLimit?: number
}

interface WorkspaceValue {
  // 项目
  projects: Project[]
  activeProjectId: string | null
  activeProject: Project | null
  openFolder: () => Promise<void>
  setActiveProject: (id: string) => void
  closeProject: (id: string) => void
  // 最近项目（历史）
  recentProjects: RecentProject[]
  recentLimit: number
  openRecent: (path: string) => Promise<void>
  removeRecent: (path: string) => void
  setRecentLimit: (n: number) => void
  // 文件树
  tree: FlatNode[]
  toggleDir: (path: string) => Promise<void>
  // 编辑器
  tabs: Tab[]
  activePath: string | null
  openFile: (path: string) => Promise<void>
  setActivePath: (path: string) => void
  closeTab: (path: string) => void
  contentOf: (path: string) => string | undefined
  stateOf: (path: string) => FileState | undefined
  editContent: (path: string, text: string) => void
  isDirty: (path: string) => boolean
  saveActive: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null)

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_RECENT_LIMIT
  return Math.max(RECENT_LIMIT_MIN, Math.min(RECENT_LIMIT_MAX, Math.floor(n)))
}

export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // 最近项目（历史，最近在前）+ 上限。持久化于 ~/.deva/config.json 的 workspace 段。
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [recentLimit, setRecentLimitState] = useState<number>(DEFAULT_RECENT_LIMIT)
  // 配置载入完成前不回写，避免用空默认覆盖已存配置（镜像 store/models.tsx 的 hydrate 守卫）。
  const [hydrated, setHydrated] = useState(false)

  // 文件树：目录路径 -> 子项；展开集合。以绝对路径为键。
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // 编辑器
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState<Record<string, string>>({})
  const [savedContent, setSavedContent] = useState<Record<string, string>>({})
  const [fileState, setFileState] = useState<Record<string, FileState>>({})

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

  const ensureChildren = useCallback(async (dir: string): Promise<void> => {
    const list = await window.deva.fs.readDir(dir)
    setChildrenMap((prev) => ({ ...prev, [dir]: list }))
  }, [])

  // 上限的最新值给 applyOpen 截断历史用（避免把 recentLimit 塞进 applyOpen 依赖导致回调频繁重建）。
  const limitRef = useRef(recentLimit)
  useEffect(() => {
    limitRef.current = recentLimit
  }, [recentLimit])

  // 是否已有「用户主动打开」的项目（同步置位，供 hydrate 判断是否还需自动重开上次项目）。
  // 用 ref 而非 state：需在 hydrate 的 await 之间被同步读到，避免踩启动瞬间用户的手动打开。
  const userOpenedRef = useRef(false)

  // 打开一个项目的公共路径：登记为项目 + 设为活动 + 载入根目录 + 记入最近列表。
  const applyOpen = useCallback(
    async (proj: Project): Promise<void> => {
      userOpenedRef.current = true
      setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]))
      setActiveProjectId(proj.id)
      setRecentProjects((prev) => {
        const now = Date.now()
        const next = [
          { path: proj.path, name: proj.name, openedAt: now },
          ...prev.filter((r) => r.path !== proj.path)
        ]
        return next.slice(0, limitRef.current)
      })
      if (!childrenMap[proj.path]) await ensureChildren(proj.path)
      setExpanded((e) => ({ ...e, [proj.path]: true }))
    },
    [childrenMap, ensureChildren]
  )

  const openFolder = useCallback(async (): Promise<void> => {
    const res = await window.deva.fs.openFolder()
    if (!res) return
    await applyOpen({ id: res.path, name: res.name, path: res.path })
  }, [applyOpen])

  const removeRecent = useCallback((path: string): void => {
    setRecentProjects((prev) => prev.filter((r) => r.path !== path))
  }, [])

  const openRecent = useCallback(
    async (path: string): Promise<void> => {
      const res = await window.deva.fs.openPath(path)
      if (!res) {
        // 路径已失效（被删/移动）：从历史剔除，不报错。
        removeRecent(path)
        return
      }
      await applyOpen({ id: res.path, name: res.name, path: res.path })
    },
    [applyOpen, removeRecent]
  )

  const setRecentLimit = useCallback((n: number): void => {
    const lim = clampLimit(n)
    setRecentLimitState(lim)
    setRecentProjects((prev) => prev.slice(0, lim))
  }, [])

  // 挂载时载入持久化配置：恢复历史/上限，并自动重开上次的活动项目（若仍有效）。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await window.deva.config.get()
        const saved = cfg?.workspace as WorkspacePersisted | undefined
        if (!alive) return
        const lim = clampLimit(saved?.recentLimit ?? DEFAULT_RECENT_LIMIT)
        setRecentLimitState(lim)
        limitRef.current = lim
        const recentArr = saved?.recent
        if (Array.isArray(recentArr)) {
          const cleaned = recentArr
            .filter((r) => r && typeof r.path === 'string')
            .map((r) => ({
              path: r.path,
              name: r.name || baseName(r.path),
              openedAt: typeof r.openedAt === 'number' ? r.openedAt : 0
            }))
            .slice(0, lim)
          setRecentProjects(cleaned)
        }
        const last = saved?.last
        if (last && typeof last === 'string') {
          const res = await window.deva.fs.openPath(last)
          if (!alive) return
          if (res) {
            // 仅当用户尚未在 hydrate 期间手动打开项目时，才自动重开上次项目。
            // 经 applyOpen 完整打开（设为活动 + 载入文件树 + 展开根），而非只塞进 projects。
            if (!userOpenedRef.current) {
              await applyOpen({ id: res.path, name: res.name, path: res.path })
            }
          } else {
            // 上次项目已失效：从历史剔除。
            setRecentProjects((prev) => prev.filter((r) => r.path !== last))
          }
        }
      } catch {
        /* 无配置 / 读取失败：空态起步 */
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
    // 仅挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 变更后回写（仅在 hydrate 之后）。写入整个 workspace 段（config.set 顶层浅合并）。
  useEffect(() => {
    if (!hydrated) return
    void window.deva.config.set({
      workspace: {
        recent: recentProjects,
        last: activeProject?.path ?? null,
        recentLimit
      }
    })
  }, [hydrated, recentProjects, activeProject, recentLimit])

  const setActiveProject = useCallback(
    (id: string): void => {
      setActiveProjectId(id)
      const proj = projects.find((p) => p.id === id)
      if (proj && !childrenMap[proj.path]) void ensureChildren(proj.path)
    },
    [projects, childrenMap, ensureChildren]
  )

  const closeProject = useCallback((id: string): void => {
    // 关闭仅移出「已打开」集合；不动最近历史（关闭 ≠ 忘记）。
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id)
      setActiveProjectId((cur) => (cur === id ? next[0]?.id ?? null : cur))
      return next
    })
  }, [])

  const toggleDir = useCallback(
    async (path: string): Promise<void> => {
      const willExpand = !expanded[path]
      setExpanded((e) => ({ ...e, [path]: willExpand }))
      if (willExpand && !childrenMap[path]) await ensureChildren(path)
    },
    [expanded, childrenMap, ensureChildren]
  )

  // 扁平化当前项目的可见树（供列表渲染）
  const tree = useMemo<FlatNode[]>(() => {
    if (!activeProject) return []
    const acc: FlatNode[] = []
    const walk = (dir: string, depth: number): void => {
      const list = childrenMap[dir]
      if (!list) return
      for (const e of list) {
        const isOpen = !!expanded[e.path]
        acc.push({ ...e, depth, expanded: isOpen })
        if (e.type === 'dir' && isOpen) walk(e.path, depth + 1)
      }
    }
    walk(activeProject.path, 0)
    return acc
  }, [activeProject, childrenMap, expanded])

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      setTabs((prev) =>
        prev.some((t) => t.path === path) ? prev : [...prev, { path, name: baseName(path) }]
      )
      setActivePath(path)
      if (content[path] !== undefined || fileState[path] !== undefined) return
      const res = await window.deva.fs.readFile(path)
      if (res.binary) {
        setFileState((s) => ({ ...s, [path]: 'binary' }))
      } else if (res.tooLarge) {
        setFileState((s) => ({ ...s, [path]: 'tooLarge' }))
      } else {
        setContent((c) => ({ ...c, [path]: res.content }))
        setSavedContent((c) => ({ ...c, [path]: res.content }))
        setFileState((s) => ({ ...s, [path]: 'ok' }))
      }
    },
    [content, fileState]
  )

  const closeTab = useCallback((path: string): void => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      const next = prev.filter((t) => t.path !== path)
      setActivePath((cur) => {
        if (cur !== path) return cur
        if (next.length === 0) return null
        return (next[idx] ?? next[idx - 1] ?? next[0]).path
      })
      return next
    })
  }, [])

  const editContent = useCallback((path: string, text: string): void => {
    setContent((c) => ({ ...c, [path]: text }))
  }, [])

  const isDirty = useCallback(
    (path: string): boolean => fileState[path] === 'ok' && content[path] !== savedContent[path],
    [fileState, content, savedContent]
  )

  const saveActive = useCallback(async (): Promise<void> => {
    const path = activePath
    if (!path || fileState[path] !== 'ok') return
    if (content[path] === savedContent[path]) return
    const text = content[path] ?? ''
    await window.deva.fs.writeFile(path, text)
    setSavedContent((c) => ({ ...c, [path]: text }))
  }, [activePath, fileState, content, savedContent])

  const contentOf = useCallback((path: string): string | undefined => content[path], [content])
  const stateOf = useCallback((path: string): FileState | undefined => fileState[path], [fileState])

  const value = useMemo<WorkspaceValue>(
    () => ({
      projects,
      activeProjectId,
      activeProject,
      openFolder,
      setActiveProject,
      closeProject,
      recentProjects,
      recentLimit,
      openRecent,
      removeRecent,
      setRecentLimit,
      tree,
      toggleDir,
      tabs,
      activePath,
      openFile,
      setActivePath,
      closeTab,
      contentOf,
      stateOf,
      editContent,
      isDirty,
      saveActive
    }),
    [
      projects,
      activeProjectId,
      activeProject,
      openFolder,
      setActiveProject,
      closeProject,
      recentProjects,
      recentLimit,
      openRecent,
      removeRecent,
      setRecentLimit,
      tree,
      toggleDir,
      tabs,
      activePath,
      openFile,
      closeTab,
      contentOf,
      stateOf,
      editContent,
      isDirty,
      saveActive
    ]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用')
  return ctx
}
