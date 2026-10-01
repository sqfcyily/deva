import { ipcMain, type BrowserWindow } from 'electron'
import { randomInt } from 'node:crypto'
import QRCode from 'qrcode'
import { deleteSecret, getSecret, setSecret } from '../secrets'
import { FeishuAdapter, fetchFeishuBotName } from './feishu'
import { beginFeishuScan, waitFeishuScan } from './feishu-onboard'
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
import { addBot, deleteBot, getBot, listBots, updateBot, type BotConfig, type ReplyMode } from './store'
import type { ChannelId, ChannelState, Platform, RemoteAdapter } from './types'

/**
 * 机器人面板的 IPC 与生命周期。机器人只能扫码创建：扫码即创建应用、拿到凭据，扫码人自动成为
 * 已配对用户（白名单）。其他人要用，需机器人主人在面板里生成邀请码、对方在私聊里发 /pair。
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
  }
}

export interface BotView {
  id: ChannelId
  platform: Platform
  name: string
  /** 飞书 / Lark（国际版），列表上的小标签。 */
  region?: 'cn' | 'intl'
  enabled: boolean
  state: ChannelState
  error?: string
  replyMode: ReplyMode
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
        enabled: b.enabled,
        ...channelState(b.id),
        replyMode: b.replyMode,
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

interface Scan {
  cancelled: boolean
}
const scans = new Map<string, Scan>()

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
  ipcMain.handle(
    'remote:scan-start',
    async (
      _e,
      platform: Platform
    ): Promise<
      | { ok: true; scanId: string; qr: string; userCode?: string; expiresAt: number }
      | { ok: false; error: string }
    > => {
      if (platform !== 'feishu') return { ok: false, error: '暂不支持这个平台。' }
      let begin
      try {
        begin = await beginFeishuScan()
      } catch (e) {
        return { ok: false, error: `获取二维码失败：${(e as Error)?.message ?? e}` }
      }
      const scanId = genId('scan')
      const scan: Scan = { cancelled: false }
      scans.set(scanId, scan)
      void (async () => {
        const r = await waitFeishuScan(begin, () => scan.cancelled)
        scans.delete(scanId)
        if (r.kind !== 'done') {
          send('remote:scan', r.kind === 'error' ? { scanId, status: 'error', error: r.message } : { scanId, status: r.kind })
          return
        }
        const botId = genId('bot')
        const saved = await setSecret(SECRET_KEY(botId, 'appSecret'), r.appSecret)
        if (!saved.ok) {
          send('remote:scan', { scanId, status: 'error', error: '系统密钥存储不可用，无法安全保存机器人凭据。' })
          return
        }
        const name = await fetchFeishuBotName({ appId: r.appId, appSecret: r.appSecret, domain: r.domain })
        addBot({
          id: botId,
          platform: 'feishu',
          name: name || '飞书机器人',
          enabled: true,
          createdAt: Date.now(),
          replyMode: 'stream',
          // 扫码人即主人：直接进白名单。私聊 chatId 等连上后机器人主动打招呼时补上。
          users: r.openId ? [{ id: r.openId, chatId: '', pairedAt: Date.now() }] : [],
          bindings: {},
          settings: { appId: r.appId, domain: r.domain }
        })
        push()
        send('remote:scan', { scanId, status: 'done', botId })
        const err = await launch(botId)
        if (err) console.warn('[remote] 新机器人启动失败：', err)
      })()
      return {
        ok: true,
        scanId,
        qr: await QRCode.toDataURL(begin.url, { margin: 1, width: 360 }),
        userCode: begin.userCode,
        expiresAt: begin.expiresAt
      }
    }
  )

  ipcMain.handle('remote:scan-cancel', (_e, scanId: string): { ok: true } => {
    const s = scans.get(scanId)
    if (s) s.cancelled = true
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

  // 删除机器人：断开连接、清密钥与配置。飞书开放平台上的应用本身不受影响（可在开放平台自行删除）。
  ipcMain.handle('remote:delete-bot', async (_e, id: ChannelId): Promise<{ ok: true }> => {
    await stopChannel(id)
    await deleteSecret(SECRET_KEY(id, 'appSecret'))
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
