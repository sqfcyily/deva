import { ipcMain, type BrowserWindow } from 'electron'
import { randomBytes, randomInt } from 'node:crypto'
import { hostname } from 'node:os'
import QRCode from 'qrcode'
import { formatTicket } from '../../../../shared/remote-crypto'
import { OFFICIAL_RELAY_URL } from '../../../../shared/remote-web'
import type { PhoneDeviceView, PhoneLinkResult, PhoneMode, PhoneQrResult, PhoneState } from '../../../../shared/phone'
import { isEn } from '../../../locale'
import { deleteSecretsByPrefix, getSecret, setSecret } from '../../secrets'
import { onHubChange, startChannel, stopChannel } from '../hub'
import { DEFAULT_SCOPE, addBot, deleteBot, listBots, updateBot, type BotConfig } from '../store'
import type { AdapterHost, ChannelId } from '../types'
import { PhoneAdapter, removeDevice } from './adapter'
import { cancelPairTickets, consumeTicket, deviceKey, failTicket, issueTicket, listDevices, ticketSecret, type PhoneDevice } from './devices'
import { createSecureGate, type SecretResult } from './secure'
import { relayPageUrl, relayWsBase, startRelayClient, type RelayClient } from './relay'
import { lanAddresses, startLanServer, type LanServer } from './server'

/**
 * Deva 手机版的电脑端入口（单例）：「手机」面板（图标栏左下角）顶部固定的「Deva 手机版」。
 *
 * 存为一个 platform = 'web' 的机器人（hub 往它推交互卡与通知，已配对用户 = 设备），不在机器人列表里显示，
 * 不能添加也不能删除。连接方式三选一：官方中转（默认）/ 自建中转 / 仅局域网。
 *
 * 配对：面板上的二维码 = 中转页面（或局域网地址）+ 桌面 id + 一次性配对票据，手机扫码打开即自动连接（不用输任何东西）。
 */

const WEB_PORT_DEFAULT = 17800
const SECRET_KEY = (id: ChannelId, field: string): string => `remote:${id}:${field}`

interface PhoneSettings {
  mode: PhoneMode
  relayUrl: string
  port: number
  deskId: string
}

function settingsOf(bot: BotConfig): PhoneSettings {
  const s = bot.settings
  const legacyRelay = s.relay && typeof s.relay === 'object' ? (s.relay as Record<string, unknown>) : null
  const relayUrl = typeof s.relayUrl === 'string' ? s.relayUrl : typeof legacyRelay?.url === 'string' ? legacyRelay.url : ''
  // 旧设置：official = 官方中转（不带自定义地址）；custom = 自建中转；更早的「手机网页」开了中转的算自建中转。
  const mode: PhoneMode = s.mode === 'lan' ? 'lan' : 'relay'
  return {
    mode,
    relayUrl: s.mode === 'official' ? '' : s.mode === 'custom' || s.mode === 'relay' || legacyRelay?.enabled === true ? relayUrl : '',
    port: typeof s.port === 'number' && s.port >= 1024 && s.port <= 65535 ? Math.floor(s.port) : WEB_PORT_DEFAULT,
    deskId: typeof s.deskId === 'string' && s.deskId ? s.deskId : randomBytes(8).toString('hex')
  }
}

/**
 * 这台电脑的「Deva 手机版」：默认没有，用户在「手机」面板的 + 里添加后才有，最多一个。
 * 历史上多建的手机网页一并清掉（只留最早那个），旧版设置顺手规范化。
 */
function phoneBot(): BotConfig | null {
  const webs = listBots()
    .filter((b) => b.platform === 'web')
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const extra of webs.slice(1)) deleteBot(extra.id)
  const cur = webs[0]
  if (!cur) return null
  const s = settingsOf(cur)
  // 规范化：写回新版设置项，去掉旧版的 relay / lan / tokens。
  if (cur.settings.mode !== s.mode || cur.settings.relayUrl !== s.relayUrl || cur.settings.deskId !== s.deskId || 'tokens' in cur.settings) {
    updateBot(cur.id, (b) => ({ ...b, scope: DEFAULT_SCOPE, settings: { ...s } }))
    return { ...cur, settings: { ...s } }
  }
  return cur
}

/** 添加（已有就返回已有的）：建好即启用，面板上直接出二维码。 */
function addPhoneBot(): BotConfig {
  const cur = phoneBot()
  if (cur) return cur
  const bot: BotConfig = {
    id: `bot_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`,
    platform: 'web',
    name: isEn() ? 'Deva Mobile' : 'Deva 手机版',
    enabled: true,
    createdAt: Date.now(),
    replyMode: 'final',
    scope: DEFAULT_SCOPE,
    users: [],
    bindings: {},
    settings: { ...settingsOf({ settings: {} } as BotConfig) }
  }
  addBot(bot)
  return bot
}

function relayUrlOf(s: PhoneSettings): string {
  return s.mode === 'relay' ? s.relayUrl || OFFICIAL_RELAY_URL : ''
}

