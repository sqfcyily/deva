import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react'

/**
 * 工作区状态（真实数据，经 window.deva.fs 走主进程）。
 * - 项目：可多开的真实文件夹，顶部切换。
 * - 文件树：按需懒加载（展开目录时才读取其子项），以绝对路径为键，天然支持多项目。
 * - 编辑器：多标签，跟踪脏状态，Ctrl+S 写回磁盘。
 */

export interface Project {
  id: string // 绝对路径即唯一 id
  name: string
  path: string
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

/** 空标签分片的稳定引用（避免每次渲染新建 [] 触发下游 memo 抖动）。 */
const NO_TABS: Tab[] = []

interface WorkspaceValue {
  // 项目
  projects: Project[]
  activeProjectId: string | null
  activeProject: Project | null
  openFolder: () => Promise<void>
  setActiveProject: (id: string) => void
  closeProject: (id: string) => void
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

export function WorkspaceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // 文件树：目录路径 -> 子项；展开集合。以绝对路径为键。
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // 编辑器：标签与活动文件按项目分片（对外派生为「当前项目」的标签/活动文件）。
  // 内容缓存以绝对路径为键、天然唯一，保持全局不分片。
  const [tabsByProject, setTabsByProject] = useState<Record<string, Tab[]>>({})
  const [activePathByProject, setActivePathByProject] = useState<Record<string, string | null>>({})
  const [content, setContent] = useState<Record<string, string>>({})
  const [savedContent, setSavedContent] = useState<Record<string, string>>({})
  const [fileState, setFileState] = useState<Record<string, FileState>>({})

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

  // 当前项目的编辑器标签 / 活动文件（派生自分片；无项目则空）。
  const tabs = activeProjectId ? tabsByProject[activeProjectId] ?? NO_TABS : NO_TABS
  const activePath = activeProjectId ? activePathByProject[activeProjectId] ?? null : null

  const ensureChildren = useCallback(async (dir: string): Promise<void> => {
    const list = await window.deva.fs.readDir(dir)
    setChildrenMap((prev) => ({ ...prev, [dir]: list }))
  }, [])

  // 打开一个项目的公共路径：登记为项目 + 设为活动 + 载入根目录。
  const applyOpen = useCallback(
    async (proj: Project): Promise<void> => {
      setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]))
      setActiveProjectId(proj.id)
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

  const setActiveProject = useCallback(
    (id: string): void => {
      setActiveProjectId(id)
      const proj = projects.find((p) => p.id === id)
      if (proj && !childrenMap[proj.path]) void ensureChildren(proj.path)
    },
    [projects, childrenMap, ensureChildren]
  )

  const closeProject = useCallback((id: string): void => {
    // 关闭即移出「已打开」集合。
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== id)
      setActiveProjectId((cur) => (cur === id ? next[0]?.id ?? null : cur))
      return next
    })
    // 一并丢弃该项目的编辑器标签分片（关闭即释放，重开是新的一组）。
    setTabsByProject((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setActivePathByProject((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
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
      // 打开进「当前活动项目」的标签组（文件本就从该项目树点开）；切项目不影响本次归属。
      const pid = activeProjectId
      if (!pid) return
      setTabsByProject((prev) => {
        const list = prev[pid] ?? NO_TABS
        if (list.some((t) => t.path === path)) return prev
        return { ...prev, [pid]: [...list, { path, name: baseName(path) }] }
      })
      setActivePathByProject((prev) => ({ ...prev, [pid]: path }))
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
    [activeProjectId, content, fileState]
  )

  const setActivePath = useCallback(
    (path: string): void => {
      const pid = activeProjectId
      if (!pid) return
      setActivePathByProject((prev) => ({ ...prev, [pid]: path }))
    },
    [activeProjectId]
  )

  const closeTab = useCallback(
    (path: string): void => {
      const pid = activeProjectId
      if (!pid) return
      setTabsByProject((prev) => {
        const list = prev[pid] ?? NO_TABS
        const idx = list.findIndex((t) => t.path === path)
        if (idx === -1) return prev
        const next = list.filter((t) => t.path !== path)
        setActivePathByProject((ap) => {
          if ((ap[pid] ?? null) !== path) return ap
          const fallback = next.length === 0 ? null : (next[idx] ?? next[idx - 1] ?? next[0]).path
          return { ...ap, [pid]: fallback }
        })
        return { ...prev, [pid]: next }
      })
    },
    [activeProjectId]
  )

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
    ]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用')
  return ctx
}
