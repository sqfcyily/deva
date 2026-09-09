import { useState } from 'react'
import {
  Sun,
  Moon,
  Monitor,
  SlidersHorizontal,
  Palette,
  Boxes,
  Info,
  type LucideIcon
} from 'lucide-react'
import { useTheme, type ThemeMode } from '../../theme/ThemeContext'
import { useI18n } from '../../i18n/i18n'
import type { Locale } from '../../i18n/messages'
import { ModelSettings } from './ModelSettings'

/**
 * 设置视图：左侧类别导航 + 右侧内容（类似主流应用的设置页）。
 * 设置视图占满工作区（活动栏侧边面板在此折叠）。
 */
type Category = 'general' | 'appearance' | 'models' | 'about'

export function SettingsView(): React.JSX.Element {
  const { t } = useI18n()
  const [cat, setCat] = useState<Category>('general')

  const cats: { key: Category; icon: LucideIcon; labelKey: string }[] = [
    { key: 'general', icon: SlidersHorizontal, labelKey: 'settings.general' },
    { key: 'appearance', icon: Palette, labelKey: 'settings.appearance' },
    { key: 'models', icon: Boxes, labelKey: 'settings.models' },
    { key: 'about', icon: Info, labelKey: 'settings.about' }
  ]

  return (
    <div className="settings2">
      <nav className="settings2__nav">
        <div className="settings2__nav-title">{t('settings.title')}</div>
        {cats.map(({ key, icon: Icon, labelKey }) => (
          <button
            key={key}
            className={`settings2__nav-item${cat === key ? ' is-active' : ''}`}
            onClick={() => setCat(key)}
          >
            <Icon size={16} strokeWidth={1.75} />
            {t(labelKey)}
          </button>
        ))}
      </nav>

      <div className="settings2__content">
        {cat === 'general' && <GeneralPane />}
        {cat === 'appearance' && <AppearancePane />}
        {cat === 'models' && <ModelSettings />}
        {cat === 'about' && <AboutPane />}
      </div>
    </div>
  )
}

function GeneralPane(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  return (
    <div className="pane">
      <h1 className="pane__title">{t('settings.general')}</h1>
      <div className="settings__row">
        <div className="settings__row-label">{t('settings.language')}</div>
        <select
          className="select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </div>
    </div>
  )
}

function AppearancePane(): React.JSX.Element {
  const { t } = useI18n()
  const { mode, setMode } = useTheme()
  const themeOptions: { value: ThemeMode; icon: LucideIcon; labelKey: string }[] = [
    { value: 'light', icon: Sun, labelKey: 'settings.themeLight' },
    { value: 'dark', icon: Moon, labelKey: 'settings.themeDark' },
    { value: 'system', icon: Monitor, labelKey: 'settings.themeSystem' }
  ]
  return (
    <div className="pane">
      <h1 className="pane__title">{t('settings.appearance')}</h1>
      <div className="settings__row">
        <div>
          <div className="settings__row-label">{t('settings.theme')}</div>
          <div className="settings__row-desc">{t('settings.themeDesc')}</div>
        </div>
        <div className="segmented">
          {themeOptions.map(({ value, icon: Icon, labelKey }) => (
            <button
              key={value}
              className={`segmented__item${mode === value ? ' is-active' : ''}`}
              onClick={() => setMode(value)}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function AboutPane(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="pane">
      <h1 className="pane__title">{t('settings.about')}</h1>
      <div className="settings__row">
        <div className="settings__row-label">{t('app.name')}</div>
        <div className="settings__row-desc">
          {t('settings.version')} 0.1.0 · Electron
        </div>
      </div>
      <div className="settings__row">
        <div className="settings__row-label">{t('app.tagline')}</div>
      </div>
    </div>
  )
}
