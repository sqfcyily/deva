import { useState } from 'react'
import { useI18n } from '../i18n/i18n'
import { MemoryDetail } from './MemoryDetail'
import type { MemoryList } from './memory-editor'
import { useRelativeTime } from './shell-common'

/**
 * 角色资料页的「记忆」标签页（对比稿 design/memory-ui.html 方案 ①）：这个角色的角色记忆，按最近更新排，每行
 * 标题 + 更新时间（直接用「对话」行 .cf-convrow，切换标签页时行高与间距不变）；点一行打开记忆详情弹窗（标题 / 正文，
 * 见 MemoryDetail）。
 * 列表数据由资料页持有（它还要据条数决定是否显示这个标签页）。
 */
export function RoleMemoryList({ personaId, list }: { personaId: string; list: MemoryList }): React.JSX.Element {
  const { t } = useI18n()
  const rel = useRelativeTime()
  const [openId, setOpenId] = useState<string | null>(null)
  const entries = [...(list.mem?.entries ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const open = openId ? (entries.find((e) => e.id === openId) ?? null) : null
  const close = (): void => setOpenId(null)

  return (
    <>
      {entries.map((e) => (
        <button key={e.id} type="button" className="cf-convrow" title={e.title} onClick={() => setOpenId(e.id)}>
          <span className="cf-convrow__title">{e.title}</span>
          <span className="cf-convrow__time">{rel(e.updatedAt)}</span>
        </button>
      ))}
      {open && (
        <div className="cf-modal__backdrop" onClick={close}>
          <div
            className="cf-modal is-editor cf-memmodal"
            role="dialog"
            aria-label={t('cf.profile.memDetail')}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="cf-modal__head">
              <span className="cf-modal__title">{t('cf.profile.memDetail')}</span>
              <button className="cf-modal__close" title={t('cf.cancel')} onClick={close}>
                ✕
              </button>
            </div>
            <MemoryDetail
              key={open.id}
              entry={open}
              scope={{ personaId }}
              onClose={close}
              onChanged={list.apply}
            />
          </div>
        </div>
      )}
    </>
  )
}
