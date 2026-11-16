/**
 * 电脑端「手机」面板里「Deva 手机版」⇄ 主进程（services/remote/web/phone.ts）的数据形状。
 */

/** relay = 经中转（默认；地址留空 = Deva 官方中转）；lan = 仅局域网（不经过任何服务器）。 */
export type PhoneMode = 'relay' | 'lan'

export interface PhoneDeviceView {
  id: string
  name: string
  /** standalone = 主屏幕应用；browser = 浏览器标签页。 */
  kind?: 'browser' | 'standalone'
  pairedAt: number
  lastSeen?: number
  online: boolean
  /** 开了推送通知。 */
  push: boolean
}

export interface PhoneState {
  /** 添加过「Deva 手机版」（默认没有，最多一个）。 */
  added: boolean
  enabled: boolean
  mode: PhoneMode
  /** 自己的中转地址；空串 = 用 Deva 官方中转（不把官方地址写进配置，官方换地址时自动跟着换）。 */
  relayUrl: string
  port: number
  /** 官方中转地址（shared/remote-web.ts 的 OFFICIAL_RELAY_URL；空串 = 尚未开通）。 */
  officialUrl: string
  status: { state: 'off' | 'connecting' | 'on' | 'error'; error?: string }
  devices: PhoneDeviceView[]
}

export type PhoneQrResult = { ok: true; url: string; qr: string; expiresAt: number } | { ok: false; error: string }

/** 「在浏览器中打开 / 复制链接」：一次性链接（10 分钟内有效，不随二维码刷新作废）。 */
export type PhoneLinkResult = { ok: true; url: string; expiresAt: number } | { ok: false; error: string }

/** 有新手机扫码连上（面板上的二维码据此原地变成「已连接」）。 */
export interface PhonePairedEvent {
  id: string
  name: string
}
