/**
 * 对话优先外壳各部分共用的小件：路径与时间辅助、头像与头像组、折叠过渡、悬停菜单、分段选择器、开关。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Persona } from '../mock/extensions'
import { useI18n } from '../i18n/i18n'
import {
  PersonaFace,
  USER_AVATAR_SEED,
  parseAvatarSpec,
  resolveShape,
  shapeMask
} from '../components/humation'
import { useProfile } from '../store/profile'

/** 路径末段（跨平台）。 */
export function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/** 是否同一路径：忽略末尾分隔符；Windows 下不分大小写、不分正反斜杠。 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+$/, '')
    return window.deva.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * 嵌进纯文本标题（如删除确认框）的名字限长：超过 max 个字符截断补「…」。按码点切，不劈开 emoji 等代理对。
 * 确认框标题是拼好的整句，CSS 省略会连带吃掉句尾的「？」，故在文本层截断。
 */
export function clipName(s: string, max = 20): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s
}

/**
 * 无对话头的中列界面（快速开启 / 角色空态 / 资料卡）共用的顶部拖拽把手：一条透明、与原生标题栏同高的
 * 窗口拖拽区，补上这些界面缺失的顶部拖拽（对话视图已由 .cf-conv__head 承担）。纯装饰、无交互。
 */
export function DragBar(): React.JSX.Element {
  return <div className="cf-dragbar" aria-hidden="true" />
}

export const IS_MAC = window.deva.platform === 'darwin'

/** 系统默认角色 id（首启种子「Deva」，id 恒为 general）：兼作兜底身份，且不允许删除。 */
export const DEFAULT_PERSONA_ID = 'general'

/** 相对时间（本地化，词与数字空格拼接，不用插值——t 只收 key）。 */
export function useRelativeTime(): (ts: number) => string {
  const { t } = useI18n()
  return (ts: number): string => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return t('chat.time.now')
    if (min < 60) return `${min} ${t('chat.time.min')}`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} ${t('chat.time.hr')}`
    const day = Math.floor(hr / 24)
    if (day === 1) return t('chat.time.yesterday')
    return `${day} ${t('chat.time.day')}`
  }
}

/** 文案占位替换：{name} → vars.name（同一占位可出现多次）。 */
export function fill(s: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), s)
}

/**
 * 高度可过渡的折叠块：收起 = 行高 0fr + 淡出（CSS .cf-fold），展开反之；新出现的从收起态展开。
 * instant：挂载时直接是展开态，不放进场过渡（切到这个对话时已经在的几件）。
 * 收起后内容 visibility: hidden（过渡放完才藏），不能再被 Tab 到。
 */
export function Fold({
  open,
  instant,
  className,
  children
}: {
  open: boolean
  instant?: boolean
  className: string
  children: React.ReactNode
}): React.JSX.Element {
  const [ready, setReady] = useState(!!instant)
  useEffect(() => {
    if (ready) return
    // 先以收起态画出一帧，下一帧再展开，过渡才有起点。
    let r2 = 0
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setReady(true))
    })
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  }, [ready])
  const closed = !open || !ready
  return (
    <div className={`cf-fold ${className}${closed ? ' is-closed' : ''}`} aria-hidden={closed || undefined}>
      <div className="cf-fold__in">{children}</div>
    </div>
  )
}

/** 时刻的短写法：今天只写时分，明天写「明天 时分」，更远写月日时分。 */
export function useShortTime(): (ms: number) => string {
  const { t, locale } = useI18n()
  const loc = locale === 'en' ? 'en-US' : 'zh-CN'
  return (ms: number): string => {
    const d = new Date(ms)
    const now = new Date()
    const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
    const sameDay = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    if (sameDay(d, now)) return hm
    const tomorrow = new Date(now)
    tomorrow.setDate(now.getDate() + 1)
    if (sameDay(d, tomorrow)) return `${t('cf.task.tomorrow')} ${hm}`
    return d.toLocaleString(loc, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
}

/**
 * 搜索行 + 按钮浮层的开合逻辑（AddMenu / NewChatMenu 共用）：悬停或点击展开，
 * 离开略延迟收起以容忍按钮→浮层途中的空档（避免闪烁），choose 选中即收起并执行。
 */
export function useHoverMenu(): {
  open: boolean
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void }
  show: () => void
  choose: (fn: () => void) => void
} {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }
  useEffect(() => cancelClose, [])

  return {
    open,
    hoverProps: {
      onMouseEnter: () => {
        cancelClose()
        setOpen(true)
      },
      onMouseLeave: scheduleClose
    },
    show: () => setOpen(true),
    choose: (fn) => {
      cancelClose()
      setOpen(false)
      fn()
    }
  }
}

/**
 * 头像堆叠：最多 max 个；超出时末位照常放第 max 个头像、盖一层半透明深色再写 +N（N 含被盖住的这个）。
 * 悬停显示全部角色名。
 */
export function AvatarStack({
  personas,
  size = 20,
  max = 3,
  plain
}: {
  personas: Persona[]
  size?: number
  max?: number
  /** 不挂名字提示：外层另有悬停提示时用（如成员进度提示）。 */
  plain?: boolean
}): React.JSX.Element {
  const { locale } = useI18n()
  const shown = personas.length > max ? personas.slice(0, max - 1) : personas
  const more = personas.length - shown.length
  const veiled = more > 0 ? personas[shown.length] : null
  return (
    <span
      className="cf-avstack"
      style={{ '--sz': `${size}px` } as React.CSSProperties}
      title={plain ? undefined : personas.map((p) => p.name).join(locale === 'en' ? ', ' : '、')}
    >
      {shown.map((p) => (
        <span key={p.id} className="cf-avstack__ava">
          <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} compact />
        </span>
      ))}
      {veiled && (
        <span className="cf-avstack__ava">
          <PersonaFace seed={veiled.id} spec={parseAvatarSpec(veiled.avatar)} image={veiled.avatarImage} compact />
          <span
            className={`cf-avstack__veil${more >= 10 ? ' is-wide' : ''}`}
            style={{ mask: shapeMask(resolveShape(veiled.id, parseAvatarSpec(veiled.avatar))) }}
          >
            +{more}
          </span>
        </span>
      )}
    </span>
  )
}

export function Segmented({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ v: string; label: string }>
}): React.JSX.Element {
  return (
    <div className="cf-seg">
      {options.map((o) => (
        <button
          key={o.v}
          className={`cf-seg__opt${value === o.v ? ' is-on' : ''}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  on,
  onChange,
  disabled
}: {
  on: boolean
  onChange: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      className={`cf-switch${on ? ' is-on' : ''}`}
      aria-pressed={on}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="cf-switch__dot" />
    </button>
  )
}

