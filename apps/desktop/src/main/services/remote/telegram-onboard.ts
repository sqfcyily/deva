import { randomBytes } from 'node:crypto'
import { TelegramError, tgCall, type TelegramMe, type TgUpdate } from './telegram'

/**
 * Telegram 认领机器人：Telegram 没有「扫码建应用」，机器人得先在 @BotFather 里建好、把 Token 粘进来。
 * 之后的「谁是主人」仍走扫码：二维码是 t.me/<机器人>?start=<一次性码>，手机扫码打开机器人、点 Start，
 * 客户端会发出 `/start <一次性码>`——收到即认定发送人为主人（拿到用户 id 与私聊 chat_id）。
 *
 * 一次性码 72 位随机、10 分钟有效，只出现在电脑屏幕上，别人猜不到也抢不走。
 */

const LINK_TTL_MS = 10 * 60_000

export type LinkOutcome =
  | { kind: 'done'; userId: string; userName?: string }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export interface TelegramLink {
  /** 二维码内容（t.me 深链接）。 */
  url: string
  expiresAt: number
  /** 认领结果（永不 reject）。 */
  outcome: Promise<LinkOutcome>
  cancel(): void
}

/** 开始等待主人点 Start（调用前先用 fetchTelegramMe 校验过 Token）。 */
export async function startTelegramLink(token: string, me: TelegramMe): Promise<TelegramLink> {
  // 设过 Webhook 的机器人收不到 getUpdates，先清掉（失败直接抛给界面）。
  await tgCall(token, 'deleteWebhook', { drop_pending_updates: false })
  const code = randomBytes(9).toString('base64url')
  const ac = new AbortController()
  const expiresAt = Date.now() + LINK_TTL_MS
  const re = new RegExp(`^/start(?:@${me.username})?\\s+${code}$`, 'i')

  const wait = async (): Promise<LinkOutcome> => {
    let offset = 0
    while (Date.now() < expiresAt) {
      if (ac.signal.aborted) return { kind: 'cancelled' }
      let updates: TgUpdate[]
      try {
        const left = Math.max(1, Math.min(25, Math.floor((expiresAt - Date.now()) / 1000)))
        updates = await tgCall<TgUpdate[]>(
          token,
          'getUpdates',
          { offset, timeout: left, allowed_updates: ['message'] },
          { signal: ac.signal, timeoutMs: (left + 15) * 1000 }
        )
      } catch (e) {
        if (ac.signal.aborted) return { kind: 'cancelled' }
        const err = e as TelegramError
        if (err.code === 401 || err.code === 404) return { kind: 'error', message: 'Token 已失效，请重新复制。' }
        if (err.code === 409)
          return { kind: 'error', message: '这个机器人正被其他程序占用（例如另一台电脑上的 Deva），请先停掉那边。' }
        // 网络抖动：稍后重试，直到过期。
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      for (const u of updates) {
        offset = u.update_id + 1
        const m = u.message
        if (!m?.from || m.from.is_bot || m.chat.type !== 'private' || !re.test((m.text ?? '').trim())) continue
        // 把已收的更新确认掉，免得机器人正式启动后再收一遍。
        await tgCall(token, 'getUpdates', { offset, timeout: 0 }).catch(() => undefined)
        const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ')
        return {
          kind: 'done',
          userId: String(m.from.id),
          userName: name || (m.from.username ? `@${m.from.username}` : undefined)
        }
      }
    }
    return { kind: 'expired' }
  }

  return {
    url: `https://t.me/${me.username}?start=${code}`,
    expiresAt,
    outcome: wait().catch((e): LinkOutcome => ({ kind: 'error', message: (e as Error)?.message ?? String(e) })),
    cancel: () => ac.abort()
  }
}
