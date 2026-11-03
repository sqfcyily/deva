import { useEffect, useState } from 'react'
import { Globe, X } from 'lucide-react'
import type { BrowserUiState, BrowserUiTab } from '../../../../shared/browser'
import { useI18n } from '../../i18n/i18n'
import { displayUrl, tabTitle } from './text'
import './capsule.css'

/** 订阅内置浏览器的界面状态。 */
export function useBrowserState(): BrowserUiState | null {
  const [s, setS] = useState<BrowserUiState | null>(null)
  useEffect(() => {
    void window.deva.browser.getState().then(setS)
    return window.deva.browser.onState(setS)
  }, [])
  return s
}

/**
 * 本对话打开的网页列表（胶囊右侧箭头）：点一行切到它；每行 ✕ 关掉它，标题右侧「全部关闭」。
 * locked（Deva 正在用 / 等你操作）时不给关（✕ 不显示，「全部关闭」置灰并在悬停提示里说明）。
 * 定位由外层（.cf-todo__panel 的 bottom:100%）决定。
 */
export function PagesPanel({
  sessionId,
  tabs,
  current,
  locked,
  onPick
}: {
  sessionId: string
  tabs: BrowserUiTab[]
  current: string
  locked: boolean
  onPick: (tab: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const api = window.deva.browser
  return (
    <div className="cf-todo__panel cf-bpages" role="dialog" aria-label={t('browser.pages')}>
      <div className="cf-todo__head">
        <span className="cf-todo__title">{t('browser.pages')}</span>
        <button
          type="button"
          className="cf-todo__cancel"
          disabled={locked}
          title={locked ? t('browser.closeLocked') : undefined}
          onClick={() => void api.closeSession(sessionId)}
        >
          {t('browser.closeAll')}
        </button>
      </div>
      <div className="cf-todo__scroll cf-browser__list">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            className={`cf-browser__row${tab.id === current ? ' is-on' : ''}`}
            onClick={() => onPick(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick(tab.id)
              }
            }}
          >
            <Globe size={13} />
            <span className="cf-browser__row-title">{tabTitle(t, tab)}</span>
            <span className="cf-browser__row-url">{displayUrl(tab.url)}</span>
            {!locked && (
              <button
                type="button"
                className="cf-browser__row-x"
                title={t('browser.closePage')}
                aria-label={t('browser.closePage')}
                onClick={(e) => {
                  e.stopPropagation()
                  void api.closeTab(tab.id)
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
