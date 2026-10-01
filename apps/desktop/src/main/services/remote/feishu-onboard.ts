import * as lark from '@larksuiteoapi/node-sdk'

/**
 * 飞书扫码创建机器人：官方 SDK 的 registerApp（OAuth 2.0 设备授权，RFC 8628）。
 * 文档：https://open.larkoffice.com/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs
 *
 * 扫码 → 在飞书 App 的确认页里创建应用 → 拿到 App ID / Secret 与扫码人的 open_id。
 * 飞书 / Lark（国际版）租户由 SDK 自动切换域名；取消、过期也由 SDK 统一处理。
 */

/** 确认页预填的应用信息（用户仍可在页面上修改）。{user} 由飞书替换为扫码人的名字。 */
const APP_PRESET = {
  name: '{user}的 Deva',
  desc: '在飞书里和电脑上的 Deva 对话：查看回复、审批计划、接收定时任务结果。'
}

/**
 * 在平台默认模板之上追加的配置：显式声明 Deva 依赖的消息事件与卡片回调，
 * 免得默认模板哪天不再包含它们（只能追加，平台未开放时整段被忽略、走默认流程）。
 */
const APP_ADDONS = {
  events: { items: { tenant: ['im.message.receive_v1'] } },
  callbacks: { items: ['card.action.trigger'] }
}

export type ScanOutcome =
  | { kind: 'done'; appId: string; appSecret: string; openId?: string; domain: 'feishu' | 'lark' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

export interface FeishuScan {
  /** 二维码内容（飞书 App 扫码打开的链接）。 */
  url: string
  expiresAt: number
  /** 扫码结果（永不 reject）。 */
  outcome: Promise<ScanOutcome>
  cancel(): void
}

/** 开始一次扫码：二维码就绪即返回；拿不到二维码则抛错。 */
export async function startFeishuScan(): Promise<FeishuScan> {
  const ac = new AbortController()
  let onReady!: (info: { url: string; expireIn: number }) => void
  const ready = new Promise<{ url: string; expireIn: number }>((r) => (onReady = r))

  const outcome: Promise<ScanOutcome> = lark
    .registerApp({
      source: 'deva',
      signal: ac.signal,
      // 只新建：避免扫码人误选已有应用（其配置之后会被 Deva 的连接方式覆盖）。
      createOnly: true,
      appPreset: APP_PRESET,
      addons: APP_ADDONS,
      onQRCodeReady: onReady
    })
    .then(
      (r): ScanOutcome => ({
        kind: 'done',
        appId: r.client_id,
        appSecret: r.client_secret,
        openId: r.user_info?.open_id,
        domain: r.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
      }),
      (e: { code?: string; message?: string; description?: string }): ScanOutcome => {
        if (e?.code === 'access_denied') return { kind: 'denied' }
        if (e?.code === 'expired_token') return { kind: 'expired' }
        if (e?.code === 'abort') return { kind: 'cancelled' }
        return { kind: 'error', message: e?.description || e?.message || String(e) }
      }
    )

  // 二维码就绪前就结束了（多为网络错误）：把原因抛给界面。
  const info = await Promise.race([
    ready,
    outcome.then((o) => {
      throw new Error(o.kind === 'error' ? o.message : '飞书没有返回二维码')
    })
  ])
  return {
    url: info.url,
    expiresAt: Date.now() + info.expireIn * 1000,
    outcome,
    cancel: () => ac.abort()
  }
}
