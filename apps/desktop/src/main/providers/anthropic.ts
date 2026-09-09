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

function mapStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
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
  const body = {
    model: req.model,
    system: req.system,
    messages: mapMessages(req.messages),
    tools: req.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema
    })),
    max_tokens: req.maxTokens ?? 4096,
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
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: StopReason = 'end_turn'

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
        const usage = (evt.message as { usage?: { input_tokens?: number } })?.usage
        if (usage?.input_tokens) inputTokens = usage.input_tokens
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
        const usage = evt.usage as { output_tokens?: number }
        if (usage?.output_tokens) outputTokens = usage.output_tokens
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

  if (inputTokens || outputTokens) yield { type: 'usage', input: inputTokens, output: outputTokens }
  yield { type: 'done', stopReason }
}
