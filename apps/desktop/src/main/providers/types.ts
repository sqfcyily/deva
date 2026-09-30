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
  /**
   * 工具返回的图片（read_file 读图、MCP 图片块）。与 content 分列而非把 content 改成块数组：
   * 历史重建 / 压缩摘要 / 边车等处都把 content 当字符串读，分列后它们原样可用，只有适配器与
   * token 估算需要认识这个字段。content 里应留一句文字说明（图片是什么、从哪来）。
   */
  images?: ImagePart[]
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
  /** max_tokens 超出模型允许的输出上限：引擎会自动降档重发。 */
  | 'output_limit'
  | 'server'
  | 'aborted'
  | 'unknown'

export interface NormalizedError {
  kind: ErrorKind
  retryable: boolean
  message: string
  /** 服务端建议的重试等待（毫秒，来自 retry-after 头）；缺省由调用方按指数退避自定。 */
  retryAfterMs?: number
}

/** 统一流式事件——Agent 引擎只消费这套。 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  /**
   * 参数写到一半就撞上输出上限（stopReason=max_tokens）的工具调用：参数原文残缺、不可执行。
   * 循环把它记成一次失败的工具调用，回灌「请分段写」（见 chat.ts runAgentLoop）。
   */
  | { type: 'tool_call_truncated'; id: string; name: string; partialArgs: string }
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

/**
 * 工具结果图片的引子。OpenAI 两套协议的工具结果只收文本，图片只能挪进随后的 user 消息——
 * 用这句讲明它们属于上方工具结果，免得模型当成用户新发来的图。
 */
export function toolImagesNote(images: ImagePart[]): string {
  const names = images.map((i) => i.name).filter(Boolean).join('、')
  return `[以下 ${images.length} 张图片是上方工具结果的附件${names ? `：${names}` : ''}]`
}

/** 解析工具参数 JSON：空串视为无参数 `{}`；解析失败返回 undefined（多半是被输出上限截在了中途）。 */
export function parseToolArgs(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 参数没能完整解析的工具调用收尾（三个适配器共用）。因输出上限截断（stopReason=max_tokens）时
 * 如实上报为 tool_call_truncated——此前这类调用被当成参数为 `{}` 的完整调用交出去执行（报参数缺失），
 * 截断本身反被掩盖。其余情况（模型给了坏 JSON，极少见）维持旧行为按 `{}` 交出，让工具报错、模型自行纠正。
 */
export function* settleBrokenCalls(
  broken: { id: string; name: string; raw: string }[],
  stopReason: StopReason
): Generator<StreamEvent> {
  for (const c of broken) {
    if (stopReason === 'max_tokens')
      yield { type: 'tool_call_truncated', id: c.id, name: c.name, partialArgs: c.raw }
    else yield { type: 'tool_call', id: c.id, name: c.name, args: {} }
  }
}

/** 响应体摘要：折叠空白、限长。中转 / 网关常把真正原因（上游额度用尽、内容拦截等）写在这里。 */
function bodyHint(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return s ? `：${s}` : ''
}

/** 解析 retry-after 头（秒数或 HTTP 日期）→ 毫秒；无效返回 undefined。 */
function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (!v) return undefined
  const sec = Number(v)
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/**
 * 请求被拒是否因为 max_tokens / max_output_tokens 超出该模型允许的输出上限（中转 / 老模型常见）。
 * 引擎据此把输出预算降回保守值重发，而不是整轮报错。
 */
export function isOutputLimitRejection(status: number, body: string): boolean {
  return status === 400 && /max_(output_)?tokens/i.test(body)
}

/** HTTP 状态码 → 归一化错误。retryAfter 为响应头 retry-after 原值（可选）。 */
export function httpError(status: number, body: string, retryAfter?: string | null): NormalizedError {
  if (isOutputLimitRejection(status, body))
    return {
      kind: 'output_limit',
      retryable: false,
      message: `请求的输出上限超出该模型允许范围（${status}）${bodyHint(body)}`
    }
  if (status === 401 || status === 403)
    return { kind: 'auth', retryable: false, message: `鉴权失败（${status}）：请检查 API 密钥。` }
  if (status === 429)
    return {
      kind: 'rate_limit',
      retryable: true,
      message: `触发限流（429），请稍后重试${bodyHint(body)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  if (status === 400 && /context|token|length|maximum/i.test(body))
    return {
      kind: 'context_length',
      retryable: false,
      message: '对话长度已超出该模型的上下文上限，无法继续。请新建对话，或换用上下文更大的模型后重试。'
    }
  if (status >= 500)
    return {
      kind: 'server',
      retryable: true,
      message: `服务端错误（${status}）${bodyHint(body)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  return {
    kind: 'invalid_request',
    retryable: false,
    message: `请求失败（${status}）：${body.slice(0, 300)}`
  }
}
