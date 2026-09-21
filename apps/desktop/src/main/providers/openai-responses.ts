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
 * OpenAI Responses API 适配器（POST {baseURL}/responses，stream:true）。
 * 与 Chat Completions（openai.ts）并列的第二套 OpenAI 协议：面向 OpenAI 官方新接口。
 *
 * 归一化要点（与本应用的 Anthropic 风味 Message[] 对接）：
 *  - system → 顶层 `instructions`（无状态，每轮都发）。
 *  - 消息拍平成 Responses 的 `input` 数组：assistant 文本→{role:'assistant',content:[output_text]}，
 *    tool_use→独立 {type:'function_call',call_id,name,arguments}；user 文本/图片/PDF→{role:'user',content:[...]}，
 *    tool_result→独立 {type:'function_call_output',call_id,output}。
 *  - 工具声明用 Responses 的**扁平**形状 {type:'function',name,description,parameters}（非 Chat 的 function 嵌套）。
 *  - `call_id` 是串联 function_call ↔ function_call_output 的键：流式时取自 output_item，作 tool_call.id 上抛，
 *    结果回灌时 tool_result.toolUseId 即以此匹配。
 *
 * 无状态设计（与 anthropic.ts / openai.ts 一致）：不使用 previous_response_id、每轮重发全量历史；
 * `store:false` 不在服务端留存（隐私一致）。刻意不回传 reasoning items（本应用不持久化思维链），
 * 非推理模型与文本/单步场景完全可用；推理模型多步工具链在极端情况下可能要求 reasoning 连续性——
 * 届时可改用 Chat Completions 适配器。收到 reasoning 摘要增量仍会作为 thinking 展示（但不主动请求）。
 */

/** Responses 富内容块（input 用）。图片/文件为输入块，assistant 文本回放为 output_text。 */
type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string }
  | { type: 'output_text'; text: string }

/** Responses input 顶层项：消息项，或独立的函数调用/调用结果项。 */
type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

