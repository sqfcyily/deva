/**
 * Humation 头像统一封装（全应用唯一的头像渲染面）。
 *
 * 背景：对话优先外壳原本用 emoji 作角色/用户头像。改为 Humation —— 一套确定性手绘 SVG 头像引擎
 * （纯 JS/SVG，无 wasm、无网络，契合 CSP）。同一 seed 恒生成同一头像；亦可用 selections/colors 精确定制。
 *
 * 数据模型：角色头像以 `AvatarSpec`（JSON）存进 persona frontmatter 的 `avatar` 字段（主进程/preload/store
 * 全程只当**不透明字符串**搬运，语义仅在此解释）。
 *  - `avatar` 为空 → 由 seed（persona.id）确定性生成，故所有既有角色零迁移即得一枚稳定头像
 *    （部件由引擎按 seed 选，配色由 `seededPalette` 按同一 seed 挑，形状为圆形）；
 *  - `avatar` 为 JSON → 用显式 selections/colors/shape 覆盖，seed 退化为无关紧要的兜底。
 *
 * 编辑器：打开时把「seed + 已存 spec」经 `resolveSpec` 解析为**具体** selections/colors/shape，此后一律以具体值工作、
 * 保存时也写入具体值 —— 故「所见（编辑器）＝所存＝各处所渲染」，绝无 seed 与存储不一致的漂移。
 *
 * 形状与构图（对比稿 design/avatar-shapes.html，2026-11-09 用户选定）：
 *  - 底板不再限定圆形，15 种形状；已有角色与「我」保持圆形，新加的角色创建时随机一个并存成具体形状（菱形不进随机池），可在编辑器改；
 *  - 「探出」构图：身体按形状裁切，头部与配件画在底板前、可越出上沿；头像占位尺寸不变；
 *    ≤20px 与叠放处用 `compact`（框内构图，整枚按形状裁切），避免轮廓杂乱；
 *  - 上传图片按同一形状裁切、不探出；透明背景的图片按主体包围盒摆放，可以探出。
 *  形状恒铺满头像框（两种构图都是），故外层遮层用 `shapeMask(shape)` 即可与头像同形；
 *  但生成中（busy）底板会变成星芒，要跟着变的遮层用 FaceProps.veil 画在 SVG 里。
 */
