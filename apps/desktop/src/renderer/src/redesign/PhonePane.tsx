import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Copy, Loader2, QrCode, RefreshCw, Smartphone, Trash2, UserMinus, X } from 'lucide-react'
import QRCode from 'qrcode'
import type { PhoneDeviceView, PhoneState, PhoneVia } from '../../../shared/phone'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { PlatformLogo } from './PlatformLogo'
import './phone.css'

/**
 * 「手机」面板里的「Deva 手机版」（电脑端入口，单例）。面板里不区分「手机版」和「飞书 / Telegram 机器人」：
 * 都只是在手机上用 Deva 的方式，删除、移除的做法与它们一致（标题行一个删除按钮；行尾悬停出现的移除图标）。
 *
 * 详情（对比稿 design/phone-pane-v2.html 方案 C，以手机为中心）：
 *  · 主角是「已连接的手机」，右上角「连接新手机」点开才在原位出二维码，扫完原地变「已连接」，可关闭；
 *    还没有手机时二维码默认展开，布局不变；
 *  · 连接出问题：二维码收着时顶部一条横幅，展开时直接盖在二维码上（参考微信扫码登录）。
 * 走中转还是局域网在扫码时选（design/phone-conn.html 方案 D）：二维码上方「远程 | 局域网」，没有全局开关；
 * 远程的中转地址、局域网端口都只在配置文件里改（apps/relay/README.md）。状态由主进程 phone:changed 推送。
 */

const VIAS: PhoneVia[] = ['relay', 'lan']

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

type Overall = 'off' | 'connecting' | 'on' | 'error'

/** 总状态（列表行与标题下）：有通道出错算出错，有通道在连算连接中。 */
function overallOf(state: PhoneState | null): Overall {
  if (!state?.enabled) return 'off'
  const ls = [state.links.relay, state.links.lan]
  if (ls.some((l) => l.state === 'error')) return 'error'
  if (ls.some((l) => l.state === 'connecting')) return 'connecting'
  return 'on'
}

