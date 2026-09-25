import { ipcMain } from 'electron'
import { getSecret } from './secrets'
import { httpError, type ErrorKind, type NormalizedError } from '../providers/types'

/**
 * 决策服务（主进程）——「是否该做某事」的类型化概率决策运行时。
 *
 * 通用契约（**厂商中立**）：给定「世界状态」+ 一组「类型化问题」，返回每题一个 [0,1] 置信度，
 * 并按各服务商配置的阈值折算成布尔闸门（confidence ≥ threshold → decide）。
 * 与 LLM 流式对话正交：**不生成文本、单次非流式、绝不经 `streamChat`**——决策模型（purpose='decision'）
 * 只能走到这里。首个适配器为 TypeSafe · Jev（adapter='jev'）；`jev` 仅作内部适配器值，公共面一律用通用名 decision。
 *
 * 密钥复用 secrets.ts 的解密（getSecret，绝不外泄明文），HTTP 只在主进程发起，
 * 渲染层只拿 {ok, kind, message}（测试）或 {ok, outcomes}（决策，供 Phase 3 任务侧内部调用）。
 * 错误归一化复用 providers/types 的 httpError（与服务商探针同一套 kind）。
 */

/** 决策适配器（可扩展；当前仅 Jev）。 */
export type DecisionAdapter = 'jev'

/**
 * 单个类型化问题。
 * 简写：只给 prompt（+ 可选 options）→ 无 options 为 noul、有 options 为 choice（选项描述=选项名）。
 * 显式：给 type 与对应 criteria（与 Jev 契约同形）——
 *   · choice：optionCriteria = { 选项: 描述 | null }（描述会发给模型，应写清各选项区别）；
 *   · score ：levels = 有序等级描述数组（2~10 级）；
 *   · noul  ：noulCriteria = { true?: 是的含义, false?: 否的含义 }。
 * prompt 可为字符串或对象（Jev instructions 支持结构化：问题放一个字段，数据放其他字段）。
 */
export interface DecisionQuestion {
  /** 稳定标识，用于把结果对回问题（不发给模型）。 */
  id: string
  /** 要决策的事项（Jev instructions）。 */
  prompt: string | Record<string, unknown>
  /** 简写 choice 的候选项（描述即选项名）。 */
  options?: string[]
  /** 显式题型；缺省按 options 推断。 */
  type?: 'noul' | 'choice' | 'score'
  /** choice：选项 → 描述（null = 无需描述）。 */
  optionCriteria?: Record<string, string | Record<string, unknown> | null>
  /** score：有序等级描述（低 → 高）。 */
  levels?: string[]
  /** noul：是/否各自含义。 */
  noulCriteria?: { true?: string; false?: string }
}

/**
 * 交给决策模型的「世界状态」。
 * data（推荐）：结构化对象，原样作为 Jev 的 state 上送（文档推荐用对象，字段名即语义）。
 * 否则退回旧形态：自由文本 context + signals JSON 拼成字符串。
 */
export interface DecisionState {
  /** 结构化 state（优先）。 */
  data?: Record<string, unknown> | unknown[]
  /** 自由文本情境描述。 */
  context?: string
  /** 结构化信号，键值不限，序列化后随请求上送。 */
  signals?: Record<string, unknown>
}

/** 单题决策结果。 */
export interface DecisionOutcome {
  id: string
  /** 置信度 [0,1]（「该做/是」的概率）。 */
  confidence: number
  /** 闸门：confidence ≥ threshold。 */
  decide: boolean
  /** 适配器若返回则带上的简短理由。 */
  reason?: string
  /** choice 题：所选候选项（原样对应 DecisionQuestion.options 之一）；noul 题缺省。 */
  choice?: string
  /** choice / score 题：各候选项（score 为等级下标字符串）概率。 */
  probabilities?: Record<string, number>
  /** noul 题：是的概率（与 confidence 相同，显式给出便于阅读）。 */
  noul?: number
  /** score 题：概率加权等级值（可落在两级之间，0 基）。 */
  score?: number
}

export interface DecisionResult {
  ok: boolean
  outcomes: DecisionOutcome[]
  kind?: ErrorKind
  message?: string
}

/** 决策连接配置（密钥已解密，仅在主进程内传递；threshold 为闸门阈值）。 */
export interface DecisionConfig {
  adapter: DecisionAdapter
  providerId: string
  baseURL: string
  /** 折算布尔闸门用的阈值 [0,1]。 */
  threshold: number
  /** 决策模型版本标识（Jev：如 'jev-latest'/'jev-1.13.0'）；缺省用 DEFAULT_JEV_MODEL。 */
  model?: string
}