import { Component, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { humation1 } from '@humation/assets-humation-1'
import { createAvatar, createPartPreview, getPartsForSlot, resolvePartId } from '@humation/core'
import type { PartOption } from '@humation/core'
import {
  AUTO_SHAPE,
  SHAPE_POOL,
  hashSeed,
  isAvatarShape,
  legacyAutoShape,
  type AvatarShape
} from '../../../shared/avatar-shape'

export { humation1 }
export { AUTO_SHAPE, AVATAR_SHAPES, isAvatarShape, seededShape, type AvatarShape } from '../../../shared/avatar-shape'

/** 人类用户（「我」）的固定头像 seed —— 稳定、确定性，与角色区分（角色以 persona.id 为 seed）。 */
export const USER_AVATAR_SEED = 'deva-you'

/** 头像自定义规格：序列化为 JSON 存进 persona 的 avatar 字段；空对象 → 回落 seed 生成。 */
export interface AvatarSpec {
  /** 各部件槽位选择（head/body/bottom/item/glasses → 部件名/别名/ID）。 */
  selections?: Record<string, string>
  /** 各配色槽（hair/skin/clothes/bottom/stroke/background → hex，带不带 # 皆可）。 */
  colors?: Record<string, string>
  /** 背景色（hex 或 'transparent'）。 */
  background?: string
  /** 底板形状（AVATAR_SHAPES 之一；旧数据可能是 AUTO_SHAPE，按 seed 挑）；缺省圆形。 */
  shape?: string
}

/**
 * 编辑器暴露的可选部件槽位（按自然编辑顺序：发型→上衣→眼镜→配件）。
 * 刻意不含 bottom（下装）：头像取头肩胸像、下装在裁剪线以下永不显示，故编辑器不暴露。
 */
export const AVATAR_SLOTS = ['head', 'body', 'glasses', 'item'] as const
export type AvatarSlot = (typeof AVATAR_SLOTS)[number]

/**
 * 编辑器暴露的可调配色槽（colors 映射内的键）。stroke 描边刻意不暴露，保持默认黑轮廓；
 * bottom（下装色）同样不暴露（下装永不显示）；
 * background 是 toJSON 的**顶层字段**（非 colors 键），编辑器单独用一枚背景色选择器绑定。
 */
export const AVATAR_COLORS = ['hair', 'skin', 'clothes'] as const
export type AvatarColorSlot = (typeof AVATAR_COLORS)[number]

/**
 * 随机配色取样池（发/肤/衣/背景）—— 精选而非全随机，避免生成刺眼组合。
 *
 * 肤色：刻意只收浅至中等的暖色调（偏亚洲肤色），不收棕/黑——这是产品口径，别照「肤色光谱要全」补回来。
 * 背景：三档并存，按用户看过预览页（avatar-bg 对比稿）后定的取舍（2026-11-05）：
 *   - 原深色池只留参考图 2.png 实采的紫 / 蓝 / 青 / 绿（★）和藏青；橙红、琥珀、砖红、玫红、深紫、
 *     深青绿已删，别加回来；
 *   - 明亮中调：对标 `0d8ce9` 与小码酱的 `3ad9c7`，亮度约 50–65%、高饱和；
 *   - 马卡龙：高亮度、低饱和的粉彩色。马卡龙杏 `ffdac1` 与浅肤色 `ffd9c0` 几乎同色，
 *     马卡龙黄 `fff1a8` 配白衣服也偏弱，这两对靠 Humation 自带的黑色描边分出轮廓。
 *   **别拿亮度比当唯一判据**：这是平涂插画、色相差本身就在分离。
 */
const HAIR_TONES = ['1c1c1c', '3b2a1a', '6b4226', 'a55c2b', 'd8b26a', 'b0b0b0', '7c4dff', 'e6567a']
const SKIN_TONES = ['ffe0bd', 'ffd9c0', 'f8dcb4', 'f1c27d', 'e8c19a', 'dcab7e']
const CLOTHES_TONES = ['ffffff', '2d2d2d', '4f8cff', '46c26a', 'ff8c42', 'ff5d8f', '7c7cf0', 'ffd23f']
const BG_TONES = [
  // 原深色池保留项
  '8a38f5', // ★ 紫
  '1f3a8a', // 藏青
  '0d8ce9', // ★ 蓝
  '0987a0', // ★ 青
  '198e51', // ★ 绿
  // 明亮中调
  '3ad9c7', // 亮青绿
  '2ec4a0', // 薄荷绿
  '3fb950', // 草绿
  '3aa0ff', // 天蓝
  '5c7cfa', // 靛蓝
  '9b7bf0', // 薰衣草紫
  'e05cd0', // 洋红
  'f06292', // 桃粉
  'f2665e', // 珊瑚红
  'ff8a3d', // 橘
  'f5b82e', // 向日葵黄
  // 马卡龙
  'a8d8ff', // 马卡龙蓝
  'b5ead7', // 马卡龙绿
  'cdb4ff', // 马卡龙紫
  'ffb7c5', // 马卡龙粉
  'ffdac1', // 马卡龙杏
  'fff1a8' // 马卡龙黄
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * 由 seed 确定性取一组配色（发/肤/衣/背景），同一 seed 恒得同一组。
 *
 * 为什么需要：Humation 的 seed **只决定部件、不决定配色** —— 不带 spec 生成的头像配色恒为引擎默认
 * （发黑 / 肤白 / 衣白 / 灰底 F6F5F4），于是「对话生成的角色名片」「内置角色」「用户头像」等所有
 * 走 seed 回落的头像清一色是同一套黑白线稿，只有部件不同。这里按 seed 哈希从精选色池里挑，
 * 补上四项配色：既有色彩，又**保持确定性**——同一角色永远同一张脸，不会每次渲染漂移，
 * 名片预览与点开后的编辑器也必然一致。（`randomizeSpec` 是另一路：用户点「随机」时才真随机。）
 */
export function seededPalette(seed: string): { colors: Record<string, string>; background: string } {
  let s = hashSeed(seed) || 1 // xorshift32 不能从 0 起步
  const next = (n: number): number => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s % n
  }
  // 取值顺序即各槽位的取样次序，改动顺序会让所有既有头像换色——别随手调。
  return {
    colors: {
      hair: HAIR_TONES[next(HAIR_TONES.length)],
      skin: SKIN_TONES[next(SKIN_TONES.length)],
      clothes: CLOTHES_TONES[next(CLOTHES_TONES.length)]
    },
    background: BG_TONES[next(BG_TONES.length)]
  }
}

/* ─────────────────────────────── 底板形状 ─────────────────────────────── */

type Pt = [number, number]
const r2 = (n: number): number => Math.round(n * 100) / 100

/** 极坐标采样：t 从正上方顺时针，r(t) 为到 (50,50) 的距离。 */
function polarPts(fn: (t: number) => number, n = 180): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const r = fn(t)
    pts.push([50 + r * Math.sin(t), 50 - r * Math.cos(t)])
  }
  return pts
}
function superellipsePts(a: number, n: number, m = 160): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < m; i++) {
    const t = (i / m) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    pts.push([50 + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), 50 + a * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)])
  }
  return pts
}
function rotatePts(pts: Pt[], deg: number): Pt[] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return pts.map(([x, y]) => [50 + (x - 50) * c - (y - 50) * s, 50 + (x - 50) * s + (y - 50) * c])
}
/** 星芒的极坐标半径（八个角）：星芒形状与「生成中」的星芒共用。 */
function burstR(t: number): number {
  return 41.5 + 8.5 * Math.pow((1 + Math.cos(8 * t)) / 2, 1.4)
}
/** 等比缩放并居中进 0..100 方框（四周留 m）。 */
function fitPts(pts: Pt[], m = 2): Pt[] {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  const k = (100 - 2 * m) / Math.max(x1 - x0, y1 - y0)
  const ox = 50 - ((x0 + x1) / 2) * k
  const oy = 50 - ((y0 + y1) / 2) * k
  return pts.map(([x, y]) => [ox + x * k, oy + y * k])
}
/** 几个圆的平滑并集（融合处是圆角而不是尖角）：沿射线二分求边界。 */
function smoothUnionPts(circles: [number, number, number][], k: number, n = 200): Pt[] {
  const f = (x: number, y: number): number =>
    -k * Math.log(circles.reduce((s, [cx, cy, r]) => s + Math.exp(-(Math.hypot(x - cx, y - cy) - r) / k), 0))
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const dx = Math.sin(t)
    const dy = -Math.cos(t)
    let lo = 0
    let hi = 90
    for (let j = 0; j < 30; j++) {
      const mid = (lo + hi) / 2
      if (f(50 + dx * mid, 50 + dy * mid) < 0) lo = mid
      else hi = mid
    }
    pts.push([50 + dx * lo, 50 + dy * lo])
  }
  return pts
}
function ptsPath(pts: Pt[]): string {
  return pts.map((p, i) => (i ? 'L' : 'M') + r2(p[0]) + ' ' + r2(p[1])).join('') + 'Z'
}
/** 圆角多边形：每个顶点前后各退 rad，用二次曲线绕过顶点。 */
function roundPolyPath(pts: Pt[], rad: number): string {
  const n = pts.length
  const unit = (a: Pt, p: Pt): Pt => {
    const dx = a[0] - p[0]
    const dy = a[1] - p[1]
    const l = Math.hypot(dx, dy)
    return [dx / l, dy / l]
  }
  let d = ''
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const ua = unit(pts[(i - 1 + n) % n], p)
    const ub = unit(pts[(i + 1) % n], p)
    d +=
      (i ? 'L' : 'M') +
      `${r2(p[0] + ua[0] * rad)} ${r2(p[1] + ua[1] * rad)}Q${r2(p[0])} ${r2(p[1])} ${r2(p[0] + ub[0] * rad)} ${r2(p[1] + ub[1] * rad)}`
  }
  return d + 'Z'
}

