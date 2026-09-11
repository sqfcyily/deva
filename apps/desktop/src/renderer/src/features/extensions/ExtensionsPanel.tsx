import { Sparkles, Plug, Bot, Plus, Upload, type LucideIcon } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useExtensions } from '../../store/extensions'
import type { ExtKind, McpStatus } from '../../mock/extensions'

/**
 * 扩展面板：技能 / MCP 服务 / 子智能体。
 * 技能顶部为上传导入（.zip / SKILL.md）；MCP / 子智能体可「+」新建。点击某项 → 中央显示其详情。全局配置。
 */
export function ExtensionsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { skills, mcp, subagents, selected, select, add, importSkill } = useExtensions()

  const isSel = (kind: ExtKind, id: string): boolean =>
    selected?.kind === kind && selected?.id === id

  return (
    <>
      <PanelHeader title={t('extensions.title')} badge={t('common.global')} />
      <div className="sidepanel__body">
        <Section
          icon={Sparkles}
          title={t('extensions.skills')}
          addTitle={t('extensions.uploadSkill')}
          addIcon={Upload}
          onAdd={() => importSkill()}
        >
          {skills.map((s) => (
            <Row
              key={s.id}
              icon={Sparkles}
              name={s.name}
              desc={s.desc}
              enabled={s.enabled}
              badge={s.source === 'builtin' ? t('extensions.builtin') : undefined}
              selected={isSel('skill', s.id)}
              onClick={() => select('skill', s.id)}
            />
          ))}
        </Section>

        <Section
          icon={Plug}
          title={t('extensions.mcp')}
          addTitle={t('extensions.addMcp')}
          onAdd={() => add('mcp')}
        >
          {mcp.map((m) => (
            <Row
              key={m.id}
              icon={Plug}
              name={m.name}
              desc={m.desc}
              enabled={m.enabled}
              status={m.status}
              meta={m.status === 'connected' && m.toolCount > 0 ? String(m.toolCount) : undefined}
              selected={isSel('mcp', m.id)}
              onClick={() => select('mcp', m.id)}
            />
          ))}
        </Section>

        <Section
          icon={Bot}
          title={t('extensions.subagents')}
          addTitle={t('extensions.addSubagent')}
          onAdd={() => add('subagent')}
        >
          {subagents.map((a) => (
            <Row
              key={a.id}
              icon={Bot}
              name={a.name}
              desc={a.desc}
              enabled={a.enabled}
              selected={isSel('subagent', a.id)}
              onClick={() => select('subagent', a.id)}
            />
          ))}
        </Section>
      </div>
    </>
  )
}

function Section({
  title,
  addTitle,
  addIcon: AddIcon = Plus,
  onAdd,
  children
}: {
  icon: LucideIcon
  title: string
  addTitle: string
  /** 顶部动作按钮图标：技能用 Upload（上传导入），MCP / 子智能体用 Plus（新建）。 */
  addIcon?: LucideIcon
  onAdd: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ext-section">
      <div className="ext-section__head">
        <span className="sidepanel__title">{title}</span>
        <button className="icon-btn icon-btn--sm" title={addTitle} onClick={onAdd}>
          <AddIcon size={15} />
        </button>
      </div>
      {children}
    </div>
  )
}

function Row({
  icon: Icon,
  name,
  desc,
  enabled,
  selected,
  onClick,
  status,
  meta,
  badge
}: {
  icon: LucideIcon
  name: string
  desc: string
  enabled: boolean
  selected: boolean
  onClick: () => void
  /** MCP 专用：运行期连接状态（决定圆点着色）。技能 / 子智能体不传，退回启用态着色。 */
  status?: McpStatus
  /** MCP 专用：右侧计数（如已发现工具数）。 */
  meta?: string
  /** 可选徽标（如内置技能的「内置」标签）。 */
  badge?: string
}): React.JSX.Element {
  return (
    <div className={`list-row${selected ? ' is-selected' : ''}`} onClick={onClick}>
      <span
        className="list-row__icon"
        style={{ color: enabled ? 'var(--accent)' : 'var(--fg-subtle)' }}
      >
        <Icon size={14} />
      </span>
      <span className="list-row__label">
        {name}
        {badge && <span className="ext-row-badge">{badge}</span>}
        {desc && <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>{desc}</span>}
      </span>
      <span className="list-row__meta">
        {meta && <span className="ext-count">{meta}</span>}
        {status ? (
          <span className={`ext-dot ext-dot--${status}`} />
        ) : (
          <span
            className="ext-dot"
            style={{ color: enabled ? 'var(--success)' : 'var(--border-strong)' }}
          />
        )}
      </span>
    </div>
  )
}
