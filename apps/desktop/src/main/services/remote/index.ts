import { ipcMain, type BrowserWindow } from 'electron'
import { randomBytes, randomInt } from 'node:crypto'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { isEn } from '../../locale'
import { getDevaHome } from '../config'
import { deleteSecretsByPrefix, getSecret, setSecret } from '../secrets'
import { FeishuAdapter, fetchFeishuBotName } from './feishu'
import { startFeishuScan } from './feishu-onboard'
import {
  cancelPairCode,
  channelState,
  initHub,
  issuePairCode,
  onHubChange,
  removePairedUser,
  startChannel,
  stopAllChannels,
  stopChannel
} from './hub'
import {
  DEFAULT_SCOPE,
  addBot,
  deleteBot,
  getBot,
  listBots,
  normalizeScope,
  updateBot,
  type BotConfig,
  type PairedUser,
  type ReplyMode,
  type ReplyScope
} from './store'
import { TelegramAdapter, fetchTelegramMe } from './telegram'
import { startTelegramLink } from './telegram-onboard'
import type { ChannelId, ChannelState, Platform, RemoteAdapter } from './types'
import { WebAdapter, type WebStatus } from './web/adapter'
import { relayPageUrl, relayWsBase } from './web/relay'
import { lanAddresses } from './web/server'

/**
 * 机器人面板的 IPC 与生命周期。机器人都经扫码创建，扫码人自动成为已配对用户（白名单）：
 *  · 飞书：扫码即在平台上创建应用、拿到凭据；
 *  · Telegram：先粘贴 @BotFather 给的 Token，再扫码打开机器人点 Start 认领（见 telegram-onboard.ts）。
 * 其他人要用，需机器人主人在面板里生成邀请码、对方在私聊里发 /pair。
 *
 * 新增平台：在 ADAPTERS 登记「从配置 + 密钥构造适配器」的工厂，再补一条扫码 / 授权流程。
 */

const SECRET_KEY = (id: ChannelId, field: string): string => `remote:${id}:${field}`

const ADAPTERS: Record<Platform, (bot: BotConfig) => Promise<RemoteAdapter | string>> = {
  feishu: async (bot) => {
    const appId = typeof bot.settings.appId === 'string' ? bot.settings.appId : ''
    const appSecret = await getSecret(SECRET_KEY(bot.id, 'appSecret'))
    if (!appId || !appSecret) return '机器人凭据丢失，请删除后重新扫码创建。'
    return new FeishuAdapter(bot.id, {
      appId,
      appSecret,
      domain: bot.settings.domain === 'lark' ? 'lark' : 'feishu'
    })
  },
  telegram: async (bot) => {
    const token = await getSecret(SECRET_KEY(bot.id, 'botToken'))
    if (!token) return '机器人 Token 丢失，请删除后重新添加。'
    return new TelegramAdapter(bot.id, { token })
  },
  web: async (bot) => {
    const w = webSettings(bot)
    const key = (await getSecret(SECRET_KEY(bot.id, 'deskKey'))) ?? ''
    if (w.relay.enabled && !key) return '中转密钥丢失，请删除后重新添加。'
    const adapter = new WebAdapter(bot.id, {
      port: w.port,
      lan: w.lan,
      relay: { enabled: w.relay.enabled, url: w.relay.url, deskId: w.deskId, key },
      logFile: join(getDevaHome(), 'remote', `web-${bot.id}.json`),
      botName: () => getBot(bot.id)?.name || 'Deva'
    })
    webAdapters.set(bot.id, adapter)
    return adapter
  }
}

// ───────── 手机网页 ─────────

/** 正在运行的网页适配器（按机器人 id），面板要读它的内网 / 中转状态。 */
const webAdapters = new Map<ChannelId, WebAdapter>()

const WEB_PORT_DEFAULT = 17800

export interface WebSettings {
  port: number
  lan: boolean
  relay: { enabled: boolean; url: string }
  deskId: string
}

function webSettings(bot: BotConfig): WebSettings {
  const s = bot.settings
  const relay = s.relay && typeof s.relay === 'object' ? (s.relay as Record<string, unknown>) : {}
  const port = typeof s.port === 'number' && s.port >= 1024 && s.port <= 65535 ? Math.floor(s.port) : WEB_PORT_DEFAULT
  return {
    port,
    lan: s.lan !== false,
    relay: { enabled: relay.enabled === true, url: typeof relay.url === 'string' ? relay.url : '' },
    deskId: typeof s.deskId === 'string' ? s.deskId : ''
  }
}

/** 面板展示的网页机器人信息（地址、各接入方式的状态）。 */
export interface WebInfo extends WebSettings {
  urls: string[]
  status: WebStatus
  relayPage: string | null
}

