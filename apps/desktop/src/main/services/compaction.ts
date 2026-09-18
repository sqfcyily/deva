import { streamChat } from '../providers'
import type { ContentPart, Message } from '../providers/types'
import { getConfig } from './config'
import { save as saveProject, type StoredSession } from './chat-store'

/**
 * 上下文压缩（主进程）。
 * 当历史接近模型上下文窗口时，把较早的消息「摘要替换」成一条带标记的摘要消息，
 * 只保留近期消息逐字，从而把上下文降回安全区，让长对话可持续（对齐 Codex / Claude Code）。
 *
 * 设计要点：
 * - 触发优先用上一轮真实 usage.input（持久化在会话上，最准，天然覆盖图片/工具）；无则回退字符估算。
 * - 边界吸附到真实用户轮，绝不切开 assistant(tool_use)↔user(tool_result)，且必留本轮问题。
 * - 摘要是真实持久化的 user 消息（带标记前缀）：上下文唯一真源、随重开存活、作为续聊引子发给模型。
 * - 摘要失败绝不改动历史（宁可不压，也不破坏真源）。
 */

export interface CompactModelConfig {
  adapter: 'anthropic' | 'openai'
  providerId: string
  baseURL: string
  model: string
}

/** 摘要消息的标记前缀：极不可能被用户键入；重开时据此识别摘要消息并特殊渲染。 */
export const COMPACT_MARKER = '⟦deva:compaction⟧'

export type CompactStatus = 'compacted' | 'none' | 'failed'

interface CompactionCfg {
  enabled: boolean
  triggerRatio: number
  defaultWindow: number
}

const DEFAULTS: CompactionCfg = { enabled: true, triggerRatio: 0.75, defaultWindow: 128_000 }

/** 从 config.json 的 `compaction` 段读配置（明文可手改即设置面），非法值回退默认。 */
export function compactionConfig(): CompactionCfg {
  const raw = (getConfig().compaction ?? {}) as Partial<CompactionCfg>
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    triggerRatio:
      typeof raw.triggerRatio === 'number' && raw.triggerRatio > 0 && raw.triggerRatio < 1
        ? raw.triggerRatio
        : DEFAULTS.triggerRatio,
    defaultWindow:
      typeof raw.defaultWindow === 'number' && raw.defaultWindow > 0
        ? raw.defaultWindow
        : DEFAULTS.defaultWindow
  }
}

// 模型 → 上下文窗口（token）近似表；子串命中，够用即可。id 内自带窗口者优先解析（见 windowForModel）。
const WINDOW_TABLE: { match: RegExp; window: number }[] = [
  { match: /claude/i, window: 200_000 },
  { match: /gemini/i, window: 1_000_000 },
  { match: /(gpt|o[13])/i, window: 128_000 },
  { match: /deepseek/i, window: 128_000 },
  { match: /glm/i, window: 128_000 },
  { match: /qwen2/i, window: 32_000 }, // 通义开源系（多经 Ollama 本地跑）：保守
  { match: /qwen-?max/i, window: 32_000 },
  { match: /qwen/i, window: 128_000 },
  { match: /moonshot|kimi/i, window: 128_000 },
  { match: /llama/i, window: 32_000 } // 本地 Llama：有效窗口常远小于标称，保守
]

/** 估算某模型的上下文窗口：id 自带（如 -128k）> 内置表 > 全局默认。 */
export function windowForModel(modelId: string, fallback: number): number {
  const km = /(\d+)k\b/i.exec(modelId)
  if (km) {
    const n = Number(km[1])
    if (n >= 4 && n <= 4000) return n * 1000
  }
  for (const e of WINDOW_TABLE) if (e.match.test(modelId)) return e.window
  return fallback
}

// ── token 估算（字符法；图片/文档按固定成本，规避 base64 数长度失真）───────────────
const CHARS_PER_TOKEN = 3.5
const IMAGE_TOKENS = 1600
const DOC_TOKENS = 3000

function partTokens(p: ContentPart): number {
  switch (p.type) {
    case 'text':
      return p.text.length / CHARS_PER_TOKEN
    case 'tool_use':
      return JSON.stringify(p.input ?? {}).length / CHARS_PER_TOKEN + 8
    case 'tool_result':
      return p.content.length / CHARS_PER_TOKEN + 8
    case 'image':
      return IMAGE_TOKENS
    case 'document':
      return DOC_TOKENS
    default:
      return 0
  }
}

function messageTokens(m: Message): number {
  if (typeof m.content === 'string') return m.content.length / CHARS_PER_TOKEN + 4
  let t = 4
  for (const p of m.content) t += partTokens(p)
  return t
}

/** 全历史 token 估算（触发判定的字符法回退）。 */
export function estimateTokens(messages: Message[]): number {
  let t = 0
  for (const m of messages) t += messageTokens(m)
  return Math.round(t)
}

