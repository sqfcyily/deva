import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlarmClock,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpToLine,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cog,
  Copy,
  Download,
  FileText,
  FileCode2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Image as ImageIcon,
  Info,
  ListChecks,
  Lock,
  MessageCircle,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  Users,
  X
} from 'lucide-react'
import './redesign.css'
import type { McpKV, McpServer, McpStatus, Persona } from '../mock/extensions'
import type {
  GitBranch as GitBranchEntry,
  GitFailReason,
  GitGenLocale,
  GitGenModel,
  GitStatus,
  PersonaUpsertInput,
  PreviewScheduleResult,
  TaskRecord,
  TaskSchedule,
  TaskStatus
} from '../../../preload'
import { ScheduleEditor } from '../features/chat/ScheduleEditor'
import { TaskModelSelect, TaskPersonaSelect } from '../features/chat/TaskPickers'
import { taskErrorKey } from '../features/chat/TaskConfirmCard'
import {
  useChat,
  type AgentDraft,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type SendAttachment,
  type SessionMeta
} from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useModels } from '../store/models'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast, type ToastOptions } from '../components/ToastProvider'
import { Modal } from '../components/Modal'
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

/**
 * 右侧「对话轮次索引」面板参数。纯渲染层视觉常量：不持久化、不给设置项。
 * 面板只索引用户消息（对话的锚点），轮次少时不出现，避免短对话占位。
 */
/** 触发阈值：用户消息条数 ≥ 此值才渲染面板。 */
const TOC_MIN_TURNS = 4
/** 展开态面板宽度（px）。 */
const TOC_WIDTH = 160
/**
 * 判定「右侧留白够常驻展开」时，在面板宽度之外额外要求的余量（px）。
 * 须覆盖面板自身的右内缩（CSS .cf-toc 的 right: var(--space-4) = 16px）再留 16px 呼吸位，
 * 否则留白恰好卡在阈值时面板会压住正文右缘。
 */
const TOC_GAP = 32
/**
 * 当前轮判定线：距滚动容器顶边的偏移（px），最后一条越过它的用户消息即当前轮。
 * 须与 {@link TOC_JUMP_PAD} 保持接近——二者之差若超过相邻两条用户消息的最小间距，
 * 跳转落位后下一轮会立刻越线把高亮抢走，表现为「点了 A 却亮 B」。
 */
const TOC_ACTIVE_OFFSET = 48
/** 跳转后目标消息距容器顶边的留白（px）。 */
const TOC_JUMP_PAD = 16
/** 索引项保留的文本长度上限（DOM 体积护栏）；列表里的视觉截断交给 CSS line-clamp。 */
const TOC_TEXT_MAX = 200
/**
 * 面板一屏最多显示的索引条数，多出的在列表内部滚动（条数本身不设上限）。
 * 不做成「条数 × 固定行高」的估算：索引项 1~2 行不定高，收起态只剩刻度更矮，
 * 必须实测第 N 条的底边才不会多显或少显一条。
 */
const TOC_VISIBLE_MAX = 10

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
    respondAsk,
    respondPlan,
    respondMount
  } = useChat()
  const { personas, remove, reorderPersonas } = useExtensions()
  const { t, locale } = useI18n()
  const dialog = useDialog()

  const [railTab, setRailTab] = useState<'chats' | 'roster' | 'tasks'>('chats')
  /**
   * 「角色」tab 当前选中的角色（右侧显示其资料卡）。仅当 railTab==='roster' 时生效——右侧内容整体由
   * railTab 决定，故「消息」tab 与「角色」tab 各自记住自己的右侧（当前对话 / 当前角色），彼此独立、
   * 切 tab 时右侧随之切换（见下方渲染分支）。
   */
  const [viewPersonaId, setViewPersonaId] = useState<string | null>(null)
  /**
   * 「定时任务」tab 的外部导航意图：对话里点已创建任务名片「查看任务」时置为目标任务 id，切到 tasks tab
   * 后由 TasksPane 消费（直选该任务详情）并回清为 null——使之后手动进本 tab 仍复位到未选中空态。
   */
  const [tasksTarget, setTasksTarget] = useState<string | null>(null)
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
  /**
   * 点已创建定时任务名片「查看任务」→ 切到「定时任务」tab 并直选该任务详情。
   * 不再打开其独占会话：会话要等任务首次触发才由 runScheduledTurn 建，创建后立即打开必为空；
   * 查看任务详情（日程 / 授权 / 运行历史）才是此刻有意义的落点。
   */
  const openAutotask = (taskId: string): void => {
    setTasksTarget(taskId)
    setRailTab('tasks')
  }
  // 主进程导航意图（tasks:navigate）：通知点击带 `{sessionId}` → 打开该任务独占会话并回消息视图；
  // 托盘「定时任务概览」带 `{pane:'tasks'}` → 切到 Tasks 标签。窗口从托盘唤起时随即落到目标视图。
  useEffect(() => {
    const off = window.deva?.tasks?.onNavigate?.((payload) => {
      if (payload?.sessionId) {
        selectSession(payload.sessionId)
        setRailTab('chats')
      } else if (payload?.pane === 'tasks') {
        setRailTab('tasks')
      }
    })
    return () => off?.()
  }, [selectSession])

  /** 与某身份发起新对话：新建空会话（首发落绑定，并快照该身份当时的偏好模型）→ 回到消息视图。 */
  const startWith = (personaId: string): void => {
    newSession(personaId, undefined, personas.find((p) => p.id === personaId)?.model)
    setRailTab('chats')
  }
  /**
   * 右键菜单「新开对话」：以选中对话的**原角色**发起一条全新对话（复用 startWith → 新建空会话并
   * 快照该角色当前偏好模型）。原角色已删（或为旧无绑定会话）时回落兜底身份，绝不无绑定裸建。
   */
  const newChatFromThread = (id: string): void => {
    const source = railSessions.find((s) => s.id === id)
    const personaId = source?.personaId ?? defaultPersonaId
    if (personaId) startWith(personaId)
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
  /**
   * 「通过对话添加定时任务」：同上，仅把引导语换成定时任务模板（含【时间间隔】【具体任务】占位，
   * 交由用户补全后自己发送）。Agent 收到后照常澄清需求、调 create_task 铸确认名片待批。
   */
  const addTaskByChat = (): void => {
    newSession(defaultPersonaId, undefined, defaultPersona?.model)
    setRailTab('chats')
    setComposerPrefill({ text: t('tasks.addByChatPrompt'), nonce: Date.now() })
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
        {railTab === 'tasks' ? (
          // 「定时任务」tab：占满列表列 + 右侧内容的整块空间，作独立管理面（列表 + 每行操作）。
          // 与「消息 / 角色」正交——不渲染 Rail 列表列，故 Rail 的 tab 只会拿到 'chats' | 'roster'。
          <TasksPane
            target={tasksTarget}
            onTargetConsumed={() => setTasksTarget(null)}
            onAddByChat={addTaskByChat}
          />
        ) : (
          <>
            <Rail
              tab={railTab}
              sessions={railSessions}
              personas={personas}
              currentSessionId={currentSessionId}
              sessionStates={sessionStates}
              viewPersonaId={viewPersonaId}
              onOpenThread={openThread}
              onOpenProfile={openProfile}
              onStartPersona={startWith}
              onAddPersona={() => setEditor({ mode: 'create' })}
              onAddPersonaByChat={addPersonaByChat}
              onNewChatFromThread={newChatFromThread}
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
                onOpenProfile={openProfile}
                onSend={send}
                onStop={stop}
                onMount={mountFocus}
                onAsk={respondAsk}
                onPlan={respondPlan}
                onMountReq={respondMount}
                onOpenProposal={openProposal}
                onOpenAutotask={openAutotask}
                onDeleteTurns={deleteTurnsWithConfirm}
                prefill={composerPrefill}
                onPrefillConsumed={() => setComposerPrefill(null)}
              />
            )}
          </>
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
  tab: 'chats' | 'roster' | 'tasks'
  onTab: (t: 'chats' | 'roster' | 'tasks') => void
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
      <button
        className={`cf-navbtn${tab === 'tasks' ? ' is-active' : ''}`}
        title={t('cf.tabTasks')}
        aria-label={t('cf.tabTasks')}
        aria-current={tab === 'tasks'}
        onClick={() => onTab('tasks')}
      >
        <AlarmClock size={20} />
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
  onStartPersona,
  onAddPersona,
  onAddPersonaByChat,
  onNewChatFromThread,
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
  /** 角色行右键「开始对话」：以该角色发起一条全新对话（复用 startWith）。 */
  onStartPersona: (id: string) => void
  onAddPersona: () => void
  onAddPersonaByChat: () => void
  onNewChatFromThread: (id: string) => void
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
          <AddMenu
            manualLabel={t('cf.addPersona')}
            chatLabel={t('cf.addByChat')}
            onManual={onAddPersona}
            onByChat={onAddPersonaByChat}
          />
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
                    label: t('cf.newChat'),
                    icon: <Plus size={14} />,
                    onClick: () => onNewChatFromThread(menu.id)
                  },
                  {
                    label: t('cf.deleteChat'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => onDeleteThread(menu.id, menu.title)
                  }
                ]
              : [
                  {
                    label: t('cf.startChat'),
                    icon: <MessageCircle size={14} />,
                    onClick: () => onStartPersona(menu.id)
                  },
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
 * openUp 时把传入的 y 当作菜单「底边」锚点（top = y − 菜单高度），使其向上生长——
 * 用于贴近视口底部的触发点（如挂载 chip 的 git pill），避免菜单向下遮挡输入区，行为同模型切换的 dropup。
 */
function ContextMenu({
  x,
  y,
  items,
  onClose,
  openUp = false
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
  /** 向上浮出：y 视作菜单底边锚点，菜单朝上生长（默认向下）。 */
  openUp?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
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
  }, [x, y, openUp])
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

/* ─────────────────────────── Git 快捷面板（IDEA 式点击浮出） ───────────────────────────
 * 挂载工作区若是 git 仓库，则在挂载 chip 里跟一枚分支 pill，点击浮出常用操作。
 * 后端（services/git.ts + window.deva.git.*）早已齐备；此处只是薄薄一层 renderer UI。
 * 安全：focusRoot 在 fs:open-folder 时已 trustRoot，git:status 内部 assertInside——复用既有受信根，
 * 不新增任何越权面，也不弹权限框（与「全放行 + 静默硬底线」一致）。
 */

/** git 是否可用：全应用只探一次（缓存 Promise），避免每次挂载都 spawn 一次 --version。 */
let gitAvailablePromise: Promise<boolean> | null = null
function probeGitAvailable(): Promise<boolean> {
  if (!gitAvailablePromise) {
    gitAvailablePromise = window.deva.git
      .available()
      .then((r) => r.available)
      .catch(() => false)
  }
  return gitAvailablePromise
}

/** GitFailReason → 本地化文案；缺 key 时回落到通用「操作失败」。 */
function gitReasonText(t: (k: string) => string, reason?: GitFailReason): string {
  const key = `cf.git.err.${reason || 'error'}`
  const s = t(key)
  return s === key ? t('cf.git.err.error') : s
}

/** DOM 侧硬上限：仅防止极端超长输出撑大节点；可见的「最多 5 行 + …」由 CSS line-clamp 负责。 */
const GIT_ERR_DETAIL_MAX = 4000

/** 归一 git 命令输出（stderr）用于展示：去 \r（进度符）、去首尾空白、超长硬截断；空则返回空串。 */
function gitErrorDetail(message?: string): string {
  if (!message) return ''
  const s = message.replace(/\r/g, '').trim()
  if (!s) return ''
  return s.length > GIT_ERR_DETAIL_MAX ? s.slice(0, GIT_ERR_DETAIL_MAX) : s
}

/**
 * 构造 git 失败 toast：标题=归类文案（认证失败/被拒绝…），正文=命令实际输出（截断）。
 * 无输出时退化为仅标题一行；有输出时延长停留时间，便于阅读原因。
 */
function gitErrorToast(
  t: (k: string) => string,
  r: { reason?: GitFailReason; message?: string }
): ToastOptions {
  const title = gitReasonText(t, r.reason)
  const detail = gitErrorDetail(r.message)
  return detail
    ? { variant: 'error', title, message: <span className="cf-giterr">{detail}</span>, duration: 8000 }
    : { variant: 'error', message: title }
}

interface GitState {
  available: boolean
  status: GitStatus | null
  busy: boolean
  refresh: () => Promise<void>
}

/**
 * 读取某工作区的 git 状态。不轮询（status 每次 spawn git 进程，且当前无文件监听）：
 * 只在「挂载 / 开菜单 / 每次写操作后」拉取。用 reqRef 防竞态——快速切换工作区时旧结果不覆盖新。
 */
function useGitStatus(root: string | null): GitState {
  const [available, setAvailable] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++reqRef.current
    if (!root) {
      setAvailable(false)
      setStatus(null)
      return
    }
    const ok = await probeGitAvailable()
    if (seq !== reqRef.current) return
    setAvailable(ok)
    if (!ok) {
      setStatus(null)
      return
    }
    setBusy(true)
    try {
      const st = await window.deva.git.status(root)
      if (seq !== reqRef.current) return
      setStatus(st.isRepo ? st : null)
    } catch {
      if (seq === reqRef.current) setStatus(null)
    } finally {
      if (seq === reqRef.current) setBusy(false)
    }
  }, [root])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { available, status, busy, refresh }
}

