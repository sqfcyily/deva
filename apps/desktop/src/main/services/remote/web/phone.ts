import { ipcMain, type BrowserWindow } from 'electron'
import { randomBytes, randomInt } from 'node:crypto'
import { hostname } from 'node:os'
import QRCode from 'qrcode'
import { formatTicket } from '../../../../shared/remote-crypto'
import { OFFICIAL_RELAY_URL } from '../../../../shared/remote-web'
import type { PhoneDeviceView, PhoneLinkResult, PhoneLinkStatus, PhoneQrResult, PhoneState, PhoneVia } from '../../../../shared/phone'
import { isEn } from '../../../locale'
import { deleteSecretsByPrefix, getSecret, setSecret } from '../../secrets'
import { onHubChange, startChannel, stopChannel } from '../hub'
import { DEFAULT_SCOPE, addBot, deleteBot, getBot, listBots, updateBot, type BotConfig } from '../store'
import type { AdapterHost, ChannelId } from '../types'
import { PhoneAdapter, removeDevice } from './adapter'
import type { RawSink } from './conn'
import { cancelPairTickets, consumeTicket, deviceKey, failTicket, issueTicket, listDevices, ticketSecret, type PhoneDevice } from './devices'
import { createSecureGate, type SecretResult } from './secure'
import { relayPageUrl, startRelayClient, type RelayClient } from './relay'
import { lanAddresses, startLanServer, type LanServer } from './server'

/**
 * Deva 手机版的电脑端入口（单例）：「手机」面板（图标栏左下角）里的「Deva 手机版」。
 *
 * 存为一个 platform = 'web' 的机器人（hub 往它推交互卡与通知，已配对用户 = 设备），用户在面板的 + 里添加后才有，最多一个。
 *
 * 连接方式在扫码时选（对比稿 design/phone-conn.html 方案 D）：中转（地址留空 = Deva 官方中转）或局域网直连。
 * 手机网页从哪个地址打开就只走那一路，所以「走哪条路」是设备的属性（PhoneDevice.via），不是全局开关。
 * 两条通道按需运行：有手机走它、或正在显示它的二维码 / 复制的链接还没过期时才开；最后一台局域网手机移除后端口自动关闭。
 *
 * 配对：二维码 = 中转页面（或局域网地址）+ 桌面 id + 一次性配对票据，手机扫码打开即自动连接（不用输任何东西）。
 */

const WEB_PORT_DEFAULT = 17800
/** 二维码 / 链接到期后通道再开这么久：刚扫上的手机可能还在加载页面。 */
const HOLD_GRACE_MS = 30_000
/** 二维码收起后通道再留这么久才关。 */
const RELEASE_DELAY_MS = 5_000
const SECRET_KEY = (id: ChannelId, field: string): string => `remote:${id}:${field}`

interface PhoneSettings {
  relayUrl: string
  port: number
  deskId: string
  /** 扫码默认选的方式（上次选的）。 */
  lastVia: PhoneVia
}

function settingsOf(bot: BotConfig): PhoneSettings {
  const s = bot.settings
  const legacyRelay = s.relay && typeof s.relay === 'object' ? (s.relay as Record<string, unknown>) : null
  // 旧版：mode = official / custom / relay / lan（二选一）；更早的「手机网页」开了中转的算自建中转。
  const relayUrl =
    s.mode === 'official'
      ? ''
      : typeof s.relayUrl === 'string'
        ? s.relayUrl
        : legacyRelay?.enabled === true && typeof legacyRelay.url === 'string'
          ? legacyRelay.url
          : ''
  return {
    relayUrl,
    port: typeof s.port === 'number' && s.port >= 1024 && s.port <= 65535 ? Math.floor(s.port) : WEB_PORT_DEFAULT,
    deskId: typeof s.deskId === 'string' && s.deskId ? s.deskId : randomBytes(8).toString('hex'),
    lastVia: s.lastVia === 'lan' || s.lastVia === 'relay' ? s.lastVia : s.mode === 'lan' ? 'lan' : 'relay'
  }
}