/** 测试连接结果（形状对齐服务商探针 provider:test，便于渲染层复用 UI）。 */
export interface DecisionTestResult {
  ok: boolean
  kind?: ErrorKind
  message: string
  latencyMs?: number
}

const TIMEOUT_MS = 15_000

/** Jev 默认模型版本（决策模型无「模型清单」，故 provider 未配 model 时的回落值）。 */
const DEFAULT_JEV_MODEL = 'jev-latest'

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/** 带超时的 fetch；超时按 AbortError 抛出，交由 networkError 归一。 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function networkError(e: unknown): NormalizedError {
  const aborted = (e as Error)?.name === 'AbortError'
  return {
    kind: 'network',
    retryable: true,
    message: aborted ? `请求超时（${TIMEOUT_MS / 1000}s）` : String((e as Error)?.message ?? e)
  }
}

/**
 * TypeSafe · Jev「System One」HTTP 契约（https://docs.typesafe.ai）：
 *   POST {base}/v1/systemone   Authorization: Bearer <key>   Content-Type: application/json
 *   { state: <string 待评估文本>, model: <如 'jev-latest'>, questions: { <名>: {type,instructions,criteria?} } }
 *   type ∈ noul(是/否概率) | choice(选项，附 criteria 键→描述) | score(打分，criteria 为分级描述数组)
 * 响应：{ model, answers: { <名>: {...} }, usage:{input_tokens,output_tokens} }
 *   noul → {type,noul:number[0,1]}；choice → {type,choice,confidence,probabilities}；score → {type,score,confidence,legend,probabilities}
 */

/** 通用 state → Jev state：有 data 原样上送（对象/数组）；否则 context + signals JSON 拼成字符串。 */
function stateToJev(state: DecisionState): unknown {
  if (state.data !== undefined) return state.data
  const ctx = state.context?.trim() ?? ''
  if (state.signals && Object.keys(state.signals).length > 0) {
    const sig = JSON.stringify(state.signals)
    return ctx ? `${ctx}\n\n${sig}` : sig
  }
  return ctx
}

/** 通用问题数组折成 Jev 的 questions 对象（显式 type 优先，否则按 options 推断 noul/choice）。 */
function buildJevQuestions(questions: DecisionQuestion[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const q of questions) {
    const type = q.type ?? (q.options && q.options.length > 0 ? 'choice' : 'noul')
    if (type === 'choice') {
      let criteria = q.optionCriteria
      if (!criteria) {
        criteria = {}
        for (const opt of q.options ?? []) criteria[opt] = opt
      }
      out[q.id] = { type: 'choice', instructions: q.prompt, criteria }
    } else if (type === 'score') {
      out[q.id] = { type: 'score', instructions: q.prompt, criteria: q.levels ?? [] }
    } else {
      out[q.id] = {
        type: 'noul',
        instructions: q.prompt,
        ...(q.noulCriteria ? { criteria: q.noulCriteria } : {})
      }
    }
  }
  return out
}

/** 可重试的状态码：429 限流 / 529 过载（文档要求指数退避重试）。 */
const RETRYABLE_STATUS = new Set([429, 529])
/** 最多额外重试次数与退避基数（ms）：500 → 1000。 */
const MAX_RETRIES = 2
const RETRY_BASE_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 退避时长：优先服务端 Retry-After（秒，封顶 5s），否则指数退避 + 少量抖动。 */
function retryDelay(res: Response, attempt: number): number {
  const ra = Number(res.headers.get('retry-after'))
  if (Number.isFinite(ra) && ra > 0) return Math.min(5000, ra * 1000)
  return RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 150)
}

/** 从单个 Jev answer 折出闸门用置信度 [0,1]（+ 可选理由：所选项 / 分值）。 */
function answerConfidence(answer: unknown): {
  confidence: number
  reason?: string
  choice?: string
  probabilities?: Record<string, number>
  noul?: number
  score?: number
} {
  const a = (answer ?? {}) as {
    type?: unknown
    noul?: unknown
    confidence?: unknown
    choice?: unknown
    score?: unknown
    probabilities?: unknown
  }
  const probs = (): Record<string, number> | undefined => {
    if (!a.probabilities || typeof a.probabilities !== 'object') return undefined
    const p: Record<string, number> = {}
    for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) p[k] = clamp01(v)
    return p
  }
  if (a.type === 'noul' || a.noul !== undefined) {
    const n = clamp01(a.noul)
    return { confidence: n, noul: n }
  }
  if (a.type === 'choice') {
    const choice = typeof a.choice === 'string' ? a.choice : undefined
    return { confidence: clamp01(a.confidence), reason: choice, choice, probabilities: probs() }
  }
  if (a.type === 'score') {
    const s = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : undefined
    return {
      confidence: clamp01(a.confidence),
      reason: s !== undefined ? String(s) : undefined,
      score: s,
      probabilities: probs()
    }
  }
  // 兜底：拿得到 confidence/noul 就用。
  return { confidence: clamp01(a.confidence ?? a.noul) }
}

