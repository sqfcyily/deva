import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronUp,
  CircleCheckBig,
  Globe,
  Hand,
  KeyRound,
  Pin,
  PinOff,
  ShieldCheck,
  Upload,
  X,
  type LucideIcon
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChatState } from '../../store/chat'
import { useDockOrder } from '../chat/dockOrder'
import { doingText, siteOf, tabTitle } from './text'
import { PagesPanel, useBrowserState } from './shared'
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

/**
 * 预览卡：tab = 看哪个标签，null 表示跟着 Deva（等你操作的 → 正在操作的 → 当前标签）。
 * mode：hover = 悬停浮出（移开即收）；open = 点胶囊打开（移开不收，点别处 / Esc / 再点胶囊收）；
 * pinned = 卡上点了「固定」（点别处、打字都不收，可以边聊边看；取消固定或再点胶囊才收）。
 */
interface Preview {
  tab: string | null
  mode: 'hover' | 'open' | 'pinned'
}

/**
 * 内置浏览器胶囊（输入框正上方，与待办清单 / 后台任务胶囊同一排）：本对话在浏览器里打开过网页才出现。
 * 显示 Deva 此刻在网页上做什么（停止用输入框的停止键，这里不重复放）、等你操作时的提示（「去处理」打开窗口）。
 * 悬停或点胶囊浮出预览卡：网页的实时画面（主进程按 CDP 推送，只在卡显示时推；点画面在「Deva 浏览器」窗口中打开）、
 * 标题（不显示网址，悬停标题看站点）、固定、关闭（关掉这个网页）。有两个以上网页时右侧出箭头，列出本对话打开的全部网页：
 * 点一行预览它，✕ 关掉它，标题右侧「全部关闭」；只有一个网页时没有箭头，关网页用卡上的「关闭」。
 */
