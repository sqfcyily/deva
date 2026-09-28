import { useMemo, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import {
  AVATAR_COLORS,
  AVATAR_SLOTS,
  PersonaFace,
  isNonePart,
  partLabel,
  partPreview,
  partsForSlot,
  randomizeSpec,
  type AvatarSpec
} from '../components/humation'

/*
 * 头像编辑面板（角色编辑器与个人资料面板共用）：左侧大预览兼上传入口 + 随机/移除，右侧部件与配色。
 * 面板内改动只进**本地草稿**：「完成」经 onDone 交出、「取消」/ 父级直接卸载即丢弃——调用方无需快照回滚。
 */

// 十六进制 ↔ 颜色槽值互转：Humation colors/background 存不带 `#` 的十六进制；<input type=color> 需带 `#`。
const toHexInput = (v: string | undefined): string => {
  const s = (v || '').replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}` : '#000000'
}
const fromHexInput = (v: string): string => v.replace(/^#/, '').toUpperCase()

/** 自定义头像落盘边长（px）：正方缩略图，够 96px 预览的 2× 屏，又不至于把 data URI 撑大。 */
const AVATAR_PX = 256
/** 原图上限：只挡住误选的巨型图；归一后落盘的永远是上面那张 256² 小方图。 */
const AVATAR_UPLOAD_MAX = 12 * 1024 * 1024

/**
 * 用户选的图 → 居中裁成正方 → 缩到 AVATAR_PX → data URI。
 * 归一在渲染层做（canvas），主进程只管存字节，故无论原图多大 / 什么比例，落盘的都是小方图。
 * blob: 与 data: 均在 index.html 的 img-src 白名单内；本地文件同源，canvas 不会被 taint。
 */
function fileToAvatarDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = (): void => {
      URL.revokeObjectURL(url)
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        if (!side) return reject(new Error('empty image'))
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_PX
        canvas.height = AVATAR_PX
        const ctx = canvas.getContext('2d')
        if (!ctx) return reject(new Error('no 2d context'))
        ctx.drawImage(
          img,
          (img.naturalWidth - side) / 2,
          (img.naturalHeight - side) / 2,
          side,
          side,
          0,
          0,
          AVATAR_PX,
          AVATAR_PX
        )
        // 不支持 webp 时 toDataURL 会**静默回落 image/png**——主进程按 MIME 定扩展名，两种都收。
        const uri = canvas.toDataURL('image/webp', 0.9)
        if (!uri.startsWith('data:image/')) return reject(new Error('encode failed'))
        resolve(uri)
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    img.onerror = (): void => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

export function AvatarEditor({
  seed,
  initialSpec,
  initialImage,
  title,
  busy,
  onCancel,
  onDone
}: {
  seed: string
  /** 进面板时的**具体** spec（调用方已 resolveSpec），此后只处理显式值。 */
  initialSpec: AvatarSpec
  /** 自定义头像（data URI；空串 = 无）：非空即盖过 spec 生成头像。 */
  initialImage: string
  title?: string
  /** 「完成」需异步落盘时置 true，禁用两个按钮。 */
  busy?: boolean
  onCancel: () => void
  onDone: (spec: AvatarSpec, image: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [avatar, setAvatar] = useState<AvatarSpec>(initialSpec)
  const [avatarImage, setAvatarImage] = useState<string>(initialImage)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // 选图：先在渲染层归一成 256×256 方图再交主进程，故无论用户给多大的原图，落盘都是小图。
  const onPickImage = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // 清空，否则连选同一个文件不会再触发 change
    if (!file) return
    if (file.size > AVATAR_UPLOAD_MAX) {
      toast.show({ title: t('cf.avaImgTooBig'), variant: 'error' })
      return
    }
    void fileToAvatarDataUri(file)
      .then(setAvatarImage)
      .catch(() => toast.show({ title: t('cf.avaImgFailed'), variant: 'error' }))
  }
  // 各槽位部件缩略图：用中性默认配色一次性生成并 memo（大预览才反映实际配色，故此处不随配色重算）。
  const slotPreviews = useMemo(
    () =>
      AVATAR_SLOTS.map((slot) => ({
        slot,
        parts: partsForSlot(slot).map((part) => ({
          part,
          uri: isNonePart(part) ? '' : partPreview(part)
        }))
      })),
    []
  )
  const setSelection = (slot: string, partId: string): void =>
    setAvatar((a) => ({ ...a, selections: { ...(a.selections ?? {}), [slot]: partId } }))
  const setColorSlot = (slot: string, hex: string): void =>
    setAvatar((a) => ({ ...a, colors: { ...(a.colors ?? {}), [slot]: fromHexInput(hex) } }))
  const setBackground = (hex: string): void => setAvatar((a) => ({ ...a, background: fromHexInput(hex) }))

  return (
    <div className="cf-avapanel">
      <div className="cf-avaedit">
        <div className="cf-avaedit__side">
          {/* 头像本体就是上传入口：悬停浮出遮层，点击直接唤起系统文件选择器。 */}
          <button
            type="button"
            className="cf-avaedit__preview"
            aria-label={t('cf.avaImgUpload')}
            onClick={() => fileRef.current?.click()}
          >
            <PersonaFace seed={seed} spec={avatar} image={avatarImage} title={title || t('cf.fAvatar')} />
            <span className="cf-avaedit__upload" title={t('cf.avaImgUpload')}>
              <ImagePlus size={20} aria-hidden="true" />
            </span>
          </button>
          {/* 用了自定义图时「随机」无从体现，换成「移除」让用户能退回生成头像。 */}
          {avatarImage ? (
            <button type="button" className="cf-btn cf-avaedit__rand" onClick={() => setAvatarImage('')}>
              {t('cf.avaImgRemove')}
            </button>
          ) : (
            <button
              type="button"
              className="cf-btn cf-avaedit__rand"
              onClick={() => setAvatar(randomizeSpec())}
            >
              {t('cf.avaRandom')}
            </button>
          )}
          {/* 系统文件选择器由 <input type="file"> 唤起：图只在渲染层解码，不经任何 Agent 工具。 */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={onPickImage}
          />
        </div>

        <div className="cf-avaedit__main">
          {/* 部件：每槽一行横向缩略图；「无」选项渲染为文字块。 */}
          {slotPreviews.map(({ slot, parts }) => (
            <div key={slot} className="cf-avaedit__group">
              <span className="cf-avaedit__glabel">{t(`cf.avaSlot.${slot}`)}</span>
              <div className="cf-avaedit__parts">
                {parts.map(({ part, uri }) => {
                  const selected = avatar.selections?.[slot] === part.id
                  return (
                    <button
                      key={part.id}
                      type="button"
                      title={partLabel(part)}
                      aria-pressed={selected}
                      className={`cf-avaedit__part${selected ? ' is-selected' : ''}`}
                      onClick={() => setSelection(slot, part.id)}
                    >
                      {uri ? (
                        <img src={uri} alt={partLabel(part)} draggable={false} />
                      ) : (
                        <span className="cf-avaedit__none">{t('cf.avaNone')}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {/* 配色：角色部件配色 + 背景色。 */}
          <div className="cf-avaedit__colors">
            {AVATAR_COLORS.map((slot) => (
              <label key={slot} className="cf-avaedit__swatch">
                <input
                  type="color"
                  value={toHexInput(avatar.colors?.[slot])}
                  onChange={(e) => setColorSlot(slot, e.target.value)}
                />
                <span>{t(`cf.avaColor.${slot}`)}</span>
              </label>
            ))}
            <label className="cf-avaedit__swatch">
              <input
                type="color"
                value={toHexInput(avatar.background)}
                onChange={(e) => setBackground(e.target.value)}
              />
              <span>{t('cf.avaColor.background')}</span>
            </label>
          </div>
        </div>
      </div>

      <div className="cf-editor__actions">
        <button type="button" className="cf-btn" disabled={busy} onClick={onCancel}>
          {t('cf.cancel')}
        </button>
        <button
          type="button"
          className="cf-btn is-primary"
          disabled={busy}
          onClick={() => onDone(avatar, avatarImage)}
        >
          {t('cf.avaDone')}
        </button>
      </div>
    </div>
  )
}
