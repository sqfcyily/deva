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
  /**
   * 群聊：该条 assistant 消息（及其 tool_result 回灌）的发言角色 personaId。
   * 纯本地元数据——normalizeMessages 只重建 {role, content}，绝不发往 API。单聊恒缺省。
   */
  author?: string
}

/** 归一化工具声明（JSON Schema 为准）。 */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 归一化的终止原因。
 * 'refusal' = 模型拒绝作答、或被服务端内容策略拦截（OpenAI finish_reason 'content_filter' /
 * Anthropic stop_reason 'refusal'）。**必须与 end_turn 区分**：这类回合同样「自然结束且无正文」，
 * 混作 end_turn 会让空回合被一律归咎于「上下文接近上限」，给出完全错误的排查方向。
 */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop'
  | 'refusal'
  | 'aborted'
  | 'error'

export interface GenerateRequest {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /**
   * 是否给本次请求打**提示缓存断点**。目前只有 Anthropic 协议支持显式断点；
   * OpenAI / DeepSeek 是服务端自动前缀缓存，无需请求参数，此开关对其无作用也无副作用。
   * **只有「带着同一前缀反复重发」的场景才该开**：Agent 循环每步都重发全量历史，正是典型；
   * 一次性调用（压缩摘要、生成提交信息）打了断点只会白付 1.25 倍缓存写入费，故默认关闭。
   */
  cache?: boolean
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
  /**
   * 用量。input = 本次请求的**总提示 token**（已含缓存命中/写入部分）。
   * 注意 Anthropic 协议的 input_tokens 只是「未命中缓存的余量」，适配器已在此把三段相加归一，
   * 保证跨服务商语义一致——上下文压缩的触发判定依赖它，不会因日后开启提示缓存而失真。
   * cacheRead / cacheWrite = 提示缓存的命中 / 写入 token 数；缺省表示该服务商未报告该项。
   */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
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
    return {
      kind: 'context_length',
      retryable: false,
      message: '对话长度已超出该模型的上下文上限，无法继续。请新建对话，或换用上下文更大的模型后重试。'
    }
  if (status >= 500)
    return { kind: 'server', retryable: true, message: `服务端错误（${status}）。` }
  return {
    kind: 'invalid_request',
    retryable: false,
    message: `请求失败（${status}）：${body.slice(0, 300)}`
  }
}
