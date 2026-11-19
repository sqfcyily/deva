/**
 * 对话列表的多选：右键某条对话选「多选」进入，点对话行勾选 / 取消，列表底部的操作条批量归档（已归档对话里是
 * 移回列表）或删除；多选时右键对话行也出这几项。选择状态（useThreadSelect）与批量操作（useThreadBatch）由 Rail 持有，
 * 操作条（ThreadSelectBar）与右键菜单共用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Trash2, X } from 'lucide-react'
import type { SessionLiveState, SessionMeta } from '../store/chat'
import { useChatActions } from '../store/chat'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'

export interface ThreadSelect {
  /** 是否在多选状态。 */
  active: boolean
  selected: ReadonlySet<string>
  /** 进入多选，并勾上右键的那一条。 */
  start: (id: string) => void
  toggle: (id: string) => void
  /** 全选当前列出的对话；已经全选则全部取消。 */
  toggleAll: () => void
  exit: () => void
}

/**
 * 多选状态。visibleIds = 列表此刻列出的对话（搜索、筛选之后的）：全选只选它们，被搜索 / 筛选隐去或已不存在的
 * 对话自动从选择里去掉——操作条上的数字与看得见的勾始终一致，不会删到看不见的对话。
 */
export function useThreadSelect(visibleIds: string[]): ThreadSelect {
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const visible = useMemo(() => new Set(visibleIds), [visibleIds])
  const selected = useMemo(() => {
    if (!picked) return new Set<string>()
    return new Set([...picked].filter((id) => visible.has(id)))
  }, [picked, visible])
  const active = picked !== null

  const start = useCallback((id: string) => setPicked(new Set([id])), [])
  const exit = useCallback(() => setPicked(null), [])
  const toggle = useCallback(
    (id: string) =>
      setPicked((cur) => {
        if (!cur) return cur
        const next = new Set(cur)
        if (!next.delete(id)) next.add(id)
        return next
      }),
    []
  )
  const toggleAll = (): void =>
    setPicked((cur) => (cur ? new Set(selected.size === visibleIds.length ? [] : visibleIds) : cur))

  // Esc 退出多选；弹着确认框、右键菜单时 Esc 归它们（它们各自关掉自己）。
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.cf-modal__backdrop, .modal__backdrop, .cf-ctx')) return
      exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, exit])

  return { active, selected, start, toggle, toggleAll, exit }
}

/** 对选中对话的批量操作（操作条与多选时的右键菜单共用）。 */
export interface ThreadBatch {
  /** 选中了几个。 */
  count: number
  /** 当前列出的对话是否已全部选中。 */
  allOn: boolean
  archive: () => void
  /** 已归档对话里：移回对话列表。 */
  unarchive: () => void
  remove: () => void
}

/**
 * 批量操作。归档跳过进行中的对话（同单条归档：归档后它在看不见的地方跑完），提示条里写明跳过了几个，并可撤销。
 * 删除先弹确认框，写明连带删除的成员与改为独立运行的定时任务。操作完成即退出多选。
 * sessions = 当前列出的对话（从中取出选中的，也是全选的范围）。
 */
export function useThreadBatch(
  select: ThreadSelect,
  sessions: SessionMeta[],
  sessionStates: Record<string, SessionLiveState>
): ThreadBatch {
  const { t, locale } = useI18n()
  const { setArchived, deleteSessions } = useChatActions()
  const { tasks } = useTasks()
  const dialog = useDialog()
  const toast = useToast()
  const en = locale === 'en'
  const chosen = sessions.filter((s) => select.selected.has(s.id))
  const n = chosen.length
  const allOn = n > 0 && n === sessions.length
  const plural = (k: number): string => (k > 1 ? 's' : '')

  const archive = (): void => {
    const ids = chosen.filter((s) => !sessionStates[s.id]?.streaming).map((s) => s.id)
    const skipped = n - ids.length
    if (ids.length === 0) {
      toast.show({ variant: 'warning', message: t('cf.archiveBusy') })
      return
    }
    setArchived(ids, true)
    const skippedNote = skipped
      ? en
        ? ` ${skipped} still running ${skipped > 1 ? 'were' : 'was'} left in the list.`
        : `，${skipped} 个进行中的对话未归档`
      : ''
    toast.show({
      message: en
        ? `Archived ${ids.length} chat${plural(ids.length)}.${skippedNote}`
        : `已归档 ${ids.length} 个对话${skippedNote}`,
      action: { label: t('cf.undo'), onClick: () => setArchived(ids, false) }
    })
    select.exit()
  }

  const unarchive = (): void => {
    setArchived(
      chosen.map((s) => s.id),
      false
    )
    select.exit()
  }

  const remove = async (): Promise<void> => {
    const ids = new Set(chosen.map((s) => s.id))
    const members = chosen.reduce((k, s) => k + (s.members ?? []).filter((m) => !m.removed).length, 0)
    const owned = tasks.filter((x) => x.ownerSessionId && ids.has(x.ownerSessionId)).length
    const notes = [
      t('cf.deleteChatsConfirm'),
      members ? t('cf.deleteChatsMembers').replace('{n}', String(members)) : '',
      owned ? t('cf.deleteChatsTasks').replace('{n}', String(owned)) : ''
    ]
    const ok = await dialog.confirm({
      title: en ? `Delete ${n} selected chat${plural(n)}?` : `删除选中的 ${n} 个对话？`,
      message: notes.filter(Boolean).join(''),
      variant: 'danger',
      confirmText: t('cf.delete')
    })
    if (!ok) return
    deleteSessions([...ids])
    select.exit()
  }

  return { count: n, allOn, archive, unarchive, remove: () => void remove() }
}

/** 多选操作条（对话列表底部）：左边「已选 N」与全选，右边归档（已归档对话里是移回列表）/ 删除 / 退出。 */
export function ThreadSelectBar({
  select,
  batch,
  total,
  archivedView
}: {
  select: ThreadSelect
  batch: ThreadBatch
  /** 当前列出的对话数（全选的范围）。 */
  total: number
  /** 正在看已归档对话：归档换成「移回对话列表」。 */
  archivedView: boolean
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { count: n, allOn, archive, unarchive, remove } = batch
  return (
    <div className="cf-railsel">
      <span className="cf-railsel__count">{locale === 'en' ? `${n} selected` : `已选 ${n} 个`}</span>
      <button className="cf-railsel__all" disabled={total === 0} onClick={select.toggleAll}>
        {t(allOn ? 'cf.selectNone' : 'cf.selectAll')}
      </button>
      <span className="cf-railsel__actions">
        {archivedView ? (
          <button
            className="cf-iconbtn"
            disabled={n === 0}
            title={t('cf.unarchive')}
            aria-label={t('cf.unarchive')}
            onClick={unarchive}
          >
            <ArchiveRestore size={16} />
          </button>
        ) : (
          <button
            className="cf-iconbtn"
            disabled={n === 0}
            title={t('cf.archive')}
            aria-label={t('cf.archive')}
            onClick={archive}
          >
            <Archive size={16} />
          </button>
        )}
        <button
          className="cf-iconbtn cf-railsel__danger"
          disabled={n === 0}
          title={t('cf.delete')}
          aria-label={t('cf.delete')}
          onClick={remove}
        >
          <Trash2 size={16} />
        </button>
        <button
          className="cf-iconbtn"
          title={t('cf.selectExit')}
          aria-label={t('cf.selectExit')}
          onClick={select.exit}
        >
          <X size={16} />
        </button>
      </span>
    </div>
  )
}
