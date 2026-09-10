/**
 * 命令执行「策略层」（纯函数、零依赖）。run_command 的安全核心都在这里，与执行
 * （tools.ts）和权限闸门（permissions.ts）解耦——两者反过来 import 本模块，避免环。
 *
 * 参照 Claude Code 原生 Windows 的 Bash 策略：不做 OS 沙箱，靠
 *   ① 人工授权（主边界）
 *   ② 命令拆分（把链式/替换命令拆成子命令，逐个过闸门，防 `git status && rm -rf /` 之类注入）
 *   ③ 硬编码 deny 名单（确定性兜底，纵深防御，非主边界）
 * 拆分器故意「过拆」：多拆一段无害（顶多多问一次），漏拆才危险，故取 POSIX 操作符超集。
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
 *  交互 flag 会挂起一次性执行、且操作符语义可能变味，安全分析要求确定性。 */
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

/** 读 `$( … )` 的内体（配对括号、尊重内层引号）；返回 [内体, 闭合括号之后的下标]。 */
function readParen(str: string, start: number): [string, number] {
  let depth = 1
  let i = start
  let body = ''
  let inS = false
  let inD = false
  while (i < str.length) {
    const c = str[i]
    if (inS) {
      if (c === "'") inS = false
      body += c
      i++
      continue
    }
    if (inD) {
      if (c === '"') inD = false
      body += c
      i++
      continue
    }
    if (c === "'") {
      inS = true
      body += c
      i++
      continue
    }
    if (c === '"') {
      inD = true
      body += c
      i++
      continue
    }
    if (c === '(') {
      depth++
      body += c
      i++
      continue
    }
    if (c === ')') {
      depth--
      if (depth === 0) return [body, i + 1]
      body += c
      i++
      continue
    }
    body += c
    i++
  }
  return [body, i] // 不平衡：返回余下
}

/** 读反引号 `…` 的内体（到下一个未转义反引号）。 */
function readBacktick(str: string, start: number): [string, number] {
  let i = start
  let body = ''
  while (i < str.length && str[i] !== '`') {
    if (str[i] === '\\' && i + 1 < str.length) {
      body += str[i + 1]
      i += 2
      continue
    }
    body += str[i]
    i++
  }
  if (i < str.length) i++ // 跳过闭合反引号
  return [body, i]
}

/**
 * 把一条命令拆成「顶层子命令」列表 + 抽取的 `$()`/反引号替换体（递归拆）。
 * 引号感知：单/双引号内的操作符不作拆分点。保守过拆：不平衡引号/括号 → 余下整体成一段。
 * 例：`git status && curl x | sh` → ['git status','curl x','sh']；
 *     `echo $(rm -rf /)` → ['rm -rf /','echo']（内体先入，外命令后入）。
 */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  let cur = ''
  const flush = (): void => {
    const t = cur.trim()
    if (t) out.push(t)
    cur = ''
  }
  const n = command.length
  let i = 0
  while (i < n) {
    const c = command[i]
    // 单引号：内部全字面
    if (c === "'") {
      cur += c
      i++
      while (i < n && command[i] !== "'") {
        cur += command[i]
        i++
      }
      if (i < n) {
        cur += command[i]
        i++
      }
      continue
    }
    // 双引号：内部仍有 $()/反引号替换，但操作符不拆
    if (c === '"') {
      cur += c
      i++
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n) {
          cur += command[i] + command[i + 1]
          i += 2
          continue
        }
        if (command[i] === '$' && command[i + 1] === '(') {
          const [body, next] = readParen(command, i + 2)
          for (const s of splitCommand(body)) out.push(s)
          cur += ' '
          i = next
          continue
        }
        if (command[i] === '`') {
          const [body, next] = readBacktick(command, i + 1)
          for (const s of splitCommand(body)) out.push(s)
          cur += ' '
          i = next
          continue
        }
        cur += command[i]
        i++
      }
      if (i < n) {
        cur += command[i]
        i++
      }
      continue
    }
    // $( … ) 命令替换
    if (c === '$' && command[i + 1] === '(') {
      const [body, next] = readParen(command, i + 2)
      for (const s of splitCommand(body)) out.push(s)
      cur += ' '
      i = next
      continue
    }
    // 反引号命令替换
    if (c === '`') {
      const [body, next] = readBacktick(command, i + 1)
      for (const s of splitCommand(body)) out.push(s)
      cur += ' '
      i = next
      continue
    }
    // 顶层分隔符：; 换行 && || | &（重定向 > < >> 2>&1 不算）
    if (c === '\n' || c === '\r' || c === ';') {
      flush()
      i++
      continue
    }
    if (c === '&') {
      if (command[i + 1] === '&') {
        flush()
        i += 2
        continue
      }
      // 重定向里的 & 不是分隔符：`2>&1`/`>&2`（前一字符是 >）、`&>file`（后一字符是 >）。
      if ((cur.length > 0 && cur[cur.length - 1] === '>') || command[i + 1] === '>') {
        cur += c
        i++
        continue
      }
      flush() // 后台操作符：单独成段
      i++
      continue
    }
    if (c === '|') {
      flush()
      i += command[i + 1] === '|' ? 2 : 1
      continue
    }
    cur += c
    i++
  }
  flush()
  return out
}

