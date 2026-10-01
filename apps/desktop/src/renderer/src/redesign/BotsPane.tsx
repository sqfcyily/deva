import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Loader2, Plus, QrCode, RefreshCw, Search, X } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import feishuLogo from '../assets/platforms/feishu.svg'

type RemoteState = Awaited<ReturnType<typeof window.deva.remote.getState>>
type BotView = RemoteState['bots'][number]
type Platform = BotView['platform']

/** 可添加的平台（菜单顺序）。soon = 即将支持，菜单里置灰。 */
const PLATFORMS: { id: Platform | 'telegram'; soon?: boolean }[] = [{ id: 'feishu' }, { id: 'telegram', soon: true }]

/**
 * 「机器人」tab（图标栏「设置」上方）：与对话 / 角色 / 任务同一套面板——左列表 + 右详情。
 * 左列表顶部：搜索 + 「添加机器人」（悬停列出支持的平台，点即添加；扫码在弹框里完成）。
 * 机器人只能扫码创建：扫码即在平台上建好应用、拿到凭据，扫码人自动成为主人（已配对）。
 * 状态由主进程 remote:changed 推送，本面板只做展示与触发。
 */
export function BotsPane(): React.JSX.Element {
  const { t } = useI18n()
  const [bots, setBots] = useState<BotView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [viewId, setViewId] = useState<string | null>(null)
  const [adding, setAdding] = useState<Platform | null>(null)
  const [query, setQuery] = useState('')

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
    if (viewId && bots.some((b) => b.id === viewId)) return
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
          <BotAddMenu onPick={setAdding} />
        </div>
        <div className="cf-list">
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
        {view ? (
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
function BotAddMenu({ onPick }: { onPick: (p: Platform) => void }): React.JSX.Element {
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
                onPick(p.id as Platform)
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

/** 平台标志：有内置品牌图标的用图标，其余（尚未支持的平台）用简洁色块。 */
const PLATFORM_ICONS: Record<string, string> = { feishu: feishuLogo }

function PlatformLogo({ platform, size }: { platform: string; size: number }): React.JSX.Element {
  const icon = PLATFORM_ICONS[platform]
  if (icon)
    return <img className="bots-logo bots-logo--img" src={icon} width={size} height={size} alt="" aria-hidden />
  return (
    <span
      className={`bots-logo bots-logo--${platform}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
      aria-hidden
    >
      {platform === 'telegram' ? 'T' : <Bot size={size * 0.55} />}
    </span>
  )
}

// ───────── 添加：扫码弹框 ─────────

type ScanState =
  | { phase: 'loading' }
  | { phase: 'waiting'; qr: string; userCode?: string; expiresAt: number }
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
  const [st, setSt] = useState<ScanState>({ phase: 'loading' })
  const scanRef = useRef<string | null>(null)
  const [, setTick] = useState(0)

  const start = useCallback(async () => {
    if (scanRef.current) void window.deva.remote.scanCancel(scanRef.current)
    scanRef.current = null
    setSt({ phase: 'loading' })
    const r = await window.deva.remote.scanStart(platform)
    if (!r.ok) {
      setSt({ phase: 'failed', message: r.error })
      return
    }
    scanRef.current = r.scanId
    setSt({ phase: 'waiting', qr: r.qr, userCode: r.userCode, expiresAt: r.expiresAt })
  }, [platform])

  useEffect(() => {
    void start()
    // 关弹框：取消后台轮询。
    return () => {
      if (scanRef.current) void window.deva.remote.scanCancel(scanRef.current)
      scanRef.current = null
    }
  }, [start])

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
              <p className="bots-scan__lead">{t('bots.scanLead')}</p>
              {st.phase === 'waiting' && st.userCode && <code className="bots-scan__code">{st.userCode}</code>}
              {st.phase === 'waiting' && (
                <span className="bots-scan__status">
                  <Loader2 size={13} className="bots-spin" />
                  {t('bots.scanWaiting').replace('{s}', String(left))}
                </span>
              )}
              {st.phase === 'loading' && <span className="bots-scan__status">{t('bots.scanLoading')}</span>}
              {st.phase === 'failed' && <span className="bots-scan__status is-error">{st.message}</span>}
              {st.phase !== 'loading' && (
                <button className="bots-btn" onClick={() => void start()}>
                  <RefreshCw size={13} />
                  {st.phase === 'failed' ? t('bots.scanRetry') : t('bots.scanRefresh')}
                </button>
              )}
            </div>
          </div>
          <p className="bots-hint">{t('bots.scanNote')}</p>
        </div>
      </div>
    </div>
  )
}

// ───────── 详情 ─────────

/** 剩余秒数 → 「9:58」形式（邀请码 10 分钟有效，纯秒数太长不好读）。 */
function fmtLeft(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
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
      message: t('bots.deleteConfirm'),
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
          </span>
        </div>
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
            <span className="bots-card__hint">{t('bots.inviteHint')}</span>
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

      <div className="bots-card">
        <div className="bots-card__label">{t('bots.usage')}</div>
        <p className="bots-card__hint bots-usage">{t('bots.usageText')}</p>
      </div>

      <p className="bots-warn">{t('bots.security')}</p>
      <button className="ext-linkbtn bots-delete" onClick={() => void remove()}>
        {t('bots.delete')}
      </button>
    </>
  )
}
