/**
 * 服务商的自定义请求头（设置 › 模型 › 服务商详情里填写，存 config.json 的 `models.providers[].headers`）——
 * 渲染层（编辑时逐行校验）与主进程（发请求前整理）共用的纯函数模块，不依赖 Node / DOM。
 *
 * 用途：个别中转 / 企业网关按请求头识别客户端或租户（如要求 `originator`、指定的 `user-agent`，issue #77），
 * 官方端点也有可选头（`anthropic-beta`、`openai-organization`）。用户填的头并在本应用默认头之后，同名即覆盖。
 */

/**
 * 不允许经自定义请求头设置的名字（小写）：
 *  · 鉴权头由「API 密钥」一栏负责，两处都能填会互相覆盖、出了问题难排查；
 *  · 其余由请求正文与网络栈决定，改了只会让请求发不出去。
 */
export const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'content-length',
  'host',
  'connection',
  'transfer-encoding'
])

/** 单个服务商最多保留的自定义请求头条数（防手改配置塞进成百上千条）。 */
export const MAX_CUSTOM_HEADERS = 32

/** HTTP 头名的合法字符（RFC 9110 token）。 */
const NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** 头值只收可见 ASCII 与空格 / 制表符：fetch 遇到其余字符会直接抛错，整条请求都发不出去。 */
const VALUE_RE = /^[\t\x20-\x7e]*$/

/** 一条请求头不能用的原因：名字非法 / 名字被保留 / 值含不支持的字符。 */
export type HeaderIssue = 'name' | 'reserved' | 'value'

/** 校验一条请求头（名、值均先去首尾空白）；可用返回 null。空名 / 空值不算问题，整理时直接略过。 */
export function headerIssue(name: string, value: string): HeaderIssue | null {
  const n = name.trim()
  if (n && !NAME_RE.test(n)) return 'name'
  if (RESERVED_HEADERS.has(n.toLowerCase())) return 'reserved'
  if (!VALUE_RE.test(value.trim())) return 'value'
  return null
}

/**
 * 把任意来源（界面草稿 / 手改过的 config.json）的请求头整理成可直接并进 fetch headers 的表：
 * 名字转小写（与本应用默认头同一写法，同名才能覆盖而不是并排发两条）、去首尾空白，
 * 略过空名 / 空值 / 不合法 / 被保留的条目，永不抛错。
 */
export function sanitizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let count = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    const name = k.trim().toLowerCase()
    const value = v.trim()
    if (!name || !value || headerIssue(name, value)) continue
    if (!(name in out) && ++count > MAX_CUSTOM_HEADERS) break
    out[name] = value
  }
  return out
}