/**
 * 各形状的路径（形状名单、随机池与按 seed 取样在 shared/avatar-shape.ts，主进程也用）。
 * 路径为 0..100 单位方框内的绝对路径，只用 M / L / Q / A / Z（mapPath 依赖这点）。
 */
const SHAPE_PATHS: Record<AvatarShape, string> = {
  circle: 'M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z',
  squircle: ptsPath(superellipsePts(48, 4.2)),
  arch: 'M4 50A46 46 0 0 1 96 50L96 86Q96 98 84 98L16 98Q4 98 4 86Z',
  scallop: ptsPath(polarPts((t) => 47 + 3 * Math.cos(12 * t), 192)),
  burst: ptsPath(polarPts(burstR, 192)),
  // 六角软星（参考图 2026-11-11 橙色那枚）：原图轮廓的极坐标谐波几乎只有 6 次（12 次以上可忽略），
  // 即 r = R(1 − 0.135·cos6t)：瓣尖在 ±30°/±90°/±150°，正上方是凹口——顶上两个瓣尖像一对耳朵
  hexstar: ptsPath(fitPts(polarPts((t) => 50 - 6.75 * Math.cos(6 * t), 192))),
  // 五团云（参考图 1.png，对比稿 design/avatar-cloud.html）：左上一团最大最高、右上一团小而低，两侧两团最大，底一团；
  // 五个圆的位置、大小与平滑半径照原图轮廓拟合（加权误差约 0.5%）。别做左右对称——会把顶上两团间的凹口填平，用户嫌平。取代四叶（用户删掉）
  cloud: ptsPath(
    fitPts(
      smoothUnionPts(
        [[37.21, 30.76, 26.99], [67.01, 29.52, 20.25], [72.41, 57.87, 28.64], [23.21, 56.95, 29.07], [49.2, 72.17, 25]],
        2.35
      )
    )
  ),
  diamond: roundPolyPath([[50, 1], [99, 50], [50, 99], [1, 50]], 15),
  // 参考图 3 第 5 个：从原图取轮廓拟合三、四次谐波，起伏放大 2.5 倍（原样几乎看不出不是圆）
  pebble: ptsPath(
    fitPts(
      polarPts(
        (t) =>
          50 +
          2.5 *
            (0.14 * Math.cos(2 * t) +
              0.25 * Math.cos(3 * t) +
              0.57 * Math.sin(3 * t) -
              0.29 * Math.cos(4 * t) +
              0.84 * Math.sin(4 * t))
      )
    )
  ),
  // 倾斜的软方块（参考图 1）
  tilt: ptsPath(
    fitPts(
      rotatePts(
        polarPts((t) => {
          const c = Math.abs(Math.cos(t))
          const s = Math.abs(Math.sin(t))
          return (47 / Math.pow(Math.pow(c, 3.4) + Math.pow(s, 3.4), 1 / 3.4)) * (1 + 0.025 * Math.sin(2 * t + 0.6))
        }),
        -12
      )
    )
  ),
  // 斜五边（参考图 2026-11-11 蓝色那枚）：只有 5 次谐波，r = R(1 + 0.098·sin5t)——瓣尖在 18°+72°k，
  // 比「尖朝上」转了半格，一个尖正指右方，看着是歪着的
  pentagon: ptsPath(fitPts(polarPts((t) => 50 + 4.9 * Math.sin(5 * t), 180))),
  leaf: 'M4 48A44 44 0 0 1 48 4L86 4Q96 4 96 14L96 52A44 44 0 0 1 52 96L14 96Q4 96 4 86Z',
  blob: ptsPath(polarPts((t) => 46.5 + 2.6 * Math.sin(3 * t + 0.8) + 1.6 * Math.cos(5 * t + 0.3) + 1.2 * Math.sin(2 * t))),
  // 拨片（参考图 1）：三个角各一个圆、中间一个大圆的平滑并集，边是外凸弧线——直边三角会把肩膀斜着切开
  pick: ptsPath(fitPts(smoothUnionPts([[28, 22, 20], [80, 46, 17], [22, 80, 19], [44, 50, 34]], 7))),
  // 对话气泡：左下角收成小圆角
  bubble: 'M50 2A48 48 0 0 1 98 50A48 48 0 0 1 50 98L14 98Q2 98 2 86L2 50A48 48 0 0 1 50 2Z'
}