/* ============================ 通用小件 ============================ */
// 全应用头像（角色 / 人类用户）统一走 Humation：
//  - 角色：seed=persona.id，叠加其 avatar spec（若有）。
//  - 用户：个人资料里的头像（图片 / spec；未配置时主进程回默认头像），读到前回落固定 seed（USER_AVATAR_SEED）。
// 结构：外层 .cf-ava 作定位框，内层 .cf-ava__face 放头像本体（形状与探出由 PersonaFace 自己画，外层不裁剪）。
export function Avatar({
  persona,
  user,
  size,
  busy,
  attention,
  unread,
  plain,
  compact
}: {
  persona?: Persona
  user?: boolean
  size?: number
  /** 不挂悬停提示：名字已经写在旁边的地方用（标题栏成员条、对话里成员名前的小头像）。 */
  plain?: boolean
  /** 框内构图（不探出）：≤20px 自动启用；尺寸由 CSS 决定的小头像（成员名前）显式传。 */
  compact?: boolean
  /** 忙碌（对话生成中）：底板从原形状慢慢变成星芒并转动，结束后变回（见 humation.tsx useBusyMorph）。 */
  busy?: boolean
  /** 待你处理（问答 / 计划 / 挂载 / 待确认名片）：右上角红点。 */
  attention?: boolean
  /** 有新消息未读：右上角红点。 */
  unread?: boolean
}): React.JSX.Element | null {
  const profile = useProfile()
  const style = { ...(size ? { '--sz': `${size}px` } : {}) } as React.CSSProperties
  const cls = `cf-ava${user ? ' is-user' : ''}`
  const seed = user ? USER_AVATAR_SEED : (persona?.id ?? '')
  const spec = user ? profile.avatar : parseAvatarSpec(persona?.avatar)
  // 红点排在 .cf-ava__face 之后，靠文档顺序压在头像之上。
  const marks = unread || attention ? <span className="cf-ava__dot" aria-hidden="true" /> : null
  // 非用户、非角色（理论上罕见）：空占位圈。
  if (!user && !persona)
    return (
      <div className={cls} style={style}>
        {marks}
      </div>
    )
  const title =
    user || plain
      ? undefined
      : `${(persona as Persona).name} · ${(persona as Persona).desc}${(persona as Persona).model ? ` · ${(persona as Persona).model}` : ''}`
  return (
    <div className={cls} style={style} title={title}>
      <span className="cf-ava__face">
        <PersonaFace
          seed={seed}
          spec={spec}
          image={user ? profile.avatarImage : (persona as Persona).avatarImage}
          title={title}
          compact={compact ?? (size ?? 28) <= 20}
          busy={busy}
        />
      </span>
      {marks}
    </div>
  )
}

/**
 * 引用恒定、调用时转给最新一次渲染的那个函数：传给 memo 组件的回调用它包一层，
 * 父组件重渲染时不会因回调换了引用而带着子组件一起重渲染，也不会调到旧状态。
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}
