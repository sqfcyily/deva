import { Plus, MessageSquare, Trash2 } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useChat } from '../../store/chat'

/** 相对时间（本地化，词与数字以空格拼接，不用插值）。 */
function useRelativeTime(): (ts: number) => string {
  const { t } = useI18n()
  return (ts: number): string => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return t('chat.time.now')
    if (min < 60) return `${min} ${t('chat.time.min')}`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} ${t('chat.time.hr')}`
    const day = Math.floor(hr / 24)
    if (day === 1) return t('chat.time.yesterday')
    return `${day} ${t('chat.time.day')}`
  }
}

/** 对话历史会话列表（按项目，真实持久化数据）。 */
export function ChatSessionsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { sessions, currentSessionId, selectSession, newSession, deleteSession, streaming } =
    useChat()
  const rel = useRelativeTime()

  return (
    <>
      <PanelHeader
        title={t('activity.chat')}
        actions={
          <button
            className="icon-btn"
            title={t('chat.newChat')}
            onClick={newSession}
            disabled={streaming}
          >
            <Plus size={16} />
          </button>
        }
      />
      <div className="sidepanel__body">
        {sessions.length === 0 ? (
          <div className="sidepanel__empty">{t('chat.noSessions')}</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`list-row${s.id === currentSessionId ? ' is-selected' : ''}`}
              onClick={() => selectSession(s.id)}
              role="button"
              tabIndex={0}
            >
              <span className="list-row__icon">
                <MessageSquare size={14} />
              </span>
              <span className="list-row__label">{s.title || t('chat.untitled')}</span>
              <span className="list-row__meta">{rel(s.updatedAt)}</span>
              <button
                className="list-row__action"
                title={t('chat.delete')}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSession(s.id)
                }}
                disabled={streaming}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}
