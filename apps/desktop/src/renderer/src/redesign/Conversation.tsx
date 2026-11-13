/**
 * 对话流：分段渲染、滚动跟随、轮次目录。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Check, Copy, ListChecks, RotateCcw, TextQuote } from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type { MemberMeta, TaskRecord } from '../../../preload'
import { SubagentProgressNotice } from '../features/chat/BackgroundTasks'
import { useBrowserState } from '../features/browser/shared'
import { ModelSetupCard } from '../features/chat/ModelSetupCard'
import {
  type ChatBlock,
  type ChatMessage,
  type PendingCard,
  type SendAttachment,
  type SessionLiveState,
  type StreamStatus
} from '../store/chat'
import { hasUsableModel, useModels } from '../store/models'
import { NEW_MEMBER_TOKENS } from '../../../shared/mention'
import { useI18n } from '../i18n/i18n'
import {
  avatarDataUri,
  parseAvatarSpec
} from '../components/humation'
import {
  StatusIndicator,
  deriveActivity,
  hasProcess,
  MemberFaceContext,
  TaskNamesContext
} from '../features/chat/blocks'
import { RewindModal } from './RewindModal'
import { fill } from './shell-common'
import { ContextMenu } from './ContextMenu'
import { type MemberEntry, MemberBar, type MemberWait, MemberAsks } from './MemberBar'
import { TaskBar, TaskLogHead, MemberLogHead } from './TaskBar'
import {
  type MentionLookup,
  MentionContext,
  quoteOf,
  splitQuotes,
  type MemberReportHead,
  withoutHeadline,
  MemberInlineFace,
  ConvMessage
} from './ConvMessage'
import { type SlashCommand, type ComposerPrefill, MemberProgressNotice, Composer } from './Composer'

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
 * 索引里有的轮起点（同 tocItems）：用户消息与后台通知行、成员对话里派来的任务。成员交差 / 唤醒主角色那种
 * 不显示的起点（.is-quiet）不算——它们不进索引，算进来就会出现「当前轮在索引里没有、一项都不亮」。
 */
const TOC_ANCHOR = '.cf-msg.is-user[data-turn]:not(.is-quiet), .cf-msg.is-task[data-turn]'

/**
 * 面板一屏最多显示的索引条数，多出的在列表内部滚动（条数本身不设上限）。
 * 不做成「条数 × 固定行高」的估算：索引项 1~2 行不定高，收起态只剩刻度更矮，
 * 必须实测第 N 条的底边才不会多显或少显一条。
 */
const TOC_VISIBLE_MAX = 10

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

