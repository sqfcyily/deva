import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

/**
 * 统一下拉框（取代原生 <select>，样稿见 design/select.html）。
 *
 * - 收起态：与同页输入框同高、同圆角、同焦点光圈，右侧细灰箭头。尺寸由所在表单经 CSS 变量给出
 *   （--select-h / --select-radius / --select-bg，缺省 32px / 小圆角 / 浮起底色），组件本身不分尺寸档。
 * - 浮层：渲染到 body、按触发框定位（设置页等内容区会滚动，放在内部会被裁掉），与触发框同宽；
 *   句中紧凑的按内容取宽（不窄于触发框与 120px），下方放不下朝上展开，超高滚动。打开时把选中项放到中部、
 *   并对齐到行边界（顶部那一行完整显示）；之后只有键盘移动会滚动，鼠标悬停只换高亮、浮层不动。
 * - 键盘：焦点始终留在触发框（aria-activedescendant），↑↓ / Home / End 移动，Enter / 空格选中，
 *   Esc 收起，Tab 收起并照常移走焦点，直接输入文字跳到以之开头的选项。
 * - 单选选中即收起；多选（multiple）点选后浮层保持打开，收起态内容由调用方给（display）。多选里与其余互斥的
 *   整体项（如「所有角色」）标 closeOnPick，点了同单选一样收起。
 *
 * Esc 在 window 捕获阶段拦下，不连带关闭外层的设置弹框等；但若外层是同样在 window 捕获阶段监听 Esc 的
 * components/Modal（先于本浮层注册），它会先收到——目前没有把下拉框放进 Modal 的地方。
 */

export interface SelectOption<V> {
  value: V
  label: string
  /** 第二行说明。 */
  sub?: string
  /** 左侧图形：色点 / 图标 / 头像（select-dot / select-icon / select-ava）。 */
  lead?: ReactNode
  /** 多选时点了即收起浮层（与其余选项互斥的整体项）。 */
  closeOnPick?: boolean
}
export type SelectEntry<V> = SelectOption<V> | { separator: true } | { group: string; lead?: ReactNode }

interface CommonProps<V> {
  items: SelectEntry<V>[]
  /** 嵌在句子里：按内容取宽。 */
  inline?: boolean
  /** 等宽字体（协议名、分钟数等机器字段）。 */
  mono?: boolean
  /** 当前值不在选项里时收起态显示的文字。 */
  placeholder?: string
  'aria-label'?: string
  /** 加在触发框上（如固定最小宽度）。 */
  className?: string
  /** 加在浮层上（如固定宽度）。 */
  menuClassName?: string
}
interface SingleProps<V> extends CommonProps<V> {
  multiple?: false
  value: V
  onChange: (value: V) => void
  /** 自定义收起态内容（用 select__lead / select__label 包裹）；缺省 = 选中项的 lead + label。 */
  display?: ReactNode
}
interface MultiProps<V> extends CommonProps<V> {
  multiple: true
  isSelected: (value: V) => boolean
  onToggle: (value: V) => void
  display: ReactNode
}

const isOption = <V,>(e: SelectEntry<V>): e is SelectOption<V> => 'value' in e

/** 浮层与触发框的间距、离视口边缘的留白、最大高度、句中紧凑的最小宽度、连续输入的间隔。 */
const GAP = 6
const EDGE = 12
const MAX_H = 320
const INLINE_MIN_W = 120
const TYPEAHEAD_MS = 600

interface MenuPos {
  left: number
  /** 常规：与触发框同宽。 */
  width?: number
  /** 句中紧凑：按内容取宽，夹在两者之间。 */
  minWidth?: number
  maxWidth?: number
  top?: number
  bottom?: number
  maxHeight: number
}

