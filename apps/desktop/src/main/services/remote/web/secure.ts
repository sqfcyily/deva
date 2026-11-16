import { CRYPTO_VERSION, deskAccept, isPhoneHi, type SealedFrame, type SecureChannel } from '../../../../shared/remote-crypto'
import { MAX_FRAME_CHARS, type WebPlainServerFrame } from '../../../../shared/remote-web'
import type { Conn, ConnAuth, ConnHandlers, ConnSink, RawConn, RawHandlers, RawSink } from './conn'

/**
 * 安全层：传输层（内网 / 中转）给来的每条连接先在这里做端到端加密握手（shared/remote-crypto.ts），
 * 第一帧密文解开（证明对方确实持有票据 / 设备密钥）后才交给适配器；之后收发都经这条通道加解密。
 *
 * 握手前只认明文的 hi 与 ping；握手后只认密文帧 { t:'x' } 与 ping。任何一帧解不开就断开。
 */

export type SecretResult = { secret: Uint8Array } | { error: string; removed?: boolean }

export interface GateOptions {
  /** 按凭据查共享密钥：票据过期 / 用过、设备已移除时给出可直接展示的原因。 */
  lookup(auth: ConnAuth): Promise<SecretResult>
  /** 第一帧密文解开：对方确实持有密钥（一次性票据此时作废）。 */
  onProven(auth: ConnAuth): void
  /** 第一帧解不开：对方拿着错的密钥（票据累计失败次数）。 */
  onFailed(auth: ConnAuth): void
  sink: ConnSink
}

/** 握手（含第一帧密文）必须在这段时间内完成。 */
const AUTH_TIMEOUT_MS = 15_000

export function createSecureGate(opts: GateOptions): RawSink {
  return {
    attach(raw: RawConn): RawHandlers {
      let auth: ConnAuth | null = null
      let channel: SecureChannel | null = null
      let pending = false
      let inner: ConnHandlers | null = null
      let closed = false

      const plain = (f: WebPlainServerFrame): void => raw.sendText(JSON.stringify(f))
      const shut = (): void => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        raw.close()
      }
      const timer = setTimeout(() => {
        if (!inner) shut()
      }, AUTH_TIMEOUT_MS)

      const onHi = async (hi: unknown): Promise<void> => {
        if (!isPhoneHi(hi)) return shut()
        if (hi.v !== CRYPTO_VERSION) {
          plain({ t: 'err', code: 'version', message: '手机网页与电脑端 Deva 的版本不匹配，请刷新页面或更新电脑上的 Deva。' })
          return shut()
        }
        pending = true
        const a: ConnAuth = { kind: hi.k, id: hi.id }
        let r: SecretResult
        try {
          r = await opts.lookup(a)
        } catch (e) {
          r = { error: `电脑端出错：${(e as Error)?.message ?? e}` }
        }
        pending = false
        if (closed) return
        if ('error' in r) {
          plain({ t: 'err', code: 'auth', message: r.error, removed: r.removed })
          return shut()
        }
        const acc = deskAccept(hi, r.secret)
        if (!acc) return shut()
        auth = a
        channel = acc.channel
        plain(acc.reply)
      }

      const onSealed = (f: SealedFrame): void => {
        const ch = channel
        const a = auth
        if (!ch || !a) return shut()
        const payload = ch.open(f) as ({ t?: unknown } & Record<string, unknown>) | undefined
        if (!payload || typeof payload.t !== 'string') {
          if (!inner) {
            opts.onFailed(a)
            plain({ t: 'err', code: 'auth', message: '二维码无效或已被使用，请在电脑上刷新二维码后重新扫码。' })
          }
          return shut()
        }
        if (!inner) {
          clearTimeout(timer)
          opts.onProven(a)
          const conn: Conn = {
            via: raw.via,
            remote: raw.remote,
            auth: a,
            visible: true,
            send: (frame) => {
              if (!closed) raw.sendText(JSON.stringify(ch.seal(frame)))
            },
            close: () => shut()
          }
          inner = opts.sink.attach(conn)
        }
        inner.onFrame(payload as { t: string } & Record<string, unknown>)
      }

      return {
        onText(text: string): void {
          if (closed) return
          if (text.length > MAX_FRAME_CHARS) return shut()
          let f: { t?: unknown }
          try {
            f = JSON.parse(text) as { t?: unknown }
          } catch {
            return shut()
          }
          if (!f || typeof f !== 'object') return shut()
          if (f.t === 'ping') return plain({ t: 'pong' })
          if (f.t === 'hi') {
            if (channel || pending) return shut()
            void onHi(f)
            return
          }
          if (f.t === 'x' && typeof (f as SealedFrame).d === 'string') return onSealed(f as SealedFrame)
          shut()
        },
        onClose(): void {
          closed = true
          clearTimeout(timer)
          inner?.onClose()
        }
      }
    }
  }
}
