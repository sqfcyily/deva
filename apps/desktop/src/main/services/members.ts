/**
 * 项目成员（多 Agent 协作，方案见 design/project-members-plan.html）。
 *
 * 一个主对话可以有至多 MAX_MEMBERS 个成员。每个成员是一个**独立的成员会话**（真正的对话文件，`parentId`
 * 指向主对话，不进左侧列表），有自己的历史、压缩、待办与回滚；主智能体用 member_send 派任务，成员在后台
 * 干完后把最终回复作为结论：成员以自己的身份（头像和名字）在主对话里回一条结论原文（不调用模型）；出错时不显示，
 * 唤醒主智能体处理。派任务时设了 report_to_me 才唤醒主智能体处理结果（等汇总时主对话里显示带头像的进度提示）。
 * 成员可直接向用户提问、提交计划（主对话里显示为通知行）。
 *
 * 成员有两种来源：
 *  · created：主智能体分析项目后用 create_member 创建，使用默认角色 Deva 的设定（不随主对话的角色），名字与职责由主智能体给出，
 *    头像以成员会话 id 为种子生成；
 *  · mention：用户在主对话里 @ 一个已有角色，系统自动把它加为成员，使用该角色的设定、名字与头像。
 *
 * 名单存在主对话的 `members` 属性里（不在消息里），压缩、按轮删除都不影响；移除只做标记，成员会话保留。
 * 主智能体通过随消息下发的【成员名单】（见 listing.ts memberListingPart）得知名单，增减成员不改工具表与系统提示词。
 */
import type { MemberRunStatus } from '../../shared/chat-protocol'
import { isAbsolute, resolve } from 'path'
import type { Message, ToolSpec } from '../providers/types'
import { isAutoNudge, isCompactionSummary, isTaskNotification } from './compaction'

/** 一个主对话的成员上限（含已移除的不算）。 */
export const MAX_MEMBERS = 10

/**
 * 派给成员的任务消息的标记前缀（成员会话里的 user 消息）：标记 + 首行「【X 派来的任务】标题」，其后是任务说明、
 * 主智能体的附注、主对话最近几轮正文（仅首次派发）。成员工作记录里据此画成「X 派来的任务」，而不是用户气泡。
 */
export const MEMBER_TASK_MARKER = '⟦deva:member-task⟧'

/**
 * 成员通知正文的开头标签（交给主智能体的结论、用户直接跟成员说话的同步）。主对话里含它的后台任务通知
 * 不显示那一行（见 chat-display.ts toDisplayMessages 的 quiet）：交差内容由其后主角色的回复呈现。
 */
export const MEMBER_NOTICE_TAG = '<成员通知>'

export interface MemberRef {
  /** 成员会话 id（也是生成头像的种子）。 */
  sessionId: string
  /** 成员名（主对话内唯一，大小写不敏感）。 */
  name: string
  origin: 'created' | 'mention'
  /** 设定来源角色：created = 默认角色 Deva（2026-11-09 前建的是当时主对话的角色），mention = 被 @ 的角色。 */
  personaId: string
  /**
   * 负责的文件夹（绝对路径）；null = 没有文件夹（用户可在成员对话里自己挂）。与成员会话的 focusRoot 同步，读取以成员会话为准
   * （见 chat-members.ts memberFolder）：2026-11-09 前 null 表示「跟随主对话」，那些成员会话的 focusRoot 已是当时主对话的目录。
   */
  root: string | null
  /** 一句话职责。 */
  duty: string
  /**
   * 头像形状（shared/avatar-shape.ts 的形状名）：主智能体建的成员创建时挑定、存下，此后固定。
   * @ 加入的角色用角色自己的头像，不存；2026-11-11 前建的成员没有，显示时按旧取法（legacyAutoShape）现算。
   */
  shape?: string
  addedAt: number
  /** 已移除：不再派任务，成员会话保留。 */
  removed?: boolean
  /** 最近一次的任务标题：主智能体派来的，或用户在成员会话里直接交代的那条消息开头。成员卡片显示它。 */
  task?: string
  /** 最近一次结论（截断）、结局与当时的任务标题。 */
  last?: { text: string; at: number; status: MemberRunStatus; task?: string }
  /**
   * 主智能体派来、还没交差的任务，按派出先后（派出时记下，交差才去掉；被停止、出错或 Deva 重启中断的都留着）：
   * 用户之后在成员会话里接着说话（如「继续」），那一轮就算接着做这几项，结束时照常交回主对话。落盘，重启后仍在。
   * 成员空闲时派来的新任务取代没做完的旧任务；正忙时插进来的追加在后面，各自交差（见 chat-members.ts）。
   * 主智能体 member_stop 叫停、成员被移除时清掉（那是不要了，不是没做完）。
   */
  openTasks?: OpenTask[]
  /** 旧版只记一项（2026-11-13 前）：读取时当作只有这一项的 openTasks（见 chat-members.ts openTasksOf）。 */
  openTask?: OpenTask
  /**
   * 用户在成员会话里亲自改过模型 / 思考等级：此后以成员会话为准，派任务时不再按主对话同步覆盖。
   */
  modelSet?: boolean
  effortSet?: boolean
}

