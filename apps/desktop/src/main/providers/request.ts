import { httpFetch } from '../http'
import { isEn } from '../locale'

/**
 * 等待响应的时长上限：请求发出后这么久还没收到响应头，即判定为中断（可重试，由主循环自动重连）。
 * 流开始之后由 SSE 层的空闲看门狗兜底（STREAM_IDLE_MS），这里管的是它之前的那一段：经代理 / VPN / TUN 时
 * 本机这一跳的连接一直活着、上游却已断开，或中转服务收下请求后自己卡住，底层都不会报错，不设上限就会
 * 一直等下去（曾有用户的对话整夜停在「进行中」）。
 * 取 10 分钟，同 Claude Code（Anthropic SDK 的默认请求超时，同样只计到收到响应头）：有的中转要等上游
 * 整段生成完才回响应头，给短了会误判并重发，重复计费。
 */
const RESPONSE_TIMEOUT_MS = 600_000

/** 服务端返回错误状态时，读错误正文的时长上限。 */
const ERROR_BODY_TIMEOUT_MS = 30_000

/** 等待响应超时：名字不是 'AbortError'，适配器按可重试的网络错误处理（同 StreamIdleError）。 */
class ResponseTimeoutError extends Error {
  constructor(ms: number) {
    const min = Math.round(ms / 60_000)
    super(
      isEn()
        ? `No response from the server for over ${min} min; treating the connection as dropped`
        : `等待服务器响应超过 ${min} 分钟，判定为中断`
    )
    this.name = 'ResponseTimeoutError'
  }
}

/**
 * 发起模型请求（三个适配器共用）：在 httpFetch 之上加等待响应的时长上限。
 * 用户中止照常抛 AbortError；等待响应超时抛 ResponseTimeoutError。
 * 非 2xx：错误正文也在这里限时读完，返回只带这段正文的新 Response——服务端回了错误状态却迟迟不把正文
 * 发完时，适配器读正文那一步同样会一直等。
 */
export async function fetchModel(url: string, init: RequestInit): Promise<Response> {
  const user = init.signal ?? undefined
  const limit = new AbortController()
  // AbortSignal.any 不在用户信号上加事件监听，每步调用一次也不会越积越多。
  const signal = user ? AbortSignal.any([user, limit.signal]) : limit.signal
  let timedOut = false
  let clock = setTimeout(() => {
    timedOut = true
    limit.abort()
  }, RESPONSE_TIMEOUT_MS)
  try {
    const res = await httpFetch(url, { ...init, signal })
    if (res.ok) return res
    clearTimeout(clock)
    // 与限时竞速：到点即中止连接（释放 socket），不等 text() 自己收尾。
    const text = await new Promise<string>((resolve) => {
      clock = setTimeout(() => {
        limit.abort()
        resolve('')
      }, ERROR_BODY_TIMEOUT_MS)
      res.text().then(resolve, () => resolve(''))
    })
    // 304 不能带正文（Response 构造会抛错）；POST 实际不会遇到，仅防御。
    return new Response(res.status === 304 ? null : text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    })
  } catch (e) {
    if (timedOut && !user?.aborted) throw new ResponseTimeoutError(RESPONSE_TIMEOUT_MS)
    throw e
  } finally {
    clearTimeout(clock)
  }
}
