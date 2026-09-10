import { realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'

/**
 * 受信根守卫（主进程共享）。
 * 「已打开的项目根目录」是被允许读写的区域——无论是 fs IPC 还是 Agent 的文件工具，
 * 都必须先经此校验，杜绝路径穿越。会话中可经用户显式授权临时新增受信根（见 chat.ts 的
 * 「项目外访问询问」）；这类授权是内存态，随重启清空。详见 docs/architecture/security.md。
 */

// 已授权的受信根集合（绝对路径，字面形式）。任何来自渲染层/模型的路径都要先经 isInsideRoot 校验。
const roots = new Set<string>()

/**
 * 解析「真实路径」：跟随符号链接，闭合「链接在根内、目标在根外」的穿越洞。
 * 目标可能尚不存在（如将新建的文件）→ 对最近的存在祖先做 realpath，再把剥下的尾段接回。
 * 任一步失败都回退字面 resolve（不因解析失败而误放行/误拦截）。
 */
function realResolve(p: string): string {
  const abs = resolve(p)
  const tail: string[] = []
  let cur = abs
  // 逐级向上寻找第一个真实存在、可 realpath 的祖先；上限防御异常路径导致的死循环。
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync.native(cur)
      return tail.length ? join(real, ...tail) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return abs // 触底仍不可解析 → 退回字面
      tail.unshift(basename(cur))
      cur = parent
    }
  }
  return abs
}

/** 登记一个受信根（打开文件夹时，或用户在会话中显式授权项目外目录时）。 */
export function trustRoot(dir: string): void {
  roots.add(resolve(dir))
}

/** 移除一个受信根（用于「仅此次」授权：临时精确放行后撤销）。 */
export function untrustRoot(dir: string): void {
  roots.delete(resolve(dir))
}

/** 当前所有受信根（绝对路径，字面形式）。 */
export function listRoots(): string[] {
  return [...roots]
}

/**
 * target 是否落在某个受信根内。
 * 以「真实路径」比较（realResolve 跟随符号链接）：只要目标的真实路径不在任一受信根的
 * 真实路径之内即视为越界——从而堵住「根内符号链接指向根外」的穿越（旧实现仅 resolve 归一
 * `..` 但不跟随链接，存在真实穿越面）。
 */
export function isInsideRoot(target: string): boolean {
  const real = realResolve(target)
  for (const root of roots) {
    const rootReal = realResolve(root)
    if (real === rootReal || real.startsWith(rootReal + sep)) return true
  }
  return false
}

export function assertInside(target: string): void {
  if (!isInsideRoot(target)) throw new Error('拒绝访问：路径不在已打开的项目内')
}

/**
 * 敏感路径硬底：凭据/密钥与系统关键目录。
 * 即便用户在「项目外访问」询问里点了允许，命中这里的路径仍一律拒绝——
 * 防止把授权流程变成读取 ~/.ssh、~/.deva（本应用密钥库）等的后门。
 * 以真实路径比较（跟随符号链接），覆盖整个子树。
 */
export function isSensitivePath(target: string): boolean {
  const real = realResolve(target)
  for (const d of sensitiveDirs()) {
    if (real === d || real.startsWith(d + sep)) return true
  }
  return false
}

/** 敏感目录清单（按平台，真实路径，模块级缓存）。 */
let SENSITIVE_CACHE: string[] | null = null
function sensitiveDirs(): string[] {
  if (SENSITIVE_CACHE) return SENSITIVE_CACHE
  const home = homedir()
  const dirs = [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.deva') // 本应用的配置/密钥库，绝不可经 Agent 访问
  ]
  if (process.platform === 'win32') {
    dirs.push(process.env.SystemRoot || process.env.windir || 'C:\\Windows')
  } else {
    dirs.push('/etc', '/proc', '/sys', '/dev')
  }
  SENSITIVE_CACHE = dirs.map((d) => realResolve(d))
  return SENSITIVE_CACHE
}
