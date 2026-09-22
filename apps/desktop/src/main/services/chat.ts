import { ipcMain, type BrowserWindow } from 'electron'
import { streamChat } from '../providers'
import type { ContentPart, Message, StopReason, ToolSpec } from '../providers/types'
import {
  executeTool,
  isMcpTool,
  writeTargetPath,
  toolCategory,
  toolSpecs,
  buildPlanTool,
  type ToolContext,
  type ToolResult
} from './tools'
import { isDangerousCommand } from './exec-policy'
import { enabledSkillSummaries, loadSkillInstructionsByName } from './skills'
import { enabledAgentSummaries, getEnabledAgentByName, type AgentRecord } from './agents'
import { enabledPersonas, getPersona } from './personas'
import { resolveDefaultModel, resolveModelRef, resolveModelRefOrNull } from './model-resolve'
import { sealedDecision } from './sealed'
import { createTask, type CreateTaskResult } from './tasks'
import type { TaskCreateInput, TaskRecord } from './tasks-types'
import { dispatchMcpTool, getMcpToolSpecs } from './mcp'
import {
  isInsideRoot,
  isProtectedPath,
  isSensitivePath,
  trustRoot,
  untrustRoot
} from './fs-guard'
import {
  deriveTitle,
  ensureSession,
  getSession,
  deleteSession as deleteStoredSession,
  listSessions,
  save as saveProject,
  type ChatSessionMeta,
  type StoredNotice,
  type StoredSession
} from './chat-store'
import { ATTACH_TEXT_PREFIX, buildAttachmentPart } from './attachments'
import {
  compactSession,
  isCompactionSummary,
  needsCompaction,
  stripMarker,
  type CompactStatus
} from './compaction'

/**
 * 会话编排（Agent 主循环）。
 * 流式生成 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续，直至模型不再调用工具
 * （主轮不设步数上限，对标 Claude Code 的 agentic loop；子轮保留安全上限，见 runAgentLoop 调用处）。
 * 对话历史只存主进程（sessions），渲染层仅发新用户文本；工具/密钥/文件访问都在主进程内闭环。
 */

type AdapterKind = 'anthropic' | 'openai' | 'responses'

interface ChatModelConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
  model: string
}

interface ChatSendRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
  workspaceRoot: string | null
  /** 用户经原生选择框挑选的附件绝对路径（正文由主进程读取，base64 不经渲染层）。 */
  attachments?: string[]
  /**
   * 对话优先外壳：本对话绑定的 persona id（首发落库时绑定，一对话一身份）。
   * 缺省 = 旧 AppShell 路径（叠加式 enabledPersonas，无单身份注入）。
   */
  personaId?: string
  /**
   * 本对话的聚焦工作区绝对路径；null/缺省 = 全机通用助手（无聚焦）。
   * 「挂载目录」是纯粹的对话属性：决定聚焦工作区、终端 cwd、权限作用域键，与「对话存哪里/列不列」无关
   * （对话已无分桶概念）。
   */
  focusRoot?: string | null
  /**
   * 本对话的模型引用 `"providerId:modelId"`；缺省 = 不改（沿用会话已存值）；空串 = 显式回落全局默认。
   * **快照固定 / 只改当前对话**：新建对话由渲染层带上角色偏好快照；聊天中切换模型即随本字段更新（仅本
   * 对话）。runTurn 经 resolveModelRef(session.model, model) 解析，删除的模型自动回落 model（全局默认）。
   */
  modelRef?: string
}

/** 手动 /compact 请求：无用户文本、无后续模型轮，只压缩历史并回发结果事件。 */
interface ChatCompactRequest {
  sessionId: string
  model: ChatModelConfig
  workspaceRoot: string | null
}

/** 立即建档一条空对话（对话优先外壳：绑定信息随之落库，首发前即持久化）。见 chat:create-session。 */
interface ChatCreateSessionRequest {
  sessionId: string
  workspaceRoot: string | null
  personaId?: string
  focusRoot?: string | null
  modelRef?: string
}

/** 角色名片草稿：propose_agent 原始参数归一化后的形状（编辑器/名片消费）。 */
export interface AgentDraft {
  name: string
  desc: string
  color: string
  model: string
  prompt: string
}

/** 归一化 propose_agent 的原始参数为角色草稿：description→desc、补空 model、缺省 color。
 * 头像不由 LLM 提议（无从得知部件词表）：名片按 name 确定性渲染，用户接受后可在编辑器定制。 */
function normalizeAgentDraft(input: unknown): AgentDraft {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    name: str(a.name).trim(),
    desc: str(a.description).trim(),
    color: str(a.color).trim() || '#4f8cff',
    model: '',
    prompt: str(a.prompt)
  }
}

/**
 * 定时任务确认名片草稿：create_task 原始参数归一化后的形状（名片/编辑器消费）。
 * schedule 扁平化为恒有 at/cron/tz 字符串（不适用者为空串），便于编辑器双向绑定；tz 空 = 创建时按本地时区补。
 * 授权信封（personaId/modelRef）不由模型提议——由用户在名片里议定，此草稿只承载模型的建议部分。
 */
export interface AutotaskDraft {
  title: string
  prompt: string
  schedule: { kind: 'once' | 'recurring'; at: string; cron: string; tz: string }
}

/**
 * chat:resolve-autotask 的返回：create 成功带已建任务 id；dismiss 成功；失败带稳定错误码（渲染层本地化）。
 * 错误码含 createTask 的全部码 + 编排层的 no-session / no-input。
 */
export type ResolveAutotaskResult =
  | { ok: true; status: 'created'; taskId: string }
  | { ok: true; status: 'dismissed' }
  | {
      ok: false
      error:
        | 'invalid-input'
        | 'invalid-tz'
        | 'invalid-cron'
        | 'invalid-once'
        | 'expired'
        | 'no-session'
        | 'no-input'
    }

/** 归一化 create_task 的原始参数为定时任务草稿。日程校验/时区补全留待创建时（createTask + 渲染层）。 */
function normalizeAutotaskDraft(input: unknown): AutotaskDraft {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const sched = (a.schedule && typeof a.schedule === 'object' ? a.schedule : {}) as Record<
    string,
    unknown
  >
  const schedKind = sched.kind === 'once' ? 'once' : 'recurring'
  return {
    title: str(a.title).trim(),
    prompt: str(a.prompt),
    schedule: {
      kind: schedKind,
      at: str(sched.at).trim(),
      cron: str(sched.cron).trim(),
      tz: str(sched.tz).trim()
    }
  }
}

/** 重建历史用的展示消息（主进程从 provider Message[] 归约，去掉 base64 负载）。 */
type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }
  /**
   * 弱化提示气泡：compacted=较早历史已压缩（由 messages 里的摘要标记还原）；
   * truncated=达输出上限被截断 / empty=通篇无回复（由 StoredNotice 边车还原）。
   */
  | { kind: 'notice'; code: 'compacted' | 'truncated' | 'empty' }
  /** 请求失败红框：由 StoredNotice 边车还原（原样展示错误文案）。 */
  | { kind: 'error'; message: string }
  /** 角色名片：propose_agent 的提议。status 终态（accepted/rejected）由 StoredSession.proposals 边车持久化。 */
  | { kind: 'agentcard'; id: string; draft: AgentDraft; status: 'pending' | 'accepted' | 'rejected' }
  /**
   * 定时任务确认名片：create_task 的提议。status 终态（created/dismissed）由 StoredSession.autotasks 边车持久化，
   * taskId 记已创建任务 id（供名片「打开该任务会话」跳转）。pending = 待用户在名片里议定授权后创建。
   */
  | {
      kind: 'autotaskcard'
      id: string
      draft: AutotaskDraft
      status: 'pending' | 'created' | 'dismissed'
      taskId?: string
    }
  /**
   * ask_user 询问：重建为问答卡。问题从 tool_use 入参重解析，答案由 StoredSession.asks 边车还原。
   * answers 有值（含空数组）= 已答/已取消（渲染为「已答态·逐题回述」，不可交互）；
   * null = 取消/中止（渲染层归一为空数组作已答态）；undefined = 从未答复（罕见：闭应用于问询挂起时）。
   */
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] | null }
  /**
   * exit_plan 计划卡：重建为待批准/已决的计划审阅卡。计划正文从 tool_use 入参（input.plan）还原，
   * decision 由 StoredSession.plans 边车还原（'approve'/'keep'/null=未决）。
   */
  | { kind: 'plan'; id: string; plan: string; decision?: 'approve' | 'keep' | null }

export type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

/** StoredNotice → 展示消息（一条独立的 assistant 气泡，仅含该提示块）。 */
function noticeToDisplay(nt: StoredNotice): DisplayMessage {
  if (nt.kind === 'error')
    return { role: 'assistant', blocks: [{ kind: 'error', message: nt.message ?? '请求失败。' }] }
  return { role: 'assistant', blocks: [{ kind: 'notice', code: nt.code ?? 'empty' }] }
}

/**
 * provider Message[] → 展示消息序列（供切换/重开会话时重建气泡）。
 * 工具结果回灌消息不单独成气泡，而是回填上一条 assistant 的工具卡状态；
 * 附件仅重建为「名称 + 类型」的贴片（不回传 base64）。思考块为易逝态，不重建。
 * `notices` 边车（错误红框 / 截断 / 空回合）按 after 位置就地插回——它们不在 messages 里
 * （不属于模型上下文），此处还原后重开对话即可再见，而不再只剩自己发的消息。
 */
