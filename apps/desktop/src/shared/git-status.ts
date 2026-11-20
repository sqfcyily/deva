export type GitStatusLetter = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | 'T'

export interface GitFileStatus {
  /** 绝对路径（渲染层回传给文件级操作，主进程再 assertInside 校验） */
  path: string
  /** 仓库根相对路径（用于灰色路径展示与 diff pathspec） */
  rel: string
  /** 文件名（basename） */
  name: string
  /** 相对目录（rel 的 dirname，顶层为空串） */
  dir: string
  letter: GitStatusLetter
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  /** 未跟踪（新文件，git 尚无 diff → diff 视图直接读全文件当新增） */
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
  /** 合并进行中（存在 MERGE_HEAD）：UI 显示「合并中」并提供「中止合并」 */
  mergeInProgress: boolean
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  conflicts: GitFileStatus[]
}

