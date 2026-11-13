import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronUp, Loader2, Square } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { type ChatBlock, useChatState, useChatStream, useChatActions } from '../../store/chat'
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
 * 等主智能体汇总的后台子智能体进度（同成员的 MemberProgressNotice，外观同 .cf-mprogress）：同一轮派出的后台子智能体
 * 是一组，主进程等最后一个结束才唤醒主智能体一次、一并汇总。组里已有完成、还有在跑的时，对话末尾居中一行
 * 「「检索鉴权逻辑」已完成」/「2 个子智能体已完成」；全部结束即消失，主智能体随之汇总。悬停看每个的状态。
 * 一轮只有一条助手消息，按消息分组即按派发的那一轮分组。只算顺利完成的：出错 / 被停止的结局写在各自的 Task 卡上。
 * 不进对话记录。
 */
export function SubagentProgressNotice({ ownerName }: { ownerName: string }): React.JSX.Element | null {
  const { t } = useI18n()
  const { messages } = useChatStream()
  const groups = useMemo(() => {
    const out: SubagentBlock[][] = []
    for (const m of messages) {
      const cards = m.blocks.filter((b): b is SubagentBlock => b.kind === 'subagent' && !!b.background)
      if (cards.some((b) => b.status === 'running') && cards.some((b) => b.status === 'ok')) out.push(cards)
    }
    return out
  }, [messages])
  if (groups.length === 0) return null
  return (
    <>
      {groups.map((cards) => {
        const done = cards.filter((b) => b.status === 'ok')
        const running = cards.filter((b) => b.status === 'running')
        const text =
          done.length === 1
            ? t('chat.bg.doneOne').replace('{name}', subagentTitle(done[0], t))
            : t('chat.bg.doneMany').replace('{n}', String(done.length))
        const title = [
          ...done.map((b) => `${subagentTitle(b, t)}　${t('chat.bg.doneStatus')}`),
          ...running.map((b) => `${subagentTitle(b, t)}　${t('chat.bg.working')}`),
          t('chat.bg.doneHint').replace('{owner}', ownerName)
        ].join('\n')
        return (
          <div key={cards[0].id} className="cf-mprogress">
            <div className="cf-mprogress__pill is-noface" title={title}>
              <Bot size={13} className="cf-mprogress__icon" />
              <span className="cf-mprogress__text">{text}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

/**
 * 后台任务胶囊（输入框正上方，与待办清单胶囊同一排）：本对话里仍在后台运行的子智能体（默认即后台运行）。
 * 它们不是本轮在等的事、常比回合活得长，放在对话流里要么随当前步骤上下移动、要么得翻回原消息才能停止，
 * 故固定在这里：一个时直接显示标题与停止键；多个时显示个数，点开向上展开——每个任务固定两行：标题 + 停止键，
 * 下面一行它当前的步骤（同时执行多个工具时只写一个，后缀「等 N 项」），面板右上角「全部停止」。
 * 全部结束即不渲染——结束通知照常作为一行系统通知进入对话流。
 * 对话流里的子智能体节点不带停止键。
 */
export function BackgroundCapsule(): React.JSX.Element | null {
  const { t } = useI18n()
  const { currentSessionId } = useChatState()
  const { messages } = useChatStream()
  const { stopSubagent } = useChatActions()
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
