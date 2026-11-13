/**
 * agent 循环：调模型、执行工具、回灌结果，直到模型收尾；中途的提问 / 计划审阅 / 挂载请求在这里等用户回应。
 */
import type { AskQuestion, ChatModelConfig } from '../../shared/chat-protocol'
import { randomUUID } from 'node:crypto'
import { streamChat } from '../providers'
import {
  type BrokenCallCause,
  type ContentPart,
  type EffortLevel,
  type Message,
  type StopReason,
  type ToolSpec
} from '../providers/types'
import { OUTPUT_BUDGET_SAFE, OUTPUT_BUDGET_WIDE, type ContextOverflow } from '../../shared/context'
import { REPEAT_STOP, REPEAT_WARN } from '../../shared/limits'
import {
  executeTool,
  isMcpTool,
  needsWorkspaceMount,
  toolCategory,
  type ToolContext,
  type ToolResult
} from './tools'
import { enabledSkillSummaries, loadSkillInstructionsByName } from './skills'
import {
  attachListing,
  memberListingPart,
  memoryListingPart,
  skillListingPart,
  type MemberListingItem
} from './listing'
import {
  TOOL_SEARCH,
  USAGE_SUMMARY,
  runToolSearch,
  searchedNames,
  skillToolUsages,
  unknownUsages,
  usageGateResult,
  usageListingPart
} from './tool-search'
import { DEFERRED_MEMBER_TOOLS, MAIN_MEMBER_TOOLS, MEMBER_SIDE_TOOLS } from './members'
import {
  PARALLEL_READ_TOOLS,
  SUBAGENT_EXCLUDED
} from './tool-catalog'
import { loadProjectDoc } from './project-doc'
import {
  GENERAL_SUBAGENT,
  FORK_AGENT,
  getSubagentByName,
  isForkAgent,
  subagentSummaries
} from './subagents'
import {
  getSubagentMeta,
  isSubagentBusy,
  loadSubagent,
  newSubagentId,
  pruneSubagents,
  removeSessionSubagents,
  saveSubagent,
  setSubagentBusy,
  type SubagentRecord
} from './subagent-store'
import {
  modelOverrides
} from './model-resolve'
import { sealedDecision } from './sealed'
import { HANDOFF_TOOL, stubLongInforms } from './handoff'
import { dispatchMcpTool } from './mcp'
import {
  getSession
} from './chat-store'
import { trimHistoryImages } from './image-trim'
import { isEn } from '../locale'
import {
  markBrowserTurnEnded
} from './browser'
import { type Recorder, type WriteSnap } from './checkpoints'
import {
  compactionWorthRetry,
  insertText,
  modelMessages,
  needsCompactionMidTurn,
  rememberContextLimit,
  rememberOutputBudget
} from './compaction'
import { trailingRepetition, watchRepetition } from './repetition'
import { parseAskQuestions } from './ask-questions'
import { DANGLING_RESULT, turnToolIds } from './chat-history'
import {
  MAX_RECONNECT,
  RECONNECT_MAX_DELAY_MS,
  outputBudgetRejected,
  wantedOutputBudget,
  outputBudgetKey,
  outputBudget,
  effortRejected,
  effortKey,
  sentEffort,
  truncatedNudge,
  stepLimitNudge,
  repeatReminder,
  repeatStopNudge,
  degenerateMessage,
  callFingerprint,
  EMPTY_NUDGE,
  MAX_TRUNCATED_STREAK,
  truncatedCallInput,
  BROKEN_CALL_LABEL,
  truncatedCallResult,
  delay
} from './loop-support'
import {
  type PlanVerdict,
  pendingAsk,
  pendingPlan,
  pendingMount,
  timedWait,
  type BackgroundSubagent,
  backgroundSubagents,
  shuttingDown,
  genId,
  emit,
  remoteTurns,
  notifyPending
} from './chat-state'
import { plainTaskText, subagentDisplayArgs } from './chat-display'
import { buildSubagentTools, skillDirNote, CHANGE_REPORT_RULE, buildSubagentSystem } from './chat-prompts'
import { bgGroupsWaiting, setBackgroundState, enqueueNotice } from './background-tasks'
import { type MemberToolResult, setMemberFolder } from './chat-members'

/**
 * 已明确拒绝过挂载的会话（内存态，随重启清空）。会话级去重：用户点过一次「暂不挂载」后，
 * 同会话后续同类调用只回灌文案、绝不再弹卡——否则一个多步循环会连弹好几张，比不提示还烦。
 * 用户之后若自己在输入框上方挂载了工作区，判据（root 非空）本就不再命中，无需清除此标记。
 */
const mountDeclined = new Set<string>()

/**
 * fork 的起始历史：主对话历史的浅拷贝（消息对象按不可变对待、与主对话共享）+ 一条合成的回灌消息。
 * 派发时主历史的末条是本步含全部 tool_use 的 assistant 消息，协议要求每个 tool_use 紧跟结果：本次 fork
 * 调用自身与同一步的其它调用各补一条说明性结果（tool_result 排在最前），再接分身的任务指令。
 */
