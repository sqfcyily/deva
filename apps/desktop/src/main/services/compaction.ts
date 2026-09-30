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
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
  model: string
}

/** 摘要消息的标记前缀：极不可能被用户键入；重开时据此识别摘要消息并特殊渲染。 */
export const COMPACT_MARKER = '⟦deva:compaction⟧'

/**
 * 引擎自愈引导消息的标记前缀（输出被截断后续写、空回合追问等）。这类 user 消息由主进程注入，
 * 不是用户说的话：不算一轮起点、不渲染成用户气泡、不进压缩转录。
 */
export const AUTO_MARKER = '⟦deva:auto⟧'

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
      return p.content.length / CHARS_PER_TOKEN + 8 + (p.images?.length ?? 0) * IMAGE_TOKENS
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

/**
 * 一轮进行中（Agent 循环两步之间）是否已接近窗口：用量 = 最近一次请求的真实总输入 + 其后新增消息
 * （助手输出 / 工具结果）的估算。只看上一步读数会低估——工具结果常常很大（读了一个大文件），
 * 它们不在那次读数里、却要随下一步整个发出去。拿不到真实用量时回退全历史估算。
 * lastInputAt = 那次请求发出时的历史长度。
 */
export function needsCompactionMidTurn(
  messages: Message[],
  modelId: string,
  lastInput: number,
  lastInputAt: number,
  cfg: CompactionCfg = compactionConfig()
): boolean {
  if (!cfg.enabled) return false
  const window = windowForModel(modelId, cfg.defaultWindow)
  const used =
    lastInput > 0 ? lastInput + estimateTokens(messages.slice(lastInputAt)) : estimateTokens(messages)
  return used >= window * cfg.triggerRatio
}

// ── 边界选取 ──────────────────────────────────────────────────────────────────
function hasToolResult(m: Message): boolean {
  return typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result')
}

/**
 * 真实用户轮：role=user 且不含 tool_result（工具结果回灌消息不算），也不是压缩摘要——
 * 轮中压缩会把摘要放在本轮用户请求之后，摘要若算作轮起点，下次压缩就会把它当成「本轮请求」保留、
 * 而把真正的请求原文压掉。
 */
function isGenuineUserTurn(m: Message): boolean {
  return m.role === 'user' && !hasToolResult(m) && !isCompactionSummary(m) && !isAutoNudge(m)
}

/** 助手消息是否带工具调用（一轮进行中，除最后一步外的每条助手消息都带）。 */
function hasToolUse(m: Message): boolean {
  return (
    m.role === 'assistant' &&
    typeof m.content !== 'string' &&
    m.content.some((p) => p.type === 'tool_use')
  )
}

/** 最后一轮（一轮进行中即当前这轮）的起点：最后一条真实用户消息的下标，没有则 -1。 */
export function lastTurnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isGenuineUserTurn(messages[i])) return i
  return -1
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

/**
 * 轮内切点（仅轮中压缩用）：当前这轮自身已大到 pickBoundary 找不到边界时（它只在真实用户轮上切，
 * 而进行中的这轮从头到尾只有一条），改在本轮内部切。从末尾累加到 keepTokens，再吸附到一条带工具调用的
 * 助手消息——以它起头的尾部，其每个 tool_use 的结果都在尾部内，配对不会被切开。
 * 返回 cut：(start, cut) 是本轮已完成、待并入摘要的步骤；至少要压掉一整步才值得，否则 -1。
 */
