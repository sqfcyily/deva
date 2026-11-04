import { randomUUID } from 'node:crypto'
import { app } from 'electron'

/**
 * OpenCode Console 推理网关（Go 套餐与按量计费）对第三方客户端的两项要求，见官方文档
 * https://opencode.ai/v2/docs/console/go#where-can-i-use-it 与
 * https://opencode.ai/v2/docs/console/harnesses#sessions ：
 *  1. **每个对话一个稳定的 `x-opencode-session`**：网关据此把同一对话固定路由、复用提示缓存，
 *     Go 对缺失该头的请求直接回 400 `MissingSessionID`，对话一步都走不下去。值只需稳定、不必可解析
 *     （本应用用对话 id），**且绝不能是写死的常量**——并行对话共用一条会话会被当成异常流量。
 *  2. **用自有 User-Agent 表明身份**（如 `my-agent/1.0`），而不是 SDK / HTTP 库的默认名，让网关
 *     认得出这是编码 agent 的正常流量。
 *
 * 第 2 项已推广到所有服务商（见 providerHeaders）；会话头只对 opencode.ai 的推理端点加。
 */

/** 兜底会话 id：不经对话的单次调用（拉取模型清单、生成提交信息）用它。进程内稳定、每次启动不同。 */
const runSessionId = `deva-${randomUUID()}`

/** 该 baseURL 是否指向 opencode.ai 的推理网关（Go 或按量计费）。 */
function isOpencodeInference(baseURL: string): boolean {
  try {
    const u = new URL(baseURL.trim())
    const host = u.hostname.toLowerCase()
    if (!(host === 'opencode.ai' || host.endsWith('.opencode.ai'))) return false
    // 官方 Base URLs 一节既给推理根（/inference、/inference/go），也给带 API 的完整地址，两种都可能被粘进设置页。
    return u.pathname === '/inference' || u.pathname.startsWith('/inference/')
  } catch {
    return false
  }
}

/**
 * 模型请求（对话流式与拉取模型清单）要追加的请求头，适配器原样并进 fetch headers 即可：
 *  · 所有服务商都带 `user-agent: deva/<版本>` 自报身份——不带就是 Node fetch 的默认值 `node`，网关、
 *    中转服务与服务商后台都分不出是哪个工具在调用（issue #33）。版本号与更新器 / MCP 客户端同源。
 *  · opencode.ai 的推理端点另加 `x-opencode-session`（见文件头）。
 * @param sessionId 所属对话 id；缺省（不经对话的一次性调用）退回本次运行 id。
 */
export function providerHeaders(baseURL: string, sessionId?: string): Record<string, string> {
  const ua = { 'user-agent': `deva/${app.getVersion()}` }
  if (!isOpencodeInference(baseURL)) return ua
  return { ...ua, 'x-opencode-session': sessionId?.trim() || runSessionId }
}

/** 推理网关里紧跟在套餐段之后的 API 段（见官方 Base URLs 一节）。 */
const API_SEGMENTS = new Set(['openai', 'anthropic', 'google'])

/**
 * 模型清单地址：网关只在「推理根」下提供 `/v1/models`（`https://opencode.ai/inference/v1/models`
 * 与 Go 的 `https://opencode.ai/inference/go/v1/models`），各 API 路径（`/openai/v1`、`/anthropic/v1`）
 * 下没有 `/models`，按各家常规拼法必然 404。非网关地址返回 null，由调用方走常规路径。
 */
export function opencodeModelsURL(baseURL: string): string | null {
  if (!isOpencodeInference(baseURL)) return null
  try {
    const u = new URL(baseURL.trim())
    const segments = u.pathname.split('/').filter(Boolean) // ['inference', 'go', 'openai', 'v1']
    const at = segments.indexOf('inference')
    const plan = segments[at + 1]
    const root = plan && !API_SEGMENTS.has(plan) ? `inference/${plan}` : 'inference'
    return `${u.origin}/${root}/v1/models`
  } catch {
    return null
  }
}