function toDisplayMessages(
  messages: Message[],
  proposals: Record<string, 'accepted' | 'rejected'> = {},
  notices: StoredNotice[] = [],
  asks: Record<string, { answers: string[] | null }> = {},
  summaries: Record<string, string> = {},
  plans: Record<string, { decision: 'approve' | 'keep' | null }> = {},
  autotasks: Record<string, { status: 'created' | 'dismissed'; taskId?: string }> = {}
): DisplayMessage[] {
  const out: DisplayMessage[] = []
  let lastAssistant: Extract<DisplayMessage, { role: 'assistant' }> | null = null

  // 预扫：收集所有已存在 tool_result 的 toolUseId。用于判定 ask_user 是否「曾被答复过」——
  // 旧数据（本次修复前建的对话）无 asks 边车但有 tool_result，据此仍渲染为已答态（逐题回落「未作答」），
  // 而非误显为一张可再次点选的交互卡。真正从未答复的（无 result 无边车）才留作交互态。
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_result') resultIds.add(p.toolUseId)
  }

  // after → 该位置应插入的提示（一轮通常至多一条，用数组以防同位置多条）。
  const noticesAfter = new Map<number, StoredNotice[]>()
  for (const nt of notices) {
    const arr = noticesAfter.get(nt.after)
    if (arr) arr.push(nt)
    else noticesAfter.set(nt.after, [nt])
  }
  const flushNotices = (n: number): void => {
    const arr = noticesAfter.get(n)
    if (!arr) return
    for (const nt of arr) {
      out.push(noticeToDisplay(nt))
      // 提示气泡自成一条、不含工具卡，其后紧随新用户轮——断开 tool_result 回填链，避免误填。
      lastAssistant = null
    }
  }

  // 处理单条消息（早退用 return 代替原 for...of 的 continue，以便每条处理完统一 flush 提示）。
  const processOne = (m: Message): void => {
    if (m.role === 'assistant') {
      const parts: ContentPart[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      const blocks: DisplayBlock[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) blocks.push({ kind: 'text', text: p.text })
        else if (p.type === 'tool_use') {
          // propose_agent 铸成角色名片（惰性提议）；ask_user 铸成提问卡（含答复回填）；其余工具照常铸工具卡。
          if (p.name === 'propose_agent')
            blocks.push({
              kind: 'agentcard',
              id: p.id,
              draft: normalizeAgentDraft(p.input),
              status: proposals[p.id] ?? 'pending'
            })
          else if (p.name === 'create_task')
            blocks.push({
              kind: 'autotaskcard',
              id: p.id,
              draft: normalizeAutotaskDraft(p.input),
              status: autotasks[p.id]?.status ?? 'pending',
              taskId: autotasks[p.id]?.taskId
            })
          else if (p.name === 'ask_user')
            blocks.push({
              kind: 'ask',
              id: p.id,
              questions: parseAskQuestions(p.input),
              // 有边车 → 用边车答复（null=取消）；无边车但有 tool_result（旧数据）→ 空数组占位，
              // 逐题回落「未作答」；两者皆无（真正未答复）→ undefined，重开后仍是可交互卡。
              answers: asks[p.id] ? asks[p.id].answers : resultIds.has(p.id) ? [] : undefined
            })
          else if (p.name === 'exit_plan')
            blocks.push({
              kind: 'plan',
              id: p.id,
              plan: typeof (p.input as { plan?: unknown })?.plan === 'string'
                ? ((p.input as { plan: string }).plan)
                : '',
              // 有边车 → 用边车决定（null=中止未决）；无边车但有 tool_result（旧数据）→ 视为已决（keep）占位；
              // 两者皆无（真正未决，罕见）→ undefined，重开后只读展示。
              decision: plans[p.id] ? plans[p.id].decision : resultIds.has(p.id) ? 'keep' : undefined
            })
          else
            blocks.push({
              kind: 'tool',
              id: p.id,
              name: p.name,
              args: p.input,
              status: 'ok',
              summary: summaries[p.id]
            })
        }
      }
      // 同一轮内、仅被 tool_result 隔开的连续 assistant 段并入上一条展示气泡（与流式「一轮一头像」对齐）：
      // 有工具调用时，一轮在持久化历史里是多条 assistant 被 tool_result(user) 隔开，逐条成气泡会让重开后
      // 每段各显一个头像（像输出了多次）。lastAssistant 非空即代表「自上条 assistant 起只隔了 tool_result
      // 回灌」——真实用户轮 / 压缩摘要 / 提示气泡都会把它置空，从而使其后的 assistant 另起新气泡（新头像）。
      if (lastAssistant) {
        lastAssistant.blocks.push(...blocks)
      } else {
        const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks }
        out.push(msg)
        lastAssistant = msg
      }
      return
    }

    // user

    // 压缩摘要（带标记的 user 消息）：Codex 式重开——只呈现「已压缩」提示 + 摘要正文，
    // 不重建被压缩掉的早期气泡（与真正发给模型的内容一致）。渲染为一条 assistant 展示消息，
    // 且置 lastAssistant=null（它无工具块、其后紧跟真实用户轮，不会被 tool_result 回填）。
    if (isCompactionSummary(m) && typeof m.content === 'string') {
      out.push({
        role: 'assistant',
        blocks: [
          { kind: 'notice', code: 'compacted' },
          { kind: 'text', text: stripMarker(m.content) }
        ]
      })
      lastAssistant = null
      return
    }

    if (typeof m.content === 'string') {
      out.push({ role: 'user', text: m.content, attachments: [] })
      // 真实用户轮：断开 assistant 合并链，其后的 assistant 段另起新气泡（新头像）。
      lastAssistant = null
      return
    }
    const parts = m.content
    if (parts.some((p) => p.type === 'tool_result')) {
      // 工具结果回灌：回填上一条 assistant 的工具卡状态，不生成气泡
      if (lastAssistant) {
        for (const p of parts) {
          if (p.type !== 'tool_result') continue
          const b = lastAssistant.blocks.find(
            (x): x is Extract<DisplayBlock, { kind: 'tool' }> => x.kind === 'tool' && x.id === p.toolUseId
          )
          if (b) b.status = p.isError ? 'error' : 'ok'
        }
      }
      return
    }

    // 真实用户消息（可能带附件）：附件在前、提问正文在最后一个 text 块
    const atts: { name: string; kind: 'image' | 'document' | 'text' }[] = []
    const textParts = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    for (const p of parts) {
      if (p.type === 'image') atts.push({ name: p.name ?? '图片', kind: 'image' })
      else if (p.type === 'document') atts.push({ name: p.name ?? '文档', kind: 'document' })
    }
    for (let i = 0; i < textParts.length - 1; i++) {
      const tp = textParts[i]
      if (tp.text.startsWith(ATTACH_TEXT_PREFIX))
        atts.push({ name: tp.text.slice(ATTACH_TEXT_PREFIX.length).split('\n')[0].trim(), kind: 'text' })
    }
    const question = textParts.length ? textParts[textParts.length - 1].text : ''
    out.push({ role: 'user', text: question, attachments: atts })
    // 真实用户轮：断开 assistant 合并链，其后的 assistant 段另起新气泡（新头像）。
    lastAssistant = null
  }

  // 提示可能锚在最前（after=0，几乎不出现）、任意消息之后、或全部消息之后（after=length，最常见）。
  flushNotices(0)
  for (let i = 0; i < messages.length; i++) {
    processOne(messages[i])
    flushNotices(i + 1)
  }
  return out
}

/**
 * 一条 provider 消息是否为「一轮的起点」（= 一条真实用户消息，恰好对应展示层一个用户气泡）。
 * 排除：assistant 消息；压缩摘要（带标记的 user 字符串消息，展示为 assistant 气泡）；
 * 工具结果回灌消息（user 角色但含 tool_result，展示层并入上一条 assistant、不单独成气泡）。
 * 与 toDisplayMessages 的判定同源，故「数用户气泡」在渲染层与主进程逐一对齐——轮下标据此天然一致。
 */
function isTurnStart(m: Message): boolean {
  if (m.role !== 'user') return false
  if (isCompactionSummary(m)) return false
  if (typeof m.content === 'string') return true
  return !m.content.some((p) => p.type === 'tool_result')
}

/**
 * 把 messages 划分为「轮」区间（end 独占）。第 k 个区间 = 第 k 轮（0 基，与展示层用户气泡序一致）：
 * 从某轮起点起、直到下一轮起点前的全部消息（含该轮的工具调用与其结果）都归入本轮。
 * 首个轮起点之前的消息（如压缩摘要前言）不属于任何轮、不在返回区间内——故按轮删不会误删前言。
 */
function turnRanges(messages: Message[]): { start: number; end: number }[] {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (isTurnStart(messages[i])) starts.push(i)
  const ranges: { start: number; end: number }[] = []
  for (let k = 0; k < starts.length; k++)
    ranges.push({ start: starts[k], end: k + 1 < starts.length ? starts[k + 1] : messages.length })
  return ranges
}

/**
 * 按「轮」删除对话（同步删除模型上下文）。turnIndices 为 0 基轮下标集合（越界者忽略）。
 * 就地重写 s.messages，并同步：① 重锚/丢弃 notices 边车；② 清理按 toolUseId 记录的边车
 * （proposals/asks/summaries）——只保留仍存活的 tool_use。
 * **边界安全**：整轮删除天然不切断 tool_use↔tool_result（一轮的工具调用与其结果同处该轮区间内），
 * 故删除后剩余序列不会出现「有 tool_use 无 tool_result」或反之的悬挂对。
 */
function deleteTurns(s: StoredSession, turnIndices: number[]): void {
  const ranges = turnRanges(s.messages)
  const del = new Set(turnIndices.filter((k) => Number.isInteger(k) && k >= 0 && k < ranges.length))
  if (del.size === 0) return

  const old = s.messages
  const toDelete = new Set<number>()
  for (const k of del) for (let i = ranges[k].start; i < ranges[k].end; i++) toDelete.add(i)

  // 删空全部轮：连同前言（压缩摘要等预备区，不属任何轮）一并清空——否则残留孤立前言。
  // 仅「全部轮均被删」才清前言；否则前言随其后仍存活的首轮保留。
  if (del.size === ranges.length) {
    s.messages = []
    s.notices = []
    s.proposals = {}
    s.asks = {}
    s.summaries = {}
    s.plans = {}
    s.autotasks = {}
    s.updatedAt = Date.now()
    return
  }

  s.messages = old.filter((_, i) => !toDelete.has(i))

  // 重锚 notices：after 语义 = 提示前方的消息条数（锚点消息下标 = after-1）。
  //  after=0（锚在最前）恒保留；锚点消息被删 → 丢弃该提示；否则新 after = 存活消息中「旧下标 < after」的条数。
  if (s.notices?.length) {
    const survivingBefore = (afterOld: number): number => {
      let c = 0
      for (let i = 0; i < afterOld && i < old.length; i++) if (!toDelete.has(i)) c++
      return c
    }
    s.notices = s.notices
      .filter((nt) => nt.after === 0 || !toDelete.has(nt.after - 1))
      .map((nt) => (nt.after === 0 ? nt : { ...nt, after: survivingBefore(nt.after) }))
  }

  // 清理按 toolUseId 的边车：只保留仍存活消息里出现的 tool_use id。
  const liveUseIds = new Set<string>()
  for (const m of s.messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_use') liveUseIds.add(p.id)
  }
  const prune = <T>(rec?: Record<string, T>): Record<string, T> | undefined => {
    if (!rec) return rec
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(rec)) if (liveUseIds.has(k)) out[k] = v
    return out
  }
  s.proposals = prune(s.proposals)
  s.asks = prune(s.asks)
  s.summaries = prune(s.summaries)
  s.plans = prune(s.plans)
  // autotasks 边车随名片 tool_use 存活；删除对话轮不删已创建的定时任务本体（任务独立生命周期，经「定时任务」页管理）。
  s.autotasks = prune(s.autotasks)
  s.updatedAt = Date.now()
}

/** ask_user 的候选项（description 为可选补充说明）。 */
interface AskOption {
  label: string
  description?: string
}

/** ask_user 的单个问题：题干 + 候选项 + 是否多选 + 是否必答。 */
interface AskQuestion {
  question: string
  options: AskOption[]
  /** true=多选（可勾多项）；false=单选。 */
  multi: boolean
  /** false=可跳过（允许空答，回灌「未作答」交由模型合理默认）；缺省/true=必答。 */
  required: boolean
}

