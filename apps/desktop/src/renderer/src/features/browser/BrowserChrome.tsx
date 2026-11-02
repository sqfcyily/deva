import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CircleCheckBig,
  ExternalLink,
  Globe,
  Hand,
  Info,
  KeyRound,
  Loader2,
  Lock,
  PictureInPicture2,
  Pin,
  PinOff,
  RotateCw,
  ShieldCheck,
  Square,
  Upload,
  X,
  type LucideIcon
} from 'lucide-react'
import { BROWSER_CHROME, type BrowserUiState } from '../../../../shared/browser'
import type { PersonaRecord } from '../../../../preload'
import { useI18n } from '../../i18n/i18n'
import { PersonaFace, parseAvatarSpec } from '../../components/humation'
import { displayUrl, doingText, tabTitle } from './text'

const HANDOFF_ICON: Record<string, LucideIcon> = {
  login: KeyRound,
  captcha: ShieldCheck,
  upload: Upload,
  confirm: CircleCheckBig,
  other: Hand
}

const IS_MAC = navigator.userAgent.includes('Macintosh')

/**
 * 「Deva 浏览器」窗口的外框：标签条（占标题栏，带角色头像）、地址栏、状态条（Deva 正在操作 / 等你操作）。
 * 网页本身是主进程叠放在外框下方的原生视图（见 main/services/browser/host.ts），这里只画外框与网页四周的边框；
 * 各部分高度须与 BROWSER_CHROME 一致，主进程按同一套数字摆放网页。
 */