/** Jev 适配器：单次非流式 POST /v1/systemone，按 id 折回每题闸门置信度。 */
async function decideJev(
  cfg: DecisionConfig,
  state: DecisionState,
  questions: DecisionQuestion[]
): Promise<DecisionResult> {
  const apiKey = (await getSecret(cfg.providerId)) ?? ''
  if (!apiKey) return { ok: false, outcomes: [], kind: 'auth', message: 'no-key' }
  const base = normalizeBase(cfg.baseURL)
  const body = JSON.stringify({
    state: stateToJev(state),
    model: cfg.model ?? DEFAULT_JEV_MODEL,
    questions: buildJevQuestions(questions)
  })
  try {
    let res: Response
    // 429/529：按文档指数退避重试（最多 MAX_RETRIES 次）；其余错误立即返回。
    for (let attempt = 0; ; attempt++) {
      res = await fetchWithTimeout(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body
      })
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= MAX_RETRIES) break
      const wait = retryDelay(res, attempt)
      console.warn(`[decision] ${res.status}，${wait}ms 后重试（第 ${attempt + 1} 次）`)
      await res.text().catch(() => '')
      await sleep(wait)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = httpError(res.status, text)
      return { ok: false, outcomes: [], kind: err.kind, message: err.message }
    }
    const json = await res.json().catch(() => null)
    const answers = (json as { answers?: Record<string, unknown> } | null)?.answers ?? {}
    // 按 id 对回；缺失的问题给 0 置信度（不发起）。阈值折算成布尔闸门。
    const outcomes: DecisionOutcome[] = questions.map((q) => {
      const a = answerConfidence(answers[q.id])
      return { id: q.id, ...a, decide: a.confidence >= cfg.threshold }
    })
    return { ok: true, outcomes }
  } catch (e) {
    const err = networkError(e)
    return { ok: false, outcomes: [], kind: err.kind, message: err.message }
  }
}

/**
 * 通用决策入口（主进程内部调用，Phase 3 由任务侧闸门使用）：按 adapter 分派。
 * 绝不经 IPC 暴露给渲染层——决策结果只在主进程内驱动「是否主动发起」。
 */
export async function decide(
  cfg: DecisionConfig,
  state: DecisionState,
  questions: DecisionQuestion[]
): Promise<DecisionResult> {
  switch (cfg.adapter) {
    case 'jev':
      return decideJev(cfg, state, questions)
    default:
      return { ok: false, outcomes: [], kind: 'invalid_request', message: `unknown adapter` }
  }
}

/**
 * 决策专属「测试连接」：用一个平凡问题探连通 + 鉴权，只判成败（不消费具体决策结果），
 * 语义对齐服务商探针的 ping。任何 2xx 即视为通。
 */
async function testJev(cfg: DecisionConfig): Promise<DecisionTestResult> {
  const apiKey = (await getSecret(cfg.providerId)) ?? ''
  if (!apiKey) return { ok: false, kind: 'auth', message: 'no-key' }
  const base = normalizeBase(cfg.baseURL)
  const started = Date.now()
  try {
    const res = await fetchWithTimeout(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        state: 'ping',
        model: cfg.model ?? DEFAULT_JEV_MODEL,
        questions: { ping: { type: 'noul', instructions: 'ping' } }
      })
    })
    const latencyMs = Date.now() - started
    if (res.ok) return { ok: true, message: 'ok', latencyMs }
    const text = await res.text().catch(() => '')
    const err = httpError(res.status, text)
    return { ok: false, kind: err.kind, message: err.message, latencyMs }
  } catch (e) {
    const err = networkError(e)
    return { ok: false, kind: err.kind, message: err.message }
  }
}

export function registerDecisionIpc(): void {
  // 决策专属测试连接：解密密钥对目标发一个最小决策请求，只判成败（明文不出主进程）。
  ipcMain.handle('decision:test', async (_e, cfg: DecisionConfig): Promise<DecisionTestResult> => {
    switch (cfg.adapter) {
      case 'jev':
        return testJev(cfg)
      default:
        return { ok: false, kind: 'invalid_request', message: 'unknown adapter' }
    }
  })
}