interface AskResponse {
  key: string
  /** 用户对每个问题的答复（answers[i] 对应 questions[i]，选中项或自由输入）；null 表示取消/中止。 */
  answers: string[] | null
}

/** 用户对 exit_plan 计划审阅的决定：approve=批准并执行 / keep=继续完善。 */
interface PlanResponse {
  key: string
  decision: 'approve' | 'keep'
}

/**
 * 判定某选项 label 是否与界面内置的「自己输入」入口重复。界面每题都会追加该伪选项，
 * 模型仍常自作主张塞一个「自己输入 / 自定义 / 手动输入 / Custom / Enter your own」——需剔除以免重复。
 * 刻意只认「明确表示自行打字」的兜底措辞：`其他/Other` 这类含糊词可能是真实业务分类，
 * 交由工具描述约束、不在此自动过滤，避免误伤合法选项。
 */
const CUSTOM_ENTRY_LABELS = new Set([
  '自己输入',
  '自行输入',
  '自定义',
  '自定义输入',
  '自定义答案',
  '手动输入',
  '手动填写',
  '手动录入',
  '手填',
  'custom',
  'custom input',
  'custom answer',
  'enter your own',
  'type your own',
  'enter manually',
  'input manually'
])
function isCustomEntryLabel(label: string): boolean {
  // 归一：去首尾空白与尾部省略号/标点（…/./。/:/：），再小写比对。
  const k = label
    .trim()
    .replace(/[…\.。:：\s]+$/u, '')
    .toLowerCase()
  return CUSTOM_ENTRY_LABELS.has(k)
}

/**
 * 把模型给的「选项」值健壮地归一成 AskOption[]。刻意宽容：不同模型对候选项的写法五花八门，
 * 若只认「对象且 label 为字符串」会把纯字符串数组 / 别名键（value/title/text/name）全部静默丢掉，
 * 表现为「有问题却无选项、只剩自由输入」。这里逐项归一，尽量不丢用户本可点选的项。
 * 末尾剔除与内置「自己输入」入口重复的兜底项。
 */
function normalizeOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const out: AskOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ label })
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const labelKey = ['label', 'value', 'title', 'text', 'name'].find(
        (k) => typeof o[k] === 'string' && (o[k] as string).trim()
      )
      if (!labelKey) continue
      const label = (o[labelKey] as string).trim()
      const description =
        typeof o.description === 'string' && o.description.trim() ? o.description : undefined
      out.push({ label, description })
    }
  }
  return out.filter((o) => !isCustomEntryLabel(o.label))
}

/**
 * 题干里表达「答案可留空」的口径（中英）。用于在模型漏设 required:false 时兜底识别为可选题。
 * 「可选」只认括号标记 [（(]可选[)）]，不认裸「可选」——避免误伤「可选方案/可选项」这类正常用词。
 */
const OPTIONAL_HINT_RE =
  /留空|选填|非必填|可不填|可不答|可跳过|可略过|可省略|无则不填|没有.{0,4}不填|[（(]\s*可选\s*[)）]|optional|leave\s+(?:it\s+|this\s+)?blank|if\s+(?:any|none)/i
/** 反向语：题干明说「不可留空/必填（排除『非必填』）」。命中则强制必答，抵消上面的误判。 */
const REQUIRED_HINT_RE = /(?<!非)必填|必须填|请勿留空|不要留空|不可留空|不能留空|勿留空/

/**
 * 判定某题是否可选（允许空答）。优先信模型显式的 required；未显式声明时，据题干口径兜底：
 * 出现「可留空/选填/optional」等且无「请勿留空/必填」反向语 → 视为可选。
 * 这弥补了「模型只在题干里用自然语言说可留空、却没设 required:false」导致界面强制必答的问题。
 */
function isQuestionOptional(question: string, explicit: unknown): boolean {
  if (explicit === false) return true
  if (explicit === true) return false
  return OPTIONAL_HINT_RE.test(question) && !REQUIRED_HINT_RE.test(question)
}

/**
 * 把 ask_user 工具入参健壮地解析成 AskQuestion[]。优先读多问格式 `questions`；
 * 若缺失/为空但存在顶层 `question`（旧式或跑偏调用），防御性收编成单元素；
 * 仍为空则兜底为一条通用问题——绝不向渲染层抛空卡。
 */
function parseAskQuestions(args: unknown): AskQuestion[] {
  const a = (args ?? {}) as { questions?: unknown; question?: unknown; options?: unknown }
  const out: AskQuestion[] = []
  if (Array.isArray(a.questions)) {
    for (const item of a.questions) {
      if (!item || typeof item !== 'object') continue
      const q = item as Record<string, unknown>
      const question = typeof q.question === 'string' && q.question.trim() ? q.question : ''
      const options = normalizeOptions(q.options)
      // 无题干但有选项时兜底题干，避免整条问题因题干缺失被丢；题干与选项都空的项才跳过。
      if (!question && options.length === 0) continue
      out.push({
        question: question || '请选择：',
        options,
        multi: Boolean(q.multiSelect),
        // required 默认 true；模型显式 required:false 或题干口径含「可留空/选填」等 → 视为可跳过。
        required: !isQuestionOptional(question, q.required)
      })
    }
  }
  // 防御回退：模型仍按旧式单问格式调用（顶层 question/options）。
  if (out.length === 0 && typeof a.question === 'string' && a.question.trim()) {
    out.push({ question: a.question, options: normalizeOptions(a.options), multi: false, required: true })
  }
  // 最终兜底：绝不发空问答卡。
  if (out.length === 0) out.push({ question: '请选择：', options: [], multi: false, required: true })
  return out
}

/** 发往渲染层的富事件（比 provider 的 StreamEvent 多了工具执行/权限阶段）。 */
export type ChatStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /** depth>0 + agent：本事件来自某子智能体（渲染层据此折叠进「子智能体任务」卡）。 */
  | { type: 'tool_call'; id: string; name: string; args: unknown; depth?: number; agent?: string }
  | {
      type: 'tool_result'
      id: string
      name: string
      summary: string
      isError: boolean
      /** depth>0 + agent：来自子智能体的工具结果（折叠进 Task 卡）。 */
      depth?: number
      agent?: string
    }
  /** 征求决策/澄清：暂停循环，向用户抛出一个或多个问题，等其一次性作答后回灌为 tool_result。 */
  | { type: 'ask_user'; key: string; questions: AskQuestion[] }
  /** 计划审阅：exit_plan 提交计划，暂停循环等用户批准（approve=批准后按计划执行 / keep=继续完善 / 取消）。 */
  | { type: 'plan_review'; key: string; plan: string }
  | { type: 'usage'; input: number; output: number }
  /** 连接中断、正在自动重连（transient；attempt/max 供 UI 显示进度）。 */
  | { type: 'reconnecting'; attempt: number; max: number }
  /** 重连前置：丢弃本步骤已画出的残缺尾部，随后重新流式（无法无缝续传，只能重发本步）。 */
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  /**
   * 上下文压缩结果（自动或手动 /compact）。渲染层据此在助手气泡追加软提示块；
   * status: compacted=已压缩 / none=无需压缩 / failed=失败（历史未动）。
   */
  | { type: 'compacted'; scope: 'auto' | 'manual'; status: CompactStatus; message?: string }
  | { type: 'done'; stopReason: StopReason }

// 主对话单轮工具步数上限：Infinity = 不设上限，一直循环到模型不再调用工具为止（对标 Claude Code 的
// agentic loop）。天然刹车 = 用户随时可中止（controller.signal，见 runAgentLoop 内的 aborted 判定）
// + 接近上下文上限时自动压缩（compaction）。子智能体不吃此值，另有自己的安全上限（见 run_subagent）。
const MAX_STEPS = Infinity
/** 单个步骤因可重试网络错误自动重连的最大次数。 */
const MAX_RECONNECT = 3

/** 可被取消打断的睡眠：正常到点 resolve(true)，signal 触发则 resolve(false)。 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const activeTurns = new Map<string, AbortController>()
/** 待用户答复的 ask_user 询问（键 → resolve + 所属轮次）；answers 为 null 表示取消/中止。 */
const pendingAsk = new Map<string, { resolve: (answers: string[] | null) => void; turnId: string }>()
/** 待用户批准的 exit_plan 计划审阅（键 → resolve + 所属轮次）；null 表示取消/中止。 */
const pendingPlan = new Map<
  string,
  { resolve: (decision: 'approve' | 'keep' | null) => void; turnId: string }
>()

let idCounter = 0
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

/** 定时任务密封执行一次的结果（返回给 scheduler 以构造运行记录）。 */
export interface ScheduledTurnResult {
  stopReason: StopReason
  /** 末轮可见文本（供 scheduler 派生运行摘要）。 */
  text: string
  /** 失败原因（stopReason==='error' 时）。 */
  errorMessage?: string
}

/**
 * 定时任务密封执行器（模块级桥接）。runScheduledTurn 是 registerChatIpc 内的闭包（捕获 emit /
 * activeTurns / runAgentLoop 等），而 scheduler.ts 在别处 import——用此模块级引用桥接：
 * registerChatIpc 一运行即挂上，scheduler 经 runScheduledTask 跨模块直调。未就绪即抛错，
 * 由 scheduler 捕获记一次错误运行（绝不崩）。
 */
let scheduledRunner: ((task: TaskRecord) => Promise<ScheduledTurnResult>) | null = null
export function runScheduledTask(task: TaskRecord): Promise<ScheduledTurnResult> {
  if (!scheduledRunner)
    return Promise.reject(new Error('chat runtime 尚未就绪（registerChatIpc 未运行）'))
  return scheduledRunner(task)
}

/**
 * 主智能体系统提示词，刻意分两块、职责不重叠：
 *  1) **系统默认提示词（规范）**：只声明本应用内的各类规范——环境、工具使用、授权、决策/澄清、技能。
 *     **不含**身份、性格、语气、行文风格、能力范围等——那些一律交给「角色设定」，避免与角色冲突
 *     （否则「你是 Deva 编程助手」会与角色「你是小酱…」双重身份，且窄化范围）。
 *  2) **角色设定（persona）**：本次对话的身份/性格/语气/行文风格/偏好。安全与工具规范**恒优先**于角色，
 *     角色绝不能借此关闭「切勿用文字征求授权」等铁律（前言明确框定这一边界）。
 */
