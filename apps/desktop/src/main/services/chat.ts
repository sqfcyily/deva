import { ipcMain, type BrowserWindow } from 'electron'
import { streamChat } from '../providers'
import type { ContentPart, Message, StopReason, ToolSpec } from '../providers/types'
import {
  evaluate,
  evaluateEdit,
  rememberSession,
  rememberSessionExec,
  clearSession
} from './permissions'
import {
  executeTool,
  isMcpTool,
  writeTargetPath,
  toolCategory,
  toolSpecs,
  type ToolContext,
  type ToolResult
} from './tools'
import { enabledSkillSummaries, loadSkillInstructionsByName } from './skills'
import { enabledAgentSummaries, getEnabledAgentByName, type AgentRecord } from './agents'
import { enabledPersonas, getPersona } from './personas'
import { resolveModelRef } from './model-resolve'
import { dispatchMcpTool, getMcpToolSpecs } from './mcp'
import {
  isInsideRoot,
  isProtectedPath,
  isSensitivePath,
  isWithinDir,
  trustRoot,
  untrustRoot
} from './fs-guard'
import {
  deriveTitle,
  ensureSession,
  getSession,
  deleteSession as deleteStoredSession,
  listSessions,
  projectKey,
  save as saveProject,
  type ChatSessionMeta,
  type StoredNotice
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

type AdapterKind = 'anthropic' | 'openai'

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
   * 与 workspaceRoot（分桶键）解耦：新壳恒传 workspaceRoot=null 落 no-project 桶，聚焦范围由此承载。
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
  emoji: string
  color: string
  model: string
  prompt: string
}

/** 归一化 propose_agent 的原始参数为角色草稿：description→desc、补空 model、缺省 emoji/color。 */
function normalizeAgentDraft(input: unknown): AgentDraft {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    name: str(a.name).trim(),
    desc: str(a.description).trim(),
    emoji: str(a.emoji).trim() || '🤖',
    color: str(a.color).trim() || '#4f8cff',
    model: '',
    prompt: str(a.prompt)
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
  notices: StoredNotice[] = []
): DisplayMessage[] {
  const out: DisplayMessage[] = []
  let lastAssistant: Extract<DisplayMessage, { role: 'assistant' }> | null = null

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
          // propose_agent 铸成角色名片（惰性提议）；其余工具照常铸工具卡。
          if (p.name === 'propose_agent')
            blocks.push({
              kind: 'agentcard',
              id: p.id,
              draft: normalizeAgentDraft(p.input),
              status: proposals[p.id] ?? 'pending'
            })
          else blocks.push({ kind: 'tool', id: p.id, name: p.name, args: p.input, status: 'ok' })
        }
      }
      const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks }
      out.push(msg)
      lastAssistant = msg
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
  }

  // 提示可能锚在最前（after=0，几乎不出现）、任意消息之后、或全部消息之后（after=length，最常见）。
  flushNotices(0)
  for (let i = 0; i < messages.length; i++) {
    processOne(messages[i])
    flushNotices(i + 1)
  }
  return out
}

interface PermissionResponse {
  key: string
  decision: 'allow' | 'deny'
  remember: boolean
}

/** ask_user 的候选项（description 为可选补充说明）。 */
interface AskOption {
  label: string
  description?: string
}

/** ask_user 的单个问题：题干 + 候选项 + 是否多选。 */
interface AskQuestion {
  question: string
  options: AskOption[]
  /** true=多选（可勾多项）；false=单选。 */
  multi: boolean
}

interface AskResponse {
  key: string
  /** 用户对每个问题的答复（answers[i] 对应 questions[i]，选中项或自由输入）；null 表示取消/中止。 */
  answers: string[] | null
}