/**
 * 头像的形状：spec 里存了就用它；没存的一律圆形。
 * 用户定（2026-11-09 / 11-11）：已有角色与「我」保持圆形，新加的角色才随机，且创建时就存成具体形状、此后固定——
 * 手动新建走 randomizeSpec，名片走 seededShape（见 shared/avatar-shape.ts）。
 * 'auto' 只剩旧数据（老成员显示时按它现算），取法冻结在当时的 12 个形状上（legacyAutoShape），形状库改了也不换。
 */
export function resolveShape(seed: string, spec?: AvatarSpec | null): AvatarShape {
  const s = spec?.shape
  if (s === AUTO_SHAPE) return legacyAutoShape(seed)
  return isAvatarShape(s) ? s : 'circle'
}

/** 形状的单位路径（0..100），供编辑器画形状色块。 */
export function shapePath(shape: AvatarShape): string {
  return SHAPE_PATHS[shape]
}

const maskCache = new Map<string, string>()
/** 形状蒙版图（只有 url(...)）：要自定位置与大小时用，如群组头像整体扫光——几枚头像的形状拼成一个蒙版。 */
export function shapeMaskImage(shape: AvatarShape): string {
  let v = maskCache.get(shape)
  if (!v) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${SHAPE_PATHS[shape]}"/></svg>`
    v = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    maskCache.set(shape, v)
  }
  return v
}

/** 形状蒙版（CSS mask 值）：给头像上的遮层 / 扫光用，与头像同形（形状恒铺满头像框）。 */
export function shapeMask(shape: AvatarShape): string {
  return `${shapeMaskImage(shape)} center / 100% 100% no-repeat`
}

type Box = { x: number; y: number; s: number }
/** 单位路径 → 目标方框坐标（直接换算坐标，不用 transform 属性：CSS transform-origin 会作用到它上面，裁切框随之偏移）。 */
const mapCache = new Map<string, string>()
function mapPath(shape: AvatarShape, b: Box): string {
  const key = `${shape}|${b.x},${b.y},${b.s}`
  const hit = mapCache.get(key)
  if (hit) return hit
  const k = b.s / 100
  const tok = SHAPE_PATHS[shape].match(/[MLQAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const X = (v: number): number => r2(b.x + v * k)
  const Y = (v: number): number => r2(b.y + v * k)
  let out = ''
  let i = 0
  const n = (): number => parseFloat(tok[i++])
  while (i < tok.length) {
    const cmd = tok[i++]
    if (cmd === 'M' || cmd === 'L') out += `${cmd}${X(n())} ${Y(n())}`
    else if (cmd === 'Q') out += `Q${X(n())} ${Y(n())} ${X(n())} ${Y(n())}`
    else if (cmd === 'A') {
      const rx = n()
      const ry = n()
      const rot = n()
      const large = n()
      const sweep = n()
      out += `A${r2(rx * k)} ${r2(ry * k)} ${rot} ${large} ${sweep} ${X(n())} ${Y(n())}`
    } else if (cmd === 'Z') out += 'Z'
  }
  mapCache.set(key, out)
  return out
}

/* ─────────────────────────────── 规格解析 ─────────────────────────────── */

/** 仅保留对象里的字符串值，丢弃其余（防御外来 JSON）。 */
function pickStrings(o: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v
    }
  }
  return out
}

const PART_SLOT = new Map(humation1.parts.map((p) => [p.id, p.selectionSlot]))

/**
 * 剔除部件清单里对不上的 selections 项（部件不存在 / 不属于该槽位 / 槽位不存在），被剔的槽位回落 seed 生成。
 *
 * 为什么必须：引擎遇到这类值会直接 throw，而 spec 来自磁盘——手改角色文件、模型用写文件工具改、
 * 部件包升级后旧 id 下线都会带进坏值。渲染期一抛就整个界面白屏，连编辑器都进不去修（issue #25）。
 * 故凡把外来 selections 交给引擎（HumationFace / resolveSpec）都先过这里；判定口径照搬引擎的 resolveAvatarState。
 */
