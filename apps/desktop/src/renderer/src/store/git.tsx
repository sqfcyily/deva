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
import { useWorkspace } from './workspace'

/**
 * Git 源代码管理状态（真实数据，经 window.deva.git 走主进程调用系统 git）。
 * 仓库根 = 当前活动项目路径（useWorkspace().activeProject.path）。
 * 凭据/身份全交系统 git + 凭据管理器——本 store **不持有任何凭据**。
 *
 * 线缆类型在渲染层复述（对齐 services/git.ts / preload；沿用项目「各层复述线缆类型」惯例）。
 */

export type GitStatusLetter = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | 'T'

export interface GitFileStatus {
  path: string
  rel: string
  name: string
  dir: string
  letter: GitStatusLetter
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  untracked: boolean
}

export interface GitStatus {
  isRepo: boolean
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  remotes: string[]
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  conflicts: GitFileStatus[]
}

export interface GitDiffLine {
  type: 'ctx' | 'add' | 'del' | 'hunk'
  oldNo?: number
  newNo?: number
  text: string
}

export interface GitCommit {
  oid: string
  short: string
  author: string
  email: string
  timestamp: number
  subject: string
}

export interface GitBranch {
  name: string
  current: boolean
}

export type GitFailReason =
  | 'auth'
  | 'network'
  | 'rejected'
  | 'conflict'
  | 'dirty'
  | 'identity-needed'
  | 'empty'
  | 'no-git'
  | 'canceled'
  | 'error'

export interface GitActionResult {
  ok: boolean
  reason?: GitFailReason
  message?: string
  path?: string
  name?: string
}

/** 当前选中的文件 + 它所在的一侧（暂存/未暂存），diff 视图据此取对应侧差异。 */
export interface GitSelection {
  file: GitFileStatus
  staged: boolean
}

interface GitContextValue {
  available: boolean | null // null=探测中
  version: string | null
  hasProject: boolean
  repoDir: string | null
  isRepo: boolean
  status: GitStatus | null
  loading: boolean
  busy: boolean
  error: string | null
  selected: GitSelection | null
  commitMessage: string
  branches: GitBranch[]
  // 动作
  refresh: () => Promise<void>
  select: (file: GitFileStatus, staged: boolean) => void
  clearSelection: () => void
  setCommitMessage: (m: string) => void
  stage: (files: GitFileStatus[]) => Promise<void>
  unstage: (files: GitFileStatus[]) => Promise<void>
  discard: (files: GitFileStatus[]) => Promise<void>
  commit: () => Promise<GitActionResult>
  init: () => Promise<void>
  checkout: (ref: string) => Promise<GitActionResult>
  createBranch: (name: string, checkout: boolean) => Promise<GitActionResult>
  loadBranches: () => Promise<void>
  fetch: () => Promise<GitActionResult>
  pull: () => Promise<GitActionResult>
  push: () => Promise<GitActionResult>
  setIdentity: (name: string, email: string, global: boolean) => Promise<void>
  clone: (url: string) => Promise<GitActionResult>
}

const GitContext = createContext<GitContextValue | null>(null)

