/* Deva 手机版 Service Worker：缓存页面外壳（离线 / 弱网也能秒开）、收推送、点通知打开对应对话。
 * 推送内容由电脑端用 Web Push 加密发出（services/remote/web/push.ts），格式：
 *   { title, body, sid?, tag?, deskId }
 */
const CACHE = 'deva-shell-v1'

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon-192.png']))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/** 页面：先走网络（拿到新版），失败用缓存；带指纹的静态资源：缓存优先。WebSocket 与其他来源不管。 */
self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
            return res
          })
      )
    )
    return
  }
  if (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('./index.html', res.clone()))
          return res
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || Response.error()))
    )
  }
})

self.addEventListener('push', (e) => {
  let msg = {}
  try {
    msg = e.data ? e.data.json() : {}
  } catch {
    msg = { title: 'Deva', body: e.data ? e.data.text() : '' }
  }
  const title = msg.title || 'Deva'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 页面正在前台：不重复提醒（电脑端一般也不会推，这里兜底）。iOS 要求每条推送都显示通知，所以只在确有前台页面时跳过。
      if (list.some((c) => c.visibilityState === 'visible' && c.focused)) return
      return self.registration.showNotification(title, {
        body: msg.body || '',
        tag: msg.tag || undefined,
        icon: './icon-192.png',
        badge: './icon-192.png',
        data: { sid: msg.sid || null, deskId: msg.deskId || null }
      })
    })
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const { sid, deskId } = e.notification.data || {}
  const target = new URL(sid && deskId ? `./#o=${encodeURIComponent(deskId)}.${encodeURIComponent(sid)}` : './', self.registration.scope).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'open', deskId, sid })
          return c.focus()
        }
      }
      return self.clients.openWindow(target)
    })
  )
})