function validSelections(sel?: Record<string, string>): Record<string, string> | undefined {
  if (!sel) return undefined
  const out: Record<string, string> = {}
  for (const [slot, value] of Object.entries(sel)) {
    try {
      if (PART_SLOT.get(resolvePartId(value, humation1, slot)) === slot) out[slot] = value
    } catch {
      // 未知部件：丢弃
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** 解析存储字符串 → AvatarSpec；空 / 非 JSON / 解析失败一律返回 null（回落 seed 生成）。 */
export function parseAvatarSpec(raw: string | null | undefined): AvatarSpec | null {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s[0] !== '{') return null
  try {
    const obj = JSON.parse(s) as Record<string, unknown>
    const spec: AvatarSpec = {}
    const sel = pickStrings(obj.selections)
    const col = pickStrings(obj.colors)
    if (Object.keys(sel).length) spec.selections = sel
    if (Object.keys(col).length) spec.colors = col
    if (typeof obj.background === 'string' && obj.background) spec.background = obj.background
    // 四叶已删、原位换成云朵：存成四叶的头像读成云朵（下次保存即写回 cloud）
    const shape = obj.shape === 'clover' ? 'cloud' : obj.shape
    if (isAvatarShape(shape) || shape === AUTO_SHAPE) spec.shape = shape
    return spec.selections || spec.colors || spec.background || spec.shape ? spec : null
  } catch {
    return null
  }
}

/** AvatarSpec → 存储字符串；实质为空则返回 ''（不写 avatar 字段，回落 seed 生成）。 */
export function serializeAvatarSpec(spec: AvatarSpec | null | undefined): string {
  if (!spec) return ''
  const out: AvatarSpec = {}
  if (spec.selections && Object.keys(spec.selections).length) out.selections = spec.selections
  if (spec.colors && Object.keys(spec.colors).length) out.colors = spec.colors
  if (spec.background) out.background = spec.background
  if (isAvatarShape(spec.shape) || spec.shape === AUTO_SHAPE) out.shape = spec.shape
  if (!out.selections && !out.colors && !out.background && !out.shape) return ''
  return JSON.stringify(out)
}

/** 把「seed + 部分 spec」解析为完整、具体的 spec（编辑器初始化：从此只处理显式值，杜绝漂移）。 */
export function resolveSpec(seed: string, spec?: AvatarSpec | null): Required<AvatarSpec> {
  // seed 配色垫底、spec 显式值覆盖：与 HumationFace 的合并口径一致，故「编辑器所见＝各处所渲染」。
  const pal = seededPalette(seed)
  const json = createAvatar(humation1, {
    seed,
    selections: validSelections(spec?.selections),
    colors: { ...pal.colors, ...spec?.colors },
    background: spec?.background || pal.background
  }).toJSON()
  return {
    selections: json.selections,
    colors: json.colors,
    background: json.background,
    shape: resolveShape(seed, spec)
  }
}

/**
 * 生成一枚随机头像的完整 spec（随机部件 + 精选随机配色 + 随机形状）。
 * keepShape：保留指定形状不随机（个人资料里「我」的头像——默认圆形，随机时不改形状）。
 */
export function randomizeSpec(keepShape?: string): Required<AvatarSpec> {
  const base = createAvatar(humation1, { seed: Math.random().toString(36).slice(2) }).toJSON()
  return {
    selections: base.selections,
    colors: {
      ...base.colors,
      hair: pick(HAIR_TONES),
      skin: pick(SKIN_TONES),
      clothes: pick(CLOTHES_TONES)
    },
    background: pick(BG_TONES),
    shape: isAvatarShape(keepShape) ? keepShape : pick(SHAPE_POOL)
  }
}

/** 某槽位下的全部部件选项（供编辑器渲染缩略图网格）。 */
export function partsForSlot(slot: string): PartOption[] {
  return getPartsForSlot(humation1, slot)
}

/** 单个部件的孤立缩略图（data URI，供 <img> 用）；colors 可选以让缩略图反映当前配色。 */
export function partPreview(part: PartOption, colors?: Record<string, string>): string {
  return createPartPreview(humation1, part, { colors, background: 'transparent' }).toDataUri()
}

/** 部件显示名（回落 ID）。 */
export function partLabel(part: PartOption): string {
  return part.name || part.id
}

/** 是否「无」部件（item/glasses 的空选项）—— 编辑器渲染为文字块而非空白缩略图。 */
export function isNonePart(part: PartOption): boolean {
  return (part.name || '').toLowerCase() === 'none'
}

/* ─────────────────────────────── 渲染 ─────────────────────────────── */

/**
 * 构图几何（人物坐标系 = 引擎裁切 viewBox -4 -4.5 88 88）：
 *  - 框内（compact）：形状铺满原裁切框，整枚按形状裁；
 *  - 探出：形状框取 {4, 12, 72}，人物比框内大约 22%。下沿必须 ≤ 84——上衣下摆约在 y≈86，再低就露出裤腰；
 *    身体按形状裁，头部与配件只在形状中线以下按形状裁，以上放开（越出上沿；只放开顶部一小条会把头发切出硬边）。
 */
const POP_BOX: Box = { x: 4, y: 12, s: 72 }

type HumationParts = { crop: Box; body: string; head: string }
const partsCache = new Map<string, HumationParts>()
/** 引擎分层内容 → 身体（下装 + 上衣）与头部（头 + 配件 + 眼镜）两段；同一组输入全应用共用一份。 */
function humationParts(seed: string, selections: Record<string, string> | undefined): HumationParts {
  const key = JSON.stringify([seed, selections ?? null])
  const hit = partsCache.get(key)
  if (hit) return hit
  const data = createAvatar(humation1, { seed, selections, background: 'transparent' }).toRenderData()
  let body = ''
  let head = ''
  const re = /<g data-hm-layer-slot="([^"]+)"[\s\S]*?<\/g>(?=<g data-hm-layer-slot|$)/g
  let m: RegExpExecArray | null
  let matched = 0
  while ((m = re.exec(data.content))) {
    matched += m[0].length
    if (m[1] === 'bottom' || m[1] === 'body') body += m[0]
    else head += m[0]
  }
  // 拆分对不上（引擎输出格式变了）：整段当身体，按形状裁，至少不会画错位
  if (matched !== data.content.length) {
    body = data.content
    head = ''
  }
  const parts = {
    crop: { x: data.viewBox.x, y: data.viewBox.y, s: data.viewBox.width },
    body,
    head
  }
  if (partsCache.size > 300) partsCache.clear()
  partsCache.set(key, parts)
  return parts
}

