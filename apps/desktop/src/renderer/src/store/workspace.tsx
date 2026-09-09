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

  const ensureChildren = useCallback(
    async (dir: string): Promise<void> => {
      const list = await window.deva.fs.readDir(dir)
      setChildrenMap((prev) => ({ ...prev, [dir]: list }))
    },
    []
  )

  const openFolder = useCallback(async (): Promise<void> => {
    const res = await window.deva.fs.openFolder()
    if (!res) return
    const proj: Project = { id: res.path, name: res.name, path: res.path }
    setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]))
    setActiveProjectId(proj.id)
    if (!childrenMap[proj.path]) await ensureChildren(proj.path)
    setExpanded((e) => ({ ...e, [proj.path]: true }))
  }, [childrenMap, ensureChildren])

  const setActiveProject = useCallback(
    (id: string): void => {
      setActiveProjectId(id)
      const proj = projects.find((p) => p.id === id)
      if (proj && !childrenMap[proj.path]) void ensureChildren(proj.path)
    },
    [projects, childrenMap, ensureChildren]
  )

  const closeProject = useCallback(
    (id: string): void => {
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== id)
        setActiveProjectId((cur) => (cur === id ? next[0]?.id ?? null : cur))
        return next
      })
    },
    []
  )

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
      setTabs((prev) => (prev.some((t) => t.path === path) ? prev : [...prev, { path, name: baseName(path) }]))
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

  const closeTab = useCallback(
    (path: string): void => {
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
    },
    []
  )

  const editContent = useCallback((path: string, text: string): void => {
    setContent((c) => ({ ...c, [path]: text }))
  }, [])

  const isDirty = useCallback(
    (path: string): boolean =>
      fileState[path] === 'ok' && content[path] !== savedContent[path],
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