/** 是否需要压缩：优先真实 usage.input，回退字符估算，与「窗口 × 触发比例」比较。 */
export function needsCompaction(
  session: StoredSession,
  modelId: string,
  cfg: CompactionCfg = compactionConfig()
): boolean {
  if (!cfg.enabled) return false
  const window = windowForModel(modelId, cfg.defaultWindow)
  const used =
    session.lastInputTokens && session.lastInputTokens > 0
      ? session.lastInputTokens
      : estimateTokens(session.messages)
  return used >= window * cfg.triggerRatio
}

// ── 边界选取 ──────────────────────────────────────────────────────────────────
function hasToolResult(m: Message): boolean {
  return typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result')
}

/** 真实用户轮：role=user 且不含 tool_result（工具结果回灌消息不算）。 */
function isGenuineUserTurn(m: Message): boolean {
  return m.role === 'user' && !hasToolResult(m)
}

const MIN_COMPACT_MESSAGES = 4

/**
 * 选定保留尾部的起点下标：从末尾向前累加 token 至 keepTokens，再吸附到一条真实用户轮。
 * 返回 boundary：[0, boundary) 待压缩、[boundary, end) 保留。压缩收益不足时返回 -1。
 */
export function pickBoundary(messages: Message[], keepTokens: number): number {
  const n = messages.length
  if (n < MIN_COMPACT_MESSAGES + 2) return -1

  let acc = 0
  let idx = n
  for (let i = n - 1; i >= 0; i--) {
    acc += messageTokens(messages[i])
    if (acc >= keepTokens) {
      idx = i
      break
    }
  }
  if (idx === n) return -1 // 历史本就不大，累加从未达标 → 不压

  // 吸附：从 idx 向后找第一条真实用户轮作为尾部起点（保证尾部以真实用户轮开头）
  let boundary = -1
  for (let i = idx; i < n; i++) {
    if (isGenuineUserTurn(messages[i])) {
      boundary = i
      break
    }
  }
  if (boundary < MIN_COMPACT_MESSAGES) return -1 // 无合适边界，或可压段过短，不值得
  return boundary
}

// ── 转录与摘要 ────────────────────────────────────────────────────────────────
const MAX_TRANSCRIPT_CHARS = 48_000
const MAX_TOOL_RESULT_CHARS = 2_000
const MAX_TOOL_ARGS_CHARS = 400

/** 把待压段拍平成纯文本转录（丢 base64、截断超长工具结果、总量头部截断保留较近）。 */
export function buildTranscript(messages: Message[], locale: string): string {
  const zh = locale !== 'en'
  const U = zh ? '用户' : 'User'
  const A = zh ? '助手' : 'Assistant'
  const lines: string[] = []
  const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + '…' : s)

  for (const m of messages) {
    const label = m.role === 'user' ? U : A
    if (typeof m.content === 'string') {
      if (m.content.trim()) lines.push(`${label}: ${m.content}`)
      continue
    }
    for (const p of m.content) {
      if (p.type === 'text') {
        if (p.text.trim()) lines.push(`${label}: ${p.text}`)
      } else if (p.type === 'tool_use') {
        const args = clip(JSON.stringify(p.input ?? {}), MAX_TOOL_ARGS_CHARS)
        lines.push(`${label} [${zh ? '调用工具' : 'tool'} ${p.name}]: ${args}`)
      } else if (p.type === 'tool_result') {
        const tag = zh ? (p.isError ? '工具结果·错误' : '工具结果') : p.isError ? 'tool result·error' : 'tool result'
        lines.push(`[${tag}]: ${clip(p.content, MAX_TOOL_RESULT_CHARS)}`)
      } else if (p.type === 'image') {
        lines.push(`${label} [${zh ? '图片' : 'image'}]`)
      } else if (p.type === 'document') {
        lines.push(`${label} [${zh ? '文档' : 'document'}]`)
      }
    }
  }

  let text = lines.join('\n')
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const omitted = zh ? '…（更早内容已省略）\n' : '…(earlier content omitted)\n'
    text = omitted + text.slice(text.length - MAX_TRANSCRIPT_CHARS)
  }
  return text
}

const SUMMARY_TIMEOUT_MS = 60_000
const SUMMARY_MAX_TOKENS = 2048

const SUMMARY_SYSTEM_ZH = [
  '你是一个对话压缩器。请把以下开发者与 AI 助手的对话，压缩成一份简洁但信息完整的摘要，供后续对话继续参考。',
  '必须保留：',
  '1. 用户的核心目标与明确指令（尤其是尚未完成的要求）；',
  '2. 关键决定、结论与已达成的共识；',
  '3. 已完成的改动：涉及的文件、函数、命令及其结果；',
  '4. 尚未完成的任务与下一步计划；',
  '5. 重要的事实、约束、报错与踩过的坑。',
  '要求：用要点式罗列；代码片段、文件路径、命令、标识符一律保留原文；不要臆造未发生的内容；只输出摘要正文，不要客套或额外解释。'
].join('\n')

