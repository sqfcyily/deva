import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Square,
  Paperclip,
  Sparkles,
  ChevronDown,
  FileText,
  FolderTree,
  FilePen,
  Replace,
  Search,
  FileSearch,
  Globe,
  Wrench,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Zap,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Image as ImageIcon,
  FileCode2,
  X
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import {
  useChat,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type PermMode,
  type StreamStatus,
  type ToolStatus
} from '../../store/chat'
import { useModels } from '../../store/models'

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
  edit_file: { icon: <Replace size={14} />, key: 'chat.tool.editFile' }
}

/** 权限模式元信息（图标 + i18n 键）；顺序即菜单顺序。 */
const PERM_MODES: { mode: PermMode; icon: React.ReactNode }[] = [
  { mode: 'ask', icon: <ShieldQuestion size={13} /> },
  { mode: 'acceptEdits', icon: <ShieldCheck size={13} /> },
  { mode: 'auto', icon: <Zap size={13} /> }
]

/** 工具卡上要展示的参数提示：优先 path，其次 pattern（grep/glob），再次 url（web_fetch）。 */
function argHint(args: unknown): string | null {
  if (args && typeof args === 'object') {
    const o = args as { path?: unknown; pattern?: unknown; url?: unknown }
    if (typeof o.path === 'string' && o.path.trim()) return o.path
    if (typeof o.pattern === 'string' && o.pattern.trim()) return o.pattern
    if (typeof o.url === 'string' && o.url.trim()) return o.url
  }
  return null
}

/** 底部指示器要表达的当前活动。 */
type Activity =
  | { kind: 'thinking' }
  | { kind: 'responding' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'permission' }

/**
 * 从最后一条助手消息的块序列推断"此刻在干什么"：
 * 未解决的权限卡 > 仍在运行的工具 > 末块有正文=生成回答 > 其余=思考中。
 */
function deriveActivity(messages: ChatMessage[]): Activity {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return { kind: 'thinking' }
  const blocks = last.blocks
  if (blocks.some((b) => b.kind === 'permission' && !b.resolved)) return { kind: 'permission' }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'tool' && b.status === 'running') return { kind: 'tool', toolName: b.name }
  }
  const tail = blocks[blocks.length - 1]
  if (tail?.kind === 'text' && tail.text.trim()) return { kind: 'responding' }
  return { kind: 'thinking' }
}

