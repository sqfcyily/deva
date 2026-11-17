import { randomBytes } from 'node:crypto'
import { b64uDecode, b64uEncode, randomKey } from '../../../../shared/remote-crypto'
import type { PhoneVia } from '../../../../shared/phone'
import type { WebPushSub } from '../../../../shared/remote-web'
import { deleteSecret, getSecret, setSecret } from '../../secrets'
import { getBot, updateBot, type PairedUser } from '../store'
import type { ChannelId } from '../types'

/**
 * 手机设备与一次性票据。
 *
 *  · 设备 = 手机网页「机器人」的一个已配对用户（bot.users，hub 往它推交互卡与通知），外加设备密钥
 *   （密钥库 remote:<botId>:dev:<设备 id>，只在本机加密保存）与推送订阅、最近使用时间等。
 *  · 票据只在内存：pair = 电脑上二维码里的配对票据（2 分钟，新码出来后旧码只再留 15 秒）；
 *    「在浏览器中打开 / 复制链接」用的也是配对票据，但 10 分钟有效、不随二维码刷新作废（sticky）；
 *    install = 手机添加到主屏幕前要的安装票据（1 小时）。都只能用一次，解密失败 3 次作废。
 */

export interface PhoneDevice extends PairedUser {
  kind?: 'browser' | 'standalone'
  /** 走哪条路连的（扫码时定下；每次连上按实际连接更新）。旧数据没有时按迁移前的连接方式补上。 */
  via?: PhoneVia
  lastSeen?: number
  push?: WebPushSub
}

const DEV_KEY = (botId: ChannelId, did: string): string => `remote:${botId}:dev:${did}`

export function listDevices(botId: ChannelId): PhoneDevice[] {
  return (getBot(botId)?.users ?? []) as PhoneDevice[]
}

export function getDevice(botId: ChannelId, did: string): PhoneDevice | null {
  return listDevices(botId).find((d) => d.id === did) ?? null
}

/** 新设备：生成设备密钥存进密钥库，再登记为已配对用户。密钥库不可用时返回 null。 */
export async function createDevice(
  botId: ChannelId,
  name: string,
  kind: 'browser' | 'standalone',
  via: PhoneVia
): Promise<{ id: string; key: Uint8Array } | null> {
  const id = `d_${randomBytes(8).toString('hex')}`
  const key = randomKey()
  const saved = await setSecret(DEV_KEY(botId, id), b64uEncode(key))
  if (!saved.ok) return null
  const now = Date.now()
  updateBot(botId, (b) => ({
    ...b,
    users: [...b.users, { id, name: name.slice(0, 40) || '手机', chatId: id, pairedAt: now, kind, via, lastSeen: now } as PhoneDevice]
  }))
  return { id, key }
}

/** 设备密钥（设备已被移除或密钥丢失时为 null）。 */
export async function deviceKey(botId: ChannelId, did: string): Promise<Uint8Array | null> {
  if (!getDevice(botId, did)) return null
  const raw = await getSecret(DEV_KEY(botId, did))
  const key = raw ? b64uDecode(raw) : null
  return key && key.length === 32 ? key : null
}

export function patchDevice(botId: ChannelId, did: string, patch: Partial<Omit<PhoneDevice, 'id'>>): void {
  updateBot(botId, (b) => ({
    ...b,
    users: b.users.map((u) => (u.id === did ? ({ ...u, ...patch } as PhoneDevice) : u))
  }))
}

/** 去掉设备的密钥（用户记录由调用方经 hub.removePairedUser 删，顺带清绑定并通知界面）。 */
export async function forgetDeviceKey(botId: ChannelId, did: string): Promise<void> {
  await deleteSecret(DEV_KEY(botId, did))
}

// ───────── 一次性票据 ─────────

export type TicketKind = 'pair' | 'install'

interface Ticket {
  kind: TicketKind
  secret: Uint8Array
  expiresAt: number
  failures: number
  /** 链接用的配对票据：二维码刷新 / 收起时不作废。 */
  sticky?: boolean
}

const PAIR_TTL_MS = 2 * 60_000
const LINK_TTL_MS = 10 * 60_000
const INSTALL_TTL_MS = 60 * 60_000
/** 新的配对码出来后，旧码再留这么久（刚好在刷新那一刻扫的也能成功）。 */
const PAIR_GRACE_MS = 15_000
const MAX_FAILURES = 3

const tickets = new Map<string, Ticket>()

function sweep(): void {
  const now = Date.now()
  for (const [id, t] of tickets) if (t.expiresAt <= now) tickets.delete(id)
}

/** link = 「在浏览器中打开 / 复制链接」用的配对票据（10 分钟，不随二维码作废）。 */
export function issueTicket(kind: TicketKind | 'link'): { id: string; secret: Uint8Array; expiresAt: number } {
  sweep()
  const now = Date.now()
  if (kind === 'pair')
    for (const t of tickets.values())
      if (t.kind === 'pair' && !t.sticky) t.expiresAt = Math.min(t.expiresAt, now + PAIR_GRACE_MS)
  const id = randomBytes(9).toString('base64url')
  const secret = randomKey()
  const expiresAt = now + (kind === 'pair' ? PAIR_TTL_MS : kind === 'link' ? LINK_TTL_MS : INSTALL_TTL_MS)
  tickets.set(id, { kind: kind === 'link' ? 'pair' : kind, secret, expiresAt, failures: 0, sticky: kind === 'link' })
  return { id, secret, expiresAt }
}

/**
 * 二维码收起时：二维码的配对票据作废（看不到的码不该继续有效）；复制出去的链接还留着。
 * all = 停用 / 删除 / 改中转地址或端口：链接也一并作废。
 */
export function cancelPairTickets(all = false): void {
  for (const [id, t] of tickets) if (t.kind === 'pair' && (all || !t.sticky)) tickets.delete(id)
}

export function ticketSecret(id: string, kind: TicketKind): Uint8Array | null {
  const t = tickets.get(id)
  if (!t || t.kind !== kind) return null
  if (t.expiresAt <= Date.now()) {
    tickets.delete(id)
    return null
  }
  return t.secret
}

export function consumeTicket(id: string): void {
  tickets.delete(id)
}

export function failTicket(id: string): void {
  const t = tickets.get(id)
  if (t && ++t.failures >= MAX_FAILURES) tickets.delete(id)
}
