import { Plus, Server, Circle } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { sshHosts } from '../../mock/data'

/** 远程主机导航。点击主机 → 中央建立/展示 SSH 会话。 */
export function SshPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedHost, selectHost } = useUI()

  return (
    <>
      <PanelHeader
        title={t('ssh.title')}
        badge={t('common.global')}
        actions={
          <button className="icon-btn" title={t('ssh.addHost')}>
            <Plus size={16} />
          </button>
        }
      />
      <div className="sidepanel__body">
        {sshHosts.map((h) => (
          <div
            key={h.id}
            className={`list-row${h.id === selectedHost ? ' is-selected' : ''}`}
            onClick={() => selectHost(h.id)}
          >
            <span className="list-row__icon" style={{ color: 'var(--accent)' }}>
              <Server size={14} />
            </span>
            <span className="list-row__label">
              {h.name}
              <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>
                {h.user}@{h.addr}
              </span>
            </span>
            <span
              className="list-row__meta"
              style={{ color: h.online ? 'var(--success)' : 'var(--fg-subtle)' }}
            >
              <Circle size={8} fill="currentColor" />
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