function pickInTurnCut(messages: Message[], start: number, keepTokens: number): number {
  const n = messages.length
  let acc = 0
  let idx = -1
  for (let i = n - 1; i > start; i--) {
    acc += messageTokens(messages[i])
    if (acc >= keepTokens) {
      idx = i
      break
    }
  }
  if (idx < 0) return -1 // 本轮到目前为止也不大：该压的是此前的轮，那是 pickBoundary 的事

  let cut = -1
  for (let i = idx; i < n; i++)
    if (hasToolUse(messages[i])) {
      cut = i
      break
    }
  // 最后一条工具结果自己就超过保留量（比如刚读了个大文件）：退到最后一步，尾部只留这一步。
  if (cut < 0)
    for (let i = idx - 1; i > start; i--)
      if (hasToolUse(messages[i])) {
        cut = i
        break
      }
  // start 是用户请求，start+1 / start+2 是第一步的助手消息与工具结果：cut 至少落在第二步上。
  return cut >= start + 3 ? cut : -1
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
    if (isAutoNudge(m)) continue
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

/**
 * 单次摘要请求的总时长上限：只用来兜住「一直慢吞吞吐字却永不收尾」的跑飞流。
 * 真正的「死连接」判定交给 SSE 层的空闲看门狗（STREAM_IDLE_MS：静默 60s 即判中断、可重试）。
 * 注：此处曾是 60s 总时长——长转录 + 慢模型（尤其先吐一大段思维链的推理模型）正常也跑不完，
 * 一刀切下去正文为空，用户只看到一句无从下手的「压缩失败」。
 */
const SUMMARY_TIMEOUT_MS = 300_000
/** 摘要输出预算。留足余量：推理模型的思维链同样吃这份预算，给太小会挤得吐不出正文。 */
const SUMMARY_MAX_TOKENS = 4096
/**
 * 摘要请求的重试次数（与主循环 MAX_RECONNECT 同值）。
 * 主循环遇可重试断流会自动重连，摘要却是一次性请求——断一次就前功尽弃，故必须自己重试。
 */
const SUMMARY_MAX_RETRY = 3

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

/** 可被取消打断的退避等待（重试间隔）。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** 摘要中止（用户按下停止）：与「摘要失败」区分开，调用方据此给不同结论。 */
class SummaryAborted extends Error {}

/**
 * 请模型产出摘要。**只接受「干净收尾且有正文」的结果**——
 * 半截摘要一旦被采信就会顶替掉真实历史，且不可逆，故宁可整轮不压也不要残缺摘要。
 * 断流/限流/超时按可重试处理（指数退避，至多 SUMMARY_MAX_RETRY 次）；
 * 鉴权、参数等致命错误立即抛出——重试无益，把原文抛给用户看才有用。
 */
async function summarize(
  model: CompactModelConfig,
  transcript: string,
  locale: string,
  signal: AbortSignal,
  midTurn = false
): Promise<string> {
  const zh = locale !== 'en'
  const system = zh ? SUMMARY_SYSTEM_ZH : SUMMARY_SYSTEM_EN
  // 轮中压缩：最后那条用户请求还在执行，摘要要能让助手接着做下去，而不只是回顾。
  const midTurnHint = !midTurn
    ? ''
    : zh
      ? '注意：记录里最后一条用户请求仍在执行中。请重点保留围绕它已经完成的步骤、查到的关键信息、改过的文件与下一步要做什么。\n\n'
      : 'Note: the last user request in this transcript is still being worked on. Focus on the steps already completed for it, key findings, files changed, and what to do next.\n\n'
  const userText = zh
    ? `${midTurnHint}以下是需要压缩的对话记录，请据此产出摘要：\n\n${transcript}`
    : `${midTurnHint}Here is the conversation to compact. Produce the summary accordingly:\n\n${transcript}`

  let lastReason = '摘要请求未能完成'

  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new SummaryAborted('已中止')

    const ctrl = new AbortController()
    const onAbort = (): void => ctrl.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, SUMMARY_TIMEOUT_MS)

    let text = ''
    let fatal = ''
    let retryable = ''
    // 流是否非正常收尾（done 的 stopReason 为 error/aborted）：此时手里的正文必定残缺，不可采信。
    let interrupted = false

    try {
      for await (const ev of streamChat(
        { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL },
        {
          model: model.model,
          system,
          messages: [{ role: 'user', content: userText }],
          maxTokens: SUMMARY_MAX_TOKENS,
          // 不传 temperature：新版 Claude（如 Opus）已弃用该参数，传了直接 400；用模型默认值即可。
          signal: ctrl.signal
        }
      )) {
        if (ev.type === 'text_delta') text += ev.text
        else if (ev.type === 'error') {
          if (ev.error.retryable) retryable = ev.error.message
          else fatal = ev.error.message
        } else if (ev.type === 'done') {
          if (ev.stopReason === 'error' || ev.stopReason === 'aborted') interrupted = true
        }
      }
    } catch (e) {
      // 适配器之外的意外（JSON/运行时错误）：按可重试处理，最后一次仍败则原文上报。
      retryable = (e as Error)?.message ?? String(e)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }

    if (signal.aborted) throw new SummaryAborted('已中止')
    if (fatal) throw new Error(fatal)

    const body = text.trim()
    if (!retryable && !timedOut && !interrupted) {
      if (body) return body
      // 干净收尾却没有正文：多为模型只吐了思维链、或被内容策略挡下。重试无益，直说。
      throw new Error('模型没有返回摘要正文（可能只输出了思维链，或被内容策略拦截）')
    }

    lastReason = timedOut
      ? `摘要请求超过 ${Math.round(SUMMARY_TIMEOUT_MS / 1000)}s 仍未完成`
      : retryable || '连接中断'
    if (attempt >= SUMMARY_MAX_RETRY)
      throw new Error(`${lastReason}（已重试 ${SUMMARY_MAX_RETRY} 次）`)

    await sleep(Math.min(1000 * 2 ** attempt, 8000), signal)
  }
}

