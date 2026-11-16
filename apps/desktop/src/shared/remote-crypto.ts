import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils'

/**
 * 手机 ⇄ 电脑端的端到端加密（主进程与手机网页共用这一份，保证两头算法一致）。
 *
 * 中转（以及局域网上的旁听者）只看得到握手公钥与密文。每条连接先握手：
 *   1. 手机 → 电脑（明文）：hi { k 用途, id, e 手机临时公钥, n 随机数 }
 *   2. 电脑 → 手机（明文）：hi { e 电脑临时公钥, m = HMAC(共享密钥, 记录) }——手机据此确认对面确实是那台电脑
 *   3. 两头各自：会话密钥 = HKDF(X25519(临时私钥, 对方临时公钥), salt = 共享密钥, info = 记录摘要)，
 *      分出「手机→电脑」「电脑→手机」两把 ChaCha20-Poly1305 密钥；之后每帧 { t:'x', d: 密文 }。
 * 共享密钥 = 二维码里的一次性配对密钥（pair）/ 添加到主屏幕时的安装密钥（install）/ 配对后发给手机的设备密钥（resume）。
 * 临时密钥每条连接新生成：设备密钥日后泄露也解不开录下的旧流量；重放旧握手得到的会话密钥不同，旧密文解不开。
 * 帧序号即 nonce，严格递增：中转丢帧、重放、乱序都会让解密失败，连接随即断开。
 *
 * 只用 crypto.getRandomValues（非 https 的局域网页面也有），不依赖只在安全上下文可用的 crypto.subtle。
 */

export const CRYPTO_VERSION = 1

export type AuthKind = 'pair' | 'install' | 'resume'

/** 手机发起握手（明文）。 */
export interface PhoneHi {
  t: 'hi'
  v: number
  k: AuthKind
  /** pair / install = 票据 id；resume = 设备 id。 */
  id: string
  e: string
  n: string
}

/** 电脑回应握手（明文）。 */
export interface DeskHi {
  t: 'hi'
  e: string
  m: string
}

/** 加密帧。 */
export interface SealedFrame {
  t: 'x'
  d: string
}

// ───────── base64url ─────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i
  // 也认标准 base64 的 + /
  m['+'.charCodeAt(0)] = 62
  m['/'.charCodeAt(0)] = 63
  return m
})()

export function b64uEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

/** 解码失败（含非法字符）返回 null。 */
export function b64uDecode(s: string): Uint8Array | null {
  if (typeof s !== 'string') return null
  const str = s.replace(/=+$/, '')
  if (str.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((str.length * 3) / 4))
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const v = c < 128 ? B64_INDEX[c] : -1
    if (v < 0) return null
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out
}

export function randomKey(len = 32): Uint8Array {
  return randomBytes(len)
}

/** 二维码 / 地址里的票据：「id.密钥」。 */
export function formatTicket(id: string, secret: Uint8Array): string {
  return `${id}.${b64uEncode(secret)}`
}

export function parseTicket(raw: string | null | undefined): { id: string; secret: Uint8Array } | null {
  if (!raw) return null
  const m = /^([A-Za-z0-9_-]{6,40})\.([A-Za-z0-9_-]{40,48})$/.exec(raw)
  if (!m) return null
  const secret = b64uDecode(m[2])
  return secret && secret.length === 32 ? { id: m[1], secret } : null
}

// ───────── 握手 ─────────

function transcript(hi: PhoneHi, deskPub: Uint8Array): Uint8Array {
  const phonePub = b64uDecode(hi.e) ?? new Uint8Array()
  const nonce = b64uDecode(hi.n) ?? new Uint8Array()
  return sha256(concatBytes(utf8ToBytes(`deva-e2e/${CRYPTO_VERSION}|${hi.k}|${hi.id}|`), phonePub, nonce, deskPub))
}

function deskMac(secret: Uint8Array, digest: Uint8Array): Uint8Array {
  return hmac(sha256, secret, concatBytes(utf8ToBytes('desk'), digest))
}

