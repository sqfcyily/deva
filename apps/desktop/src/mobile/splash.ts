import { isIOS, isStandalone } from './push'

/**
 * 从主屏幕打开时的启动画面：纯紫底 + 白色标志（对比稿 design/mobile-splash.html 方案 A）。
 * · 安卓：启动画面由系统按 manifest 的 background_color 与 icon-maskable-512.png 生成（两者同一种紫，
 *   系统怎么裁图标都看不出边）；页面里的 #boot（index.html）接住它，页面渲染好后淡出。
 * · iOS：没有自动生成的启动画面，要 apple-touch-startup-image，且尺寸必须与屏幕完全一致。
 *   在 Safari 里按本机屏幕现画一张，添加到主屏幕时 iOS 会记下它。
 * 改颜色要同步 manifest.webmanifest、index.html（#boot 与 theme-color）和 icon-maskable-512.png。
 */
const SPLASH_BG = '#6540E9'

/** 标志在屏幕上的宽度：屏宽的 33%，最多 200px（同 index.html 的 #boot svg）。 */
const MARK_SHARE = 0.33
const MARK_MAX = 200
/** 标志「!D」在 1024 坐标里的外接框宽度（x 285–739），中心在 (512, 512)。 */
const MARK_W = 454

/** 页面已渲染：启动底层淡出后移除。 */
export function hideBoot(): void {
  const el = document.getElementById('boot')
  if (!el || el.classList.contains('is-out')) return
  // 浏览器标签页里本来就不显示，直接移除。
  if (getComputedStyle(el).display === 'none') return el.remove()
  el.classList.add('is-out')
  el.addEventListener('transitionend', () => el.remove(), { once: true })
  setTimeout(() => el.remove(), 600)
}

/** iOS Safari 里：按本机屏幕画一张启动图挂到页面上，供「添加到主屏幕」时使用。 */
export function prepareIosStartupImage(): void {
  if (!isIOS() || isStandalone()) return
  // 不占首屏渲染的时间。
  setTimeout(() => {
    try {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = window.screen
      const w = Math.round(width * dpr)
      const h = Math.round(height * dpr)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const g = canvas.getContext('2d')
      if (!g) return
      g.fillStyle = SPLASH_BG
      g.fillRect(0, 0, w, h)
      drawMark(g, w / 2, h / 2, Math.min(width * MARK_SHARE, MARK_MAX) * dpr)
      const link = document.createElement('link')
      link.rel = 'apple-touch-startup-image'
      link.media = `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`
      link.href = canvas.toDataURL('image/png')
      document.head.appendChild(link)
    } catch {
      // 画不出来就用 iOS 默认的白屏。
    }
  }, 1500)
}

/** 白色标志「!D」（同 apps/desktop/build/icon.svg），中心在 (cx, cy)，宽 size。 */
function drawMark(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / MARK_W
  g.save()
  g.translate(cx, cy)
  g.scale(s, s)
  g.translate(-512 - 27, -512 - 26)
  g.fillStyle = '#fff'
  // 感叹号竖线（96 × 380，两端半圆）与圆点。
  g.fill(new Path2D('M312 320 A48 48 0 0 1 408 320 V604 A48 48 0 0 1 312 604 Z'))
  g.fill(new Path2D('M312 756 A48 48 0 1 0 408 756 A48 48 0 1 0 312 756 Z'))
  // D 的弧。
  g.strokeStyle = '#fff'
  g.lineWidth = 96
  g.lineJoin = 'round'
  g.stroke(new Path2D('M468 320 H500 A218 218 0 0 1 500 756 H468'))
  g.restore()
}
