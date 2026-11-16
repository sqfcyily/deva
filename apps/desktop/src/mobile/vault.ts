/**
 * 本机保存的电脑凭证（一台手机可以连多台电脑）：设备 id + 设备密钥，配对成功时电脑发来。
 * 存在 localStorage（按页面来源区分：官方中转、自建中转、局域网各是各的）。
 *
 * iOS 上「添加到主屏幕」的应用与 Safari 的存储可能互不相通：主屏幕应用首次打开时用地址里的安装票据
 * 换自己的凭证（见 link.ts），这里不需要特殊处理。
 */

export interface DeskCred {
  deskId: string
  /** 电脑名（hostname）。 */
  computer: string
  device: string
  /** 设备密钥（base64url）。 */
  key: string
  /** 在电脑上显示的设备名。 */
  name: string
  addedAt: number
  lastUsed: number
}

const KEY = 'deva.desks.v3'
const CURRENT = 'deva.desk.current'

function read(): DeskCred[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as DeskCred[]
    return Array.isArray(raw) ? raw.filter((d) => d && typeof d.deskId === 'string' && typeof d.key === 'string') : []
  } catch {
    return []
  }
}

function write(list: DeskCred[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式等：本次打开仍可用，刷新后要重新扫码 */
  }
}

export function listDesks(): DeskCred[] {
  return read().sort((a, b) => b.lastUsed - a.lastUsed)
}

export function getDesk(deskId: string): DeskCred | null {
  return read().find((d) => d.deskId === deskId) ?? null
}

export function saveDesk(cred: DeskCred): void {
  write([...read().filter((d) => d.deskId !== cred.deskId), cred])
}

export function patchDesk(deskId: string, patch: Partial<Omit<DeskCred, 'deskId'>>): void {
  write(read().map((d) => (d.deskId === deskId ? { ...d, ...patch } : d)))
}

export function removeDesk(deskId: string): void {
  write(read().filter((d) => d.deskId !== deskId))
  if (currentDeskId() === deskId) setCurrentDesk(listDesks()[0]?.deskId ?? null)
}

export function currentDeskId(): string | null {
  try {
    return localStorage.getItem(CURRENT)
  } catch {
    return null
  }
}

export function setCurrentDesk(deskId: string | null): void {
  try {
    if (deskId) localStorage.setItem(CURRENT, deskId)
    else localStorage.removeItem(CURRENT)
  } catch {
    /* ignore */
  }
}

// ───────── 小设置（按本机） ─────────

export function prefGet(key: string): string | null {
  try {
    return localStorage.getItem(`deva.pref.${key}`)
  } catch {
    return null
  }
}

export function prefSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`deva.pref.${key}`)
    else localStorage.setItem(`deva.pref.${key}`, value)
  } catch {
    /* ignore */
  }
}
