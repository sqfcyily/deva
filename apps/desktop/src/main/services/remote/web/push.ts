import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type JsonWebKey,
  type KeyObject
} from 'node:crypto'
import { b64uDecode, b64uEncode } from '../../../../shared/remote-crypto'
import type { WebPushSub } from '../../../../shared/remote-web'
import { httpFetch } from '../../../http'
import { getSecret, setSecret } from '../../secrets'
import type { ChannelId } from '../types'

/**
 * Web Push（RFC 8030 / 8291 / 8292）：电脑直接把通知推给手机浏览器的推送服务（Apple / Google / Mozilla），
 * 不经中转。iOS 16.4 起，添加到主屏幕的网页才能收到；国内安卓的 Chrome 走 FCM，通常连不上。
 *
 * VAPID 密钥对每台电脑一份（密钥库 remote:<botId>:vapid，JWK）；公钥交给手机订阅用。
 * 负载按 aes128gcm 加密：推送服务只看得到密文。
 */

const VAPID_KEY = (botId: ChannelId): string => `remote:${botId}:vapid`
/** VAPID 的联系方式（推送服务出问题时联系发送方用）。 */
const VAPID_SUBJECT = 'https://github.com/sqfcyily/deva'

interface Vapid {
  priv: KeyObject
  /** 未压缩公钥（65 字节）的 base64url，即手机订阅时的 applicationServerKey。 */
  pub: string
}

const cache = new Map<ChannelId, Vapid>()

function fromJwk(jwk: JsonWebKey): Vapid | null {
  if (!jwk.x || !jwk.y || !jwk.d) return null
  const x = b64uDecode(jwk.x)
  const y = b64uDecode(jwk.y)
  if (!x || !y || x.length !== 32 || y.length !== 32) return null
  const raw = new Uint8Array(65)
  raw[0] = 4
  raw.set(x, 1)
  raw.set(y, 33)
  return { priv: createPrivateKey({ key: jwk, format: 'jwk' }), pub: b64uEncode(raw) }
}

/** 这台电脑的 VAPID 密钥（没有就生成并存进密钥库；密钥库不可用时返回 null，手机端就不开推送）。 */
export async function vapidOf(botId: ChannelId): Promise<Vapid | null> {
  const hit = cache.get(botId)
  if (hit) return hit
  const raw = await getSecret(VAPID_KEY(botId))
  if (raw) {
    try {
      const v = fromJwk(JSON.parse(raw) as JsonWebKey)
      if (v) {
        cache.set(botId, v)
        return v
      }
    } catch {
      /* 坏了就重新生成（手机端会用新公钥重新订阅） */
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  const saved = await setSecret(VAPID_KEY(botId), JSON.stringify(jwk))
  if (!saved.ok) return null
  const v = fromJwk(jwk)
  if (v) cache.set(botId, v)
  return v
}

function vapidHeader(endpoint: string, v: Vapid): string {
  const aud = new URL(endpoint).origin
  const enc = (o: unknown): string => b64uEncode(new TextEncoder().encode(JSON.stringify(o)))
  const head = enc({ typ: 'JWT', alg: 'ES256' })
  const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: v.priv, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${v.pub}`
}

/** RFC 8291：用订阅里的 p256dh / auth 把负载加密成 aes128gcm 消息体。 */
export function encryptPushPayload(sub: WebPushSub, payload: Uint8Array): Buffer | null {
  const uaPub = b64uDecode(sub.keys.p256dh)
  const auth = b64uDecode(sub.keys.auth)
  if (!uaPub || uaPub.length !== 65 || !auth || auth.length < 16) return null
  const ecdh = createECDH('prime256v1')
  const asPub = ecdh.generateKeys()
  const shared = ecdh.computeSecret(Buffer.from(uaPub))
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPub), asPub])
  const ikm = Buffer.from(hkdfSync('sha256', shared, Buffer.from(auth), keyInfo, 32))
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 单条记录：正文后接 0x02（最后一条记录的分隔符）。
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const head = Buffer.alloc(21)
  salt.copy(head, 0)
  head.writeUInt32BE(4096, 16)
  head.writeUInt8(asPub.length, 20)
  return Buffer.concat([head, asPub, body])
}

export interface PushMessage {
  title: string
  body: string
  /** 点开要打开的对话。 */
  sid?: string
  /** 同一 tag 的新通知替换旧的（同一对话只留最新一条）。 */
  tag?: string
  deskId: string
}

export type PushOutcome = 'sent' | 'gone' | 'failed'

/** 推一条通知。gone = 订阅已失效（手机卸载 / 关了通知），调用方应删掉这个订阅。 */
export async function sendPush(botId: ChannelId, sub: WebPushSub, msg: PushMessage): Promise<PushOutcome> {
  const v = await vapidOf(botId)
  if (!v) return 'failed'
  let url: URL
  try {
    url = new URL(sub.endpoint)
  } catch {
    return 'gone'
  }
  if (url.protocol !== 'https:') return 'gone'
  const body = encryptPushPayload(sub, new TextEncoder().encode(JSON.stringify(msg)))
  if (!body) return 'gone'
  try {
    const res = await httpFetch(url.href, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(url.href, v),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 3600),
        urgency: 'high',
        ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {})
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000)
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    if (!res.ok) {
      console.warn('[remote/web] 推送失败：', res.status, (await res.text().catch(() => '')).slice(0, 200))
      return 'failed'
    }
    return 'sent'
  } catch (e) {
    console.warn('[remote/web] 推送失败：', (e as Error)?.message ?? e)
    return 'failed'
  }
}
