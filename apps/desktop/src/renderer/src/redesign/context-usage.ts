import { useEffect, useState } from 'react'
import type { ContextUsage } from '../../../preload'

/**
 * 本对话的上下文占用（主进程 chat:context-usage 计算，见 main/services/context-usage.ts）。
 *
 * 何时重新拉取：换对话 / 换模型 / 改了模型的窗口或输出上限（sig 变）；本对话每一步的用量（usage）、
 * 回合结束（done）、压缩完成（compacted）；对话记录被改写后列表里的 updatedAt 变了（删轮、回滚）。
 * 读数一律以主进程为准：渲染层不自己拼「事件读数 + 快照」，免得回合中与回合后两份数据打架。
 *
 * 拉回来的结果按「对话 + 模型」缓存：切回看过的对话立即显示，不先闪一下空白再出数字。
 */

const cache = new Map<string, ContextUsage | null>()
const CACHE_MAX = 200

export function useContextUsage(
  sessionId: string,
  modelRef: string | null,
  sig: string,
  updatedAt: number | undefined
): ContextUsage | null {
  const key = modelRef ? `${sessionId}\n${modelRef}` : ''
  const [, setVersion] = useState(0)
  const [tick, setTick] = useState(0)

  useEffect(
    () =>
      window.deva.chat.onEvent(({ sessionId: sid, event }) => {
        if (sid !== sessionId) return
        if (
          event.type === 'usage' ||
          event.type === 'done' ||
          (event.type === 'compacted' && event.status === 'compacted')
        )
          setTick((n) => n + 1)
      }),
    [sessionId]
  )

  useEffect(() => {
    if (!modelRef) return
    let alive = true
    window.deva.chat.contextUsage(sessionId, modelRef).then(
      (u) => {
        if (!alive) return
        if (cache.size >= CACHE_MAX) cache.clear()
        cache.set(key, u)
        setVersion((n) => n + 1)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [key, sessionId, modelRef, sig, updatedAt, tick])

  return key ? (cache.get(key) ?? null) : null
}

/** 用量的紧凑写法（按 K 取整，够看出量级即可）：860 / 128K / 1.2M。 */
export function approxTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 999_500) return `${Math.round(n / 1000)}K`
  return `${Number((n / 1_000_000).toFixed(2))}M`
}

/** 占窗口的比例（0~1，供圆环与进度条；超窗按满格画）。 */
export function usageRatio(u: ContextUsage): number {
  if (u.used == null || u.window <= 0) return 0
  return Math.min(1, Math.max(0, u.used / u.window))
}

/**
 * 百分比文字（不加「约」），一位小数：19.9%。最多 100%（换到窗口小的模型时读数可能超过窗口，
 * 下次发送会先压缩）；用量不足 0.1% 但非零时写 <0.1%，免得显示成 0%。
 */
export function usagePercent(u: ContextUsage): string {
  if (u.used == null || u.window <= 0) return ''
  const p = (u.used / u.window) * 100
  return p > 0 && p < 0.1 ? '<0.1%' : `${Number(Math.min(100, p).toFixed(1))}%`
}
