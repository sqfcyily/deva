/**
 * Humation 头像统一封装（全应用唯一的头像渲染面）。
 *
 * 背景：对话优先外壳原本用 emoji 作角色/用户头像。改为 Humation —— 一套确定性手绘 SVG 头像引擎
 * （纯 JS/SVG，无 wasm、无网络，契合 CSP）。同一 seed 恒生成同一头像；亦可用 selections/colors 精确定制。
 *
 * 数据模型：角色头像以 `AvatarSpec`（JSON）存进 persona frontmatter 的 `avatar` 字段（主进程/preload/store
 * 全程只当**不透明字符串**搬运，语义仅在此解释）。
 *  - `avatar` 为空 → 由 seed（persona.id）确定性生成，故所有既有角色零迁移即得一枚稳定头像；
 *  - `avatar` 为 JSON → 用显式 selections/colors 覆盖，seed 退化为无关紧要的兜底。
 *
 * 编辑器：打开时把「seed + 已存 spec」经 `resolveSpec` 解析为**具体** selections/colors，此后一律以具体值工作、
 * 保存时也写入具体值 —— 故「所见（编辑器）＝所存＝各处所渲染」，绝无 seed 与存储不一致的漂移。
 */
import { Avatar } from '@humation/react'
import { humation1 } from '@humation/assets-humation-1'
import { createAvatar, createPartPreview, getPartsForSlot } from '@humation/core'
import type { PartOption } from '@humation/core'

export { humation1 }

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

/** 随机配色取样池（发/肤/衣/背景）—— 精选而非全随机，避免生成刺眼组合。 */
const HAIR_TONES = ['1c1c1c', '3b2a1a', '6b4226', 'a55c2b', 'd8b26a', 'b0b0b0', '7c4dff', 'e6567a']
const SKIN_TONES = ['ffe0bd', 'f1c27d', 'e0ac69', 'c68642', '8d5524', 'ffd9c0']
const CLOTHES_TONES = ['ffffff', '2d2d2d', '4f8cff', '46c26a', 'ff8c42', 'ff5d8f', '7c7cf0', 'ffd23f']
const BG_TONES = ['F6F5F4', 'e8f0fe', 'fdeef2', 'eafbf1', 'fff4e0', 'efeaff', 'e6f7fb']

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

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
    return spec.selections || spec.colors || spec.background ? spec : null
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
  if (!out.selections && !out.colors && !out.background) return ''
  return JSON.stringify(out)
}

/** 把「seed + 部分 spec」解析为完整、具体的 spec（编辑器初始化：从此只处理显式值，杜绝漂移）。 */
export function resolveSpec(seed: string, spec?: AvatarSpec | null): Required<AvatarSpec> {
  const json = createAvatar(humation1, {
    seed,
    selections: spec?.selections,
    colors: spec?.colors,
    ...(spec?.background ? { background: spec.background } : {})
  }).toJSON()
  return { selections: json.selections, colors: json.colors, background: json.background }
}

/** 生成一枚随机头像的完整 spec（随机部件 + 精选随机配色）。 */
export function randomizeSpec(): Required<AvatarSpec> {
  const base = createAvatar(humation1, { seed: Math.random().toString(36).slice(2) }).toJSON()
  return {
    selections: base.selections,
    colors: {
      ...base.colors,
      hair: pick(HAIR_TONES),
      skin: pick(SKIN_TONES),
      clothes: pick(CLOTHES_TONES)
    },
    background: pick(BG_TONES)
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

/**
 * 头像人脸本体：一枚 Humation SVG。默认 size='100%' 铺满父容器（父容器负责圆形裁剪与描边环）。
 * seed 恒传（无 spec 时确定性生成）；spec 的 selections/colors 存在即覆盖 seed 选择。
 */
export function HumationFace({
  seed,
  spec,
  size,
  title,
  className
}: {
  seed: string
  spec?: AvatarSpec | null
  size?: number | string
  title?: string
  className?: string
}): React.JSX.Element {
  const selections =
    spec?.selections && Object.keys(spec.selections).length ? spec.selections : undefined
  const colors = spec?.colors && Object.keys(spec.colors).length ? spec.colors : undefined
  return (
    <Avatar
      assets={humation1}
      seed={seed}
      selections={selections}
      colors={colors}
      background={spec?.background}
      size={size ?? '100%'}
      title={title}
      className={className}
    />
  )
}