/**
 * 轮内切时迁移检查点记录：被并入摘要的那几步，其 tool_use 已从历史里消失，而回滚按「这一轮起的全部
 * tool_use id」查记录——不迁走，事后回滚这一轮就会漏掉这几步改过的文件（恢复到一个中间状态）。
 * 挪到尾部第一个 tool_use 名下（同一轮），回滚按 seq 取最早记录，归到哪个 id 下不影响结果。
 */
function moveCheckpoints(session: StoredSession, removed: Message[], tail: Message[]): void {
  const cps = session.checkpoints
  if (!cps) return
  let anchor = ''
  for (const m of tail) {
    if (typeof m.content === 'string') continue
    const p = m.content.find((x) => x.type === 'tool_use')
    if (p && p.type === 'tool_use') {
      anchor = p.id
      break
    }
  }
  if (!anchor) return
  const moved: NonNullable<StoredSession['checkpoints']>[string] = []
  for (const m of removed) {
    if (typeof m.content === 'string') continue
    for (const p of m.content)
      if (p.type === 'tool_use' && cps[p.id]) {
        moved.push(...cps[p.id])
        delete cps[p.id]
      }
  }
  if (moved.length) cps[anchor] = [...moved, ...(cps[anchor] ?? [])]
}

// 保留尾部目标 ≈ 窗口的 30%（压缩后仍有充足近期上下文）。
const KEEP_RATIO = 0.3
const KEEP_TOKENS_MIN = 2000

/**
 * 压缩一个会话：选边界 → 转录待压段 → 一次性摘要 → 用 [摘要消息, ...尾部] 替换 messages 并落盘。
 * 成功 'compacted'；无可压 'none'；摘要失败 'failed'（历史保持不变）。
 * **就地改写** session.messages（不重新赋值）：轮中压缩时 Agent 循环正拿着这个数组往里追加。
 */
