import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { b64uDecode, parseTicket } from '../shared/remote-crypto'
import {
  parseWebPageParams,
  type WebDelivered,
  type WebMessage,
  type WebPersona,
  type WebServerFrame,
  type WebSession,
  type WebTask
} from '../shared/remote-web'
import { dropDesk, loadHistory, loadSnapshot, saveHistory, saveSnapshot, type CachedHistory } from './cache'
import { ChatPage } from './chat'
import { Drawer } from './drawer'
import { FilePage } from './files'
import { Home, NewChatSheet } from './home'
import { Link, deviceName, type Auth, type LinkPhase } from './link'
import { InstallSheet, NotifySheet, Splash, StatePage } from './onboard'
import { useOutbox, type Outbox, type Outgoing } from './outbox'
import { usePrompts, type Act, type LivePrompt } from './prompts'
import { currentSub, isStandalone, permission, pushSupport, registerSW, subscribe, unsubscribe } from './push'
import { Scanner } from './scanner'
import { SnackBar, useSessionOps, type SessionOps } from './session-ops'
import { Settings } from './settings'
import { t } from './strings'
import { TaskPage } from './tasks'
import { useTheme, type ThemePref } from './theme'
import { currentDeskId, getDesk, listDesks, patchDesk, prefGet, prefSet, removeDesk, saveDesk, setCurrentDesk, type DeskCred } from './vault'

/**
 * Deva 手机版：对话列表做首页 + 左上角抽屉（对比稿 design/mobile-web.html 方案 B）。
 *
 * 启动：地址里带配对票据（扫码）→ 配对；带安装票据（主屏幕图标首次打开）→ 换凭证；否则用本机保存的凭证重连。
 * 先显示本机缓存（秒开），连上后同步。页面内导航用一层「栈」配合 history，系统返回手势可用。
 */

export type Page =
  | { name: 'home' }
  | { name: 'chat'; sid: string }
  | { name: 'settings' }
  | { name: 'file'; sid: string; file: WebDelivered }
  | { name: 'task'; id: string }
export type Overlay = null | 'drawer' | 'new' | 'install' | 'notify' | 'scan'
export type Filter = { kind: 'all' } | { kind: 'tasks' } | { kind: 'persona'; id: string } | { kind: 'archived' }
export type TextSize = 'sm' | 'md' | 'lg'
export type NotifyState = 'on' | 'off' | 'denied' | 'need-install' | 'need-https' | 'unsupported'

type Toast = { id: number; text: string; ok: boolean }

/** 正在连的那台电脑：凭证（配对成功前为 null）与这次连接用的鉴权方式。 */
interface Target {
  deskId: string
  computer: string
  auth: Auth
  /** 扫码 / 安装：首次连接，显示「正在连接」。 */
  pairing: boolean
}

export interface Store {
  link: Link | null
  deskId: string
  computer: string
  desks: DeskCred[]
  phase: LinkPhase
  ready: boolean
  sessions: Map<string, WebSession>
  personas: Map<string, WebPersona>
  /** 定时任务（电脑端排好序：进行中 → 出错 → 已暂停 → 已完成）。 */
  tasks: WebTask[]
  /** 对话末尾的交互卡（见 prompts.ts）。 */
  prompts: Map<string, LivePrompt>
  hist: Map<string, CachedHistory>
  seen: Map<string, number>
  syncedAt: number | null
  vapid: string | null
  deviceName: string
  filter: Filter
  setFilter(f: Filter): void
  open(p: Page): void
  back(): void
  overlay: Overlay
  setOverlay(o: Overlay): void
  toast(text: string, ok?: boolean): void
  act: Act
  markSeen(sid: string): void
  switchDesk(deskId: string): void
  disconnect(): Promise<void>
  /** 设置里「管理」删除一台电脑（当前这台 = 断开这台手机）。 */
  removeComputer(deskId: string): Promise<void>
  rename(name: string): Promise<void>
  notify: NotifyState
  enableNotify(): Promise<void>
  disableNotify(): Promise<void>
  textSize: TextSize
  setTextSize(s: TextSize): void
  /** 外观：跟随系统 / 浅色 / 深色。 */
  theme: ThemePref
  setTheme(p: ThemePref): void
  /** 安卓 Chrome 的「安装应用」原生弹框（有才给）。 */
  nativeInstall: (() => Promise<void>) | null
  /** 已经添加到主屏幕（在浏览器里看也不再提示添加）。 */
  installed: boolean
  /** 发出去还没出现在对话记录里的消息（按对话）。 */
  outbox: Map<string, Outgoing[]>
  outboxOps: Omit<Outbox, 'outbox' | 'reconcile'>
  /** 归档 / 删除 / 切换模型。 */
  ops: SessionOps
}