function deriveKeys(shared: Uint8Array, secret: Uint8Array, digest: Uint8Array): { p2d: Uint8Array; d2p: Uint8Array } {
  const okm = hkdf(sha256, shared, secret, digest, 64)
  return { p2d: okm.slice(0, 32), d2p: okm.slice(32, 64) }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** X25519 共享值：对方公钥是小阶点时结果全零，视为无效。 */
function sharedSecret(priv: Uint8Array, pubB64: string): Uint8Array | null {
  const pub = b64uDecode(pubB64)
  if (!pub || pub.length !== 32) return null
  try {
    const s = x25519.getSharedSecret(priv, pub)
    return s.some((b) => b !== 0) ? s : null
  } catch {
    return null
  }
}

/** 手机：发起握手。 */
export function phoneHello(kind: AuthKind, id: string): { hi: PhoneHi; priv: Uint8Array } {
  const priv = x25519.utils.randomPrivateKey()
  const hi: PhoneHi = {
    t: 'hi',
    v: CRYPTO_VERSION,
    k: kind,
    id,
    e: b64uEncode(x25519.getPublicKey(priv)),
    n: b64uEncode(randomBytes(16))
  }
  return { hi, priv }
}

/** 手机：收到电脑的回应。电脑不知道共享密钥（冒充 / 中转篡改）时返回 null。 */
export function phoneFinish(hi: PhoneHi, priv: Uint8Array, secret: Uint8Array, reply: DeskHi): SecureChannel | null {
  const deskPub = b64uDecode(reply.e)
  const mac = b64uDecode(reply.m)
  if (!deskPub || deskPub.length !== 32 || !mac) return null
  const digest = transcript(hi, deskPub)
  if (!equalBytes(mac, deskMac(secret, digest))) return null
  const shared = sharedSecret(priv, reply.e)
  if (!shared) return null
  const k = deriveKeys(shared, secret, digest)
  return new SecureChannel(k.p2d, k.d2p)
}

/** 电脑：回应手机的握手（secret 由调用方按 k / id 查到）。手机公钥无效时返回 null。 */
export function deskAccept(hi: PhoneHi, secret: Uint8Array): { reply: DeskHi; channel: SecureChannel } | null {
  if (!b64uDecode(hi.n)) return null
  const priv = x25519.utils.randomPrivateKey()
  const deskPub = x25519.getPublicKey(priv)
  const shared = sharedSecret(priv, hi.e)
  if (!shared) return null
  const digest = transcript(hi, deskPub)
  const k = deriveKeys(shared, secret, digest)
  return {
    reply: { t: 'hi', e: b64uEncode(deskPub), m: b64uEncode(deskMac(secret, digest)) },
    channel: new SecureChannel(k.d2p, k.p2d)
  }
}

export function isPhoneHi(f: unknown): f is PhoneHi {
  const h = f as PhoneHi
  return (
    !!h &&
    h.t === 'hi' &&
    typeof h.v === 'number' &&
    (h.k === 'pair' || h.k === 'install' || h.k === 'resume') &&
    typeof h.id === 'string' &&
    h.id.length <= 64 &&
    typeof h.e === 'string' &&
    typeof h.n === 'string'
  )
}

// ───────── 加密通道 ─────────

const enc = new TextEncoder()
const dec = new TextDecoder()

function nonceOf(counter: number): Uint8Array {
  const n = new Uint8Array(12)
  // 前 4 字节为 0，后 8 字节为大端序号（2^53 以内足够）。
  let c = counter
  for (let i = 11; i >= 4; i--) {
    n[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  return n
}

/** 一条连接上的加密通道：发送 / 接收各一把密钥、各一个严格递增的序号。 */
export class SecureChannel {
  private sendSeq = 0
  private recvSeq = 0

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly recvKey: Uint8Array
  ) {}

  /** 对象 → 加密帧。 */
  seal(payload: unknown): SealedFrame {
    const plain = enc.encode(JSON.stringify(payload))
    const box = chacha20poly1305(this.sendKey, nonceOf(this.sendSeq++)).encrypt(plain)
    return { t: 'x', d: b64uEncode(box) }
  }

  /** 加密帧 → 对象。认证失败（篡改 / 重放 / 乱序 / 密钥不对）返回 undefined，调用方应断开连接。 */
  open(frame: SealedFrame): unknown {
    const box = b64uDecode(frame.d)
    if (!box || box.length < 16) return undefined
    let plain: Uint8Array
    try {
      plain = chacha20poly1305(this.recvKey, nonceOf(this.recvSeq)).decrypt(box)
    } catch {
      return undefined
    }
    this.recvSeq++
    try {
      return JSON.parse(dec.decode(plain))
    } catch {
      return undefined
    }
  }
}
