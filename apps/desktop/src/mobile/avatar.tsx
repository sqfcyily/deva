import { PersonaFace, parseAvatarSpec } from '../renderer/src/components/humation'
import type { WebPersona } from '../shared/remote-web'

/**
 * 头像：与桌面端同一套渲染（Humation 生成头像 / 上传的图片），同一个角色在手机上和电脑上长得一样。
 * 定时任务的对话没有角色，用闹钟图标；找不到角色（已删除）时按 id 生成一个稳定的头像。
 */
export function Avatar({
  persona,
  seed,
  size = 44,
  busy,
  task
}: {
  persona?: WebPersona | null
  /** 没有角色时的生成种子（如对话的 personaId）。 */
  seed?: string
  size?: number
  busy?: boolean
  task?: boolean
}): React.JSX.Element {
  if (task)
    return (
      <span className="ava ava--task" style={{ width: size, height: size }} aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l2 2M5 3 2 6M19 3l3 3" />
        </svg>
      </span>
    )
  return (
    <span className="ava" style={{ width: size, height: size }} aria-hidden>
      <PersonaFace
        seed={persona?.id ?? seed ?? 'general'}
        spec={parseAvatarSpec(persona?.avatar)}
        image={persona?.avatarImage || undefined}
        busy={busy}
        size={size}
      />
    </span>
  )
}
