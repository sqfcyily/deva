import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Square,
  Paperclip,
  Sparkles,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  FilePen,
  Replace,
  Search,
  FileSearch,
  Globe,
  SquareTerminal,
  Plug,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Info,
  Image as ImageIcon,
  FileCode2,
  MessageCircleQuestion,
  Bot,
  Pencil,
  Circle,
  CheckSquare,
  ClipboardList,
  ClipboardCheck,
  X
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import {
  useChat,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type StreamStatus,
  type ToolStatus
} from '../../store/chat'
import { useModels } from '../../store/models'
import { Markdown } from './Markdown'
import { HumationFace } from '../../components/humation'
import { TaskConfirmCard } from './TaskConfirmCard'

/**
 * 对话主视图（DeepSeek 网页版风格）。消费 chat store 的真实数据：
 * 用户消息靠右气泡，助手消息靠左通栏；助手块按到达顺序渲染文本/思考/工具卡/权限卡/错误。
 */

/** 一次挑选返回的附件（与 preload PickedAttachment 结构一致）。 */
interface Picked {
  path: string
  name: string
  ext: string
  size: number
  kind: 'image' | 'document' | 'text' | 'unsupported'
  supported: boolean
  reason?: string
}

/** 距底 ≤ 此像素即视为「贴住底部」，留缓冲避免临界抖动。 */
const BOTTOM_THRESHOLD = 64

/** 附件类型 → 图标。 */
function iconFor(kind: AttachKind | 'unsupported'): React.ReactNode {
  if (kind === 'image') return <ImageIcon size={13} />
  if (kind === 'document') return <FileText size={13} />
  if (kind === 'text') return <FileCode2 size={13} />
  return <Paperclip size={13} />
}

const TOOL_META: Record<string, { icon: React.ReactNode; key: string }> = {
  read_file: { icon: <FileText size={14} />, key: 'chat.tool.readFile' },
  list_dir: { icon: <FolderTree size={14} />, key: 'chat.tool.listDir' },
  glob: { icon: <FileSearch size={14} />, key: 'chat.tool.glob' },
  grep: { icon: <Search size={14} />, key: 'chat.tool.grep' },
  web_fetch: { icon: <Globe size={14} />, key: 'chat.tool.webFetch' },
  write_file: { icon: <FilePen size={14} />, key: 'chat.tool.writeFile' },
  edit_file: { icon: <Replace size={14} />, key: 'chat.tool.editFile' },
  run_command: { icon: <SquareTerminal size={14} />, key: 'chat.tool.runCommand' },
  ask_user: { icon: <MessageCircleQuestion size={14} />, key: 'chat.tool.askUser' },
  create_skill: { icon: <Sparkles size={14} />, key: 'chat.tool.createSkill' },
  create_mcp: { icon: <Plug size={14} />, key: 'chat.tool.createMcp' }
}

/**
 * 路径展示的字符预算。780px 列宽下标题约可容 70 字符，但结果徽标宽度不定
 * （「第 590–669/670 行」比「176 行」宽得多，实测同一条 68 字符路径会因此一行放得下、也可能折行），
 * 故取 54 留一档余量：窄徽标下本就放得下的路径不动，宽徽标下会折行的一律先压。
 * 窗口远窄于列宽上限时仍可能折行，届时由 .card__title 的 overflow-wrap 兜底。
 */
const PATH_BUDGET = 54

/**
 * 深路径压缩中段：保头保尾，中间塞省略号，令其单行放得下而不折行。
 * 尾部固定留「父目录/文件名」——文件名是身份、父目录用于区分同名文件（一堆 index.ts）；
 * 头部在预算内尽量多留——src/main 与 src/test 的差别全在这一段。
 */
function compressPath(p: string): string {
  if (p.length <= PATH_BUDGET) return p
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  const segs = p.split(/[/\\]/)
  // 少于 4 段则中间无段可省，省了反而更长
  if (segs.length < 4) return p
  const tail = segs.slice(-2).join(sep)
  // 从左往右尽量多保留头部段，直到再加一段就超预算（+3 为 sep…sep 的开销）
  let keep = 0
  for (let i = 1; i <= segs.length - 2; i++) {
    if (segs.slice(0, i).join(sep).length + 3 + tail.length > PATH_BUDGET) break
    keep = i
  }
  // keep=1 且首段为空 → POSIX 绝对路径，join 得空串，恰好拼出前导分隔符
  const out = `${segs.slice(0, keep).join(sep)}${keep > 0 ? sep : ''}…${sep}${tail}`
  return out.length < p.length ? out : p
}

/**
 * 工具卡上要展示的参数提示：优先 command（run_command），再 path，再 pattern（grep/glob），再 url（web_fetch）。
 * full 为原值（压缩过时挂 title 供悬停查看），text 为展示值——只有 path 压缩中段，
 * 命令的头部、正则的全文、URL 的域名与查询串同样字字关键，照旧折行不动。
 */
