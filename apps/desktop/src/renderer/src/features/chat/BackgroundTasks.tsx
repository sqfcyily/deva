import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, Loader2, Square } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useChat, type ChatBlock } from '../../store/chat'
import { ToolText, subagentTitle } from './blocks'
import { useDockOrder } from './dockOrder'

type SubagentBlock = Extract<ChatBlock, { kind: 'subagent' }>

/**
 * 子智能体此刻在做什么：执行中的工具调用（同时执行好几个时取最后一个，running 为其总数），没有则最近一次。
 * 内部步骤只在本次运行的渲染态里实时累积（不落盘，重载后只剩结论），还没有步骤时 step 为 undefined。
 */
function currentChild(task: SubagentBlock): { step?: SubagentBlock['children'][number]; running: number } {
  const running = task.children.filter((c) => c.status === 'running')
  return { step: running[running.length - 1] ?? task.children[task.children.length - 1], running: running.length }
}

/**
 * 后台任务胶囊（输入框正上方，与待办清单胶囊同一排）：本对话里仍在后台运行的子智能体（run_in_background）。
 * 它们不是本轮在等的事、常比回合活得长，放在对话流里要么随当前步骤上下移动、要么得翻回原消息才能停止，
 * 故固定在这里：一个时直接显示标题与停止键；多个时显示个数，点开向上展开——每个任务固定两行：标题 + 停止键，
 * 下面一行它当前的步骤（同时执行多个工具时只写一个，后缀「等 N 项」），面板右上角「全部停止」。
 * 全部结束即不渲染——结束通知照常作为一行系统通知进入对话流。
 * 对话流里的子智能体节点不带停止键。
 */
export function BackgroundCapsule(): React.JSX.Element | null {
  const { t } = useI18n()
  const { messages, currentSessionId, stopSubagent } = useChat()
  const [open, setOpen] = useState(false)
  // 已点停止、等主进程收尾事件把它定格的那一小段：按钮置灰，免得连点。
  const [stopping, setStopping] = useState<Set<string>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)

  const tasks = useMemo(() => {
    const out: SubagentBlock[] = []
    for (const m of messages)
      for (const b of m.blocks) if (b.kind === 'subagent' && b.background && b.status === 'running') out.push(b)
    return out
  }, [messages])

  // 切会话 / 只剩一个时面板关上，免得下次出现时自己弹开。
  useEffect(() => setOpen(false), [currentSessionId])
  useEffect(() => {
    if (tasks.length < 2) setOpen(false)
  }, [tasks.length])

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

  const order = useDockOrder(tasks.length > 0, currentSessionId)
  if (tasks.length === 0) return null

  const stop = (ids: string[]): void => {
    const todo = ids.filter((id) => !stopping.has(id))
    if (todo.length === 0) return
    setStopping((prev) => new Set([...prev, ...todo]))
    for (const id of todo) stopSubagent(id)
  }

  const stopButton = (task: SubagentBlock): React.JSX.Element => (
    <button
      type="button"
      className="cf-bg__stop"
      title={t('chat.subagent.stopHint')}
      disabled={stopping.has(task.id)}
      onClick={() => stop([task.id])}
    >
      <Square size={9} />
      {t('chat.subagent.stop')}
    </button>
  )

  if (tasks.length === 1) {
    const task = tasks[0]
    const name = subagentTitle(task, t)
    return (
      <div className="cf-bg" ref={rootRef} style={{ order }}>
        <div className="cf-bg__pill">
          <Loader2 size={13} className="spin cf-bg__spin" />
          <span className="cf-bg__label">{t('chat.bg.label')}</span>
          {/* 与待办清单胶囊同排时可能被截断，且单个任务没有可展开的面板：完整标题挂在悬停上。 */}
          <span className="cf-bg__name" title={name}>
            {name}
          </span>
          {stopButton(task)}
        </div>
      </div>
    )
  }

  return (
    <div className={`cf-bg${open ? ' is-open' : ''}`} ref={rootRef} style={{ order }}>
      {open && (
        <div className="cf-todo__panel" role="dialog" aria-label={t('chat.bg.title')}>
          <div className="cf-todo__head">
            <span className="cf-todo__title">{t('chat.bg.title')}</span>
            <button
              type="button"
              className="cf-bg__stop"
              title={t('chat.bg.stopAllHint')}
              disabled={tasks.every((task) => stopping.has(task.id))}
              onClick={() => stop(tasks.map((task) => task.id))}
            >
              <Square size={9} />
              {t('chat.bg.stopAll')}
            </button>
          </div>
          <div className="cf-todo__scroll cf-bg__list">
            {tasks.map((task) => {
              const name = subagentTitle(task, t)
              const { step, running } = currentChild(task)
              return (
                <div key={task.id} className="cf-bg__item">
                  <div className="cf-bg__row">
                    <Loader2 size={13} className="spin cf-bg__spin" />
                    <span className="cf-bg__name" title={name}>
                      {name}
                    </span>
                    {stopButton(task)}
                  </div>
                  <div className="cf-bg__step">
                    {step ? <ToolText step={step} /> : t('chat.bg.working')}
                    {running > 1 && (
                      <span className="cf-bg__more">{t('chat.bg.more').replace('{n}', String(running))}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <button
        type="button"
        className="cf-bg__pill is-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Loader2 size={13} className="spin cf-bg__spin" />
        <span className="cf-bg__name">{t('chat.bg.count').replace('{n}', String(tasks.length))}</span>
        <ChevronUp size={14} className="cf-bg__caret" />
      </button>
    </div>
  )
}
