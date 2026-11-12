import { getConfig, setConfig } from '../config'

/**
 * 通用设备通道的持久化配置（config.json → generalServer 段，非敏感项）。
 * 设备 token 是密钥，另存 secrets.json，键 `general:<deviceId>:token`（secrets.ts，safeStorage 加密），
 * 不与远程通道的 `remote:<botId>:*` 复用（设计 §3.2）。
 *
 * enabled 默认 true：入站面在未配对时只有 /api/pair（限速 + 一次性码）与 401，配对后才可访问；
 * host 默认 0.0.0.0（局域网可连），写 '127.0.0.1' 即「仅本机」开关。
 */

export interface GeneralDevice {
  id: string
  name: string
  pairedAt: number
  /** 单设备启停（审查 F1/F8）：false 即鉴权短路，该设备请求一律 401。默认 true。 */
  enabled: boolean
}

export interface GeneralServerConfig {
  enabled: boolean
  port: number
  host: string
  devices: GeneralDevice[]
}

/** 设备名净化：去 C0/C1 控制符、bidi 覆写与零宽字符，截断 40 字符（配对与改名共用）。 */
export function sanitizeDeviceName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .trim()
    .slice(0, 40)
}

/** 唯一性比较口径：NFKC 归一化后不分大小写。 */
function nfkcName(v: string): string {
  return v.normalize('NFKC').trim().toLowerCase()
}

/** 改名：净化 + 全局唯一（NFKC 不分大小写），自身除外。 */
export function renameDevice(id: string, rawName: string): { ok: true } | { ok: false; error: string } {
  const name = sanitizeDeviceName(rawName)
  if (!name) return { ok: false, error: '设备名不能为空。' }
  const cfg = getGeneralServerConfig()
  if (!cfg.devices.some((d) => d.id === id)) return { ok: false, error: '设备不存在。' }
  if (cfg.devices.some((d) => d.id !== id && nfkcName(d.name) === nfkcName(name)))
    return { ok: false, error: `设备名「${name}」已被占用。` }
  write({ ...cfg, devices: cfg.devices.map((d) => (d.id === id ? { ...d, name } : d)) })
  return { ok: true }
}

export const DEFAULT_ANDROID_PORT = 4317

const DEFAULTS: Omit<GeneralServerConfig, 'devices'> = {
  enabled: true,
  port: DEFAULT_ANDROID_PORT,
  host: '0.0.0.0'
}

function normalize(raw: unknown): GeneralServerConfig {
  const devices: GeneralDevice[] = []
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.devices))
      for (const d of r.devices) {
        const c = d as Record<string, unknown>
        if (c && typeof c.id === 'string' && c.id)
          devices.push({
            id: c.id,
            name: typeof c.name === 'string' ? c.name : '',
            pairedAt: typeof c.pairedAt === 'number' ? c.pairedAt : 0,
            enabled: c.enabled !== false
          })
      }
    return {
      enabled: r.enabled !== false,
      port:
        typeof r.port === 'number' && Number.isInteger(r.port) && r.port > 0 && r.port < 65536
          ? r.port
          : DEFAULTS.port,
      host: typeof r.host === 'string' && r.host ? r.host : DEFAULTS.host,
      devices
    }
  }
  return { ...DEFAULTS, devices }
}

export function getGeneralServerConfig(): GeneralServerConfig {
  return normalize(getConfig().generalServer)
}

function write(cfg: GeneralServerConfig): void {
  setConfig({
    generalServer: { enabled: cfg.enabled, port: cfg.port, host: cfg.host, devices: cfg.devices }
  })
}

export function patchGeneralServer(patch: Partial<Omit<GeneralServerConfig, 'devices'>>): void {
  write({ ...getGeneralServerConfig(), ...patch })
}

/** 配对成功落设备（同 id 覆盖）；吊销走 removeDevice + 删密钥。 */
export function addDevice(d: GeneralDevice): void {
  const cfg = getGeneralServerConfig()
  write({ ...cfg, devices: [...cfg.devices.filter((x) => x.id !== d.id), d] })
}

/** 单设备启停（审查 F1/F8）：false 即鉴权短路，该设备请求一律 401。 */
export function setDeviceEnabled(id: string, enabled: boolean): void {
  const cfg = getGeneralServerConfig()
  if (!cfg.devices.some((d) => d.id === id)) return
  write({ ...cfg, devices: cfg.devices.map((d) => (d.id === id ? { ...d, enabled } : d)) })
}

export function removeDevice(id: string): void {
  const cfg = getGeneralServerConfig()
  write({ ...cfg, devices: cfg.devices.filter((d) => d.id !== id) })
}