const hex = (v: string): string => (/^[0-9a-fA-F]{6}$/.test(v.trim()) ? `#${v.trim()}` : v.trim())

/** 透明图的主体包围盒（占整图的比例）。 */
type Cutout = { x: number; y: number; w: number; h: number }
const cutCache = new Map<string, Cutout | null>()

/** 四角都透明才算透明图（照片边缘总是不透明的），再取不透明像素的包围盒。 */
function detectCutout(src: string): Promise<Cutout | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = (): void => {
      try {
        const N = 64
        const canvas = document.createElement('canvas')
        canvas.width = N
        canvas.height = N
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        // 与 <image preserveAspectRatio="xMidYMid slice"> 同口径：居中裁方
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        if (!side) return resolve(null)
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, N, N)
        const d = ctx.getImageData(0, 0, N, N).data
        const a = (x: number, y: number): number => d[(y * N + x) * 4 + 3]
        if ([a(0, 0), a(N - 1, 0), a(0, N - 1), a(N - 1, N - 1)].some((v) => v > 16)) return resolve(null)
        let x0 = N
        let y0 = N
        let x1 = -1
        let y1 = -1
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++)
            if (a(x, y) > 40) {
              if (x < x0) x0 = x
              if (x > x1) x1 = x
              if (y < y0) y0 = y
              if (y > y1) y1 = y
            }
        if (x1 < 0) return resolve(null)
        resolve({ x: x0 / N, y: y0 / N, w: (x1 + 1 - x0) / N, h: (y1 + 1 - y0) / N })
      } catch {
        resolve(null)
      }
    }
    img.onerror = (): void => resolve(null)
    img.src = src
  })
}

/** 上传图是否透明图（异步判定、全应用缓存；判定前按普通照片画）。 */
function useCutout(src?: string): Cutout | null {
  const [cut, setCut] = useState<Cutout | null>(() => (src ? (cutCache.get(src) ?? null) : null))
  useEffect(() => {
    if (!src) {
      setCut(null)
      return
    }
    if (cutCache.has(src)) {
      setCut(cutCache.get(src) ?? null)
      return
    }
    let alive = true
    void detectCutout(src).then((r) => {
      if (cutCache.size > 100) cutCache.clear()
      cutCache.set(src, r)
      if (alive) setCut(r)
    })
    return () => {
      alive = false
    }
  }, [src])
  return cut
}

/** 透明图在 0..100 方框里的摆放：探出时主体高约 110、底边压在形状下沿附近；框内时主体收进形状。 */
function cutoutRect(cut: Cutout, pop: boolean): { x: number; y: number; w: number } {
  const w = pop ? Math.min(110 / cut.h, 96 / cut.w) : 80 / Math.max(cut.h, cut.w)
  return { x: 50 - (cut.x + cut.w / 2) * w, y: (pop ? 98 : 92) - (cut.y + cut.h) * w, w }
}

export type FaceProps = {
  seed: string
  spec?: AvatarSpec | null
  /** 自定义头像 data URI；空串 / 省略 → 走 Humation 生成头像。 */
  image?: string
  size?: number | string
  title?: string
  className?: string
  /** 框内构图：整枚按形状裁切、不探出。≤20px 与叠放处用。 */
  compact?: boolean
  /** 生成中：底板从原形状慢慢变成星芒并转动，人物跟着星芒裁；结束后变回原形状（见 useBusyMorph）。 */
  busy?: boolean
  /** 盖一层半透明深色（与底板同形，生成中跟着变）：群组头像超过四人时写 +N 的那一枚用。 */
  veil?: boolean
}

/**
 * 角色头像的**唯一渲染入口**：生成头像与用户上传图都走这里，按同一形状出图。
 *
 * 铺满父容器（size 缺省 '100%'）。父容器**不要再做圆形裁剪**（border-radius + overflow:hidden）——
 * 形状与探出都在 SVG 里处理，外层一裁就会切掉越出上沿的头部。
 *
 * 注：渲染层 CSP 不放行 `file:`，自定义头像只能以 data URI 交付（主进程 personas:get/list 派生）。
 */
export function PersonaFace(props: FaceProps): React.JSX.Element {
  // key 只取喂给引擎的输入：换了头像就重建兜底、重新渲染。
  const key = JSON.stringify([props.seed, props.spec?.selections ?? null, props.image ? props.image.length : 0])
  return (
    <FaceBoundary key={key}>
      <FaceSvg {...props} />
    </FaceBoundary>
  )
}

/** 只有 seed / spec 的生成头像（无上传图），同 PersonaFace。 */
export function HumationFace(props: Omit<FaceProps, 'image'>): React.JSX.Element {
  return <PersonaFace {...props} />
}

/* ───────────────────── 生成中：底板变星芒并转动 ───────────────────── */
// 对比稿 design/avatar-busy-burst.html（单人，人物跟着星芒）与 design/group-busy-burst.html（群组：谁在工作谁变）。
// 每帧底板 = 原形状与「转到当前角度的星芒」按进度混合（沿 MORPH_N 个方向插值半径）。只有星芒那一项在转、原形状不转，
// 所以生成在任何时刻结束都能直接平滑变回原形状，不用先把角度转回去。

const MORPH_N = 120
/** 变成星芒 / 变回原形状的时长（秒）。 */
const MORPH_IN = 1.4
const MORPH_OUT = 1.0
/** 星芒转一圈的秒数。 */
const SPIN_PERIOD = 10

