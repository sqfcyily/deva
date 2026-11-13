import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BotsPane } from './BotsPane'
// 关于页的应用图标：直接用安装包图标的源文件，图形只维护一份
import './redesign.css'
import type { Persona } from '../mock/extensions'
import type { MemberMeta, TaskRecord } from '../../../preload'
import {
  type ChatBlock,
  type SessionMeta,
  useChatState,
  useChatActions
} from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import {
  ICONRAIL_W,
  ICONRAIL_W_MAC,
  ResizeHandle,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT,
  clampSidebar,
  loadLayout,
  saveLayout,
  useViewport
} from './resizable'
import { clipName, IS_MAC, DEFAULT_PERSONA_ID, fill } from './shell-common'
import { type MemberEntry, memberPersona } from './MemberBar'
import { type RailTab, IconRail, Rail, QuickStart, RosterEmpty } from './Rail'
import { TasksPane, TaskFormModal } from './TasksPane'
import { LiveConversation } from './Conversation'
import { type SlashCommand, type ComposerPrefill, restoreToComposer } from './Composer'
import { type EditorState, ProfileView, PersonaEditor } from './ProfileView'
import { type SettingsInit, Settings } from './SettingsPane'

/**
 * 「对话优先」外壳（已接真实 store）。
 *
 * 形态（借鉴 IM 应用的单人对话）：
 *  - 左栏两个 tab：消息（对话列表，来自 useChatState().sessions）/ 角色（花名册，来自 useExtensions().personas）
 *  - 一对话一身份：中列是「我 ↔ 某一个角色」的单人对话，头顶显示当值角色（persona 单选、首发绑定后不可改）
 *  - 角色可查看资料、可反复发起对话；「添加/编辑角色」走 PersonaEditor（round-trip upsertPersona）
 *  - 工作区可选：头部一个 chip，挂了文件夹就「聚焦中」（focusRoot），没挂就是全机通用助手
 *  - 动手全内联：复用 features/chat/blocks 的 BlockView / StatusIndicator / deriveActivity 渲染工具/权限/思考/子智能体
 *
 * 安全不变式全程不动：角色不收窄工具，每次调用都过同一闸门；聚焦挂载复用 fs.openFolder 的
 * trustRoot；Agent 文件读写与命令执行不设任何限制。旧壳（PREVIEW_CHAT_FIRST=false）零回归靠后端 personaId 缺省 gate。
 */

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

