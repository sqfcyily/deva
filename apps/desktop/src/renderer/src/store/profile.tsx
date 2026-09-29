import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { parseAvatarSpec, serializeAvatarSpec, type AvatarSpec } from '../components/humation'

/**
 * 本机用户资料（个人资料面板）：目前只有头像。真源在主进程（spec 存 config.json，图片另存
 * ~/.deva/profile/），这里只持渲染用的镜像；启动拉一次，改头像时本地同步更新（左栏与消息气泡即时刷新）。
 */
interface ProfileContextValue {
  /** 头像 spec（未配置时主进程已回默认头像）；null = 尚未读到 / 读失败，回落固定 seed 头像。 */
  avatar: AvatarSpec | null
  /** 自定义头像图片（data URI；空串 = 无）。 */
  avatarImage: string
  /** 落盘新头像；图片仅在相对已存值有变化时写（空串 = 清除）。失败返回 false。 */
  saveAvatar: (spec: AvatarSpec, image: string) => Promise<boolean>
}

const ProfileContext = createContext<ProfileContextValue | null>(null)

export function ProfileProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [avatar, setAvatar] = useState<AvatarSpec | null>(null)
  const [avatarImage, setAvatarImage] = useState('')

  useEffect(() => {
    let alive = true
    void window.deva.profile
      .get()
      .then((p) => {
        if (!alive) return
        setAvatar(parseAvatarSpec(p.avatar))
        setAvatarImage(p.avatarImage)
      })
      .catch(() => {
        /* 读失败：保持默认头像 */
      })
    return () => {
      alive = false
    }
  }, [])

  const saveAvatar = useCallback(
    async (spec: AvatarSpec, image: string): Promise<boolean> => {
      try {
        await window.deva.profile.setAvatar(serializeAvatarSpec(spec))
        setAvatar(spec)
        if (image !== avatarImage) {
          const saved = await window.deva.profile.setAvatarImage(image)
          setAvatarImage(saved)
          // 非空图却读回空串 = 主进程校验 / 写入失败。
          if (image && !saved) return false
        }
        return true
      } catch {
        return false
      }
    },
    [avatarImage]
  )

  const value = useMemo(() => ({ avatar, avatarImage, saveAvatar }), [avatar, avatarImage, saveAvatar])
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext)
  if (!ctx) throw new Error('useProfile must be used within ProfileProvider')
  return ctx
}