/**
 * 一项派来、还没交差的任务。toolUseId = 主对话里 member_send 的调用 id；group = 派出它的主轮 id（要汇总的几项
 * 按它合并唤醒）；task = 任务标题（交差时的标题，旧记录没有）。
 */
export interface OpenTask {
  toolUseId: string
  reportToMe: boolean
  group: string
  task?: string
}

export type { MemberRunStatus } from '../../shared/chat-protocol'

export type { MemberProgressGroup } from '../../shared/chat-protocol'

/** 未移除的成员。 */
export function activeMembers(list: MemberRef[] | undefined): MemberRef[] {
  return (list ?? []).filter((m) => !m.removed)
}

/** 按名字找未移除的成员（去掉开头的 @、大小写不敏感）。 */
export function findMember(list: MemberRef[] | undefined, name: string): MemberRef | undefined {
  const want = name.trim().replace(/^@/, '').toLowerCase()
  if (!want) return undefined
  return activeMembers(list).find((m) => m.name.toLowerCase() === want)
}

/** 成员没有文件夹时名单里的写法。 */
export const NO_FOLDER = '未指定'

/** 文件夹在名单与界面上的写法：主对话工作目录下的写相对路径，其余写绝对路径；没有文件夹写「未指定」。 */
export function rootLabel(root: string | null, mainRoot: string | null): string {
  if (!root) return NO_FOLDER
  if (mainRoot) {
    const base = mainRoot.replace(/[\\/]+$/, '')
    const lowerRoot = root.toLowerCase()
    const lowerBase = base.toLowerCase()
    if (lowerRoot === lowerBase) return '项目根目录'
    if (lowerRoot.startsWith(lowerBase) && /[\\/]/.test(root.charAt(base.length)))
      return `${root.slice(base.length + 1).replace(/\\/g, '/')}/`
  }
  return root
}

/**
 * create_member 的 folder 参数 → 绝对路径（相对路径以主对话工作目录为基准，「.」= 主对话工作目录本身）。
 * 空 = 不指定文件夹（null）；主对话没挂文件夹时相对路径解析不了，也是 null（调用方报错）。
 */
export function resolveMemberFolder(folder: string, mainRoot: string | null): string | null {
  const f = folder.trim()
  if (!f) return null
  if (isAbsolute(f)) return resolve(f)
  return mainRoot ? resolve(mainRoot, f) : null
}

// ── 主对话正文 ────────────────────────────────────────────────────────────────

/** 一条真实用户消息的正文（展示层取最后一个 text 块作气泡正文，这里同口径）；不是真实用户消息则 null。 */
export function realUserText(m: Message): string | null {
  if (m.role !== 'user') return null
  if (isCompactionSummary(m) || isAutoNudge(m) || isTaskNotification(m)) return null
  if (typeof m.content === 'string') return m.content
  if (m.content.some((p) => p.type === 'tool_result')) return null
  for (let i = m.content.length - 1; i >= 0; i--) {
    const p = m.content[i]
    if (p.type === 'text') return p.text
  }
  return ''
}

