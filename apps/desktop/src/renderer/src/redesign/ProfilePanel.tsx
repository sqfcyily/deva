import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MemoryEntry, MemoryErrorCode, MemoryIpcResult, MemorySnapshot } from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { PersonaFace, USER_AVATAR_SEED, resolveSpec } from '../components/humation'
import { useProfile } from '../store/profile'
import { AvatarEditor } from './AvatarEditor'

/*
 * 个人资料面板（点左上角自己的头像打开）：头像 + Deva 记住的关于你（全局记忆，类用户画像）。
 * 记忆读写全走 memory:* IPC，与模型的 memory_* 工具同一套校验（单条字数 / 条数 / 总字数上限）；
 * 每次操作回带最新快照，直接替换本地列表。面板开着时模型可能在后台写记忆 → 监听对话 done 再拉一次。
 * 记忆以标签墙呈现（每条一枚标签）：悬停浮出遮罩，内含编辑 / 删除（二次确认）两钮，双击也可原地编辑；末尾常驻「+」标签，点开即原地追加。
 */

/** 用量占比到此即变色提醒（接近上限，模型很快会被拒写）。 */
const USAGE_WARN_RATIO = 0.85

/** 文案占位符替换：`{name}` → vars.name。 */
const fill = (s: string, vars: Record<string, number | string>): string =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

