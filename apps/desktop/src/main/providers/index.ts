import { getSecret } from '../services/secrets'
import { streamAnthropic } from './anthropic'
import { streamOpenAI } from './openai'
import type { GenerateRequest, StreamEvent } from './types'

export type AdapterKind = 'anthropic' | 'openai'

export interface StreamChatConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
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
  if (cfg.adapter === 'anthropic') {
    yield* streamAnthropic(adapterCfg, req)
  } else {
    yield* streamOpenAI(adapterCfg, req)
  }
}

export type { GenerateRequest, StreamEvent } from './types'