const radiiCache = new Map<AvatarShape, Float32Array>()
let probeCtx: CanvasRenderingContext2D | null | undefined
/** 形状在 MORPH_N 个方向上到中心 (50,50) 的距离（t 从正上方顺时针，同 polarPts），沿射线二分求边界。 */
function shapeRadii(shape: AvatarShape): Float32Array | null {
  const hit = radiiCache.get(shape)
  if (hit) return hit
  if (probeCtx === undefined) probeCtx = document.createElement('canvas').getContext('2d')
  if (!probeCtx) return null
  const path = new Path2D(SHAPE_PATHS[shape])
  const out = new Float32Array(MORPH_N)
  for (let i = 0; i < MORPH_N; i++) {
    const t = (i / MORPH_N) * Math.PI * 2
    const dx = Math.sin(t)
    const dy = -Math.cos(t)
    let lo = 0
    let hi = 80
    for (let j = 0; j < 24; j++) {
      const mid = (lo + hi) / 2
      if (probeCtx.isPointInPath(path, 50 + dx * mid, 50 + dy * mid)) lo = mid
      else hi = mid
    }
    out[i] = lo
  }
  radiiCache.set(shape, out)
  return out
}

const easeInOut = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

/** 全应用共用一个 requestAnimationFrame：只有正在生成或正在变回的头像在里面，都停了就不再跑。 */
type MorphStep = (dt: number) => boolean
const morphs = new Set<MorphStep>()
let morphRaf = 0
let morphLast = 0
function morphTick(ts: number): void {
  const dt = morphLast ? Math.min(0.05, (ts - morphLast) / 1000) : 0
  morphLast = ts
  for (const step of morphs) if (!step(dt)) morphs.delete(step)
  if (morphs.size) morphRaf = requestAnimationFrame(morphTick)
  else {
    morphRaf = 0
    morphLast = 0
  }
}
let reduceMotion: MediaQueryList | null | undefined
function runMorph(step: MorphStep): void {
  morphs.add(step)
  if (!morphRaf) morphRaf = requestAnimationFrame(morphTick)
}

type MorphEls = {
  plate: React.RefObject<SVGPathElement | null>
  ring: React.RefObject<SVGPathElement | null>
  clipS: React.RefObject<SVGPathElement | null>
  clipH: React.RefObject<SVGPathElement | null>
  veil: React.RefObject<SVGPathElement | null>
}

/**
 * 生成中的变形：busy 打开 → MORPH_IN 秒变成星芒并持续转动；关闭 → MORPH_OUT 秒变回原形状后停下。
 * 直接改 DOM 上的路径（底板、分隔环、两个裁切、遮层同一条），不经 React 重渲染；React 只在形状 / 构图变了时改 d，
 * 下一帧就按新的形状接着画。系统「减少动画」：不渐变、不转动，生成中直接显示静止的星芒。
 */
function useBusyMorph(busy: boolean, shape: AvatarShape, box: Box, rest: string, els: MorphEls): void {
  const st = useRef({ busy, p: 0, phi: 0, shape, box, rest })
  st.current.busy = busy
  st.current.shape = shape
  st.current.box = box
  st.current.rest = rest
  const stepRef = useRef<MorphStep | null>(null)

  useEffect(() => {
    if (!busy && st.current.p === 0) return
    if (stepRef.current && morphs.has(stepRef.current)) return
    const paint = (e: number, phi: number): void => {
      const s = st.current
      let d = s.rest
      const rs = e > 0 ? shapeRadii(s.shape) : null
      if (rs) {
        const k = s.box.s / 100
        d = ''
        for (let i = 0; i < MORPH_N; i++) {
          const t = (i / MORPH_N) * Math.PI * 2
          const r = (1 - e) * rs[i] + e * burstR(t - phi)
          d += `${i ? 'L' : 'M'}${r2(s.box.x + (50 + r * Math.sin(t)) * k)} ${r2(s.box.y + (50 - r * Math.cos(t)) * k)}`
        }
        d += 'Z'
      }
      for (const ref of [els.plate, els.ring, els.clipS, els.clipH, els.veil]) ref.current?.setAttribute('d', d)
    }
    const step: MorphStep = (dt) => {
      const s = st.current
      reduceMotion ??= window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
      if (reduceMotion?.matches) {
        s.p = s.busy ? 1 : 0
        s.phi = 0
        paint(s.p, 0)
        return false
      }
      s.p = s.busy ? Math.min(1, s.p + dt / MORPH_IN) : Math.max(0, s.p - dt / MORPH_OUT)
      s.phi = s.p > 0 ? (s.phi + (dt * Math.PI * 2) / SPIN_PERIOD) % (Math.PI * 2) : 0
      paint(easeInOut(s.p), s.phi)
      return s.busy || s.p > 0
    }
    stepRef.current = step
    runMorph(step)
  }, [busy, els])

  // 卸载：退出共用的动画循环
  useEffect(
    () => () => {
      if (stepRef.current) morphs.delete(stepRef.current)
    },
    []
  )
}

