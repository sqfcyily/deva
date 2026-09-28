import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 自定义头像图片落盘（角色 personas/avatars/<id>.<ext>、用户 profile/avatar.<ext> 共用）。
 *
 * 「多次上传覆盖」= 一个 name 至多一张图：写入前先清掉**所有**扩展名变体，再按来图 MIME 落一个。
 * 格式不固定死 webp，是为了容错——渲染层若在某平台 webp 编码失败可回落 png/jpeg，主进程照收，
 * 读回时按扩展名还原 MIME，不会出现「存的是 png 却谎称 webp」的坏 data URI。
 *
 * name 的合法性（防路径穿越）由调用方负责：这里只拼 `${name}.${ext}`。
 */

const AVATAR_EXT_MIME: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg'
}
const AVATAR_MIME_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg'
}
/** 解码后字节上限：渲染层已归一到 256×256（正常 <100KB），此处只兜底异常大图。 */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 该 name 现存的头像图片路径（按扩展名优先序取首个命中）；没有则空串。 */
function avatarImagePath(dir: string, name: string): string {
  for (const ext of Object.keys(AVATAR_EXT_MIME)) {
    const p = join(dir, `${name}.${ext}`)
    if (existsSync(p)) return p
  }
  return ''
}

/** 读成 data URI 交付渲染层（无图 / 读失败 → 空串，回落生成头像）。 */
export function readAvatarImage(dir: string, name: string): string {
  const p = avatarImagePath(dir, name)
  if (!p) return ''
  const ext = p.slice(p.lastIndexOf('.') + 1)
  const mime = AVATAR_EXT_MIME[ext]
  if (!mime) return ''
  try {
    return `data:${mime};base64,${readFileSync(p).toString('base64')}`
  } catch {
    return ''
  }
}

/** 删掉该 name 的所有头像图片变体（清除 / 覆盖前 / 删角色时调用）。 */
export function clearAvatarImage(dir: string, name: string): void {
  for (const ext of Object.keys(AVATAR_EXT_MIME)) {
    try {
      rmSync(join(dir, `${name}.${ext}`), { force: true })
    } catch {
      /* 忽略：文件可能本就不存在 */
    }
  }
}

/** 写入自定义头像（data URI）。成功返回读回的 data URI；参数非法 / 写失败返回空串。 */
export function writeAvatarImage(dir: string, name: string, dataUri: string): string {
  if (typeof dataUri !== 'string') return ''
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(dataUri.trim())
  if (!m) return ''
  const ext = AVATAR_MIME_EXT[m[1].toLowerCase()]
  if (!ext) return ''
  let buf: Buffer
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch {
    return ''
  }
  if (!buf.length || buf.length > AVATAR_MAX_BYTES) return ''
  try {
    mkdirSync(dir, { recursive: true })
    clearAvatarImage(dir, name) // 先清干净，保证一个 name 只剩一张（换格式重传也不留旧图）
    writeFileSync(join(dir, `${name}.${ext}`), buf)
  } catch {
    return ''
  }
  return readAvatarImage(dir, name)
}