export function ProfilePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const profile = useProfile()

  const [editingAvatar, setEditingAvatar] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)

  const [mem, setMem] = useState<MemorySnapshot | null>(null)
  // 行内编辑：同一时刻至多一条；error 同时服务于编辑行与末尾追加框（按 target 区分）。
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [adding, setAdding] = useState(false)
  const [addText, setAddText] = useState('')
  const [error, setError] = useState<{ target: string; code: MemoryErrorCode } | null>(null)
  const [pending, setPending] = useState(false)

  const reqRef = useRef(0)
  const reload = (): void => {
    const req = ++reqRef.current
    void window.deva.memory
      .list()
      .then((snap) => {
        if (req === reqRef.current) setMem(snap)
      })
      .catch(() => {
        /* 读失败：保留旧列表 */
      })
  }
  useEffect(() => {
    reload()
    // 面板开着时模型可能调用了 memory_write / memory_delete：任一轮结束即刷新（不轮询）。
    return window.deva.chat.onEvent((p) => {
      if (p.event.type === 'done') reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 所有写操作统一收口：成功替换快照；失败按 target 挂错误码（i18n 在渲染时做）。
  const run = async (target: string, op: () => Promise<MemoryIpcResult>): Promise<boolean> => {
    if (pending) return false
    setPending(true)
    try {
      const r = await op()
      reqRef.current++ // 作废进行中的 reload，免得旧快照覆盖这次结果
      if (!r.ok) {
        // 条目已被别处（模型）删掉：该行即将随刷新消失，行内错误无处显示 → 改用 toast 并拉最新列表。
        if (r.code === 'notFound') {
          setEditId(null)
          toast.show({ title: t('cf.profile.err.notFound'), variant: 'error' })
          reload()
          return false
        }
        setError({ target, code: r.code })
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

  const startEdit = (e: MemoryEntry): void => {
    setAdding(false)
    setEditId(e.id)
    setEditText(e.content)
    setError(null)
  }
  const cancelEdit = (): void => {
    setEditId(null)
    setError(null)
  }
  const saveEdit = async (): Promise<void> => {
    if (!editId) return
    const cur = mem?.entries.find((e) => e.id === editId)
    if (!cur || editText.trim() === cur.content) return cancelEdit()
    if (await run(editId, () => window.deva.memory.write(editText, editId))) setEditId(null)
  }
  const startAdd = (): void => {
    setEditId(null)
    setAdding(true)
    setAddText('')
    setError(null)
  }
  const cancelAdd = (): void => {
    setAdding(false)
    setAddText('')
    if (error?.target === 'add') setError(null)
  }
  // keepOpen：回车追加后留在输入态便于连续追加；失焦追加后收起。失败则保留输入与错误提示。
  const saveAdd = async (keepOpen: boolean): Promise<void> => {
    if (!addText.trim()) {
      if (!keepOpen) cancelAdd()
      return
    }
    if (await run('add', () => window.deva.memory.write(addText))) {
      setAddText('')
      if (!keepOpen) setAdding(false)
    }
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
    void run(id, () => window.deva.memory.remove(id))
  }
  const clearAll = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('cf.profile.memClear'),
      message: t('cf.profile.memClearConfirm'),
      confirmText: t('cf.profile.memClear'),
      variant: 'danger'
    })
    if (ok) {
      setEditId(null)
      void run('clear', () => window.deva.memory.clear())
    }
  }

  const doneAvatar = (spec: Parameters<typeof profile.saveAvatar>[0], image: string): void => {
    setSavingAvatar(true)
    void profile.saveAvatar(spec, image).then((ok) => {
      setSavingAvatar(false)
      if (!ok) {
        toast.show({ title: t('cf.avaImgFailed'), variant: 'error' })
        return
      }
      setEditingAvatar(false)
    })
  }

  // ✕ / 背景：头像编辑屏时只退回资料页（丢弃头像改动），否则关闭面板。
  const dismiss = (): void => {
    if (editingAvatar) {
      if (!savingAvatar) setEditingAvatar(false)
    } else onClose()
  }
  const errText = (target: string): string | null => {
    if (!error || error.target !== target) return null
    return fill(t(`cf.profile.err.${error.code}`), {
      max: mem?.maxChars ?? 0,
      entries: mem?.maxEntries ?? 0,
      budget: mem?.budget ?? 0
    })
  }

  const usageRatio = mem && mem.budget ? mem.used / mem.budget : 0
  const initialSpec = resolveSpec(USER_AVATAR_SEED, profile.avatar)

  return (
    <div className="cf-modal__backdrop" onClick={dismiss}>
      <div
        className="cf-modal is-editor"
        role="dialog"
        aria-label={t('cf.profile.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">
            {editingAvatar ? t('cf.fAvatar') : t('cf.profile.title')}
          </span>
          <button className="cf-modal__close" title={t('cf.close')} onClick={dismiss}>
            ✕
          </button>
        </div>
        <div className="cf-editor">
          {editingAvatar ? (
            <AvatarEditor
              seed={USER_AVATAR_SEED}
              initialSpec={initialSpec}
              initialImage={profile.avatarImage}
              title={t('cf.fAvatar')}
              busy={savingAvatar}
              onCancel={() => setEditingAvatar(false)}
              onDone={doneAvatar}
            />
          ) : (
            <>
              <div className="cf-me__head">
                <button
                  type="button"
                  className="cf-me__avatar"
                  title={t('cf.avaEdit')}
                  aria-label={t('cf.avaEdit')}
                  onClick={() => setEditingAvatar(true)}
                >
                  <PersonaFace
                    seed={USER_AVATAR_SEED}
                    spec={profile.avatar}
                    image={profile.avatarImage}
                    title={t('cf.fAvatar')}
                  />
                  <span className="cf-me__avatarov" aria-hidden="true">
                    <ImagePlus size={20} />
                  </span>
                </button>
              </div>

              <section className="cf-me__mem">
                <div className="cf-me__memhead">
                  <span className="cf-me__memtitle">{t('cf.profile.memTitle')}</span>
                  {mem && (
                    <span
                      className={`cf-me__usage${usageRatio >= USAGE_WARN_RATIO ? ' is-warn' : ''}`}
                      title={t('cf.profile.memUsageHint')}
                    >
                      {fill(t('cf.profile.memUsage'), {
                        n: mem.entries.length,
                        maxEntries: mem.maxEntries,
                        used: mem.used,
                        budget: mem.budget
                      })}
                    </span>
                  )}
                </div>

                {mem && (
                  <MemoryTags
                    entries={mem.entries}
                    editId={editId}
                    editText={editText}
                    maxChars={mem.maxChars}
                    pending={pending}
                    onEditText={setEditText}
                    onStartEdit={startEdit}
                    onCancelEdit={cancelEdit}
                    onSaveEdit={() => void saveEdit()}
                    onDelete={(id) => void remove(id)}
                    adding={adding}
                    addText={addText}
                    onAddText={(text) => {
                      setAddText(text)
                      if (error?.target === 'add') setError(null)
                    }}
                    onStartAdd={startAdd}
                    onCancelAdd={cancelAdd}
                    onSaveAdd={(keepOpen) => void saveAdd(keepOpen)}
                  />
                )}
                {error && <div className="cf-me__err">{errText(error.target)}</div>}
              </section>

              <div className="cf-editor__actions cf-me__actions">
                <button
                  type="button"
                  className="cf-btn cf-me__clear"
                  disabled={pending || !mem?.entries.length}
                  onClick={() => void clearAll()}
                >
                  {t('cf.profile.memClear')}
                </button>
                <button type="button" className="cf-btn is-primary" onClick={onClose}>
                  {t('cf.close')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------- 记忆标签墙 ---------------------------------- */

/**
 * 每条记忆一枚标签，自动换行铺开。悬停浮出遮罩（同头像遮罩），内含编辑 / 删除两钮（删除经父级二次确认），
 * 双击也可原地变输入框编辑；
 * 键盘：聚焦后 Enter / F2 编辑、Delete 删除。末尾常驻「+」标签：点开变输入框，
 * 回车追加并留在输入态（可连续追加），失焦有内容则追加后收起，Esc 放弃。
 */
function MemoryTags({
  entries,
  editId,
  editText,
  maxChars,
  pending,
  onEditText,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  adding,
  addText,
  onAddText,
  onStartAdd,
  onCancelAdd,
  onSaveAdd
}: {
  entries: MemoryEntry[]
  editId: string | null
  editText: string
  maxChars: number
  pending: boolean
  onEditText: (text: string) => void
  onStartEdit: (e: MemoryEntry) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onDelete: (id: string) => void
  adding: boolean
  addText: string
  onAddText: (text: string) => void
  onStartAdd: () => void
  onCancelAdd: () => void
  onSaveAdd: (keepOpen: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Esc 取消时置位，让随后的 blur 不再当作「保存」（编辑框与追加框同一时刻只开一个，共用即可）。
  const cancelledRef = useRef(false)

  return (
    <div className="cf-me__tags">
      {entries.map((e) => {
        const isEditing = e.id === editId
        return (
          <div
            key={e.id}
            className={`cf-me__tag${isEditing ? ' is-editing' : ''}`}
            title={isEditing ? undefined : `${e.content}\n${t('cf.profile.memBulletHint')}`}
            tabIndex={isEditing ? -1 : 0}
            onDoubleClick={() => {
              if (!isEditing) onStartEdit(e)
            }}
            onKeyDown={(ev) => {
              if (isEditing || ev.target !== ev.currentTarget) return
              if (ev.key === 'Enter' || ev.key === 'F2') {
                ev.preventDefault()
                onStartEdit(e)
              } else if (ev.key === 'Delete') {
                ev.preventDefault()
                onDelete(e.id)
              }
            }}
          >
            {isEditing ? (
              <input
                className="cf-me__tagedit"
                value={editText}
                autoFocus
                maxLength={maxChars}
                // 输入框随内容伸缩（CJK 约 1em/字），上限与标签最大宽度一致。
                style={{ width: `${Math.min(Math.max(editText.length, 6) + 1, 24)}em` }}
                onFocus={() => {
                  cancelledRef.current = false
                }}
                onChange={(ev) => onEditText(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
                    ev.preventDefault()
                    ev.currentTarget.blur() // 统一经 blur 保存，免得回车 + 失焦各存一次
                  } else if (ev.key === 'Escape') {
                    ev.preventDefault()
                    ev.stopPropagation()
                    cancelledRef.current = true
                    onCancelEdit()
                  }
                }}
                onBlur={() => {
                  if (cancelledRef.current) return
                  onSaveEdit()
                }}
              />
            ) : (
              <>
                <span className="cf-me__tagtext">{e.content}</span>
                {/* 遮罩不参与布局（绝对定位盖住整枚标签），出现/消失时标签不变宽、整墙不重排。 */}
                <span className="cf-me__tagov">
                  <button
                    type="button"
                    className="cf-me__tagbtn"
                    title={t('cf.profile.memEdit')}
                    aria-label={t('cf.profile.memEdit')}
                    tabIndex={-1}
                    disabled={pending}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onStartEdit(e)
                    }}
                    onDoubleClick={(ev) => ev.stopPropagation()}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="cf-me__tagbtn is-danger"
                    title={t('cf.profile.memDelete')}
                    aria-label={t('cf.profile.memDelete')}
                    tabIndex={-1}
                    disabled={pending}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onDelete(e.id)
                    }}
                    onDoubleClick={(ev) => ev.stopPropagation()}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </>
            )}
          </div>
        )
      })}
      {entries.length === 0 && !adding && (
        <span className="cf-me__tagsempty">{t('cf.profile.memEmpty')}</span>
      )}
      {adding ? (
        <div className="cf-me__tag is-editing">
          <input
            className="cf-me__tagedit"
            value={addText}
            autoFocus
            maxLength={maxChars}
            placeholder={t('cf.profile.memAddPlaceholder')}
            style={{ width: `${Math.min(Math.max(addText.length, 10) + 1, 24)}em` }}
            onFocus={() => {
              cancelledRef.current = false
            }}
            onChange={(ev) => onAddText(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
                ev.preventDefault()
                if (!pending) onSaveAdd(true)
              } else if (ev.key === 'Escape') {
                ev.preventDefault()
                ev.stopPropagation()
                cancelledRef.current = true
                onCancelAdd()
              }
            }}
            onBlur={() => {
              if (cancelledRef.current || pending) return
              onSaveAdd(false)
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="cf-me__tag cf-me__tagadd"
          title={t('cf.profile.memAdd')}
          aria-label={t('cf.profile.memAdd')}
          disabled={pending}
          onClick={onStartAdd}
        >
          <Plus size={14} />
        </button>
      )}
    </div>
  )
}