function FaceSvg({ seed, spec, image, size, title, className, compact, busy, veil }: FaceProps): React.JSX.Element {
  const rid = useId()
  const id = 'hm' + rid.replace(/[^a-zA-Z0-9_-]/g, '')
  const cut = useCutout(image || undefined)
  const shape = resolveShape(seed, spec)
  const pal = seededPalette(seed)
  const bg = hex(spec?.background || pal.background)
  const plateFill = bg === 'transparent' ? 'none' : bg

  let box: Box
  let pop = false
  let kind: 'gen' | 'img' | 'cut'
  let content: ReactNode
  let style: React.CSSProperties | undefined

  if (image) {
    box = { x: 0, y: 0, s: 100 }
    pop = !!cut && !compact
    kind = cut ? 'cut' : 'img'
    const r = cut ? cutoutRect(cut, pop) : { x: 0, y: 0, w: 100 }
    content = (
      <g clipPath={`url(#${id}${pop ? 'h' : 's'})`}>
        <image
          href={image}
          x={r2(r.x)}
          y={r2(r.y)}
          width={r2(r.w)}
          height={r2(r.w)}
          preserveAspectRatio="xMidYMid slice"
        />
      </g>
    )
  } else {
    const parts = humationParts(seed, validSelections(spec?.selections))
    pop = !compact && !!parts.head
    box = pop ? POP_BOX : parts.crop
    kind = 'gen'
    const colors = { ...pal.colors, ...(spec?.colors ?? {}) }
    style = Object.fromEntries(Object.entries(colors).map(([k, v]) => [`--hm-${k}`, hex(v)])) as React.CSSProperties
    content = (
      <>
        <g clipPath={`url(#${id}s)`} dangerouslySetInnerHTML={{ __html: parts.body }} />
        {parts.head && <g clipPath={`url(#${id}${pop ? 'h' : 's'})`} dangerouslySetInnerHTML={{ __html: parts.head }} />}
      </>
    )
  }

  const d = mapPath(shape, box)
  const plateRef = useRef<SVGPathElement>(null)
  const ringRef = useRef<SVGPathElement>(null)
  const clipSRef = useRef<SVGPathElement>(null)
  const clipHRef = useRef<SVGPathElement>(null)
  const veilRef = useRef<SVGPathElement>(null)
  const els = useMemo<MorphEls>(
    () => ({ plate: plateRef, ring: ringRef, clipS: clipSRef, clipH: clipHRef, veil: veilRef }),
    []
  )
  useBusyMorph(!!busy, shape, box, d, els)
  const cls = `hm-ava hm-ava--${kind}${pop ? ' is-pop' : ''}${className ? ` ${className}` : ''}`
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={cls}
      viewBox={`${box.x} ${box.y} ${box.s} ${box.s}`}
      width={size ?? '100%'}
      height={size ?? '100%'}
      overflow="visible"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      {/* 底板、分隔环、两个裁切、遮层是同一条路径：生成中由 useBusyMorph 一起改（人物跟着星芒裁） */}
      <defs>
        <clipPath id={`${id}s`}>
          <path ref={clipSRef} d={d} />
        </clipPath>
        {pop && (
          <clipPath id={`${id}h`}>
            <path ref={clipHRef} d={d} />
            <rect x={box.x - 60} y={box.y - 80} width={box.s + 120} height={80 + box.s / 2} />
          </clipPath>
        )}
      </defs>
      {/* 叠放时的描边环：由外层 --hm-ring / --hm-ring-w 打开，按屏幕像素计宽（一半压在底板下） */}
      <path
        ref={ringRef}
        d={d}
        fill="none"
        vectorEffect="non-scaling-stroke"
        style={{ stroke: 'var(--hm-ring, none)', strokeWidth: 'var(--hm-ring-w, 0)' }}
      />
      <path ref={plateRef} d={d} fill={plateFill} />
      {content}
      {veil && <path ref={veilRef} d={d} fill="rgba(0, 0, 0, 0.38)" />}
    </svg>
  )
}

const uriCache = new Map<string, string>()

/**
 * 头像的图片地址（data URI，框内构图）：供放不了 React 组件的地方用（如输入框编辑器里的 @ 成员标签）。
 * 与 PersonaFace 同形状、同配色；上传图按形状裁切。生成失败返回空串。
 */
export function avatarDataUri(seed: string, spec?: AvatarSpec | null, image?: string): string {
  const key = JSON.stringify([seed, spec ?? null, image ? image.length + image.slice(-32) : ''])
  const hit = uriCache.get(key)
  if (hit) return hit
  try {
    const shape = resolveShape(seed, spec)
    const pal = seededPalette(seed)
    const bg = hex(spec?.background || pal.background)
    let box: Box
    let inner: string
    let style = ''
    if (image) {
      box = { x: 0, y: 0, s: 100 }
      inner = `<image href="${image}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid slice"/>`
    } else {
      const parts = humationParts(seed, validSelections(spec?.selections))
      box = parts.crop
      inner = parts.body + parts.head
      const colors = { ...pal.colors, ...(spec?.colors ?? {}) }
      style = Object.entries(colors)
        .map(([k, v]) => `--hm-${k}:${hex(v)}`)
        .join(';')
    }
    const d = mapPath(shape, box)
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.s} ${box.s}" style="${style}">` +
      `<defs><clipPath id="c"><path d="${d}"/></clipPath></defs>` +
      `<path d="${d}" fill="${bg === 'transparent' ? 'none' : bg}"/><g clip-path="url(#c)">${inner}</g></svg>`
    const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    if (uriCache.size > 200) uriCache.clear()
    uriCache.set(key, uri)
    return uri
  } catch {
    return ''
  }
}

/**
 * 头像渲染兜底：引擎在渲染期抛错时只让这一枚头像留空，不让异常冒到根上把整个界面卸成白屏。
 * 已知的坏数据由 validSelections 事先剔除，这里防的是引擎升级后新增的校验等意料之外的抛错。
 */
class FaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
