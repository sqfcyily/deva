import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { ipcMain } from 'electron'
import { assertInside } from './fs-guard'
import { getConfig, getDevaHome } from './config'
import { detectShells } from './shells'

/**
 * Git 源代码管理服务（主进程）。
 *
 * 技术路线（对标 VS Code）：**调用系统已装的 git 命令行**，凭据/身份全部交给系统
 * git + 系统凭据管理器（Windows 的 Git Credential Manager）。因此 Deva 本身
 * **零凭据存储、零 PAT UI**——push/pull 直接复用系统已存的登录态。
 *
 * 安全要点：
 * - 全程 `execFile(gitPath, [argv], {cwd})`：**无 shell、无字符串拼接** → 杜绝命令注入；
 *   用户可控串（提交信息/分支名/URL/路径）一律作独立 argv，涉及路径处用 `--` 分隔。
 * - 仓库操作先 `assertInside(dir)`（仓库根即受信根）；逐个文件路径再 `assertInside`。
 * - `GIT_TERMINAL_PROMPT=0`：无 TTY 时**不在 stdin 挂起**；GCM 的 GUI 弹窗仍照常完成授权。
 * - 与 Agent 的 `run_command` 明确分离：本功能是第一方、用户点击触发的固定命令，
 *   **不走** exec-policy 拆分/deny 闸门，也**不走** Agent 权限门；破坏性操作走 UI 确认。
 *
 * 对「免装 git 铁律」的取舍（已与用户确认）：源代码管理功能依赖系统装了 git；没装则该功能
 * 不可用（与 VS Code 一致，UI 显示「未检测到 git」）。其余功能不受影响。
 */

// ── 导出类型（供 preload/renderer 复用；沿用 GitDiffView 现有渲染形状） ──────────────

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

/** 远程/提交/切换失败的结构化原因，渲染层据此给对应提示。 */
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

// ── git 二进制定位 ───────────────────────────────────────────────────────────

const GIT_EXE = process.platform === 'win32' ? 'git.exe' : 'git'
let gitPathCache: string | null | undefined // undefined=未探测, null=探测过但无

/** 读配置里的 git.path 覆盖（对标 VS Code 的 `git.path` 设置）。兼容 {git:{path}} 与扁平 gitPath。 */
function readGitPathOverride(): string | null {
  const cfg = getConfig()
  const g = cfg.git
  if (g && typeof g === 'object') {
    const p = (g as Record<string, unknown>).path
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  const flat = cfg.gitPath
  if (typeof flat === 'string' && flat.trim()) return flat.trim()
  return null
}

/** 在 PATH 上找到 git 可执行文件（镜像 exec-policy.findGitBashOnPath 的 PATH 遍历）。 */
function findGitOnPath(): string | null {
  const pathEnv = process.env.PATH || process.env.Path || ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const p = join(dir, GIT_EXE)
    if (existsSync(p)) return p
  }
  return null
}

