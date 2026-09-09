import { Server, Circle } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useUI } from '../../store/ui'
import { sshHosts } from '../../mock/data'

/**
 * 中央 SSH 会话：连接选中主机后的整屏终端（演示输出）。
 */
export function SshSessionView(): React.JSX.Element {
  const { t } = useI18n()
  const { selectedHost } = useUI()
  const host = sshHosts.find((h) => h.id === selectedHost)

  if (!host) {
    return (
      <div className="placeholder">
        <Server size={40} className="placeholder__icon" />
        <div className="placeholder__hint">{t('ssh.selectHint')}</div>
      </div>
    )
  }

  const prompt = `${host.user}@${host.name}`

  return (
    <div className="contentview">
      <div className="contentview__header">
        <span className="list-row__icon" style={{ color: 'var(--accent)' }}>
          <Server size={14} />
        </span>
        <span className="contentview__path">
          <b>{host.name}</b> · {host.addr}
        </span>
        <span className="contentview__spacer" />
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: host.online ? 'var(--success)' : 'var(--fg-subtle)'
          }}
        >
          <Circle size={8} fill="currentColor" />
          {host.online ? t('ssh.connected') : t('ssh.connect')}
        </span>
      </div>
      <div className="termws" style={{ flex: 1 }}>
        <div className="termws__body">
          <div className="terminal">
            <div className="muted">Last login: Mon Sep 8 09:20:11 2026 from 10.0.0.2</div>
            <div>
              <span className="accent">{prompt}</span>
              <span className="muted">:~$ </span>uptime
            </div>
            <div className="muted"> 09:21:03 up 42 days, 3:14, 1 user, load average: 0.08, 0.12, 0.09</div>
            <div>
              <span className="accent">{prompt}</span>
              <span className="muted">:~$ </span>docker ps --format '{'{.Names}'}'
            </div>
            <div className="muted">web-api</div>
            <div className="muted">nginx-gateway</div>
            <div>
              <span className="accent">{prompt}</span>
              <span className="muted">:~$ </span>
              <span
                style={{
                  background: 'var(--fg)',
                  width: 7,
                  height: 14,
                  display: 'inline-block',
                  verticalAlign: 'middle'
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
