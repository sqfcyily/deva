import { useEffect, useRef, useState } from 'react'
import {
  ChevronUp,
  CircleCheckBig,
  Globe,
  Hand,
  KeyRound,
  ShieldCheck,
  Square,
  SquareArrowOutUpRight,
  Upload,
  type LucideIcon
} from 'lucide-react'
import type { BrowserUiState } from '../../../../shared/browser'
import { useI18n } from '../../i18n/i18n'
import { useChat } from '../../store/chat'
import { displayUrl, doingText, tabTitle } from './text'
import './capsule.css'

const HANDOFF_ICON: Record<string, LucideIcon> = {
  login: KeyRound,
  captcha: ShieldCheck,
  upload: Upload,
  confirm: CircleCheckBig,
  other: Hand
}

/** 悬停多久浮出预览（鼠标路过不弹）。 */
const PREVIEW_DELAY = 300

/** 预览卡：看哪个标签；pinned = 点击打开的（鼠标移开不收，点外面或再点胶囊才收）。 */
interface Preview {
  tab: string
  img: string | null
  pinned: boolean
}

/**
 * 内置浏览器胶囊（输入框正上方，与待办清单 / 后台任务胶囊同一排）：本对话在浏览器里打开过网页才出现。
 * 显示 Deva 此刻在网页上做什么（可停止）、等你操作时的提示（「去处理」打开窗口）。
 * 悬停或点击胶囊浮出预览卡（网页缩略图、标题、网址），卡上的图标按钮才在「Deva 浏览器」窗口中打开——
 * 点胶囊本身不打开窗口。右侧箭头列出本对话打开的全部网页，点一行切到它的预览。
 */
