import { realpathSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'

/**
 * 受信根守卫（主进程共享）：仅约束**渲染层发起**的 fs / git IPC——「已打开的项目根目录」是渲染层
 * 可读写的区域，路径须先经此校验，杜绝路径穿越。受信根是内存态，随重启清空。
 *
 * Agent 的文件工具（read_file / write_file / edit_file / glob / grep / list_dir）**不经过这里**：
 * 2026-10-09 起文件读写不设任何路径限制（含凭据目录、~/.deva、.git），见 tools.ts 的 resolvePath。
 */

// 已授权的受信根集合（绝对路径，字面形式）。任何来自渲染层的路径都要先经 isInsideRoot 校验。
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

/** 登记一个受信根（打开文件夹 / 挂载工作区时）。 */
export function trustRoot(dir: string): void {
  roots.add(resolve(dir))
}

/** 移除一个受信根。 */
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
 * target 是否落在指定目录 dir 之内（含 dir 本身）。以真实路径比较（跟随符号链接）。
 * 用于区分「当前活动工作区」与「其它受信根」：acceptEdits 仅自动接受当前工作区内的写入。
 */
export function isWithinDir(target: string, dir: string | null): boolean {
  if (!dir) return false
  const real = realResolve(target)
  const dreal = realResolve(dir)
  return real === dreal || real.startsWith(dreal + sep)
}
