import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Square,
  Sparkles,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  FilePen,
  FilePlus,
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
  MessageCircleQuestion,
  Bot,
  Lightbulb,
  Pencil,
  Circle,
  CheckSquare,
  ClipboardList,
  ClipboardCheck,
  Brain,
  FolderOpen,
  ListChecks,
  Package,
  Archive,
  Puzzle,
  MousePointerClick,
  Keyboard,
  ScanText,
  Camera,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Hourglass,
  Code,
  AppWindow,
  ArrowDownUp,
  ListFilter,
  KeyRound,
  ShieldCheck,
  Upload,
  Hand,
  MessageSquare,
  CircleCheckBig,
  UserPlus,
  Send,
  CalendarClock,
  CircleStop,
  MessagesSquare,
  Forward,
  MessageSquareReply,
  UsersRound,
  BookOpen,
  type LucideIcon
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { REPEAT_STOP, TASK_MAX_STEPS } from '../../../../shared/limits'
import { useExtensions } from '../../store/extensions'
import type { ChatBlock, ChatMessage, StreamStatus, ToolStatus } from '../../store/chat'
import { CopyButton, Markdown } from './Markdown'
import { HumationFace, PersonaFace, USER_AVATAR_SEED, seededShape } from '../../components/humation'
import { useProfile } from '../../store/profile'
import { TaskConfirmCard } from './TaskConfirmCard'
import { DeliverablesCard } from './DeliverablesCard'
import { TodoItemList } from './Todos'

/**
 * 助手消息的块渲染（对话优先外壳复用）：文本 / 思考、工具调用与子智能体（时间轴，每步一个节点）/
 * 挂载请求 / 计划审阅 / 问答卡 / 角色名片 / 定时任务名片，以及对话流底部的工作状态指示器。
 */

/**
 * 内置工具 → 文案键与时间轴节点图标：工具名称取 chat.tool.<键>，动词取 chat.flow.{done|doing|base}.<键>。
 * 不在表里的（如 MCP 工具）一律按 unknown 处理，图标为扳手。
 */
const TOOL_META: Record<string, { key: string; icon: LucideIcon }> = {
  read_file: { key: 'readFile', icon: FileText },
  list_dir: { key: 'listDir', icon: FolderTree },
  glob: { key: 'glob', icon: FileSearch },
  grep: { key: 'grep', icon: Search },
  web_fetch: { key: 'webFetch', icon: Globe },
  write_file: { key: 'writeFile', icon: FilePlus },
  edit_file: { key: 'editFile', icon: FilePen },
  run_command: { key: 'runCommand', icon: SquareTerminal },
  ask_user: { key: 'askUser', icon: MessageCircleQuestion },
  create_skill: { key: 'createSkill', icon: Sparkles },
  create_mcp: { key: 'createMcp', icon: Plug },
  memory_read: { key: 'memoryRead', icon: Brain },
  memory_write: { key: 'memoryWrite', icon: Brain },
  memory_delete: { key: 'memoryDelete', icon: Brain },
  // 正常的 todo_write 不画工具节点（进度在胶囊里）；只有参数被输出上限截断的那次会以普通工具节点出现。
  todo_write: { key: 'todoWrite', icon: ListChecks },
  // present_files 在时间轴上与普通工具一样是一步；成功的交付另在回合结束后于回复末尾画交付卡（见 deliveries）。
  present_files: { key: 'presentFiles', icon: Package },
  // 拼图与输入框「/」联想、角色资料卡里的技能图标一致。
  skill: { key: 'skill', icon: Puzzle },
  // 查看按需加载工具的用法（主进程 tool-search.ts）；没查就调用、被拦下的那次也画成这一步。
  tool_search: { key: 'toolSearch', icon: BookOpen },
  // 内置浏览器：时间轴上按动作区分（见 BROWSER_META）；这里是不知道动作时（如底部状态行）的通用说法。
  browser: { key: 'browser', icon: Globe },
  // 项目成员（见 services/members.ts）：主智能体添加成员 / 派任务 / 中止，成员查看主对话、把结论交给主对话处理。
  create_member: { key: 'createMember', icon: UserPlus },
  member_send: { key: 'memberSend', icon: Send },
  member_stop: { key: 'memberStop', icon: CircleStop },
  member_status: { key: 'memberStatus', icon: UsersRound },
  read_main: { key: 'readMain', icon: MessagesSquare },
  report_to_main: { key: 'reportToMain', icon: Forward },
  reply_task: { key: 'replyTask', icon: MessageSquareReply }
}

/** browser 工具的各个动作：每个动作有自己的动词与图标（打开网页、查看页面、点击……）。 */
const BROWSER_META: Record<string, { key: string; icon: LucideIcon }> = {
  open: { key: 'browserOpen', icon: Globe },
  snapshot: { key: 'browserRead', icon: ScanText },
  click: { key: 'browserClick', icon: MousePointerClick },
  type: { key: 'browserType', icon: Keyboard },
  select: { key: 'browserSelect', icon: ListFilter },
  press: { key: 'browserPress', icon: Keyboard },
  scroll: { key: 'browserScroll', icon: ArrowDownUp },
  back: { key: 'browserBack', icon: ArrowLeft },
  forward: { key: 'browserForward', icon: ArrowRight },
  reload: { key: 'browserReload', icon: RotateCw },
  wait: { key: 'browserWait', icon: Hourglass },
  screenshot: { key: 'browserShot', icon: Camera },
  evaluate: { key: 'browserEval', icon: Code },
  tabs: { key: 'browserTabs', icon: AppWindow },
  switch_tab: { key: 'browserSwitchTab', icon: AppWindow },
  close_tab: { key: 'browserCloseTab', icon: AppWindow },
  // 把窗口弹给用户看：对用户来说就是「打开网页」（结果说明里是网页标题）
  show: { key: 'browserOpen', icon: Globe },
  dialog: { key: 'browserDialog', icon: MessageSquare }
}

/** handoff（请用户在网页上亲自操作）按原因区分：等你登录 / 完成验证 / 上传文件 / 确认 / 操作。 */
const HANDOFF_META: Record<string, { key: string; icon: LucideIcon }> = {
  login: { key: 'browserHandoffLogin', icon: KeyRound },
  captcha: { key: 'browserHandoffCaptcha', icon: ShieldCheck },
  upload: { key: 'browserHandoffUpload', icon: Upload },
  confirm: { key: 'browserHandoffConfirm', icon: CircleCheckBig },
  other: { key: 'browserHandoffOther', icon: Hand }
}

/** 工具的文案键与图标：browser 按 args.action 细分，其余按工具名；未知工具（如 MCP 工具）为 undefined。 */
function toolMeta(name: string, args?: unknown): { key: string; icon: LucideIcon } | undefined {
  if (name === 'browser') {
    const a = args as { action?: unknown; reason?: unknown } | null | undefined
    if (a?.action === 'handoff') return HANDOFF_META[typeof a.reason === 'string' ? a.reason : ''] ?? HANDOFF_META.other
    if (typeof a?.action === 'string' && BROWSER_META[a.action]) return BROWSER_META[a.action]
  }
  return TOOL_META[name]
}

/**
 * browser 各动作在工具行上显示的对象：打开的网址、输入的文字、按键、等待的文字、脚本。
 * 切换 / 关闭标签不显示标签编号（p1 之类是内部编号，对用户没有意义）：结果说明里是网页标题。
 */
function browserObject(args: unknown): { text: string; full: string } | null {
  const a = (args ?? {}) as Record<string, unknown>
  const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  let text = ''
  switch (a.action) {
    case 'open':
      text = pick(a.url)
      break
    case 'type':
    case 'wait':
      text = pick(a.text)
      break
    case 'press':
      text = pick(a.key)
      break
    case 'evaluate':
      text = pick(a.script)
      break
  }
  return text ? { text: text.replace(/\s+/g, ' '), full: text } : null
}

/**
 * 路径的展示形：只留「父目录/文件名」——文件名是身份，父目录用于区分同名文件（一堆 index.ts）。
 * 工具行单行展示，深路径的前段对扫读没有帮助，完整路径挂在悬停上。
 */
function shortPath(p: string): string {
  const trimmed = p.trim().replace(/[/\\]+$/, '')
  const sep = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  const segs = trimmed.split(/[/\\]/).filter(Boolean)
  return segs.length > 2 ? segs.slice(-2).join(sep) : trimmed
}

/**
 * 工具行的「对象」：技能为技能名；其余优先 command（run_command），再 pattern（grep/glob——搜的是什么比在哪搜
 * 更有信息量，搜索范围挂悬停），再 path，再 url（web_fetch），再记忆正文 / id。full 为原值（挂悬停），text 为展示值——
 * 只有 path 缩成「父目录/文件名」，命令、正则、URL 原样展示，超长时由 CSS 单行省略号截断尾部。
 * 未知工具（如 MCP 工具）显示工具名：动词「已调用」本身说明不了调了什么。
 */
const MEMBER_TOOLS = new Set(['create_member', 'member_send', 'member_stop', 'member_status'])

/** 成员工具的对象：成员名（派任务另带任务标题）。不是成员工具、或没写成员（查看全部成员的状态）时为 null。 */
function memberObject(name: string, args: unknown): { who: string; task: string } | null {
  if (!MEMBER_TOOLS.has(name)) return null
  const a = (args ?? {}) as { name?: unknown; member?: unknown; task?: unknown }
  const who = String((name === 'create_member' ? a.name : a.member) ?? '').trim()
  if (!who) return null
  const task = name === 'member_send' && typeof a.task === 'string' ? a.task.trim() : ''
  return { who, task }
}

/**
 * 成员名前的小头像（派任务、建成员等步骤）：由对话外壳按名字提供（主对话的成员名单，含已移除的）。没提供（成员对话、
 * 后台任务面板等）或认不出这个名字时返回 null，只写名字。
 */
export const MemberFaceContext = createContext<((name: string) => React.ReactNode) | null>(null)