function assistantText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

interface Round {
  user: string
  reply: string
}

/** 每段最多保留的字数：回复保留结尾（最终答复在后），提问保留开头。 */
const ROUND_CHARS = 1500

function clipHead(s: string): string {
  return s.length > ROUND_CHARS ? `${s.slice(0, ROUND_CHARS)}…` : s
}
function clipTail(s: string): string {
  return s.length > ROUND_CHARS ? `…${s.slice(-ROUND_CHARS)}` : s
}

/** 主对话按轮切分的正文：每轮 = 一条真实用户消息 + 其后的助手正文（不含工具调用、思考、通知）。 */
function roundsOf(messages: Message[]): Round[] {
  const out: Round[] = []
  for (const m of messages) {
    const u = realUserText(m)
    if (u !== null) {
      out.push({ user: u.trim(), reply: '' })
      continue
    }
    if (m.role !== 'assistant') continue
    const t = assistantText(m).trim()
    if (!t) continue
    if (!out.length) out.push({ user: '', reply: '' })
    const cur = out[out.length - 1]
    cur.reply = cur.reply ? `${cur.reply}\n${t}` : t
  }
  return out
}

function formatRound(r: Round, owner: string): string {
  const lines: string[] = []
  if (r.user) lines.push(`【用户】${clipHead(r.user)}`)
  if (r.reply) lines.push(`【${owner}】${clipTail(r.reply)}`)
  return lines.join('\n')
}

/**
 * 成员会话里最近一次交差的结论全文（没有则空串）：正常收尾的回复（有正文、没有工具调用），或轮中用 reply_task
 * 先交回的结论，取较晚的那次。member_status 据此给出结论全文。
 */
export function lastReplyText(memberMessages: Message[]): string {
  for (let i = memberMessages.length - 1; i >= 0; i--) {
    const m = memberMessages[i]
    if (m.role !== 'assistant') continue
    if (typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_use')) {
      // 受理了的 reply_task（结果没报错；被拒的不算交差）。
      const next = memberMessages[i + 1]
      const results = next && typeof next.content !== 'string' ? next.content : []
      for (let j = m.content.length - 1; j >= 0; j--) {
        const p = m.content[j]
        if (p.type !== 'tool_use' || p.name !== 'reply_task') continue
        const ok = results.some((r) => r.type === 'tool_result' && r.toolUseId === p.id && !r.isError)
        const c = (p.input as { conclusion?: unknown } | null)?.conclusion
        if (ok && typeof c === 'string' && c.trim()) return c.trim()
      }
      continue
    }
    const t = assistantText(m).trim()
    if (t) return t
  }
  return ''
}

/** 成员会话里用户最近一次直接说的话（不是主智能体派来的任务；没有则空串）。 */
export function lastDirectUserText(memberMessages: Message[]): string {
  for (let i = memberMessages.length - 1; i >= 0; i--) {
    const t = realUserText(memberMessages[i])
    if (t === null || t.startsWith(MEMBER_TASK_MARKER)) continue
    return t.trim()
  }
  return ''
}

/** 首次派任务时附带的主对话最近几轮正文（含当前这一轮：用户的请求与主智能体派任务前说的话）。 */
export function recentMainContext(messages: Message[], owner: string, rounds = 3): string {
  return roundsOf(messages)
    .slice(-rounds)
    .map((r) => formatRound(r, owner))
    .filter(Boolean)
    .join('\n\n')
}

