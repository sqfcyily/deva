import { useEffect, useState } from 'react'
import { Bell, Check, CloudOff, QrCode, SquarePlus, Share, Unlink, RefreshCw } from 'lucide-react'
import type { LinkPhase } from './link'
import type { Store } from './App'
import { isIOS, isStandalone } from './push'
import { fmtListTime, t } from './strings'
import { prefGet, prefSet, type DeskCred } from './vault'

/** Deva 标志（apps/desktop/build/icon.svg）。 */
export function Logo({ size = 72 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="deva-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="url(#deva-logo-bg)" />
      <g fill="#fff" transform="translate(-27 -26)">
        <rect x="312" y="272" width="96" height="380" rx="48" />
        <circle cx="360" cy="756" r="48" />
        <path d="M468 320 H500 A218 218 0 0 1 500 756 H468" fill="none" stroke="#fff" strokeWidth="96" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

/** 首次连接（扫码 / 主屏幕图标首次打开）：电脑名 + 三步。正常一两秒就结束。 */
export function Splash({ computer, phase }: { computer: string; phase: LinkPhase }): React.JSX.Element {
  // 握手回应到达 = 二维码有效且加密已建立（前两项同时完成）；收到 ok = 同步完成。
  const done = phase.kind === 'ready' ? 3 : phase.kind === 'connecting' ? (phase.step === 0 ? 0 : 2) : 0
  const offline = phase.kind === 'offline'
  const items = [t('stepTicket'), t('stepSecure'), t('stepSync')]
  return (
    <div className="state">
      <Logo size={76} />
      <h2>{offline ? t('offlineTitle', { pc: computer || t('thisComputer') }) : t('connectingTitle')}</h2>
      {computer && !offline && <span className="state__pc">{computer}</span>}
      {offline ? (
        <p>{t('offlineHintNoCache')}</p>
      ) : (
        <div className="steps">
          {items.map((label, i) => {
            const ok = done > i
            const now = done === i
            return (
              <div key={i} className={`step${now ? ' is-now' : ''}${ok ? ' is-done' : ''}`}>
                {ok ? (
                  <span className="step__ok">
                    <Check size={13} strokeWidth={3} />
                  </span>
                ) : now ? (
                  <span className="spin spin--lg" />
                ) : (
                  <span className="step__todo" />
                )}
                {label}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 没有凭证 / 二维码失效 / 被移除 / 版本不对：都只引导去电脑上扫码，不再有输入配对码的页面。 */
export function StatePage({
  kind,
  message,
  onScan,
  others = [],
  onSwitch,
  onForget
}: {
  kind: 'welcome' | 'expired' | 'removed' | 'version'
  message?: string
  onScan: () => void
  others?: DeskCred[]
  onSwitch?: (deskId: string) => void
  onForget?: () => void
}): React.JSX.Element {
  useEffect(() => {
    if (kind === 'removed') onForget?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])
  const canScan = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia
  const title =
    kind === 'welcome' ? t('welcomeTitle') : kind === 'expired' ? t('expiredTitle') : kind === 'removed' ? t('removedTitle') : t('versionTitle')
  const lead = kind === 'welcome' ? t('welcomeLead') : kind === 'removed' ? t('removedLead') : kind === 'expired' ? t('expiredLead') : message
  return (
    <div className="state">
      {kind === 'welcome' ? (
        <Logo size={76} />
      ) : (
        <span className="illus">{kind === 'removed' ? <Unlink size={42} strokeWidth={1.5} /> : kind === 'version' ? <RefreshCw size={42} strokeWidth={1.5} /> : <QrCode size={42} strokeWidth={1.5} />}</span>
      )}
      <h2>{title}</h2>
      {lead && <p>{lead}</p>}
      {others.length > 0 && (
        <div className="state__list">
          {others.map((d) => (
            <button key={d.deskId} className="btn btn--wide" onClick={() => onSwitch?.(d.deskId)}>
              {t('continueWith', { pc: d.computer || t('thisComputer') })}
            </button>
          ))}
        </div>
      )}
      <div className="state__foot">
        {kind === 'version' ? (
          <button className="btn btn--primary btn--wide" onClick={() => location.reload()}>
            <RefreshCw size={18} />
            {t('ok')}
          </button>
        ) : (
          canScan && (
            <button className="btn btn--primary btn--wide" onClick={onScan}>
              <QrCode size={19} />
              {t('scanNow')}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/** 列表上方的连接提示：电脑不在线（显示缓存）/ 断线重连中。连接正常时什么都不显示。 */
export function Banner({ store }: { store: Store }): React.JSX.Element | null {
  const [late, setLate] = useState(false)
  const connecting = store.phase.kind === 'connecting'
  // 断线重连：两秒内恢复的不打扰。
  useEffect(() => {
    if (!connecting) return setLate(false)
    const id = window.setTimeout(() => setLate(true), 2000)
    return () => window.clearTimeout(id)
  }, [connecting])
  if (store.phase.kind === 'offline')
    return (
      <div className="banner">
        <CloudOff size={19} strokeWidth={1.8} />
        <span className="banner__k">
          <b>{t('offlineTitle', { pc: store.computer })}</b>
          {store.syncedAt ? t('offlineHint', { t: fmtListTime(store.syncedAt) }) : t('offlineHintNoCache')}
        </span>
      </div>
    )
  if (connecting && late && store.syncedAt)
    return (
      <div className="banner banner--thin">
        <span className="spin" />
        {t('reconnecting')}
      </div>
    )
  return null
}

const TIP_KEY = 'installTipAt'
const TIP_SNOOZE_MS = 7 * 24 * 3600_000

/** 首次在浏览器里打开：列表顶部提示添加到主屏幕（以后再说 = 一周内不再提示）。 */
export function InstallTip({ store }: { store: Store }): React.JSX.Element | null {
  const [hidden, setHidden] = useState(() => Date.now() - Number(prefGet(TIP_KEY) ?? 0) < TIP_SNOOZE_MS)
  const mobile = isIOS() || /Android/.test(navigator.userAgent)
  if (hidden || store.installed || isStandalone() || !mobile || !window.isSecureContext || !store.ready) return null
  const later = (): void => {
    prefSet(TIP_KEY, String(Date.now()))
    setHidden(true)
  }
  return (
    <div className="tip">
      <div className="tip__t">
        <Logo size={44} />
        <span className="tip__k">
          <b>{t('installTitle')}</b>
          <span>{t('installLead')}</span>
        </span>
      </div>
      <div className="tip__btns">
        <button className="btn" onClick={later}>
          {t('later')}
        </button>
        <button
          className="btn btn--primary"
          onClick={() => (store.nativeInstall ? void store.nativeInstall() : store.setOverlay('install'))}
        >
          {store.nativeInstall ? t('installAdd') : t('installHow')}
        </button>
      </div>
    </div>
  )
}

/**
 * 添加到主屏幕的步骤。打开时向电脑要一张安装票据写进地址：主屏幕图标保存的就是这个地址，
 * 首次从主屏幕打开时用它换自己的凭证（iOS 上主屏幕应用与 Safari 的存储可能不互通），不用再扫码。
 */
export function InstallSheet({ store, onClose }: { store: Store; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    let alive = true
    void store.link?.installTicket().then((ticket) => {
      if (!alive || !ticket) return
      const q = new URLSearchParams({ d: store.deskId, i: ticket, n: store.computer })
      history.replaceState(history.state, '', `${location.pathname}${location.search}#${q}`)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const ios = isIOS()
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet sheet--float" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__t">
          <b>{t('installSheetTitle')}</b>
          <span>{t('installSheetSub')}</span>
        </div>
        {ios ? (
          <div className="how">
            <div className="how__s">
              <span className="how__n">1</span>
              {t('installIos1')}
              <span className="kbd">
                <Share size={16} />
                {t('installIosShare')}
              </span>
            </div>
            <div className="how__s">
              <span className="how__n">2</span>
              {t('installIos2')}
              <span className="kbd">
                <SquarePlus size={16} />
                {t('installIosAdd')}
              </span>
            </div>
            <div className="how__s">
              <span className="how__n">3</span>
              {t('installIos3')}
            </div>
          </div>
        ) : (
          <div className="how">
            <div className="how__s">{t('installAndroid')}</div>
          </div>
        )}
        <div className="how__note">{t('installNote')}</div>
        <div className="sheet__btns">
          <button className="btn btn--ghost btn--wide" onClick={onClose}>
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 通知权限：先在应用里说明用途，点「允许通知」才弹系统授权框（直接弹容易被拒，拒了就不能再问）。 */
export function NotifySheet({ store, onClose }: { store: Store; onClose: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="dim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="state state--sheet">
          <span className="illus illus--accent">
            <Bell size={40} strokeWidth={1.5} />
          </span>
          <h2>{t('notifyTitle')}</h2>
          <p>{t('notifyLead')}</p>
        </div>
        <div className="sheet__btns">
          <button
            className="btn btn--primary btn--wide"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await store.enableNotify()
              setBusy(false)
              onClose()
            }}
          >
            {t('notifyAllow')}
          </button>
          <button className="btn btn--ghost btn--wide" onClick={onClose}>
            {t('notifyNotNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
