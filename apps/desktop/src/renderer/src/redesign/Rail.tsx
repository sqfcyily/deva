/**
 * 左侧图标栏与对话列表（搜索、筛选、分组、行菜单、新建对话 / 角色）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpToLine,
  ChevronRight,
  Cog,
  Folder,
  FolderMinus,
  Globe,
  ListFilter,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Bot,
  Trash2,
  Users,
  X
} from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type {
  TaskRecord
} from '../../../preload'
import { useBrowserState } from '../features/browser/shared'
import {
  type SessionLiveState,
  type SessionMeta
} from '../store/chat'
import { useI18n } from '../i18n/i18n'
import { PersonaFace, parseAvatarSpec } from '../components/humation'
import { ProfilePanel } from './ProfilePanel'
import {
  basename,
  DragBar,
  DEFAULT_PERSONA_ID,
  useRelativeTime,
  fill,
  useHoverMenu,
  Avatar
} from './shell-common'
import { ContextMenu } from './ContextMenu'
import { memberPersona } from './MemberBar'
import { useDraftPreview } from './Composer'

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

/** 图标栏的 tab：对话 / 角色 / 定时任务 / 机器人。 */
export type RailTab = 'chats' | 'roster' | 'tasks' | 'bots'

/* ============================ 最左：图标导航栏（微信式） ============================ */
/**
 * 窄图标栏：顶部当前用户头像，中部「对话 / 角色」切换（点击切左栏列表列），底部设置入口。
 * 把原先挤在列表列顶部的文字 tab 与底部的用户/设置脚移到这里，列表列因而只承载列表本身。
 */
