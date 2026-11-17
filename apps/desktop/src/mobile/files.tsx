import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, Folder } from 'lucide-react'
import type { WebDelivered } from '../shared/remote-web'
import type { Store } from './App'
import { Markdown } from './cards'
import type { FileResult } from './link'
import { fmtBytes, t } from './strings'

/**
 * 文件：交付文件卡片（点开在应用内预览：Markdown、文本、网页（隔离渲染）、Office 文档的文字、图片；其他格式保存 / 分享）
 * 与对话里图片附件的缩略图。
 */

const EXT_COLOR: Record<string, string> = {
  xlsx: 'var(--ft-excel)',
  xls: 'var(--ft-excel)',
  csv: 'var(--ft-excel)',
  docx: 'var(--ft-word)',
  doc: 'var(--ft-word)',
  pptx: 'var(--ft-ppt)',
  ppt: 'var(--ft-ppt)',
  pdf: 'var(--danger)',
  zip: 'var(--ft-archive)',
  png: 'var(--ft-image)',
  jpg: 'var(--ft-image)',
  jpeg: 'var(--ft-image)',
  gif: 'var(--ft-image)',
  webp: 'var(--ft-image)',
  svg: 'var(--ft-image)',
  md: 'var(--accent)',
  html: 'var(--accent)'
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function FileTile({ name }: { name: string }): React.JSX.Element {
  const ext = extOf(name)
  return (
    <span className="file__ic" style={{ background: EXT_COLOR[ext] ?? 'var(--ft-text)' }} aria-hidden>
      {ext ? ext.toUpperCase().slice(0, 4) : <FileText size={18} />}
    </span>
  )
}

/**
 * 你发的消息里的文件附件：文件类型图标 + 文件名，图标同输入框上方待发送的附件。
 * 图片附件另有缩略图（AttachmentThumb），不走这里。
 */
export function AttachmentCard({ name, kind }: { name: string; kind?: string }): React.JSX.Element {
  return (
    <span className="att">
      {kind === 'folder' ? (
        <span className="file__ic att__folder" aria-hidden>
          <Folder size={17} />
        </span>
      ) : (
        <FileTile name={name} />
      )}
      <b className="att__k">{name}</b>
    </span>
  )
}

export function FileCard({ file, onOpen, className }: { file: WebDelivered; onOpen: () => void; className?: string }): React.JSX.Element {
  return (
    <button className={`file${className ? ` ${className}` : ''}`} onClick={onOpen}>
      <FileTile name={file.name} />
      <span className="file__k">
        <b>{file.name}</b>
        <span>{t('filePreview')}</span>
      </span>
      <ChevronRight size={17} className="file__chev" />
    </button>
  )
}

/** 交付文件预览页（取过的文件在这一次打开里记住，返回再进不重新下载）。 */
const fileCache = new Map<string, FileResult>()

export function FilePage({ store, sid, file }: { store: Store; sid: string; file: WebDelivered }): React.JSX.Element {
  const key = `${store.deskId}|${sid}|${file.tool}|${file.index}`
  const [res, setRes] = useState<FileResult | null>(() => fileCache.get(key) ?? null)
  const [progress, setProgress] = useState(0)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (res || !store.link || !store.ready) return
    let alive = true
    void store.link.file(sid, file.tool, file.index, (p) => alive && setProgress(p)).then((r) => {
      if (!alive) return
      if (r.ok) fileCache.set(key, r)
      setRes(r)
    })
    return () => {
      alive = false
    }
  }, [res, store.link, store.ready, sid, file, key])

  useEffect(() => {
    if (!res?.blob) return
    const u = URL.createObjectURL(res.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [res])

  const save = async (): Promise<void> => {
    if (!res) return
    const blob = res.blob ?? new Blob([res.text ?? ''], { type: 'text/plain;charset=utf-8' })
    const f = new File([blob], res.name ?? file.name, { type: blob.type })
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
    if (nav.canShare?.({ files: [f] })) {
      try {
        await navigator.share({ files: [f] })
        return
      } catch {
        /* 用户取消或不支持：改下载 */
      }
    }
    const u = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = u
    a.download = f.name
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(u), 10_000)
  }

  // 网页文件：电脑按文本给内容，这里按扩展名改成渲染（源码仍可用右上角保存 / 分享拿到）。
  const html = !!res?.ok && res.kind === 'text' && /^html?$/.test(extOf(res.name ?? file.name))

  return (
    <div className="page">
      <header className="tb tb--sub">
        <button className="ib" aria-label="back" onClick={store.back}>
          <ChevronLeft size={26} strokeWidth={1.8} />
        </button>
        <div className="tb__who">
          <b>{file.name}</b>
          {res?.size !== undefined && <span>{fmtBytes(res.size)}</span>}
        </div>
        {res?.ok && (
          <button className="ib" aria-label={t('fileDownload')} onClick={() => void save()}>
            <Download size={21} strokeWidth={1.8} />
          </button>
        )}
      </header>
      <div className={`scroll fileview${html ? ' fileview--frame' : ''}`}>
        {!res ? (
          <div className="fileview__wait">
            <span className="spin spin--lg" />
            <span>{t('fileLoading')}</span>
            {progress > 0 && (
              <span className="bar">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </span>
            )}
          </div>
        ) : !res.ok ? (
          <div className="empty">{res.message}</div>
        ) : res.kind === 'markdown' ? (
          <div className="fileview__doc">
            <Markdown text={res.text ?? ''} />
          </div>
        ) : html ? (
          // 网页交给浏览器渲染。sandbox 不带 allow-same-origin：页面里的脚本跑在独立的空来源里，
          // 碰不到本应用的存储（配对密钥）、Cookie 和 Service Worker，也不能把外层页面带走。
          <iframe className="fileview__frame" title={file.name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={res.text ?? ''} />
        ) : res.kind === 'text' ? (
          <pre className="fileview__text">{res.text}</pre>
        ) : res.kind === 'image' && url ? (
          <div className="fileview__img">
            <img src={url} alt={file.name} />
          </div>
        ) : (
          <div className="fileview__wait">
            <FileTile name={file.name} />
            <span>{t('fileNoPreview')}</span>
            <button className="btn btn--primary" onClick={() => void save()}>
              <Download size={18} />
              {t('fileDownload')}
            </button>
          </div>
        )}
        {res?.truncated && <div className="note note--center">{t('fileTruncated')}</div>}
      </div>
    </div>
  )
}

/** 对话里图片附件的缩略图（按 ref 向电脑要，取到的记住；没取到的下次显示时再要）。 */
const thumbs = new Map<string, string>()

/** 手机发出的照片对上对话记录里的那条以后：本机预览直接当它的缩略图，不再向电脑要一遍（见 outbox.ts）。 */
export function adoptThumb(deskId: string, sid: string, refId: string, uri: string): void {
  thumbs.set(`${deskId}|${sid}|${refId}`, uri)
}

export function AttachmentThumb({ store, sid, refId, name }: { store: Store; sid: string; refId: string; name: string }): React.JSX.Element {
  const key = `${store.deskId}|${sid}|${refId}`
  const [uri, setUri] = useState<string | null | undefined>(() => thumbs.get(key))
  const [big, setBig] = useState(false)
  useEffect(() => {
    if (uri !== undefined || !store.link || !store.ready) return
    let alive = true
    void store.link.image(sid, refId).then((u) => {
      if (u) thumbs.set(key, u)
      if (alive) setUri(u)
    })
    return () => {
      alive = false
    }
  }, [uri, store.link, store.ready, sid, refId, key])
  if (!uri) return <AttachmentCard name={name} />
  return (
    <>
      <button className="thumb" onClick={() => setBig(true)}>
        <img src={uri} alt={name} />
      </button>
      {big && (
        <div className="viewer" onClick={() => setBig(false)}>
          <img src={uri} alt={name} />
        </div>
      )}
    </>
  )
}