export function BrowserCapsule({ sessionId }: { sessionId: string | null }): React.JSX.Element | null {
  const { t } = useI18n()
  const { streaming } = useChatState()
  const s = useBrowserState()
  const api = window.deva.browser
  const [listOpen, setListOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  /** 打开预览时先放一张截图（实时画面的首帧到之前不空着）。 */
  const [thumb, setThumb] = useState<{ tab: string; src: string } | null>(null)
  const [frame, setFrame] = useState<{ tab: string; src: string } | null>(null)
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const hoverTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  const tabs = s && sessionId ? s.tabs.filter((x) => x.sessionId === sessionId) : []
  const focusId = s && sessionId ? (s.handoff[sessionId]?.tab ?? s.operating[sessionId]?.tab ?? s.current[sessionId]) : undefined
  const cur = tabs.find((x) => x.id === focusId) ?? tabs[tabs.length - 1]
  const shown = preview ? (tabs.find((x) => x.id === preview.tab) ?? cur) : cur
  /** 预览卡正在看的标签（卡没打开为 undefined）。 */
  const previewId = preview ? shown?.id : undefined
  const order = useDockOrder(!!(s && sessionId && cur), sessionId)

  useEffect(() => {
    setListOpen(false)
    setPreview(null)
  }, [sessionId])
  // 关到只剩一个网页：箭头没了，列表一并收起
  useEffect(() => {
    if (tabs.length <= 1) setListOpen(false)
  }, [tabs.length])

  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  // 预览卡打开先取一张截图：不看可见性（实测有时窗口在前台、页面却报 hidden），保证卡片不空着
  useEffect(() => {
    if (!previewId) return
    void api.thumbnail(previewId).then((src) => src && setThumb({ tab: previewId, src }))
  }, [api, previewId])
  // 实时画面：预览卡显示且主窗口可见时推它正在看的标签（最小化等不可见时停推，省资源）
  useEffect(() => api.onLiveFrame((f) => setFrame({ tab: f.tab, src: `data:image/jpeg;base64,${f.data}` })), [api])
  useEffect(() => {
    if (!previewId || !visible) return
    void api.liveStart(previewId)
    return () => void api.liveStop()
  }, [api, previewId, visible])

  // 固定着的预览卡在看哪个标签：告诉主进程（用户正在看，Deva 关不掉、闲置也不回收）
  const pinnedTab = preview?.mode === 'pinned' ? (previewId ?? null) : null
  useEffect(() => {
    void api.setPreviewPinned(pinnedTab)
  }, [api, pinnedTab])
  useEffect(() => () => void api.setPreviewPinned(null), [api])

  // 列表或点开（未固定）的预览卡：点外面关闭；Esc 关闭并截住（不让输入框把它算作一次 Esc）。固定的卡不受影响
  const popupOpen = listOpen || preview?.mode === 'open'
  useEffect(() => {
    if (!popupOpen) return
    const close = (): void => {
      setListOpen(false)
      setPreview((p) => (p?.mode === 'pinned' ? p : null))
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

  // 浮层（预览卡 / 网页列表）的横向位置：默认与胶囊左对齐；胶囊排在靠右处、放不下时往左挪，
  // 不超出胶囊排（与输入框同宽）。在绘制前量好，不会先画在原处再跳过去。
  const [popX, setPopX] = useState(0)
  const popup = listOpen && tabs.length > 1 ? 'list' : preview ? 'preview' : null
  useLayoutEffect(() => {
    const root = rootRef.current
    const dock = root?.parentElement
    if (!popup || !root || !dock) return
    const place = (): void => {
      const pop = root.querySelector<HTMLElement>('.cf-browser__preview, .cf-todo__panel')
      if (!pop) return
      const r = root.getBoundingClientRect()
      const d = dock.getBoundingClientRect()
      setPopX(Math.max(d.left, Math.min(r.left, d.right - pop.offsetWidth)) - r.left)
    }
    place()
    // 卡开着时胶囊也会挪：左边的胶囊出现 / 消失、文字变长变短，窗口缩放时胶囊排变宽变窄
    const ro = new ResizeObserver(place)
    const watch = (): void => {
      ro.disconnect()
      ro.observe(dock)
      for (const c of Array.from(dock.children)) ro.observe(c)
    }
    watch()
    const mo = new MutationObserver(() => {
      watch()
      place()
    })
    mo.observe(dock, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [popup])

  if (!s || !sessionId || !cur || !shown) return null
  const op = s.operating[sessionId]
  const ho = s.handoff[sessionId]

  const openWindow = (tab?: string): void => {
    window.clearTimeout(hoverTimer.current)
    setListOpen(false)
    setPreview(null)
    void api.open({ tab: tab ?? cur.id })
  }
  /** 打开预览卡；tab 为 null 时跟着 Deva。 */
  const showPreview = (tab: string | null, mode: Preview['mode']): void => {
    window.clearTimeout(hoverTimer.current)
    setListOpen(false)
    setPreview({ tab, mode })
  }
  const hoverIn = (): void => {
    if (listOpen || preview) return
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => showPreview(null, 'hover'), PREVIEW_DELAY)
  }
  const hoverOut = (): void => {
    window.clearTimeout(hoverTimer.current)
    // 移进预览卡不收（下方有 8px 桥接区）；只有悬停浮出的随鼠标收
    hoverTimer.current = window.setTimeout(() => setPreview((p) => (p?.mode === 'hover' ? null : p)), 150)
  }
  /** 点胶囊：打开（不固定）/ 收起预览卡（不打开窗口）。 */
  const toggle = (): void => {
    if (preview && preview.mode !== 'hover') setPreview(null)
    else showPreview(preview?.tab ?? null, 'open')
  }

  const img = frame?.tab === shown.id ? frame.src : thumb?.tab === shown.id ? thumb.src : null
  const openLabel = s.open ? t('browser.switchWindow') : t('browser.openWindow')
  /** Deva 正在用（本轮进行中 / 正在操作 / 等你操作）时不给关网页（卡上「关闭」与列表同一规则）。 */
  const locked = streaming || !!op || !!ho
  /** 只有一个网页：不要右侧箭头（列表），关网页用卡上的「关闭」。 */
  const multi = tabs.length > 1

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
        {/* 不放「停止」：就在输入框的停止键正上方，重复且容易误点 */}
        <span className="cf-browser__text tl__shimmer">{doingText(t, op.action, op.label)}</span>
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
    <div
      className={`cf-browser${listOpen ? ' is-open' : ''}`}
      ref={rootRef}
      style={{ order, '--cf-pop-x': `${popX}px` } as React.CSSProperties}
    >
      {listOpen && multi && (
        <PagesPanel
          sessionId={sessionId}
          tabs={tabs}
          current={cur.id}
          locked={locked}
          onPick={(tab) => showPreview(tab, 'open')}
        />
      )}
      {preview && !listOpen && (
        <div
          className={`cf-browser__preview${preview.mode === 'pinned' ? ' is-pinned' : ''}`}
          onMouseEnter={() => window.clearTimeout(hoverTimer.current)}
          onMouseLeave={hoverOut}
        >
          {/* 点画面 = 在独立窗口中打开（悬停时画面中间出提示） */}
          <button
            type="button"
            className={`cf-browser__shot${op?.tab === shown.id ? ' is-op' : ''}${ho?.tab === shown.id ? ' is-ho' : ''}`}
            aria-label={openLabel}
            onClick={() => openWindow(shown.id)}
          >
            {img ? <img src={img} alt="" draggable={false} /> : <span className="cf-browser__shot-empty" />}
            <span className="cf-browser__shot-tip">{openLabel}</span>
          </button>
          <div className="cf-browser__meta">
            {/* 不显示网址（同独立窗口）；悬停标题看站点 */}
            <span className="cf-browser__meta-title" title={[tabTitle(t, shown), siteOf(shown.url)?.host].filter(Boolean).join('\n')}>
              {tabTitle(t, shown)}
            </span>
            <button
              type="button"
              className={`cf-browser__open${preview.mode === 'pinned' ? ' is-on' : ''}`}
              aria-pressed={preview.mode === 'pinned'}
              title={preview.mode === 'pinned' ? t('browser.unpinPreview') : t('browser.pinPreview')}
              aria-label={preview.mode === 'pinned' ? t('browser.unpinPreview') : t('browser.pinPreview')}
              onClick={() => setPreview((p) => (p ? { ...p, mode: p.mode === 'pinned' ? 'open' : 'pinned' } : p))}
            >
              {preview.mode === 'pinned' ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
            {/* 关闭：关掉这个网页（卡随之收起；最后一个网页关掉后胶囊也消失）。Deva 正在用时置灰 */}
            <button
              type="button"
              className="cf-browser__open"
              disabled={locked}
              title={locked ? t('browser.closeLocked') : t('browser.closePage')}
              aria-label={t('browser.closePage')}
              onClick={() => {
                setPreview(null)
                void api.closeTab(shown.id)
              }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      <div className="cf-browser__pill">
        <div
          className="cf-browser__main"
          role="button"
          tabIndex={0}
          aria-expanded={!!preview && preview.mode !== 'hover'}
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
        {multi && (
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
            <span className="cf-browser__count">{tabs.length}</span>
            <ChevronUp size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
