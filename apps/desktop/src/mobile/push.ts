import { b64uDecode } from '../shared/remote-crypto'
import type { WebPushSub } from '../shared/remote-web'

/**
 * 推送与 Service Worker（public/sw.js）。
 *
 * iOS 16.4 起，只有「添加到主屏幕」后从主屏幕打开的网页能请求通知与推送；安卓 Chrome 在浏览器里也行
 * （国内网络下推送服务通常连不上）。局域网的 http 页面不是安全上下文，都用不了。
 */

export type PushSupport = 'ok' | 'need-install' | 'need-https' | 'unsupported'

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
}

export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'need-https'
  if (isIOS() && !isStandalone()) return 'need-install'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported'
  return 'ok'
}

export function permission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

let reg: Promise<ServiceWorkerRegistration | null> | null = null

/** 注册 Service Worker（缓存页面外壳，收推送）。只在安全上下文里。 */
export function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (reg) return reg
  reg = (async () => {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return null
    try {
      return await navigator.serviceWorker.register('./sw.js', { scope: './' })
    } catch {
      return null
    }
  })()
  return reg
}

function toSub(s: PushSubscription): WebPushSub | null {
  const j = s.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return null
  return { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }
}

/** 当前订阅（权限已给且订阅着才有）。 */
export async function currentSub(): Promise<WebPushSub | null> {
  if (pushSupport() !== 'ok' || permission() !== 'granted') return null
  const r = await registerSW()
  const s = await r?.pushManager.getSubscription().catch(() => null)
  return s ? toSub(s) : null
}

/**
 * 请求通知权限并订阅（必须在点击里调用：iOS 只认用户手势里发起的请求）。
 * vapid = 电脑的推送公钥；换了电脑（公钥不同）时先退订旧的再订。
 */
export async function subscribe(vapid: string): Promise<WebPushSub | null> {
  if (pushSupport() !== 'ok') return null
  const p = await Notification.requestPermission()
  if (p !== 'granted') return null
  const r = await registerSW()
  if (!r) return null
  const key = b64uDecode(vapid)
  if (!key) return null
  try {
    const cur = await r.pushManager.getSubscription()
    if (cur) {
      const curKey = cur.options.applicationServerKey ? new Uint8Array(cur.options.applicationServerKey) : null
      if (curKey && curKey.length === key.length && curKey.every((b, i) => b === key[i])) return toSub(cur)
      await cur.unsubscribe()
    }
    const s = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
    return toSub(s)
  } catch {
    return null
  }
}

export async function unsubscribe(): Promise<void> {
  const r = await registerSW()
  const s = await r?.pushManager.getSubscription().catch(() => null)
  await s?.unsubscribe().catch(() => undefined)
}
