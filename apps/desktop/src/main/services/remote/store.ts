import { getConfig, setConfig } from '../config'
import type { ChannelId, Platform } from './types'

/**
 * 机器人实例的持久化配置（config.json → remote.bots[]，非敏感项；密钥另存 secrets.json，
 * 键 `remote:<botId>:<field>`，见 secrets.ts）。
 *
 * 结构平台无关：启用开关 / 已配对用户 / IM 会话 ↔ Deva 对话绑定 / 回复方式由 hub 统一管理；
 * 平台特有的非敏感参数（飞书 appId、域名 …）放 settings，由各适配器自行解释。
 */

export interface PairedUser {
  /** 平台用户 id（飞书 open_id）。 */
  id: string
  name?: string
  /**
   * 与该用户的私聊：通知（定时任务完成 / 无人跟随的对话在等决定）推到这里。
   * 扫码创建时只知道用户 id，空串表示还没建立私聊——连上后机器人主动打招呼即补上。
   */
  chatId: string
  pairedAt: number
}

/** stream = 流式更新同一张卡片；final = 只在需要你决定和回合结束时更新（少打扰）。 */
export type ReplyMode = 'stream' | 'final'

export interface BotConfig {
  id: ChannelId
  platform: Platform
  name: string
  enabled: boolean
  createdAt: number
  replyMode: ReplyMode
  users: PairedUser[]
  /** IM 私聊 chatId → 当前绑定的 Deva 对话 id。 */
  bindings: Record<string, string>
  settings: Record<string, unknown>
}

function readRemote(): Record<string, unknown> {
  const r = getConfig().remote
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
}

function normalize(raw: unknown): BotConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || c.platform !== 'feishu') return null
  const users = Array.isArray(c.users)
    ? (c.users as PairedUser[])
        .filter((u) => u && typeof u.id === 'string')
        .map((u) => ({ ...u, chatId: typeof u.chatId === 'string' ? u.chatId : '' }))
    : []
  const bindings: Record<string, string> = {}
  if (c.bindings && typeof c.bindings === 'object')
    for (const [k, v] of Object.entries(c.bindings as Record<string, unknown>))
      if (typeof v === 'string') bindings[k] = v
  return {
    id: c.id,
    platform: c.platform,
    name: typeof c.name === 'string' ? c.name : '',
    enabled: c.enabled === true,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    replyMode: c.replyMode === 'final' ? 'final' : 'stream',
    users,
    bindings,
    settings: c.settings && typeof c.settings === 'object' ? (c.settings as Record<string, unknown>) : {}
  }
}

export function listBots(): BotConfig[] {
  const bots = readRemote().bots
  return Array.isArray(bots) ? bots.map(normalize).filter((b): b is BotConfig => b !== null) : []
}

export function getBot(id: ChannelId): BotConfig | null {
  return listBots().find((b) => b.id === id) ?? null
}

function writeBots(bots: BotConfig[]): void {
  setConfig({ remote: { ...readRemote(), bots } })
}

export function addBot(bot: BotConfig): void {
  writeBots([...listBots().filter((b) => b.id !== bot.id), bot])
}

export function deleteBot(id: ChannelId): void {
  writeBots(listBots().filter((b) => b.id !== id))
}

/** 读-改-写某机器人配置；机器人已被删除则什么也不做。 */
export function updateBot(id: ChannelId, fn: (b: BotConfig) => BotConfig): BotConfig | null {
  const bots = listBots()
  const i = bots.findIndex((b) => b.id === id)
  if (i < 0) return null
  bots[i] = fn(bots[i])
  writeBots(bots)
  return bots[i]
}

/** 机器人配置（已删除时回落空配置：无用户、无绑定 → 一切鉴权与投递自然失效）。 */
export function getChannelConfig(id: ChannelId): BotConfig {
  return (
    getBot(id) ?? {
      id,
      platform: 'feishu',
      name: '',
      enabled: false,
      createdAt: 0,
      replyMode: 'stream',
      users: [],
      bindings: {},
      settings: {}
    }
  )
}

/** hub 用：改用户 / 绑定（与 updateBot 同，保留旧名以免 hub 关心「机器人」概念）。 */
export function updateChannelConfig(id: ChannelId, fn: (c: BotConfig) => BotConfig): void {
  updateBot(id, fn)
}
