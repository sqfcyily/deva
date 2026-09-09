import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import { messages, type Locale, type MessageTree } from './messages'

/**
 * 轻量 i18n。默认跟随系统语言（navigator.language），中文归一到 zh-CN，其余走 en。
 * t('a.b.c') 的调用签名与 i18next 一致，方便后续替换为 i18next 而不改调用点。
 * 详见 docs/modules/ui-theming-i18n.md。
 */

const STORAGE_KEY = 'deva.locale'
const SUPPORTED: Locale[] = ['zh-CN', 'en']

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

function detectLocale(): Locale {
  // 优先 ~/.deva/config.json（可手改），其次 localStorage 兜底，最后跟随系统语言
  try {
    const v = window.deva?.config?.getSync()?.locale
    if (typeof v === 'string' && SUPPORTED.includes(v as Locale)) return v as Locale
  } catch {
    /* config 不可用时回退 */
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && SUPPORTED.includes(stored as Locale)) return stored as Locale
  } catch {
    /* ignore */
  }
  const sys = (navigator.language || 'en').toLowerCase()
  return sys.startsWith('zh') ? 'zh-CN' : 'en'
}

function resolve(tree: MessageTree, key: string): string {
  const parts = key.split('.')
  let cur: string | MessageTree = tree
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null || !(p in cur)) return key
    cur = cur[p]
  }
  return typeof cur === 'string' ? cur : key
}

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale)
  }, [locale])

  const setLocale = (next: Locale): void => {
    setLocaleState(next)
    // 主存 ~/.deva/config.json；localStorage 作为兜底缓存
    void window.deva?.config?.set({ locale: next })
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  const value = useMemo<I18nContextValue>(() => {
    const dict = messages[locale]
    return { locale, setLocale, t: (key: string) => resolve(dict, key) }
  }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用')
  return ctx
}
