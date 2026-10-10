import { ipcMain, type BrowserWindow } from 'electron'
import { randomInt } from 'node:crypto'
import QRCode from 'qrcode'
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
        users: b.users.map((u) => ({ id: u.id, name: u.name, pairedAt: u.pairedAt }))
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
          replyMode: 'stream',
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
    return { ok: true }
  })

  // 启动时自动连接已启用的机器人（失败只记日志 / 状态，不阻塞启动）。
  for (const b of listBots())
    if (b.enabled)
      void launch(b.id).then(
        (err) => err && console.warn(`[remote] ${b.name} 自动连接失败：`, err),
        (e) => console.warn(`[remote] ${b.name} 自动连接失败：`, (e as Error)?.message ?? e)
      )
}

export { stopAllChannels }
