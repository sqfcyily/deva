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

/** 单个类型化问题：一句话描述要决策什么，可选给出候选项（供适配器做更结构化的判定）。 */
export interface DecisionQuestion {
  /** 稳定标识，用于把结果对回问题。 */
  id: string
  /** 自然语言：要决策的事项（如「现在是否该主动给用户发条消息？」）。 */
  prompt: string
  /** 可选候选项/枚举，交由适配器解释。 */
  options?: string[]
}

/** 交给决策模型的「世界状态」：自由文本情境 + 结构化信号（近期活动/计数/时间戳等）。 */
export interface DecisionState {
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

/** 通用 state（context+signals）折成 Jev 需要的单串文本：情境正文 + 结构化信号 JSON。 */
function stateToText(state: DecisionState): string {
  const ctx = state.context?.trim() ?? ''
  if (state.signals && Object.keys(state.signals).length > 0) {
    const sig = JSON.stringify(state.signals)
    return ctx ? `${ctx}\n\n${sig}` : sig
  }
  return ctx
}

/** 通用问题数组折成 Jev 的 questions 对象：无候选→noul（是/否概率），有候选→choice。 */
function buildJevQuestions(questions: DecisionQuestion[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const q of questions) {
    if (q.options && q.options.length > 0) {
      const criteria: Record<string, string> = {}
      for (const opt of q.options) criteria[opt] = opt
      out[q.id] = { type: 'choice', instructions: q.prompt, criteria }
    } else {
      out[q.id] = { type: 'noul', instructions: q.prompt }
    }
  }
  return out
}

/** 从单个 Jev answer 折出闸门用置信度 [0,1]（+ 可选理由：所选项 / 分值）。 */
function answerConfidence(answer: unknown): { confidence: number; reason?: string } {
  const a = (answer ?? {}) as {
    type?: unknown
    noul?: unknown
    confidence?: unknown
    choice?: unknown
    score?: unknown
  }
  if (a.type === 'noul' || a.noul !== undefined) return { confidence: clamp01(a.noul) }
  if (a.type === 'choice')
    return { confidence: clamp01(a.confidence), reason: typeof a.choice === 'string' ? a.choice : undefined }
  if (a.type === 'score')
    return { confidence: clamp01(a.confidence), reason: a.score !== undefined ? String(a.score) : undefined }
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
  try {
    const res = await fetchWithTimeout(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        state: stateToText(state),
        model: cfg.model ?? DEFAULT_JEV_MODEL,
        questions: buildJevQuestions(questions)
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = httpError(res.status, text)
      return { ok: false, outcomes: [], kind: err.kind, message: err.message }
    }
    const json = await res.json().catch(() => null)
    const answers = (json as { answers?: Record<string, unknown> } | null)?.answers ?? {}
    // 按 id 对回；缺失的问题给 0 置信度（不发起）。阈值折算成布尔闸门。
    const outcomes: DecisionOutcome[] = questions.map((q) => {
      const { confidence, reason } = answerConfidence(answers[q.id])
      return { id: q.id, confidence, decide: confidence >= cfg.threshold, reason }
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