// ───────── 运行时 ─────────

type Status = PhoneState['status']

/** 正在运行的手机通道（启用时才有）。 */
class PhoneChannel extends PhoneAdapter {
  status: Status = { state: 'connecting' }
  private relay: RelayClient | null = null
  private lan: LanServer | null = null

  constructor(
    id: ChannelId,
    private settings: PhoneSettings,
    private onStatus: () => void,
    onDevicesChanged: () => void,
    onPaired: (did: string) => void
  ) {
    super(id, { deskId: settings.deskId, onDevicesChanged, onPaired })
  }

  private setStatus(state: Status['state'], error?: string, host?: AdapterHost): void {
    this.status = { state, error }
    if (host) host.onState(state === 'on' ? 'connected' : state === 'off' ? 'off' : state, error)
    this.onStatus()
  }

  async start(host: AdapterHost): Promise<void> {
    await super.start(host)
    const id = this.id
    const gate = createSecureGate({
      sink: this,
      lookup: async (auth): Promise<SecretResult> => {
        if (auth.kind === 'resume') {
          const key = await deviceKey(id, auth.id)
          return key ? { secret: key } : { error: '这台手机已在电脑上被移除，请在电脑上重新扫码。', removed: true }
        }
        const secret = ticketSecret(auth.id, auth.kind)
        if (secret) return { secret }
        return {
          error:
            auth.kind === 'pair'
              ? '二维码已失效（每个二维码只能用一次，2 分钟后自动换新）。请在电脑上扫描最新的二维码。'
              : '安装凭证已过期，请在电脑上重新扫码。'
        }
      },
      onProven: (auth) => {
        if (auth.kind !== 'resume') consumeTicket(auth.id)
      },
      onFailed: (auth) => {
        if (auth.kind !== 'resume') failTicket(auth.id)
      }
    })
    const s = this.settings
    if (s.mode === 'lan') {
      try {
        this.lan = await startLanServer(s.port, gate)
        this.setStatus('on', undefined, host)
      } catch (e) {
        this.setStatus('error', (e as Error)?.message ?? String(e), host)
      }
      return
    }
    const url = relayUrlOf(s)
    if (!url) return this.setStatus('error', '还没有可用的中转地址，请在「连接方式」里填写，或改用仅局域网。', host)
    const key = await deskKey(id)
    if (!key) return this.setStatus('error', '系统密钥存储不可用，无法安全保存中转密钥。', host)
    this.setStatus('connecting', undefined, host)
    this.relay = startRelayClient({
      url,
      deskId: s.deskId,
      key,
      sink: gate,
      onState: (state, error) => this.setStatus(state, state === 'error' ? error : undefined, host)
    })
  }

  async stop(): Promise<void> {
    this.relay?.close()
    this.relay = null
    const lan = this.lan
    this.lan = null
    await super.stop()
    if (lan) await lan.close()
  }
}

/** 中转用的桌面密钥（首次用时生成）：中转据此认定桌面 id 归这台电脑。 */
async function deskKey(id: ChannelId): Promise<string | null> {
  const k = SECRET_KEY(id, 'deskKey')
  const cur = await getSecret(k)
  if (cur) return cur
  const key = randomBytes(32).toString('base64url')
  return (await setSecret(k, key)).ok ? key : null
}

let channel: PhoneChannel | null = null

// ───────── IPC ─────────

