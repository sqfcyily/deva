import { createPortal } from 'react-dom'
import { useI18n } from '../i18n/i18n'
import { MemoryTags } from './ProfilePanel'
import { fill, useMemoryEditor } from './memory-editor'

/*
 * 项目私有记忆面板（工作区文件夹菜单 →「项目记忆」打开）：当前工作区下 Deva 记住的、只属于你本人的项目经验。
 * 数据存于 ~/.deva/projects/<key>/memory.json（不入版本库），读写与编辑态见 useMemoryEditor（带上 root），
 * 与模型的 memory_* 工具（scope="project"）同一套校验。复用个人资料面板的标签墙，交互一致：
 * 悬停出编辑 / 删除，双击原地编辑；删除与清空均二次确认。
 * 挂到 body：打开它的菜单按钮在挂载 chip 内部，留在那里会继承 chip 的字号 / 颜色 / 不换行与 :hover 样式。
 */

const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export function ProjectMemoryPanel({ root, onClose }: { root: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const { mem, pending, errorText, handlers, clearAll } = useMemoryEditor({
    root,
    clearTitle: t('cf.projMem.clear'),
    clearConfirm: t('cf.projMem.clearConfirm')
  })

  return createPortal(
    <div className="cf-modal__backdrop" onClick={onClose}>
      <div
        className="cf-modal is-editor"
        role="dialog"
        aria-label={t('cf.projMem.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title" title={root}>
            {fill(t('cf.projMem.titleOf'), { name: basename(root) })}
          </span>
          <button className="cf-modal__close" title={t('cf.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cf-editor">
          <p className="cf-me__hint">{t('cf.projMem.hint')}</p>
          <section className="cf-me__mem" aria-label={t('cf.projMem.title')}>
            {mem && <MemoryTags entries={mem.entries} emptyText={t('cf.projMem.empty')} h={handlers} />}
            {errorText && <div className="cf-me__err">{errorText}</div>}
          </section>
          <div className="cf-editor__actions cf-me__actions">
            <button
              type="button"
              className="cf-btn cf-me__clear"
              disabled={pending || !mem?.entries.length}
              onClick={clearAll}
            >
              {t('cf.projMem.clear')}
            </button>
            <button type="button" className="cf-btn is-primary" onClick={onClose}>
              {t('cf.close')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
