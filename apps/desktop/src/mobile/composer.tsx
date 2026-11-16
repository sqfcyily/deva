import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Camera, FileUp, Image as ImageIcon, Plus, X } from 'lucide-react'
import { MAX_UPLOAD_BYTES } from '../shared/remote-web'
import type { Store } from './App'
import { FileTile } from './files'
import { fmtBytes, t } from './strings'

/**
 * 输入框：左侧 ＋（照片 / 拍照 / 文件），右侧单键——进行中且没写字时是停止，写了字是发送（插入这一轮，同电脑端）。
 * 选好的附件立刻开始上传，传完才能发；照片先在手机上压缩（长边 2048、JPEG），省流量也省模型上下文。
 */

interface Pending {
  id: string
  name: string
  size: number
  preview?: string
  progress: number
  uid?: string
  error?: string
  abort: AbortController
}

const IMAGE_MAX_EDGE = 2048

/** 照片压缩：长边超过 2048 或体积超过 1.5 MB 的转成 JPEG（GIF 原样保留，动图压了就不动了）。 */
async function compress(file: File): Promise<{ blob: Blob; name: string }> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return { blob: file, name: file.name }
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type !== 'image/heic') {
      bmp.close()
      return { blob: file, name: file.name }
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85))
    if (!blob) return { blob: file, name: file.name }
    return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' }
  } catch {
    return { blob: file, name: file.name }
  }
}

export function Composer({
  store,
  sid,
  busy,
  waiting,
  onSent
}: {
  store: Store
  sid: string
  busy: boolean
  waiting: boolean
  onSent: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState(false)
  const [files, setFiles] = useState<Pending[]>([])
  const ta = useRef<HTMLTextAreaElement>(null)
  const pickPhoto = useRef<HTMLInputElement>(null)
  const pickCamera = useRef<HTMLInputElement>(null)
  const pickFile = useRef<HTMLInputElement>(null)
  const { link, ready } = store

  // 输入框随内容长高（最多约 6 行）。没到上限时不许滚动：行高的小数会让内容比框高出零点几像素，
  // 电脑版 Chrome 会因此在右侧画出一条滚动条。
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    const h = el.scrollHeight
    el.style.height = `${Math.min(h, 150)}px`
    el.style.overflowY = h > 150 ? 'auto' : 'hidden'
  }, [text])

  // 离开对话：没发出去的上传作废。
  useEffect(
    () => () => {
      setFiles((l) => {
        for (const f of l) {
          f.abort.abort()
          if (f.preview) URL.revokeObjectURL(f.preview)
        }
        return []
      })
    },
    []
  )

  const patch = (id: string, p: Partial<Pending>): void => setFiles((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)))

  const add = async (list: FileList | null): Promise<void> => {
    setMenu(false)
    if (!list || !link) return
    for (const raw of [...list].slice(0, 9)) {
      const id = `${Date.now()}-${Math.random()}`
      const abort = new AbortController()
      const isImg = raw.type.startsWith('image/')
      setFiles((l) => [...l, { id, name: raw.name, size: raw.size, progress: 0, abort, preview: isImg ? URL.createObjectURL(raw) : undefined }])
      const { blob, name } = await compress(raw)
      if (blob.size > MAX_UPLOAD_BYTES) {
        patch(id, { error: t('uploadFailed') })
        store.toast(`${raw.name}：${fmtBytes(blob.size)} > ${fmtBytes(MAX_UPLOAD_BYTES)}`, false)
        continue
      }
      patch(id, { size: blob.size, name })
      const r = await link.upload(blob, name, (p) => patch(id, { progress: p }), abort.signal)
      if (abort.signal.aborted) continue
      if (r.uid) patch(id, { uid: r.uid, progress: 1 })
      else {
        patch(id, { error: r.message ?? t('uploadFailed') })
        store.toast(r.message ?? t('uploadFailed'), false)
      }
    }
  }

  const remove = (f: Pending): void => {
    f.abort.abort()
    if (f.preview) URL.revokeObjectURL(f.preview)
    setFiles((l) => l.filter((x) => x.id !== f.id))
  }

  const uploading = files.some((f) => !f.uid && !f.error)
  const okFiles = files.filter((f) => f.uid)
  const body = text.trim()
  const canSend = ready && !uploading && (!!body || okFiles.length > 0) && !waiting

  // 同 IM：点发送立刻显示在对话末尾、清空输入框，回执与对话记录在后台对上（见 outbox.ts）。
  const send = (): void => {
    if (!canSend) return
    if (busy && okFiles.length) return store.toast(t('attachBusy'), false)
    store.outboxOps.send(
      sid,
      body,
      okFiles.map((f) => ({ uid: f.uid!, name: f.name, preview: f.preview })),
      busy
    )
    setText('')
    // 照片预览交给发件箱（消息对上以后由它释放）；出错没发的附件这里释放。
    for (const f of files) if (f.preview && !f.uid) URL.revokeObjectURL(f.preview)
    setFiles([])
    onSent()
    ta.current?.focus()
  }

  const showStop = busy && !body && !files.length

  return (
    <div className="cmp">
      {files.length > 0 && (
        <div className="cmp__files">
          {files.map((f) => (
            <span key={f.id} className={`chip${f.error ? ' is-error' : ''}`}>
              {f.preview ? <img src={f.preview} alt="" /> : <FileTile name={f.name} />}
              {!f.uid && !f.error && (
                <span className="chip__prog" style={{ ['--p' as string]: `${Math.round(f.progress * 100)}%` }} />
              )}
              <button className="chip__x" aria-label={t('cancel')} onClick={() => remove(f)}>
                <X size={13} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="cmp__box">
        <button className="cmp__plus" aria-label={t('attachFile')} disabled={!ready} onClick={() => setMenu((v) => !v)}>
          <Plus size={22} strokeWidth={1.8} className={menu ? 'is-open' : ''} />
        </button>
        <textarea
          ref={ta}
          className="cmp__input"
          rows={1}
          placeholder={busy ? t('composerBusy') : t('composer')}
          value={text}
          enterKeyHint="send"
          onFocus={() => setMenu(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 电脑浏览器里 Enter 发送、Shift+Enter 换行；手机键盘的 Enter 是换行，用按钮发。
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault()
              send()
            }
          }}
        />
        {showStop ? (
          <button className="cmp__go is-stop" aria-label={t('stop')} disabled={!ready} onClick={() => link?.stopTurn(sid)}>
            <i />
          </button>
        ) : (
          <button className={`cmp__go${canSend ? '' : ' is-off'}`} aria-label={t('send')} disabled={!canSend} onClick={() => send()}>
            <ArrowUp size={19} strokeWidth={2.4} />
          </button>
        )}
      </div>
      {menu && (
        <div className="cmp__menu">
          <button onClick={() => pickPhoto.current?.click()}>
            <ImageIcon size={22} strokeWidth={1.7} />
            {t('attachPhoto')}
          </button>
          <button onClick={() => pickCamera.current?.click()}>
            <Camera size={22} strokeWidth={1.7} />
            {t('attachCamera')}
          </button>
          <button onClick={() => pickFile.current?.click()}>
            <FileUp size={22} strokeWidth={1.7} />
            {t('attachFile')}
          </button>
        </div>
      )}
      <input ref={pickPhoto} type="file" accept="image/*" multiple hidden onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
      <input ref={pickCamera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
      <input ref={pickFile} type="file" multiple hidden onChange={(e) => void add(e.target.files).finally(() => (e.target.value = ''))} />
    </div>
  )
}
