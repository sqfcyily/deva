import { useEffect, useRef, useState } from 'react'
import { Check, ChevronUp, Circle, CircleDot } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChat } from '../../store/chat'
import type { TodoItem } from '../../../../preload'
import { useDockOrder } from './dockOrder'

/**
 * 待办清单（todo_write）的界面：输入框上方的进度胶囊 + 向上展开的清单面板，以及条目列表（对话流里的
 * 「已完成清单」卡也用它）。数据全来自主进程 todos 边车（store/chat 的 todos），这里只展示；唯一的写操作是
 * 面板里的「取消清单」——不再进行的清单也可由模型自己取消（todo_write cancel），胶囊随之收起。
 */

function countDone(items: TodoItem[]): number {
  return items.filter((x) => x.status === 'completed').length
}

/** 条目列表：已完成打勾划线、进行中高亮、待办空心圈。 */
export function TodoItemList({ items }: { items: TodoItem[] }): React.JSX.Element {
  const { t } = useI18n()
  const label: Record<TodoItem['status'], string> = {
    pending: t('chat.todo.pending'),
    in_progress: t('chat.todo.inProgress'),
    completed: t('chat.todo.completed')
  }
  return (
    <ul className="todo-items">
      {items.map((x, i) => (
        <li key={i} className={`todo-item is-${x.status}`}>
          <span className="todo-item__mark" role="img" aria-label={label[x.status]} title={label[x.status]}>
            {x.status === 'completed' ? (
              <Check size={10} strokeWidth={3.5} />
            ) : x.status === 'in_progress' ? (
              <CircleDot size={15} />
            ) : (
              <Circle size={15} />
            )}
          </span>
          <span className="todo-item__text">{x.content}</span>
        </li>
      ))}
    </ul>
  )
}

/** 进度环（0..1）：胶囊与面板头共用。 */
function ProgressRing({ value }: { value: number }): React.JSX.Element {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg className="cf-todo__ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r={r} className="cf-todo__ring-track" />
      <circle
        cx="8"
        cy="8"
        r={r}
        className="cf-todo__ring-fill"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * 进度胶囊（输入框正上方）：最多一个——正在进行的那个清单。显示其进行中一项与完成数，点开向上展开它的
 * 全部条目；较早的清单不展示。没有进行中的清单（从未建、已全部完成、或已取消）时不渲染：全部完成的清单
 * 已在对话流里落成「已完成清单」卡。
 */
export function TodoCapsule(): React.JSX.Element | null {
  const { t } = useI18n()
  const { todos, currentSessionId, streaming, cancelTodoList } = useChat()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = todos.active

  // 切会话 / 换了清单（新开、取消、全部完成）→ 面板关上，免得下次出现时自己弹开。
  useEffect(() => setOpen(false), [currentSessionId, active?.id])

  // 面板打开时：点面板外关闭；Esc 关闭并就此截住（不让输入框把它算作「双击 Esc 打开回滚」的一次）。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const order = useDockOrder(!!active, currentSessionId)
  if (!active) return null
  const total = active.items.length
  const done = countDone(active.items)
  const title = active.title || t('chat.todo.untitled')
  const doing = active.items.find((x) => x.status === 'in_progress')
  const next = active.items.find((x) => x.status === 'pending')
  const now = doing ? doing.content : next ? `${t('chat.todo.waiting')} · ${next.content}` : title

  return (
    <div className={`cf-todo${open ? ' is-open' : ''}`} ref={rootRef} style={{ order }}>
      {open && (
        <div className="cf-todo__panel" role="dialog" aria-label={title}>
          <div className="cf-todo__head">
            <ProgressRing value={done / total} />
            <span className="cf-todo__title">{title}</span>
            <span className="cf-todo__count">
              {done}/{total}
            </span>
            {/* 回合进行中不可取消：模型正在推进它，取消了也会被立刻写回——先停止任务。 */}
            <button
              type="button"
              className="cf-todo__cancel"
              disabled={streaming}
              title={t(streaming ? 'chat.todo.cancelBusy' : 'chat.todo.cancelHint')}
              onClick={() => {
                cancelTodoList()
                setOpen(false)
              }}
            >
              {t('chat.todo.cancel')}
            </button>
          </div>
          <div className="cf-todo__scroll">
            <TodoItemList items={active.items} />
          </div>
        </div>
      )}
      <button
        type="button"
        className="cf-todo__pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${now}\n${t('chat.todo.open')}`}
      >
        <ProgressRing value={done / total} />
        <span className={`cf-todo__now${doing ? ' is-doing' : ''}`}>{now}</span>
        <span className="cf-todo__count">
          {done}/{total}
        </span>
        <ChevronUp size={14} className="cf-todo__caret" />
      </button>
    </div>
  )
}