export function BrowserCapsule({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const { t } = useI18n()
  const { stop, streaming } = useChat()
  const [s, setS] = useState<BrowserUiState | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.deva.browser.getState().then(setS)
    return window.deva.browser.onState(setS)
  }, [])
  useEffect(() => {
    setListOpen(false)
    setPreview(null)
  }, [sessionId])

  // 列表或点开的预览卡：点外面关闭；Esc 关闭并截住（不让输入框把它算作一次 Esc）
  const popupOpen = listOpen || !!preview?.pinned
  useEffect(() => {
    if (!popupOpen) return
    const close = (): void => {
      setListOpen(false)
      setPreview(null)
    }
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [popupOpen])
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  if (!s || !sessionId) return null
  const tabs = s.tabs.filter((x) => x.sessionId === sessionId)
  if (tabs.length === 0) return null
  const cur = tabs.find((x) => x.id === s.current[sessionId]) ?? tabs[tabs.length - 1]
  const op = s.operating[sessionId]
  const ho = s.handoff[sessionId]
  const api = window.deva.browser
  const shown = preview ? (tabs.find((x) => x.id === preview.tab) ?? cur) : cur

  const openWindow = (tab?: string): void => {
    window.clearTimeout(hoverTimer.current)
    setListOpen(false)
    setPreview(null)
    void api.open({ tab: tab ?? cur.id })
  }
  /** 打开某个标签的预览卡并取它此刻的缩略图。 */
  const showPreview = (tab: string, pinned: boolean): void => {
    window.clearTimeout(hoverTimer.current)
    setListOpen(false)
    setPreview({ tab, img: null, pinned })
    void api.thumbnail(tab).then((img) => setPreview((p) => (p && p.tab === tab ? { ...p, img } : p)))
  }
  const hoverIn = (): void => {
    if (listOpen || preview?.pinned) return
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => showPreview(cur.id, false), PREVIEW_DELAY)
  }
  const hoverOut = (): void => {
    window.clearTimeout(hoverTimer.current)
    // 移进预览卡不收（下方有 8px 桥接区）；点开的不随鼠标收
    hoverTimer.current = window.setTimeout(() => setPreview((p) => (p?.pinned ? p : null)), 150)
  }
  /** 点胶囊：切换点开的预览卡（不打开窗口）。 */
  const toggle = (): void => {
    if (preview?.pinned) setPreview(null)
    else showPreview(cur.id, true)
  }

  let body: React.JSX.Element
  if (ho) {
    const Icon = HANDOFF_ICON[ho.reason] ?? Hand
    body = (
      <>
        <Icon size={14} className="cf-browser__icon is-warn" />
        <span className="cf-browser__text">{t(`browser.handoffShort.${ho.reason}`)}</span>
        <button
          type="button"
          className="cf-browser__btn is-primary"
          onClick={(e) => {
            e.stopPropagation()
            openWindow(ho.tab)
          }}
        >
          {t('browser.goHandle')}
        </button>
      </>
    )
  } else if (op) {
    body = (
      <>
        <Globe size={14} className="cf-browser__icon is-live" />
        <span className="cf-browser__text tl__shimmer">{doingText(t, op.action, op.label)}</span>
        {streaming && (
          <button
            type="button"
            className="cf-browser__btn"
            title={t('browser.stopHint')}
            onClick={(e) => {
              e.stopPropagation()
              stop()
            }}
          >
            <Square size={9} />
            {t('browser.stop')}
          </button>
        )}
      </>
    )
  } else {
    body = (
      <>
        <Globe size={14} className="cf-browser__icon" />
        <span className="cf-browser__text">{tabTitle(t, cur)}</span>
      </>
    )
  }

  return (
    <div className={`cf-browser${listOpen ? ' is-open' : ''}`} ref={rootRef}>
      {listOpen && (
        <div className="cf-todo__panel" role="dialog" aria-label={t('browser.pages')}>
          <div className="cf-todo__head">
            <span className="cf-todo__title">{t('browser.pages')}</span>
            <span className="cf-browser__hint">{t('browser.pagesHint')}</span>
          </div>
          <div className="cf-todo__scroll cf-browser__list">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`cf-browser__row${tab.id === cur.id ? ' is-on' : ''}`}
                onClick={() => showPreview(tab.id, true)}
              >
                <Globe size={13} />
                <span className="cf-browser__row-title">{tabTitle(t, tab)}</span>
                <span className="cf-browser__row-url">{displayUrl(tab.url)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {preview && !listOpen && (
        <div
          className="cf-browser__preview"
          onMouseEnter={() => window.clearTimeout(hoverTimer.current)}
          onMouseLeave={hoverOut}
        >
          <div className="cf-browser__shot">
            {preview.img ? <img src={preview.img} alt="" draggable={false} /> : <span className="cf-browser__shot-empty" />}
          </div>
          <div className="cf-browser__meta">
            <div className="cf-browser__meta-text">
              <span className="cf-browser__meta-title">{tabTitle(t, shown)}</span>
              <span className="cf-browser__meta-url">{displayUrl(shown.url)}</span>
            </div>
            <button
              type="button"
              className="cf-browser__open"
              title={s.open ? t('browser.switchWindow') : t('browser.openWindow')}
              aria-label={s.open ? t('browser.switchWindow') : t('browser.openWindow')}
              onClick={() => openWindow(shown.id)}
            >
              <SquareArrowOutUpRight size={15} />
            </button>
          </div>
        </div>
      )}
      <div className="cf-browser__pill">
        <div
          className="cf-browser__main"
          role="button"
          tabIndex={0}
          aria-expanded={!!preview?.pinned}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle()
            }
          }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {body}
        </div>
        <button
          type="button"
          className="cf-browser__more"
          aria-expanded={listOpen}
          title={t('browser.pages')}
          onClick={() => {
            window.clearTimeout(hoverTimer.current)
            setPreview(null)
            setListOpen((v) => !v)
          }}
        >
          {tabs.length > 1 && <span className="cf-browser__count">{tabs.length}</span>}
          <ChevronUp size={14} />
        </button>
      </div>
    </div>
  )
}