function webInfo(bot: BotConfig): WebInfo {
  const w = webSettings(bot)
  return {
    ...w,
    urls: lanAddresses().map((ip) => `http://${ip}:${w.port}/`),
    status: webAdapters.get(bot.id)?.getStatus() ?? { lan: 'off', relay: 'off' },
    relayPage: w.relay.url ? relayPageUrl(w.relay.url) : null
  }
}

export interface BotView {
  id: ChannelId
  platform: Platform
  name: string
  /** 飞书 / Lark（国际版），列表上的小标签。 */
  region?: 'cn' | 'intl'
  /** Telegram 机器人的 @用户名。 */
  username?: string
  enabled: boolean
  state: ChannelState
  error?: string
  replyMode: ReplyMode
  scope: ReplyScope
  users: { id: string; name?: string; pairedAt: number }[]
  /** 手机网页机器人才有。 */
  web?: WebInfo
}

function publicState(): { bots: BotView[] } {
  return {
    bots: listBots()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((b) => ({
        id: b.id,
        platform: b.platform,
        name: b.name,
        region: b.platform === 'feishu' ? (b.settings.domain === 'lark' ? 'intl' : 'cn') : undefined,
        username: typeof b.settings.username === 'string' ? b.settings.username : undefined,
        enabled: b.enabled,
        ...channelState(b.id),
        replyMode: b.replyMode,
        scope: b.scope,
        users: b.users.map((u) => ({ id: u.id, name: u.name, pairedAt: u.pairedAt })),
        web: b.platform === 'web' ? webInfo(b) : undefined
      }))
  }
}

/** 按配置启动机器人；返回错误文案或 null。 */
async function launch(id: ChannelId): Promise<string | null> {
  const bot = getBot(id)
  if (!bot) return '机器人不存在。'
  const made = await ADAPTERS[bot.platform](bot)
  if (typeof made === 'string') return made
  await startChannel(made)
  return null
}

// ───────── 扫码创建 ─────────

/** 扫码成功后要建的机器人（启用状态、回复方式等通用项由 scan-start 补齐）。 */
interface NewBot {
  platform: Platform
  name: string
  users: PairedUser[]
  settings: Record<string, unknown>
  /** 存进密钥库的字段（键 remote:<botId>:<字段>）。 */
  secrets: Record<string, string>
}

type ScanResult =
  | { kind: 'done'; bot: NewBot }
  | { kind: 'denied' | 'expired' | 'cancelled' }
  | { kind: 'error'; message: string }

interface Scan {
  /** 二维码内容。 */
  url: string
  expiresAt: number
  /** 扫码结果（永不 reject）。 */
  outcome: Promise<ScanResult>
  cancel(): void
}

/** 飞书：扫码即创建应用。 */
async function feishuScan(): Promise<Scan> {
  const scan = await startFeishuScan()
  return {
    ...scan,
    outcome: scan.outcome.then(async (r): Promise<ScanResult> => {
      if (r.kind !== 'done') return r
      const name = await fetchFeishuBotName({ appId: r.appId, appSecret: r.appSecret, domain: r.domain })
      return {
        kind: 'done',
        bot: {
          platform: 'feishu',
          name: name || 'Deva',
          // 扫码人即主人：直接进白名单。私聊 chatId 等连上后机器人主动打招呼时补上。
          users: r.openId ? [{ id: r.openId, chatId: '', pairedAt: Date.now() }] : [],
          settings: { appId: r.appId, domain: r.domain },
          secrets: { appSecret: r.appSecret }
        }
      }
    })
  }
}

/** Telegram：校验 Token，再等主人扫码点 Start。 */
async function telegramScan(rawToken: string): Promise<Scan> {
  const token = rawToken.trim()
  if (!/^\d+:[\w-]{20,}$/.test(token))
    throw new Error('Token 格式不对，应形如 123456789:AAH…，请从 @BotFather 完整复制。')
  const me = await fetchTelegramMe(token)
  // 同一个机器人只能有一处在收消息（getUpdates 互斥），重复添加只会互相挤掉。
  if (listBots().some((b) => b.platform === 'telegram' && b.settings.botId === me.id))
    throw new Error(`@${me.username} 已经添加过了。`)
  const link = await startTelegramLink(token, me)
  return {
    ...link,
    outcome: link.outcome.then((r): ScanResult => {
      if (r.kind !== 'done') return r
      return {
        kind: 'done',
        bot: {
          platform: 'telegram',
          name: me.first_name || me.username,
          // 认领人即主人。私聊 chatId 先留空，连上后机器人主动打招呼时补上（Telegram 私聊 chatId 即用户 id）。
          users: [{ id: r.userId, name: r.userName, chatId: '', pairedAt: Date.now() }],
          settings: { botId: me.id, username: me.username },
          secrets: { botToken: token }
        }
      }
    })
  }
}