export function BrowserChrome(): React.JSX.Element {
  const { t } = useI18n()
  const [s, setS] = useState<BrowserUiState | null>(null)
  const [personas, setPersonas] = useState<Record<string, PersonaRecord>>({})

  useEffect(() => {
    void window.deva.browser.ready().then(setS)
    return window.deva.browser.onState(setS)
  }, [])

  // 标签上的头像：标签里出现没见过的角色时重新取一次角色表
  const personaKey = useMemo(
    () => [...new Set((s?.tabs ?? []).map((x) => x.personaId).filter(Boolean))].sort().join(','),
    [s?.tabs]
  )
  useEffect(() => {
    void window.deva.personas.list().then((list) => setPersonas(Object.fromEntries(list.map((p) => [p.id, p]))))
  }, [personaKey])

  const tabs = s?.tabs ?? []
  const active = tabs.find((x) => x.id === s?.active) ?? null
  const sid = active?.sessionId
  const handoff = s && sid && s.handoff[sid]?.tab === active?.id ? s.handoff[sid] : null
  const op = s && sid && !handoff && s.operating[sid]?.tab === active?.id ? s.operating[sid] : null
  const chromeH = BROWSER_CHROME.tabBar + BROWSER_CHROME.addressBar + (handoff || op ? BROWSER_CHROME.statusBar : 0)

  // 地址栏：不在编辑时跟随当前标签的网址；编辑中保留用户输入
  const [addr, setAddr] = useState('')
  const [editing, setEditing] = useState(false)
  const addrRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) setAddr(active ? displayUrl(active.url) : '')
  }, [active?.id, active?.url, editing])

  const persona = (id?: string): PersonaRecord | undefined => (id ? personas[id] : undefined)
  const face = (id?: string): React.JSX.Element => {
    const p = persona(id)
    return p ? (
      <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} title={p.name} />
    ) : (
      <Globe size={12} />
    )
  }
  const api = window.deva.browser
  // 状态条里说话的是这个对话的角色（没取到角色时叫 Deva）
  const who = persona(active?.personaId)?.name || 'Deva'
  const HandoffIcon = handoff ? (HANDOFF_ICON[handoff.reason] ?? Hand) : Hand

  return (
    <div className={`bc${IS_MAC ? ' is-mac' : ''}`}>
      <div className="bc-tabs">
        <div className="bc-tabs__list" role="tablist">
          {tabs.map((tab) => {
            const on = tab.id === s?.active
            const live = s?.operating[tab.sessionId]?.tab === tab.id
            const waiting = s?.handoff[tab.sessionId]?.tab === tab.id
            const p = persona(tab.personaId)
            const title = tabTitle(t, tab)
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={on}
                className={`bc-tab${on ? ' is-on' : ''}`}
                title={p ? `${title}\n${t('browser.openedBy').replace('{name}', p.name)}` : title}
                onMouseDown={(e) => {
                  if (e.button === 0) void api.activate(tab.id)
                  // 中键关闭（同常见浏览器）
                  if (e.button === 1) {
                    e.preventDefault()
                    void api.closeTab(tab.id)
                  }
                }}
              >
                <span className={`bc-tab__ava${live ? ' is-live' : ''}${waiting ? ' is-wait' : ''}`}>
                  {face(tab.personaId)}
                </span>
                <span className="bc-tab__title">{title}</span>
                {tab.loading && <Loader2 size={12} className="spin bc-tab__spin" />}
                <button
                  type="button"
                  className="bc-tab__x"
                  title={t('browser.closeTab')}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void api.closeTab(tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="bc-tabs__acts">
          <button
            type="button"
            className={`bc-ib${s?.pinned ? ' is-on' : ''}`}
            title={s?.pinned ? t('browser.unpin') : t('browser.pin')}
            onClick={() => void api.pin(!s?.pinned)}
          >
            {s?.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button type="button" className="bc-ib" title={t('browser.dock')} onClick={() => void api.dock()}>
            <PictureInPicture2 size={15} />
          </button>
        </div>
      </div>

      <div className="bc-bar">
        <button
          type="button"
          className="bc-ib"
          title={t('browser.back')}
          disabled={!active?.canGoBack}
          onClick={() => active && void api.nav(active.id, 'back')}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="bc-ib"
          title={t('browser.forward')}
          disabled={!active?.canGoForward}
          onClick={() => active && void api.nav(active.id, 'forward')}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="bc-ib"
          title={active?.loading ? t('browser.stopLoading') : t('browser.reload')}
          disabled={!active}
          onClick={() => active && void api.nav(active.id, active.loading ? 'stop' : 'reload')}
        >
          {active?.loading ? <X size={16} /> : <RotateCw size={15} />}
        </button>
        <form
          className="bc-addr"
          onSubmit={(e) => {
            e.preventDefault()
            if (active && addr.trim()) void api.navigate(active.id, addr.trim())
            addrRef.current?.blur()
          }}
        >
          {active?.url.startsWith('https:') ? <Lock size={13} /> : <Info size={13} />}
          <input
            ref={addrRef}
            value={addr}
            disabled={!active}
            spellCheck={false}
            placeholder={t('browser.address')}
            onFocus={(e) => {
              setEditing(true)
              e.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAddr(active ? displayUrl(active.url) : '')
                e.currentTarget.blur()
              }
            }}
          />
        </form>
        <button
          type="button"
          className="bc-ib"
          title={t('browser.openExternal')}
          disabled={!active || !/^https?:/.test(active.url)}
          onClick={() => active && void api.openExternal(active.id)}
        >
          <ExternalLink size={15} />
        </button>
      </div>

      {handoff && sid && (
        <div className="bc-strip is-handoff">
          <HandoffIcon size={15} className="bc-strip__icon" />
          <span className="bc-strip__text">
            <b>{t(`browser.handoff.${handoff.reason}`).replace('{name}', who)}</b>
            <span> · {handoff.message || t('browser.handoffHint')}</span>
          </span>
          <button type="button" className="bc-btn" onClick={() => void api.handoff(sid, 'skip')}>
            {t('browser.skip')}
          </button>
          <button type="button" className="bc-btn is-primary" onClick={() => void api.handoff(sid, 'done')}>
            {t('browser.done')}
          </button>
        </div>
      )}
      {op && sid && (
        <div className="bc-strip is-op">
          <span className="bc-strip__ava">{face(active?.personaId)}</span>
          <span className="bc-strip__text">
            <b>{t('browser.operating').replace('{name}', who)}</b>
            <span> · {doingText(t, op.action, op.label)}</span>
          </span>
          <button type="button" className="bc-btn" title={t('browser.stopHint')} onClick={() => void api.stop(sid)}>
            <Square size={9} />
            {t('browser.stop')}
          </button>
        </div>
      )}

      <div className={`bc-frame${op ? ' is-op' : ''}${handoff ? ' is-handoff' : ''}`} style={{ top: chromeH }}>
        {tabs.length === 0 && (
          <div className="bc-empty">
            <Globe size={28} />
            <div className="bc-empty__title">{t('browser.emptyTitle')}</div>
            <p>{t('browser.emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