/**
 * 把模型给的「选项」值健壮地归一成 AskOption[]。刻意宽容：不同模型对候选项的写法五花八门，
 * 若只认「对象且 label 为字符串」会把纯字符串数组 / 别名键（value/title/text/name）全部静默丢掉，
 * 表现为「有问题却无选项、只剩自由输入」。这里逐项归一，尽量不丢用户本可点选的项。
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
  return out
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
        multi: Boolean(q.multiSelect)
      })
    }
  }
  // 防御回退：模型仍按旧式单问格式调用（顶层 question/options）。
  if (out.length === 0 && typeof a.question === 'string' && a.question.trim()) {
    out.push({ question: a.question, options: normalizeOptions(a.options), multi: false })
  }
  // 最终兜底：绝不发空问答卡。
  if (out.length === 0) out.push({ question: '请选择：', options: [], multi: false })
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
  | {
      type: 'permission_request'
      key: string
      toolName: string
      args: unknown
      /** 「项目外访问」授权：被访问目标的完整绝对路径（供权限卡显式展示越界路径）。 */
      outsideRoot?: string
      /** 「项目外访问」授权：点「信任目录」将加入受信根的目录。 */
      trustDir?: string
      /** Tier-2 保护目录（.git/.claude/.vscode）写入：即便 auto/acceptEdits 也逐次授权，仅「仅此次/拒绝」。 */
      protectedWrite?: boolean
      /** depth>0 + agent：该权限请求来自某子智能体（权限卡照常浮出，可附子智能体标签）。 */
      depth?: number
      agent?: string
    }
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
const pending = new Map<string, { resolve: (r: { decision: 'allow' | 'deny'; remember: boolean }) => void; turnId: string }>()
/** 待用户答复的 ask_user 询问（键 → resolve + 所属轮次）；answers 为 null 表示取消/中止。 */
const pendingAsk = new Map<string, { resolve: (answers: string[] | null) => void; turnId: string }>()

let idCounter = 0
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