function systemPrompt(
  workspaceRoot: string | null,
  skills: { name: string; description: string }[] = [],
  personas: { name: string; prompt: string }[] = []
): string {
  const loc = workspaceRoot
    ? `当前工作目录：${workspaceRoot}。路径可用相对该目录的写法。`
    : '当前未打开任何项目文件夹；涉及文件的操作需先请用户打开项目。'
  // ── ① 系统默认提示词：纯规范。开场句仅交代运行环境与「身份/风格见角色设定」，不作任何身份/风格规定。
  const lines = [
    personas.length
      ? '你运行在 Deva 桌面应用中，可通过工具读取/写入文件、执行命令、加载技能等来完成用户请求。以下是你在本应用内必须始终遵守的规范；你的身份、性格、语气与行文风格由后文的「角色设定」决定，本段不作规定。'
      : '你是 Deva，一个运行在用户桌面上的 AI 助手，可通过工具读取/写入文件、执行命令、加载技能等来完成用户请求。以下是你在本应用内必须始终遵守的规范。',
    `【环境】${loc}`,
    '【工具使用】先用 read_file / list_dir 了解现状再动手；write_file 会覆盖整个文件，务必先读后写、保留无关内容。需要动手时直接调用相应工具，不要只声明打算做什么便停下等待确认；若某次工具调用被用户拒绝，再据此说明或改用不需该操作的方式。',
    '【授权】要写入/修改文件或执行命令时，直接调用对应工具即可——应用会自动弹出授权界面，由用户在界面上点「允许」或「拒绝」。切勿在回复文字里询问「是否允许写入 / 是否同意覆盖 / 请确认」之类的话：用户无法用文字回复授权、只能通过授权按钮操作，用文字征求授权等于让操作卡死。',
    '【决策与澄清】当需求确有歧义、存在多个各有取舍的可行方案需用户抉择、或缺少无法合理默认的关键信息时，调用 ask_user 抛出一个或多个问题（每题可给候选项、可单选或多选，界面另有内置「自己输入」入口），用户在同一张卡片里一次性作答后回灌给你再继续；能合理默认就直接做，别为琐碎选择打断用户。注意区分：征求决策/澄清用 ask_user，征求写入/执行授权仍走上述授权按钮，切勿用 ask_user 去问「是否允许」。',
    '【计划先行】遇到非平凡的实现类任务（新功能、跨多文件改动、有多个各有取舍的方案、或需求尚不明确等），先用只读工具（read_file / list_dir / glob / grep / web_fetch）充分调研理解现状，再调用 `exit_plan` 提交一份面向用户批准的完整实施计划（Markdown）；**在计划获批前不要写入文件或执行命令**。用户批准后你直接按计划执行、无需再次征求授权（此后写入/执行仍会经权限确认）；用户若选择继续完善，请依其反馈调整后再重新提交，在收到新反馈前不要重复调用 exit_plan。琐碎、单点、只读或答疑类任务直接做，不必先出计划。'
  ]
  if (skills.length) {
    // 渐进式披露：此处只列「名称 + 一句话描述」；当任务匹配时，模型再调用 skill 工具取完整指令。
    lines.push(
      '【技能 Skills】当用户任务匹配下列某项技能时，先调用 `skill` 工具并传入其名称（name）获取该技能的完整操作指令，然后严格据此执行；用户也可用「/技能名」显式触发。',
      ...skills.map((s) => `  - ${s.name}${s.description ? `：${s.description}` : ''}`)
    )
  }
  // ── ② 角色设定：身份/性格/语气/行文风格/偏好。前言保留安全边界（角色不得凌驾上述规范）。
  if (personas.length) {
    lines.push(
      '───────── 角色设定 ─────────',
      '以下是本次对话的角色设定（身份、性格、语气、行文风格、偏好）。在不违反上述规范的前提下，请在本次对话中始终以该角色的身份与风格回应：',
      ...personas.map((p) => `【${p.name}】\n${p.prompt.trim()}`)
    )
  }
  return lines.join('\n')
}

/**
 * 密封无头执行（定时任务）的系统提示词：与 systemPrompt 同构，但**去掉一切「等用户」的指引**。
 * 定时任务在无人在场时自动触发，绝不能停下来等确认——故不提 ask_user / exit_plan / 授权按钮，
 * 改为明确告知：只用当前已授权的工具，基于合理默认自主完成，受限处在结论中说明，不要反问、不要等待。
 */
function sealedSystemPrompt(
  workspaceRoot: string | null,
  personas: { name: string; prompt: string }[] = []
): string {
  const loc = workspaceRoot
    ? `当前工作目录：${workspaceRoot}。路径可用相对该目录的写法。`
    : '本任务无固定工作目录；如需读写文件请使用**绝对路径**。'
  const lines = [
    personas.length
      ? '你运行在 Deva 桌面应用中，正在**自动执行一个用户预先设定的定时任务**（无人实时在场）。以下是你必须始终遵守的规范；你的身份、性格与行文风格由后文的「角色设定」决定。'
      : '你是 Deva，运行在用户桌面上的 AI 助手，正在**自动执行一个用户预先设定的定时任务**（无人实时在场）。以下是你必须始终遵守的规范。',
    `【环境】${loc}`,
    '【任务】按本次指令收集/整理信息或执行操作，给出条理清晰的结果；如需外部信息可使用 web_fetch 等工具。若是提醒类指令，直接给出清晰简洁的提醒正文（用户会通过系统通知看到）。',
    '【自动执行】本次为无人值守的自动执行：你**无法**向用户提问、征求授权或提交计划审阅（ask_user / exit_plan 均不可用，调用它们不会有人回应）。请基于合理默认自主完成任务，一次性给出最终结果，不要反问、不要停下等待确认。',
    '【工具与权限】读写文件、执行命令、调用已启用的技能与 MCP 工具默认均可使用，无需授权。唯有凭据/系统等敏感目录（Tier-1）、受保护目录（.git/.claude/.vscode）与危险命令会被安全策略拒绝——若某次调用被拒，请改用其它方式或在结论中说明受限之处，切勿反复重试同一被拒操作。',
    '【产出】用简洁、结构清晰的简体中文（除非角色设定另有风格）直接给出最终结果，作为本次任务的成果记录在对话中。'
  ]
  if (personas.length) {
    lines.push(
      '───────── 角色设定 ─────────',
      '以下是本任务的角色设定（身份、性格、语气、行文风格、偏好）。在不违反上述规范的前提下，请以该角色的身份与风格给出结果：',
      ...personas.map((p) => `【${p.name}】\n${p.prompt.trim()}`)
    )
  }
  return lines.join('\n')
}

/** 据已启用技能动态构建 skill 工具规格（无启用技能时返回 null，不向模型暴露）。 */
function buildSkillTool(skills: { name: string; description: string }[]): ToolSpec | null {
  if (!skills.length) return null
  const list = skills.map((s) => `${s.name}${s.description ? `（${s.description}）` : ''}`).join('；')
  return {
    name: 'skill',
    description:
      '加载并应用一个已启用「技能（Skill）」的完整操作指令。当用户任务匹配某技能时，调用本工具并传入其名称（name），即可获得该技能的详细步骤/规范，然后严格据此完成任务。' +
      `当前可用技能：${list}。`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载的技能名称（须为上述可用技能之一）。' }
      },
      required: ['name']
    }
  }
}

/** 据已启用子智能体动态构建 run_subagent 工具规格（无启用项时返回 null，不向模型暴露）。 */
function buildSubagentTool(agents: { name: string; description: string }[]): ToolSpec | null {
  if (!agents.length) return null
  const list = agents
    .map((a) => `${a.name}${a.description ? `（${a.description}）` : ''}`)
    .join('；')
  return {
    name: 'run_subagent',
    description:
      '把一项相对独立、需要隔离上下文的子任务，派发给一个预设的「子智能体（Subagent）」独立完成，只返回其最终结论。' +
      '适合大范围检索/梳理、专项分析等与主线相对独立的封闭子任务。子智能体拥有自己的系统提示词、工具集与模型，运行在隔离上下文中（看不到主对话历史），其内部每一次工具调用照常受权限约束。' +
      `当前可用子智能体：${list}。`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: '要派发到的子智能体名称（须为上述可用子智能体之一）。',
          enum: agents.map((a) => a.name)
        },
        prompt: {
          type: 'string',
          description:
            '交给该子智能体的完整任务描述。它看不到主对话历史，请把所需背景、目标与验收标准一次说清。'
        }
      },
      required: ['agent', 'prompt']
    }
  }
}

/**
 * 子智能体本轮可用工具集：内置工具（排除 ask_user / skill / run_subagent）为基。
 * - allowlist 为空 → 全部内置工具（不含 MCP，保守默认）。
 * - allowlist 非空 → 仅其中命中的内置工具 + 命中的已连接 MCP 工具。
 * 白名单只**收窄**可见工具；被保留的每个工具调用仍照常过同一道权限闸门（无提权）。
 */
function buildSubagentTools(allowlist: string[]): ToolSpec[] {
  // create_skill / propose_agent / create_mcp / create_task 亦排除：子智能体不得创建技能/角色/MCP 服务/定时任务
  //（它们在 toolSpecs 基表里，须显式剔除）。
  const EXCLUDED = new Set([
    'ask_user',
    'skill',
    'run_subagent',
    'create_skill',
    'propose_agent',
    'create_mcp',
    'create_task'
  ])
  const builtins = toolSpecs.filter((t) => !EXCLUDED.has(t.name))
  if (!allowlist || allowlist.length === 0) return builtins
  const allow = new Set(allowlist)
  const pickedBuiltins = builtins.filter((t) => allow.has(t.name))
  const pickedMcp = getMcpToolSpecs().filter((t) => allow.has(t.name))
  return [...pickedBuiltins, ...pickedMcp]
}

/**
 * 密封无头执行（定时任务）的可见工具表：**除交互/创建类外全量放开**（与交互对话同策略）。
 * - 内置工具剔除交互/创建类（ask_user 无人应答；run_subagent 无法在无人值守下监管；
 *   create_skill/propose_agent/create_mcp/create_task 不得在自动执行中创建持久实体；
 *   exit_plan 无用户可批准计划）后**全部保留**（read/write/exec 均在），不再有白名单收窄。
 * - **追加**已启用技能的 `skill` 工具（技能加载 headless-安全，用户明确要求「包含 skill」）与
 *   **全部已连接 MCP 工具**（用户明确要求「包含 mcp」）。
 * - 每个保留的调用仍由 sealedDecision 的安全地板（Tier-1/Tier-2/危险命令）兜底。
 */
function buildSealedTools(skills: { name: string; description: string }[]): ToolSpec[] {
  const EXCLUDED = new Set([
    'ask_user',
    'run_subagent',
    'create_skill',
    'propose_agent',
    'create_mcp',
    'create_task',
    'exit_plan'
  ])
  const builtins = toolSpecs.filter((t) => !EXCLUDED.has(t.name))
  const skillTool = buildSkillTool(skills)
  return [...builtins, ...(skillTool ? [skillTool] : []), ...getMcpToolSpecs()]
}

