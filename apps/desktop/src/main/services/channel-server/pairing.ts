import { randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'

/**
 * 通用设备的配对码（与 IM 通道的邀请码同构但独立）：6 位数字、5 分钟有效（设计 §3.2），
 * 只在桌面「远程设备」面板显示；新码生成即顶替旧码，配对成功即作废（一次性）。
 * 暴力猜测由限速兜底：同 IP 每分钟 10 次配对尝试，超限 429（server.ts 调 pairAttemptAllowed）。
 */

const PAIR_TTL_MS = 5 * 60_000
const PAIR_WINDOW_MS = 60_000
const PAIR_MAX_ATTEMPTS = 10

let current: { code: string; expiresAt: number } | null = null
/** 连续失败计数：≥20 即熔断配对接口，直到下次主动出码（审查 P1-7——多源地址绕过单 IP 限速的兜底）。 */
let failStreak = 0
const FAIL_STREAK_MAX = 20
/** 同 IP 的尝试时间戳（滑动窗口）。 */
const attempts = new Map<string, number[]>()

export function issuePairCode(): { code: string; expiresAt: number } {
  failStreak = 0 // 主动出码即解除熔断：只有桌面用户能出码
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  current = { code, expiresAt: Date.now() + PAIR_TTL_MS }
  return { ...current }
}

/** 取消配对：当前码立即作废（离开面板时调，与 IM 通道的 pairCancel 同语义）。 */
export function cancelPairCode(): void {
  current = null
}

/**
 * 配对码一次性原子消费：校验与作废在同一步同步完成（JS 单线程，无 await 间隙），
 * 并发同码配对有且只有一个成功——堵死「校验 → 异步落密钥 → 作废」窗口期的双重接入竞态。
 * 返回被消费码的原有效期（供 setSecret 失败后 restorePairCode 回滚）；未消费返回 null。
 */
export function consumePairCodeIfMatch(code: string): { expiresAt: number } | null {
  if (!current) return null
  if (current.expiresAt < Date.now()) {
    current = null
    return null
  }
  if (code !== current.code) return null
  const { expiresAt } = current
  current = null
  return { expiresAt }
}

/**
 * 配对成功后的密钥存储失败的回滚（§6 白烧码）：码在我们手里、期间不可能被别人消费——
 * 恢复原有效期，设备同码重试即得。仅当期间桌面未再出新码（current 仍为 null）才恢复；
 * 已出新码则丢弃（与旧行为一致，码死）。JS 单线程，判定与赋值无竞态。
 */
export function restorePairCode(code: string, expiresAt: number): void {
  if (current === null) current = { code, expiresAt }
}

/** 配对失败（码不对/已过期）记一次；连续失败触发全局熔断。 */
export function notePairFailure(): void {
  failStreak++
}

/** 滑动窗口限速 + 全局失败熔断；放行返回 true，超限 false（HTTP 429）。 */
export function pairAttemptAllowed(ip: string): boolean {
  if (failStreak >= FAIL_STREAK_MAX) return false
  const now = Date.now()
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
  attempts.set(ip, list)
  if (list.length >= PAIR_MAX_ATTEMPTS) return false
  list.push(now)
  // 表过大时清掉已出窗的旧 IP，防长期运行缓慢泄漏
  if (attempts.size > 1000)
    for (const [k, v] of attempts) if (v.length === 0 || now - v[v.length - 1] >= PAIR_WINDOW_MS) attempts.delete(k)
  return true
}

/** 局域网 IPv4 候选全集（多网卡/VPN 机器上第一个不一定可达，全部给 UI 让用户挑）。 */
export function lanHosts(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal && !out.includes(net.address)) out.push(net.address)
  return out
}

/** 局域网 IPv4（二维码里的 host）：取第一个非内部地址；拿不到则回退 127.0.0.1（同机调试仍可用）。 */
export function lanHost(): string {
  return lanHosts()[0] ?? '127.0.0.1'
}
