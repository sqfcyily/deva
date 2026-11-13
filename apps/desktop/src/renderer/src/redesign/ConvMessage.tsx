/**
 * 对话流里的单条消息：用户正文（引用、@提及）与助手回复。
 */
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Bot } from 'lucide-react'
import { AttachmentList } from './attachments'
import type { Persona } from '../mock/extensions'
import { Markdown } from '../features/chat/Markdown'
import {
  type ChatBlock,
  type ChatMessage
} from '../store/chat'
import { mentionRanges } from '../../../shared/mention'
import { isQuoteLine } from '../../../shared/quote'
import { useI18n } from '../i18n/i18n'
import {
  BlockView,
  CompactionNotice,
  DeliveryCards,
  LiveThinkingWindow,
  ProcessFold,
  Timeline,
  currentSteps,
  groupBlocks,
  splitProcess
} from '../features/chat/blocks'
import { fill, Avatar } from './shell-common'
import { TaskSpeakerFace, HandoffNotice } from './TaskBar'

/** 用户消息文本默认最多显示的行数，超出即折叠。 */
const USER_TEXT_LINES = 3

/** 主对话里用户消息的 @ 成员标签（见 MentionText）：会生效的名字与其头像。成员对话里不提供。 */
export interface MentionLookup {
  names: readonly string[]
  face: (name: string) => string | null
}

export const MentionContext = createContext<MentionLookup | null>(null)

/**
 * 一段用户文字：会生效的 `@名字` 画成成员标签（头像 + 名字，不写 @；同输入框里的 MentionNode），其余原样。
 * @ 保留成零宽字放在标签里，复制出来仍是「@名字」。
 */
