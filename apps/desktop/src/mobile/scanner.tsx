import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { t } from './strings'

/**
 * 应用内扫码（添加另一台电脑 / 主屏幕应用里重新连接）：后置摄像头 + jsQR（按需加载，不进首屏包）。
 * 主屏幕应用里用系统相机扫码会跳到浏览器、连的是浏览器那份，所以这里要自己扫。
 */
export function Scanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }): React.JSX.Element {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer = 0
    let alive = true
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    void (async () => {
      try {
        const [{ default: jsQR }, s] = await Promise.all([
          import('jsqr'),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        ])
        stream = s
        if (!alive) return s.getTracks().forEach((tr) => tr.stop())
        const v = video.current!
        v.srcObject = s
        await v.play()
        const tick = (): void => {
          if (!alive || !ctx) return
          if (v.videoWidth) {
            // 缩到短边 480 再识别：够清楚，也省电。
            const k = Math.min(1, 480 / Math.min(v.videoWidth, v.videoHeight))
            canvas.width = Math.round(v.videoWidth * k)
            canvas.height = Math.round(v.videoHeight * k)
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
            if (hit?.data) {
              alive = false
              navigator.vibrate?.(30)
              onResult(hit.data)
              return
            }
          }
          timer = window.setTimeout(tick, 200)
        }
        tick()
      } catch {
        if (alive) setError(t('scanNoCamera'))
      }
    })()
    return () => {
      alive = false
      window.clearTimeout(timer)
      stream?.getTracks().forEach((tr) => tr.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="scanner">
      <video ref={video} playsInline muted />
      <div className="scanner__frame" aria-hidden />
      <div className="scanner__top">
        <button className="ib ib--light" aria-label={t('close')} onClick={onClose}>
          <X size={24} />
        </button>
      </div>
      <div className="scanner__hint">
        <b>{error ? t('errorTitle') : t('scanTitle')}</b>
        <span>{error ?? t('scanHint')}</span>
      </div>
    </div>
  )
}
