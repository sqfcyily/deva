import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AppWindow,
  ChevronLeft,
  ChevronRight,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Image as ImageIcon,
  Presentation,
  X
} from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import type { AttachKind } from '../store/chat'

/**
 * 附件的显示：图片是缩略图（点开在应用内看大图），文件 / 文件夹是卡片（类型图标 + 名称 + 类型与大小）。
 * 输入框与消息里同一套（对比稿 design/attach-preview.html 方案 B）。
 *
 * 图片字节不进渲染层的状态：缩略图与原图都按需向主进程要 data URI——输入框里与刚发出的按本地路径
 * （主进程只认用户亲手选中 / 粘贴 / 拖入的），重载的对话记录按主进程给的 ref。
 */

/** 图片从哪取。 */
export type ImageSource = { path: string } | { sessionId: string; ref: string }

/** 一张可点开的图片。 */
export interface ViewerItem {
  src: ImageSource
  name: string
  size?: number
}

// ---------------- 缩略图缓存（按来源；同一张图在输入框与发出后的消息里共用一份） ----------------

/** 缩略图约 20–150KB，留一百多张足够覆盖一屏多的对话，再多按先进先出丢掉。 */
const THUMB_CACHE_MAX = 160
const thumbPending = new Map<string, Promise<string | null>>()
/** 已取到的结果（null = 取不到）：挂载时同步读出，切换会话、发出消息时缩略图不闪。 */
const thumbDone = new Map<string, string | null>()
/** 缩略图宽高比：消息里的缩略图按比例定宽，重新挂载时直接用，不先方后变。 */
const ratios = new Map<string, number>()

function sourceKey(src: ImageSource): string {
  return 'path' in src ? `p:${src.path}` : `r:${src.sessionId}:${src.ref}`
}

function fetchImage(src: ImageSource, full: boolean): Promise<string | null> {
  const p =
    'path' in src
      ? window.deva.fs.attachmentImage(src.path, full)
      : window.deva.chat.attachmentImage(src.sessionId, src.ref, full)
  return p.catch(() => null)
}

function loadThumb(src: ImageSource): Promise<string | null> {
  const key = sourceKey(src)
  if (thumbDone.has(key)) return Promise.resolve(thumbDone.get(key) ?? null)
  let p = thumbPending.get(key)
  if (!p) {
    p = fetchImage(src, false).then((url) => {
      thumbPending.delete(key)
      thumbDone.set(key, url)
      if (thumbDone.size > THUMB_CACHE_MAX) {
        const oldest = thumbDone.keys().next().value
        if (oldest !== undefined) {
          thumbDone.delete(oldest)
          ratios.delete(oldest)
        }
      }
      return url
    })
    thumbPending.set(key, p)
  }
  return p
}