export function ChatFirstShell(): React.JSX.Element {
  const {
    sessions: storedSessions,
    currentSessionId,
    sessionStates,
    currentBinding,
    draftSession,
    pendingCards
  } = useChatState()
  const {
    send,
    stop,
    newSession,
    selectSession,
    deleteSession,
    renameSession,
    setArchived,
    deleteSessions,
    deleteTurns,
    mountFocus,
    respondAsk,
    respondPlan,
    respondMount,
    removeMember,
    onInsertsReturned
  } = useChatActions()
  const { personas, remove, reorderPersonas } = useExtensions()
  const { tasks, setStatus: setTaskStatus, runNow: runTaskNow, update: updateTask, remove: removeTask } = useTasks()
  const { t, locale } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  // 绑定在某个主对话上的定时任务（见 design/task-entry-README.md）：任务对话不进左侧列表、不算「其他对话有动静」，
  // 从主对话标题栏的闹钟入口进入。
  const boundTasks = useMemo(() => tasks.filter((x) => !!x.ownerSessionId), [tasks])
  const boundTaskSessions = useMemo(() => new Set(boundTasks.map((x) => x.sessionId)), [boundTasks])

  // 回合被停止或出错时还没送达的插入消息：放回所属会话的输入框（正在看就直接放进去，否则进那个会话的草稿）。
  useEffect(() => onInsertsReturned(restoreToComposer), [onInsertsReturned])

  const [railTab, setRailTab] = useState<RailTab>('chats')
  // 图标栏「对话」按钮的红点：其他对话有新消息或待你处理时亮起（与头像红点同口径）。只认列表里看得到的对话：
  // 删除正在跑的对话时回合被中止，随后的 done 仍会给它记一条未读；已归档的不再提醒（含仍待确认的名片）。
  // 不过滤就成了点开找不到的红点。
  const chatAlert = useMemo(() => {
    const visible = new Set(
      storedSessions.filter((s) => !s.archived && !boundTaskSessions.has(s.id)).map((s) => s.id)
    )
    return Object.entries(sessionStates).some(
      ([id, st]) => id !== currentSessionId && visible.has(id) && (st.unread || st.attention)
    )
  }, [sessionStates, currentSessionId, storedSessions, boundTaskSessions])
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
   * quote：放进输入框顶部的引用条（右键「引用」），不动输入的文字。
   */
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefill | null>(null)

  /** 兜底身份：优先 general，其次首个（花名册非空时）。 */
  const defaultPersona = useMemo(
    () => personas.find((p) => p.id === DEFAULT_PERSONA_ID) ?? personas[0],
    [personas]
  )
  const defaultPersonaId = defaultPersona?.id

  // 定时任务以自己的身份发言时的头像用任务所用的角色（未指定或角色已删 = 默认角色，同主进程执行时），见 TaskSpeakerFace。
  // 消息里只记了任务名：先找在当前对话中运行的同名任务，再找全部（改为独立运行后，旧消息仍按原角色画）。
  const taskPersonaOf = useCallback(
    (title: string): Persona | undefined => {
      const name = title.trim()
      const task =
        tasks.find((x) => x.ownerSessionId === currentSessionId && x.title === name) ??
        tasks.find((x) => x.title === name)
      const pid = task?.auth.personaId
      return (pid ? personas.find((p) => p.id === pid) : undefined) ?? defaultPersona
    },
    [tasks, personas, defaultPersona, currentSessionId]
  )

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

  // 成员对话：当前会话是某个主对话的成员会话（成员会话不进列表，名单挂在主对话上，见 store SessionMeta.members）。
  const memberOf = useMemo(() => {
    for (const s of sessions) {
      const member = s.members?.find((m) => m.sessionId === currentSessionId)
      if (member) return { parent: s, member }
    }
    return null
  }, [sessions, currentSessionId])

  // 任务对话：当前会话是某个绑定任务的任务对话（标题栏换成「‹ 主角色 | 闹钟 任务名」）。主对话已不在时按普通对话看。
  const taskOf = useMemo(() => {
    const task = boundTasks.find((x) => x.sessionId === currentSessionId)
    const parent = task ? sessions.find((x) => x.id === task.ownerSessionId) : undefined
    return task && parent ? { task, parent } : null
  }, [boundTasks, sessions, currentSessionId])
  // 看着任务对话时任务被删（任务对话随之删除）：回到它的主对话；主对话也没了（连带删除）则回列表第一条。
  const lastTaskViewRef = useRef<{ sid: string; owner: string } | null>(null)
  useEffect(() => {
    const prev = lastTaskViewRef.current
    if (taskOf) {
      lastTaskViewRef.current = { sid: taskOf.task.sessionId, owner: taskOf.parent.id }
      return
    }
    if (!prev || prev.sid !== currentSessionId) return
    lastTaskViewRef.current = null
    const target = sessions.some((x) => x.id === prev.owner)
      ? prev.owner
      : sessions.find((x) => !x.archived && !boundTaskSessions.has(x.id))?.id
    if (target) selectSession(target)
  }, [taskOf, currentSessionId, sessions, boundTaskSessions, selectSession])

  /** 当值身份（当前对话绑定的 persona；未绑定或已不存在时为默认角色，同上）。看成员记录时是它所属主对话的角色。 */
  const owner =
    personas.find((p) => p.id === (memberOf ? memberOf.parent.personaId : currentBinding.personaId)) ??
    defaultPersona
  const toMemberEntry = (m: MemberMeta): MemberEntry => ({ meta: m, persona: memberPersona(m, personas, defaultPersona) })
  // 当前主对话的成员（未移除的），标题栏头像与 @ 联想用。
  const currentMembers = useMemo<MemberEntry[]>(
    () =>
      memberOf
        ? []
        : (sessions.find((s) => s.id === currentSessionId)?.members ?? [])
            .filter((m) => !m.removed)
            .map((m) => ({ meta: m, persona: memberPersona(m, personas, defaultPersona) })),
    [memberOf, sessions, currentSessionId, personas, defaultPersona]
  )
  // 当前主对话里已移除的成员：对话里旧的派任务步骤、交差回复照样按名字认出头像。
  const formerMembers = useMemo<MemberEntry[]>(
    () =>
      memberOf
        ? []
        : (sessions.find((s) => s.id === currentSessionId)?.members ?? [])
            .filter((m) => m.removed)
            .map((m) => ({ meta: m, persona: memberPersona(m, personas, defaultPersona) })),
    [memberOf, sessions, currentSessionId, personas, defaultPersona]
  )
  // 输入框开头敲 @ 的联想（对比稿 design/mention-panel.html 方案 A）：第一项「新建成员」（写需求由主角色建），
  // 其后本对话的成员（标「成员」），再后其他已启用的角色（@ 即加入本对话）。
  const mentionables = useMemo<SlashCommand[]>(() => {
    if (memberOf) return []
    const out: SlashCommand[] = [
      {
        name: t('cf.member.newToken'),
        label: t('cf.member.newMember'),
        desc: fill(t('cf.member.newMemberDesc'), { owner: owner?.name ?? '' }),
        kind: 'newMember'
      }
    ]
    for (const m of currentMembers)
      out.push({ name: m.meta.name, desc: m.meta.duty, kind: 'mention', persona: m.persona, member: true })
    const hint = fill(t('cf.member.mentionHint'), { owner: owner?.name ?? '' })
    for (const p of personas)
      if (p.enabled && p.id !== owner?.id && !out.some((c) => c.kind === 'mention' && c.name === p.name))
        out.push({ name: p.name, desc: p.desc || hint, kind: 'mention', persona: p })
    return out
  }, [memberOf, currentMembers, personas, owner, t])
  // 移除成员：一律先确认；它正在工作时另说明当前任务会中止。
  const removeMemberFrom = (mainId: string, m: MemberMeta): void => {
    const busy = !!sessionStates[m.sessionId]?.streaming
    void (async () => {
      const ok = await dialog.confirm({
        title: fill(t('cf.member.removeTitle'), { name: m.name }),
        message: fill(t(busy ? 'cf.member.removeBusyMessage' : 'cf.member.removeMessage'), {
          name: m.name,
          owner: owner?.name ?? ''
        }),
        variant: 'danger',
        confirmText: t('cf.member.remove')
      })
      if (ok) removeMember(mainId, m.sessionId)
    })()
  }

  // 左侧列表数据源：把「草稿会话」（尚未落库的空对话）并到已落库会话之前——与角色开启新对话时，该对话
  // 立即出现在聊天列表（内容可为空）。草稿 id 必不在 sessions 中（见 store.draftSession），无需去重；
  // 首发落库后 draftSession 转 null、真值并入 sessions，列表项按同 id 无缝接管。
  // 绑定任务的任务对话不进列表（从主对话标题栏的闹钟入口进入）。
  const railSessions = useMemo(
    () => (draftSession ? [draftSession, ...sessions] : sessions).filter((s) => !boundTaskSessions.has(s.id)),
    [draftSession, sessions, boundTaskSessions]
  )
  // 列表里一条对话都没有（已归档的不算）、右侧也没开着已归档对话或成员记录 / 任务对话 → 右侧显示快速开启页。
  const noThreads =
    !memberOf && !taskOf && !railSessions.some((s) => !s.archived || s.id === currentSessionId)

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

  // 绑定任务的操作（标题栏闹钟列表、任务对话标题栏）：立即运行（同管理页的提示）、暂停 / 继续、编辑（同管理页的表单）。
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const editTask = useMemo(() => tasks.find((x) => x.id === editTaskId) ?? null, [tasks, editTaskId])
  const runBoundTask = (task: TaskRecord): void => {
    void (async () => {
      const res = await runTaskNow(task.id)
      if (res.ok && res.already) {
        const running = res.already === 'running'
        toast.show({
          title: t(running ? 'tasks.runNowAlreadyRunning' : 'tasks.runNowAlreadyQueued'),
          message: t(running ? 'tasks.runNowAlreadyRunningHint' : 'tasks.runNowAlreadyQueuedHint')
        })
      } else if (res.ok) {
        toast.show({ title: t('tasks.runNowStarted'), variant: 'success' })
      } else {
        await dialog.confirm({ title: t('tasks.runNowFailed'), message: res.reason || '', confirmText: t('common.close') })
      }
    })()
  }
  const toggleBoundTask = (task: TaskRecord): void => {
    void setTaskStatus(task.id, task.status === 'active' ? 'paused' : 'active')
  }
  // 对话里定时任务列表的「删除」：先弹确认框（同定时任务页）；在会话中运行的任务连它的任务对话一起删（见主进程
  // tasks.ts deleteTask）。
  const deleteBoundTask = (task: TaskRecord): void => {
    const name = clipName(task.title || t('chat.untitled'))
    void (async () => {
      const ok = await dialog.confirm({
        title: locale === 'en' ? `Delete task “${name}”?` : `删除定时任务 ${name} ？`,
        message: t(task.ownerSessionId ? 'tasks.deleteBoundConfirm' : 'tasks.deleteConfirm'),
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      if (ok) await removeTask(task.id)
    })()
  }

  // 右键删除（对话 / 角色）：先弹居中确认框（破坏性 → 红色确认键），确认后才走既有删除通路——
  // 对话经 deleteSession（中止在跑回合 + 落盘删除 + 切到最近会话），角色经 remove('persona')。
  // 标题直接写成「删除对话 xxx ？/删除角色 xxx ？」这一动作问句（比裸标题更醒目），随语言拼装；
  // 名字经 clipName 限长，过长截断补「…」，免得撑宽 / 撑高弹框。
  // 主对话的成员及它们的对话会一并删除；在它里面运行的定时任务改为独立运行：确认框里写明。
  const deleteThread = (id: string, title: string): void => {
    const name = clipName(title || t('chat.untitled'))
    const heading = locale === 'en' ? `Delete conversation “${name}”?` : `删除对话 ${name} ？`
    const mem = (sessions.find((x) => x.id === id)?.members ?? []).filter((m) => !m.removed)
    const owned = boundTasks.filter((x) => x.ownerSessionId === id)
    const sep = t('cf.member.nameSep')
    const items = mem.length
      ? [fill(t('cf.deleteChatMembers'), { n: String(mem.length), names: mem.map((m) => m.name).join(sep) })]
      : []
    const message =
      (items.length
        ? `${t('cf.deleteChatConfirm')}${fill(t('cf.deleteChatCascade'), { items: items.join(locale === 'en' ? '; ' : '；') })}`
        : t('cf.deleteChatConfirm')) +
      (owned.length
        ? fill(t('cf.deleteChatTasksAlone'), { n: String(owned.length), names: owned.map((x) => x.title).join(sep) })
        : '')
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message,
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
    // 对话正在进行 / 压缩 / 回滚时不删（含主进程自己起的轮，如定时任务、手机端消息）：保留选择，等结束后再删。
    if (!(await deleteTurns(indices))) {
      toast.show({ variant: 'warning', message: t('cf.deleteTurnsBusy') })
      return false
    }
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
            onOpenChat={openThread}
          />
        ) : (
          <>
            <Rail
              tab={railTab}
              sessions={railSessions}
              personas={personas}
              // 看成员记录时，列表里高亮它所属的主对话。
              currentSessionId={memberOf ? memberOf.parent.id : currentSessionId}
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
              boundTasks={boundTasks}
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
              <LiveConversation
                // 成员记录里助手消息是成员说的：头像与名字用成员的身份。
                owner={memberOf ? memberPersona(memberOf.member, personas, defaultPersona) : owner}
                currentSessionId={currentSessionId}
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
                onPrefill={(text, quote) => setComposerPrefill({ text, nonce: Date.now(), quote })}
                onPrefillConsumed={() => setComposerPrefill(null)}
                members={currentMembers}
                formerMembers={formerMembers}
                sessionStates={sessionStates}
                mentionables={mentionables}
                onOpenMember={(id) => selectSession(id)}
                onRemoveMember={(m) => removeMemberFrom(currentSessionId, m)}
                pendingCards={pendingCards}
                boundTasks={taskOf || memberOf ? [] : boundTasks.filter((x) => x.ownerSessionId === currentSessionId)}
                taskPersonaOf={taskPersonaOf}
                onOpenTask={(task) => selectSession(task.sessionId)}
                onRunTask={runBoundTask}
                onToggleTask={toggleBoundTask}
                onDeleteTask={deleteBoundTask}
                onEditTask={(task) => setEditTaskId(task.id)}
                taskView={
                  taskOf
                    ? {
                        task: taskOf.task,
                        owner: personas.find((p) => p.id === taskOf.parent.personaId) ?? defaultPersona,
                        onBack: () => selectSession(taskOf.parent.id),
                        backAlert: !!(
                          sessionStates[taskOf.parent.id]?.unread || sessionStates[taskOf.parent.id]?.attention
                        )
                      }
                    : undefined
                }
                memberView={
                  memberOf
                    ? {
                        entry: toMemberEntry(memberOf.member),
                        owner,
                        mainRoot: memberOf.parent.focusRoot ?? null,
                        onBack: () => selectSession(memberOf.parent.id),
                        backAlert: !!(
                          sessionStates[memberOf.parent.id]?.unread || sessionStates[memberOf.parent.id]?.attention
                        )
                      }
                    : undefined
                }
              />
            )}
          </>
        )}
      </div>

      {editor && <PersonaEditor initial={editor} onClose={() => setEditor(null)} />}
      {settingsOpen && <Settings initial={settingsInit} onClose={() => setSettingsOpen(false)} />}
      {/* 从任务对话标题栏「编辑任务」打开的表单（同管理页）。不显示运行方式：这里是从某个对话进来的，改到别的对话后
          「返回」就会回到那个对话；运行方式到定时任务页里改。 */}
      {editTask && (
        <TaskFormModal
          key={editTask.id}
          task={editTask}
          hideRunMode
          onClose={() => setEditTaskId(null)}
          onSubmit={async (input) => {
            await updateTask({ id: editTask.id, ...input })
            setEditTaskId(null)
            return null
          }}
        />
      )}
    </div>
  )
}
