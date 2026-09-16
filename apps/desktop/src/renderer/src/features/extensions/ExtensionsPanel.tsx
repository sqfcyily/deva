import { Plus, Upload, type LucideIcon } from 'lucide-react'
import { PanelHeader } from '../PanelHeader'
import { useI18n } from '../../i18n/i18n'
import { useExtensions } from '../../store/extensions'
import type { ExtKind, McpStatus } from '../../mock/extensions'

/**
 * 扩展面板：Agent 提示词 / 技能 / MCP 服务 / 子智能体。
 * 技能顶部为上传导入（.zip / SKILL.md）；Agent 提示词 / MCP / 子智能体可「+」新建。点击某项 → 中央显示其详情。全局配置。
 *
 * 视觉：Codex 味——分组小标 mono 大写、行收成安静单行（名字 + 可选 mono 小标），
 * 状态只用一个克制字形（● 开 / ○ 关 / ! 错），不再堆彩色圆点与前导图标。
 */
export function ExtensionsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const { skills, mcp, subagents, personas, selected, select, add, importSkill } = useExtensions()

  const isSel = (kind: ExtKind, id: string): boolean =>
    selected?.kind === kind && selected?.id === id

  return (
    <>
      <PanelHeader title={t('extensions.title')} badge={t('common.global')} />
      <div className="sidepanel__body">
        <Section
          title={t('extensions.personas')}
          addTitle={t('extensions.addPersona')}
          onAdd={() => add('persona')}
        >
          {personas.map((p) => (
            <Row
              key={p.id}
              name={p.name}
              enabled={p.enabled}
              selected={isSel('persona', p.id)}
              onClick={() => select('persona', p.id)}
            />
          ))}
        </Section>

        <Section
          title={t('extensions.skills')}
          addTitle={t('extensions.uploadSkill')}
          addIcon={Upload}
          onAdd={() => importSkill()}
        >
          {skills.map((s) => (
            <Row
              key={s.id}
              name={s.name}
              enabled={s.enabled}
              tag={s.source === 'builtin' ? t('extensions.builtin') : undefined}
              selected={isSel('skill', s.id)}
              onClick={() => select('skill', s.id)}
            />
          ))}
        </Section>

        <Section
          title={t('extensions.mcp')}
          addTitle={t('extensions.addMcp')}
          onAdd={() => add('mcp')}
        >
          {mcp.map((m) => (
            <Row
              key={m.id}
              name={m.name}
              enabled={m.enabled}
              status={m.status}
              tag={
                m.status === 'connected' && m.toolCount > 0
                  ? `${m.toolCount} ${t('extensions.tools')}`
                  : undefined
              }
              selected={isSel('mcp', m.id)}
              onClick={() => select('mcp', m.id)}
            />
          ))}
        </Section>

        <Section
          title={t('extensions.subagents')}
          addTitle={t('extensions.addSubagent')}
          onAdd={() => add('subagent')}
        >
          {subagents.map((a) => (
            <Row
              key={a.id}
              name={a.name}
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
  title: string
  addTitle: string
  /** 顶部动作按钮图标：技能用 Upload（上传导入），其余用 Plus（新建）。 */
  addIcon?: LucideIcon
  onAdd: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="ext-section">
      <div className="ext-section__head">
        <span className="ext-section__title">{title}</span>
        <button className="icon-btn icon-btn--sm" title={addTitle} onClick={onAdd}>
          <AddIcon size={14} />
        </button>
      </div>
      {children}
    </div>
  )
}

/** 状态字形：MCP 用运行期连接态，其余退回启用态。 */
function glyphFor(status: McpStatus | undefined, enabled: boolean): { char: string; cls: string } {
  if (status) {
    switch (status) {
      case 'connected':
        return { char: '●', cls: 'ext-glyph--on' }
      case 'connecting':
        return { char: '●', cls: 'ext-glyph--connecting' }
      case 'error':
        return { char: '!', cls: 'ext-glyph--error' }
      default:
        return { char: '○', cls: 'ext-glyph--off' }
    }
  }
  return enabled ? { char: '●', cls: 'ext-glyph--on' } : { char: '○', cls: 'ext-glyph--off' }
}

function Row({
  name,
  enabled,
  selected,
  onClick,
  status,
  tag
}: {
  name: string
  enabled: boolean
  selected: boolean
  onClick: () => void
  /** MCP 专用：运行期连接状态（决定右侧字形着色）。 */
  status?: McpStatus
  /** 可选 mono 小标（内置技能「内置」/ MCP 已发现工具数）。 */
  tag?: string
}): React.JSX.Element {
  const g = glyphFor(status, enabled)
  // 仅非 MCP 且未启用时压暗名字；MCP 的态由字形承载，不压暗。
  const off = !status && !enabled
  return (
    <div
      className={`ext-row${selected ? ' is-selected' : ''}${off ? ' is-off' : ''}`}
      onClick={onClick}
    >
      <div className="ext-row__main">
        <span className="ext-row__name">{name}</span>
        {tag && <span className="ext-row__tag">{tag}</span>}
      </div>
      <span className={`ext-row__glyph ${g.cls}`}>{g.char}</span>
    </div>
  )
}
