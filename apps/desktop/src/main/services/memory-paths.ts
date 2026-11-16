import { createHash } from 'node:crypto'
import { realpathSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'

/**
 * 记忆文件的路径推导（`memory.ts` 与 `memory-archive.ts` 共用）。
 *
 * 单独一个模块是为了避免循环依赖：`memory.ts` 要调 `memory-archive.ts`（写满自动迁出），
 * 而 `memory-archive.ts` 又要知道项目记忆目录在哪。路径规则放这里，两边都单向依赖它。
 */

/** 记忆作用域：全局（用户本人）或某个工作区的私有项目记忆。 */
export type MemoryScope = { kind: 'global' } | { kind: 'project'; root: string }

/**
 * 工作区 → 稳定的项目记忆键。按真实路径算（符号链接 / 大小写不同的写法指向同一项目即同一份记忆），
 * 取不到真实路径（目录已不存在等）回落原路径。Windows / macOS 默认大小写不敏感，统一转小写。
 */
export function projectMemoryKey(root: string): string {
  let p = root
  try {
    p = realpathSync.native(root)
  } catch {
    /* 回落原路径 */
  }
  let norm = p.replace(/[\\/]+$/, '')
  if (process.platform === 'win32' || process.platform === 'darwin') norm = norm.toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

/** `<DEVA_HOME>/memory.json` 或 `<DEVA_HOME>/projects/<key>/memory.json`。 */
export function memoryFilePath(scope: MemoryScope): string {
  if (scope.kind === 'project')
    return join(getDevaHome(), 'projects', projectMemoryKey(scope.root), 'memory.json')
  return join(getDevaHome(), 'memory.json')
}

/** 遗忘区文件（与 memory.json 同目录、同作用域划分）。 */
export function archiveFilePath(scope: MemoryScope): string {
  if (scope.kind === 'project')
    return join(getDevaHome(), 'projects', projectMemoryKey(scope.root), 'memory-archive.json')
  return join(getDevaHome(), 'memory-archive.json')
}