/** 子智能体系统提示词：固定的隔离/约束说明 + 该子智能体自身的职责正文（prompt）。 */
function buildSubagentSystem(def: AgentRecord, workspaceRoot: string | null): string {
  const loc = workspaceRoot
    ? `当前工作目录：${workspaceRoot}。路径可用相对该目录的写法。`
    : '当前未打开任何项目文件夹；涉及文件的操作需先由主智能体请用户打开项目。'
  const lines = [
    `你是子智能体「${def.name}」，由主智能体派生来独立完成一项被交办的子任务。`,
    loc,
    '请只专注完成这项子任务；完成后用简洁的简体中文直接给出结论/产物，作为交回主智能体的答复，不要反问。',
    '你无法向用户提问（没有 ask_user 工具），也不能再派生其它子智能体；若信息不足，基于合理默认完成，并在结论中说明所做的假设。',
    '你的每一次工具调用仍会经过权限确认，写入/执行类操作可能被用户拒绝——被拒时改用只读方式或在结论中说明受限之处。'
  ]
  const body = def.prompt.trim()
  if (body) lines.push('', '你的职责与专长如下：', body)
  return lines.join('\n')
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
  /** 模型配置（adapter / provider / baseURL / model）。 */
  model: ChatModelConfig
  /** 工具执行上下文（workspaceRoot + 取消信号）。 */
  ctx: ToolContext
  /** 取消控制器：其 signal 贯穿流式与工具执行。 */
  controller: AbortController
  /** 单轮最大工具步数（主轮 25，子轮更小）。 */
  maxSteps: number
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
  /** 本轮已启用技能快照（供 skill 工具「未找到」提示与正文加载）。 */
  skillSummaries: { name: string; description: string }[]
  /** 子智能体显示名（depth>0 时随事件下发，供渲染层折叠 Task 卡；主轮 undefined）。 */
  agentName?: string
  /** 每收到一次真实 usage.input 即回调（主轮据此持久化 lastInputTokens 作压缩触发依据）。 */
  onUsage?: (input: number) => void
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
   * decision=null 表示取消/中止。仅主轮传入。
   */
  onPlanDecided?: (toolUseId: string, decision: 'approve' | 'keep' | null) => void
}