function argHint(args: unknown): { text: string; full: string } | null {
  if (args && typeof args === 'object') {
    const o = args as { command?: unknown; path?: unknown; pattern?: unknown; url?: unknown }
    if (typeof o.command === 'string' && o.command.trim()) return { text: o.command, full: o.command }
    if (typeof o.path === 'string' && o.path.trim())
      return { text: compressPath(o.path), full: o.path }
    if (typeof o.pattern === 'string' && o.pattern.trim())
      return { text: o.pattern, full: o.pattern }
    if (typeof o.url === 'string' && o.url.trim()) return { text: o.url, full: o.url }
  }
  return null
}

/** 压缩过才挂 title：未压缩时展示值即全值，重复的悬停提示只是噪声。 */
function hintTitle(h: { text: string; full: string } | null): string | undefined {
  return h && h.text !== h.full ? h.full : undefined
}

/** 底部指示器要表达的当前活动。（对话优先外壳复用 StatusIndicator/deriveActivity，故导出。） */
export type Activity =
  | { kind: 'thinking' }
  | { kind: 'responding' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'subagent'; agent: string }
  | { kind: 'ask' }
  | { kind: 'plan' }

/**
 * 从最后一条助手消息的块序列推断"此刻在干什么"：
 * 未答复的问答卡 / 未决计划 > 运行中的工具 / 子智能体 > 末块有正文=生成回答 > 其余=思考中。
 */
export function deriveActivity(messages: ChatMessage[]): Activity {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return { kind: 'thinking' }
  const blocks = last.blocks
  if (blocks.some((b) => b.kind === 'plan' && !b.decided)) return { kind: 'plan' }
  if (blocks.some((b) => b.kind === 'ask' && b.answers === undefined)) return { kind: 'ask' }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'tool' && b.status === 'running') return { kind: 'tool', toolName: b.name }
    if (b.kind === 'subagent' && b.status === 'running')
      return { kind: 'subagent', agent: b.agent }
  }
  const tail = blocks[blocks.length - 1]
  if (tail?.kind === 'text' && tail.text.trim()) return { kind: 'responding' }
  return { kind: 'thinking' }
}