export function GitProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { activeProject, openRecent } = useWorkspace()
  const repoDir = activeProject?.path ?? null

  const [available, setAvailable] = useState<boolean | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GitSelection | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [branches, setBranches] = useState<GitBranch[]>([])

  // 供无 state 依赖的稳定回调同步读取（避免 refresh/写操作因闭包拿到旧值或频繁重建）。
  const repoDirRef = useRef(repoDir)
  const availableRef = useRef(available)
  useEffect(() => {
    repoDirRef.current = repoDir
  }, [repoDir])
  useEffect(() => {
    availableRef.current = available
  }, [available])

  // git 是否可用（全局，与项目无关）：定位成功 + --version 跑通。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const a = await window.deva.git.available()
        if (!alive) return
        setAvailable(a.available)
        setVersion(a.available ? a.version : null)
      } catch {
        if (alive) setAvailable(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const dir = repoDirRef.current
    if (availableRef.current === false || !dir) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      const s = await window.deva.git.status(dir)
      if (repoDirRef.current !== dir) return // 期间切换了项目：丢弃陈旧结果
      setStatus(s)
      // 若选中文件已不在对应分组（被暂存/丢弃/提交），清空选中
      setSelected((cur) => {
        if (!cur) return cur
        const pool = cur.file.conflicted ? s.conflicts : cur.staged ? s.staged : s.unstaged
        const still = pool.find((f) => f.path === cur.file.path)
        return still ? { file: still, staged: cur.staged } : null
      })
    } catch {
      /* 忽略：非仓库/瞬时错误由空态兜底 */
    } finally {
      if (repoDirRef.current === dir) setLoading(false)
    }
  }, [])

  // 活动项目变化：重置并刷新。
  useEffect(() => {
    setSelected(null)
    setStatus(null)
    setBranches([])
    setError(null)
    void refresh()
  }, [repoDir, refresh])

  // 窗口重新聚焦：刷新（用户可能在外部改动了工作区/远程）。
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // 写操作统一包装：置忙 → 执行 → 记录错误 → 刷新。
  const runOp = useCallback(
    async (op: (dir: string) => Promise<GitActionResult>): Promise<GitActionResult> => {
      const dir = repoDirRef.current
      if (!dir) return { ok: false, reason: 'error' }
      setBusy(true)
      setError(null)
      try {
        const res = await op(dir)
        if (!res.ok && res.message) setError(res.message)
        await refresh()
        return res
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setError(message)
        return { ok: false, reason: 'error', message }
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const loadBranches = useCallback(async (): Promise<void> => {
    const dir = repoDirRef.current
    if (!dir) return
    try {
      const bs = await window.deva.git.branches(dir)
      if (repoDirRef.current === dir) setBranches(bs)
    } catch {
      /* 忽略 */
    }
  }, [])

  const select = useCallback((file: GitFileStatus, staged: boolean): void => {
    setSelected({ file, staged })
  }, [])
  const clearSelection = useCallback((): void => setSelected(null), [])

  const stage = useCallback(
    async (files: GitFileStatus[]): Promise<void> => {
      await runOp((dir) => window.deva.git.stage(dir, files.map((f) => f.path)))
    },
    [runOp]
  )
  const unstage = useCallback(
    async (files: GitFileStatus[]): Promise<void> => {
      await runOp((dir) => window.deva.git.unstage(dir, files.map((f) => f.path)))
    },
    [runOp]
  )
  const discard = useCallback(
    async (files: GitFileStatus[]): Promise<void> => {
      const tracked = files.filter((f) => !f.untracked).map((f) => f.path)
      const untracked = files.filter((f) => f.untracked).map((f) => f.path)
      await runOp((dir) => window.deva.git.discard(dir, tracked, untracked))
    },
    [runOp]
  )

  const commit = useCallback(async (): Promise<GitActionResult> => {
    const res = await runOp((dir) => window.deva.git.commit(dir, commitMessage))
    if (res.ok) setCommitMessage('')
    return res
  }, [runOp, commitMessage])

  const init = useCallback(async (): Promise<void> => {
    await runOp((dir) => window.deva.git.init(dir))
    await loadBranches()
  }, [runOp, loadBranches])

  const checkout = useCallback(
    async (ref: string): Promise<GitActionResult> => {
      const res = await runOp((dir) => window.deva.git.checkout(dir, ref))
      await loadBranches()
      return res
    },
    [runOp, loadBranches]
  )

  const createBranch = useCallback(
    async (name: string, doCheckout: boolean): Promise<GitActionResult> => {
      const res = await runOp((dir) => window.deva.git.createBranch(dir, name, doCheckout))
      await loadBranches()
      return res
    },
    [runOp, loadBranches]
  )

  const fetch = useCallback((): Promise<GitActionResult> => runOp((dir) => window.deva.git.fetch(dir)), [runOp])
  const pull = useCallback((): Promise<GitActionResult> => runOp((dir) => window.deva.git.pull(dir)), [runOp])

  const push = useCallback((): Promise<GitActionResult> => {
    const branch = status?.branch ?? null
    const needUpstream = status?.upstream === null && !!branch
    return runOp((dir) => window.deva.git.push(dir, needUpstream ? branch : null))
  }, [runOp, status])

  const setIdentity = useCallback(
    async (name: string, email: string, global: boolean): Promise<void> => {
      const dir = repoDirRef.current
      if (!dir) return
      await window.deva.git.setConfig(dir, name, email, global)
    },
    []
  )

  const clone = useCallback(
    async (url: string): Promise<GitActionResult> => {
      setBusy(true)
      setError(null)
      try {
        const res = await window.deva.git.clone(url)
        if (res.ok && res.path) {
          // 克隆已 trustRoot(dest)，经 workspace 打开为活动项目 → repoDir 变化触发刷新。
          await openRecent(res.path)
        } else if (!res.ok && res.message) {
          setError(res.message)
        }
        return res
      } finally {
        setBusy(false)
      }
    },
    [openRecent]
  )

  const value = useMemo<GitContextValue>(
    () => ({
      available,
      version,
      hasProject: repoDir !== null,
      repoDir,
      isRepo: status?.isRepo ?? false,
      status,
      loading,
      busy,
      error,
      selected,
      commitMessage,
      branches,
      refresh,
      select,
      clearSelection,
      setCommitMessage,
      stage,
      unstage,
      discard,
      commit,
      init,
      checkout,
      createBranch,
      loadBranches,
      fetch,
      pull,
      push,
      setIdentity,
      clone
    }),
    [
      available,
      version,
      repoDir,
      status,
      loading,
      busy,
      error,
      selected,
      commitMessage,
      branches,
      refresh,
      select,
      clearSelection,
      stage,
      unstage,
      discard,
      commit,
      init,
      checkout,
      createBranch,
      loadBranches,
      fetch,
      pull,
      push,
      setIdentity,
      clone
    ]
  )

  return <GitContext.Provider value={value}>{children}</GitContext.Provider>
}

export function useGit(): GitContextValue {
  const ctx = useContext(GitContext)
  if (!ctx) throw new Error('useGit 必须在 GitProvider 内使用')
  return ctx
}