/** 把归一化消息展开成 Responses 的 input 序列（工具调用/结果各自成独立顶层项）。 */
function mapInput(messages: Message[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = []

  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content)
        out.push({ role: m.role, content: [{ type: 'input_text', text: m.content }] })
      continue
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('')
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const p of m.content) {
        if (p.type === 'tool_use')
          out.push({
            type: 'function_call',
            call_id: p.id,
            name: p.name,
            arguments: JSON.stringify(p.input ?? {})
          })
      }
      continue
    }

    // user 消息：先落工具结果（独立项），再把文本/图片/PDF 并成一条 user 消息。
    const parts: ResponsesContentPart[] = []
    for (const p of m.content) {
      if (p.type === 'tool_result')
        out.push({ type: 'function_call_output', call_id: p.toolUseId, output: p.content })
      else if (p.type === 'text') parts.push({ type: 'input_text', text: p.text })
      else if (p.type === 'image')
        parts.push({ type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` })
      else if (p.type === 'document')
        parts.push({
          type: 'input_file',
          filename: p.name ?? 'document.pdf',
          file_data: `data:${p.mediaType};base64,${p.data}`
        })
    }
    if (parts.length) out.push({ role: 'user', content: parts })
  }

  return out
}

/** 累积中的函数调用（键为 Responses 的 output item id，如 fc_...）。 */
interface PendingCall {
  callId: string
  name: string
  args: string
}

export async function* streamResponses(
  cfg: AdapterConfig,
  req: GenerateRequest
): AsyncGenerator<StreamEvent> {
  const url = `${cfg.baseURL.replace(/\/$/, '')}/responses`
  const body = {
    model: req.model,
    instructions: req.system,
    input: mapInput(req.messages),
    tools: req.tools?.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      // 严格模式要求 schema 满足额外约束（全 required + additionalProperties:false），
      // 本应用工具 schema 未必满足，关闭以免服务端 400。
      strict: false
    })),
    // 输出上限：未指定时给 8192（与 anthropic 一致，降低长回复被截断概率）。
    max_output_tokens: req.maxTokens ?? 8192,
    temperature: req.temperature,
    // 无状态使用：不留存于服务端（隐私一致），亦不使用 previous_response_id。
    store: false,
    stream: true
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

  // output item id -> 累积中的函数调用
  const calls = new Map<string, PendingCall>()
  let stopReason: StopReason = 'end_turn'
  let sawTool = false
  let inputTokens = 0
  let outputTokens = 0

  const takeUsage = (evt: Record<string, unknown>): void => {
    const usage = (evt.response as { usage?: { input_tokens?: number; output_tokens?: number } })
      ?.usage
    if (usage?.input_tokens) inputTokens = usage.input_tokens
    if (usage?.output_tokens) outputTokens = usage.output_tokens
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

      if (type === 'response.output_text.delta') {
        const delta = evt.delta
        if (typeof delta === 'string' && delta) yield { type: 'text_delta', text: delta }
      } else if (
        type === 'response.reasoning_summary_text.delta' ||
        type === 'response.reasoning_text.delta'
      ) {
        // 推理模型的思维摘要（仅在服务端产出时到达）——作为思考展示，本应用不持久化。
        const delta = evt.delta
        if (typeof delta === 'string' && delta) yield { type: 'thinking_delta', text: delta }
      } else if (type === 'response.output_item.added') {
        const item = evt.item as { id?: string; type?: string; call_id?: string; name?: string }
        if (item?.type === 'function_call' && item.id)
          calls.set(item.id, { callId: item.call_id ?? '', name: item.name ?? '', args: '' })
      } else if (type === 'response.function_call_arguments.delta') {
        const c = calls.get(evt.item_id as string)
        if (c && typeof evt.delta === 'string') c.args += evt.delta
      } else if (type === 'response.output_item.done') {
        const item = evt.item as {
          id?: string
          type?: string
          call_id?: string
          name?: string
          arguments?: string
        }
        if (item?.type === 'function_call') {
          const acc = item.id ? calls.get(item.id) : undefined
          const callId = item.call_id ?? acc?.callId ?? ''
          const name = item.name ?? acc?.name ?? ''
          // done 事件里的 arguments 为权威全量；缺失时回落流式累积。
          const rawArgs = typeof item.arguments === 'string' ? item.arguments : (acc?.args ?? '')
          let parsed: unknown = {}
          try {
            parsed = rawArgs ? JSON.parse(rawArgs) : {}
          } catch {
            parsed = {}
          }
          if (item.id) calls.delete(item.id)
          sawTool = true
          yield { type: 'tool_call', id: callId, name, args: parsed }
        }
      } else if (type === 'response.completed') {
        takeUsage(evt)
      } else if (type === 'response.incomplete') {
        takeUsage(evt)
        const reason = (evt.response as { incomplete_details?: { reason?: string } })
          ?.incomplete_details?.reason
        if (reason === 'max_output_tokens') stopReason = 'max_tokens'
      } else if (type === 'response.failed') {
        takeUsage(evt)
        const err = (evt.response as { error?: { message?: string } })?.error
        yield {
          type: 'error',
          error: { kind: 'server', retryable: false, message: err?.message ?? '生成失败' }
        }
        yield { type: 'done', stopReason: 'error' }
        return
      } else if (type === 'error') {
        const message =
          typeof evt.message === 'string'
            ? evt.message
            : ((evt.error as { message?: string })?.message ?? '流式错误')
        yield { type: 'error', error: { kind: 'server', retryable: false, message } }
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

  // 有完整工具调用即让主循环继续（覆盖 max_tokens：仅在工具调用完整收尾时才置 tool_use）。
  if (sawTool) stopReason = 'tool_use'

  if (inputTokens || outputTokens) yield { type: 'usage', input: inputTokens, output: outputTokens }
  yield { type: 'done', stopReason }
}
