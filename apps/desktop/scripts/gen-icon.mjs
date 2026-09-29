/**
 * 生成应用图标：build/icon.png（1024，供 mac/linux，electron-builder 自动转 icns）
 * 与 build/icon.ico（16~256 多尺寸，供 Windows）。
 *
 * 零第三方依赖：按 build/icon.svg 的几何形状解析式光栅化（超采样抗锯齿），
 * 用内置 zlib 编码 PNG，ICO 内嵌 PNG 帧。改图形请同步修改 icon.svg 与下方 inShape。
 *
 * 用法：node scripts/gen-icon.mjs   （在 apps/desktop 下）
 */
import { deflateSync } from 'zlib'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')

// ── 几何（1024 画布坐标，与 icon.svg 平移后一致）────────────────────────────
const BG_R = 224 // 底板圆角
const C0 = [0x4f, 0x46, 0xe5] // 渐变起点 indigo
const C1 = [0x7c, 0x3a, 0xed] // 渐变终点 violet

function inBg(x, y) {
  const cx = Math.min(Math.max(x, BG_R), 1024 - BG_R)
  const cy = Math.min(Math.max(y, BG_R), 1024 - BG_R)
  return (x - cx) ** 2 + (y - cy) ** 2 <= BG_R * BG_R
}

function inShape(x, y) {
  // 感叹号竖线：胶囊 (333,294)-(333,578) 半径 48
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

// ── 光栅化 ─────────────────────────────────────────────────────────────────
function render(size, ss = 4) {
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
      const t = (pxl + py + 1) / (2 * size) // 对角线渐变
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

// ── PNG / ICO 编码 ─────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(frames.length, 4)
  let offset = head.length
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    head[e] = size >= 256 ? 0 : size
    head[e + 1] = size >= 256 ? 0 : size
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bpp
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...frames.map((f) => f.data)])
}

// ── 输出 ───────────────────────────────────────────────────────────────────
writeFileSync(join(OUT, 'icon.png'), png(1024, render(1024)))
const frames = [16, 24, 32, 48, 64, 128, 256].map((size) => ({
  size,
  data: png(size, render(size, size <= 32 ? 8 : 4))
}))
writeFileSync(join(OUT, 'icon.ico'), ico(frames))
console.log('generated build/icon.png (1024) and build/icon.ico (16-256)')
