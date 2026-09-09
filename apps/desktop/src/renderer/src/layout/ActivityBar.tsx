import { useUI } from '../store/ui'
import { useI18n } from '../i18n/i18n'
import {
  topContributions,
  bottomContributions,
  type FeatureContribution
} from '../features/registry'

/** 左侧活动栏：切换主视图。条目来自功能贡献注册表，底部为 placement:'bottom' 项（如设置）。 */
export function ActivityBar(): React.JSX.Element {
  const { activeView, setActiveView } = useUI()
  const { t } = useI18n()

  const renderItem = ({ id, icon: Icon, titleKey }: FeatureContribution): React.JSX.Element => (
    <button
      key={id}
      className={`activitybar__item${activeView === id ? ' is-active' : ''}`}
      title={t(titleKey)}
      aria-label={t(titleKey)}
      onClick={() => setActiveView(id)}
    >
      <Icon size={20} strokeWidth={1.75} />
    </button>
  )

  return (
    <nav className="activitybar">
      {topContributions.map(renderItem)}
      <div className="activitybar__spacer" />
      {bottomContributions.map(renderItem)}
    </nav>
  )
}
