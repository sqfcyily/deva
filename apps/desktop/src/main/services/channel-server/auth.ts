import { timingSafeEqual } from 'node:crypto'
import { getSecret } from '../secrets'
import { getGeneralServerConfig } from './config'

/**
 * Bearer token → deviceId 的解析。token 明文的进程内缓存（secrets.json 里是 safeStorage 密文，
 * 明文不出主进程——沿用 secrets.ts 的硬规则）。配对成功 / 吊销设备后调 invalidateTokenCache()。
 */

let cache: Map<string, string> | null = null

export function invalidateTokenCache(): void {
  cache = null
}

export async function deviceIdForToken(token: string): Promise<string | null> {
  const given = Buffer.from(token)
  if (!given.length) return null
  if (!cache) {
    cache = new Map()
    for (const d of getGeneralServerConfig().devices) {
      if (!d.enabled) continue // 单设备启停(审查 F1/F8):停用设备直接不算已知凭据
      const t = await getSecret(`general:${d.id}:token`)
      if (t) cache.set(t, d.id)
    }
  }
  // 恒等长 + 常时比较，不因字节数差异提前返回
  for (const [known, id] of cache) {
    const k = Buffer.from(known)
    if (k.length === given.length && timingSafeEqual(k, given)) return id
  }
  return null
}
