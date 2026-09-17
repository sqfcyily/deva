import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Cog,
  FileText,
  FileCode2,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  MessageCircle,
  Paperclip,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Users,
  Zap
} from 'lucide-react'
import './redesign.css'
import type { Persona } from '../mock/extensions'
import type { PersonaUpsertInput } from '../../../preload'
import {
  useChat,
  type AgentDraft,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type PermMode,
  type SendAttachment,
  type SessionMeta
} from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useModels } from '../store/models'
import { useWorkspace } from '../store/workspace'
import { useI18n } from '../i18n/i18n'
import { useTheme } from '../theme/ThemeContext'
import { BlockView, StatusIndicator, deriveActivity } from '../features/chat/ChatView'
import { ModelSettings } from '../features/settings/ModelSettings'

/**
 * 「对话优先」外壳（已接真实 store）。
 *
 * 形态（借鉴 IM 应用的单人对话）：
 *  - 左栏两个 tab：消息（对话列表，来自 useChat().sessions）/ 角色（花名册，来自 useExtensions().personas）
 *  - 一对话一身份：中列是「我 ↔ 某一个角色」的单人对话，头顶显示当值角色（persona 单选、首发绑定后不可改）
 *  - 角色可查看资料、可反复发起对话；「添加/编辑角色」走 PersonaEditor（round-trip upsertPersona）
 *  - 工作区可选：头部一个 chip，挂了文件夹就「聚焦中」（focusRoot），没挂就是全机通用助手
 *  - 动手全内联：复用 ChatView 的 BlockView / StatusIndicator / deriveActivity 渲染工具/权限/思考/子智能体
 *
 * 安全不变式全程不动：persona 工具白名单只收窄可见性、每次调用仍过同一闸门；聚焦挂载复用 fs.openFolder 的
 * trustRoot；~/.deva 等 Tier-1 永不可写。旧壳（PREVIEW_CHAT_FIRST=false）零回归靠后端 personaId 缺省 gate。
 */

/* ============================ 小工具 ============================ */

/** 附件类型 → 图标（ChatView 内 iconFor 未导出，此处内联同款）。 */
function iconFor(kind: AttachKind): React.ReactNode {
  if (kind === 'image') return <ImageIcon size={13} />
  if (kind === 'document') return <FileText size={13} />
  if (kind === 'text') return <FileCode2 size={13} />
  return <Paperclip size={13} />
}

/** 路径末段（跨平台）。 */
function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/** 距底 ≤ 此像素即视为「贴住底部」，留缓冲避免临界抖动（与 ChatView 同值）。 */
const BOTTOM_THRESHOLD = 64

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

/** 相对时间（本地化，词与数字空格拼接，不用插值——t 只收 key）。 */
function useRelativeTime(): (ts: number) => string {
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

/** 权限模式选项（复用 ChatView 同款：逐次询问 / 接受编辑 / 全自动，图标一致）。 */
const PERM_MODES: Array<{ mode: PermMode; icon: React.ReactNode }> = [
  { mode: 'ask', icon: <ShieldQuestion size={13} /> },
  { mode: 'acceptEdits', icon: <ShieldCheck size={13} /> },
  { mode: 'auto', icon: <Zap size={13} /> }
]

/**
 * 角色编辑器打开态：新建 / 编辑（带原对象）/ 确认名片（propose：预填 LLM 草稿，接受才落盘）。
 * propose 态的 draft 取自不可变的名片块 → 关闭重开即回到 LLM 原始草稿（丢弃改动，兼作「重置」）。
 */
type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; persona: Persona }
  | { mode: 'propose'; draft: AgentDraft; toolId: string }

