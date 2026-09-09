import { Sparkles, Plug, Bot, Plus, type LucideIcon } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useExtensions } from '../../store/extensions'
import type { ExtKind } from '../../mock/extensions'

/**
 * 扩展面板：技能 / MCP 服务 / 子智能体。
 * 每组可「+」新建；点击某项 → 中央显示其详情。全局配置，与项目无关。
 */
export function ExtensionsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { skills, mcp, subagents, selected, select, add } = useExtensions()

  const isSel = (kind: ExtKind, id: string): boolean =>
    selected?.kind === kind && selected?.id === id

  return (
    <>
      <PanelHeader title={t('extensions.title')} badge={t('common.global')} />
      <div className="sidepanel__body">
        <Section
          icon={Sparkles}
          title={t('extensions.skills')}
          addTitle={t('extensions.addSkill')}
          onAdd={() => add('skill')}
        >
          {skills.map((s) => (
            <Row
              key={s.id}
              icon={Sparkles}
              name={s.name}
              desc={s.desc}
              enabled={s.enabled}
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
  onAdd,
  children
}: {
  icon: LucideIcon
  title: string
  addTitle: string
  onAdd: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ext-section">
      <div className="ext-section__head">
        <span className="sidepanel__title">{title}</span>
        <button className="icon-btn icon-btn--sm" title={addTitle} onClick={onAdd}>
          <Plus size={15} />
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
  onClick
}: {
  icon: LucideIcon
  name: string
  desc: string
  enabled: boolean
  selected: boolean
  onClick: () => void
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
        {desc && <span style={{ color: 'var(--fg-subtle)', marginLeft: 6 }}>{desc}</span>}
      </span>
      <span
        className="list-row__meta"
        style={{ color: enabled ? 'var(--success)' : 'var(--border-strong)' }}
      >
        <span className="ext-dot" />
      </span>
    </div>
  )
}