function MentionText({ text }: { text: string }): React.ReactNode {
  const lookup = useContext(MentionContext)
  if (!lookup || !text.includes('@')) return text
  const ranges = mentionRanges(text, lookup.names)
  if (!ranges.length) return text
  const out: React.ReactNode[] = []
  let at = 0
  ranges.forEach((r, i) => {
    if (r.start > at) out.push(text.slice(at, r.start))
    const name = text.slice(r.start + 1, r.end)
    const face = lookup.face(name)
    out.push(
      <span key={i} className="cf-mention">
        <span className="cf-mention__at">@</span>
        {face && <img className="cf-mention__face" src={face} alt="" draggable={false} />}
        {name}
      </span>
    )
    at = r.end
  })
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

/** 用户消息开头引用的折叠行数：比正文少，免得引用把真正的问题挤到「展开」后面。 */
const USER_QUOTE_LINES = 2

/**
 * 聊天区右键「引用」：把选区转成 Markdown 引用（每行加 `> `）。选区两端落在同一个代码块里时先包成带语言的代码块，
 * 保住缩进；其余按显示出来的文字（去掉行尾空白、连续空行并成一个）。
 */
export function quoteOf(sel: Selection | null): string {
  if (!sel || sel.isCollapsed) return ''
  const elOf = (n: Node | null): Element | null => (n instanceof Element ? n : (n?.parentElement ?? null))
  let text = sel.toString().replace(/\r\n?/g, '\n')
  const code = elOf(sel.anchorNode)?.closest('.md-code')
  if (code && code === elOf(sel.focusNode)?.closest('.md-code')) {
    text = text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
    if (!text) return ''
    const lang = /language-([\w-]+)/.exec(code.querySelector('code')?.className ?? '')?.[1] ?? ''
    text = '```' + lang + '\n' + text + '\n```'
  } else {
    text = text.trim().replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    if (!text) return ''
  }
  return text
    .split('\n')
    .map((l) => (l ? '> ' + l : '>'))
    .join('\n')
}

/** 用户消息按引用切开的一段：quote=true 是引用（已去掉 `> ` 前缀与代码围栏行），否则是正文原文。 */
type UserTextSeg = { quote: boolean; text: string }

/**
 * 把用户消息按引用切段：以 `>` 开头的连续行是一段引用（几段引用之间隔空行也并成一段），其余是正文。
 * 引用里的空行并掉（折叠时两行都给内容）。没有引用返回 null（照原文显示）。
 */
export function splitQuotes(text: string): UserTextSeg[] | null {
  if (!/^ {0,3}>/m.test(text)) return null
  const lines = text.split('\n')
  const segs: UserTextSeg[] = []
  let i = 0
  while (i < lines.length) {
    const start = i
    if (isQuoteLine(lines[i])) {
      let end = i
      for (let j = i; j < lines.length; j++) {
        if (isQuoteLine(lines[j])) end = j
        else if (lines[j].trim()) break
      }
      i = end + 1
      const body = lines
        .slice(start, i)
        .map((l) => l.replace(/^ {0,3}> ?/, ''))
        .filter((l) => !/^\s*```/.test(l))
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        // 只去首尾空行，保住代码的行首缩进
        .replace(/^\n+/, '')
        .replace(/\s+$/, '')
      if (body.trim()) segs.push({ quote: true, text: body })
    } else {
      while (i < lines.length && !isQuoteLine(lines[i])) i++
      const body = lines
        .slice(start, i)
        .join('\n')
        .replace(/^(?:[ \t]*\n)+/, '')
        .replace(/\s+$/, '')
      if (body) segs.push({ quote: false, text: body })
    }
  }
  return segs.some((s) => s.quote) ? segs : null
}

/**
 * 拆出开头的引用（保留 `> ` 格式）：发送失败放回、撤回插入、回滚填回时，把它放回输入框顶部的引用条。
 * 开头不是引用返回 null。
 */
export function leadingQuote(text: string): { quote: string; rest: string } | null {
  const lines = text.split('\n')
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteLine(lines[i])) end = i
    else if (lines[i].trim()) break
  }
  if (end < 0) return null
  return {
    quote: lines.slice(0, end + 1).join('\n').trim(),
    rest: lines
      .slice(end + 1)
      .join('\n')
      .replace(/^(?:[ \t]*\n)+/, '')
      .replace(/\s+$/, '')
  }
}

/** 引用条与正文拼成要发的消息：引用在前、空一行接正文；没写正文就只发引用。 */
export function withQuote(quote: string, text: string): string {
  if (!quote) return text
  return text.trim() ? `${quote}\n\n${text}` : quote
}

/** 引用的纯文字（去掉 `> ` 与代码围栏行）：full=false 时空白并成一个空格，给引用条与草稿预览显示一行。 */
export function quotePlain(quote: string, full = false): string {
  const text = splitQuotes(quote)?.find((s) => s.quote)?.text ?? quote
  return full ? text : text.replace(/\s+/g, ' ').trim()
}

/**
 * 用户消息正文：默认折叠到 {@link USER_TEXT_LINES} 行，超出时给出展开/收起按钮。
 * 折叠靠 CSS line-clamp，是否溢出则须实测——文本换行取决于主区宽度，无法静态判断。
 * clamp 落在内层 .cf-msg__clamp（无内边距），气泡 padding 留在外层 .cf-msg__text。
 * 有引用（右键「引用」带进来的 `> ` 段）时按引用切段：引用单独成块（竖线 + 弱化字色，折叠到
 * {@link USER_QUOTE_LINES} 行），正文各段照常折叠；任一段超出都给展开按钮，一起展开。
 */
function UserText({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n()
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  const segs = useMemo<UserTextSeg[]>(() => splitQuotes(text) ?? [{ quote: false, text }], [text])

  // 只在收起态测量：此时 clientHeight 是折叠后的高度、scrollHeight 是全文高度，二者不等即超出。
  // 展开态两者必然相等，故直接跳过、沿用上次判定，否则按钮会自己消失。
  useLayoutEffect(() => {
    if (expanded) return
    const els = refs.current.slice(0, segs.length).filter((el): el is HTMLDivElement => el !== null)
    if (!els.length) return
    const measure = (): void => setOverflow(els.some((el) => el.scrollHeight - el.clientHeight > 1))
    measure()
    // 侧栏折叠、窗口缩放都会改变换行，需要重新判定。
    const ro = new ResizeObserver(measure)
    els.forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [segs, expanded])

  return (
    <>
      <div className="cf-msg__text">
        {/* 折叠盒必须无内边距：气泡的下内边距会让被截断的下一行漏出「半个字」，详见 CSS 注释。 */}
        {segs.map((s, i) => (
          <div
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            className={`${s.quote ? 'cf-msg__quote' : 'cf-msg__clamp'}${expanded ? '' : ' is-clamped'}`}
            style={{ '--clamp-lines': String(s.quote ? USER_QUOTE_LINES : USER_TEXT_LINES) } as React.CSSProperties}
          >
            {s.quote ? s.text : <MentionText text={s.text} />}
          </div>
        ))}
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

/** 成员交差回复的标题行（见 Conversation reportOf）。 */
export interface MemberReportHead {
  /** 「前端已完成：任务」。 */
  headline: string
  /** 交差的成员（按标题开头的名字认出；认不出时只写标题）。 */
  persona?: Persona
  /** 绑定的定时任务告知的那条：任务名（以任务的身份画，闹钟头像）。 */
  task?: string
}

/** 去掉回复开头的标题行（单独画成带头像的一行）；剩下的是成员的结论原文。 */
export function withoutHeadline(m: ChatMessage, headline: string): ChatMessage {
  const [first, ...rest] = m.blocks
  if (first?.kind !== 'text') return m
  const text = first.text.slice(headline.length).replace(/^\s+/, '')
  return { ...m, blocks: text ? [{ ...first, text }, ...rest] : rest }
}

/** 对话里成员名前的小头像：执行步骤里的派任务、建成员等（见 blocks.tsx MemberFaceContext），以及交差回复的标题行。 */
export function MemberInlineFace({ persona }: { persona: Persona }): React.JSX.Element {
  return (
    <span className="cf-inface" aria-hidden="true">
      <Avatar persona={persona} plain compact />
    </span>
  )
}

/** 单条消息：IM 头像外壳 + 复用 features/chat/blocks 的 BlockView（安全渲染器不重写）。 */
/**
 * 单条消息。包 memo：流式输出时只有末条在变，前面的消息 props 不变就不重渲染
 * （msg 未变的消息对象引用不变，见 store/chat.tsx updateLastAssistant）。
 */
export const ConvMessage = memo(function ConvMessage({
  msg,
  report,
  owner,
  taskSpeaker,
  taskPersona,
  taskOwner,
  active,
  latest,
  elapsedSec,
  footer,
  dataTurn,
  sessionId,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask
}: {
  msg: ChatMessage
  /** 成员交差的回复：标题行（「前端已完成：任务」）单独画、前面带成员的小头像（msg 里已去掉这一行）。 */
  report?: MemberReportHead
  owner?: Persona
  /** 绑定的定时任务告知的那条：以任务的身份画（taskPersona 的头像 + 定时任务角标 + 任务名），不用 owner。 */
  taskSpeaker?: string
  /** 定时任务所用的角色（见 TaskSpeakerFace）。 */
  taskPersona?: Persona
  /** 成员对话里派任务的主对话角色：主智能体派来的任务画成它说的话。 */
  taskOwner?: Persona
  active: boolean
  /** 是否为对话里最后一条消息（进行中撑住的高度在它不再是最后一条时释放）。 */
  latest: boolean
  /** 本轮已用秒数（进行中的折叠条标题末尾显示；只对 active 的消息有意义）。 */
  elapsedSec: number
  /** 接在消息内容末尾的底部状态行（只交给进行中的那条：已有折叠条时是等待作答 / 重连 / 压缩，还没内容时是思考中）。 */
  footer?: React.ReactNode
  /** 该消息所属的对话轮下标（0 基）；标注在根节点上，供右键菜单定位「删除此轮」。前言/未知为 undefined。 */
  dataTurn?: number
  /** 消息所在的对话：附件图片按它向主进程取缩略图 / 原图。 */
  sessionId: string
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
  // 成员交差的通知：不显示（其后主角色的回复就是交差内容），只留一个不占高度的锚点——它仍是一轮的起点，
  // 跳转定位 / 右键删轮都靠 is-user + data-turn。
  if (msg.role === 'user' && msg.notify && msg.quiet)
    return <div className="cf-msg is-user is-quiet" data-turn={dataTurn} aria-hidden="true" />
  // 绑定的定时任务交来要处理的结果：居中一行「任务名 摘要」，点开看全文；其后是主角色的回复（对比稿 M2）。
  if (msg.role === 'user' && msg.notify && msg.handoff)
    return (
      <div className="cf-msg is-user is-notify" data-turn={dataTurn}>
        <HandoffNotice handoff={msg.handoff} />
      </div>
    )
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
  // 两轮之间的压缩提示：分隔线 + 一行居中提示 + 折叠的摘要，不画头像与角色名——那不是角色说的话。
  const only = msg.blocks.length === 1 ? msg.blocks[0] : undefined
  if (msg.role === 'assistant' && only?.kind === 'compaction' && only.steps === undefined) {
    return (
      <div className="cf-msg is-compaction" data-turn={dataTurn}>
        <CompactionNotice summary={only.summary} first={only.first} />
      </div>
    )
  }
  // 成员对话：主智能体派来的任务。画成主角色说的话（左侧头像），正文是它写的任务说明（旧记录另有「你的原话」）；仍是一轮的起点。
  if (msg.role === 'user' && msg.task) {
    const task = msg.task
    const from = taskOwner?.name ?? task.owner
    return (
      <div className="cf-msg is-task" data-turn={dataTurn}>
        <Avatar persona={taskOwner} size={32} />
        <div className="cf-msg__body">
          <div className="cf-msg__head">
            <span className="cf-msg__name">{from}</span>
            <span className="cf-msg__meta">
              {t('cf.member.taskFrom')}
              {task.title ? ` · ${task.title}` : ''}
            </span>
          </div>
          {/* 现在的任务只有主角色写的说明：直接作正文。旧记录还带「你的原话」，照旧分两段。 */}
          {!task.quote && task.note && (
            <div className="msg__text">
              <Markdown text={task.note} />
            </div>
          )}
          {task.quote && (
            <div className="cf-brief">
              {task.quote && (
                <>
                  <span className="cf-brief__k">{t('cf.member.quote')}</span>
                  <div className="cf-brief__quote">
                    <UserText text={task.quote} />
                  </div>
                </>
              )}
              {task.note && (
                <>
                  <span className="cf-brief__k">{fill(t('cf.member.note'), { owner: from })}</span>
                  <div className="cf-brief__note">
                    <UserText text={task.note} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (msg.role === 'user') {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user" data-turn={dataTurn}>
        <div className="cf-msg__body">
          {msg.attachments && msg.attachments.length > 0 && (
            <AttachmentList
              variant="sent"
              entries={msg.attachments.map((a, i) => ({
                id: String(i),
                name: a.name,
                kind: a.kind,
                size: a.size,
                title: a.path ?? a.name,
                // 重载的记录按 ref 取图；刚发出、还没重载的按发送时的本地路径。
                src:
                  a.kind !== 'image'
                    ? undefined
                    : a.ref
                      ? { sessionId, ref: a.ref }
                      : a.file
                        ? { path: a.file }
                        : undefined
              }))}
            />
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
  const name = <span className="cf-msg__name">{taskSpeaker ?? owner?.name ?? t('cf.assistant')}</span>
  return (
    <div className="cf-msg" data-turn={dataTurn}>
      {taskSpeaker ? <TaskSpeakerFace persona={taskPersona} size={32} /> : <Avatar persona={owner} size={32} />}
      <div className="cf-msg__body">
        {!split && <div className="cf-msg__head">{name}</div>}
        <div
          className="msg__content"
          ref={contentRef}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('button')) releasePeak()
          }}
        >
          {report && (
            <div className="cf-mreport">
              {report.persona && <MemberInlineFace persona={report.persona} />}
              {report.headline}
            </div>
          )}
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
})