/* ============================ 顶层外壳 ============================ */
export function ChatFirstShell(): React.JSX.Element {
  const {
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamStatus,
    sessionStates,
    send,
    stop,
    newSession,
    selectSession,
    currentBinding,
    mountFocus,
    respondPermission,
    respondAsk,
    permMode,
    setPermMode
  } = useChat()
  const { personas } = useExtensions()
  const { t } = useI18n()

  const [railTab, setRailTab] = useState<'chats' | 'roster'>('chats')
  /** 非空时中列显示该角色资料卡；为空时显示当前对话。 */
  const [viewPersonaId, setViewPersonaId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 非空时打开角色编辑器（Part G）。 */
  const [editor, setEditor] = useState<EditorState | null>(null)

  /** 兜底身份：优先 general，其次首个（花名册非空时）。 */
  const defaultPersona = useMemo(
    () => personas.find((p) => p.id === 'general') ?? personas[0],
    [personas]
  )
  const defaultPersonaId = defaultPersona?.id

  // 自动绑定「通用」：当有兜底身份、当前对话未绑定、且是空对话时，落一条绑定到默认身份的空会话。
  // 循环安全：newSession 写入覆盖层后 currentBinding.personaId 置位 → 下次 guard 失败，不再触发。
  // 同时**快照**该身份当时的偏好模型（空串=跟随全局默认）：日后改该身份偏好不影响本对话（快照固定）。
  useEffect(() => {
    if (defaultPersonaId && !currentBinding.personaId && messages.length === 0) {
      newSession(defaultPersonaId, undefined, defaultPersona?.model)
    }
  }, [defaultPersonaId, defaultPersona?.model, currentBinding.personaId, messages.length, newSession])

  /** 当值身份（当前对话绑定的 persona）。 */
  const owner = personas.find((p) => p.id === currentBinding.personaId)

  const openThread = (id: string): void => {
    selectSession(id)
    setViewPersonaId(null)
    setRailTab('chats')
  }
  const openProfile = (personaId: string): void => setViewPersonaId(personaId)
  /** 点角色名片 → 打开预填的编辑器（propose 态，接受才落盘）。 */
  const openProposal = (block: Extract<ChatBlock, { kind: 'agentcard' }>): void =>
    setEditor({ mode: 'propose', draft: block.draft, toolId: block.id })
  /** 与某身份发起新对话：新建空会话（首发落绑定，并快照该身份当时的偏好模型）→ 回到消息视图。 */
  const startWith = (personaId: string): void => {
    newSession(personaId, undefined, personas.find((p) => p.id === personaId)?.model)
    setViewPersonaId(null)
    setRailTab('chats')
  }
  /**
   * 「通过对话添加角色」：新建一个绑定兜底身份（通常「通用」）的空对话，自动发一句引导语，
   * 让 Agent 立即开始一步步引导用户澄清需求、最后调 propose_agent 铸名片供确认（不写盘，接受才落盘）。
   * newSession 同步置位 sessionIdRef，故随后的 send 必打到这条新会话。
   */
  const addPersonaByChat = (): void => {
    newSession(defaultPersonaId, undefined, defaultPersona?.model)
    setViewPersonaId(null)
    setRailTab('chats')
    void send(t('cf.addByChatPrompt'))
  }
  const viewPersona = viewPersonaId ? personas.find((p) => p.id === viewPersonaId) : undefined

  return (
    <div className="cf-shell">
      {/* 无独立标题栏（微信式）：最小化/最大化/关闭用系统原生窗口控件叠加（titleBarOverlay），
          此处不再自绘按钮，避免与原生按钮重影。拖拽交给图标栏与对话头。 */}
      <div className="cf-body">
        <IconRail
          tab={railTab}
          onTab={setRailTab}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <Rail
          tab={railTab}
          sessions={sessions}
          personas={personas}
          currentSessionId={currentSessionId}
          sessionStates={sessionStates}
          viewPersonaId={viewPersonaId}
          onOpenThread={openThread}
          onOpenProfile={openProfile}
          onAddPersona={() => setEditor({ mode: 'create' })}
          onAddPersonaByChat={addPersonaByChat}
        />
        {viewPersona ? (
          <ProfileView
            persona={viewPersona}
            sessions={sessions}
            onOpenThread={openThread}
            onStart={() => startWith(viewPersona.id)}
            onEdit={() => setEditor({ mode: 'edit', persona: viewPersona })}
          />
        ) : (
          <Conversation
            owner={owner}
            currentSessionId={currentSessionId}
            messages={messages}
            streaming={streaming}
            streamStatus={streamStatus}
            focusRoot={currentBinding.focusRoot}
            permMode={permMode}
            onOpenProfile={openProfile}
            onSend={send}
            onStop={stop}
            onMount={mountFocus}
            onPermission={respondPermission}
            onAsk={respondAsk}
            onPermMode={setPermMode}
            onOpenProposal={openProposal}
          />
        )}
      </div>

      {editor && <PersonaEditor initial={editor} onClose={() => setEditor(null)} />}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/* ============================ 最左：图标导航栏（微信式） ============================ */
/**
 * 窄图标栏：顶部当前用户头像，中部「对话 / 角色」切换（点击切左栏列表列），底部设置入口。
 * 把原先挤在列表列顶部的文字 tab 与底部的用户/设置脚移到这里，列表列因而只承载列表本身。
 */
function IconRail({
  tab,
  onTab,
  onOpenSettings
}: {
  tab: 'chats' | 'roster'
  onTab: (t: 'chats' | 'roster') => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <nav className="cf-iconrail">
      <div className="cf-iconrail__me" title={`${t('cf.localUser')} · ~/.deva`}>
        <Avatar user size={34} />
      </div>
      <button
        className={`cf-navbtn${tab === 'chats' ? ' is-active' : ''}`}
        title={t('cf.tabChats')}
        aria-label={t('cf.tabChats')}
        aria-current={tab === 'chats'}
        onClick={() => onTab('chats')}
      >
        <MessageCircle size={20} />
      </button>
      <button
        className={`cf-navbtn${tab === 'roster' ? ' is-active' : ''}`}
        title={t('cf.tabRoster')}
        aria-label={t('cf.tabRoster')}
        aria-current={tab === 'roster'}
        onClick={() => onTab('roster')}
      >
        <Users size={20} />
      </button>
      <div className="cf-spacer" />
      <button
        className="cf-navbtn"
        title={t('cf.settings')}
        aria-label={t('cf.settings')}
        onClick={onOpenSettings}
      >
        <Cog size={20} />
      </button>
    </nav>
  )
}

/* ============================ 左栏：列表列（对话 / 角色） ============================ */
function Rail({
  tab,
  sessions,
  personas,
  currentSessionId,
  sessionStates,
  viewPersonaId,
  onOpenThread,
  onOpenProfile,
  onAddPersona,
  onAddPersonaByChat
}: {
  tab: 'chats' | 'roster'
  sessions: SessionMeta[]
  personas: Persona[]
  currentSessionId: string
  sessionStates: Record<string, { streaming: boolean; attention: boolean }>
  viewPersonaId: string | null
  onOpenThread: (id: string) => void
  onOpenProfile: (id: string) => void
  onAddPersona: () => void
  onAddPersonaByChat: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 消息列表按最近更新降序。
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )
  return (
    <aside className="cf-rail">
      {/* 顶部：搜索占满整行；角色 tab 额外并排一个「添加角色」入口（悬停/点击出二选一弹层）。 */}
      <div className="cf-rail__top">
        <div className="cf-search">🔎 {t('cf.search')}</div>
        {tab === 'roster' && (
          <AddPersonaMenu onManual={onAddPersona} onByChat={onAddPersonaByChat} />
        )}
      </div>

      <div className="cf-list">
        {tab === 'chats' ? (
          ordered.length === 0 ? (
            <div className="cf-empty">{t('chat.noSessions')}</div>
          ) : (
            ordered.map((s) => (
              <ThreadRow
                key={s.id}
                session={s}
                owner={personas.find((p) => p.id === s.personaId)}
                state={sessionStates[s.id]}
                active={viewPersonaId === null && s.id === currentSessionId}
                onClick={() => onOpenThread(s.id)}
              />
            ))
          )
        ) : personas.length === 0 ? (
          <div className="cf-empty">{t('cf.noPersona')}</div>
        ) : (
          personas.map((p) => (
            <PersonaRow
              key={p.id}
              persona={p}
              active={viewPersonaId === p.id}
              onClick={() => onOpenProfile(p.id)}
            />
          ))
        )}
      </div>
    </aside>
  )
}

/**
 * 「添加角色」入口：一个 + 图标，鼠标悬停或点击弹出二选一浮层——手动添加（打开编辑器表单）/
 * 通过对话添加（新建对话、Agent 引导创建）。离开略延迟收起以容忍按钮→浮层途中的空档，选中即收起并执行。
 */
function AddPersonaMenu({
  onManual,
  onByChat
}: {
  onManual: () => void
  onByChat: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  // 离开时略延迟收起，避免从 + 按钮移到浮层项途中的短暂空档导致闪烁。
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }
  useEffect(() => cancelClose, [])

  const choose = (fn: () => void): void => {
    cancelClose()
    setOpen(false)
    fn()
  }

  return (
    <div
      className="cf-addmenu"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        className="cf-rail__addbtn"
        title={t('cf.addPersona')}
        aria-label={t('cf.addPersona')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="cf-addmenu__pop" role="menu">
          <button className="cf-addmenu__item" role="menuitem" onClick={() => choose(onManual)}>
            <Pencil size={15} className="cf-addmenu__icon" />
            <span>{t('cf.addManual')}</span>
          </button>
          <button className="cf-addmenu__item" role="menuitem" onClick={() => choose(onByChat)}>
            <MessageCircle size={15} className="cf-addmenu__icon" />
            <span>{t('cf.addByChat')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

function ThreadRow({
  session,
  owner,
  state,
  active,
  onClick
}: {
  session: SessionMeta
  owner?: Persona
  state?: { streaming: boolean; attention: boolean }
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const rel = useRelativeTime()
  const alert = Boolean(state?.attention || state?.streaming)
  return (
    <button className={`cf-thread${active ? ' is-active' : ''}`} onClick={onClick}>
      <Avatar persona={owner} size={38} />
      <div className="cf-thread__main">
        {/* 上：角色名（＋活动圆点）与时间；下：首次对话标题。挂载目录不在此展示。 */}
        <div className="cf-thread__top">
          <span className="cf-thread__owner">
            {alert && <span className="cf-thread__dot" />}
            {owner?.name ?? ''}
          </span>
          <span className="cf-thread__time">{rel(session.updatedAt)}</span>
        </div>
        <div className="cf-thread__title">{session.title || t('chat.untitled')}</div>
      </div>
    </button>
  )
}

function PersonaRow({
  persona,
  active,
  onClick
}: {
  persona: Persona
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button className={`cf-prow${active ? ' is-active' : ''}`} onClick={onClick}>
      <Avatar persona={persona} size={38} />
      <div className="cf-prow__main">
        {/* 花名册只展示角色名与专长；专长未填写则整行不显示。 */}
        <div className="cf-prow__name" style={{ '--p': persona.color } as React.CSSProperties}>
          {persona.name}
        </div>
        {persona.desc && <div className="cf-prow__spec">{persona.desc}</div>}
      </div>
    </button>
  )
}

/* ============================ 中列：单人对话 ============================ */
function Conversation({
  owner,
  currentSessionId,
  messages,
  streaming,
  streamStatus,
  focusRoot,
  permMode,
  onOpenProfile,
  onSend,
  onStop,
  onMount,
  onPermission,
  onAsk,
  onPermMode,
  onOpenProposal
}: {
  owner?: Persona
  currentSessionId: string
  messages: ChatMessage[]
  streaming: boolean
  streamStatus: { elapsedSec: number; reconnecting: { attempt: number; max: number } | null }
  focusRoot: string | null
  permMode: PermMode
  onOpenProfile: (id: string) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<void>
  onStop: () => void
  onMount: (path: string | null) => void
  onPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
  onAsk: (key: string, answers: string[]) => void
  onPermMode: (mode: PermMode) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)

  // 是否「贴住底部」：决定流式新内容是否自动跟随。用户上滚离开底部即脱离跟随，回到底部（或点「回到最新」）
  // 恢复跟随。ref 供滚动副作用同步读取（避免闭包过期、其变化不触发副作用重跑），state 仅驱动浮标显隐。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // 新内容到达：仅当仍贴底才自动滚到底；用户上滚查看历史时保持不动。
  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  // 切换会话（Conversation 不按会话重挂载）：复位贴底并直接滚到底。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [currentSessionId])

  // 监听用户滚动：据距底距离更新「是否贴底」。程序化滚到底同样触发，结果仍为贴底、幂等。
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

  // 发送后必看到自己的消息与回复：无论此刻是否上滚，都恢复贴底跟随。
  const handleSend = (text: string, attachments?: SendAttachment[]): Promise<void> => {
    stickRef.current = true
    setAtBottom(true)
    return onSend(text, attachments)
  }

  return (
    <main className="cf-conv">
      <div className="cf-conv__head">
        <button
          className="cf-idbtn"
          onClick={() => owner && onOpenProfile(owner.id)}
          title={t('cf.viewProfile')}
        >
          {/* 顶部只显示角色名称（去掉头像与描述行）；仍可点击打开资料卡。 */}
          <div
            className="cf-idbtn__name"
            style={owner ? ({ '--p': owner.color } as React.CSSProperties) : undefined}
          >
            {owner?.name ?? ''}
          </div>
        </button>
      </div>

      <div className="cf-msgs" ref={scrollRef} onScroll={onScroll}>
        <div className="cf-msgs__inner">
          {messages.length === 0 ? (
            <div className="cf-empty">
              {owner ? (owner.desc ? `${owner.name} · ${owner.desc}` : owner.name) : ''}
            </div>
          ) : (
            <>
              {messages.map((m, i) => (
                <ConvMessage
                  key={m.id}
                  msg={m}
                  owner={owner}
                  active={streaming && i === messages.length - 1}
                  onPermission={onPermission}
                  onAsk={onAsk}
                  onOpenProposal={onOpenProposal}
                />
              ))}
              {streaming && (
                <StatusIndicator
                  activity={deriveActivity(messages)}
                  status={streamStatus}
                  onStop={onStop}
                />
              )}
            </>
          )}
        </div>
      </div>

      <Composer
        owner={owner}
        streaming={streaming}
        permMode={permMode}
        focusRoot={focusRoot}
        onMount={onMount}
        onSend={handleSend}
        onStop={onStop}
        onPermMode={onPermMode}
        showJump={!atBottom && messages.length > 0}
        onJump={jumpToLatest}
      />
    </main>
  )
}

/** 单条消息：IM 头像外壳 + 复用 ChatView 的 BlockView（安全渲染器不重写）。 */
function ConvMessage({
  msg,
  owner,
  active,
  onPermission,
  onAsk,
  onOpenProposal
}: {
  msg: ChatMessage
  owner?: Persona
  active: boolean
  onPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
  onAsk: (key: string, answers: string[]) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (msg.role === 'user') {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user">
        <div className="cf-msg__body">
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
          {text && <div className="cf-msg__text">{text}</div>}
        </div>
        <Avatar user size={32} />
      </div>
    )
  }
  return (
    <div className="cf-msg">
      <Avatar persona={owner} size={32} />
      <div className="cf-msg__body">
        <div className="cf-msg__head">
          <span
            className="cf-msg__name"
            style={owner ? ({ '--p': owner.color } as React.CSSProperties) : undefined}
          >
            {owner?.name ?? t('cf.assistant')}
          </span>
        </div>
        <div className="msg__content">
          {msg.blocks.map((b, i) => (
            <BlockView
              key={i}
              block={b}
              thinkingDone={!(active && i === msg.blocks.length - 1)}
              onPermission={onPermission}
              onAsk={onAsk}
              onOpenProposal={onOpenProposal}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Composer({
  owner,
  streaming,
  permMode,
  focusRoot,
  onMount,
  onSend,
  onStop,
  onPermMode,
  showJump,
  onJump
}: {
  owner?: Persona
  streaming: boolean
  permMode: PermMode
  focusRoot: string | null
  onMount: (path: string | null) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<void>
  onStop: () => void
  onPermMode: (mode: PermMode) => void
  showJump: boolean
  onJump: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<Picked[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  const name = owner?.name ?? t('cf.assistant')
  const placeholder = locale === 'en' ? `Message ${name}…` : `跟 ${name} 说点什么…`
  const supported = pending.filter((p) => p.supported)
  const canSend = Boolean(input.trim()) || supported.length > 0
  const mounted = Boolean(focusRoot)

  // 挂载 / 卸载工作区（放在输入区工具条，取代原顶部头部的入口）。
  const onWschip = (): void => {
    if (mounted) {
      onMount(null)
      return
    }
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onMount(r.path)
    })()
  }

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
    void onSend(
      text,
      atts.map((p) => ({ path: p.path, name: p.name, kind: p.kind as AttachKind }))
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    if (e.shiftKey || e.ctrlKey || e.altKey) return // 交给默认换行
    e.preventDefault()
    submit()
  }

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  return (
    <div className="cf-composer">
      {/* 回到最新：仅当用户上滚离开底部且已有消息时浮现，锚在输入区正上方居中 */}
      {showJump && (
        <button
          className="cf-jump"
          type="button"
          onClick={onJump}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
        >
          <ChevronDown size={18} />
        </button>
      )}
      <div className="cf-composer__inner">
        <div className="cf-box">
          {pending.length > 0 && (
            <div className="cf-composer__files">
              {pending.map((p) => (
                <span
                  key={p.path}
                  className={`attach-chip${p.supported ? '' : ' is-bad'}`}
                  title={p.reason || p.name}
                >
                  {iconFor((p.supported ? p.kind : 'text') as AttachKind)}
                  <span className="attach-chip__name">{p.name}</span>
                  <button
                    className="attach-chip__x"
                    onClick={() => removePending(p.path)}
                    title={t('cf.cancel')}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            value={input}
            placeholder={placeholder}
            onChange={autoGrow}
            onKeyDown={onKeyDown}
          />
          <div className="cf-box__bar">
            <button className="cf-iconbtn" title={t('cf.attach')} onClick={() => void pickFiles()}>
              📎
            </button>
            <button
              className={`cf-wschip${mounted ? ' is-on' : ''}`}
              title={mounted ? t('cf.unmountHint') : t('cf.mountHint')}
              onClick={onWschip}
            >
              {mounted && focusRoot ? (
                <>
                  <FolderOpen size={15} />
                  {`${basename(focusRoot)} · ${t('cf.focusing')}`}
                </>
              ) : (
                <>
                  <FolderPlus size={15} />
                  {t('cf.mountWorkspace')}
                </>
              )}
            </button>
            <PermPicker permMode={permMode} onPermMode={onPermMode} />
            <ModelPicker />
            {/* 流式输出时发送键变「停止」（点击中断本会话当前回合）：只放图标，按钮宽度不变、两态不跳动。 */}
            {streaming ? (
              <button
                className="cf-send is-stop"
                type="button"
                title={t('chat.stop')}
                aria-label={t('chat.stop')}
                onClick={onStop}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="cf-send" type="button" disabled={!canSend} onClick={submit}>
                {t('cf.send')}
              </button>
            )}
          </div>
        </div>
        <div className="cf-hint">
          <kbd>Enter</kbd> {t('cf.send')} · <kbd>Shift+Enter</kbd> {t('cf.newline')}
        </div>
      </div>
    </div>
  )
}

/**
 * 权限模式选择器（按项目/按当前受信根即时持久化）。复用 ChatView 同款 app.css 类
 * （perm-pick / chip / model-pick__backdrop / perm-pick__menu），零新增 CSS、视觉与旧壳一致。
 * 菜单向上弹出（.perm-pick__menu 的 bottom:calc(100%+8px)），锚在输入区工具条恰好在屏内。
 */
function PermPicker({
  permMode,
  onPermMode
}: {
  permMode: PermMode
  onPermMode: (mode: PermMode) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="perm-pick">
      <button
        className={`chip${permMode === 'auto' ? ' is-auto' : ''}${open ? ' is-open' : ''}`}
        type="button"
        title={t('chat.perm.menuTitle')}
        onClick={() => setOpen((v) => !v)}
      >
        {PERM_MODES.find((p) => p.mode === permMode)?.icon}
        <span className="chip__label">{t(`chat.perm.mode.${permMode}`)}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="perm-pick__menu" role="menu">
            <div className="perm-pick__title">{t('chat.perm.menuTitle')}</div>
            {PERM_MODES.map(({ mode, icon }) => (
              <button
                key={mode}
                role="menuitemradio"
                aria-checked={mode === permMode}
                className={`perm-pick__item${mode === permMode ? ' is-active' : ''}`}
                onClick={() => {
                  onPermMode(mode)
                  setOpen(false)
                }}
              >
                <span className="perm-pick__icon">{icon}</span>
                <span className="perm-pick__text">
                  <span className="perm-pick__name">{t(`chat.perm.mode.${mode}`)}</span>
                  <span className="perm-pick__desc">{t(`chat.perm.mode.${mode}Desc`)}</span>
                </span>
                {mode === permMode && <Check size={15} className="perm-pick__check" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 模型选择器（**只改当前对话**的模型，不动全局默认）。复用 ChatView 同款 app.css 类
 * （model-pick / chip / model-pick__backdrop / model-pick__menu），零新增 CSS，视觉与旧壳一致。
 * 只列「已启用服务商 × 已启用模型」，按服务商分组；切换即写当前对话覆盖层（setSessionModel），下一条消息
 * 随 modelRef 落库到会话属性，故同角色的多个对话可各用不同模型。
 * 显示的是**本对话生效模型**：本对话已选则显示所选；未选（跟随默认）/所选模型已被删除 → 回落全局默认
 * activeModel 显示（与主进程 resolveModelRef 的兜底一致，删除的偏好模型自动回归默认）。
 * 菜单向上弹出（.model-pick__menu 的 bottom:calc(100%+8px)），锚在输入区工具条恰在屏内。
 */
function ModelPicker(): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel, providers } = useModels()
  const { currentBinding, setSessionModel } = useChat()
  const [open, setOpen] = useState(false)
  const groups = providers
    .filter((p) => p.enabled)
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0)
  // 本对话生效模型：解析对话覆盖层的 model 引用 `"pid:mid"`；空/非法/已删除 → 回落全局 activeModel。
  const selected = useMemo(() => {
    const ref = currentBinding.model
    if (ref) {
      const idx = ref.indexOf(':')
      if (idx > 0) {
        const pid = ref.slice(0, idx)
        const mid = ref.slice(idx + 1)
        const p = providers.find((x) => x.id === pid)
        const m = p?.models.find((x) => x.id === mid)
        if (p && m) return { pid, mid, name: m.name, accent: p.accent }
      }
    }
    if (activeModel)
      return {
        pid: activeModel.provider.id,
        mid: activeModel.model.id,
        name: activeModel.model.name,
        accent: activeModel.provider.accent
      }
    return null
  }, [currentBinding.model, providers, activeModel])
  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={t('chat.selectModel')}
        onClick={() => setOpen((v) => !v)}
      >
        {selected && <span className="chip__dot" style={{ background: selected.accent }} />}
        <span className="chip__label">{selected ? selected.name : t('chat.selectModel')}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            {groups.length === 0 && <div className="model-pick__empty">{t('chat.noModel')}</div>}
            {groups.map(({ p, models }) => (
              <div key={p.id} className="model-pick__group">
                <div className="model-pick__group-head">
                  <span className="model-pick__dot" style={{ background: p.accent }} />
                  <span className="model-pick__group-name">{p.name}</span>
                </div>
                {models.map((m) => {
                  const active = selected?.pid === p.id && selected?.mid === m.id
                  return (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={active}
                      className={`model-pick__item${active ? ' is-active' : ''}`}
                      title={m.name}
                      onClick={() => {
                        setSessionModel(`${p.id}:${m.id}`)
                        setOpen(false)
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
  )
}

/* ============================ 中列：角色资料卡 ============================ */
function ProfileView({
  persona,
  sessions,
  onOpenThread,
  onStart,
  onEdit
}: {
  persona: Persona
  sessions: SessionMeta[]
  onOpenThread: (id: string) => void
  onStart: () => void
  onEdit: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { providers } = useModels()
  const rel = useRelativeTime()
  const convs = useMemo(
    () =>
      sessions
        .filter((s) => s.personaId === persona.id)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, persona.id]
  )
  // 偏好模型显示完整名称（服务商 · 模型），而非存储的 "pid:mid" 引用；空=跟随默认，
  // 引用已删除时兜底显示原始串（与编辑器下拉的标签格式保持一致）。
  const prefModelLabel = useMemo(() => {
    const ref = persona.model
    if (!ref) return t('cf.defaultModel')
    const idx = ref.indexOf(':')
    if (idx > 0) {
      const p = providers.find((x) => x.id === ref.slice(0, idx))
      const m = p?.models.find((x) => x.id === ref.slice(idx + 1))
      if (p && m) return `${p.name} · ${m.name}`
    }
    return ref
  }, [persona.model, providers, t])
  const convsLabel =
    locale === 'en' ? `Conversations with ${persona.name}` : `与 ${persona.name} 的对话`
  const noConvs =
    locale === 'en' ? `No conversations with ${persona.name} yet` : `还没有和 ${persona.name} 的对话`

  return (
    <main className="cf-conv">
      <div className="cf-profile">
        <div className="cf-profile__ava" style={{ '--p': persona.color } as React.CSSProperties}>
          {persona.emoji}
        </div>
        <div className="cf-profile__name" style={{ '--p': persona.color } as React.CSSProperties}>
          {persona.name}
        </div>
        <div className="cf-profile__spec">{persona.desc}</div>

        <div className="cf-profile__meta">
          <div className="cf-profile__row">
            <span className="cf-profile__k">{t('cf.prefModel')}</span>
            <span className="cf-profile__v">{prefModelLabel}</span>
          </div>
        </div>

        <div className="cf-profile__actions">
          <button className="cf-profile__new" onClick={onStart}>
            ＋ {t('cf.startChat')}
          </button>
          <button className="cf-profile__edit" onClick={onEdit}>
            {t('cf.editPersona')}
          </button>
        </div>

        <div className="cf-profile__convs">
          <div className="cf-profile__convs-label">{convsLabel}</div>
          {convs.length === 0 ? (
            <div className="cf-empty">{noConvs}</div>
          ) : (
            convs.map((s) => (
              <button key={s.id} className="cf-convrow" onClick={() => onOpenThread(s.id)}>
                <span className="cf-convrow__title">{s.title || t('chat.untitled')}</span>
                {s.focusRoot && (
                  <span className="cf-convrow__proj">📁 {basename(s.focusRoot)}</span>
                )}
                <span className="cf-convrow__time">{rel(s.updatedAt)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </main>
  )
}

/* ============================ 角色编辑器（Part G） ============================ */
function PersonaEditor({
  initial,
  onClose
}: {
  initial: EditorState
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { providers } = useModels()
  const { upsertPersona } = useExtensions()
  const { resolveProposal } = useChat()
  const editing = initial.mode === 'edit' ? initial.persona : null
  // propose 态：预填 LLM 草稿，接受才落盘、拒绝不写；editing 恒 null → upsert 无 id → 只创建不覆盖。
  const proposing = initial.mode === 'propose' ? initial : null
  const draft = proposing?.draft

  const [name, setName] = useState(editing?.name ?? draft?.name ?? '')
  const [emoji, setEmoji] = useState(editing?.emoji ?? draft?.emoji ?? '🤖')
  const [color, setColor] = useState(editing?.color ?? draft?.color ?? '#7c7cf0')
  const [desc, setDesc] = useState(editing?.desc ?? draft?.desc ?? '')
  const [model, setModel] = useState(editing?.model ?? draft?.model ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? draft?.prompt ?? '')
  const [saving, setSaving] = useState(false)

  // 模型下拉：所有服务商 × 其模型 → "providerId:modelId"；空 = 跟随默认。
  const modelOptions = useMemo(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({ value: `${p.id}:${m.id}`, label: `${p.name} · ${m.name}` }))
      ),
    [providers]
  )

  // 保存（create/edit）/ 接受（propose）：同一条渲染层 upsertPersona（用户点击即授权，零提权）。
  // propose 态额外落定名片终态为 accepted（重开不退回 pending、不重复建角色）。
  const save = (): void => {
    if (!name.trim() || saving) return
    setSaving(true)
    void (async () => {
      // tools 不再下发：角色不限制工具，全部工具按需可用（缺省即全内置）。
      const input: PersonaUpsertInput = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        description: desc.trim(),
        emoji: emoji.trim() || '🤖',
        color,
        model,
        prompt,
        enabled: true
      }
      const saved = await upsertPersona(input)
      setSaving(false)
      if (saved) {
        if (proposing) resolveProposal(proposing.toolId, 'accepted')
        onClose()
      }
    })()
  }

  // 拒绝（仅 propose 态）：不写任何东西，只把名片终态落为 rejected 并关闭。
  const reject = (): void => {
    if (!proposing) return
    resolveProposal(proposing.toolId, 'rejected')
    onClose()
  }

  return (
    <div className="cf-modal__backdrop" onClick={onClose}>
      <div
        className="cf-modal is-editor"
        role="dialog"
        aria-label={
          proposing
            ? t('cf.editorProposeTitle')
            : editing
              ? t('cf.editorEditTitle')
              : t('cf.editorNewTitle')
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">
            {proposing
              ? t('cf.editorProposeTitle')
              : editing
                ? t('cf.editorEditTitle')
                : t('cf.editorNewTitle')}
          </span>
          {/* ✕/背景 = 关闭（propose 态下丢弃改动、保持 pending、可再开）；不 resolve、不写。 */}
          <button
            className="cf-modal__close"
            title={proposing ? t('cf.close') : t('cf.cancel')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="cf-editor">
          <div className="cf-field">
            <label className="cf-field__label">{t('cf.fName')}</label>
            <input className="cf-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="cf-field cf-field--row">
            <div className="cf-field">
              <label className="cf-field__label">{t('cf.fEmoji')}</label>
              <input
                className="cf-input cf-input--emoji"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
              />
            </div>
            <div className="cf-field">
              <label className="cf-field__label">{t('cf.fColor')}</label>
              <input
                className="cf-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
          </div>

          <div className="cf-field">
            <label className="cf-field__label">{t('cf.fSpecialty')}</label>
            <input className="cf-input" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>

          <div className="cf-field">
            <label className="cf-field__label">{t('cf.fModel')}</label>
            <select
              className="cf-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{t('cf.defaultModel')}</option>
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="cf-field">
            <label className="cf-field__label">{t('cf.fPrompt')}</label>
            <textarea
              className="cf-textarea"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
            />
          </div>

          <div className="cf-editor__actions">
            {/* propose：左=拒绝（不写+标记 rejected），右=接受（upsert+标记 accepted）；否则 取消/保存。 */}
            <button className="cf-btn" onClick={proposing ? reject : onClose}>
              {proposing ? t('cf.reject') : t('cf.cancel')}
            </button>
            <button className="cf-btn is-primary" disabled={!name.trim() || saving} onClick={save}>
              {proposing ? t('cf.accept') : t('cf.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================ 系统设置（Part H） ============================ */
type SettingsSection = 'general' | 'models' | 'extensions' | 'about'

function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>('general')
  const nav: Array<{ id: SettingsSection; icon: string; label: string }> = [
    { id: 'general', icon: '⚙️', label: t('settings.general') },
    { id: 'models', icon: '🧠', label: t('settings.models') },
    { id: 'extensions', icon: '🧩', label: t('activity.extensions') },
    { id: 'about', icon: 'ℹ️', label: t('settings.about') }
  ]
  return (
    <div className="cf-modal__backdrop" onClick={onClose}>
      <div
        className="cf-modal"
        role="dialog"
        aria-label={t('cf.settings')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">{t('cf.settings')}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cf-modal__body">
          <nav className="cf-nav">
            {nav.map((n) => (
              <button
                key={n.id}
                className={`cf-nav__item${section === n.id ? ' is-active' : ''}`}
                onClick={() => setSection(n.id)}
              >
                <span className="cf-nav__icon">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
          <div className="cf-pane">
            {section === 'general' && <GeneralPane />}
            {section === 'models' && <ModelSettings />}
            {section === 'extensions' && <ExtensionsPane />}
            {section === 'about' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  )
}

function GeneralPane(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { mode, setMode } = useTheme()
  const { recentLimit, setRecentLimit } = useWorkspace()
  return (
    <>
      <h2 className="cf-pane__title">{t('settings.general')}</h2>
      <div className="cf-set">
        <div className="cf-set__row">
          <div className="cf-set__label">{t('settings.language')}</div>
          <Segmented
            value={locale}
            onChange={(v) => setLocale(v as 'zh-CN' | 'en')}
            options={[
              { v: 'zh-CN', label: '简体中文' },
              { v: 'en', label: 'English' }
            ]}
          />
        </div>
        <div className="cf-set__row">
          <div className="cf-set__label">
            {t('settings.theme')}
            <span className="cf-set__hint">{t('settings.themeDesc')}</span>
          </div>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'light' | 'dark' | 'system')}
            options={[
              { v: 'system', label: t('settings.themeSystem') },
              { v: 'light', label: t('settings.themeLight') },
              { v: 'dark', label: t('settings.themeDark') }
            ]}
          />
        </div>
        <div className="cf-set__row">
          <div className="cf-set__label">
            {t('settings.recentLimit')}
            <span className="cf-set__hint">{t('settings.recentLimitDesc')}</span>
          </div>
          <input
            className="cf-input cf-input--num"
            type="number"
            min={1}
            max={50}
            value={recentLimit}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              if (Number.isFinite(n)) setRecentLimit(Math.min(50, Math.max(1, n)))
            }}
          />
        </div>
      </div>
    </>
  )
}

function ExtensionsPane(): React.JSX.Element {
  const { t } = useI18n()
  const { skills, mcp, subagents, personas, toggle } = useExtensions()
  type Item = {
    kind: 'skill' | 'mcp' | 'subagent' | 'persona'
    id: string
    name: string
    enabled: boolean
    badge: string
    note?: string
    locked?: boolean
  }
  const items: Item[] = [
    ...skills.map(
      (s): Item => ({
        kind: 'skill',
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        badge: t('cf.kindSkill'),
        note: s.source === 'builtin' ? t('cf.builtin') : undefined,
        locked: s.source === 'builtin'
      })
    ),
    ...mcp.map(
      (m): Item => ({
        kind: 'mcp',
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        badge: t('cf.kindMcp'),
        note: m.status === 'connected' ? t('cf.mcpConnected') : t('cf.mcpDisconnected')
      })
    ),
    ...subagents.map(
      (a): Item => ({
        kind: 'subagent',
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        badge: t('cf.kindSubagent')
      })
    ),
    ...personas.map(
      (p): Item => ({
        kind: 'persona',
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        badge: t('cf.kindPersona')
      })
    )
  ]
  return (
    <>
      <h2 className="cf-pane__title">{t('activity.extensions')}</h2>
      <p className="cf-pane__desc">{t('cf.extHint')}</p>
      {items.length === 0 ? (
        <div className="cf-empty">{t('cf.extEmpty')}</div>
      ) : (
        <div className="cf-rows">
          {items.map((x) => (
            <div key={`${x.kind}:${x.id}`} className="cf-setrow">
              <div className="cf-setrow__main">
                <div className="cf-setrow__name">
                  {x.name}
                  <span className="cf-badge">{x.badge}</span>
                  {x.note && <span className="cf-setrow__note">{x.note}</span>}
                </div>
              </div>
              <Toggle
                on={x.enabled}
                disabled={x.locked}
                onChange={() => toggle(x.kind, x.id)}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function AboutPane(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <h2 className="cf-pane__title">{t('settings.about')}</h2>
      <div className="cf-about">
        <div className="cf-about__logo">
          <span className="cf-brand__dot" />
        </div>
        <div className="cf-about__name">{t('app.name')}</div>
        <div className="cf-about__ver">
          {t('settings.version')} 0.0.0
        </div>
        <p className="cf-about__desc">{t('app.tagline')}</p>
      </div>
    </>
  )
}

function Segmented({
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

function Toggle({
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
function Avatar({
  persona,
  user,
  size
}: {
  persona?: Persona
  user?: boolean
  size?: number
}): React.JSX.Element | null {
  const style = {
    ...(size ? { '--sz': `${size}px` } : {}),
    ...(persona ? { '--p': persona.color } : {})
  } as React.CSSProperties
  if (user)
    return (
      <div className="cf-ava is-user" style={style}>
        我
      </div>
    )
  if (!persona)
    return <div className="cf-ava" style={style} />
  return (
    <div
      className="cf-ava"
      style={style}
      title={`${persona.name} · ${persona.desc}${persona.model ? ` · ${persona.model}` : ''}`}
    >
      {persona.emoji}
    </div>
  )
}
