import { PersonaFace, parseAvatarSpec } from '../renderer/src/components/humation'
import type { WebPersona, WebSession } from '../shared/remote-web'

/**
 * 头像：与电脑端同一套渲染（Humation 生成头像 + 形状底板 / 上传的图片），同一个角色在手机上和电脑上长得一样。
 * 找不到角色（已删除）时按 id 生成一个稳定的头像。进行中时底板变星芒（同电脑端，只用在对话列表；对话页里不动）。
 */
export function Avatar({
  persona,
  seed,
  size = 48,
  busy,
  dot
}: {
  persona?: WebPersona | null
  /** 没有角色时的生成种子。 */
  seed?: string
  size?: number
  busy?: boolean
  dot?: boolean
}): React.JSX.Element {
  return (
    <span className="ava" style={{ width: size, height: size }} aria-hidden>
      <PersonaFace
        seed={persona?.id ?? seed ?? 'general'}
        spec={parseAvatarSpec(persona?.avatar)}
        image={persona?.avatarImage || undefined}
        busy={busy}
        size={size}
      />
      {dot && <span className="ava__dot" />}
    </span>
  )
}

/** 一位成员的头像（同 SessionFace 里的成员：@ 加入的角色按角色列表取，主角色建的成员以成员会话 id 为种子）。 */
export function MemberFace({
  m,
  personas,
  size
}: {
  m: { id?: string; avatar?: string; personaId?: string }
  personas: Map<string, WebPersona>
  size: number
}): React.JSX.Element {
  const p = m.personaId ? personas.get(m.personaId) : undefined
  return (
    <span className="ava" style={{ width: size, height: size }} aria-hidden>
      <PersonaFace
        seed={p?.id ?? m.id ?? 'member'}
        spec={parseAvatarSpec(p?.avatar ?? m.avatar)}
        image={p?.avatarImage || undefined}
        size={size}
      />
    </span>
  )
}

/** 群组头像排布（照电脑端 GroupFace，以 38px 为基准按比例缩放）。 */
const GROUP: Record<2 | 3 | 4, { s: number; at: [number, number][] }> = {
  2: { s: 28, at: [[-3, 5], [13, 5]] },
  3: { s: 21, at: [[8.5, 0], [0, 17], [17, 17]] },
  4: { s: 20, at: [[0, 0], [18, 0], [0, 18], [18, 18]] }
}

/** 对话的头像：有项目成员 = 主角色 + 成员的群组头像；否则角色头像（定时任务的对话也是任务的角色，同电脑端）。 */
export function SessionFace({
  s,
  personas,
  size = 50,
  dot,
  still
}: {
  s: WebSession
  personas: Map<string, WebPersona>
  size?: number
  dot?: boolean
  /** 进行中也不变星芒（对话页标题栏：进度已有状态行，不再让头像动）。 */
  still?: boolean
}): React.JSX.Element {
  const persona = personas.get(s.personaId ?? 'general')
  const members = s.members ?? []
  const busy = s.busy && !still
  if (!members.length) return <Avatar persona={persona} seed={s.personaId} size={size} busy={busy} dot={dot} />
  const people = [
    { seed: persona?.id ?? s.personaId ?? 'general', spec: parseAvatarSpec(persona?.avatar), image: persona?.avatarImage },
    ...members.map((m) => {
      // @ 加入的角色：按角色列表取（含上传的头像图）。
      const p = m.personaId ? personas.get(m.personaId) : undefined
      return { seed: p?.id ?? m.id, spec: parseAvatarSpec(p?.avatar ?? m.avatar), image: p?.avatarImage || undefined }
    })
  ].slice(0, 4)
  const layout = GROUP[people.length as 2 | 3 | 4]
  const k = size / 38
  return (
    <span className="ava ava--group" style={{ width: size, height: size }} aria-hidden>
      {people.map((p, i) => (
        <span
          key={i}
          className="ava__member"
          style={{ left: layout.at[i][0] * k, top: layout.at[i][1] * k, width: layout.s * k, height: layout.s * k }}
        >
          <PersonaFace seed={p.seed} spec={p.spec} image={p.image || undefined} busy={i === 0 && busy} size={layout.s * k} compact />
        </span>
      ))}
      {dot && <span className="ava__dot" />}
    </span>
  )
}
