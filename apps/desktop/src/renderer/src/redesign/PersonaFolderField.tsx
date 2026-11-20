import { useEffect, useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import './persona-folder.css'

/**
 * 角色编辑页的「默认工作区」一栏（对比稿 design/workspace-home.html 场景 ⑤，并入 #49 角色默认工作区）。
 *
 * 默认是角色自己的目录（`~/Deva/Agents/<角色 id>`，没挂载工作区时的落点）；「更换」换成某个项目文件夹后，这个角色的
 * 新对话一开始就挂载它（读项目说明、启用项目私有记忆），「恢复默认」改回来。只在保存时落盘。
 * 一行显示（图标 + 路径 + 按钮），与同表单的输入框等高。
 */
export function PersonaFolderField({
  personaId,
  value,
  onChange
}: {
  /** 编辑已有角色时的 id；新建时缺省（id 保存时才生成，默认工作区随之确定）。 */
  personaId?: string
  /** 换成的工作区；空串 = 用默认工作区。 */
  value: string
  onChange: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [home, setHome] = useState<string | null>(null)
  useEffect(() => {
    if (!personaId) return
    let alive = true
    window.deva.workspace
      .roleHome(personaId)
      .then((r) => alive && setHome(r.path))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [personaId])

  // 选目录走与输入框「挂载工作区」同一入口（系统对话框，选中即登记受信根）。
  const pick = (): void => {
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onChange(r.path)
    })()
  }
  const path = value || home
  return (
    <div className="cf-field">
      <label className="cf-field__label">{t('cf.fWorkspace')}</label>
      <div className={`cf-pfolder${value ? ' is-project' : ''}`}>
        <span className="cf-pfolder__ic">{value ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
        {path ? (
          <span className="cf-pfolder__path" title={path}>
            {path}
          </span>
        ) : (
          <span className="cf-pfolder__path is-muted">{t('cf.wsPending')}</span>
        )}
        {value && (
          <button type="button" className="cf-pfolder__btn" onClick={() => onChange('')}>
            {t('cf.wsReset')}
          </button>
        )}
        <button type="button" className="cf-pfolder__btn" onClick={pick}>
          {t('cf.wsChange')}
        </button>
      </div>
    </div>
  )
}
