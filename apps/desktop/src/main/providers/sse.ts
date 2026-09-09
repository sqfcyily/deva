/**
 * 流空闲判定阈值：连续这么久收不到任何字节（含 SSE 心跳/注释帧），
 * 即判定连接已"僵死"（半开 TCP：socket 未报错但也不再吐数据）。
 * 活跃生成时 token 持续到达、Anthropic 每数秒发 ping，均会刷新计时，
 * 故该阈值只会命中真正的死连接，不会误伤"慢思考"的模型。
 */
export const STREAM_IDLE_MS = 60_000

/** 空闲超时专用错误：名字不是 'AbortError'，故被适配器归一化为 retryable 网络错误。 */
export class StreamIdleError extends Error {
  constructor(ms: number) {
    super(`连接空闲超过 ${Math.round(ms / 1000)}s，判定为中断`)
    this.name = 'StreamIdleError'
  }
}

/**
 * 极简 SSE 解析：把 fetch 的响应体流切成一个个 {event, data} 事件。
 * 用 Node 全局 fetch + Web Streams（Electron 主进程即 Node，无需任何依赖），
 * 契合「零环境配置」铁律。Anthropic 与 OpenAI 两套流都走它。
 *
 * idleMs>0 时启用空闲看门狗：任一 read() 超过 idleMs 未返回即抛 StreamIdleError，
 * 把"僵死的半开连接"变成一个可被上层识别、可自动重连的真实信号。
 */
export async function* iterateSSE(
  res: Response,
  idleMs = 0
): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = idleMs > 0 ? await readWithIdle(reader, idleMs) : await reader.read()
      if (done) break
      // 统一换行，避免 \r\n 导致分帧漏判
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)

        let event: string | undefined
        const dataLines: string[] = []
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
          // 以 ':' 开头的注释行（心跳）直接忽略
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') }
      }
    }
  } finally {
    // 无论正常结束、上层 break，还是空闲超时抛出，都主动取消底层流，
    // 释放可能仍半开的 socket（fire-and-forget，避免在死连接上 await 卡住）。
    void reader.cancel().catch(() => {})
  }
}

/** reader.read() 与空闲计时器竞速：超时抛 StreamIdleError；正常返回则清除计时器。 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs)
  })
  try {
    return await Promise.race([reader.read(), idle])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
