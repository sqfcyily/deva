import { useEffect, useState } from 'react'
import { Folder, FolderPlus, Plus } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import './mount-menu.css'

/**
 * 输入框工具条上未挂载时的「挂载工作区」入口（对比稿 design/workspace-home.html 方案 B）：按钮文字不变，点开是一张
 * 小菜单——最近用过的文件夹（点一下就挂载）、「选择文件夹…」（系统对话框），底部一行说明没挂载时文件放在角色的
 * 默认文件夹，可以直接打开。默认文件夹本身不出现在工具条上。
 */
export function MountMenu({
  personaId,
  personaName,
  onMount
}: {
  /** 本对话的角色：底部那行打开的是它的默认文件夹。 */
  personaId: string
  personaName: string
  onMount: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<{ path: string; name: string }[]>([])

  // 每次打开都重取：期间可能挂过新的文件夹，或列过的文件夹被删了。
  useEffect(() => {
    if (!open) return
    let alive = true
    window.deva.workspace
      .recent()
      .then((r) => alive && setRecent(r))
      .catch(() => {})
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      alive = false
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // 取消系统对话框 = 什么都不做（保持未挂载）。
  const pick = (): void => {
    setOpen(false)
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onMount(r.path)
    })()
  }
  const openHome = (): void => {
    setOpen(false)
    void window.deva.workspace
      .openRoleHome(personaId)
      .catch(() => ({ ok: false }))
      .then((r) => {
        if (!r.ok) toast.show({ variant: 'error', message: t('cf.ws.revealFailed') })
      })
  }

  return (
    <div className="cf-mount">
      <button
        type="button"
        className={`cf-wschip${open ? ' is-open' : ''}`}
        title={t('cf.mountHint')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <FolderPlus size={15} />
        {t('cf.mountWorkspace')}
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="cf-mount__pop" role="menu">
            {recent.length > 0 && (
              <>
                <div className="cf-mount__head">{t('cf.mountRecent')}</div>
                {recent.map((r) => (
                  <button
                    key={r.path}
                    type="button"
                    role="menuitem"
                    className="cf-mount__item"
                    title={r.path}
                    onClick={() => {
                      setOpen(false)
                      onMount(r.path)
                    }}
                  >
                    <Folder size={14} />
                    <span className="cf-mount__name">{r.name}</span>
                    <span className="cf-mount__path">{r.path}</span>
                  </button>
                ))}
              </>
            )}
            <button type="button" role="menuitem" className="cf-mount__item" onClick={pick}>
              <Plus size={14} />
              <span className="cf-mount__name">{t('cf.mountPick')}</span>
            </button>
            <div className="cf-mount__sep" />
            <div className="cf-mount__foot">
              <span>{t('cf.mountHomeNote').replace('{name}', personaName)}</span>
              <button type="button" className="cf-mount__link" onClick={openHome}>
                {t('cf.mountHomeOpen')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
