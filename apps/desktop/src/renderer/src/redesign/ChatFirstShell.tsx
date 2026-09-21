import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpToLine,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cog,
  Copy,
  FileText,
  FileCode2,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Info,
  ListChecks,
  Lock,
  MessageCircle,
  Paperclip,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Square,
  Trash2,
  Unlock,
  Users,
  X,
  Zap
} from 'lucide-react'
import './redesign.css'
import type { McpKV, McpServer, McpStatus, Persona } from '../mock/extensions'
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
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import {
  AVATAR_COLORS,
  AVATAR_SLOTS,
  HumationFace,
  USER_AVATAR_SEED,
  isNonePart,
  parseAvatarSpec,
  partLabel,
  partPreview,
  partsForSlot,
  randomizeSpec,
  resolveSpec,
  serializeAvatarSpec,
  type AvatarSpec
} from '../components/humation'
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

/**
 * 无对话头的中列界面（快速开启 / 角色空态 / 资料卡）共用的顶部拖拽把手：一条透明、与原生标题栏同高的
 * 窗口拖拽区，补上这些界面缺失的顶部拖拽（对话视图已由 .cf-conv__head 承担）。纯装饰、无交互。
 */
function DragBar(): React.JSX.Element {
  return <div className="cf-dragbar" aria-hidden="true" />
}

/**
 * 花名册手动排序不再按名称（角色可改名 → 名称排序会跳位）：改由用户拖拽 / 置顶决定，顺序以 id 列表
 * 持久化（对标微信等 IM 的联系人手动排序）。此纯函数把「把 dragId 放到 targetId 之前/之后」算成新的 id 序列。
 */
function reorderIds(
  ids: string[],
  dragId: string,
  targetId: string,
  place: 'before' | 'after'
): string[] {
  if (dragId === targetId) return ids
  const without = ids.filter((id) => id !== dragId)
  const ti = without.indexOf(targetId)
  if (ti < 0) return ids
  without.splice(place === 'before' ? ti : ti + 1, 0, dragId)
  return without
}

/** 距底 ≤ 此像素即视为「贴住底部」，留缓冲避免临界抖动（与 ChatView 同值）。 */
const BOTTOM_THRESHOLD = 64

