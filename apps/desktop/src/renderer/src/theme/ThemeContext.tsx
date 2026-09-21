import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'

/**
 * 主题系统。三态：light / dark / system（默认跟随系统）。
 * - system 时读取 prefers-color-scheme，并实时监听系统切换。
 * - 实际生效值写入 <html data-theme>，样式层据此切换 token。
 * - 同步原生标题栏控件配色（Windows titleBarOverlay 的图标色）。
 * 详见 docs/modules/ui-theming-i18n.md。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'deva.theme'

/** 从 ~/.deva/config.json 同步取主题（首帧，避免闪烁）。不可用时返回 null 走后续兜底。 */
function readConfigMode(): ThemeMode | null {
  try {
    const v = window.deva?.config?.getSync()?.theme
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* config 不可用（如纯 web 预览）时回退 */
  }
  return null
}

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStoredMode(): ThemeMode {
  // 优先 ~/.deva/config.json（可手改），其次 localStorage 兜底，最后默认跟随系统
  const fromConfig = readConfigMode()
  if (fromConfig) return fromConfig
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* localStorage 不可用时回退默认 */
  }
  return 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  // 监听系统主题变化（仅在 system 模式下才影响最终结果，但始终跟踪）
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemTheme(e.matches ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = mode === 'system' ? systemTheme : mode

  // 应用到 DOM + 同步原生标题栏
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved)
    const symbolColor = resolved === 'dark' ? '#e4e4e7' : '#3a3a3d'
    void window.deva?.window.setOverlaySymbolColor(symbolColor)
  }, [resolved])

  const setMode = (next: ThemeMode): void => {
    setModeState(next)
    // 主存 ~/.deva/config.json；localStorage 作为兜底缓存
    void window.deva?.config?.set({ theme: next })
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 忽略持久化失败 */
    }
  }

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode }),
    [mode, resolved]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
