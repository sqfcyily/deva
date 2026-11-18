import { useEffect, useState } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'

/**
 * 挂载卡（模型调用 mount_workspace，对比稿 design/workspace-home.html）：问句 + 一行说明，先列最近用过的文件夹
 * （点一行直接挂载），右下「暂不挂载」与主按钮「选择其他文件夹…」。排版同提问卡。
 *
 * 只画未决态：决定之后这一步的工具节点写明结果（「挂载工作区  web-sign」），卡片不再显示。
 * 列出的文件夹都是用户自己挂过的（主进程按各对话记录取、只列仍存在的），目录不会来自模型。
 * 取消系统对话框 ≠ 暂不挂载：卡片保持未决，循环继续等着。
 */
export function WorkspaceMountCard({
  question,
  onAnswer,
  extra
}: {
  /** 模型给的问句；缺省用通用问法。 */
  question?: string
  /** 回应：路径 = 挂载该文件夹，null = 暂不挂载。缺省 → 只读展示。 */
  onAnswer?: (path: string | null) => void
  /** 操作行左侧的附加项（同其他交互卡）。 */
  extra?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const [recent, setRecent] = useState<{ path: string; name: string }[]>([])
  useEffect(() => {
    let alive = true
    window.deva.workspace
      .recent()
      .then((r) => alive && setRecent(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const pick = (): void => {
    void (async () => {
      const r = await window.deva.fs.openFolder()
      if (r) onAnswer?.(r.path)
    })()
  }
  return (
    <div className="msg__mount">
      <div className="msg__mount-q">{question || t('chat.mount.ask')}</div>
      <div className="msg__mount-sub">{t('chat.mount.sub')}</div>
      {recent.length > 0 && (
        <div className="msg__mount-recent">
          {recent.map((r) => (
            <button
              key={r.path}
              type="button"
              className="ask__option"
              title={r.path}
              disabled={!onAnswer}
              onClick={() => onAnswer?.(r.path)}
            >
              <span className="ask__option-mark">
                <Folder size={15} />
              </span>
              <span className="ask__option-body">
                <span className="ask__option-label">{r.name}</span>
                <span className="ask__option-desc">{r.path}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {onAnswer && (
        <div className="msg__mount-actions">
          {extra}
          <div className="msg__mount-actions-end">
            <button type="button" className="btn btn--sm" onClick={() => onAnswer(null)}>
              {t('chat.mount.skip')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={pick}>
              <FolderOpen size={14} />
              {t('chat.mount.pickOther')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