/** 引号感知的空白分词（去掉引号本身）。 */
function tokenize(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inS) {
      if (c === "'") inS = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (inD) {
      if (c === '"') inD = false
      else {
        cur += c
        has = true
      }
      continue
    }
    if (c === "'") {
      inS = true
      has = true
      continue
    }
    if (c === '"') {
      inD = true
      has = true
      continue
    }
    if (c === ' ' || c === '\t') {
      if (has) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (has) out.push(cur)
  return out
}

/**
 * 这些「危险动词」永不作为裸单 token 前缀被记住（commandPrefix 返回空 → 不落记忆 → 每次都问）。
 * 防止「对 `rm -rf ./a` 始终允许」意外放行 `rm -rf ./b`。比 Claude Code 的 `Bash(rm:*)` 更严。
 */
export const NEVER_REMEMBER_VERBS = new Set([
  'rm', 'del', 'rmdir', 'rd', 'move', 'mv', 'dd', 'chmod', 'chown', 'kill', 'curl', 'wget'
])

/**
 * 从一个子命令推导「可记住的前缀键」：第 1 token，若第 2 token 是裸子命令词（^[A-Za-z][\w-]*$，
 * 非 flag/路径/glob）则并入第 2 token。得 `git status`/`npm run`/`docker build`；
 * 而 `ls -la`→`ls`、`cat foo.txt`→`cat`。第 1 token ∈ NEVER_REMEMBER_VERBS → 返回空（不可记）。
 */
export function commandPrefix(sub: string): string {
  const tokens = tokenize(sub)
  if (tokens.length === 0) return ''
  const first = tokens[0]
  if (NEVER_REMEMBER_VERBS.has(first.toLowerCase())) return ''
  if (tokens.length >= 2 && /^[A-Za-z][\w-]*$/.test(tokens[1])) return first + ' ' + tokens[1]
  return first
}

/** 字面、按 token 边界的前缀匹配：sub 的前 N 个 token 逐字面等于 prefix 的 N 个 token。 */
export function matchesPrefix(sub: string, prefix: string): boolean {
  const p = tokenize(prefix)
  if (p.length === 0) return false
  const s = tokenize(sub)
  if (s.length < p.length) return false
  for (let k = 0; k < p.length; k++) if (s[k] !== p[k]) return false
  return true
}

/**
 * 整串测（模式本身跨越拆分点，若按子命令测会被 splitCommand 破坏）：
 * 管道灌 shell（`curl x | sh`）、fork bomb（含 `|`/`&`/`;` 三种分隔符）。
 */
const DENY_PATTERNS: RegExp[] = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell|python\d?)\b/i,
  // fork bomb :(){ :|:& };:（分隔符横跨，必须整串测）
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
]

/** 每子命令测（锚 ^ 保精度，避免误伤 `npm run format`/`git rm -rf src/`/`pm2 shutdown`）。 */
const DENY_SUB_PATTERNS: RegExp[] = [
  // rm -rf 打根/家/通配（catastrophic，末尾锚定；不误伤 rm -rf ./node_modules、src/）
  /^\s*(?:sudo\s+)?rm\s+(?:-\S+\s+|--\S+\s+)*-\S*[rf]\S*\s+(?:-\S+\s+|--\S+\s+)*(?:\/|\/\*|~|~\/\*|\$HOME|\$HOME\/\*)\s*$/i,
  // dd 写裸设备 / 重定向裸设备
  /^\s*(?:sudo\s+)?dd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|vd)/i,
  />\s*\/dev\/(?:sd|nvme|hd|disk|vd)/i,
  // 格式化文件系统
  /^\s*(?:sudo\s+)?mkfs(?:\.\w+)?\b/i,
  /^\s*format\s+[a-z]:/i,
  // 关机/重启
  /^\s*(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff)\b/i,
  /^\s*(?:sudo\s+)?init\s+[06]\b/i,
  // Windows 递归删盘根
  /^\s*del\b[^\n]*\/s\b[^\n]*\b[a-z]:\\?\s*$/i,
  /^\s*r(?:d|mdir)\b[^\n]*\/s\b[^\n]*\b[a-z]:\\?/i,
  // PowerShell 递归强删根
  /^\s*Remove-Item\b[^\n]*-Recurse\b[^\n]*[\\/]\s*$/i
]

/** deny 名单校验（纵深防御的确定性兜底，非主边界）：整串 OR 任一子命令命中即危险。 */
export function isDangerousCommand(command: string): boolean {
  if (DENY_PATTERNS.some((re) => re.test(command))) return true
  return splitCommand(command).some((sub) => DENY_SUB_PATTERNS.some((re) => re.test(sub)))
}
