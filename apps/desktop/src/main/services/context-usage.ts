import { ipcMain } from 'electron'
import type { ContextUsage } from '../../shared/chat-protocol'
import { onChatEvent } from './chat-bus'
import { getSession, type StoredSession } from './chat-store'
import {
  compactionConfig,
  contextWindowFor,
  estimateTokens,
  modelMessages,
  triggerTokens
} from './compaction'
import { resolveModelRefOrNull, type ResolvedModel } from './model-resolve'

/**
 * 当前对话的上下文占用（输入框模型面板显示用，只读，不参与任何判定）。
 *
 * 读数来源与压缩判定同口径：
 * - 回合进行中：最近一步的真实输入量。引擎只在回合结束时才把读数写进 session.lastInputTokens，所以这里
 *   订阅事件总线自己记一份（主轮的 usage 事件；子轮不发），回合结束（done）或轮中压缩成功后丢弃。
 * - 回合结束后：session.lastInputTokens（每轮收尾写入、随会话落盘，重开对话也有）。
 * - 都没有（刚压缩完、删过轮、回滚过）：按模型看到的部分做字符估算，标 estimated。
 * 窗口与压缩线直接调 compaction.ts 的同一套算法，用户改了模型窗口、引擎从报错里学到的真实窗口都会反映出来。
 */

/** 回合进行中各会话最近一步的真实输入量（键 = 会话 id）。不落盘。 */
const liveInput = new Map<string, number>()

function contextUsageOf(
  session: StoredSession | undefined,
  model: Pick<ResolvedModel, 'adapter' | 'providerId' | 'model'>
): ContextUsage {
  const cfg = compactionConfig()
  const window = contextWindowFor(model, cfg)
  const trigger = cfg.enabled ? triggerTokens(model, cfg) : null
  if (!session || session.messages.length === 0) return { used: null, estimated: false, window, trigger }
  const live = liveInput.get(session.id)
  if (live) return { used: live, estimated: false, window, trigger }
  const last = session.lastInputTokens
  if (last && last > 0) return { used: last, estimated: false, window, trigger }
  return { used: estimateTokens(modelMessages(session.messages)), estimated: true, window, trigger }
}

export function registerContextUsageIpc(): void {
  onChatEvent(({ sessionId, event }) => {
    if (event.type === 'usage') {
      if (event.input > 0) liveInput.set(sessionId, event.input)
    } else if (event.type === 'done' || (event.type === 'compacted' && event.status === 'compacted')) {
      // done：引擎随即把最后一步读数写进 lastInputTokens；压缩成功：旧读数描述的是压缩前的长历史。
      liveInput.delete(sessionId)
    }
  })

  // modelRef = 渲染层正在显示的本对话生效模型（`"providerId:modelId"`）；解析不了（模型已删）回 null。
  ipcMain.handle(
    'chat:context-usage',
    (_e, sessionId: unknown, modelRef: unknown): ContextUsage | null => {
      if (typeof sessionId !== 'string' || typeof modelRef !== 'string') return null
      const model = resolveModelRefOrNull(modelRef)
      if (!model) return null
      return contextUsageOf(getSession(sessionId), model)
    }
  )
}
