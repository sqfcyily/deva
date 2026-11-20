import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import type { MemoryEntry } from '../../../preload'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import { PersonaFace, USER_AVATAR_SEED, resolveSpec } from '../components/humation'
import { useProfile } from '../store/profile'
import { AvatarEditor } from './AvatarEditor'
import { MemoryDetail } from './MemoryDetail'
import { fill, useMemoryList } from './memory-editor'

/*
 * 个人资料面板（点左上角自己的头像打开）：头像 + Deva 记住的关于你（全局记忆，类用户画像）。
 * 记忆每条一枚标签（只显示标题）：宽时环绕居中头像（每页 12 条，滚轮 / 方向键 / 圆点翻页），窄时退回标签墙；
 * 点一枚标签即在同一个弹窗里换成记忆详情页（类型 / 标题 / 正文，删除 / 取消 / 保存，见 MemoryDetail），弹窗高度定格
 * 不抖动（对比稿 design/memory-ui.html 方案 A）。记忆只由模型在对话中写入，面板仅供查看 / 修改 / 删除。
 */

export function ProfilePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const profile = useProfile()

  const [editingAvatar, setEditingAvatar] = useState(false)
  const [savingAvatar, setSavingAvatar] = useState(false)
  // 记忆详情页：进来时把弹窗高度定格为当时的高度，切换前后弹窗大小不变；回到资料页再放开。
  const modalRef = useRef<HTMLDivElement>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [lockedH, setLockedH] = useState<number | null>(null)

  const { mem, apply, pending, clearAll } = useMemoryList(undefined, {
    title: t('cf.profile.memClear'),
    confirm: t('cf.profile.memClearConfirm')
  })
  const detail = detailId ? (mem?.entries.find((e) => e.id === detailId) ?? null) : null

  const openDetail = (id: string): void => {
    setLockedH(modalRef.current?.getBoundingClientRect().height ?? null)
    setDetailId(id)
  }
  const closeDetail = (): void => {
    setDetailId(null)
    setLockedH(null)
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

  // ✕ / 背景：头像编辑屏、记忆详情页时只退回资料页（丢弃改动），否则关闭面板。
  const dismiss = (): void => {
    if (editingAvatar) {
      if (!savingAvatar) setEditingAvatar(false)
    } else if (detail) closeDetail()
    else onClose()
  }

  const initialSpec = resolveSpec(USER_AVATAR_SEED, profile.avatar)

  return (
    <div className="cf-modal__backdrop" onClick={dismiss}>
      <div
        ref={modalRef}
        className="cf-modal is-editor"
        style={lockedH ? { height: lockedH } : undefined}
        role="dialog"
        aria-label={t('cf.profile.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">
            {editingAvatar ? t('cf.fAvatar') : detail ? t('cf.profile.memDetail') : t('cf.profile.title')}
          </span>
          <button className="cf-modal__close" title={detail ? t('cf.cancel') : t('cf.close')} onClick={dismiss}>
            ✕
          </button>
        </div>
        {detail ? (
          <MemoryDetail key={detail.id} entry={detail} onClose={closeDetail} onChanged={apply} />
        ) : (
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
                  entries={mem?.entries ?? null}
                  onOpen={openDetail}
                />

                <div className="cf-editor__actions cf-me__actions">
                  <button
                    type="button"
                    className="cf-btn cf-me__clear"
                    disabled={pending || !mem?.entries.length}
                    onClick={clearAll}
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
        )}
      </div>
    </div>
  )
}

/* ---------------------------------- 记忆标签 ---------------------------------- */

/** 一枚记忆标签：只显示标题（过长省略，悬停看全），点击进记忆详情页。 */
function MemoryTag({
  entry: e,
  onOpen,
  style,
  elRef
}: {
  entry: MemoryEntry
  onOpen: (id: string) => void
  style?: React.CSSProperties
  elRef?: (el: HTMLButtonElement | null) => void
}): React.JSX.Element {
  return (
    <button
      ref={elRef}
      type="button"
      className="cf-me__tag"
      style={style}
      title={e.title}
      onClick={() => onOpen(e.id)}
    >
      <span className="cf-me__tagtext">{e.title}</span>
    </button>
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
  entries,
  onOpen
}: {
  avatar: React.ReactNode
  entries: MemoryEntry[] | null
  onOpen: (id: string) => void
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
            <MemoryOrbit width={width} avatar={avatar} entries={entries} onOpen={onOpen} />
          ) : (
            <MemoryTags entries={entries} onOpen={onOpen} />
          ))}
      </section>
    </div>
  )
}

/** 窄屏：每条一枚标签自动换行铺开。 */
function MemoryTags({
  entries,
  onOpen
}: {
  entries: MemoryEntry[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="cf-me__tags">
      {entries.map((e) => (
        <MemoryTag key={e.id} entry={e} onOpen={onOpen} />
      ))}
      {entries.length === 0 && <span className="cf-me__tagsempty">{t('cf.profile.memEmpty')}</span>}
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
 */
function MemoryOrbit({
  width,
  avatar,
  entries,
  onOpen
}: {
  width: number
  avatar: React.ReactNode
  entries: MemoryEntry[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const stageRef = useRef<HTMLDivElement>(null)
  const inRefs = useRef<(HTMLElement | null)[]>([])
  const outRefs = useRef<(HTMLElement | null)[]>([])
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
    if (lockRef.current || pages <= 1) return
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

  const slotStyle = (i: number): React.CSSProperties => {
    const p = slotPoint(SLOT_DEG[i], rx)
    // 纵坐标取整：椭圆上的 y 带小数，标签落在半像素上时文字、边框取整会偏上偏下，看着不居中。
    return { left: `calc(50% + ${p.x}px)`, top: `calc(50% + ${Math.round(p.y)}px)` }
  }

  return (
    <div
      ref={stageRef}
      className="cf-me__orbit"
      onKeyDown={(ev) => {
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
              <span className="cf-me__tagtext">{e.title}</span>
            </div>
          ))}
        </div>
      )}
      {shown.map((e, i) => (
        <MemoryTag
          key={e.id}
          entry={e}
          onOpen={onOpen}
          style={slotStyle(i)}
          elRef={(el) => {
            inRefs.current[i] = el
          }}
        />
      ))}
      <div className="cf-me__core">{avatar}</div>
      {entries.length === 0 && <span className="cf-me__orbitempty">{t('cf.profile.memEmpty')}</span>}
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
  )
}
