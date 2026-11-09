/**
 * Provider 归一化类型（主进程内部）。
 * Agent 引擎只面向这套接口与 StreamEvent 编程，各家模型以适配器接入。
 * 对应 docs/architecture/providers.md §3。跨 IPC 的「线缆类型」另在 preload 声明（结构一致）。
 */

/** 归一化消息内容块（Anthropic 风味：工具结果放在 user 消息里）。 */
export interface TextPart {
  type: 'text'
  text: string
  /**
   * 引擎附带的清单块（技能清单 / 记忆条目，见 services/listing.ts）：记下本块告知了哪些条目，供从历史推算
   * 「已告知的状态」。只在主进程内部使用，适配器只发 text，不会发给模型。
   */
  listing?: ListingRecord
}
/**
 * 随消息下发的清单种类。guide：按需加载工具的完整用法（tool_search 等给出，见 tool-search.ts）；
 * members：本对话的项目成员名单（见 listing.ts memberListingPart）。
 */
export type ListingKind = 'skills' | 'memory' | 'guide' | 'members'
/** 清单块的结构化记录：本块告知（新增或更新）的条目及其内容摘要、本块告知移除的条目。 */
export interface ListingRecord {
  kind: ListingKind
  /** key：技能名 / 记忆 id / 工具名。 */
  listed: { key: string; digest: string }[]
  removed?: string[]
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
  /** 本次调用的结果已把清单变化告诉了模型（memory_write / memory_delete）：同 TextPart.listing 计入折叠，不发给模型。 */
  listing?: ListingRecord
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
 * 智谱 'sensitive' / Anthropic stop_reason 'refusal'）。**必须与 end_turn 区分**：这类回合同样「自然结束且无正文」，
 * 混作 end_turn 会让空回合被一律归咎于「上下文接近上限」，给出完全错误的排查方向。
 * 'step_limit' / 'repeated' = 引擎层的终止原因（与 aborted / error 同属循环层，服务端不会给）：定时任务达到
 * 单次运行的步数上限 / 同一工具同参数同结果连续出现到上限（原地打转），收尾后停下（见 shared/limits.ts）。
 * **同样必须与 end_turn 区分**：任务没做完，运行记录须记失败而非成功，对话里也要留下说明。
 */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop'
  | 'refusal'
  | 'aborted'
  | 'error'
  | 'step_limit'
  | 'repeated'

// 思考等级的档位定义与模型能力表在主进程 / 渲染层共用模块里（见 shared/effort.ts）。
export { isEffortLevel, type EffortLevel } from '../../shared/effort'
import type { EffortRequest } from '../../shared/effort'
import { parseContextLimit } from '../../shared/context'
import { isEn } from '../locale'

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
  /**
   * 所属对话 id（供需要「每对话一个稳定会话 id」的网关使用，如 OpenCode Go 的
   * x-opencode-session，缺失即 400 MissingSessionID）。不经对话的一次性调用留空，由
   * providers/opencode.ts 退回本次运行 id。
   */
  sessionId?: string
  /**
   * 思考参数（已按模型能力表收敛、映射好，见 shared/effort.ts 的 effortRequest）。
   * 缺省 = 不发任何思考 / 推理参数，请求体与改造前逐字节一致。适配器按 format 放进各家字段：
   * standard → Anthropic adaptive thinking + output_config.effort / OpenAI Chat reasoning_effort /
   * Responses reasoning.effort；deepseek / zai / qwen（仅 OpenAI Chat）→ 各家私有开关 + 可选 reasoning_effort；
   * compat（仅 Anthropic，国产兼容端点）→ output_config.effort + 必要时 thinking.type。
   */
  effort?: EffortRequest
}

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'network'
  | 'invalid_request'
  /** max_tokens 超出模型允许的输出上限：引擎会自动降档重发。 */
  | 'output_limit'
  /** 模型 / 网关不认所发的思考等级参数：引擎会记住并去掉该参数重发。 */
  | 'effort_unsupported'
  | 'server'
  | 'aborted'
  | 'unknown'

export interface NormalizedError {
  kind: ErrorKind
  retryable: boolean
  message: string
  /** 服务端建议的重试等待（毫秒，来自 retry-after 头）；缺省由调用方按指数退避自定。 */
  retryAfterMs?: number
  /** 上下文超限报错里写明的真实窗口（token，见 shared/context.ts 的 parseContextLimit）；认不出则缺省。 */
  limit?: number
}

/** 统一流式事件——Agent 引擎只消费这套。 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  /**
   * 参数没能完整解析的工具调用：参数原文残缺、不可执行，cause 说明原因（见 BrokenCallCause）。
   * 循环把它记成一次失败的工具调用，按原因回灌纠正提示（见 chat.ts runAgentLoop）。
   */
  | {
      type: 'tool_call_truncated'
      id: string
      name: string
      partialArgs: string
      cause: BrokenCallCause
    }
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
  /**
   * 该服务商要求的专有请求头（由 providers/index.ts 按 baseURL + 对话 id 现算，见
   * providers/opencode.ts）。适配器原样并进 fetch headers，无须知道其来源。
   */
  headers?: Record<string, string>
}

/**
 * 工具结果图片的引子。OpenAI 两套协议的工具结果只收文本，图片只能挪进随后的 user 消息——
 * 用这句讲明它们属于上方工具结果，免得模型当成用户新发来的图。
 */
