import { nativeImage, type NativeImage } from 'electron'
import { deflateSync } from 'zlib'

/**
 * 应用 / 托盘图标（运行期生成，无需任何二进制资产文件）。
 *
 * 遵「免装铁律」：只用内置 `zlib` 手写最小 PNG（RGBA 真彩 + alpha），
 * 画 Deva 标志（「!」作 D 的竖笔 + 半圆），与安装包图标 build/icon.ico 保持一致。
 * 生成 32×32 逻辑像素 PNG（附 2x）交 `nativeImage`；Windows 托盘会自动缩放到 16px。
 * 全程纯 JS、零第三方依赖，dev 与打包行为一致（不经 electron-vite `?asset` 资产管线，
 * 免去二进制资产的类型声明与打包路径问题）。
 */

// ── 最小 PNG 编码器（IHDR + IDAT + IEND，手写 CRC32）─────────────────────────

/** CRC32 查表（PNG 分块校验；不依赖 Node22 的 `zlib.crc32`，手写以兼容更低版本）。 */
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 把 RGBA 像素缓冲编码为 PNG（每行前置 filter 字节 0，zlib 压缩 IDAT）。 */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深 8
  ihdr[9] = 6 // 颜色类型 6 = RGBA
  // 10/11/12 = 压缩 / 滤波 / 隔行，均 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const idat = deflateSync(raw)
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ── 绘制 Deva 标志（与 build/icon.svg、scripts/gen-icon.mjs 同一几何）──────────

type RGB = [number, number, number]

const BG_R = 224 // 底板圆角（1024 画布坐标）
const C0: RGB = [0x4f, 0x46, 0xe5] // 渐变起点 indigo
const C1: RGB = [0x7c, 0x3a, 0xed] // 渐变终点 violet

/** 点是否在圆角方形底板内（1024 画布坐标）。 */
function inBg(x: number, y: number): boolean {
  const cx = Math.min(Math.max(x, BG_R), 1024 - BG_R)
  const cy = Math.min(Math.max(y, BG_R), 1024 - BG_R)
  return (x - cx) ** 2 + (y - cy) ** 2 <= BG_R * BG_R
}

/** 点是否在白色图形内：感叹号（竖线 + 圆点）充当 D 的竖笔，右侧接半圆弧。 */
function inShape(x: number, y: number): boolean {
  // 感叹号竖线：胶囊 (333,294)-(333,578)，半径 48
  const cy = Math.min(Math.max(y, 294), 578)
  if ((x - 333) ** 2 + (y - cy) ** 2 <= 48 * 48) return true
  // 感叹号圆点
  if ((x - 333) ** 2 + (y - 730) ** 2 <= 48 * 48) return true
  // 弧两端的短横（平头）
  if (x >= 441 && x <= 473 && (Math.abs(y - 294) <= 48 || Math.abs(y - 730) <= 48)) return true
  // 右半圆环：圆心 (473,512)，中线半径 218，线宽 96
  if (x >= 473) {
    const d = Math.hypot(x - 473, y - 512)
    if (d >= 170 && d <= 266) return true
  }
  return false
}

/**
 * 生成标志 RGBA 像素：渐变圆角底板 + 白色「!」+ 半圆（D）。
 * 按解析几何做 ss×ss 超采样抗锯齿，小尺寸（托盘 16/32px）边缘也不发毛。
 */
function drawLogo(size: number, ss = 8): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const k = 1024 / size
  const n = ss * ss
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let bgCov = 0
      let inkCov = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) * k
          const y = (py + (sy + 0.5) / ss) * k
          if (inBg(x, y)) {
            bgCov++
            if (inShape(x, y)) inkCov++
          }
        }
      }
      if (!bgCov) continue
      const t = (pxl + py + 1) / (2 * size) // 左上 → 右下对角渐变
      const a = inkCov / bgCov
      const i = (py * size + pxl) * 4
      for (let c = 0; c < 3; c++) {
        const bg = C0[c] + (C1[c] - C0[c]) * t
        px[i + c] = Math.round(bg * (1 - a) + 255 * a)
      }
      px[i + 3] = Math.round((bgCov / n) * 255)
    }
  }
  return px
}

let cached: NativeImage | null = null

/**
 * 取应用 / 托盘图标（首次生成后缓存）。
 * 基准 32px，另附 2x（64px）表示供高分屏使用。
 * 生成失败（极端环境）返回空 `NativeImage`——Tray 仍可创建，仅无图标，不崩。
 */
export function getAppIcon(): NativeImage {
  if (cached) return cached
  try {
    const size = 32
    const img = nativeImage.createFromBuffer(encodePng(size, size, drawLogo(size)))
    img.addRepresentation({
      scaleFactor: 2,
      buffer: encodePng(size * 2, size * 2, drawLogo(size * 2, 4))
    })
    cached = img
  } catch {
    cached = nativeImage.createEmpty()
  }
  return cached
}