/** 进行中的扫码（scanId → 取消函数）。 */
const scans = new Map<string, () => void>()

export type ScanEvent =
  | { scanId: string; status: 'done'; botId: string }
  | { scanId: string; status: 'denied' | 'expired' | 'cancelled' }
  | { scanId: string; status: 'error'; error: string }

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`
}

export function registerRemoteIpc(getWindow: () => BrowserWindow | null): void {
  initHub()

  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const push = (): void => send('remote:changed', publicState())
  onHubChange(push)

  ipcMain.handle('remote:get-state', () => publicState())

  // 开始扫码：返回二维码图片（data URL），后台轮询，结果经 remote:scan 事件推回。
  // Telegram 需带上 @BotFather 给的 Token（二维码用于认领主人）。
  ipcMain.handle(
    'remote:scan-start',
    async (
      _e,
      platform: Platform,
      opts?: { token?: string }
    ): Promise<
      | { ok: true; scanId: string; qr: string; link?: string; userCode?: string; expiresAt: number }
      | { ok: false; error: string }
    > => {
      let scan: Scan
      try {
        if (platform === 'feishu') scan = await feishuScan()
        else if (platform === 'telegram') scan = await telegramScan(opts?.token ?? '')
        else return { ok: false, error: '暂不支持这个平台。' }
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e)
        return { ok: false, error: platform === 'feishu' ? `获取二维码失败：${msg}` : msg }
      }
      const scanId = genId('scan')
      scans.set(scanId, scan.cancel)
      void (async () => {
        const r = await scan.outcome
        scans.delete(scanId)
        if (r.kind !== 'done') {
          send('remote:scan', r.kind === 'error' ? { scanId, status: 'error', error: r.message } : { scanId, status: r.kind })
          return
        }
        const botId = genId('bot')
        for (const [field, value] of Object.entries(r.bot.secrets)) {
          const saved = await setSecret(SECRET_KEY(botId, field), value)
          if (!saved.ok) {
            send('remote:scan', { scanId, status: 'error', error: '系统密钥存储不可用，无法安全保存机器人凭据。' })
            return
          }
        }
        addBot({
          id: botId,
          platform: r.bot.platform,
          name: r.bot.name,
          enabled: true,
          createdAt: Date.now(),
          replyMode: 'final',
          scope: DEFAULT_SCOPE,
          users: r.bot.users,
          bindings: {},
          settings: r.bot.settings
        })
        push()
        send('remote:scan', { scanId, status: 'done', botId })
        const err = await launch(botId)
        if (err) console.warn('[remote] 新机器人启动失败：', err)
      })()
      return {
        ok: true,
        scanId,
        qr: await QRCode.toDataURL(scan.url, { margin: 1, width: 360 }),
        // Telegram 的认领链接也可以直接在电脑上点开（装了桌面版 Telegram 时）。
        link: platform === 'telegram' ? scan.url : undefined,
        expiresAt: scan.expiresAt
      }
    }
  )

  ipcMain.handle('remote:scan-cancel', (_e, scanId: string): { ok: true } => {
    scans.get(scanId)?.()
    return { ok: true }
  })

  ipcMain.handle(
    'remote:set-enabled',
    async (_e, id: ChannelId, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      if (!getBot(id)) return { ok: false, error: '机器人不存在。' }
      if (enabled) {
        const err = await launch(id)
        if (err) return { ok: false, error: err }
      } else {
        await stopChannel(id)
      }
      updateBot(id, (b) => ({ ...b, enabled }))
      push()
      return { ok: true }
    }
  )

  ipcMain.handle('remote:set-reply-mode', (_e, id: ChannelId, mode: ReplyMode): { ok: true } => {
    updateBot(id, (b) => ({ ...b, replyMode: mode === 'final' ? 'final' : 'stream' }))
    push()
    return { ok: true }
  })

  ipcMain.handle('remote:set-scope', (_e, id: ChannelId, scope: ReplyScope): { ok: true } => {
    updateBot(id, (b) => ({ ...b, scope: normalizeScope(scope) }))
    push()
    return { ok: true }
  })

  // 删除机器人：断开连接、清密钥与配置。平台上的应用 / 机器人本身不受影响（可在飞书开放平台 / @BotFather 自行删除）。
  ipcMain.handle('remote:delete-bot', async (_e, id: ChannelId): Promise<{ ok: true }> => {
    await stopChannel(id)
    webAdapters.delete(id)
    await deleteSecretsByPrefix(SECRET_KEY(id, ''))
    deleteBot(id)
    push()
    return { ok: true }
  })

  ipcMain.handle('remote:pair-code', (_e, id: ChannelId) => issuePairCode(id))

  ipcMain.handle('remote:pair-cancel', (_e, id: ChannelId): { ok: true } => {
    cancelPairCode(id)
    return { ok: true }
  })

  ipcMain.handle('remote:remove-user', (_e, id: ChannelId, userId: string): { ok: true } => {
    removePairedUser(id, userId)
    webAdapters.get(id)?.dropUser(userId)
    return { ok: true }
  })

  // ───────── 手机网页 ─────────

  // 添加：不用扫码授权，立刻建好并启动；配对走面板上的二维码（一次性配对码）。
  ipcMain.handle('remote:web-create', async (): Promise<{ ok: true; botId: string } | { ok: false; error: string }> => {
    const botId = genId('bot')
    const key = randomBytes(32).toString('base64url')
    const saved = await setSecret(SECRET_KEY(botId, 'deskKey'), key)
    if (!saved.ok) return { ok: false, error: '系统密钥存储不可用，无法安全保存中转密钥。' }
    const used = new Set(listBots().filter((b) => b.platform === 'web').map((b) => webSettings(b).port))
    let port = WEB_PORT_DEFAULT
    while (used.has(port)) port++
    addBot({
      id: botId,
      platform: 'web',
      name: isEn() ? 'Phone web' : '手机网页',
      enabled: true,
      createdAt: Date.now(),
      replyMode: 'final',
      scope: DEFAULT_SCOPE,
      users: [],
      bindings: {},
      settings: { port, lan: true, relay: { enabled: false, url: '' }, deskId: randomBytes(8).toString('hex') }
    })
    push()
    const err = await launch(botId)
    if (err) console.warn('[remote] 手机网页启动失败：', err)
    push()
    return { ok: true, botId }
  })

  // 二维码：地址 + 一次性配对码（10 分钟有效），手机打开页面即自动配对。
  ipcMain.handle(
    'remote:web-qr',
    async (
      _e,
      id: ChannelId,
      via: 'lan' | 'relay',
      urlOverride?: string
    ): Promise<{ ok: true; url: string; qr: string; code: string; expiresAt: number } | { ok: false; error: string }> => {
      const bot = getBot(id)
      if (!bot || bot.platform !== 'web') return { ok: false, error: '机器人不存在。' }
      const w = webInfo(bot)
      let base: string
      if (via === 'relay') {
        if (!w.relayPage) return { ok: false, error: '请先填写中转地址。' }
        base = `${w.relayPage}#d=${encodeURIComponent(w.deskId)}&`
      } else {
        const url = urlOverride && w.urls.includes(urlOverride) ? urlOverride : w.urls[0]
        if (!url) return { ok: false, error: '没有找到可用的局域网地址，请检查网络连接。' }
        base = `${url}#`
      }
      const { code, expiresAt } = issuePairCode(id)
      const url = `${base}c=${code}`
      return { ok: true, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 360 }), code, expiresAt }
    }
  )

  // 改接入设置（端口 / 内网开关 / 中转）：启用中的机器人按新设置重启。
  ipcMain.handle(
    'remote:web-update',
    async (
      _e,
      id: ChannelId,
      patch: { port?: number; lan?: boolean; relay?: { enabled?: boolean; url?: string } }
    ): Promise<{ ok: boolean; error?: string }> => {
      const bot = getBot(id)
      if (!bot || bot.platform !== 'web') return { ok: false, error: '机器人不存在。' }
      const cur = webSettings(bot)
      const next: WebSettings = {
        ...cur,
        relay: { ...cur.relay, ...(patch.relay ?? {}) }
      }
      if (typeof patch.port === 'number') {
        if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)
          return { ok: false, error: '端口须在 1024–65535 之间。' }
        next.port = patch.port
      }
      if (typeof patch.lan === 'boolean') next.lan = patch.lan
      next.relay.url = next.relay.url.trim()
      if (next.relay.enabled && !relayWsBase(next.relay.url))
        return { ok: false, error: '中转地址无效，应形如 https://relay.example.com' }
      updateBot(id, (b) => ({
        ...b,
        settings: { ...b.settings, port: next.port, lan: next.lan, relay: next.relay }
      }))
      if (bot.enabled) {
        const err = await launch(id)
        push()
        if (err) return { ok: false, error: err }
      }
      push()
      return { ok: true }
    }
  )

  // 启动时自动连接已启用的机器人（失败只记日志 / 状态，不阻塞启动）。
  for (const b of listBots())
    if (b.enabled)
      void launch(b.id).then(
        (err) => err && console.warn(`[remote] ${b.name} 自动连接失败：`, err),
        (e) => console.warn(`[remote] ${b.name} 自动连接失败：`, (e as Error)?.message ?? e)
      )
}

export { stopAllChannels }
