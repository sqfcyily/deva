/**
 * 电脑端「手机」面板里「Deva 手机版」⇄ 主进程（services/remote/web/phone.ts）的数据形状。
 */

/**
 * 手机走哪条路连到这台电脑：relay = 经中转（地址留空 = Deva 官方中转）；lan = 局域网直连（不经过任何服务器）。
 * 扫码时选定（对比稿 design/phone-conn.html 方案 D）：手机网页从哪个地址打开就只走那一路，之后不会变。
 */
export type PhoneVia = 'relay' | 'lan'

/** 一条通道的运行状态：off = 没有手机在用、也没在扫码，不运行。 */
export interface PhoneLinkStatus {
  state: 'off' | 'connecting' | 'on' | 'error'
  error?: string
}

export interface PhoneDeviceView {
  id: string
  name: string
  /** standalone = 主屏幕应用；browser = 浏览器标签页。 */
  kind?: 'browser' | 'standalone'
  via: PhoneVia
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
  /** 扫码默认选的方式（上次选的）。 */
  lastVia: PhoneVia
  /** 两条通道各自的状态：有手机在用、或正在显示它的二维码时才运行。 */
  links: Record<PhoneVia, PhoneLinkStatus>
  devices: PhoneDeviceView[]
}

export type PhoneQrResult = { ok: true; url: string; qr: string; expiresAt: number } | { ok: false; error: string }

/** 「复制链接」：一次性链接（10 分钟内有效，不随二维码刷新作废）。 */
export type PhoneLinkResult = { ok: true; url: string; expiresAt: number } | { ok: false; error: string }

/** 有新手机扫码连上（面板上的二维码据此原地变成「已连接」）。 */
export interface PhonePairedEvent {
  id: string
  name: string
}
