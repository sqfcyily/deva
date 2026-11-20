import { useEffect, useRef, useState } from 'react'
import type { MemoryIpcResult, MemoryScopeArg, MemorySnapshot } from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'

/*
 * 记忆列表（个人资料面板的全局记忆、角色资料页的角色记忆共用）：读快照，对话每轮结束再拉一次（模型可能在后台
 * 写了记忆，不轮询），以及「清空全部」（二次确认）。修改与删除在记忆详情页（MemoryDetail.tsx），改完把快照交回 apply。
 */

/** 文案占位符替换：`{name}` → vars.name。 */
export const fill = (s: string, vars: Record<string, number | string>): string =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

export type MemoryList = {
  mem: MemorySnapshot | null
  /** 详情页改完交回的最新快照；省略 = 重新读取。 */
  apply: (snapshot?: MemorySnapshot) => void
  pending: boolean
  /** 二次确认后清空本层全部记忆。 */
  clearAll: () => void
}

export function useMemoryList(
  scope: MemoryScopeArg | undefined,
  clear?: { title: string; confirm: string }
): MemoryList {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const [mem, setMem] = useState<MemorySnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const key = scope === undefined ? '' : typeof scope === 'string' ? `p:${scope}` : `r:${scope.personaId}`

  // 作用域换了（切到别的角色）就丢弃进行中请求的结果，免得旧快照落进新列表。
  const keyRef = useRef(key)
  const reqRef = useRef(0)
  const reload = (): void => {
    const req = ++reqRef.current
    void window.deva.memory
      .list(scope)
      .then((snap) => {
        if (req === reqRef.current) setMem(snap)
      })
      .catch(() => {
        /* 读失败：保留旧列表 */
      })
  }
  useEffect(() => {
    keyRef.current = key
    setMem(null)
    reload()
    // 模型可能在对话中调用了 memory_write / memory_delete：任一轮结束即刷新。
    return window.deva.chat.onEvent((p) => {
      if (p.event.type === 'done') reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const apply = (snapshot?: MemorySnapshot): void => {
    reqRef.current++ // 作废进行中的 reload，免得旧快照覆盖这次结果
    if (snapshot) setMem(snapshot)
    else reload()
  }

  const run = async (op: () => Promise<MemoryIpcResult>): Promise<void> => {
    if (pending) return
    const at = keyRef.current
    setPending(true)
    try {
      const r = await op()
      if (at !== keyRef.current) return
      if (r.ok) apply(r.snapshot)
      else toast.show({ title: t('cf.profile.err.failed'), variant: 'error' })
    } catch {
      toast.show({ title: t('cf.profile.err.failed'), variant: 'error' })
    } finally {
      setPending(false)
    }
  }

  const clearAll = async (): Promise<void> => {
    if (!clear) return
    const ok = await dialog.confirm({
      title: clear.title,
      message: clear.confirm,
      confirmText: clear.title,
      variant: 'danger'
    })
    if (ok) void run(() => window.deva.memory.clear(scope))
  }

  return { mem, apply, pending, clearAll: () => void clearAll() }
}