/** 从 Git Bash 检测反推同装的 git.exe（覆盖 git 不在 PATH 但装了 Git for Windows 的场景）。 */
function findGitFromBash(): string | null {
  const gitBash = detectShells().find((s) => s.id === 'git-bash')
  if (!gitBash?.path) return null
  const binDir = dirname(gitBash.path) // <root>/bin
  const root = dirname(binDir) // <root>
  const cands = [
    join(root, 'cmd', 'git.exe'),
    join(root, 'bin', 'git.exe'),
    join(root, 'mingw64', 'bin', 'git.exe')
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** 解析 git 路径（模块级缓存）：① 配置覆盖 → ② PATH → ③ Git Bash 反推 → null。 */
function resolveGitPath(): string | null {
  if (gitPathCache !== undefined) return gitPathCache
  const override = readGitPathOverride()
  if (override && existsSync(override)) return (gitPathCache = override)
  const onPath = findGitOnPath()
  if (onPath) return (gitPathCache = onPath)
  const fromBash = findGitFromBash()
  if (fromBash) return (gitPathCache = fromBash)
  return (gitPathCache = null)
}

// ── 统一执行器 ───────────────────────────────────────────────────────────────

const MAX_BUFFER = 32 * 1024 * 1024 // 32MB：大仓 status/diff 兜底
const DEFAULT_TIMEOUT = 30_000
const REMOTE_TIMEOUT = 120_000
const MAX_FILE_BYTES = 2 * 1024 * 1024 // 未跟踪文件读全文的上限（对齐 workspace）

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 底层执行（不做 assertInside）：供 `git --version` 等无仓库根上下文的命令用。
 * 用户可控串一律作独立 argv；env 关掉交互提示与可选锁，锁定英文错误文案便于解析。
 */
function runGitRaw(cwd: string | undefined, args: string[], timeout = DEFAULT_TIMEOUT): Promise<RunResult> {
  const git = resolveGitPath()
  if (!git) return Promise.resolve({ code: -1, stdout: '', stderr: 'git-not-found' })
  return new Promise((res) => {
    execFile(
      git,
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        maxBuffer: MAX_BUFFER,
        timeout,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        // execFile 回调：非零退出时 err 携带 .code（数字退出码），stdout/stderr 仍有值。
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null
        let code = 0
        if (e) code = typeof e.code === 'number' ? e.code : e.killed ? 124 : 1
        res({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** 仓库操作执行器：首行 `assertInside(dir)`，随后交给 runGitRaw。 */
function runGit(dir: string, args: string[], timeout = DEFAULT_TIMEOUT): Promise<RunResult> {
  assertInside(dir)
  return runGitRaw(dir, args, timeout)
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

function emptyStatus(root: string): GitStatus {
  return {
    isRepo: false,
    root,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    remotes: [],
    staged: [],
    unstaged: [],
    conflicts: []
  }
}

/** git 状态字符 → 展示字母。 */
function letterFor(c: string): GitStatusLetter {
  switch (c) {
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'C':
      return 'C'
    case 'T':
      return 'T'
    default:
      return 'M'
  }
}

function mkFile(
  root: string,
  rel: string,
  letter: GitStatusLetter,
  flags: { staged: boolean; unstaged: boolean; conflicted: boolean; untracked: boolean }
): GitFileStatus {
  const norm = rel.replace(/\\/g, '/')
  const abs = resolve(root, norm)
  const d = dirname(norm)
  return {
    path: abs,
    rel: norm,
    name: basename(norm),
    dir: d === '.' ? '' : d,
    letter,
    ...flags
  }
}

/**
 * 解析 `git status --porcelain=v2 --branch -z` 输出。
 * `-z` 用 NUL 分隔，稳过含空格/中文/特殊字符的路径；重命名（`2`）额外占一个 NUL 段（origPath）。
 */
function parsePorcelainV2(
  stdout: string,
  root: string
): Omit<GitStatus, 'isRepo' | 'root' | 'remotes'> {
  const tokens = stdout.split('\0')
  let branch: string | null = null
  let detached = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const staged: GitFileStatus[] = []
  const unstaged: GitFileStatus[] = []
  const conflicts: GitFileStatus[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    // 表头
    if (t.startsWith('# ')) {
      if (t.startsWith('# branch.head ')) {
        const name = t.slice('# branch.head '.length)
        if (name === '(detached)') detached = true
        else branch = name
      } else if (t.startsWith('# branch.upstream ')) {
        upstream = t.slice('# branch.upstream '.length)
      } else if (t.startsWith('# branch.ab ')) {
        const m = /\+(\d+)\s+-(\d+)/.exec(t)
        if (m) {
          ahead = parseInt(m[1], 10)
          behind = parseInt(m[2], 10)
        }
      }
      continue
    }
    // 普通改动：1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    if (t.startsWith('1 ')) {
      const f = t.split(' ')
      const xy = f[1]
      const rel = f.slice(8).join(' ')
      pushXY(root, rel, xy, staged, unstaged)
      continue
    }
    // 重命名/复制：2 <XY> ... <X><score> <path>，下一个 NUL 段是 origPath
    if (t.startsWith('2 ')) {
      const f = t.split(' ')
      const xy = f[1]
      const rel = f.slice(9).join(' ')
      i++ // 消费 origPath（v1 不展示原名，仅跳过）
      pushXY(root, rel, xy, staged, unstaged)
      continue
    }
    // 冲突（未合并）：u <xy> ... <path>
    if (t.startsWith('u ')) {
      const f = t.split(' ')
      const rel = f.slice(10).join(' ')
      conflicts.push(
        mkFile(root, rel, 'U', { staged: false, unstaged: true, conflicted: true, untracked: false })
      )
      continue
    }
    // 未跟踪：? <path>
    if (t.startsWith('? ')) {
      const rel = t.slice(2)
      unstaged.push(
        mkFile(root, rel, 'U', { staged: false, unstaged: true, conflicted: false, untracked: true })
      )
      continue
    }
    // 忽略（! <path>）等：跳过
  }

  return { branch, detached, upstream, ahead, behind, staged, unstaged, conflicts }
}

/** 据 XY（X=暂存态、Y=工作区态）把一个文件分派进 staged / unstaged（可同时进两边）。 */
function pushXY(
  root: string,
  rel: string,
  xy: string,
  staged: GitFileStatus[],
  unstaged: GitFileStatus[]
): void {
  const x = xy[0]
  const y = xy[1]
  if (x && x !== '.') {
    staged.push(
      mkFile(root, rel, letterFor(x), {
        staged: true,
        unstaged: false,
        conflicted: false,
        untracked: false
      })
    )
  }
  if (y && y !== '.') {
    unstaged.push(
      mkFile(root, rel, letterFor(y), {
        staged: false,
        unstaged: true,
        conflicted: false,
        untracked: false
      })
    )
  }
}

/** 解析统一 diff 文本 → GitDiffLine[]（保留 hunk 头，按 +/-/空格推进行号游标）。 */
function parseUnifiedDiff(text: string): GitDiffLine[] {
  const out: GitDiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const raw of text.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
        inHunk = true
        out.push({ type: 'hunk', text: raw })
      }
      continue
    }
    if (raw.startsWith('Binary files')) {
      out.push({ type: 'hunk', text: raw })
      continue
    }
    if (!inHunk) continue // 跳过 diff --git / index / ---,+++ 等文件头
    const sign = raw[0]
    if (sign === '+') {
      out.push({ type: 'add', newNo, text: raw.slice(1) })
      newNo++
    } else if (sign === '-') {
      out.push({ type: 'del', oldNo, text: raw.slice(1) })
      oldNo++
    } else if (sign === ' ') {
      out.push({ type: 'ctx', oldNo, newNo, text: raw.slice(1) })
      oldNo++
      newNo++
    }
    // '\'（\ No newline at end of file）与空行：忽略
  }
  return out
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 未跟踪文件：git 无 diff → 直接读全文件，逐行当作新增。 */
async function diffUntracked(absPath: string): Promise<GitDiffLine[]> {
  let stat: import('fs').Stats
  try {
    stat = await fs.stat(absPath)
  } catch {
    return []
  }
  if (stat.size > MAX_FILE_BYTES) return [{ type: 'hunk', text: '(文件过大，未显示)' }]
  const buf = await fs.readFile(absPath)
  if (looksBinary(buf)) return [{ type: 'hunk', text: '(二进制文件)' }]
  const lines = buf.toString('utf8').split('\n')
  // 末行为空（文件以换行结尾）时去掉，避免多一条空新增
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const out: GitDiffLine[] = [{ type: 'hunk', text: `@@ -0,0 +1,${lines.length} @@` }]
  lines.forEach((text, i) => out.push({ type: 'add', newNo: i + 1, text }))
  return out
}

// ── 错误归类 ─────────────────────────────────────────────────────────────────

function classifyRemoteError(stderr: string): GitFailReason {
  const s = stderr
  if (/Authentication failed|could not read Username|Permission denied|Invalid username or password|terminal prompts disabled|403 Forbidden|401 Unauthorized|access denied/i.test(s))
    return 'auth'
  if (/Could not resolve host|unable to access|Failed to connect|Connection (?:timed out|refused)|network is unreachable|timed out/i.test(s))
    return 'network'
  if (/\[rejected\]|non-fast-forward|failed to push|fetch first|tip of your current branch is behind/i.test(s))
    return 'rejected'
  if (/CONFLICT|Automatic merge failed|needs merge|would be overwritten by merge/i.test(s))
    return 'conflict'
  if (/have unstaged changes|commit your changes or stash|Your local changes|would be overwritten/i.test(s))
    return 'dirty'
  return 'error'
}

function classifyCommitError(stderr: string): GitFailReason {
  if (/Please tell me who you are|unable to auto-detect email|empty ident|user\.name|user\.email/i.test(stderr))
    return 'identity-needed'
  if (/nothing to commit|no changes added/i.test(stderr)) return 'empty'
  return 'error'
}

/** 把渲染层传来的路径数组归一为绝对路径并逐个 assertInside（越界即抛）。 */
function safeAbsPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const abs = resolve(p)
    assertInside(abs)
    out.push(abs)
  }
  return out
}

// ── IPC 注册 ─────────────────────────────────────────────────────────────────

export function registerGitIpc(): void {
  // git 是否可用（定位成功 + --version 跑通）
  ipcMain.handle('git:available', async () => {
    const git = resolveGitPath()
    if (!git) return { available: false as const }
    const res = await runGitRaw(undefined, ['--version'])
    if (res.code !== 0) return { available: false as const }
    return {
      available: true as const,
      version: res.stdout.trim().replace(/^git version\s*/i, ''),
      path: git
    }
  })

  // 核心：完整状态（分支 / upstream / ahead-behind / 分组文件）
  ipcMain.handle('git:status', async (_e, dir: string): Promise<GitStatus> => {
    assertInside(dir)
    const st = await runGitRaw(dir, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z'
    ])
    if (st.code !== 0) return emptyStatus(dir) // 非仓库 / 无 git
    const top = await runGitRaw(dir, ['rev-parse', '--show-toplevel'])
    const root = top.code === 0 && top.stdout.trim() ? resolve(top.stdout.trim()) : resolve(dir)
    const parsed = parsePorcelainV2(st.stdout, root)
    // 只保留落在受信根内的文件（常见情形 root===项目根，无过滤；子目录场景下过滤根外文件）
    const inside = (f: GitFileStatus): boolean => {
      try {
        assertInside(f.path)
        return true
      } catch {
        return false
      }
    }
    const rem = await runGitRaw(dir, ['remote'])
    const remotes = rem.code === 0 ? rem.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
    return {
      isRepo: true,
      root,
      branch: parsed.branch,
      detached: parsed.detached,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      remotes,
      staged: parsed.staged.filter(inside),
      unstaged: parsed.unstaged.filter(inside),
      conflicts: parsed.conflicts.filter(inside)
    }
  })

  // 文件级 diff：staged→index↔HEAD；unstaged→worktree↔index；未跟踪→读全文件当新增
  ipcMain.handle(
    'git:diff',
    async (
      _e,
      dir: string,
      filePath: string,
      opts: { staged?: boolean; untracked?: boolean } = {}
    ): Promise<GitDiffLine[]> => {
      assertInside(dir)
      const abs = resolve(filePath)
      assertInside(abs)
      if (opts.untracked) return diffUntracked(abs)
      const args = ['diff', '--no-color', '--no-ext-diff']
      if (opts.staged) args.push('--cached')
      args.push('--', abs)
      const res = await runGitRaw(dir, args)
      if (res.code !== 0) return []
      return parseUnifiedDiff(res.stdout)
    }
  )

  // 暂存（改/加/删都由 add 记录）
  ipcMain.handle('git:stage', async (_e, dir: string, paths: string[]) => {
    assertInside(dir)
    const abs = safeAbsPaths(paths)
    if (!abs.length) return { ok: false as const, message: 'no paths' }
    const res = await runGit(dir, ['add', '--', ...abs])
    return res.code === 0 ? { ok: true as const } : { ok: false as const, message: res.stderr.trim() }
  })

  // 取消暂存：有 HEAD → reset；首提交前无 HEAD → rm --cached
  ipcMain.handle('git:unstage', async (_e, dir: string, paths: string[]) => {
    assertInside(dir)
    const abs = safeAbsPaths(paths)
    if (!abs.length) return { ok: false as const, message: 'no paths' }
    const head = await runGit(dir, ['rev-parse', '--verify', 'HEAD'])
    const res =
      head.code === 0
        ? await runGit(dir, ['reset', '-q', 'HEAD', '--', ...abs])
        : await runGit(dir, ['rm', '--cached', '-q', '--', ...abs])
    return res.code === 0 ? { ok: true as const } : { ok: false as const, message: res.stderr.trim() }
  })

  // 丢弃（破坏性，UI 先确认）：已跟踪 → checkout HEAD 还原；未跟踪 → 删文件
  ipcMain.handle(
    'git:discard',
    async (_e, dir: string, trackedPaths: string[], untrackedPaths: string[]) => {
      assertInside(dir)
      const tracked = safeAbsPaths(trackedPaths)
      const untracked = safeAbsPaths(untrackedPaths)
      if (tracked.length) await runGit(dir, ['checkout', 'HEAD', '--', ...tracked])
      for (const p of untracked) {
        await fs.rm(p, { force: true }).catch(() => {})
      }
      return { ok: true as const }
    }
  )

  // 提交：信息写临时文件（DEVA_HOME 下）避免多行/特殊字符问题；身份缺失回 identity-needed
  ipcMain.handle('git:commit', async (_e, dir: string, message: string) => {
    assertInside(dir)
    if (typeof message !== 'string' || !message.trim())
      return { ok: false as const, reason: 'empty' as GitFailReason }
    const tmp = join(getDevaHome(), `commit-msg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    try {
      await fs.writeFile(tmp, message, 'utf8')
      const res = await runGit(dir, ['commit', '-F', tmp])
      if (res.code === 0) return { ok: true as const }
      return { ok: false as const, reason: classifyCommitError(res.stderr), message: res.stderr.trim() }
    } finally {
      fs.unlink(tmp).catch(() => {})
    }
  })

  // 设置身份（identity-needed 后 UI 填写回写；global 决定 --global / --local）
  ipcMain.handle(
    'git:set-config',
    async (_e, dir: string, name: string, email: string, global: boolean) => {
      assertInside(dir)
      const scope = global ? '--global' : '--local'
      if (typeof name === 'string' && name.trim())
        await runGit(dir, ['config', scope, 'user.name', name.trim()])
      if (typeof email === 'string' && email.trim())
        await runGit(dir, ['config', scope, 'user.email', email.trim()])
      return { ok: true as const }
    }
  )

  // 分支清单
  ipcMain.handle('git:branches', async (_e, dir: string): Promise<GitBranch[]> => {
    assertInside(dir)
    const res = await runGit(dir, ['branch', '--format=%(refname:short)%00%(HEAD)'])
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, head] = l.split('\0')
        return { name, current: head === '*' }
      })
  })

  // 切换分支
  ipcMain.handle('git:checkout', async (_e, dir: string, ref: string) => {
    assertInside(dir)
    if (typeof ref !== 'string' || !ref) return { ok: false as const, reason: 'error' as GitFailReason }
    const res = await runGit(dir, ['checkout', ref])
    if (res.code === 0) return { ok: true as const }
    const reason: GitFailReason = /local changes|would be overwritten/i.test(res.stderr) ? 'dirty' : 'error'
    return { ok: false as const, reason, message: res.stderr.trim() }
  })

  // 新建分支（checkout 决定是否切过去）
  ipcMain.handle('git:create-branch', async (_e, dir: string, name: string, checkout: boolean) => {
    assertInside(dir)
    if (typeof name !== 'string' || !name.trim())
      return { ok: false as const, message: 'empty name' }
    const args = checkout ? ['checkout', '-b', name.trim()] : ['branch', name.trim()]
    const res = await runGit(dir, args)
    return res.code === 0 ? { ok: true as const } : { ok: false as const, message: res.stderr.trim() }
  })

  // 提交历史
  ipcMain.handle('git:log', async (_e, dir: string, depth = 30): Promise<GitCommit[]> => {
    assertInside(dir)
    const fmt = ['%H', '%h', '%an', '%ae', '%at', '%s'].join('%x00')
    const res = await runGit(dir, ['log', `--format=${fmt}`, '-n', String(Math.max(1, Math.min(500, depth)))])
    if (res.code !== 0) return []
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [oid, short, author, email, at, subject] = line.split('\0')
        return { oid, short, author, email, timestamp: parseInt(at, 10) * 1000, subject: subject ?? '' }
      })
  })

  // 初始化仓库
  ipcMain.handle('git:init', async (_e, dir: string) => {
    assertInside(dir)
    const res = await runGit(dir, ['init'])
    return res.code === 0 ? { ok: true as const } : { ok: false as const, message: res.stderr.trim() }
  })

  // 远程：获取（凭据全交系统 git/GCM；GIT_TERMINAL_PROMPT=0 防挂起）
  ipcMain.handle('git:fetch', async (_e, dir: string) => {
    assertInside(dir)
    const res = await runGit(dir, ['fetch', '--prune'], REMOTE_TIMEOUT)
    return res.code === 0
      ? { ok: true as const }
      : { ok: false as const, reason: classifyRemoteError(res.stderr), message: res.stderr.trim() }
  })

  // 远程：拉取
  ipcMain.handle('git:pull', async (_e, dir: string) => {
    assertInside(dir)
    const res = await runGit(dir, ['pull'], REMOTE_TIMEOUT)
    return res.code === 0
      ? { ok: true as const }
      : { ok: false as const, reason: classifyRemoteError(res.stderr), message: res.stderr.trim() }
  })

  // 远程：推送（无 upstream 时首推 -u origin <branch>）
  ipcMain.handle('git:push', async (_e, dir: string, setUpstreamBranch: string | null) => {
    assertInside(dir)
    const args =
      typeof setUpstreamBranch === 'string' && setUpstreamBranch
        ? ['push', '-u', 'origin', setUpstreamBranch]
        : ['push']
    const res = await runGit(dir, args, REMOTE_TIMEOUT)
    return res.code === 0
      ? { ok: true as const }
      : { ok: false as const, reason: classifyRemoteError(res.stderr), message: res.stderr.trim() }
  })
}
