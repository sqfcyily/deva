/**
 * 飞书扫码创建机器人（设备授权式的应用注册）。
 *
 * 流程与飞书官方 OpenClaw 接入工具（@larksuite/openclaw-lark-tools）一致：
 *   init  → 确认支持 client_secret 方式
 *   begin → 拿到二维码链接（verification_uri_complete）与 device_code
 *   poll  → 用户在飞书 App 里扫码确认后，返回新应用的 App ID / Secret 与扫码人的 open_id
 * 创建出的是「个人智能体」类型的自建应用，机器人能力与消息事件（长连接）已预先配好，用户不必去开放平台。
 *
 * 注意：此接口未见公开文档（官方工具在用），返回字段以官方工具的用法为准；出错时把原始错误交给界面。
 */

const BASE = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com'
} as const

type Domain = keyof typeof BASE

async function call(domain: Domain, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE[domain]}/oauth/v1/app/registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000)
  })
  // 轮询中的「还没扫 / 慢一点」也走非 2xx，错误信息在 JSON 里，统一按 JSON 读。
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok && typeof data.error !== 'string') throw new Error(`HTTP ${res.status}`)
  return data
}

export interface ScanBegin {
  deviceCode: string
  /** 二维码内容（飞书 App 扫码打开的链接）。 */
  url: string
  /** 用户码（部分版本返回，展示给用户核对）。 */
  userCode?: string
  intervalSec: number
  expiresAt: number
}

export async function beginFeishuScan(): Promise<ScanBegin> {
  const init = await call('feishu', { action: 'init' })
  const methods = Array.isArray(init.supported_auth_methods) ? init.supported_auth_methods : []
  if (!methods.includes('client_secret')) throw new Error('飞书暂不支持这种创建方式，请稍后再试。')
  const r = await call('feishu', {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id'
  })
  const uri = typeof r.verification_uri_complete === 'string' ? r.verification_uri_complete : ''
  const deviceCode = typeof r.device_code === 'string' ? r.device_code : ''
  if (!uri || !deviceCode) throw new Error(`飞书没有返回二维码（${String(r.error ?? '未知错误')}）`)
  const url = new URL(uri)
  url.searchParams.set('from', 'onboard')
  const expireIn = typeof r.expire_in === 'number' ? r.expire_in : 600
  return {
    deviceCode,
    url: url.toString(),
    userCode: typeof r.user_code === 'string' ? r.user_code : undefined,
    intervalSec: typeof r.interval === 'number' && r.interval > 0 ? r.interval : 5,
    expiresAt: Date.now() + expireIn * 1000
  }
}

export type ScanOutcome =
  | { kind: 'done'; appId: string; appSecret: string; openId?: string; domain: Domain }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

/** 轮询直到用户确认 / 拒绝 / 过期 / 被取消。 */
export async function waitFeishuScan(begin: ScanBegin, isCancelled: () => boolean): Promise<ScanOutcome> {
  let domain: Domain = 'feishu'
  let interval = begin.intervalSec
  const sleep = async (sec: number): Promise<void> => {
    const until = Date.now() + sec * 1000
    while (Date.now() < until && !isCancelled()) await new Promise((r) => setTimeout(r, 250))
  }
  while (Date.now() < begin.expiresAt) {
    await sleep(interval)
    if (isCancelled()) return { kind: 'cancelled' }
    let r: Record<string, unknown>
    try {
      r = await call(domain, { action: 'poll', device_code: begin.deviceCode })
    } catch {
      continue // 网络抖动：下一轮再问
    }
    const user = (r.user_info && typeof r.user_info === 'object' ? r.user_info : {}) as Record<string, unknown>
    // Lark（国际版）租户：换到国际域名重新取结果。
    if (user.tenant_brand === 'lark' && domain === 'feishu') {
      domain = 'lark'
      continue
    }
    if (typeof r.client_id === 'string' && typeof r.client_secret === 'string')
      return {
        kind: 'done',
        appId: r.client_id,
        appSecret: r.client_secret,
        openId: typeof user.open_id === 'string' ? user.open_id : undefined,
        domain
      }
    const err = typeof r.error === 'string' ? r.error : ''
    if (err === 'authorization_pending' || !err) continue
    if (err === 'slow_down') {
      interval += 5
      continue
    }
    if (err === 'access_denied') return { kind: 'denied' }
    if (err === 'expired_token') return { kind: 'expired' }
    return { kind: 'error', message: `${err}${r.error_description ? `：${String(r.error_description)}` : ''}` }
  }
  return { kind: 'expired' }
}
