import { ipcMain } from 'electron'
import { join } from 'path'
import { clearAvatarImage, readAvatarImage, writeAvatarImage } from './avatar-image'
import { getConfig, getDevaHome, setConfig } from './config'

/**
 * 本机用户资料（个人资料面板）：目前只有头像。
 * - 生成头像的 spec（AvatarSpec JSON 串，渲染层 humation.tsx 解析）存 `config.json` → `profile.avatar`；
 *   空串 = 未配置，渲染层回落固定 seed 的默认头像。
 * - 上传的图片另存 `<DEVA_HOME>/profile/avatar.<ext>`（base64 不进 config.json，免得每次读写配置都带着它），
 *   读回成 data URI 交付渲染层（CSP 不放行 file:）。
 */

export interface UserProfile {
  avatar: string
  avatarImage: string
}

const IMAGE_NAME = 'avatar'
/** spec JSON 的长度兜底：正常只有几百字节。 */
const AVATAR_SPEC_MAX = 4096

function profileDir(): string {
  return join(getDevaHome(), 'profile')
}

function profileSection(): Record<string, unknown> {
  const p = getConfig().profile
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
}

export function getProfile(): UserProfile {
  const avatar = profileSection().avatar
  return {
    avatar: typeof avatar === 'string' ? avatar : '',
    avatarImage: readAvatarImage(profileDir(), IMAGE_NAME)
  }
}

function setProfileAvatar(spec: string): void {
  const avatar = spec.length > AVATAR_SPEC_MAX ? '' : spec
  setConfig({ profile: { ...profileSection(), avatar } })
}

export function registerProfileIpc(): void {
  ipcMain.handle('profile:get', (): UserProfile => getProfile())
  ipcMain.handle('profile:set-avatar', (_e, spec: string): { ok: true } => {
    setProfileAvatar(String(spec ?? ''))
    return { ok: true }
  })
  // 空串 = 清除图片；否则返回读回的 data URI（校验 / 写入失败为空串）。
  ipcMain.handle('profile:set-avatar-image', (_e, dataUri: string): string => {
    const uri = String(dataUri ?? '')
    if (!uri) {
      clearAvatarImage(profileDir(), IMAGE_NAME)
      return ''
    }
    return writeAvatarImage(profileDir(), IMAGE_NAME, uri)
  })
}
