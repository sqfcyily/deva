import { ipcMain } from 'electron'
import { getSecret } from './secrets'
import { httpError, type ErrorKind, type NormalizedError } from '../providers/types'

/**
 * 服务商探针（主进程）：连通性测试 + 拉取模型清单。
 * 与流式对话共用密钥解密（getSecret，绝不外泄明文）与错误归一化（httpError）。
 * 两个能力都只在主进程发起 HTTP，渲染层只拿到 {ok, kind, message} 结果。
 */

type AdapterKind = 'anthropic' | 'openai'

interface ProbeConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
  /** 测试连接需要一个具体模型；拉取清单可省略 */
  model?: string
}

interface TestResult {
  ok: boolean
  kind?: ErrorKind
  message: string
  /** 成功时的往返耗时（毫秒） */
  latencyMs?: number
}

interface ListModelsResult {
  ok: boolean
  models?: string[]
  kind?: ErrorKind
  message?: string
}

const TIMEOUT_MS = 15_000

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
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

/** 从各家 /models 响应中抽取模型 ID（OpenAI: data[].id；个别实现: models[].id/name）。 */
function extractModelIds(json: unknown): string[] {
  const root = json as { data?: unknown[]; models?: unknown[] } | null
  const arr = Array.isArray(root?.data)
    ? root!.data
    : Array.isArray(root?.models)
      ? root!.models
      : []
  const ids = arr
    .map((it) => {
      const o = it as { id?: unknown; name?: unknown }
      const v = typeof o?.id === 'string' ? o.id : typeof o?.name === 'string' ? o.name : ''
      return v
    })
    .filter((v): v is string => Boolean(v))
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}

export function registerProviderIpc(): void {
  // 连通性测试：用解密后的密钥对目标发一个最小请求（max_tokens:1），只判成败。
  ipcMain.handle('provider:test', async (_e, cfg: ProbeConfig): Promise<TestResult> => {
    const model = cfg.model?.trim()
    if (!model) return { ok: false, kind: 'invalid_request', message: 'no-model' }

    const apiKey = (await getSecret(cfg.providerId)) ?? ''
    const base = normalizeBase(cfg.baseURL)
    const started = Date.now()
    try {
      let res: Response
      if (cfg.adapter === 'anthropic') {
        res = await fetchWithTimeout(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
          })
        })
      } else {
        res = await fetchWithTimeout(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }]
          })
        })
      }
      const latencyMs = Date.now() - started
      if (res.ok) return { ok: true, message: 'ok', latencyMs }
      const text = await res.text().catch(() => '')
      const err = httpError(res.status, text)
      return { ok: false, kind: err.kind, message: err.message, latencyMs }
    } catch (e) {
      const err = networkError(e)
      return { ok: false, kind: err.kind, message: err.message }
    }
  })

  // 拉取模型清单：GET /models（OpenAI 风味）或 /v1/models（Anthropic），失败时 UI 退回手动输入。
  ipcMain.handle('provider:list-models', async (_e, cfg: ProbeConfig): Promise<ListModelsResult> => {
    const apiKey = (await getSecret(cfg.providerId)) ?? ''
    const base = normalizeBase(cfg.baseURL)
    try {
      const res =
        cfg.adapter === 'anthropic'
          ? await fetchWithTimeout(`${base}/v1/models`, {
              headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            })
          : await fetchWithTimeout(`${base}/models`, {
              headers: { authorization: `Bearer ${apiKey}` }
            })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const err = httpError(res.status, text)
        return { ok: false, kind: err.kind, message: err.message }
      }
      const json = await res.json().catch(() => null)
      return { ok: true, models: extractModelIds(json) }
    } catch (e) {
      const err = networkError(e)
      return { ok: false, kind: err.kind, message: err.message }
    }
  })
}