export function IconRail({
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

export function Rail({
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
  boundTasks,
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
  /** 绑定在各主对话上的定时任务（主对话行上打闹钟徽标）。 */
  boundTasks: TaskRecord[]
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
  // 各主对话绑定的定时任务（对话行上打闹钟徽标，悬停列出任务名）
  const tasksBySession = useMemo(() => {
    const m: Record<string, TaskRecord[]> = {}
    for (const x of boundTasks) if (x.ownerSessionId) (m[x.ownerSessionId] ??= []).push(x)
    return m
  }, [boundTasks])
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
  const threadRow = (s: SessionMeta): React.JSX.Element => {
    const owner = personas.find((p) => p.id === s.personaId)
    // 成员的显示身份与是否在工作，一一对应（认不出身份的成员两边一起去掉）。
    const members = (s.members ?? [])
      .filter((m) => !m.removed)
      .map((m) => ({ persona: memberPersona(m, personas, owner), working: !!sessionStates[m.sessionId]?.streaming }))
      .filter((x): x is { persona: Persona; working: boolean } => !!x.persona)
    return (
    <ThreadRow
      key={s.id}
      session={s}
      owner={owner}
      memberFaces={members.map((x) => x.persona)}
      state={sessionStates[s.id]}
      membersWorking={members.map((x) => x.working)}
      browserPages={browserPages[s.id] ?? 0}
      tasks={tasksBySession[s.id] ?? []}
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
  }
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
export function AddMenu({
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

/**
 * 群组头像（有成员的对话，占 38px 头像列）：两人左右堆叠、三人三角排布（参考图 1）、四人 2×2 稍微堆叠（只压 2px），
 * 超过四人时第 4 枚（右下）盖半透明深色层写 +N（N 含被盖住的这一位）。都是后一枚压住前一枚（同参考图 1），
 * 写 +N 的第 4 枚自然在最上面；人物脸朝左，被压住的多是右侧头发与下方肩膀，脸仍露着。
 * 主角色排第一位（左 / 上 / 左上）；头像一律框内构图，压处的分隔环取行底色。
 * 两人时头像放大到 28px，左右各越出头像列 3px（落在行内边距与文字间距里，不挤文字）。
 * 生成中谁在工作谁变星芒（对比稿 design/group-busy-burst.html 方案 A）：主角色在回复就是主角色那枚，成员在工作就是
 * 那位成员；写 +N 的第 4 枚代表它自己和没露脸的人，其中任何一位在工作它就变。待处理 / 未读红点在方框右上角。
 */
const GROUP_LAYOUT: Record<1 | 2 | 3 | 4, { size: number; ring: boolean; at: [number, number][] }> = {
  // 只剩一位（主角色不存在、只有一个成员）：照单人头像画满
  1: { size: 38, ring: false, at: [[0, 0]] },
  2: { size: 28, ring: true, at: [[-3, 5], [13, 5]] },
  3: { size: 21, ring: true, at: [[8.5, 0], [0, 17], [17, 17]] },
  // 20px 四枚，相邻只压住 2px（偏移 18），整体正好 38px
  4: { size: 20, ring: true, at: [[0, 0], [18, 0], [0, 18], [18, 18]] }
}

export function GroupFace({
  people,
  working,
  dot,
  title
}: {
  people: Persona[]
  /** 与 people 一一对应：这一位是否在工作（主角色在回复 / 成员在干活）。 */
  working?: boolean[]
  dot?: boolean
  title?: string
}): React.JSX.Element {
  const shown = people.slice(0, 4)
  const more = people.length > 4 ? people.length - 3 : 0
  const layout = GROUP_LAYOUT[shown.length as 1 | 2 | 3 | 4]
  return (
    <span className={`cf-group${layout.ring ? ' is-overlap' : ''}`} title={title}>
      {shown.map((p, i) => {
        const [x, y] = layout.at[i]
        const veiled = more > 0 && i === 3
        const busy = veiled ? !!working?.slice(3).some(Boolean) : !!working?.[i]
        return (
          <span
            key={`${i}:${p.id}`}
            className="cf-group__face"
            style={{ left: x, top: y, width: layout.size, height: layout.size }}
          >
            <PersonaFace
              seed={p.id}
              spec={parseAvatarSpec(p.avatar)}
              image={p.avatarImage}
              compact
              busy={busy}
              veil={veiled}
            />
            {veiled && <span className="cf-group__more">+{more}</span>}
          </span>
        )
      })}
      {dot && <span className="cf-ava__dot" aria-hidden="true" />}
    </span>
  )
}

function ThreadRow({
  session,
  owner,
  memberFaces,
  state,
  membersWorking,
  browserPages,
  tasks,
  active,
  onClick,
  onContext
}: {
  session: SessionMeta
  owner?: Persona
  /** 成员的显示身份（未移除的，按加入先后）：有成员时头像换成群组头像（GroupFace）。 */
  memberFaces: Persona[]
  state?: SessionLiveState
  /** 与 memberFaces 一一对应：这位成员是否正在工作（群组头像里谁在工作谁变星芒）。定时任务不算。 */
  membersWorking: boolean[]
  /** 这个对话在内置浏览器里开着几个网页（>0 时标题旁打地球徽标）。 */
  browserPages: number
  /** 绑定在这个对话上的定时任务（>0 时打闹钟徽标，悬停列出任务名）。 */
  tasks: TaskRecord[]
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
  // 有项目成员（协作者）：头像换成群组头像（堆叠 / 三角 / 四宫格），悬停列出成员名。
  const members = (session.members ?? []).filter((m) => !m.removed)
  return (
    <button
      className={`cf-thread${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      {/* 对话中（streaming）→ 头像底板变成星芒并转动；有新消息 / 待你处理 → 右上角红点。
          正在查看的对话不打红点（内容就在眼前），已归档的也不打（归档即不再提醒）。 */}
      <span className="cf-thread__face">
        {memberFaces.length > 0 ? (
          <GroupFace
            people={owner ? [owner, ...memberFaces] : memberFaces}
            working={owner ? [!!state?.streaming, ...membersWorking] : membersWorking}
            dot={!active && !session.archived && (state?.attention || state?.unread)}
            title={fill(t('cf.member.threadBadge'), {
              n: String(members.length),
              names: members.map((m) => m.name).join(t('cf.member.nameSep'))
            })}
          />
        ) : (
          <Avatar
            persona={owner}
            size={38}
            busy={state?.streaming}
            attention={!active && !session.archived && state?.attention}
            unread={!active && !session.archived && state?.unread}
          />
        )}
      </span>
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
          {(isTask || tasks.length > 0 || browserPages > 0) && (
            <span className="cf-thread__badges">
              {(isTask || tasks.length > 0) && (
                <span
                  className="cf-thread__badge"
                  title={
                    tasks.length
                      ? fill(t('cf.task.threadBadge'), {
                          n: String(tasks.length),
                          names: tasks.map((x) => x.title).join(t('cf.member.nameSep'))
                        })
                      : t('cf.tabTasks')
                  }
                >
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

/* ============================ 中列：快速开启（无任何对话时的空态） ============================ */
/**
 * 左侧对话被清空后中列的落点：列出花名册全部角色，点头像/卡片直接与该角色开启新对话
 * （onStart → startWith：新建并落盘一条绑定该角色的空对话，随即切入消息视图）。
 * 默认角色 Deva 删不掉，花名册只在加载完成前为空，此时网格先留空。
 */
export function QuickStart({
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
export function RosterEmpty(): React.JSX.Element {
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