/** read_main：主对话正文的一页（默认最近 PAGE_ROUNDS 轮；before = 只看第 before 轮之前的，轮号从 1 开始）。 */
const PAGE_ROUNDS = 5
export function readMainPage(messages: Message[], owner: string, before?: number): string {
  const all = roundsOf(messages)
  if (!all.length) return '主对话还没有内容。'
  const end =
    typeof before === 'number' && Number.isFinite(before)
      ? Math.max(0, Math.min(Math.floor(before) - 1, all.length))
      : all.length
  const start = Math.max(0, end - PAGE_ROUNDS)
  if (end <= 0) return '已经到主对话开头了，没有更早的内容。'
  const shown = all.slice(start, end)
  const body = shown.map((r, i) => `── 第 ${start + i + 1} 轮 ──\n${formatRound(r, owner)}`).join('\n\n')
  const tail =
    start > 0
      ? `（主对话共 ${all.length} 轮，以上是第 ${start + 1}–${end} 轮；更早的内容用 read_main 并传 before=${start + 1} 查看。）`
      : `（主对话共 ${all.length} 轮，以上已到开头。）`
  // 每轮的用户消息与回复各只给前 / 后 ROUND_CHARS 字（带「…」）：被截的要读全文，按轮号取。
  const clipped = shown.some((r) => r.user.length > ROUND_CHARS || r.reply.length > ROUND_CHARS)
  const more = clipped ? '\n（带「…」的轮被截短了：要看某一轮的全文，用 read_main 并传 round=轮号。）' : ''
  return `${body}\n\n${tail}${more}`
}

/** read_main 读一轮全文时每次给出的字数：更长的分段读，结果末尾给出下一段的 offset。 */
const ROUND_PAGE_CHARS = 8000

/** read_main 传 round：主对话第 round 轮（从 1 开始）的全文，从 offset 字起最多 ROUND_PAGE_CHARS 字。 */
export function readMainRound(messages: Message[], owner: string, round: number, offset = 0): string {
  const all = roundsOf(messages)
  const n = Math.floor(round)
  if (!all.length) return '主对话还没有内容。'
  if (!Number.isFinite(n) || n < 1 || n > all.length) return `没有第 ${round} 轮：主对话共 ${all.length} 轮（轮号从 1 开始）。`
  const r = all[n - 1]
  const full = [r.user && `【用户】${r.user}`, r.reply && `【${owner}】${r.reply}`].filter(Boolean).join('\n')
  const from = Math.max(0, Math.min(Math.floor(offset) || 0, full.length))
  const to = Math.min(full.length, from + ROUND_PAGE_CHARS)
  const head = `── 第 ${n} 轮${from > 0 ? `（接第 ${from} 字）` : ''} ──`
  const tail =
    to < full.length
      ? `（第 ${n} 轮共 ${full.length} 字，以上是第 ${from + 1}–${to} 字；接着读用 read_main 并传 round=${n}、offset=${to}。）`
      : `（第 ${n} 轮共 ${full.length} 字，已读完。）`
  return `${head}\n${full.slice(from, to)}\n\n${tail}`
}

// ── 任务消息 ──────────────────────────────────────────────────────────────────

/** 旧版任务消息附带的用户原话段（现在不再附，只为解析旧记录保留）。 */
const QUOTE_HEAD = '【用户原话】'
const NOTE_HEAD = '【任务说明】'
const CONTEXT_HEAD = '【主对话最近几轮】（供参考；更早的内容可用 read_main 查看）'
/** 插进成员当前工作的任务附带的说明（只给模型看，成员工作记录里不显示）。 */
const INSERT_HEAD = '【插入说明】'
const INSERT_NOTE =
  `${INSERT_HEAD}这项任务是在你做别的任务时插进来的。它与手上的任务无关、能单独先做完时，做完先用 reply_task 交回它的结论，` +
  '再接着做原来的任务；它是对当前任务的补充说明或修改意见时，合在一起做，最后在最终回复里一并交代。'
/** 任务说明段的标题（旧版叫「X的附注」）。 */
const NOTE_RE = /^【(?:.+的附注|任务说明)】$/
const TITLE_RE = /^【(.+)派来的任务】(.*)$/

/**
 * 派给成员的任务消息正文（成员会话里的一条 user 消息）：标题 + 主智能体写的任务说明（+ 首次派发时主对话最近几轮）。
 * 不附用户原话：任务由主智能体理解后派发，说明里写完整。inserted = 成员正忙、这条插进它当前的工作：末尾附插入说明。
 */
