import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { ipcMain } from 'electron'
import { getDevaHome } from './config'
import { getPersona, resolvePersonaId } from './personas'
import { trustRoot } from './fs-guard'

/**
 * 角色的默认工作区（对比稿 design/workspace-home.html 方案 B）：对话没挂载工作区时，相对路径与 run_command 都落在
 * 当前角色自己的目录 `~/Deva/Agents/<角色 id>`，不再因为缺相对路径基准而弹挂载卡打断。用户要处理某个已有的项目时，
 * 由模型调用 mount_workspace 请用户挂载（见 workspace-mount.ts），或用户自己在输入框挂载。
 *
 * - 按角色 id 放（id 恒定）：角色改名不搬家，不同角色同名也不冲突；删角色不删目录（里面是用户的文件）。
 * - `~/Deva` 是 Deva 放用户文件的根目录：角色的工作区在 Agents 下，将来的共享目录也放在这一层。
 * - 目录在真正读写时才创建（见 baseDir），只开对话不留空目录。
 * - 默认工作区不是项目：不读 AGENTS.md、没有项目私有记忆、不显示版本控制——这些仍只认挂载的工作区
 *  （ToolContext.workspaceRoot），默认工作区另放在 ToolContext.homeDir。
 */

/** Deva 放用户文件的根目录。隔离实例（设了 DEVA_HOME）放进它自己的目录，不往用户真实的 ~/Deva 里写。 */
function devaFilesRoot(): string {
  return process.env.DEVA_HOME?.trim() ? join(getDevaHome(), 'Deva') : join(homedir(), 'Deva')
}

/** 各角色默认工作区的上级目录。 */
function agentsRoot(): string {
  return join(devaFilesRoot(), 'Agents')
}

/**
 * 角色的默认工作区（绝对路径，不保证已存在）。未绑定或已删除的角色按默认角色处理（同 resolvePersonaId）；
 * 角色 id 只含字母、数字与 `_.-`（见 personas.ts isSafeId），可以直接当目录名。
 */
export function roleHome(personaId: string | undefined): string {
  return join(agentsRoot(), resolvePersonaId(personaId))
}

/**
 * 工具的相对路径基准：挂载的工作区；没挂载时为角色的默认工作区（此时才创建）。两者都没有（不该发生）→ null，
 * 由调用方按「缺基准」报错。
 */
export function baseDir(ctx: { workspaceRoot: string | null; homeDir?: string | null }): string | null {
  if (ctx.workspaceRoot) return ctx.workspaceRoot
  const home = ctx.homeDir
  if (!home) return null
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 建不了（权限、磁盘）：照样返回，由后续读写各自报出原因 */
  }
  return home
}

/**
 * 角色设的工作区（角色编辑页「工作区」换成了某个文件夹，见 PersonaRecord.workspace）：新对话一开始就挂载它。
 * 没设、或文件夹已不在（删了、移走了）→ null，新对话照常用默认工作区，角色里的设置原样保留。
 * 路径只认主进程自己的角色记录（由用户在编辑页经系统对话框选定），渲染层传来的值不采信。
 */
export function personaWorkspace(personaId: string | undefined): string | null {
  const ws = getPersona(resolvePersonaId(personaId))?.workspace
  if (!ws || !isAbsolute(ws)) return null
  try {
    if (!statSync(ws).isDirectory()) return null
  } catch {
    return null
  }
  const abs = resolve(ws)
  trustRoot(abs)
  return abs
}

/** 路径落在哪个角色的默认工作区里：角色名 + 相对该工作区的子路径（直接在里面为空串）；都不是 → null。 */
export function roleHomeOf(path: string): { role: string; rel: string } | null {
  const rel = relative(agentsRoot(), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const [id, ...rest] = rel.split(/[\\/]/)
  return { role: getPersona(id)?.name ?? id, rel: rest.join(sep) }
}

export function registerRoleHomeIpc(): void {
  // 某角色的默认工作区：角色编辑页「工作区」一栏显示用。
  ipcMain.handle('workspace:role-home', (_e, personaId: unknown): { path: string; exists: boolean } => {
    const path = roleHome(typeof personaId === 'string' ? personaId : undefined)
    return { path, exists: existsSync(path) }
  })
}
