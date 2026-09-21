import { nativeImage, type NativeImage } from 'electron'
import { deflateSync } from 'zlib'

/**
 * 应用 / 托盘图标（运行期生成，无需任何二进制资产文件）。
 *
 * 遵「免装铁律」：只用内置 `zlib` 手写最小 PNG（RGBA 真彩 + alpha），
 * 画一枚指针时钟——切合「定时任务 / 自动任务」主题，也作应用窗口图标。
 * 生成一张 32×32 逻辑像素 PNG 交 `nativeImage`；Windows 托盘会自动缩放到 16px。
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

// ── 绘制时钟 ────────────────────────────────────────────────────────────────

type RGB = [number, number, number]

/** 点到线段的最近距离（画指针用，含端点夹取）。 */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 覆盖度 → 1px 软边抗锯齿（d<0 全覆盖，d>1 无覆盖）。 */
function aa(d: number): number {
  return Math.max(0, Math.min(1, 0.5 - d))
}

/**
 * 生成时钟 RGBA 像素（透明底、靛蓝表盘、白色指针、白色圈边、中心点）。
 * 表盘满圈填充，指针指向约 12 点与 3 点，一眼可辨「时钟 / 定时」。
 */
function drawClock(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  const c = (size - 1) / 2
  const R = size * 0.46 // 外半径
  const rim = size * 0.055 // 白色圈边宽度
  const handW = size * 0.05 // 指针半宽
  const face: RGB = [99, 102, 241] // indigo-500
  const ink: RGB = [255, 255, 255]

  // 指针端点（从中心指向 12 点与 3 点）
  const minA: [number, number] = [c, c - R * 0.66]
  const hourA: [number, number] = [c + R * 0.5, c]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - c, y - c)
      // 表盘：dist<R 填靛蓝，边缘抗锯齿
      const discA = aa(dist - R)
      if (discA <= 0) continue

      let r = face[0]
      let g = face[1]
      let b = face[2]

      // 白圈边（环形，位于外沿内侧）
      const rimA = Math.min(aa(Math.abs(dist - (R - rim)) - rim * 0.5), discA)
      // 指针 + 中心点（白）
      const handCover = Math.max(
        aa(distToSegment(x, y, c, c, minA[0], minA[1]) - handW),
        aa(distToSegment(x, y, c, c, hourA[0], hourA[1]) - handW),
        aa(dist - size * 0.08) // 中心圆点
      )
      const inkA = Math.min(Math.max(rimA, handCover), discA)
      if (inkA > 0) {
        r = Math.round(face[0] * (1 - inkA) + ink[0] * inkA)
        g = Math.round(face[1] * (1 - inkA) + ink[1] * inkA)
        b = Math.round(face[2] * (1 - inkA) + ink[2] * inkA)
      }

      const i = (y * size + x) * 4
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = Math.round(discA * 255)
    }
  }
  return px
}

let cached: NativeImage | null = null

/**
 * 取应用 / 托盘图标（首次生成后缓存）。
 * 生成失败（极端环境）返回空 `NativeImage`——Tray 仍可创建，仅无图标，不崩。
 */
export function getAppIcon(): NativeImage {
  if (cached) return cached
  try {
    const size = 32
    const png = encodePng(size, size, drawClock(size))
    cached = nativeImage.createFromBuffer(png)
  } catch {
    cached = nativeImage.createEmpty()
  }
  return cached
}
