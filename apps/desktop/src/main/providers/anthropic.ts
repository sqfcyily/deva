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
 * Anthropic Messages API 适配器。手写 SSE → 归一化 StreamEvent，不引 SDK。
 * 端点：POST {baseURL}/v1/messages（stream:true）。
 */

function mapContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    if (p.type === 'tool_use')
      return { type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} }
    if (p.type === 'image')
      return {
        type: 'image',
        source: { type: 'base64', media_type: p.mediaType, data: p.data }
      }
    if (p.type === 'document')
      return {
        type: 'document',
        source: { type: 'base64', media_type: p.mediaType, data: p.data }
      }
    return {
      type: 'tool_result',
      tool_use_id: p.toolUseId,
      content: p.content,
      is_error: p.isError ?? false
    }
  })
}

function mapMessages(messages: Message[]): unknown[] {
  return messages.map((m) => ({ role: m.role, content: mapContent(m.content) }))
}

/**
 * 提示缓存断点（Anthropic 专有，见 GenerateRequest.cache）。服务端按**前缀字节**匹配，
 * 渲染顺序固定为 tools → system → messages，故本适配器打两个断点、分工明确：
 *  ① system 末尾：把「工具定义 + 系统提示」这段整轮不变的大前缀钉成缓存条目；
 *  ② 最后一条消息的末块：随对话增长而移动，把已产生的历史尾巴一并写进缓存，
 *     下一步（Agent 循环每步都要重发全量历史）即可命中，省掉 O(N²) 的重复计费。
 * 命中读取约为基础输入价的 1/10，写入则为 1.25 倍：**两次请求即回本**，而工具循环动辄十几步。
 * 多断点不会重复计费——已缓存的部分只写增量。前缀短于该模型的最小可缓存长度（512~4096 token
 * 不等）时服务端**静默忽略**，不报错。是否真的生效看 usage 的 cacheRead / cacheWrite。
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const

/** 断点②：给最后一条消息的最后一个内容块挂上标记（就地改 mapMessages 产出的新对象）。 */
function markCacheTail(messages: unknown[]): void {
  const last = messages[messages.length - 1] as { content?: unknown } | undefined
  const blocks = last?.content
  if (!Array.isArray(blocks) || blocks.length === 0) return
  const tail = blocks[blocks.length - 1]
  if (tail && typeof tail === 'object')
    (tail as Record<string, unknown>).cache_control = CACHE_CONTROL
}

/**
 * Anthropic 用量字段。**input_tokens 只计「未命中缓存的余量」**，缓存写入 / 命中分别单列，
 * 三者相加才是本次请求的总提示 token——这点与 OpenAI/DeepSeek 的「prompt_tokens 即总量」相反。
 */
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

function mapStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    // 内容策略拒绝：正文通常为空，必须单独归类（否则渲染层会误报「上下文接近上限」）。
    case 'refusal':
      return 'refusal'
    case 'stop_sequence':
      return 'stop'
    default:
      return 'end_turn'
  }
}

export async function* streamAnthropic(
  cfg: AdapterConfig,
  req: GenerateRequest
): AsyncGenerator<StreamEvent> {
  const url = `${cfg.baseURL.replace(/\/$/, '')}/v1/messages`
  const messages = mapMessages(req.messages)
  if (req.cache) markCacheTail(messages)
  // 断点①：挂 cache_control 须把 system 从纯字符串改成 text 块数组（字符串挂不上）。
  // 不打断点时照旧发字符串，请求体与改造前逐字节一致。
  const system =
    req.cache && req.system
      ? [{ type: 'text', text: req.system, cache_control: CACHE_CONTROL }]
      : req.system
  const body = {
    model: req.model,
    system,
    messages,
    tools: req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    })),
    // 输出上限：未指定时给 8192（现代 Claude 模型普遍支持，显著降低长回复被截断的概率）。
    max_tokens: req.maxTokens ?? 8192,
    temperature: req.temperature,
    stream: true
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
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

  // index -> 正在累积的 tool_use 块
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>()
  /** 未命中缓存的输入余量（Anthropic 的 input_tokens 语义），**不是**总量。 */
  let uncachedInput = 0
  let cacheWrite = 0
  let cacheRead = 0
  let outputTokens = 0
  let stopReason: StopReason = 'end_turn'

  // 用量分散在 message_start（输入侧）与 message_delta（输出侧）两处，且各版本带的字段互有出入，
  // 统一用同一个取值器：谁带哪段就取哪段，不覆盖没带的。
  const takeUsage = (u: AnthropicUsage | undefined): void => {
    if (!u) return
    if (u.input_tokens) uncachedInput = u.input_tokens
    if (u.output_tokens) outputTokens = u.output_tokens
    if (u.cache_creation_input_tokens) cacheWrite = u.cache_creation_input_tokens
    if (u.cache_read_input_tokens) cacheRead = u.cache_read_input_tokens
  }

  try {
    for await (const { data } of iterateSSE(res, STREAM_IDLE_MS)) {
      if (data === '[DONE]') break
      let evt: Record<string, unknown>
      try {
        evt = JSON.parse(data)
      } catch {
        continue
      }
      const type = evt.type as string

      if (type === 'message_start') {
        takeUsage((evt.message as { usage?: AnthropicUsage })?.usage)
      } else if (type === 'content_block_start') {
        const index = evt.index as number
        const block = evt.content_block as { type: string; id?: string; name?: string }
        if (block?.type === 'tool_use') {
          toolBlocks.set(index, { id: block.id ?? '', name: block.name ?? '', json: '' })
        }
      } else if (type === 'content_block_delta') {
        const index = evt.index as number
        const delta = evt.delta as {
          type: string
          text?: string
          partial_json?: string
          thinking?: string
        }
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text_delta', text: delta.text }
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'thinking_delta', text: delta.thinking }
        } else if (delta.type === 'input_json_delta') {
          const blk = toolBlocks.get(index)
          if (blk) blk.json += delta.partial_json ?? ''
        }
      } else if (type === 'content_block_stop') {
        const index = evt.index as number
        const blk = toolBlocks.get(index)
        if (blk) {
          let args: unknown = {}
          try {
            args = blk.json ? JSON.parse(blk.json) : {}
          } catch {
            args = {}
          }
          yield { type: 'tool_call', id: blk.id, name: blk.name, args }
          toolBlocks.delete(index)
        }
      } else if (type === 'message_delta') {
        const delta = evt.delta as { stop_reason?: string }
        takeUsage(evt.usage as AnthropicUsage | undefined)
        if (delta?.stop_reason) stopReason = mapStopReason(delta.stop_reason)
      } else if (type === 'error') {
        const err = evt.error as { message?: string }
        yield {
          type: 'error',
          error: { kind: 'server', retryable: true, message: err?.message ?? '流式错误' }
        }
        yield { type: 'done', stopReason: 'error' }
        return
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

  // 归一成「总提示 token」：未命中余量 + 缓存写入 + 缓存命中。
  // 未用提示缓存时后两项恒为 0，与旧行为逐字节一致；日后加了断点，压缩触发判定也不会因此失真。
  const inputTokens = uncachedInput + cacheWrite + cacheRead
  if (inputTokens || outputTokens)
    yield { type: 'usage', input: inputTokens, output: outputTokens, cacheRead, cacheWrite }
  yield { type: 'done', stopReason }
}
