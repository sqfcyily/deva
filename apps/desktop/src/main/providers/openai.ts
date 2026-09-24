import { iterateSSE, STREAM_IDLE_MS } from './sse'
import {
  httpError,
  type AdapterConfig,
  type ContentPart,
  type GenerateRequest,
  type Message,
  type StopReason,
  type StreamEvent
} from './types'

/**
 * OpenAI Chat Completions 风味适配器（兼容 DeepSeek / Moonshot / 智谱 / Qwen / Ollama 等）。
 * 端点：POST {baseURL}/chat/completions（stream:true）。
 * 归一化要点：工具结果拆成独立 {role:'tool'} 消息；tool_calls 增量按 index 拼接。
 */

/** OpenAI 富内容块（多模态 user 消息用）。 */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAIContentPart[]
  tool_call_id?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

/** 把归一化消息展开成 OpenAI 消息序列（一条 assistant 的工具结果会裂成多条 tool 消息）。 */
function mapMessages(system: string | undefined, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('')
      const toolUses = m.content.filter(
        (p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use'
      )
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.length
          ? toolUses.map((t) => ({
              id: t.id,
              type: 'function' as const,
              function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) }
            }))
          : undefined
      })
      continue
    }

    // user 消息：文本/图片合并为一条 user；tool_result 各成一条 tool 消息
    const texts: string[] = []
    const images: OpenAIContentPart[] = []
    for (const p of m.content) {
      if (p.type === 'text') texts.push(p.text)
      else if (p.type === 'image')
        images.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } })
      else if (p.type === 'document')
        // OpenAI Chat 无原生 PDF 通道：降级为文字说明，避免上下文断裂
        texts.push(`[附加文档：${p.name ?? '未命名'}（当前模型不支持直接读取其内容）]`)
      else if (p.type === 'tool_result')
        out.push({ role: 'tool', tool_call_id: p.toolUseId, content: p.content })
    }
    if (images.length) {
      const parts: OpenAIContentPart[] = []
      if (texts.length) parts.push({ type: 'text', text: texts.join('\n') })
      parts.push(...images)
      out.push({ role: 'user', content: parts })
    } else if (texts.length) {
      out.push({ role: 'user', content: texts.join('\n') })
    }
  }
  return out
}

function mapFinishReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

interface PendingCall {
  id: string
  name: string
  args: string
}

export async function* streamOpenAI(
  cfg: AdapterConfig,
  req: GenerateRequest
): AsyncGenerator<StreamEvent> {
  const url = `${cfg.baseURL.replace(/\/$/, '')}/chat/completions`
  const body = {
    model: req.model,
    messages: mapMessages(req.system, req.messages),
    tools: req.tools?.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.inputSchema }
    })),
    temperature: req.temperature,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      yield { type: 'done', stopReason: 'aborted' }
      return
    }
    yield { type: 'error', error: { kind: 'network', retryable: true, message: String((e as Error)?.message ?? e) } }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    yield { type: 'error', error: httpError(res.status, text) }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  // index -> 正在拼接的 tool_call
  const calls = new Map<number, PendingCall>()
  let stopReason: StopReason = 'end_turn'
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0

  const flushCalls = function* (): Generator<StreamEvent> {
    const indices = [...calls.keys()].sort((a, b) => a - b)
    for (const i of indices) {
      const c = calls.get(i)!
      let args: unknown = {}
      try {
        args = c.args ? JSON.parse(c.args) : {}
      } catch {
        args = {}
      }
      yield { type: 'tool_call', id: c.id, name: c.name, args }
    }
    calls.clear()
  }

  try {
    for await (const { data } of iterateSSE(res, STREAM_IDLE_MS)) {
      if (data === '[DONE]') break
      let chunk: Record<string, unknown>
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }

      // 带内错误块：不少网关用 HTTP 200 + `data: {"error":{...}}` 报错（配额耗尽、内容拦截、
      // 上游 5xx 等）。这类块没有 choices，若只管 choices 就会被静默跳过 —— 本轮遂以
      // 「自然结束 + 零正文」收场，用户只看到一句语焉不详的空回合提示。必须原样上报。
      const inband = chunk.error as { message?: string; code?: string; type?: string } | undefined
      if (inband && !Array.isArray(chunk.choices)) {
        const message = inband.message ?? inband.code ?? inband.type ?? '服务端返回了未说明的错误'
        yield { type: 'error', error: { kind: 'server', retryable: false, message } }
        yield { type: 'done', stopReason: 'error' }
        return
      }

      const usage = chunk.usage as {
        prompt_tokens?: number
        completion_tokens?: number
        /** OpenAI 口径：命中量是 prompt_tokens 的子集 */
        prompt_tokens_details?: { cached_tokens?: number }
        /** DeepSeek 口径：命中 / 未命中分列，相加等于 prompt_tokens */
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      } | null
      if (usage) {
        if (usage.prompt_tokens) inputTokens = usage.prompt_tokens
        if (usage.completion_tokens) outputTokens = usage.completion_tokens
        // 两家都是**服务端自动前缀缓存**（无需请求参数、不额外收写入费），故只有命中量、没有写入量。
        // prompt_tokens 本就是含命中的总量，不必再加。
        const hit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
        if (hit) cacheRead = hit
        // 个别网关只透传 DeepSeek 的命中/未命中两段而不给 prompt_tokens，此时相加兜底出总量。
        if (
          !usage.prompt_tokens &&
          (usage.prompt_cache_hit_tokens || usage.prompt_cache_miss_tokens)
        )
          inputTokens =
            (usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)
      }

      const choice = (chunk.choices as unknown[] | undefined)?.[0] as
        | {
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              /** 结构化拒绝文本（OpenAI 及兼容网关在拒绝时改走此字段，content 为空）。 */
              refusal?: string | null
              tool_calls?: {
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }[]
            }
            finish_reason?: string | null
          }
        | undefined
      if (!choice) continue

      const delta = choice.delta
      if (delta?.content) yield { type: 'text_delta', text: delta.content }
      // DeepSeek-R1 等把思维链放在 reasoning_content
      if (delta?.reasoning_content) yield { type: 'thinking_delta', text: delta.reasoning_content }
      // 拒绝走的是 refusal 字段而非 content：不接这一路，整轮就会「什么都没返回」——
      // 模型明明解释了为何不做，用户却只看到一条空回合提示。作为正文展示。
      if (delta?.refusal) yield { type: 'text_delta', text: delta.refusal }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name = tc.function.name
          if (tc.function?.arguments) cur.args += tc.function.arguments
          calls.set(tc.index, cur)
        }
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason)
        if (stopReason === 'tool_use') yield* flushCalls()
      }
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      yield { type: 'done', stopReason: 'aborted' }
      return
    }
    yield { type: 'error', error: { kind: 'network', retryable: true, message: String((e as Error)?.message ?? e) } }
    yield { type: 'done', stopReason: 'error' }
    return
  }

  // 兜底：有残留未 flush 的工具调用（个别实现不带 finish_reason）
  if (calls.size) {
    stopReason = 'tool_use'
    yield* flushCalls()
  }

  if (inputTokens || outputTokens)
    yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead }
  yield { type: 'done', stopReason }
}
