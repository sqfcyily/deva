/**
 * 右键菜单（对话列表、Git、工作区、对话流共用）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** 菜单条目：普通项点击即执行并关闭菜单；separator=分隔线；section=不可点的分组标题；filter=过滤框（按 label 过滤普通项）。 */
interface CtxItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  /** 禁用项：灰显 + 悬停说明（title），不可点（如系统默认角色的删除项）。 */
  disabled?: boolean
  title?: string
  onClick: () => void
}

export type CtxEntry =
  | CtxItem
  | { kind: 'separator' }
  | { kind: 'section'; label: string }
  | { kind: 'filter'; placeholder?: string }

/**
 * 轻量右键菜单：定位到光标处（视口坐标），带全屏透明背板——点击 / 右键空白 / Esc 皆关闭。
 * 挂载后测量自身尺寸并夹取回视口内，避免贴近右 / 下边缘时溢出被裁。
 * openUp 时把传入的 y 当作菜单「底边」锚点（top = y − 菜单高度），使其向上生长——
 * 用于贴近视口底部的触发点（如挂载 chip 的 git pill），避免菜单向下遮挡输入区，行为同模型切换的 dropup。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  openUp = false
}: {
  x: number
  y: number
  items: CtxEntry[]
  onClose: () => void
  /** 向上浮出：y 视作菜单底边锚点，菜单朝上生长（默认向下）。 */
  openUp?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = x
    // openUp：y 是底边 → 顶边 = y − 高度；否则 y 即顶边。随后统一夹回视口。
    let top = openUp ? y - r.height : y
    if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad
    if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
    // 条目数 / 过滤结果变化会改变高度，需重新夹取
  }, [x, y, openUp, items.length, q])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div
        className="cf-ctx__backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div ref={ref} className="cf-ctx" style={{ left: pos.left, top: pos.top }} role="menu">
        {items.map((it, i) => {
          if ('kind' in it) {
            if (it.kind === 'separator') return q ? null : <div key={i} className="cf-ctx__sep" role="separator" />
            if (it.kind === 'section') return q ? null : <div key={i} className="cf-ctx__section">{it.label}</div>
            return (
              <input
                key={i}
                className="cf-ctx__filter"
                autoFocus
                placeholder={it.placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )
          }
          if (q && !it.label.toLowerCase().includes(q)) return null
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`cf-ctx__item${it.danger ? ' is-danger' : ''}`}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                onClose()
                it.onClick()
              }}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
