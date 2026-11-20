import { FolderOpen } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'

/**
 * 挂载卡（模型调用 mount_workspace，对比稿 design/workspace-home.html）：问句 + 一行说明，右下「暂不挂载」与主按钮
 * 「选择文件夹…」（系统目录对话框，同输入框的「挂载工作区」）。排版同提问卡。
 *
 * 只画未决态：决定之后这一步的工具节点写明结果（「挂载工作区  web-sign」），卡片不再显示。
 * 目录只能由用户在系统对话框里选，不会来自模型。取消对话框 ≠ 暂不挂载：卡片保持未决，循环继续等着。
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
      {onAnswer && (
        <div className="msg__mount-actions">
          {extra}
          <div className="msg__mount-actions-end">
            <button type="button" className="btn btn--sm" onClick={() => onAnswer(null)}>
              {t('chat.mount.skip')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={pick}>
              <FolderOpen size={14} />
              {t('chat.mount.pick')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
