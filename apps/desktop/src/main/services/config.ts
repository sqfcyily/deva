import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 应用配置存储（主进程）。
 * 非敏感的用户配置（主题 / 语言 / 服务商与模型 / 默认模型等）以**明文 JSON** 存于
 * `~/.deva/config.json`，开发者可手改 / 备份 / 版本化（对标 ~/.claude）。
 * 根目录可用环境变量 `DEVA_HOME` 覆盖（便携安装 / 测试 / CI）。
 * **敏感信息（API 密钥）绝不进此文件**——见 services/secrets.ts（safeStorage 加密的 secrets.json）。
 * 详见 docs/architecture/security.md。
 */

let home = ''

/** Deva 配置根目录：DEVA_HOME 覆盖，否则 ~/.deva。首次调用即确保目录存在。 */
export function getDevaHome(): string {
  if (home) return home
  const override = process.env.DEVA_HOME?.trim()
  home = override && override.length > 0 ? override : join(app.getPath('home'), '.deva')
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 目录创建失败：后续读写各自兜底，不阻断启动 */
  }
  return home
}

function configPath(): string {
  return join(getDevaHome(), 'config.json')
}

let config: Record<string, unknown> = {}
let loaded = false

/** 同步载入（配置很小；同步读简化了首帧同步 IPC）。 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>
  } catch {
    // 首次运行 / 文件不存在 / 解析失败 —— 视为空配置
    config = {}
  }
  loaded = true
}

function persist(): void {
  try {
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* 持久化失败静默：不影响本次会话的内存态 */
  }
}

/**
 * 主进程内读取整份配置（只读快照）。
 * 供其它服务在进程内复用（如 git.ts 读 `git.path` 覆盖），避免各自重复读文件。
 */
export function getConfig(): Record<string, unknown> {
  ensureLoaded()
  return config
}

/**
 * 主进程内写配置（顶层浅合并，值为 undefined 时删除该键），并落盘。
 * 供 skills.ts / agents.ts 等服务在进程内维护启用态（config.json 内的 skills/agents 段），
 * 与渲染层的 `config:set` IPC 走同一份内存态 + 持久化路径。
 */
export function setConfig(patch: Record<string, unknown>): void {
  ensureLoaded()
  if (!patch || typeof patch !== 'object') return
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete config[k]
    else config[k] = v
  }
  persist()
}

export function registerConfigIpc(): void {
  ensureLoaded()

  // 同步读取整份配置：供渲染层首帧读取主题/语言，避免闪烁（FOUC）。
  ipcMain.on('config:get-sync', (evt) => {
    ensureLoaded()
    evt.returnValue = config
  })

  // 异步读取整份配置。
  ipcMain.handle('config:get', () => {
    ensureLoaded()
    return config
  })

  // 顶层浅合并补丁：值为 undefined 时删除该键。
  ipcMain.handle('config:set', (_e, patch: Record<string, unknown>) => {
    setConfig(patch)
    return { ok: true as const }
  })
}