/**
 * 本对话里在会话中运行的定时任务（主角色的 member_send / member_status 也能点到它们，见主进程 askTask）：
 * has = 这个名字是不是定时任务；only = 只有定时任务、没有成员。查看状态的步骤据此写「已查看定时任务」而不是「成员状态」。
 */
export const TaskNamesContext = createContext<{ has: (name: string) => boolean; only: boolean } | null>(null)

/** 这一步是不是在查看定时任务（member_status 点名定时任务，或不点名而本对话只有定时任务）。 */
function useTaskStatusStep(step: { name: string; args: unknown }): boolean {
  const tasks = useContext(TaskNamesContext)
  if (step.name !== 'member_status' || !tasks) return false
  const member = memberObject(step.name, step.args)
  return member ? tasks.has(member.who) : tasks.only
}

/** tool_search 查的是哪些工具：写工具的显示名（不认识的写原名）。不在 TOOL_META 里的名片类工具另有文案键。 */
const USAGE_NAME_KEY: Record<string, string> = { create_task: 'createTask', propose_agent: 'proposeAgent' }

function usageObject(args: unknown, t?: (key: string) => string): { text: string; full: string } | null {
  const raw = (args as { names?: unknown } | null)?.names
  const names = (Array.isArray(raw) ? raw : [raw]).filter((n): n is string => typeof n === 'string' && n.trim() !== '')
  if (!names.length) return null
  const key = (n: string): string | undefined => TOOL_META[n]?.key ?? USAGE_NAME_KEY[n]
  const text = names.map((n) => (t && key(n) ? t(`chat.tool.${key(n)}`) : n)).join('、')
  return { text, full: text }
}

function flowObject(
  name: string,
  args: unknown,
  t?: (key: string) => string
): { text: string; full: string } | null {
  if (!TOOL_META[name]) return { text: name, full: name }
  if (name === 'browser') return browserObject(args)
  if (name === 'tool_search') return usageObject(args, t)
  if (name === 'skill') {
    const skill = (args as { name?: unknown } | null)?.name
    return typeof skill === 'string' && skill.trim() ? { text: skill.trim(), full: skill.trim() } : null
  }
  // 成员工具：对象写成员名（派任务另带任务标题）；查看主对话没有对象。
  const member = memberObject(name, args)
  if (member) {
    const text = member.task ? `${member.who} · ${member.task}` : member.who
    return { text, full: text }
  }
  if (MEMBER_TOOLS.has(name)) return null
  if (name === 'read_main') return null
  // 交给主对话处理：对象写要主对话做的事。
  if (name === 'report_to_main') {
    const reason = (args as { reason?: unknown } | null)?.reason
    return typeof reason === 'string' && reason.trim() ? { text: reason.trim(), full: reason.trim() } : null
  }
  // 先交回一项任务的结论：对象写任务标题。
  if (name === 'reply_task') {
    const task = (args as { task?: unknown } | null)?.task
    return typeof task === 'string' && task.trim() ? { text: task.trim(), full: task.trim() } : null
  }
  if (args && typeof args === 'object') {
    const o = args as { command?: unknown; path?: unknown; pattern?: unknown; url?: unknown }
    if (typeof o.command === 'string' && o.command.trim()) return { text: o.command, full: o.command }
    if (typeof o.pattern === 'string' && o.pattern.trim()) {
      const scope = typeof o.path === 'string' && o.path.trim() ? `${o.pattern}  ·  ${o.path}` : o.pattern
      return { text: o.pattern, full: scope }
    }
    if (typeof o.path === 'string' && o.path.trim()) return { text: shortPath(o.path), full: o.path }
    if (typeof o.url === 'string' && o.url.trim()) return { text: o.url, full: o.url }
    // memory_write 的记忆正文：让用户在工具行上直接看到模型记了什么（写入对用户可见、可审计）。
    const m = args as { content?: unknown; id?: unknown }
    if (typeof m.content === 'string' && m.content.trim()) return { text: m.content, full: m.content }
    if (typeof m.id === 'string' && m.id.trim()) return { text: m.id, full: m.id }
  }
  return null
}

/** 底部指示器要表达的当前活动。（对话优先外壳复用 StatusIndicator/deriveActivity，故导出。） */
export type Activity =
  | { kind: 'thinking' }
  | { kind: 'responding' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'subagent'; agent: string }
  | { kind: 'ask' }
  | { kind: 'plan' }
  /** member：等的是为成员选文件夹（不是挂载本对话的工作区）。 */
  | { kind: 'mount'; member?: string }

/**
 * 从最后一条助手消息的块序列推断"此刻在干什么"：
 * 未处理的挂载请求 / 未答复的问答卡 / 未决计划 > 运行中的工具 / 子智能体 > 末块有正文=生成回答 > 其余=思考中。
 */
export function deriveActivity(messages: ChatMessage[]): Activity {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return { kind: 'thinking' }
  const blocks = last.blocks
  const mountReq = blocks.find((b) => b.kind === 'mount' && !b.decided)
  if (mountReq?.kind === 'mount') return { kind: 'mount', ...(mountReq.member !== undefined ? { member: mountReq.member } : {}) }
  if (blocks.some((b) => b.kind === 'plan' && !b.decided)) return { kind: 'plan' }
  if (blocks.some((b) => b.kind === 'ask' && b.answers === undefined)) return { kind: 'ask' }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'tool' && b.status === 'running') return { kind: 'tool', toolName: b.name }
    // 后台子智能体不是本轮在等的事（本轮已越过它接着干），不算当前活动。
    if (b.kind === 'subagent' && b.status === 'running' && !b.background)
      return { kind: 'subagent', agent: b.agent }
  }
  const tail = blocks[blocks.length - 1]
  if (tail?.kind === 'text' && tail.text.trim()) return { kind: 'responding' }
  return { kind: 'thinking' }
}

/**
 * 对话流底部的工作状态指示器：随自动滚动停在最新消息下方，仅流式期间显示。
 * 三种形态：活跃（脉动点 + 活动文案 + 已用秒数）/ 等待授权 / 自动重连（含[停止]）。
 * "自动重连"是主进程 reconnecting 事件驱动的真实信号，非渲染层猜测。
 * folded：本轮已有「工作过程」折叠条——当前步骤露在它下面、计时在它标题末尾，活跃形态不再显示；
 * 等待、重连、压缩这些特殊状态照常显示。
 * pending：回复还什么都没出（请求刚发出、在等第一个字）——活跃形态换成三个跳动的点。
 */