export function Select<V>(props: SingleProps<V> | MultiProps<V>): React.JSX.Element {
  const { items, inline, mono, placeholder, className, menuClassName } = props
  const uid = useId()
  const listId = `${uid}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const [active, setActive] = useState(0)
  /** 浮层内容超高、出现滚动条（此时去掉右内边距，让行底色铺到滚动条边）。 */
  const [scrolls, setScrolls] = useState(false)
  /** 本次高亮变化来自键盘：只有这时才把高亮项滚进可视区（鼠标悬停不滚，免得浮层跟着跳）。 */
  const byKeyboard = useRef(false)
  const typed = useRef({ text: '', at: 0 })
  const open = pos !== null

  const options = useMemo(() => items.filter(isOption), [items])
  const isOn = (v: V): boolean => (props.multiple ? props.isSelected(v) : Object.is(props.value, v))

  const place = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const minWidth = inline ? Math.max(r.width, INLINE_MIN_W) : r.width
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - minWidth - EDGE))
    const below = window.innerHeight - r.bottom - GAP - EDGE
    const above = r.top - GAP - EDGE
    const down = below >= 220 || below >= above
    setPos({
      left,
      ...(inline ? { minWidth, maxWidth: window.innerWidth - left - EDGE } : { width: minWidth }),
      ...(down
        ? { top: r.bottom + GAP, maxHeight: Math.min(MAX_H, below) }
        : { bottom: window.innerHeight - r.top + GAP, maxHeight: Math.min(MAX_H, above) })
    })
  }

  const openMenu = (): void => {
    const i = options.findIndex((o) => isOn(o.value))
    setActive(i >= 0 ? i : 0)
    place()
  }

  const close = (refocus: boolean): void => {
    setPos(null)
    if (refocus) triggerRef.current?.focus()
  }

  const pick = (i: number): void => {
    const o = options[i]
    if (!o) return
    if (props.multiple) {
      props.onToggle(o.value)
      if (o.closeOnPick) close(true)
      else setActive(i)
      return
    }
    close(true)
    if (!Object.is(o.value, props.value)) props.onChange(o.value)
  }

  // 打开时把当前选中项放到浮层中部（长列表如 60 个分钟数），再对齐到行边界：
  // 顶部第一行完整显示，免得半截行一被鼠标碰到就得滚出来。
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!open || !menu) return
    const overflow = menu.scrollHeight > menu.clientHeight
    setScrolls(overflow)
    const el = menu.querySelector<HTMLElement>(`[data-i="${active}"]`)
    if (!el || !overflow) return
    // 滚动后上内边距已移出视野，对齐到行的上沿（不减内边距），否则顶部会露出上一行的一截。
    const rows = [...menu.children] as HTMLElement[]
    const want = el.offsetTop - menu.clientHeight / 2 + el.offsetHeight / 2
    let top = rows.find((c) => c.offsetTop + c.offsetHeight > want)?.offsetTop ?? want
    // 靠近列表末尾时滚不到那么远：退到能滚到的最后一个行边界，顶部仍是整行。
    const max = menu.scrollHeight - menu.clientHeight
    if (top > max) top = rows.filter((c) => c.offsetTop <= max).pop()?.offsetTop ?? 0
    // 定位到第一行时直接回到顶（保留上内边距）。
    menu.scrollTop = top <= (rows[0]?.offsetTop ?? 0) ? 0 : top
    // 只在刚打开时定位一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => {
    if (!open || !byKeyboard.current) return
    byKeyboard.current = false
    menuRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // Esc 收起（捕获阶段拦下，不连带关闭外层弹框）；窗口尺寸一变位置就不准了，直接收起。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      close(true)
    }
    const onResize = (): void => close(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    const last = options.length - 1
    const move = (i: number): void => {
      byKeyboard.current = true
      setActive(Math.max(0, Math.min(last, i)))
    }
    if (e.key === 'ArrowDown') move(active + 1)
    else if (e.key === 'ArrowUp') move(active - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(last)
    else if (e.key === 'Enter' || e.key === ' ') pick(active)
    else if (e.key === 'Tab') return close(false)
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now()
      typed.current = {
        text: (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + e.key.toLowerCase(),
        at: now
      }
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text))
      if (hit >= 0) move(hit)
    } else return
    e.preventDefault()
  }

  // 收起态内容：调用方给的，或选中项的 lead + label；当前值不在选项里显示占位。
  let display = props.display
  if (display === undefined && !props.multiple) {
    const cur = options.find((o) => Object.is(o.value, props.value))
    display = cur ? (
      <>
        {cur.lead && <span className="select__lead">{cur.lead}</span>}
        <span className="select__label">{cur.label}</span>
      </>
    ) : (
      <span className="select__label select__placeholder">{placeholder ?? String(props.value ?? '')}</span>
    )
  }

  let n = -1
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={props['aria-label']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${uid}-${active}` : undefined}
        className={`select${inline ? ' select--inline' : ''}${mono ? ' select--mono' : ''}${open ? ' is-open' : ''}${
          className ? ` ${className}` : ''
        }`}
        onClick={() => (open ? close(true) : openMenu())}
        onKeyDown={onKeyDown}
      >
        {display}
        <ChevronDown size={15} className="select__caret" />
      </button>
      {pos &&
        createPortal(
          <>
            <div className="select-menu__backdrop" onMouseDown={() => close(false)} />
            <div
              ref={menuRef}
              id={listId}
              role="listbox"
              aria-multiselectable={props.multiple || undefined}
              className={`select-menu${inline ? ' select-menu--inline' : ''}${mono ? ' select-menu--mono' : ''}${
                scrolls ? ' is-scroll' : ''
              }${menuClassName ? ` ${menuClassName}` : ''}`}
              style={pos}
            >
              {items.map((e, k) => {
                if ('separator' in e) return <div key={k} className="select-menu__sep" role="separator" />
                if ('group' in e)
                  return (
                    <div key={k} className="select-menu__group" role="presentation">
                      {e.lead}
                      {e.group}
                    </div>
                  )
                const i = ++n
                const on = isOn(e.value)
                return (
                  <div
                    key={k}
                    id={`${uid}-${i}`}
                    data-i={i}
                    role="option"
                    aria-selected={on}
                    className={`select-menu__opt${e.sub ? ' has-sub' : ''}${on ? ' is-on' : ''}${
                      i === active ? ' is-active' : ''
                    }`}
                    // 焦点留在触发框：按下不抢焦点，点击选中。
                    onMouseDown={(ev) => ev.preventDefault()}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(i)}
                  >
                    {e.lead}
                    <span className="select-menu__main">
                      <span className="select-menu__name">{e.label}</span>
                      {e.sub && <span className="select-menu__sub">{e.sub}</span>}
                    </span>
                    <Check size={15} className="select-menu__check" />
                  </div>
                )
              })}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