export function buildTaskMessage(p: {
  owner: string
  task: string
  note: string
  context: string
  inserted?: boolean
}): string {
  const lines = [`${MEMBER_TASK_MARKER}【${p.owner}派来的任务】${p.task}`]
  if (p.note) lines.push('', NOTE_HEAD, p.note)
  if (p.context) lines.push('', CONTEXT_HEAD, p.context)
  if (p.inserted) lines.push('', INSERT_NOTE)
  return lines.join('\n')
}

export interface ParsedTask {
  owner: string
  task: string
  quote: string
  note: string
}

/** 解析任务消息（不是任务消息则 null）：成员工作记录据此画「X 派来的任务」。 */
export function parseTaskMessage(text: string): ParsedTask | null {
  if (!text.startsWith(MEMBER_TASK_MARKER)) return null
  const lines = text.slice(MEMBER_TASK_MARKER.length).split('\n')
  const head = TITLE_RE.exec(lines[0] ?? '')
  const out: ParsedTask = { owner: head?.[1] ?? '', task: (head?.[2] ?? '').trim(), quote: '', note: '' }
  let section: 'quote' | 'note' | 'context' | null = null
  const buf: Record<'quote' | 'note', string[]> = { quote: [], note: [] }
  for (const line of lines.slice(1)) {
    if (line.startsWith(QUOTE_HEAD)) section = 'quote'
    else if (NOTE_RE.test(line)) section = 'note'
    else if (line === CONTEXT_HEAD || line.startsWith(INSERT_HEAD)) section = 'context'
    else if (section === 'quote' || section === 'note') buf[section].push(line)
  }
  out.quote = buf.quote.join('\n').trim()
  out.note = buf.note.join('\n').trim()
  return out
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

/** 主对话（主智能体）的成员工具名。 */
export const MAIN_MEMBER_TOOLS = new Set(['create_member', 'member_send', 'member_stop', 'member_status'])
/** 成员会话的成员工具名。 */
export const MEMBER_SIDE_TOOLS = new Set(['read_main', 'report_to_main', 'reply_task'])

/**
 * 按需加载的成员工具（见 tool-search.ts）：没有成员的对话用不上，工具表里只留这句话与参数骨架；有成员时用法随
 * 成员名单附上（见 chat.ts），模型用到时已看过完整说明。create_member 不按需加载（「默认不建成员」须在决定前看到），
 * member_stop 本身就短。
 */
export const DEFERRED_MEMBER_TOOLS: Record<string, string> = {
  member_send: '把任务（或对上次结果的修改意见）交给一个项目成员，成员在后台完成。',
  member_status: '查看项目成员的当前状态与最近一次结论。'
}

/**
 * 主智能体的成员工具：创建、派任务、中止、查状态。描述写死（名单随消息下发），工具表稳定，提示缓存不受增减成员影响。
 * 这里是完整定义；进工具表前按 DEFERRED_MEMBER_TOOLS 换成按需加载的版本（见 chat.ts）。
 */
export function mainMemberTools(): ToolSpec[] {
  return [
    {
      name: 'create_member',
      description:
        `创建一个项目成员：成员在自己的独立会话里、以默认角色 Deva 的设定工作，长期负责项目里的一块（通常是一个文件夹），由你用 member_send 派任务。默认不建成员：同一个项目分几块的工作，你自己做，或用 run_subagent 分头并行。只有同时满足两点才使用：① 这块工作和其他部分差别大——在不同的目录或仓库、技术栈不同，或是不同的工作场景（如部署、测试、功能开发）；② 这块工作在本对话里会持续、反复地做（多轮修改、反复验证），值得保留它自己的上下文。一次性的任务即使跨了几块，也用 run_subagent；调研、小事不建成员。用户明确要求时照做。你为分工建过成员后（你是管理者），与现有成员都不相关的新项目或工作块，直接新建成员负责，不受第②点限制；用户 @ 请来的协助者不算分工，不改变这条。建之前先了解项目结构，一块一个成员。成员最多 ${MAX_MEMBERS} 个；现有成员见系统随消息附带的【成员名单】。用户在消息里 @ 一个角色时，系统会自动把它加为成员，无需调用本工具。`,
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '成员名，按职责起，2～6 个字，如「前端」「后端」「部署」。同一对话内不能重名。'
          },
          folder: {
            type: 'string',
            description:
              '它负责的文件夹：相对当前工作目录的路径（如 web；整个当前工作目录写 .）或绝对路径。省略表示不指定文件夹（成员没有工作目录，用户之后可以在成员的对话里为它选）。'
          },
          pick_folder: {
            type: 'boolean',
            description:
              '不知道它负责的文件夹在哪（不在当前工作目录下，用户也没给路径）时设为 true：系统会在对话里请用户点选文件夹，不要用文字问路径。'
          },
          duty: { type: 'string', description: '一句话职责，如「负责前端，React + Vite」。' }
        },
        required: ['name', 'duty']
      }
    },
    {
      name: 'member_send',
      description:
        '把任务交给一个成员，成员在后台工作。成员负责的文件夹里的工作（读代码、排查、验证、修改、跑构建）都交给它，不要自己先查一遍再派。' +
        '成员看不到你和用户的对话（只有第一次派任务时附上主对话最近几轮，之后它需要时自己用 read_main 翻），所以在 message 里把任务写完整：要做什么、范围（哪些模块 / 文件）、已知的事实（需求单内容、报错原文、截图位置等原样附上）、约束（如只查不改）和怎样算完成。忠实于用户的要求，不擅自扩大范围。' +
        '成员工作中需要用户回答或批准时，会直接向用户提问、提交计划，不经过你。成员完成后会以自己的身份（头像和名字）在对话里直接回复用户（不经过你、不唤醒你），你的历史里也会有这条，不必再转述；成员出错时用户看不到，系统会唤醒你处理。' +
        '需要你接着处理结果时（要据此安排下一步、要把几个成员的结果合起来、或用户要你汇总），把 report_to_me 设为 true：成员完成后会唤醒你处理；同一轮里派出的几项都设了 true 时，等最后一个完成才一起唤醒你。成员发现要你处理时（如要用它没有的工具），也会自己把结论交给你并唤醒你。' +
        '成员没有创建角色、技能、MCP、定时任务和呈交文件的工具，这些事你自己做，不要派给成员；用户点名要成员做也一样，由你来做并简短说明。' +
        '派出后不要等待、轮询或猜测它的结果，可以接着派其他成员、做别的事，或先简短回复用户。多个成员可以同时工作。对成员上一次结果的修改意见也用它转交。成员正在忙时，这条会插入它当前的工作。',
      inputSchema: {
        type: 'object',
        properties: {
          member: { type: 'string', description: '成员名（见【成员名单】）。' },
          task: { type: 'string', description: '任务标题，10 个字左右，会显示在界面上。' },
          message: {
            type: 'string',
            description: '任务说明：要做什么、范围、已知事实（原样附上需求单 / 报错等）、约束和完成标准。成员只看得到这段（与标题），写完整。'
          },
          report_to_me: {
            type: 'boolean',
            description:
              '成员完成后是否唤醒你处理结果（默认 false：成员以自己的身份直接回复用户）。要据此安排下一步、要合并几个成员的结果、或用户要你汇总时设为 true。'
          }
        },
        required: ['member', 'task', 'message']
      }
    },
    {
      name: 'member_stop',
      description: '中止一个成员当前的任务。只在用户要求停下，或这项任务已不再需要时使用。',
      inputSchema: {
        type: 'object',
        properties: { member: { type: 'string', description: '成员名。' } },
        required: ['member']
      }
    },
    {
      name: 'member_status',
      description:
        '查看成员的当前状态与最近一次结论：谁在工作（正在做什么、已用多久）、谁在等用户回答或批准、最近一次交差的结论全文。' +
        '用户问进展、要你汇总各成员的情况，或较早的交差内容已被压缩成摘要时使用。不要为了等结果反复调用：成员完成后系统会转告。',
      inputSchema: {
        type: 'object',
        properties: { member: { type: 'string', description: '可选：只看这个成员；省略则看全部成员。' } }
      }
    }
  ]
}

