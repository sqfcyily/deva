import type { WebServerFrame } from '../../../../shared/remote-web'

/**
 * 手机端连接的两层形状：
 *  · RawConn：传输层（内网 WebSocket / 中转转发）给出的「收发文本」连接，不关心内容；
 *  · Conn：加密握手完成后（secure.ts）交给适配器的连接，收发的是明文帧对象，发出时自动加密。
 */

export interface RawConn {
  readonly via: 'lan' | 'relay'
  /** 来源描述（日志用：内网 ip / 中转连接 id）。 */
  readonly remote: string
  sendText(text: string): void
  close(code?: number): void
}

export interface RawHandlers {
  onText(text: string): void
  onClose(): void
}

export interface RawSink {
  attach(conn: RawConn): RawHandlers
}

/** 握手用的是哪种凭据：pair = 扫码配对票据；install = 添加到主屏幕的安装票据；resume = 设备密钥。 */
export interface ConnAuth {
  kind: 'pair' | 'install' | 'resume'
  /** 票据 id 或设备 id。 */
  id: string
}

export interface Conn {
  readonly via: 'lan' | 'relay'
  readonly remote: string
  readonly auth: ConnAuth
  /** hello 之后由适配器填上：这条连接所属的设备 id。 */
  device?: string
  /** 页面是否在前台（visible 帧）。 */
  visible: boolean
  /** 正看着的对话（最近要过它的最新一页）：进行中有新内容直接推过去（见 adapter pushTurn）。 */
  viewing?: string
  send(frame: WebServerFrame): void
  close(): void
}

/** 适配器从安全层拿到的回调。 */
export interface ConnHandlers {
  onFrame(frame: { t: string } & Record<string, unknown>): void
  onClose(): void
}

export interface ConnSink {
  attach(conn: Conn): ConnHandlers
}
