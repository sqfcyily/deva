import { useState } from 'react'
import type { WebNotice } from '../shared/remote-web'
import { WEB_PROTOCOL_VERSION } from '../shared/remote-web'
import type { Store } from './App'
import { fmtListTime } from './App'
import { t, type Hello, type LinkState } from './link'

/** 「我」：连接状态、这台手机、通知、添加到主屏幕、断开。配对与接入方式仍在电脑端设置。 */
export function MeTab({
  store,
  hello,
  state,
  notices
}: {
  store: Store
  hello: Hello
  state: LinkState
  notices: WebNotice[]
}): React.JSX.Element {
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem('deva.web.notify') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'
    } catch {
      return false
    }
  })
  const secure = window.isSecureContext && typeof Notification !== 'undefined'
  const denied = secure && Notification.permission === 'denied'

  const toggleNotify = async (): Promise<void> => {
    if (!secure || denied) return
    if (notify) {
      setNotify(false)
      try {
        localStorage.setItem('deva.web.notify', '0')
      } catch {
        /* ignore */
      }
      return
    }
    const p = await Notification.requestPermission()
    if (p === 'granted') {
      setNotify(true)
      try {
        localStorage.setItem('deva.web.notify', '1')
      } catch {
        /* ignore */
      }
    }
  }

  const ios = /iPhone|iPad/.test(navigator.userAgent)
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone

  const disconnect = (): void => {
    store.link.forget()
    location.reload()
  }

  return (
    <>
      <header className="top">
        <h1 className="top__title">{t('tabMe')}</h1>
      </header>
      <div className="scroll">
        <div className="pcbox">
          <span className="pcbox__pc">
            <svg className="ic" viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </span>
          <span className="pcbox__k">
            <b>{hello.bot.computer || hello.bot.name}</b>
            <span>
              <span className={`dot${state.kind === 'ready' ? ' dot--on' : state.kind === 'connecting' ? ' dot--busy' : ' dot--off'}`} />
              {state.kind === 'ready' ? t('ready') : state.kind === 'offline' ? t('offline') : state.kind === 'connecting' ? t('connecting') : t('errorTitle')} ·{' '}
              {store.link.viaRelay ? t('viaRelay') : t('viaLan')}
            </span>
          </span>
        </div>

        <div className="group">
          <div className="cell">
            <span className="cell__k">
              <b>{t('thisPhone')}</b>
              <span>{t('pairedAs')} {hello.user.name ?? hello.user.id}</span>
            </span>
          </div>
          <div className="cell">
            <span className="cell__k">
              <b>{t('notifications')}</b>
              <span>{!secure ? t('notifNeedHttps') : denied ? t('notifDenied') : t('notifHint')}</span>
            </span>
            <button className={`sw${notify ? ' is-on' : ''}`} disabled={!secure || denied} aria-pressed={notify} onClick={() => void toggleNotify()} />
          </div>
          {!standalone && (
            <div className="cell">
              <span className="cell__k">
                <b>{t('addToHome')}</b>
                <span>{ios ? t('addToHomeIos') : t('addToHomeAndroid')}</span>
              </span>
            </div>
          )}
        </div>

        {notices.length > 0 && (
          <div className="group">
            {[...notices].reverse().slice(0, 8).map((n) => (
              <button
                key={n.id}
                className="cell cell--btn"
                onClick={() => n.sessionId && store.sessions.has(n.sessionId) && store.open({ tab: 'chats', chat: n.sessionId })}
              >
                <span className="cell__k">
                  <b>{n.title ?? 'Deva'}</b>
                  <span>{n.text}</span>
                </span>
                <span className="cell__v">{fmtListTime(n.at)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="group">
          <button className="cell cell--btn" onClick={disconnect}>
            <span className="cell__k">
              <b>{t('disconnect')}</b>
              <span>{t('disconnectHint')}</span>
            </span>
            <span className="cell__v bad">{t('disconnect')}</span>
          </button>
        </div>
        <div className="muted small center">
          {t('version')} v{WEB_PROTOCOL_VERSION}
        </div>
      </div>
    </>
  )
}
