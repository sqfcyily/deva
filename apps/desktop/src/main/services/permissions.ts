import { ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import { projectKey } from './chat-store'
import { toolCategory } from './tools'
import { commandPrefix, isDangerousCommand, matchesPrefix, splitCommand } from './exec-policy'

/**
 * 权限闸门（allow / deny / ask）+ 每项目权限模式（持久化）。
 * 判定链：只读工具恒放行 → 本会话已记住 → 项目模式（auto 全放行 / acceptEdits 放行项目内编辑）→ 询问。
 * 子 Agent / Skill / MCP 后续都必须走这同一道闸门，无后门。
 *
 * 权限模式「按项目绑定」，但**集中存于 `~/.deva/permissions.json`（按 projectKey 区分）**，
 * 不落在项目目录内——避免克隆/下载的仓库自带一份配置预先授权危险操作（供应链脚枪），
 * 也与对话历史（~/.deva/chats）保持同一存储约定。会话级记住的授权是内存态，随重启清空。
 * 详见 docs/modules/permissions.md。
 */

export type Decision = 'allow' | 'deny' | 'ask'

/** 每项目权限模式：逐次询问 / 自动接受项目内编辑 / 全自动（含执行）。 */
export type PermMode = 'ask' | 'acceptEdits' | 'auto'

function normalizeMode(m: unknown): PermMode {
  return m === 'acceptEdits' || m === 'auto' ? m : 'ask'
}

// sessionId -> 本会话已记住放行的工具名集合（内存态，随重启清空）
const sessionAllow = new Map<string, Set<string>>()
// sessionId -> 本会话已记住放行的「命令前缀」集合（exec 专用，粒度到 `git status` 而非整个工具）
const sessionAllowExec = new Map<string, Set<string>>()

// projectKey -> 权限模式（持久化，惰性载入 + 内存缓存）
interface PermStore {
  version: number
  projects: Record<string, { mode: PermMode }>
}
let store: PermStore | null = null

function storeFile(): string {
  return join(getDevaHome(), 'permissions.json')
}

function load(): PermStore {
  if (store) return store
  let data: PermStore = { version: 1, projects: {} }
  try {
    const raw = readFileSync(storeFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
      const projects: Record<string, { mode: PermMode }> = {}
      for (const [k, v] of Object.entries(parsed.projects as Record<string, unknown>)) {
        projects[k] = { mode: normalizeMode((v as { mode?: unknown })?.mode) }
      }
      data = { version: 1, projects }
    }
  } catch {
    /* 首次运行 / 文件不存在 / 解析失败 → 默认（全部 ask） */
  }
  store = data
  return data
}

function persist(): void {
  if (!store) return
  try {
    writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8')
  } catch {
    /* 持久化失败静默：不影响本次会话内存态 */
  }
}

/** 取某项目的权限模式（未设置默认 ask）。 */
export function getMode(key: string): PermMode {
  return normalizeMode(load().projects[key]?.mode)
}

/** 设置某项目的权限模式并落盘。 */
export function setMode(key: string, mode: PermMode): void {
  const data = load()
  data.projects[key] = { mode: normalizeMode(mode) }
  persist()
}

/** 判定一次工具调用的权限：结合工具类别、会话记住、项目模式。exec 类另走 evaluateExec（可见命令）。 */
export function evaluate(sessionId: string, key: string, toolName: string, args?: unknown): Decision {
  const cat = toolCategory(toolName)
  if (cat === 'read') return 'allow'
  if (cat === 'exec') return evaluateExec(sessionId, key, args)
  // 以下 edit 与 mcp 共用一条路径：先看会话记住 → auto 全放行 → acceptEdits 仅对 edit 短路 → 否则 ask。
  // MCP 工具（外部服务）因此默认 ask、可按会话记住、auto 下放行、acceptEdits 下仍逐次询问。
  if (sessionAllow.get(sessionId)?.has(toolName)) return 'allow'
  const mode = getMode(key)
  if (mode === 'auto') return 'allow'
  if (mode === 'acceptEdits' && cat === 'edit') return 'allow'
  return 'ask'
}

/**
 * exec 类的判定（顺序即语义）：deny 压过一切（含 auto 与记住的前缀）→ auto 放行 → 记住的前缀
 * 覆盖「每一个」子命令才放行 → 否则询问。acceptEdits 对 exec 不短路（只放行编辑）。
 * 命令拆分后逐段核对，是防 `git status && rm -rf /` 之类注入的关键：记住的 `git status`
 * 只覆盖第一段，其余段匹配不到前缀 → 整条落 ask。
 */
function evaluateExec(sessionId: string, key: string, args?: unknown): Decision {
  const command =
    args && typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : ''
  if (!command.trim()) return 'ask'
  if (isDangerousCommand(command)) return 'deny' // 1 deny 胜过 auto + 前缀
  if (getMode(key) === 'auto') return 'allow' // 2 auto（deny 已在上一步处理）
  const prefixes = sessionAllowExec.get(sessionId) // 3 每个子命令都须被某前缀覆盖
  if (prefixes && prefixes.size > 0) {
    const subs = splitCommand(command)
    if (subs.length > 0 && subs.every((s) => [...prefixes].some((p) => matchesPrefix(s, p))))
      return 'allow'
  }
  return 'ask' // 4 否则询问
}

export function rememberSession(sessionId: string, toolName: string): void {
  let set = sessionAllow.get(sessionId)
  if (!set) {
    set = new Set()
    sessionAllow.set(sessionId, set)
  }
  set.add(toolName)
}

/**
 * 记住一次 exec 授权：把命令拆分后逐段推导「可记住前缀」加入本会话集合。
 * NEVER_REMEMBER_VERBS（rm/mv/curl…）经 commandPrefix 返回空串被 filter 掉 → 永不记住 → 每次重问。
 */
export function rememberSessionExec(sessionId: string, args: unknown): void {
  const command =
    args && typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : ''
  if (!command.trim()) return
  const prefixes = splitCommand(command).map(commandPrefix).filter(Boolean)
  if (prefixes.length === 0) return
  let set = sessionAllowExec.get(sessionId)
  if (!set) {
    set = new Set()
    sessionAllowExec.set(sessionId, set)
  }
  for (const p of prefixes) set.add(p)
}

export function clearSession(sessionId: string): void {
  sessionAllow.delete(sessionId)
  sessionAllowExec.delete(sessionId)
}

/** 权限模式的读写 IPC（按项目：workspaceRoot → projectKey）。 */
export function registerPermissionsIpc(): void {
  ipcMain.handle(
    'perm:get-mode',
    (_e, workspaceRoot: string | null): PermMode => getMode(projectKey(workspaceRoot))
  )
  ipcMain.handle(
    'perm:set-mode',
    (_e, workspaceRoot: string | null, mode: PermMode): { ok: true } => {
      setMode(projectKey(workspaceRoot), normalizeMode(mode))
      return { ok: true }
    }
  )
}
