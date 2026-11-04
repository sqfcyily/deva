import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  AlarmClock,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
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
  ExternalLink,
  FileText,
  FileCode2,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  ArrowRightLeft,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Globe,
  Image as ImageIcon,
  Info,
  Lightbulb,
  ListChecks,
  ListFilter,
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
  Shrink,
  Bot,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  Users,
  X
} from 'lucide-react'
import { BotsPane } from './BotsPane'
import { useComposerEditor, type ComposerKey } from './composer-editor'
import { UpdateSection } from './UpdateSection'
// 关于页的应用图标：直接用安装包图标的源文件，图形只维护一份
import devaIcon from '../../../../build/icon.svg'
import './redesign.css'
import type { McpKV, McpServer, McpStatus, Persona, Skill } from '../mock/extensions'
import type {
  EffortLevel,
  GitBranch as GitBranchEntry,
  GitFailReason,
  GitGenLocale,
  GitGenModel,
  GitOpResult,
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
import { TodoCapsule } from '../features/chat/Todos'
import { BackgroundCapsule } from '../features/chat/BackgroundTasks'
import { BrowserCapsule } from '../features/browser/BrowserCapsule'
import { useDockOrder } from '../features/chat/dockOrder'
import { useBrowserState } from '../features/browser/shared'
import { ModelSetupCard } from '../features/chat/ModelSetupCard'
import { Markdown } from '../features/chat/Markdown'
import {
  useChat,
  type AgentDraft,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type SendAttachment,
  type SessionLiveState,
  type SessionMeta,
  type StreamStatus
} from '../store/chat'
import { rolesAllow, useExtensions } from '../store/extensions'
import { findActive, hasUsableModel, useModels } from '../store/models'
import {
  clampEffort,
  isToggleEffort,
  supportedEffortLevels,
  type EffortAdapter
} from '../../../shared/effort'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast, type ToastOptions } from '../components/ToastProvider'
import { Modal } from '../components/Modal'
import { Select, type SelectEntry } from '../components/Select'
import {
  COMPOSER_DEFAULT,
  ICONRAIL_W,
  ICONRAIL_W_MAC,
  ResizeHandle,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT,
  clampComposer,
  clampSidebar,
  loadLayout,
  saveLayout,
  useViewport
} from './resizable'
import {
  PersonaFace,
  USER_AVATAR_SEED,
  parseAvatarSpec,
  randomizeSpec,
  resolveSpec,
  serializeAvatarSpec,
  type AvatarSpec
} from '../components/humation'
import { useTheme } from '../theme/ThemeContext'
import { readChatFontSize, saveChatFontSize, type ChatFontSize } from '../theme/chatFontSize'
import {
  BlockView,
  CompactionNotice,
  DeliveryCards,
  LiveThinkingWindow,
  ProcessFold,
  StatusIndicator,
  Timeline,
  currentSteps,
  deriveActivity,
  groupBlocks,
  hasProcess,
  splitProcess
} from '../features/chat/blocks'
import { ModelSettings } from '../features/settings/ModelSettings'
import { AvatarEditor } from './AvatarEditor'
import { ProfilePanel } from './ProfilePanel'
import { RewindModal } from './RewindModal'
import { useProfile } from '../store/profile'

/**
 * 「对话优先」外壳（已接真实 store）。
 *
 * 形态（借鉴 IM 应用的单人对话）：
 *  - 左栏两个 tab：消息（对话列表，来自 useChat().sessions）/ 角色（花名册，来自 useExtensions().personas）
 *  - 一对话一身份：中列是「我 ↔ 某一个角色」的单人对话，头顶显示当值角色（persona 单选、首发绑定后不可改）
 *  - 角色可查看资料、可反复发起对话；「添加/编辑角色」走 PersonaEditor（round-trip upsertPersona）
 *  - 工作区可选：头部一个 chip，挂了文件夹就「聚焦中」（focusRoot），没挂就是全机通用助手
 *  - 动手全内联：复用 features/chat/blocks 的 BlockView / StatusIndicator / deriveActivity 渲染工具/权限/思考/子智能体
 *
 * 安全不变式全程不动：角色不收窄工具，每次调用都过同一闸门；聚焦挂载复用 fs.openFolder 的
 * trustRoot；Agent 文件读写与命令执行不设任何限制。旧壳（PREVIEW_CHAT_FIRST=false）零回归靠后端 personaId 缺省 gate。
 */

/* ============================ 小工具 ============================ */

/** 附件类型 → 图标。 */
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
 * 嵌进纯文本标题（如删除确认框）的名字限长：超过 max 个字符截断补「…」。按码点切，不劈开 emoji 等代理对。
 * 确认框标题是拼好的整句，CSS 省略会连带吃掉句尾的「？」，故在文本层截断。
 */
function clipName(s: string, max = 20): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s
}

/**
 * 无对话头的中列界面（快速开启 / 角色空态 / 资料卡）共用的顶部拖拽把手：一条透明、与原生标题栏同高的
 * 窗口拖拽区，补上这些界面缺失的顶部拖拽（对话视图已由 .cf-conv__head 承担）。纯装饰、无交互。
 */
function DragBar(): React.JSX.Element {
  return <div className="cf-dragbar" aria-hidden="true" />
}

const IS_MAC = window.deva.platform === 'darwin'

/**
 * macOS 左上角红绿灯（关闭/最小化/全屏）当前是否可见：可见时图标栏加宽并在顶部为它让位。
 * 全屏时系统会隐藏红绿灯，此时回到常规布局；其他平台恒为 false。
 */
function useTrafficLights(): boolean {
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    if (!IS_MAC) return
    let alive = true
    const off = window.deva.window.onFullScreen(setFullScreen)
    void window.deva.window.isFullScreen().then((on) => alive && setFullScreen(on))
    return () => {
      alive = false
      off()
    }
  }, [])
  return IS_MAC && !fullScreen
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

/** 距底 ≤ 此像素即视为「贴住底部」，留缓冲避免临界抖动。 */
const BOTTOM_THRESHOLD = 64

/**
 * 长对话分段渲染：打开对话时只渲染最后 WINDOW_TURNS 轮，滚到离已渲染内容的顶边（或跳转后的底边）
 * 不足 LOAD_MORE_PX 时再补一段同样多的轮。整条历史一次挂载的话，Markdown 解析、代码高亮与整页布局都随
 * 长度线性增长：几百轮的对话每次切换都要卡十几秒，上千轮能把渲染进程撑崩。
 */
const WINDOW_TURNS = 10
const LOAD_MORE_PX = 600

/**
 * 右侧「对话轮次索引」面板参数。纯渲染层视觉常量：不持久化、不给设置项。
 * 面板只索引用户消息（对话的锚点），轮次少时不出现，避免短对话占位。
 */
/** 触发阈值：用户消息条数 ≥ 此值才渲染面板。 */
const TOC_MIN_TURNS = 4
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
/** 图标栏的 tab：对话 / 角色 / 定时任务 / 机器人。 */
type RailTab = 'chats' | 'roster' | 'tasks' | 'bots'