export function StatusIndicator({
  activity,
  status,
  folded = false,
  pending = false,
  onStop
}: {
  activity: Activity
  status: StreamStatus
  folded?: boolean
  pending?: boolean
  onStop: () => void
}): React.JSX.Element | null {
  const { t } = useI18n()

  // 连接中断、正在自动重连：真实信号，给出停止入口（用户可放弃重连）。
  if (status.reconnecting) {
    const { attempt, max, reason } = status.reconnecting
    // 断流重连带进度；引擎自愈（截断续写 / 空回合追问 / 压缩重试）只在多次尝试时显示进度。
    const label =
      reason === 'truncated'
        ? t('chat.work.autoTruncated')
        : reason === 'empty'
          ? t('chat.work.autoEmpty')
          : reason === 'context'
            ? t('chat.work.autoContext')
            : reason === 'output_limit'
              ? t('chat.work.autoOutputLimit')
              : reason === 'effort'
                ? t('chat.work.autoEffort')
                : reason === 'repetition'
                  ? t('chat.work.autoRepetition')
                  : reason === 'output_fit'
                    ? t('chat.work.autoOutputFit')
                    : t('chat.work.reconnecting')
    return (
      <div className="chat__status is-reconnecting" role="status" aria-live="polite">
        <Loader2 size={14} className="spin" />
        <span>
          {label}
          {max > 1 ? ` (${attempt}/${max})` : ''}
        </span>
        <button type="button" className="chat__status-stop" onClick={onStop}>
          {t('chat.stop')}
        </button>
      </div>
    )
  }

  // 正在压缩上下文：主进程真实信号（compacting 事件）。压缩可能要几十秒，换掉「思考中」，文字扫光以示区别。
  if (status.compacting) {
    return (
      <div className="chat__status" role="status" aria-live="polite">
        <span className="chat__status-dot" />
        <span className="chat__status-shimmer">{t('chat.work.compacting')}…</span>
        <span className="chat__status-time">{formatElapsed(status.elapsedSec)}</span>
      </div>
    )
  }

  // 等待挂载工作区：引导用户去上方卡片点「挂载工作区 / 暂不挂载」。
  if (activity.kind === 'mount') {
    return (
      <div className="chat__status is-waiting" role="status" aria-live="polite">
        <FolderOpen size={14} />
        <span>
          {activity.member !== undefined
            ? t('chat.work.awaitingMemberFolder').split('{name}').join(activity.member)
            : t('chat.work.awaitingMount')}
        </span>
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
      ? `${t('chat.work.usingTool')} · ${t(`chat.tool.${verbKey(activity.toolName)}`)}`
      : activity.kind === 'subagent'
        ? `${t('chat.work.subagent')} · ${subagentName(activity.agent, t) || t('chat.subagent.fallback')}`
        : activity.kind === 'responding'
          ? t('chat.work.responding')
          : t('chat.work.thinking')

  if (folded) return null

  // 请求中：此时并不知道模型会不会思考，不写「思考中」，只在角色名下面、正文将出现的位置放三个依次
  // 放大缩小的点；第一个字（或思考）一到即被替换。
  if (pending)
    return (
      <div className="chat__pending" role="status" aria-label={t('chat.work.requesting')}>
        <i />
        <i />
        <i />
      </div>
    )

  return (
    <div className="chat__status" role="status" aria-live="polite">
      <span className="chat__status-dot" />
      <span>{label}…</span>
      <span className="chat__status-time">{formatElapsed(status.elapsedSec)}</span>
    </div>
  )
}

/** 已用时长 → 时分秒（1h 2m 3s）；高位为 0 的单位省略，秒恒显示（45s / 2m 5s）。 */
function formatElapsed(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h) return `${h}h ${m}m ${s}s`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * 思考的实时小窗：最多几行高（见 .tl__think-live），超出时始终停在最新内容、上沿渐隐。
 * 高度封顶，思考再长也不会把页面越撑越高。（进行中折叠条下直接露出它，见对话区，故导出。）
 */
export function LiveThinkingWindow({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setOverflow(el.scrollHeight > el.clientHeight + 1)
  }, [text])
  return (
    <div ref={ref} className={`tl__body tl__think tl__think-live${overflow ? ' is-overflow' : ''}`}>
      <Markdown text={text} muted />
    </div>
  )
}

/**
 * 手动收起后把开合按钮所在的行滚回可视区：展开的内容很长、读到下面时，吸顶的标题早已离开原位，收起后内容
 * 一下变短，不拉回来就跳到别处、找不到读到哪了。返回挂在该行上的 ref，以及点开合按钮时先调用的标记函数。
 * 只管用户手动收起；自动收起（如思考完成）不调用标记，不动滚动位置（贴底跟随照常）。
 */
function useAnchorOnClose<T extends HTMLElement>(open: boolean): [React.RefObject<T>, () => void] {
  const ref = useRef<T>(null)
  const pending = useRef(false)
  useLayoutEffect(() => {
    if (open || !pending.current) return
    pending.current = false
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [open])
  return [ref, () => (pending.current = open)]
}

/**
 * 时间轴上的思考节点（可展开）。对齐 Codex/DeepSeek 的推理折叠：思考中默认展开、标签扫光，
 * 思考完成后自动收起（用户仍可手动点开）。正文按弱化配色渲染 Markdown（muted）。
 * autoOpen=false（进行中折叠条下的当前步骤）：思考中不展开全文，改为实时滚动的小窗，高度封顶。
 * 展开后标题行吸在对话区顶部（见 .tl__think-head），长思考读到中下部也能随手收起；这是唯一的收起入口。
 * 节点图标画在标题行里（节点列留空占位），吸顶时随这一行一起走。
 */
function TimelineThinking({
  text,
  done,
  autoOpen = true
}: {
  text: string
  done: boolean
  autoOpen?: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  // 初始：思考中展开、已完成（如历史消息）收起。
  const [open, setOpen] = useState(!done && autoOpen)
  // 完成的瞬间（done: false→true）自动收起一次；此后用户可自由再展开。
  const wasDone = useRef(done)
  useEffect(() => {
    if (done && !wasDone.current) setOpen(false)
    wasDone.current = done
  }, [done])
  const [headRef, markToggle] = useAnchorOnClose<HTMLDivElement>(open)
  const toggle = (): void => {
    markToggle()
    setOpen(!open)
  }
  return (
    <li className={`tl__item${done ? '' : ' is-run'}${open ? ' is-open' : ''}`}>
      <span className="tl__node" />
      <div className="tl__main">
        <div ref={headRef} className="tl__think-head">
          <span className="tl__think-icon">
            <Lightbulb size={14} />
          </span>
          <button type="button" className="tl__line" aria-expanded={open} onClick={toggle}>
            <span className="tl__text">
              {done ? (
                <span className="tl__verb">{t('chat.thought')}</span>
              ) : (
                <span className="tl__shimmer">{t('chat.thinking')}</span>
              )}
            </span>
            <ChevronRight size={12} className="tl__caret" />
          </button>
        </div>
        {open ? (
          <div className="tl__body tl__think">
            <Markdown text={text} muted />
          </div>
        ) : (
          !done && !autoOpen && text.trim() && <LiveThinkingWindow text={text} />
        )}
      </div>
    </li>
  )
}


export function BlockView({
  block,
  thinkingDone,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask,
  bare,
  extra,
  hint
}: {
  block: ChatBlock
  thinkingDone: boolean
  onAsk: (key: string, answers: string[]) => void
  /** 回应 exit_plan 计划审阅（批准并执行 / 继续完善（可附回复）/ 忽略）。缺省 → 计划卡只读展示。 */
  onPlan?: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  /** 回应「请求挂载工作区」（path=已选目录 / null=暂不挂载）。缺省 → 卡片只读展示。 */
  onMountReq?: (key: string, path: string | null) => void
  /** 点角色名片 → 打开预填的 PersonaEditor（缺省 → 名片只读展示）。 */
  onOpenProposal?: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** created 态定时任务名片「打开任务会话」（缺省 → 不显跳转）。 */
  onOpenAutotask?: (taskId: string) => void
  /**
   * 待处理的提问 / 计划 / 挂载卡不画卡头：主对话末尾成员在等你处理时，卡片上方的胶囊已经写明谁在等什么
   * （见 redesign/MemberBar.tsx MemberAsks）。已处理的卡不受影响。
   */
  bare?: boolean
  /** 待处理的提问 / 计划 / 挂载卡操作行里附加的一项（成员的「打开对话」），排在左侧按钮之后。 */
  extra?: React.ReactNode
  /** bare 时选文件夹卡问句下面的一行说明（「不限」是什么意思，由调用方按场景给）。 */
  hint?: React.ReactNode
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

  // 思考 / 工具调用 / 子智能体 / 已完成清单 / 插入的消息通常由 groupBlocks 归进时间轴；单独交到这里时画成只有
  // 一个节点的时间轴。
  if (
    block.kind === 'thinking' ||
    block.kind === 'tool' ||
    block.kind === 'subagent' ||
    block.kind === 'todolist' ||
    block.kind === 'insert'
  ) {
    return <Timeline steps={[{ block, index: 0 }]} liveBlock={thinkingDone ? undefined : block} />
  }

  if (block.kind === 'agentcard') {
    return <AgentCard block={block} onOpen={onOpenProposal} />
  }

  if (block.kind === 'autotaskcard') {
    return <TaskConfirmCard block={block} onOpen={onOpenAutotask} />
  }

  if (block.kind === 'ask') {
    return <AskCard block={block} onAsk={onAsk} bare={bare} extra={extra} />
  }

  if (block.kind === 'plan') {
    return <PlanReviewCard block={block} onPlan={onPlan} bare={bare} extra={extra} />
  }

  if (block.kind === 'mount') {
    return <MountRequestCard block={block} onMountReq={onMountReq} bare={bare} extra={extra} hint={hint} />
  }

  // 步骤边界标记：只服务于重连时丢残缺尾部的判定，不渲染。
  if (block.kind === 'step') return null

  if (block.kind === 'compaction') return <CompactionNotice summary={block.summary} first={block.first} />

  // notice：回合终止说明（中止 / 截断 / 空回合等），一行灰字配黄色图标，区别于红色错误
  if (block.kind === 'notice') {
    const NOTICE_KEY: Record<typeof block.code, string> = {
      truncated: 'chat.notice.truncated',
      empty: 'chat.notice.empty',
      refused: 'chat.notice.refused',
      restored: 'chat.notice.restored',
      aborted: 'chat.notice.aborted',
      step_limit: 'chat.notice.stepLimit',
      repeated: 'chat.notice.repeated',
      degenerate: 'chat.notice.degenerate'
    }
    // 文案里的 {n}：阈值与主进程判定共用 shared/limits.ts。
    const n = block.code === 'repeated' ? REPEAT_STOP : TASK_MAX_STEPS
    return (
      <div className="msg__notice">
        <Info size={14} />
        <span>{t(NOTICE_KEY[block.code]).replace('{n}', String(n))}</span>
      </div>
    )
  }

  // error：红色图标 + 红色报错原文一行（文案由主进程按界面语言生成；原文为空时兜底「出错了」）
  return (
    <div className="msg__error">
      <AlertTriangle size={14} />
      <span className="msg__error-text">{block.message || t('chat.error')}</span>
    </div>
  )
}

/**
 * 挂载工作区请求卡：未挂载工作区时，模型某次调用缺「相对路径基准」，主进程闸门已暂停循环等这里的处置。
 * 「挂载工作区」走系统目录对话框（fs.openFolder，与输入框上方的挂载入口同一条路径与信任语义）——
 * 目录只可能是用户亲手选的，卡片里绝不出现「按模型给的路径一键挂载」。取消对话框 ≠ 暂不挂载：
 * 卡片保持未决，循环继续等着。decided 为终态、只读展示。
 */
function MountRequestCard({
  block,
  onMountReq,
  bare,
  extra,
  hint
}: {
  block: Extract<ChatBlock, { kind: 'mount' }>
  onMountReq?: (key: string, path: string | null) => void
  /** 见 BlockView 同名参数。 */
  bare?: boolean
  extra?: React.ReactNode
  hint?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const decided = block.decided
  const pick = (): void => {
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r && onMountReq) onMountReq(block.key, r.path)
    })()
  }
  // 为成员选择文件夹（create_member 的 pick_folder）：同一张卡，换成成员的文案，「不限」= 不指定。
  const member = block.member
  if (member !== undefined) {
    const name = (s: string): string => s.split('{name}').join(member)
    // 主对话末尾成员在等你选文件夹（对比稿 design/member-mount-card.html 方案 A）：排版同提问卡——加粗问句、
    // 一行灰字说明「不限」，左边附加项（打开对话），右边「不限」与主按钮「选择文件夹…」。
    if (bare && !decided)
      return (
        <div className="msg__mount">
          <div className="msg__mount-q">{name(t('chat.mount.memberAsk'))}</div>
          {hint && <div className="msg__mount-sub">{hint}</div>}
          {onMountReq && (
            <div className="msg__mount-actions">
              {extra}
              <div className="msg__mount-actions-end">
                <button type="button" className="btn btn--sm" onClick={() => onMountReq(block.key, null)}>
                  {t('chat.mount.memberSkip')}
                </button>
                <button type="button" className="btn btn--sm btn--primary" onClick={pick}>
                  <FolderOpen size={14} />
                  {t('chat.mount.memberPick')}
                </button>
              </div>
            </div>
          )}
        </div>
      )
    return (
      <div className={`msg__mount${decided ? ' is-decided' : ''}${decided === 'mounted' ? ' is-ok' : ''}`}>
        {!(bare && !decided) && (
          <div className="msg__mount-head">
            <FolderOpen size={14} />
            <span className="msg__mount-title">{name(t('chat.mount.memberTitle'))}</span>
            {decided && (
              <span className={decided === 'mounted' ? 'msg__mount-badge msg__mount-badge--ok' : 'msg__mount-badge'}>
                {decided === 'mounted' ? t('chat.mount.memberPicked') : t('chat.mount.memberSkipped')}
              </span>
            )}
          </div>
        )}
        <div className="msg__mount-body">
          {decided === 'mounted' ? (
            <span>
              {t('chat.mount.memberDone')} <code>{block.root}</code>
            </span>
          ) : (
            <span>{t('chat.mount.memberHint')}</span>
          )}
        </div>
        {!decided && onMountReq && (
          <div className="msg__mount-actions">
            <button type="button" className="btn btn--sm btn--primary" onClick={pick}>
              <FolderOpen size={14} />
              {t('chat.mount.memberPick')}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => onMountReq(block.key, null)}>
              {t('chat.mount.memberSkip')}
            </button>
            {extra}
          </div>
        )}
      </div>
    )
  }
  return (
    <div
      className={`msg__mount${decided ? ' is-decided' : ''}${decided === 'mounted' ? ' is-ok' : ''}`}
    >
      {!(bare && !decided) && (
        <div className="msg__mount-head">
          <FolderOpen size={14} />
          <span className="msg__mount-title">{t('chat.mount.cardTitle')}</span>
          {decided && (
            <span
              className={
                decided === 'mounted' ? 'msg__mount-badge msg__mount-badge--ok' : 'msg__mount-badge'
              }
            >
              {decided === 'mounted' ? t('chat.mount.mounted') : t('chat.mount.skipped')}
            </span>
          )}
        </div>
      )}
      <div className="msg__mount-body">
        {decided === 'mounted' ? (
          <span>
            {t('chat.mount.doneHint')} <code>{block.root}</code>
          </span>
        ) : (
          <>
            <span>
              {block.path ? t('chat.mount.reasonPath') : t('chat.mount.reasonScan')}
              {block.path && <code>{block.path}</code>}
            </span>
            <span className="msg__mount-tool">
              {t('chat.mount.byTool')} <code>{block.tool}</code>
            </span>
          </>
        )}
      </div>
      {!decided && onMountReq && (
        <div className="msg__mount-actions">
          <button type="button" className="btn btn--sm btn--primary" onClick={pick}>
            <FolderOpen size={14} />
            {t('chat.mount.pick')}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onMountReq(block.key, null)}
          >
            {t('chat.mount.skip')}
          </button>
          {extra}
        </div>
      )}
    </div>
  )
}