/** 设备走哪条路（旧数据迁移时已补上，缺省按中转）。 */
function viaOf(d: PhoneDevice): PhoneVia {
  return d.via === 'lan' ? 'lan' : 'relay'
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
  const old = cur.settings
  const legacy = 'mode' in old || 'relay' in old || 'lan' in old || 'tokens' in old
  if (legacy || old.relayUrl !== s.relayUrl || old.port !== s.port || old.deskId !== s.deskId || old.lastVia !== s.lastVia) {
    // 旧版只运行一种连接方式：已连接的手机都走它，补上 via。
    const oldVia: PhoneVia = old.mode === 'lan' ? 'lan' : 'relay'
    updateBot(cur.id, (b) => ({
      ...b,
      scope: DEFAULT_SCOPE,
      settings: { ...s },
      users: b.users.map((u) => ((u as PhoneDevice).via ? u : ({ ...u, via: oldVia } as PhoneDevice)))
    }))
    return getBot(cur.id) ?? cur
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

// ───────── 运行时 ─────────

const OFF: PhoneLinkStatus = { state: 'off' }

/** 正在运行的手机通道（启用时才有）：中转、局域网两条通道按需启停。 */
class PhoneChannel extends PhoneAdapter {
  links: Record<PhoneVia, PhoneLinkStatus> = { relay: OFF, lan: OFF }
  private hub: AdapterHost | null = null
  private gate: RawSink | null = null
  private relay: RelayClient | null = null
  /** 每开一次中转加一：旧客户端关掉后（或同步回调早于赋值时）的状态回调据此认出来。 */
  private relayGen = 0
  private lan: LanServer | null = null
  private closed = false
  /** 扫码（qr）/ 复制的链接（link）要求通道开到什么时候。 */
  private holds: Record<PhoneVia, { qr: number; link: number }> = { relay: { qr: 0, link: 0 }, lan: { qr: 0, link: 0 } }
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /** 启停一律串行，免得两次调整交错。 */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    id: ChannelId,
    private settings: PhoneSettings,
    private onStatus: () => void,
    onDevicesChanged: () => void,
    onPaired: (did: string) => void
  ) {
    super(id, { deskId: settings.deskId, onDevicesChanged, onPaired })
  }

  async start(host: AdapterHost): Promise<void> {
    await super.start(host)
    this.hub = host
    this.closed = false
    const id = this.id
    this.gate = createSecureGate({
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
    this.report()
    await this.sync()
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    await this.queue
    this.relayGen++
    this.relay?.close()
    this.relay = null
    const lan = this.lan
    this.lan = null
    await super.stop()
    if (lan) await lan.close()
  }

  /** 设备增删（扫码配对、移除、手机自己断开）：顺带按设备启停通道。 */
  protected override devicesChanged(): void {
    super.devicesChanged()
    void this.sync()
  }

  /** 扫码 / 复制链接：让这条通道开到票据过期之后。扫码换了方式时，另一条不再为扫码开着。 */
  hold(via: PhoneVia, kind: 'qr' | 'link', until: number): Promise<void> {
    if (kind === 'qr') {
      this.holds.relay.qr = 0
      this.holds.lan.qr = 0
      this.holds[via].qr = until + HOLD_GRACE_MS
    } else this.holds[via].link = Math.max(this.holds[via].link, until + HOLD_GRACE_MS)
    return this.sync()
  }

  /**
   * 二维码收起：通道不再为扫码开着（复制出去的链接照旧）。留几秒再关：
   * 「再连一台」、切回这个页面等马上又要出码的情况不必重连一遍。
   */
  releaseQr(): Promise<void> {
    const soon = Date.now() + RELEASE_DELAY_MS
    this.holds.relay.qr = Math.min(this.holds.relay.qr, soon)
    this.holds.lan.qr = Math.min(this.holds.lan.qr, soon)
    return this.sync()
  }

  /** 重试：只重启出错的通道。 */
  retry(): Promise<void> {
    return this.serial(async () => {
      if (this.links.relay.state === 'error') await this.closeLink('relay')
      if (this.links.lan.state === 'error') await this.closeLink('lan')
      await this.reconcile()
    })
  }

  /** 按「有没有手机在用 / 是否在扫码」启停两条通道。 */
  sync(): Promise<void> {
    return this.serial(() => this.reconcile())
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch((e) => console.warn('[remote/web] 手机通道调整失败：', (e as Error)?.message ?? e))
    return this.queue
  }

  private wanted(via: PhoneVia): boolean {
    const now = Date.now()
    const h = this.holds[via]
    return h.qr > now || h.link > now || listDevices(this.id).some((d) => viaOf(d) === via)
  }

  private async reconcile(): Promise<void> {
    if (this.closed || !this.gate) return
    for (const via of ['relay', 'lan'] as const) {
      const running = via === 'relay' ? !!this.relay : !!this.lan
      if (!this.wanted(via)) {
        if (running || this.links[via].state !== 'off') await this.closeLink(via)
      } else if (!running && this.links[via].state !== 'error') {
        // 出错的（端口被占用、密钥库不可用）不自动反复重试，等用户点重试或改设置。
        await (via === 'relay' ? this.openRelay() : this.openLan())
      }
    }
    this.scheduleHoldExpiry()
  }

  private async openRelay(): Promise<void> {
    const url = this.settings.relayUrl || OFFICIAL_RELAY_URL
    if (!url) return this.setLink('relay', 'error', '还没有可用的中转地址，请填写自己部署的中转地址，或改用局域网连接。')
    const key = await deskKey(this.id)
    if (!key) return this.setLink('relay', 'error', '系统密钥存储不可用，无法安全保存中转密钥。')
    if (this.closed || !this.gate) return
    this.setLink('relay', 'connecting')
    const gen = ++this.relayGen
    this.relay = startRelayClient({
      url,
      deskId: this.settings.deskId,
      key,
      sink: this.gate,
      onState: (state, error) => {
        if (gen === this.relayGen) this.setLink('relay', state, state === 'error' ? error : undefined)
      }
    })
  }

  private async openLan(): Promise<void> {
    if (!this.gate) return
    this.setLink('lan', 'connecting')
    try {
      this.lan = await startLanServer(this.settings.port, this.gate)
      this.setLink('lan', 'on')
    } catch (e) {
      this.setLink('lan', 'error', (e as Error)?.message ?? String(e))
    }
  }

  private async closeLink(via: PhoneVia): Promise<void> {
    if (via === 'relay') {
      const relay = this.relay
      this.relay = null
      this.relayGen++
      relay?.close()
    } else {
      const lan = this.lan
      this.lan = null
      if (lan) await lan.close()
    }
    this.setLink(via, 'off')
  }

  /** 扫码 / 链接的保留期到了就再调整一次（通道可能该关了）。 */
  private scheduleHoldExpiry(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    const now = Date.now()
    const next = Math.min(
      ...(['relay', 'lan'] as const).flatMap((v) => [this.holds[v].qr, this.holds[v].link]).filter((t) => t > now),
      Infinity
    )
    if (next !== Infinity) this.holdTimer = setTimeout(() => void this.sync(), next - now + 50)
  }

  private setLink(via: PhoneVia, state: PhoneLinkStatus['state'], error?: string): void {
    this.links = { ...this.links, [via]: { state, error } }
    this.report()
    this.onStatus()
  }

  /** 报给 hub 的总状态：有通道出错算出错，有通道在连算连接中。 */
  private report(): void {
    const ls = [this.links.relay, this.links.lan]
    const err = ls.find((l) => l.state === 'error')
    this.hub?.onState(err ? 'error' : ls.some((l) => l.state === 'connecting') ? 'connecting' : 'connected', err?.error)
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

  ipcMain.handle('phone:retry', async (): Promise<{ ok: true }> => {
    await channel?.retry()
    return { ok: true }
  })

  /** 带一次性配对票据的网页地址（二维码与「复制链接」共用）：按所选方式给中转页面或局域网地址。 */
  const pairLink = async (kind: 'pair' | 'link', viaArg: unknown): Promise<PhoneLinkResult> => {
    const bot = phoneBot()
    if (!bot || !bot.enabled || !channel) return { ok: false, error: '请先启用 Deva 手机版。' }
    const via: PhoneVia = viaArg === 'lan' ? 'lan' : 'relay'
    const s = settingsOf(bot)
    let base: string | null
    if (via === 'lan') {
      const ip = lanAddresses()[0]
      base = ip ? `http://${ip}:${s.port}/` : null
      if (!base) return { ok: false, error: '没有找到可用的局域网地址，请检查网络连接。' }
    } else {
      base = relayPageUrl(s.relayUrl || OFFICIAL_RELAY_URL)
      if (!base) return { ok: false, error: '中转地址无效。' }
    }
    // 记下这次选的方式：下次扫码默认还用它。
    if (s.lastVia !== via) updateBot(bot.id, (b) => ({ ...b, settings: { ...b.settings, lastVia: via } }))
    const t = issueTicket(kind)
    await channel.hold(via, kind === 'pair' ? 'qr' : 'link', t.expiresAt)
    const q = new URLSearchParams({ d: s.deskId, p: formatTicket(t.id, t.secret), n: hostname().slice(0, 40) })
    return { ok: true, url: `${base}#${q.toString()}`, expiresAt: t.expiresAt }
  }

  ipcMain.handle('phone:qr', async (_e, via: unknown): Promise<PhoneQrResult> => {
    const r = await pairLink('pair', via)
    if (!r.ok) return r
    return { ...r, qr: await QRCode.toDataURL(r.url, { margin: 1, width: 440, errorCorrectionLevel: 'M' }) }
  })

  // 不方便扫码时：复制一次性链接（发到手机上点开，或在别的设备的浏览器里打开），10 分钟内有效、只能用一次。
  ipcMain.handle('phone:link', (_e, via: unknown): Promise<PhoneLinkResult> => pairLink('link', via))

  ipcMain.handle('phone:qr-cancel', async (): Promise<{ ok: true }> => {
    cancelPairTickets()
    await channel?.releaseQr()
    return { ok: true }
  })

  ipcMain.handle('phone:remove-device', async (_e, did: unknown): Promise<{ ok: true }> => {
    const bot = phoneBot()
    if (typeof did === 'string' && bot) {
      channel?.dropDevice(did)
      await removeDevice(bot.id, did)
      await channel?.sync()
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
  // 中转地址、局域网端口不在界面上显示和修改，只在配置文件里改（apps/relay/README.md）。
  const base = { lastVia: s.lastVia }
  if (!bot) return { added: false, enabled: false, ...base, links: { relay: OFF, lan: OFF }, devices: [] }
  const online = channel?.onlineDevices() ?? new Set<string>()
  const devices: PhoneDeviceView[] = listDevices(bot.id)
    .map((d: PhoneDevice) => ({
      id: d.id,
      name: d.name || '手机',
      kind: d.kind,
      via: viaOf(d),
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: online.has(d.id),
      push: !!d.push
    }))
    .sort((a, b) => b.pairedAt - a.pairedAt)
  return {
    added: true,
    enabled: bot.enabled,
    ...base,
    links: bot.enabled && channel ? { ...channel.links } : { relay: OFF, lan: OFF },
    devices
  }
}
