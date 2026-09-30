import { nativeImage, type NativeImage } from 'electron'
import type { ImagePart } from '../providers/types'

/**
 * 工具结果里的图片整形（主进程）。read_file 读到的图片文件、MCP 工具返回的图片块都走这里，
 * 产出可直接随 tool_result 发给模型的 ImagePart——模型凭视觉能力直接「看」图，而非读文字描述。
 *
 * 两条约束决定了这里的做法：
 *  - **media_type 必须与实际字节一致**：服务商会校验，不一致直接 400；扩展名不可信，故按魔数识别。
 *  - **体积 / 尺寸有上限**：Anthropic 单图 base64 上限 5MB（原始字节约 3.75MB）；长边超过 1568px
 *    服务端也会先缩小再看，发大图只是白占上下文与落盘体积。故超限就地缩放 / 转码再发。
 * 缩放用 Electron 自带的 nativeImage（零依赖，守免装铁律；不引 sharp 之类原生模块）。
 * 它只可靠解码 PNG / JPEG：GIF / WebP 解不开时不超限就原样发（服务端自会处理），超限则如实报错。
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** 长边上限：与服务端内部缩放阈值对齐，约 1600 token/张（compaction 的 IMAGE_TOKENS 同此估算）。 */
const MAX_EDGE = 1568
/** 发送体积上限（原始字节）：base64 膨胀 4/3 后恰在 Anthropic 的 5MB 之内。 */
const MAX_SEND_BYTES = Math.floor(3.75 * 1024 * 1024)
/** 可接受的源文件上限：再大的图缩放也能压下来，但读盘解码本身已不划算。 */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024
/** 超限回退 JPEG 时的质量阶梯。 */
const JPEG_QUALITIES = [85, 70, 50]

/** 按魔数识别图片格式；不是这四种之一返回 null。 */
export function sniffImageMime(buf: Buffer): ImageMime | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  )
    return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export type PreparedImage =
  | {
      ok: true
      part: ImagePart
      /** 原图尺寸（解码不了时缺省）。 */
      width?: number
      height?: number
      /** 实际发送的尺寸 / 体积（缩放或转码过才与原图不同）。 */
      sentWidth?: number
      sentHeight?: number
      sentBytes: number
      resized: boolean
    }
  | { ok: false; reason: string }

/**
 * 把一张图整形成可发送的 ImagePart。`mime` 应来自 sniffImageMime（而非扩展名）。
 * 不超限则原样发送（字节不动）；超限则缩放到长边 MAX_EDGE，PNG 优先保持 PNG（保透明与文字锐度），
 * 仍超限再逐级降质回退 JPEG。永不抛错。
 */
export function prepareImage(buf: Buffer, mime: ImageMime, name?: string): PreparedImage {
  const make = (data: Buffer, mediaType: string): ImagePart => ({
    type: 'image',
    mediaType,
    data: data.toString('base64'),
    ...(name ? { name } : {})
  })

  let img: NativeImage
  try {
    img = nativeImage.createFromBuffer(buf)
  } catch {
    img = nativeImage.createEmpty()
  }

  if (img.isEmpty()) {
    if (buf.length > MAX_SEND_BYTES)
      return {
        ok: false,
        reason: `图片过大（${formatBytes(buf.length)}），且该格式无法在本地压缩；上限 ${formatBytes(MAX_SEND_BYTES)}`
      }
    return { ok: true, part: make(buf, mime), sentBytes: buf.length, resized: false }
  }

  const { width, height } = img.getSize()
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_EDGE && buf.length <= MAX_SEND_BYTES)
    return { ok: true, part: make(buf, mime), width, height, sentWidth: width, sentHeight: height, sentBytes: buf.length, resized: false }

  const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1
  const out =
    scale < 1
      ? img.resize({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          quality: 'best'
        })
      : img
  const size = out.getSize()
  const done = (data: Buffer, mediaType: string): PreparedImage => ({
    ok: true,
    part: make(data, mediaType),
    width,
    height,
    sentWidth: size.width,
    sentHeight: size.height,
    sentBytes: data.length,
    resized: true
  })

  // 源为 JPEG（照片居多）直接出 JPEG；其余先试 PNG。
  if (mime !== 'image/jpeg') {
    const png = out.toPNG()
    if (png.length <= MAX_SEND_BYTES) return done(png, 'image/png')
  }
  for (const q of JPEG_QUALITIES) {
    const jpg = out.toJPEG(q)
    if (jpg.length <= MAX_SEND_BYTES) return done(jpg, 'image/jpeg')
  }
  return { ok: false, reason: `图片压缩后仍超过 ${formatBytes(MAX_SEND_BYTES)}，无法发送` }
}