export function Conversation({
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
  onPrefillConsumed,
  members,
  formerMembers,
  sessionStates,
  mentionables,
  onOpenMember,
  onRemoveMember,
  pendingCards,
  boundTasks,
  taskPersonaOf,
  onOpenTask,
  onRunTask,
  onToggleTask,
  onDeleteTask,
  onEditTask,
  taskView,
  memberView
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
  /** sessionId 缺省为当前对话；在主对话里答成员的卡时传成员会话 id（三个回应同）。 */
  onAsk: (key: string, answers: string[], sessionId?: string) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string, sessionId?: string) => void
  /** 回应「请求挂载工作区」（path=用户选定目录 / null=暂不挂载）。 */
  onMountReq: (key: string, path: string | null, sessionId?: string) => void
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
  prefill: ComposerPrefill | null
  /** 请求预填输入框（回滚恢复对话后把该轮原问题放回去）；quote=true 是放进引用条（右键「引用」）。 */
  onPrefill: (text: string, quote?: boolean) => void
  /** Composer 消费预填后回调，父层据此置空，避免重挂载时复活旧预填。 */
  onPrefillConsumed: () => void
  /** 当前主对话的成员（未移除的）：标题栏角色名后的一排头像，点开是成员卡片。 */
  members: MemberEntry[]
  /** 当前主对话里已移除的成员：只用来给对话里旧的派任务步骤、交差回复配头像。 */
  formerMembers: MemberEntry[]
  /** 各会话的活动态：成员头像的忙碌扫光取成员会话的。 */
  sessionStates: Record<string, SessionLiveState>
  /** 输入框开头敲 @ 的联想候选（本对话成员与可加入的角色）。 */
  mentionables: SlashCommand[]
  /** 打开某个成员的对话（在当前对话区切换到它的成员会话）。 */
  onOpenMember: (memberSessionId: string) => void
  onRemoveMember: (m: MemberMeta) => void
  /** 各会话正等用户处理的交互卡：成员的在主对话末尾显示为胶囊 + 卡片（见 MemberAsks）。 */
  pendingCards: Record<string, PendingCard[]>
  /** 绑定在本对话上的定时任务：标题栏成员入口旁的闹钟入口（见 TaskBar）。 */
  boundTasks: TaskRecord[]
  /** 定时任务以自己的身份发言时，按任务名找它所用的角色（头像用，见 TaskSpeakerFace）。 */
  taskPersonaOf: (title: string) => Persona | undefined
  /** 打开某个任务的任务对话（整页切换，同成员对话）。 */
  onOpenTask: (task: TaskRecord) => void
  onRunTask: (task: TaskRecord) => void
  /** 暂停 / 继续。 */
  onToggleTask: (task: TaskRecord) => void
  /** 删除定时任务（先弹确认框）。 */
  onDeleteTask: (task: TaskRecord) => void
  onEditTask: (task: TaskRecord) => void
  /** 正在看的任务对话：标题栏换成「← 主角色 | 闹钟 任务名 · 日程 · 下次」+ 立即运行 / 暂停 / 编辑。owner 是主对话的角色。 */
  taskView?: {
    task: TaskRecord
    owner?: Persona
    onBack: () => void
    /** 主对话有新回复或待处理：返回按钮上亮提示点。 */
    backAlert: boolean
  }
  /**
   * 正在看的成员对话：标题栏换成「← 主角色 | 成员」，可以直接跟成员说话（会同步告知主角色）；主智能体派来的
   * 任务画成「X 派来的任务」。owner 是主对话的角色（本组件的 owner 此时是成员的身份）。
   */
  memberView?: {
    entry: MemberEntry
    owner?: Persona
    mainRoot: string | null
    onBack: () => void
    /** 主对话有新回复或待处理：返回按钮上亮提示点。 */
    backAlert: boolean
  }
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 成员在内置浏览器里等你操作（登录、验证等）：同提问 / 计划，在对话末尾放一枚胶囊提醒（见 MemberAsks）。
  const browserState = useBrowserState()
  // 在本对话中运行的定时任务名（小写）：主角色的 member_send / member_status 也能点到它们（见 blocks.tsx TaskNamesContext）。
  // 与成员同名的让给成员（主进程同样先找成员）。
  const taskNames = useMemo(() => {
    const memberNames = new Set([...members, ...formerMembers].map((m) => m.meta.name.toLowerCase()))
    return new Set(boundTasks.map((x) => x.title.trim().toLowerCase()).filter((n) => n && !memberNames.has(n)))
  }, [boundTasks, members, formerMembers])
  const taskNameCtx = useMemo(
    () => ({ has: (name: string) => taskNames.has(name.trim().toLowerCase()), only: taskNames.size > 0 && !members.length }),
    [taskNames, members]
  )
  // 执行步骤里成员名前的小头像（派任务、建成员等，见 blocks.tsx MemberFaceContext）：按名字在主对话名单里找，含已移除的。
  // 定时任务名前不放图标。
  const memberFace = useCallback(
    (name: string): React.ReactNode => {
      const key = name.trim().toLowerCase()
      const hit = [...members, ...formerMembers].find((m) => m.meta.name.toLowerCase() === key)
      return hit?.persona ? <MemberInlineFace persona={hit.persona} /> : null
    },
    [members, formerMembers]
  )
  // 成员会话 id → 显示身份（进度提示里的头像，含已移除的）。
  const memberPersonaOf = useCallback(
    (sid: string): Persona | undefined => [...members, ...formerMembers].find((m) => m.meta.sessionId === sid)?.persona,
    [members, formerMembers]
  )
  // 用户消息里的 @ 成员标签（见 MentionText）：现在可 @ 的成员与角色，加上已移除的成员（旧消息照样显示它当时的
  // 头像与名字），以及「新建成员」标记。成员对话里不做。
  const mentionLookup = useMemo<MentionLookup | null>(() => {
    if (memberView) return null
    const faces = new Map<string, Persona | undefined>()
    for (const c of mentionables) if (c.kind === 'mention') faces.set(c.name, c.persona)
    for (const m of formerMembers) if (!faces.has(m.meta.name)) faces.set(m.meta.name, m.persona)
    return {
      names: [...faces.keys(), ...NEW_MEMBER_TOKENS],
      face: (name) => {
        const p = faces.get(name)
        return p ? avatarDataUri(p.id, parseAvatarSpec(p.avatar), p.avatarImage) || null : null
      }
    }
  }, [memberView, mentionables, formerMembers])
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
  // selection 有值 → 提供「复制」「引用」（quote 是右键那一刻按选区算好的引用文本）；canDelete（非流式且有内容）→
  // 提供「选择删除」。二者各自独立成项。
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    turn: number | null
    selection: string
    quote: string
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
      // 成员交差的轮（不显示起点）不进索引：索引的是用户说的话。
      if (m.quiet) continue
      // 带引用（右键「引用」带进来的）时取正文，不带「>」；只有引用就用引用。
      const raw = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
      const segs = splitQuotes(raw)
      let full = (segs ? (segs.find((s) => !s.quote) ?? segs[0]).text : raw).replace(/\s+/g, ' ').trim()
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
  // 只按索引里有的轮起点算（见 TOC_ANCHOR）：成员交差那种不显示的起点算进来的话，滚到成员回复 / 汇总时
  // 当前轮落在索引里没有的轮上，索引一项都不亮。
  const [activeTurn, setActiveTurn] = useState(-1)
  const tocRafRef = useRef(0)
  // 刚从索引跳过去的轮：末尾几轮很短时跳过去就到了底，底部规则会把高亮抢给最后一轮（「点了 A 却亮 B」）；
  // 它还在视野里就仍亮它。离开底部即作废。
  const jumpedRef = useRef<number | null>(null)
  const recomputeActive = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const nodes = el.querySelectorAll<HTMLElement>(TOC_ANCHOR)
    if (nodes.length === 0) {
      setActiveTurn((p) => (p === -1 ? p : -1))
      return
    }
    let hit = -1
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD) {
      // 已滚到底时强制取最后一轮：末轮下方内容往往不足以把它顶过判定线，
      // 不特判就会出现「点了最后一项却高亮上一轮」。刚跳过去的轮仍在视野里时例外。
      const j = jumpedRef.current
      const jumped = j === null ? undefined : [...nodes].find((n) => Number(n.dataset.turn) === j)
      hit =
        jumped && jumped.getBoundingClientRect().top >= el.getBoundingClientRect().top - 1
          ? (j as number)
          : Number(nodes[nodes.length - 1].dataset.turn)
    } else {
      jumpedRef.current = null
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


  // 滚到某一轮的起点（须已渲染）：复用右键删除已标注的 data-turn 作锚点（成员对话里派来的任务也是轮起点）。
  const scrollToTurn = (turn: number): void => {
    const el = scrollRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(
      `.cf-msg.is-user[data-turn="${turn}"], .cf-msg.is-task[data-turn="${turn}"]`
    )
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
    jumpedRef.current = turn
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
    // 只认真正点在对话区里的右键：挂到 body 的浮层（卡片里下拉框的选项列表等）在 React 树里仍是对话区的子孙，
    // 右键会冒泡上来误弹对话菜单。
    if (!e.currentTarget.contains(e.target as Node)) return
    if (selecting) return
    const sel = window.getSelection()
    const selection = (sel?.toString() ?? '').trim()
    const canDelete = !streaming && messages.length > 0
    if (!selection && !canDelete) return
    e.preventDefault()
    const hit = (e.target as HTMLElement).closest('[data-turn]') as HTMLElement | null
    const n = hit ? Number(hit.dataset.turn) : NaN
    const turn = Number.isInteger(n) && n >= 0 ? n : null
    setCtxMenu({ x: e.clientX, y: e.clientY, turn, selection, quote: selection ? quoteOf(sel) : '', canDelete })
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
  // 主对话里等你处理的「为成员选择文件夹」卡在对话末尾的胶囊下处理（见 MemberAsks），消息流里先不画；处理完照常是一步。
  const hidePendingPick = (m: ChatMessage): ChatMessage =>
    !memberView && m.role === 'assistant' && m.blocks.some((b) => b.kind === 'mount' && b.member && !b.decided)
      ? { ...m, blocks: m.blocks.filter((b) => !(b.kind === 'mount' && b.member && !b.decided)) }
      : m
  /**
   * 成员交差的回复（记录里是「前端已完成：任务」+ 结论原文）：前一条是不显示的成员通知、本条正文以通知的标题开头。
   * 画成该成员说的话（它的头像和名字，不显示标题行，见 renderMsg）；成员按标题开头的名字认（名单里最长的那个前缀，
   * 含已移除的）。要唤醒主角色处理的那种通知后面是主角色自己写的回复，开头对不上标题，照常显示。
   */
  const reportOf = (i: number): MemberReportHead | undefined => {
    const m = messages[i]
    const prev = messages[i - 1]
    if (memberView || m?.role !== 'assistant' || !prev?.quiet) return undefined
    const headline = prev.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('').trim()
    const first = m.blocks[0]
    if (!headline || first?.kind !== 'text' || !first.text.startsWith(headline)) return undefined
    // 绑定的定时任务只是告知的那条：以任务的身份画（闹钟头像 + 任务名）。
    if (prev.handoff && !prev.handoff.needsAction) return { headline, task: prev.handoff.title }
    const lower = headline.toLowerCase()
    const who = [...members, ...formerMembers]
      .filter((x) => lower.startsWith(x.meta.name.toLowerCase()))
      .sort((a, b) => b.meta.name.length - a.meta.name.length)[0]
    return { headline, persona: who?.persona }
  }
  const renderMsg = (m: ChatMessage, i: number, turn?: number): React.JSX.Element => {
    const report = reportOf(i)
    // 成员交差：以该成员的身份画（头像 + 名字 + 结论原文）；认不出是哪位成员时退回带标题行的写法。
    // 定时任务告知的：以任务的身份画（任务所用角色的头像 + 定时任务角标 + 任务名）。
    const speaker = report?.persona
    return (
      <ConvMessage
        key={m.id}
        msg={report ? withoutHeadline(m, report.headline) : hidePendingPick(m)}
        report={report && !speaker && !report.task ? report : undefined}
        owner={speaker ?? owner}
        taskSpeaker={report?.task}
        taskPersona={report?.task ? taskPersonaOf(report.task) : undefined}
        taskOwner={memberView?.owner}
        active={!selecting && streaming && i === messages.length - 1}
        latest={i === messages.length - 1}
        elapsedSec={i === messages.length - 1 ? streamStatus.elapsedSec : 0}
        footer={statusInMsg && !selecting && i === messages.length - 1 ? statusLine : undefined}
        dataTurn={turn}
        sessionId={currentSessionId}
        onAsk={onAsk}
        onPlan={onPlan}
        onMountReq={onMountReq}
        onOpenProposal={onOpenProposal}
        onOpenAutotask={onOpenAutotask}
      />
    )
  }

  // 成员正等你处理的卡（只在主对话里显示；成员对话里卡片就在它自己的对话流中）。
  // 主对话里另有主角色建成员时「为成员选择文件夹」的卡（create_member 的 pick_folder）：同样放在对话末尾，不进消息流。
  const waits: MemberWait[] = memberView
    ? []
    : [
        ...(pendingCards[currentSessionId] ?? [])
          .filter((c) => c.kind === 'mount' && c.member)
          .map((card) => ({ sid: currentSessionId, name: (card.kind === 'mount' && card.member) || '', card, isNew: true })),
        ...members.flatMap((m): MemberWait[] => {
          const handoff = browserState?.handoff[m.meta.sessionId]
          return [
            ...(pendingCards[m.meta.sessionId] ?? []).map((card) => ({
              sid: m.meta.sessionId,
              name: m.meta.name,
              persona: m.persona,
              card
            })),
            ...(handoff ? [{ sid: m.meta.sessionId, name: m.meta.name, persona: m.persona, handoff }] : [])
          ]
        })
      ]

  const view = (
    <main className="cf-conv">
      <div className="cf-conv__head">
        {memberView ? (
          <MemberLogHead view={memberView} streaming={streaming} />
        ) : taskView ? (
          <TaskLogHead
            view={taskView}
            streaming={streaming}
            onRun={() => onRunTask(taskView.task)}
            onToggle={() => onToggleTask(taskView.task)}
            onEdit={() => onEditTask(taskView.task)}
          />
        ) : (
          <>
            <button
              className="cf-idbtn"
              onClick={() => owner && onOpenProfile(owner.id)}
              title={t('cf.viewProfile')}
            >
              {/* 顶部只显示角色名称（去掉头像与描述行）；仍可点击打开资料卡。 */}
              <div className="cf-idbtn__name">{owner?.name ?? ''}</div>
            </button>
            <MemberBar
              members={members}
              sessionStates={sessionStates}
              waiting={(id) => !!pendingCards[id]?.length || !!browserState?.handoff[id]}
              onOpen={onOpenMember}
              onRemove={onRemoveMember}
            />
            <TaskBar
              tasks={boundTasks}
              sessionStates={sessionStates}
              onOpen={onOpenTask}
              onRun={onRunTask}
              onToggle={onToggleTask}
              onDelete={onDeleteTask}
            />
          </>
        )}
        {!memberView && archived && (
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
                  {memberView
                    ? fill(t('cf.member.empty'), { name: memberView.entry.meta.name })
                    : taskView
                      ? fill(t('cf.task.empty'), { name: taskView.task.title })
                      : owner
                      ? owner.desc
                        ? `${owner.name} · ${owner.desc}`
                        : owner.name
                      : ''}
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
                {/* 等主角色汇总的成员进度（不进对话记录，全部交差时消失）。 */}
                {isTail && !memberView && (
                  <MemberProgressNotice ownerName={owner?.name ?? 'Deva'} faceOf={memberPersonaOf} />
                )}
                {/* 等主智能体汇总的后台子智能体（同上，不进对话记录，全部结束时消失）。 */}
                {isTail && !memberView && <SubagentProgressNotice ownerName={owner?.name ?? 'Deva'} />}
                {/* 成员在等你处理（不进对话记录，处理完消失）。按会话重挂载，展开与回执不串到别的对话。 */}
                {isTail && !memberView && (
                  <MemberAsks
                    key={currentSessionId}
                    waits={waits}
                    onAsk={onAsk}
                    onPlan={onPlan}
                    onMountReq={onMountReq}
                    onOpenMember={onOpenMember}
                  />
                )}
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
                  },
                  // 引用：放进输入框顶部的引用条（同 TG 的回复，一次一条，再引用就替换），已输入的文字不动。
                  ...(ctxMenu.quote
                    ? [
                        {
                          label: t('cf.quote'),
                          icon: <TextQuote size={14} />,
                          onClick: () => onPrefill(ctxMenu.quote, true)
                        }
                      ]
                    : [])
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
          mentionables={mentionables}
          // 成员对话：技能按成员的设定来源角色过滤。
          roleId={memberView?.entry.meta.personaId}
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
  // 执行步骤里成员名前的小头像（见 blocks.tsx MemberFaceContext）；成员对话里没有成员工具，不提供。
  return (
    <MemberFaceContext.Provider value={memberView ? null : memberFace}>
      <TaskNamesContext.Provider value={memberView ? null : taskNameCtx}>
        <MentionContext.Provider value={mentionLookup}>{view}</MentionContext.Provider>
      </TaskNamesContext.Provider>
    </MemberFaceContext.Provider>
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