export function ChatView(): React.JSX.Element {
  const { t } = useI18n()
  const {
    messages,
    streaming,
    streamStatus,
    currentSessionId,
    send,
    stop,
    respondAsk
  } = useChat()
  const { activeModel, providers, setActiveModel } = useModels()
  const [input, setInput] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const [pending, setPending] = useState<Picked[]>([])

  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // 是否「贴住底部」：决定流式新内容是否自动跟随滚动。用户上滚离开底部即脱离跟随，
  // 回到底部（或点「回到最新」）即重新跟随。ref 供滚动副作用同步读取（避免闭包过期、且其变化不触发副作用重跑），
  // state 仅驱动「回到最新」按钮显隐。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // 新内容到达时，仅当仍贴住底部才自动滚到底；用户上滚查看历史时保持不动。
  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  // 切换会话（含首次挂载）：复位为贴底并直接滚到底（ChatView 不按会话重挂载，故需显式复位）。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [currentSessionId])

  // 监听用户滚动：据距底距离更新「是否贴底」。程序化滚到底同样会触发，结果仍为贴底、幂等。
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBot = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom((prev) => (prev === atBot ? prev : atBot))
  }

  // 回到最新：平滑滚到底并恢复自动跟随。
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stickRef.current = true
    setAtBottom(true)
  }

  const supportedPending = pending.filter((p) => p.supported)
  const canSend = Boolean(input.trim()) || supportedPending.length > 0

  const pickFiles = async (): Promise<void> => {
    if (streaming) return
    const picked = (await window.deva.fs.pickAttachments()) as Picked[]
    if (!picked.length) return
    setPending((prev) => {
      const seen = new Set(prev.map((p) => p.path))
      return [...prev, ...picked.filter((p) => !seen.has(p.path))]
    })
  }

  const removePending = (path: string): void =>
    setPending((prev) => prev.filter((p) => p.path !== path))

  const submit = (): void => {
    const text = input
    const atts = pending.filter((p) => p.supported)
    if ((!text.trim() && atts.length === 0) || streaming) return
    setInput('')
    setPending([])
    if (taRef.current) taRef.current.style.height = 'auto'
    // 发送后必看到自己的消息与回复：无论此刻是否上滚，都恢复贴底跟随。
    stickRef.current = true
    setAtBottom(true)
    void send(
      text,
      atts.map((p) => ({ path: p.path, name: p.name, kind: p.kind as AttachKind }))
    )
  }

  // 在光标处插入换行并同步 state / 自适应高度（Ctrl/Alt+Enter 走此路，浏览器默认不会为这些组合键插入换行）。
  const insertNewlineAtCursor = (el: HTMLTextAreaElement): void => {
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    const next = `${el.value.slice(0, start)}\n${el.value.slice(end)}`
    setInput(next)
    // 同步原生值与光标，避免下一帧受控回填把光标拽回，并即时重算高度。
    el.value = next
    const caret = start + 1
    el.selectionStart = caret
    el.selectionEnd = caret
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    // Shift/Ctrl/Alt + Enter 一律换行；仅裸 Enter 发送。
    if (e.shiftKey || e.ctrlKey || e.altKey) {
      // Shift+Enter 交给浏览器默认换行；Ctrl/Alt+Enter 默认不换行，需手动插入。
      if (e.ctrlKey || e.altKey) {
        e.preventDefault()
        insertNewlineAtCursor(e.currentTarget)
      }
      return
    }
    e.preventDefault()
    submit()
  }

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // 可选模型：按服务商分组（仅启用的服务商 / 其下启用的模型），供分组下拉渲染。
  const groups = providers
    .filter((p) => p.enabled)
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0)

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="chat__empty">
            <Sparkles size={30} />
            <div className="chat__empty-title">{t('chat.empty')}</div>
            <div className="chat__empty-hint">{t('chat.emptyHint')}</div>
          </div>
        ) : (
          <div className="chat__thread">
            {messages.map((m, i) => (
              <MessageRow
                key={m.id}
                msg={m}
                active={streaming && i === messages.length - 1}
                onAsk={respondAsk}
              />
            ))}
            {streaming && (
              <StatusIndicator
                activity={deriveActivity(messages)}
                status={streamStatus}
                onStop={stop}
              />
            )}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="composer">
        {/* 回到最新：仅当用户上滚离开底部且已有消息时浮现，锚在输入框顶边正上方居中 */}
        {!atBottom && messages.length > 0 && (
          <button
            className="chat__jump"
            type="button"
            onClick={jumpToLatest}
            title={t('chat.jumpToLatest')}
            aria-label={t('chat.jumpToLatest')}
          >
            <ChevronDown size={18} />
          </button>
        )}
        <div className="composer__box">
          {pending.length > 0 && (
            <div className="composer__attachments">
              {pending.map((p) => (
                <span
                  key={p.path}
                  className={`attach-chip${p.supported ? '' : ' is-bad'}`}
                  title={p.supported ? p.name : `${p.name} · ${p.reason ?? ''}`}
                >
                  {iconFor(p.kind)}
                  <span className="attach-chip__name">{p.name}</span>
                  <button
                    className="attach-chip__x"
                    type="button"
                    onClick={() => removePending(p.path)}
                    title={t('chat.attachRemove')}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="composer__input"
            rows={1}
            placeholder={t('chat.placeholder')}
            value={input}
            onChange={autoGrow}
            onKeyDown={onKeyDown}
          />
          <div className="composer__toolbar">
            <button className="chip" type="button" onClick={pickFiles} disabled={streaming}>
              <Paperclip size={13} />
              {t('chat.attach')}
            </button>

            <div className="composer__spacer" />

            {/* 模型选择 */}
            <div className="model-pick">
              <button
                className={`chip${pickOpen ? ' is-open' : ''}`}
                type="button"
                onClick={() => setPickOpen((v) => !v)}
              >
                {activeModel && (
                  <span
                    className="chip__dot"
                    style={{ background: activeModel.provider.accent }}
                  />
                )}
                <span className="chip__label">
                  {activeModel ? activeModel.model.name : t('chat.selectModel')}
                </span>
                <ChevronDown size={13} className="chip__caret" />
              </button>
              {pickOpen && (
                <>
                  <div className="model-pick__backdrop" onClick={() => setPickOpen(false)} />
                  <div className="model-pick__menu" role="menu">
                    {groups.length === 0 && (
                      <div className="model-pick__empty">{t('chat.noModel')}</div>
                    )}
                    {groups.map(({ p, models }) => (
                      <div key={p.id} className="model-pick__group">
                        <div className="model-pick__group-head">
                          <span className="model-pick__dot" style={{ background: p.accent }} />
                          <span className="model-pick__group-name">{p.name}</span>
                        </div>
                        {models.map((m) => {
                          const active =
                            activeModel?.provider.id === p.id && activeModel?.model.id === m.id
                          return (
                            <button
                              key={m.id}
                              role="menuitemradio"
                              aria-checked={active}
                              className={`model-pick__item${active ? ' is-active' : ''}`}
                              title={m.name}
                              onClick={() => {
                                setActiveModel(p.id, m.id)
                                setPickOpen(false)
                              }}
                            >
                              <span className="model-pick__name">{m.name}</span>
                              {active && <Check size={14} className="model-pick__check" />}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {streaming ? (
              <button
                className="icon-btn"
                style={{ background: 'var(--bg-hover)', color: 'var(--fg)' }}
                title={t('chat.stop')}
                onClick={stop}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                className="icon-btn"
                style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                title={t('chat.send')}
                onClick={submit}
                disabled={!canSend}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 对话流底部的工作状态指示器：随自动滚动停在最新消息下方，仅流式期间显示。
 * 三种形态：活跃（脉动点 + 活动文案 + 已用秒数）/ 等待授权 / 自动重连（含[停止]）。
 * "自动重连"是主进程 reconnecting 事件驱动的真实信号，非渲染层猜测。
 */
export function StatusIndicator({
  activity,
  status,
  onStop
}: {
  activity: Activity
  status: StreamStatus
  onStop: () => void
}): React.JSX.Element {
  const { t } = useI18n()

  // 连接中断、正在自动重连：真实信号，给出停止入口（用户可放弃重连）。
  if (status.reconnecting) {
    const { attempt, max } = status.reconnecting
    return (
      <div className="chat__status is-reconnecting" role="status" aria-live="polite">
        <Loader2 size={14} className="spin" />
        <span>
          {t('chat.work.reconnecting')} ({attempt}/{max})
        </span>
        <button type="button" className="chat__status-stop" onClick={onStop}>
          {t('chat.stop')}
        </button>
      </div>
    )
  }

  // 等待批准计划：引导用户去上方计划卡点「批准并执行 / 继续完善」。
  if (activity.kind === 'plan') {
    return (
      <div className="chat__status is-waiting" role="status" aria-live="polite">
        <ClipboardCheck size={14} />
        <span>{t('chat.work.awaitingPlan')}</span>
      </div>
    )
  }

  // 等待作答：引导用户去上方问答卡选择/输入。
  if (activity.kind === 'ask') {
    return (
      <div className="chat__status is-waiting" role="status" aria-live="polite">
        <MessageCircleQuestion size={14} />
        <span>{t('chat.work.awaitingAnswer')}</span>
      </div>
    )
  }

  const label =
    activity.kind === 'tool'
      ? `${t('chat.work.usingTool')} · ${t(TOOL_META[activity.toolName]?.key ?? 'chat.tool.unknown')}`
      : activity.kind === 'subagent'
        ? `${t('chat.work.subagent')} · ${activity.agent || t('chat.subagent.fallback')}`
        : activity.kind === 'responding'
          ? t('chat.work.responding')
          : t('chat.work.thinking')

  return (
    <div className="chat__status" role="status" aria-live="polite">
      <span className="chat__status-dot" />
      <span>{label}…</span>
      <span className="chat__status-time">{status.elapsedSec}s</span>
    </div>
  )
}

/**
 * 单条消息行。用 React.memo + msg 引用比较：store 的 updateLastAssistant 只替换最后一条消息对象、
 * 其余引用不变，故流式期间只有「正在生长的那条」会重渲染/重解析，历史消息全部跳过。
 * 比较刻意忽略 onAsk 的引用变化——它以 setMessages 函数式更新 + 按 key 派发，
 * 行为与创建它的那次渲染无关，用「旧」回调也不会出错。
 */
const MessageRow = memo(
  function MessageRow({
    msg,
    active,
    onAsk
  }: {
    msg: ChatMessage
    active: boolean
    onAsk: (key: string, answers: string[]) => void
  }): React.JSX.Element {
    if (msg.role === 'user') {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="msg msg--user">
        <div className="bubble--user">
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="msg__attachments">
              {msg.attachments.map((a, i) => (
                <span key={i} className="attach-chip attach-chip--sent" title={a.name}>
                  {iconFor(a.kind)}
                  <span className="attach-chip__name">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {text && (
            <div className="msg__text">
              <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

    return (
      <div className="msg msg--agent">
        <div className="msg__content">
          {msg.blocks.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              thinkingDone={!(active && i === msg.blocks.length - 1)}
              onAsk={onAsk}
            />
          ))}
        </div>
      </div>
    )
  },
  (prev, next) => prev.msg === next.msg && prev.active === next.active
)

/**
 * 思考块（可折叠）。对齐 Codex/DeepSeek 的推理折叠：思考中默认展开，思考完成后自动收起
 * （用户仍可手动点开）。标签随状态在「思考中」/「已思考」间切换。正文按弱化配色渲染 Markdown（muted）。
 */
function ThinkingBlock({ text, done }: { text: string; done: boolean }): React.JSX.Element {
  const { t } = useI18n()
  // 初始：思考中展开、已完成（如历史消息）收起。
  const [open, setOpen] = useState(!done)
  // 完成的瞬间（done: false→true）自动收起一次；此后用户可自由再展开。
  const wasDone = useRef(done)
  useEffect(() => {
    if (done && !wasDone.current) setOpen(false)
    wasDone.current = done
  }, [done])
  return (
    <div className={open ? 'msg__think is-open' : 'msg__think'}>
      <button type="button" className="msg__think-head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className="msg__think-caret" />
        <span className="msg__think-label">{done ? t('chat.thought') : t('chat.thinking')}</span>
      </button>
      {open && (
        <div className="msg__think-body">
          <Markdown text={text} muted />
        </div>
      )}
    </div>
  )
}

export function BlockView({
  block,
  thinkingDone,
  onAsk,
  onPlan,
  onOpenProposal,
  onOpenAutotask
}: {
  block: ChatBlock
  thinkingDone: boolean
  onAsk: (key: string, answers: string[]) => void
  /** 回应 exit_plan 计划审阅（批准并执行 / 继续完善）。缺省 → 计划卡只读展示（如旧壳）。 */
  onPlan?: (key: string, decision: 'approve' | 'keep') => void
  /** 点角色名片 → 打开预填的 PersonaEditor（仅对话优先外壳传入；旧壳不传 → 名片只读展示）。 */
  onOpenProposal?: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** created 态定时任务名片「打开任务会话」（仅对话优先外壳传入；旧壳不传 → 不显跳转）。 */
  onOpenAutotask?: (taskId: string) => void
}): React.JSX.Element | null {
  const { t } = useI18n()

  if (block.kind === 'text') {
    if (!block.text) return null
    return (
      <div className="msg__text">
        <Markdown text={block.text} />
      </div>
    )
  }

  if (block.kind === 'thinking') {
    return <ThinkingBlock text={block.text} done={thinkingDone} />
  }

  if (block.kind === 'tool') {
    const meta = TOOL_META[block.name] ?? { icon: <Wrench size={14} />, key: 'chat.tool.unknown' }
    const hint = argHint(block.args)
    return (
      <div className="card">
        <div className="card__head" title={hintTitle(hint)}>
          <span className="card__head-icon">{meta.icon}</span>
          <span className="card__title">
            {t(meta.key)} {hint && <code>{hint.text}</code>}
          </span>
          <ToolBadge status={block.status} summary={block.summary} />
        </div>
      </div>
    )
  }

  if (block.kind === 'subagent') {
    return <SubagentCard block={block} />
  }

  if (block.kind === 'agentcard') {
    return <AgentCard block={block} onOpen={onOpenProposal} />
  }

  if (block.kind === 'autotaskcard') {
    return <TaskConfirmCard block={block} onOpen={onOpenAutotask} />
  }

  if (block.kind === 'ask') {
    return <AskCard block={block} onAsk={onAsk} />
  }

  if (block.kind === 'plan') {
    return <PlanReviewCard block={block} onPlan={onPlan} />
  }

  // notice：回合终止说明（截断/空回合）或上下文压缩结果，弱化提示样式，区别于红色错误
  if (block.kind === 'notice') {
    const NOTICE_KEY: Record<typeof block.code, string> = {
      truncated: 'chat.notice.truncated',
      empty: 'chat.notice.empty',
      compacted: 'chat.notice.compacted',
      compact_none: 'chat.notice.compactNone',
      compact_failed: 'chat.notice.compactFailed'
    }
    return (
      <div className="msg__notice">
        <Info size={14} />
        <span>{t(NOTICE_KEY[block.code])}</span>
      </div>
    )
  }

  // error
  return (
    <div className="msg__error">
      <AlertTriangle size={14} />
      <span style={{ whiteSpace: 'pre-wrap' }}>{block.message}</span>
    </div>
  )
}

/**
 * 计划审阅卡（exit_plan）：展示模型提交的待批准计划（Markdown 正文），提供「批准并执行 / 继续完善」。
 * 未决态可交互；decided 为终态、只读展示（重开对话按 plans 边车复原）。onPlan 缺省 → 只读（如旧壳）。
 */
function PlanReviewCard({
  block,
  onPlan
}: {
  block: Extract<ChatBlock, { kind: 'plan' }>
  onPlan?: (key: string, decision: 'approve' | 'keep') => void
}): React.JSX.Element {
  const { t } = useI18n()
  const decided = block.decided
  return (
    <div className={decided ? 'msg__plan is-decided' : 'msg__plan'}>
      <div className="msg__plan-head">
        <ClipboardList size={14} />
        <span className="msg__plan-title">{t('chat.plan.cardTitle')}</span>
        {decided && (
          <span className="msg__plan-badge">
            {decided === 'approve' ? t('chat.plan.approved') : t('chat.plan.kept')}
          </span>
        )}
      </div>
      <div className="msg__plan-body">
        <Markdown text={block.plan} />
      </div>
      {!decided && onPlan && (
        <div className="msg__plan-actions">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => onPlan(block.key, 'approve')}
          >
            <ClipboardCheck size={14} />
            {t('chat.plan.approve')}
          </button>
          <button type="button" className="btn btn--sm" onClick={() => onPlan(block.key, 'keep')}>
            {t('chat.plan.keep')}
          </button>
        </div>
      )}
    </div>
  )
}

/** 单个问题的作答草稿：已选标签集合 + 是否展开自由输入 + 自由输入文本。 */
interface AskDraft {
  picks: string[]
  /** 是否选中「自己输入」项（有候选项时输入框才显示；纯自由题恒显示）。 */
  customOn: boolean
  custom: string
}

/** 「推荐」标记：匹配 label 末尾的 （推荐）/(Recommended)，用于高亮 + 从展示/回传中剥离。 */
const RECO_RE = /[（(]\s*(推荐|recommended)\s*[)）]\s*$/i
const isReco = (label: string): boolean => RECO_RE.test(label)
const cleanLabel = (label: string): string => label.replace(RECO_RE, '').trim()

/** 把一题的草稿收敛成一条可读答案：已选标签（剥离「推荐」标记）+ 非空自由输入，按「、」拼接。 */
function draftToAnswer(d: AskDraft): string {
  const parts = d.picks.map(cleanLabel)
  const c = d.custom.trim()
  if (c) parts.push(c)
  return parts.join('、')
}

/**
 * 问答卡（征求决策/澄清）：每题单选或多选、每题都可自行输入，用户选好后统一提交。
 * 多问题时改为「分步向导」——每次只显示一题、可前后切换（类 Claude Code），避免一次性铺开过长；
 * 单问题保持一次性展示。全部问题都作答后「提交」才可用；作答后收敛为已答态，逐题回述答案。
 */
function AskCard({
  block,
  onAsk
}: {
  block: Extract<ChatBlock, { kind: 'ask' }>
  onAsk: (key: string, answers: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { questions } = block
  const multiQ = questions.length > 1
  const last = questions.length - 1
  const answered = block.answers !== undefined
  const [drafts, setDrafts] = useState<AskDraft[]>(() =>
    questions.map(() => ({ picks: [], customOn: false, custom: '' }))
  )
  // 当前步（仅多问题向导使用）；单选自动前进用定时器，卸载时清理避免卸载后 setState。
  const [step, setStep] = useState(0)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
    },
    []
  )

  const patchDraft = (qi: number, patch: Partial<AskDraft>): void => {
    setDrafts((prev) => prev.map((d, i) => (i === qi ? { ...d, ...patch } : d)))
  }

  // 选真候选项。单选时选中会互斥地关掉「自己输入」并清空其文本；再点已选项即取消。
  const pickReal = (qi: number, label: string): void => {
    if (answered) return
    const q = questions[qi]
    const cur = drafts[qi].picks
    if (q.multi) {
      patchDraft(qi, {
        picks: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
      })
    } else {
      patchDraft(qi, {
        picks: cur[0] === label && cur.length === 1 ? [] : [label],
        customOn: false,
        custom: ''
      })
    }
  }

  // 点「自己输入」项：展开/收起输入框。单选时与真候选项互斥（清空 picks）；收起时清空已输文本。
  const toggleCustom = (qi: number): void => {
    if (answered) return
    const q = questions[qi]
    const d = drafts[qi]
    const nextOn = !d.customOn
    patchDraft(qi, {
      customOn: nextOn,
      custom: nextOn ? d.custom : '',
      picks: q.multi ? d.picks : nextOn ? [] : d.picks
    })
  }

  // 有候选项时，输入框仅在选中「自己输入」后显示；纯自由题（无候选项）恒显示。
  const inputShown = (qi: number): boolean =>
    questions[qi].options.length === 0 || drafts[qi].customOn

  // 每题「已作答」= 可跳过题(required===false)恒视为已答；否则需选了项或填了（已展开的）自由输入。
  const isDone = (qi: number): boolean => {
    if (questions[qi].required === false) return true
    const d = drafts[qi]
    if (d.picks.length > 0) return true
    return inputShown(qi) && d.custom.trim().length > 0
  }
  const allDone = questions.every((_, qi) => isDone(qi))
  // 空答（未选也未填）：用于把可跳过题的按钮文案从「下一步/提交」切成「跳过」。
  const isBlank = (qi: number): boolean =>
    drafts[qi].picks.length === 0 && drafts[qi].custom.trim().length === 0

  const clearTimer = (): void => {
    if (advanceTimer.current) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = null
    }
  }
  const goStep = (i: number): void => {
    clearTimer()
    setStep(Math.max(0, Math.min(last, i)))
  }

  // 真候选项点击：单选且本次为「选中」（非取消）且非末题 → 短延时自动前进（让用户看清选中态再切）。
  const onOptionClick = (qi: number, label: string): void => {
    const q = questions[qi]
    const willSelect = q.multi || !(drafts[qi].picks[0] === label && drafts[qi].picks.length === 1)
    pickReal(qi, label)
    if (multiQ && !q.multi && willSelect && qi < last) {
      clearTimer()
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null
        setStep((s) => Math.min(last, s + 1))
      }, 180)
    }
  }

  const submit = (): void => {
    if (answered || !allDone) return
    clearTimer()
    onAsk(
      block.key,
      questions.map((_, qi) => draftToAnswer(drafts[qi]))
    )
  }

  // 单题作答区（候选项 + 「自己输入」项 + 展开后的输入框）：单题模式与向导模式共用。
  const renderBody = (qi: number): React.JSX.Element => {
    const q = questions[qi]
    const hasOptions = q.options.length > 0
    const d = drafts[qi]
    const CustomIcon = q.multi ? (d.customOn ? CheckSquare : Square) : d.customOn ? CheckCircle2 : Circle
    return (
      <>
        {hasOptions && (
          <div className="ask__options">
            {q.options.map((o, i) => {
              const on = d.picks.includes(o.label)
              const Icon = q.multi ? (on ? CheckSquare : Square) : on ? CheckCircle2 : Circle
              return (
                <button
                  key={i}
                  type="button"
                  className={`ask__option${on ? ' is-on' : ''}`}
                  onClick={() => onOptionClick(qi, o.label)}
                >
                  <Icon size={15} className="ask__option-mark" />
                  <span className="ask__option-body">
                    <span className="ask__option-label">
                      {cleanLabel(o.label)}
                      {isReco(o.label) && <span className="ask__reco">{t('chat.ask.recommended')}</span>}
                    </span>
                    {o.description && <span className="ask__option-desc">{o.description}</span>}
                  </span>
                </button>
              )
            })}
            {/* 「自己输入」项：点选后才展开输入框（对齐 Claude Code 的 Other，避免每题常驻文本框）。 */}
            <button
              type="button"
              className={`ask__option${d.customOn ? ' is-on' : ''}`}
              onClick={() => toggleCustom(qi)}
            >
              <CustomIcon size={15} className="ask__option-mark" />
              <span className="ask__option-body">
                <span className="ask__option-label">{t('chat.ask.customOption')}</span>
              </span>
            </button>
          </div>
        )}
        {inputShown(qi) && (
          <div className="ask__custom">
            <Pencil size={13} className="ask__custom-icon" />
            <input
              className="ask__custom-input"
              value={d.custom}
              placeholder={t('chat.ask.customPlaceholder')}
              // 有候选项时输入框是「点开自己输入」才出现的，自动聚焦；纯自由题恒显示则不抢焦点。
              autoFocus={hasOptions}
              onChange={(e) => patchDraft(qi, { custom: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                // 向导非末题：回车前进（须本题已答）；单题或末题：回车提交（须全答）。
                if (multiQ && qi < last) {
                  if (isDone(qi)) {
                    e.preventDefault()
                    goStep(qi + 1)
                  }
                } else if (allDone) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
        )}
        {q.required === false && <div className="ask__optional">{t('chat.ask.optional')}</div>}
      </>
    )
  }

  return (
    <div className={`ask${answered ? ' is-answered' : ''}`}>
      <div className="ask__head">
        <span className="ask__head-icon">
          <MessageCircleQuestion size={15} />
        </span>
        {t('chat.ask.title')}
        {!answered && multiQ && (
          <span className="ask__progress">
            {step + 1} / {questions.length}
          </span>
        )}
      </div>

      {answered ? (
        // 已答：逐题回述（紧凑，一行一答）。
        questions.map((q, qi) => (
          <div className="ask__q" key={qi}>
            <div className="ask__question">
              {multiQ && <span className="ask__q-num">{qi + 1}.</span>}
              {q.question}
            </div>
            <div className="ask__resolved">
              <CheckCircle2 size={13} />
              <span>{block.answers?.[qi] || t('chat.ask.noAnswer')}</span>
            </div>
          </div>
        ))
      ) : multiQ ? (
        // 多题未答：分步向导（上方进度圆点切换题目 + 单题 + 固定「提交」，全答后才可用）。
        <>
          <div className="ask__steps">
            {questions.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`ask__step-dot${i === step ? ' is-current' : ''}${
                  isDone(i) ? ' is-done' : ''
                }`}
                onClick={() => goStep(i)}
                aria-label={`${i + 1}`}
              >
                {isDone(i) && i !== step ? <Check size={12} /> : i + 1}
              </button>
            ))}
          </div>
          <div className="ask__q">
            <div className="ask__question">
              <span className="ask__q-num">{step + 1}.</span>
              {questions[step].question}
            </div>
            {renderBody(step)}
          </div>
          {/* 标准向导底部导航：左「上一步」固定；右侧非末题为「下一步」、末题变「提交」。 */}
          <div className="ask__actions ask__actions--nav">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => goStep(step - 1)}
              disabled={step === 0}
            >
              {t('chat.ask.prev')}
            </button>
            {step < last ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => goStep(step + 1)}
                disabled={!isDone(step)}
              >
                {questions[step].required === false && isBlank(step)
                  ? t('chat.ask.skip')
                  : t('chat.ask.next')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={submit}
                disabled={!allDone}
              >
                {t('chat.ask.submit')}
              </button>
            )}
          </div>
        </>
      ) : (
        // 单题未答：一次性展示（无步骤 / 无导航），与改造前一致。
        <>
          <div className="ask__q">
            <div className="ask__question">{questions[0].question}</div>
            {renderBody(0)}
          </div>
          <div className="ask__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={submit}
              disabled={!allDone}
            >
              {questions[0].required === false && isBlank(0)
                ? t('chat.ask.skip')
                : t('chat.ask.submit')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 子智能体折叠 Task 卡（仿 Claude Code）：默认收起、只显示结论徽标；展开后看任务描述与内部工具调用序列。
 * 子智能体的权限请求不在此卡内——照常作为顶层权限卡浮出确认（见 reduceBlocks）。
 */
function SubagentCard({
  block
}: {
  block: Extract<ChatBlock, { kind: 'subagent' }>
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const name = block.agent || t('chat.subagent.fallback')
  const count = block.children.length
  return (
    <div className={`subagent${open ? ' is-open' : ''}`}>
      <button type="button" className="subagent__head" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={13} className="subagent__caret" />
        <span className="subagent__head-icon">
          <Bot size={14} />
        </span>
        <span className="subagent__title">
          {t('chat.subagent.title')} · <strong>{name}</strong>
          {count > 0 && (
            <span className="subagent__count">
              {count} {t('chat.subagent.stepUnit')}
            </span>
          )}
        </span>
        <ToolBadge status={block.status} summary={block.summary} />
      </button>
      {open && (
        <div className="subagent__body">
          {block.task && (
            <div className="subagent__task">
              <span className="subagent__task-label">{t('chat.subagent.task')}</span>
              <span className="subagent__task-text">{block.task}</span>
            </div>
          )}
          {count === 0 ? (
            <div className="subagent__empty">{t('chat.subagent.noSteps')}</div>
          ) : (
            <div className="subagent__steps">
              {block.children.map((c) => {
                const meta = TOOL_META[c.name] ?? { icon: <Wrench size={13} />, key: 'chat.tool.unknown' }
                const hint = argHint(c.args)
                return (
                  <div key={c.id} className="subagent__step" title={hintTitle(hint)}>
                    <span className="subagent__step-icon">{meta.icon}</span>
                    <span className="subagent__step-title">
                      {t(meta.key)} {hint && <code>{hint.text}</code>}
                    </span>
                    <ToolBadge status={c.status} summary={c.summary} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 角色名片（propose_agent 提议）：微信名片式紧凑卡。
 * pending → 可点，点开预填的 PersonaEditor 供查看/微调/接受/拒绝；accepted/rejected 为终态、不可点。
 * 旧壳（ChatView）不传 onOpen → 名片始终只读展示（不影响旧壳）。
 */
function AgentCard({
  block,
  onOpen
}: {
  block: Extract<ChatBlock, { kind: 'agentcard' }>
  onOpen?: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { draft, status } = block
  const pending = status === 'pending'
  const clickable = pending && Boolean(onOpen)
  const name = draft.name || t('chat.agentcard.fallback')
  const hint =
    status === 'accepted'
      ? t('chat.agentcard.accepted')
      : status === 'rejected'
        ? t('chat.agentcard.rejected')
        : t('chat.agentcard.hint')
  return (
    <div
      className={`agentcard agentcard--${status}${clickable ? ' is-clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpen?.(block) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen?.(block)
              }
            }
          : undefined
      }
    >
      <span
        className="agentcard__avatar"
        style={{ '--p': draft.color } as React.CSSProperties}
      >
        {/* 提案中的智能体尚无 id：以名字为 seed 确定性生成头像（用户接受后可在编辑器改）。 */}
        <HumationFace seed={name} title={name} />
      </span>
      <span className="agentcard__body">
        <span className="agentcard__title">{t('chat.agentcard.title')}</span>
        <span className="agentcard__name">{name}</span>
        {draft.desc && <span className="agentcard__desc">{draft.desc}</span>}
      </span>
      <span
        className={`agentcard__hint${
          status === 'accepted' ? ' is-accepted' : status === 'rejected' ? ' is-rejected' : ''
        }`}
      >
        {status === 'accepted' && <Check size={13} />}
        {hint}
      </span>
    </div>
  )
}

function ToolBadge({ status, summary }: { status: ToolStatus; summary?: string }): React.JSX.Element {
  const { t } = useI18n()
  if (status === 'running')
    return (
      <span className="card__badge badge--pending">
        <Loader2 size={12} className="spin" /> {t('chat.status.running')}
      </span>
    )
  if (status === 'ok')
    return (
      <span className="card__badge badge--ok">
        <CheckCircle2 size={12} /> {summary || t('chat.status.done')}
      </span>
    )
  if (status === 'denied')
    return (
      <span className="card__badge badge--err">
        <XCircle size={12} /> {t('chat.status.denied')}
      </span>
    )
  return (
    <span className="card__badge badge--err">
      <XCircle size={12} /> {summary || t('chat.status.failed')}
    </span>
  )
}