/**
 * 计划审阅卡（exit_plan）：展示模型提交的待批准计划（Markdown 正文），左侧「继续完善」，右侧「忽略 / 批准并执行」。
 * 未决态可交互；decided 为终态、只读展示（重开对话按 plans 边车复原）。其中 cancelled = 这次审阅已随
 * 回合结束（中断 / 历史回填），主进程已无人接应——只展示不给按钮，免得留下点不动的「僵尸卡」。
 * onPlan 缺省 → 只读。
 * 已决态默认**收起**正文（只留标题行 + 计划首行摘要），点标题行展开/收起，免得长计划在批准后继续占满对话。
 * 「继续完善」在卡内展开输入框，回复（修改意见或提问）须非空才能提交，随决定一起回灌、模型当轮回应；
 * 回复在已决态常显（收起时也显示）。「忽略」= 放弃这份计划，模型不执行也不重提。
 */
function PlanReviewCard({
  block,
  onPlan,
  bare,
  extra
}: {
  block: Extract<ChatBlock, { kind: 'plan' }>
  onPlan?: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  /** 见 BlockView 同名参数。 */
  bare?: boolean
  extra?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const decided = block.decided
  const [open, setOpen] = useState(false)
  const [refining, setRefining] = useState(false)
  const [feedback, setFeedback] = useState('')
  const showBody = !decided || open
  const reply = feedback.trim()
  const submitKeep = (): void => {
    if (reply) onPlan?.(block.key, 'keep', reply)
  }
  const summary = decided ? planSummary(block.plan) : ''
  return (
    <div
      className={`msg__plan${decided ? ' is-decided' : ''}${decided === 'approve' ? ' is-ok' : ''}`}
    >
      {!(bare && !decided) && (
        <div
          className={decided ? 'msg__plan-head is-toggle' : 'msg__plan-head'}
          role={decided ? 'button' : undefined}
          tabIndex={decided ? 0 : undefined}
          aria-expanded={decided ? open : undefined}
          title={decided ? (open ? t('chat.plan.collapse') : t('chat.plan.expand')) : undefined}
          onClick={decided ? () => setOpen((v) => !v) : undefined}
          onKeyDown={
            decided
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setOpen((v) => !v)
                  }
                }
              : undefined
          }
        >
          {decided && (
            <ChevronRight size={14} className={open ? 'msg__plan-caret is-open' : 'msg__plan-caret'} />
          )}
          <ClipboardList size={14} className="msg__plan-icon" />
          <span className="msg__plan-title">{t('chat.plan.cardTitle')}</span>
          {decided && !open && summary && <span className="msg__plan-summary">{summary}</span>}
          {decided && (
            <span
              className={
                decided === 'approve' ? 'msg__plan-badge msg__plan-badge--approved' : 'msg__plan-badge'
              }
            >
              {decided === 'approve'
                ? t('chat.plan.approved')
                : decided === 'keep'
                  ? t('chat.plan.kept')
                  : decided === 'ignore'
                    ? t('chat.plan.ignored')
                    : t('chat.plan.cancelled')}
            </span>
          )}
        </div>
      )}
      {showBody && (
        <div className="msg__plan-body">
          <Markdown text={block.plan} />
        </div>
      )}
      {block.feedback && (
        <div className="msg__plan-feedback">
          <span className="msg__plan-feedback-label">{t('chat.plan.feedbackLabel')}</span>
          <span className="msg__plan-feedback-text">{block.feedback}</span>
        </div>
      )}
      {!decided && onPlan && refining && (
        <div className="msg__plan-refine">
          <textarea
            className="msg__plan-input"
            rows={3}
            value={feedback}
            placeholder={t('chat.plan.feedbackPlaceholder')}
            autoFocus
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              // 同输入框：回车提交、Shift / Ctrl / Alt+回车换行、输入法组字中不拦；空回复不提交。
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              if (e.shiftKey || e.ctrlKey || e.altKey) return
              e.preventDefault()
              submitKeep()
            }}
          />
          <div className="msg__plan-actions">
            <button type="button" className="btn btn--sm" onClick={() => setRefining(false)}>
              {t('chat.plan.back')}
            </button>
            <div className="msg__plan-actions-end">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={!reply}
                onClick={submitKeep}
              >
                {t('chat.plan.sendFeedback')}
              </button>
            </div>
          </div>
        </div>
      )}
      {!decided && onPlan && !refining && (
        <div className="msg__plan-actions">
          <button type="button" className="btn btn--sm" onClick={() => setRefining(true)}>
            {t('chat.plan.keep')}
          </button>
          {extra}
          <div className="msg__plan-actions-end">
            <button type="button" className="btn btn--sm" onClick={() => onPlan(block.key, 'ignore')}>
              {t('chat.plan.ignore')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onPlan(block.key, 'approve')}
            >
              <ClipboardCheck size={14} />
              {t('chat.plan.approve')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 计划的一行摘要：正文首个非空行，剥掉 Markdown 标题 / 列表 / 强调标记（已决计划卡收起态与时间轴节点共用）。 */
function planSummary(plan: string): string {
  return (plan.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^\s*(#+|[-*+]|\d+[.)])\s*/, '')
    .replace(/[*_`]/g, '')
    .trim()
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
 * 已答态默认**收起**（与计划卡同构：标题行 + 答案摘要 + 状态徽标），点标题行展开/收起逐题回述。
 */
function AskCard({
  block,
  onAsk,
  bare,
  extra
}: {
  block: Extract<ChatBlock, { kind: 'ask' }>
  onAsk: (key: string, answers: string[]) => void
  /** 见 BlockView 同名参数。 */
  bare?: boolean
  extra?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const { questions } = block
  const multiQ = questions.length > 1
  const last = questions.length - 1
  const answered = block.answers !== undefined
  // 已答态：默认收起；摘要 = 各题非空答案按「；」拼接（单题即答案本身），徽标按实答题数决定绿/灰。
  const [open, setOpen] = useState(false)
  const givenAnswers = (block.answers ?? []).filter((a) => a.trim())
  const answerSummary = givenAnswers.join('；')
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

  // 点「自己输入」项：选中即原地变输入框，点前面的勾取消。单选时与真候选项互斥（清空 picks）；取消时清空已输文本。
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

  // 留空点到别处即退回未选中，不留一个空的选中项；切走窗口时 document 已失焦，不算。
  const onInlineBlur = (qi: number): void => {
    setTimeout(() => {
      if (!document.hasFocus()) return
      setDrafts((prev) =>
        prev.map((d, i) =>
          i === qi && d.customOn && !d.custom.trim() ? { ...d, customOn: false, custom: '' } : d
        )
      )
    }, 0)
  }

  // 行内输入框挂载即聚焦、光标放末尾（回到已填过的题接着写）；引用稳定，只在挂载时调用。
  const focusInline = useCallback((el: HTMLTextAreaElement | null): void => {
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // 有候选项时，输入框仅在选中「自己输入」后显示（就在该行原地）；纯自由题（无候选项）恒显示。
  const inputShown = (qi: number): boolean =>
    questions[qi].options.length === 0 || drafts[qi].customOn

  // 「真有答案」= 选了项或填了（已展开的）自由输入：步骤圆点打勾只看这个，可跳过题未答不打勾。
  const isAnswered = (qi: number): boolean => {
    const d = drafts[qi]
    if (d.picks.length > 0) return true
    return inputShown(qi) && d.custom.trim().length > 0
  }
  // 「可放行」（下一步/提交是否可用）= 可跳过题(required===false)恒放行；否则需真有答案。
  const isDone = (qi: number): boolean => questions[qi].required === false || isAnswered(qi)
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

  // 自由输入回车：向导非末题前进（须本题已答）；单题或末题提交（须全答）。回车不换行。
  const onCustomKeyDown = (e: React.KeyboardEvent, qi: number): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    if (multiQ && qi < last) {
      if (isDone(qi)) goStep(qi + 1)
    } else if (allDone) {
      submit()
    }
  }

  // 单题作答区（候选项 + 「自己输入」项 / 纯自由题的输入框）：单题模式与向导模式共用。
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
            {/* 「自己输入」项：选中后这一行原地变成输入框（对齐 Claude Code 的 Other），不另起文本框。 */}
            {d.customOn ? (
              <div
                className="ask__option ask__option--custom is-on"
                // 点行内空白也落到文本框；拦下默认行为，免得先失焦触发「留空退回」。
                onMouseDown={(e) => {
                  if (e.target instanceof HTMLTextAreaElement) return
                  e.preventDefault()
                  e.currentTarget.querySelector('textarea')?.focus()
                }}
              >
                <CustomIcon
                  size={15}
                  className="ask__option-mark"
                  onClick={() => toggleCustom(qi)}
                />
                <span className="ask__option-body">
                  <textarea
                    // 向导换题时重新挂载，以便聚焦并把光标放到末尾。
                    key={qi}
                    ref={focusInline}
                    className="ask__inline"
                    rows={1}
                    value={d.custom}
                    placeholder={t('chat.ask.customPlaceholder')}
                    onChange={(e) => patchDraft(qi, { custom: e.target.value })}
                    onKeyDown={(e) => onCustomKeyDown(e, qi)}
                    onBlur={() => onInlineBlur(qi)}
                  />
                </span>
              </div>
            ) : (
              <button type="button" className="ask__option" onClick={() => toggleCustom(qi)}>
                <CustomIcon size={15} className="ask__option-mark" />
                <span className="ask__option-body">
                  <span className="ask__option-label">{t('chat.ask.customOption')}</span>
                </span>
              </button>
            )}
          </div>
        )}
        {!hasOptions && (
          <div className="ask__custom">
            <Pencil size={13} className="ask__custom-icon" />
            <input
              className="ask__custom-input"
              value={d.custom}
              placeholder={t('chat.ask.customPlaceholder')}
              onChange={(e) => patchDraft(qi, { custom: e.target.value })}
              onKeyDown={(e) => onCustomKeyDown(e, qi)}
            />
          </div>
        )}
        {q.required === false && <div className="ask__optional">{t('chat.ask.optional')}</div>}
      </>
    )
  }

  return (
    <div className={`ask${answered ? ' is-answered' : ''}`}>
      {answered ? (
        // 已答：标题行可点，展开/收起逐题回述；收起时只留答案摘要 + 状态徽标。
        <div
          className="ask__head is-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={open ? t('chat.ask.collapse') : t('chat.ask.expand')}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen((v) => !v)
            }
          }}
        >
          <ChevronRight size={14} className={open ? 'ask__caret is-open' : 'ask__caret'} />
          <span className="ask__head-icon">
            <MessageCircleQuestion size={15} />
          </span>
          <span className="ask__title">{t('chat.ask.title')}</span>
          {!open && answerSummary && <span className="ask__summary">{answerSummary}</span>}
          <span className={givenAnswers.length > 0 ? 'ask__badge ask__badge--ok' : 'ask__badge'}>
            {givenAnswers.length > 0 ? t('chat.ask.answered') : t('chat.ask.unanswered')}
            {multiQ && givenAnswers.length > 0 && ` ${givenAnswers.length}/${questions.length}`}
          </span>
        </div>
      ) : bare ? null : (
        <div className="ask__head">
          <span className="ask__head-icon">
            <MessageCircleQuestion size={15} />
          </span>
          {t('chat.ask.title')}
          {multiQ && (
            <span className="ask__progress">
              {step + 1} / {questions.length}
            </span>
          )}
        </div>
      )}

      {answered ? (
        // 已答展开：逐题回述（紧凑，一行一答）；收起时不渲染。
        open &&
        questions.map((q, qi) => (
          <div className="ask__q" key={qi}>
            <div className="ask__question">
              {multiQ && <span className="ask__q-num">{qi + 1}.</span>}
              {q.question}
            </div>
            {/* 真有答案 → 成功绿勾；跳过/未作答 → 灰勾，不冒充「已确认」。 */}
            <div className={block.answers?.[qi] ? 'ask__resolved is-ok' : 'ask__resolved'}>
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
                  isAnswered(i) ? ' is-done' : ''
                }`}
                onClick={() => goStep(i)}
                aria-label={`${i + 1}`}
              >
                {isAnswered(i) && i !== step ? <Check size={12} /> : i + 1}
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
            <span className="ask__actions-start">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => goStep(step - 1)}
                disabled={step === 0}
              >
                {t('chat.ask.prev')}
              </button>
              {extra}
            </span>
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
            {extra && <span className="ask__actions-start">{extra}</span>}
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
 * 成功时不必再写出的结果摘要：动词已经说明了结果（主进程给的摘要是中文定稿，这里按原文比对）。
 * 命令以退出码 0 结束是常态，同样不写；非 0 退出码主进程会标成失败，照常显示。
 */
const QUIET_SUMMARIES = new Set([
  '已编辑',
  '已写入',
  '退出码 0',
  '已记住',
  '已删除',
  '已创建技能',
  '已创建 MCP 服务'
])

/** 成功摘要只是复述对象的工具：技能的「已加载技能「名称」」与行上的「已加载技能 名称」重复，不写。 */
const QUIET_TOOLS = new Set([
  'skill',
  'tool_search',
  'create_member',
  'member_send',
  'member_stop',
  'member_status',
  'read_main',
  'report_to_main',
  'reply_task'
])

/** 子智能体被用户亲手停下的结局摘要（后台「已停止」/ 前台「已中止」）：不当作出错展示。 */
const STOPPED_SUMMARIES = new Set(['已停止', '已中止'])

/** 工具的动词键（chat.flow.{done|doing|base}.<键>），见 toolMeta；未知工具（如 MCP 工具）为 unknown。 */
function verbKey(name: string, args?: unknown): string {
  return toolMeta(name, args)?.key ?? 'unknown'
}

type ToolStep = { name: string; args: unknown; status: ToolStatus; summary?: string }

const isFailed = (status: ToolStatus): boolean => status === 'error' || status === 'denied'

/** 不算原因的失败摘要（主进程旧版兜底写的就是它，旧对话里还存着）：照「没有原因」处理，只显示「失败」。 */
const GENERIC_FAILURES = new Set(['失败', 'failed', 'Failed'])

/** 失败 / 拒绝时写在行尾的原因；没有具体原因时为「失败」。未失败返回 null。 */
function failReason(step: ToolStep, t: (key: string) => string): string | null {
  if (!isFailed(step.status)) return null
  if (step.status === 'denied') return t('chat.status.denied')
  return step.summary && !GENERIC_FAILURES.has(step.summary) ? step.summary : t('chat.flow.failed')
}

/** 行上的悬停提示：完整对象（命令 / 路径），失败时另起一行附上原因。 */
function stepTitle(step: ToolStep, t: (key: string) => string): string | undefined {
  const full = flowObject(step.name, step.args, t)?.full
  const reason = failReason(step, t)
  if (!reason) return full
  return full ? `${full}\n${reason}` : reason
}

/** 节点图标：执行中转圈、失败打叉，其余按工具类型（未知工具为扳手）。 */
function stepIcon(step: ToolStep, size: number, taskStatus = false): React.JSX.Element {
  if (step.status === 'running') return <Loader2 size={size} className="spin" />
  if (isFailed(step.status)) return <XCircle size={size} />
  const Icon = taskStatus ? CalendarClock : (toolMeta(step.name, step.args)?.icon ?? Wrench)
  return <Icon size={size} />
}

/**
 * 一次工具调用的文字：动词 + 对象 + 结果说明（单行，完整对象挂在外层的悬停上）。
 * 成功不做标记（只补一句有信息量的摘要），执行中动词扫光，失败 / 拒绝在行尾用灰字写原因（同子智能体被停止）——
 * 红色叉号图标已表明失败，原因不必抢眼：出错后模型多半会自己改了重跑。不加「失败：」前缀，没有具体原因时才写「失败」。
 * 放不下时只省略对象（长命令 / 长路径），结果说明保持完整——否则失败原因总被挤出行外。
 * 时间轴与后台任务面板（每个后台子智能体的当前步骤）共用。
 */
export function ToolText({ step }: { step: ToolStep }): React.JSX.Element {
  const { t } = useI18n()
  const faceOf = useContext(MemberFaceContext)
  const key = useTaskStatusStep(step) ? 'taskStatus' : verbKey(step.name, step.args)
  const obj = flowObject(step.name, step.args, t)
  const member = memberObject(step.name, step.args)
  const reason = failReason(step, t)
  let verb: React.JSX.Element
  let tail: React.JSX.Element | null = null
  if (step.status === 'running') {
    verb = <span className="tl__shimmer">{t(`chat.flow.doing.${key}`)}</span>
  } else if (reason) {
    verb = <span className="tl__verb">{t(`chat.flow.base.${key}`)}</span>
    tail = <span className="tl__extra">{reason}</span>
  } else {
    verb = <span className="tl__verb">{t(`chat.flow.done.${key}`)}</span>
    if (step.summary && !QUIET_SUMMARIES.has(step.summary) && !QUIET_TOOLS.has(step.name))
      tail = <span className="tl__extra">{step.summary}</span>
  }
  return (
    <span className="tl__text tl__text--tool">
      {verb}
      {/* 成员名不是代码：正文字体，前面带成员的小头像，任务标题灰字跟在后面。 */}
      {member ? (
        <span className="tl__obj tl__obj--member">
          {faceOf?.(member.who)}
          <span className="tl__who">{member.who}</span>
          {member.task && <span className="tl__task"> · {member.task}</span>}
        </span>
      ) : (
        obj && <code className="tl__obj">{obj.text}</code>
      )}
      {tail}
    </span>
  )
}

/**
 * 时间轴上的工具调用节点：图标节点 + 一行文字。
 * 命令可以点开看完整命令（行里放不下、多行命令被压成一行）：样式同 Markdown 代码块，表头只有复制按钮——
 * 失败原因已写在行尾；能点开看，就不再挂悬停提示。其余工具只有一行，完整对象挂在悬停上。
 */
function TimelineTool({ step }: { step: ToolStep }): React.JSX.Element {
  const { t } = useI18n()
  const { skills } = useExtensions()
  const [open, setOpen] = useState(false)
  // 查看定时任务：节点用日历钟（同任务入口），不用成员的人形图标。
  const taskStatus = useTaskStatusStep(step)
  const state = step.status === 'running' ? ' is-run' : isFailed(step.status) ? ' is-err' : ''
  const command = step.name === 'run_command' ? flowObject(step.name, step.args)?.full : undefined
  let title = stepTitle(step, t)
  // 技能行里只写技能名：悬停另起一行附上技能说明（按名称或文件夹名匹配，同主进程 skill 工具）。
  if (step.name === 'skill' && !isFailed(step.status)) {
    const wanted = flowObject(step.name, step.args)?.full.toLowerCase()
    const desc = skills.find((s) => s.name.toLowerCase() === wanted || s.id.toLowerCase() === wanted)?.desc.trim()
    if (title && desc) title = `${title}\n${desc}`
  }
  if (!command)
    return (
      <li className={`tl__item${state}`}>
        <span className="tl__node">{stepIcon(step, 14, taskStatus)}</span>
        <div className="tl__main">
          <div className="tl__line" title={title}>
            <ToolText step={step} />
          </div>
        </div>
      </li>
    )
  return (
    <li className={`tl__item${state}${open ? ' is-open' : ''}`}>
      <span className="tl__node">{stepIcon(step, 14)}</span>
      <div className="tl__main">
        <button
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ToolText step={step} />
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body md-code tl__cmd">
            <div className="md-code__head">
              <span className="md-code__lang">shell</span>
              <CopyButton getText={() => command} />
            </div>
            <pre className="tl__cmd-body">{command}</pre>
          </div>
        )}
      </div>
    </li>
  )
}

/** 时间轴上的中间说明（夹在工具调用之间的正文）：小圆点节点 + 弱化的正文。 */
function TimelineNote({ text }: { text: string }): React.JSX.Element {
  return (
    <li className="tl__item tl__item--note">
      <span className="tl__node">
        <span className="tl__dot" />
      </span>
      <div className="tl__main">
        <Markdown text={text} muted />
      </div>
    </li>
  )
}

/**
 * 时间轴上已作答的提问：「已回答 + 答案摘要」，点开逐题回述。作答前它是对话里的问答卡（等你回复），
 * 答完就收进工作过程，免得一张大卡留在中间，后续步骤与回复一上一下把页面拉来拉去。
 */
function TimelineAsk({ block }: { block: Extract<ChatBlock, { kind: 'ask' }> }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const given = (block.answers ?? []).filter((a) => a.trim())
  const multiQ = block.questions.length > 1
  return (
    <li className={`tl__item${open ? ' is-open' : ''}`}>
      <span className="tl__node">
        <MessageCircleQuestion size={14} />
      </span>
      <div className="tl__main">
        <button
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tl__text">
            <span className="tl__verb">{t(given.length > 0 ? 'chat.ask.answered' : 'chat.ask.unanswered')}</span>
            {given.length > 0 && <span>{given.join('；')}</span>}
          </span>
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body tl__qa">
            {block.questions.map((q, qi) => (
              <div key={qi}>
                <div className="tl__qa-q">
                  {multiQ && `${qi + 1}. `}
                  {q.question}
                </div>
                <div className="tl__qa-a">{block.answers?.[qi] || t('chat.ask.noAnswer')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/** 时间轴上已决定的计划：「已批准计划 + 摘要」等，点开看计划全文与你写的回复。 */
function TimelinePlan({ block }: { block: Extract<ChatBlock, { kind: 'plan' }> }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const decision = block.decided ?? 'cancelled'
  return (
    <li className={`tl__item${open ? ' is-open' : ''}`}>
      <span className="tl__node">
        {decision === 'approve' ? <ClipboardCheck size={14} /> : <ClipboardList size={14} />}
      </span>
      <div className="tl__main">
        <button
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tl__text">
            <span className="tl__verb">{t(`chat.flow.plan.${decision}`)}</span>
            <span>{planSummary(block.plan)}</span>
          </span>
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body tl__plan">
            <Markdown text={block.plan} muted />
            {block.feedback && (
              <div className="tl__feedback">
                <span className="tl__feedback-label">{t('chat.plan.feedbackLabel')}</span>
                {block.feedback}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * 时间轴上已完成的待办清单：「已完成清单 + 标题 + 条目数」，点开看全部条目。清单全部完成时落在对话流里
 * （输入框上方的进度胶囊随之收起）。纯展示，不进模型上下文。
 */
function TimelineTodo({ block }: { block: Extract<ChatBlock, { kind: 'todolist' }> }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <li className={`tl__item${open ? ' is-open' : ''}`}>
      <span className="tl__node">
        <ClipboardCheck size={14} />
      </span>
      <div className="tl__main">
        <button
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tl__text">
            <span className="tl__verb">{t('chat.todo.doneTitle')}</span>
            <span>{block.title || t('chat.todo.untitled')}</span>
            <span className="tl__extra">
              {block.items.length} {t('chat.todo.itemUnit')}
            </span>
          </span>
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body tl__todo">
            <TodoItemList items={block.items} />
          </div>
        )}
      </div>
    </li>
  )
}

/** 时间轴上已处置的挂载请求：「已挂载工作区 + 目录」或「未挂载工作区」。 */
function TimelineMount({ block }: { block: Extract<ChatBlock, { kind: 'mount' }> }): React.JSX.Element {
  const { t } = useI18n()
  const mounted = block.decided === 'mounted'
  const verb =
    block.member !== undefined
      ? t(mounted ? 'chat.flow.mount.memberPicked' : 'chat.flow.mount.memberSkipped')
          .split('{name}')
          .join(block.member)
      : t(mounted ? 'chat.flow.mount.mounted' : 'chat.flow.mount.skipped')
  return (
    <li className="tl__item">
      <span className="tl__node">
        <FolderOpen size={14} />
      </span>
      <div className="tl__main">
        <div className="tl__line" title={mounted ? block.root : undefined}>
          <span className="tl__text">
            <span className="tl__verb">{verb}</span>
            {mounted && block.root && <code className="tl__obj">{block.root}</code>}
          </span>
        </div>
      </div>
    </li>
  )
}

/**
 * 两轮之间的压缩提示：分隔线中间一行「以上对话已压缩为摘要 · 查看摘要」，被压的消息照常显示在它上面。
 * 摘要正文默认折叠、点开才看——它是写给模型的上下文，不该以角色的口吻整段摊在对话里。
 * first = 前面没有任何消息（旧版压缩删掉了原文）：改写「较早的对话已压缩为摘要」，也不画分隔线。
 */
export function CompactionNotice({ summary, first = false }: { summary: string; first?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className={`msg__compaction${open ? ' is-open' : ''}${first ? ' is-first' : ''}`}>
      <div className="msg__compaction-line">
        <button
          type="button"
          className="msg__compaction-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Archive size={13} />
          <span>{t(first ? 'chat.notice.compactedFirst' : 'chat.notice.compacted')}</span>
          <span className="msg__compaction-toggle">
            {open ? t('chat.notice.compactedHide') : t('chat.notice.compactedShow')}
          </span>
          <ChevronRight size={13} className="msg__compaction-caret" />
        </button>
      </div>
      {open && (
        <div className="msg__compaction-body">
          <Markdown text={summary} muted />
        </div>
      )}
    </div>
  )
}

/**
 * 一轮进行中的压缩：执行步骤里的一个节点「此前 N 步已压缩为摘要 · 查看摘要」，只有文字、不加底色，
 * 点开在节点下展开摘要。不计入步数。steps = 0（旧版压缩删掉了已完成的步骤）时写「此前的步骤已压缩为摘要」。
 */
function TimelineCompaction({ summary, steps }: { summary: string; steps: number }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [lineRef, markToggle] = useAnchorOnClose<HTMLButtonElement>(open)
  const label =
    steps > 0 ? t('chat.notice.compactedSteps').replace('{n}', String(steps)) : t('chat.notice.compactedStepsNone')
  return (
    <li className={`tl__item tl__item--compaction${open ? ' is-open' : ''}`}>
      <span className="tl__node">
        <Archive size={14} />
      </span>
      <div className="tl__main">
        <button
          ref={lineRef}
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => {
            markToggle()
            setOpen((v) => !v)
          }}
        >
          <span className="tl__text">
            <span>{label}</span>
            <span className="tl__compaction-toggle">
              {open ? t('chat.notice.compactedHide') : t('chat.notice.compactedShow')}
            </span>
          </span>
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body tl__think">
            <Markdown text={summary} muted />
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * 时间轴上回合进行中插入的消息：节点是用户自己的小头像，正文用用户气泡的底色，与工具步骤区分开，一眼看出是「我说的」。
 * 正文完整显示（可换行），不像工具步骤那样截成一行。
 */
function TimelineInsert({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n()
  const profile = useProfile()
  return (
    <li className="tl__item tl__item--insert">
      <span className="tl__node">
        <span className="tl__me" title={t('chat.insert.node')}>
          <PersonaFace seed={USER_AVATAR_SEED} spec={profile.avatar} image={profile.avatarImage} compact />
        </span>
      </span>
      <div className="tl__main">
        <div className="tl__insert">{text}</div>
      </div>
    </li>
  )
}

/** 时间轴的一步（index 为其在原块序列中的下标）。 */
type TimelineStep = { block: ChatBlock; index: number }

/**
 * 时间轴（仿 Claude / ChatGPT）：一条细竖线串起每一步，每步一个图标节点——读取、编辑、命令各有图标，
 * 失败的节点变红、执行中的转圈；思考与子智能体的节点可展开。逐条列出，不做合并。
 * liveBlock = 仍在流式输出的那一块（按引用比对，思考据此判断是否已完成），没有则缺省。
 * compact = 进行中折叠条下的当前步骤：思考中不展开全文，改为实时小窗。
 * limit = 最多画几个节点：超出时留出最后一格写「还有 N 个在执行」，控制当前步骤区域的最大高度。
 */
export function Timeline({
  steps,
  liveBlock,
  compact = false,
  limit
}: {
  steps: TimelineStep[]
  liveBlock?: ChatBlock
  compact?: boolean
  limit?: number
}): React.JSX.Element {
  const { t } = useI18n()
  const capped = limit !== undefined && steps.length > limit
  const shown = capped ? steps.slice(0, limit - 1) : steps
  return (
    <ol className="tl">
      {shown.map(({ block: b, index }) => {
        if (b.kind === 'tool') return <TimelineTool key={b.id} step={b} />
        if (b.kind === 'subagent') return <TimelineSubagent key={b.id} block={b} />
        if (b.kind === 'thinking')
          return (
            <TimelineThinking key={`i${index}`} text={b.text} done={b !== liveBlock} autoOpen={!compact} />
          )
        if (b.kind === 'text') return <TimelineNote key={`i${index}`} text={b.text} />
        if (b.kind === 'ask') return <TimelineAsk key={b.key} block={b} />
        if (b.kind === 'plan') return <TimelinePlan key={b.key} block={b} />
        if (b.kind === 'mount') return <TimelineMount key={b.key} block={b} />
        if (b.kind === 'todolist') return <TimelineTodo key={b.id} block={b} />
        if (b.kind === 'insert') return <TimelineInsert key={`i${index}`} text={b.text} />
        if (b.kind === 'compaction')
          return <TimelineCompaction key={`c${index}`} summary={b.summary} steps={b.steps ?? 0} />
        return null
      })}
      {capped && (
        <li className="tl__item tl__item--more">
          <span className="tl__node">
            <span className="tl__dot" />
          </span>
          <div className="tl__main">
            <div className="tl__line">
              {t('chat.process.more').replace('{n}', String(steps.length - shown.length))}
            </div>
          </div>
        </li>
      )}
    </ol>
  )
}

/**
 * 块序列的渲染单元：single = 原样渲染的单块（index 为其在原序列中的下标，供 thinkingDone 判定）；
 * timeline = 一段连续的过程（思考 / 工具调用 / 子智能体），画成一条时间轴。
 */
export type BlockItem =
  | { type: 'single'; block: ChatBlock; index: number }
  | { type: 'timeline'; steps: TimelineStep[]; key: string }

/**
 * 进时间轴的块：思考、工具调用（含交付，交付卡另见 DeliveryCards）、子智能体、已完成的待办清单，以及已经
 * 处置过的提问 / 计划 / 挂载请求（还在等你处置时是对话里的卡片）。
 */
function isTimelineStep(b: ChatBlock): boolean {
  switch (b.kind) {
    case 'tool':
    case 'thinking':
    case 'subagent':
    case 'todolist':
    case 'insert':
      return true
    // 一轮进行中的压缩是执行步骤里的节点；两轮之间的自成一条，不进时间轴。
    case 'compaction':
      return b.steps !== undefined
    case 'ask':
      return b.answers !== undefined
    case 'plan':
    case 'mount':
      return Boolean(b.decided)
    default:
      return false
  }
}

/**
 * 把助手块序列切成渲染单元（纯函数）：连续的过程块收成一条时间轴；空文本块与步骤边界不渲染，也不打断时间轴
 * （流式间隙常见）；其余块原样逐个渲染并打断时间轴。
 * notesInline：夹在过程块之间的正文也作为时间轴上的「说明」节点——用于已结束回合的工作过程（那里的正文
 * 都是中间说明）；进行中的回合不知道哪段正文是最终回复，正文照常渲染、打断时间轴。
 * 只含说明、没有一步过程的段不成时间轴，正文原样拆回单块。
 */
export function groupBlocks(blocks: ChatBlock[], notesInline = false): BlockItem[] {
  const out: BlockItem[] = []
  let run: TimelineStep[] = []

  const flush = (): void => {
    if (run.some((s) => isTimelineStep(s.block))) {
      // 以首步下标作 key：时间轴在流式中增长时不重挂载，节点的展开态得以保留。
      out.push({ type: 'timeline', steps: run, key: `tl:${run[0].index}` })
    } else {
      for (const s of run) out.push({ type: 'single', block: s.block, index: s.index })
    }
    run = []
  }

  blocks.forEach((b, i) => {
    if (isTimelineStep(b) || (notesInline && b.kind === 'text' && b.text.trim())) {
      run.push({ block: b, index: i })
    } else if ((b.kind === 'text' && !b.text.trim()) || b.kind === 'step') {
      // 透明：不渲染、不打断。
    } else {
      flush()
      out.push({ type: 'single', block: b, index: i })
    }
  })
  flush()
  return out
}

/**
 * 不折进「工作过程」的块：角色 / 任务名片、错误与回合提示、还在等你处置的问答 / 计划 / 挂载卡——
 * 这些是要用户看到或处理的结果，不是过程。问答 / 计划 / 挂载卡处置完就成了过程的一步，收进折叠条。
 * 后台运行的子智能体也是过程的一步（停止键在输入框上方的后台任务胶囊里，不在对话流中）。
 * 交付调用同样是过程的一步，交付卡不在块序列的原位置上画，回合结束后排在回复末尾（见 DeliveryCards）。
 */
function isPinned(b: ChatBlock): boolean {
  switch (b.kind) {
    case 'agentcard':
    case 'autotaskcard':
    case 'error':
    case 'notice':
      return true
    case 'compaction':
      return b.steps === undefined
    case 'ask':
      return b.answers === undefined
    case 'plan':
    case 'mount':
      return !b.decided
    default:
      return false
  }
}

/** 成功的交付（present_files）：回合结束后在回复末尾画交付卡。 */
function isDelivery(b: ChatBlock): b is Extract<ChatBlock, { kind: 'tool' }> {
  return b.kind === 'tool' && b.name === 'present_files' && b.status === 'ok'
}

/**
 * 本轮的交付卡，按调用顺序排在回复末尾；由调用方只在回合结束后渲染——进行中交付只是时间轴上的一步。
 * 工具描述据此告诉模型「交付卡在本轮回复结束后显示在回复末尾」（main/services/tools.ts），改位置时一并改。
 */
export function DeliveryCards({ blocks }: { blocks: ChatBlock[] }): React.JSX.Element {
  return (
    <>
      {blocks.filter(isDelivery).map((b) => (
        <DeliverablesCard key={b.id} block={b} />
      ))}
    </>
  )
}

/** 算「过程」的块：时间轴上的各步（固定展示的除外）。 */
function isProcess(b: ChatBlock): boolean {
  if (isPinned(b)) return false
  return isTimelineStep(b)
}

/** 块序列里是否已有过程（思考 / 工具调用 / 子智能体 / 已完成清单）：有则消息里会出现「工作过程」折叠条。 */
export function hasProcess(blocks: ChatBlock[]): boolean {
  return blocks.some(isProcess)
}

/**
 * 回合的过程折叠（纯函数）：最后一个过程块及其之前的非固定块（含夹在中间的正文）收进「工作过程」，
 * 其后的正文即最终回复；固定块无论位置都留在外面，保持原相对顺序。进行中与结束后同一套切法——
 * 进行中时夹在工具调用之间的说明一旦后面又有了工具调用，就随之收进折叠条。
 * 没有过程块 → null，按原样逐块渲染。已结束回合折叠后外面什么都不剩（如中断在工具调用上）也返回 null；
 * 末尾的交付卡算外面有东西（交付完没再写字也照常折叠）。进行中（live）不看这一条：回复还没写出来是常态。
 */
export function splitProcess(
  blocks: ChatBlock[],
  live = false
): { process: ChatBlock[]; visible: ChatBlock[] } | null {
  let last = -1
  blocks.forEach((b, i) => {
    if (isProcess(b)) last = i
  })
  if (last < 0) return null
  const process: ChatBlock[] = []
  const visible: ChatBlock[] = []
  blocks.forEach((b, i) => {
    if (i <= last && !isPinned(b)) process.push(b)
    else visible.push(b)
  })
  if (live) return { process, visible }
  const hasVisible =
    blocks.some(isDelivery) || visible.some((b) => b.kind !== 'step' && (b.kind !== 'text' || b.text.trim()))
  return hasVisible ? { process, visible } : null
}

/**
 * 进行中折叠条下露出的「当前步骤」（blocks 为整轮块序列）：所有还在执行的工具调用 / 子智能体（并行的一并
 * 列出）；都执行完、模型在想下一步时，保留最近的一步（含思考中），免得这块在一行和零行之间来回闪。
 * 最近一步之后已写出正文或出现卡片（说明、回复、待批准的计划等）时不再保留：正在输出的内容本身就是进度，
 * 留着的那一步（如「已思考」）已经过时。
 * 后台运行的子智能体不算：它不是本轮在等的事，常常比回合活得长，由输入框上方的后台任务胶囊展示。
 */
export function currentSteps(blocks: ChatBlock[]): ChatBlock[] {
  const steps = blocks.filter(isProcess)
  const running = steps.filter(
    (b) => (b.kind === 'tool' && b.status === 'running') || (b.kind === 'subagent' && b.status === 'running' && !b.background)
  )
  if (running.length > 0) return running
  const last = steps[steps.length - 1]
  if (!last) return []
  const after = blocks.slice(blocks.indexOf(last) + 1)
  return after.some((b) => b.kind !== 'step' && (b.kind !== 'text' || b.text.trim())) ? [] : [last]
}

/** 过程里只有一段思考（没有工具调用、说明等别的步骤）时返回思考正文，否则 null。 */
function thoughtOnly(blocks: ChatBlock[]): string | null {
  const steps = blocks.filter((b) => b.kind !== 'step' && (b.kind !== 'text' || b.text.trim()))
  const only = steps.length === 1 ? steps[0] : undefined
  return only?.kind === 'thinking' ? only.text : null
}

/** 秒数 →「1 分 12 秒」/「1m 12s」：高位为 0 的单位省略，秒恒显示。 */
export function formatDuration(sec: number, t: (key: string) => string): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const unit = (key: string, n: number): string => t(`chat.process.${key}`).replace('{n}', String(n))
  const parts = h ? [unit('h', h), unit('m', m), unit('s', s)] : m ? [unit('m', m), unit('s', s)] : [unit('s', s)]
  return parts.join(' ')
}

/**
 * 「工作过程」折叠条：进行中与结束后都默认收起，一行灰字。
 * 进行中：标题「处理中 · 7 步 · 12 秒」（计时在末尾，底部状态行此时不再显示），收起时下方露出当前步骤
 * （preview，由调用方给出）。thinking：当前步骤正是流式输出中的思考——标题以扫光的「思考中」开头，
 * 调用方此时只露思考的实时小窗，不再重复一行「思考中」节点。
 * 结束后：标题为本轮耗时与步数（「已处理 1 分 12 秒 · 7 步」，工具调用与子智能体各算一步）；没记录耗时的
 * 旧对话回落为「已执行 7 步」。失败不进标题——过程中的失败多是参数不对、随即重试，展开后节点已标红；
 * 真正的错误由外面的错误块呈现。
 * 展开后按原顺序画出整条时间轴（children 由调用方给出，复用其块渲染）；展开态由调用方保管，跨过回合结束不变。
 * 展开时这一行吸在对话区顶部（里面展开的思考标题读到时盖住它，见 .msg__process-row），步骤再多也能随手收起；
 * 手动收起后把这一行滚回可视区。
 * 过程里只有一段思考（进行中与结束后都算）：折叠条就是这段思考——展开后直接是思考正文（不用 children），不再
 * 套一层时间轴节点：否则进行中标题写着「思考中」，展开后下面又一行「思考中」节点，收起节点时两处重复。结束后
 * 标题为「已思考 12 秒」（没记录耗时为「已思考」）。进行中随后出现工具调用时才换成时间轴，那时思考已结束、
 * 节点本就收起，看着与自动收起无异。
 * lead：排在折叠条同一行最前面的内容（对话区传角色名，显示为「Deva  已处理 … · N 步 ⌄」）。带 lead 时
 * 箭头挪到文字末尾、朝下（展开后朝上）：夹在名字和文字之间读起来像层级路径，也看不出是展开按钮。
 */
export function ProcessFold({
  blocks,
  durationMs,
  live = false,
  thinking = false,
  elapsedSec,
  preview,
  open,
  onToggle,
  lead,
  children
}: {
  blocks: ChatBlock[]
  durationMs?: number
  live?: boolean
  /** 进行中且当前步骤是流式输出中的思考。 */
  thinking?: boolean
  /** 进行中已用秒数，显示在标题末尾。 */
  elapsedSec?: number
  preview?: React.ReactNode
  open: boolean
  onToggle: () => void
  lead?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const thought = thoughtOnly(blocks)
  const [rowRef, markToggle] = useAnchorOnClose<HTMLDivElement>(open)
  const toggle = (): void => {
    markToggle()
    onToggle()
  }
  // 步数：工具调用、子智能体、提问、计划各算一步（它们在模型那边都是一次工具调用）。
  const calls = blocks.filter(
    (b) => b.kind === 'tool' || b.kind === 'subagent' || b.kind === 'ask' || b.kind === 'plan'
  ).length
  const parts: string[] = []
  if (!live && durationMs !== undefined)
    parts.push(
      t(thought !== null ? 'chat.process.thought' : 'chat.process.worked').replace(
        '{d}',
        formatDuration(Math.max(1, Math.round(durationMs / 1000)), t)
      )
    )
  if (calls > 0)
    parts.push(
      t(live || durationMs !== undefined ? 'chat.process.count' : 'chat.process.steps').replace('{n}', String(calls))
    )
  // 进行中以当前活动开头：思考中（扫光）或处理中；结束后没有耗时与步数的旧对话回落为「已思考」。
  const title = live ? (
    <>
      {thinking ? <span className="tl__shimmer">{t('chat.thinking')}</span> : t('chat.process.live')}
      {parts.length > 0 && ` · ${parts.join(' · ')}`}
    </>
  ) : parts.length > 0 ? (
    parts.join(' · ')
  ) : (
    t('chat.thought')
  )
  const head = (
    <button type="button" className="msg__process-head" aria-expanded={open} onClick={toggle}>
      {!lead && <ChevronRight size={13} className="msg__process-caret" />}
      <span>
        {title}
        {live && elapsedSec !== undefined && (
          <span className="msg__process-time"> · {formatDuration(elapsedSec, t)}</span>
        )}
      </span>
      {lead && <ChevronDown size={13} className="msg__process-caret" />}
    </button>
  )
  return (
    <div
      className={`msg__process${open ? ' is-open' : ''}${lead ? ' has-lead' : ''}`}
    >
      <div ref={rowRef} className="msg__process-row">
        {lead}
        {head}
      </div>
      {open ? (
        <div className="msg__process-body">{thought !== null ? <Markdown text={thought} muted /> : children}</div>
      ) : (
        preview && <div className="msg__process-preview">{preview}</div>
      )}
    </div>
  )
}

/** 子智能体类型的展示名：分身（fork）按界面语言显示，其余（General / Explore / Research / Plan）原样。 */
function subagentName(agent: string | undefined, t: (key: string) => string): string {
  if (!agent) return ''
  return agent.toLowerCase() === 'fork' ? t('chat.subagent.fork') : agent
}

/**
 * 子智能体的标题（时间轴节点与后台任务胶囊共用）：优先用模型给的任务描述（3-5 字），比固定的子智能体名
 * 有信息量，也与 Claude Code 一致；没给描述时退回子智能体名（未指定预设则为「通用子智能体」）。
 */
export function subagentTitle(
  block: Extract<ChatBlock, { kind: 'subagent' }>,
  t: (key: string) => string
): string {
  return block.desc || subagentName(block.agent, t) || t('chat.subagent.fallback')
}

/**
 * 时间轴上的子智能体节点（可展开）：「子智能体任务 + 标题」+ 后台标记；执行中转圈、扫光，失败节点变红并写明原因。
 * 内部工具调用只在执行中显示（标题行带步数，展开后每步一行、带小图标）：它们不落盘，重载后就没了，
 * 故完成后一律只显示派发的任务，免得同一张卡重载前后两个样。
 * 后台运行的停止键不在这里，在输入框上方的后台任务胶囊里（BackgroundCapsule）。
 * 子智能体的权限请求不在此节点内——照常作为顶层权限卡浮出确认（见 reduceBlocks）。
 */
function TimelineSubagent({ block }: { block: Extract<ChatBlock, { kind: 'subagent' }> }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const name = subagentTitle(block, t)
  const label = t(block.continued ? 'chat.subagent.continuedTitle' : 'chat.subagent.title')
  const running = block.status === 'running'
  const steps = running ? block.children : []
  // 完成的瞬间（running: true→false）自动收起一次：步骤列表随之消失，不留着一张只剩任务的展开卡。
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false)
    wasRunning.current = running
  }, [running])
  // 结局摘要（主进程定稿的中文）：早期版本带「子智能体「名称」」前缀，节点上紧挨着名称，剥掉免得重复。
  const outcome = block.summary?.replace(/^子智能体「[^」]*」/, '')
  // 用户亲手停的（后台「已停止」/ 前台「已中止」）不是出错：节点不标红。结局与失败原因一样用灰字写在行尾。
  const stopped = isFailed(block.status) && STOPPED_SUMMARIES.has(outcome ?? '')
  const failed = isFailed(block.status) && !stopped
  return (
    <li className={`tl__item${running ? ' is-run' : failed ? ' is-err' : ''}${open ? ' is-open' : ''}`}>
      <span className="tl__node">
        {running ? <Loader2 size={14} className="spin" /> : failed ? <XCircle size={14} /> : <Bot size={14} />}
      </span>
      <div className="tl__main">
        <button
          type="button"
          className="tl__line"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tl__text">
            <span className={running ? 'tl__shimmer' : 'tl__verb'}>{label}</span>
            <span>{name}</span>
            {block.background && <span className="tl__tag">{t('chat.subagent.background')}</span>}
            {steps.length > 0 && (
              <span className="tl__extra">
                {steps.length} {t('chat.subagent.stepUnit')}
              </span>
            )}
            {stopped && <span className="tl__extra">{outcome}</span>}
            {failed && (
              <span className="tl__extra">
                {block.status === 'denied' ? t('chat.status.denied') : outcome || t('chat.status.failed')}
              </span>
            )}
          </span>
          <ChevronRight size={12} className="tl__caret" />
        </button>
        {open && (
          <div className="tl__body">
            {block.task && <div className="tl__task">{block.task}</div>}
            {steps.map((c) => (
              <div
                key={c.id}
                className={`tl__sub${isFailed(c.status) ? ' is-err' : c.status === 'running' ? ' is-run' : ''}`}
                title={stepTitle(c, t)}
              >
                <span className="tl__sub-icon">{stepIcon(c, 12)}</span>
                <ToolText step={c} />
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * 角色名片（propose_agent 提议）：微信名片式紧凑卡。
 * pending → 可点，点开预填的 PersonaEditor 供查看/微调/接受/拒绝；accepted/rejected 为终态、不可点。
 * 不传 onOpen → 名片始终只读展示。
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
      <span className="agentcard__avatar">
        {/* 提案中的智能体尚无 id：以名字为 seed 确定性生成头像（用户接受后可在编辑器改）；新角色形状按名字挑，与接受后的编辑器一致。 */}
        <HumationFace seed={name} spec={{ shape: seededShape(name) }} title={name} />
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
