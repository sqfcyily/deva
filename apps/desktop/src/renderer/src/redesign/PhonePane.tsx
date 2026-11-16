import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, ExternalLink, Loader2, Lock, QrCode, RefreshCw, Smartphone, Trash2, UserMinus, X } from 'lucide-react'
import QRCode from 'qrcode'
import type { PhoneDeviceView, PhoneMode, PhoneState } from '../../../shared/phone'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import './phone.css'

/**
 * 「手机」面板里的「Deva 手机版」（电脑端入口，单例）。面板里不区分「手机版」和「飞书 / Telegram 机器人」：
 * 都只是在手机上用 Deva 的方式，删除、移除的做法与它们一致（标题行一个删除按钮；行尾悬停出现的移除图标）。
 *
 * 详情（对比稿 design/phone-pane-v2.html 方案 C，以手机为中心）：
 *  · 还没有手机：整页就是一个大二维码；
 *  · 已有手机：主角是「已连接的手机」，右上角「连接新手机」点开才在原位出二维码，扫完原地变「已连接」，可关闭；
 *  · 连接出问题：二维码收着时顶部一条横幅（重试 / 连接设置），展开时直接盖在二维码上（参考微信扫码登录）。
 * 二维码框位置大小始终不变；「连接设置」在下方展开。状态由主进程 phone:changed 推送。
 */

/** 「自己部署」说明页（暂用仓库里的中转说明，官网页面做好后替换）。 */
const RELAY_DOCS_URL = 'https://github.com/sqfcyily/deva/blob/main/apps/relay/README.md'

