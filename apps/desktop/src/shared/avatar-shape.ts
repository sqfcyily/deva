/**
 * 头像底板形状的名字与按 seed 取样（主进程与渲染层共用；形状路径与渲染只在渲染层 components/humation.tsx）。
 *
 * 规则（用户定 2026-11-09 / 2026-11-11）：已有角色与「我」没存形状 → 圆形；新角色**创建时**挑一个形状并存成具体值，
 * 此后固定不变——形状库以后增删、调序都不影响已建好的角色与成员。
 */

/** 全部形状（编辑器按此顺序列出）。前 8 个对称，后 7 个非对称。 */
export const AVATAR_SHAPES = [
  'circle',
  'squircle',
  'arch',
  'scallop',
  'burst',
  'hexstar',
  'cloud',
  'diamond',
  'pebble',
  'tilt',
  'pentagon',
  'leaf',
  'blob',
  'pick',
  'bubble'
] as const
export type AvatarShape = (typeof AVATAR_SHAPES)[number]

export function isAvatarShape(v: unknown): v is AvatarShape {
  return typeof v === 'string' && (AVATAR_SHAPES as readonly string[]).includes(v)
}

/** FNV-1a 32 位：头像的确定性取样（形状、配色）都用它。 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 新角色随机形状的取样池。菱形上半部收窄、头部会越过两侧斜边，只供手选。 */
export const SHAPE_POOL: readonly AvatarShape[] = AVATAR_SHAPES.filter((s) => s !== 'diamond')

/** 新角色按 seed 挑形状：只在创建时调用一次，结果存成具体形状（名片预览与接受后的编辑器用同一 seed，两处一致）。 */
export function seededShape(seed: string): AvatarShape {
  return SHAPE_POOL[hashSeed(`${seed}#shape`) % SHAPE_POOL.length]
}

/**
 * spec.shape 的旧值：2026-11-09 ~ 11-11 间手机端接受名片建的角色、主智能体建的项目成员没有存具体形状，
 * 存的是它（成员是整个没存，显示时按它算）。启动时角色已改写成具体形状（personas.ts pinAutoAvatarShapes），
 * 老成员仍按它现算——**取法冻结**在当时的 12 个形状上，形状库再怎么改它们也不换形状。
 */
export const AUTO_SHAPE = 'auto'
const LEGACY_AUTO_POOL: readonly AvatarShape[] = [
  'circle',
  'squircle',
  'arch',
  'scallop',
  'burst',
  'cloud',
  'pebble',
  'tilt',
  'leaf',
  'blob',
  'pick',
  'bubble'
]
export function legacyAutoShape(seed: string): AvatarShape {
  return LEGACY_AUTO_POOL[hashSeed(`${seed}#shape`) % LEGACY_AUTO_POOL.length]
}