export async function compactSession(args: {
  session: StoredSession
  model: CompactModelConfig
  signal: AbortSignal
  /**
   * 一轮进行中调用（Agent 循环两步之间）。先照常只压此前的轮；本轮自身已大到装不下时，
   * 改为在本轮内部切：保留本轮用户请求原文 + 近期步骤，其间已完成的步骤并入摘要，
   * 布局为 [本轮请求, 摘要, ...近期步骤]。
   */
  midTurn?: boolean
}): Promise<{ status: CompactStatus; message?: string }> {
  const { session, model, signal } = args
  const cfg = compactionConfig()
  const locale = String(getConfig().locale ?? 'zh-CN')
  const window = windowForModel(model.model, cfg.defaultWindow)
  const keepTokens = Math.max(KEEP_TOKENS_MIN, Math.round(window * KEEP_RATIO))
  const msgs = session.messages

  let boundary = pickBoundary(msgs, keepTokens)
  // 轮内切时原样保留的本轮用户请求下标（-1 = 普通压缩，不保留）
  let keepHead = -1
  if (boundary < 0 && args.midTurn) {
    const start = lastTurnStart(msgs)
    const cut = start < 0 ? -1 : pickInTurnCut(msgs, start, keepTokens)
    if (cut > 0) {
      boundary = cut
      keepHead = start
    }
  }
  if (boundary < 0) return { status: 'none' }

  const toSummarize = msgs.slice(0, boundary)
  const tail = msgs.slice(boundary)
  const transcript = buildTranscript(toSummarize, locale)

  let summary = ''
  try {
    summary = await summarize(model, transcript, locale, signal, keepHead >= 0)
  } catch (e) {
    // 失败原因原样带回（鉴权 / 断流 / 超时 / 无正文）：调用方会连同提示一起展示给用户。
    // 历史在此之前一个字都没动，返回即安全收场。
    const message = e instanceof SummaryAborted ? '已中止' : ((e as Error)?.message ?? String(e))
    return { status: 'failed', message }
  }
  if (signal.aborted) return { status: 'failed', message: '已中止' }
  if (!summary) return { status: 'failed', message: '模型没有返回摘要正文' }

  const zh = locale !== 'en'
  const header =
    keepHead >= 0
      ? zh
        ? '以下是此前对话以及本轮任务已完成部分的摘要（为节省上下文，较早的消息已压缩）。上面那条是用户本轮的原始请求，任务仍在进行中：请在此基础上接着做，不要从头再来，也不要重复已经完成的步骤。'
        : "The following summarizes the earlier conversation and the work already done on the current task (older messages were compacted to save context). The message above is the user's original request for this turn, and the task is still in progress: continue from here — do not start over or repeat steps already completed."
      : zh
        ? '以下是此前对话的摘要（为节省上下文，较早的消息已压缩）。请在此基础上继续。'
        : 'The following is a summary of the earlier conversation (older messages were compacted to save context). Continue from here.'
  const summaryMsg: Message = { role: 'user', content: `${COMPACT_MARKER}\n${header}\n\n${summary}` }
  // 轮内切：本轮请求原样留在最前（附件一并保留），摘要紧随其后。两条 user 连着，发送前由
  // normalizeMessages 合并；摘要不算轮起点，故本轮在轮下标上仍是同一轮。
  const head = keepHead >= 0 ? [msgs[keepHead]] : []

  if (keepHead >= 0) moveCheckpoints(session, msgs.slice(keepHead + 1, boundary), tail)

  msgs.splice(0, msgs.length, ...head, summaryMsg, ...tail)
  // 终态提示边车随历史重排：锚在被压缩区（after <= boundary）的一并丢弃（其上下文已成摘要，
  // 不重建早期气泡）；锚在保留段的按新布局平移——尾部前面现在是 [head..., 摘要]，故 after -= boundary - offset。
  const offset = head.length + 1
  if (session.notices?.length)
    session.notices = session.notices
      .filter((nt) => nt.after > boundary)
      .map((nt) => ({ ...nt, after: nt.after - boundary + offset }))
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

/** 该消息是否为引擎注入的自愈引导（见 AUTO_MARKER）。 */
export function isAutoNudge(m: Message): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(AUTO_MARKER)
}