export function ChatFirstShell(): React.JSX.Element {
  const {
    sessions: storedSessions,
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
    renameSession,
    setArchived,
    deleteSessions,
    deleteTurns,
    currentBinding,
    draftSession,
    mountFocus,
    respondAsk,
    respondPlan,
    respondMount,
    onInsertsReturned
  } = useChat()
  const { personas, remove, reorderPersonas } = useExtensions()
  const { tasks } = useTasks()
  const { t, locale } = useI18n()
  const dialog = useDialog()
  const toast = useToast()

  // 回合被停止或出错时还没送达的插入消息：放回所属会话的输入框（正在看就直接放进去，否则进那个会话的草稿）。
  useEffect(() => onInsertsReturned(restoreToComposer), [onInsertsReturned])

  const [railTab, setRailTab] = useState<RailTab>('chats')
  // 图标栏「对话」按钮的红点：其他对话有新消息或待你处理时亮起（与头像红点同口径）。只认列表里看得到的对话：
  // 删除正在跑的对话时回合被中止，随后的 done 仍会给它记一条未读；已归档的不再提醒（含仍待确认的名片）。
  // 不过滤就成了点开找不到的红点。
  const chatAlert = useMemo(() => {
    const visible = new Set(storedSessions.filter((s) => !s.archived).map((s) => s.id))
    return Object.entries(sessionStates).some(
      ([id, st]) => id !== currentSessionId && visible.has(id) && (st.unread || st.attention)
    )
  }, [sessionStates, currentSessionId, storedSessions])
  // 左侧对话面板宽（可拖动）：存的是用户意图值，渲染时按窗口宽再夹取——窗口缩小时自动收窄、放大后复原。
  const viewport = useViewport()
  const trafficLights = useTrafficLights()
  const railW = trafficLights ? ICONRAIL_W_MAC : ICONRAIL_W
  const [sidebarW, setSidebarW] = useState(() => loadLayout().sidebarWidth ?? SIDEBAR_DEFAULT)
  const sidebarShown = clampSidebar(sidebarW, viewport.w, railW)
  const sidebarRef = useRef(sidebarShown)
  sidebarRef.current = sidebarShown
  // 收起会话列表：只有「对话」页能收起（角色页右侧只是资料卡，收起没意义；定时任务 / 机器人页本就占满）。
  // 收起状态记住（切页再回来、重启都保持）。收起时悬停「对话」图标，列表整块浮在对话区上方（peek），
  // 点会话即切过去（列表留着，可以接着点别的，鼠标离开才收回）——不用先展开就能换对话。
  const [listCollapsed, setListCollapsed] = useState(() => loadLayout().sidebarCollapsed ?? false)
  const collapsed = railTab === 'chats' && listCollapsed
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<number | null>(null)
  const clearPeekTimer = (): void => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    peekTimer.current = null
  }
  const setCollapsed = (next: boolean): void => {
    clearPeekTimer()
    setPeek(false)
    setListCollapsed(next)
    saveLayout({ sidebarCollapsed: next || undefined })
  }
  // 浮出：停 0.2 秒才浮出（鼠标路过不弹）；离开图标与列表 0.15 秒才收回（从图标移到列表要穿过图标栏右侧
  // 约 9px 的空白；再长收回就显得拖沓。同「新建对话」悬停菜单的 0.14 秒）。
  // 已浮出时再进入只取消待收回、不排定时器——否则点了会话（收回）后排着的定时器会把它重新打开。
  const peekEnter = (): void => {
    if (!collapsed) return
    clearPeekTimer()
    if (!peek) peekTimer.current = window.setTimeout(() => setPeek(true), 200)
  }
  // 进入浮出的列表：只取消待收回。浮出只由悬停「对话」图标触发——收起过程中（或刚拖动收起）鼠标还停在
  // 列表上，不该因此又浮出来。
  const peekHover = useRef(false)
  const peekStay = (): void => {
    peekHover.current = true
    if (peek) clearPeekTimer()
  }
  // 正在浮出列表的输入框（搜索框、菜单里的筛选框）里打字：打字时鼠标常挪开、输入法候选框也会盖到指针上，
  // 这时不因鼠标离开而收回，等焦点离开输入框再说（见 peekFocusOut）。
  const typingInPeek = (): boolean => {
    const el = document.activeElement
    return el instanceof HTMLInputElement && el.closest('.cf-rail.is-peek') !== null
  }
  const peekLeave = (): void => {
    peekHover.current = false
    if (!collapsed) return
    clearPeekTimer()
    peekTimer.current = window.setTimeout(() => {
      if (!typingInPeek()) setPeek(false)
    }, 150)
  }
  // 焦点离开浮出列表里的输入框（点了别处、切走窗口）：鼠标也不在列表上就收回。
  const peekFocusOut = (): void => {
    if (peek && !peekHover.current) setPeek(false)
  }
  useEffect(() => clearPeekTimer, [])
  // 离开对话页：收回浮出列表。切换对话不收回——可以连着点开几个看，鼠标离开列表才收回。
  useEffect(() => {
    clearPeekTimer()
    setPeek(false)
  }, [railTab])
  // Esc 收回浮出列表；Ctrl+B / ⌘B 在对话页收起 / 展开会话列表。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && peek) {
        clearPeekTimer()
        setPeek(false)
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyB' && railTab === 'chats') {
        e.preventDefault()
        setCollapsed(!listCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek, railTab, listCollapsed])
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
  // 打开设置时落在哪一页（资料卡的「能力」直达设置 › 扩展，可直接进某项详情）。
  const [settingsInit, setSettingsInit] = useState<SettingsInit>({})
  const openSettings = (init: SettingsInit = {}): void => {
    setSettingsInit(init)
    setSettingsOpen(true)
  }
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

  // 对话归属的角色：未绑定、或绑定的角色已不存在（如手动删了角色文件）一律算默认角色，与主进程执行时一致
  // （见 personas.ts resolvePersonaId）。列表头像、筛选、搜索、资料卡都读这里；只改显示，不改对话里存的绑定。
  const sessions = useMemo(() => {
    if (!defaultPersonaId) return storedSessions
    const ids = new Set(personas.map((p) => p.id))
    const known = (s: SessionMeta): boolean => !!s.personaId && ids.has(s.personaId)
    return storedSessions.every(known)
      ? storedSessions
      : storedSessions.map((s) => (known(s) ? s : { ...s, personaId: defaultPersonaId }))
  }, [storedSessions, personas, defaultPersonaId])

  // 说明（去掉了旧的「自动绑定通用」effect）：从前只要当前对话未绑定且为空，就自动落一条绑定到默认身份
  // 的空会话——这会在「删空左侧所有对话」后立刻重建一条，导致永远无法真正清空、也进不了「快速开启」空态。
  // 现在改为：空对话由用户显式动作（点头像 / ＋开始对话 / 通过对话添加）才创建并落盘（见 startWith）；
  // 左侧无任何对话时，中列改渲染 QuickStart（列出全部角色，点头像直接开聊）。

  /** 当值身份（当前对话绑定的 persona；未绑定或已不存在时为默认角色，同上）。 */
  const owner = personas.find((p) => p.id === currentBinding.personaId) ?? defaultPersona

  // 左侧列表数据源：把「草稿会话」（尚未落库的空对话）并到已落库会话之前——与角色开启新对话时，该对话
  // 立即出现在聊天列表（内容可为空）。草稿 id 必不在 sessions 中（见 store.draftSession），无需去重；
  // 首发落库后 draftSession 转 null、真值并入 sessions，列表项按同 id 无缝接管。
  const railSessions = useMemo(
    () => (draftSession ? [draftSession, ...sessions] : sessions),
    [draftSession, sessions]
  )
  // 列表里一条对话都没有（已归档的不算）、右侧也没开着已归档对话 → 右侧显示快速开启页。
  const noThreads = !railSessions.some((s) => !s.archived || s.id === currentSessionId)

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
  // 主进程导航意图（tasks:navigate）：通知点击带 `{sessionId}` → 打开该对话（定时任务独占会话 / 刚回复完的对话）并回消息视图；
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
  // 标题直接写成「删除对话 xxx ？/删除角色 xxx ？」这一动作问句（比裸标题更醒目），随语言拼装；
  // 名字经 clipName 限长，过长截断补「…」，免得撑宽 / 撑高弹框。
  const deleteThread = (id: string, title: string): void => {
    const name = clipName(title || t('chat.untitled'))
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
  // 重命名对话：居中输入框，预填当前标题并全选。没改不让提交；清空也可提交（= 恢复自动标题）。
  const renameThread = (id: string, title: string): void => {
    void (async () => {
      const next = await dialog.prompt({
        title: t('cf.renameChatTitle'),
        defaultValue: title,
        placeholder: t('cf.renamePlaceholder'),
        confirmText: t('cf.renameChat'),
        validate: (v) => v.replace(/\s+/g, ' ').trim() !== title
      })
      if (next !== null) renameSession(id, next)
    })()
  }
  // 右键归档：从列表移走，提示条带「撤销」。归档的是当前对话时右侧随之打开列表第一条（见 store.setArchived），
  // 撤销则把它重新打开。名字经 clipName 限长，随语言拼装。
  const archiveThread = (id: string, title: string): void => {
    const wasCurrent = id === currentSessionId
    setArchived(id, true)
    const name = clipName(title || t('chat.untitled'))
    toast.show({
      message: locale === 'en' ? `Archived “${name}”` : `已归档「${name}」`,
      action: {
        label: t('cf.undo'),
        onClick: () => {
          setArchived(id, false)
          if (wasCurrent) openThread(id)
        }
      }
    })
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
    // 定时任务的独占对话不在此列：任务改由 Deva 执行，对话随之改挂 Deva（主进程删角色时处理）。
    const taskSessionIds = new Set(tasks.map((x) => x.sessionId))
    const relatedIds = sessions
      .filter((s) => s.personaId === id && !taskSessionIds.has(s.id))
      .map((s) => s.id)
    const shown = clipName(name)
    const heading = locale === 'en' ? `Delete persona “${shown}”?` : `删除角色 ${shown} ？`
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
    <div
      className={`cf-shell${IS_MAC ? ' is-mac' : ''}${trafficLights ? ' has-traffic-lights' : ''}`}
    >
      {/* 无独立标题栏（微信式）：最小化/最大化/关闭用系统原生窗口控件叠加（titleBarOverlay），
          此处不再自绘按钮，避免与原生按钮重影。拖拽交给图标栏与对话头。 */}
      <div
        className={`cf-body${collapsed && peek ? ' is-peeking' : ''}`}
        style={
          {
            '--cf-rail-w': `${railW}px`,
            '--cf-side': `${collapsed ? 0 : sidebarShown}px`,
            '--cf-side-open': `${sidebarShown}px`
          } as React.CSSProperties
        }
      >
        {/* 面板右缘拖拽手柄（覆盖在分隔线上，绝对定位不占网格单元）；定时任务 tab 的列表列同宽同享。
            对话页：往左拖过下限继续拖即收起（手柄随之卸下、这次拖动结束）。收起后不显示手柄：往外拖要拖够
            距离才生效、中间没有跟手的反馈，展开交给「对话」图标 / Ctrl+B。 */}
        {!collapsed && (
          <ResizeHandle
            axis="x"
            value={sidebarShown}
            title={t('cf.resizeSidebar')}
            style={{ left: `calc(${railW}px + ${sidebarShown}px)` }}
            onChange={(v) => {
              if (railTab === 'chats' && v < SIDEBAR_COLLAPSE_AT) {
                // 收起后手柄卸下、不再走 onCommit：拖到下限前改过的宽度在这里落盘。
                saveLayout({ sidebarWidth: sidebarRef.current })
                setCollapsed(true)
                return
              }
              setSidebarW(clampSidebar(v, window.innerWidth, railW))
            }}
            onCommit={() => saveLayout({ sidebarWidth: sidebarRef.current })}
            onReset={() => {
              setSidebarW(SIDEBAR_DEFAULT)
              saveLayout({ sidebarWidth: undefined })
            }}
          />
        )}
        <IconRail
          tab={railTab}
          // 点亮着的「对话」图标 = 收起 / 展开会话列表；点别的图标照常切页。
          onTab={(tab) => (tab === 'chats' && railTab === 'chats' ? setCollapsed(!listCollapsed) : setRailTab(tab))}
          listCollapsed={collapsed}
          onChatsHover={peekEnter}
          onChatsLeave={peekLeave}
          onOpenSettings={() => openSettings()}
          chatAlert={chatAlert}
        />
        {railTab === 'bots' ? (
          // 「机器人」tab：同定时任务，占满列表列 + 右侧内容（机器人列表 + 详情）。
          <BotsPane />
        ) : railTab === 'tasks' ? (
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
              onRenameThread={renameThread}
              onArchiveThread={archiveThread}
              onUnarchiveThread={(id) => setArchived(id, false)}
              onDeleteThread={deleteThread}
              onDeletePersona={deletePersona}
              onReorderPersonas={reorderPersonas}
              collapsed={collapsed}
              peek={collapsed && peek}
              onHover={peekStay}
              onLeave={peekLeave}
              onInputBlur={peekFocusOut}
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
                  onManageCaps={(ext) => openSettings({ section: 'extensions', ext })}
                />
              ) : (
                <RosterEmpty />
              )
            ) : noThreads ? (
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
                archived={!!railSessions.find((s) => s.id === currentSessionId)?.archived}
                onUnarchive={() => setArchived(currentSessionId, false)}
                attention={sessionStates[currentSessionId]?.attention ?? false}
                prefill={composerPrefill}
                onPrefill={(text) => setComposerPrefill({ text, nonce: Date.now() })}
                onPrefillConsumed={() => setComposerPrefill(null)}
              />
            )}
          </>
        )}
      </div>

      {editor && <PersonaEditor initial={editor} onClose={() => setEditor(null)} />}
      {settingsOpen && <Settings initial={settingsInit} onClose={() => setSettingsOpen(false)} />}
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
  listCollapsed,
  onChatsHover,
  onChatsLeave,
  onOpenSettings,
  chatAlert
}: {
  tab: RailTab
  /** 点亮着的「对话」图标也回调（由调用方切换会话列表的收起 / 展开）。 */
  onTab: (t: RailTab) => void
  /** 对话页的会话列表已收起：「对话」图标的提示改为「展开会话列表」，红点也显示在它上面。 */
  listCollapsed: boolean
  /** 悬停 / 离开「对话」图标（收起时据此浮出列表）。 */
  onChatsHover: () => void
  onChatsLeave: () => void
  onOpenSettings: () => void
  /** 其他对话有新消息或待你处理 → 按钮上显示红点。 */
  chatAlert: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const [profileOpen, setProfileOpen] = useState(false)
  // 亮着的「对话」图标点了是收起 / 展开，提示写明，免得点了以为列表丢了。
  const chatsLabel =
    tab !== 'chats' ? t('cf.tabChats') : listCollapsed ? t('cf.expandList') : t('cf.collapseList')
  return (
    <nav className="cf-iconrail">
      <button
        type="button"
        className="cf-iconrail__me"
        title={t('cf.profile.open')}
        aria-label={t('cf.profile.open')}
        onClick={() => setProfileOpen(true)}
      >
        <Avatar user size={34} />
      </button>
      {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
      <button
        className={`cf-navbtn${tab === 'chats' ? ' is-active' : ''}`}
        title={chatsLabel}
        aria-label={chatsLabel}
        aria-current={tab === 'chats'}
        aria-expanded={tab === 'chats' ? !listCollapsed : undefined}
        onClick={() => onTab('chats')}
        onMouseEnter={onChatsHover}
        onMouseLeave={onChatsLeave}
      >
        <MessageCircle size={20} />
        {/* 看不到会话列表时（不在对话页，或列表已收起），在导航按钮上提示其他对话的动静。 */}
        {(tab !== 'chats' || listCollapsed) && chatAlert && (
          <span className="cf-navbtn__dot" aria-hidden="true" />
        )}
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
        className={`cf-navbtn${tab === 'bots' ? ' is-active' : ''}`}
        title={t('bots.title')}
        aria-label={t('bots.title')}
        aria-current={tab === 'bots'}
        onClick={() => onTab('bots')}
      >
        <Bot size={20} />
      </button>
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
  | { x: number; y: number; kind: 'thread'; id: string; title: string; archived: boolean }
  | { x: number; y: number; kind: 'persona'; id: string; name: string }

/* ============================ 左栏：列表列（对话 / 角色） ============================ */
/** 对话列表的一项筛选条件：角色 id，或挂载文件夹路径（NO_FOLDER = 未挂载文件夹）。 */
interface ConvFilter {
  kind: 'role' | 'folder'
  value: string
}
const NO_FOLDER = ''
const folderKeyOf = (s: SessionMeta): string => s.focusRoot || NO_FOLDER
// 同一类里选了多个是「任一」，角色与文件夹之间是「同时满足」；没选即不限。
const passRoles = (s: SessionMeta, roles: string[]): boolean =>
  !roles.length || roles.includes(s.personaId ?? '')
const passFolders = (s: SessionMeta, folders: string[]): boolean =>
  !folders.length || folders.includes(folderKeyOf(s))
/**
 * 列表搜索词（消息 / 角色 tab 各一份）与对话筛选：切换时不清空，由用户手动清。放在模块级，切到定时任务 /
 * 机器人（Rail 卸载）再回来仍在；不跨重启。
 */
const railSearchMemo: { query: Record<'chats' | 'roster', string>; filters: ConvFilter[] } = {
  query: { chats: '', roster: '' },
  filters: []
}

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
  onRenameThread,
  onArchiveThread,
  onUnarchiveThread,
  onDeleteThread,
  onDeletePersona,
  onReorderPersonas,
  collapsed,
  peek,
  onHover,
  onLeave,
  onInputBlur
}: {
  tab: 'chats' | 'roster'
  sessions: SessionMeta[]
  personas: Persona[]
  currentSessionId: string
  sessionStates: Record<string, SessionLiveState>
  viewPersonaId: string | null
  onOpenThread: (id: string) => void
  onOpenProfile: (id: string) => void
  /** 以该角色发起一条全新对话（复用 startWith）：角色行右键「开始对话」与搜索行「新建对话」浮层共用。 */
  onStartPersona: (id: string) => void
  onAddPersona: () => void
  onAddPersonaByChat: () => void
  onNewChatFromThread: (id: string) => void
  /** 重命名对话（弹框输入新标题）；title 为当前标题。 */
  onRenameThread: (id: string, title: string) => void
  /** 归档（从列表移走，提示条可撤销）/ 移回对话列表。 */
  onArchiveThread: (id: string, title: string) => void
  onUnarchiveThread: (id: string) => void
  onDeleteThread: (id: string, title: string) => void
  onDeletePersona: (id: string, name: string) => void
  onReorderPersonas: (ids: string[]) => void
  /** 会话列表已收起（列宽归零、列表藏在对话区下面）。 */
  collapsed: boolean
  /** 收起时浮出：整块浮在对话区上方。 */
  peek: boolean
  /** 鼠标进出列表（浮出时据此决定收回）。右键菜单、新建菜单都是列表的子元素，停在上面不算离开。 */
  onHover: () => void
  onLeave: () => void
  /** 焦点离开列表里的输入框（且没落在列表内别处）：浮出时据此决定收回。 */
  onInputBlur: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  // 右键菜单态（对话/角色行共用一个，同一时刻至多一个）。
  const [menu, setMenu] = useState<RowMenu | null>(null)
  // 搜索词：对话 / 角色 tab 共用一个输入框，但各记各的（检索对象不同，残留词会误导），切 tab 不清空。
  const [queries, setQueries] = useState(railSearchMemo.query)
  const query = queries[tab]
  const setQuery = (v: string): void => setQueries((qs) => (qs[tab] === v ? qs : { ...qs, [tab]: v }))
  // 对话筛选（只在消息 tab）：按选中先后排列，空输入框按退格撤掉最后一项。与消息 tab 的搜索词同进退——
  // 浮出列表收回、从列表新建对话时一并清空。
  const [filters, setFilters] = useState<ConvFilter[]>(railSearchMemo.filters)
  const [filterOpen, setFilterOpen] = useState(false)
  // 已归档对话：从「新建对话」浮层底部进入，在列表这一栏里列出，顶部「←」返回。已归档的不进列表、搜索与筛选。
  const [archiveView, setArchiveView] = useState(false)
  // 右键归档的次数：每归档一次加一，NewChatMenu 据此在 + 右上角短暂亮一枚归档角标，提示去这里找回。
  const [archiveHint, setArchiveHint] = useState(0)
  // 各对话在内置浏览器里开着几个网页（对话行上打地球徽标）；整栏订阅一次，不让每行各自监听
  const browserState = useBrowserState()
  const browserPages = useMemo(() => {
    const n: Record<string, number> = {}
    for (const tab of browserState?.tabs ?? []) n[tab.sessionId] = (n[tab.sessionId] ?? 0) + 1
    return n
  }, [browserState?.tabs])
  const liveSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions])
  const archivedSessions = useMemo(
    () => sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )
  // 最后一个已归档对话被移回或删除：入口随之隐藏，自动回到对话列表。
  useEffect(() => {
    if (archiveView && archivedSessions.length === 0) setArchiveView(false)
  }, [archiveView, archivedSessions.length])
  useEffect(() => {
    railSearchMemo.query = queries
    railSearchMemo.filters = filters
  }, [queries, filters])
  // 花名册拖拽态：dragId=正被拖动的角色；dropTarget=当前悬停的落点行与半区（驱动放置指示线）。
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  )
  const clearFilters = (): void => {
    setFilters((fs) => (fs.length ? [] : fs))
    setFilterOpen(false)
  }
  // 切 tab 只收起筛选面板（面板只属于消息 tab），搜索词与筛选都保留。
  useEffect(() => {
    setFilterOpen(false)
  }, [tab])
  const asideRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 收起后浮出列表收回时：连带关掉在它里面打开的右键菜单（否则菜单留在隐藏的列表里，下次浮出时它的全屏
  // 透明背板跟着回来，第一下点击被背板吃掉）；清空搜索词与筛选、退出已归档对话（浮出列表是临时的，下次浮出
  // 不该还是筛过的样子）；焦点若还在列表里（如搜索框）也移走，免得接着打字打进看不见的框。
  useEffect(() => {
    if (!collapsed || peek) return
    setMenu(null)
    setQuery('')
    clearFilters()
    setArchiveView(false)
    const el = document.activeElement
    if (el instanceof HTMLElement && asideRef.current?.contains(el)) el.blur()
  }, [collapsed, peek])
  // 删掉的角色从筛选里剔除（否则列表一直是空的，面板里又找不到它来取消）。
  useEffect(() => {
    setFilters((fs) => {
      const next = fs.filter((f) => f.kind !== 'role' || personas.some((p) => p.id === f.value))
      return next.length === fs.length ? fs : next
    })
  }, [personas])
  // 筛选条件变了，列表回到顶部看结果。
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [filters])
  // 筛选面板：点面板、筛选按钮、已选标签以外的地方（含输入框，点它就是要打字）或按 Esc 收起。
  // 不用全屏背板：点对话行时收起面板的同时照常打开对话。
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent): void => {
      const inside =
        e.target instanceof Element &&
        e.target.closest('.cf-filter, .cf-search__filter')
      if (!inside) setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])
  const roleIds = useMemo(() => filters.filter((f) => f.kind === 'role').map((f) => f.value), [filters])
  const folderKeys = useMemo(
    () => filters.filter((f) => f.kind === 'folder').map((f) => f.value),
    [filters]
  )
  const toggleFilter = (kind: ConvFilter['kind'], value: string): void =>
    setFilters((fs) =>
      fs.some((f) => f.kind === kind && f.value === value)
        ? fs.filter((f) => !(f.kind === kind && f.value === value))
        : [...fs, { kind, value }]
    )
  // 从列表新建对话：清空搜索与筛选，保证新对话出现在列表里。
  const startFresh = (fn: () => void): void => {
    setQuery('')
    clearFilters()
    fn()
  }
  // 筛选面板的选项（只在打开时算）：有对话的角色按花名册顺序，挂过的文件夹按最近使用；已选的即便没有对话了
  // 也列出来，好取消。数字是在另一类条件下的对话数，为 0 置灰（仍可点）。
  const filterOptions = useMemo(() => {
    if (!filterOpen) return null
    const roles = personas
      .filter((p) => roleIds.includes(p.id) || liveSessions.some((s) => s.personaId === p.id))
      .map((p) => ({
        persona: p,
        n: liveSessions.filter((s) => s.personaId === p.id && passFolders(s, folderKeys)).length
      }))
    const paths: string[] = []
    for (const s of [...liveSessions].sort((a, b) => b.updatedAt - a.updatedAt))
      if (s.focusRoot && !paths.includes(s.focusRoot)) paths.push(s.focusRoot)
    for (const k of folderKeys) if (k !== NO_FOLDER && !paths.includes(k)) paths.push(k)
    const names = paths.map(basename)
    const count = (key: string): number =>
      liveSessions.filter((s) => folderKeyOf(s) === key && passRoles(s, roleIds)).length
    const folders = paths.map((path, i) => ({
      key: path,
      name: names[i],
      // 同名文件夹附上级目录名区分。
      hint:
        names.filter((n) => n === names[i]).length > 1
          ? basename(path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''))
          : '',
      n: count(path)
    }))
    // 从没挂过文件夹就不出文件夹一栏（只剩「未挂载」一项，筛了等于没筛）。
    const none = count(NO_FOLDER)
    if (paths.length && (none || folderKeys.includes(NO_FOLDER)))
      folders.push({ key: NO_FOLDER, name: t('cf.filterNoFolder'), hint: '', n: none })
    return { roles, folders }
  }, [filterOpen, personas, liveSessions, roleIds, folderKeys, t])
  // 已选条件的说明（搜索框里只写总数，选了什么挂在悬停与读屏上）：「角色：…」「文件夹：…」各一行。
  const pickedRoles = roleIds
    .map((id) => personas.find((p) => p.id === id))
    .filter((p): p is Persona => !!p)
  const sep = locale === 'en' ? ', ' : '、'
  const colon = locale === 'en' ? ': ' : '：'
  const folderNames = folderKeys
    .map((k) => (k === NO_FOLDER ? t('cf.filterNoFolder') : basename(k)))
    .join(sep)
  const roleNames = pickedRoles.map((p) => p.name).join(sep)
  const filterLines = [
    pickedRoles.length ? `${t('cf.filterRoles')}${colon}${roleNames}` : '',
    folderKeys.length ? `${t('cf.filterFolders')}${colon}${folderNames}` : ''
  ].filter(Boolean)
  // 归一化后的检索词（去空白 + 小写）；空则视为不过滤。
  const q = query.trim().toLowerCase()
  // 消息列表按最近更新降序，先按筛选条件，再按检索词过滤（标题 + 所属角色名 + 挂载的文件夹名，均大小写不敏感）。
  const ordered = useMemo(() => {
    const sorted = [...liveSessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((s) => passRoles(s, roleIds) && passFolders(s, folderKeys))
    if (!q) return sorted
    return sorted.filter((s) => {
      const owner = personas.find((p) => p.id === s.personaId)
      return (
        s.title.toLowerCase().includes(q) ||
        (owner ? owner.name.toLowerCase().includes(q) : false) ||
        (s.focusRoot ? basename(s.focusRoot).toLowerCase().includes(q) : false)
      )
    })
  }, [liveSessions, personas, q, roleIds, folderKeys])
  // 角色列表按检索词过滤（角色名 + 简介，均大小写不敏感）；空词返回全部。
  const shownPersonas = useMemo(() => {
    if (!q) return personas
    return personas.filter(
      (p) => p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
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
  // 对话行（对话列表与已归档对话共用）：右键菜单记下是否已归档，菜单项随之不同。
  const threadRow = (s: SessionMeta): React.JSX.Element => (
    <ThreadRow
      key={s.id}
      session={s}
      owner={personas.find((p) => p.id === s.personaId)}
      state={sessionStates[s.id]}
      browserPages={browserPages[s.id] ?? 0}
      active={s.id === currentSessionId}
      onClick={() => onOpenThread(s.id)}
      onContext={(e) => {
        e.preventDefault()
        setMenu({
          x: e.clientX,
          y: e.clientY,
          kind: 'thread',
          id: s.id,
          title: s.title || '',
          archived: !!s.archived
        })
      }}
    />
  )
  return (
    <aside
      ref={asideRef}
      className={`cf-rail${collapsed ? ' is-collapsed' : ''}${peek ? ' is-peek' : ''}`}
      aria-hidden={collapsed && !peek ? true : undefined}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onBlur={(e) => {
        const to = e.relatedTarget
        if (e.target instanceof HTMLInputElement && !(to instanceof Node && e.currentTarget.contains(to))) onInputBlur()
      }}
    >
      {/* 顶部：搜索占满整行；消息 tab 并排「新建对话」入口（悬停出角色列表），角色 tab 并排「添加角色」入口（悬停/点击出二选一弹层）。
          消息 tab 的搜索框最左是筛选按钮（代替放大镜）；选了条件后换成已选的角色头像（堆叠）与文件夹（多个时标数字），
          点它们同样打开筛选面板。 */}
      <div className="cf-rail__top">
        {tab === 'chats' && archiveView ? (
          // 已归档对话：顶行换成「← 已归档对话 N」，返回即回到对话列表（搜索词与筛选原样保留）。
          <>
            <button
              className="cf-rail__back"
              title={t('cf.backToChats')}
              aria-label={t('cf.backToChats')}
              onClick={() => setArchiveView(false)}
            >
              <ArrowLeft size={16} />
            </button>
            <span className="cf-rail__title">{t('cf.archivedChats')}</span>
            <span className="cf-rail__count">{archivedSessions.length}</span>
          </>
        ) : (
          <>
          <div className={`cf-search${tab === 'chats' ? ' cf-search--filter' : ''}`}>
            {tab !== 'chats' ? (
              <Search className="cf-search__icon" size={14} />
            ) : (
              // 选了条件仍是同一个按钮：原位加底色、图标后接已选总数，图标不换不挪，选择前后不跳。
              <button
                className={`cf-search__filter${filters.length ? ' is-active' : ''}`}
                title={filters.length ? filterLines.join('\n') : t('cf.filter')}
                aria-label={
                  filters.length ? filterLines.join(locale === 'en' ? '; ' : '；') : t('cf.filter')
                }
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((o) => !o)}
              >
                <ListFilter size={15} />
                {filters.length > 0 && filters.length}
              </button>
            )}
            <input
              className="cf-search__input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === 'chats' ? t(filters.length ? 'cf.search' : 'cf.searchChats') : t('cf.searchRoster')
              }
              aria-label={t('cf.search')}
            />
            {(query || filters.length > 0) && (
              <button
                className="cf-search__clear"
                title={filters.length ? t('cf.clearSearch') : t('common.close')}
                aria-label={filters.length ? t('cf.clearSearch') : t('common.close')}
                onClick={() => {
                  setQuery('')
                  clearFilters()
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {tab === 'chats' && (
            <NewChatMenu
              personas={personas}
              archivedCount={archivedSessions.length}
              archiveHint={archiveHint}
              onStart={(id) => startFresh(() => onStartPersona(id))}
              onOpenArchive={() => {
                setFilterOpen(false)
                setArchiveView(true)
              }}
            />
          )}
          {tab === 'roster' && (
            <AddMenu
              manualLabel={t('cf.addPersona')}
              chatLabel={t('cf.addByChat')}
              onManual={onAddPersona}
              onByChat={onAddPersonaByChat}
            />
          )}
          </>
        )}
        {/* 筛选面板：外观同统一下拉框的浮层，角色与文件夹两栏，点选即时生效、面板不收起。选中项铺浅主题色底（同对话列表的当前行），不用行尾对勾。 */}
        {tab === 'chats' && !archiveView && filterOptions && (
          <div className="select-menu cf-filter" role="menu" aria-label={t('cf.filter')}>
            <div className="select-menu__group">{t('cf.filterRoles')}</div>
            {filterOptions.roles.map(({ persona: p, n }) => {
              const on = roleIds.includes(p.id)
              return (
                <button
                  key={p.id}
                  className={`select-menu__opt cf-filter__opt${on ? ' is-on' : ''}${!n && !on ? ' is-dim' : ''}`}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  // 不抢输入框的焦点（浮出列表靠它判断是否在打字）。
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFilter('role', p.id)}
                >
                  <span className="select-ava">
                    <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} />
                  </span>
                  <span className="select-menu__main">
                    <span className="select-menu__name">{p.name}</span>
                  </span>
                  <span className="cf-filter__count">{n}</span>
                </button>
              )
            })}
            {filterOptions.folders.length > 0 && (
              <>
                <div className="select-menu__sep" />
                <div className="select-menu__group">{t('cf.filterFolders')}</div>
                {filterOptions.folders.map(({ key, name, hint, n }) => {
                  const on = folderKeys.includes(key)
                  return (
                    <button
                      key={key || '\0'}
                      className={`select-menu__opt cf-filter__opt${on ? ' is-on' : ''}${!n && !on ? ' is-dim' : ''}`}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      title={key || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleFilter('folder', key)}
                    >
                      <span className="cf-filter__icon">
                        {key === NO_FOLDER ? <FolderMinus size={15} /> : <Folder size={15} />}
                      </span>
                      <span className="select-menu__main">
                        <span className="select-menu__name">
                          {name}
                          {hint && <span className="cf-filter__hint"> · {hint}</span>}
                        </span>
                      </span>
                      <span className="cf-filter__count">{n}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* 角色 tab：角色为空只会是还没加载完（默认角色 Deva 删不掉），先留空，不落到「未找到匹配项」。 */}
      <div className="cf-list" ref={listRef}>
        {tab === 'chats' && archiveView ? (
          archivedSessions.map(threadRow)
        ) : tab === 'chats' ? (
          ordered.length === 0 ? (
            <div className="cf-empty">
              {q || filters.length ? t('cf.searchNoResults') : t('chat.noSessions')}
              {filters.length > 0 && (
                <button className="cf-empty__action" onClick={clearFilters}>
                  {t('cf.filterClear')}
                </button>
              )}
            </div>
          ) : (
            ordered.map(threadRow)
          )
        ) : personas.length === 0 ? null : shownPersonas.length === 0 ? (
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
            menu.kind === 'thread' && menu.archived
              ? [
                  {
                    label: t('cf.unarchive'),
                    icon: <ArchiveRestore size={14} />,
                    onClick: () => onUnarchiveThread(menu.id)
                  },
                  {
                    label: t('cf.deleteChat'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => onDeleteThread(menu.id, menu.title)
                  }
                ]
              : menu.kind === 'thread'
              ? [
                  {
                    label: t('cf.newChat'),
                    icon: <Plus size={14} />,
                    onClick: () => startFresh(() => onNewChatFromThread(menu.id))
                  },
                  {
                    label: t('cf.renameChat'),
                    icon: <Pencil size={14} />,
                    onClick: () => onRenameThread(menu.id, menu.title)
                  },
                  {
                    label: t('cf.archive'),
                    icon: <Archive size={14} />,
                    // 进行中不能归档（灰显 + 悬停说明）：归档后它在看不见的地方跑完，红点却指向列表里找不到的对话。
                    // 反过来已归档的对话一开始新一轮就会移回列表（主进程 emitTurnStart），故「进行中」与「已归档」互斥。
                    disabled: sessionStates[menu.id]?.streaming === true,
                    title: sessionStates[menu.id]?.streaming ? t('cf.archiveBusy') : undefined,
                    onClick: () => {
                      setArchiveHint((n) => n + 1)
                      onArchiveThread(menu.id, menu.title)
                    }
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
type CtxEntry =
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
function ContextMenu({
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

/**
 * 分支名基础校验（git check-ref-format 的常见规则）：不合规时「创建」按钮置灰，其余细则交给 git 报错。
 * 拒绝前导 `-` 同时杜绝名字被 git 当成命令行选项。
 */
function isValidBranchName(raw: string): boolean {
  const s = raw.trim()
  if (!s || s === '@' || /^[-./]/.test(s) || /[/.]$/.test(s) || s.endsWith('.lock')) return false
  if (s.includes('..') || s.includes('@{') || s.includes('//') || s.includes('/.')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(s)
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
 * 菜单复用 ContextMenu（视口定位 + 越界夹回），始终只显示一级：点「分支」原地换成分支列表（含合并分支 / 新建分支），
 * 点某个分支再换成它的操作（切换 / 重命名 / 删除）。「提交」开 CommitModal。
 */
type GitMenuView =
  | { kind: 'main' }
  | { kind: 'branches' }
  | { kind: 'merge' }
  | { kind: 'branch'; branch: GitBranchEntry }

function GitWidget({ root, streaming }: { root: string; streaming: boolean }): React.JSX.Element | null {
  const { t, locale } = useI18n()
  const toast = useToast()
  const dialog = useDialog()
  const { activeModel, hasKey } = useModels()
  const { available, status, busy, refresh } = useGitStatus(root)

  // 一轮结束（正常完成 / 中断 / 出错，streaming 由 true 落为 false）后刷新一次：
  // 本轮可能改了文件，pill 上的状态与提交框的改动清单随之更新。
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])

  const [menu, setMenu] = useState<{ x: number; y: number; view: GitMenuView } | null>(null)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [commitOpen, setCommitOpen] = useState(false)
  const [opBusy, setOpBusy] = useState(false)
  const pillRef = useRef<HTMLButtonElement>(null)

  if (!available || !status || !status.isRepo) return null

  const label = status.detached ? t('cf.git.detached') : status.branch || t('cf.git.noBranch')
  const fmt = (key: string, name: string): string => t(key).replace('{name}', name)

  // 锚点取 pill 上边缘（留 4px 间隙）；ContextMenu 以 openUp 把它当底边向上浮出，
  // 避免菜单向下遮挡下方的输入区/角色卡（挂载 chip 贴近视口底部）。
  // 打开前先拉分支列表（本地命令，很快），使「分支」视图点开即有内容。
  const openMenu = async (): Promise<void> => {
    const el = pillRef.current
    if (!el) return
    try {
      setBranches(await window.deva.git.branches(root))
    } catch {
      setBranches([])
    }
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top - 4, view: { kind: 'main' } })
  }

  // 切换菜单视图：ContextMenu 点击时先 onClose（置 null）再 onClick，故这里直接写入完整状态覆盖之。
  const go = (view: GitMenuView): void => {
    if (menu) setMenu({ x: menu.x, y: menu.y, view })
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

  // 新建分支：基于当前 HEAD 创建并立即切过去（git checkout -b），未提交的改动随之带到新分支。
  const createBranch = async (): Promise<void> => {
    const name = await dialog.prompt({
      title: t('cf.git.createBranchTitle'),
      message: t('cf.git.createBranchHint'),
      label: t('cf.git.newBranchName'),
      placeholder: 'feature/…',
      confirmText: t('cf.git.createBranchDo'),
      validate: isValidBranchName
    })
    if (!name) return
    await run(() => window.deva.git.createBranch(root, name, true), fmt('cf.git.doneCreateBranch', name))
  }

  // 合并到当前分支：冲突时不当作普通失败——提示去解决或中止，并给「中止合并」快捷按钮。
  const mergeBranch = async (ref: string): Promise<void> => {
    setOpBusy(true)
    try {
      const r = await window.deva.git.merge(root, ref)
      if (r.ok) toast.show({ variant: 'success', message: fmt('cf.git.doneMerge', ref) })
      else if (r.reason === 'conflict')
        toast.show({
          variant: 'warning',
          title: t('cf.git.mergeConflictTitle'),
          message: t('cf.git.mergeConflictHint'),
          action: { label: t('cf.git.abortMerge'), onClick: () => void abortMerge(false) }
        })
      else toast.show(gitErrorToast(t, r))
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      setOpBusy(false)
      void refresh()
    }
  }

  // 中止合并会丢弃已做的冲突解决，菜单入口先确认（toast 快捷按钮紧随合并失败，直接执行）。
  const abortMerge = async (confirm: boolean): Promise<void> => {
    if (
      confirm &&
      !(await dialog.confirm({
        title: t('cf.git.abortMergeTitle'),
        message: t('cf.git.abortMergeHint'),
        variant: 'danger',
        confirmText: t('cf.git.abortMerge')
      }))
    )
      return
    await run(() => window.deva.git.mergeAbort(root), t('cf.git.doneAbortMerge'))
  }

  // 删除本地分支：先确认 → -d；未合并则再确认一次（写明会丢失的提交数）→ -D。
  const deleteBranch = async (name: string): Promise<void> => {
    const ok = await dialog.confirm({
      title: fmt('cf.git.deleteBranchTitle', name),
      message: t('cf.git.deleteBranchHint'),
      variant: 'danger',
      confirmText: t('cf.git.delete')
    })
    if (!ok) return
    const done = fmt('cf.git.doneDeleteBranch', name)
    let first: GitOpResult
    try {
      first = await window.deva.git.deleteBranch(root, name, false)
    } catch {
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
      return
    }
    if (!first.ok && first.reason === 'unmerged') {
      const force = await dialog.confirm({
        title: t('cf.git.forceDeleteTitle'),
        message: t('cf.git.forceDeleteHint').replace('{name}', name).replace('{n}', String(first.count ?? 0)),
        variant: 'danger',
        confirmText: t('cf.git.forceDelete')
      })
      if (force) await run(() => window.deva.git.deleteBranch(root, name, true), done)
      return
    }
    await run(async () => first, done)
  }

  const renameBranch = async (oldName: string): Promise<void> => {
    const name = await dialog.prompt({
      title: t('cf.git.renameBranchTitle'),
      label: t('cf.git.newBranchName'),
      defaultValue: oldName,
      confirmText: t('cf.git.rename'),
      validate: (v) => isValidBranchName(v) && v.trim() !== oldName
    })
    if (!name) return
    await run(() => window.deva.git.renameBranch(root, oldName, name), fmt('cf.git.doneRenameBranch', name))
  }

  const deleteRemoteBranch = async (b: GitBranchEntry): Promise<void> => {
    if (!b.remote) return
    const remote = b.remote
    const ok = await dialog.confirm({
      title: fmt('cf.git.deleteRemoteTitle', b.name),
      message: t('cf.git.deleteRemoteHint'),
      variant: 'danger',
      confirmText: t('cf.git.delete')
    })
    if (!ok) return
    await run(
      () => window.deva.git.deleteRemoteBranch(root, remote, b.name.slice(remote.length + 1)),
      fmt('cf.git.doneDeleteBranch', b.name)
    )
  }

  // 切换分支；远程分支：本地已有同名分支则直接切过去，否则建跟踪分支（checkout --track）。
  const checkout = (b: GitBranchEntry): void => {
    const done = t('cf.git.doneCheckout')
    if (!b.remote) {
      void run(() => window.deva.git.checkout(root, b.name), done)
      return
    }
    const short = b.name.slice(b.remote.length + 1)
    if (branches.some((x) => !x.remote && x.name === short))
      void run(() => window.deva.git.checkout(root, short), done)
    else void run(() => window.deva.git.checkoutRemote(root, b.name), done)
  }

  const spacer = <span style={{ width: 14, display: 'inline-block' }} />
  const filterItem: CtxEntry[] =
    branches.length > 8 ? [{ kind: 'filter', placeholder: t('cf.git.filterBranches') }] : []
  // 分支列表（本地 / 远程分组）：onPick 决定点击某分支后做什么（进操作视图 / 直接合并）
  const branchList = (list: GitBranchEntry[], onPick: (b: GitBranchEntry) => void): CtxEntry[] => {
    const local = list.filter((b) => !b.remote)
    const remote = list.filter((b) => b.remote)
    const row = (b: GitBranchEntry): CtxEntry => ({
      label: b.name,
      icon: b.current ? <Check size={14} /> : spacer,
      title: b.upstream ? `↑ ${b.upstream}` : undefined,
      onClick: () => onPick(b)
    })
    return [
      ...(local.length ? [{ kind: 'section' as const, label: t('cf.git.localBranches') }, ...local.map(row)] : []),
      ...(remote.length ? [{ kind: 'section' as const, label: t('cf.git.remoteBranches') }, ...remote.map(row)] : [])
    ]
  }

  const view = menu?.view ?? { kind: 'main' as const }
  let items: CtxEntry[]
  if (view.kind === 'branches') {
    items = [
      ...filterItem,
      { label: t('cf.git.createBranch'), icon: <Plus size={14} />, onClick: () => void createBranch() },
      {
        label: t('cf.git.mergeBranch'),
        icon: <GitMerge size={14} />,
        disabled: status.mergeInProgress,
        title: status.mergeInProgress ? t('cf.git.mergeBusy') : undefined,
        onClick: () => go({ kind: 'merge' })
      },
      ...branchList(branches, (b) => go({ kind: 'branch', branch: b }))
    ]
  } else if (view.kind === 'merge') {
    items = [
      ...filterItem,
      { kind: 'section', label: fmt('cf.git.mergeIntoTitle', label) },
      ...branchList(
        branches.filter((b) => !b.current),
        (b) => void mergeBranch(b.name)
      )
    ]
  } else if (view.kind === 'branch') {
    const b = view.branch
    items = [
      { kind: 'section', label: b.name },
      {
        label: t('cf.git.checkout'),
        icon: <ArrowRightLeft size={14} />,
        disabled: b.current,
        title: b.current ? t('cf.git.currentBranch') : undefined,
        onClick: () => checkout(b)
      },
      ...(b.remote
        ? []
        : [{ label: t('cf.git.renameBranch'), icon: <Pencil size={14} />, onClick: () => void renameBranch(b.name) }]),
      { kind: 'separator' },
      b.remote
        ? { label: t('cf.git.deleteRemoteBranch'), icon: <Trash2 size={14} />, danger: true, onClick: () => void deleteRemoteBranch(b) }
        : {
            label: t('cf.git.deleteBranch'),
            icon: <Trash2 size={14} />,
            danger: true,
            disabled: b.current,
            title: b.current ? t('cf.git.deleteCurrentHint') : undefined,
            onClick: () => void deleteBranch(b.name)
          }
    ]
  } else {
    items = [
      ...(status.mergeInProgress
        ? [
            { label: t('cf.git.abortMerge'), icon: <X size={14} />, danger: true, onClick: () => void abortMerge(true) },
            { kind: 'separator' as const }
          ]
        : []),
      { label: t('cf.git.pull'), icon: <ArrowDownToLine size={14} />, onClick: () => void run(() => window.deva.git.pull(root), t('cf.git.donePull')) },
      { label: t('cf.git.push'), icon: <ArrowUpFromLine size={14} />, onClick: () => void run(() => window.deva.git.push(root, status.upstream ? null : status.branch), t('cf.git.donePush')) },
      { label: t('cf.git.fetch'), icon: <Download size={14} />, onClick: () => void run(() => window.deva.git.fetch(root), t('cf.git.doneFetch')) },
      { label: t('cf.git.commit'), icon: <GitCommitHorizontal size={14} />, onClick: () => setCommitOpen(true) },
      { kind: 'separator' },
      { label: t('cf.git.branches'), icon: <GitBranch size={14} />, onClick: () => go({ kind: 'branches' }) },
      { label: t('cf.git.refresh'), icon: <RefreshCw size={14} />, onClick: () => void refresh() }
    ]
  }

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
        onClick={() => void openMenu()}
        disabled={opBusy}
      >
        <GitBranch size={13} />
        <span className="cf-gitchip__branch" title={label}>
          {label}
        </span>
        {status.mergeInProgress && <span className="cf-gitchip__merge">{t('cf.git.merging')}</span>}
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
          key={view.kind === 'branch' ? `branch:${view.branch.name}` : view.kind}
          items={items}
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
 * 已挂载 chip 的文件夹名按钮：点击向上浮出菜单（同 GitWidget 的 openUp 定位）——复制路径 / 在系统文件管理器中打开。
 * 刻意不提供「更换文件夹」：换目录会让系统提示词变化、提示缓存整段失效，不鼓励频繁切换；确需更换就点 ✕ 卸载后重新挂载。
 */
function WorkspaceMenu({ root }: { root: string }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const openMenu = (): void => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenu({ x: r.left, y: r.top - 4 })
  }

  // 优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copyPath = (): void => {
    void window.deva.clipboard.writeText(root).catch(() => {
      void navigator.clipboard?.writeText(root).catch(() => {})
    })
  }

  const reveal = (): void => {
    void window.deva.fs
      .revealFolder(root)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('cf.ws.revealFailed') })
      })
  }

  const platform = window.deva.platform
  const revealLabel = t(
    platform === 'win32' ? 'cf.ws.revealWin' : platform === 'darwin' ? 'cf.ws.revealMac' : 'cf.ws.revealOther'
  )

  const items = [
    { label: t('cf.ws.copyPath'), icon: <Copy size={14} />, onClick: copyPath },
    { label: revealLabel, icon: <ExternalLink size={14} />, onClick: reveal }
  ]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="cf-wschip__main"
        title={root}
        aria-label={t('cf.ws.menuHint')}
        aria-haspopup="menu"
        onClick={openMenu}
      >
        <FolderOpen size={15} />
        <span className="cf-wschip__name">{basename(root)}</span>
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} openUp items={items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}

/**
 * 流式生成中的展示清洗：模型偶尔用代码块 / 引号包裹整段，边生成边剥掉开头的围栏行与引号、
 * 末尾正在长出来的收尾围栏，免得这些符号先闪出来再消失。结束后以主进程清洗的全文为准。
 */
function cleanStreamingCommit(raw: string): string {
  let s = raw.trimStart()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    if (nl < 0) return ''
    s = s.slice(nl + 1).replace(/\n?`{0,3}$/, '')
  }
  return s.replace(/^["“]/, '')
}

/**
 * 轻量提交框（v1 只做「暂存全部改动 + 提交」，不含逐文件 diff/staging）：
 * 顶部一行改动数量摘要；一个信息 textarea；「AI 生成」按当前模型走 generateCommitMessage（无模型/无密钥则灰掉）。
 * 生成时文字流式填入输入框（只读），按钮变「停止生成」；中断保留已生成部分，关闭提交框也会中断。
 * 有冲突时禁止提交并提示先解决——避免把未合并状态提交进去。
 */
function CommitModal({
  root,
  status: initialStatus,
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
  // 进行中的生成请求 id：停止生成 / 关闭提交框时据此中断。
  const genIdRef = useRef<string | null>(null)
  const msgRef = useRef<HTMLTextAreaElement>(null)

  // 关闭提交框（卸载）时中断仍在进行的生成，免得主进程白跑到超时。
  useEffect(
    () => () => {
      if (genIdRef.current) void window.deva.git.cancelCommitMessage(genIdRef.current)
    },
    []
  )

  // 流式填入时输入框跟到末尾。
  useEffect(() => {
    const el = msgRef.current
    if (gen && el) el.scrollTop = el.scrollHeight
  }, [gen, msg])

  // 打开即重取一次状态：父级快照可能早于本轮对话 / 用户在外部新建的文件，避免改动数与可提交态过期。
  const [status, setStatus] = useState(initialStatus)
  useEffect(() => {
    let alive = true
    window.deva.git
      .status(root)
      .then((st) => {
        if (alive && st.isRepo) setStatus(st)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root])

  // 变更集：跨 staged/unstaged/conflicts 按路径去重计数。
  const changed = useMemo(() => {
    const set = new Set<string>()
    for (const f of status.staged) set.add(f.path)
    for (const f of status.unstaged) set.add(f.path)
    for (const f of status.conflicts) set.add(f.path)
    return set.size
  }, [status])

  const hasConflicts = status.conflicts.length > 0
  const canCommit = Boolean(msg.trim()) && changed > 0 && !hasConflicts && !busy && !gen

  const stopGenerate = (): void => {
    if (genIdRef.current) void window.deva.git.cancelCommitMessage(genIdRef.current)
  }

  const generate = async (): Promise<void> => {
    if (!model || genIdRef.current) return
    const id = `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const prev = msg
    let raw = ''
    genIdRef.current = id
    setGen(true)
    setMsg('')
    const off = window.deva.git.onCommitMessageDelta((rid, text) => {
      if (rid !== id) return
      raw += text
      setMsg(cleanStreamingCommit(raw))
    })
    try {
      const r = await window.deva.git.generateCommitMessage(root, model, locale, id)
      if (r.ok && r.text) setMsg(r.text)
      else {
        // 失败，或中断时一个字都还没出来：还原生成前的内容；中断不算错误、不提示。
        setMsg(prev)
        if (!r.aborted) toast.show(gitErrorToast(t, r))
      }
    } catch {
      setMsg(prev)
      toast.show({ variant: 'error', message: gitReasonText(t, 'error') })
    } finally {
      off()
      genIdRef.current = null
      setGen(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!canCommit) return
    setBusy(true)
    try {
      // 提交前再取一次最新状态，暂存其中全部未暂存改动（未跟踪文件已含在 unstaged 内），再提交——
      // 弹窗打开期间新增的文件也不会漏。
      const fresh = await window.deva.git.status(root)
      const latest = fresh.isRepo ? fresh : status
      if (latest.conflicts.length > 0) {
        setStatus(latest)
        return
      }
      const toStage = latest.unstaged.map((f) => f.path)
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
        ref={msgRef}
        className="input cf-commit__msg"
        value={msg}
        placeholder={t('cf.git.commitPlaceholder')}
        onChange={(e) => setMsg(e.target.value)}
        readOnly={gen}
        autoFocus
      />
      <div className="cf-commit__bar">
        {gen ? (
          <button type="button" className="btn btn--ghost" onClick={stopGenerate}>
            <Square size={12} fill="currentColor" />
            {t('cf.git.aiStop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void generate()}
            disabled={!model || busy}
            title={model ? t('cf.git.aiHint') : t('cf.git.aiNoModel')}
          >
            <Sparkles size={14} />
            {t('cf.git.aiGenerate')}
          </button>
        )}
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
 * 搜索行 + 按钮浮层的开合逻辑（AddMenu / NewChatMenu 共用）：悬停或点击展开，
 * 离开略延迟收起以容忍按钮→浮层途中的空档（避免闪烁），choose 选中即收起并执行。
 */
function useHoverMenu(): {
  open: boolean
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void }
  show: () => void
  choose: (fn: () => void) => void
} {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }
  useEffect(() => cancelClose, [])

  return {
    open,
    hoverProps: {
      onMouseEnter: () => {
        cancelClose()
        setOpen(true)
      },
      onMouseLeave: scheduleClose
    },
    show: () => setOpen(true),
    choose: (fn) => {
      cancelClose()
      setOpen(false)
      fn()
    }
  }
}

/**
 * 「新建对话」入口（消息 tab 搜索行右侧）：外观与交互同 AddMenu，浮层列出花名册全部角色，
 * 点某个角色即以其开启一条全新对话（onStart → startWith）。角色多时角色列表内滚动；有已归档对话时
 * 底部隔线固定一行「已归档对话」与数量（不随列表滚走），点了在列表这一栏打开已归档对话。
 */
function NewChatMenu({
  personas,
  archivedCount,
  archiveHint,
  onStart,
  onOpenArchive
}: {
  personas: Persona[]
  archivedCount: number
  /** 右键归档的次数（Rail 每归档一次加一）；变化时在 + 右上角短暂亮归档角标。 */
  archiveHint: number
  onStart: (personaId: string) => void
  onOpenArchive: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { open, hoverProps, show, choose } = useHoverMenu()
  // 归档角标：亮约 1.5 秒后淡出；连续归档重新计时并轻跳一下。鼠标停在 + / 浮层上时一直亮着（浮层底部
  // 「已归档对话」同时标主题色），移开即熄。只认挂载后的变化——切 tab、进出已归档视图会重新挂载本组件，
  // 不能把之前的计数当成新归档。撤销到一条已归档都不剩时也熄（浮层里已没有那一行）。
  const [hint, setHint] = useState(false)
  const seenHint = useRef(archiveHint)
  const hovered = useRef(false)
  const badgeRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (archiveHint === seenHint.current) return
    seenHint.current = archiveHint
    hovered.current = false
    if (hint && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      badgeRef.current?.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
        { duration: 220, easing: 'ease-out' }
      )
    }
    setHint(true)
    // 只随归档次数触发；hint 仅用来判断是否已经亮着
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveHint])
  useEffect(() => {
    if (!hint) return
    if (open) {
      hovered.current = true
      return
    }
    if (hovered.current) {
      hovered.current = false
      setHint(false)
      return
    }
    const timer = window.setTimeout(() => setHint(false), 1500)
    return () => window.clearTimeout(timer)
  }, [hint, open, archiveHint])
  const hinting = hint && archivedCount > 0
  return (
    <div className="cf-addmenu" {...hoverProps}>
      <button
        className="cf-rail__addbtn"
        title={t('cf.newChat')}
        aria-label={t('cf.newChat')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
      >
        <Plus size={16} />
      </button>
      <span ref={badgeRef} className={`cf-addmenu__badge${hinting ? ' is-on' : ''}`} aria-hidden="true">
        <Archive size={10} strokeWidth={2.6} />
      </span>
      {open && (personas.length > 0 || archivedCount > 0) && (
        <div className="cf-addmenu__pop cf-addmenu__pop--scroll" role="menu">
          {personas.length > 0 && (
            <div className="cf-addmenu__list">
              {personas.map((p) => (
                <button
                  key={p.id}
                  className="cf-addmenu__item cf-addmenu__item--persona"
                  role="menuitem"
                  // 名字 / 专长过长时单行省略，悬停 title 给出全文。
                  title={p.desc ? `${p.name} · ${p.desc}` : p.name}
                  onClick={() => choose(() => onStart(p.id))}
                >
                  <Avatar persona={p} size={28} />
                  {/* 与花名册行同构：角色名 + 专长（未填写则只显示名字）。 */}
                  <span className="cf-addmenu__main">
                    <span className="cf-addmenu__name">{p.name}</span>
                    {p.desc && <span className="cf-addmenu__desc">{p.desc}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* 没有已归档对话时连同分隔线一起不显示。 */}
          {archivedCount > 0 && (
            <>
              {personas.length > 0 && <div className="cf-addmenu__sep" />}
              <button
                className={`cf-addmenu__item${hinting ? ' is-hint' : ''}`}
                role="menuitem"
                onClick={() => choose(onOpenArchive)}
              >
                <Archive size={15} className="cf-addmenu__icon" />
                <span className="cf-addmenu__label">{t('cf.archivedChats')}</span>
                <span className="cf-addmenu__count">{archivedCount}</span>
                <ChevronRight size={14} className="cf-addmenu__chev" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 「添加」入口（角色花名册 / 定时任务共用）：一个 + 图标，鼠标悬停或点击弹出二选一浮层——
 * 手动添加（打开编辑器表单）/ 通过对话添加（新建对话、Agent 引导创建）。
 * 开合逻辑见 useHoverMenu。文案由调用方按对象给（角色 / 任务）。
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
  const { open, hoverProps, show, choose } = useHoverMenu()

  return (
    <div className="cf-addmenu" {...hoverProps}>
      <button
        className="cf-rail__addbtn"
        title={manualLabel}
        aria-label={manualLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
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
  browserPages,
  active,
  onClick,
  onContext
}: {
  session: SessionMeta
  owner?: Persona
  state?: SessionLiveState
  /** 这个对话在内置浏览器里开着几个网页（>0 时标题旁打地球徽标）。 */
  browserPages: number
  active: boolean
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const rel = useRelativeTime()
  const draft = useDraftPreview(session.id)
  // 任务独占会话（sessionId = `task-…`）：行上打一枚静态「⏰ 定时」徽标以区别普通对话。
  // 「有新运行未读」（state.unread）与待你处理（state.attention）都在头像右上角打红点。
  const isTask = session.id.startsWith('task-')
  return (
    <button
      className={`cf-thread${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      {/* 对话中（streaming）→ 头像上一道扫光指示；有新消息 / 待你处理 → 右上角红点。
          正在查看的对话不打红点（内容就在眼前），已归档的也不打（归档即不再提醒）。 */}
      <Avatar
        persona={owner}
        size={38}
        busy={state?.streaming}
        attention={!active && !session.archived && state?.attention}
        unread={!active && !session.archived && state?.unread}
      />
      <div className="cf-thread__main">
        {/* 上：对话标题与时间（主视觉，醒目显示对话内容）；下：角色名，挂了文件夹则换成文件夹名（悬停看完整路径，角色看头像）。 */}
        <div className="cf-thread__top">
          <span className="cf-thread__title">{session.title || t('chat.untitled')}</span>
          <span className="cf-thread__time">{rel(session.updatedAt)}</span>
        </div>
        {/* 下行：左边是角色名 / 文件夹名 / 草稿，右边是状态图标，与上方时间右缘对齐（右侧一列：上时间、下状态）。 */}
        <div className="cf-thread__sub">
          {/* 这个会话里有没发出的内容（且不是正在看的会话）：下行换成红色「[草稿]」+ 内容开头，提醒切回去接着写。 */}
          {draft && !active ? (
            <div className="cf-thread__owner">
              <span className="cf-thread__draft">{t('cf.draftTag')}</span>
              {draft}
            </div>
          ) : session.focusRoot ? (
            <div className="cf-thread__owner cf-thread__owner--ws" title={session.focusRoot}>
              <Folder size={11} />
              <span className="cf-thread__wsname">{basename(session.focusRoot)}</span>
            </div>
          ) : (
            <div className="cf-thread__owner">{owner?.name ?? ''}</div>
          )}
          {(isTask || browserPages > 0) && (
            <span className="cf-thread__badges">
              {isTask && (
                <span className="cf-thread__badge" title={t('cf.tabTasks')}>
                  <AlarmClock size={13} />
                </span>
              )}
              {/* 开着内置浏览器的网页。地球是满圆，比闹钟显大，缩 1px 让两者观感一致 */}
              {browserPages > 0 && (
                <span
                  className="cf-thread__badge"
                  title={t('browser.threadBadge').replace('{n}', String(browserPages))}
                >
                  <Globe size={12} />
                </span>
              )}
            </span>
          )}
        </div>
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
        <div className="cf-prow__name">
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
 * 默认角色 Deva 删不掉，花名册只在加载完成前为空，此时网格先留空。
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
          <div className="cf-quick__grid">
            {personas.map((p) => (
              <button
                key={p.id}
                className="cf-qcard"
                onClick={() => onStart(p.id)}
                title={p.desc || p.name}
              >
                <Avatar persona={p} size={48} />
                <span className="cf-qcard__name">{p.name}</span>
                {p.desc && <span className="cf-qcard__desc">{p.desc}</span>}
              </button>
            ))}
          </div>
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

  // 人格名：未指定 / 引用已删 → 显示默认角色 Deva（执行时同样回落 Deva，见主进程 runScheduledTurn）。
  const personaName = (id: string | null): string => {
    const p =
      personas.find((x) => x.id === id) ?? personas.find((x) => x.id === DEFAULT_PERSONA_ID)
    return p?.name ?? t('tasks.personaNone')
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
      if (res.ok && res.already) {
        // 同一任务已在运行 / 排队：主进程没有重复入队，只知会一下（不是错误）。
        const running = res.already === 'running'
        toast.show({
          title: t(running ? 'tasks.runNowAlreadyRunning' : 'tasks.runNowAlreadyQueued'),
          message: t(running ? 'tasks.runNowAlreadyRunningHint' : 'tasks.runNowAlreadyQueuedHint')
        })
      } else if (res.ok) {
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

/** 任务详情运行历史默认展示的条数（最近 N 次），超出折叠在「展开全部」后。 */
const HISTORY_PREVIEW = 5

type TaskRunStatus = TaskRecord['runs'][number]['status']

/**
 * 运行状态图标的圆内符号（圆框共用）：对勾 / 叉 / i（中止）/ 双箭头（追赶跳过）。
 * 中止与对话里「已停止本轮回复」的提示同一个图标（lucide Info）、同为黄色，两处说的是同一件事。
 */
const RUN_ICON_MARK: Record<TaskRunStatus, React.ReactNode> = {
  ok: <path d="m9 12 2 2 4-4" />,
  error: (
    <>
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  aborted: (
    <>
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  skipped: (
    <>
      <path d="m8 9 3 3-3 3" />
      <path d="m13 9 3 3-3 3" />
    </>
  )
}

/**
 * 运行状态图标（任务详情「上次」与运行历史共用，对比稿 design/run-status-icons.html 方案 A）：同宽线框圆形，
 * 文字徽标长短不一会把后面的摘要挤得对不齐。悬停显示状态文字，失败时连同原因。
 */
function RunStatusIcon({
  status,
  label,
  detail
}: {
  status: TaskRunStatus
  label: string
  detail?: string
}): React.JSX.Element {
  const title = detail ? `${label}：${detail}` : label
  return (
    <span className={`cf-runicon is-${status}`} role="img" aria-label={title} title={title}>
      <svg
        viewBox="0 0 24 24"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        {RUN_ICON_MARK[status]}
      </svg>
    </span>
  )
}

/**
 * 右详情面（对齐角色资料卡 .cf-profile）：展示选中任务的类型/状态、日程与运行信息、运行历史，
 * 以及操作（编辑·暂停/恢复·立即运行·删除）。任务指令不在此展示，点「编辑」查看。
 * 日程人读摘要经 useSchedulePreview 权威求值。
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
  const runKey = (s: TaskRunStatus): string =>
    s === 'ok'
      ? 'tasks.runOk'
      : s === 'skipped'
        ? 'tasks.runSkipped'
        : s === 'aborted'
          ? 'tasks.runAborted'
          : 'tasks.runError'
  // 运行历史按时间降序（最近在上）。
  const history = useMemo(() => [...task.runs].reverse(), [task.runs])
  // 默认只列最近 HISTORY_PREVIEW 次，超出时给「展开全部」开关（组件按 task.id 取 key，切任务即复位收起）。
  const [historyAll, setHistoryAll] = useState(false)
  const shownHistory = historyAll ? history : history.slice(0, HISTORY_PREVIEW)

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
                {/* 时间与状态都取运行历史的最后一条（含「立即运行」）：task.lastRunAt 只在按日程触发时更新，
                    拿它配最后一条的状态会对不上。 */}
                {lastRun ? (
                  <>
                    {rel(lastRun.firedAt)}
                    <RunStatusIcon
                      status={lastRun.status}
                      label={t(runKey(lastRun.status))}
                      detail={lastRun.error}
                    />
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
              <div className="cf-truns">
                {shownHistory.map((run, i) => (
                  <div key={i} className="cf-trun">
                    <span className="cf-trun__time">{fmtAbs(run.firedAt, locale)}</span>
                    <RunStatusIcon status={run.status} label={t(runKey(run.status))} detail={run.error} />
                    {(run.summary || run.error) && (
                      <span className="cf-trun__msg">{run.summary || run.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {history.length > HISTORY_PREVIEW && (
              <button
                type="button"
                className="cf-trun__more"
                onClick={() => setHistoryAll((v) => !v)}
                aria-expanded={historyAll}
              >
                {historyAll
                  ? t('tasks.historyCollapse')
                  : t('tasks.historyShowAll').replace('{n}', String(history.length))}
              </button>
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
  archived,
  onUnarchive,
  attention,
  prefill,
  onPrefill,
  onPrefillConsumed
}: {
  owner?: Persona
  currentSessionId: string
  messages: ChatMessage[]
  streaming: boolean
  streamStatus: StreamStatus
  focusRoot: string | null
  onOpenProfile: (id: string) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  onStop: () => void
  onMount: (path: string | null) => void
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  /** 回应「请求挂载工作区」（path=用户选定目录 / null=暂不挂载）。 */
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** created 态定时任务名片「打开任务会话」。 */
  onOpenAutotask: (taskId: string) => void
  /** 按「轮」删除选中轮次（含破坏性确认）；返回是否已删（true=退出选择态并清空选择）。 */
  onDeleteTurns: (turnIndices: number[]) => Promise<boolean>
  /** 当前对话已归档：标题栏显示「已归档」与「移回对话列表」。 */
  archived: boolean
  onUnarchive: () => void
  /** 当前会话有待用户处理的卡片（问答 / 计划 / 挂载请求）：此时不开回滚面板。 */
  attention: boolean
  /** 输入框预填（一次性、不发送）；null 表示无待预填。 */
  prefill: { text: string; nonce: number } | null
  /** 请求预填输入框（回滚恢复对话后把该轮原问题放回去）。 */
  onPrefill: (text: string) => void
  /** Composer 消费预填后回调，父层据此置空，避免重挂载时复活旧预填。 */
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 一个可用模型都没有（首次安装的常态）→ 对话区显示「接入模型」引导卡；须等配置载入，否则启动瞬间误判。
  const { providers: modelProviders, ready: modelsReady } = useModels()
  const needModelSetup = modelsReady && !hasUsableModel(modelProviders)

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
  // 各轮首条消息（用户消息）的下标：分段渲染按整轮取边界。
  const turnStart = useMemo(() => {
    const arr: number[] = []
    messages.forEach((m, i) => {
      if (m.role === 'user') arr.push(i)
    })
    return arr
  }, [messages])
  const lastTurn = turnStart.length - 1
  /** 第 turn 轮的首条消息下标；第 0 轮及更早从 0 起，带上首轮之前的前言（压缩摘要等）。 */
  const startOfTurn = (turn: number): number => (turn <= 0 ? 0 : turnStart[turn])
  /** 第 turn 轮的末条消息下标。 */
  const endOfTurn = (turn: number): number =>
    turn + 1 < turnStart.length ? turnStart[turn + 1] - 1 : messages.length - 1

  // 分段渲染的范围（见 WINDOW_TURNS）：首末两轮的轮下标，to 为 null 即一直到最新（含此后新到的轮）。
  // 换了对话（sid 不符）回到默认的最后几轮；同一对话的消息整份重建（删轮 / 回滚 / 压缩后重载）时沿用原范围，
  // 停在原来那片内容附近，超出现有轮数的部分收拢到末尾。不合规时在渲染中就地改正（React 允许组件在渲染中
  // 更新自身状态），不先按旧范围画一遍——换对话时那一遍就是整条历史。
  const [win, setWin] = useState<{ sid: string; from: number; to: number | null } | null>(null)
  let range = messages.length > 0 && win && win.sid === currentSessionId ? win : null
  if (messages.length > 0) {
    const fromTurn = range ? Math.min(range.from, lastTurn) : lastTurn - WINDOW_TURNS + 1
    const toTurn = range && range.to !== null && range.to < lastTurn ? Math.max(range.to, fromTurn) : null
    if (!range || range.from !== fromTurn || range.to !== toTurn) {
      range = { sid: currentSessionId, from: fromTurn, to: toTurn }
      setWin(range)
    }
  }
  const from = range ? startOfTurn(range.from) : 0
  const to = range && range.to !== null ? endOfTurn(range.to) : messages.length - 1
  /** 已渲染到最新一条：不在时（跳转到较早的轮后）不跟随新内容、不显示底部状态行，「回到最新」常显。 */
  const isTail = to === messages.length - 1
  // 补上更早一段后要保持的「距底距离」（内容加在上方，按距底距离落位，看着的内容不动）。
  const restoreRef = useRef<number | null>(null)
  // 跳转目标轮还没渲染：先换范围，渲染后再落位。
  const pendingJumpRef = useRef<number | null>(null)
  // 从中间一段回到最新：换回最后几轮后直接落到底。
  const pendingBottomRef = useRef(false)
  const loadEarlier = (): void => {
    if (!range || from <= 0) return
    const el = scrollRef.current
    if (el) restoreRef.current = el.scrollHeight - el.scrollTop
    setWin({ ...range, from: range.from - WINDOW_TURNS })
  }
  const loadLater = (): void => {
    if (!range || range.to === null) return
    const next = range.to + WINDOW_TURNS
    setWin({ ...range, to: next >= lastTurn ? null : next })
  }
  /** 回到最后几轮（下一次渲染落到底）。 */
  const resetToTail = (): void => {
    pendingBottomRef.current = true
    setWin(null)
  }
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

  // 检查点回滚面板：null=关闭；turn=null 从列表开始，否则直达该轮详情（右键「回到此处」）。
  // 三个入口（/rewind、双击 Esc、右键）共用 canRewind：流式中或有待处理卡片时一律不开。
  const [rewind, setRewind] = useState<{ turn: number | null } | null>(null)
  const canRewind = !streaming && !attention
  const openRewind = (turn: number | null = null): boolean => {
    if (!canRewind) return false
    setRewind({ turn })
    return true
  }
  // 某轮提问原文（不含附件）：面板在回滚前调用，回滚后该轮消息就不在了。
  const promptOf = (turn: number): string => {
    let k = -1
    for (const m of messages) {
      if (m.role !== 'user') continue
      if (++k === turn) return m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    }
    return ''
  }

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


  // 滚到某一轮的用户消息（须已渲染）：复用右键删除已标注的 data-turn 作锚点。
  const scrollToTurn = (turn: number): void => {
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
    const atBot = isTail && el.scrollHeight - top - el.clientHeight <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom(atBot)
    // 直接落位，不用 behavior:"smooth"：长对话里一路滚过去既慢又晃眼。
    el.scrollTop = top
    setActiveTurn(turn)
  }
  // 跳到某一轮：已渲染就直接滚过去；还没渲染则改为从该轮起渲染一段（不把中间的轮全渲染出来），渲染后再落位，
  // 它上方的内容随即按滚到顶部补上。
  const jumpToTurn = (turn: number): void => {
    const i = turnStart[turn]
    if (i === undefined) return
    if (i >= from && i <= to) {
      scrollToTurn(turn)
      return
    }
    const end = turn + WINDOW_TURNS - 1
    pendingJumpRef.current = turn
    setWin({ sid: currentSessionId, from: turn, to: end >= lastTurn ? null : end })
  }
  // 换了渲染范围之后、绘制之前落位：补上更早一段时保持距底距离，跳转则滚到目标轮，回到最新则落到底。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoreRef.current !== null) {
      el.scrollTop = el.scrollHeight - restoreRef.current
      restoreRef.current = null
    }
    if (pendingJumpRef.current !== null) {
      const turn = pendingJumpRef.current
      pendingJumpRef.current = null
      scrollToTurn(turn)
    }
    if (pendingBottomRef.current) {
      pendingBottomRef.current = false
      el.scrollTop = el.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win])

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
    setRewind(null)
    setActiveTurn(-1)
    restoreRef.current = null
    pendingJumpRef.current = null
    pendingBottomRef.current = false
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [currentSessionId])

  // 换了渲染范围或消息整份重建后（刚打开 / 刚补过一段 / 刚跳转 / 删轮后）离边缘仍不远（内容填不满一屏等）：
  // 接着补，直到够滚动或到头。排在上面两个滚到底的副作用之后，量的是落位后的位置。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (from > 0 && el.scrollTop < LOAD_MORE_PX) loadEarlier()
    else if (!isTail && el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_PX) loadLater()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, messages])

  // 监听用户滚动：据距底距离更新「是否贴底」，离已渲染内容的边缘不远时补一段。程序化滚到底同样触发，结果仍为贴底、幂等。
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBot = isTail && dist <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom((prev) => (prev === atBot ? prev : atBot))
    scheduleActive()
    if (from > 0 && el.scrollTop < LOAD_MORE_PX) loadEarlier()
    else if (!isTail && dist < LOAD_MORE_PX) loadLater()
  }

  // 内容变矮或可视区变高后已到底（如上滚后收起展开的工作过程 / 思考，页面缩短、下方再无内容）：滚动位置常常
  // 没变，不触发 onScroll，贴底态停在「未贴底」，「回到最新」一直挂着。故在尺寸变化时补判一次。只补回到底部
  // 这一向：内容变高时不动贴底态，否则流式新内容撑高的那一刻（滚到底的副作用还没跑）会被误判为离底、断掉跟随。
  useEffect(() => {
    const el = scrollRef.current
    const inner = el?.firstElementChild
    if (!el || !inner || !isTail) return
    const ro = new ResizeObserver(() => {
      // 贴底时可视区变矮（如输入框上方多出一排胶囊：浏览器 / 待办 / 后台任务）：立刻贴回底部。否则最新的步骤、思考
      // 被挤到可视区下面，要等下一次内容更新才滚回来——Deva 正在执行耗时的步骤时，那一行会一直被挡着
      if (stickRef.current) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight
        return
      }
      if (el.scrollHeight - el.scrollTop - el.clientHeight > BOTTOM_THRESHOLD) return
      stickRef.current = true
      setAtBottom(true)
    })
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [isTail])

  // 回到最新：平滑滚到底并恢复自动跟随。正看着跳转过去的一段时，换回最后几轮直接落到底，不滚过中间。
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    if (isTail) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else resetToTail()
  }

  // 发送后必看到自己的消息与回复：无论此刻是否上滚，都恢复贴底跟随。
  const handleSend = (text: string, attachments?: SendAttachment[]): Promise<boolean> => {
    stickRef.current = true
    setAtBottom(true)
    if (!isTail) resetToTail()
    return onSend(text, attachments)
  }

  // 底部工作状态行。本轮已有「工作过程」折叠条时，常规的「正在做什么 + 计时」已在折叠条里，只剩等待作答 /
  // 重连 / 压缩这些特殊状态；它们放进这条消息的末尾，紧跟步骤与卡片——放在消息列表下面的话，进行中消息底部
  // 撑住的空白（见 ConvMessage）会把它和上面的步骤隔开。还没有折叠条时照常放在列表下方。
  // 回复还什么都没出（请求中）时也放进这条消息，就在角色名下面、正文将出现的位置，显示为三个跳动的点；
  // 正文或思考一到即被替换。
  const lastMsg = messages[messages.length - 1]
  const folded = streaming && lastMsg?.role === 'assistant' && hasProcess(lastMsg.blocks)
  const blank =
    streaming &&
    lastMsg?.role === 'assistant' &&
    lastMsg.blocks.every((b) => b.kind === 'step' || (b.kind === 'text' && !b.text.trim()))
  const statusInMsg = folded || blank
  const statusLine = streaming ? (
    <StatusIndicator
      activity={deriveActivity(messages)}
      status={streamStatus}
      folded={folded}
      pending={blank}
      onStop={onStop}
    />
  ) : null

  // 单条消息渲染（选择态与常态复用；选择态下 active 恒 false，因选择只在非流式时可用）。
  // turn：常态渲染传入，标注到根 data-turn 供右键定位；选择态用卡片自身处理点击，无需传。
  const renderMsg = (m: ChatMessage, i: number, turn?: number): React.JSX.Element => (
    <ConvMessage
      key={m.id}
      msg={m}
      owner={owner}
      active={!selecting && streaming && i === messages.length - 1}
      latest={i === messages.length - 1}
      elapsedSec={i === messages.length - 1 ? streamStatus.elapsedSec : 0}
      footer={statusInMsg && !selecting && i === messages.length - 1 ? statusLine : undefined}
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
          <div className="cf-idbtn__name">{owner?.name ?? ''}</div>
        </button>
        {archived && (
          <>
            <span className="cf-conv__tag">
              <Archive size={11} />
              {t('cf.archivedTag')}
            </span>
            <button className="cf-conv__headbtn" onClick={onUnarchive}>
              <ArchiveRestore size={13} />
              {t('cf.unarchive')}
            </button>
          </>
        )}
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
              <>
                <div className="cf-empty">
                  {owner ? (owner.desc ? `${owner.name} · ${owner.desc}` : owner.name) : ''}
                </div>
                {needModelSetup && <ModelSetupCard />}
              </>
            ) : selecting ? (
              // 选择态：按「轮」分组，每轮一张可勾选卡片；前言（turn<0）原样呈现、不可选。只画已渲染范围内的轮
              // （范围按整轮取，各轮要么整轮在内、要么整轮在外）。
              groupTurns(messages)
                .filter((g) => g.from >= from && g.to - 1 <= to)
                .map((g) => {
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
                {messages.slice(from, to + 1).map((m, k) => renderMsg(m, from + k, turnOf[from + k]))}
                {isTail && !statusInMsg && statusLine}
                {/* 已有对话但模型被删光：引导卡接在末尾（不进对话记录）。 */}
                {isTail && needModelSetup && !streaming && <ModelSetupCard />}
              </>
            )}
          </div>
        </div>
        {/* 轮次索引：只在轮次够多且非选择态时出现（选择态要让位给勾选交互）。 */}
        {!selecting && tocItems.length >= TOC_MIN_TURNS && (
          <TurnIndex items={tocItems} active={activeTurn} onJump={jumpToTurn} />
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
            // 落在某一轮上才给：回到的是「这一轮开始之前」，前言区（压缩摘要等）不算轮。
            ...(ctxMenu.canDelete && ctxMenu.turn !== null && canRewind
              ? [
                  {
                    label: t('cf.rewind.here'),
                    icon: <RotateCcw size={14} />,
                    onClick: () => openRewind(ctxMenu.turn)
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
          sessionId={currentSessionId}
          owner={owner}
          streaming={streaming}
          focusRoot={focusRoot}
          onMount={onMount}
          onSend={handleSend}
          onStop={onStop}
          showJump={!atBottom && messages.length > 0}
          onJump={jumpToLatest}
          onRewind={() => openRewind()}
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
        />
      )}

      {rewind && (
        <RewindModal
          sessionId={currentSessionId}
          turns={tocItems}
          initialTurn={rewind.turn}
          promptOf={promptOf}
          onClose={() => setRewind(null)}
          onPrefill={onPrefill}
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
 * 当前轮高亮。默认只显刻度短横线，悬停整条面板才展开为浮层文字列表，不压住正文；
 * 不随窗口宽度切换，任何宽度下行为一致。
 */
function TurnIndex({
  items,
  active,
  onJump
}: {
  items: TocItem[]
  /** 当前所在轮下标；-1 表示无。 */
  active: number
  onJump: (turn: number) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)
  // 悬停即展开浮层。展开与否决定索引项高度（收起时无文字），故须在高度实测之前就定下来。
  const [open, setOpen] = useState(false)

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

  // 滚轮刻意不转发给对话：面板不在 .cf-msgs 内、列表又有 overscroll-behavior:contain，滚到头即停——
  // 浮层盖在正文之上，看索引时正文在底下跟着乱跑既晃眼、又会把高亮一路带走。
  return (
    <nav
      className={`cf-toc${open ? ' is-open' : ''}`}
      aria-label={t('cf.toc.title')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="cf-toc__list"
        ref={listRef}
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

/**
 * 进行中消息出现这些元素时不撑住高度（见 ConvMessage）：工作过程里用户展开着的节点 / 折叠条，
 * 以及还在等用户处置的问答、计划、挂载卡。
 */
const NO_HOLD =
  '.msg__process [aria-expanded="true"], .ask:not(.is-answered), .msg__plan:not(.is-decided), .msg__mount:not(.is-decided)'

/** 单条消息：IM 头像外壳 + 复用 features/chat/blocks 的 BlockView（安全渲染器不重写）。 */
function ConvMessage({
  msg,
  owner,
  active,
  latest,
  elapsedSec,
  footer,
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
  /** 是否为对话里最后一条消息（进行中撑住的高度在它不再是最后一条时释放）。 */
  latest: boolean
  /** 本轮已用秒数（进行中的折叠条标题末尾显示；只对 active 的消息有意义）。 */
  elapsedSec: number
  /** 接在消息内容末尾的底部状态行（只交给进行中的那条：已有折叠条时是等待作答 / 重连 / 压缩，还没内容时是思考中）。 */
  footer?: React.ReactNode
  /** 该消息所属的对话轮下标（0 基）；标注在根节点上，供右键菜单定位「删除此轮」。前言/未知为 undefined。 */
  dataTurn?: number
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  onOpenAutotask: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 「工作过程」是否展开：进行中与结束后都默认收起；用户点开后在本次挂载内保持（跨过回合结束也不变）。
  const [processOpen, setProcessOpen] = useState(false)
  // 进行中消息高度只增不减：当前步骤区域随内容伸缩（5 个并行工具 → 1 行思考 → 1 个工具）、中间说明收进
  // 折叠条，都会让消息变矮，页面跟着上下拉扯。故把本轮出现过的最大高度记作最小高度，空出的地方留在消息
  // 底部。回合结束后用 0.25s 平滑收回到实际高度（直接释放的话，最终回复很短时会一下缩掉一大截）。
  // 用户在消息里点了按钮（开合折叠条、思考 / 子智能体节点、各种卡片）立即释放：那是有意的伸缩，
  // 否则点开思考再收起，撑高的那截会一直留着，「回到最新」就落到一片空白上。
  // 以下两种情况不记高度（见 NO_HOLD），恢复后从当时的高度重新记：
  // · 工作过程里有用户展开着的东西（折叠条本身、计划 / 思考 / 提问等节点）：展开的节点可能随后被自动换掉
  //   （当前步骤前进到下一步），它撑出的高度不该留下。
  // · 有等你处置的问答 / 计划 / 挂载卡：回合停着等你，本无抖动可防；处置后卡片收进折叠条是你造成的收缩，
  //   而且常是在输入框里按回车提交，不经过按钮点击，上面的释放管不到。
  const contentRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef(0)
  const releasePeak = (): void => {
    peakRef.current = 0
    const el = contentRef.current
    if (!el) return
    el.style.transition = ''
    el.style.minHeight = ''
  }
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (active) {
      const ro = new ResizeObserver(() => {
        if (el.querySelector(NO_HOLD)) {
          if (peakRef.current) releasePeak()
          return
        }
        const h = el.getBoundingClientRect().height
        if (h > peakRef.current) {
          peakRef.current = h
          el.style.minHeight = `${h}px`
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }
    // 回合结束：撑住的空白平滑收回。先量出不撑时的实际高度，再从撑住的高度过渡过去。
    const held = el.style.minHeight
    if (!held) return
    releasePeak()
    const natural = el.getBoundingClientRect().height
    if (natural >= parseFloat(held) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.style.minHeight = held
    void el.getBoundingClientRect() // 让过渡从撑住的高度起步
    el.style.transition = 'min-height 0.25s ease'
    el.style.minHeight = `${natural}px`
    const timer = setTimeout(releasePeak, 300)
    return () => clearTimeout(timer)
  }, [active])
  useLayoutEffect(() => {
    if (!latest) releasePeak()
  }, [latest])
  // 后台任务通知（后台子智能体结束后自动起的那一轮的起点）：一行居中的系统通知，不画成用户气泡。
  // 仍保留 is-user + data-turn：它是一轮的起点，右键删轮 / 跳转定位都靠它。
  if (msg.role === 'user' && msg.notify) {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user is-notify" data-turn={dataTurn}>
        <div className="cf-notify">
          <Bot size={13} />
          <span>{text || t('chat.subagent.notify')}</span>
        </div>
      </div>
    )
  }
  // 压缩摘要（较早的对话已收成它）：一行居中提示 + 折叠的摘要，不画头像与角色名——那不是角色说的话。
  const only = msg.blocks.length === 1 ? msg.blocks[0] : undefined
  if (msg.role === 'assistant' && only?.kind === 'compaction') {
    return (
      <div className="cf-msg is-compaction" data-turn={dataTurn}>
        <CompactionNotice summary={only.summary} />
      </div>
    )
  }
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
  // 仍在流式输出的那一块（只有进行中的回合才有）：思考据此判断是否已完成，按引用比对。
  const liveBlock = active ? msg.blocks[msg.blocks.length - 1] : undefined
  // 连续的思考 / 工具调用 / 子智能体画成一条时间轴（见 groupBlocks）；其余块逐个原样渲染。
  // notesInline：工作过程里夹着的正文是中间说明，作为时间轴上的说明节点，不打断时间轴。
  const renderBlocks = (blocks: ChatBlock[], notesInline = false): React.ReactNode =>
    groupBlocks(blocks, notesInline).map((item) =>
      item.type === 'timeline' ? (
        <Timeline key={item.key} steps={item.steps} liveBlock={liveBlock} />
      ) : (
        <BlockView
          key={item.index}
          block={item.block}
          thinkingDone={item.block !== liveBlock}
          onAsk={onAsk}
          onPlan={onPlan}
          onMountReq={onMountReq}
          onOpenProposal={onOpenProposal}
          onOpenAutotask={onOpenAutotask}
        />
      )
    )
  // 思考 / 工具调用等过程收进「工作过程」折叠条，名片等固定块与回复正文留在外面（见 splitProcess）；
  // 交付卡在回合结束后排在最后（见 DeliveryCards）。
  // 进行中同样默认收起，收起时折叠条下露出当前步骤（并行执行的一并列出，最多 5 行，见 currentSteps）；
  // 最近一步之后已在输出正文或出了卡片时不露。
  // 当前步骤正是流式输出中的思考：折叠条标题直接写「思考中」，下面只露实时小窗，不再重复一行「思考中」
  // 节点（点折叠条展开整条时间轴即可看全文）。
  const split = splitProcess(msg.blocks, active)
  const current = split && active ? currentSteps(msg.blocks) : []
  const step = current.length === 1 ? current[0] : undefined
  const liveThinking = step?.kind === 'thinking' && step === liveBlock ? step : undefined
  const preview =
    current.length > 0 ? (
      liveThinking ? (
        liveThinking.text.trim() && <LiveThinkingWindow text={liveThinking.text} />
      ) : (
        <Timeline
          steps={current.map((b) => ({ block: b, index: msg.blocks.indexOf(b) }))}
          liveBlock={liveBlock}
          compact
          limit={5}
        />
      )
    ) : undefined
  // 有工作过程时，角色名与折叠条同一行（「Deva › 已处理 … · N 步」）；没有时单独一行。
  const name = <span className="cf-msg__name">{owner?.name ?? t('cf.assistant')}</span>
  return (
    <div className="cf-msg" data-turn={dataTurn}>
      <Avatar persona={owner} size={32} />
      <div className="cf-msg__body">
        {!split && <div className="cf-msg__head">{name}</div>}
        <div
          className="msg__content"
          ref={contentRef}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('button')) releasePeak()
          }}
        >
          {split ? (
            <>
              <ProcessFold
                blocks={split.process}
                durationMs={msg.durationMs}
                live={active}
                thinking={Boolean(liveThinking)}
                elapsedSec={active ? elapsedSec : undefined}
                preview={preview}
                open={processOpen}
                onToggle={() => setProcessOpen((v) => !v)}
                lead={name}
              >
                {renderBlocks(split.process, true)}
              </ProcessFold>
              {renderBlocks(split.visible)}
            </>
          ) : (
            renderBlocks(msg.blocks)
          )}
          {!active && <DeliveryCards blocks={msg.blocks} />}
          {footer}
        </div>
      </div>
    </div>
  )
}

/**
 * 输入框「/ 指令」联想的一个候选项。
 * `command` = 渲染层自有指令（/compact 见 store/chat 的手动压缩分支；/rewind 在 Composer.submit 拦截）；
 * `skill` = 已启用技能，由主进程按 `/name` 匹配并把 SKILL.md 正文预置进本轮消息。
 */
interface SlashCommand {
  name: string
  desc: string
  kind: 'command' | 'skill'
}

/**
 * 取「/ 指令」联想的查询词：仅当输入**直接以 / 开头**且其后尚无空白（仍在敲指令名本身）时生效。
 * 返回 '' 表示刚敲下 `/`（列全部）；返回 null 表示不该联想（正文中间的 /、已带参数的指令、多行输入）。
 */
function slashQueryOf(input: string): string | null {
  const m = /^\/([A-Za-z0-9_-]*)$/.exec(input)
  return m ? m[1] : null
}

/**
 * 各会话未发送的输入（正文 + 待发附件），按会话 id 存在内存里：切走时存下、切回来接着写，也不会把 A 会话
 * 没写完的内容带到 B。只存非空的；不落盘，重启应用后清空。
 * 会话列表据此在其他会话行上显示「[草稿] …」（见 useDraftPreview）：只在进出会话时变动，打字不刷新列表。
 */
type ComposerDraft = { text: string; pending: Picked[] }
const composerDrafts = new Map<string, ComposerDraft>()
const draftListeners = new Set<() => void>()

/** 写入（null = 清除）某会话的草稿，并通知会话列表。 */
function setComposerDraft(id: string, draft: ComposerDraft | null): void {
  if (draft) composerDrafts.set(id, draft)
  else if (!composerDrafts.delete(id)) return
  for (const notify of draftListeners) notify()
}

function subscribeDrafts(onChange: () => void): () => void {
  draftListeners.add(onChange)
  return () => {
    draftListeners.delete(onChange)
  }
}

/**
 * 正在显示的输入框（随会话切换更新）：插入的消息被撤回或退回时，正是这个会话就直接放回输入框，否则并进那个
 * 会话的草稿（见 restoreToComposer）。
 */
let liveComposer: { sessionId: string; restore: (text: string) => void } | null = null

/** 把文字放回某会话的输入框：排在已有内容之前，中间空一行。 */
function restoreToComposer(sessionId: string, text: string): void {
  if (!text.trim()) return
  if (liveComposer?.sessionId === sessionId) {
    liveComposer.restore(text)
    return
  }
  const d = composerDrafts.get(sessionId)
  setComposerDraft(sessionId, {
    text: d?.text.trim() ? `${text}\n\n${d.text}` : text,
    pending: d?.pending ?? []
  })
}

/**
 * 待送达的插入消息（输入框上方，与待办清单、后台任务胶囊同一排）：回合进行中插入、当前步骤还没结束的消息。
 * 「撤回」把文字放回输入框，可以改完再插入；送达后胶囊消失，消息出现在执行步骤里。多条显示条数，送达时合并成一条。
 */
function InsertCapsule({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useI18n()
  const { pendingInserts, withdrawInserts } = useChat()
  const [busy, setBusy] = useState(false)
  const order = useDockOrder(pendingInserts.length > 0, sessionId)
  if (pendingInserts.length === 0) return null
  const text = pendingInserts.join('  ')
  const withdraw = (): void => {
    setBusy(true)
    void withdrawInserts()
      .then((back) => restoreToComposer(sessionId, back))
      .finally(() => setBusy(false))
  }
  return (
    <div className="cf-ins" style={{ order }}>
      {/* 消息文字最多 160px（见 .cf-dock），完整内容挂在悬停上 */}
      <div className="cf-bg__pill cf-ins__pill" title={`${text}\n${t('cf.insert.pendingHint')}`}>
        <Clock size={13} className="cf-ins__icon" />
        <span className="cf-bg__label cf-ins__label">{t('cf.insert.pending')}</span>
        <span className="cf-bg__name">{text}</span>
        {pendingInserts.length > 1 && (
          <span className="cf-ins__count">{t('cf.insert.count').replace('{n}', String(pendingInserts.length))}</span>
        )}
        <button type="button" className="cf-bg__stop" disabled={busy} onClick={withdraw}>
          {t('cf.insert.withdraw')}
        </button>
      </div>
    </div>
  )
}

/** 某会话草稿的一行摘要：正文（空白归一），只有附件时为附件名；没有草稿为 null。 */
function useDraftPreview(id: string): string | null {
  return useSyncExternalStore(subscribeDrafts, () => {
    const d = composerDrafts.get(id)
    if (!d) return null
    return d.text.replace(/\s+/g, ' ').trim() || d.pending.map((p) => p.name).join(' ') || null
  })
}

function Composer({
  sessionId,
  owner,
  streaming,
  focusRoot,
  onMount,
  onSend,
  onStop,
  showJump,
  onJump,
  onRewind,
  prefill,
  onPrefillConsumed
}: {
  /** 当前会话：输入框里的草稿按它分开保存（见 composerDrafts）。 */
  sessionId: string
  owner?: Persona
  streaming: boolean
  focusRoot: string | null
  onMount: (path: string | null) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  onStop: () => void
  showJump: boolean
  onJump: () => void
  /** 打开检查点回滚面板（/rewind、双击 Esc）；返回 false 表示此刻不可用（未打开）。 */
  onRewind: () => boolean
  prefill: { text: string; nonce: number } | null
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { skills: allSkills } = useExtensions()
  // 本对话角色能用的技能（已启用、且可用角色含该角色；内置恒可用）——同主进程的过滤，/ 联想与上色只认它们。
  const ownerId = owner?.id ?? DEFAULT_PERSONA_ID
  const skills = useMemo(
    () => allSkills.filter((s) => s.enabled && (s.source === 'builtin' || rolesAllow(s.roles, ownerId))),
    [allSkills, ownerId]
  )
  const toast = useToast()
  const { insert: onInsert } = useChat()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<Picked[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  // 输入框高度：固定高、不随内容长高，内容多了框内滚动；只能靠顶边手柄拖动调整。
  // 与侧栏同理，存用户意图值、渲染时按窗口高再夹取。
  const viewport = useViewport()
  const [composerH, setComposerH] = useState(() => loadLayout().composerHeight ?? COMPOSER_DEFAULT)
  const boxH = clampComposer(composerH, viewport.h)
  const boxHRef = useRef(boxH)
  boxHRef.current = boxH
  /** 「/ 指令」联想：当前高亮项下标（随查询词变化复位）。 */
  const [slashSel, setSlashSel] = useState(0)
  /** Esc 收起联想；任何一次输入改动都会复位，重新键入即可再唤出。 */
  const [slashOff, setSlashOff] = useState(false)
  /** 输入框是否持有焦点：失焦即收起联想（采纳项走 mousedown+preventDefault，不会触发失焦）。 */
  const [focused, setFocused] = useState(false)
  const slashRef = useRef<HTMLDivElement>(null)
  /** 上一次「空输入框里按 Esc」的时刻：500ms 内再按一次即打开回滚面板。 */
  const lastEscRef = useRef(0)

  // 预填（不发送）：把父层注入的文本写进输入框，聚焦并将光标移到末尾，交由用户自己发送。
  // nonce 变化触发一次；消费后立即回调置空（父层 prefill→null），guard 防重入与重挂载复活。
  useEffect(() => {
    if (!prefill) return
    composer.setText(prefill.text, true)
    onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce])

  // 指令表：渲染层自有的 /compact、/rewind 置顶，其后是本角色可用的技能（停用或不对本角色开放的主进程也不认）。
  // 同名技能会被自有指令遮蔽（渲染层先拦截），按小写名去重、保留先者，不给出点了没反应的候选。
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const out: SlashCommand[] = [
      { name: 'compact', desc: t('cf.slash.compact'), kind: 'command' },
      { name: 'rewind', desc: t('cf.slash.rewind'), kind: 'command' }
    ]
    const seen = new Set(out.map((c) => c.name.toLowerCase()))
    for (const s of skills) {
      if (!s.enabled) continue
      const key = s.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: s.name, desc: s.desc, kind: 'skill' })
    }
    return out
  }, [skills, t])

  const slashQuery = slashQueryOf(input)
  // 排序：前缀命中优先于子串命中，组内保持原序（/compact 在前，技能按扩展页顺序）。
  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    if (!q) return slashCommands
    const head: SlashCommand[] = []
    const tail: SlashCommand[] = []
    for (const c of slashCommands) {
      const n = c.name.toLowerCase()
      if (n.startsWith(q)) head.push(c)
      else if (n.includes(q)) tail.push(c)
    }
    return [...head, ...tail]
  }, [slashCommands, slashQuery])
  const slashOpen = focused && slashQuery !== null && slashMatches.length > 0 && !slashOff
  // 高亮下标就地夹紧：命中集随输入收缩时，无需等 effect 落地即为合法值。
  const slashCur = slashOpen ? Math.min(slashSel, slashMatches.length - 1) : -1

  // 查询词一变就回到第一项（最贴合用户刚敲的那几个字母）。
  useEffect(() => {
    setSlashSel(0)
  }, [slashQuery])

  // 键盘上下移动时把高亮项滚进可视区（列表超高时才有实际位移）。
  useEffect(() => {
    if (!slashOpen) return
    slashRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [slashCur, slashOpen])

  /** 采纳候选：写回 `/name `（尾随空格便于接着补充说明，发送前会被 trim），光标留在末尾。 */
  const applySlash = (c: SlashCommand): void => composer.setText(`/${c.name} `, true)

  const name = owner?.name ?? t('cf.assistant')
  // 回合进行中：输入框里的文字会插入当前这一轮，占位提示说明送达时机。
  const placeholder = streaming
    ? t('cf.insert.placeholder').replace('{name}', name)
    : locale === 'en'
      ? `Message ${name}…`
      : `跟 ${name} 说点什么…`
  const supported = pending.filter((p) => p.supported)
  const canSend = Boolean(input.trim()) || supported.length > 0
  // 回合进行中有文字：唯一的按键是「发送」（插入当前轮）。只插文字，待发附件留在输入框里随下一条消息发出。
  const canInsert = streaming && Boolean(input.trim())
  /** 上一次插入的时刻：插入后输入框清空、同一位置随即变成停止键，短时间内不认停止，防双击把任务停掉。 */
  const insertedAtRef = useRef(0)
  const stopTurn = (): void => {
    if (Date.now() - insertedAtRef.current < 600) return
    onStop()
  }
  const mounted = Boolean(focusRoot)

  // 挂载工作区（放在输入区工具条，取代原顶部头部的入口）：仅未挂载态的 chip 调用，选了才挂载，取消则保持现状。
  // 已挂载态不提供直接更换（见 WorkspaceMenu），卸载由尾随的 ✕ 图标承担，避免「取消对话框＝卸载」的意外语义。
  const pickWorkspace = (): void => {
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onMount(r.path)
    })()
  }

  // 新增附件并入 pending：不支持 / 过大的不加入（加了也发不出去），toast 说明哪些被跳过；按路径去重。
  const addPicked = (picked: Picked[]): void => {
    const bad = picked.filter((p) => !p.supported)
    if (bad.length) {
      const names = bad.map((p) => p.name).join(locale === 'en' ? ', ' : '、')
      toast.show({ variant: 'warning', message: t('cf.attachSkipped').replace('{names}', names) })
    }
    setPending((prev) => {
      const seen = new Set(prev.map((p) => p.path))
      const out = [...prev]
      for (const p of picked) {
        if (!p.supported || seen.has(p.path)) continue
        seen.add(p.path)
        out.push(p)
      }
      return out
    })
  }

  const pickFiles = async (): Promise<void> => {
    if (streaming) return
    addPicked((await window.deva.fs.pickAttachments()) as Picked[])
  }

  // 粘贴 / 拖入的文件：与「附加文件」同一条链路（主进程落盘授权 → pending 附件条）。
  // 只交字节不交路径，渲染层仍无法让主进程读任意路径；拖入的文件夹读不出字节，直接跳过。
  const addFiles = async (files: File[]): Promise<void> => {
    const results = await Promise.allSettled(
      files.map(async (f) =>
        window.deva.fs.pasteAttachment({
          name: f.name,
          mime: f.type,
          size: f.size,
          // 超过最大附件上限（PDF 20MB）的不读字节，只报体积，主进程据此判「过大」。
          data: f.size > 20 * 1024 * 1024 ? null : new Uint8Array(await f.arrayBuffer())
        })
      )
    )
    // 同一文件多次粘贴 / 拖入只留一份：主进程按内容去重、重复的返回同一路径，addPicked 按路径过滤即可。
    addPicked(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value as Picked] : [])))
  }

  // 剪贴板带纯文本时一律按文本粘贴——Word / Excel 复制内容会顺带一张渲染图，不能把它变成附件。
  const onPaste = (e: ClipboardEvent): boolean => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length || e.clipboardData?.getData('text/plain')) return false
    e.preventDefault()
    if (!streaming) void addFiles(files)
    return true
  }

  // 拖入文件：整个窗口都可放下，一律转成附件。Chromium 对未拦截的文件拖放默认「打开该文件」
  // （导航离开应用），故凡带文件的 dragover / drop 都 preventDefault；回复中只拦截不附加，同粘贴。
  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = streamingRef.current ? 'none' : 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length && !streamingRef.current) void addFilesRef.current(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const removePending = (path: string): void =>
    setPending((prev) => prev.filter((p) => p.path !== path))

  // 插入当前轮：清空输入框交给主进程，当前步骤结束后送达；没插进去（原因已 toast）就把文字放回。
  const insertNow = (): void => {
    const text = composer.getText()
    // /compact、/rewind 是本地指令，回合进行中用不了，也不该当成消息插进去。
    if (!text.trim() || /^\/(compact|rewind)$/i.test(text.trim())) return
    const sid = sessionId
    insertedAtRef.current = Date.now()
    composer.setText('')
    composer.clearHistory()
    void onInsert(text).then((ok) => {
      if (!ok) restoreToComposer(sid, text)
    })
  }

  const submit = (): void => {
    if (streaming) {
      insertNow()
      return
    }
    const text = composer.getText()
    const atts = pending.filter((p) => p.supported)
    if (!text.trim() && atts.length === 0) return
    // /rewind 纯渲染层指令：打开回滚面板、不发消息；此刻不可用则原样留在输入框。
    if (text.trim().toLowerCase() === '/rewind' && atts.length === 0) {
      if (onRewind()) composer.setText('')
      return
    }
    const prevPending = pending
    const sid = sessionId
    composer.setText('')
    composer.clearHistory()
    setPending([])
    void onSend(
      text,
      atts.map((p) => ({ path: p.path, name: p.name, kind: p.kind as AttachKind }))
    ).then((sent) => {
      // 未发出（未选模型 / 请求失败，原因已 toast）：把草稿放回——但别覆盖用户在此期间新敲的内容；
      // 此间已切到别的会话的，放回原会话的草稿里。
      if (sent) return
      if (sessionRef.current !== sid) {
        if (!composerDrafts.has(sid)) setComposerDraft(sid, { text, pending: prevPending })
        return
      }
      if (!composer.getText()) composer.setText(text)
      setPending((cur) => (cur.length ? cur : prevPending))
    })
  }

  const onKey = (key: ComposerKey, e: KeyboardEvent): boolean => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey
    // 「/ 指令」联想打开时这几个键先归联想；其余（含 Shift+Enter 换行）照旧落到输入框。
    if (slashOpen) {
      if (plain && (key === 'down' || key === 'up')) {
        e.preventDefault()
        const d = key === 'down' ? 1 : -1
        setSlashSel((i) => {
          const n = slashMatches.length
          return (Math.min(i, n - 1) + d + n) % n
        })
        return true
      }
      if (key === 'tab' || (plain && key === 'enter')) {
        e.preventDefault()
        const pick = slashMatches[slashCur]
        if (pick) applySlash(pick)
        return true
      }
      if (key === 'escape') {
        e.preventDefault()
        setSlashOff(true)
        return true
      }
    }
    // 双击 Esc（仅空输入框、无待发附件时）打开回滚面板；联想浮层开着时 Esc 已在上面被它吃掉。
    if (key === 'escape' && plain && !input.trim() && pending.length === 0 && !streaming) {
      const now = Date.now()
      if (now - lastEscRef.current <= 500) {
        lastEscRef.current = 0
        e.preventDefault()
        onRewind()
        return true
      }
      lastEscRef.current = now
      return false
    }
    if (key !== 'enter' || !plain) return false // 其余交给编辑器（Shift+Enter 换行）
    e.preventDefault()
    submit()
    return true
  }

  // 开头 `/name` 会不会生效（决定是否上色）：/compact、/rewind 须整条只有它且无附件（同 submit 与 store 的拦截）；
  // 其余按本角色可用技能的显示名或文件夹名、不分大小写匹配（同主进程 loadSkillInstructionsByName）。
  const noAtts = supported.length === 0
  const isToken = (name: string, whole: string): boolean => {
    const n = name.toLowerCase()
    if ((n === 'compact' || n === 'rewind') && noAtts && whole.toLowerCase() === `/${n}`) return true
    return skills.some((s) => s.enabled && (s.name.toLowerCase() === n || s.id.toLowerCase() === n))
  }

  const composer = useComposerEditor({
    onChange: (text) => {
      setInput(text)
      setSlashOff(false) // 又动了输入：Esc 收起的联想重新可唤出
    },
    onKey,
    onPaste,
    isToken
  })

  // 判定依据（技能启停、有无附件）变了而文本没变：重新识别一次开头指令。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => composer.refreshToken(), [skills, noAtts])

  // 草稿按会话分开：进入会话（含挂载）换上它的草稿，没有则清空；离开（切换会话或卸载，如进入选择删除）时
  // 把当前内容存到它名下。撤销历史一并清掉，免得撤销把别的会话的内容找回来。用 layout effect，切过去时
  // 不会先闪一下上一个会话的文字。
  useLayoutEffect(() => {
    const draft = composerDrafts.get(sessionId)
    setComposerDraft(sessionId, null)
    composer.setText(draft?.text ?? '')
    composer.clearHistory()
    setPending(draft?.pending ?? [])
    return () => {
      const text = composer.getText()
      const kept = pendingRef.current
      if (text.trim() || kept.length) setComposerDraft(sessionId, { text, pending: kept })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 登记为「正在显示的输入框」：撤回或退回的插入消息若属于本会话，直接放回这里（排在已有内容之前）。
  useLayoutEffect(() => {
    const entry = {
      sessionId,
      restore: (text: string): void => {
        const cur = composer.getText()
        composer.setText(cur.trim() ? `${text}\n\n${cur}` : text, true)
      }
    }
    liveComposer = entry
    return () => {
      if (liveComposer === entry) liveComposer = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

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
        {slashOpen && (
          <div className="cf-slash" ref={slashRef}>
            <div className="cf-slash__list" role="listbox" aria-label={t('cf.slash.title')}>
              {slashMatches.map((c, i) => {
                const on = i === slashCur
                return (
                  <button
                    key={`${c.kind}:${c.name}`}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-on={on ? '1' : undefined}
                    className={`cf-slash__item${on ? ' is-on' : ''}`}
                    title={c.desc}
                    // 鼠标按下即采纳：抢在 blur 之前，输入框不失焦、光标不丢。
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applySlash(c)
                    }}
                    onMouseEnter={() => setSlashSel(i)}
                  >
                    {c.kind === 'skill' ? (
                      <Puzzle size={14} />
                    ) : c.name === 'rewind' ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Shrink size={14} />
                    )}
                    <span className="cf-slash__name">{`/${c.name}`}</span>
                    <span className="cf-slash__desc">{c.desc}</span>
                  </button>
                )
              })}
            </div>
            <div className="cf-slash__hint">{t('cf.slash.hint')}</div>
          </div>
        )}
        {/*
         * 输入框上方的胶囊排：待办清单、后台任务、浏览网页、插入对话，各自有内容才出现。
         * 实际先后按出现的先后（新出现的在最右，见 useDockOrder）；这里的书写顺序只在切会话、几枚同时出现时起作用——
         * 越常驻的越靠左，插入对话最短暂、最需要用户留意，放最后。
         */}
        <div className="cf-dock">
          <TodoCapsule />
          <BackgroundCapsule />
          <BrowserCapsule sessionId={sessionId} />
          <InsertCapsule sessionId={sessionId} />
        </div>
        <div className="cf-box">
          {/* 拖拽手柄压在输入框上边框：向上拖加高输入框。 */}
          <ResizeHandle
            axis="y"
            className="cf-resizer--box"
            value={boxH}
            title={t('cf.resizeComposer')}
            onChange={(v) => setComposerH(clampComposer(v, window.innerHeight))}
            onCommit={() => saveLayout({ composerHeight: boxHRef.current })}
            onReset={() => {
              setComposerH(COMPOSER_DEFAULT)
              saveLayout({ composerHeight: undefined })
            }}
          />
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
          {/* 输入区：Lexical 接管的 contentEditable（子节点归编辑器管，React 不渲染内容）；占位提示叠在其上。 */}
          <div className="cf-draft" style={{ height: boxH }}>
            <div
              ref={composer.rootRef}
              className="cf-draft__input"
              contentEditable
              role="textbox"
              aria-multiline
              aria-label={placeholder}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            {composer.empty && <div className="cf-draft__ph">{placeholder}</div>}
          </div>
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
                <WorkspaceMenu root={focusRoot} />
                <GitWidget root={focusRoot} streaming={streaming} />
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
            <EffortPicker />
            {/* 回合进行中只有一枚键：输入框有文字＝「发送」（插入当前轮），空＝「停止」（只放图标，与发送同宽不跳动）。
                有文字时不出停止，要停先清空输入框。 */}
            {streaming ? (
              canInsert ? (
                <button
                  className="cf-send"
                  type="button"
                  title={t('cf.insert.hint').replace('{name}', name)}
                  onClick={insertNow}
                >
                  {t('cf.send')}
                </button>
              ) : (
                <button
                  className="cf-send is-stop"
                  type="button"
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                  onClick={stopTurn}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )
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
 * 模型选择器。复用 app.css 的既有类
 * （model-pick / chip / model-pick__backdrop / model-pick__menu），零新增 CSS。
 * 只列「已启用服务商 × 已启用模型」，按服务商分组。
 * 切换时做两件事：① 写当前对话覆盖层并立即落库到会话属性（setSessionModel，切了不发重启也不丢），
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
                      title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
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

/**
 * 思考等级选择器（紧挨模型选择器，复用其 model-pick / chip 类）。与模型同一套语义：切换只改本对话并立即
 * 落库（setSessionEffort），同时记为「最近使用」（setActiveEffort），尚未定格的对话（新对话）沿用它。
 * 只列本对话生效模型支持的档（模型能力内置表，见 shared/effort.ts）；模型不支持思考等级则整个隐藏。
 * 「默认」= 不发任何思考参数；各档如何映射到各家协议、不支持时如何自愈，见主进程 providers/* 与 chat.ts。
 */
function EffortPicker(): React.JSX.Element | null {
  const { t } = useI18n()
  const { activeEffort, setActiveEffort, activeModel, providers } = useModels()
  const { currentBinding, setSessionEffort } = useChat()
  const [open, setOpen] = useState(false)
  // 本对话生效模型（同 ModelPicker：本对话已选 → 否则回落最近使用）。选择器只列对话模型，adapter 必属三协议之一。
  const active = findActive(providers, currentBinding.model ?? null) ?? activeModel
  const adapter = active?.provider.adapter as EffortAdapter | undefined
  const modelId = active?.model.id
  const levels = adapter && modelId ? supportedEffortLevels(adapter, modelId) : []
  if (!adapter || !modelId || levels.length === 0) return null
  // 只能开、不能调档的模型（如通义 qwen-plus、Kimi K2）：唯一的一档显示为「开启」。
  const toggle = isToggleEffort(adapter, modelId)
  const nameOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.on') : t(`chat.effort.levels.${lv}`)
  const hintOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.onHint') : t(`chat.effort.hints.${lv}`)
  // 本对话存的档位（尚未定格时为「最近使用」）收敛到该模型支持的档来显示——与主进程实际发送的一致；
  // 存值本身不改，换回支持该档的模型即恢复。
  const current = clampEffort(adapter, modelId, currentBinding.effort ?? activeEffort)
  const label = nameOf(current)
  const options: EffortLevel[] = ['default', ...levels]
  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={`${t('chat.effort.title')}：${label}`}
        aria-label={`${t('chat.effort.title')}：${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Lightbulb size={13} />
        <span className="chip__label">{label}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            <div className="model-pick__group">
              <div className="model-pick__group-head">
                <span className="model-pick__group-name">{t('chat.effort.title')}</span>
              </div>
              {options.map((lv) => {
                const active = lv === current
                return (
                  <button
                    key={lv}
                    role="menuitemradio"
                    aria-checked={active}
                    className={`model-pick__item${active ? ' is-active' : ''}`}
                    onClick={() => {
                      // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话的默认。
                      setSessionEffort(lv)
                      setActiveEffort(lv)
                      setOpen(false)
                    }}
                  >
                    <span className="model-pick__name cf-effort__text">
                      <span>{nameOf(lv)}</span>
                      <span className="cf-effort__hint">{hintOf(lv)}</span>
                    </span>
                    {active && <Check size={14} className="model-pick__check" />}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ============================ 中列：角色资料卡 ============================ */
/** 资料卡下方的两个标签：与该角色的对话 / 它的专属能力。 */
type ProfileTab = 'chats' | 'caps'

/**
 * 角色资料卡：头像与名字并排、操作按钮，下面用「对话 / 能力」两个标签切换，一次只看一块。
 * 能力 = 在扩展页指定给这个角色的技能与 MCP（对所有角色开放的不在这里重复），点某项进入设置 › 扩展的详情；
 * 没有专属能力的角色不显示「能力」标签。标签选择跨角色保留，便于逐个查看各角色的能力。
 * 名片（头像到标签）固定不动，只有下方列表滚动。
 */
function ProfileView({
  persona,
  sessions,
  onOpenThread,
  onStart,
  onEdit,
  onManageCaps
}: {
  persona: Persona
  sessions: SessionMeta[]
  onOpenThread: (id: string) => void
  onStart: () => void
  onEdit: () => void
  /** 打开设置 › 扩展里这一项的详情。 */
  onManageCaps: (target: { kind: 'skill' | 'mcp'; id: string }) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { skills, mcp } = useExtensions()
  const rel = useRelativeTime()
  const [tab, setTab] = useState<ProfileTab>('chats')
  const convs = useMemo(
    () =>
      sessions
        .filter((s) => s.personaId === persona.id)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, persona.id]
  )
  // 专属能力：可用角色里点名了这个角色的技能与 MCP（停用的也列出、置灰，免得以为没配上）。
  const caps = useMemo(
    () => [
      ...skills
        .filter((s) => s.roles?.includes(persona.id))
        .map((s) => ({ kind: 'skill' as const, id: s.id, name: s.name, desc: s.desc, enabled: s.enabled })),
      ...mcp
        .filter((m) => m.roles?.includes(persona.id))
        .map((m) => ({
          kind: 'mcp' as const,
          id: m.id,
          name: m.name,
          desc: m.desc || (m.enabled ? t(`extensions.status.${m.status}`) : ''),
          enabled: m.enabled
        }))
    ],
    [skills, mcp, persona.id, t]
  )
  // 没有专属能力就只有「对话」一个标签；之前停在「能力」的也回到对话。
  const current: ProfileTab = caps.length ? tab : 'chats'
  const tabs: [ProfileTab, string, number][] = [['chats', t('cf.profileTabChats'), convs.length]]
  if (caps.length) tabs.push(['caps', t('cf.profileTabCaps'), caps.length])
  const noConvs =
    locale === 'en' ? `No conversations with ${persona.name} yet` : `还没有和 ${persona.name} 的对话`

  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-profile cf-profile--persona">
        <div className="cf-profile__inner cf-profile__inner--persona">
          <div className="cf-phead">
            <div className="cf-profile__ava">
              <PersonaFace
                seed={persona.id}
                spec={parseAvatarSpec(persona.avatar)}
                image={persona.avatarImage}
                title={persona.name}
              />
            </div>
            <div className="cf-phead__id">
              <div className="cf-phead__name cf-profile__clip" title={persona.name}>
                {persona.name}
              </div>
              {persona.desc && (
                <div className="cf-phead__spec" title={persona.desc}>
                  {persona.desc}
                </div>
              )}
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

          <div className="cf-ptabs" role="tablist">
            {tabs.map(([key, label, n]) => (
              <button
                key={key}
                role="tab"
                aria-selected={current === key}
                className={`cf-ptab${current === key ? ' is-on' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
                <span className="cf-ptab__n">{n}</span>
              </button>
            ))}
          </div>

          {/* 按角色 + 标签换 key：切标签或换角色时列表回到顶部，不沿用上一个列表的滚动位置。 */}
          <div key={`${persona.id}:${current}`} className="cf-ptabs__body" role="tabpanel">
            {current === 'chats' ? (
              convs.length === 0 ? (
                <div className="cf-ptabs__note cf-profile__clip" title={noConvs}>
                  {noConvs}
                </div>
              ) : (
                convs.map((s) => (
                  <button key={s.id} className="cf-convrow" onClick={() => onOpenThread(s.id)}>
                    <span className="cf-convrow__title">{s.title || t('chat.untitled')}</span>
                    {s.focusRoot && (
                      <span className="cf-convrow__proj" title={s.focusRoot}>
                        <Folder size={11} />
                        <span className="cf-convrow__projname">{basename(s.focusRoot)}</span>
                      </span>
                    )}
                    <span className="cf-convrow__time">{rel(s.updatedAt)}</span>
                  </button>
                ))
              )
            ) : (
              caps.map((c) => (
                <button
                  key={`${c.kind}:${c.id}`}
                  className={`cf-cap${c.enabled ? '' : ' is-off'}`}
                  onClick={() => onManageCaps({ kind: c.kind, id: c.id })}
                >
                  <span className="cf-cap__ico">{c.kind === 'skill' ? <Puzzle size={15} /> : <Plug size={15} />}</span>
                  <span className="cf-cap__main">
                    <span className="cf-cap__name">{c.name}</span>
                    {c.desc && <span className="cf-cap__desc">{c.desc}</span>}
                  </span>
                  <span className="cf-cap__kind">
                    {c.enabled ? t(c.kind === 'skill' ? 'cf.kindSkill' : 'cf.kindMcp') : t('cf.capDisabled')}
                  </span>
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
function PersonaEditor({
  initial,
  onClose
}: {
  initial: EditorState
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { providers } = useModels()
  const { upsertPersona, setPersonaAvatarImage } = useExtensions()
  const { resolveProposal } = useChat()
  const editing = initial.mode === 'edit' ? initial.persona : null
  // propose 态：预填 LLM 草稿，接受才落盘、拒绝不写；editing 恒 null → upsert 无 id → 只创建不覆盖。
  const proposing = initial.mode === 'propose' ? initial : null
  const draft = proposing?.draft

  const [name, setName] = useState(editing?.name ?? draft?.name ?? '')
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
  // 自定义头像（用户上传的图，data URI）：非空即盖过上面的 spec 生成头像。编辑态取已存图，
  // 新建 / 名片态恒空。它不进 upsertPersona 入参——落盘要等 upsert 返回 id（见 save）。
  const [avatarImage, setAvatarImage] = useState<string>(editing?.avatarImage ?? '')
  // 头像编辑面板开关：点击信息表单里的头像缩略图进入。面板自持草稿：「完成」回写这里的
  // avatar/avatarImage、「取消」/ ✕ 直接收起即丢弃；两者都只切回表单，真正落盘仍走表单底部的保存/接受。
  const [avatarEditing, setAvatarEditing] = useState(false)
  // 顶部 ✕ / 点击背景：在头像面板时只退回信息表单（丢弃头像改动），否则关闭整个编辑器。
  const dismiss = (): void => {
    if (avatarEditing) setAvatarEditing(false)
    else onClose()
  }

  // 模型下拉：「跟随默认」+ 按服务商分组的模型（同输入框的模型选择）→ "providerId:modelId"；空 = 跟随默认。
  // 决策模型（purpose==='decision'）不参与对话生成，排除在角色偏好模型之外。
  const llmProviders = useMemo(
    () => providers.filter((p) => (p.purpose ?? 'llm') === 'llm' && p.models.length > 0),
    [providers]
  )
  const modelItems = useMemo<SelectEntry<string>[]>(
    () => [
      {
        value: '',
        label: t('cf.defaultModel'),
        sub: t('cf.defaultModelHint'),
        lead: (
          <span className="select-icon">
            <Sparkles size={14} />
          </span>
        )
      },
      ...llmProviders.flatMap((p): SelectEntry<string>[] => [
        { separator: true },
        { group: p.name, lead: <span className="select-dot" style={{ background: p.accent }} /> },
        ...p.models.map((m) => ({ value: `${p.id}:${m.id}`, label: m.name }))
      ])
    ],
    [llmProviders, t]
  )
  // 收起态：选中模型带服务商色点；引用的模型已删除时如实显示原引用（与资料卡原先的兜底一致）。
  const modelDisplay = useMemo(() => {
    if (!model) return undefined
    const idx = model.indexOf(':')
    const p = idx > 0 ? llmProviders.find((x) => x.id === model.slice(0, idx)) : undefined
    const m = p?.models.find((x) => x.id === model.slice(idx + 1))
    if (!p || !m) return <span className="select__label select__placeholder">{model}</span>
    return (
      <>
        <span className="select__lead">
          <span className="select-dot" style={{ background: p.accent }} />
        </span>
        <span className="select__label">{m.name}</span>
      </>
    )
  }, [model, llmProviders])

  // 保存（create/edit）/ 接受（propose）：同一条渲染层 upsertPersona（用户点击即授权，零提权）。
  // propose 态额外落定名片终态为 accepted（重开不退回 pending、不重复建角色）。
  const save = (): void => {
    if (!name.trim() || saving) return
    setSaving(true)
    void (async () => {
      const input: PersonaUpsertInput = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        description: desc.trim(),
        // 存显式头像 spec（JSON 串）：所见即所存即所渲染。
        avatar: serializeAvatarSpec(avatar),
        model,
        prompt,
        enabled: true
      }
      const saved = await upsertPersona(input)
      // 自定义头像另走一路：它不入 frontmatter，且**新建角色要等 upsert 返回才有 id**。
      // 只在相对已存值真有变化时写（空串 = 清除），免得每次保存都重写一遍同一张图。
      if (saved && avatarImage !== (editing?.avatarImage ?? '')) {
        await setPersonaAvatarImage(saved.id, avatarImage)
      }
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
            /* ===== 头像编辑面板：点击头像进入；「完成」回写并返回信息表单 ===== */
            <AvatarEditor
              seed={avatarSeed}
              initialSpec={avatar}
              initialImage={avatarImage}
              title={name}
              onCancel={() => setAvatarEditing(false)}
              onDone={(spec, image) => {
                setAvatar(spec)
                setAvatarImage(image)
                setAvatarEditing(false)
              }}
            />
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
                  onClick={() => setAvatarEditing(true)}
                >
                  <span className="cf-avapick__face">
                    <PersonaFace
                      seed={avatarSeed}
                      spec={avatar}
                      image={avatarImage}
                      title={name || t('cf.fAvatar')}
                    />
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
                <Select
                  aria-label={t('cf.fModel')}
                  value={model}
                  onChange={setModel}
                  items={modelItems}
                  display={modelDisplay}
                />
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
/** 打开设置时的落点：哪一页，以及（扩展页）直接打开哪一项的详情。 */
type SettingsInit = { section?: SettingsSection; ext?: { kind: 'skill' | 'mcp'; id: string } }

function Settings({ initial, onClose }: { initial?: SettingsInit; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>(initial?.section ?? 'general')
  // 直达的扩展详情只在首次进入扩展页时生效；切到别的页再回来是普通的扩展列表。
  const [extTarget, setExtTarget] = useState(initial?.ext ?? null)
  const nav: Array<{ id: SettingsSection; icon: React.ReactNode; label: string }> = [
    { id: 'general', icon: <Cog size={15} />, label: t('settings.general') },
    { id: 'models', icon: <Brain size={15} />, label: t('settings.models') },
    { id: 'extensions', icon: <Puzzle size={15} />, label: t('activity.extensions') },
    { id: 'about', icon: <Info size={15} />, label: t('settings.about') }
  ]
  return (
    // 遮罩层不响应点击：设置弹框只能通过右上角关闭按钮手动关闭，避免误触丢失上下文
    <div className="cf-modal__backdrop">
      <div className="cf-modal" role="dialog" aria-label={t('cf.settings')}>
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
                onClick={() => {
                  setSection(n.id)
                  setExtTarget(null)
                }}
              >
                <span className="cf-nav__icon">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
          <div className="cf-pane">
            {section === 'general' && <GeneralPane />}
            {section === 'models' && <ModelSettings />}
            {section === 'extensions' && <ExtensionsPane initialOpen={extTarget} />}
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
  // 文字大小：点选即生效（写 <html data-chat-fs>）并落盘，见 theme/chatFontSize.ts
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(readChatFontSize)
  const pickChatFontSize = (v: string): void => {
    const next = v as ChatFontSize
    setChatFontSize(next)
    saveChatFontSize(next)
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
        <div className="cf-set__row">
          <div className="cf-set__label">{t('settings.chatFontSize')}</div>
          <Segmented
            value={chatFontSize}
            onChange={pickChatFontSize}
            options={[
              { v: 'sm', label: t('settings.chatFontSm') },
              { v: 'md', label: t('settings.chatFontMd') },
              { v: 'lg', label: t('settings.chatFontLg') },
              { v: 'xl', label: t('settings.chatFontXl') }
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

function ExtensionsPane({
  initialOpen
}: {
  initialOpen?: { kind: 'skill' | 'mcp'; id: string } | null
}): React.JSX.Element {
  const { t } = useI18n()
  // 角色（persona）不在此列出：它有专属的「角色」tab 与资料卡来管理，扩展页只管技能 / MCP。
  // 子智能体亦不在此列：它是内置能力（通用 / Explore / Research / Plan），不可配置，见 main/services/subagents.ts。
  const { skills, mcp, toggle, refresh } = useExtensions()
  // 进入扩展页即从磁盘重拉最新：技能平时由主进程目录监听实时推送，这里兜底监听失效（如技能目录在网络盘）
  // 并顺带刷新 MCP。refresh 标识稳定，不会形成刷新循环。
  useEffect(() => {
    refresh()
  }, [refresh])

  // 钻取导航：点开某行 → 进入详情（对齐模型设置页的主从抽屉）。MCP 详情可编辑；技能详情只读，
  // 只提供删除与启停；内置技能不展示详情。新增经对话工具 / 上传 / 直接改盘，扩展页不放新增入口。
  const [open, setOpen] = useState<{ kind: 'skill' | 'mcp'; id: string } | null>(initialOpen ?? null)
  const openMcp = open?.kind === 'mcp' ? mcp.find((m) => m.id === open.id) : undefined
  const openSkill = open?.kind === 'skill' ? skills.find((s) => s.id === open.id) : undefined

  if (openMcp) {
    return <McpEditor item={openMcp} onBack={() => setOpen(null)} />
  }
  if (openSkill) {
    return <SkillDetail item={openSkill} onBack={() => setOpen(null)} />
  }

  type Item = {
    kind: 'skill' | 'mcp'
    id: string
    name: string
    enabled: boolean
    badge: string
    note?: string
    /** 注记以警示色显示（MCP 已启用却没连上：失败 / 待填密钥 / 待完善配置）。 */
    noteWarn?: boolean
    /** 可用角色（null = 所有角色，行尾不显示；内置技能不设）。 */
    roles?: string[] | null
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
        roles: s.source === 'builtin' ? undefined : s.roles,
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
        // 未启用不加注记（开关本身已表达）；已启用则如实给出连接状态，没连上的原因用警示色。
        note: m.enabled ? t(`extensions.status.${m.status}`) : undefined,
        noteWarn: m.enabled && MCP_STATUS_WARN.has(m.status),
        roles: m.roles
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
          {items.map((x) => {
            const name = (
              <span className="cf-setrow__name">
                <span className="cf-setrow__label" title={x.name}>
                  {x.name}
                </span>
                <span className="cf-badge">{x.badge}</span>
                {x.note && (
                  <span className={`cf-setrow__note${x.noteWarn ? ' cf-setrow__note--warn' : ''}`}>
                    {x.note}
                  </span>
                )}
              </span>
            )
            return (
              <div key={`${x.kind}:${x.id}`} className="cf-setrow">
                {x.locked ? (
                  // 内置技能不展示详情：只读一行，开关禁用。
                  <div className="cf-setrow__main">{name}</div>
                ) : (
                  // 主区做按钮（点开详情），开关作兄弟节点独立触发（互不干扰）。
                  <button className="cf-setrow__open" onClick={() => setOpen({ kind: x.kind, id: x.id })}>
                    {name}
                    {x.roles !== undefined && <RolesBadge roles={x.roles} />}
                    <ChevronRight className="cf-setrow__chevron" size={15} />
                  </button>
                )}
                <Toggle on={x.enabled} disabled={x.locked} onChange={() => toggle(x.kind, x.id)} />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * 头像堆叠：最多 max 个；超出时末位照常放第 max 个头像、盖一层半透明深色再写 +N（N 含被盖住的这个）。
 * 悬停显示全部角色名。
 */
function AvatarStack({
  personas,
  size = 20,
  max = 3
}: {
  personas: Persona[]
  size?: number
  max?: number
}): React.JSX.Element {
  const { locale } = useI18n()
  const shown = personas.length > max ? personas.slice(0, max - 1) : personas
  const more = personas.length - shown.length
  const veiled = more > 0 ? personas[shown.length] : null
  return (
    <span
      className="cf-avstack"
      style={{ '--sz': `${size}px` } as React.CSSProperties}
      title={personas.map((p) => p.name).join(locale === 'en' ? ', ' : '、')}
    >
      {shown.map((p) => (
        <span key={p.id} className="cf-avstack__ava">
          <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} />
        </span>
      ))}
      {veiled && (
        <span className="cf-avstack__ava">
          <PersonaFace seed={veiled.id} spec={parseAvatarSpec(veiled.avatar)} image={veiled.avatarImage} />
          <span className={`cf-avstack__veil${more >= 10 ? ' is-wide' : ''}`}>+{more}</span>
        </span>
      )}
    </span>
  )
}

/** 可用角色里还存在的角色（按花名册顺序）；null = 所有角色。 */
function usePickedPersonas(roles: string[] | null): Persona[] {
  const { personas } = useExtensions()
  return useMemo(() => (roles === null ? [] : personas.filter((p) => roles.includes(p.id))), [personas, roles])
}

/**
 * 扩展列表行尾的可用角色：指定了角色显示头像堆叠，所有角色不显示。指定的角色都删了时主进程会把该项
 * 改回所有角色并停用（personas.ts pruneExtRoles），渲染层不再有「无可用角色」这一态。
 */
function RolesBadge({ roles }: { roles: string[] | null }): React.JSX.Element | null {
  const picked = usePickedPersonas(roles)
  return picked.length ? <AvatarStack personas={picked} /> : null
}

/**
 * 技能 / MCP 详情的「可用角色」：统一下拉框的多选模式。收起时显示「所有角色」或所选角色的头像堆叠与名字；
 * 浮层第一项「所有角色」（点了即收起），其下「只给这些角色」逐个勾选，即时生效。从所有角色点某个角色即只给它，
 * 取消到一个不剩即回到所有角色。
 */
/** 「所有角色」选项的值：角色 id 只含字母数字与 _.-，不会与之相撞。 */
const ROLES_GENERAL = '*'

function RolesPicker({
  kind,
  id,
  roles
}: {
  kind: 'skill' | 'mcp'
  id: string
  roles: string[] | null
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { personas, setRoles } = useExtensions()
  const picked = usePickedPersonas(roles)
  // 没有指定（或指定的角色刚被删、主进程正改回所有角色）都按所有角色显示。
  const all = picked.length === 0
  const sep = locale === 'en' ? ', ' : '、'

  const toggle = (pid: string): void => {
    if (pid === ROLES_GENERAL) {
      if (roles !== null) setRoles(kind, id, null)
      return
    }
    if (all) return setRoles(kind, id, [pid])
    const live = picked.map((p) => p.id)
    const next = live.includes(pid) ? live.filter((x) => x !== pid) : [...live, pid]
    setRoles(kind, id, next.length ? next : null)
  }

  const summary =
    picked.length <= 2
      ? picked.map((p) => p.name).join(sep)
      : t('extensions.rolesSummary')
          .replace('{names}', picked
            .slice(0, 2)
            .map((p) => p.name)
            .join(sep))
          .replace('{n}', String(picked.length))
          .replace('{rest}', String(picked.length - 2))

  const display = all ? (
    <>
      <span className="select__lead">
        <span className="select-icon">
          <Users size={12} />
        </span>
      </span>
      <span className="select__label">{t('extensions.rolesGeneral')}</span>
    </>
  ) : (
    <>
      <span className="select__lead">
        <AvatarStack personas={picked} size={20} max={4} />
      </span>
      <span className="select__label">{summary}</span>
    </>
  )

  return (
    <div className="ext-field">
      <label className="ext-field__label">{t('extensions.roles')}</label>
      <Select
        multiple
        aria-label={t('extensions.roles')}
        display={display}
        isSelected={(v) => (v === ROLES_GENERAL ? all : picked.some((p) => p.id === v))}
        onToggle={toggle}
        items={[
          {
            value: ROLES_GENERAL,
            label: t('extensions.rolesGeneral'),
            sub: t('extensions.rolesGeneralHint'),
            // 「所有角色」是一个整体，点了同单选一样收起；只有具体角色才多选。
            closeOnPick: true,
            lead: (
              <span className="select-icon">
                <Users size={14} />
              </span>
            )
          },
          { separator: true },
          { group: t('extensions.rolesOnly') },
          ...personas.map((p) => ({
            value: p.id,
            label: p.name,
            sub: p.desc || undefined,
            lead: (
              <span className="select-ava">
                <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} />
              </span>
            )
          }))
        ]}
      />
    </div>
  )
}

/**
 * 技能详情（对话优先外壳）：只读的钻取式主从抽屉，顶栏与名称分隔线同 MCP 详情（返回 · 删除 · 启用）。
 * 只展示名称、可用角色与 SKILL.md 正文；描述及其余 frontmatter 字段（compatibility / license / metadata /
 * allowed-tools，以及 Deva 自有的 trigger）一律不显示。整页撑满设置面板、不出外层滚动条：
 * 正文吃掉剩余高度、过长时框内滚动。删除 = 技能文件夹移到系统回收站。
 * 仅自定义技能可进入；内置技能在列表里不可点开。
 */
function SkillDetail({ item, onBack }: { item: Skill; onBack: () => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const { toggle, removeSkill } = useExtensions()

  const onDelete = (): void => {
    const name = clipName(item.name)
    void (async () => {
      const ok = await dialog.confirm({
        title: locale === 'en' ? `Delete skill “${name}”?` : `删除技能 ${name} ？`,
        message: t(IS_MAC ? 'cf.skillDeleteConfirmMac' : 'cf.skillDeleteConfirm'),
        confirmText: t('cf.delete'),
        variant: 'danger'
      })
      if (!ok) return
      if (await removeSkill(item.id)) onBack()
      else toast.show({ variant: 'error', message: t('cf.skillDeleteFailed') })
    })()
  }

  return (
    <section className="provider-detail provider-detail--fill" key={item.id}>
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('common.back')}
        </button>
        <div className="provider-detail__spacer" />
        <button className="icon-btn provider-detail__del" title={t('extensions.remove')} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('extensions.enable')}</span>
        <Toggle on={item.enabled} onChange={() => toggle('skill', item.id)} />
      </div>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Puzzle size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono">{item.name}</h2>
      </header>

      <RolesPicker kind="skill" id={item.id} roles={item.roles} />

      <div className="ext-field ext-field--grow">
        <label className="ext-field__label">{t('extensions.instructions')}</label>
        {item.instructions ? (
          <div className="ext-detail__md">
            <Markdown text={item.instructions} />
          </div>
        ) : (
          <span className="ext-detail__muted">{t('extensions.instructionsEmpty')}</span>
        )}
      </div>
    </section>
  )
}

/** 详情页运行期状态字形（● 连接 / ! 错或待处理 / ○ 未启用）。 */
const MCP_STATUS_GLYPH: Record<McpStatus, string> = {
  connected: '●',
  connecting: '●',
  error: '!',
  needs_config: '!',
  needs_secret: '!',
  disconnected: '○'
}

/** 已启用却没连上、需要用户处理的状态（列表注记用警示色）。 */
const MCP_STATUS_WARN = new Set<McpStatus>(['error', 'needs_config', 'needs_secret'])

/**
 * MCP 详情编辑（对话优先外壳）：钻取式主从抽屉，形态对齐模型设置页（顶部返回 + 逐字段即时落盘）。
 * 传输 / 命令 / 参数 / 环境变量（或 URL / 请求头）经 update('mcp', …) round-trip 到 mcp.json；名称只读
 * （创建时定下，见 create_mcp：改名不改 id、也不刷新已发给模型的工具说明，故不提供）。
 * 密钥恒经 mcpSetSecret 加密另存、写后不回显（`{secretRef}` 占位符落盘，明文零留痕）。
 */
function McpEditor({ item, onBack }: { item: McpServer; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const { update, remove, toggle, mcpRetry, mcpSetSecret } = useExtensions()
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
      {/* 顶部工具条「返回 + 删除/启用」同一行，对齐模型设置页 */}
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('common.back')}
        </button>
        <div className="provider-detail__spacer" />
        <button className="icon-btn provider-detail__del" title={t('extensions.remove')} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('extensions.enable')}</span>
        <Toggle on={item.enabled} onChange={() => toggle('mcp', item.id)} />
      </div>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Plug size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono ext-detail__name--clip" title={item.name}>
          {item.name}
        </h2>
        {/* 启用即连接：状态只读展示在标题行最右侧，唯一的动作是失败后「重试」。未启用一律显示「未启用」。 */}
        <span className={`ext-status__live ext-status__live--${item.enabled ? item.status : 'disconnected'}`}>
          {item.enabled
            ? `${MCP_STATUS_GLYPH[item.status]} ${t(`extensions.status.${item.status}`)}`
            : `${MCP_STATUS_GLYPH.disconnected} ${t('extensions.status.off')}`}
          {item.enabled && item.status === 'connected' && item.toolCount > 0
            ? ` · ${item.toolCount} ${t('extensions.tools')}`
            : ''}
        </span>
        {item.enabled && item.status === 'error' && (
          <button className="ext-linkbtn" onClick={() => mcpRetry(item.id)}>
            {t('extensions.retry')}
          </button>
        )}
      </header>
      {item.enabled && item.status === 'error' && item.lastError && (
        <div className="mcp-error">{item.lastError}</div>
      )}
      {item.enabled && item.status === 'needs_config' && item.lastError && (
        <div className="mcp-error mcp-error--warn">{item.lastError}</div>
      )}
      {item.enabled && item.status === 'needs_secret' && (
        <div className="mcp-error mcp-error--warn">
          {t('extensions.missingSecrets').replace('{fields}', item.missingSecrets.join(', '))}
        </div>
      )}

      <RolesPicker kind="mcp" id={item.id} roles={item.roles} />

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.transport')}</label>
        <Select<McpServer['transport']>
          mono
          aria-label={t('extensions.transport')}
          value={item.transport}
          onChange={(transport) => update('mcp', item.id, { transport })}
          items={[
            { value: 'stdio', label: 'stdio', sub: t('extensions.transportSub.stdio') },
            { value: 'sse', label: 'sse', sub: t('extensions.transportSub.sse') },
            { value: 'http', label: 'http (streamable)', sub: t('extensions.transportSub.http') }
          ]}
        />
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
        <img className="cf-about__icon" src={devaIcon} alt="" aria-hidden />
        <div className="cf-about__name">{t('app.name')}</div>
        <div className="cf-about__ver">
          {t('settings.version')} {__APP_VERSION__}
        </div>
        {t('app.tagline') && <p className="cf-about__desc">{t('app.tagline')}</p>}
        <UpdateSection />
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
//  - 角色：seed=persona.id，叠加其 avatar spec（若有）。
//  - 用户：个人资料里的头像（图片 / spec；未配置时主进程回默认头像），读到前回落固定 seed（USER_AVATAR_SEED）。
// 结构：外层 .cf-ava 作定位框，内层 .cf-ava__face 圆形裁剪头像（无描边）。
function Avatar({
  persona,
  user,
  size,
  busy,
  attention,
  unread
}: {
  persona?: Persona
  user?: boolean
  size?: number
  /** 忙碌（对话生成中）：头像上叠一道自左向右扫过的高光带，作就地「思考/生成中」指示。 */
  busy?: boolean
  /** 待你处理（问答 / 计划 / 挂载 / 待确认名片）：右上角红点。 */
  attention?: boolean
  /** 有新消息未读：右上角红点。 */
  unread?: boolean
}): React.JSX.Element | null {
  const profile = useProfile()
  const style = { ...(size ? { '--sz': `${size}px` } : {}) } as React.CSSProperties
  const cls = `cf-ava${busy ? ' is-busy' : ''}${user ? ' is-user' : ''}`
  // 遮层必须排在 .cf-ava__face 之后：同为 inset:0 的绝对定位兄弟，靠文档顺序压在头像之上；红点再压在最上。
  const sweep = busy ? <span className="cf-ava__sweep" aria-hidden="true" /> : null
  const marks = unread || attention ? <span className="cf-ava__dot" aria-hidden="true" /> : null
  // 非用户、非角色（理论上罕见）：空占位圈。
  if (!user && !persona)
    return (
      <div className={cls} style={style}>
        {sweep}
        {marks}
      </div>
    )
  const seed = user ? USER_AVATAR_SEED : (persona as Persona).id
  const spec = user ? profile.avatar : parseAvatarSpec((persona as Persona).avatar)
  const title = user
    ? undefined
    : `${(persona as Persona).name} · ${(persona as Persona).desc}${(persona as Persona).model ? ` · ${(persona as Persona).model}` : ''}`
  return (
    <div className={cls} style={style} title={title}>
      <span className="cf-ava__face">
        <PersonaFace
          seed={seed}
          spec={spec}
          image={user ? profile.avatarImage : (persona as Persona).avatarImage}
          title={title}
        />
      </span>
      {sweep}
      {marks}
    </div>
  )
}