/**
 * 挂载 chip 里的分支 pill + 快捷菜单。仅当 git 可用且目标是仓库时渲染，否则返回 null（非仓库 / 没装 git 静默隐藏）。
 * 菜单复用既有 ContextMenu（视口定位 + 越界夹回）；「切换分支」二次弹出分支列表菜单；「提交」开 CommitModal。
 */
function GitWidget({ root }: { root: string }): React.JSX.Element | null {
  const { t, locale } = useI18n()
  const toast = useToast()
  const { activeModel, hasKey } = useModels()
  const { available, status, busy, refresh } = useGitStatus(root)

  const [menu, setMenu] = useState<{ kind: 'main' | 'branch'; x: number; y: number } | null>(null)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [commitOpen, setCommitOpen] = useState(false)
  const [opBusy, setOpBusy] = useState(false)
  const pillRef = useRef<HTMLButtonElement>(null)

  if (!available || !status || !status.isRepo) return null

  const label = status.detached ? t('cf.git.detached') : status.branch || t('cf.git.noBranch')

  // 锚点取 pill 上边缘（留 4px 间隙）；ContextMenu 以 openUp 把它当底边向上浮出，
  // 避免菜单向下遮挡下方的输入区/角色卡（挂载 chip 贴近视口底部）。
  const openMenuAt = (kind: 'main' | 'branch'): void => {
    const el = pillRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenu({ kind, x: r.left, y: r.top - 4 })
  }

  // 统一执行一个 git 写操作：置忙 → 调用 → 据结果 toast → 刷新状态。
  const run = async (
    fn: () => Promise<{ ok: boolean; reason?: GitFailReason; message?: string }>,
    okMsg: string
  ): Promise<void> => {
    setOpBusy(true)
    try {
      const r = await fn()
      if (r.ok) toast.show({ variant: 'success', message: okMsg })
      else toast.show(gitErrorToast(t, r))
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setOpBusy(false)
      void refresh()
    }
  }

  const openBranches = async (): Promise<void> => {
    try {
      setBranches(await window.deva.git.branches(root))
    } catch {
      setBranches([])
    }
    openMenuAt('branch')
  }

  const mainItems = [
    { label: t('cf.git.fetch'), icon: <Download size={14} />, onClick: () => void run(() => window.deva.git.fetch(root), t('cf.git.doneFetch')) },
    { label: t('cf.git.pull'), icon: <ArrowDownToLine size={14} />, onClick: () => void run(() => window.deva.git.pull(root), t('cf.git.donePull')) },
    { label: t('cf.git.push'), icon: <ArrowUpFromLine size={14} />, onClick: () => void run(() => window.deva.git.push(root, status.upstream ? null : status.branch), t('cf.git.donePush')) },
    { label: t('cf.git.switchBranch'), icon: <GitBranch size={14} />, onClick: () => void openBranches() },
    { label: t('cf.git.commit'), icon: <GitCommitHorizontal size={14} />, onClick: () => setCommitOpen(true) },
    { label: t('cf.git.refresh'), icon: <RefreshCw size={14} />, onClick: () => void refresh() }
  ]

  const branchItems = branches.map((b) => ({
    label: b.name,
    icon: b.current ? <Check size={14} /> : <span style={{ width: 14, display: 'inline-block' }} />,
    disabled: b.current,
    title: b.current ? t('cf.git.currentBranch') : undefined,
    onClick: () => void run(() => window.deva.git.checkout(root, b.name), t('cf.git.doneCheckout'))
  }))

  const commitModel: GitGenModel | null =
    activeModel && hasKey(activeModel.provider.id)
      ? {
          // activeModel 恒为对话模型（选择器已按 purpose 过滤），adapter 必属 LLM 三协议之一。
          adapter: activeModel.provider.adapter as GitGenModel['adapter'],
          providerId: activeModel.provider.id,
          baseURL: activeModel.provider.apiHost,
          model: activeModel.model.id
        }
      : null

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className={`cf-gitchip${opBusy || busy ? ' is-busy' : ''}`}
        title={t('cf.git.menuHint')}
        aria-label={t('cf.git.menuHint')}
        onClick={() => openMenuAt('main')}
        disabled={opBusy}
      >
        <GitBranch size={13} />
        <span className="cf-gitchip__branch">{label}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="cf-gitchip__ab">
            {status.ahead > 0 && (
              <span className="cf-gitchip__up">
                <ArrowUpFromLine size={11} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="cf-gitchip__down">
                <ArrowDownToLine size={11} />
                {status.behind}
              </span>
            )}
          </span>
        )}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          openUp
          items={menu.kind === 'main' ? mainItems : branchItems}
          onClose={() => setMenu(null)}
        />
      )}
      {commitOpen && (
        <CommitModal
          root={root}
          status={status}
          locale={locale as GitGenLocale}
          model={commitModel}
          onClose={() => setCommitOpen(false)}
          onDone={() => {
            setCommitOpen(false)
            void refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * 轻量提交框（v1 只做「暂存全部改动 + 提交」，不含逐文件 diff/staging）：
 * 顶部一行改动数量摘要；一个信息 textarea；「AI 生成」按当前模型走 generateCommitMessage（无模型/无密钥则灰掉）。
 * 有冲突时禁止提交并提示先解决——避免把未合并状态提交进去。
 */
function CommitModal({
  root,
  status,
  locale,
  model,
  onClose,
  onDone
}: {
  root: string
  status: GitStatus
  locale: GitGenLocale
  model: GitGenModel | null
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [msg, setMsg] = useState('')
  const [gen, setGen] = useState(false)
  const [busy, setBusy] = useState(false)

  // 变更集：跨 staged/unstaged/conflicts 按路径去重计数。
  const changed = useMemo(() => {
    const set = new Set<string>()
    for (const f of status.staged) set.add(f.path)
    for (const f of status.unstaged) set.add(f.path)
    for (const f of status.conflicts) set.add(f.path)
    return set.size
  }, [status])

  const hasConflicts = status.conflicts.length > 0
  const canCommit = Boolean(msg.trim()) && changed > 0 && !hasConflicts && !busy

  const generate = async (): Promise<void> => {
    if (!model) return
    setGen(true)
    try {
      const r = await window.deva.git.generateCommitMessage(root, model, locale)
      if (r.ok && r.text) setMsg(r.text)
      else toast.show(gitErrorToast(t, r))
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setGen(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!canCommit) return
    setBusy(true)
    try {
      // 先暂存全部未暂存改动（未跟踪文件已含在 status.unstaged 内），再提交。
      const toStage = status.unstaged.map((f) => f.path)
      if (toStage.length > 0) {
        const sres = await window.deva.git.stage(root, toStage)
        if (!sres.ok) {
          toast.show(gitErrorToast(t, sres))
          return
        }
      }
      const cres = await window.deva.git.commit(root, msg.trim())
      if (cres.ok) {
        toast.show({ variant: 'success', message: t('cf.git.doneCommit') })
        onDone()
      } else {
        toast.show(gitErrorToast(t, cres))
      }
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setBusy(false)
    }
  }

  const meta = hasConflicts
    ? t('cf.git.commitConflicts')
    : changed > 0
      ? t('cf.git.commitCount').replace('{n}', String(changed))
      : t('cf.git.commitNone')

  return (
    <Modal open onClose={onClose} width={460} labelledBy="cf-commit-title">
      <h2 id="cf-commit-title" className="modal__title">
        {t('cf.git.commitTitle')}
      </h2>
      <p className="cf-commit__meta">{meta}</p>
      <textarea
        className="input cf-commit__msg"
        value={msg}
        placeholder={t('cf.git.commitPlaceholder')}
        onChange={(e) => setMsg(e.target.value)}
        autoFocus
      />
      <div className="cf-commit__bar">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void generate()}
          disabled={!model || gen || busy}
          title={model ? t('cf.git.aiHint') : t('cf.git.aiNoModel')}
        >
          <Sparkles size={14} />
          {gen ? t('cf.git.aiGenerating') : t('cf.git.aiGenerate')}
        </button>
        <div className="cf-commit__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {t('cf.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={!canCommit}
          >
            {t('cf.git.commitDo')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * 「添加」入口（角色花名册 / 定时任务共用）：一个 + 图标，鼠标悬停或点击弹出二选一浮层——
 * 手动添加（打开编辑器表单）/ 通过对话添加（新建对话、Agent 引导创建）。
 * 离开略延迟收起以容忍按钮→浮层途中的空档，选中即收起并执行。文案由调用方按对象给（角色 / 任务）。
 */
function AddMenu({
  manualLabel,
  chatLabel,
  onManual,
  onByChat
}: {
  /** 手动项文案，同时作 + 按钮的 title / aria-label（如「添加角色」「添加任务」）。 */
  manualLabel: string
  /** 「通过对话添加」项文案。 */
  chatLabel: string
  onManual: () => void
  onByChat: () => void
}): React.JSX.Element {
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
        title={manualLabel}
        aria-label={manualLabel}
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
            <span>{manualLabel}</span>
          </button>
          <button className="cf-addmenu__item" role="menuitem" onClick={() => choose(onByChat)}>
            <MessageCircle size={15} className="cf-addmenu__icon" />
            <span>{chatLabel}</span>
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
  // 任务独占会话（sessionId = `task-…`）：行上打一枚静态「⏰ 定时」徽标以区别普通对话。
  // 「有新运行未读」的动态红点复用既有 attention 通道（state.attention），不新造信号。
  const isTask = session.id.startsWith('task-')
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
          {isTask && (
            <span className="cf-thread__badge" title={t('cf.tabTasks')}>
              <AlarmClock size={11} />
            </span>
          )}
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

/* ============================ 定时任务标签页 ============================ */

/** 分组展示顺序：进行中 → 已暂停 → 出错 → 已完成。 */
const TASK_GROUP_ORDER: TaskStatus[] = ['active', 'paused', 'error', 'completed']
const TASK_GROUP_KEY: Record<TaskStatus, string> = {
  active: 'tasks.groupActive',
  paused: 'tasks.groupPaused',
  error: 'tasks.groupError',
  completed: 'tasks.groupCompleted'
}

/** 绝对本地时间（简短）：用于「下次触发 / 上次运行」展示，跟随界面语言。 */
function fmtAbs(ts: number, locale: 'zh-CN' | 'en'): string {
  try {
    return new Date(ts).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

/**
 * 定时任务标签页——「左列表 + 右详情」双栏（对齐角色页）：TasksPane 作容器，持有当前选中任务的
 * 本地态 viewTaskId；左侧 TasksRail 按状态分组列出任务（名称 + 人读日程），右侧 TaskDetail 展示选中
 * 任务的完整信息与操作，未选中则给出空态。真值来自 useTasks（订阅 tasks:changed），所有变更委托主进程 IPC。
 *
 * 新建两路（搜索框旁的 + 菜单，布局同角色花名册）：手动 → 本面 TaskFormModal 直填并经 tasks:create 落盘；
 * 通过对话 → 交外壳新建对话并预填引导语，仍走模型 create_task + 确认名片。两路同一条主进程创建通路与
 * 同一套授权语义（创建即批准、触发时零交互），手动填表本身即用户亲自确认，不再另加一道名片。
 */
function TasksPane({
  target,
  onTargetConsumed,
  onAddByChat
}: {
  /** 外部导航意图（对话里「查看任务」）：非空则挂载即选中该任务；消费后经 onTargetConsumed 回清。 */
  target: string | null
  onTargetConsumed: () => void
  /** 「通过对话添加」：新建对话 + 预填引导语（实现于外壳，同「通过对话添加角色」）。 */
  onAddByChat: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { tasks, create, setStatus, runNow, update, remove } = useTasks()
  const { providers } = useModels()
  const { personas } = useExtensions()
  const dialog = useDialog()
  const toast = useToast()

  // 当前选中的任务（右侧显示其详情）。态存于本组件——切走再回本 tab 复位到未选中空态。
  // 初值取外部 target：从对话「查看任务」切入时本组件恰新挂载，直接落在目标任务详情。
  const [viewTaskId, setViewTaskId] = useState<string | null>(target)
  // 正在编辑的任务 id（非空 → 弹出编辑弹窗）。存 id 而非记录：编辑期间任务经广播刷新亦从最新列表派生。
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  // 手动新建表单是否打开（与编辑弹窗互斥：同一 TaskFormModal，task=null 即新建态）。
  const [creating, setCreating] = useState(false)
  // target 变化（再次从对话点「查看任务」而本组件未卸载时）→ 改选目标并回清父层意图。
  useEffect(() => {
    if (target) {
      setViewTaskId(target)
      onTargetConsumed()
    }
    // 仅以 target 为触发源：消费后父层置 null，不因 onTargetConsumed 引用变动而重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // 按状态分组，组内按下次触发升序（无下次的排后），再按创建时间降序。左列表据此分段。
  const groups = useMemo(() => {
    const g: Record<TaskStatus, TaskRecord[]> = {
      active: [],
      paused: [],
      completed: [],
      error: []
    }
    for (const task of tasks) g[task.status].push(task)
    const byNext = (a: TaskRecord, b: TaskRecord): number => {
      const an = a.nextRunAt ?? Number.POSITIVE_INFINITY
      const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY
      if (an !== bn) return an - bn
      return b.createdAt - a.createdAt
    }
    ;(Object.keys(g) as TaskStatus[]).forEach((k) => g[k].sort(byNext))
    return g
  }, [tasks])

  // 选中任务从列表实时派生（引用被删/刷新即自动兜底为 null → 右侧回落空态，无需手动清选中）。
  const viewTask = useMemo(
    () => tasks.find((x) => x.id === viewTaskId) ?? null,
    [tasks, viewTaskId]
  )
  // 编辑目标同样从列表派生：编辑中若任务被删（广播刷新）则记录消失 → 弹窗自然关闭。
  const editTask = useMemo(
    () => tasks.find((x) => x.id === editTaskId) ?? null,
    [tasks, editTaskId]
  )

  // 人格名（未指定 / 引用已删则回落中性占位——定时任务已不设「跟随当前对话」）。
  const personaName = (id: string | null): string => {
    if (!id) return t('tasks.personaNone')
    return personas.find((p) => p.id === id)?.name ?? t('tasks.personaNone')
  }
  // 模型完整名（服务商 · 模型）；空 / 已删则回落默认标签。
  const modelLabel = (ref: string | null): string => {
    if (!ref) return t('tasks.modelDefault')
    const idx = ref.indexOf(':')
    if (idx > 0) {
      const p = providers.find((x) => x.id === ref.slice(0, idx))
      const m = p?.models.find((x) => x.id === ref.slice(idx + 1))
      if (p && m) return `${p.name} · ${m.name}`
    }
    return ref
  }

  const doRunNow = (task: TaskRecord): void => {
    void (async () => {
      const res = await runNow(task.id)
      if (res.ok) {
        // ok:true 表示已成功派发进调度器串行队列（非「已完成」）——非阻断 toast 知会「已开始运行」，
        // 实际结果稍后落入运行历史，用户无需点确认。
        toast.show({
          title: t('tasks.runNowStarted'),
          message: t('tasks.runNowStartedHint'),
          variant: 'success'
        })
      } else {
        // 失败仍走阻断式确认框（需用户知悉原因）。
        await dialog.confirm({
          title: t('tasks.runNowFailed'),
          message: res.reason || '',
          confirmText: t('common.close')
        })
      }
    })()
  }
  const doDelete = (task: TaskRecord): void => {
    const name = task.title || t('chat.untitled')
    const heading = locale === 'en' ? `Delete task “${name}”?` : `删除定时任务 ${name} ？`
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message: t('tasks.deleteConfirm'),
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      // 删除后不必手动清 viewTaskId：viewTask 由 tasks 派生，记录消失即回落空态。
      if (ok) await remove(task.id)
    })()
  }

  return (
    <>
      <TasksRail
        groups={groups}
        viewTaskId={viewTask?.id ?? null}
        onSelect={setViewTaskId}
        onDelete={doDelete}
        onAddManual={() => setCreating(true)}
        onAddByChat={onAddByChat}
      />
      {viewTask ? (
        <TaskDetail
          key={viewTask.id}
          task={viewTask}
          personaName={personaName(viewTask.auth.personaId)}
          modelLabel={modelLabel(viewTask.auth.modelRef)}
          onEdit={() => setEditTaskId(viewTask.id)}
          onSetStatus={(s) => void setStatus(viewTask.id, s)}
          onRunNow={() => doRunNow(viewTask)}
          onDelete={() => doDelete(viewTask)}
        />
      ) : (
        <TasksEmpty hasTasks={tasks.length > 0} />
      )}
      {creating && (
        <TaskFormModal
          task={null}
          onClose={() => setCreating(false)}
          onSubmit={async (input) => {
            const res = await create(input)
            // 失败：回错误 key 给表单就地提示（不关弹窗）；成功：关表单并直选新任务（列表由广播刷新）。
            if (!res.ok) return taskErrorKey(res.error)
            setCreating(false)
            setViewTaskId(res.task.id)
            return null
          }}
        />
      )}
      {editTask && (
        <TaskFormModal
          key={editTask.id}
          task={editTask}
          onClose={() => setEditTaskId(null)}
          onSubmit={async (input) => {
            await update({ id: editTask.id, ...input })
            setEditTaskId(null)
            return null
          }}
        />
      )}
    </>
  )
}

/**
 * 日程人读摘要：按 schedule 签名 + 语言向主进程 schedule.ts 求权威描述，抽成 hook 供左列表行与
 * 右详情共用。无效日程回落提示文案，请求失败回落空串（由调用方兜底显示 cron/at 原串）。
 *
 * 传 allowPast=true：这里展示的都是**已创建任务**（已完成的一次性任务其墙钟必然已过），
 * 一次性时间过去但日程合法时仍取人读摘要，绝不把「已执行完毕」误标为「日程无效」。
 */
function useSchedulePreview(schedule: TaskSchedule): string {
  const { t, locale } = useI18n()
  const [desc, setDesc] = useState('')
  const sig = `${schedule.kind}|${schedule.at ?? ''}|${schedule.cron ?? ''}|${schedule.tz}`
  useEffect(() => {
    let alive = true
    void window.deva.tasks
      .preview(schedule, locale, true)
      .then((res) => {
        if (!alive) return
        setDesc(res.ok ? res.description : t('tasks.previewInvalid'))
      })
      .catch(() => {
        if (alive) setDesc('')
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, locale])
  return desc
}

/**
 * 左列表列（对齐角色花名册 .cf-rail）：顶部搜索 + 并排「添加任务」入口（按标题过滤），
 * 下方按状态分组列出任务行。tasks tab 下由本列 + 右详情共同占据列表列与右侧内容整块。
 */
function TasksRail({
  groups,
  viewTaskId,
  onSelect,
  onDelete,
  onAddManual,
  onAddByChat
}: {
  groups: Record<TaskStatus, TaskRecord[]>
  viewTaskId: string | null
  onSelect: (id: string) => void
  /** 右键菜单「删除」委托（含破坏性确认，实现于 TasksPane.doDelete）。 */
  onDelete: (task: TaskRecord) => void
  /** 「添加任务」→ 打开手动新建表单（TasksPane 持有弹窗态）。 */
  onAddManual: () => void
  /** 「通过对话添加」→ 新建对话并预填引导语（由外壳实现，同「通过对话添加角色」）。 */
  onAddByChat: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  // 右键菜单（对齐花名册/会话行）：定位光标处，携选中任务；点删除走 onDelete 的破坏性确认。
  const [menu, setMenu] = useState<{ x: number; y: number; task: TaskRecord } | null>(null)
  const q = query.trim().toLowerCase()
  // 按标题过滤后的分组（空词返回全部）；同时算总数以区分「全空」与「搜索无结果」。
  const shown = useMemo(() => {
    const out = {} as Record<TaskStatus, TaskRecord[]>
    let total = 0
    ;(Object.keys(groups) as TaskStatus[]).forEach((k) => {
      const list = q ? groups[k].filter((x) => (x.title || '').toLowerCase().includes(q)) : groups[k]
      out[k] = list
      total += list.length
    })
    return { out, total }
  }, [groups, q])
  const allEmpty = (Object.keys(groups) as TaskStatus[]).every((k) => groups[k].length === 0)

  return (
    <aside className="cf-rail">
      <div className="cf-rail__top">
        <div className="cf-search">
          <Search className="cf-search__icon" size={14} />
          <input
            className="cf-search__input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            aria-label={t('tasks.searchPlaceholder')}
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
        <AddMenu
          manualLabel={t('tasks.addTask')}
          chatLabel={t('tasks.addByChat')}
          onManual={onAddManual}
          onByChat={onAddByChat}
        />
      </div>

      <div className="cf-list">
        {allEmpty ? (
          <div className="cf-empty">{t('tasks.paneEmpty')}</div>
        ) : shown.total === 0 ? (
          <div className="cf-empty">{t('cf.searchNoResults')}</div>
        ) : (
          TASK_GROUP_ORDER.filter((k) => shown.out[k].length > 0).map((k) => (
            <section key={k} className="cf-trailgroup">
              <div className="cf-tasks__grouphd">
                {t(TASK_GROUP_KEY[k])}
                <span className="cf-tasks__count">{shown.out[k].length}</span>
              </div>
              {shown.out[k].map((task) => (
                <TaskRailRow
                  key={task.id}
                  task={task}
                  active={viewTaskId === task.id}
                  onClick={() => onSelect(task.id)}
                  onContext={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, task })
                  }}
                />
              ))}
            </section>
          ))
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t('tasks.actDelete'),
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => onDelete(menu.task)
            }
          ]}
        />
      )}
    </aside>
  )
}

/** 左列表单个任务行（对齐 .cf-prow）：类型图标（按状态着色）| 标题 / 人读日程。 */
function TaskRailRow({
  task,
  active,
  onClick,
  onContext
}: {
  task: TaskRecord
  active: boolean
  onClick: () => void
  /** 右键唤起删除菜单（阻默认系统菜单，定位到光标）。 */
  onContext: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const desc = useSchedulePreview(task.schedule)
  return (
    <button
      className={`cf-trow${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      <span className={`cf-trow__icon is-${task.status}`} title={t('tasks.cardTitle')}>
        <CalendarClock size={16} />
      </span>
      <div className="cf-trow__main">
        <div className="cf-trow__title">{task.title || t('chat.untitled')}</div>
        <div className="cf-trow__sched">
          <Clock size={11} />
          <span className="cf-trow__schedtext">
            {desc || task.schedule.cron || task.schedule.at || ''}
          </span>
        </div>
      </div>
    </button>
  )
}

/**
 * 右详情面（对齐角色资料卡 .cf-profile）：展示选中任务的类型/状态、日程与运行信息、任务指令、
 * 运行历史，以及操作（编辑·暂停/恢复·立即运行·删除）。日程人读摘要经 useSchedulePreview 权威求值。
 */
function TaskDetail({
  task,
  personaName,
  modelLabel,
  onEdit,
  onSetStatus,
  onRunNow,
  onDelete
}: {
  task: TaskRecord
  personaName: string
  modelLabel: string
  onEdit: () => void
  onSetStatus: (status: TaskStatus) => void
  onRunNow: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const rel = useRelativeTime()
  const desc = useSchedulePreview(task.schedule)

  const lastRun = task.runs.length > 0 ? task.runs[task.runs.length - 1] : undefined
  const lastKey =
    lastRun?.status === 'ok'
      ? 'tasks.runOk'
      : lastRun?.status === 'skipped'
        ? 'tasks.runSkipped'
        : 'tasks.runError'
  const runKey = (s: 'ok' | 'error' | 'skipped'): string =>
    s === 'ok' ? 'tasks.runOk' : s === 'skipped' ? 'tasks.runSkipped' : 'tasks.runError'
  // 运行历史按时间降序（最近在上）。
  const history = useMemo(() => [...task.runs].reverse(), [task.runs])

  // 任务指令可能很长（占位过多），做成折叠面板：标题行作开关，默认收起（不渲染指令体），点击可展开/再收起。
  const [promptOpen, setPromptOpen] = useState(false)

  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-profile">
        <div className="cf-profile__inner cf-tdetail">
          <div className={`cf-tdetail__icon is-${task.status}`}>
            <CalendarClock size={30} />
          </div>
          <div className="cf-profile__name">{task.title || t('chat.untitled')}</div>
          <div className="cf-tdetail__tags">
            <span className={`cf-tdetail__status is-${task.status}`}>
              {t(TASK_GROUP_KEY[task.status])}
            </span>
          </div>

          <div className="cf-profile__meta">
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fSchedule')}</span>
              <span className="cf-profile__v">
                {desc || task.schedule.cron || task.schedule.at || ''}
              </span>
            </div>
            {task.status === 'active' && (
              <div className="cf-profile__row">
                <span className="cf-profile__k">{t('tasks.previewNext')}</span>
                <span className="cf-profile__v">
                  {task.nextRunAt ? fmtAbs(task.nextRunAt, locale) : t('tasks.nextNever')}
                </span>
              </div>
            )}
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.lastRun')}</span>
              <span className="cf-profile__v">
                {task.lastRunAt ? (
                  <>
                    {rel(task.lastRunAt)}
                    <span
                      className={`cf-runbadge is-${lastRun?.status ?? 'error'}`}
                      title={lastRun?.error || undefined}
                    >
                      {t(lastKey)}
                    </span>
                  </>
                ) : (
                  t('tasks.lastNever')
                )}
              </span>
            </div>
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fPersona')}</span>
              <span className="cf-profile__v">{personaName}</span>
            </div>
            <div className="cf-profile__row">
              <span className="cf-profile__k">{t('tasks.fModel')}</span>
              <span className="cf-profile__v">{modelLabel}</span>
            </div>
          </div>

          <div className="cf-tdetail__section">
            <button
              type="button"
              className="cf-tdetail__prompthead"
              onClick={() => setPromptOpen((v) => !v)}
              aria-expanded={promptOpen}
            >
              <ChevronRight size={14} className={`cf-tdetail__chev${promptOpen ? ' is-open' : ''}`} />
              <span className="cf-profile__convs-label">{t('tasks.fPrompt')}</span>
            </button>
            {promptOpen && <div className="cf-tdetail__prompt">{task.prompt}</div>}
          </div>

          <div className="cf-tdetail__actions">
            <button className="cf-tdetail__act" onClick={onEdit}>
              <Pencil size={15} /> {t('tasks.actEdit')}
            </button>
            {task.status === 'active' ? (
              <button className="cf-tdetail__act" onClick={() => onSetStatus('paused')}>
                <Pause size={15} /> {t('tasks.actPause')}
              </button>
            ) : task.status === 'completed' ? null : (
              // completed 为一次性任务已触发的终态（nextRunAt=null），置回 active 不产生任何后续触发，
              // 故不给「恢复」按钮；仅 paused / error 可恢复调度。
              <button className="cf-tdetail__act" onClick={() => onSetStatus('active')}>
                <RotateCcw size={15} /> {t('tasks.actResume')}
              </button>
            )}
            <button className="cf-tdetail__act" onClick={onRunNow}>
              <Play size={15} /> {t('tasks.actRunNow')}
            </button>
            <button className="cf-tdetail__act cf-tdetail__act--danger" onClick={onDelete}>
              <Trash2 size={15} /> {t('tasks.actDelete')}
            </button>
          </div>

          <div className="cf-tdetail__section">
            <div className="cf-profile__convs-label">{t('tasks.runHistory')}</div>
            {history.length === 0 ? (
              <div className="cf-empty">{t('tasks.historyEmpty')}</div>
            ) : (
              history.map((run, i) => (
                <div key={i} className="cf-trun">
                  <span className="cf-trun__time">{fmtAbs(run.firedAt, locale)}</span>
                  <span className={`cf-runbadge is-${run.status}`} title={run.error || undefined}>
                    {t(runKey(run.status))}
                  </span>
                  {(run.summary || run.error) && (
                    <span className="cf-trun__msg">{run.summary || run.error}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 任务表单弹窗（复用 .cf-modal is-editor 编辑器骨架）——**新建 / 编辑共用一套表单**：标题/指令/日程/人格/模型。
 * 与创建确认名片同构：日程 cron 反解/拼装走共享 ../features/chat/schedule，实时 preview 校验并给人读摘要；
 * 落盘走 tasks.create / tasks.update（主进程校验日程、算首次或重算下次触发、完成/错误态改日程即重激活），
 * 成功后由 tasks:changed 刷新；失败带稳定错误码就地提示（弹窗不关，供用户改后重试）。
 * 编辑保留原任务时区（只换墙钟/cron），新建取本地时区。
 */
function TaskFormModal({
  task,
  onClose,
  onSubmit
}: {
  /** 既有任务 → 编辑态；null → 手动新建（空表单 + 每天 10:00 默认日程）。 */
  task: TaskRecord | null
  onClose: () => void
  /** 提交：成功返回 null（由调用方关闭弹窗），失败返回错误文案 key（就地提示，不关弹窗）。 */
  onSubmit: (input: {
    title: string
    prompt: string
    schedule: TaskSchedule
    auth: { personaId: string | null; modelRef: string | null }
  }) => Promise<string | null>
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const creating = task == null

  const [title, setTitle] = useState(task?.title ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? '')

  // 新建默认：人格 null → TaskPersonaSelect 自动落到首个已启用角色；模型 null → 全局默认。
  const [personaId, setPersonaId] = useState<string | null>(task?.auth.personaId ?? null)
  const [modelRef, setModelRef] = useState<string | null>(task?.auth.modelRef ?? null)

  const [saving, setSaving] = useState(false)
  // 提交失败的错误文案 key（主进程稳定错误码 → 本地化）；再次提交前清空。
  const [err, setErr] = useState<string | null>(null)

  // 编辑保留原任务时区（改日程只换墙钟/cron）；新建 / 缺失兜底本地时区。
  const tz = useMemo(
    () => task?.schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
    [task]
  )

  // 新建默认日程：每天 10:00 —— 即 ScheduleEditor 对空 cron 的预设，这里写成具体 cron，
  // 使首帧日程即合法（免得 preview 尚未回来就点「创建任务」被主进程判 invalid-cron）。
  const initialSchedule = useMemo<TaskSchedule>(
    () => (task ? { ...task.schedule, tz } : { kind: 'recurring', cron: '0 10 * * *', tz }),
    [task, tz]
  )

  // 送 preview / create / update 的日程对象：由日程编辑器（ScheduleEditor）拼好后回填。
  const [schedule, setSchedule] = useState<TaskSchedule>(initialSchedule)

  // 实时预览（轻防抖）：人读摘要 + 下次触发；严格校验（不 allowPast），把日程改到过去即时暴露为无效。
  const [preview, setPreview] = useState<PreviewScheduleResult | null>(null)
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      void window.deva.tasks
        .preview(schedule, locale)
        .then((r) => {
          if (alive) setPreview(r)
        })
        .catch(() => {
          if (alive) setPreview(null)
        })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [schedule, locale])

  const nextText = (ms: number | null): string =>
    ms == null
      ? t('tasks.previewNever')
      : new Date(ms).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')

  const scheduleInvalid = preview != null && !preview.ok
  const canSubmit = !saving && prompt.trim().length > 0 && !scheduleInvalid

  const heading = creating ? t('tasks.createTitle') : t('tasks.editTitle')

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setSaving(true)
    setErr(null)
    try {
      const failed = await onSubmit({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        auth: { personaId, modelRef }
      })
      // 成功（null）→ 由调用方关闭弹窗；失败 → 就地提示，表单保持可改。
      if (failed) setErr(failed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cf-modal__backdrop" onClick={onClose}>
      <div
        className="cf-modal is-editor"
        role="dialog"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">{heading}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cf-editor">
          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fTitle')}</label>
            <input
              className="cf-input"
              value={title}
              placeholder={t('tasks.fTitlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fSchedule')}</label>
            <ScheduleEditor initial={initialSchedule} tz={tz} onChange={setSchedule} />

            {/* 日程预览：人读摘要 + 下次触发；无效即时提示（阻断保存）。 */}
            <div className={`cf-schedprev${scheduleInvalid ? ' is-invalid' : ''}`}>
              {scheduleInvalid ? (
                <>
                  <AlertTriangle size={13} />
                  <span>{t('tasks.previewInvalid')}</span>
                </>
              ) : preview && preview.ok ? (
                <span>
                  {preview.description} · {t('tasks.previewNext')}：{nextText(preview.nextRunAt)}
                </span>
              ) : (
                <span>…</span>
              )}
            </div>
          </div>

          {/* 任务指令：与对话输入框同款内嵌盒（更高、不可拖），底部工具条内嵌人格 / 模型 chip 选择器。 */}
          <div className="cf-field">
            <label className="cf-field__label">{t('tasks.fPrompt')}</label>
            <div className="cf-box cf-box--task">
              <textarea
                value={prompt}
                placeholder={t('tasks.fPromptPlaceholder')}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="cf-box__bar">
                <TaskPersonaSelect value={personaId} onChange={setPersonaId} />
                <TaskModelSelect value={modelRef} onChange={setModelRef} />
              </div>
            </div>
          </div>

          {/* 提交失败（主进程校验未过）：复用日程预览的红字行就地提示，弹窗保持打开。 */}
          {err && (
            <div className="cf-schedprev is-invalid">
              <AlertTriangle size={13} />
              <span>{t(err)}</span>
            </div>
          )}

          <div className="cf-editor__actions">
            <button className="cf-btn" onClick={onClose}>
              {t('cf.cancel')}
            </button>
            <button className="cf-btn is-primary" disabled={!canSubmit} onClick={submit}>
              {creating ? t('tasks.confirm') : t('cf.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** tasks tab 右侧空态（未选中任务时）：对齐角色页 RosterEmpty。 */
function TasksEmpty({ hasTasks }: { hasTasks: boolean }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('tasks.paneTitle')}</div>
          <div className="cf-quick__hint">
            {hasTasks ? t('tasks.detailEmpty') : t('tasks.paneHint')}
          </div>
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
  onOpenProfile,
  onSend,
  onStop,
  onMount,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask,
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
  onOpenProfile: (id: string) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<void>
  onStop: () => void
  onMount: (path: string | null) => void
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep') => void
  /** 回应「请求挂载工作区」（path=用户选定目录 / null=暂不挂载）。 */
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** created 态定时任务名片「打开任务会话」。 */
  onOpenAutotask: (taskId: string) => void
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
  // 右侧轮次索引的数据源：只取用户消息，turn 与上面的 turnOf 同源（每遇 user +1，0 基）。
  // 正文为空（纯附件）时回落到附件名，再空则用占位文案，保证每轮都有可点的锚点。
  const tocItems = useMemo<TocItem[]>(() => {
    const out: TocItem[] = []
    let turn = -1
    for (const m of messages) {
      if (m.role !== 'user') continue
      turn++
      let full = m.blocks
        .map((b) => (b.kind === 'text' ? b.text : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!full && m.attachments?.length) full = m.attachments.map((a) => a.name).join(' ')
      if (!full) full = t('cf.toc.untitled')
      out.push({
        turn,
        text: full.length > TOC_TEXT_MAX ? full.slice(0, TOC_TEXT_MAX) + '…' : full
      })
    }
    return out
  }, [messages, t])

  // 当前所在轮（高亮）。-1 表示无（无消息时）。滚动中经 rAF 去抖重算，避免每个滚动事件都量 DOM。
  const [activeTurn, setActiveTurn] = useState(-1)
  const tocRafRef = useRef(0)
  const recomputeActive = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const nodes = el.querySelectorAll<HTMLElement>('.cf-msg.is-user[data-turn]')
    if (nodes.length === 0) {
      setActiveTurn((p) => (p === -1 ? p : -1))
      return
    }
    let hit = -1
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD) {
      // 已滚到底时强制取最后一轮：末轮下方内容往往不足以把它顶过判定线，
      // 不特判就会出现「点了最后一项却高亮上一轮」。
      hit = Number(nodes[nodes.length - 1].dataset.turn)
    } else {
      const line = el.getBoundingClientRect().top + TOC_ACTIVE_OFFSET
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].getBoundingClientRect().top > line) break
        hit = Number(nodes[i].dataset.turn)
      }
      // 全部都在判定线之下（滚到最顶）：取第一条，保证总有高亮。
      if (hit < 0) hit = Number(nodes[0].dataset.turn)
    }
    if (!Number.isInteger(hit)) hit = -1
    setActiveTurn((p) => (p === hit ? p : hit))
  }, [])
  const scheduleActive = useCallback((): void => {
    if (tocRafRef.current) return
    tocRafRef.current = requestAnimationFrame(() => {
      tocRafRef.current = 0
      recomputeActive()
    })
  }, [recomputeActive])
  useEffect(
    () => () => {
      // 清零不可省：tocRafRef 兼作「已排队」闸门，只 cancel 不复位会让闸门永久关闭，
      // 之后所有 scheduleActive() 都直接 return（StrictMode 挂载即 setup→cleanup→setup，必踩）。
      if (tocRafRef.current) {
        cancelAnimationFrame(tocRafRef.current)
        tocRafRef.current = 0
      }
    },
    []
  )

  // 面板是否常驻展开：消息列固定 --cf-main 宽且居中，右侧留白够放下面板才常驻，否则收起为细条
  // （悬停再展开为浮层），免得窄窗口下压住正文。宽度读 CSS 变量，不在 JS 里重复写死。
  const [tocOpen, setTocOpen] = useState(false)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      const raw = parseFloat(getComputedStyle(el).getPropertyValue('--cf-main'))
      const mainW = Number.isFinite(raw) && raw > 0 ? raw : 780
      const gutter = (el.clientWidth - Math.min(el.clientWidth, mainW)) / 2
      const open = gutter >= TOC_WIDTH + TOC_GAP
      setTocOpen((p) => (p === open ? p : open))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 索引面板不在 .cf-msgs 内，鼠标停在它上面滚轮什么也不会滚（面板「吞掉」滚轮，
  // 看起来就像高亮卡住不跟随）。故由面板把自己消化不掉的滚动量转发过来。
  const scrollMsgsBy = useCallback((dy: number): void => {
    const el = scrollRef.current
    if (el) el.scrollTop += dy
  }, [])

  // 跳到某一轮的用户消息：复用右键删除已标注的 data-turn 作锚点。
  const jumpToTurn = useCallback((turn: number): void => {
    const el = scrollRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(`.cf-msg.is-user[data-turn="${turn}"]`)
    if (!target) return
    const top = Math.max(
      0,
      target.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        TOC_JUMP_PAD
    )
    // 贴底态按目标位置同步算，不能等 onScroll 回填：目标与当前位置相同时一次 scroll 都不会触发，
    // 贴底态会卡在错值（§4.8 流式跟随据此决策）。
    const atBot = el.scrollHeight - top - el.clientHeight <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom(atBot)
    // 直接落位，不用 behavior:"smooth"：长对话里一路滚过去既慢又晃眼。
    el.scrollTop = top
    setActiveTurn(turn)
  }, [])

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
    scheduleActive()
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming])

  // 切换会话（Conversation 不按会话重挂载）：复位贴底并直接滚到底；同时退出选择态（选择只属当前对话）。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    setSelecting(false)
    setSelected(new Set())
    setCtxMenu(null)
    setActiveTurn(-1)
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
    scheduleActive()
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
      onAsk={onAsk}
      onPlan={onPlan}
      onMountReq={onMountReq}
      onOpenProposal={onOpenProposal}
      onOpenAutotask={onOpenAutotask}
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
      {/* .cf-convmid 只为给右侧轮次索引面板提供定位上下文（.cf-msgs 自身会滚动，面板不能放里面）。 */}
      <div className="cf-convmid">
        <div
          className="cf-msgs"
          ref={scrollRef}
          onScroll={onScroll}
          onContextMenu={onMsgsContextMenu}
        >
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
        {/* 轮次索引：只在轮次够多且非选择态时出现（选择态要让位给勾选交互）。 */}
        {!selecting && tocItems.length >= TOC_MIN_TURNS && (
          <TurnIndex
            items={tocItems}
            active={activeTurn}
            collapsed={!tocOpen}
            onJump={jumpToTurn}
            onWheelOut={scrollMsgsBy}
          />
        )}
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
          focusRoot={focusRoot}
          onMount={onMount}
          onSend={handleSend}
          onStop={onStop}
          showJump={!atBottom && messages.length > 0}
          onJump={jumpToLatest}
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
        />
      )}
    </main>
  )
}

/** 一条轮次索引项：turn 与 turnOf/groupTurns 同源的 0 基轮下标；text 已归一空白并限长。 */
interface TocItem {
  turn: number
  text: string
}

/**
 * 右侧对话轮次索引面板（对标 DeepSeek 网页版）：只索引用户消息，点击跳转、悬停看完整摘要、
 * 当前轮高亮。collapsed 时只显刻度短横线，悬停整条面板才展开为浮层文字列表——窄窗口下
 * 右侧留白不足以常驻，收起可避免压住正文。
 *
 * 摘要卡用 position:fixed 才能逃出 .cf-toc__list 的 overflow 裁剪；因此本组件与其祖先
 * 都绝不可用 transform 定位（transform 会使自身成为 fixed 的包含块，卡片就被拉回来裁掉）。
 */
function TurnIndex({
  items,
  active,
  collapsed,
  onJump,
  onWheelOut
}: {
  items: TocItem[]
  /** 当前所在轮下标；-1 表示无。 */
  active: number
  /** 右侧留白不足：收起为细竖条，悬停才展开。 */
  collapsed: boolean
  onJump: (turn: number) => void
  /** 把面板自身消化不掉的滚轮量转发给消息滚动容器（像素）。 */
  onWheelOut: (deltaY: number) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [hovering, setHovering] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // 收起态被悬停时临时展开；常驻态恒展开。展开与否决定索引项高度（收起态无文字），
  // 故须在高度实测之前就定下来。
  const open = !collapsed || hovering

  // 一屏只放 TOC_VISIBLE_MAX 条：实测第 N 条底边定上限，其余靠列表自身滚动。
  // 用 layout 副作用（而非 effect）避免先铺满再收窄的一帧抖动。
  const [maxH, setMaxH] = useState<number | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const nodes = list.querySelectorAll<HTMLElement>('.cf-toc__item')
    if (nodes.length <= TOC_VISIBLE_MAX) {
      setMaxH((p) => (p === null ? p : null))
      return
    }
    const measure = (): void => {
      // 取 rect 之差而非 offsetTop：列表已滚动时两者一起位移，差值仍是布局距离。
      const cs = getComputedStyle(list)
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const top = nodes[0].getBoundingClientRect().top
      const bottom = nodes[TOC_VISIBLE_MAX - 1].getBoundingClientRect().bottom
      const h = Math.round(bottom - top + pad)
      setMaxH((p) => (p === h ? p : h))
    }
    measure()
    // 盯住首条而非列表自身：收起↔展开时列表宽度有 0.14s 过渡，只测一次会量到过渡中途
    // 的行高（窄宽度下文字多折一行），面板就会稳定地多显几条。观察条目宽度不会因为
    // 上限生效而变化，故不存在测量回环（观察列表则可能自激）。
    const ro = new ResizeObserver(measure)
    ro.observe(nodes[0])
    return () => ro.disconnect()
  }, [items, open])

  // 轮次多到列表内部要滚动时，保证高亮项始终可见。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cf-toc__item.is-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 滚轮：轮次多到列表自己能滚时先给列表。面板不在 .cf-msgs 内，浏览器不会把滚动
  // 链到对话上，所以「滚到头之后还滚不滚对话」完全由这里决定。
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const list = listRef.current
    if (!list) return
    const room = list.scrollHeight - list.clientHeight
    const canSelf =
      room > 1 &&
      (e.deltaY < 0 ? list.scrollTop > 0 : list.scrollTop < room - 1)
    if (canSelf) return
    // 收起态（浮层盖在正文之上）：滚到头就停住，绝不转发——看索引时正文在底下跟着
    // 乱跑，既晃眼又会把高亮一路带走。常驻态面板待在右侧留白里、不遮挡正文，仍转发，
    // 保持「鼠标搁哪儿都能滚页面」的直觉，也免得停在面板上时整个界面纹丝不动。
    if (collapsed) return
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? list.clientHeight : 1
    onWheelOut(e.deltaY * unit)
  }

  return (
    <nav
      className={`cf-toc${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`}
      aria-label={t('cf.toc.title')}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => {
        setHovering(false)
      }}
    >
      <div
        className="cf-toc__list"
        ref={listRef}
        onWheel={onWheel}
        // 与 CSS 的 max-height:100% 取较小值：窗口矮于 10 条时以消息区高度为准。
        style={maxH === null ? undefined : { maxHeight: `min(${maxH}px, 100%)` }}
      >
        {items.map((it) => (
          <button
            key={it.turn}
            className={`cf-toc__item${it.turn === active ? ' is-active' : ''}`}
            aria-current={it.turn === active ? 'true' : undefined}
            title={it.text}
            onClick={() => onJump(it.turn)}
          >
            <span className="cf-toc__dash" aria-hidden />
            <span className="cf-toc__label">{it.text}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

/** 用户消息文本默认最多显示的行数，超出即折叠。 */
const USER_TEXT_LINES = 3

/**
 * 用户消息正文：默认折叠到 {@link USER_TEXT_LINES} 行，超出时给出展开/收起按钮。
 * 折叠靠 CSS line-clamp，是否溢出则须实测——文本换行取决于主区宽度，无法静态判断。
 * clamp 落在内层 .cf-msg__clamp（无内边距），气泡 padding 留在外层 .cf-msg__text。
 */
function UserText({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)

  // 只在收起态测量：此时 clientHeight 是 3 行高度、scrollHeight 是全文高度，二者不等即超出。
  // 展开态两者必然相等，故直接跳过、沿用上次判定，否则按钮会自己消失。
  useLayoutEffect(() => {
    if (expanded) return
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflow(el.scrollHeight - el.clientHeight > 1)
    measure()
    // 侧栏折叠、窗口缩放都会改变换行，需要重新判定。
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  return (
    <>
      <div className="cf-msg__text">
        {/* 折叠盒必须无内边距：气泡的下内边距会让被截断的下一行漏出「半个字」，详见 CSS 注释。 */}
        <div
          ref={ref}
          className={`cf-msg__clamp${expanded ? '' : ' is-clamped'}`}
          style={{ '--clamp-lines': String(USER_TEXT_LINES) } as React.CSSProperties}
        >
          {text}
        </div>
      </div>
      {overflow && (
        <button
          type="button"
          className="cf-msg__more"
          onClick={(e) => {
            // 选择态下整轮卡片本身可点选，展开/收起不应连带勾选。
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
        >
          {t(expanded ? 'cf.msgCollapse' : 'cf.msgExpand')}
          <ChevronDown size={12} className={expanded ? 'is-up' : undefined} />
        </button>
      )}
    </>
  )
}

/** 单条消息：IM 头像外壳 + 复用 ChatView 的 BlockView（安全渲染器不重写）。 */
function ConvMessage({
  msg,
  owner,
  active,
  dataTurn,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask
}: {
  msg: ChatMessage
  owner?: Persona
  active: boolean
  /** 该消息所属的对话轮下标（0 基）；标注在根节点上，供右键菜单定位「删除此轮」。前言/未知为 undefined。 */
  dataTurn?: number
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep') => void
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  onOpenAutotask: (taskId: string) => void
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
          {text && <UserText text={text} />}
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
              onAsk={onAsk}
              onPlan={onPlan}
              onMountReq={onMountReq}
              onOpenProposal={onOpenProposal}
              onOpenAutotask={onOpenAutotask}
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
  focusRoot,
  onMount,
  onSend,
  onStop,
  showJump,
  onJump,
  prefill,
  onPrefillConsumed
}: {
  owner?: Persona
  streaming: boolean
  focusRoot: string | null
  onMount: (path: string | null) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<void>
  onStop: () => void
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

  // 挂载 / 更换工作区（放在输入区工具条，取代原顶部头部的入口）。
  // 无论是否已挂载，点击主体都弹出目录选择：选了才更新，取消则保持现状（已挂载时不再自动卸载）。
  // 卸载改由已挂载态尾随的 ✕ 图标承担，避免「取消对话框＝卸载」的意外语义。
  const pickWorkspace = (): void => {
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
            <button
              className="cf-iconbtn"
              title={t('cf.attach')}
              aria-label={t('cf.attach')}
              onClick={() => void pickFiles()}
            >
              <Paperclip size={16} />
            </button>
            {mounted && focusRoot ? (
              <span className="cf-wschip cf-wschip--mounted is-on">
                <button
                  type="button"
                  className="cf-wschip__main"
                  onClick={pickWorkspace}
                >
                  <FolderOpen size={15} />
                  {`${basename(focusRoot)}`}
                </button>
                <GitWidget root={focusRoot} />
                <button
                  type="button"
                  className="cf-wschip__x"
                  title={t('cf.unmountHint')}
                  aria-label={t('cf.unmountHint')}
                  onClick={() => onMount(null)}
                >
                  <X size={13} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="cf-wschip"
                title={t('cf.mountHint')}
                onClick={pickWorkspace}
              >
                <FolderPlus size={15} />
                {t('cf.mountWorkspace')}
              </button>
            )}
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
  // 只列对话模型（purpose==='llm'）：决策模型（如 Jev）不生成文本，绝不可被选为对话模型。
  const groups = providers
    .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
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

  // 模型下拉：所有**对话**服务商 × 其模型 → "providerId:modelId"；空 = 跟随默认。
  // 决策模型（purpose==='decision'）不参与对话生成，排除在角色偏好模型之外。
  const modelOptions = useMemo(
    () =>
      providers
        .filter((p) => (p.purpose ?? 'llm') === 'llm')
        .flatMap((p) =>
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
  // 关窗驻留托盘：仅 Windows 呈现（macOS/Linux 关窗语义不同，主进程亦仅 win32 默认驻留）。
  const isWin = window.deva?.platform === 'win32'
  const [closeToTray, setCloseToTray] = useState<boolean>(() => {
    const v = window.deva?.config?.getSync?.().closeToTray
    return typeof v === 'boolean' ? v : true // win32 默认驻留（与主进程 close 判定一致）
  })
  const toggleTray = (): void => {
    const next = !closeToTray
    setCloseToTray(next)
    void window.deva?.config?.set?.({ closeToTray: next })
  }
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
        {isWin && (
          <div className="cf-set__row">
            <div className="cf-set__label">
              {t('settings.closeToTray')}
            </div>
            <Toggle on={closeToTray} onChange={toggleTray} />
          </div>
        )}
      </div>
    </>
  )
}

function ExtensionsPane(): React.JSX.Element {
  const { t } = useI18n()
  // 角色（persona）不在此列出：它有专属的「角色」tab 与资料卡来管理，扩展页只管技能 / MCP。
  // 子智能体亦不在此列：它是内置能力（通用 / Explore / Plan），不可配置，见 main/services/subagents.ts。
  const { skills, mcp, toggle, refresh } = useExtensions()
  // 进入扩展页即从磁盘重拉最新：技能可能经对话 create_skill、上传或直接改盘在别处新增，Provider 仅在
  // 应用启动时载入一次，故此处显式刷新，避免必须重启才能看到新技能。refresh 标识稳定，不会形成刷新循环。
  useEffect(() => {
    refresh()
  }, [refresh])

  // 钻取导航：选中某个 MCP 服务 → 进入详情编辑（对齐模型设置页的主从抽屉）。技能只读，故只有 MCP 行
  // 可点开。MCP 的新增经对话工具 / 直接改盘 ~/.deva/mcp.json，扩展页不放新增入口。
  const [openMcpId, setOpenMcpId] = useState<string | null>(null)
  const openMcp = openMcpId ? mcp.find((m) => m.id === openMcpId) : undefined

  if (openMcp) {
    return <McpEditor item={openMcp} onBack={() => setOpenMcpId(null)} />
  }

  type Item = {
    kind: 'skill' | 'mcp'
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
    )
  ]
  return (
    <>
      <h2 className="cf-pane__title">{t('activity.extensions')}</h2>
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
          {t('settings.version')} 0.1.2
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
