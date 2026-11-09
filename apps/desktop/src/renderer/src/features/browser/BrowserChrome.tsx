import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  CircleCheckBig,
  Ellipsis,
  Globe,
  Hand,
  KeyRound,
  Loader2,
  Lock,
  Pin,
  PinOff,
  ShieldCheck,
  Square,
  TriangleAlert,
  Upload,
  X,
  type LucideIcon
} from 'lucide-react'
import { BROWSER_CHROME, type BrowserUiState } from '../../../../shared/browser'
import type { PersonaRecord } from '../../../../preload'
import { useI18n } from '../../i18n/i18n'
import { PersonaFace, parseAvatarSpec } from '../../components/humation'
import { doingText, siteOf, tabTitle } from './text'

const HANDOFF_ICON: Record<string, LucideIcon> = {
  login: KeyRound,
  captcha: ShieldCheck,
  upload: Upload,
  confirm: CircleCheckBig,
  other: Hand
}

const IS_MAC = navigator.userAgent.includes('Macintosh')

/**
 * 「Deva 浏览器」窗口的外框：一行标签条（占标题栏，带角色头像；左侧后退，右侧「⋯」/ 置顶；收起用窗口的 ✕）与状态条
 * （Deva 正在操作 / 等你操作）。浏览器只给 Deva 用，不显示网址、不能输入网址；等用户登录等操作时在状态条里显示站点，
 * 输入密码前能确认是哪个网站。
 * 网页本身是主进程叠放在外框下方的原生视图（见 main/services/browser/host.ts），这里只画外框与网页四周的边框；
 * 各部分高度须与 BROWSER_CHROME 一致，主进程按同一套数字摆放网页。
 */
export function BrowserChrome(): React.JSX.Element {
  const { t } = useI18n()
  const [s, setS] = useState<BrowserUiState | null>(null)
  const [personas, setPersonas] = useState<Record<string, PersonaRecord>>({})
  const [menuOpen, setMenuOpen] = useState(false)

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
  // 等你操作：该对话的任一标签上都显示（登录页开了新标签时，在新标签里也能点「完成，继续」）；须与主进程 chromeHeight 一致
  const handoff = s && sid ? (s.handoff[sid] ?? null) : null
  const op = s && sid && !handoff && s.operating[sid]?.tab === active?.id ? s.operating[sid] : null
  const chromeH = BROWSER_CHROME.tabBar + (handoff || op ? BROWSER_CHROME.statusBar : 0)

  const persona = (id?: string): PersonaRecord | undefined => (id ? personas[id] : undefined)
  const face = (id?: string): React.JSX.Element => {
    const p = persona(id)
    return p ? (
      <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} title={p.name} compact />
    ) : (
      <Globe size={12} />
    )
  }
  const api = window.deva.browser
  // 状态条里说话的是这个对话的角色（没取到角色时叫 Deva）；成员请你操作时署成员名
  const who = handoff?.who || persona(active?.personaId)?.name || 'Deva'
  const HandoffIcon = handoff ? (HANDOFF_ICON[handoff.reason] ?? Hand) : Hand
  const site = handoff && active ? siteOf(active.url) : null

  const openMenu = (btn: HTMLElement): void => {
    if (!active || menuOpen) return
    const r = btn.getBoundingClientRect()
    setMenuOpen(true)
    void api
      .menu(
        active.id,
        {
          forward: t('browser.forward'),
          reload: t('browser.reload'),
          stopLoading: t('browser.stopLoading'),
          copyLink: t('browser.copyLink'),
          openExternal: t('browser.openExternal')
        },
        { x: r.left, y: r.bottom + 4 }
      )
      .finally(() => setMenuOpen(false))
  }

  return (
    <div className={`bc${IS_MAC ? ' is-mac' : ''}`}>
      <div className="bc-tabs">
        <div className="bc-tabs__nav">
          <button
            type="button"
            className="bc-ib"
            title={t('browser.back')}
            disabled={!active?.canGoBack}
            onClick={() => active && void api.nav(active.id, 'back')}
          >
            <ArrowLeft size={16} />
          </button>
        </div>
        <span className="bc-tabs__sep" />
        <div className="bc-tabs__list" role="tablist">
          {tabs.map((tab) => {
            const on = tab.id === s?.active
            const live = s?.operating[tab.sessionId]?.tab === tab.id
            const waiting = s?.handoff[tab.sessionId]?.tab === tab.id
            const p = persona(tab.personaId)
            const title = tabTitle(t, tab)
            const host = siteOf(tab.url)?.host
            // 悬停提示：标题、站点、谁打开的（不显示网址，想知道在哪个网站时看这里）
            const tip = [title, host && host !== title ? host : '', p ? t('browser.openedBy').replace('{name}', p.name) : '']
              .filter(Boolean)
              .join('\n')
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={on}
                className={`bc-tab${on ? ' is-on' : ''}`}
                title={tip}
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
            className={`bc-ib${menuOpen ? ' is-press' : ''}`}
            title={t('browser.more')}
            disabled={!active}
            onClick={(e) => openMenu(e.currentTarget)}
          >
            <Ellipsis size={16} />
          </button>
          <button
            type="button"
            className={`bc-ib${s?.pinned ? ' is-on' : ''}`}
            title={s?.pinned ? t('browser.unpin') : t('browser.pin')}
            onClick={() => void api.pin(!s?.pinned)}
          >
            {s?.pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          {/* 不单独放「收起」：窗口的 ✕ 就是收起（网页继续在后台运行），两个按钮作用相同 */}
        </div>
      </div>

      {handoff && sid && (
        <div className="bc-strip is-handoff">
          <HandoffIcon size={15} className="bc-strip__icon" />
          <span className="bc-strip__text">
            <b>{t(`browser.handoff.${handoff.reason}`).replace('{name}', who)}</b>
            {site && (
              <span
                className={`bc-site${site.secure ? '' : ' is-insecure'}`}
                title={site.secure ? undefined : t('browser.insecure')}
              >
                {site.secure ? <Lock size={12} /> : <TriangleAlert size={12} />}
                {site.host}
              </span>
            )}
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