/** 系统默认角色 id（首启种子「Deva」，id 恒为 general）：兼作兜底身份，且不允许删除。 */
const DEFAULT_PERSONA_ID = 'general'

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
    deleteSession,
    deleteSessions,
    deleteTurns,
    currentBinding,
    draftSession,
    mountFocus,
    respondPermission,
    respondAsk,
    respondPlan,
    permMode,
    setPermMode
  } = useChat()
  const { personas, remove, reorderPersonas } = useExtensions()
  const { t, locale } = useI18n()
  const dialog = useDialog()

  const [railTab, setRailTab] = useState<'chats' | 'roster'>('chats')
  /**
   * 「角色」tab 当前选中的角色（右侧显示其资料卡）。仅当 railTab==='roster' 时生效——右侧内容整体由
   * railTab 决定，故「消息」tab 与「角色」tab 各自记住自己的右侧（当前对话 / 当前角色），彼此独立、
   * 切 tab 时右侧随之切换（见下方渲染分支）。
   */
  const [viewPersonaId, setViewPersonaId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 非空时打开角色编辑器（Part G）。 */
  const [editor, setEditor] = useState<EditorState | null>(null)
  /**
   * 输入框预填（一次性、不自动发送）：用于「通过对话添加角色」——把引导语放进输入框交由用户
   * 自己审阅/修改后发送，而非替他发出。nonce 使相同文本也能重复触发；Composer 消费后回调置空。
   */
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(
    null
  )

  /** 兜底身份：优先 general，其次首个（花名册非空时）。 */
  const defaultPersona = useMemo(
    () => personas.find((p) => p.id === DEFAULT_PERSONA_ID) ?? personas[0],
    [personas]
  )
  const defaultPersonaId = defaultPersona?.id

  // 说明（去掉了旧的「自动绑定通用」effect）：从前只要当前对话未绑定且为空，就自动落一条绑定到默认身份
  // 的空会话——这会在「删空左侧所有对话」后立刻重建一条，导致永远无法真正清空、也进不了「快速开启」空态。
  // 现在改为：空对话由用户显式动作（点头像 / ＋开始对话 / 通过对话添加）才创建并落盘（见 startWith）；
  // 左侧无任何对话时，中列改渲染 QuickStart（列出全部角色，点头像直接开聊）。

  /** 当值身份（当前对话绑定的 persona）。 */
  const owner = personas.find((p) => p.id === currentBinding.personaId)

  // 左侧列表数据源：把「草稿会话」（尚未落库的空对话）并到已落库会话之前——与角色开启新对话时，该对话
  // 立即出现在聊天列表（内容可为空）。草稿 id 必不在 sessions 中（见 store.draftSession），无需去重；
  // 首发落库后 draftSession 转 null、真值并入 sessions，列表项按同 id 无缝接管。
  const railSessions = useMemo(
    () => (draftSession ? [draftSession, ...sessions] : sessions),
    [draftSession, sessions]
  )

  // 打开某对话 → 切到「消息」tab（右侧内容随 railTab 切换）。不清 viewPersonaId：让「角色」tab 记住
  // 自己上次查看的角色，两个 tab 的右侧彼此独立。
  const openThread = (id: string): void => {
    selectSession(id)
    setRailTab('chats')
  }
  // 查看某角色资料 → 切到「角色」tab 并选中该角色（右侧随之显示其资料卡）。
  const openProfile = (personaId: string): void => {
    setViewPersonaId(personaId)
    setRailTab('roster')
  }
  /** 点角色名片 → 打开预填的编辑器（propose 态，接受才落盘）。 */
  const openProposal = (block: Extract<ChatBlock, { kind: 'agentcard' }>): void =>
    setEditor({ mode: 'propose', draft: block.draft, toolId: block.id })
  /** 与某身份发起新对话：新建空会话（首发落绑定，并快照该身份当时的偏好模型）→ 回到消息视图。 */
  const startWith = (personaId: string): void => {
    newSession(personaId, undefined, personas.find((p) => p.id === personaId)?.model)
    setRailTab('chats')
  }
  /**
   * 「通过对话添加角色」：新建一个绑定兜底身份（通常「通用」）的空对话，把引导语**预填进输入框**，
   * 交由用户自己发送（不自动发出）——用户可先审阅/修改，确认后再发起；Agent 收到后一步步引导澄清
   * 需求、最后调 propose_agent 铸名片供确认（不写盘，接受才落盘）。
   */
  const addPersonaByChat = (): void => {
    newSession(defaultPersonaId, undefined, defaultPersona?.model)
    setRailTab('chats')
    setComposerPrefill({ text: t('cf.addByChatPrompt'), nonce: Date.now() })
  }
  const viewPersona = viewPersonaId ? personas.find((p) => p.id === viewPersonaId) : undefined

  // 右键删除（对话 / 角色）：先弹居中确认框（破坏性 → 红色确认键），确认后才走既有删除通路——
  // 对话经 deleteSession（中止在跑回合 + 落盘删除 + 切到最近会话），角色经 remove('persona')。
  // 标题直接写成「删除对话 xxx ？/删除角色 xxx ？」这一动作问句（比裸标题更醒目），随语言拼装。
  const deleteThread = (id: string, title: string): void => {
    const name = title || t('chat.untitled')
    const heading = locale === 'en' ? `Delete conversation “${name}”?` : `删除对话 ${name} ？`
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message: t('cf.deleteChatConfirm'),
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      if (ok) deleteSession(id)
    })()
  }
  // 按「轮」删除当前对话的选中轮次（同步删上下文）：先弹居中破坏性确认，确认后走 store.deleteTurns。
  // 返回是否已删——Conversation 据此退出选择态并清空选择（未确认则保持选择态供继续调整）。
  const deleteTurnsWithConfirm = async (indices: number[]): Promise<boolean> => {
    if (indices.length === 0) return false
    const heading =
      locale === 'en'
        ? `Delete ${indices.length} selected turn${indices.length > 1 ? 's' : ''}?`
        : `删除选中的 ${indices.length} 轮对话？`
    const ok = await dialog.confirm({
      title: heading,
      message: t('cf.deleteTurnsConfirm'),
      variant: 'danger',
      confirmText: t('cf.delete')
    })
    if (!ok) return false
    await deleteTurns(indices)
    return true
  }
  const deletePersona = (id: string, name: string): void => {
    // 系统默认角色不可删除（UI 侧菜单项已禁用，此处再兜一道，防其他触发路径）。
    if (id === DEFAULT_PERSONA_ID) return
    // 该角色名下已落库的对话（草稿未落库不计），删角色时一并清除；数量用于提示影响面。
    const relatedIds = sessions.filter((s) => s.personaId === id).map((s) => s.id)
    const heading = locale === 'en' ? `Delete persona “${name}”?` : `删除角色 ${name} ？`
    // 有关联对话 → 提示「同时删除 N 个对话」；无 → 用不涉及对话的简短文案。
    const message =
      relatedIds.length > 0
        ? t('cf.deletePersonaConfirmWithChats').replace('{count}', String(relatedIds.length))
        : t('cf.deletePersonaConfirm')
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message,
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      if (!ok) return
      // 先清对话再删角色：避免出现「角色已删、对话仍引用缺失角色」的空窗渲染。
      if (relatedIds.length > 0) deleteSessions(relatedIds)
      remove('persona', id)
    })()
  }

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
          sessions={railSessions}
          personas={personas}
          currentSessionId={currentSessionId}
          sessionStates={sessionStates}
          viewPersonaId={viewPersonaId}
          onOpenThread={openThread}
          onOpenProfile={openProfile}
          onAddPersona={() => setEditor({ mode: 'create' })}
          onAddPersonaByChat={addPersonaByChat}
          onDeleteThread={deleteThread}
          onDeletePersona={deletePersona}
          onReorderPersonas={reorderPersonas}
        />
        {railTab === 'roster' ? (
          // 「角色」tab：右侧显示选中角色的资料卡；未选中（或角色已删）则给出提示。
          // 与「消息」tab 的右侧彼此独立——切 tab 即切右侧内容。
          viewPersona ? (
            <ProfileView
              persona={viewPersona}
              sessions={railSessions}
              onOpenThread={openThread}
              onStart={() => startWith(viewPersona.id)}
              onEdit={() => setEditor({ mode: 'edit', persona: viewPersona })}
            />
          ) : (
            <RosterEmpty />
          )
        ) : railSessions.length === 0 ? (
          <QuickStart personas={personas} onStart={startWith} />
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
            onPlan={respondPlan}
            onPermMode={setPermMode}
            onOpenProposal={openProposal}
            onDeleteTurns={deleteTurnsWithConfirm}
            prefill={composerPrefill}
            onPrefillConsumed={() => setComposerPrefill(null)}
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

/** 列表行右键菜单：光标处（视口坐标）+ 目标（对话或角色）。 */
type RowMenu =
  | { x: number; y: number; kind: 'thread'; id: string; title: string }
  | { x: number; y: number; kind: 'persona'; id: string; name: string }

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
  onAddPersonaByChat,
  onDeleteThread,
  onDeletePersona,
  onReorderPersonas
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
  onDeleteThread: (id: string, title: string) => void
  onDeletePersona: (id: string, name: string) => void
  onReorderPersonas: (ids: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 右键菜单态（对话/角色行共用一个，同一时刻至多一个）。
  const [menu, setMenu] = useState<RowMenu | null>(null)
  // 搜索词（对话/角色 tab 共用一个输入框，切 tab 时清空，见下方 effect）。
  const [query, setQuery] = useState('')
  // 花名册拖拽态：dragId=正被拖动的角色；dropTarget=当前悬停的落点行与半区（驱动放置指示线）。
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  )
  // 切换 tab 时清空搜索词：两个 tab 检索对象不同（对话标题 vs 角色名），残留词会误导。
  useEffect(() => {
    setQuery('')
  }, [tab])
  // 归一化后的检索词（去空白 + 小写）；空则视为不过滤。
  const q = query.trim().toLowerCase()
  // 消息列表按最近更新降序，再按检索词过滤（标题 + 所属角色名，均大小写不敏感）。
  const ordered = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!q) return sorted
    return sorted.filter((s) => {
      const owner = personas.find((p) => p.id === s.personaId)
      return (
        s.title.toLowerCase().includes(q) ||
        (owner ? owner.name.toLowerCase().includes(q) : false)
      )
    })
  }, [sessions, personas, q])
  // 角色列表按检索词过滤（角色名 + 简介 + 开场白，均大小写不敏感）；空词返回全部。
  const shownPersonas = useMemo(() => {
    if (!q) return personas
    return personas.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.desc.toLowerCase().includes(q) ||
        p.tagline.toLowerCase().includes(q)
    )
  }, [personas, q])

  const clearDrag = (): void => {
    setDragId(null)
    setDropTarget(null)
  }
  // 拖拽落定：把 dragId 放到目标行的上/下半区所决定的位置，算出新 id 序列并落盘（乐观 + 持久化）。
  const dropOnPersona = (targetId: string, edge: 'before' | 'after'): void => {
    if (dragId && dragId !== targetId) {
      onReorderPersonas(reorderIds(personas.map((p) => p.id), dragId, targetId, edge))
    }
    clearDrag()
  }
  // 置顶：把该角色移到花名册最前（右键菜单触发）。已在最前则为无害的同序写入。
  const pinPersona = (id: string): void => {
    const ids = personas.map((p) => p.id)
    onReorderPersonas([id, ...ids.filter((x) => x !== id)])
  }
  return (
    <aside className="cf-rail">
      {/* 顶部：搜索占满整行；角色 tab 额外并排一个「添加角色」入口（悬停/点击出二选一弹层）。 */}
      <div className="cf-rail__top">
        <div className="cf-search">
          <Search className="cf-search__icon" size={14} />
          <input
            className="cf-search__input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'chats' ? t('cf.searchChats') : t('cf.searchRoster')}
            aria-label={t('cf.search')}
          />
          {query && (
            <button
              className="cf-search__clear"
              title={t('common.close')}
              aria-label={t('common.close')}
              onClick={() => setQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {tab === 'roster' && (
          <AddPersonaMenu onManual={onAddPersona} onByChat={onAddPersonaByChat} />
        )}
      </div>

      <div className="cf-list">
        {tab === 'chats' ? (
          ordered.length === 0 ? (
            <div className="cf-empty">{q ? t('cf.searchNoResults') : t('chat.noSessions')}</div>
          ) : (
            ordered.map((s) => (
              <ThreadRow
                key={s.id}
                session={s}
                owner={personas.find((p) => p.id === s.personaId)}
                state={sessionStates[s.id]}
                active={s.id === currentSessionId}
                onClick={() => onOpenThread(s.id)}
                onContext={(e) => {
                  e.preventDefault()
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    kind: 'thread',
                    id: s.id,
                    title: s.title || ''
                  })
                }}
              />
            ))
          )
        ) : personas.length === 0 ? (
          <div className="cf-empty">{t('cf.noPersona')}</div>
        ) : shownPersonas.length === 0 ? (
          <div className="cf-empty">{t('cf.searchNoResults')}</div>
        ) : (
          shownPersonas.map((p) => (
            <PersonaRow
              key={p.id}
              persona={p}
              active={viewPersonaId === p.id}
              dragging={dragId === p.id}
              dropEdge={dropTarget?.id === p.id && dragId !== p.id ? dropTarget.edge : null}
              onClick={() => onOpenProfile(p.id)}
              onContext={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, kind: 'persona', id: p.id, name: p.name })
              }}
              onDragStart={() => setDragId(p.id)}
              onDragOverRow={(edge) => {
                if (!dragId || dragId === p.id) return
                setDropTarget((cur) =>
                  cur && cur.id === p.id && cur.edge === edge ? cur : { id: p.id, edge }
                )
              }}
              onDropRow={(edge) => dropOnPersona(p.id, edge)}
              onDragEnd={clearDrag}
            />
          ))
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'thread'
              ? [
                  {
                    label: t('cf.deleteChat'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => onDeleteThread(menu.id, menu.title)
                  }
                ]
              : [
                  {
                    label: t('cf.pinTop'),
                    icon: <ArrowUpToLine size={14} />,
                    // 已在花名册最前则禁用（灰显），避免无意义的同序写入。
                    disabled: personas[0]?.id === menu.id,
                    onClick: () => pinPersona(menu.id)
                  },
                  {
                    label: t('cf.deletePersona'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    // 系统默认角色：菜单项禁用（灰显 + 悬停说明），不可点。
                    disabled: menu.id === DEFAULT_PERSONA_ID,
                    title:
                      menu.id === DEFAULT_PERSONA_ID ? t('cf.deletePersonaLocked') : undefined,
                    onClick: () => onDeletePersona(menu.id, menu.name)
                  }
                ]
          }
        />
      )}
    </aside>
  )
}

