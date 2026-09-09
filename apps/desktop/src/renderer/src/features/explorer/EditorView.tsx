import { useEffect } from 'react'
import { FileCode, FileWarning, X } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useWorkspace } from '../../store/workspace'

/**
 * 中央编辑器：真实文件内容，多标签，可编辑并写回磁盘。
 * 纯 textarea 实现（等宽 + 行号槽），后续可平滑替换为 Monaco / CodeMirror。
 */
export function EditorView(): React.JSX.Element {
  const { t } = useI18n()
  const {
    tabs,
    activePath,
    setActivePath,
    closeTab,
    contentOf,
    stateOf,
    editContent,
    isDirty,
    saveActive
  } = useWorkspace()

  // Ctrl/Cmd+S 保存当前文件
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void saveActive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveActive])

  if (!activePath || tabs.length === 0) {
    return (
      <div className="placeholder">
        <FileCode size={40} className="placeholder__icon" />
        <div className="placeholder__hint">{t('explorer.selectHint')}</div>
      </div>
    )
  }

  const state = stateOf(activePath)
  const text = contentOf(activePath) ?? ''

  return (
    <div className="contentview">
      <div className="editor__tabs">
        {tabs.map((tab) => {
          const active = tab.path === activePath
          const dirty = isDirty(tab.path)
          return (
            <button
              key={tab.path}
              className={`editor__tab${active ? ' is-active' : ''}`}
              onClick={() => setActivePath(tab.path)}
              title={tab.path}
            >
              <FileCode size={13} />
              {tab.name}
              {dirty ? (
                <span className="editor__dirty" title={t('explorer.unsaved')} />
              ) : null}
              <span
                className="editor__tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.path)
                }}
              >
                <X size={13} />
              </span>
            </button>
          )
        })}
      </div>

      <div className="contentview__body">
        {state === 'ok' ? (
          <textarea
            className="editor__area"
            spellCheck={false}
            value={text}
            onChange={(e) => editContent(activePath, e.target.value)}
          />
        ) : (
          <div className="placeholder">
            <FileWarning size={36} className="placeholder__icon" />
            <div className="placeholder__hint">
              {state === 'binary' ? t('explorer.binary') : t('explorer.tooLarge')}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