/** 缩略图：undefined = 还在取，null = 取不到。 */
function useThumb(src: ImageSource): string | null | undefined {
  const key = sourceKey(src)
  const [got, setGot] = useState<{ key: string; url: string | null } | null>(() =>
    thumbDone.has(key) ? { key, url: thumbDone.get(key) ?? null } : null
  )
  useEffect(() => {
    if (thumbDone.has(key)) {
      setGot({ key, url: thumbDone.get(key) ?? null })
      return
    }
    let alive = true
    void loadThumb(src).then((url) => {
      if (alive) setGot({ key, url })
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return got?.key === key ? got.url : undefined
}

// ---------------- 小工具 ----------------

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 文件名里的扩展名（大写，如 PDF、YAML）；没有为空串。 */
function extLabel(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toUpperCase() : ''
}

/** 「PNG · 386 KB」：类型与大小，缺哪项就不写哪项。 */
function metaLine(name: string, size?: number): string {
  return [extLabel(name), size !== undefined ? formatSize(size) : ''].filter(Boolean).join(' · ')
}

/**
 * 文件卡片按类型显示的图标与颜色（对比稿 design/file-type-icons.html 方案 B：线框图标 + 类型色浅底）。
 * 按扩展名归类，与附件怎么交给模型（kind）无关：同是「只给位置」的文件，Word 蓝、Excel 绿、程序灰。
 */
type FileCategory =
  | 'word'
  | 'excel'
  | 'ppt'
  | 'pdf'
  | 'archive'
  | 'program'
  | 'video'
  | 'audio'
  | 'image'
  | 'code'
  | 'text'
  | 'folder'
  | 'other'

const CATEGORY_EXT: [FileCategory, string[]][] = [
  ['word', ['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'wps', 'pages']],
  ['excel', ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'et', 'numbers']],
  ['ppt', ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp', 'dps', 'key']],
  ['pdf', ['pdf']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'cab']],
  ['program', ['exe', 'msi', 'dmg', 'pkg', 'apk', 'ipa', 'appimage', 'deb', 'rpm', 'msix', 'appx', 'dll', 'so', 'dylib', 'sys']],
  ['video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp']],
  ['audio', ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'opus', 'amr']],
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'ico', 'svg']],
  ['text', ['txt', 'md', 'markdown', 'log', 'rst']]
]
const EXT_CATEGORY = new Map(CATEGORY_EXT.flatMap(([c, exts]) => exts.map((e) => [e, c] as const)))

function categoryOf(kind: AttachKind, name: string): FileCategory {
  if (kind === 'folder') return 'folder'
  const hit = EXT_CATEGORY.get(extLabel(name).toLowerCase())
  if (hit) return hit
  // 认不出扩展名的：能当文本读进消息的算代码 / 配置，其余是「其他」。
  return kind === 'text' ? 'code' : kind === 'document' ? 'pdf' : kind === 'image' ? 'image' : 'other'
}

const CATEGORY_COLOR: Record<FileCategory, string> = {
  word: 'var(--ft-word)',
  excel: 'var(--ft-excel)',
  ppt: 'var(--ft-ppt)',
  pdf: 'var(--danger)',
  archive: 'var(--ft-archive)',
  program: 'var(--ft-program)',
  video: 'var(--ft-video)',
  audio: 'var(--ft-audio)',
  image: 'var(--fg-subtle)',
  code: 'var(--accent)',
  text: 'var(--ft-text)',
  folder: 'var(--warning)',
  other: 'var(--fg-subtle)'
}

const CATEGORY_ICON: Record<FileCategory, typeof FileIcon> = {
  word: FileText,
  excel: FileSpreadsheet,
  ppt: Presentation,
  pdf: FileText,
  archive: FileArchive,
  program: AppWindow,
  video: FileVideo,
  audio: FileAudio,
  image: ImageIcon,
  code: FileCode2,
  text: FileText,
  folder: Folder,
  other: FileIcon
}

/** 右上角的移除键：悬停或键盘聚焦到这一项时才露出。 */
function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="cf-att__x"
      onClick={onRemove}
      title={t('chat.attachRemove')}
      aria-label={`${t('chat.attachRemove')} ${name}`}
    >
      <X size={10} strokeWidth={3} />
    </button>
  )
}

// ---------------- 图片缩略图 ----------------

/**
 * 一张图片的缩略图。variant：composer = 输入框里 56px 方图；sent = 消息里高 112px、宽度随原图比例（64–240px）。
 * 取不到（文件已被删改、记录里已对不上）时显示图片图标占位，不可点。
 */
function Thumb({
  item,
  variant,
  onOpen,
  onRemove
}: {
  item: ViewerItem
  variant: 'composer' | 'sent'
  onOpen: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const key = sourceKey(item.src)
  const url = useThumb(item.src)
  const [ratio, setRatio] = useState(() => ratios.get(key))
  const width =
    variant === 'sent' ? Math.round(Math.min(240, Math.max(64, 112 * (ratio ?? ratios.get(key) ?? 1)))) : undefined
  const meta = metaLine(item.name, item.size)
  const title = meta ? `${item.name}\n${meta}` : item.name
  return (
    <span className={`cf-att cf-att--${variant}`}>
      {url === null ? (
        <span className="cf-att__thumb is-broken" style={{ width }} title={title}>
          <ImageIcon size={variant === 'sent' ? 22 : 18} strokeWidth={1.8} />
        </span>
      ) : (
        <button
          type="button"
          className={`cf-att__thumb${url === undefined ? ' is-loading' : ''}`}
          style={{ width }}
          title={title}
          aria-label={t('cf.attachView').replace('{name}', item.name)}
          onClick={onOpen}
        >
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w && h) {
                  ratios.set(key, w / h)
                  setRatio(w / h)
                }
              }}
            />
          )}
        </button>
      )}
      {onRemove && <RemoveButton name={item.name} onRemove={onRemove} />}
    </span>
  )
}

