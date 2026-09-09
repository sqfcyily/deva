/**
 * Provider 归一化类型（主进程内部）。
 * Agent 引擎只面向这套接口与 StreamEvent 编程，各家模型以适配器接入。
 * 对应 docs/architecture/providers.md §3。跨 IPC 的「线缆类型」另在 preload 声明（结构一致）。
 */

/** 归一化消息内容块（Anthropic 风味：工具结果放在 user 消息里）。 */
export interface TextPart {
  type: 'text'
  text: string
}
export interface ToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
export interface ToolResultPart {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}
/** 图片附件（base64）。Anthropic → image 块；OpenAI → image_url(data URI)。 */
export interface ImagePart {
  type: 'image'
  /** MIME，如 image/png、image/jpeg */
  mediaType: string
  /** base64（不含 data: 前缀） */
  data: string
  /** 原始文件名（仅用于展示/重建气泡，不发给模型） */
  name?: string
}
/** 文档附件（base64），当前用于 PDF。仅 Anthropic 可原生读取（document 块）。 */
export interface DocumentPart {
  type: 'document'
  /** MIME，如 application/pdf */
  mediaType: string
  /** base64（不含 data: 前缀） */
  data: string
  name?: string
}
export type ContentPart =
  | TextPart
  | ToolUsePart
  | ToolResultPart
  | ImagePart
  | DocumentPart

export interface Message {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 归一化工具声明（JSON Schema 为准）。 */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop' | 'aborted' | 'error'

export interface GenerateRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'network'
  | 'invalid_request'
  | 'server'
  | 'aborted'
  | 'unknown'

export interface NormalizedError {
  kind: ErrorKind
  retryable: boolean
  message: string
}

/** 统一流式事件——Agent 引擎只消费这套。 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'error'; error: NormalizedError }
  | { type: 'done'; stopReason: StopReason }

/** 单个适配器的连接配置（密钥已解密，仅在主进程内传递）。 */
export interface AdapterConfig {
  baseURL: string
  apiKey: string
}

/** HTTP 状态码 → 归一化错误。 */
export function httpError(status: number, body: string): NormalizedError {
  if (status === 401 || status === 403)
    return { kind: 'auth', retryable: false, message: `鉴权失败（${status}）：请检查 API 密钥。` }
  if (status === 429)
    return { kind: 'rate_limit', retryable: true, message: '触发限流（429），请稍后重试。' }
  if (status === 400 && /context|token|length|maximum/i.test(body))
    return { kind: 'context_length', retryable: false, message: '上下文超出模型上限。' }
  if (status >= 500)
    return { kind: 'server', retryable: true, message: `服务端错误（${status}）。` }
  return {
    kind: 'invalid_request',
    retryable: false,
    message: `请求失败（${status}）：${body.slice(0, 300)}`
  }
}
