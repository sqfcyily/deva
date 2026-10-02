import { useEffect, useRef, useState } from 'react'
import type { MemoryEntry, MemoryErrorCode, MemoryIpcResult, MemorySnapshot } from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'

/*
 * 记忆标签墙的编辑逻辑，个人资料面板（全局记忆）使用。
 * 读写全走 memory:* IPC（root 省略即全局），与模型的 memory_* 工具同一套校验（单条字数 / 条数 / 总字数上限）；
 * 每次写操作回带最新快照，直接替换本地列表。面板开着时模型可能在后台写记忆 → 监听对话 done 再拉一次（不轮询）。
 */

/** 文案占位符替换：`{name}` → vars.name。 */
export const fill = (s: string, vars: Record<string, number | string>): string =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

/** 进入编辑前量下的标签原宽与字体：编辑框从原宽起步，随内容增长（见 ProfilePanel 的 editBoxWidth）。 */
export type EditBase = { width: number; font: string }

/** 单条标签的编辑 / 删除回调（父级持有编辑态与写操作）。 */
export type TagHandlers = {
  editId: string | null
  editText: string
  editBase: EditBase | null
  maxChars: number
  pending: boolean
  onEditText: (text: string) => void
  onStartEdit: (e: MemoryEntry, base: EditBase) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onDelete: (id: string) => void
}

export type MemoryEditor = {
  mem: MemorySnapshot | null
  pending: boolean
  /** 最近一次写操作的错误（已按语言译好），无则 null。 */
  errorText: string | null
  handlers: TagHandlers
  /** 二次确认后清空本作用域全部记忆。 */
  clearAll: () => void
}

export function useMemoryEditor({
  root,
  clearTitle,
  clearConfirm
}: {
  /** 工作区根：给了即该项目的私有记忆，省略即全局记忆。 */
  root?: string
  clearTitle: string
  clearConfirm: string
}): MemoryEditor {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()

  const [mem, setMem] = useState<MemorySnapshot | null>(null)
  // 行内编辑：同一时刻至多一条。
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editBase, setEditBase] = useState<EditBase | null>(null)
  const [error, setError] = useState<MemoryErrorCode | null>(null)
  const [pending, setPending] = useState(false)

  // 写操作回来时比对：作用域已换（切到别的工作区）就丢弃结果，免得旧工作区的快照落进新面板。
  const rootRef = useRef(root)
  const reqRef = useRef(0)
  const reload = (): void => {
    const req = ++reqRef.current
    void window.deva.memory
      .list(root)
      .then((snap) => {
        if (req === reqRef.current) setMem(snap)
      })
      .catch(() => {
        /* 读失败：保留旧列表 */
      })
  }
  useEffect(() => {
    rootRef.current = root
    setMem(null)
    setEditId(null)
    setError(null)
    reload()
    // 面板开着时模型可能调用了 memory_write / memory_delete：任一轮结束即刷新。
    return window.deva.chat.onEvent((p) => {
      if (p.event.type === 'done') reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  // 所有写操作统一收口：成功替换快照；失败挂错误码（i18n 在渲染时做）。
  const run = async (op: () => Promise<MemoryIpcResult>): Promise<boolean> => {
    if (pending) return false
    const scope = root
    setPending(true)
    try {
      const r = await op()
      if (scope !== rootRef.current) return false
      reqRef.current++ // 作废进行中的 reload，免得旧快照覆盖这次结果
      if (!r.ok) {
        // 条目已被别处（模型）删掉：该行即将随刷新消失，行内错误无处显示 → 改用 toast 并拉最新列表。
        if (r.code === 'notFound') {
          setEditId(null)
          toast.show({ title: t('cf.profile.err.notFound'), variant: 'error' })
          reload()
          return false
        }
        setError(r.code)
        return false
      }
      setMem(r.snapshot)
      setError(null)
      return true
    } catch {
      toast.show({ title: t('cf.profile.err.failed'), variant: 'error' })
      return false
    } finally {
      setPending(false)
    }
  }

  const cancelEdit = (): void => {
    setEditId(null)
    setError(null)
  }
  const saveEdit = async (): Promise<void> => {
    if (!editId) return
    const cur = mem?.entries.find((e) => e.id === editId)
    if (!cur || editText.trim() === cur.content) return cancelEdit()
    if (await run(() => window.deva.memory.write(editText, editId, root))) setEditId(null)
  }
  // 删除先二次确认（记忆一旦删掉，Deva 就不再知道这件事）。
  const remove = async (id: string): Promise<void> => {
    const hit = mem?.entries.find((e) => e.id === id)
    if (!hit || pending) return
    const ok = await dialog.confirm({
      title: t('cf.profile.memDelete'),
      message: fill(t('cf.profile.memDeleteConfirm'), { content: hit.content }),
      confirmText: t('cf.profile.memDelete'),
      variant: 'danger'
    })
    if (!ok) return
    if (editId === id) setEditId(null)
    void run(() => window.deva.memory.remove(id, root))
  }
  const clearAll = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: clearTitle,
      message: clearConfirm,
      confirmText: clearTitle,
      variant: 'danger'
    })
    if (ok) {
      setEditId(null)
      void run(() => window.deva.memory.clear(root))
    }
  }

  const errorText =
    error &&
    fill(t(`cf.profile.err.${error}`), {
      max: mem?.maxChars ?? 0,
      entries: mem?.maxEntries ?? 0,
      budget: mem?.budget ?? 0
    })

  return {
    mem,
    pending,
    errorText,
    handlers: {
      editId,
      editText,
      editBase,
      maxChars: mem?.maxChars ?? 0,
      pending,
      onEditText: setEditText,
      onStartEdit: (e, base) => {
        setEditId(e.id)
        setEditText(e.content)
        setEditBase(base)
        setError(null)
      },
      onCancelEdit: cancelEdit,
      onSaveEdit: () => void saveEdit(),
      onDelete: (id) => void remove(id)
    },
    clearAll: () => void clearAll()
  }
}