const SEEN_KEY = (deskId: string): string => `deva.seen.${deskId}`
/** 删除另一台电脑时临时连过去告别：最多等这么久。 */
const BYE_TIMEOUT_MS = 10_000
const INSTALLED_KEY = 'installed'

/** 安卓 Chrome 的 beforeinstallprompt 事件（标准库里没有类型）。 */
interface InstallPrompt {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function loadSeen(deskId: string): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(SEEN_KEY(deskId)) ?? '{}') as Record<string, number>))
  } catch {
    return new Map()
  }
}

function credAuth(d: DeskCred): Auth | null {
  const key = b64uDecode(d.key)
  return key && key.length === 32 ? { kind: 'resume', device: d.device, key } : null
}

/** 通知点进来要打开的对话（#o=桌面id.对话id，启动时读一次）。 */
const initialOpen = ((): { deskId: string; sid: string } | null => {
  const o = parseWebPageParams(location.hash).o
  const m = o ? /^([^.]+)\.(.+)$/.exec(o) : null
  return m ? { deskId: decodeURIComponent(m[1]), sid: decodeURIComponent(m[2]) } : null
})()

/** 启动时决定连哪台电脑、用什么凭证。地址里的票据用过即从地址栏抹掉（截图 / 收藏时不带着它）。 */
function bootTarget(): Target | null {
  const p = parseWebPageParams(location.hash)
  const keep = new URLSearchParams()
  if (p.d) keep.set('d', p.d)
  if (p.p || p.i || p.n || p.o) history.replaceState(null, '', `${location.pathname}${location.search}${keep.size ? `#${keep}` : ''}`)
  if (p.d && p.p) {
    const tk = parseTicket(p.p)
    if (tk) return { deskId: p.d, computer: p.n ?? '', auth: { kind: 'pair', id: tk.id, secret: tk.secret }, pairing: true }
  }
  if (p.d && p.i && !getDesk(p.d)) {
    const tk = parseTicket(p.i)
    if (tk) return { deskId: p.d, computer: p.n ?? '', auth: { kind: 'install', id: tk.id, secret: tk.secret }, pairing: true }
  }
  const fromNotice = initialOpen?.deskId ? getDesk(initialOpen.deskId) : null
  const cred = fromNotice || (p.d && getDesk(p.d)) || (currentDeskId() && getDesk(currentDeskId()!)) || listDesks()[0]
  if (!cred) return null
  const auth = credAuth(cred)
  return auth ? { deskId: cred.deskId, computer: cred.computer, auth, pairing: false } : null
}


function notifyStateNow(subscribed: boolean): NotifyState {
  const s = pushSupport()
  if (s !== 'ok') return s
  if (permission() === 'denied') return 'denied'
  return subscribed ? 'on' : 'off'
}

export function App(): React.JSX.Element {
  const [target, setTarget] = useState<Target | null>(bootTarget)
  /** 电脑名与「首次连接中」：随目标电脑重置，连上后由 ok 帧更新（不改 target，免得重建连接）。 */
  const [computer, setComputer] = useState(target?.computer ?? '')
  const [pairing, setPairing] = useState(!!target?.pairing)
  const [desks, setDesks] = useState<DeskCred[]>(listDesks)
  const [phase, setPhase] = useState<LinkPhase>({ kind: 'connecting', step: 0 })
  const [sessions, setSessions] = useState<Map<string, WebSession>>(new Map())
  const [personas, setPersonas] = useState<Map<string, WebPersona>>(new Map())
  const [tasks, setTasks] = useState<WebTask[]>([])
  const [hist, setHist] = useState<Map<string, CachedHistory>>(new Map())
  const [seen, setSeen] = useState<Map<string, number>>(new Map())
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const [vapid, setVapid] = useState<string | null>(null)
  const [devName, setDevName] = useState(deviceName())
  const [stack, setStack] = useState<Page[]>([{ name: 'home' }])
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [notify, setNotify] = useState<NotifyState>(() => notifyStateNow(false))
  const [textSize, setTextSizeState] = useState<TextSize>(() => (prefGet('textSize') as TextSize) || 'md')
  const [theme, setTheme] = useTheme()
  const [installEvt, setInstallEvt] = useState<InstallPrompt | null>(null)
  const [installed, setInstalled] = useState(() => prefGet(INSTALLED_KEY) === '1')
  const markInstalled = useCallback(() => {
    prefSet(INSTALLED_KEY, '1')
    setInstalled(true)
    setInstallEvt(null)
  }, [])
  const [link, setLink] = useState<Link | null>(null)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const histRef = useRef(hist)
  histRef.current = hist
  const pendingOpen = useRef(initialOpen)

  const toast = useCallback((text: string, ok = true) => {
    if (!text) return
    const id = Date.now() + Math.random()
    setToasts((l) => [...l.slice(-2), { id, text, ok }])
    window.setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 2600)
  }, [])

  // 文字大小 / 外观：根元素上的属性。
  useEffect(() => {
    document.documentElement.dataset.fs = textSize
  }, [textSize])

  // Service Worker、安卓的安装弹框、通知点进来。
  useEffect(() => {
    void registerSW().then(() => currentSub().then((s) => setNotify(notifyStateNow(!!s))))
    const onPrompt = (e: Event): void => {
      e.preventDefault()
      setInstallEvt(e as unknown as InstallPrompt)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    // 装好了（从系统弹框 / 浏览器菜单装的都算）：收起添加提示，以后在浏览器里打开也不再提示。
    window.addEventListener('appinstalled', markInstalled)
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as { type?: string; deskId?: string; sid?: string }
      if (d?.type === 'open' && d.sid) {
        pendingOpen.current = { deskId: d.deskId ?? '', sid: d.sid }
        setTarget((cur) => (d.deskId && cur?.deskId !== d.deskId ? switchTarget(d.deskId) ?? cur : cur))
        openPending()
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', markInstalled)
      navigator.serviceWorker?.removeEventListener('message', onMsg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPending = useCallback(() => {
    const o = pendingOpen.current
    if (!o || !sessionsRef.current.has(o.sid)) return
    pendingOpen.current = null
    setOverlay(null)
    setStack([{ name: 'home' }, { name: 'chat', sid: o.sid }])
    history.pushState({ deva: 1 }, '')
  }, [])
  // 通知点进来的对话：列表到了就打开。
  useEffect(() => {
    if (pendingOpen.current) openPending()
  }, [sessions, openPending])

  // ───────── 连接：目标电脑一变就重建 ─────────
  useEffect(() => {
    if (!target) return
    const deskId = target.deskId
    let alive = true
    setComputer(target.computer || getDesk(deskId)?.computer || '')
    setPairing(target.pairing)
    ops.reset()
    setSessions(new Map())
    setPersonas(new Map())
    setTasks([])
    live.reset([])
    setHist(new Map())
    setSyncedAt(null)
    setSeen(loadSeen(deskId))
    setPhase({ kind: 'connecting', step: 0 })
    void loadSnapshot(deskId).then((snap) => {
      if (!alive || !snap) return
      setSessions((cur) => (cur.size ? cur : new Map(snap.sessions.map((s) => [s.id, s]))))
      setPersonas((cur) => (cur.size ? cur : new Map(snap.personas.map((p) => [p.id, p]))))
      setTasks((cur) => (cur.length ? cur : (snap.tasks ?? [])))
      setSyncedAt(snap.syncedAt)
    })

    const l = new Link(
      deskId,
      target.auth,
      {
        onPhase: (p) => alive && setPhase(p),
        onPaired: (device, key) => {
          const now = Date.now()
          saveDesk({ deskId, computer: target.computer, device, key, name: deviceName(), addedAt: now, lastUsed: now })
          setCurrentDesk(deskId)
          setDesks(listDesks())
        },
        onFrame: (f) => alive && onFrame(deskId, f)
      },
      deviceName()
    )
    setLink(l)
    l.start()
    return () => {
      alive = false
      l.stop()
      setLink(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  /** 收到的帧 → 状态（并顺手写缓存）。 */
  const onFrame = (deskId: string, f: WebServerFrame): void => {
    switch (f.t) {
      case 'ok': {
        // 第一次连上这台电脑：已有的对话都算看过，不然满屏未读红点。
        if (localStorage.getItem(SEEN_KEY(deskId)) === null) {
          const base = new Map(f.sessions.map((s) => [s.id, s.updatedAt]))
          setSeen(base)
          try {
            localStorage.setItem(SEEN_KEY(deskId), JSON.stringify(Object.fromEntries(base)))
          } catch {
            /* ignore */
          }
        }
        setSessions(ops.fromServer(f.sessions))
        live.reset(f.prompts)
        setVapid(f.vapid)
        setDevName(f.device.name)
        setSyncedAt(Date.now())
        patchDesk(deskId, { computer: f.desk.computer, lastUsed: Date.now(), name: f.device.name })
        setCurrentDesk(deskId)
        setDesks(listDesks())
        setComputer(f.desk.computer)
        setPairing(false)
        // 已开通知：把当前订阅报给电脑（换过电脑 / 订阅被系统刷新过都能对上）。
        if (f.vapid && permission() === 'granted')
          void currentSub().then((s) => {
            setNotify(notifyStateNow(!!s))
            if (s) void linkRef.current?.setPush(s)
          })
        return
      }
      case 'sessions':
        setSessions(ops.fromServer(f.list))
        setSyncedAt(Date.now())
        return
      case 'session':
        setSessions((m) => new Map(m).set(f.s.id, f.s))
        return
      case 'session_gone':
        ops.gone(f.sid)
        setSessions((m) => {
          const next = new Map(m)
          next.delete(f.sid)
          return next
        })
        return
      case 'personas':
        setPersonas(new Map(f.list.map((p) => [p.id, p])))
        return
      case 'tasks':
        setTasks(f.list)
        return
      case 'history': {
        const cur = histRef.current.get(f.sid)
        // 电脑推来的进行中这一轮接不上手上已有的（最新一页还没到）：丢掉，别拿这一小段把整段换掉。
        if (f.live && (!cur || f.start > cur.total)) return
        const h = mergeHistory(cur, f)
        histRef.current = new Map(histRef.current).set(f.sid, h)
        setHist((m) => new Map(m).set(f.sid, h))
        void saveHistory(deskId, f.sid, h)
        outbox.reconcile(f.sid, h, sessionsRef.current.get(f.sid)?.busy ?? false)
        // 包含这一轮末尾的：处理过的交互卡的回执已在对话记录里，末尾那条交给它（往前翻的页不算）。
        if (f.end >= f.total) live.settle(f.sid)
        return
      }
      case 'prompt':
        live.update(f.p)
        return
      case 'notice':
        if (stackTop().name !== 'chat' || (stackTop() as { sid?: string }).sid !== f.n.sessionId)
          toast(f.n.title ? `${f.n.title}：${f.n.text}` : f.n.text, f.n.tone !== 'error')
        return
      case 'err':
        toast(f.message, false)
        return
      default:
        return
    }
  }

  const linkRef = useRef<Link | null>(null)
  linkRef.current = link
  const outbox = useOutbox(linkRef, histRef, toast)
  const live = usePrompts(linkRef, toast)
  const ops = useSessionOps(linkRef, sessionsRef, setSessions, toast)
  const { send: outSend, retry: outRetry, discard: outDiscard } = outbox
  const outboxOps = useMemo(() => ({ send: outSend, retry: outRetry, discard: outDiscard }), [outSend, outRetry, outDiscard])
  const stackRef = useRef(stack)
  stackRef.current = stack
  const stackTop = (): Page => stackRef.current[stackRef.current.length - 1]

  // 列表与角色写进缓存（去抖）。
  useEffect(() => {
    if (!target || !syncedAt || !sessions.size) return
    const id = window.setTimeout(
      () =>
        saveSnapshot(target.deskId, {
          // 进行中的状态只在连着时有意义：缓存里一律记成空闲，免得电脑不在线时还显示「运行测试…」。
          sessions: [...sessions.values()].map((s) => ({ ...s, busy: false, status: undefined, since: undefined, retry: undefined })),
          personas: [...personas.values()],
          tasks,
          syncedAt
        }),
      800
    )
    return () => window.clearTimeout(id)
  }, [target, sessions, personas, tasks, syncedAt])

  // 打开对话时先放上缓存的历史。
  const top = stack[stack.length - 1]
  const topSid = top.name === 'chat' ? top.sid : null
  useEffect(() => {
    if (!target || !topSid || hist.has(topSid)) return
    void loadHistory(target.deskId, topSid).then((h) => h && setHist((m) => (m.has(topSid) ? m : new Map(m).set(topSid, h))))
  }, [target, topSid, hist])

  // ───────── 导航：页面栈 + 系统返回 ─────────
  useEffect(() => {
    const onPop = (): void => {
      setOverlay(null)
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = useCallback((p: Page) => {
    setOverlay(null)
    setStack((s) => [...s, p])
    history.pushState({ deva: 1 }, '')
  }, [])

  const back = useCallback(() => {
    if (history.state?.deva) history.back()
    else setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  const markSeen = useCallback(
    (sid: string) => {
      if (!target) return
      const s = sessionsRef.current.get(sid)
      const at = s?.updatedAt ?? Date.now()
      // 告诉电脑「看过了」（两端共用已读时间，电脑上的红点随之消掉）；电脑那边已记过的不再发。
      if (s && (s.readAt ?? 0) < s.updatedAt) linkRef.current?.send({ t: 'read', sid })
      setSeen((m) => {
        if ((m.get(sid) ?? 0) >= at) return m
        const next = new Map(m).set(sid, at)
        try {
          localStorage.setItem(SEEN_KEY(target.deskId), JSON.stringify(Object.fromEntries(next)))
        } catch {
          /* ignore */
        }
        return next
      })
    },
    [target]
  )


  const switchDesk = useCallback((deskId: string) => {
    const t2 = switchTarget(deskId)
    if (!t2) return
    setOverlay(null)
    setStack([{ name: 'home' }])
    setFilter({ kind: 'all' })
    setTarget(t2)
  }, [])

  const disconnect = useCallback(async () => {
    if (!target) return
    linkRef.current?.send({ t: 'bye' })
    removeDesk(target.deskId)
    await dropDesk(target.deskId)
    const rest = listDesks()
    setDesks(rest)
    setStack([{ name: 'home' }])
    const next = rest[0] ? switchTarget(rest[0].deskId) : null
    setTarget(next)
  }, [target])

  // 删除另一台电脑：先从本机删掉凭证和缓存，再临时连一下告诉它移除这台手机。
  // 连不上（电脑不在线等）就算了，那台电脑的「手机」里仍会列着，可以在电脑上移除。
  const removeComputer = useCallback(
    async (deskId: string) => {
      if (deskId === target?.deskId) return disconnect()
      const cred = getDesk(deskId)
      removeDesk(deskId)
      setDesks(listDesks())
      await dropDesk(deskId)
      const auth = cred ? credAuth(cred) : null
      if (!auth) return
      const done = (): void => {
        window.clearTimeout(timer)
        l.stop()
      }
      const l = new Link(
        deskId,
        auth,
        {
          onPhase: (p) => {
            if (p.kind === 'ready') {
              l.send({ t: 'bye' })
              done()
            } else if (p.kind === 'auth' || p.kind === 'version') done()
          },
          onFrame: () => undefined,
          onPaired: () => undefined
        },
        deviceName()
      )
      const timer = window.setTimeout(done, BYE_TIMEOUT_MS)
      l.start()
    },
    [target, disconnect]
  )

  const rename = useCallback(
    async (name: string) => {
      const l = linkRef.current
      if (!l || !target) return
      const r = await l.result((rid) => ({ t: 'rename', rid, name }))
      if (r.ok) {
        setDevName(name)
        patchDesk(target.deskId, { name })
      } else toast(r.message, false)
    },
    [target, toast]
  )

  const enableNotify = useCallback(async () => {
    if (!vapid) return toast(t('notifyUnsupported'), false)
    const sub = await subscribe(vapid)
    setNotify(notifyStateNow(!!sub))
    if (!sub) {
      if (permission() === 'denied') toast(t('notifyDenied'), false)
      return
    }
    const r = await linkRef.current?.setPush(sub)
    if (r && !r.ok) toast(r.message, false)
  }, [vapid, toast])

  const disableNotify = useCallback(async () => {
    await linkRef.current?.setPush(null)
    await unsubscribe()
    setNotify(notifyStateNow(false))
  }, [])

  // 第一次连上（从主屏幕打开、可以推送、还没问过）：说明用途后再请求通知权限。
  useEffect(() => {
    if (phase.kind !== 'ready' || !vapid || notify !== 'off' || prefGet('notifyAsked')) return
    if (!isStandalone() && /iPhone|iPad/.test(navigator.userAgent)) return
    prefSet('notifyAsked', '1')
    setOverlay((o) => o ?? 'notify')
  }, [phase.kind, vapid, notify])

  const setTextSize = useCallback((s: TextSize) => {
    prefSet('textSize', s)
    setTextSizeState(s)
  }, [])

  const store = useMemo<Store>(
    () => ({
      link,
      deskId: target?.deskId ?? '',
      computer: computer || t('thisComputer'),
      desks,
      phase,
      ready: phase.kind === 'ready',
      sessions,
      personas,
      tasks,
      prompts: live.prompts,
      hist,
      seen,
      syncedAt,
      vapid,
      deviceName: devName,
      filter,
      setFilter,
      open,
      back,
      overlay,
      setOverlay,
      toast,
      act: live.act,
      markSeen,
      switchDesk,
      disconnect,
      removeComputer,
      rename,
      notify,
      enableNotify,
      disableNotify,
      textSize,
      setTextSize,
      theme,
      setTheme,
      // 弹框只能用一次：用户点了「安装」就收起提示（appinstalled 要等安装真正完成才来）；取消了提示留着，
      // 按钮变回「怎么添加」，浏览器以后再给弹框时又变回「添加」。
      nativeInstall: installEvt
        ? async () => {
            await installEvt.prompt()
            const choice = await installEvt.userChoice.catch(() => null)
            setInstallEvt(null)
            if (choice?.outcome === 'accepted') markInstalled()
          }
        : null,
      installed,
      outbox: outbox.outbox,
      outboxOps,
      ops
    }),
    [link, target, computer, desks, phase, sessions, personas, tasks, live.prompts, live.act, hist, seen, syncedAt, vapid, devName, filter, open, back, overlay, toast, markSeen, switchDesk, disconnect, removeComputer, rename, notify, enableNotify, disableNotify, textSize, setTextSize, theme, setTheme, installEvt, installed, markInstalled, outbox.outbox, outboxOps, ops]
  )

  // ───────── 渲染 ─────────

  const scanned = (url: string): void => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return toast(t('scanWrong'), false)
    }
    const p = parseWebPageParams(u.hash)
    const tk = parseTicket(p.p)
    if (!p.d || !tk) return toast(t('scanWrong'), false)
    // 别的来源（例如局域网地址）：直接打开那个页面。
    if (u.origin !== location.origin || u.pathname !== location.pathname) {
      location.href = url
      return
    }
    setOverlay(null)
    setStack([{ name: 'home' }])
    setFilter({ kind: 'all' })
    setTarget({ deskId: p.d, computer: p.n ?? '', auth: { kind: 'pair', id: tk.id, secret: tk.secret }, pairing: true })
  }

  const scanner = overlay === 'scan' && <Scanner onResult={scanned} onClose={() => setOverlay(null)} />

  if (!target)
    return (
      <div className="app">
        <StatePage kind="welcome" onScan={() => setOverlay('scan')} />
        {scanner}
        <Toasts list={toasts} />
      </div>
    )

  if (phase.kind === 'auth' || phase.kind === 'version') {
    const kind = phase.kind === 'version' ? 'version' : phase.removed ? 'removed' : 'expired'
    return (
      <div className="app">
        <StatePage
          kind={kind}
          message={phase.message}
          onScan={() => setOverlay('scan')}
          others={kind === 'removed' ? desks.filter((d) => d.deskId !== target.deskId) : kind === 'expired' ? desks : []}
          onSwitch={switchDesk}
          onForget={() => {
            removeDesk(target.deskId)
            void dropDesk(target.deskId)
            setDesks(listDesks())
          }}
        />
        {scanner}
        <Toasts list={toasts} />
      </div>
    )
  }

  if (pairing && phase.kind !== 'ready')
    return (
      <div className="app">
        <Splash computer={computer} phase={phase} />
        <Toasts list={toasts} />
      </div>
    )

  let page: React.JSX.Element
  if (top.name === 'chat') page = <ChatPage key={top.sid} store={store} sid={top.sid} />
  else if (top.name === 'settings') page = <Settings store={store} />
  else if (top.name === 'file') page = <FilePage store={store} sid={top.sid} file={top.file} />
  else if (top.name === 'task') page = <TaskPage key={top.id} store={store} id={top.id} />
  else page = <Home store={store} />

  return (
    <div className="app">
      {page}
      {overlay === 'drawer' && <Drawer store={store} onClose={() => setOverlay(null)} />}
      {overlay === 'new' && <NewChatSheet store={store} onClose={() => setOverlay(null)} />}
      {overlay === 'install' && <InstallSheet store={store} onClose={() => setOverlay(null)} />}
      {overlay === 'notify' && <NotifySheet store={store} onClose={() => setOverlay(null)} />}
      {scanner}
      <SnackBar snack={ops.snack} onDone={ops.dismissSnack} />
      <Toasts list={toasts} />
    </div>
  )
}

/**
 * 收到的一段历史并进已有的：[start, end) 在已有部分之前 = 往前翻页，拼到前面；与已有部分相接或重叠 = 最新一页 /
 * 补拉，替换 start 之后的部分；接不上（离开太久，中间缺了一段）就整段换掉。
 */
function mergeHistory(cur: CachedHistory | undefined, f: Extract<WebServerFrame, { t: 'history' }>): CachedHistory {
  const incoming = reuse(cur, f.messages)
  if (cur && f.end <= cur.start && f.start < cur.start) return { messages: [...incoming, ...cur.messages], start: f.start, total: cur.total }
  if (cur && f.start > cur.start && f.start <= cur.total) {
    const keep = cur.messages.filter((x) => Number(x.id) < f.start)
    return { messages: [...keep, ...incoming], start: cur.start, total: f.end }
  }
  return { messages: incoming, start: f.start, total: f.end }
}

/** 内容没变的消息沿用手上原来的对象：对话页的气泡据此跳过重新渲染（见 chat.tsx）。 */
function reuse(cur: CachedHistory | undefined, list: WebMessage[]): WebMessage[] {
  if (!cur) return list
  const old = new Map(cur.messages.map((m) => [m.id, m]))
  return list.map((m) => {
    const o = old.get(m.id)
    return o && JSON.stringify(o) === JSON.stringify(m) ? o : m
  })
}

function switchTarget(deskId: string): Target | null {
  const cred = getDesk(deskId)
  const auth = cred ? credAuth(cred) : null
  if (!cred || !auth) return null
  setCurrentDesk(deskId)
  return { deskId, computer: cred.computer, auth, pairing: false }
}

function Toasts({ list }: { list: Toast[] }): React.JSX.Element {
  return (
    <div className="toasts" aria-live="polite">
      {list.map((x) => (
        <div key={x.id} className={`toast${x.ok ? '' : ' is-error'}`}>
          {x.text}
        </div>
      ))}
    </div>
  )
}
