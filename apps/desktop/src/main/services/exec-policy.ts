/**
 * run_command 的执行 shell 解析（纯函数）。
 *
 * 2026-10-09 起命令执行不设任何限制：原先的命令拆分器与危险命令 deny 名单已整体移除，
 * 本模块只负责决定用哪个 shell 执行。
 */
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { detectShells } from './shells'

/**
 * 在 PATH 上找到 git.exe，据 Git for Windows 的固定布局推导同装的 bash.exe。
 * 覆盖 shells.ts 硬编码候选路径（`%ProgramFiles%\Git\bin\bash.exe` 等）漏掉的场景：
 * 非 C: 盘安装、绿色版、自定义目录——只要 git 在 PATH 上即可（几乎总是）。
 * 只从「真实 git 安装目录」旁推导，故不会误取 System32\bash.exe（那是 WSL）。
 */
function findGitBashOnPath(): string | null {
  const pathEnv = process.env.PATH || process.env.Path || ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const gitPath = join(dir, 'git.exe')
    if (!existsSync(gitPath)) continue
    const gitDir = dirname(gitPath) // 常见 <root>\cmd、<root>\bin、<root>\mingw64\bin
    const cands = [
      join(gitDir, 'bash.exe'), // git 与 bash 同在 bin/
      join(gitDir, '..', 'bin', 'bash.exe'), // git 在 cmd/、bash 在 bin/（最常见）
      join(gitDir, '..', '..', 'bin', 'bash.exe') // git 在 mingw64/bin/
    ]
    for (const c of cands) if (existsSync(c)) return c
  }
  return null
}

/** run_command 的执行 shell。与交互式终端（shells.ts 的 --login -i / WSL / pwsh）刻意分开：
 *  交互 flag 会挂起一次性执行、且操作符语义可能变味。 */
export interface ExecShell {
  file: string
  args: string[]
  /** true = 交给 Node `shell:true`（win→ComSpec /d /s /c，posix→/bin/sh -c）。 */
  useShell: boolean
}

let execShellCache: ExecShell | null = null

/**
 * 解析执行 shell：**优先 Git Bash**（用户选定，命令统一写 POSIX）。
 * - win：探到 Git Bash → `bash -l -c`（--login 拿全 PATH，去掉交互 -i 防挂起）；否则回落 cmd（shell:true）。
 * - posix：有 /bin/bash → `bash -c`；否则回落 /bin/sh -c（shell:true）。
 */
export function resolveExecShell(): ExecShell {
  if (execShellCache) return execShellCache
  const shells = detectShells()
  if (process.platform === 'win32') {
    // 先用共享探测（标准 C: 盘安装），再回落到 PATH 推导（非标准安装），都没有才用 cmd。
    const gitBash = shells.find((s) => s.id === 'git-bash')
    const bashPath = gitBash?.path || findGitBashOnPath()
    execShellCache = bashPath
      ? { file: bashPath, args: ['-l', '-c'], useShell: false }
      : { file: '', args: [], useShell: true }
  } else {
    const bash = shells.find((s) => s.path === '/bin/bash') || shells.find((s) => s.id === 'bash')
    execShellCache = bash
      ? { file: bash.path, args: ['-c'], useShell: false }
      : { file: '', args: [], useShell: true }
  }
  return execShellCache
}
