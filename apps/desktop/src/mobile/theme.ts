import { useCallback, useEffect, useState } from 'react'
import { prefGet, prefSet } from './vault'

/**
 * 外观：跟随系统 / 浅色 / 深色（设置里选，按本机保存）。生效的深浅色写在根元素的 data-theme 上，
 * 配色表见 mobile.css；浏览器顶栏 / 状态栏的颜色（theme-color）同步改。
 * index.html 里有一小段同样的判断，在页面渲染前先设好，打开时不会先闪一下白底。
 */

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'
/** 与 mobile.css 的 --bg 一致。 */
const BAR = { light: '#ffffff', dark: '#1e1e20' }

const media = (): MediaQueryList | null => window.matchMedia?.('(prefers-color-scheme: dark)') ?? null

function loadPref(): ThemePref {
  const v = prefGet(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function apply(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && !!media()?.matches)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? BAR.dark : BAR.light)
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPrefState] = useState<ThemePref>(loadPref)

  useEffect(() => {
    apply(pref)
    if (pref !== 'system') return
    const mq = media()
    if (!mq) return
    const onChange = (): void => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])

  const setPref = useCallback((p: ThemePref) => {
    prefSet(KEY, p === 'system' ? null : p)
    setPrefState(p)
  }, [])

  return [pref, setPref]
}