/**
 * 轻量右键菜单：定位到光标处（视口坐标），带全屏透明背板——点击 / 右键空白 / Esc 皆关闭。
 * 挂载后测量自身尺寸并夹取回视口内，避免贴近右 / 下边缘时溢出被裁。
 */
function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: Array<{
    label: string
    icon?: React.ReactNode
    danger?: boolean
    /** 禁用项：灰显 + 悬停说明（title），不可点（如系统默认角色的删除项）。 */
    disabled?: boolean
    title?: string
    onClick: () => void
  }>
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = x
    let top = y
    if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad
    if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
  }, [x, y])
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
        {items.map((it, i) => (
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
        ))}
      </div>
    </>
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
  onClick,
  onContext
}: {
  session: SessionMeta
  owner?: Persona
  state?: { streaming: boolean; attention: boolean }
  active: boolean
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const rel = useRelativeTime()
  return (
    <button
      className={`cf-thread${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      {/* 对话中（streaming）→ 头像边框绕圈小点指示。 */}
      <Avatar persona={owner} size={38} busy={state?.streaming} />
      <div className="cf-thread__main">
        {/* 上：角色名与时间；下：首次对话标题。挂载目录不在此展示。 */}
        <div className="cf-thread__top">
          <span className="cf-thread__owner">{owner?.name ?? ''}</span>
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
  dragging,
  dropEdge,
  onClick,
  onContext,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd
}: {
  persona: Persona
  active: boolean
  /** 本行正被拖动（淡化显示）。 */
  dragging: boolean
  /** 本行是当前落点时的插入边（上=before / 下=after），驱动放置指示线；非落点为 null。 */
  dropEdge: 'before' | 'after' | null
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
  onDragStart: () => void
  /** 拖动经过本行：据指针落在上/下半区回报插入边。 */
  onDragOverRow: (edge: 'before' | 'after') => void
  onDropRow: (edge: 'before' | 'after') => void
  onDragEnd: () => void
}): React.JSX.Element {
  // 指针在本行的上半区 → 插到本行之前；下半区 → 之后。
  const edgeAt = (e: React.DragEvent): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY - r.top < r.height / 2 ? 'before' : 'after'
  }
  return (
    <button
      className={`cf-prow${active ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}${
        dropEdge ? ` drop-${dropEdge}` : ''
      }`}
      draggable
      onClick={onClick}
      onContextMenu={onContext}
      onDragStart={(e) => {
        // 需要 dataTransfer 非空，拖拽才成立（内容用不到，仅占位）。
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', persona.id)
        onDragStart()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOverRow(edgeAt(e))
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropRow(edgeAt(e))
      }}
      onDragEnd={onDragEnd}
    >
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
/* ============================ 中列：快速开启（无任何对话时的空态） ============================ */
/**
 * 左侧对话被清空后中列的落点：列出花名册全部角色，点头像/卡片直接与该角色开启新对话
 * （onStart → startWith：新建并落盘一条绑定该角色的空对话，随即切入消息视图）。
 * 花名册为空时给出「先去添加角色」的提示（与角色 tab 空态一致）。
 */
function QuickStart({
  personas,
  onStart
}: {
  personas: Persona[]
  onStart: (personaId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('cf.quickStartTitle')}</div>
          <div className="cf-quick__hint">{t('cf.quickStartHint')}</div>
          {personas.length === 0 ? (
            <div className="cf-empty">{t('cf.noPersona')}</div>
          ) : (
            <div className="cf-quick__grid">
              {personas.map((p) => (
                <button
                  key={p.id}
                  className="cf-qcard"
                  onClick={() => onStart(p.id)}
                  title={p.desc || p.name}
                  style={{ '--p': p.color } as React.CSSProperties}
                >
                  <Avatar persona={p} size={48} />
                  <span
                    className="cf-qcard__name"
                    style={{ '--p': p.color } as React.CSSProperties}
                  >
                    {p.name}
                  </span>
                  {p.desc && <span className="cf-qcard__desc">{p.desc}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

/**
 * 「角色」tab 未选中任何角色时的右侧落点（与「消息」tab 的右侧彼此独立）：一句提示，引导从左侧花名册
 * 选一个角色查看资料。复用 QuickStart 的居中容器，无新增 CSS。
 */
function RosterEmpty(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('cf.rosterEmptyTitle')}</div>
          <div className="cf-quick__hint">{t('cf.rosterEmptyHint')}</div>
        </div>
      </div>
    </main>
  )
}

/**
 * 把展示消息按「轮」分组为连续区间（to 独占）。turn>=0 为可删的对话轮（0 基，每遇一条 user 消息 +1）；
 * turn=-1 为首条 user 之前的前言（压缩摘要 / 历史提示气泡等，不可删）。turn 值与主进程 turnRanges 同源
 * （都以「数用户气泡」为轮界），故渲染层选中的轮下标可直接交给主进程按轮删除，逐一对齐。
 */
function groupTurns(messages: ChatMessage[]): { turn: number; from: number; to: number }[] {
  const groups: { turn: number; from: number; to: number }[] = []
  let turn = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') turn++
    const last = groups[groups.length - 1]
    if (last && last.turn === turn) last.to = i + 1
    else groups.push({ turn, from: i, to: i + 1 })
  }
  return groups
}

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
  onPlan,
  onPermMode,
  onOpenProposal,
  onDeleteTurns,
  prefill,
  onPrefillConsumed
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
  onPlan: (key: string, decision: 'approve' | 'keep') => void
  onPermMode: (mode: PermMode) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** 按「轮」删除选中轮次（含破坏性确认）；返回是否已删（true=退出选择态并清空选择）。 */
  onDeleteTurns: (turnIndices: number[]) => Promise<boolean>
  /** 输入框预填（一次性、不发送）；null 表示无待预填。 */
  prefill: { text: string; nonce: number } | null
  /** Composer 消费预填后回调，父层据此置空，避免重挂载时复活旧预填。 */
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)

  // 是否「贴住底部」：决定流式新内容是否自动跟随。用户上滚离开底部即脱离跟随，回到底部（或点「回到最新」）
  // 恢复跟随。ref 供滚动副作用同步读取（避免闭包过期、其变化不触发副作用重跑），state 仅驱动浮标显隐。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // 选择态（按轮删除）：selecting=是否在选择模式；selected=选中的轮下标集合（0 基，与 groupTurns 一致）。
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  // 右键菜单：记录光标位置、命中的轮下标（turn=null 表示未落在某一轮上），以及右键那一刻的选中文字与是否可删。
  // selection 有值 → 提供「复制」；canDelete（非流式且有内容）→ 提供「选择删除」。二者各自独立成项。
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    turn: number | null
    selection: string
    canDelete: boolean
  } | null>(null)
  // 每条消息所属轮下标：与 groupTurns 同源（每遇 user +1），前言为 -1；供常态渲染在根节点标注 data-turn。
  const turnOf = useMemo(() => {
    const arr: number[] = []
    let turn = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') turn++
      arr[i] = turn
    }
    return arr
  }, [messages])
  const exitSelect = (): void => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggleTurn = (turn: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }
  const doDeleteSelected = (): void => {
    const indices = [...selected]
    if (indices.length === 0) return
    void (async () => {
      const done = await onDeleteTurns(indices)
      if (done) exitSelect()
    })()
  }
  // 聊天区右键：按当下情形组装菜单。
  // - 选中文字 → 提供「复制」（不论是否流式，复制只读无副作用）；
  // - 非流式且有内容 → 提供「选择删除」（流式/改写中删除会撞上正在变的 messages，故此时不给）。
  // 选择态下让位给选择态自身交互；既无选中又不可删则不接管右键（放行系统默认菜单）。
  const onMsgsContextMenu = (e: React.MouseEvent): void => {
    if (selecting) return
    const selection = (window.getSelection()?.toString() ?? '').trim()
    const canDelete = !streaming && messages.length > 0
    if (!selection && !canDelete) return
    e.preventDefault()
    const hit = (e.target as HTMLElement).closest('[data-turn]') as HTMLElement | null
    const n = hit ? Number(hit.dataset.turn) : NaN
    const turn = Number.isInteger(n) && n >= 0 ? n : null
    setCtxMenu({ x: e.clientX, y: e.clientY, turn, selection, canDelete })
  }
  // 复制选中文字到系统剪贴板：优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copySelection = (text: string): void => {
    if (!text) return
    void window.deva?.clipboard?.writeText(text).catch(() => {
      void navigator.clipboard?.writeText(text).catch(() => {})
    })
  }
  // 会话内消息被删空（选中全部轮）后自动退出选择态，避免停留在空白选择界面。
  useEffect(() => {
    if (selecting && messages.length === 0) exitSelect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, selecting])

  // 新内容到达：仅当仍贴底才自动滚到底；用户上滚查看历史时保持不动。
  useEffect(() => {
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  // 切换会话（Conversation 不按会话重挂载）：复位贴底并直接滚到底；同时退出选择态（选择只属当前对话）。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    setSelecting(false)
    setSelected(new Set())
    setCtxMenu(null)
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

  // 单条消息渲染（选择态与常态复用；选择态下 active 恒 false，因选择只在非流式时可用）。
  // turn：常态渲染传入，标注到根 data-turn 供右键定位；选择态用卡片自身处理点击，无需传。
  const renderMsg = (m: ChatMessage, i: number, turn?: number): React.JSX.Element => (
    <ConvMessage
      key={m.id}
      msg={m}
      owner={owner}
      active={!selecting && streaming && i === messages.length - 1}
      dataTurn={turn}
      onPermission={onPermission}
      onAsk={onAsk}
      onPlan={onPlan}
      onOpenProposal={onOpenProposal}
    />
  )

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

      {/* 删除入口在聊天区右键唤起（见 onMsgsContextMenu）；选择态由右键菜单的「选择删除」开启。 */}
      <div className="cf-msgs" ref={scrollRef} onScroll={onScroll} onContextMenu={onMsgsContextMenu}>
        <div className={`cf-msgs__inner${selecting ? ' is-selecting' : ''}`}>
          {messages.length === 0 ? (
            <div className="cf-empty">
              {owner ? (owner.desc ? `${owner.name} · ${owner.desc}` : owner.name) : ''}
            </div>
          ) : selecting ? (
            // 选择态：按「轮」分组，每轮一张可勾选卡片；前言（turn<0）原样呈现、不可选。
            groupTurns(messages).map((g) => {
              const items = messages.slice(g.from, g.to)
              if (g.turn < 0)
                return (
                  <Fragment key={`pre-${g.from}`}>
                    {items.map((m, k) => renderMsg(m, g.from + k))}
                  </Fragment>
                )
              const isSel = selected.has(g.turn)
              return (
                <div
                  key={`turn-${g.turn}`}
                  className={`cf-turn is-selectable${isSel ? ' is-selected' : ''}`}
                  role="button"
                  aria-pressed={isSel}
                  onClick={() => toggleTurn(g.turn)}
                >
                  <span className="cf-turn__check" aria-hidden>
                    {isSel && <Check size={13} />}
                  </span>
                  <div className="cf-turn__body">
                    {items.map((m, k) => renderMsg(m, g.from + k))}
                  </div>
                </div>
              )
            })
          ) : (
            <>
              {messages.map((m, i) => renderMsg(m, i, turnOf[i]))}
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

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            ...(ctxMenu.selection
              ? [
                  {
                    label: t('common.copy'),
                    icon: <Copy size={14} />,
                    onClick: () => copySelection(ctxMenu.selection)
                  }
                ]
              : []),
            ...(ctxMenu.canDelete
              ? [
                  {
                    label: t('cf.selectToDelete'),
                    icon: <ListChecks size={14} />,
                    onClick: () => setSelecting(true)
                  }
                ]
              : [])
          ]}
        />
      )}

      {selecting ? (
        <div className="cf-selbar">
          <span className="cf-selbar__count">
            {locale === 'en'
              ? `${selected.size} selected`
              : `已选 ${selected.size} 轮`}
          </span>
          <div className="cf-selbar__actions">
            <button className="cf-selbar__btn" onClick={exitSelect}>
              {t('cf.selCancel')}
            </button>
            <button
              className="cf-selbar__btn cf-selbar__btn--danger"
              disabled={selected.size === 0}
              onClick={doDeleteSelected}
            >
              {t('cf.delete')}
            </button>
          </div>
        </div>
      ) : (
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
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
        />
      )}
    </main>
  )
}

/** 单条消息：IM 头像外壳 + 复用 ChatView 的 BlockView（安全渲染器不重写）。 */
function ConvMessage({
  msg,
  owner,
  active,
  dataTurn,
  onPermission,
  onAsk,
  onPlan,
  onOpenProposal
}: {
  msg: ChatMessage
  owner?: Persona
  active: boolean
  /** 该消息所属的对话轮下标（0 基）；标注在根节点上，供右键菜单定位「删除此轮」。前言/未知为 undefined。 */
  dataTurn?: number
  onPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep') => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (msg.role === 'user') {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user" data-turn={dataTurn}>
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
    <div className="cf-msg" data-turn={dataTurn}>
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
              onPlan={onPlan}
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
  onJump,
  prefill,
  onPrefillConsumed
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
  prefill: { text: string; nonce: number } | null
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<Picked[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  // 预填（不发送）：把父层注入的文本写进输入框，聚焦并将光标移到末尾，交由用户自己发送。
  // nonce 变化触发一次；消费后立即回调置空（父层 prefill→null），guard 防重入与重挂载复活。
  useEffect(() => {
    if (!prefill) return
    setInput(prefill.text)
    onPrefillConsumed()
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce])

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
 * 模型选择器。复用 ChatView 同款 app.css 类
 * （model-pick / chip / model-pick__backdrop / model-pick__menu），零新增 CSS，视觉与旧壳一致。
 * 只列「已启用服务商 × 已启用模型」，按服务商分组。
 * 切换时做两件事：① 写当前对话覆盖层（setSessionModel），下一条消息随 modelRef 落库到会话属性，
 * 故同角色的多个对话可各用不同模型；② 把这次选择记为「最近使用模型」（setActiveModel）——本应用不设
 * 显式「默认模型」，最近一次在此切换的模型即充当**新对话未选时的默认**（见 store/models.tsx activeModelId）。
 * 显示的是**本对话生效模型**：本对话已选则显示所选；未选 / 所选模型已被删除 → 回落最近使用模型
 * activeModel 显示（与主进程 resolveModelRef 的兜底一致，删除的偏好模型自动回归最近使用）。
 * 菜单向上弹出（.model-pick__menu 的 bottom:calc(100%+8px)），锚在输入区工具条恰在屏内。
 */
function ModelPicker(): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel, providers, setActiveModel } = useModels()
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
                        // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话未选时的默认。
                        setSessionModel(`${p.id}:${m.id}`)
                        setActiveModel(p.id, m.id)
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
      <DragBar />
      <div className="cf-profile">
        <div className="cf-profile__inner">
          <div className="cf-profile__ava" style={{ '--p': persona.color } as React.CSSProperties}>
            <HumationFace
              seed={persona.id}
              spec={parseAvatarSpec(persona.avatar)}
              title={persona.name}
            />
          </div>
          <div
            className="cf-profile__name"
            style={{ '--p': persona.color } as React.CSSProperties}
          >
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
      </div>
    </main>
  )
}

/* ============================ 角色编辑器（Part G） ============================ */
// 十六进制 ↔ 颜色槽值互转：Humation colors/background 存不带 `#` 的十六进制；<input type=color> 需带 `#`。
const toHexInput = (v: string | undefined): string => {
  const s = (v || '').replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}` : '#000000'
}
const fromHexInput = (v: string): string => v.replace(/^#/, '').toUpperCase()

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
  const [color, setColor] = useState(editing?.color ?? draft?.color ?? '#7c7cf0')
  const [desc, setDesc] = useState(editing?.desc ?? draft?.desc ?? '')
  const [model, setModel] = useState(editing?.model ?? draft?.model ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? draft?.prompt ?? '')
  const [saving, setSaving] = useState(false)

  // 头像：初始化解析为**具体** spec，此后只处理显式值、保存也写显式值（杜绝漂移）。
  // 编辑=沿用已存（空则按 id 确定性生成，与各处显示一致）；名片=按角色名确定性生成（与聊天名片预览一致）；
  // 新建=默认随机一枚（每个新角色开箱即有独特头像）。seed 只初始化取一次，故编辑期间不随输入名跳变。
  const avatarSeed = editing?.id || draft?.name || 'new-persona'
  const [avatar, setAvatar] = useState<AvatarSpec>(() =>
    editing
      ? resolveSpec(avatarSeed, parseAvatarSpec(editing.avatar))
      : proposing
        ? resolveSpec(avatarSeed, null)
        : randomizeSpec()
  )
  // 头像编辑面板开关：点击信息表单里的头像缩略图进入，「完成」/「取消」均返回继续编辑其余信息。
  const [avatarEditing, setAvatarEditing] = useState(false)
  // 进面板时快照当前头像：「取消」还原快照后返回（丢弃面板内改动），「完成」保留改动返回。
  // 两者都只切回表单，真正落盘仍走表单底部的保存/接受。
  const avatarBackup = useRef<AvatarSpec | null>(null)
  const openAvatarPanel = (): void => {
    avatarBackup.current = avatar
    setAvatarEditing(true)
  }
  const closeAvatarPanel = (revert: boolean): void => {
    if (revert && avatarBackup.current) setAvatar(avatarBackup.current)
    avatarBackup.current = null
    setAvatarEditing(false)
  }
  // 顶部 ✕ / 点击背景：在头像面板时只退回信息表单（丢弃头像改动），否则关闭整个编辑器。
  const dismiss = (): void => {
    if (avatarEditing) closeAvatarPanel(true)
    else onClose()
  }
  // 各槽位部件缩略图：用中性默认配色一次性生成并 memo（大预览才反映实际配色，故此处不随配色重算）。
  const slotPreviews = useMemo(
    () =>
      AVATAR_SLOTS.map((slot) => ({
        slot,
        parts: partsForSlot(slot).map((part) => ({
          part,
          uri: isNonePart(part) ? '' : partPreview(part)
        }))
      })),
    []
  )
  const setSelection = (slot: string, partId: string): void =>
    setAvatar((a) => ({ ...a, selections: { ...(a.selections ?? {}), [slot]: partId } }))
  const setColorSlot = (slot: string, hex: string): void =>
    setAvatar((a) => ({ ...a, colors: { ...(a.colors ?? {}), [slot]: fromHexInput(hex) } }))
  const setBackground = (hex: string): void => setAvatar((a) => ({ ...a, background: fromHexInput(hex) }))

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
        // 存显式头像 spec（JSON 串）：所见即所存即所渲染。
        avatar: serializeAvatarSpec(avatar),
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
    <div className="cf-modal__backdrop" onClick={dismiss}>
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
            {avatarEditing
              ? t('cf.fAvatar')
              : proposing
                ? t('cf.editorProposeTitle')
                : editing
                  ? t('cf.editorEditTitle')
                  : t('cf.editorNewTitle')}
          </span>
          {/* ✕/背景：头像面板时退回信息表单；否则关闭（propose 态丢弃改动、保持 pending、可再开），不 resolve、不写。 */}
          <button
            className="cf-modal__close"
            title={avatarEditing ? t('cf.cancel') : proposing ? t('cf.close') : t('cf.cancel')}
            onClick={dismiss}
          >
            ✕
          </button>
        </div>
        <div className="cf-editor">
          {avatarEditing ? (
            /* ===== 头像编辑面板：点击头像进入；改动实时写入 state，「完成」返回信息表单 ===== */
            <div className="cf-avapanel">
              <div className="cf-avaedit">
                <div className="cf-avaedit__side">
                  <div
                    className="cf-avaedit__preview"
                    style={{ '--p': color } as React.CSSProperties}
                  >
                    <HumationFace seed={avatarSeed} spec={avatar} title={name || t('cf.fAvatar')} />
                  </div>
                  <button
                    type="button"
                    className="cf-btn cf-avaedit__rand"
                    onClick={() => setAvatar(randomizeSpec())}
                  >
                    {t('cf.avaRandom')}
                  </button>
                  <label className="cf-avaedit__theme">
                    <span>{t('cf.fColor')}</span>
                    <input
                      className="cf-color"
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                    />
                  </label>
                </div>

                <div className="cf-avaedit__main">
                  {/* 部件：每槽一行横向缩略图；「无」选项渲染为文字块。 */}
                  {slotPreviews.map(({ slot, parts }) => (
                    <div key={slot} className="cf-avaedit__group">
                      <span className="cf-avaedit__glabel">{t(`cf.avaSlot.${slot}`)}</span>
                      <div className="cf-avaedit__parts">
                        {parts.map(({ part, uri }) => {
                          const selected = avatar.selections?.[slot] === part.id
                          return (
                            <button
                              key={part.id}
                              type="button"
                              title={partLabel(part)}
                              aria-pressed={selected}
                              className={`cf-avaedit__part${selected ? ' is-selected' : ''}`}
                              onClick={() => setSelection(slot, part.id)}
                            >
                              {uri ? (
                                <img src={uri} alt={partLabel(part)} draggable={false} />
                              ) : (
                                <span className="cf-avaedit__none">{t('cf.avaNone')}</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}

                  {/* 配色：角色部件配色 + 背景色。 */}
                  <div className="cf-avaedit__colors">
                    {AVATAR_COLORS.map((slot) => (
                      <label key={slot} className="cf-avaedit__swatch">
                        <input
                          type="color"
                          value={toHexInput(avatar.colors?.[slot])}
                          onChange={(e) => setColorSlot(slot, e.target.value)}
                        />
                        <span>{t(`cf.avaColor.${slot}`)}</span>
                      </label>
                    ))}
                    <label className="cf-avaedit__swatch">
                      <input
                        type="color"
                        value={toHexInput(avatar.background)}
                        onChange={(e) => setBackground(e.target.value)}
                      />
                      <span>{t('cf.avaColor.background')}</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* 两者都只收起面板返回表单：「取消」丢弃面板内头像改动、「完成」保留；落盘仍走表单保存/接受。 */}
              <div className="cf-editor__actions">
                <button type="button" className="cf-btn" onClick={() => closeAvatarPanel(true)}>
                  {t('cf.cancel')}
                </button>
                <button
                  type="button"
                  className="cf-btn is-primary"
                  onClick={() => closeAvatarPanel(false)}
                >
                  {t('cf.avaDone')}
                </button>
              </div>
            </div>
          ) : (
            /* ===== 信息表单：头像收成一枚可点缩略图（点击进面板），其余字段照旧 ===== */
            <>
              {/* 头像独立成身份头：一枚缩略图 + 提示，点击切到头像编辑面板。 */}
              <div className="cf-field cf-field--avatar">
                <label className="cf-field__label">{t('cf.fAvatar')}</label>
                <button
                  type="button"
                  className="cf-avapick"
                  title={t('cf.avaEdit')}
                  onClick={openAvatarPanel}
                >
                  <span
                    className="cf-avapick__face"
                    style={{ '--p': color } as React.CSSProperties}
                  >
                    <HumationFace seed={avatarSeed} spec={avatar} title={name || t('cf.fAvatar')} />
                  </span>
                  <span className="cf-avapick__hint">{t('cf.avaEditHint')}</span>
                </button>
              </div>

              <div className="cf-field">
                <label className="cf-field__label">{t('cf.fName')}</label>
                <input className="cf-input" value={name} onChange={(e) => setName(e.target.value)} />
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
                <button
                  className="cf-btn is-primary"
                  disabled={!name.trim() || saving}
                  onClick={save}
                >
                  {proposing ? t('cf.accept') : t('cf.save')}
                </button>
              </div>
            </>
          )}
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
  const nav: Array<{ id: SettingsSection; icon: React.ReactNode; label: string }> = [
    { id: 'general', icon: <Cog size={15} />, label: t('settings.general') },
    { id: 'models', icon: <Brain size={15} />, label: t('settings.models') },
    { id: 'extensions', icon: <Puzzle size={15} />, label: t('activity.extensions') },
    { id: 'about', icon: <Info size={15} />, label: t('settings.about') }
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
      </div>
    </>
  )
}

function ExtensionsPane(): React.JSX.Element {
  const { t } = useI18n()
  // 角色（persona）不在此列出：它有专属的「角色」tab 与资料卡来管理，扩展页只管技能/MCP/子智能体。
  const { skills, mcp, subagents, toggle, refresh } = useExtensions()
  // 进入扩展页即从磁盘重拉最新：技能可能经对话 create_skill、上传或直接改盘在别处新增，Provider 仅在
  // 应用启动时载入一次，故此处显式刷新，避免必须重启才能看到新技能。refresh 标识稳定，不会形成刷新循环。
  useEffect(() => {
    refresh()
  }, [refresh])

  // 钻取导航：选中某个 MCP 服务 → 进入详情编辑（对齐模型设置页的主从抽屉）。技能只读、子智能体暂不在此编辑，
  // 故只有 MCP 行可点开。MCP 的新增经对话工具 / 直接改盘 ~/.deva/mcp.json，扩展页不放新增入口。
  const [openMcpId, setOpenMcpId] = useState<string | null>(null)
  const openMcp = openMcpId ? mcp.find((m) => m.id === openMcpId) : undefined

  if (openMcp) {
    return <McpEditor item={openMcp} onBack={() => setOpenMcpId(null)} />
  }

  type Item = {
    kind: 'skill' | 'mcp' | 'subagent'
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
          {items.map((x) =>
            x.kind === 'mcp' ? (
              // MCP 行可点开编辑：主区做按钮（点开详情），开关作兄弟节点独立触发（互不干扰）。
              <div key={`${x.kind}:${x.id}`} className="cf-setrow">
                <button
                  className="cf-setrow__open"
                  title={t('extensions.name')}
                  onClick={() => setOpenMcpId(x.id)}
                >
                  <span className="cf-setrow__name">
                    {x.name}
                    <span className="cf-badge">{x.badge}</span>
                    {x.note && <span className="cf-setrow__note">{x.note}</span>}
                  </span>
                  <ChevronRight className="cf-setrow__chevron" size={15} />
                </button>
                <Toggle on={x.enabled} onChange={() => toggle(x.kind, x.id)} />
              </div>
            ) : (
              <div key={`${x.kind}:${x.id}`} className="cf-setrow">
                <div className="cf-setrow__main">
                  <div className="cf-setrow__name">
                    {x.name}
                    <span className="cf-badge">{x.badge}</span>
                    {x.note && <span className="cf-setrow__note">{x.note}</span>}
                  </div>
                </div>
                <Toggle on={x.enabled} disabled={x.locked} onChange={() => toggle(x.kind, x.id)} />
              </div>
            )
          )}
        </div>
      )}
    </>
  )
}

/** 面板 / 详情共用的运行期状态字形（● 连接 / ! 错 / ○ 断）。 */
const MCP_STATUS_GLYPH: Record<McpStatus, string> = {
  connected: '●',
  connecting: '●',
  error: '!',
  disconnected: '○'
}

/**
 * MCP 详情编辑（对话优先外壳）：钻取式主从抽屉，形态对齐模型设置页（顶部返回 + 逐字段即时落盘）。
 * 名称 / 传输 / 命令 / 参数 / 环境变量（或 URL / 请求头）经 update('mcp', …) round-trip 到 mcp.json；
 * 密钥恒经 mcpSetSecret 加密另存、写后不回显（`{secretRef}` 占位符落盘，明文零留痕）。
 */
function McpEditor({ item, onBack }: { item: McpServer; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const { update, remove, toggle, mcpConnect, mcpDisconnect, mcpTest, mcpSetSecret } = useExtensions()
  const [secretWarn, setSecretWarn] = useState(false)
  const isStdio = item.transport === 'stdio'

  // 写入密钥字段：加密不可用时亮出降级提示（空值即删除已存密钥）。
  // 返回落盘结果，供 McpKvEditor 呈现「保存中 / 已保存」反馈。
  const setSecret = (field: string, value: string): Promise<{ ok: boolean; available: boolean }> =>
    mcpSetSecret(item.id, field, value).then((r) => {
      if (value && !r.available) setSecretWarn(true)
      return r
    })

  const onDelete = (): void => {
    void (async () => {
      const ok = await dialog.confirm({
        title: item.name,
        message: t('cf.mcpDeleteConfirm'),
        confirmText: t('common.delete'),
        variant: 'danger'
      })
      if (ok) {
        remove('mcp', item.id)
        onBack()
      }
    })()
  }

  return (
    <section className="provider-detail" key={item.id}>
      <button className="provider-detail__back" onClick={onBack}>
        <ChevronLeft size={16} />
        {t('common.back')}
      </button>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Plug size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono">{item.name}</h2>
        <span className="ext-detail__scope">{t('common.global')}</span>
        <div className="provider-detail__spacer" />
        <button className="icon-btn" title={t('extensions.remove')} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('extensions.enable')}</span>
        <Toggle on={item.enabled} onChange={() => toggle('mcp', item.id)} />
      </header>

      <div className="ext-status">
        <span className={`ext-status__live ext-status__live--${item.status}`}>
          {MCP_STATUS_GLYPH[item.status]} {t(`extensions.status.${item.status}`)}
          {item.status === 'connected' && item.toolCount > 0
            ? ` · ${item.toolCount} ${t('extensions.tools')}`
            : ''}
        </span>
        <span className="ext-detail__spacer" />
        <button className="ext-linkbtn" onClick={() => mcpTest(item.id)}>
          {t('extensions.test')}
        </button>
        {item.status === 'connected' ? (
          <button className="ext-linkbtn" onClick={() => mcpDisconnect(item.id)}>
            {t('extensions.disconnect')}
          </button>
        ) : (
          <button className="ext-linkbtn" onClick={() => mcpConnect(item.id)}>
            {t('extensions.connect')}
          </button>
        )}
      </div>
      {item.status === 'error' && item.lastError && <div className="mcp-error">{item.lastError}</div>}

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.name')}</label>
        <input
          className="ext-input"
          value={item.name}
          onChange={(e) => update('mcp', item.id, { name: e.target.value })}
        />
      </div>

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.transport')}</label>
        <select
          className="ext-select ext-select--mono"
          value={item.transport}
          onChange={(e) =>
            update('mcp', item.id, { transport: e.target.value as McpServer['transport'] })
          }
        >
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">http (streamable)</option>
        </select>
      </div>

      {isStdio ? (
        <>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.command')}</label>
            <input
              className="ext-input ext-input--mono"
              placeholder={t('extensions.commandPlaceholder')}
              value={item.command}
              onChange={(e) => update('mcp', item.id, { command: e.target.value })}
            />
          </div>
          <McpArgsField item={item} />
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.env')}</label>
            <McpKvEditor
              serverId={item.id}
              rows={item.env}
              onChange={(rows) => update('mcp', item.id, { env: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      ) : (
        <>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.url')}</label>
            <input
              className="ext-input ext-input--mono"
              placeholder={t('extensions.urlPlaceholder')}
              value={item.url}
              onChange={(e) => update('mcp', item.id, { url: e.target.value })}
            />
          </div>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.headers')}</label>
            <McpKvEditor
              serverId={item.id}
              rows={item.headers}
              onChange={(rows) => update('mcp', item.id, { headers: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      )}

      {secretWarn && (
        <p className="ext-field__note ext-field__note--warn">{t('extensions.secretUnavailable')}</p>
      )}

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.discoveredTools')}</label>
        {item.tools.length === 0 ? (
          <div className="ext-tools--empty">{t('extensions.noToolsYet')}</div>
        ) : (
          <ul className="mcp-tools">
            {item.tools.map((tool) => (
              <li key={tool.name} className="mcp-tools__item">
                <code className="mcp-tools__name">{tool.name}</code>
                {tool.description && <span className="mcp-tools__desc">{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 命令参数编辑：一行一个（本地字符串态，随服务切换 remount 自动重置）。 */
function McpArgsField({ item }: { item: McpServer }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  const [text, setText] = useState(item.args.join('\n'))
  return (
    <div className="ext-field">
      <label className="ext-field__label">{t('extensions.args')}</label>
      <textarea
        className="ext-area ext-area--mono"
        rows={3}
        placeholder={t('extensions.argsPlaceholder')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          update('mcp', item.id, {
            args: e.target.value
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean)
          })
        }}
      />
    </div>
  )
}

/**
 * 键值对编辑（env / headers）：明文即时落盘；密钥经 onSetSecret 加密。
 * 密钥字段对齐模型页 API-Key 交互：
 *  - 输入后**保留**遮罩草稿在框内（不再失焦即清空 → 不会「自动消失」）；
 *  - 防抖 ~600ms 自动保存 + 失焦 / 回车立即冲刷，落盘结果亮「保存中 / 已保存」；
 *  - 重新打开时草稿为空，据 hasSecret 亮「已配置」并提示「留空不修改」——始终不回显明文。
 */
function McpKvEditor({
  serverId,
  rows,
  onChange,
  onSetSecret
}: {
  serverId: string
  rows: McpKV[]
  onChange: (rows: McpKV[]) => void
  onSetSecret: (field: string, value: string) => Promise<{ ok: boolean; available: boolean }>
}): React.JSX.Element {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saveState, setSaveState] = useState<Record<number, 'idle' | 'saving' | 'saved'>>({})
  const [configured, setConfigured] = useState<Record<number, boolean>>({})
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({})

  // 各密钥行是否已配置（布尔，不回显明文）；键集变化时重查，点亮「已配置」。
  const secretSig = JSON.stringify(rows.map((r) => (r.secret ? r.key.trim() : '')))
  useEffect(() => {
    const keys = JSON.parse(secretSig) as string[]
    let alive = true
    void (async () => {
      const next: Record<number, boolean> = {}
      await Promise.all(
        keys.map(async (key, i) => {
          if (key) next[i] = (await window.deva?.mcp?.hasSecret?.(serverId, key)) ?? false
        })
      )
      if (alive) setConfigured(next)
    })()
    return () => {
      alive = false
    }
  }, [serverId, secretSig])

  const setRow = (i: number, patch: Partial<McpKV>): void =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void => onChange([...rows, { key: '', value: '', secret: false }])
  const removeRow = (i: number): void => onChange(rows.filter((_, idx) => idx !== i))

  const clearTimer = (i: number): void => {
    const tm = timersRef.current[i]
    if (tm) {
      clearTimeout(tm)
      timersRef.current[i] = null
    }
  }

  const doSaveSecret = async (i: number, key: string, value: string): Promise<void> => {
    if (!key || !value) return
    setSaveState((s) => ({ ...s, [i]: 'saving' }))
    const r = await onSetSecret(key, value)
    setSaveState((s) => ({ ...s, [i]: r.ok ? 'saved' : 'idle' }))
    if (r.ok) setConfigured((c) => ({ ...c, [i]: true }))
  }

  // 输入变化：更新草稿并防抖自动保存（不清空草稿，遮罩值留在框内）。
  const onSecretChange = (i: number, value: string): void => {
    setDrafts((d) => ({ ...d, [i]: value }))
    setSaveState((s) => ({ ...s, [i]: 'idle' }))
    clearTimer(i)
    const key = rows[i].key.trim()
    if (!key || !value) return
    timersRef.current[i] = setTimeout(() => {
      timersRef.current[i] = null
      void doSaveSecret(i, key, value)
    }, 600)
  }

  // 立即冲刷在途保存（失焦 / 回车）。
  const flushSecret = (i: number): void => {
    clearTimer(i)
    void doSaveSecret(i, rows[i].key.trim(), drafts[i] ?? '')
  }

  const toggleSecret = (i: number): void => {
    const r = rows[i]
    const key = r.key.trim()
    if (r.secret && key) void onSetSecret(key, '') // 转明文：清除已加密的旧值
    clearTimer(i)
    setRow(i, { secret: !r.secret, value: '' })
    setDrafts((d) => {
      const n = { ...d }
      delete n[i]
      return n
    })
    setSaveState((s) => {
      const n = { ...s }
      delete n[i]
      return n
    })
    setConfigured((c) => {
      const n = { ...c }
      delete n[i]
      return n
    })
  }

  return (
    <div className="kv-editor">
      {rows.map((r, i) => (
        <div className="kv-row-wrap" key={i}>
          <div className="kv-row">
            <input
              className="ext-input ext-input--mono kv-row__key"
              placeholder={t('extensions.kvKey')}
              value={r.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            {r.secret ? (
              <input
                className="ext-input ext-input--mono kv-row__val"
                type="password"
                placeholder={
                  configured[i]
                    ? t('extensions.secretPlaceholder')
                    : t('extensions.secretValuePlaceholder')
                }
                value={drafts[i] ?? ''}
                onChange={(e) => onSecretChange(i, e.target.value)}
                onBlur={() => flushSecret(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') flushSecret(i)
                }}
              />
            ) : (
              <input
                className="ext-input ext-input--mono kv-row__val"
                placeholder={t('extensions.kvValue')}
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
            )}
            <button
              className={`icon-btn icon-btn--sm kv-row__lock${r.secret ? ' is-on' : ''}`}
              title={r.secret ? t('extensions.unmarkSecret') : t('extensions.markSecret')}
              onClick={() => toggleSecret(i)}
            >
              {r.secret ? <Lock size={13} /> : <Unlock size={13} />}
            </button>
            <button
              className="icon-btn icon-btn--sm"
              title={t('extensions.removeRow')}
              onClick={() => removeRow(i)}
            >
              <X size={13} />
            </button>
          </div>
          {r.secret && (saveState[i] === 'saving' || saveState[i] === 'saved' || configured[i]) && (
            <div className="kv-row__status">
              {saveState[i] === 'saving' ? (
                <span className="key-status">{t('extensions.secretSaving')}</span>
              ) : saveState[i] === 'saved' ? (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('extensions.secretSaved')}
                </span>
              ) : (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('extensions.secretConfigured')}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <button className="btn btn--ghost btn--sm kv-add" onClick={addRow}>
        <Plus size={13} /> {t('extensions.addRow')}
      </button>
    </div>
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
// 全应用头像（角色 / 人类用户）统一走 Humation：
//  - 角色：seed=persona.id，叠加其 avatar spec（若有）；描边环用身份色 --p。
//  - 用户：固定 seed（USER_AVATAR_SEED），描边环用强调色（.is-user 覆盖 --p）。
// 结构：外层 .cf-ava 不裁剪（让忙碌小点可越界绕圈），内层 .cf-ava__face 圆形裁剪 SVG，::after 画描边环。
function Avatar({
  persona,
  user,
  size,
  busy
}: {
  persona?: Persona
  user?: boolean
  size?: number
  /** 忙碌（对话生成中）：在头像边框上叠加一枚绕圈旋转的白色小点，作就地「思考/生成中」指示。 */
  busy?: boolean
}): React.JSX.Element | null {
  const style = {
    ...(size ? { '--sz': `${size}px` } : {}),
    ...(persona ? { '--p': persona.color } : {})
  } as React.CSSProperties
  const cls = `cf-ava${busy ? ' is-busy' : ''}${user ? ' is-user' : ''}`
  const orbit = busy ? (
    <span className="cf-ava__spin" aria-hidden="true">
      <i className="cf-ava__dot" />
    </span>
  ) : null
  // 非用户、非角色（理论上罕见）：空占位圈。
  if (!user && !persona)
    return (
      <div className={cls} style={style}>
        {orbit}
      </div>
    )
  const seed = user ? USER_AVATAR_SEED : (persona as Persona).id
  const spec = user ? null : parseAvatarSpec((persona as Persona).avatar)
  const title = user
    ? undefined
    : `${(persona as Persona).name} · ${(persona as Persona).desc}${(persona as Persona).model ? ` · ${(persona as Persona).model}` : ''}`
  return (
    <div className={cls} style={style} title={title}>
      <span className="cf-ava__face">
        <HumationFace seed={seed} spec={spec} title={title} />
      </span>
      {orbit}
    </div>
  )
}
