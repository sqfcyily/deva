import { existsSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { ipcMain, shell } from 'electron'
import { getConfig, getDevaHome, setConfig } from './config'
import { getPersona, resolvePersonaId } from './personas'
import { listSessions } from './chat-store'
import { trustRoot } from './fs-guard'

/**
 * 角色的默认文件夹（对比稿 design/workspace-home.html 方案 B）：对话没挂载工作区时，相对路径与 run_command 都落在
 * 当前角色自己的文件夹 `~/Deva/<角色名>`，不再因为缺相对路径基准而弹挂载卡打断。用户要处理某个已有的项目时，
 * 由模型调用 mount_workspace 请用户挂载（见 workspace-mount.ts），或用户自己在输入框挂载。
 *
 * - 路径在第一次用到时按当时的角色名定下并记进 config.json 的 roleHomes，之后角色改名不跟着搬家；
 *   删角色也不删文件夹（里面是用户的文件）。
 * - 文件夹在真正读写时才创建（见 baseDir），只开对话不留空文件夹。
 * - 默认文件夹不是项目：不读 AGENTS.md、没有项目私有记忆、不显示版本控制——这些仍只认挂载的工作区
 *  （ToolContext.workspaceRoot），默认文件夹另放在 ToolContext.homeDir。
 */

const ROLE_HOMES_KEY = 'roleHomes'
/** 输入框「挂载工作区」菜单与挂载卡里列出的最近用过的文件夹个数。 */
const RECENT_MAX = 5

/** 各角色默认文件夹的上级目录。隔离实例（设了 DEVA_HOME）放进它自己的目录，不往用户真实的 ~/Deva 里写。 */
function homesRoot(): string {
  return process.env.DEVA_HOME?.trim() ? join(getDevaHome(), 'Deva') : join(homedir(), 'Deva')
}

/** 已定下的默认文件夹：角色 id → 绝对路径。 */
function pinnedHomes(): Record<string, string> {
  const raw = getConfig()[ROLE_HOMES_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [id, p] of Object.entries(raw as Record<string, unknown>))
    if (typeof p === 'string' && isAbsolute(p)) out[id] = p
  return out
}

/** 比较路径用的规范形式（Windows 不分大小写）。 */
function samePathKey(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 角色名 → 合法的文件夹名：去掉各平台不允许的字符与结尾的点和空格；不能用时回落角色 id。 */
function folderName(name: string, fallback: string): string {
  const s = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')
  return !s || RESERVED_NAME.test(s) ? fallback : s
}

/**
 * 角色的默认文件夹（绝对路径，不保证已存在）。第一次取时按角色名定下并记住；与别的角色撞名时加序号。
 * 未绑定或已删除的角色按默认角色处理（同 resolvePersonaId）。
 */
export function roleHome(personaId: string | undefined): string {
  const id = resolvePersonaId(personaId)
  const pinned = pinnedHomes()
  if (pinned[id]) return pinned[id]
  const base = folderName(getPersona(id)?.name ?? id, id)
  const taken = new Set(Object.values(pinned).map(samePathKey))
  let dir = join(homesRoot(), base)
  for (let i = 2; taken.has(samePathKey(dir)); i++) dir = join(homesRoot(), `${base} ${i}`)
  setConfig({ [ROLE_HOMES_KEY]: { ...pinned, [id]: dir } })
  return dir
}

/**
 * 工具的相对路径基准：挂载的工作区；没挂载时为角色的默认文件夹（此时才创建）。两者都没有（不该发生）→ null，
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
 * 角色设的工作文件夹（角色编辑页「工作文件夹」换成了某个文件夹，见 PersonaRecord.workspace）：新对话一开始就挂载它。
 * 没设、或文件夹已不在（删了、移走了）→ null，新对话照常用默认文件夹，角色里的设置原样保留。
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

/** 路径落在哪个角色的默认文件夹里：角色名 + 相对该文件夹的子路径（直接在里面为空串）；都不是 → null。 */
export function roleHomeOf(path: string): { role: string; rel: string } | null {
  for (const [id, home] of Object.entries(pinnedHomes())) {
    const rel = relative(home, path)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      return { role: getPersona(id)?.name ?? id, rel }
  }
  return null
}

/** 最近挂载过、现在仍存在的文件夹（取各对话挂过的工作区与成员负责的文件夹，按最近使用）。 */
export function recentFolders(): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = []
  const seen = new Set<string>()
  for (const s of listSessions()) {
    const p = s.focusRoot
    if (!p || out.length >= RECENT_MAX) continue
    const key = samePathKey(p)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    // 列表里点一下就挂载：同挂载卡的「已有目录」一样登记受信根（重开时这些目录本就已登记，这里只是兜底）。
    trustRoot(p)
    out.push({ path: p, name: basename(p) || p })
  }
  return out
}

export function registerRoleHomeIpc(): void {
  // 某角色的默认文件夹：输入框「挂载工作区」菜单底部与角色编辑页显示用。
  ipcMain.handle('workspace:role-home', (_e, personaId: unknown): { path: string; exists: boolean } => {
    const path = roleHome(typeof personaId === 'string' ? personaId : undefined)
    return { path, exists: existsSync(path) }
  })
  // 在系统文件管理器里打开角色的默认文件夹（还没有就先建好）。只开默认文件夹，不接受渲染层给的路径。
  ipcMain.handle('workspace:open-role-home', async (_e, personaId: unknown): Promise<{ ok: boolean }> => {
    const path = baseDir({ workspaceRoot: null, homeDir: roleHome(typeof personaId === 'string' ? personaId : undefined) })
    if (!path) return { ok: false }
    return { ok: (await shell.openPath(path)) === '' }
  })
  ipcMain.handle('workspace:recent', (): { path: string; name: string }[] => recentFolders())
}