/** 左列表里的一行。 */
export function PhoneRow({ state, active, onClick }: { state: PhoneState | null; active: boolean; onClick: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const status = overallOf(state)
  const sub = !state?.enabled
    ? t('phone.rowOff')
    : state.devices.length
      ? t('phone.rowDevices').replace('{n}', String(state.devices.length))
      : t('phone.rowNone')
  return (
    <button className={`cf-trow bots-row phone-row${active ? ' is-active' : ''}`} onClick={onClick}>
      <PlatformLogo platform="web" size={30} />
      <div className="cf-trow__main">
        <div className="cf-trow__title">{t('phone.title')}</div>
        <div className="bots-row__meta">
          <span className={`bots-dot bots-dot--${status === 'on' ? 'connected' : status}`} />
          {sub}
        </div>
      </div>
    </button>
  )
}

type Qr = { phase: 'loading' } | { phase: 'ready'; qr: string; expiresAt: number } | { phase: 'failed'; message: string }

/** 二维码：出现即取（同时让主进程开启所选的通道），过期前 15 秒自动换新；换方式 / 卸载时作废。 */
function useQr(active: boolean, via: PhoneVia): { qr: Qr; refresh: () => void } {
  const [qr, setQr] = useState<Qr>({ phase: 'loading' })
  const timer = useRef<number | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    // 换新码时旧码留在原处，新码到手再替换（不闪加载圈）；只有第一次 / 失败后重试才显示加载。
    setQr((cur) => (cur.phase === 'ready' ? cur : { phase: 'loading' }))
    void window.deva.phone.qr(via).then((r) => {
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
  }, [via])

  useEffect(() => {
    alive.current = true
    // 换了方式：旧码不能再给人扫。
    setQr({ phase: 'loading' })
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

/**
 * 每条通道最近一次的出错原因：自动重试（connecting）期间仍按出错显示，不在「连接中 / 失败」之间来回跳；
 * 连上或关掉才清掉。null = 没出错。
 */
function useLinkErrors(links: PhoneState['links']): Record<PhoneVia, string | null> {
  const [errs, setErrs] = useState<Record<PhoneVia, string | null>>({ relay: null, lan: null })
  const { relay, lan } = links
  useEffect(() => {
    setErrs((cur) => {
      const next = { ...cur }
      for (const [v, l] of [
        ['relay', relay],
        ['lan', lan]
      ] as const) {
        if (l.state === 'error') next[v] = l.error ?? ''
        else if (l.state !== 'connecting') next[v] = null
      }
      return next.relay === cur.relay && next.lan === cur.lan ? cur : next
    })
  }, [relay, lan])
  return errs
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
  // 二维码收在「连接新手机」里，点开才出现；还没有手机时默认展开。
  const [panelOpen, setPanelOpen] = useState(state.devices.length === 0)
  // 扫码后手机走哪条路：默认上次选的。
  const [via, setVia] = useState<PhoneVia>(state.lastVia)
  const link = state.links[via]
  const errs = useLinkErrors(state.links)
  // 中转偶尔重连（短暂 connecting）时不收起二维码，免得整块来回切换。
  const [wasOn, setWasOn] = useState<PhoneVia | null>(null)
  useEffect(() => {
    if (link.state === 'on') setWasOn(via)
    else if (link.state !== 'connecting') setWasOn(null)
  }, [link.state, via])
  const hasDevices = state.devices.length > 0
  const online = state.enabled && (link.state === 'on' || (link.state === 'connecting' && wasOn === via))
  const { qr, refresh } = useQr(state.enabled && !paired && panelOpen, via)
  const [retrying, setRetrying] = useState(false)
  const [, setTick] = useState(0)

  // 扫码连上：二维码那块原地变成「已连接」。
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

  // 重连出错的通道（不等自动重试的间隔）。
  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await window.deva.phone.retry()
    } finally {
      setRetrying(false)
    }
  }

  const closePanel = (): void => {
    setPanelOpen(false)
    setPaired(null)
  }

  const status = overallOf(state)
  const err = errs[via]
  const view: 'off' | 'online' | 'connecting' | 'error' = !state.enabled
    ? 'off'
    : online
      ? 'online'
      : link.state === 'error' || err !== null
        ? 'error'
        : 'connecting'
  const errText = err || link.error

  /** 盖在二维码上的一层：点整块即可开启 / 重试（同微信「点击刷新」）。 */
  const mask: Mask | null =
    view === 'off'
      ? { title: t('phone.qrOff'), tap: t('phone.tapEnable'), onTap: busy ? undefined : () => void toggle() }
      : view === 'connecting'
        ? { spin: true, title: t('phone.connectingShort') }
        : view === 'error'
          ? link.state === 'connecting' || retrying
            ? { alert: true, title: t(`phone.linkDown.${via}`), sub: t('phone.retrying') }
            : { alert: true, title: t(`phone.linkDown.${via}`), tap: t('phone.tapRetry'), onTap: () => void retry() }
          : qr.phase === 'loading'
            ? { spin: true, title: t('phone.generating') }
            : qr.phase === 'failed'
              ? { alert: true, title: t('phone.qrFailed'), tap: t('phone.tapRetry'), onTap: refresh }
              : null

  const qrReady = view === 'online' && qr.phase === 'ready'
  // 切换远程 / 局域网、换新码时这一行和「复制链接」按钮都留在原处，只有二维码和文字在变：
  // 二维码还没好时倒计时淡出（仍占位，不跳），按钮照常可点（链接与二维码各自取票）。
  const countdown = (
    <span className={`phone-hero__meta${qrReady ? '' : ' is-hidden'}`} aria-hidden={!qrReady}>
      <RefreshCw size={12} />
      {t('phone.scanMeta').replace('{s}', qrReady ? fmtLeft(qr.expiresAt - 15_000 - Date.now()) : '2:00')}
    </span>
  )
  const qrErr =
    view === 'error' && errText ? (
      <span className="phone-hero__err">{errText}</span>
    ) : view === 'online' && qr.phase === 'failed' ? (
      <span className="phone-hero__err">{qr.message}</span>
    ) : null
  const seg = state.enabled && <ViaSeg via={via} onChange={setVia} />
  const lead = view === 'off' ? t('phone.introLead') : via === 'lan' ? t('phone.scanLeadLan') : t('phone.scanLead')

  // 连接出问题、而二维码收着（或展开的是另一条路）：顶部一条横幅，写清有几台手机受影响。
  const downVia = VIAS.find((v) => errs[v] !== null && state.devices.some((d) => d.via === v) && !(panelOpen && v === via))

  return (
    <>
      <div className="bots-detail__head">
        <PlatformLogo platform="web" size={44} />
        <div className="bots-detail__title">
          <span className="bots-detail__name">{t('phone.title')}</span>
          <span className={`bots-detail__state is-${status === 'on' ? 'connected' : status}`}>
            <span className={`bots-dot bots-dot--${status === 'on' ? 'connected' : status}`} />
            {t(`phone.status.${status}`)}
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

      {downVia && (
        <div className="phone-banner" title={errs[downVia] || undefined}>
          <AlertCircle size={15} />
          <b>{t(`phone.linkDown.${downVia}`)}</b>
          <span className="phone-banner__msg">
            {t('phone.linkDownDevices').replace('{n}', String(state.devices.filter((d) => d.via === downVia).length))}
          </span>
          {state.links[downVia].state === 'connecting' || retrying ? (
            <span className="phone-banner__sub">{t('phone.retrying')}</span>
          ) : (
            <button className="ext-linkbtn" onClick={() => void retry()}>
              {t('phone.retry')}
            </button>
          )}
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
          <div className={`phone-panel${paired ? '' : ' is-qr'}`}>
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
                  {seg}
                  <h5>{view === 'off' ? t('phone.introTitle') : t('phone.scanTitle')}</h5>
                  <p>{lead}</p>
                  {qrErr}
                  {view !== 'off' && (
                    <div className="phone-copy">
                      {countdown}
                      <CopyLink via={via} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {hasDevices ? <DeviceRows state={state} /> : !panelOpen && <p className="bots-card__empty">{t('phone.rowNone')}</p>}
      </div>
      <p className="bots-warn">{t('phone.security')}</p>
    </>
  )
}

/** 二维码上方「远程 | 局域网」：扫码后手机走哪条路。 */
function ViaSeg({ via, onChange }: { via: PhoneVia; onChange: (v: PhoneVia) => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="cf-seg phone-seg" role="tablist">
      {VIAS.map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={via === v}
          className={`cf-seg__opt${via === v ? ' is-on' : ''}`}
          onClick={() => via !== v && onChange(v)}
        >
          {t(`phone.via.${v}`)}
        </button>
      ))}
    </div>
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
function QrBox({ src, mask }: { src: string | null; mask: Mask | null }): React.JSX.Element {
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
    <div className={`phone-qr${mask ? ' is-dim' : ''}`}>
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

/** 复制网页版链接（发到手机上点开，或在别的设备的浏览器里打开）：一次性，10 分钟内有效，走当前选的方式。 */
function CopyLink({ via }: { via: PhoneVia }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const copy = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.deva.phone.link(via)
      if (!r.ok) return toast.show({ variant: 'error', message: r.error })
      await window.deva.clipboard.writeText(r.url).catch(() => navigator.clipboard?.writeText(r.url))
      toast.show({ variant: 'success', message: t('phone.linkCopied') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className="bots-btn" disabled={busy} onClick={() => void copy()}>
      <Copy size={13} />
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
              {/* 在浏览器里用是常态，不写；只标出添加到主屏幕的（能收通知）。 */}
              {d.kind === 'standalone' ? `${t('phone.deviceStandalone')} · ` : ''}
              {`${t(`phone.via.${d.via}`)} · `}
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