export function toolImagesNote(images: ImagePart[]): string {
  const names = images.map((i) => i.name).filter(Boolean).join('、')
  return `[以下 ${images.length} 张图片是上方工具结果的附件${names ? `：${names}` : ''}]`
}

/** 解析工具参数 JSON：空串视为无参数 `{}`；解析失败返回 undefined（多半是被截在了中途）。 */
export function parseToolArgs(raw: string): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 工具参数没能完整解析的原因。max_tokens = 写到一半撞上输出上限；refusal = 被服务端内容策略截断；
 * invalid = 流正常结束参数却不是合法 JSON——多见于超长参数（个别中转截断了却不报 length，或模型在
 * 长内容里写坏了转义）。
 */
export type BrokenCallCause = 'max_tokens' | 'refusal' | 'invalid'

/**
 * 参数没能完整解析的工具调用收尾（三个适配器共用）：一律如实上报为 tool_call_truncated，按 stopReason
 * 定性。此前非截断的坏参数被当成参数为 `{}` 的完整调用交出去执行，工具只报「缺少 path 参数」——模型以为
 * 漏填了参数，原样重发同一个超长调用，反复失败也不停（连续截断的闸门管不到它）。
 */
export function* settleBrokenCalls(
  broken: { id: string; name: string; raw: string }[],
  stopReason: StopReason
): Generator<StreamEvent> {
  const cause: BrokenCallCause =
    stopReason === 'max_tokens' ? 'max_tokens' : stopReason === 'refusal' ? 'refusal' : 'invalid'
  for (const c of broken)
    yield { type: 'tool_call_truncated', id: c.id, name: c.name, partialArgs: c.raw, cause }
}

/** 响应体摘要：折叠空白、限长。中转 / 网关常把真正原因（上游额度用尽、内容拦截等）写在这里。 */
function bodyHint(body: string): string {
  const s = body.replace(/\s+/g, ' ').trim().slice(0, 200)
  return s ? `${isEn() ? ': ' : '：'}${s}` : ''
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
 * 请求被拒是否因为 max_tokens / max_output_tokens / max_completion_tokens 超出该模型允许的输出上限
 *（中转 / 老模型常见）。引擎据此把输出预算降回保守值重发，而不是整轮报错。
 */
export function isOutputLimitRejection(status: number, body: string): boolean {
  return status === 400 && /max_(output_|completion_)?tokens/i.test(body)
}

/**
 * 请求被拒是否因为思考等级参数（reasoning_effort / output_config.effort / adaptive thinking 等）不被该模型
 * 或网关接受。只在请求确实带了这些参数时才作此判定（effortSent），否则同样字眼的 400 照常归类。
 */
function isEffortRejection(status: number, body: string): boolean {
  return status === 400 && /reasoning_effort|reasoning|effort|output_config|thinking|adaptive/i.test(body)
}

/**
 * HTTP 状态码 → 归一化错误。retryAfter 为响应头 retry-after 原值（可选）；
 * effortSent = 本次请求带了思考等级参数（见 GenerateRequest.effort）。
 * message 会直接显示给用户，按界面语言出中 / 英文（见 locale.ts）。
 */
export function httpError(
  status: number,
  body: string,
  retryAfter?: string | null,
  effortSent?: boolean
): NormalizedError {
  const en = isEn()
  // Anthropic 的「输入 + max_tokens 超出窗口」也落在这一类，其报错里写着真实窗口，一并带上。
  if (isOutputLimitRejection(status, body))
    return {
      kind: 'output_limit',
      retryable: false,
      message: en
        ? `The requested output limit exceeds what this model allows (${status})${bodyHint(body)}`
        : `请求的输出上限超出该模型允许范围（${status}）${bodyHint(body)}`,
      limit: parseContextLimit(body)
    }
  if (status === 401 || status === 403)
    return {
      kind: 'auth',
      retryable: false,
      message: en
        ? `Authentication failed (${status}). Check your API key.`
        : `鉴权失败（${status}）：请检查 API 密钥。`
    }
  if (status === 429)
    return {
      kind: 'rate_limit',
      retryable: true,
      message: en
        ? `Rate limited (429). Try again later${bodyHint(body)}`
        : `触发限流（429），请稍后重试${bodyHint(body)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  // 须在 context_length 之前：后者的正则很宽（token / maximum…），参数被拒的报错常被它误吞。
  if (effortSent && isEffortRejection(status, body))
    return {
      kind: 'effort_unsupported',
      retryable: false,
      message: en
        ? `This model doesn't support the selected thinking level (${status})${bodyHint(body)}`
        : `该模型不支持所选思考等级（${status}）${bodyHint(body)}`
    }
  if (status === 400 && /context|token|length|maximum/i.test(body))
    return {
      kind: 'context_length',
      retryable: false,
      message: en
        ? 'The conversation is longer than this model’s context window. Start a new chat, or switch to a model with a larger context window and try again.'
        : '对话长度已超出该模型的上下文上限，无法继续。请新建对话，或换用上下文更大的模型后重试。',
      limit: parseContextLimit(body)
    }
  if (status >= 500)
    return {
      kind: 'server',
      retryable: true,
      message: en ? `Server error (${status})${bodyHint(body)}` : `服务端错误（${status}）${bodyHint(body)}`,
      retryAfterMs: parseRetryAfter(retryAfter)
    }
  return {
    kind: 'invalid_request',
    retryable: false,
    message: en
      ? `Request failed (${status}): ${body.slice(0, 300)}`
      : `请求失败（${status}）：${body.slice(0, 300)}`
  }
}
