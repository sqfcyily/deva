import type { WebClientFrame, WebServerFrame } from '../../../../shared/remote-web'

/**
 * 一条手机端连接（来自内网 WebSocket 或中转转发），适配器只认这个形状，不关心它从哪条路来。
 */
export interface Conn {
  readonly via: 'lan' | 'relay'
  /** 来源描述（日志用：内网 ip / 中转连接 id）。 */
  readonly remote: string
  /** 鉴权通过后由适配器填上。 */
  user?: string
  send(frame: WebServerFrame): void
  close(): void
}

/** 传输层把连接交给适配器时拿到的回调。 */
export interface ConnHandlers {
  onFrame(frame: WebClientFrame): void
  onClose(): void
}

export interface ConnSink {
  attach(conn: Conn): ConnHandlers
}

/** 单帧大小上限（手机端只发文本与表单，远用不到这么大；防止异常客户端撑爆内存）。 */
export const MAX_FRAME_BYTES = 256 * 1024

export function parseClientFrame(raw: unknown): WebClientFrame | null {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES) return null
  try {
    const f = JSON.parse(raw) as WebClientFrame
    return f && typeof f === 'object' && typeof f.t === 'string' ? f : null
  } catch {
    return null
  }
}
