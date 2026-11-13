import { useEffect, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  File,
  FolderOpen,
  Package
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { type ChatBlock, useChatState } from '../../store/chat'
import { useToast } from '../../components/ToastProvider'
import type { DeliverableInfo } from '../../../../shared/deliverables'

/**
 * 交付卡（present_files 成功后，回合结束时排在回复末尾，见 DeliveryCards）：模型交付给用户的成品文件，每个一行——
 * 缩略图（系统缩略图 / 文件图标）、文件名、大小与所在目录，操作：打开 / 在文件夹中显示 / 复制路径。
 * 卡片内容取自主进程（按对话 id + 调用 id 从历史里取路径），重开对话同样还原；文件被移走则标「已不存在」。
 */

// 缩略图按「对话:调用:序号」缓存：滚动 / 重渲染时不反复向系统要图。
const thumbCache = new Map<string, string | null>()

/** 文件多于 FOLD_PREVIEW + 1 个时折叠，只显示前 FOLD_PREVIEW 个（免得出现「展开其余 1 个」）。 */
const FOLD_PREVIEW = 5

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/**
 * 主进程信息到达前，先按调用参数画出文件名，避免卡片高度跳动。参数是模型原样发出的（可能是相对路径、
 * 可能重复），只取文件名占位；真实路径以 inspect 返回的为准。
 */
function placeholders(args: unknown): DeliverableInfo[] {
  const paths = (args as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths)) return []
  return [...new Set(paths.filter((p): p is string => typeof p === 'string'))]
    .map((p) => {
      const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      return { path: p, name: p.slice(cut + 1), dir: p.slice(0, Math.max(cut, 0)), size: 0, openable: false }
    })
}

export function DeliverablesCard({
  block
}: {
  block: Extract<ChatBlock, { kind: 'tool' }>
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { currentSessionId: sessionId } = useChatState()
  const [files, setFiles] = useState<DeliverableInfo[]>(() => placeholders(block.args))
  const [loaded, setLoaded] = useState(false)
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({})
  const [copied, setCopied] = useState<number | null>(null)
  const [expanded, setExpanded] = useState(false)
  // 整张卡收起（点标题）：默认展开——交付物就是这一轮的结果；收起状态不保存，重开对话恢复展开。
  const [cardOpen, setCardOpen] = useState(true)

  useEffect(() => {
    let alive = true
    void window.deva.deliverables
      .inspect(sessionId, block.id)
      .then((list) => {
        if (!alive) return
        setFiles(list)
        setLoaded(true)
        list.forEach((f, i) => {
          if (f.size === null) return
          const key = `${sessionId}:${block.id}:${i}`
          if (thumbCache.has(key)) {
            setThumbs((prev) => ({ ...prev, [i]: thumbCache.get(key) ?? null }))
            return
          }
          void window.deva.deliverables
            .thumbnail(sessionId, block.id, i)
            .catch(() => null)
            .then((url) => {
              thumbCache.set(key, url)
              if (alive) setThumbs((prev) => ({ ...prev, [i]: url }))
            })
        })
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [sessionId, block.id])

  useEffect(() => {
    if (copied === null) return
    const h = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(h)
  }, [copied])

  const open = (i: number): void => {
    void window.deva.deliverables
      .open(sessionId, block.id, i)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('chat.deliver.openFailed') })
      })
  }

  const reveal = (i: number): void => {
    void window.deva.deliverables
      .reveal(sessionId, block.id, i)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('chat.deliver.missing') })
      })
  }

  // 优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copyPath = (i: number, path: string): void => {
    void window.deva.clipboard
      .writeText(path)
      .catch(() => navigator.clipboard.writeText(path))
      .then(
        () => setCopied(i),
        () => {}
      )
  }

  const platform = window.deva.platform
  const revealLabel = t(
    platform === 'win32'
      ? 'chat.deliver.revealWin'
      : platform === 'darwin'
        ? 'chat.deliver.revealMac'
        : 'chat.deliver.revealOther'
  )
  const count = t(files.length === 1 ? 'chat.deliver.countOne' : 'chat.deliver.count').replace(
    '{n}',
    String(files.length)
  )
  const foldable = files.length > FOLD_PREVIEW + 1
  // 从头截取，行序号即文件在交付清单里的序号（IPC 按它取路径）。
  const shown = foldable && !expanded ? files.slice(0, FOLD_PREVIEW) : files
  // 收起时标题带上首个文件名与总数，不展开也知道交付了什么。
  const summary =
    files.length === 0
      ? ''
      : files.length === 1
        ? files[0].name
        : t('chat.deliver.collapsedMany')
            .replace('{name}', files[0].name)
            .replace('{n}', String(files.length))
            .replace('{rest}', String(files.length - 1))

  return (
    <div className={`card deliv${cardOpen ? ' is-open' : ''}`}>
      <button
        type="button"
        className="card__head deliv__head"
        onClick={() => setCardOpen((v) => !v)}
        aria-expanded={cardOpen}
      >
        <ChevronRight size={13} className="deliv__caret" />
        <span className="card__head-icon">
          <Package size={14} />
        </span>
        <span className="card__title">
          {t('chat.deliver.title')}
          {!cardOpen && summary && <span className="deliv__summary"> · {summary}</span>}
        </span>
        {cardOpen && <span className="deliv__count">{count}</span>}
      </button>
      <div className="deliv__list" hidden={!cardOpen}>
        {shown.map((f, i) => {
          const missing = loaded && f.size === null
          const canOpen = loaded && !missing && f.openable
          const thumb = thumbs[i]
          // 点整行：能打开就打开，否则在文件夹中显示（可执行 / 脚本类文件不直接打开）。
          const primary = (): void => (canOpen ? open(i) : reveal(i))
          return (
            <div key={f.path} className={`deliv__item${missing ? ' is-missing' : ''}`}>
              <button
                type="button"
                className="deliv__main"
                onClick={primary}
                disabled={!loaded || missing}
                title={f.path}
              >
                <span className="deliv__thumb">
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : <File size={20} />}
                </span>
                <span className="deliv__meta">
                  <span className="deliv__name">{f.name}</span>
                  <span className="deliv__sub">
                    {missing
                      ? t('chat.deliver.missing')
                      : loaded
                        ? `${formatSize(f.size ?? 0)} · ${f.dir}`
                        : f.dir}
                  </span>
                </span>
              </button>
              <span className="deliv__actions">
                {canOpen && (
                  <button
                    type="button"
                    className="deliv__act"
                    onClick={() => open(i)}
                    title={t('chat.deliver.open')}
                    aria-label={t('chat.deliver.open')}
                  >
                    <ExternalLink size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="deliv__act"
                  onClick={() => reveal(i)}
                  disabled={!loaded || missing}
                  title={revealLabel}
                  aria-label={revealLabel}
                >
                  <FolderOpen size={14} />
                </button>
                <button
                  type="button"
                  className="deliv__act"
                  onClick={() => copyPath(i, f.path)}
                  title={t('chat.deliver.copyPath')}
                  aria-label={t('chat.deliver.copyPath')}
                >
                  {copied === i ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </span>
            </div>
          )
        })}
      </div>
      {cardOpen && foldable && (
        <button
          type="button"
          className="deliv__more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded
            ? t('chat.deliver.collapse')
            : t('chat.deliver.expand').replace('{n}', String(files.length - FOLD_PREVIEW))}
        </button>
      )}
    </div>
  )
}
