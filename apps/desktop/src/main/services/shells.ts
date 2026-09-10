/**
 * Shell 配置探测（主进程侧）。
 *
 * 职责：枚举本机已安装、可用于集成终端的 shell（类 VSCode 终端配置）。只用
 * `node:fs` 与 `process.env` 做存在性判断——零配置、零依赖、不碰 node-pty，
 * 因此放在主进程而非 Utility Process。结果模块级缓存（探测一次即可）。
 *
 * 安全：`path`/`args` 只在主进程内使用；对渲染层仅暴露 id/label/isDefault
 * （见 services/terminal.ts 的 terminal:list-shells）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 一个可选 shell 配置。path/args 为主进程内部字段，不外泄渲染层。 */
export interface ShellProfile {
  id: string
  label: string
  path: string
  args: string[]
  isDefault?: boolean
}

let cache: ShellProfile[] | null = null

/** 收集首个存在的候选路径。 */
function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

/** Windows 下的候选 shell（按展示顺序；默认项另行标记）。 */
function detectWindows(): ShellProfile[] {
  const list: ShellProfile[] = []
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA

  // Windows PowerShell 5.1：随系统预装，作默认。
  const winPs = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(winPs)) {
    list.push({ id: 'windows-powershell', label: 'Windows PowerShell', path: winPs, args: [], isDefault: true })
  }

  // 命令提示符 cmd.exe：随系统预装。
  const cmd = process.env.ComSpec || join(sysRoot, 'System32', 'cmd.exe')
  if (existsSync(cmd)) {
    list.push({ id: 'cmd', label: 'Command Prompt', path: cmd, args: [] })
  }

  // PowerShell 7（pwsh）：装了才有。
  const pwsh = firstExisting([
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(programFilesX86, 'PowerShell', '7', 'pwsh.exe')
  ])
  if (pwsh) list.push({ id: 'pwsh', label: 'PowerShell', path: pwsh, args: [] })

  // Git Bash：装了 Git for Windows 才有。--login -i 加载 profile，把 git 等工具带进 PATH。
  const gitBash = firstExisting([
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : undefined
  ])
  if (gitBash) list.push({ id: 'git-bash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'] })

  // WSL：装了才有（仅探测入口，不枚举发行版）。
  const wsl = join(sysRoot, 'System32', 'wsl.exe')
  if (existsSync(wsl)) list.push({ id: 'wsl', label: 'WSL', path: wsl, args: [] })

  // 极端兜底：一个都没探到（几乎不可能）。
  if (list.length === 0) {
    list.push({ id: 'cmd', label: 'Command Prompt', path: 'cmd.exe', args: [], isDefault: true })
  }
  return list
}

/** 非 Windows：优先 $SHELL，再补常见候选；默认项为登录 shell。 */
function detectPosix(): ShellProfile[] {
  const list: ShellProfile[] = []
  const seen = new Set<string>()
  const add = (id: string, label: string, path: string, isDefault?: boolean): void => {
    if (seen.has(path) || !existsSync(path)) return
    seen.add(path)
    list.push({ id, label, path, args: [], isDefault })
  }

  const loginShell = process.env.SHELL
  if (loginShell) add('default', 'Default (' + loginShell.split('/').pop() + ')', loginShell, true)

  add('bash', 'bash', '/bin/bash', list.length === 0)
  add('zsh', 'zsh', '/bin/zsh')
  add('zsh-usr', 'zsh', '/usr/bin/zsh')
  add('fish', 'fish', '/usr/bin/fish')
  add('sh', 'sh', '/bin/sh')

  if (list.length === 0) list.push({ id: 'sh', label: 'sh', path: '/bin/sh', args: [], isDefault: true })
  return list
}

/** 探测本机可用 shell（缓存）。 */
export function detectShells(): ShellProfile[] {
  if (cache) return cache
  cache = process.platform === 'win32' ? detectWindows() : detectPosix()
  return cache
}

/** 兜底默认可执行：Windows→PowerShell，其余→$SHELL/bin/bash。 */
function fallbackShell(): { path: string; args: string[] } {
  if (process.platform === 'win32') return { path: 'powershell.exe', args: [] }
  return { path: process.env.SHELL || '/bin/bash', args: [] }
}

/** 把渲染层传来的 shellId 解析为 {path,args}；命不中取默认 profile，再兜底。 */
export function resolveShell(id: string | null): { path: string; args: string[] } {
  const shells = detectShells()
  const hit = (id && shells.find((s) => s.id === id)) || shells.find((s) => s.isDefault) || shells[0]
  if (hit && existsSync(hit.path)) return { path: hit.path, args: hit.args }
  return fallbackShell()
}
