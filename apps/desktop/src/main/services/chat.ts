import { ipcMain, type BrowserWindow } from 'electron'
import { streamChat } from '../providers'
import type { ContentPart, Message, StopReason, ToolSpec } from '../providers/types'
import { evaluate, rememberSession, rememberSessionExec, clearSession } from './permissions'
import {
  executeTool,
  isMcpTool,
  outsideRootTarget,
  toolCategory,
  toolSpecs,
  type ToolContext,
  type ToolResult
} from './tools'
import { enabledSkillSummaries, loadSkillInstructionsByName } from './skills'
import { enabledAgentSummaries, getEnabledAgentByName, type AgentRecord } from './agents'
import { resolveModelRef } from './model-resolve'
import { dispatchMcpTool, getMcpToolSpecs } from './mcp'
import { isSensitivePath, trustRoot, untrustRoot } from './fs-guard'
import {
  deriveTitle,
  ensureSession,
  getSession,
  deleteSession as deleteStoredSession,
  listSessions,
  projectKey,
  save as saveProject,
  type ChatSessionMeta
} from './chat-store'
import { ATTACH_TEXT_PREFIX, buildAttachmentPart } from './attachments'

/**
 * 会话编排（Agent 主循环）。
 * 流式生成 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续，直至无工具调用或达上限。
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
}

/** 重建历史用的展示消息（主进程从 provider Message[] 归约，去掉 base64 负载）。 */
type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }

export type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

/**
 * provider Message[] → 展示消息序列（供切换/重开会话时重建气泡）。
 * 工具结果回灌消息不单独成气泡，而是回填上一条 assistant 的工具卡状态；
 * 附件仅重建为「名称 + 类型」的贴片（不回传 base64）。思考块为易逝态，不重建。
 */
function toDisplayMessages(messages: Message[]): DisplayMessage[] {
  const out: DisplayMessage[] = []
  let lastAssistant: Extract<DisplayMessage, { role: 'assistant' }> | null = null

  for (const m of messages) {
    if (m.role === 'assistant') {
      const parts: ContentPart[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      const blocks: DisplayBlock[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) blocks.push({ kind: 'text', text: p.text })
        else if (p.type === 'tool_use')
          blocks.push({ kind: 'tool', id: p.id, name: p.name, args: p.input, status: 'ok' })
      }
      const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks }
      out.push(msg)
      lastAssistant = msg
      continue
    }

    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', text: m.content, attachments: [] })
      continue
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
      continue
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
  return out
}

interface PermissionResponse {
  key: string
  decision: 'allow' | 'deny'
  remember: boolean
}

/** ask_user 的候选项（竖排单选；description 为可选补充说明）。 */
interface AskOption {
  label: string
  description?: string
}

interface AskResponse {
  key: string
  /** 用户最终答复文本（选中项标签或自由输入）；null 表示取消/中止。 */
  answer: string | null
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
  /** 征求决策/澄清：暂停循环，向用户抛出单选问题，等其选择/输入后回灌为 tool_result。 */
  | { type: 'ask_user'; key: string; question: string; options: AskOption[] }
  | {
      type: 'permission_request'
      key: string
      toolName: string
      args: unknown
      /** 「项目外访问」授权：被访问目标的完整绝对路径（供权限卡显式展示越界路径）。 */
      outsideRoot?: string
      /** 「项目外访问」授权：点「信任目录」将加入受信根的目录。 */
      trustDir?: string
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
  | { type: 'done'; stopReason: StopReason }

const MAX_STEPS = 25
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
/** 待用户答复的 ask_user 询问（键 → resolve + 所属轮次）；answer 为 null 表示取消/中止。 */
const pendingAsk = new Map<string, { resolve: (answer: string | null) => void; turnId: string }>()

let idCounter = 0
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

function systemPrompt(
  workspaceRoot: string | null,
  skills: { name: string; description: string }[] = []
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
    '关于决策/澄清：当需求确有歧义、存在多个各有取舍的可行方案需用户抉择、或缺少无法合理默认的关键信息时，调用 ask_user 工具抛出**一个**单选问题，界面会让用户选择或自行输入，其答复回灌给你后再继续。能合理默认就直接做，别为琐碎选择打断用户。注意区分：征求**决策/澄清**用 ask_user；征求**写入/执行授权**仍走前述权限按钮，切勿用 ask_user 去问「是否允许」。'
  ]
  if (skills.length) {
    // 渐进式披露：此处只列「名称 + 一句话描述」；当任务匹配时，模型再调用 skill 工具取完整指令。
    lines.push(
      '可用技能（Skills）：当用户任务匹配下列某项技能时，先调用 `skill` 工具并传入其名称（name）以获取该技能的完整操作指令，然后严格据此执行。用户也可用「/技能名」显式触发。',
      ...skills.map((s) => `  - ${s.name}${s.description ? `：${s.description}` : ''}`)
    )
  }
  lines.push('回答使用简体中文，简洁、准确，必要时给出关键文件路径与行号。')
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
  // create_skill 亦排除：子智能体不得创建技能（它在 toolSpecs 基表里，须显式剔除）。
  const EXCLUDED = new Set(['ask_user', 'skill', 'run_subagent', 'create_skill'])
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
  /** 项目键（评估权限模式 / 记住命令前缀用）。 */
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
    meta?: { depth: number; agent?: string }
  ): Promise<{ decision: 'allow' | 'deny'; remember: boolean }> {
    const key = genId('perm')
    emit(turnId, sessionId, {
      type: 'permission_request',
      key,
      toolName,
      args,
      outsideRoot: outside?.outsideRoot,
      trustDir: outside?.trustDir,
      ...(meta ?? {})
    })
    return new Promise((resolve) => pending.set(key, { resolve, turnId }))
  }

