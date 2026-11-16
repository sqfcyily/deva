import { useEffect, useRef } from 'react'
import type { ChatRemoteChange } from '../../../shared/chat-protocol'

/**
 * 与手机同步（主进程见 main/services/read-sync.ts）：
 *  · 已读：正在看的对话报给主进程（窗口在前台才算看；看着时有新回复、窗口回到前台也再报一次），手机上的红点随之消掉。
 *    主进程对「看过之后没有新内容」的重复报告直接忽略，这里不必去重。
 *  · 手机上看过 → 清掉这里的未读；删除 / 归档了正开着的对话 → 离开（同在电脑上自己删）；改了模型 → 撤掉本地记的模型。
 */
export interface RemoteSyncHandlers {
  onRead(sessionId: string): void
  /** 已删除或归档。 */
  onGone(sessionId: string): void
  onModel(sessionId: string): void
}

export function useRemoteSync(
  currentSessionId: string,
  /** 当前对话的 updatedAt：变了说明看着的时候来了新内容，再报一次已读。 */
  currentUpdatedAt: number | undefined,
  handlers: RemoteSyncHandlers
): void {
  const h = useRef(handlers)
  h.current = handlers

  useEffect(() => {
    if (!currentSessionId) return
    const mark = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void window.deva.chat.markRead(currentSessionId)
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [currentSessionId, currentUpdatedAt])

  useEffect(
    () =>
      window.deva.chat.onRemoteChange((c: ChatRemoteChange) => {
        if (c.kind === 'read') h.current.onRead(c.sessionId)
        else if (c.kind === 'model') h.current.onModel(c.sessionId)
        else h.current.onGone(c.sessionId)
      }),
    []
  )
}
