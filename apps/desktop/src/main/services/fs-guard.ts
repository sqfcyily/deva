import { resolve, sep } from 'path'

/**
 * 受信根守卫（主进程共享）。
 * 「已打开的项目根目录」是唯一被允许读写的区域——无论是 fs IPC 还是 Agent 的文件工具，
 * 都必须先经此校验，杜绝路径穿越。详见 docs/architecture/security.md。
 */

// 已授权的工作区根目录集合。任何来自渲染层/模型的路径都要先经 isInsideRoot 校验。
const roots = new Set<string>()

/** 登记一个受信根（打开文件夹时，或从持久化的最近项目恢复时）。 */
export function trustRoot(dir: string): void {
  roots.add(resolve(dir))
}

/** 当前所有受信根（绝对路径）。 */
export function listRoots(): string[] {
  return [...roots]
}

export function isInsideRoot(target: string): boolean {
  const abs = resolve(target)
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return true
  }
  return false
}

export function assertInside(target: string): void {
  if (!isInsideRoot(target)) throw new Error('拒绝访问：路径不在已打开的项目内')
}