function systemPrompt(
  workspaceRoot: string | null,
  skills: { name: string; description: string }[] = [],
  personas: { name: string; prompt: string }[] = []
): string {
  const loc = workspaceRoot
    ? `当前工作目录：${workspaceRoot}。路径可用相对该目录的写法。`
    : '当前未打开任何项目文件夹；涉及文件的操作需先请用户打开项目。'
  const lines = [
    '你是 Deva，一个面向开发者的桌面编程助手（类似 Codex / Claude Code）。',
    '你能通过工具读取、浏览、写入用户已打开项目中的文件，帮助用户理解与修改代码。',
    loc,
    '工具使用原则：先用 read_file / list_dir 了解现状，再动手；write_file 会覆盖整个文件，务必先读后写、保留无关内容。',
    '关于授权：当你决定写入/修改文件时，**直接调用 write_file 工具**即可——应用会自动弹出授权界面，由用户在界面上点「允许」或「拒绝」。',
    '**切勿**在回复文字里询问「是否允许写入 / 是否同意覆盖 / 请确认」之类的话——用户无法用文字回复授权，只能通过应用弹出的授权按钮操作；用文字征求授权等于让操作卡死。',
    '需要动手时就调用相应工具，不要只声明打算做什么便停下等待确认。若工具调用被用户拒绝，再据此说明或改用其他不需该操作的方式。',
    '关于决策/澄清：当需求确有歧义、存在多个各有取舍的可行方案需用户抉择、或缺少无法合理默认的关键信息时，调用 ask_user 工具抛出一个或多个问题（每题可给候选项、可单选或多选，界面还允许自行输入），用户在同一张卡片里一次性作答后回灌给你再继续。多个相关问题可一次问清、避免来回打断；但能合理默认就直接做，别为琐碎选择打断用户。注意区分：征求**决策/澄清**用 ask_user；征求**写入/执行授权**仍走前述权限按钮，切勿用 ask_user 去问「是否允许」。'
  ]
  if (skills.length) {
    // 渐进式披露：此处只列「名称 + 一句话描述」；当任务匹配时，模型再调用 skill 工具取完整指令。
    lines.push(
      '可用技能（Skills）：当用户任务匹配下列某项技能时，先调用 `skill` 工具并传入其名称（name）以获取该技能的完整操作指令，然后严格据此执行。用户也可用「/技能名」显式触发。',
      ...skills.map((s) => `  - ${s.name}${s.description ? `：${s.description}` : ''}`)
    )
  }
  lines.push('回答使用简体中文，简洁、准确，必要时给出关键文件路径与行号。')
  if (personas.length) {
    // 用户自定义的「Agent 提示词」（性格 / 语气 / 行文风格 / 偏好）：追加、可叠加多条。
    // 固定前言框定其边界——只在不违反工具使用原则的前提下遵循，绝不借此关闭安全铁律。
    lines.push(
      '以下是用户自定义的附加指令（如性格、语气、行文风格、偏好）。在不违反工具使用原则的前提下，请在本次对话中始终遵循：',
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
  // create_skill / propose_agent / create_mcp 亦排除：子智能体不得创建技能/角色/MCP 服务（它们在 toolSpecs 基表里，须显式剔除）。
  const EXCLUDED = new Set([
    'ask_user',
    'skill',
    'run_subagent',
    'create_skill',
    'propose_agent',
    'create_mcp'
  ])
  const builtins = toolSpecs.filter((t) => !EXCLUDED.has(t.name))
  if (!allowlist || allowlist.length === 0) return builtins
  const allow = new Set(allowlist)
  const pickedBuiltins = builtins.filter((t) => allow.has(t.name))
  const pickedMcp = getMcpToolSpecs().filter((t) => allow.has(t.name))
  return [...pickedBuiltins, ...pickedMcp]
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
  /** 权限模式键：按**有效根**（focusRoot ?? workspaceRoot）取持久 ask/acceptEdits/auto 模式；子轮继承父轮。 */
  key: string
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
}

export function registerChatIpc(getWindow: () => BrowserWindow | null): void {
  function emit(turnId: string, sessionId: string, event: ChatStreamEvent): void {
    getWindow()?.webContents.send('chat:event', { turnId, sessionId, event })
  }

  function requestPermission(
    turnId: string,
    sessionId: string,
    toolName: string,
    args: unknown,
    outside?: { outsideRoot: string; trustDir: string },
    meta?: { depth: number; agent?: string },
    opts?: { protectedWrite?: boolean }
  ): Promise<{ decision: 'allow' | 'deny'; remember: boolean }> {
    const key = genId('perm')
    emit(turnId, sessionId, {
      type: 'permission_request',
      key,
      toolName,
      args,
      outsideRoot: outside?.outsideRoot,
      trustDir: outside?.trustDir,
      protectedWrite: opts?.protectedWrite,
      ...(meta ?? {})
    })
    return new Promise((resolve) => pending.set(key, { resolve, turnId }))
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
      key,
      history,
      system,
      tools,
      model,
      ctx,
      controller,
      maxSteps,
      depth,
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
            // ask_user 不画通用工具卡：循环真正走到它时再发专用 ask_user 事件（避免既有工具卡又有问答卡）。
            if (ev.name !== 'ask_user')
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

        // ask_user 特判：不过权限闸门，暂停循环等用户抉择，答复回灌为 tool_result（子轮禁用）。
        if (allowAskUser && tc.name === 'ask_user') {
          const questions = parseAskQuestions(tc.args)
          const answers = await askUser(turnId, sessionId, questions)
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content:
              answers === null
                ? '用户取消了本次询问。'
                : '用户回答如下：\n' +
                  questions
                    .map((q, i) => `${i + 1}. ${q.question} → ${answers[i] ?? '（未作答）'}`)
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
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: found ? `已加载技能「${found.name}」` : '未找到该技能',
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
                key,
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
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: def ? `子智能体「${def.name}」已完成` : '未找到该子智能体',
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

        // 权限闸门（按工具类别分流）：
        //  · edit（write_file/edit_file）：先算目标绝对路径，四档判定——
        //      Tier-1 硬底拒绝 / Tier-2 保护目录逐次授权 / 项目外越界卡 / 项目内按模式判定。
        //  · read/exec/mcp：无路径越界概念（read 可及任意「非敏感」目录，Tier-1 在工具内兜底）。
        const cat = toolCategory(tc.name)

        let allowed: boolean
        let policyDenied = false
        // 「仅此次」授权临时精确放行的路径：执行后必须撤销，避免长期扩大受信面。
        let oneShotPath: string | null = null
        let denyContent = '用户拒绝了该操作。'

        if (cat === 'edit') {
          const target = writeTargetPath(tc.name, tc.args, ctx.workspaceRoot)
          const abs = target?.abs ?? null
          if (abs && isSensitivePath(abs)) {
            // Tier-1 硬底：凭据/系统目录（含本应用 ~/.deva 密钥库），即便授权也一律拒绝，不弹窗。
            allowed = false
            policyDenied = true
            denyContent = `该路径受安全策略保护（凭据/系统目录），拒绝写入：${abs}。请勿重试。`
          } else if (abs && isProtectedPath(abs)) {
            // Tier-2 保护目录（.git/.claude/.vscode）：写入即便 auto/acceptEdits 也必须逐次授权，
            // 且刻意不记住——保护目录永远逐次询问。授权后一次性精确放行该文件（含项目外的 .git），
            // 使执行时的受信校验通过；执行后在 finally 撤销。
            const r = await requestPermission(
              turnId,
              sessionId,
              tc.name,
              tc.args,
              undefined,
              evMeta,
              { protectedWrite: true }
            )
            allowed = r.decision === 'allow'
            if (allowed) {
              trustRoot(abs)
              oneShotPath = abs
            }
          } else if (abs && !isInsideRoot(abs)) {
            // 项目外写入：走越界卡（仅此次 / 信任目录）。auto 亦不例外——不做「写任意目录」后门。
            const r = await requestPermission(
              turnId,
              sessionId,
              tc.name,
              tc.args,
              { outsideRoot: abs, trustDir: target!.dir },
              evMeta
            )
            allowed = r.decision === 'allow'
            if (allowed) {
              // 本会话始终允许 → 加会话根（父目录，覆盖子树）；仅此次 → 临时精确放行该目标。
              if (r.remember) trustRoot(target!.dir)
              else {
                trustRoot(abs)
                oneShotPath = abs
              }
            }
          } else {
            // 项目内写入（或缺 path，交执行处报参数错）：acceptEdits 仅放行「当前活动工作区」，
            // auto 放行所有受信根；否则弹窗（记住则本会话始终允许该工具）。
            const inWorkspace = abs ? isWithinDir(abs, ctx.workspaceRoot) : true
            const decision = evaluateEdit(sessionId, key, tc.name, inWorkspace)
            allowed = decision === 'allow'
            if (decision === 'ask') {
              const r = await requestPermission(turnId, sessionId, tc.name, tc.args, undefined, evMeta)
              allowed = r.decision === 'allow'
              if (allowed && r.remember) rememberSession(sessionId, tc.name)
            }
          }
        } else {
          // read / exec / mcp：常规三态判定——read 恒放行；exec 危险命令 deny、auto/记住的前缀放行；
          // mcp 默认 ask、可按会话记住。allow 直接执行；ask 弹权限窗；deny 为策略层硬拒（不弹窗）。
          const decision = evaluate(sessionId, key, tc.name, tc.args)
          allowed = decision === 'allow'
          policyDenied = decision === 'deny'
          if (policyDenied)
            denyContent =
              '该命令被安全策略拒绝（危险操作），未执行。请勿重试，改用更精确、非破坏性的命令。'
          if (decision === 'ask') {
            const r = await requestPermission(turnId, sessionId, tc.name, tc.args, undefined, evMeta)
            allowed = r.decision === 'allow'
            if (allowed && r.remember) {
              // exec 记「命令前缀」（如 git status），其余工具记工具名。
              if (cat === 'exec') rememberSessionExec(sessionId, tc.args)
              else rememberSession(sessionId, tc.name)
            }
          }
        }

        if (!allowed) {
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: policyDenied ? '已拒绝（安全策略）' : '已拒绝',
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
    key: string,
    sessionId: string,
    turnId: string,
    config: ChatModelConfig,
    workspaceRoot: string | null
  ): Promise<void> {
    const controller = new AbortController()
    activeTurns.set(turnId, controller)
    const session = ensureSession(key, sessionId)
    // 聚焦工作区：本对话若挂载文件夹，用它作有效根（受信/在工作区内判定、终端 cwd、系统提示词聚焦、
    // 权限模式键均据此）；未挂载 → 回落 workspaceRoot（旧壳=已打开项目；新壳=null 即全机通用助手）。
    const effectiveRoot = session.focusRoot ?? workspaceRoot
    // 权限模式键：按有效根取持久模式 —— 挂载不同文件夹的对话各有独立模式；旧壳 focusRoot 恒空
    // → effectiveRoot === workspaceRoot → modeKey === key（分桶键），逐字节兼容。
    const modeKey = projectKey(effectiveRoot)
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
    // 每轮定格：内置工具 +（有启用技能时）skill +（有启用子智能体时）run_subagent + 当前已连接 MCP 工具。
    // 角色不再收窄工具可见性：所有角色均可按需调用全部工具（每个调用仍照常过同一道权限闸门，零提权）。
    const turnTools: ToolSpec[] = [
      ...toolSpecs,
      ...(skillTool ? [skillTool] : []),
      ...(subagentTool ? [subagentTool] : []),
      ...getMcpToolSpecs()
    ]

    try {
      // 主轮 = depth 0：可问询、可派生子智能体、由本封装发终态 done（嵌套调用不发 done）。
      const { stopReason, errorMessage } = await runAgentLoop({
        turnId,
        sessionId,
        // 权限模式键 = 有效根（focusRoot ?? workspaceRoot）：挂载不同文件夹的对话各有独立
        // 持久模式；旧壳 focusRoot 恒空 → modeKey === key，逐字节兼容。分桶落盘仍用外层 key。
        key: modeKey,
        history,
        system: systemPrompt(effectiveRoot, skillSummaries, personas),
        tools: turnTools,
        model: turnModel,
        ctx,
        controller,
        maxSteps: MAX_STEPS,
        depth: 0,
        allowAskUser: true,
        allowSubagents: true,
        skillSummaries,
        onUsage: (n) => {
          if (n > 0) lastInput = n
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

  // 发送用户消息 → 启动一轮（fire-and-forget），返回 turnId
  ipcMain.handle('chat:send', async (_e, payload: ChatSendRequest): Promise<{ turnId: string }> => {
    const { sessionId, text, model, workspaceRoot, attachments, personaId, focusRoot, modelRef } =
      payload
    const key = projectKey(workspaceRoot)
    // 首发绑定 persona / 聚焦工作区 / 本对话模型（ensureSession：personaId 一次性绑定，focusRoot 与 model
    // 可后续更新——model 承载「新建快照角色偏好 + 聊天中切换」，显式提供即落库，仅影响本对话）。
    const session = ensureSession(key, sessionId, { personaId, focusRoot, model: modelRef })
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
    void runTurn(key, sessionId, turnId, model, workspaceRoot)
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
      const { sessionId, workspaceRoot, personaId, focusRoot, modelRef } = payload
      const key = projectKey(workspaceRoot)
      ensureSession(key, sessionId, { personaId, focusRoot, model: modelRef })
      saveProject(sessionId)
      return { ok: true }
    }
  )

  // 左侧会话列表（按项目）
  ipcMain.handle(
    'chat:list-sessions',
    (_e, workspaceRoot: string | null): ChatSessionMeta[] => listSessions(projectKey(workspaceRoot))
  )

  // 载入某会话的历史（重建展示气泡）。id 全局唯一 → 无需 workspaceRoot（IPC 仍传，忽略即可）。
  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, _workspaceRoot: string | null): DisplayMessage[] => {
      const s = getSession(sessionId)
      return s ? toDisplayMessages(s.messages, s.proposals ?? {}, s.notices ?? []) : []
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

  // 删除某会话（含会话级授权）。id 全局唯一 → 按 id 删。
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, _workspaceRoot: string | null): { ok: true } => {
      deleteStoredSession(sessionId)
      clearSession(sessionId)
      return { ok: true }
    }
  )

  // 中止某一轮：取消流并把该轮的待决权限一律按拒绝解开
  ipcMain.handle('chat:abort', (_e, turnId: string): { ok: true } => {
    activeTurns.get(turnId)?.abort()
    for (const [key, p] of pending) {
      if (p.turnId === turnId) {
        pending.delete(key)
        p.resolve({ decision: 'deny', remember: false })
      }
    }
    // 待决问答按「取消」解开（回灌为「用户取消了本次询问」）。
    for (const [key, p] of pendingAsk) {
      if (p.turnId === turnId) {
        pendingAsk.delete(key)
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
      clearSession(sessionId)
      return { ok: true }
    }
  )

  // 用户对权限请求的答复
  ipcMain.handle('chat:permission-response', (_e, payload: PermissionResponse): { ok: boolean } => {
    const p = pending.get(payload.key)
    if (!p) return { ok: false }
    pending.delete(payload.key)
    p.resolve({ decision: payload.decision, remember: payload.remember })
    return { ok: true }
  })

  // 用户对 ask_user 询问的答复（每题的选中项标签或自由输入；null 视为取消）
  ipcMain.handle('chat:ask-response', (_e, payload: AskResponse): { ok: boolean } => {
    const p = pendingAsk.get(payload.key)
    if (!p) return { ok: false }
    pendingAsk.delete(payload.key)
    p.resolve(payload.answers)
    return { ok: true }
  })
}