  /** 抛出单选问题、暂停循环等用户答复（不过权限闸门，恒放行执行）。 */
  function askUser(
    turnId: string,
    sessionId: string,
    question: string,
    options: AskOption[]
  ): Promise<string | null> {
    const key = genId('ask')
    emit(turnId, sessionId, { type: 'ask_user', key, question, options })
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
  ): Promise<{ text: string; stopReason: StopReason }> {
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
          } else if (ev.type === 'error') {
            // 可重试且非用户中止 → 暂不上报，走自动重连；否则作为致命错误立即上报。
            if (ev.error.retryable && !controller.signal.aborted) retryableDrop = true
            else {
              fatal = true
              emit(turnId, sessionId, { type: 'error', kind: ev.error.kind, message: ev.error.message })
            }
          } else if (ev.type === 'done') {
            stopReason = ev.stopReason
          }
        }

        if (controller.signal.aborted) return { text: finalText, stopReason: 'aborted' }
        if (fatal) return { text: finalText, stopReason: 'error' }
        if (retryableDrop) {
          if (attempt >= MAX_RECONNECT) {
            emit(turnId, sessionId, {
              type: 'error',
              kind: 'network',
              message: `连接多次中断，已重试 ${MAX_RECONNECT} 次仍失败，已停止。`
            })
            return { text: finalText, stopReason: 'error' }
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
          const a = (tc.args ?? {}) as { question?: unknown; options?: unknown }
          const question = typeof a.question === 'string' && a.question.trim() ? a.question : '请选择：'
          const options: AskOption[] = Array.isArray(a.options)
            ? a.options
                .filter((o): o is { label: string; description?: unknown } =>
                  Boolean(o) && typeof (o as { label?: unknown }).label === 'string'
                )
                .map((o) => ({
                  label: o.label,
                  description: typeof o.description === 'string' ? o.description : undefined
                }))
            : []
          const answer = await askUser(turnId, sessionId, question, options)
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: answer === null ? '用户取消了本次询问。' : `用户回答：${answer}`,
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
              conclusion = sub.text.trim() || '（子智能体未产生文本结论。）'
              isErr = sub.stopReason === 'error'
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

        // 「项目外访问」预检：目标落在受信根之外 → 走越界询问（而非常规闸门）。
        const outside = outsideRootTarget(tc.name, tc.args, ctx.workspaceRoot)

        let allowed: boolean
        let policyDenied = false
        // 「仅此次」授权临时精确放行的路径：执行后必须撤销，避免长期扩大受信面。
        let oneShotPath: string | null = null
        let denyContent = '用户拒绝了该操作。'

        if (outside) {
          // 硬底：凭据/系统目录（含本应用 ~/.deva 密钥库）即便同意也一律拒绝，不弹窗。
          if (isSensitivePath(outside.abs)) {
            allowed = false
            policyDenied = true
            denyContent = `该路径受安全策略保护（凭据/系统目录），拒绝访问：${outside.abs}。请勿重试。`
          } else {
            // 询问（复用权限卡，附完整绝对路径 + 越界告警）。
            const r = await requestPermission(
              turnId,
              sessionId,
              tc.name,
              tc.args,
              { outsideRoot: outside.abs, trustDir: outside.dir },
              evMeta
            )
            allowed = r.decision === 'allow'
            if (allowed) {
              // 本会话始终允许 → 加会话根（父目录/目标目录，覆盖子树）；
              // 仅此次 → 临时精确放行该目标路径，执行后在 finally 撤销。
              if (r.remember) trustRoot(outside.dir)
              else {
                trustRoot(outside.abs)
                oneShotPath = outside.abs
              }
            }
          }
        } else {
          // 常规三态判定：allow 直接执行；ask 弹权限窗；deny 为策略层硬拒（不弹窗）。
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
              if (toolCategory(tc.name) === 'exec') rememberSessionExec(sessionId, tc.args)
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
    // signal 随 chat:abort 触发 → run_command 中止并杀掉子进程树。
    const ctx: ToolContext = { workspaceRoot, signal: controller.signal }
    const session = ensureSession(key, sessionId)
    const history = session.messages

    // 本轮技能快照（在轮开始时定格）：系统提示词只列 name+description（便宜的渐进式披露），
    // 有启用技能时才向模型提供 skill 工具（命中后再加载完整正文）。
    const skillSummaries = enabledSkillSummaries()
    const skillTool = buildSkillTool(skillSummaries)
    // 有启用子智能体时才向模型提供 run_subagent 工具（枚举已启用名）。
    const subagentTool = buildSubagentTool(enabledAgentSummaries())
    // 每轮定格：内置工具 +（有启用技能时）skill +（有启用子智能体时）run_subagent + 当前已连接 MCP 工具。
    const turnTools: ToolSpec[] = [
      ...toolSpecs,
      ...(skillTool ? [skillTool] : []),
      ...(subagentTool ? [subagentTool] : []),
      ...getMcpToolSpecs()
    ]

    try {
      // 主轮 = depth 0：可问询、可派生子智能体、由本封装发终态 done（嵌套调用不发 done）。
      const { stopReason } = await runAgentLoop({
        turnId,
        sessionId,
        key,
        history,
        system: systemPrompt(workspaceRoot, skillSummaries),
        tools: turnTools,
        model: config,
        ctx,
        controller,
        maxSteps: MAX_STEPS,
        depth: 0,
        allowAskUser: true,
        allowSubagents: true,
        skillSummaries
      })
      emit(turnId, sessionId, { type: 'done', stopReason })
    } catch (e) {
      emit(turnId, sessionId, {
        type: 'error',
        kind: 'unknown',
        message: (e as Error)?.message ?? String(e)
      })
      emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
    } finally {
      activeTurns.delete(turnId)
      // 本轮对 history 的原地改写落盘；更新时间用于左侧列表排序
      session.updatedAt = Date.now()
      saveProject(key)
    }
  }

  // 发送用户消息 → 启动一轮（fire-and-forget），返回 turnId
  ipcMain.handle('chat:send', async (_e, payload: ChatSendRequest): Promise<{ turnId: string }> => {
    const { sessionId, text, model, workspaceRoot, attachments } = payload
    const key = projectKey(workspaceRoot)
    const session = ensureSession(key, sessionId)
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
    saveProject(key)

    const turnId = genId('turn')
    void runTurn(key, sessionId, turnId, model, workspaceRoot)
    return { turnId }
  })

  // 左侧会话列表（按项目）
  ipcMain.handle(
    'chat:list-sessions',
    (_e, workspaceRoot: string | null): ChatSessionMeta[] => listSessions(projectKey(workspaceRoot))
  )

  // 载入某会话的历史（重建展示气泡）
  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, workspaceRoot: string | null): DisplayMessage[] => {
      const s = getSession(projectKey(workspaceRoot), sessionId)
      return s ? toDisplayMessages(s.messages) : []
    }
  )

  // 删除某会话（含会话级授权）
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, workspaceRoot: string | null): { ok: true } => {
      deleteStoredSession(projectKey(workspaceRoot), sessionId)
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

  // 重置会话历史与会话级授权（清空该会话正文但保留会话条目）
  ipcMain.handle(
    'chat:reset',
    (_e, sessionId: string, workspaceRoot: string | null): { ok: true } => {
      const key = projectKey(workspaceRoot)
      const s = getSession(key, sessionId)
      if (s) {
        s.messages = []
        s.updatedAt = Date.now()
        saveProject(key)
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

  // 用户对 ask_user 询问的答复（选中项标签或自由输入；null 视为取消）
  ipcMain.handle('chat:ask-response', (_e, payload: AskResponse): { ok: boolean } => {
    const p = pendingAsk.get(payload.key)
    if (!p) return { ok: false }
    pendingAsk.delete(payload.key)
    p.resolve(payload.answer)
    return { ok: true }
  })
}