/** 成员会话的 read_main 工具：往前翻主对话的正文。 */
export function readMainTool(): ToolSpec {
  return {
    name: 'read_main',
    description:
      '往前翻主对话（用户与主 Agent 的对话）的正文：用户的消息和主 Agent 的回复（含其他成员的交差），不含工具调用与思考过程。' +
      '不传参数时返回最近几轮，每轮较长的内容会截短（带「…」）；传 before 往前翻页；传 round 读某一轮的全文（很长时分段，结果末尾给出下一段的 offset）。',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'number', description: '只看第 before 轮之前的内容（轮号从 1 开始，见上一次结果末尾的提示）。' },
        round: { type: 'number', description: '读第 round 轮的全文（轮号见翻页结果里的「第 N 轮」）。' },
        offset: { type: 'number', description: '与 round 一起用：从第 offset 字接着读（见上一次结果末尾的提示）。' }
      }
    }
  }
}

/**
 * 成员会话的 report_to_main 工具：本轮的结论交给主智能体处理（唤醒它），不以成员的身份直接回复用户。
 * 成员自己判断：要做的事得用它没有的工具（创建角色 / 技能 / MCP / 定时任务、呈交文件），或要别的成员配合、要主智能体
 * 据此安排下一步。效果在本轮结束时生效（见 chat-members.ts reportMemberTurn），最终回复照常写，作为交给主智能体的结论。
 */
