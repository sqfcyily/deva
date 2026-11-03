import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 网址规范化（browser 工具的 open 用）：补协议（本机 / 内网地址补 http，其余补 https）；
 * 本机路径转 file:；拒绝 javascript: / chrome: 等。无效返回 null。
 */
export function normalizeUrl(raw: string): string | null {
  let u = raw.trim()
  if (!u) return null
  if (u === '~' || u.startsWith('~/') || u.startsWith('~\\')) u = join(homedir(), u.slice(1))
  if (/^[a-zA-Z]:[\\/]/.test(u) || (isAbsolute(u) && !/^[a-z][a-z0-9+.-]*:/i.test(u)))
    return pathToFileURL(u).href
  if (/^(https?|file):/i.test(u)) {
    // 原样
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(javascript|data|chrome|devtools|about|view-source):/i.test(u)) {
    return null
  } else {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u)
    u = (local ? 'http://' : 'https://') + u
  }
  try {
    const p = new URL(u)
    return ['http:', 'https:', 'file:'].includes(p.protocol) ? p.href : null
  } catch {
    return null
  }
}
