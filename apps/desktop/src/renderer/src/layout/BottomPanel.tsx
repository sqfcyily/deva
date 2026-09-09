import { Terminal as TerminalIcon, AlertCircle, ScrollText, Network, X } from 'lucide-react'
import { useUI, type BottomTab } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import { TerminalView } from '../features/terminal/TerminalView'

const TABS: { id: BottomTab; icon: typeof TerminalIcon; labelKey: string }[] = [
  { id: 'terminal', icon: TerminalIcon, labelKey: 'panel.terminal' },
  { id: 'problems', icon: AlertCircle, labelKey: 'panel.problems' },
  { id: 'output', icon: ScrollText, labelKey: 'panel.output' },
  { id: 'ports', icon: Network, labelKey: 'panel.ports' }
]

/** 底部工具面板：终端 / 问题 / 输出 / 端口。当前仅终端为演示内容。 */
export function BottomPanel(): React.JSX.Element {
  const { bottomTab, setBottomTab, togglePanel } = useUI()
  const { t } = useI18n()

  return (
    <div className="bottompanel">
      <div className="bottompanel__tabs">
        {TABS.map(({ id, icon: Icon, labelKey }) => (
          <button
            key={id}
            className={`tab${bottomTab === id ? ' is-active' : ''}`}
            onClick={() => setBottomTab(id)}
          >
            <Icon size={14} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="Close" onClick={togglePanel}>
          <X size={15} />
        </button>
      </div>
      <div className="bottompanel__body">
        {bottomTab === 'terminal' ? (
          <TerminalView />
        ) : (
          <div className="placeholder" style={{ minHeight: 120 }}>
            <span className="placeholder__hint">{t('common.comingSoon')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