export function usePhoneState(): PhoneState | null {
  const [state, setState] = useState<PhoneState | null>(null)
  useEffect(() => {
    let alive = true
    void window.deva.phone.getState().then((s) => alive && setState(s))
    const off = window.deva.phone.onChanged(setState)
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/** 连接方式的简称：官方中转 / 自建中转 / 仅局域网（列表行与详情页标题下）。 */
function viaLabel(state: PhoneState, t: (k: string) => string): string {
  return t(`phone.via.${state.mode === 'lan' ? 'lan' : state.relayUrl ? 'custom' : 'official'}`)
}

/** 左列表里的一行。 */
export function PhoneRow({ state, active, onClick }: { state: PhoneState | null; active: boolean; onClick: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const status = state?.enabled ? state.status.state : 'off'
  const sub = !state?.enabled
    ? t('phone.rowOff')
    : state.devices.length
      ? t('phone.rowDevices').replace('{n}', String(state.devices.length))
      : t('phone.rowNone')
  return (
    <button className={`cf-trow bots-row phone-row${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="phone-row__ic" aria-hidden>
        <Smartphone size={17} />
      </span>
      <div className="cf-trow__main">
        <div className="cf-trow__title">{t('phone.title')}</div>
        <div className="bots-row__meta">
          <span className={`bots-dot bots-dot--${status === 'on' ? 'connected' : status}`} />
          {sub}
          {state?.enabled && <span className="bots-tag">{viaLabel(state, t)}</span>}
        </div>
      </div>
    </button>
  )
}

type Qr = { phase: 'loading' } | { phase: 'ready'; qr: string; expiresAt: number } | { phase: 'failed'; message: string }

/** 二维码：出现即取，过期前 15 秒自动换新；卸载时作废。 */
function useQr(active: boolean): { qr: Qr; refresh: () => void } {
  const [qr, setQr] = useState<Qr>({ phase: 'loading' })
  const timer = useRef<number | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    // 换新码时旧码留在原处，新码到手再替换（不闪加载圈）；只有第一次 / 失败后重试才显示加载。
    setQr((cur) => (cur.phase === 'ready' ? cur : { phase: 'loading' }))
    void window.deva.phone.qr().then((r) => {
      if (!alive.current) return
      if (!r.ok) return setQr({ phase: 'failed', message: r.error })
      // 等新图解码好再换，免得替换那一帧是空白。
      const img = new Image()
      img.onload = img.onerror = () => {
        if (!alive.current) return
        setQr({ phase: 'ready', qr: r.qr, expiresAt: r.expiresAt })
        timer.current = window.setTimeout(refresh, Math.max(5_000, r.expiresAt - Date.now() - 15_000))
      }
      img.src = r.qr
    })
  }, [])

  useEffect(() => {
    alive.current = true
    if (active) refresh()
    return () => {
      alive.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
      void window.deva.phone.qrCancel()
    }
  }, [active, refresh])

  return { qr, refresh }
}

function fmtLeft(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

export function PhoneDetail({ state }: { state: PhoneState }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = useState(false)
  const [paired, setPaired] = useState<{ id: string; name: string } | null>(null)
  // 有手机后二维码收进「连接新手机」里，点开才出现（对比稿 design/phone-pane-v2.html 方案 C）。
  const [panelOpen, setPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 中转偶尔重连（短暂 connecting）时不收起二维码，免得整块来回切换。
  const [wasOn, setWasOn] = useState(false)
  useEffect(() => {
    if (state.status.state === 'on') setWasOn(true)
    else if (state.status.state !== 'connecting') setWasOn(false)
  }, [state.status.state])
  // 最近一次连接失败的原因：中转自动重试（connecting）期间仍按失败显示，不在「连接中 / 失败」之间来回跳。
  const [lastErr, setLastErr] = useState<string | null>(null)
  useEffect(() => {
    if (state.status.state === 'error') setLastErr(state.status.error ?? null)
    else if (state.status.state === 'on' || state.status.state === 'off') setLastErr(null)
  }, [state.status.state, state.status.error])
  const hasDevices = state.devices.length > 0
  const qrShown = !hasDevices || panelOpen
  const online = state.enabled && (state.status.state === 'on' || (state.status.state === 'connecting' && wasOn))
  const { qr, refresh } = useQr(online && !paired && qrShown)
  const [retrying, setRetrying] = useState(false)
  const [, setTick] = useState(0)

  // 扫码连上：二维码那块原地变成「已连接」（第一台手机连上后页面换成列表，这块在列表上方展开着）。
  useEffect(
    () =>
      window.deva.phone.onPaired((p) => {
        setPaired(p)
        setPanelOpen(true)
      }),
    []
  )
  // 二维码倒计时。
  useEffect(() => {
    if (qr.phase !== 'ready') return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [qr.phase])

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.deva.phone.setEnabled(!state.enabled)
    } catch (e) {
      toast.show({ variant: 'error', message: (e as Error)?.message ?? t('bots.failed') })
    } finally {
      setBusy(false)
    }
  }

  // 删除：与飞书 / Telegram 的删除同一套（标题行垃圾桶 + 确认框）。
  const remove = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('phone.title'),
      message: t('phone.deleteConfirm'),
      confirmText: t('common.delete'),
      variant: 'danger'
    })
    if (ok) await window.deva.phone.remove()
  }

  // 重连：按当前设置重启连接（不等自动重试的间隔）。
  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await window.deva.phone.setMode({})
    } finally {
      setRetrying(false)
    }
  }

  const closePanel = (): void => {
    setPanelOpen(false)
    setPaired(null)
  }

  const status = state.enabled ? state.status.state : 'off'
  const view: 'off' | 'online' | 'connecting' | 'error' = !state.enabled
    ? 'off'
    : online
      ? 'online'
      : status === 'error' || lastErr
        ? 'error'
        : 'connecting'
  const errText = lastErr ?? state.status.error

  /** 盖在二维码上的一层：点整块即可开启 / 重试（同微信「点击刷新」）。 */
  const mask: Mask | null =
    view === 'off'
      ? { title: t('phone.qrOff'), tap: t('phone.tapEnable'), onTap: busy ? undefined : () => void toggle() }
      : view === 'connecting'
        ? { spin: true, title: t('phone.connectingShort') }
        : view === 'error'
          ? status === 'connecting' || retrying
            ? { alert: true, title: t('phone.qrError'), sub: t('phone.retrying') }
            : { alert: true, title: t('phone.qrError'), tap: t('phone.tapRetry'), onTap: () => void retry() }
          : qr.phase === 'loading'
            ? { spin: true, title: t('phone.generating') }
            : qr.phase === 'failed'
              ? { alert: true, title: t('phone.qrFailed'), tap: t('phone.tapRetry'), onTap: refresh }
              : null

  const qrReady = view === 'online' && qr.phase === 'ready'
  const countdown = qrReady && (
    <span className="phone-hero__meta">
      <RefreshCw size={12} />
      {t('phone.scanMeta').replace('{s}', fmtLeft(qr.expiresAt - 15_000 - Date.now()))}
    </span>
  )
  const qrErr =
    view === 'error' ? (
      <span className="phone-hero__err">{errText}</span>
    ) : view === 'online' && qr.phase === 'failed' ? (
      <span className="phone-hero__err">{qr.message}</span>
    ) : null

  /** 「官方中转 · 端到端加密  连接设置」一行，点开在下面展开连接设置。 */
  const via = state.enabled && (
    <div className="phone-via">
      <Lock size={12} />
      <span>{viaLabel(state, t)}</span>
      {state.mode === 'relay' && <span>· {t('phone.e2e')}</span>}
      <button className="ext-linkbtn" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
        {settingsOpen ? t('phone.collapse') : t('phone.connSettings')}
      </button>
    </div>
  )
  const settings = settingsOpen && state.enabled && (
    <div className="bots-card phone-settings">
      <ConnectionSettings state={state} />
    </div>
  )

  return (
    <>
      <div className="bots-detail__head">
        <span className="phone-row__ic phone-row__ic--lg" aria-hidden>
          <Smartphone size={24} />
        </span>
        <div className="bots-detail__title">
          <span className="bots-detail__name">{t('phone.title')}</span>
          <span className={`bots-detail__state is-${status === 'on' ? 'connected' : status}`}>
            <span className={`bots-dot bots-dot--${status === 'on' ? 'connected' : status}`} />
            {t(`phone.status.${status}`)}
            {state.enabled && (
              <>
                <span className="bots-detail__sep">·</span>
                {viaLabel(state, t)}
              </>
            )}
          </span>
        </div>
        <button className="icon-btn provider-detail__del" title={t('bots.delete')} onClick={() => void remove()}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('bots.enable')}</span>
        <button
          className={`cf-switch${state.enabled ? ' is-on' : ''}`}
          aria-pressed={state.enabled}
          disabled={busy}
          title={t('bots.enable')}
          onClick={() => void toggle()}
        >
          <span className="cf-switch__dot" />
        </button>
      </div>

      {!hasDevices ? (
        // 还没有手机：整页就是一个大二维码（第一次用零步骤）。
        <>
          <div className="phone-first">
            <QrBox src={qr.phase === 'ready' ? qr.qr : null} mask={mask} large />
            <h5>{view === 'off' ? t('phone.introTitle') : t('phone.scanTitle')}</h5>
            <p>{view === 'off' ? t('phone.introLead') : t('phone.scanLead')}</p>
            {qrErr}
            {qrReady && (
              <div className="phone-first__line">
                {countdown}
                <CopyLink plain />
              </div>
            )}
            {via}
          </div>
          {settings}
        </>
      ) : (
        <>
          {/* 连接出问题且二维码收着：顶部一条横幅（展开时问题直接盖在二维码上，不重复提示）。 */}
          {view === 'error' && !panelOpen && (
            <div className="phone-banner">
              <AlertCircle size={15} />
              <b>{t('phone.qrError')}</b>
              <span className="phone-banner__msg">{errText}</span>
              {status === 'connecting' || retrying ? (
                <span className="phone-banner__sub">{t('phone.retrying')}</span>
              ) : (
                <button className="ext-linkbtn" onClick={() => void retry()}>
                  {t('phone.retry')}
                </button>
              )}
              <button className="ext-linkbtn" onClick={() => setSettingsOpen(true)}>
                {t('phone.connSettings')}
              </button>
            </div>
          )}
          <div className="bots-card phone-devs">
            <div className="bots-card__row">
              <div className="bots-card__label">
                {t('phone.devices')}
                <span className="bots-card__hint">{t('phone.devicesHint')}</span>
              </div>
              {!panelOpen && (
                <button className="bots-btn" onClick={() => setPanelOpen(true)}>
                  <QrCode size={13} />
                  {t('phone.connectNew')}
                </button>
              )}
            </div>
            {panelOpen && (
              <div className="phone-panel">
                <button className="phone-panel__close" title={t('common.close')} aria-label={t('common.close')} onClick={closePanel}>
                  <X size={14} />
                </button>
                {paired ? (
                  <>
                    <div className="phone-done">
                      <span className="phone-done__ok">
                        <Check size={30} strokeWidth={2.6} />
                      </span>
                      <b>{t('phone.pairedBadge').replace('{name}', paired.name)}</b>
                    </div>
                    <div className="phone-hero__text">
                      <h5>{t('phone.pairedTitle').replace('{name}', paired.name)}</h5>
                      <p>{t('phone.pairedLead')}</p>
                      <div className="phone-hero__btns">
                        <button className="bots-btn" onClick={() => setPaired(null)}>
                          {t('phone.pairAnother')}
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <QrBox src={qr.phase === 'ready' ? qr.qr : null} mask={mask} />
                    <div className="phone-hero__text">
                      <h5>{view === 'off' ? t('phone.introTitle') : t('phone.scanTitle')}</h5>
                      <p>{view === 'off' ? t('phone.introLead') : t('phone.scanLead')}</p>
                      {countdown}
                      {qrErr}
                      {qrReady && (
                        <div className="phone-hero__btns">
                          <CopyLink />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <DeviceRows state={state} />
          </div>
          {via}
          {settings}
        </>
      )}
      <p className="bots-warn">{t('phone.security')}</p>
    </>
  )
}

interface Mask {
  title: string
  spin?: boolean
  alert?: boolean
  sub?: string
  /** 可点：整块是一个按钮，下面一行写「点击开启 / 点击重试」。 */
  tap?: string
  onTap?: () => void
}

/** 占位二维码（固定内容，只用作没有真码时被盖住的底图，免得那一块空着）。 */
let placeholderQr: Promise<string> | null = null
function usePlaceholderQr(): string | null {
  const [uri, setUri] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    placeholderQr ??= QRCode.toDataURL('Deva', { margin: 1, width: 300, errorCorrectionLevel: 'H' })
    void placeholderQr.then((u) => alive && setUri(u))
    return () => {
      alive = false
    }
  }, [])
  return uri
}

/**
 * 二维码框：位置和大小始终不变。没有真码（未开启 / 生成中 / 连接中 / 连不上）时用占位码打底、模糊变淡，
 * 上面盖一层说明；能操作的（开启 / 重试）整块可点（参考微信扫码登录「二维码已失效，点击刷新」）。
 */
function QrBox({ src, mask, large }: { src: string | null; mask: Mask | null; large?: boolean }): React.JSX.Element {
  const placeholder = usePlaceholderQr()
  const img = src ?? placeholder
  const body = mask && (
    <>
      {mask.spin && <Loader2 size={26} className="bots-spin" />}
      {mask.alert && <AlertCircle size={28} className="phone-qr__alert" />}
      <span className="phone-qr__title">{mask.title}</span>
      {mask.sub && <span className="phone-qr__sub">{mask.sub}</span>}
      {mask.tap && <span className="phone-qr__tap">{mask.tap}</span>}
    </>
  )
  return (
    <div className={`phone-qr${large ? ' is-lg' : ''}${mask ? ' is-dim' : ''}`}>
      {img && <img key={img} src={img} alt={src ? 'QR' : ''} />}
      {mask &&
        (mask.onTap ? (
          <button className="phone-qr__mask is-tap" onClick={mask.onTap}>
            {body}
          </button>
        ) : (
          <div className="phone-qr__mask">{body}</div>
        ))}
    </div>
  )
}

/** 复制网页版链接（发到手机上点开，或在别的设备的浏览器里打开）：一次性，10 分钟内有效。 */
function CopyLink({ plain }: { plain?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const copy = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.deva.phone.link()
      if (!r.ok) return toast.show({ variant: 'error', message: r.error })
      await window.deva.clipboard.writeText(r.url).catch(() => navigator.clipboard?.writeText(r.url))
      toast.show({ variant: 'success', message: t('phone.linkCopied') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className={plain ? 'ext-linkbtn phone-copy' : 'bots-btn'} disabled={busy} onClick={() => void copy()}>
      <Copy size={plain ? 12 : 13} />
      {t('phone.copyLink')}
    </button>
  )
}

function fmtAgo(at: number | undefined, t: (k: string) => string): string {
  if (!at) return ''
  const d = Date.now() - at
  if (d < 60_000) return t('phone.justNow')
  const today = new Date().toDateString() === new Date(at).toDateString()
  return today
    ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : new Date(at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}

/** 已连接的手机的各行：行尾悬停出现移除图标（与飞书 / Telegram 的「可以使用的账号」同款）。 */
function DeviceRows({ state }: { state: PhoneState }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const fresh = (d: PhoneDeviceView): boolean => Date.now() - d.pairedAt < 10 * 60_000
  const remove = async (d: PhoneDeviceView): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('phone.removeTitle'),
      message: t('phone.removeConfirm'),
      confirmText: t('phone.remove'),
      variant: 'danger'
    })
    if (ok) await window.deva.phone.removeDevice(d.id)
  }
  return (
    <>
      {state.devices.map((d) => (
          <div key={d.id} className="phone-dev">
            <span className="phone-dev__ic">
              <Smartphone size={16} />
              {d.online && <span className="phone-dev__on" />}
            </span>
            <span className="phone-dev__k">
              <b>
                {d.name}
                {fresh(d) && <em>{t('phone.deviceNew')}</em>}
              </b>
              <span>
                {d.kind ? `${t(`phone.deviceKind.${d.kind}`)} · ` : ''}
                {d.online ? t('phone.deviceOnline') : t('phone.deviceSeen').replace('{t}', fmtAgo(d.lastSeen ?? d.pairedAt, t))}
                {d.push ? ` · ${t('phone.devicePush')}` : ''}
              </span>
            </span>
            <button className="cf-rowdel" title={t('phone.remove')} aria-label={t('phone.remove')} onClick={() => void remove(d)}>
              <UserMinus size={14} />
            </button>
          </div>
      ))}
    </>
  )
}

const MODES: PhoneMode[] = ['relay', 'lan']

/**
 * 连接设置（在二维码卡片里展开）：中转 | 局域网 两种方式平等可选。中转地址留空 = Deva 官方中转，
 * 也可以填自己部署的中转（开源，可自建）；局域网可改端口。地址与端口改完点「保存」才生效。
 */
function ConnectionSettings({ state }: { state: PhoneState }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [url, setUrl] = useState(state.relayUrl)
  const [port, setPort] = useState(String(state.port))
  const [saving, setSaving] = useState(false)
  useEffect(() => setUrl(state.relayUrl), [state.relayUrl])
  useEffect(() => setPort(String(state.port)), [state.port])

  const apply = async (patch: { mode?: PhoneMode; relayUrl?: string; port?: number }): Promise<void> => {
    setSaving(true)
    try {
      const r = await window.deva.phone.setMode(patch)
      if (!r.ok) toast.show({ variant: 'error', message: r.error || t('bots.failed') })
    } finally {
      setSaving(false)
    }
  }
  const savePort = (): void => {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return toast.show({ variant: 'error', message: t('phone.portInvalid') })
    void apply({ port: n })
  }
  const urlDirty = url.trim() !== state.relayUrl
  const portDirty = port !== String(state.port)

  return (
    <div className="phone-conn">
      <div className="phone-conn__row">
        <div className="cf-seg">
          {MODES.map((m) => (
            <button
              key={m}
              className={`cf-seg__opt${state.mode === m ? ' is-on' : ''}`}
              disabled={saving}
              onClick={() => state.mode !== m && void apply({ mode: m })}
            >
              {t(`phone.modeOpt.${m}`)}
            </button>
          ))}
        </div>
        <span className="phone-conn__hint">{t(`phone.modeHint.${state.mode}`)}</span>
      </div>
      {state.mode === 'relay' ? (
        <>
          <div className="phone-field">
            <input
              className="phone-field__input"
              value={url}
              placeholder={state.officialUrl || 'https://relay.example.com'}
              spellCheck={false}
              aria-label={t('phone.relayAddr')}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && urlDirty && void apply({ relayUrl: url.trim() })}
            />
            <button className="bots-btn" disabled={!urlDirty || saving} onClick={() => void apply({ relayUrl: url.trim() })}>
              {t('phone.save')}
            </button>
          </div>
          <div className="phone-conn__foot">
            <span>{t('phone.relayHint')}</span>
            {state.relayUrl && (
              <button className="ext-linkbtn" disabled={saving} onClick={() => void apply({ relayUrl: '' })}>
                {t('phone.restoreDefault')}
              </button>
            )}
            <a className="ext-linkbtn phone-conn__docs" href={RELAY_DOCS_URL} target="_blank" rel="noreferrer">
              {t('phone.selfHost')}
              <ExternalLink size={11} />
            </a>
          </div>
        </>
      ) : (
        <>
          <div className="phone-field">
            <span className="phone-field__label">{t('phone.port')}</span>
            <input
              className="phone-field__input phone-field__input--port"
              value={port}
              inputMode="numeric"
              aria-label={t('phone.port')}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onKeyDown={(e) => e.key === 'Enter' && portDirty && savePort()}
            />
            <button className="bots-btn" disabled={!portDirty || saving} onClick={savePort}>
              {t('phone.save')}
            </button>
          </div>
          <div className="phone-conn__foot">
            <span>{t('phone.lanNote')}</span>
          </div>
        </>
      )}
    </div>
  )
}