// ---------------- 文件卡片 ----------------

export function FileCard({
  name,
  kind,
  size,
  title,
  sent,
  onRemove
}: {
  name: string
  kind: AttachKind
  size?: number
  /** 悬停提示（文件夹给完整路径），缺省为名称。 */
  title?: string
  sent?: boolean
  onRemove?: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const meta = kind === 'folder' ? t('cf.attachFolder') : metaLine(name, size)
  const category = categoryOf(kind, name)
  const Icon = CATEGORY_ICON[category]
  return (
    <span
      className={`cf-att cf-fcard${sent ? ' is-sent' : ''}`}
      title={title ?? name}
      style={{ '--tc': CATEGORY_COLOR[category] } as React.CSSProperties}
    >
      <span className="cf-fcard__ico">
        <Icon size={19} strokeWidth={1.8} />
      </span>
      <span className="cf-fcard__txt">
        <span className="cf-fcard__name">{name}</span>
        {meta && <span className="cf-fcard__meta">{meta}</span>}
      </span>
      {onRemove && <RemoveButton name={name} onRemove={onRemove} />}
    </span>
  )
}

// ---------------- 输入框与消息里的附件区 ----------------

/** 一项附件（输入框里的待发附件、消息上的附件贴片统一成这个形状）。 */
export interface AttachEntry {
  /** 列表 key。 */
  id: string
  name: string
  kind: AttachKind
  size?: number
  /** 悬停提示（文件夹给完整路径）。 */
  title?: string
  /** 图片的来源；没有（如旧数据的图片）则按文件卡片画。 */
  src?: ImageSource
}

/**
 * 附件区：图片缩略图在前，文件卡片在后。composer 给 onRemove（每项右上角可移除）；sent 靠右对齐、不可移除。
 * 点任一缩略图在应用内看大图，同一处的几张图可左右切换。
 */
export function AttachmentList({
  entries,
  variant,
  onRemove
}: {
  entries: AttachEntry[]
  variant: 'composer' | 'sent'
  onRemove?: (id: string) => void
}): React.JSX.Element | null {
  const [viewing, setViewing] = useState<number | null>(null)
  const images = entries.filter((e): e is AttachEntry & { src: ImageSource } => e.kind === 'image' && !!e.src)
  const files = entries.filter((e) => !(e.kind === 'image' && e.src))
  const items: ViewerItem[] = images.map((e) => ({ src: e.src, name: e.name, size: e.size }))
  if (!entries.length) return null

  const thumbs = images.map((e, i) => (
    <Thumb
      key={e.id}
      item={items[i]}
      variant={variant}
      onOpen={() => setViewing(i)}
      onRemove={onRemove ? () => onRemove(e.id) : undefined}
    />
  ))
  const cards = files.map((e) => (
    <FileCard
      key={e.id}
      name={e.name}
      kind={e.kind}
      size={e.size}
      title={e.title}
      sent={variant === 'sent'}
      onRemove={onRemove ? () => onRemove(e.id) : undefined}
    />
  ))
  const viewer =
    viewing !== null && items.length > 0 ? (
      <ImageViewer items={items} index={Math.min(viewing, items.length - 1)} onClose={() => setViewing(null)} />
    ) : null

  if (variant === 'composer')
    return (
      <div className="cf-composer__files">
        {thumbs}
        {cards}
        {viewer}
      </div>
    )
  return (
    <div className="cf-sent">
      {thumbs.length > 0 && <div className="cf-sent__row">{thumbs}</div>}
      {cards.length > 0 && <div className="cf-sent__row is-files">{cards}</div>}
      {viewer}
    </div>
  )
}

// ---------------- 看大图 ----------------

/**
 * 看大图：遮罩上居中只放图片本身（不套窗口、不加边框），下方一行文件信息「名称　PNG · 386 KB · 960×600」，
 * 不显示「2 / 4」这类序号；多张图时遮罩两侧有切换箭头。不设关闭键（铺满时关闭键挨着系统的关闭按钮，容易误关
 * Deva）：Esc / 点遮罩关闭，← → 切换。原图取到、量好尺寸才换上：切换时旧图留到新图就绪，不会先缩成缩略图大小
 * 再撑开。取不到原图退回缩略图。
 */
export function ImageViewer({
  items,
  index,
  onClose
}: {
  items: ViewerItem[]
  index: number
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [i, setI] = useState(index)
  /** 正在显示的那张：url 为 null 表示原图、缩略图都取不到；full 为 false 时是退回的缩略图（不标尺寸）。 */
  const [shown, setShown] = useState<{ i: number; url: string | null; full: boolean; w: number; h: number } | null>(
    null
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const many = items.length > 1
  const target = items[Math.min(i, items.length - 1)]
  const targetKey = sourceKey(target.src)

  useEffect(() => {
    let alive = true
    const at = i
    void (async () => {
      const full = await fetchImage(target.src, true)
      const url = full ?? (await loadThumb(target.src))
      if (!alive) return
      if (!url) {
        setShown({ i: at, url: null, full: false, w: 0, h: 0 })
        return
      }
      const probe = new Image()
      probe.onload = probe.onerror = () => {
        if (alive) setShown({ i: at, url, full: !!full, w: probe.naturalWidth, h: probe.naturalHeight })
      }
      probe.src = url
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const step = (d: number): void => setI((cur) => (cur + d + items.length) % items.length)

  // 打开时焦点移到预览层（读屏读出对话框），关掉后还给原来的位置（点开它的那张缩略图）。
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  // 捕获阶段接管 Esc 与左右键：抢在输入框（双击 Esc 回滚）和各面板的 Esc 之前。
  const stepRef = useRef(step)
  stepRef.current = step
  const closeFn = useRef(onClose)
  closeFn.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeFn.current()
      else if (e.key === 'ArrowLeft') stepRef.current(-1)
      else if (e.key === 'ArrowRight') stepRef.current(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const cur = shown ? items[Math.min(shown.i, items.length - 1)] : null
  const dims = shown?.full && shown.w ? `${shown.w}×${shown.h}` : ''
  const meta = cur ? [metaLine(cur.name, cur.size), dims].filter(Boolean).join(' · ') : ''

  return createPortal(
    <div
      ref={rootRef}
      className="cf-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={t('cf.viewer.title')}
      tabIndex={-1}
      // mousedown 且校验 target：在图片上按下、拖到遮罩上松开不算点遮罩。
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      // 右键不弹任何菜单：预览层虽挂在 body 上，React 事件仍沿组件树冒泡到对话区的右键菜单（删除这一轮等）；
      // preventDefault 同时挡住主进程的原生复制菜单（页面里留着选区时会弹）。
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {many && (
        <button
          type="button"
          className="cf-viewer__nav is-prev"
          onClick={() => step(-1)}
          title={t('cf.viewer.prev')}
          aria-label={t('cf.viewer.prev')}
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {shown && cur && (
        <>
          {shown.url ? (
            <img className="cf-viewer__img" src={shown.url} alt={cur.name} draggable={false} />
          ) : (
            <div className="cf-viewer__failed">
              <ImageIcon size={28} strokeWidth={1.6} />
              {t('cf.viewer.failed')}
            </div>
          )}
          <div className="cf-viewer__caption">
            <span className="cf-viewer__name" title={cur.name}>
              {cur.name}
            </span>
            {meta && <span className="cf-viewer__meta">{meta}</span>}
          </div>
        </>
      )}
      {many && (
        <button
          type="button"
          className="cf-viewer__nav is-next"
          onClick={() => step(1)}
          title={t('cf.viewer.next')}
          aria-label={t('cf.viewer.next')}
        >
          <ChevronRight size={22} />
        </button>
      )}
    </div>,
    document.body
  )
}
