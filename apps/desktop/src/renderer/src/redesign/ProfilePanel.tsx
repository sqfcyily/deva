import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, Pencil, Trash2 } from 'lucide-react'
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
 * 记忆每条一枚标签：宽时环绕居中头像（每页 12 条，滚轮 / 方向键 / 圆点翻页），窄时退回标签墙；
 * 记忆只由模型在对话中写入，面板仅供查看 / 修改 / 删除（不提供手动追加）；
 * 悬停时标签上方浮出编辑 / 删除（二次确认）小工具条（不占标签本身的位置），双击也可原地编辑。
 */

/** 悬停工具条与标签的间距，以及标签距窗口顶部不足此值时改放下方。 */
const POP_GAP = 6
const POP_ROOM = 40

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
  // 行内编辑：同一时刻至多一条；error 按 target（条目 id / clear）区分。
  const [editId, setEditId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
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
              <MemoryBoard
                avatar={
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
                }
                error={error && <div className="cf-me__err">{errText(error.target)}</div>}
                entries={mem?.entries ?? null}
                h={{
                  editId,
                  editText,
                  maxChars: mem?.maxChars ?? 0,
                  pending,
                  onEditText: setEditText,
                  onStartEdit: startEdit,
                  onCancelEdit: cancelEdit,
                  onSaveEdit: () => void saveEdit(),
                  onDelete: (id) => void remove(id)
                }}
              />

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

/* ---------------------------------- 记忆标签 ---------------------------------- */

/** 单条标签的编辑 / 删除回调（父级持有编辑态与写操作）。 */
type TagHandlers = {
  editId: string | null
  editText: string
  maxChars: number
  pending: boolean
  onEditText: (text: string) => void
  onStartEdit: (e: MemoryEntry) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onDelete: (id: string) => void
}

/**
 * 一枚记忆标签：悬停时上方浮出编辑 / 删除小工具条（删除经父级二次确认），双击也可原地编辑；
 * 键盘：聚焦后 Enter / F2 编辑、Delete 删除。编辑中 Enter 经 blur 统一保存，Esc 放弃。
 */
function MemoryTag({
  entry: e,
  h,
  style,
  elRef
}: {
  entry: MemoryEntry
  h: TagHandlers
  style?: React.CSSProperties
  elRef?: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Esc 取消时置位，让随后的 blur 不再当作「保存」。
  const cancelledRef = useRef(false)
  const isEditing = e.id === h.editId

  // 悬停工具条：挂到 body 以 fixed 定位 —— 标签墙会内滚、环形舞台裁剪溢出，放在标签内部会被裁掉。
  // 离开标签后稍作延迟再收起，好让鼠标跨过标签与工具条之间的空隙；工具条是 React 子树（portal），
  // 移入它不算离开标签，故只在标签上挂一对 enter/leave 即可。
  const tagRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const [pop, setPop] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const showPop = (): void => {
    window.clearTimeout(hideTimer.current)
    const r = tagRef.current?.getBoundingClientRect()
    if (!r || isEditing) return
    const below = r.top < POP_ROOM // 贴近窗口顶部放不下 → 改放标签下方
    setPop({ x: r.left + r.width / 2, y: below ? r.bottom + POP_GAP : r.top - POP_GAP, below })
  }
  const hidePop = (): void => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setPop(null), 120)
  }
  useEffect(() => {
    if (isEditing) setPop(null)
  }, [isEditing])
  // 位置是一次性测的：滚动 / 滚轮翻页 / 窗口缩放后坐标即失效，直接收起。
  useEffect(() => {
    if (!pop) return
    const close = (): void => setPop(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pop])
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  return (
    <div
      ref={(el) => {
        tagRef.current = el
        elRef?.(el)
      }}
      className={`cf-me__tag${isEditing ? ' is-editing' : ''}${pop ? ' is-hot' : ''}`}
      style={style}
      title={isEditing ? undefined : `${e.content}\n${t('cf.profile.memBulletHint')}`}
      tabIndex={isEditing ? -1 : 0}
      onMouseEnter={showPop}
      onMouseLeave={hidePop}
      onFocus={(ev) => {
        if (ev.target === ev.currentTarget && ev.currentTarget.matches(':focus-visible')) showPop()
      }}
      onBlur={(ev) => {
        if (ev.target === ev.currentTarget) hidePop()
      }}
      onDoubleClick={() => {
        if (!isEditing) h.onStartEdit(e)
      }}
      onKeyDown={(ev) => {
        if (isEditing || ev.target !== ev.currentTarget) return
        if (ev.key === 'Enter' || ev.key === 'F2') {
          ev.preventDefault()
          h.onStartEdit(e)
        } else if (ev.key === 'Delete') {
          ev.preventDefault()
          h.onDelete(e.id)
        }
      }}
    >
      {isEditing ? (
        <input
          className="cf-me__tagedit"
          value={h.editText}
          autoFocus
          maxLength={h.maxChars}
          // 输入框随内容伸缩（CJK 约 1em/字），上限与标签最大宽度一致。
          style={{ width: `${Math.min(Math.max(h.editText.length, 6) + 1, 24)}em` }}
          onFocus={() => {
            cancelledRef.current = false
          }}
          onChange={(ev) => h.onEditText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
              ev.preventDefault()
              ev.currentTarget.blur() // 统一经 blur 保存，免得回车 + 失焦各存一次
            } else if (ev.key === 'Escape') {
              ev.preventDefault()
              ev.stopPropagation()
              cancelledRef.current = true
              h.onCancelEdit()
            }
          }}
          onBlur={() => {
            if (cancelledRef.current) return
            h.onSaveEdit()
          }}
        />
      ) : (
        <>
          <span className="cf-me__tagtext">{e.content}</span>
          {pop &&
            createPortal(
              <span
                className={`cf-me__tagpop${pop.below ? ' is-below' : ''}`}
                style={{ left: pop.x, top: pop.y }}
              >
            <button
              type="button"
              className="cf-me__tagbtn"
              title={t('cf.profile.memEdit')}
              aria-label={t('cf.profile.memEdit')}
              tabIndex={-1}
              disabled={h.pending}
              onClick={(ev) => {
                ev.stopPropagation()
                setPop(null) // 先收起：删除确认框层级低于工具条
                h.onStartEdit(e)
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
              disabled={h.pending}
              onClick={(ev) => {
                ev.stopPropagation()
                setPop(null) // 先收起：删除确认框层级低于工具条
                h.onDelete(e.id)
              }}
              onDoubleClick={(ev) => ev.stopPropagation()}
            >
              <Trash2 size={12} />
            </button>
              </span>,
              document.body
            )}
        </>
      )}
    </div>
  )
}

/* ---------------------------------- 布局：环形 / 标签墙 ---------------------------------- */

/** 容器窄于此宽度时环形放不下（两侧标签会出界），退回标签墙。 */
const ORBIT_MIN_W = 460

/**
 * 按宽度在两种布局间切换：宽 → 头像居中、记忆环绕（MemoryOrbit）；窄 → 头像在上、标签墙在下（MemoryTags）。
 */
function MemoryBoard({
  avatar,
  error,
  entries,
  h
}: {
  avatar: React.ReactNode
  error: React.ReactNode
  entries: MemoryEntry[] | null
  h: TagHandlers
}): React.JSX.Element {
  const { t } = useI18n()
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  // 首帧同步量一次（绘制前定下布局，免得先闪一下标签墙），之后跟随尺寸变化。
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const orbit = width >= ORBIT_MIN_W

  return (
    <div ref={boxRef} className="cf-me__board">
      {!orbit && <div className="cf-me__head">{avatar}</div>}
      <section className="cf-me__mem" aria-label={t('cf.profile.memTitle')}>
        {entries &&
          (orbit ? (
            <MemoryOrbit width={width} avatar={avatar} entries={entries} h={h} />
          ) : (
            <MemoryTags entries={entries} h={h} />
          ))}
        {error}
      </section>
    </div>
  )
}

/** 窄屏：每条一枚标签自动换行铺开。 */
function MemoryTags({
  entries,
  h
}: {
  entries: MemoryEntry[]
  h: TagHandlers
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="cf-me__tags">
      {entries.map((e) => (
        <MemoryTag key={e.id} entry={e} h={h} />
      ))}
      {entries.length === 0 && (
        <span className="cf-me__tagsempty">{t('cf.profile.memEmpty')}</span>
      )}
    </div>
  )
}

/** 每页条数。 */
const PER_PAGE = 12
/**
 * 12 个槽位在椭圆上的角度（度，y 轴朝下故角度递增即顺时针），从右上起顺时针排：
 * 左右各 3 行 ×2（上下对称），行高间隔约 48px，保证相邻行的标签不上下相叠。
 */
const SLOT_DEG = [-53.1, -28.7, -9.2, 9.2, 28.7, 53.1, 126.9, 151.3, 170.8, 189.2, 208.7, 233.1]
/** 椭圆纵半径：最上 / 最下一行落在 ±120px（sin 53.1° ≈ 0.8）。舞台高度见 .cf-me__orbit。 */
const ORBIT_RY = 150
/** 翻页时每条沿轨道转过的角度与时长。 */
const FLIP_DEG = 32
const FLIP_MS = 320
/** 环形里编辑框的定宽上限与距舞台左右边的最小留白（右侧要让出页码圆点）。 */
const EDIT_MAX_W = 260
const EDIT_EDGE = 28

const slotPoint = (deg: number, rx: number): { x: number; y: number } => {
  const r = (deg * Math.PI) / 180
  return { x: rx * Math.cos(r), y: ORBIT_RY * Math.sin(r) }
}
/** 沿椭圆从 deg+from 转到 deg+to 的关键帧（相对槽位本身的位移），顺带淡入 / 淡出。 */
const arcFrames = (deg: number, from: number, to: number, rx: number, fadeIn: boolean): Keyframe[] => {
  const base = slotPoint(deg, rx)
  return Array.from({ length: 7 }, (_, i) => {
    const k = i / 6
    const p = slotPoint(deg + from + (to - from) * k, rx)
    return {
      transform: `translate(${p.x - base.x}px, ${p.y - base.y}px)`,
      opacity: fadeIn ? k : 1 - k
    }
  })
}
const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 宽屏：头像居中，每页 12 条沿椭圆环绕。多于一页时滚轮 / 方向键 / 右侧圆点翻页，
 * 翻页只由用户触发（不自动转）：旧的一批沿轨道顺势转出淡去，新的一批从另一侧转入。
 * 编辑进行中不翻页，免得正在改的那条被转走。
 */
function MemoryOrbit({
  width,
  avatar,
  entries,
  h
}: {
  width: number
  avatar: React.ReactNode
  entries: MemoryEntry[]
  h: TagHandlers
}): React.JSX.Element {
  const { t } = useI18n()
  const stageRef = useRef<HTMLDivElement>(null)
  const inRefs = useRef<(HTMLDivElement | null)[]>([])
  const outRefs = useRef<(HTMLDivElement | null)[]>([])
  const [page, setPage] = useState(0)
  // 正在转出的上一页（只作动画，不可交互），dir 为翻页方向（+1 顺时针 / -1 逆时针）。
  const [flip, setFlip] = useState<{ seq: number; dir: 1 | -1; items: MemoryEntry[] } | null>(null)
  const lockRef = useRef(false)

  // 横半径：尽量舒展，但给最宽的标签（约 10em）留出半宽，免得两侧出界。
  const rx = Math.max(120, Math.min(185, width / 2 - 92))
  const pages = Math.max(1, Math.ceil(entries.length / PER_PAGE))
  const cur = Math.min(page, pages - 1) // 删到某页为空时自动回退
  const slice = (p: number): MemoryEntry[] => entries.slice(p * PER_PAGE, (p + 1) * PER_PAGE)
  const shown = slice(cur)

  // 新增了记忆（模型在对话中写入）→ 翻到最后一页，让新的一条可见（新条目总追加在末尾）。
  const prevLenRef = useRef(entries.length)
  useEffect(() => {
    if (entries.length > prevLenRef.current) setPage(Math.max(0, Math.ceil(entries.length / PER_PAGE) - 1))
    prevLenRef.current = entries.length
  }, [entries.length])

  const goto = (target: number, dir: 1 | -1): void => {
    if (lockRef.current || h.editId || pages <= 1) return
    const next = ((target % pages) + pages) % pages
    if (next === cur) return
    if (!reducedMotion()) {
      lockRef.current = true
      window.setTimeout(() => {
        lockRef.current = false
      }, FLIP_MS)
      setFlip((f) => ({ seq: (f?.seq ?? 0) + 1, dir, items: shown }))
    }
    setPage(next)
  }
  const gotoRef = useRef(goto)
  gotoRef.current = goto

  // 滚轮翻页：须非被动监听才能 preventDefault，否则滚轮同时会滚动整个面板。
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (ev: WheelEvent): void => {
      const d = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX
      if (Math.abs(d) < 4) return
      ev.preventDefault()
      gotoRef.current(cur + (d > 0 ? 1 : -1), d > 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [cur])

  // 翻页动画：新一批从 -dir 侧沿轨道转入，旧一批向 +dir 侧转出；结束后撤掉转出层。
  useLayoutEffect(() => {
    if (!flip) return
    const { dir } = flip
    const opts: KeyframeAnimationOptions = { duration: FLIP_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' }
    const anims: Animation[] = []
    inRefs.current.forEach((el, i) => {
      if (el) anims.push(el.animate(arcFrames(SLOT_DEG[i], -dir * FLIP_DEG, 0, rx, true), opts))
    })
    outRefs.current.forEach((el, i) => {
      if (el) anims.push(el.animate(arcFrames(SLOT_DEG[i], 0, dir * FLIP_DEG, rx, false), opts))
    })
    const timer = window.setTimeout(() => setFlip(null), FLIP_MS)
    return () => {
      window.clearTimeout(timer)
      anims.forEach((an) => an.cancel())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip?.seq])

  const slotStyle = (i: number, editing = false): React.CSSProperties => {
    const p = slotPoint(SLOT_DEG[i], rx)
    const top = `calc(50% + ${p.y}px)`
    if (!editing) return { left: `calc(50% + ${p.x}px)`, top }
    // 编辑中：定宽输入框（长文本在框内横向滚动，不再随内容撑开），中心点向内夹紧，
    // 保证整框落在舞台内、不压右侧页码圆点 —— 否则两侧槽位的编辑框会被裁掉或撑乱布局。
    const w = Math.min(EDIT_MAX_W, width - 2 * EDIT_EDGE)
    const cx = Math.min(Math.max(width / 2 + p.x, w / 2 + EDIT_EDGE), width - w / 2 - EDIT_EDGE)
    return { left: `${cx}px`, top, width: `${w}px`, maxWidth: 'none' }
  }

  return (
    <>
      <div
        ref={stageRef}
        className="cf-me__orbit"
        onKeyDown={(ev) => {
          if (ev.target instanceof HTMLInputElement) return
          if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
            ev.preventDefault()
            goto(cur + 1, 1)
          } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
            ev.preventDefault()
            goto(cur - 1, -1)
          }
        }}
      >
        {flip && (
          <div className="cf-me__orbitout" aria-hidden="true">
            {flip.items.map((e, i) => (
              <div
                key={e.id}
                ref={(el) => {
                  outRefs.current[i] = el
                }}
                className="cf-me__tag"
                style={slotStyle(i)}
              >
                <span className="cf-me__tagtext">{e.content}</span>
              </div>
            ))}
          </div>
        )}
        {shown.map((e, i) => (
          <MemoryTag
            key={e.id}
            entry={e}
            h={h}
            style={slotStyle(i, e.id === h.editId)}
            elRef={(el) => {
              inRefs.current[i] = el
            }}
          />
        ))}
        <div className="cf-me__core">{avatar}</div>
        {entries.length === 0 && (
          <span className="cf-me__orbitempty">{t('cf.profile.memEmpty')}</span>
        )}
        {/* 页码圆点：竖排贴舞台右侧，纯图形不配文字（页码仅作读屏标签）。 */}
        {pages > 1 && (
          <div className="cf-me__pager">
            {Array.from({ length: pages }, (_, p) => (
              <button
                key={p}
                type="button"
                className={`cf-me__dot${p === cur ? ' is-active' : ''}`}
                aria-label={fill(t('cf.profile.memPage'), { n: p + 1, total: pages })}
                aria-current={p === cur ? 'page' : undefined}
                onClick={() => goto(p, p > cur ? 1 : -1)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
