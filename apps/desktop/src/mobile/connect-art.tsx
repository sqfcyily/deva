import { useId } from 'react'

/**
 * 初始页与连接过程的插图：电脑（屏幕上是 Deva 标志）与手机（星芒），中间一串点。
 * 对比稿 design/mobile-welcome.html 方案 B；配色同电脑端「Deva 手机版」图标（renderer/src/assets/platforms/deva-phone.svg）。
 * idle = 静止；flow = 连接中，点依次亮起；broken = 二维码失效 / 已断开 / 电脑不在线，连线中间打叉。
 */
export type ArtState = 'idle' | 'flow' | 'broken'

/** 点的位置：电脑右边缘 118 与手机左边缘 178 之间。 */
const DOTS = [134, 148, 162]
const DOT_Y = 58

export function ConnectArt({ state = 'idle' }: { state?: ArtState }): React.JSX.Element {
  // useId 带冒号，放进 url(#…) 不保险。
  const id = useId().replace(/:/g, '')
  const pc = `pc${id}`
  const ph = `ph${id}`
  return (
    <svg className="art" viewBox="0 0 230 130" aria-hidden>
      <defs>
        <linearGradient id={pc} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#6D3FE8" />
        </linearGradient>
        <linearGradient id={ph} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F472B6" />
          <stop offset="1" stopColor="#E0479E" />
        </linearGradient>
      </defs>
      {/* 电脑：屏幕 + 底座，屏幕中间是标志「!D」（同 build/icon.svg，1024 坐标缩小放进屏幕中心 (62, 53)）。 */}
      <rect x="6" y="14" width="112" height="78" rx="16" fill={`url(#${pc})`} />
      <rect x="48" y="96" width="28" height="6" rx="3" fill={`url(#${pc})`} opacity=".55" />
      <g transform="translate(32.3 23.3) scale(.058)" fill="#fff">
        <g transform="translate(-27 -26)">
          <rect x="312" y="272" width="96" height="380" rx="48" />
          <circle cx="360" cy="756" r="48" />
          <path d="M468 320 H500 A218 218 0 0 1 500 756 H468" fill="none" stroke="#fff" strokeWidth="96" strokeLinejoin="round" />
        </g>
      </g>
      {state === 'broken' ? (
        <g>
          <circle cx={DOTS[0]} cy={DOT_Y} r="3.6" className="art__dot is-off" />
          <path d={`M${DOTS[1] - 5} ${DOT_Y - 5} l10 10 M${DOTS[1] + 5} ${DOT_Y - 5} l-10 10`} className="art__x" />
          <circle cx={DOTS[2]} cy={DOT_Y} r="3.6" className="art__dot is-off" />
        </g>
      ) : (
        <g className={state === 'flow' ? 'art__flow' : undefined}>
          {DOTS.map((x) => (
            <circle key={x} cx={x} cy={DOT_Y} r="3.6" className="art__dot" />
          ))}
        </g>
      )}
      {/* 手机 + 星芒 */}
      <rect x="178" y="22" width="46" height="84" rx="14" fill={`url(#${ph})`} />
      <path
        d="M201 48c2.8 13.6 2.8 13.6 16.4 16.4c-13.6 2.8-13.6 2.8-16.4 16.4c-2.8-13.6-2.8-13.6-16.4-16.4c13.6-2.8 13.6-2.8 16.4-16.4z"
        fill="#fff"
      />
    </svg>
  )
}