export function registerChatIpc(getWindow: () => BrowserWindow | null): void {
  function emit(turnId: string, sessionId: string, event: ChatStreamEvent): void {
    getWindow()?.webContents.send('chat:event', { turnId, sessionId, event })
  }

  /** 抛出一个或多个问题、暂停循环等用户一次性作答（不过权限闸门，恒放行执行）。 */
  function askUser(
    turnId: string,
    sessionId: string,
    questions: AskQuestion[]
  ): Promise<string[] | null> {
    const key = genId('ask')
    emit(turnId, sessionId, { type: 'ask_user', key, questions })
    return new Promise((resolve) => pendingAsk.set(key, { resolve, turnId }))
  }

  /**
   * 提交计划、暂停循环等用户批准（不过权限闸门）。返回 'approve'（批准，直接按计划执行）/
   * 'keep'（继续完善）/ null（取消/中止）。批准本身不授予任何能力——仅让循环继续。
   */
  function reviewPlan(
    turnId: string,
    sessionId: string,
    plan: string
  ): Promise<'approve' | 'keep' | null> {
    const key = genId('plan')
    emit(turnId, sessionId, { type: 'plan_review', key, plan })
    return new Promise((resolve) => pendingPlan.set(key, { resolve, turnId }))
  }

  /**
   * Agent 编排核心：单步流式 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续。
   * 主轮与子智能体共用此逻辑；**不发终态 `done`**，仅返回 `{text, stopReason}` 交调用方处置
   * （主轮由 runTurn 发 done；子轮把 text 作结论回灌父轮）。流式内的 text/tool/usage/error/
   * reconnect 等中途事件照常发。抛异常则交调用方 catch。
   */
  async function runAgentLoop(
    args: AgentLoopArgs
  ): Promise<{ text: string; stopReason: StopReason; errorMessage?: string }> {
    const {
      turnId,
      sessionId,
      history,
      system,
      tools,
      model,
      ctx,
      controller,
      maxSteps,
      depth,
      interactive,
      allowAskUser,
      allowSubagents,
      skillSummaries,
      agentName
    } = args
    // depth>0 时给 tool_call/tool_result 事件盖上「来自哪个子智能体」的戳，供渲染层折叠 Task 卡；
    // 主轮（depth 0）为 undefined，事件形状与既有完全一致（向后兼容）。
    const evMeta: { depth: number; agent?: string } | undefined =
      depth > 0 ? { depth, agent: agentName } : undefined
    // 最近一步的助手正文；作为子智能体回传父轮的「结论」（主轮不使用返回值）。
    let finalText = ''
    // 致命错误 / 重连耗尽时的错误文案：随返回值上交，供父轮子智能体结论回落与红框持久化。
    let errorMessage: string | undefined

    for (let step = 0; step < maxSteps; step++) {
      let assistantText = ''
      let toolCalls: { id: string; name: string; args: unknown }[] = []
      let stopReason: StopReason = 'end_turn'

      // 单步流式 + 自动重连：遇可重试网络错误（含空闲僵死）→ 丢弃残缺尾部、退避后重发本步。
      // 无状态中转不支持断点续流，只能整步重发；已完成的前序步骤（工具卡/文本）不受影响。
      reconnect: for (let attempt = 0; ; attempt++) {
        assistantText = ''
        toolCalls = []
        stopReason = 'end_turn'
        let retryableDrop = false
        let fatal = false

        for await (const ev of streamChat(
          { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
          {
            model: model.model,
            system,
            messages: history,
            tools,
            signal: controller.signal
          }
        )) {
          if (ev.type === 'text_delta') {
            assistantText += ev.text
            emit(turnId, sessionId, { type: 'text_delta', text: ev.text })
          } else if (ev.type === 'thinking_delta') {
            emit(turnId, sessionId, { type: 'thinking_delta', text: ev.text })
          } else if (ev.type === 'tool_call') {
            toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
            // ask_user / exit_plan 不画通用工具卡：循环走到它们时再发专用 ask_user / plan_review 事件
            //（避免既有工具卡又有问答卡/计划卡）。
            if (ev.name !== 'ask_user' && ev.name !== 'exit_plan')
              emit(turnId, sessionId, {
                type: 'tool_call',
                id: ev.id,
                name: ev.name,
                args: ev.args,
                ...(evMeta ?? {})
              })
          } else if (ev.type === 'usage') {
            emit(turnId, sessionId, { type: 'usage', input: ev.input, output: ev.output })
            args.onUsage?.(ev.input)
          } else if (ev.type === 'error') {
            // 可重试且非用户中止 → 暂不上报，走自动重连；否则作为致命错误立即上报。
            if (ev.error.retryable && !controller.signal.aborted) retryableDrop = true
            else {
              fatal = true
              errorMessage = ev.error.message
              emit(turnId, sessionId, { type: 'error', kind: ev.error.kind, message: ev.error.message })
            }
          } else if (ev.type === 'done') {
            stopReason = ev.stopReason
          }
        }

        if (controller.signal.aborted) return { text: finalText, stopReason: 'aborted' }
        if (fatal) return { text: finalText, stopReason: 'error', errorMessage }
        if (retryableDrop) {
          if (attempt >= MAX_RECONNECT) {
            errorMessage = `连接多次中断，已重试 ${MAX_RECONNECT} 次仍失败，已停止。`
            emit(turnId, sessionId, {
              type: 'error',
              kind: 'network',
              message: errorMessage
            })
            return { text: finalText, stopReason: 'error', errorMessage }
          }
          emit(turnId, sessionId, { type: 'reconnecting', attempt: attempt + 1, max: MAX_RECONNECT })
          const resumed = await delay(Math.min(1000 * 2 ** attempt, 8000), controller.signal)
          if (!resumed) return { text: finalText, stopReason: 'aborted' }
          // 通知渲染层丢弃本步已画出的残缺尾部，随后 continue 重发本步
          emit(turnId, sessionId, { type: 'stream_reset' })
          continue reconnect
        }
        break // 本步干净结束
      }

      // 落地本轮助手消息（文本 + 工具调用）
      const content: ContentPart[] = []
      if (assistantText) content.push({ type: 'text', text: assistantText })
      for (const tc of toolCalls)
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
      if (content.length) history.push({ role: 'assistant', content })
      if (assistantText) finalText = assistantText

      if (stopReason === 'aborted' || stopReason === 'error') return { text: finalText, stopReason }
      if (toolCalls.length === 0) return { text: finalText, stopReason }

      // 逐个执行工具（过权限闸门），结果回灌为一条 user 消息
      const resultParts: ContentPart[] = []
      for (const tc of toolCalls) {
        if (controller.signal.aborted) return { text: finalText, stopReason: 'aborted' }

        // exit_plan 特判：模型提交计划、暂停循环等用户批准。不过权限闸门、**不授予任何能力**——
        // 批准仅让循环继续（工具集本就完整），此后每个真实工具调用仍照常过同一道权限闸门。
        if (tc.name === 'exit_plan') {
          if (depth > 0 || !interactive) {
            // 子智能体 / 密封无头执行不参与计划审阅（无用户在场可批准；此为幻觉调用兜底）：指导性 no-op。
            resultParts.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: interactive
                ? '子智能体无需 exit_plan；请直接完成分配的任务。'
                : '定时任务在自动执行中，无需也无法进行计划审阅；请直接完成本次任务。',
              isError: true
            })
            continue
          }
          const pa = (tc.args ?? {}) as { plan?: unknown }
          const plan = typeof pa.plan === 'string' ? pa.plan : ''
          const decision = await reviewPlan(turnId, sessionId, plan)
          // 决定存入 plans 边车（按 toolUseId），供重开还原计划卡；null=取消。仅主轮回调。
          args.onPlanDecided?.(tc.id, decision)
          if (decision === 'approve') {
            resultParts.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content:
                '用户已批准计划。现在请按已批准的计划开始执行（写入/执行仍会经权限确认）。',
              isError: false
            })
          } else if (decision === 'keep') {
            resultParts.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content:
                '用户希望继续完善计划（暂不执行）。请依据用户接下来的反馈调整计划；在收到新反馈前不要重复调用 exit_plan。',
              isError: false
            })
          } else {
            resultParts.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: '用户取消了本次计划审阅。',
              isError: true
            })
          }
          continue
        }

        // ask_user 特判：不过权限闸门，暂停循环等用户抉择，答复回灌为 tool_result（子轮禁用）。
        if (allowAskUser && tc.name === 'ask_user') {
          const questions = parseAskQuestions(tc.args)
          const answers = await askUser(turnId, sessionId, questions)
          // 答案存入 asks 边车（按 toolUseId），供重开还原问答卡；null=取消。仅主轮回调。
          args.onAskAnswered?.(tc.id, answers)
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
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
          })
          continue
        }

        // skill 特判：加载已启用技能的完整正文，作为 tool_result 回灌（不过权限闸门——技能内容是数据，
        // 其后每一步的真实工具调用仍照常过闸；allowed-tools 仅作建议文本，绝不自动提权）。
        if (tc.name === 'skill') {
          const a = (tc.args ?? {}) as { name?: unknown }
          const wanted = typeof a.name === 'string' ? a.name.trim() : ''
          const found = wanted ? loadSkillInstructionsByName(wanted) : null
          const content = found
            ? `已加载技能「${found.name}」，请严格据此指令完成用户任务：\n\n${found.instructions}`
            : `未找到名为「${wanted}」的已启用技能。当前可用技能：${
                skillSummaries.map((s) => s.name).join('、') || '（无）'
              }。`
          const skillSummary = found ? `已加载技能「${found.name}」` : '未找到该技能'
          args.onToolSummary?.(tc.id, skillSummary)
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: skillSummary,
            isError: !found,
            ...(evMeta ?? {})
          })
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content,
            isError: !found
          })
          continue
        }

        // run_subagent 特判：在闸门前派生一个隔离的子智能体（独立历史/工具/模型），只把其结论文本
        // 作为 tool_result 回灌父轮。派生本身不设闸——但子智能体的每一次嵌套工具调用仍在其
        // runAgentLoop 内照常过同一道权限闸门（无后门）。递归深度上限 1：子轮 allowSubagents=false，
        // 杜绝子派生子。任何解析/执行失败都捕获成 tool_result 文本，父轮继续，不整轮失败。
        if (allowSubagents && tc.name === 'run_subagent') {
          const a = (tc.args ?? {}) as { agent?: unknown; prompt?: unknown }
          const wantedAgent = typeof a.agent === 'string' ? a.agent.trim() : ''
          const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
          const def = wantedAgent ? getEnabledAgentByName(wantedAgent) : null

          let conclusion: string
          let isErr = false
          if (!def) {
            conclusion = `未找到名为「${wantedAgent}」的已启用子智能体。当前可用：${
              enabledAgentSummaries()
                .map((x) => x.name)
                .join('、') || '（无）'
            }。`
            isErr = true
          } else if (!prompt) {
            conclusion = `派生子智能体「${def.name}」失败：缺少任务描述（prompt）。`
            isErr = true
          } else {
            try {
              const sub = await runAgentLoop({
                turnId,
                sessionId,
                // 隔离历史：只带本次任务描述，不继承父对话（避免上下文串味与预算膨胀）。
                history: [{ role: 'user', content: prompt }],
                system: buildSubagentSystem(def, ctx.workspaceRoot),
                tools: buildSubagentTools(def.tools),
                // 指定模型 → 解析；为空或不可解析 → 回落父轮模型（「跟随主对话」）。
                model: resolveModelRef(def.model, model),
                ctx,
                controller,
                maxSteps: 15,
                depth: depth + 1,
                // 子智能体仍在用户在场时运行，其每次工具调用照常过交互权限闸门。
                interactive: true,
                allowAskUser: false,
                allowSubagents: false,
                skillSummaries: [],
                agentName: def.name
              })
              isErr = sub.stopReason === 'error'
              conclusion =
                sub.text.trim() ||
                (isErr && sub.errorMessage
                  ? `子智能体「${def.name}」执行失败：${sub.errorMessage}`
                  : '（子智能体未产生文本结论。）')
            } catch (e) {
              conclusion = `子智能体「${def.name}」执行出错：${(e as Error)?.message ?? String(e)}`
              isErr = true
            }
          }

          // 父轮（depth 0）事件不盖戳：run_subagent 这张卡本身即 Task 卡的「壳」，
          // 其内部的嵌套事件已在上面的递归调用里各自盖了 depth=1 戳并折叠进来。
          const subSummary = def ? `子智能体「${def.name}」已完成` : '未找到该子智能体'
          args.onToolSummary?.(tc.id, subSummary)
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: subSummary,
            isError: isErr,
            ...(evMeta ?? {})
          })
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: conclusion,
            isError: isErr
          })
          continue
        }

        // 权限闸门（纯同步策略，零弹框）：所有工具默认放行，唯有三类不可协商的安全地板**静默拒绝**
        // （不弹窗、不挂起，回灌清晰 tool_result 让模型改道）——
        //  · edit：Tier-1 敏感目录（凭据/系统/~/.deva）拒绝、Tier-2 保护目录（.git/.claude/.vscode）拒绝；
        //          其余目标（含工作区外）一律放行，越界写入仅此次临时受信、finally 撤销。
        //  · exec：危险命令（rm -rf 等）拒绝；其余放行。
        //  · read / mcp：一律放行（read 的 Tier-1 仍由 tools 内 resolveReadPath 兜底拒绝）。
        // 交互轮与密封轮统一到这套策略；密封轮另经 sealedDecision（同源地板 + 排除交互/创建类工具）。
        const cat = toolCategory(tc.name)

        let allowed: boolean
        let policyDenied = false
        // 「仅此次」授权临时精确放行的路径：执行后必须撤销，避免长期扩大受信面。
        let oneShotPath: string | null = null
        let denyContent = '该操作被安全策略拒绝。'

        if (!interactive) {
          // 密封无头执行（定时任务）：绝不弹窗、绝不挂起——改走纯策略 sealedDecision（含同源安全地板）。
          const verdict = sealedDecision(tc.name, tc.args, ctx.workspaceRoot)
          allowed = verdict.allowed
          if (!allowed) {
            policyDenied = true
            denyContent = verdict.denyContent
          } else if (verdict.trustPath) {
            // 密封写入根未经「打开文件夹」登记进 fs-guard，放行的写入须临时精确放行使工具内 assertInside 通过；
            // 执行后在既有 finally 撤销（oneShotPath），不长期扩大受信面。
            trustRoot(verdict.trustPath)
            oneShotPath = verdict.trustPath
          }
        } else if (cat === 'edit') {
          const target = writeTargetPath(tc.name, tc.args, ctx.workspaceRoot)
          const abs = target?.abs ?? null
          if (abs && isSensitivePath(abs)) {
            // Tier-1 硬底：凭据/系统目录（含本应用 ~/.deva 密钥库），一律静默拒绝。
            allowed = false
            policyDenied = true
            denyContent = `该路径受安全策略保护（凭据/系统目录），拒绝写入：${abs}。请勿重试。`
          } else if (abs && isProtectedPath(abs)) {
            // Tier-2 硬底：受保护目录（.git/.claude/.vscode），一律静默拒绝。
            allowed = false
            policyDenied = true
            denyContent = `该路径位于受保护目录（.git/.claude/.vscode），拒绝写入：${abs}。请勿重试。`
          } else {
            // 其余目标一律放行（含工作区外）。越界写入仅此次临时精确受信，finally 撤销。
            allowed = true
            if (abs && !isInsideRoot(abs)) {
              trustRoot(abs)
              oneShotPath = abs
            }
          }
        } else if (cat === 'exec') {
          // 危险命令（rm -rf 等）静默拒绝；其余一律放行。
          const command =
            tc.args && typeof (tc.args as { command?: unknown }).command === 'string'
              ? (tc.args as { command: string }).command
              : ''
          if (isDangerousCommand(command)) {
            allowed = false
            policyDenied = true
            denyContent =
              '该命令被安全策略拒绝（危险操作），未执行。请勿重试，改用更精确、非破坏性的命令。'
          } else {
            allowed = true
          }
        } else {
          // read + mcp：一律放行（read 的 Tier-1 仍由 tools 内 resolveReadPath 兜底拒绝）。
          allowed = true
        }

        if (!allowed) {
          const denySummary = policyDenied ? '已拒绝（安全策略）' : '已拒绝'
          args.onToolSummary?.(tc.id, denySummary)
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: denySummary,
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

        let res: ToolResult
        try {
          // MCP 工具走连接管理器（callTool + 超时 + 取消，结果恒作数据）；内置工具走本地执行器。
          res = isMcpTool(tc.name)
            ? await dispatchMcpTool(tc.name, tc.args, ctx.signal)
            : await executeTool(tc.name, tc.args, ctx)
        } finally {
          // 撤销「仅此次」临时受信根（无论成功/异常）。
          if (oneShotPath) untrustRoot(oneShotPath)
        }
        if (res.summary) args.onToolSummary?.(tc.id, res.summary)
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
          content: res.content,
          isError: res.isError
        })
      }
      history.push({ role: 'user', content: resultParts })
    }

    // 达到步数上限
    emit(turnId, sessionId, {
      type: 'error',
      kind: 'server',
      message: `已达到单轮最大工具步数（${maxSteps}），已停止。`
    })
    return { text: finalText, stopReason: 'end_turn' }
  }

  /**
   * 主轮（depth 0）薄封装：建控制器/上下文、定格技能快照、调 runAgentLoop，
   * 由本封装发终态 `done`（嵌套子轮不发 done），并在 finally 落盘。
   */
  async function runTurn(
    sessionId: string,
    turnId: string,
    config: ChatModelConfig,
    workspaceRoot: string | null
  ): Promise<void> {
    const controller = new AbortController()
    activeTurns.set(turnId, controller)
    const session = ensureSession(sessionId)
    // 聚焦工作区：本对话若挂载文件夹，用它作有效根（受信/在工作区内判定、终端 cwd、系统提示词聚焦、
    // 权限模式键均据此）；未挂载 → 回落 workspaceRoot（对话优先外壳恒 null，即全机通用助手）。
    const effectiveRoot = session.focusRoot ?? workspaceRoot
    // signal 随 chat:abort 触发 → run_command 中止并杀掉子进程树。
    const ctx: ToolContext = { workspaceRoot: effectiveRoot, signal: controller.signal }

    // 本轮实际模型（对话优先外壳·快照固定/只改当前对话）：以**本对话**存的 model 为准（新建时快照角色偏好、
    // 聊天中切换即更新），经 resolveModelRef 解析——空/非法/模型已被删除都回落 config（chat:send 带上的全局
    // 默认）。故：同角色的多个对话可各用不同模型，改角色偏好模型不影响已建对话，删模型自动回归默认。
    // 提前解析，以便压缩按本轮实际模型的上下文窗口判定/摘要。
    // 注：persona 仍需取出用于系统提示词单身份注入与工具白名单，但**不再**参与模型选择（快照已固定于会话）。
    const persona = session.personaId ? getPersona(session.personaId) : null
    const turnModel = resolveModelRef(session.model, config)

    // 自动压缩：接近上下文窗口时，先把较早历史摘要替换，再进入本轮。
    // 必须在捕获 history 之前做——compactSession 会重赋 session.messages（否则 history 成悬空旧引用）。
    // 失败 / 无需压缩都发事件供渲染层弱提示，且绝不阻断本轮（宁可这一轮不压也要照常回答）。
    if (!controller.signal.aborted && needsCompaction(session, turnModel.model)) {
      try {
        const r = await compactSession({ session, model: turnModel, signal: controller.signal })
        if (r.status !== 'none')
          emit(turnId, sessionId, {
            type: 'compacted',
            scope: 'auto',
            status: r.status,
            message: r.message
          })
      } catch {
        /* 压缩自身抛错（极少）：忽略，历史未动，本轮照常 */
      }
    }

    const history = session.messages
    // 本轮起点（压缩之后捕获——compactSession 已重赋 messages）：用于判定本轮是否产出可见回复。
    const turnStart = history.length
    // 本轮真实输入 token（用于压缩触发判定）：runAgentLoop 每收到一次 usage 即回调，取最后一次。
    let lastInput = 0

    // 本轮是否产出「可见回复」：本轮新增的任一 assistant 消息含非空正文或工具调用即算。
    // 与渲染层 hasVisibleAnswer 同义——决定自然结束却空回合时是否补「空回合」提示。
    const turnProducedVisible = (): boolean => {
      for (let i = turnStart; i < history.length; i++) {
        const m = history[i]
        if (m.role !== 'assistant') continue
        const parts: ContentPart[] =
          typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
        for (const p of parts) {
          if (p.type === 'text' && p.text.trim() !== '') return true
          if (p.type === 'tool_use') return true
        }
      }
      return false
    }

    // 终态提示持久化（错误红框 / 截断 / 空回合）→ session.notices 边车，重开对话即可重建。
    // 镜像渲染层的 error 事件 + appendTerminalNotice：error 只记红框（不再叠空回合提示），
    // max_tokens 记截断，自然结束却无可见回复记空回合，aborted（用户主动停止）不记。
    const recordTurnNotice = (stopReason: StopReason, errorMessage?: string): void => {
      const after = history.length
      const notices = (session.notices ??= [])
      if (stopReason === 'error') notices.push({ after, kind: 'error', message: errorMessage })
      else if (stopReason === 'max_tokens') notices.push({ after, kind: 'notice', code: 'truncated' })
      else if ((stopReason === 'end_turn' || stopReason === 'stop') && !turnProducedVisible())
        notices.push({ after, kind: 'notice', code: 'empty' })
    }

    // 本轮技能快照（在轮开始时定格）：系统提示词只列 name+description（便宜的渐进式披露），
    // 有启用技能时才向模型提供 skill 工具（命中后再加载完整正文）。
    const skillSummaries = enabledSkillSummaries()
    // 本轮 persona 快照（仅主智能体）：
    //  · 绑定了 persona（对话优先外壳）→ 注入**该单条**身份提示词（绑定的 persona 被删则不注入，
    //    绝不回落叠加式，避免绑定对话突然串入其它启用身份）。
    //  · 未绑定（旧 AppShell）→ 走叠加式 enabledPersonas()，逐字节兼容旧行为。
    // 子智能体一律不注入（有自己的系统提示词，避免串味）。
    const personas = session.personaId
      ? persona && persona.prompt.trim()
        ? [{ name: persona.name, prompt: persona.prompt }]
        : []
      : enabledPersonas()
    const skillTool = buildSkillTool(skillSummaries)
    // 有启用子智能体时才向模型提供 run_subagent 工具（枚举已启用名）。
    const subagentTool = buildSubagentTool(enabledAgentSummaries())
    // 每轮定格：内置工具 + exit_plan（计划先行）+（有启用技能时）skill +（有启用子智能体时）run_subagent +
    // 当前已连接 MCP 工具。exit_plan 仅主轮提供（子智能体的 buildSubagentTools 不含它）。
    // 角色不再收窄工具可见性：所有角色均可按需调用全部工具（每个调用仍照常过同一道权限闸门，零提权）。
    const turnTools: ToolSpec[] = [
      ...toolSpecs,
      buildPlanTool(),
      ...(skillTool ? [skillTool] : []),
      ...(subagentTool ? [subagentTool] : []),
      ...getMcpToolSpecs()
    ]

    try {
      // 主轮 = depth 0：可问询、可派生子智能体、由本封装发终态 done（嵌套调用不发 done）。
      const { stopReason, errorMessage } = await runAgentLoop({
        turnId,
        sessionId,
        history,
        system: systemPrompt(effectiveRoot, skillSummaries, personas),
        tools: turnTools,
        model: turnModel,
        ctx,
        controller,
        maxSteps: MAX_STEPS,
        depth: 0,
        interactive: true,
        allowAskUser: true,
        allowSubagents: true,
        skillSummaries,
        onUsage: (n) => {
          if (n > 0) lastInput = n
        },
        // ask_user 答复 / 工具摘要 → 展示边车（按 toolUseId），供重开还原问答卡与工具卡摘要。
        // 只挂主轮：子智能体的嵌套调用不传这两个回调，其工具/问询不会污染父对话边车。
        // 在内存 session 上就地累积，本轮 finally 的 saveProject 一并落盘。
        onAskAnswered: (id, answers) => {
          ;(session.asks ??= {})[id] = { answers }
        },
        onToolSummary: (id, summary) => {
          ;(session.summaries ??= {})[id] = summary
        },
        // exit_plan 决定 → plans 边车（按 toolUseId），供重开还原计划卡的已决态。
        onPlanDecided: (id, decision) => {
          ;(session.plans ??= {})[id] = { decision }
        }
      })
      emit(turnId, sessionId, { type: 'done', stopReason })
      // 终态提示持久化（须在 finally 落盘前执行）：错误红框 / 截断 / 空回合入 notices 边车。
      recordTurnNotice(stopReason, errorMessage)
    } catch (e) {
      const message = (e as Error)?.message ?? String(e)
      emit(turnId, sessionId, { type: 'error', kind: 'unknown', message })
      emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
      recordTurnNotice('error', message)
    } finally {
      activeTurns.delete(turnId)
      // 记录本轮真实输入 token 作为下轮压缩触发依据（比字符估算准，天然覆盖图片/工具）。
      if (lastInput > 0) session.lastInputTokens = lastInput
      // 本轮对 history 的原地改写落盘（一对话一文件：只重写这一条）；更新时间用于左侧列表排序
      session.updatedAt = Date.now()
      saveProject(sessionId)
    }
  }

  /**
   * 定时任务密封无头执行一次（runTurn 的姊妹，供 scheduler 直调）：
   *  · 载入/新建任务独占会话；无固定工作目录（effectiveRoot=null，写入请用绝对路径）；
   *  · 追加一条合成 user 消息（任务 prompt），首次触发派生标题；
   *  · 模型 = 信封模型（严格解析）→ 回落全局默认；两者皆无则记错误不发起（绝不崩）；
   *  · runAgentLoop 以 interactive:false 密封执行——全程零弹窗、绝不挂起（sealedDecision 纯策略把关）；
   *  · emit() 对隐藏/关闭窗口 null-safe（照常落盘，渲染层下次打开经 chat-store 追平）；
   *  · finally 落盘会话。返回 {stopReason,text,errorMessage} 供 scheduler 构造运行记录。
   */
  async function runScheduledTurn(task: TaskRecord): Promise<ScheduledTurnResult> {
    const turnId = genId('turn')
    const controller = new AbortController()
    activeTurns.set(turnId, controller)
    const auth = task.auth
    const sessionId = task.sessionId
    // 密封任务无固定工作目录：相对路径回落进程 cwd，文件操作应用绝对路径。写入除硬底线外一律放行。
    const effectiveRoot: string | null = null
    const session = ensureSession(sessionId, {
      personaId: auth.personaId ?? undefined,
      model: auth.modelRef ?? undefined
    })
    // 首次触发派生标题（沿用任务标题；缺失则从 prompt 派生）。
    if (!session.title) session.title = task.title || deriveTitle(task.prompt)

    // 模型选择：先严格解析信封模型，失败再回落全局默认；两者皆无 → 记错误运行，不发起、不污染对话。
    const turnModel = resolveModelRefOrNull(auth.modelRef) ?? resolveDefaultModel()
    if (!turnModel) {
      activeTurns.delete(turnId)
      return {
        stopReason: 'error',
        text: '',
        errorMessage: '未配置可用的默认模型，无法执行定时任务（请在设置中选定默认模型）。'
      }
    }

    const ctx: ToolContext = { workspaceRoot: effectiveRoot, signal: controller.signal }
    const persona = auth.personaId ? getPersona(auth.personaId) : null
    const personas =
      persona && persona.prompt.trim() ? [{ name: persona.name, prompt: persona.prompt }] : []

    // 追加本次触发的合成 user 消息（任务指令正文）——每次触发 = 该会话新增一轮。
    const history = session.messages
    history.push({ role: 'user', content: task.prompt })

    // 自动压缩：任务多次触发累积于同一会话，接近窗口即先摘要替换早期历史（失败/无需都不阻断本轮）。
    if (!controller.signal.aborted && needsCompaction(session, turnModel.model)) {
      try {
        const r = await compactSession({ session, model: turnModel, signal: controller.signal })
        if (r.status !== 'none')
          emit(turnId, sessionId, {
            type: 'compacted',
            scope: 'auto',
            status: r.status,
            message: r.message
          })
      } catch {
        /* 压缩自身抛错：忽略，历史未动，本轮照常 */
      }
    }

    // 密封工具集：除交互/创建类外全量放开（read/write/exec + 已启用技能 skill + 全部已连接 MCP）；
    // 每次调用仍由 sealedDecision 的安全地板（Tier-1/Tier-2/危险命令）兜底。
    const skillSummaries = enabledSkillSummaries()
    const sealedTools = buildSealedTools(skillSummaries)

    let lastInput = 0
    let result: ScheduledTurnResult = { stopReason: 'end_turn', text: '' }
    try {
      const { text, stopReason, errorMessage } = await runAgentLoop({
        turnId,
        sessionId,
        history,
        system: sealedSystemPrompt(effectiveRoot, personas),
        tools: sealedTools,
        model: turnModel,
        ctx,
        controller,
        maxSteps: 15,
        depth: 0,
        // ★ 密封无头执行：绝不弹窗 / 不 ask_user / 不 exit_plan / 不派生子智能体。
        interactive: false,
        allowAskUser: false,
        allowSubagents: false,
        skillSummaries,
        onUsage: (n) => {
          if (n > 0) lastInput = n
        }
      })
      emit(turnId, sessionId, { type: 'done', stopReason })
      result = { stopReason, text, errorMessage }
    } catch (e) {
      const message = (e as Error)?.message ?? String(e)
      emit(turnId, sessionId, { type: 'error', kind: 'unknown', message })
      emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
      result = { stopReason: 'error', text: '', errorMessage: message }
    } finally {
      activeTurns.delete(turnId)
      if (lastInput > 0) session.lastInputTokens = lastInput
      session.updatedAt = Date.now()
      saveProject(sessionId)
    }
    return result
  }
  // 挂上模块级桥接，供 scheduler.ts 经 runScheduledTask 跨模块直调（registerChatIpc 运行即就绪）。
  scheduledRunner = runScheduledTurn

  // 发送用户消息 → 启动一轮（fire-and-forget），返回 turnId
  ipcMain.handle('chat:send', async (_e, payload: ChatSendRequest): Promise<{ turnId: string }> => {
    const {
      sessionId,
      text,
      model,
      workspaceRoot,
      attachments,
      personaId,
      focusRoot,
      modelRef
    } = payload
    // 首发绑定 persona / 聚焦工作区 / 本对话模型（ensureSession：personaId 一次性绑定，focusRoot 与 model
    // 可后续更新——model 承载「新建快照角色偏好 + 聊天中切换」，显式提供即落库，仅影响本对话）。
    const session = ensureSession(sessionId, { personaId, focusRoot, model: modelRef })
    const history = session.messages

    // 「/技能名」显式触发：命中已启用技能 → 剥离该 token，把完整正文预置进本条消息（这一轮即生效）。
    // 未命中则原样保留（用户可能只是打了个斜杠），不做任何处理。
    let effectiveText = text
    const slashMatch = /^\/([A-Za-z0-9_-]+)[ \t]*([\s\S]*)$/.exec(text.trim())
    if (slashMatch) {
      const loaded = loadSkillInstructionsByName(slashMatch[1])
      if (loaded) {
        const rest = slashMatch[2].trim()
        effectiveText =
          `（用户通过 /${loaded.name} 显式激活了技能「${loaded.name}」，请严格据下述指令完成本次任务）\n` +
          `===== 技能指令：${loaded.name} =====\n${loaded.instructions}\n===== 指令结束 =====` +
          (rest ? `\n\n用户补充：${rest}` : '')
      }
    }

    // 构建本条用户消息：附件内容块在前，提问正文（最后一个 text 块）在后
    const parts: ContentPart[] = []
    const notes: string[] = []
    if (attachments?.length) {
      for (const path of attachments) {
        const { part, note } = await buildAttachmentPart(path, model.adapter)
        if (part) parts.push(part)
        if (note) notes.push(note)
      }
    }
    const question = effectiveText.trim() || (parts.length ? '请理解并处理上述附件。' : '')
    const questionText = notes.length ? `${question}\n（${notes.join('；')}）` : question
    if (parts.length) {
      parts.push({ type: 'text', text: questionText })
      history.push({ role: 'user', content: parts })
    } else {
      history.push({ role: 'user', content: questionText })
    }

    // 首条用户文本派生会话标题
    if (!session.title) session.title = deriveTitle(text) || deriveTitle(questionText)
    session.updatedAt = Date.now()
    saveProject(sessionId)

    const turnId = genId('turn')
    void runTurn(sessionId, turnId, model, workspaceRoot)
    return { turnId }
  })

  /* 说明：persona 绑定与聚焦工作区都已由 ensureSession 落在 session 上，runTurn 内直接读取 —— 见其实现。 */

  // 手动压缩（输入框 /compact）：立即压缩历史，只回发 compacted + done，无后续模型轮。
  ipcMain.handle(
    'chat:compact',
    async (_e, payload: ChatCompactRequest): Promise<{ turnId: string }> => {
      const { sessionId, model } = payload
      const turnId = genId('turn')
      const controller = new AbortController()
      activeTurns.set(turnId, controller)
      try {
        const session = getSession(sessionId)
        let status: CompactStatus = 'none'
        let message: string | undefined
        if (session) {
          // 与 runTurn 同源：按**本对话**模型（快照固定）压缩——窗口与摘要模型都用它，删除则回落 model。
          const r = await compactSession({
            session,
            model: resolveModelRef(session.model, model),
            signal: controller.signal
          })
          status = r.status
          message = r.message
        }
        emit(turnId, sessionId, { type: 'compacted', scope: 'manual', status, message })
      } catch (e) {
        emit(turnId, sessionId, {
          type: 'compacted',
          scope: 'manual',
          status: 'failed',
          message: (e as Error)?.message ?? String(e)
        })
      } finally {
        activeTurns.delete(turnId)
        emit(turnId, sessionId, { type: 'done', stopReason: 'end_turn' })
      }
      return { turnId }
    }
  )

  // 立即建档一条空对话（对话优先外壳：与角色开启新对话时即落盘，重启仍在）。
  // 与 chat:send 的惰性建档同源（ensureSession + saveProject），差别只在「首发前就落盘」——
  // 让空对话作为真实持久化会话进入左侧列表、跨重启存活。旧 AppShell 不调用此接口，仍走惰性路径。
  ipcMain.handle(
    'chat:create-session',
    (_e, payload: ChatCreateSessionRequest): { ok: true } => {
      const { sessionId, personaId, focusRoot, modelRef } = payload
      ensureSession(sessionId, { personaId, focusRoot, model: modelRef })
      saveProject(sessionId)
      return { ok: true }
    }
  )

  // 左侧会话列表：一次列全部（对话无项目/分桶概念）。IPC 仍收 workspaceRoot 以兼容渲染层调用签名，忽略即可。
  ipcMain.handle(
    'chat:list-sessions',
    (_e, _workspaceRoot: string | null): ChatSessionMeta[] => {
      const list = listSessions()
      // 重开后恢复「已挂载项目」的受信根：trustRoot 是内存态、随重启清空（见 fs-guard），而 focusRoot 是
      // 持久化的对话属性——若不在此重新登记，重启后带挂载目录的会话一渲染就调 git:status / fs:*，其首行
      // assertInside 因根未受信而抛「拒绝访问」，表现为「git 丢失 + Error occurred in handler for 'git:status'」。
      // 这是渲染层能拿到 focusRoot 的最早时刻（渲染任何对话 / GitWidget 前必先经此列表），在此登记即无竞态。
      // 语义等同 IDE 重开时恢复已打开的项目文件夹；Tier-1 敏感目录仍由各工具内的硬底线独立拦截，不受影响。
      for (const m of list) {
        if (typeof m.focusRoot === 'string' && m.focusRoot.trim()) trustRoot(m.focusRoot)
      }
      return list
    }
  )

  // 载入某会话的历史（重建展示气泡）。id 全局唯一 → 无需 workspaceRoot（IPC 仍传，忽略即可）。
  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, _workspaceRoot: string | null): DisplayMessage[] => {
      const s = getSession(sessionId)
      return s
        ? toDisplayMessages(
            s.messages,
            s.proposals ?? {},
            s.notices ?? [],
            s.asks ?? {},
            s.summaries ?? {},
            s.plans ?? {},
            s.autotasks ?? {}
          )
        : []
    }
  )

  // 持久化角色名片的终态（接受/拒绝）。名片本体随 Message[] 存活，但终态无处落，
  // 故用 StoredSession.proposals 边车按 toolUseId 记录——重开不再退回 pending、不会重复建角色。
  ipcMain.handle(
    'chat:resolve-proposal',
    (_e, sessionId: string, toolUseId: string, status: 'accepted' | 'rejected'): { ok: boolean } => {
      const s = getSession(sessionId)
      if (!s) return { ok: false }
      s.proposals = { ...s.proposals, [toolUseId]: status }
      saveProject(sessionId)
      return { ok: true }
    }
  )

  // 定时任务确认名片的决议——**唯一的授权时刻**（对标 chat:resolve-proposal，但兼建任务本体）。
  // create：即在此刻用用户在名片里议定的完整信封调 createTask（创建=授权，此后触发零交互）；成功才落 autotasks
  //         边车 {created, taskId} 并存会话；失败不落边车（名片留待用户修正后重试）。
  // dismiss：记 {dismissed}，名片转紧凑「已忽略」态，不建任何任务。
  // 幂等：同名片重复 create 直接回已建任务（防双提交造双任务）。任务本体持久化于主进程 tasks.json（渲染层写不进）。
  ipcMain.handle(
    'chat:resolve-autotask',
    (
      _e,
      sessionId: string,
      toolUseId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ): ResolveAutotaskResult => {
      const s = getSession(sessionId)
      if (!s) return { ok: false, error: 'no-session' }

      // 幂等：已创建过则回既有 taskId，绝不重复建任务。
      const prior = s.autotasks?.[toolUseId]
      if (prior?.status === 'created' && prior.taskId)
        return { ok: true, status: 'created', taskId: prior.taskId }

      if (action === 'dismiss') {
        s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'dismissed' } }
        saveProject(sessionId)
        return { ok: true, status: 'dismissed' }
      }

      // action === 'create'
      if (!taskInput || typeof taskInput !== 'object') return { ok: false, error: 'no-input' }
      const res: CreateTaskResult = createTask(taskInput)
      if (!res.ok) return { ok: false, error: res.error }
      s.autotasks = { ...s.autotasks, [toolUseId]: { status: 'created', taskId: res.task.id } }
      saveProject(sessionId)
      return { ok: true, status: 'created', taskId: res.task.id }
    }
  )

  // 删除某会话（含会话级授权）。id 全局唯一 → 按 id 删。
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, _workspaceRoot: string | null): { ok: true } => {
      deleteStoredSession(sessionId)
      return { ok: true }
    }
  )

  // 中止某一轮：取消流并把该轮的待决问答/计划审阅一律按取消解开
  ipcMain.handle('chat:abort', (_e, turnId: string): { ok: true } => {
    activeTurns.get(turnId)?.abort()
    // 待决问答按「取消」解开（回灌为「用户取消了本次询问」）。
    for (const [key, p] of pendingAsk) {
      if (p.turnId === turnId) {
        pendingAsk.delete(key)
        p.resolve(null)
      }
    }
    // 待决计划审阅按「取消」解开（否则中止的回合会一直阻塞在 reviewPlan 上）。
    for (const [key, p] of pendingPlan) {
      if (p.turnId === turnId) {
        pendingPlan.delete(key)
        p.resolve(null)
      }
    }
    return { ok: true }
  })

  // 重置会话历史与会话级授权（清空该会话正文但保留会话条目）。id 全局唯一 → 按 id。
  ipcMain.handle(
    'chat:reset',
    (_e, sessionId: string, _workspaceRoot: string | null): { ok: true } => {
      const s = getSession(sessionId)
      if (s) {
        s.messages = []
        // 终态提示边车随正文一并清空——否则重置后残留的红框/提示会锚在空历史上。
        s.notices = []
        s.updatedAt = Date.now()
        saveProject(sessionId)
      }
      return { ok: true }
    }
  )

  // 按「轮」删除对话（同步删上下文）。id 全局唯一 → 按 id。turnIndices 为 0 基轮下标集合。
  // 返回删除后重建的展示气泡，供渲染层就地替换——保证展示与落盘一致、重启不变。
  // 前置约束：渲染层仅在**非流式**时发起（避免改写正被 Agent 循环原地改写的 messages）。
  ipcMain.handle(
    'chat:delete-turns',
    (
      _e,
      sessionId: string,
      _workspaceRoot: string | null,
      turnIndices: number[]
    ): DisplayMessage[] => {
      const s = getSession(sessionId)
      if (!s) return []
      deleteTurns(s, Array.isArray(turnIndices) ? turnIndices : [])
      saveProject(sessionId)
      return toDisplayMessages(
        s.messages,
        s.proposals ?? {},
        s.notices ?? [],
        s.asks ?? {},
        s.summaries ?? {},
        s.plans ?? {},
        s.autotasks ?? {}
      )
    }
  )

  // 用户对权限请求的答复
  // 用户对 ask_user 询问的答复（每题的选中项标签或自由输入；null 视为取消）
  ipcMain.handle('chat:ask-response', (_e, payload: AskResponse): { ok: boolean } => {
    const p = pendingAsk.get(payload.key)
    if (!p) return { ok: false }
    pendingAsk.delete(payload.key)
    p.resolve(payload.answers)
    return { ok: true }
  })

  ipcMain.handle('chat:plan-response', (_e, payload: PlanResponse): { ok: boolean } => {
    const p = pendingPlan.get(payload.key)
    if (!p) return { ok: false }
    pendingPlan.delete(payload.key)
    p.resolve(payload.decision)
    return { ok: true }
  })
}