export function ChatView(): React.JSX.Element {
  const { t } = useI18n()
  const { messages, streaming, streamStatus, send, stop, respondPermission, permMode, setPermMode } =
    useChat()
  const { activeModel, providers, setActiveModel } = useModels()
  const [input, setInput] = useState('')
  const [pickOpen, setPickOpen] = useState(false)
  const [permOpen, setPermOpen] = useState(false)
  const [pending, setPending] = useState<Picked[]>([])

  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

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
    void send(
      text,
      atts.map((p) => ({ path: p.path, name: p.name, kind: p.kind as AttachKind }))
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // 可选模型：仅列启用的服务商下启用的模型
  const options = providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ p, m })))

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat__empty">
            <Sparkles size={30} />
            <div className="chat__empty-title">{t('chat.empty')}</div>
            <div className="chat__empty-hint">{t('chat.emptyHint')}</div>
          </div>
        ) : (
          <div className="chat__thread">
            {messages.map((m) => (
              <MessageRow key={m.id} msg={m} onPermission={respondPermission} />
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

            {/* 权限模式选择（按项目，即时持久化） */}
            <div className="perm-pick">
              <button
                className={`chip${permMode === 'auto' ? ' is-auto' : ''}`}
                type="button"
                title={t('chat.perm.menuTitle')}
                onClick={() => setPermOpen((v) => !v)}
              >
                {PERM_MODES.find((p) => p.mode === permMode)?.icon}
                {t(`chat.perm.mode.${permMode}`)}
                <ChevronDown size={13} />
              </button>
              {permOpen && (
                <>
                  <div className="model-pick__backdrop" onClick={() => setPermOpen(false)} />
                  <div className="perm-pick__menu">
                    <div className="perm-pick__title">{t('chat.perm.menuTitle')}</div>
                    {PERM_MODES.map(({ mode, icon }) => (
                      <button
                        key={mode}
                        className={`perm-pick__item${mode === permMode ? ' is-active' : ''}`}
                        onClick={() => {
                          setPermMode(mode)
                          setPermOpen(false)
                        }}
                      >
                        <span className="perm-pick__icon">{icon}</span>
                        <span className="perm-pick__text">
                          <span className="perm-pick__name">{t(`chat.perm.mode.${mode}`)}</span>
                          <span className="perm-pick__desc">{t(`chat.perm.mode.${mode}Desc`)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="composer__spacer" />

            {/* 模型选择 */}
            <div className="model-pick">
              <button className="chip" type="button" onClick={() => setPickOpen((v) => !v)}>
                {activeModel ? activeModel.model.name : t('chat.selectModel')}
                <ChevronDown size={13} />
              </button>
              {pickOpen && (
                <>
                  <div className="model-pick__backdrop" onClick={() => setPickOpen(false)} />
                  <div className="model-pick__menu">
                    {options.length === 0 && (
                      <div className="model-pick__empty">{t('chat.noModel')}</div>
                    )}
                    {options.map(({ p, m }) => {
                      const active = activeModel?.provider.id === p.id && activeModel?.model.id === m.id
                      return (
                        <button
                          key={`${p.id}:${m.id}`}
                          className={`model-pick__item${active ? ' is-active' : ''}`}
                          onClick={() => {
                            setActiveModel(p.id, m.id)
                            setPickOpen(false)
                          }}
                        >
                          <span className="model-pick__dot" style={{ background: p.accent }} />
                          <span className="model-pick__name">{m.name}</span>
                          <span className="model-pick__prov">{p.name}</span>
                        </button>
                      )
                    })}
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
function StatusIndicator({
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

  // 等待授权：引导用户去点上方卡片按钮。
  if (activity.kind === 'permission') {
    return (
      <div className="chat__status is-waiting" role="status" aria-live="polite">
        <ShieldAlert size={14} />
        <span>{t('chat.work.awaitingPermission')}</span>
      </div>
    )
  }

  const label =
    activity.kind === 'tool'
      ? `${t('chat.work.usingTool')} · ${t(TOOL_META[activity.toolName]?.key ?? 'chat.tool.unknown')}`
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

function MessageRow({
  msg,
  onPermission
}: {
  msg: ChatMessage
  onPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
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
          <BlockView key={i} block={b} onPermission={onPermission} />
        ))}
      </div>
    </div>
  )
}

function BlockView({
  block,
  onPermission
}: {
  block: ChatBlock
  onPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
}): React.JSX.Element | null {
  const { t } = useI18n()

  if (block.kind === 'text') {
    if (!block.text) return null
    return (
      <div className="msg__text">
        <p style={{ whiteSpace: 'pre-wrap' }}>{block.text}</p>
      </div>
    )
  }

  if (block.kind === 'thinking') {
    return (
      <div className="msg__think">
        <span className="msg__think-label">{t('chat.thinking')}</span>
        <span style={{ whiteSpace: 'pre-wrap' }}>{block.text}</span>
      </div>
    )
  }

  if (block.kind === 'tool') {
    const meta = TOOL_META[block.name] ?? { icon: <Wrench size={14} />, key: 'chat.tool.unknown' }
    const path = argHint(block.args)
    return (
      <div className="card">
        <div className="card__head">
          <span className="card__head-icon">{meta.icon}</span>
          <span className="card__title">
            {t(meta.key)} {path && <code>{path}</code>}
          </span>
          <ToolBadge status={block.status} summary={block.summary} />
        </div>
      </div>
    )
  }

  if (block.kind === 'permission') {
    const meta = TOOL_META[block.toolName] ?? { icon: <Wrench size={14} />, key: 'chat.tool.unknown' }
    const path = argHint(block.args)
    return (
      <div className="permission">
        <div className="permission__head">
          <span className="permission__head-icon">
            <ShieldAlert size={15} />
          </span>
          {t('chat.permission.title')}
        </div>
        <div className="permission__desc">
          {t(meta.key)}
          {path && (
            <>
              ：<code>{path}</code>
            </>
          )}
        </div>
        {block.resolved ? (
          <div className="permission__resolved">
            {block.resolved === 'allow' ? t('chat.permission.allow') : t('chat.permission.deny')}
          </div>
        ) : (
          <div className="permission__actions">
            <button
              className="btn btn--primary btn--sm"
              onClick={() => onPermission(block.key, 'allow', false)}
            >
              {t('chat.permission.allow')}
            </button>
            <button className="btn btn--sm" onClick={() => onPermission(block.key, 'allow', true)}>
              {t('chat.permission.allowAlways')}
            </button>
            <button className="btn btn--sm" onClick={() => onPermission(block.key, 'deny', false)}>
              {t('chat.permission.deny')}
            </button>
          </div>
        )}
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