const SUMMARY_SYSTEM_EN = [
  'You are a conversation compactor. Compress the following developer–AI conversation into a concise but complete summary for the conversation to continue from.',
  'You must preserve:',
  "1. The user's core goals and explicit instructions (especially unfinished requests);",
  '2. Key decisions, conclusions, and agreements reached;',
  '3. Completed changes: files, functions, and commands involved and their results;',
  '4. Outstanding tasks and next steps;',
  '5. Important facts, constraints, errors, and pitfalls encountered.',
  'Rules: use bullet points; keep code snippets, file paths, commands, and identifiers verbatim; do not invent anything; output only the summary body, no pleasantries or extra explanation.'
].join('\n')

async function summarize(
  model: CompactModelConfig,
  transcript: string,
  locale: string,
  signal: AbortSignal
): Promise<string> {
  const zh = locale !== 'en'
  const system = zh ? SUMMARY_SYSTEM_ZH : SUMMARY_SYSTEM_EN
  const userText = zh
    ? `以下是需要压缩的对话记录，请据此产出摘要：\n\n${transcript}`
    : `Here is the conversation to compact. Produce the summary accordingly:\n\n${transcript}`

  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS)
  try {
    let text = ''
    let errMsg = ''
    for await (const ev of streamChat(
      { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
      {
        model: model.model,
        system,
        messages: [{ role: 'user', content: userText }],
        maxTokens: SUMMARY_MAX_TOKENS,
        temperature: 0.3,
        signal: ctrl.signal
      }
    )) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'error') errMsg = ev.error.message
    }
    if (!text.trim() && errMsg) throw new Error(errMsg)
    return text.trim()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// 保留尾部目标 ≈ 窗口的 30%（压缩后仍有充足近期上下文）。
const KEEP_RATIO = 0.3
const KEEP_TOKENS_MIN = 2000

/**
 * 压缩一个会话：选边界 → 转录待压段 → 一次性摘要 → 用 [摘要消息, ...尾部] 替换 messages 并落盘。
 * 成功 'compacted'；无可压 'none'；摘要失败 'failed'（历史保持不变）。
 */
export async function compactSession(args: {
  session: StoredSession
  model: CompactModelConfig
  signal: AbortSignal
}): Promise<{ status: CompactStatus; message?: string }> {
  const { session, model, signal } = args
  const cfg = compactionConfig()
  const locale = String(getConfig().locale ?? 'zh-CN')
  const window = windowForModel(model.model, cfg.defaultWindow)
  const keepTokens = Math.max(KEEP_TOKENS_MIN, Math.round(window * KEEP_RATIO))

  const boundary = pickBoundary(session.messages, keepTokens)
  if (boundary < 0) return { status: 'none' }

  const toSummarize = session.messages.slice(0, boundary)
  const tail = session.messages.slice(boundary)
  const transcript = buildTranscript(toSummarize, locale)

  let summary = ''
  try {
    summary = await summarize(model, transcript, locale, signal)
  } catch (e) {
    return { status: 'failed', message: (e as Error)?.message ?? String(e) }
  }
  if (signal.aborted) return { status: 'failed', message: 'aborted' }
  if (!summary) return { status: 'failed', message: 'empty-summary' }

  const zh = locale !== 'en'
  const header = zh
    ? '以下是此前对话的摘要（为节省上下文，较早的消息已压缩）。请在此基础上继续。'
    : 'The following is a summary of the earlier conversation (older messages were compacted to save context). Continue from here.'
  const summaryMsg: Message = { role: 'user', content: `${COMPACT_MARKER}\n${header}\n\n${summary}` }

  session.messages = [summaryMsg, ...tail]
  // 终态提示边车随历史重排：锚在被压缩区（after <= boundary）的一并丢弃（其上下文已成摘要，
  // 不重建早期气泡）；锚在保留段的按新布局平移——摘要占新 0 号位，故 after -= boundary - 1。
  if (session.notices?.length)
    session.notices = session.notices
      .filter((nt) => nt.after > boundary)
      .map((nt) => ({ ...nt, after: nt.after - boundary + 1 }))
  session.lastInputTokens = undefined // 历史已缩短，旧计数失效
  session.updatedAt = Date.now()
  saveProject(session.id)
  return { status: 'compacted' }
}

/** 该消息是否为压缩摘要（重开时据此特殊渲染）。 */
export function isCompactionSummary(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(COMPACT_MARKER)
}

/** 去掉摘要标记前缀，返回可展示的摘要正文（含 header）。 */
export function stripMarker(content: string): string {
  if (!content.startsWith(COMPACT_MARKER)) return content
  return content.slice(COMPACT_MARKER.length).replace(/^\n+/, '')
}
