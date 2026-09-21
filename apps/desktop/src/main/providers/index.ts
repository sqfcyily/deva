import { getSecret } from '../services/secrets'
import { streamAnthropic } from './anthropic'
import { streamOpenAI } from './openai'
import { streamResponses } from './openai-responses'
import type { ContentPart, GenerateRequest, Message, StreamEvent } from './types'

export type AdapterKind = 'anthropic' | 'openai' | 'responses'

export interface StreamChatConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
}

function toParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return content
}

/**
 * 合并「连续同角色」消息为一条（跨适配器统一前置处理，非破坏性：不改动入参数组）。
 * 直连 Anthropic 会自动合并连续同角色轮，但 Bedrock / 部分网关会以 400
 * 「roles must alternate」拒绝；上下文压缩后会出现「摘要(user) + 近期首条(user)」两条连续
 * user，故在此消弭，对所有服务商稳健。正常交替对话下为无操作；绝不合并不同角色，
 * 因此 assistant(tool_use) ↔ user(tool_result) 的相邻关系始终保持。
 */
export function normalizeMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      // 重新赋值成新数组（不原地改，避免污染调用方的 history）
      prev.content = [...toParts(prev.content), ...toParts(m.content)]
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * 统一入口：按 adapter 选择实现，密钥在主进程内解密后注入，绝不外泄。
 * 未配置密钥时（本地 Ollama 之类可无钥）以空串继续，由目标服务决定是否放行。
 */
export async function* streamChat(
  cfg: StreamChatConfig,
  req: GenerateRequest
): AsyncGenerator<StreamEvent> {
  const apiKey = (await getSecret(cfg.providerId)) ?? ''
  const adapterCfg = { baseURL: cfg.baseURL, apiKey }
  // 发送前消弭连续同角色（压缩产生的「摘要+近期」连续 user 等），对严格网关稳健。
  const normReq: GenerateRequest = { ...req, messages: normalizeMessages(req.messages) }
  if (cfg.adapter === 'anthropic') {
    yield* streamAnthropic(adapterCfg, normReq)
  } else if (cfg.adapter === 'responses') {
    yield* streamResponses(adapterCfg, normReq)
  } else {
    yield* streamOpenAI(adapterCfg, normReq)
  }
}

export type { GenerateRequest, StreamEvent } from './types'
