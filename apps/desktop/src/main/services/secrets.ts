import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'

/**
 * 密钥安全存储（主进程）。
 * 用 Electron safeStorage 加密（OS 凭据体系：Win DPAPI / macOS Keychain / Linux libsecret），
 * 密文（base64）落盘 `~/.deva/secrets.json`（与非敏感 config.json 同一根目录，可被 DEVA_HOME 覆盖）。
 * 即便放在点目录，也**始终保持加密、绝不明文**——DPAPI 密文绑定 OS 用户账户、与文件路径无关。
 * **明文永不出主进程**——不提供 get 给渲染层，解密只在主进程内被 provider 调用时发生。
 * 详见 docs/architecture/security.md。
 */

// providerId -> base64(密文)
let store: Record<string, string> = {}
let filePath = ''
let loaded = false

/** 从旧位置 userData/secrets.json 一次性迁移（密文原样搬运，加密不受路径影响）。 */
async function migrateLegacy(): Promise<void> {
  try {
    const legacy = join(app.getPath('userData'), 'secrets.json')
    const raw = await fs.readFile(legacy, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      store = parsed as Record<string, string>
      await persist() // 写到新位置 ~/.deva/secrets.json（旧文件保留，作兜底，不删）
    }
  } catch {
    // 无旧文件 / 解析失败 —— 视为空库
    store = {}
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  filePath = join(getDevaHome(), 'secrets.json')
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') store = parsed as Record<string, string>
  } catch {
    // 新位置不存在：尝试从旧 userData 位置迁移一次
    await migrateLegacy()
  }
  loaded = true
}

async function persist(): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf8')
}

/**
 * 主进程内部使用：取解密后的密钥。返回 null 表示未配置或无法解密。
 * 仅供 provider 适配层在发起请求时调用，绝不经 IPC 返回渲染层。
 */
export async function getSecret(providerId: string): Promise<string | null> {
  await ensureLoaded()
  const enc = store[providerId]
  if (!enc) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function registerSecretsIpc(): void {
  // 写入 / 更新密钥；空串视为删除。加密不可用时拒绝写入（绝不静默存明文）。
  ipcMain.handle(
    'secrets:set',
    async (_e, providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> => {
      await ensureLoaded()
      const available = safeStorage.isEncryptionAvailable()
      if (!key) {
        delete store[providerId]
        await persist()
        return { ok: true, available }
      }
      if (!available) return { ok: false, available }
      store[providerId] = safeStorage.encryptString(key).toString('base64')
      await persist()
      return { ok: true, available }
    }
  )

  // 是否已配置密钥（布尔，不回显明文）
  ipcMain.handle('secrets:has', async (_e, providerId: string): Promise<boolean> => {
    await ensureLoaded()
    return Boolean(store[providerId])
  })

  ipcMain.handle('secrets:delete', async (_e, providerId: string): Promise<{ ok: true }> => {
    await ensureLoaded()
    delete store[providerId]
    await persist()
    return { ok: true }
  })

  // 已配置密钥的 providerId 列表
  ipcMain.handle('secrets:list', async (): Promise<string[]> => {
    await ensureLoaded()
    return Object.keys(store)
  })

  // 当前环境是否支持加密（用于 UI 降级提示）
  ipcMain.handle('secrets:available', (): boolean => safeStorage.isEncryptionAvailable())
}
