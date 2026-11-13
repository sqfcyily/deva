import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ExternalLink, KeyRound, Loader2, Plus, QrCode, RefreshCw, Search, Smartphone, Trash2, X } from 'lucide-react'
import QRCode from 'qrcode'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { PersonaFace, parseAvatarSpec } from '../components/humation'
import { type SessionMeta, useChatState } from '../store/chat'
import { useExtensions } from '../store/extensions'
import feishuLogo from '../assets/platforms/feishu.svg'
import telegramLogo from '../assets/platforms/telegram.svg'

type RemoteState = Awaited<ReturnType<typeof window.deva.remote.getState>>
type BotView = RemoteState['bots'][number]
type Platform = BotView['platform']
type Scope = BotView['scope']
type ScopeKind = Exclude<Scope['mode'], 'all'>
type GeneralView = Awaited<ReturnType<typeof window.deva.general.getState>>

/** 与主进程 hub 同口径：没绑定角色的旧对话算默认角色。 */
const DEFAULT_PERSONA_ID = 'general'

/** 可添加的平台（菜单顺序）。soon = 即将支持，菜单里置灰。 */
const PLATFORMS: { id: Platform; soon?: boolean }[] = [{ id: 'feishu' }, { id: 'telegram' }]

/**
 * 「机器人」tab（图标栏「设置」上方）：与对话 / 角色 / 任务同一套面板——左列表 + 右详情。
 * 左列表顶部：搜索 + 「添加机器人」（悬停列出支持的平台，点即添加；扫码在弹框里完成）。
 * 机器人都经扫码创建，扫码人自动成为主人（已配对）：飞书扫码即在平台上建好应用；
 * Telegram 先粘贴 @BotFather 给的 Token，再扫码打开机器人点 Start 认领。
 * 状态由主进程 remote:changed 推送，本面板只做展示与触发。
 */