export function registerPhoneIpc(getWindow: () => BrowserWindow | null): void {
  const send = (ch: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload)
  }
  const push = (): void => send('phone:changed', publicState())
  onHubChange(push)

  const launch = async (): Promise<void> => {
    const bot = phoneBot()
    if (channel) await stopChannel(channel.id)
    channel = null
    if (!bot || !bot.enabled) return push()
    const ch = new PhoneChannel(bot.id, settingsOf(bot), push, push, (did) => {
      const d = listDevices(bot.id).find((x) => x.id === did)
      send('phone:paired', { id: did, name: d?.name ?? '' })
    })
    channel = ch
    await startChannel(ch)
    push()
  }

  ipcMain.handle('phone:get-state', () => publicState())

  ipcMain.handle('phone:add', async (): Promise<PhoneState> => {
    addPhoneBot()
    await launch()
    return publicState()
  })

  // 删除：断开并移除所有已连接的手机（设备密钥、推送密钥、中转密钥一并清掉），之后要重新添加并扫码。
  ipcMain.handle('phone:remove', async (): Promise<PhoneState> => {
    const bot = phoneBot()
    if (bot) {
      cancelPairTickets(true)
      if (channel) await stopChannel(channel.id)
      channel = null
      await deleteSecretsByPrefix(SECRET_KEY(bot.id, ''))
      deleteBot(bot.id)
    }
    push()
    return publicState()
  })

  ipcMain.handle('phone:set-enabled', async (_e, enabled: unknown): Promise<PhoneState> => {
    const bot = phoneBot()
    if (!bot) return publicState()
    updateBot(bot.id, (b) => ({ ...b, enabled: enabled === true }))
    if (enabled !== true) cancelPairTickets(true)
    await launch()
    return publicState()
  })

  ipcMain.handle(
    'phone:set-mode',
    async (_e, patch: { mode?: unknown; relayUrl?: unknown; port?: unknown }): Promise<{ ok: boolean; error?: string }> => {
      const bot = phoneBot()
      if (!bot) return { ok: false, error: '请先添加 Deva 手机版。' }
      const cur = settingsOf(bot)
      const next: PhoneSettings = { ...cur }
      if (patch.mode === 'relay' || patch.mode === 'lan') next.mode = patch.mode
      if (typeof patch.relayUrl === 'string') {
        const url = patch.relayUrl.trim()
        if (url && !relayWsBase(url)) return { ok: false, error: '中转地址无效，应形如 https://relay.example.com' }
        // 填的就是官方地址：按「用官方」存（留空），官方以后换地址也跟着换。
        next.relayUrl = relayWsBase(url) === relayWsBase(OFFICIAL_RELAY_URL) ? '' : url
      }
      if (typeof patch.port === 'number') {
        if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)
          return { ok: false, error: '端口须在 1024–65535 之间。' }
        next.port = patch.port
      }
      updateBot(bot.id, (b) => ({ ...b, settings: { ...next } }))
      // 换了连接方式：旧二维码指向的地址已不对，作废。
      if (next.mode !== cur.mode || next.relayUrl !== cur.relayUrl || next.port !== cur.port) cancelPairTickets(true)
      await launch()
      return { ok: true }
    }
  )

  /** 带一次性配对票据的网页地址（二维码与「在浏览器中打开 / 复制链接」共用）。 */
  const pairLink = (kind: 'pair' | 'link'): PhoneLinkResult => {
    const bot = phoneBot()
    if (!bot || !bot.enabled || !channel) return { ok: false, error: '请先启用 Deva 手机版。' }
    const s = settingsOf(bot)
    let base: string | null
    if (s.mode === 'lan') {
      const ip = lanAddresses()[0]
      base = ip ? `http://${ip}:${s.port}/` : null
      if (!base) return { ok: false, error: '没有找到可用的局域网地址，请检查网络连接。' }
    } else {
      base = relayPageUrl(relayUrlOf(s))
      if (!base) return { ok: false, error: '中转地址无效。' }
    }
    const t = issueTicket(kind)
    const q = new URLSearchParams({ d: s.deskId, p: formatTicket(t.id, t.secret), n: hostname().slice(0, 40) })
    return { ok: true, url: `${base}#${q.toString()}`, expiresAt: t.expiresAt }
  }

  ipcMain.handle('phone:qr', async (): Promise<PhoneQrResult> => {
    const r = pairLink('pair')
    if (!r.ok) return r
    return { ...r, qr: await QRCode.toDataURL(r.url, { margin: 1, width: 440, errorCorrectionLevel: 'M' }) }
  })

  // 不方便扫码时：直接在浏览器里打开网页版（本机或把链接发到手机上），链接 10 分钟内有效、只能用一次。
  ipcMain.handle('phone:link', (): PhoneLinkResult => pairLink('link'))

  ipcMain.handle('phone:qr-cancel', (): { ok: true } => {
    cancelPairTickets()
    return { ok: true }
  })

  ipcMain.handle('phone:remove-device', async (_e, did: unknown): Promise<{ ok: true }> => {
    const bot = phoneBot()
    if (typeof did === 'string' && bot) {
      channel?.dropDevice(did)
      await removeDevice(bot.id, did)
      push()
    }
    return { ok: true }
  })

  // 启动时：添加过且启用着就连上。
  void launch().catch((e) => console.warn('[remote/web] 手机访问启动失败：', (e as Error)?.message ?? e))
}

/** 「手机」面板上的状态（没添加时 added = false，其余为默认值）。 */
export function publicState(): PhoneState {
  const bot = phoneBot()
  const s = settingsOf(bot ?? ({ settings: {} } as BotConfig))
  if (!bot)
    return {
      added: false,
      enabled: false,
      mode: s.mode,
      relayUrl: s.relayUrl,
      port: s.port,
      officialUrl: OFFICIAL_RELAY_URL,
      status: { state: 'off' },
      devices: []
    }
  const online = channel?.onlineDevices() ?? new Set<string>()
  const devices: PhoneDeviceView[] = listDevices(bot.id)
    .map((d: PhoneDevice) => ({
      id: d.id,
      name: d.name || '手机',
      kind: d.kind,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: online.has(d.id),
      push: !!d.push
    }))
    .sort((a, b) => b.pairedAt - a.pairedAt)
  return {
    added: true,
    enabled: bot.enabled,
    mode: s.mode,
    relayUrl: s.relayUrl,
    port: s.port,
    officialUrl: OFFICIAL_RELAY_URL,
    status: bot.enabled ? (channel?.status ?? { state: 'connecting' }) : { state: 'off' },
    devices
  }
}