export function buildForkHistory(history: Message[], forkCallId: string, prompt: string): Message[] {
  const out = [...history]
  const last = out[out.length - 1]
  const uses =
    last && last.role === 'assistant' && typeof last.content !== 'string'
      ? last.content.filter((p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use')
      : []
  const results: ContentPart[] = uses.map((u) => ({
    type: 'tool_result',
    toolUseId: u.id,
    content:
      u.id === forkCallId
        ? '（已派生分身，任务见下。）'
        : '（这是同一步里的其他调用，由主智能体处理，结果你看不到。）'
  }))
  out.push({
    role: 'user',
    content: [
      ...results,
      {
        type: 'text',
        text:
          '你是主智能体派生出的分身（fork），上面是你们共享的全部对话。现在只专注完成下面这项子任务：' +
          '直接动手，不要再派发子智能体，也不要向用户提问；完成后给出简洁的结论，作为交回主智能体的答复。' +
          CHANGE_REPORT_RULE +
          '\n\n任务：' +
          prompt
      }
    ]
  })
  return out
}

/** 子智能体历史末尾若是没等到结果的 tool_use（运行中途出错），补占位结果，续聊时协议才完整。 */
function closeDanglingTail(messages: Message[]): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return
  const uses = last.content.filter((p) => p.type === 'tool_use')
  if (uses.length === 0) return
  messages.push({
    role: 'user',
    content: uses.map((u) => ({
      type: 'tool_result' as const,
      toolUseId: (u as Extract<ContentPart, { type: 'tool_use' }>).id,
      content: DANGLING_RESULT,
      isError: true
    }))
  })
}

/** runAgentLoop 的入参：主轮与子智能体共用同一套编排逻辑，仅参数不同。 */
interface AgentLoopArgs {
  turnId: string
  sessionId: string
  /** 对话历史（原地追加 assistant / tool_result）。 */
  history: Message[]
  /** 系统提示词（本轮定格，逐步复用同一字符串）。 */
  system: string
  /** 本轮可用工具表（内置 + 动态 skill / MCP / run_subagent）。 */
  tools: ToolSpec[]
  /**
   * 本对话的角色（未绑定 = 默认角色）：技能清单、skill 工具与新派子智能体的 MCP 工具表都只取对该角色开放的
   * （见 ext-roles.ts）。子智能体跟随父轮。
   */
  personaId: string
  /** 模型配置（adapter / provider / baseURL / model）。 */
  model: ChatModelConfig
  /** 思考等级（缺省 = 'default'，不发思考参数）。子智能体跟随父轮。 */
  effort?: EffortLevel
  /** 工具执行上下文（workspaceRoot + 取消信号）。 */
  ctx: ToolContext
  /** 取消控制器：其 signal 贯穿流式与工具执行。 */
  controller: AbortController
  /**
   * 步数上限（缺省 = 不设上限）。只有定时任务传（TASK_MAX_STEPS）：走满这么多步后再给一次收尾请求——
   * 注入 stepLimitNudge、本步的工具调用一律不执行，随即以 'step_limit' 结束。
   */
  maxSteps?: number
  /** 递归深度：0=主轮，1=子智能体（限制再派生；Phase 4 用）。 */
  depth: number
  /**
   * 是否交互式执行。true=常规对话（走权限闸门，可弹确认 / ask_user / exit_plan）；
   * false=定时任务密封无头执行（改走 sealedDecision 纯策略，全程零弹窗、绝不挂起）。
   * 既有调用方一律传 true；仅 runScheduledTurn 传 false。
   */
  interactive: boolean
  /** 是否允许 ask_user 单选问询（主轮 true；子轮 false）。 */
  allowAskUser: boolean
  /** 是否允许派生子智能体（主轮 true；子轮 false，杜绝子派生子；Phase 4 用）。 */
  allowSubagents: boolean
  /** 子智能体显示名（depth>0 时随事件下发，供渲染层折叠 Task 卡；主轮 undefined）。 */
  agentName?: string
  /**
   * 派生本子智能体的那次 run_subagent 调用 id（depth>0 时随事件下发）。
   * 渲染层据此把嵌套事件归入**正确的那张** Task 卡——并行派发时这是唯一可靠依据。
   */
  parentToolId?: string
  /**
   * 后台运行的子智能体（见 runAgentLoop 的 runsInBackground）：其事件盖上 bg 戳、以空 turnId 发出——它不属于任何回合，
   * 渲染层据此按 parent 在全部消息里找那张 Task 卡，而不是拼进当前流式的那条气泡。
   */
  background?: boolean
  /**
   * 取走本会话待投递的后台任务通知（见 pendingNotices）：每步工具结果回灌前调用，有则作为一段文本附在
   * 工具结果之后，模型下一步即可看到。仅主轮传入。
   */
  takeNotices?: () => string | null
  /**
   * 取走本会话待送达的插入消息（见 pendingInserts），返回合并后的原文（没有则 null）：每步工具结果回灌前、
   * 取完通知之后调用，有则附在最后，并发 insert 事件。仅主轮传入。
   */
  takeInserts?: () => string | null
  /**
   * 每收到一次真实用量即回调（主轮据此持久化 lastInputTokens 作压缩触发依据）。
   * input 为**总提示 token**（含缓存命中/写入）；cacheRead/cacheWrite 仅供观测，不参与任何判定。
   */
  onUsage?: (input: number, cacheRead: number, cacheWrite: number) => void
  /**
   * ask_user 得到答复即回调（主轮据此把答案存入 StoredSession.asks 边车，供重开还原问答卡）。
   * answers=null 表示取消/中止。仅主轮传入；子轮无 ask_user，且不得污染父轮边车。
   */
  onAskAnswered?: (toolUseId: string, answers: string[] | null) => void
  /**
   * 工具执行产出一行摘要即回调（主轮据此把摘要存入 StoredSession.summaries 边车，供重开还原工具卡摘要）。
   * 仅主轮传入；子轮工具不得写入父轮边车。
   */
  onToolSummary?: (toolUseId: string, summary: string) => void
  /**
   * exit_plan 得到用户决定即回调（主轮据此把决定存入 StoredSession.plans 边车，供重开还原计划卡）。
   * decision=null 表示取消/中止；feedback = 继续完善时附的回复。仅主轮传入。
   */
  onPlanDecided?: (
    toolUseId: string,
    decision: 'approve' | 'keep' | 'ignore' | null,
    feedback?: string
  ) => void
  /**
   * todo_write 执行：写入会话的待办清单边车并推送进度，返回回灌给模型的结果。仅主轮传入；
   * 缺省（子智能体 / 定时任务，工具集本就不含它）时按幻觉调用回指导性错误。
   */
  onTodoWrite?: (toolUseId: string, input: unknown) => { content: string; isError: boolean }
  /**
   * 文件检查点记录器（供回滚）：写入类工具执行前后、run_command 执行后调用。主轮创建、透传给子轮
   * （子轮的写入归到父级 run_subagent 的 id，随父轮一起回滚）；定时任务不传（v1 不记录）。
   */
  recorder?: Recorder
  /**
   * 每落地一步（助手消息 / 工具结果）即回调：调用方据此逐步落盘，而不是等整轮结束才写一次——
   * 一轮可能跑很久（长命令、多步工具），期间崩溃 / 强退会让这一轮已产出的内容全部丢失。
   * 仅主轮与定时任务传入；子轮历史是隔离的临时数组，不落盘。
   */
  onStep?: () => void
  /**
   * 一轮进行中的上下文压缩（对标 Claude Code：每次请求模型前都检查，长任务跑到一半也会自动压，
   * 不必等到下一轮开头——一轮里连跑几十步工具，那时早已撑爆窗口）。循环从第 2 步起、每步请求前
   * 判定接近窗口即调用；实现方须**就地**改写 history（不得重新赋值），返回是否真的压缩了。
   * 仅主轮与定时任务传入；子轮历史是隔离的临时数组，不做压缩（上下文撑满时以出错收场，结论照常交回）。
   */
  compact?: () => Promise<boolean>
  /**
   * 本对话的项目成员名单（见 members.ts）：每步请求前与历史里已告知的比对，有变化即随消息下发（同技能清单）。
   * 仅主对话的主轮传入（工具表带着 member_send 时）。
   */
  listMembers?: () => MemberListingItem[]
  /**
   * 成员相关工具的执行（主对话：create_member / member_send / member_stop；成员会话：read_main / report_to_main）。
   * 不过权限闸门——它们只改会话属性、起后台回合或读主对话正文。未传则按不可用处理。
   */
  memberTool?: (tc: { id: string; name: string; args: unknown }) => Promise<MemberToolResult>
}

/** 工具循环里一步中的一次调用（参数残缺的另带 truncated / cause，见 tool_call_truncated）。 */
type StepToolCall = { id: string; name: string; args: unknown; truncated?: number; cause?: BrokenCallCause }

/** 在闸门前就地处理的工具调用的结果（见 runAgentLoop 的 loopTools / deliver）。 */
interface LoopToolOutcome {
  /** 回灌给模型的 tool_result 正文。 */
  content: string
  isError: boolean
  /** 随结果告知模型的清单记录（按需加载工具的用法、成员名单等，见 listing.ts）。 */
  listing?: Extract<ContentPart, { type: 'tool_result' }>['listing']
  /** 界面上这一步的摘要；name 缺省为本次调用的工具名。不给 = 不发 tool_result 事件。 */
  shown?: { summary: string; isError: boolean; name?: string }
}

/** 抛出一个或多个问题、暂停循环等用户一次性作答（不过权限闸门，恒放行执行）。 */
function askUser(
  turnId: string,
  sessionId: string,
  questions: AskQuestion[]
): Promise<string[] | null> {
  const key = genId('ask')
  emit(turnId, sessionId, { type: 'ask_user', key, questions })
  notifyPending(turnId, sessionId, { kind: 'ask', questions: questions.map((q) => q.question) })
  return timedWait(turnId, new Promise((resolve) => pendingAsk.set(key, { resolve, turnId, sessionId })))
}

/**
 * 提交计划、暂停循环等用户批准（不过权限闸门）。返回 'approve'（批准，直接按计划执行）/
 * 'keep'（继续完善，可附回复）/ 'ignore'（忽略）/ null（取消/中止）。批准本身不授予任何能力——仅让循环继续。
 */
function reviewPlan(
  turnId: string,
  sessionId: string,
  plan: string
): Promise<PlanVerdict | null> {
  const key = genId('plan')
  emit(turnId, sessionId, { type: 'plan_review', key, plan })
  notifyPending(turnId, sessionId, { kind: 'plan' })
  return timedWait(turnId, new Promise((resolve) => pendingPlan.set(key, { resolve, turnId, sessionId })))
}

/**
 * 请求用户挂载工作区、暂停循环等其处置。返回已挂载目录的绝对路径，或 null（暂不挂载/取消/中止）。
 * 路径**只可能**来自用户在系统目录对话框里的选择（渲染层 fs.openFolder → trustRoot）：这里既不
 * 接受模型给的目录、也不替用户预选，故它不是一条能被模型诱导的提权通道。
 */
export function requestMount(
  turnId: string,
  sessionId: string,
  tool: string,
  path: string,
  member?: string
): Promise<string | null> {
  const key = genId('mount')
  emit(turnId, sessionId, { type: 'mount_request', key, tool, path, ...(member ? { member } : {}) })
  notifyPending(turnId, sessionId, { kind: 'mount' })
  return timedWait(turnId, new Promise((resolve) => pendingMount.set(key, { resolve, turnId, sessionId })))
}

/**
 * Agent 编排核心：单步流式 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续。
 * 主轮与子智能体共用此逻辑；**不发终态 `done`**，仅返回 `{text, stopReason}` 交调用方处置
 * （主轮由 runTurn 发 done；子轮把 text 作结论回灌父轮）。流式内的 text/tool/usage/error/
 * reconnect 等中途事件照常发。抛异常则交调用方 catch。
 */
export async function runAgentLoop(
  args: AgentLoopArgs
): Promise<{
  text: string
  stopReason: StopReason
  errorMessage?: string
}> {
  const {
    turnId,
    sessionId,
    history,
    system,
    tools,
    personaId,
    model,
    effort,
    ctx,
    controller,
    maxSteps,
    depth,
    interactive,
    allowAskUser,
    allowSubagents,
    agentName,
    parentToolId
  } = args
  // depth>0 时给 tool_call/tool_result 事件盖上「来自哪个子智能体、归属哪张卡」的戳（后台运行的再加 bg）；
  // 主轮（depth 0）为 undefined，事件形状与既有完全一致（向后兼容）。
  const evMeta: { depth: number; agent?: string; parent?: string; bg?: true } | undefined =
    depth > 0
      ? { depth, agent: agentName, parent: parentToolId, ...(args.background ? { bg: true as const } : {}) }
      : undefined
  // 子智能体运行在隔离上下文里，其正文/思考/用量/重连等**流式噪声一律不进主对话流**
  // （对标 Claude Code：Task 卡之外看不到子智能体的过程），只有工具调用（盖了 evMeta 戳，
  // 折叠进卡）与最终结论回到父轮。并行派发后这更是必须的——否则多个子智能体的正文会互相交织。
  const isSub = depth > 0

  /**
   * 这次 run_subagent / send_to_subagent 是否在后台运行：默认后台，模型设 foreground 才在前台等结论
   * （run_in_background: false 是改默认之前的写法，同样当前台）。后台只在用户在场时可用：定时任务里一律前台跑完
   * （后台结束要靠通知唤起新一轮，无人值守时不该这样续命）；成员会话同样一律前台（后台结束唤起的成员新一轮
   * 没有派发记录，交差会被当成用户直接跟成员说的话）。Task 卡的「后台」徽标与实际派发共用这一个判断。
   */
  const runsInBackground = (callArgs: unknown): boolean => {
    const a = (callArgs ?? {}) as { foreground?: unknown; run_in_background?: unknown }
    return (
      !isSub &&
      interactive &&
      !getSession(sessionId)?.parentId &&
      a.foreground !== true &&
      a.run_in_background !== false
    )
  }

  /**
   * 新派出一个子智能体（run_subagent）：建好它的记录（隔离历史 / 系统提示词 / 工具表），但不运行。
   * 未指定 / 未命中 → 一律回落内置通用子智能体，**绝不因此失败**（对标 Claude Code：未知 subagent_type
   * 同样落到 general-purpose）；名字落空时在结论前缀一行说明，免得模型以为点名的那位生效了。
   * fork 原样继承主对话：同一份历史（浅拷贝）+ 定格的 system / tools，提示缓存可整段命中。
   */
  function prepareNewSubagent(tc: {
    id: string
    args: unknown
  }): { label: string; note: string; rec?: SubagentRecord; error?: string } {
    const a = (tc.args ?? {}) as { agent?: unknown; prompt?: unknown; description?: unknown }
    const wantedAgent = typeof a.agent === 'string' ? a.agent.trim() : ''
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
    const fork = isForkAgent(wantedAgent)
    const picked = wantedAgent && !fork ? getSubagentByName(wantedAgent) : null
    const def = picked ?? GENERAL_SUBAGENT
    const label = fork ? FORK_AGENT.name : def.name
    const note =
      wantedAgent && !fork && !picked
        ? `（没有名为「${wantedAgent}」的子智能体，已改用通用子智能体 ${GENERAL_SUBAGENT.name} 完成。可选：${subagentSummaries()
            .map((x) => x.name)
            .join('、')}。）\n`
        : ''
    if (!prompt) return { label, note, error: `派生子智能体「${label}」失败：缺少任务描述（prompt）。` }
    const now = Date.now()
    return {
      label,
      note,
      rec: {
        id: newSubagentId(sessionId, tc.id),
        sessionId,
        agent: label,
        description: typeof a.description === 'string' ? a.description.trim() : '',
        originToolId: tc.id,
        toolIds: [tc.id],
        workspaceRoot: ctx.workspaceRoot,
        system: fork ? system : buildSubagentSystem(def, ctx.workspaceRoot),
        tools: fork ? tools : buildSubagentTools(def, personaId),
        // 普通子智能体只带本次任务描述，不继承父对话（避免上下文串味与预算膨胀）。
        // fork 继承的是父对话里模型看到的那部分（压缩过就从摘要起），不是完整记录。
        messages: fork
          ? buildForkHistory(modelMessages(history), tc.id, prompt)
          : [{ role: 'user', content: prompt }],
        createdAt: now,
        updatedAt: now
      }
    }
  }

  /**
   * 续聊一个已派出的子智能体（send_to_subagent）：读出它落盘的记录，把这条消息接到它自己的历史后面。
   * 工作目录若已变化（其系统提示词里写的仍是旧目录），在消息前讲明新的相对路径基准。
   */
  function prepareContinueSubagent(tc: {
    id: string
    args: unknown
  }): { label: string; note: string; rec?: SubagentRecord; error?: string } {
    const a = (tc.args ?? {}) as { to?: unknown; message?: unknown }
    const to = typeof a.to === 'string' ? a.to.trim() : ''
    const message = typeof a.message === 'string' ? a.message.trim() : ''
    const rec = to ? loadSubagent(sessionId, to) : undefined
    const label = rec?.agent || to || '子智能体'
    if (!to || !message)
      return { label, note: '', error: '续聊子智能体失败：需要 to（子智能体 ID）与 message。' }
    if (!rec)
      return {
        label,
        note: '',
        error: `子智能体 ${to} 已不可用（已被清理、所在轮次被删除，或 ID 有误），请用 run_subagent 重新派发。`
      }
    if (isSubagentBusy(sessionId, to))
      return {
        label,
        note: '',
        error: [...backgroundSubagents.values()].some((b) => b.sessionId === sessionId && b.subagentId === to)
          ? `子智能体 ${to} 正在后台运行，结束后会自动通知你；请等通知到了再给它发消息。`
          : `子智能体 ${to} 正在处理另一条消息，请等它完成后再发。`
      }
    closeDanglingTail(rec.messages)
    const moved = rec.workspaceRoot !== ctx.workspaceRoot
    rec.messages.push({
      role: 'user',
      content: moved
        ? `（提示：当前工作目录已变为 ${ctx.workspaceRoot ?? '（未挂载工作区）'}，相对路径以此为准。）\n${message}`
        : message
    })
    rec.workspaceRoot = ctx.workspaceRoot
    rec.toolIds.push(tc.id)
    return { label, note: '', rec }
  }

  /**
   * 在子智能体记录自己的历史上跑一次 runAgentLoop（新派出与续聊共用），把结果映射成交回父轮的结论。
   * 派生本身不设闸——子智能体的每一次嵌套工具调用仍在其 runAgentLoop 内照常过同一道闸门（无后门）。
   * 递归深度上限 1：子轮 allowSubagents=false，杜绝子派生子。结束后（含中止 / 出错）落盘并解除忙状态。
   * bg：后台运行——用它自己的取消控制器（不随本轮中止），事件以空 turnId 发出并盖 bg 戳。
   */
  async function runSubagentLoop(
    rec: SubagentRecord,
    tc: { id: string },
    bg?: AbortController
  ): Promise<{ conclusion: string; isErr: boolean; aborted: boolean }> {
    const label = rec.agent
    try {
      const sub = await runAgentLoop({
        turnId: bg ? '' : turnId,
        sessionId,
        history: rec.messages,
        system: rec.system,
        tools: rec.tools,
        personaId,
        // 子智能体恒跟随主对话（继承本轮模型与思考等级）。
        model,
        effort,
        ctx: bg ?{ workspaceRoot: ctx.workspaceRoot, signal: bg.signal } : ctx,
        controller: bg ?? controller,
        // 定时任务里派出的子智能体同受步数上限（主对话里为 undefined = 不限）。
        maxSteps,
        depth: depth + 1,
        // 跟随父轮：用户在场时照常过交互权限闸门；定时任务里同样无人值守（走 sealedDecision）。
        interactive,
        allowAskUser: false,
        allowSubagents: false,
        agentName: label,
        // 嵌套事件据此归入**本次调用**开出的那张 Task 卡（并行时唯一可靠依据）。
        parentToolId: tc.id,
        background: !!bg,
        // 子轮写入归到本次调用的 id（见执行点 owner），随父轮一起回滚。
        recorder: args.recorder
      })
      const aborted = sub.stopReason === 'aborted'
      const degenerate = sub.stopReason === 'degenerate'
      const isErr = sub.stopReason === 'error' || aborted || degenerate
      const partial = sub.text.trim()
      // 中止时的 text 只是半截过程输出，不能当成结论交给模型——明确标注「未完成」，
      // 免得下一轮模型把它当作子任务的正式结果继续推进。输出陷入复读而停下的同理。
      const conclusion = aborted
        ? `子智能体「${label}」被用户中止，未完成。` + (partial ? `\n中止前的最近输出：\n${partial}` : '')
        : degenerate
          ? `子智能体「${label}」执行失败：${sub.errorMessage ?? degenerateMessage()}` +
            (partial ? `\n停止前的最近输出：\n${partial}` : '')
          : partial ||
          (isErr && sub.errorMessage
            ? `子智能体「${label}」执行失败：${sub.errorMessage}`
            : '（子智能体未产生文本结论。）')
      return { conclusion, isErr, aborted }
    } catch (e) {
      return {
        conclusion: `子智能体「${label}」执行出错：${(e as Error)?.message ?? String(e)}`,
        isErr: true,
        aborted: false
      }
    } finally {
      closeDanglingTail(rec.messages)
      saveSubagent(rec)
      setSubagentBusy(sessionId, rec.id, false)
    }
  }

  /**
   * 执行一次 run_subagent / send_to_subagent，只把结论文本交回父轮；任何解析/执行失败都捕获成结论，
   * 父轮继续，绝不整轮失败。结论末尾附子智能体 ID，供模型之后用 send_to_subagent 找回它。
   * **可并发调用**：完成即定格自己那张 Task 卡（按调用 id 归属，与完成先后无关）。
   */
  async function runSubagentCall(tc: {
    id: string
    name: string
    args: unknown
  }): Promise<{ conclusion: string; isErr: boolean }> {
    const prep =
      tc.name === 'send_to_subagent' ? prepareContinueSubagent(tc) : prepareNewSubagent(tc)
    // 默认后台（定时任务与成员会话一律前台，见 runsInBackground）。
    if (prep.rec && runsInBackground(tc.args)) return launchBackgroundSubagent(tc, prep.rec, prep.note)
    let conclusion: string
    let isErr = true
    let aborted = false
    if (prep.rec) {
      // 同步占住（首个 await 之前）：同一步里对同一子智能体的第二条消息会在准备阶段被拒。
      setSubagentBusy(sessionId, prep.rec.id, true)
      const r = await runSubagentLoop(prep.rec, tc)
      conclusion =
        prep.note +
        r.conclusion +
        `\n\n[子智能体 ID：${prep.rec.id}——用 send_to_subagent 发消息可让它在保留上下文的基础上继续]`
      isErr = r.isErr
      aborted = r.aborted
    } else {
      conclusion = prep.note + (prep.error ?? '')
    }

    // 摘要只写结局：界面上它紧挨着子智能体的名称显示，再带上名称就重复了。
    const subSummary = aborted ? '已中止' : isErr ? '未完成' : '已完成'
    args.onToolSummary?.(tc.id, subSummary)
    // 父轮（depth 0）事件不盖戳：run_subagent 这张卡本身即 Task 卡的「壳」，
    // 其内部嵌套事件已在递归调用里各自盖了 depth+parent 戳并折叠进来。
    emit(turnId, sessionId, {
      type: 'tool_result',
      id: tc.id,
      name: tc.name,
      summary: subSummary,
      isError: isErr,
      ...(evMeta ?? {})
    })
    return { conclusion, isErr }
  }

  /**
   * 后台派出（默认；见 runsInBackground）：子智能体在自己的取消控制器下开跑，本次调用立即带着「已在后台启动」交回
   * 父轮；Task 卡保持运行中，嵌套事件照常收进卡里。它结束时定格 Task 卡、写边车，并把结论排进通知队列——
   * 主智能体正忙就在下一步带上，空闲就自动起一轮（见 wakeForNotices）。
   */
  function launchBackgroundSubagent(
    tc: { id: string; name: string; args: unknown },
    rec: SubagentRecord,
    note: string
  ): { conclusion: string; isErr: boolean } {
    const label = rec.agent
    const own = (tc.args as { description?: unknown } | null)?.description
    const title = (typeof own === 'string' && own.trim()) || rec.description || label
    const bg = new AbortController()
    // 派发它的这一轮是手机端发起的：它结束后起的那一轮同样按手机端算（回复推到手机，桌面不弹提醒）。
    const fromRemoteTurn = remoteTurns.has(turnId)
    const entry: BackgroundSubagent = {
      sessionId,
      subagentId: rec.id,
      controller: bg,
      silent: false,
      stoppedByUser: false,
      group: turnId
    }
    setSubagentBusy(sessionId, rec.id, true)
    backgroundSubagents.set(tc.id, entry)
    setBackgroundState(sessionId, tc.id, 'running', '后台运行中')
    void runSubagentLoop(rec, tc, bg)
      .then((r) => {
        backgroundSubagents.delete(tc.id)
        // 它开的后台网页同回合结束一样计时（用户停止的不会自动起轮，见下）
        markBrowserTurnEnded(sessionId)
        // 同组（同一轮派出）还有在跑的：交给最后结束的那一个唤醒主智能体，一并汇总（见下）。
        const othersPending = [...backgroundSubagents.values()].some((b) => b.group === entry.group)
        if (entry.silent) {
          if (!othersPending) bgGroupsWaiting.delete(entry.group)
          // 所在轮次 / 会话已被删：它刚落盘的记录同样作废（删除那一刻它还在跑，剪枝跳过了它）。
          // 退出途中被中止的不算，记录留着，重启后仍可续聊。
          if (!shuttingDown) {
            const s = getSession(sessionId)
            if (s) pruneSubagents(sessionId, new Set(turnToolIds(s.messages).flat()))
            else removeSessionSubagents(sessionId)
          }
          return
        }
        const stopped = entry.stoppedByUser
        // 摘要只写结局（界面上紧挨着子智能体名称显示）；通知标题另写全称。
        const summary = stopped ? '已停止' : r.isErr ? '未完成' : '已完成'
        setBackgroundState(sessionId, tc.id, r.isErr ? 'error' : 'ok', summary)
        emit('', sessionId, { type: 'tool_result', id: tc.id, name: tc.name, summary, isError: r.isErr, bg: true })
        const status = stopped ? '已被用户停止' : r.isErr ? '未完成' : '已完成'
        // 同一轮派出的后台子智能体是一组，等最后一个结束才唤醒主智能体一次、一并汇总（对话里不会一个结论起一轮）。
        // 先结束的通知照常排队：主智能体正忙就随下一步带上，空闲就等着。用户亲手停的单独不唤醒，但同组已有
        // 结论在等它时照样唤醒（不然那几项的结论就没人处理了）。同成员的汇总组，见 reportMemberTurn。
        let wake = false
        if (othersPending) {
          if (!stopped) bgGroupsWaiting.add(entry.group)
        } else {
          wake = !stopped || bgGroupsWaiting.has(entry.group)
          bgGroupsWaiting.delete(entry.group)
        }
        enqueueNotice(sessionId, {
          toolUseId: tc.id,
          headline: `后台子智能体「${title}」${status}`,
          body: [
            '<后台子智能体通知>',
            `子智能体：${label}（ID：${rec.id}）`,
            `任务：${title}`,
            `状态：${status}`,
            '结论：',
            r.conclusion,
            `（用 send_to_subagent 给 ${rec.id} 发消息可让它在保留上下文的基础上继续。）`,
            '</后台子智能体通知>'
          ].join('\n'),
          wake,
          model,
          remote: fromRemoteTurn,
          subagent: stopped ? 'stopped' : r.isErr ? 'failed' : 'done'
        })
      })
      .catch((e) => console.warn('[subagents] 后台子智能体收尾失败：', e))
    return {
      conclusion:
        note +
        `子智能体「${label}」已在后台启动（ID：${rec.id}）。它结束后系统会自动通知你（这一轮派出的几个会等全部结束再一起通知），` +
        '届时再据结论继续；在此之前不要轮询、等待或查看它的进度：接着做不依赖它结论的事；没有的话简短告诉用户交给了子智能体在查什么，结束这一轮等通知。',
      isErr: false
    }
  }

  /**
   * 给本步还没有结果的工具调用补占位 tool_result（按原序追加进 resultParts）。
   * 协议要求每个 tool_use 紧跟其 tool_result：中途中止 / 出错若只把 assistant(tool_use) 落进历史，
   * 下一次请求会被服务端 400 拒绝，且这条会话此后每次都 400。已并行启动的子任务照常等它
   * （共用同一控制器，很快因中止而收尾）交回自己的结论；ask_user / exit_plan 记为取消，
   * 其余工具的卡片定格为「未执行」，与重开后的边车一致。
   */
  async function fillUnrun(
    calls: { id: string; name: string }[],
    resultParts: ContentPart[],
    subRuns: Map<string, Promise<{ conclusion: string; isErr: boolean }>>,
    reason: 'aborted' | 'error' | 'step_limit' | 'repeated' | 'degenerate'
  ): Promise<void> {
    const have = new Set<string>()
    for (const p of resultParts) if (p.type === 'tool_result') have.add(p.toolUseId)
    for (const tc of calls) {
      if (have.has(tc.id)) continue
      const pendingSub = subRuns.get(tc.id)
      if (pendingSub) {
        const sub = await pendingSub.catch(() => ({
          conclusion: '子智能体未完成（回合中断）。',
          isErr: true
        }))
        resultParts.push({
          type: 'tool_result',
          toolUseId: tc.id,
          content: sub.conclusion,
          isError: sub.isErr
        })
        continue
      }
      if (tc.name === 'ask_user') args.onAskAnswered?.(tc.id, null)
      else if (tc.name === 'exit_plan') args.onPlanDecided?.(tc.id, null)
      else if (tc.name === 'todo_write') {
        // 未执行：清单维持原状，对话流里本就没有它的卡，无需收敛。
      } else {
        const label =
          reason === 'aborted'
            ? '未执行（已中止）'
            : reason === 'step_limit'
              ? isEn()
                ? 'Not run (step limit reached)'
                : '未执行（已达到步数上限）'
              : reason === 'repeated'
                ? isEn()
                  ? 'Not run (repeated calls stopped)'
                  : '未执行（重复调用已停止）'
                : reason === 'degenerate'
                  ? isEn()
                    ? 'Not run (output kept repeating)'
                    : '未执行（输出陷入重复）'
                  : '未执行'
        args.onToolSummary?.(tc.id, label)
        emit(turnId, sessionId, {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          summary: label,
          isError: true,
          ...(evMeta ?? {})
        })
      }
      resultParts.push({
        type: 'tool_result',
        toolUseId: tc.id,
        content:
          reason === 'aborted'
            ? '用户中止了本轮，此工具调用未执行。'
            : reason === 'step_limit'
              ? '已达到本次运行的步数上限，此工具调用未执行。'
              : reason === 'repeated'
                ? '相同的调用连续多次没有进展，工具调用已停止，此工具调用未执行。'
                : reason === 'degenerate'
                  ? '你的输出陷入逐字重复，本轮已停止，此工具调用未执行。'
                  : '本轮因错误中断，此工具调用未执行。',
        isError: true
      })
    }
  }

  // 最近一步的助手正文；作为子智能体回传父轮的「结论」（主轮不使用返回值）。
  let finalText = ''
  // 致命错误 / 重连耗尽时的错误文案：随返回值上交，供父轮子智能体结论回落与红框持久化。
  let errorMessage: string | undefined
  // 最近一次请求的真实总输入 token，及该请求发出时的历史长度：供轮中压缩判定
  // （之后追加的助手输出 / 工具结果不在读数里，由判定函数另行估算补上）。
  let usedInput = 0
  let usedAt = 0
  // 连续被截断的步数（见 MAX_TRUNCATED_STREAK）：工具参数残缺与「只思考 / 半截正文」截断共用。
  let truncatedStreak = 0
  // 本轮已因上下文超限强制压缩重试过（每轮至多一次：压完仍超限说明单步就装不下，再试无益）。
  let contextRetried = false
  // 本轮已因回复复读丢弃重试过一步（每轮至多一次：重试仍复读说明模型已退化，再试无益，见自愈⑤）。
  let repetitionRetried = false
  // 本轮已追问过一次空回合（至多一次，仍为空才交还用户并显示「空回合」）。
  let emptyNudged = false
  // 本次循环是否已产出过可见内容（正文或工具调用）：空回合追问只针对「从头到尾什么都没有」。
  let producedVisible = false
  // 技能清单与记忆条目随消息下发（见 listing.ts）：只给主轮与定时任务（depth 0），技能另须带着 skill 工具。
  // fork 虽共享主对话的历史与工具表，但 depth>0，且它的历史里已带着主对话附过的清单；普通子智能体本就不看记忆。
  const listsSkills = depth === 0 && tools.some((t) => t.name === 'skill')
  const listsMemory = depth === 0
  const offeredTools = new Set(tools.map((t) => t.name))
  // 技能清单与加载按本轮工具表筛：创建角色 / 技能 / MCP 的内置技能，在没有对应工具的对话里（成员会话、定时任务、
  // 子智能体）不列出也不加载，免得模型以为自己能做。
  const hasTool = (n: string): boolean => offeredTools.has(n)
  // 原地打转计数（见 shared/limits.ts）：最近一次调用的指纹及其连续次数，跨步累计，任一处不同即重来。
  let repeat = { key: '', count: 0, tool: '' }
  // 已打转到 REPEAT_STOP 次的那次调用：非空即下一步改发收尾请求。
  let stuckOn: { tool: string; count: number } | null = null

  // 主对话与子智能体不设步数上限：一直循环到模型不再调用工具为止（对标 Claude Code 的 agentic loop）。
  // 天然刹车 = 用户随时可中止（停止键；后台子智能体在其 Task 卡上单独停止）+ 接近上下文上限时自动压缩 +
  // 连续截断收场 + 原地打转收场。定时任务无人值守，另设 maxSteps（见 AgentLoopArgs.maxSteps）。
  for (let step = 0; ; step++) {
    // 轮中压缩：第 2 步起每步请求前检查（第 1 步之前调用方已在轮开头查过）。此刻上一步的工具
    // 结果已全部回灌（并行子智能体也已等齐），历史里没有悬空的 tool_use，可以安全改写。
    if (
      step > 0 &&
      args.compact &&
      !controller.signal.aborted &&
      needsCompactionMidTurn(history, model, usedInput, usedAt) &&
      (await args.compact())
    )
      usedInput = 0 // 历史已改写，旧读数作废：回退估算，直到本步拿到新读数

    // 原地打转到上限 / 已走满 maxSteps 步：本步是收尾请求。引导以 AUTO_MARKER 开头（不成气泡、不算轮起点），
    // 紧跟在上一步的工具结果之后；工具表照常带上（历史里有 tool_use 时 Anthropic 要求必须带），本步的调用一律不执行。
    const wrapUp: 'repeated' | 'step_limit' | null = stuckOn
      ? 'repeated'
      : maxSteps !== undefined && step >= maxSteps
        ? 'step_limit'
        : null
    if (stuckOn) history.push({ role: 'user', content: repeatStopNudge(stuckOn.tool, stuckOn.count) })
    else if (wrapUp === 'step_limit')
      history.push({ role: 'user', content: stepLimitNudge(maxSteps as number) })

    let assistantText = ''
    // truncated = 参数残缺时已写出的字符数、cause = 残缺原因：这种调用只记录、不执行（见下方工具循环）。
    let toolCalls: StepToolCall[] = []
    let stopReason: StopReason = 'end_turn'
    // 本步被中止 / 出错打断（而非干净结束）：仍落地已收到的部分，见下方提交段。
    let interrupted: 'aborted' | 'error' | 'degenerate' | null = null
    // 本步思考全文：只用于复读检测与截断后重画（思考不回放给模型，不进历史）。
    let thinkingText = ''
    // 按需加载工具（见 tool-search.ts）里用法还不在上下文里的，在发请求前定格：发 tool_call 事件（画成
    // 「查看用法」）与工具循环里的拦截按同一份判定。子智能体禁用的工具照旧走「子智能体不可用」，不算在内。
    let pendingUsage = new Set<string>()
    const usageGated = (name: string): boolean =>
      pendingUsage.has(name) && !(depth > 0 && SUBAGENT_EXCLUDED.has(name))

    // 单步流式 + 自动重连：遇可重试网络错误（含空闲僵死）→ 丢弃残缺尾部、退避后重发本步。
    // 无状态中转不支持断点续流，只能整步重发；已完成的前序步骤（工具卡/文本）不受影响。
    // 最近一次可重试错误的原文：重连耗尽时随报错展示，否则用户只看到笼统的「连接中断」无从排查。
    let lastDropReason = ''
    // 服务端建议的等待（retry-after），仅对紧随其后的那次退避生效。
    let retryAfterMs: number | undefined
    reconnect: for (let attempt = 0; ; attempt++) {
      assistantText = ''
      thinkingText = ''
      toolCalls = []
      stopReason = 'end_turn'
      // 复读看守（见 repetition.ts）：正文与思考各一路，命中即掐断本步的流。toolMark = 最近一次收到工具调用时
      // 两路已有的长度：截断后重画只重画它之后的部分（之前的在工具卡前面，stream_reset 删不到）。
      const watchText = watchRepetition()
      const watchThinking = watchRepetition()
      let looped: { channel: 'text' | 'thinking'; period: number } | null = null
      let toolMark = { text: 0, thinking: 0 }
      let retryableDrop = false
      let fatal = false
      // 不可重试错误先扣下、不立即画红框：其中几类引擎能自愈（输出预算降档、上下文压缩后重发），
      // 流结束后再定夺；自愈不了才上报。
      let fatalErr: {
        kind: string
        message: string
        limit?: number
        overflow?: ContextOverflow
      } | null = null
      // 每次（含重发）现算：本步刚因不认思考等级被拒时，重发即不再带该参数。
      const stepEffort = sentEffort(model, effort)
      // 同理现算：本步刚因输出预算被拒时，重发即降回保守值。
      const stepBudget = outputBudget(model)
      // 技能或记忆有变化（含轮内刚装的技能、别的对话或面板改的记忆、轮中挂载带来的项目记忆）、或压缩 / 删轮
      // 抹掉了先前的告知 → 把差异附在本次请求才首发的末条消息上。每次（含重发）现算：已告知过即无事，故幂等；
      // 压缩自愈后的重发也能补上被摘要掉的清单。
      // 「已告知」按模型看到的部分判断（压缩过就从摘要起）；清单仍附到完整记录的末条（两者末条是同一条）。
      if (listsSkills)
        attachListing(history, (h) =>
          skillListingPart(modelMessages(h), enabledSkillSummaries(personaId, hasTool))
        )
      if (listsMemory)
        attachListing(history, (h) => memoryListingPart(modelMessages(h), ctx.workspaceRoot))
      // 项目成员名单：主对话的主轮，名单有增减或更新时附上（同技能清单）。有成员（含本对话的定时任务）时
      // 派任务 / 查状态才用得上：这两个按需加载的工具，用法还不在上下文里就随名单一并附上，免得调用时被拦。
      const listMembers = args.listMembers
      if (listMembers)
        attachListing(history, (h) => {
          const seen = modelMessages(h)
          const members = listMembers()
          const guided = Object.keys(DEFERRED_MEMBER_TOOLS).filter((n) => offeredTools.has(n))
          return [memberListingPart(seen, members), members.length ? usageListingPart(seen, guided) : null]
        })
      // 本次请求实际发出的消息：清单附完之后再取，末条才带着清单。
      const sent = modelMessages(history)
      pendingUsage = unknownUsages(sent, offeredTools)

      for await (const ev of streamChat(
        { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
        {
          model: model.model,
          system,
          // 本对话 id：需要「每对话稳定会话 id」的网关据此固定路由与复用缓存（OpenCode Go 缺失即
          // 400 MissingSessionID，见 providers/opencode.ts）。子智能体与 fork 沿用父对话 id。
          sessionId,
          // 旧回合的工具图片换成文字说明、本回合超预算的较早图片也裁掉；定时任务只是告知的长内容只留标题
          // （见 handoff.ts stubLongInforms）。只影响本次请求，历史不动。
          messages: trimHistoryImages(stubLongInforms(sent)),
          tools,
          signal: controller.signal,
          maxTokens: stepBudget,
          effort: stepEffort?.req,
          // 工具循环每步都要把 system + tools + 全量历史整个重发一遍，是提示缓存最典型的受益者
          // （Anthropic 才需显式断点；OpenAI/DeepSeek 自动命中，此开关对它们无作用）。
          // 子智能体同样走这里：其 system/tools 与主轮不同，自成一套缓存条目，各缓各的。
          cache: true
        }
      )) {
        if (ev.type === 'text_delta') {
          assistantText += ev.text
          if (!isSub) emit(turnId, sessionId, { type: 'text_delta', text: ev.text })
          const hit = watchText(ev.text)
          if (hit) {
            looped = { channel: 'text', period: hit.period }
            break // 跳出即取消底层请求（iterateSSE 的 finally）
          }
        } else if (ev.type === 'thinking_delta') {
          thinkingText += ev.text
          if (!isSub) emit(turnId, sessionId, { type: 'thinking_delta', text: ev.text })
          const hit = watchThinking(ev.text)
          if (hit) {
            looped = { channel: 'thinking', period: hit.period }
            break
          }
        } else if (ev.type === 'tool_call') {
          toolMark = { text: assistantText.length, thinking: thinkingText.length }
          // 个别网关不给 id：补一个，且事件与消息共用同一个——按 toolUseId 归属的边车 / 检查点
          // 若遇空 id，会把不同轮的记录串到同一个键上。
          const id = ev.id || `call_${randomUUID()}`
          toolCalls.push({ id, name: ev.name, args: ev.args })
          // 没查用法就调用的按需加载工具会被拦下、改为附上用法：画成一步「查看用法」，不画失败，
          // 名片类（create_task / propose_agent）也不铸名片——桌面与手机端都不会冒出一张作废的卡。
          if (usageGated(ev.name))
            emit(turnId, sessionId, {
              type: 'tool_call',
              id,
              name: TOOL_SEARCH,
              args: { names: [ev.name] },
              ...(evMeta ?? {})
            })
          // ask_user / exit_plan 不画通用工具卡：循环走到它们时再发专用 ask_user / plan_review 事件
          //（避免既有工具卡又有问答卡/计划卡）。todo_write 同理：进度走 todos 事件进胶囊，不进对话流。
          else if (ev.name !== 'ask_user' && ev.name !== 'exit_plan' && ev.name !== 'todo_write')
            emit(turnId, sessionId, {
              type: 'tool_call',
              id,
              name: ev.name,
              // Task 卡：续聊卡要显示原子智能体的类型与任务标题，后台运行的标上 background——都补进展示用参数
              //（不改入历史的原参数）。
              args:
                (ev.name === 'run_subagent' || ev.name === 'send_to_subagent') && !isSub
                  ? subagentDisplayArgs(
                      ev.name,
                      ev.args,
                      (to) => getSubagentMeta(sessionId, to),
                      runsInBackground(ev.args)
                    )
                  : ev.args,
              ...(evMeta ?? {})
            })
        } else if (ev.type === 'tool_call_truncated') {
          // 参数残缺（撞上输出上限 / 被内容拦截 / 坏 JSON）：记成一次调用（进历史、画普通工具卡——
          // 哪怕是 ask_user / exit_plan，它们也没法被答复），由工具循环直接回灌纠正提示，绝不执行。
          toolMark = { text: assistantText.length, thinking: thinkingText.length }
          const id = ev.id || `call_${randomUUID()}`
          const input = truncatedCallInput(ev.partialArgs)
          toolCalls.push({
            id,
            name: ev.name,
            args: input,
            truncated: ev.partialArgs.length,
            cause: ev.cause
          })
          emit(turnId, sessionId, {
            type: 'tool_call',
            id,
            name: ev.name,
            args: input,
            ...(evMeta ?? {})
          })
        } else if (ev.type === 'usage') {
          // 子轮用量不代表主对话的上下文占用，不喂渲染层的上下文计量。
          if (!isSub)
            emit(turnId, sessionId, {
              type: 'usage',
              input: ev.input,
              output: ev.output,
              cacheRead: ev.cacheRead,
              cacheWrite: ev.cacheWrite
            })
          // 流式中本步助手消息尚未追加，history.length 即本次请求发出时的长度。
          if (ev.input > 0) {
            usedInput = ev.input
            usedAt = history.length
          }
          args.onUsage?.(ev.input, ev.cacheRead ?? 0, ev.cacheWrite ?? 0)
        } else if (ev.type === 'error') {
          // 可重试且非用户中止 → 暂不上报，走自动重连；否则作为致命错误立即上报。
          if (ev.error.retryable && !controller.signal.aborted) {
            retryableDrop = true
            lastDropReason = ev.error.message
            retryAfterMs = ev.error.retryAfterMs
          } else {
            fatal = true
            fatalErr = {
              kind: ev.error.kind,
              message: ev.error.message,
              limit: ev.error.limit,
              overflow: ev.error.overflow
            }
          }
        } else if (ev.type === 'done') {
          stopReason = ev.stopReason
        }
      }

      // 中止 / 致命错误：不再直接 return——那样本步已流出的正文（渲染层早已画出）不进历史，
      // 重开对话后这一轮凭空消失。跳出重连循环，交给下方提交段落地已收到的部分。
      if (controller.signal.aborted) {
        interrupted = 'aborted'
        break reconnect
      }
      // 自愈⑤：回复陷入逐字复读（模型退化，常见于上下文过长）。流在检测到时已掐断，复读段不进历史，
      // 也不走截断续写——那会把复读放大成无限输出。每轮重试一次：丢弃本步，上下文长时先压缩（压短了再试
      // 才有意义），再重发。本步已收到工具调用的不重试（工具卡已画出，整步丢弃会留下孤卡）。
      if (looped && !repetitionRetried && toolCalls.length === 0) {
        repetitionRetried = true
        console.warn(`[chat] 回复复读（${looped.channel}，周期 ${looped.period} 字符），丢弃本步重试`)
        if (!isSub) {
          emit(turnId, sessionId, { type: 'auto_retry', reason: 'repetition', attempt: 1, max: 1 })
          emit(turnId, sessionId, { type: 'stream_reset' })
        }
        if (
          args.compact &&
          compactionWorthRetry(history, model, usedInput, usedAt) &&
          (await args.compact())
        )
          usedInput = 0
        attempt--
        continue reconnect
      }
      // 重试过仍复读：截到复读区域的第一份，按中断落地并结束本轮。不发收尾请求——退化的模型写总结多半
      // 也在复读。界面上先丢掉本步已画出的尾部，再按截断后的内容重画。
      if (looped) {
        const cutLoop = (t: string): string => {
          const hit = trailingRepetition(t)
          return hit ? t.slice(0, hit.start + hit.period) : t
        }
        if (looped.channel === 'text') assistantText = cutLoop(assistantText)
        else thinkingText = cutLoop(thinkingText)
        if (!isSub) {
          emit(turnId, sessionId, { type: 'stream_reset' })
          const thinkingTail = thinkingText.slice(toolMark.thinking)
          const textTail = assistantText.slice(toolMark.text)
          if (thinkingTail) emit(turnId, sessionId, { type: 'thinking_delta', text: thinkingTail })
          if (textTail) emit(turnId, sessionId, { type: 'text_delta', text: textTail })
        }
        errorMessage = degenerateMessage()
        interrupted = 'degenerate'
        break reconnect
      }
      if (fatal && fatalErr) {
        // 自愈⓪：模型 / 网关不认所选思考等级 → 记住，去掉该参数重发本步（不计入重连次数）。
        // 只认本步确实带了参数的情形（适配器据此才会归出该类），故不会空转。
        if (fatalErr.kind === 'effort_unsupported' && stepEffort) {
          effortRejected.add(effortKey(model, stepEffort.level))
          console.warn('[chat] 思考等级被拒，按默认重发：', fatalErr.message)
          if (!isSub) {
            emit(turnId, sessionId, { type: 'auto_retry', reason: 'effort', attempt: 1, max: 1 })
            emit(turnId, sessionId, { type: 'stream_reset' })
          }
          attempt--
          continue reconnect
        }
        // 报错里写着真实窗口（中转把上游窗口开小、或用户填大了）→ 记住，此后压缩按它来。
        const limitLearned =
          fatalErr.limit !== undefined && rememberContextLimit(model, fatalErr.limit)
        // 自愈⑥：输入 + 输出预留超窗，而本步没传 max_tokens——预留是服务商的默认值，常是模型的最大输出
        // （DeepSeek V4 为 384K，1M 窗口里输入过 65.5 万即被拒，issue #43）。记住改为显式发送 OUTPUT_BUDGET_WIDE
        // （不超过服务商的默认值），压缩线随之按它扣输出；输入装得下就直接重发，不为此压缩。报错里的输入常写
        // 「至少 N」，重发仍超窗时本步已带了预算、不会再进这里，交给下面的压缩自愈。
        const overflow = fatalErr.overflow
        let overflowCompact = false
        if (overflow && stepBudget === undefined) {
          const budget = Math.min(OUTPUT_BUDGET_WIDE, overflow.output)
          rememberOutputBudget(model, budget)
          console.warn(
            `[chat] 输出预留超窗（${overflow.input} + ${overflow.output} > ${overflow.limit}），改为显式发送 ${budget}`
          )
          if (overflow.input + budget <= overflow.limit) {
            if (!isSub) {
              emit(turnId, sessionId, { type: 'auto_retry', reason: 'output_fit', attempt: 1, max: 1 })
              emit(turnId, sessionId, { type: 'stream_reset' })
            }
            attempt--
            continue reconnect
          }
          overflowCompact = true // 输入本身已贴着窗口：降档无益，直接压缩
        }
        // 自愈①：输出预算超出该模型允许范围 → 记住并降回保守值，重发本步（不计入重连次数）。
        // 本步已是保守值（或更小）时降档无益，直接交给下面的压缩自愈。
        const wanted = wantedOutputBudget(model)
        const budgetKey = outputBudgetKey(model, wanted)
        if (
          fatalErr.kind === 'output_limit' &&
          !overflowCompact &&
          (stepBudget === undefined || stepBudget > OUTPUT_BUDGET_SAFE) &&
          !outputBudgetRejected.has(budgetKey)
        ) {
          outputBudgetRejected.add(budgetKey)
          console.warn('[chat] 输出预算被拒，降档重发：', fatalErr.message)
          if (!isSub) {
            // 被拒的是用户填的值：带上降档后的值，渲染层提示去模型设置里改。
            const userSet = modelOverrides(model.providerId, model.model).maxOutput !== undefined
            emit(turnId, sessionId, {
              type: 'auto_retry',
              reason: 'output_limit',
              attempt: 1,
              max: 1,
              ...(userSet ? { limit: OUTPUT_BUDGET_SAFE } : {})
            })
            emit(turnId, sessionId, { type: 'stream_reset' })
          }
          attempt--
          continue reconnect
        }
        // 自愈②：上下文超限 → 强制做一次轮中压缩（绕过阈值判定），成功则重发本步。
        // （Anthropic 的「input + max_tokens 超出上下文」也报 max_tokens：降档后仍被拒即归入此类。）
        if (
          (fatalErr.kind === 'context_length' || fatalErr.kind === 'output_limit') &&
          args.compact &&
          !contextRetried
        ) {
          contextRetried = true
          if (!isSub)
            emit(turnId, sessionId, {
              type: 'auto_retry',
              reason: 'context',
              attempt: 1,
              max: 1,
              ...(limitLearned ? { limit: fatalErr.limit } : {})
            })
          if (await args.compact()) {
            usedInput = 0
            if (!isSub) emit(turnId, sessionId, { type: 'stream_reset' })
            attempt--
            continue reconnect
          }
        }
        errorMessage = fatalErr.message
        // 子轮错误由父轮包装成 tool_result 结论回灌、并把 Task 卡定格为 error，
        // 不在主对话流里再画一个红框。
        if (!isSub) emit(turnId, sessionId, { type: 'error', kind: fatalErr.kind, message: fatalErr.message })
        interrupted = 'error'
        break reconnect
      }
      if (retryableDrop) {
        if (attempt >= MAX_RECONNECT) {
          errorMessage = isEn()
            ? `The connection kept dropping and ${MAX_RECONNECT} retries failed, so the reply was stopped.${lastDropReason ? ` Last error: ${lastDropReason}` : ''}`
            : `连接多次中断，已重试 ${MAX_RECONNECT} 次仍失败，已停止。${lastDropReason ? `最后一次错误：${lastDropReason}` : ''}`
          if (!isSub)
            emit(turnId, sessionId, {
              type: 'error',
              kind: 'network',
              message: errorMessage
            })
          interrupted = 'error'
          break reconnect
        }
        if (!isSub)
          emit(turnId, sessionId, {
            type: 'reconnecting',
            attempt: attempt + 1,
            max: MAX_RECONNECT
          })
        const backoff = retryAfterMs ?? 1000 * 2 ** attempt
        retryAfterMs = undefined
        const resumed = await delay(Math.min(backoff, RECONNECT_MAX_DELAY_MS), controller.signal)
        // 退避期间被中止：stream_reset 尚未发出，渲染层仍显示着这截残缺正文——照样落地，两侧一致。
        if (!resumed) {
          interrupted = 'aborted'
          break reconnect
        }
        // 通知渲染层丢弃本步已画出的残缺尾部，随后 continue 重发本步。
        // 子轮从未画出任何正文，若照发会误伤主对话里正在写的那段文本。
        if (!isSub) emit(turnId, sessionId, { type: 'stream_reset' })
        continue reconnect
      }
      break // 本步干净结束
    }

    // 落地本步助手消息（文本 + 工具调用）。被中止 / 出错打断时同样落地已收到的部分。
    const content: ContentPart[] = []
    if (assistantText) content.push({ type: 'text', text: assistantText })
    for (const tc of toolCalls)
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
    if (content.length) history.push({ role: 'assistant', content })
    if (assistantText) finalText = assistantText

    const cut: 'aborted' | 'error' | 'degenerate' | null =
      interrupted ?? (stopReason === 'aborted' || stopReason === 'error' ? stopReason : null)
    if (cut) {
      // 流里已收到完整的 tool_use 却来不及执行：补占位结果，否则历史里留下悬空 tool_use。
      if (toolCalls.length) {
        const parts: ContentPart[] = []
        await fillUnrun(toolCalls, parts, new Map(), cut)
        history.push({ role: 'user', content: parts })
      }
      args.onStep?.()
      return { text: finalText, stopReason: cut, errorMessage }
    }
    // 逐步落盘：此刻若带工具调用，tool_use 暂时悬空（结果还没跑出来）——期间崩溃也不怕，
    // 下次载入由 repairDanglingToolUses 自愈；换来的是长命令跑到一半强退时，正文不丢。
    const stepVisible = assistantText.trim() !== '' || toolCalls.length > 0
    if (stepVisible) producedVisible = true
    args.onStep?.()
    // 收尾请求答完即停：模型仍调了工具就补「未执行」结果（历史里不留悬空调用），也不再走截断续写 / 空回合追问。
    if (wrapUp) {
      if (toolCalls.length) {
        const parts: ContentPart[] = []
        await fillUnrun(toolCalls, parts, new Map(), wrapUp)
        history.push({ role: 'user', content: parts })
        args.onStep?.()
      }
      return { text: finalText, stopReason: wrapUp }
    }
    if (toolCalls.length === 0) {
      // 自愈③：输出撞上长度上限、本步却没有工具调用（只思考 / 正文写到一半）——不交还用户等
      // 「继续」，注入引导让模型续写或拆小，与工具参数截断共用连续计数，连续失败才兜底收场。
      if (stopReason === 'max_tokens') {
        truncatedStreak++
        if (truncatedStreak >= MAX_TRUNCATED_STREAK) return { text: finalText, stopReason }
        history.push({ role: 'user', content: truncatedNudge(assistantText.trim() !== '') })
        if (!isSub)
          emit(turnId, sessionId, {
            type: 'auto_retry',
            reason: 'truncated',
            attempt: truncatedStreak,
            max: MAX_TRUNCATED_STREAK - 1
          })
        args.onStep?.()
        continue
      }
      // 自愈④：自然结束却从头到尾没有任何可见输出 → 追问一次；仍为空才交还用户（显示「空回合」）。
      if ((stopReason === 'end_turn' || stopReason === 'stop') && !producedVisible && !emptyNudged) {
        emptyNudged = true
        history.push({ role: 'user', content: EMPTY_NUDGE })
        if (!isSub) emit(turnId, sessionId, { type: 'auto_retry', reason: 'empty', attempt: 1, max: 1 })
        args.onStep?.()
        continue
      }
      return { text: finalText, stopReason }
    }
    truncatedStreak = toolCalls.some((tc) => tc.truncated !== undefined) ? truncatedStreak + 1 : 0

    // 并行派发子任务（对标 Claude Code：同一条消息里的多个子任务真正并发跑）：先把本步全部
    // run_subagent / send_to_subagent 一次性启动，其余工具仍按原序串行。每个子任务在**自己完成的
    // 那一刻**定格自己那张 Task 卡（tool_result 按调用 id 归属，与完成先后无关）；回灌给模型的结果
    // 则在下面按原序 await，顺序稳定。
    const subRuns = new Map<string, Promise<{ conclusion: string; isErr: boolean }>>()
    if (allowSubagents)
      for (const tc of toolCalls)
        if (
          (tc.name === 'run_subagent' || tc.name === 'send_to_subagent') &&
          tc.truncated === undefined
        )
          subRuns.set(tc.id, runSubagentCall(tc))

    // 并行只读（对标 Claude Code：同一条消息里的多个只读调用并发执行）：仅当本步**全部**调用都是
    // 无副作用的内置只读工具时才预先并发启动——混有写入/命令时一律保持原序串行，免得读到写入前的旧内容。
    // 需要弹「挂载工作区」卡的调用不预跑（留给下面的闸门挂起处理）；读工具在闸门里恒放行，结果按原序回灌。
    const readRuns = new Map<string, Promise<ToolResult>>()
    if (
      toolCalls.length > 1 &&
      toolCalls.every((tc) => PARALLEL_READ_TOOLS.has(tc.name) && tc.truncated === undefined)
    )
      for (const tc of toolCalls) {
        if (depth === 0 && needsWorkspaceMount(tc.name, tc.args, ctx.workspaceRoot)) continue
        const p = executeTool(tc.name, tc.args, ctx)
        p.catch(() => {}) // 中止时余下结果不再被 await：防未处理拒绝；被 await 的照常抛出
        readRuns.set(tc.id, p)
      }

    // 本步结果里已给出用法的按需加载工具（同一步的 tool_search、先被拦下的调用、加载的技能）：
    // 后面被拦下的同名调用只提示去看，不重复附用法。
    const usageGiven = new Set<string>()
    for (const tc of toolCalls)
      if (tc.name === TOOL_SEARCH && tc.truncated === undefined)
        for (const n of searchedNames(tc.args)) if (pendingUsage.has(n)) usageGiven.add(n)

    // 逐个执行工具（过权限闸门），结果回灌为一条 user 消息
    const resultParts: ContentPart[] = []
    /**
     * 记下一次在闸门前就地处理的调用结果：回灌给模型的内容进 resultParts；给了 shown 就同时把摘要记进边车、
     * 发 tool_result 事件，界面据此定格这一步（不给 = 结果由别的事件呈现：问答卡、计划卡、Task 卡、待办清单）。
     */
    const deliver = (tc: { id: string; name: string }, r: LoopToolOutcome): void => {
      if (r.shown) {
        args.onToolSummary?.(tc.id, r.shown.summary)
        emit(turnId, sessionId, {
          type: 'tool_result',
          id: tc.id,
          name: r.shown.name ?? tc.name,
          summary: r.shown.summary,
          isError: r.shown.isError,
          ...(evMeta ?? {})
        })
      }
      resultParts.push({
        type: 'tool_result',
        toolUseId: tc.id,
        content: r.content,
        isError: r.isError,
        ...(r.listing ? { listing: r.listing } : {})
      })
    }

    // 成员工具（create_member / member_send / member_stop / read_main / report_to_main 与定时任务的交接工具）：
    // 只在工具表里有它时受理，不过权限闸门（只改会话属性、起后台回合、读主对话正文）。
    const memberCall = async (tc: StepToolCall): Promise<LoopToolOutcome> => {
      const r: MemberToolResult =
        args.memberTool && offeredTools.has(tc.name)
          ? await args.memberTool(tc).catch((e: unknown) => ({
              content: `执行失败：${(e as Error)?.message ?? String(e)}`,
              summary: '执行失败',
              isError: true
            }))
          : { content: `「${tc.name}」在当前对话中不可用，不要再调用。`, summary: '工具不可用', isError: true }
      return { content: r.content, isError: r.isError, listing: r.listing, shown: { summary: r.summary, isError: r.isError } }
    }

    /**
     * 在闸门前就地处理的工具：名字 → 处理函数。它们不过权限闸门，也不授予任何能力——此后每个真实工具调用
     * 仍照常过同一道闸门。返回 null = 本场景不受理，照常落到闸门（如定时任务里的 ask_user，由密封判定拒绝）。
     */
    const loopTools: Record<string, (tc: StepToolCall) => Promise<LoopToolOutcome | null>> = {
      // tool_search：给出按需加载工具的完整用法（见 tool-search.ts）。只读。
      [TOOL_SEARCH]: async (tc) => {
        const r = runToolSearch(tc.args, offeredTools)
        return { content: r.content, isError: r.isError, listing: r.listing, shown: { summary: r.summary, isError: r.isError } }
      },

      // exit_plan：模型提交计划、暂停循环等用户批准。批准仅让循环继续（工具集本就完整）。
      exit_plan: async (tc) => {
        if (depth > 0 || !interactive)
          // 子智能体 / 密封无头执行不参与计划审阅（无用户在场可批准；此为幻觉调用兜底）：指导性 no-op。
          return {
            content: interactive
              ? '子智能体无需 exit_plan；请直接完成分配的任务。'
              : '定时任务在自动执行中，无需也无法进行计划审阅；请直接完成本次任务。',
            isError: true
          }
        const pa = (tc.args ?? {}) as { plan?: unknown }
        const plan = typeof pa.plan === 'string' ? pa.plan : ''
        const verdict = await reviewPlan(turnId, sessionId, plan)
        const decision = verdict?.decision ?? null
        const feedback = verdict?.feedback
        // 决定存入 plans 边车（按 toolUseId），供重开还原计划卡；null=取消。仅主轮回调。
        args.onPlanDecided?.(tc.id, decision, feedback)
        if (decision === 'approve')
          return {
            content:
              '用户已批准计划。现在请按已批准的计划开始执行（写入/执行无需再征求授权）；计划含多个步骤时，先用 todo_write 列出待办清单再逐项推进。',
            isError: false
          }
        // 卡上直接写了回复 → 随结果回灌，循环不停、模型当轮回应（改计划重提 / 先答疑）；
        // 没写（远程通道只有按钮）→ 等用户下一条消息。
        if (decision === 'keep')
          return {
            content: feedback
              ? `用户暂不批准，对计划的回复如下：\n\n${feedback}\n\n请据此回应（暂不执行）：若是修改意见，调整计划后重新调用 exit_plan 提交；若是提问或想讨论，先直接回答，需要时再重新提交。回复中若有需要澄清的地方，先用 ask_user 问清。`
              : '用户希望继续完善计划（暂不执行）。请依据用户接下来的反馈调整计划；在收到新反馈前不要重复调用 exit_plan。',
            isError: false
          }
        if (decision === 'ignore')
          return {
            content: '用户忽略了这份计划：不要执行，也不要重新提交。请用一句话确认后结束本轮，等待用户的新指示。',
            isError: false
          }
        return { content: '用户取消了本次计划审阅。', isError: true }
      },

      // todo_write：只写会话边车（待办清单）、推送进度，无任何副作用。
      todo_write: async (tc) =>
        args.onTodoWrite
          ? args.onTodoWrite(tc.id, tc.args)
          : { content: '当前环境不提供待办清单；请直接完成任务。', isError: true },

      // ask_user：暂停循环等用户抉择，答复回灌为 tool_result（子轮与定时任务不受理）。
      ask_user: async (tc) => {
        if (!allowAskUser) return null
        const questions = parseAskQuestions(tc.args)
        const answers = await askUser(turnId, sessionId, questions)
        // 答案存入 asks 边车（按 toolUseId），供重开还原问答卡；null=取消。仅主轮回调。
        args.onAskAnswered?.(tc.id, answers)
        return {
          content:
            answers === null
              ? '用户取消了本次询问。'
              : '用户回答如下：\n' +
                questions
                  .map((q, i) => {
                    const a = (answers[i] ?? '').trim()
                    // 空答（可跳过题被留空）→ 明确告知模型自行合理默认，别再追问同一件事。
                    return `${i + 1}. ${q.question} → ${a || '（用户未作答，请用合理默认继续，勿再追问此项）'}`
                  })
                  .join('\n'),
          isError: false
        }
      },

      // skill：加载已启用技能的完整正文，作为 tool_result 回灌（技能内容是数据，其后每一步的真实工具调用仍照常
      // 过闸；allowed-tools 仅作建议文本，绝不自动提权）。
      skill: async (tc) => {
        const a = (tc.args ?? {}) as { name?: unknown }
        const wanted = typeof a.name === 'string' ? a.name.trim() : ''
        const found = wanted ? loadSkillInstructionsByName(wanted, personaId, hasTool) : null
        // 技能接着要用的按需加载工具：用法一并附上，省得再查一步（本步已给过的不重复）。
        const usages = found
          ? skillToolUsages(found.allowedTools, new Set([...pendingUsage].filter((n) => !usageGiven.has(n))))
          : null
        for (const n of usages?.names ?? []) usageGiven.add(n)
        const content = found
          ? `已加载技能「${found.name}」，请严格据此指令完成用户任务：\n\n${skillDirNote(found.dir)}${found.instructions}` +
            (usages ? `\n\n${usages.text}` : '')
          : `未找到名为「${wanted}」的可用技能。当前可用技能：${
              enabledSkillSummaries(personaId, hasTool).map((s) => s.name).join('、') || '（无）'
            }。`
        const summary = found ? `已加载技能「${found.name}」` : '未找到该技能'
        return { content, isError: !found, listing: usages?.listing, shown: { summary, isError: !found } }
      }
    }
    for (const n of [...MAIN_MEMBER_TOOLS, ...MEMBER_SIDE_TOOLS, HANDOFF_TOOL]) loopTools[n] = memberCall

    for (const tc of toolCalls) {
      // 中止：跳出而非 return——已跑完的工具结果（含刚被中止的那条命令的输出）要随历史落盘，
      // 余下未执行的由循环后的 fillUnrun 补占位。直接 return 会把 resultParts 整个丢掉。
      if (controller.signal.aborted) break

      // 参数残缺的调用：不过闸门、不执行，回灌失败结果让模型分段重来。
      if (tc.truncated !== undefined) {
        const cause = tc.cause ?? 'max_tokens'
        const label = BROKEN_CALL_LABEL[cause]
        deliver(tc, {
          content: truncatedCallResult(tc.name, tc.truncated, cause, truncatedStreak),
          isError: true,
          shown: { summary: label, isError: true }
        })
        continue
      }

      // 子智能体禁用工具兜底：普通子智能体的工具表里本就没有它们，fork 沿用主对话的完整工具表
      //（为共享提示缓存），只能在这里拦下。
      if (depth > 0 && SUBAGENT_EXCLUDED.has(tc.name)) {
        deliver(tc, {
          content: `子智能体不能使用「${tc.name}」，请直接完成分配的任务。`,
          isError: true,
          shown: { summary: '子智能体不可用', isError: true }
        })
        continue
      }

      // 没查用法就调用按需加载工具：不执行，附上完整用法请模型照着重调。界面上这一步是「查看用法」（见上方发
      // tool_call 处），不算失败；给模型的结果仍标为出错——这次调用确实没有执行。
      if (usageGated(tc.name)) {
        const r = usageGateResult(tc.name, usageGiven.has(tc.name))
        usageGiven.add(tc.name)
        deliver(tc, {
          content: r.content,
          isError: true,
          listing: r.listing,
          shown: { summary: USAGE_SUMMARY, isError: false, name: TOOL_SEARCH }
        })
        continue
      }

      // 闸门前就地处理的工具（见 loopTools）。只认自有属性：模型调用 toString 之类的名字不能落到原型链上。
      const loopTool = Object.prototype.hasOwnProperty.call(loopTools, tc.name) ? loopTools[tc.name] : undefined
      const handled = loopTool ? await loopTool(tc) : null
      if (handled) {
        deliver(tc, handled)
        continue
      }

      // run_subagent：本步的全部子任务已在进入本循环前**并行启动**（见上方 subRuns）；
      // 此处只按 toolCalls 原序等待各自结果并回灌，故模型看到的 tool_result 顺序稳定可预期。
      const pendingSub = subRuns.get(tc.id)
      if (pendingSub) {
        const sub = await pendingSub
        resultParts.push({
          type: 'tool_result',
          toolUseId: tc.id,
          content: sub.conclusion,
          isError: sub.isErr
        })
        continue
      }

      // 权限闸门（纯同步策略，零弹框）：所有工具一律放行，文件读写与命令执行不设任何限制（2026-10-09 起）。
      // 交互轮唯一的拒绝是「用户暂不挂载工作区」；密封轮另经 sealedDecision（排除交互/创建类工具）。
      let allowed: boolean
      let policyDenied = false
      let denyContent = '该操作被安全策略拒绝。'
      /** 非安全策略的拒绝（当前仅「用户暂不挂载工作区」）：徽标文案与安全底线拒绝区分开。 */
      let denySummary: string | null = null
      /** 挂载成功时给本次 tool_result 加的前言：系统提示词本轮已定格，必须在这里讲清新基准。 */
      let mountNote = ''

      // ── 挂载前置闸：未挂载工作区、且本次调用缺「相对路径基准」→ 暂停循环，请用户一键挂载。
      // 判据纯机械（tools.needsWorkspaceMount：落点能否解析），不猜工具语义——无 path 的调用
      // （取系统时间之类）永不命中，绝对路径一律放行，read_file / run_command 刻意不在其列。
      // 仅主轮交互式触发：密封轮无人应答（另走 sealedDecision），子轮同 ask_user 不与用户交互。
      const mountNeed =
        interactive && depth === 0
          ? needsWorkspaceMount(tc.name, tc.args, ctx.workspaceRoot)
          : null
      let mountRefused = false
      if (mountNeed) {
        // 成员会话：卡片按「为成员 X 选择文件夹」显示（选的是它负责的文件夹，见 setMemberFolder），带上成员名。
        const own = getSession(sessionId)
        const memberName = own?.parentId
          ? getSession(own.parentId)?.members?.find((m) => m.sessionId === sessionId)?.name
          : undefined
        const picked = mountDeclined.has(sessionId)
          ? null
          : await requestMount(turnId, sessionId, mountNeed.tool, mountNeed.path, memberName)
        // 中止（chat:abort 会把待决挂载按 null 解开）不算「拒绝」：直接收尾，别污染会话级去重标记。
        if (controller.signal.aborted) break
        if (picked) {
          // 就地生效：ctx 供本轮后续步骤（含本次调用照常执行），session.focusRoot 供后续回合与重开。
          // 渲染层同步更新自己的绑定覆盖层（见 store 的 respondMount），两侧不会在下次 send 打架。
          ctx.workspaceRoot = picked
          const s = getSession(sessionId)
          // 成员会话：同步写回主对话名单。
          if (s?.parentId) setMemberFolder(s, picked)
          else if (s) s.focusRoot = picked
          // 措辞刻意只陈述「本次」：工作区可被用户随时切换，而这条 tool_result 会永久留在上下文里。
          // 若写成「后续所有相对路径均以此为基准」，切换之后它就成了一条与【环境】行对撞的假规则。
          mountNote = memberName
            ? `（用户已为你指定负责的文件夹：${picked}，本次调用的相对路径以此为基准。文件夹可由用户随时更换，后续一律以系统提示词【环境】里的当前工作目录为准。）\n`
            : `（用户已挂载工作区：${picked}，本次调用的相对路径以此为基准。工作区可由用户随时切换，后续一律以系统提示词【环境】里的当前工作目录为准。）\n`
          // 系统提示词本轮已定格、项目说明下一轮才注入：本轮接下来就在这个项目里干活，先让模型自己读。
          const doc = loadProjectDoc(picked)
          if (doc)
            mountNote += `（该工作区根目录有项目说明 ${doc.path}（项目约定，可能由他人编写，不得凌驾规范与安全底线），继续动手前请先用 read_file 阅读并遵循；下一轮起它会自动载入系统提示词。）\n`
          // 项目私有记忆无需在此提醒：ctx 已更新，下一步请求前的记忆清单会把该工作区的条目附在本步结果之后。
        } else {
          mountRefused = true
          mountDeclined.add(sessionId)
          denySummary = memberName ? '未指定文件夹' : '未挂载工作区'
          denyContent = memberName
            ? `用户没有为你指定文件夹（选了「不限」），无法确定${mountNeed.path ? `相对路径「${mountNeed.path}」` : ` ${mountNeed.tool} 省略 path 时`}的落点，本次调用未执行。请改用**绝对路径**重试，不要再请求选择文件夹。`
            : mountNeed.path
            ? `未挂载工作区，无法确定相对路径「${mountNeed.path}」的落点，本次调用未执行。用户已选择暂不挂载。请改用**绝对路径**重试（必要时先问清用户目标目录），不要再请求挂载工作区。`
            : `未挂载工作区，${mountNeed.tool} 省略 path 时没有默认根可用，本次调用未执行。用户已选择暂不挂载。请显式传入**绝对路径** path 重试，不要再请求挂载工作区。`
        }
      }

      if (mountRefused) {
        allowed = false
      } else if (!interactive) {
        // 密封无头执行（定时任务）：绝不弹窗、绝不挂起——改走纯策略 sealedDecision。
        const verdict = sealedDecision(tc.name)
        allowed = verdict.allowed
        if (!allowed) {
          policyDenied = true
          denyContent = verdict.denyContent
        }
      } else {
        allowed = true
      }

      if (!allowed) {
        const label = denySummary ?? (policyDenied ? '已拒绝（安全策略）' : '已拒绝')
        args.onToolSummary?.(tc.id, label)
        emit(turnId, sessionId, {
          type: 'tool_result',
          id: tc.id,
          name: tc.name,
          summary: label,
          isError: true,
          ...(evMeta ?? {})
        })
        resultParts.push({
          type: 'tool_result',
          toolUseId: tc.id,
          content: denyContent,
          isError: true
        })
        continue
      }

      // 文件检查点：写入类工具执行前备份原文件、执行后结算；run_command 只记命令文本（影响不可撤销，
      // 回滚面板据此提示）。子轮的记录归到父级 run_subagent 的 id，随父轮一起回滚。
      // 记录失败只告警，**绝不影响工具执行**。
      const cat = toolCategory(tc.name)
      const recorder = args.recorder
      const owner = depth > 0 && parentToolId ? parentToolId : tc.id
      let snap: WriteSnap | null = null
      if (recorder && cat === 'edit' && !isMcpTool(tc.name)) {
        try {
          snap = await recorder.before(tc.name, tc.args, ctx.workspaceRoot)
        } catch (e) {
          console.warn('[checkpoints] 备份失败：', e)
        }
      }

      // MCP 工具走连接管理器（callTool + 超时 + 取消，结果恒作数据）；内置工具走本地执行器。
      // MCP 只认本轮工具表里有的：路由表里有所有已连接服务的工具，只给别的角色用的不能被模型凭名字调到
      // （历史里可能留着可用范围收窄之前的调用）。
      const prefetched = readRuns.get(tc.id)
      const res: ToolResult = prefetched
        ? await prefetched
        : isMcpTool(tc.name)
          ? offeredTools.has(tc.name)
            ? await dispatchMcpTool(tc.name, tc.args, ctx.signal, ctx.sessionId)
            : {
                content: `MCP 工具「${tc.name}」在当前对话中不可用（没有提供给这个角色，或服务已断开），不要再调用。`,
                summary: '工具不可用',
                isError: true
              }
          : await executeTool(tc.name, tc.args, ctx)
      if (recorder) {
        try {
          if (snap) await recorder.after(snap, owner)
          else if (cat === 'exec') {
            const command = (tc.args as { command?: unknown } | null)?.command
            if (typeof command === 'string' && command.trim()) recorder.exec(command, owner)
          }
        } catch (e) {
          console.warn('[checkpoints] 记录失败：', e)
        }
      }
      if (res.summary) args.onToolSummary?.(tc.id, res.summary)
      // 交付文件：解析后的路径记入会话边车（须在发 tool_result 之前——渲染层收到成功即来取）。
      // 历史里保留模型原样发出的参数，见 StoredSession.delivered。
      if (res.delivered && !isSub) {
        const s = getSession(sessionId)
        if (s) s.delivered = { ...s.delivered, [tc.id]: res.delivered }
      }
      emit(turnId, sessionId, {
        type: 'tool_result',
        id: tc.id,
        name: tc.name,
        summary: res.summary,
        isError: Boolean(res.isError),
        ...(evMeta ?? {})
      })
      resultParts.push({
        type: 'tool_result',
        toolUseId: tc.id,
        // mountNote 仅在本次调用触发了挂载时非空：告诉模型相对路径基准已变（本轮系统提示词定格在
        // 「未挂载」，不这样讲清楚它会继续按未挂载的指引走）。
        content: mountNote + res.content,
        isError: res.isError,
        ...(res.images?.length ? { images: res.images } : {}),
        // 记忆写入 / 删除的结果本身就告知了变化：记录随结果落盘，记忆清单折叠时据此不再重复告知。
        ...(res.listing ? { listing: res.listing } : {})
      })
    }
    const abortedHere = controller.signal.aborted
    if (abortedHere) await fillUnrun(toolCalls, resultParts, subRuns, 'aborted')
    // 原地打转判定（见 shared/limits.ts）：按调用原序比对指纹，算在附提醒之前（提醒不进指纹）。到 REPEAT_STOP 次
    // 就不再附提醒——下一步开头 wrapUp 改发收尾请求。中止时不计（结果是「未执行」占位，不代表模型的选择）。
    if (!abortedHere)
      for (const tc of toolCalls) {
        const part = resultParts.find(
          (p): p is Extract<ContentPart, { type: 'tool_result' }> =>
            p.type === 'tool_result' && p.toolUseId === tc.id
        )
        if (!part) continue
        const key = callFingerprint(tc.name, tc.args, part)
        repeat = key === repeat.key ? { ...repeat, count: repeat.count + 1 } : { key, count: 1, tool: tc.name }
        // 记下而非现读 repeat：同一步里排在后面的不同调用会把计数清零。
        if (repeat.count >= REPEAT_STOP) stuckOn ??= { tool: tc.name, count: repeat.count }
        else if (repeat.count >= REPEAT_WARN) part.content += repeatReminder(tc.name, repeat.count)
      }
    // 期间结束的后台子智能体：通知附在本步工具结果之后（tool_result 在前），模型下一步即可看到。
    // 中止时不取，留给下一轮。
    const notices = abortedHere ? null : (args.takeNotices?.() ?? null)
    if (notices) resultParts.push({ type: 'text', text: notices })
    // 回合进行中用户插入的消息：同样附在本步工具结果之后（排在通知后面，离模型的下一步最近）。中止时不取，
    // 由回合收尾退回输入框。
    const inserted = abortedHere ? null : (args.takeInserts?.() ?? null)
    if (inserted) {
      resultParts.push({ type: 'text', text: insertText(inserted, isEn()) })
      emit(turnId, sessionId, { type: 'insert', text: plainTaskText(inserted) })
    }
    history.push({ role: 'user', content: resultParts })
    args.onStep?.()
    if (abortedHere) return { text: finalText, stopReason: 'aborted' }
    // 连续截断到上限：失败结果已回灌（历史里没有悬空调用），就此收场，渲染层照常显示「已截断」。
    if (truncatedStreak >= MAX_TRUNCATED_STREAK) return { text: finalText, stopReason: 'max_tokens' }
  }
}