export function BotsPane(): React.JSX.Element {
  const { t } = useI18n()
  const [bots, setBots] = useState<BotView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [viewId, setViewId] = useState<string | null>(null)
  const [adding, setAdding] = useState<Platform | null>(null)
  const [query, setQuery] = useState('')
  const [general, setGeneral] = useState<GeneralView | null>(null)
  // 「+」菜单选通用设备时的自动出码信号
  const [generalPairTick, setGeneralPairTick] = useState(0)

  // 通用设备通道状态（channel-server）：general:changed 推送为主，30s 轮询兜底
  useEffect(() => {
    void window.deva.general.getState().then(setGeneral)
    const off = window.deva.general.onChanged(setGeneral)
    const id = window.setInterval(() => void window.deva.general.getState().then(setGeneral), 30_000)
    return () => {
      off()
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.deva.remote.getState().then((s) => {
      if (!alive) return
      setBots(s.bots)
      setLoaded(true)
    })
    const off = window.deva.remote.onChanged((s) => setBots(s.bots))
    return () => {
      alive = false
      off()
    }
  }, [])

  // 默认选第一个；选中的被删除后同理回落。
  useEffect(() => {
    // 'general' 是通用设备通道详情的保留 viewId,不属于 bots 列表
    if (viewId && (viewId === 'general' || bots.some((b) => b.id === viewId))) return
    setViewId(bots[0]?.id ?? null)
  }, [bots, viewId])

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (q ? bots.filter((b) => (b.name || '').toLowerCase().includes(q)) : bots),
    [bots, q]
  )
  const view = bots.find((b) => b.id === viewId) ?? null

  return (
    <>
      <aside className="cf-rail">
        <div className="cf-rail__top">
          <div className="cf-search">
            <Search className="cf-search__icon" size={14} />
            <input
              className="cf-search__input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('bots.search')}
              aria-label={t('bots.search')}
            />
            {query && (
              <button
                className="cf-search__clear"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={() => setQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <BotAddMenu onPick={setAdding} onPickGeneral={() => {
            setViewId('general')
            setGeneralPairTick((n) => n + 1)
          }} />
        </div>
        <div className="cf-list">
          <button
            className={`cf-trow bots-row${viewId === 'general' ? ' is-active' : ''}`}
            onClick={() => setViewId('general')}
          >
            <span className="bots-logo">
              <Smartphone size={18} />
            </span>
            <div className="cf-trow__main">
              <div className="cf-trow__title">{t('bots.general.title')}</div>
              <div className="bots-row__meta">
                <span className={`bots-dot bots-dot--${general?.state ?? 'off'}`} />
                {t(`bots.general.stateLabel.${general?.state ?? 'off'}`)}
                {general && (
                  <span className="bots-tag">
                    {general.devices.filter((d) => d.online).length}/{general.devices.length}
                  </span>
                )}
              </div>
            </div>
          </button>
          {!loaded ? null : bots.length === 0 ? (
            <div className="cf-empty">{t('bots.listEmpty')}</div>
          ) : shown.length === 0 ? (
            <div className="cf-empty">{t('cf.searchNoResults')}</div>
          ) : (
            shown.map((b) => (
              <button
                key={b.id}
                className={`cf-trow bots-row${b.id === viewId ? ' is-active' : ''}`}
                onClick={() => setViewId(b.id)}
              >
                <PlatformLogo platform={b.platform} size={30} />
                <div className="cf-trow__main">
                  <div className="cf-trow__title">{b.name || t('bots.unnamed')}</div>
                  <div className="bots-row__meta">
                    <span className={`bots-dot bots-dot--${b.enabled ? b.state : 'off'}`} />
                    {t(`bots.platform.${b.platform}`)}
                    {b.region && <span className="bots-tag">{t(`bots.region.${b.region}`)}</span>}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="cf-conv">
        <div className="cf-dragbar" aria-hidden="true" />
        {viewId === 'general' ? (
          <div className="cf-profile">
            <div className="bots-detail">
              <GeneralDetail pairRequest={generalPairTick} />
            </div>
          </div>
        ) : view ? (
          <div className="cf-profile">
            <div className="bots-detail">
              <BotDetail key={view.id} bot={view} />
            </div>
          </div>
        ) : (
          <div className="cf-quick">
            <div className="cf-quick__inner">
              <div className="cf-quick__title">{t('bots.title')}</div>
              <div className="cf-quick__hint">{loaded && bots.length ? t('bots.detailEmpty') : t('bots.paneHint')}</div>
            </div>
          </div>
        )}
      </main>

      {adding && (
        <ScanModal
          platform={adding}
          onClose={() => setAdding(null)}
          onCreated={(id) => {
            setAdding(null)
            setViewId(id)
          }}
        />
      )}
    </>
  )
}

/** 「添加机器人」：悬停展开支持的平台（交互同角色 / 任务的 AddMenu），点击即开始添加。 */
function BotAddMenu({
  onPick,
  onPickGeneral
}: {
  onPick: (p: Platform) => void
  onPickGeneral: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  // 离开时略延迟收起，避免从 + 按钮移到浮层项途中的短暂空档导致闪烁。
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }
  useEffect(() => cancelClose, [])

  return (
    <div
      className="cf-addmenu"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        className="cf-rail__addbtn"
        title={t('bots.add')}
        aria-label={t('bots.add')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="cf-addmenu__pop" role="menu">
          <button
            className="cf-addmenu__item bots-addmenu__item"
            role="menuitem"
            onClick={() => {
              cancelClose()
              setOpen(false)
              onPickGeneral()
            }}
          >
            <Smartphone size={14} />
            {t('bots.general.addMenu')}
          </button>
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              className="cf-addmenu__item bots-addmenu__item"
              role="menuitem"
              disabled={p.soon}
              onClick={() => {
                if (p.soon) return
                cancelClose()
                setOpen(false)
                onPick(p.id)
              }}
            >
              <PlatformLogo platform={p.id} size={20} />
              <span>{t(`bots.platform.${p.id}`)}</span>
              {p.soon && <span className="bots-tag">{t('bots.soon')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 平台标志：有内置品牌图标的用图标，其余用通用机器人图标。 */
const PLATFORM_ICONS: Record<string, string> = { feishu: feishuLogo, telegram: telegramLogo }

function PlatformLogo({ platform, size }: { platform: string; size: number }): React.JSX.Element {
  const icon = PLATFORM_ICONS[platform]
  if (icon)
    return <img className="bots-logo bots-logo--img" src={icon} width={size} height={size} alt="" aria-hidden />
  return (
    <span className={`bots-logo bots-logo--${platform}`} style={{ width: size, height: size }} aria-hidden>
      <Bot size={size * 0.55} />
    </span>
  )
}

// ───────── 添加：扫码弹框 ─────────

const BOTFATHER_URL = 'https://t.me/BotFather'

type ScanState =
  /** Telegram 第一步：粘贴 @BotFather 给的 Token。 */
  | { phase: 'token'; error?: string }
  | { phase: 'loading' }
  | { phase: 'waiting'; qr: string; link?: string; userCode?: string; expiresAt: number }
  | { phase: 'failed'; message: string }

function ScanModal({
  platform,
  onClose,
  onCreated
}: {
  platform: Platform
  onClose: () => void
  onCreated: (botId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const needsToken = platform === 'telegram'
  const [st, setSt] = useState<ScanState>(needsToken ? { phase: 'token' } : { phase: 'loading' })
  const [token, setToken] = useState('')
  // Telegram 第一步的二维码：扫码在手机上打开 @BotFather 建机器人（固定链接，本地生成）。
  const [bfQr, setBfQr] = useState('')
  const scanRef = useRef<string | null>(null)

  useEffect(() => {
    if (!needsToken) return
    let alive = true
    void QRCode.toDataURL(BOTFATHER_URL, { margin: 1, width: 360 }).then((u) => alive && setBfQr(u))
    return () => {
      alive = false
    }
  }, [needsToken])
  const [, setTick] = useState(0)

  const cancelScan = useCallback((): void => {
    if (scanRef.current) void window.deva.remote.scanCancel(scanRef.current)
    scanRef.current = null
  }, [])

  const start = useCallback(async () => {
    cancelScan()
    setSt({ phase: 'loading' })
    const r = await window.deva.remote.scanStart(platform, needsToken ? { token } : undefined)
    if (!r.ok) {
      // Telegram 的失败多半是 Token 不对：退回输入步骤，就地提示。
      setSt(needsToken ? { phase: 'token', error: r.error } : { phase: 'failed', message: r.error })
      return
    }
    scanRef.current = r.scanId
    setSt({ phase: 'waiting', qr: r.qr, link: r.link, userCode: r.userCode, expiresAt: r.expiresAt })
  }, [platform, needsToken, token, cancelScan])

  // 飞书打开即取二维码；Telegram 等填完 Token。
  const startRef = useRef(start)
  startRef.current = start
  useEffect(() => {
    if (!needsToken) void startRef.current()
  }, [needsToken])

  // 关弹框：取消后台轮询。
  useEffect(() => cancelScan, [cancelScan])

  useEffect(
    () =>
      window.deva.remote.onScan((ev) => {
        if (ev.scanId !== scanRef.current) return
        scanRef.current = null
        if (ev.status === 'done') onCreated(ev.botId)
        else if (ev.status !== 'cancelled')
          setSt({ phase: 'failed', message: ev.status === 'error' ? ev.error : t(`bots.scan.${ev.status}`) })
      }),
    [onCreated, t]
  )

  // 倒计时刷新（只为显示剩余时间）。
  useEffect(() => {
    if (st.phase !== 'waiting') return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [st.phase])

  const left = st.phase === 'waiting' ? Math.max(0, Math.ceil((st.expiresAt - Date.now()) / 1000)) : 0
  const title = t('bots.addTitle').replace('{p}', t(`bots.platform.${platform}`))
  // 认领链接 t.me/<机器人>?start=… → 显示 @机器人，方便扫不了码时手动搜索。
  const botName = st.phase === 'waiting' && st.link ? new URL(st.link).pathname.slice(1) : ''

  return (
    <div className="cf-modal__backdrop">
      <div className="cf-modal bots-scanmodal" role="dialog" aria-label={title}>
        <div className="cf-modal__head">
          <span className="cf-modal__title">{title}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="bots-scanmodal__body">
          {st.phase === 'token' ? (
            <div className="bots-scan">
              <div className="bots-scan__qr">
                {bfQr ? <img src={bfQr} alt="QR" /> : <Loader2 size={28} className="bots-spin" />}
              </div>
              <form
                className="bots-scan__side"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (token.trim()) void start()
                }}
              >
                <p className="bots-scan__lead">{t('bots.tokenLead')}</p>
                <code className="bots-scan__code">@BotFather</code>
                <div className="bots-token__row">
                  <input
                    className="cf-input bots-token__input"
                    type="password"
                    value={token}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('bots.tokenPlaceholder')}
                    aria-label={t('bots.tokenPlaceholder')}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <button className="bots-btn" type="submit" disabled={!token.trim()}>
                    <KeyRound size={13} />
                    {t('bots.tokenSave')}
                  </button>
                </div>
                {st.error && <span className="bots-scan__status is-error">{st.error}</span>}
                <a className="bots-btn" href={BOTFATHER_URL} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} />
                  {t('bots.openBotFather')}
                </a>
              </form>
            </div>
          ) : (
            <div className="bots-scan">
              <div className="bots-scan__qr">
                {st.phase === 'waiting' ? (
                  <img src={st.qr} alt="QR" />
                ) : st.phase === 'failed' ? (
                  <QrCode size={48} className="bots-scan__placeholder" />
                ) : (
                  <Loader2 size={28} className="bots-spin" />
                )}
              </div>
              <div className="bots-scan__side">
                <p className="bots-scan__lead">{t(`bots.scanLead.${platform}`)}</p>
                {st.phase === 'waiting' && st.userCode && <code className="bots-scan__code">{st.userCode}</code>}
                {botName && <code className="bots-scan__code">@{botName}</code>}
                {st.phase === 'waiting' && st.link && (
                  <a className="ext-linkbtn" href={st.link} target="_blank" rel="noreferrer">
                    {t('bots.scanOpenLink')}
                  </a>
                )}
                {st.phase === 'waiting' && (
                  <span className="bots-scan__status">
                    <Loader2 size={13} className="bots-spin" />
                    {t('bots.scanWaiting').replace('{s}', fmtLeft(left))}
                  </span>
                )}
                {st.phase === 'loading' && (
                  <span className="bots-scan__status">{t(`bots.scanLoading.${platform}`)}</span>
                )}
                {st.phase === 'failed' && <span className="bots-scan__status is-error">{st.message}</span>}
                {st.phase !== 'loading' && (
                  <button className="bots-btn" onClick={() => void start()}>
                    <RefreshCw size={13} />
                    {st.phase === 'failed' ? t('bots.scanRetry') : t('bots.scanRefresh')}
                  </button>
                )}
                {needsToken && st.phase !== 'loading' && (
                  <button
                    className="ext-linkbtn"
                    onClick={() => {
                      cancelScan()
                      setSt({ phase: 'token' })
                    }}
                  >
                    {t('bots.tokenChange')}
                  </button>
                )}
              </div>
            </div>
          )}
          <p className="bots-hint">{t(`bots.scanNote.${platform}`)}</p>
        </div>
      </div>
    </div>
  )
}

// ───────── 详情 ─────────

/** 剩余秒数 → 「9:58」形式（邀请码 10 分钟有效，纯秒数太长不好读）。 */
function fmtLeft(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function BotDetail({ bot }: { bot: BotView }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const dialog = useDialog()
  const [busy, setBusy] = useState(false)
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!pair) return
    const id = window.setInterval(() => {
      if (Date.now() >= pair.expiresAt) setPair(null)
      else setTick((n) => n + 1)
    }, 1000)
    return () => window.clearInterval(id)
  }, [pair])

  // 有新账号配对成功即收起邀请码。
  const userCount = bot.users.length
  useEffect(() => setPair(null), [userCount])

  // 离开详情（切到别的机器人 / 别的 tab）时作废还挂着的邀请码：看不到的码不该继续有效。
  const pairRef = useRef(pair)
  pairRef.current = pair
  useEffect(
    () => () => {
      if (pairRef.current) void window.deva.remote.pairCancel(bot.id)
    },
    [bot.id]
  )

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.deva.remote.setEnabled(bot.id, !bot.enabled)
      if (!r.ok) toast.show({ variant: 'error', message: r.error || t('bots.failed') })
    } finally {
      setBusy(false)
    }
  }

  const removeUser = async (id: string): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('bots.removeUser'),
      message: t('bots.removeUserConfirm'),
      confirmText: t('bots.removeUser'),
      variant: 'danger'
    })
    if (ok) await window.deva.remote.removeUser(bot.id, id)
  }

  const remove = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: bot.name || t('bots.unnamed'),
      message: t(`bots.deleteConfirm.${bot.platform}`),
      confirmText: t('common.delete'),
      variant: 'danger'
    })
    if (ok) await window.deva.remote.deleteBot(bot.id)
  }

  const state = bot.enabled ? bot.state : 'off'
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - Date.now()) / 1000)) : 0

  return (
    <>
      <div className="bots-detail__head">
        <PlatformLogo platform={bot.platform} size={44} />
        <div className="bots-detail__title">
          <span className="bots-detail__name">{bot.name || t('bots.unnamed')}</span>
          <span className={`bots-detail__state is-${state}`}>
            <span className={`bots-dot bots-dot--${state}`} />
            {t(`bots.state.${state}`)}
            <span className="bots-detail__sep">·</span>
            {t(`bots.platform.${bot.platform}`)}
            {bot.region && <span className="bots-tag">{t(`bots.region.${bot.region}`)}</span>}
            {bot.username && (
              <>
                <span className="bots-detail__sep">·</span>@{bot.username}
              </>
            )}
          </span>
        </div>
        <button className="icon-btn provider-detail__del" title={t('bots.delete')} onClick={() => void remove()}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('bots.enable')}</span>
        <button
          className={`cf-switch${bot.enabled ? ' is-on' : ''}`}
          aria-pressed={bot.enabled}
          disabled={busy}
          title={t('bots.enable')}
          onClick={() => void toggle()}
        >
          <span className="cf-switch__dot" />
        </button>
      </div>
      {bot.enabled && bot.state === 'error' && bot.error && <div className="mcp-error">{bot.error}</div>}

      <div className="bots-card">
        <div className="bots-card__row">
          <div className="bots-card__label">
            {t('bots.users')}
            <span className="bots-card__hint">{t('bots.usersHint')}</span>
          </div>
          {bot.state === 'connected' && !pair && (
            <button className="bots-btn" onClick={() => void window.deva.remote.pairCode(bot.id).then(setPair)}>
              {t('bots.invite')}
            </button>
          )}
        </div>
        {pair && (
          <div className="bots-pair">
            <span className="bots-card__hint">{t(`bots.inviteHint.${bot.platform}`)}</span>
            <code className="bots-pair__code">/pair {pair.code}</code>
            <div className="bots-pair__meta">
              <span className="bots-card__hint">{t('bots.inviteExpires').replace('{s}', fmtLeft(left))}</span>
              <button className="ext-linkbtn" onClick={() => void window.deva.remote.pairCode(bot.id).then(setPair)}>
                {t('bots.inviteRegen')}
              </button>
              <button
                className="ext-linkbtn"
                onClick={() => {
                  setPair(null)
                  void window.deva.remote.pairCancel(bot.id)
                }}
              >
                {t('bots.inviteCancel')}
              </button>
            </div>
          </div>
        )}
        {bot.users.length === 0 ? (
          <p className="bots-card__empty">{t('bots.usersEmpty')}</p>
        ) : (
          bot.users.map((u, i) => (
            <div key={u.id} className="bots-user">
              <span className="bots-user__id">{u.name || u.id}</span>
              {i === 0 && <span className="bots-tag">{t('bots.owner')}</span>}
              <span className="bots-user__at">{new Date(u.pairedAt).toLocaleString()}</span>
              <button className="ext-linkbtn" onClick={() => void removeUser(u.id)}>
                {t('bots.removeUser')}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="bots-card">
        <div className="bots-card__row">
          <div className="bots-card__label">
            {t('bots.replyMode')}
            <span className="bots-card__hint">{t(`bots.replyModeHint.${bot.replyMode}`)}</span>
          </div>
          <div className="cf-seg">
            {(['stream', 'final'] as const).map((m) => (
              <button
                key={m}
                className={`cf-seg__opt${bot.replyMode === m ? ' is-on' : ''}`}
                onClick={() => void window.deva.remote.setReplyMode(bot.id, m)}
              >
                {t(`bots.replyModeOpt.${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ScopeCard bot={bot} />

      <div className="bots-card">
        <div className="bots-card__label">{t('bots.usage')}</div>
        <p className="bots-card__hint bots-usage">{t('bots.usageText')}</p>
      </div>

      <p className="bots-warn">{t('bots.security')}</p>
    </>
  )
}

// ───────── 回复范围 ─────────

/**
 * 「回复范围」：全部 / 角色 / 对话。后两者多选；计数只算还存在的（选中的都删了即「已选择 0 个」）。
 * 范围同时决定推送与 /list、/use 能看到的对话，判定在主进程 hub，这里只编辑配置。
 */
function ScopeCard({ bot }: { bot: BotView }): React.JSX.Element {
  const { t } = useI18n()
  const { personas } = useExtensions()
  const { sessions: railSessions } = useChatState()
  const [sessions, setSessions] = useState<SessionMeta[]>(railSessions)
  const [picking, setPicking] = useState<ScopeKind | null>(null)
  const scope = bot.scope

  // 对话清单直接问主进程：手机上 /new 的对话在首轮之前进不了左侧列表，用它计数会少算。
  // 左侧列表变了（删对话）或范围变了（手机上新建的对话自动纳入）都重取一次。
  useEffect(() => {
    let alive = true
    void window.deva.chat.listSessions(null).then((list) => alive && setSessions(list))
    return () => {
      alive = false
    }
  }, [railSessions, scope])

  const picked = (k: ScopeKind): number =>
    k === 'personas'
      ? scope.personas.filter((id) => personas.some((p) => p.id === id)).length
      : scope.sessions.filter((id) => sessions.some((s) => s.id === id)).length

  const save = (next: Scope): void => void window.deva.remote.setScope(bot.id, next)

  const pickMode = (m: Scope['mode']): void => {
    if (m === scope.mode) return
    // 切到一个都还没选的「角色 / 对话」：先弹出选择，确定后才生效，免得一切换就什么都不推了。
    if (m !== 'all' && picked(m) === 0) setPicking(m)
    else save({ ...scope, mode: m })
  }

  return (
    <div className="bots-card">
      <div className="bots-card__row">
        <div className="bots-card__label">
          {t('bots.scope')}
          <span className="bots-card__hint">{t(`bots.scopeHint.${scope.mode}`)}</span>
        </div>
        <div className="cf-seg">
          {(['all', 'personas', 'sessions'] as const).map((m) => (
            <button
              key={m}
              className={`cf-seg__opt${scope.mode === m ? ' is-on' : ''}`}
              onClick={() => pickMode(m)}
            >
              {t(`bots.scopeOpt.${m}`)}
            </button>
          ))}
        </div>
      </div>
      {scope.mode !== 'all' && (
        <div className="bots-scope">
          <span className="bots-card__hint">
            {t(`bots.scopePicked.${scope.mode}`).replace('{n}', String(picked(scope.mode)))}
          </span>
          <button className="bots-btn" onClick={() => setPicking(scope.mode as ScopeKind)}>
            {t('bots.scopePick')}
          </button>
        </div>
      )}
      {picking && (
        <ScopePicker
          kind={picking}
          selected={scope[picking]}
          personas={personas}
          sessions={sessions}
          onClose={() => setPicking(null)}
          onSave={(ids) => {
            save({ ...scope, mode: picking, [picking]: ids })
            setPicking(null)
          }}
        />
      )}
    </div>
  )
}

function ScopePicker({
  kind,
  selected,
  personas,
  sessions,
  onClose,
  onSave
}: {
  kind: ScopeKind
  selected: string[]
  personas: ReturnType<typeof useExtensions>['personas']
  sessions: SessionMeta[]
  onClose: () => void
  onSave: (ids: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [picked, setPicked] = useState(() => new Set(selected))
  const [query, setQuery] = useState('')

  const items = useMemo(() => {
    const byId = new Map(personas.map((p) => [p.id, p]))
    if (kind === 'personas')
      return personas.map((p) => ({
        id: p.id,
        title: p.name,
        sub: p.enabled ? p.desc : t('bots.scopeDisabled'),
        persona: p
      }))
    return sessions.map((s) => {
      const p = byId.get(s.personaId ?? '') ?? byId.get(DEFAULT_PERSONA_ID)
      return {
        id: s.id,
        title: s.title || t('bots.scopeUntitled'),
        sub: `${p?.name ?? 'Deva'} · ${new Date(s.updatedAt).toLocaleString()}`,
        persona: p
      }
    })
  }, [kind, personas, sessions, t])

  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((i) => i.title.toLowerCase().includes(q)) : items

  const toggle = (id: string): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const title = t(`bots.scopePickTitle.${kind}`)
  return (
    <div className="cf-modal__backdrop">
      <div className="cf-modal bots-pickmodal" role="dialog" aria-label={title}>
        <div className="cf-modal__head">
          <span className="cf-modal__title">{title}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="bots-pick__search">
          <div className="cf-search">
            <Search className="cf-search__icon" size={14} />
            <input
              className="cf-search__input"
              type="text"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('bots.scopeSearch')}
              aria-label={t('bots.scopeSearch')}
            />
          </div>
        </div>
        <div className="bots-pick__list">
          {items.length === 0 ? (
            <div className="cf-empty">{t(`bots.scopeListEmpty.${kind}`)}</div>
          ) : shown.length === 0 ? (
            <div className="cf-empty">{t('cf.searchNoResults')}</div>
          ) : (
            shown.map((i) => (
              <label key={i.id} className={`bots-pick__row${picked.has(i.id) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <span className="bots-pick__ava">
                  <PersonaFace
                    seed={i.persona?.id ?? DEFAULT_PERSONA_ID}
                    spec={parseAvatarSpec(i.persona?.avatar)}
                    image={i.persona?.avatarImage}
                  />
                </span>
                <span className="bots-pick__main">
                  <span className="bots-pick__title">{i.title}</span>
                  {i.sub && <span className="bots-pick__sub">{i.sub}</span>}
                </span>
              </label>
            ))
          )}
        </div>
        <div className="bots-pick__foot">
          <button className="cf-btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {/* 只存列表里还存在的：已删除的角色 / 对话顺手从配置里清掉。 */}
          <button
            className="cf-btn is-primary"
            onClick={() => onSave(items.filter((i) => picked.has(i.id)).map((i) => i.id))}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}


/**
 * 安卓入站通道详情（设计 §3.2/§3.5 的桌面面）：状态 + 一次性配对码（二维码）+ 已配对设备。
 * 状态每 5s 轮询（配对码生成/作废/吊销后立即刷新）；通道启停挂在主进程生命周期，此处只读。
 */
function GeneralDetail({ pairRequest }: { pairRequest: number }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  // pairRequest 只消费一次:+ 菜单触发的自动出码不能在每次重挂载时都顶掉旧码
  const handledPairRequest = useRef(-1)
  // 配对码活着时的引用:离开详情(unmount)即作废——看不到的码不该继续有效(与 IM BotDetail 同口径)
  const livePair = useRef(false)
  const [st, setSt] = useState<GeneralView | null>(null)
  const [pair, setPair] = useState<
    Extract<Awaited<ReturnType<typeof window.deva.general.pairCode>>, { ok: true }> | null
  >(null)
  const [, setTick] = useState(0)

  const reload = useCallback((): void => {
    void window.deva.general.getState().then(setSt)
  }, [])

  // general:changed 推送到达时 reload(getChannelServerState 全量刷新)
  useEffect(() => {
    reload()
    return window.deva.general.onChanged(() => reload())
  }, [reload])

  // 配对码倒计时；过期自动收起
  useEffect(() => {
    if (!pair) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [pair])
  useEffect(() => {
    livePair.current = pair !== null
  }, [pair])
  // 离开详情:未过期的配对码立即作废——看不到的码不该继续有效(与 IM BotDetail 同口径)
  useEffect(
    () => () => {
      if (livePair.current) void window.deva.general.pairCancel()
    },
    []
  )
  // 「+」菜单选通用设备:导航到此详情并自动出码(每个 tick 只消费一次)
  useEffect(() => {
    if (pairRequest > 0 && handledPairRequest.current !== pairRequest) {
      handledPairRequest.current = pairRequest
      makeCode()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairRequest])
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - Date.now()) / 1000)) : 0
  useEffect(() => {
    if (pair && left <= 0) {
      livePair.current = false
      setPair(null)
    }
  }, [pair, left])

  const makeCode = (): void => {
    void window.deva.general.pairCode().then((r) => {
      if (r.ok) {
        setPair(r)
        livePair.current = true
      } else {
        setPair(null)
        livePair.current = false
        toast.show({ variant: 'error', message: r.error || t('bots.failed') })
      }
    })
  }

  const revoke = async (id: string, name: string): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('bots.general.revoke'),
      message: t('bots.general.revokeConfirm').replace('{name}', name || id),
      confirmText: t('bots.general.revoke'),
      variant: 'danger'
    })
    if (!ok) return
    await window.deva.general.removeDevice(id)
    reload()
  }

  const state = st?.state ?? 'off'

  return (
    <>
      <div className="bots-detail__head">
        <span className="bots-logo">
          <Smartphone size={22} />
        </span>
        <div className="bots-detail__title">
          <span className="bots-detail__name">{t('bots.general.title')}</span>
          <span className={`bots-detail__state is-${state}`}>
            <span className={`bots-dot bots-dot--${state}`} />
            {t(`bots.state.${state}`)}
            {st && (
              <>
                <span className="bots-detail__sep">·</span>
                {t('bots.general.listen').replace('{host}', st.host).replace('{port}', String(st.port))}
                <span className="bots-detail__sep">·</span>
                {st.devices.length}
              </>
            )}
          </span>
        </div>
      </div>
      {st?.state === 'error' && st.error && <div className="mcp-error">{st.error}</div>}

      <div className="bots-card">
        <div className="bots-card__row">
          <div className="bots-card__label">
            {t('bots.general.enable')}
            <span className="bots-card__hint">{t('bots.general.enableHint')}</span>
          </div>
          <button
            className={`cf-switch${(st?.enabled ?? true) ? ' is-on' : ''}`}
            aria-pressed={st?.enabled ?? true}
            title={t('bots.general.enable')}
            onClick={() => {
              const next = !(st?.enabled ?? true)
              void window.deva.general.setEnabled(next)
              setSt((s0) => (s0 ? { ...s0, enabled: next, state: next ? 'connecting' : 'off' } : s0))
            }}
          >
            <span className="cf-switch__dot" />
          </button>
        </div>
        <p className="bots-card__hint">{t('bots.general.hint')}</p>
        <div className="bots-card__row">
          <div className="bots-card__label">
            {t('bots.general.pair')}
            <span className="bots-card__hint">{t('bots.general.pairHint')}</span>
          </div>
          <button className="bots-btn" onClick={makeCode}>
            {t('bots.general.pair')}
          </button>
        </div>
        {pair && (
          <div className="bots-pair">
            <img src={pair.qr} alt="QR" width={140} height={140} />
            <code className="bots-pair__code">{pair.code}</code>
            <div className="bots-pair__meta">
              <span className="bots-card__hint">
                {(pair.hosts ?? [pair.host]).map((h) => `${h}:${pair.port}`).join(' / ')}
              </span>
              <span className="bots-card__hint">{t('bots.general.pairExpires').replace('{s}', fmtLeft(left))}</span>
              <button className="ext-linkbtn" onClick={makeCode}>
                {t('bots.general.pairRegen')}
              </button>
              <button
                className="ext-linkbtn"
                onClick={() => {
                  livePair.current = false
                  setPair(null)
                  void window.deva.general.pairCancel()
                }}
              >
                {t('bots.general.pairCancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="bots-card">
        <div className="bots-card__row">
          <div className="bots-card__label">
            {t('bots.general.hostMode')}
            <span className="bots-card__hint">{t('bots.general.hostModeHint')}</span>
          </div>
          <div className="cf-seg">
            {(['0.0.0.0', '127.0.0.1'] as const).map((h) => (
              <button
                key={h}
                className={`cf-seg__opt${st?.host === h ? ' is-on' : ''}`}
                onClick={() => {
                  void window.deva.general.setHost(h)
                  // 立即反馈：重启监听约一两秒，5s 轮询会把真实状态带回来
                  setSt((s0) => (s0 ? { ...s0, host: h, state: s0.state === 'connected' ? 'connecting' : s0.state } : s0))
                }}
              >
                {t(h === '0.0.0.0' ? 'bots.general.lan' : 'bots.general.localOnly')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bots-card">
        <div className="bots-card__label">
          {t('bots.general.devices')}
          {st && <span className="bots-tag">{st.devices.length}</span>}
        </div>
        {!st || st.devices.length === 0 ? (
          <p className="bots-card__empty">{t('bots.general.devicesEmpty')}</p>
        ) : (
          st.devices.map((d) => (
            <div key={d.id} className="bots-user">
              <span className="bots-user__id">{d.name || d.id}</span>
              {d.online && <span className="bots-tag">{t('bots.general.online')}</span>}
              <span className="bots-user__at">{new Date(d.pairedAt).toLocaleString()}</span>
              {d.lastSeenAt > 0 && (
                <span className="bots-user__at">
                  {t('bots.general.lastSeen').replace('{t}', new Date(d.lastSeenAt).toLocaleString())}
                </span>
              )}
              <button className="ext-linkbtn" onClick={() => void revoke(d.id, d.name)}>
                {t('bots.general.revoke')}
              </button>
            </div>
          ))
        )}
      </div>

      <p className="bots-warn">{t('bots.general.plain')}</p>
    </>
  )
}