export function reportToMainTool(): ToolSpec {
  return {
    name: 'report_to_main',
    description:
      '本轮结束时，把你的结论交给主 Agent 处理（会唤醒它），而不是以你的身份直接回复用户。以下情况使用：' +
      '① 要做的事需要你没有的工具——创建角色、技能、MCP 或定时任务，把文件呈交给用户，这些只有主 Agent 能做；' +
      '② 需要别的成员配合（改不归你负责的部分）；③ 你的结果需要主 Agent 据此安排下一步。' +
      '调用后照常写完最终回复，它会作为结论交给主 Agent：写清要它做什么，并原样附上它需要的材料（如角色草案全文）——主 Agent 看不到你的工具调用和结果。' +
      '自己能做完的事不要用它；一轮只需调用一次。',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '一句话说明要主 Agent 做什么（20 字以内），会显示在主对话里，如「用草案生成角色名片」「请后端改接口返回格式」。'
        }
      },
      required: ['reason']
    }
  }
}

/**
 * 成员会话的 reply_task 工具：不等本轮结束，先交回其中一项派来的任务的结论（成员正忙时插进来、与手上的任务无关的
 * 那项）。交差方式与本轮结束时相同：以成员的身份回复用户，派任务时要了 report_to_me 的交给主智能体处理（见
 * chat-members.ts replyTask）。补充说明一类的插入不用它，合进最终回复一并交代。
 */
export function replyTaskTool(): ToolSpec {
  return {
    name: 'reply_task',
    description:
      '先交回一项派来的任务的结论，不等本轮结束。只在手上同时有几项派来的任务（工作中又插进来新任务）、其中一项与其余的无关且已经做完时使用：' +
      '结论马上交回（按派发的要求，以你的身份回复用户或交给主 Agent），你接着做其余的任务。' +
      '插进来的是对当前任务的补充说明、修改意见或与它相关的事时不要用它，合在一起做，最后在最终回复里一并交代。' +
      '只剩一项任务时不要用它，直接写最终回复。每项任务只交一次：交过的，最终回复里不要再重复它的结论。',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要交回的任务标题：任务消息开头「【…派来的任务】」后面的标题，原样填写。'
        },
        conclusion: {
          type: 'string',
          description:
            '这项任务的结论，按最终回复的要求写（直接写结果，写明做了什么、验证情况、遗留问题），会原样交给用户或主 Agent——他们看不到你的工具调用和结果。'
        }
      },
      required: ['task', 'conclusion']
    }
  }
}
