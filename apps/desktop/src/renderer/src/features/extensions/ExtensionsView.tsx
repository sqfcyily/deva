import { Sparkles, Plug, Bot, Trash2, type LucideIcon } from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useExtensions } from '../../store/extensions'
import { Switch } from '../settings/Switch'
import type { Skill, McpServer, SubAgent } from '../../mock/extensions'

/**
 * 扩展中央详情：展示并编辑左侧选中的技能 / MCP 服务 / 子智能体。
 * 内置项可查看与启停；自定义项可编辑与删除。
 */
export function ExtensionsView(): React.JSX.Element {
  const { t } = useI18n()
  const { skills, mcp, subagents, selected } = useExtensions()

  if (!selected) {
    return <div className="provider-detail provider-detail--empty">{t('extensions.detailEmpty')}</div>
  }

  if (selected.kind === 'skill') {
    const item = skills.find((s) => s.id === selected.id)
    return item ? <SkillDetail item={item} /> : <Missing />
  }
  if (selected.kind === 'mcp') {
    const item = mcp.find((s) => s.id === selected.id)
    return item ? <McpDetail item={item} /> : <Missing />
  }
  const item = subagents.find((s) => s.id === selected.id)
  return item ? <SubAgentDetail item={item} /> : <Missing />
}

function Missing(): React.JSX.Element {
  const { t } = useI18n()
  return <div className="provider-detail provider-detail--empty">{t('extensions.detailEmpty')}</div>
}

function DetailHead({
  icon: Icon,
  kind,
  id,
  name,
  source,
  enabled
}: {
  icon: LucideIcon
  kind: 'skill' | 'mcp' | 'subagent'
  id: string
  name: string
  source: 'builtin' | 'custom'
  enabled: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const { toggle, remove } = useExtensions()
  return (
    <header className="provider-detail__head">
      <span className="ext-detail__icon">
        <Icon size={18} />
      </span>
      <h2 className="provider-detail__name">{name}</h2>
      <span className={`tag${source === 'builtin' ? ' tag--official' : ''}`}>
        {source === 'builtin' ? t('extensions.builtin') : t('extensions.custom')}
      </span>
      <div className="provider-detail__spacer" />
      {source === 'custom' && (
        <button className="icon-btn" title={t('extensions.remove')} onClick={() => remove(kind, id)}>
          <Trash2 size={16} />
        </button>
      )}
      <span className="provider-detail__enable">{t('extensions.enable')}</span>
      <Switch checked={enabled} onChange={() => toggle(kind, id)} />
    </header>
  )
}

function NameDescFields({
  kind,
  item
}: {
  kind: 'skill' | 'mcp' | 'subagent'
  item: { id: string; name: string; desc: string }
}): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  return (
    <>
      <div className="field">
        <label className="field__label">{t('extensions.name')}</label>
        <input
          className="input"
          value={item.name}
          onChange={(e) => update(kind, item.id, { name: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.description')}</label>
        <input
          className="input"
          placeholder={t('extensions.descPlaceholder')}
          value={item.desc}
          onChange={(e) => update(kind, item.id, { desc: e.target.value })}
        />
      </div>
    </>
  )
}

function SkillDetail({ item }: { item: Skill }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead icon={Sparkles} kind="skill" id={item.id} name={item.name} source={item.source} enabled={item.enabled} />
      <NameDescFields kind="skill" item={item} />
      <div className="field">
        <label className="field__label">{t('extensions.trigger')}</label>
        <input
          className="input"
          value={item.trigger}
          onChange={(e) => update('skill', item.id, { trigger: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.instructions')}</label>
        <textarea
          className="textarea"
          rows={6}
          value={item.instructions}
          onChange={(e) => update('skill', item.id, { instructions: e.target.value })}
        />
      </div>
    </section>
  )
}

function McpDetail({ item }: { item: McpServer }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead icon={Plug} kind="mcp" id={item.id} name={item.name} source={item.source} enabled={item.enabled} />
      <NameDescFields kind="mcp" item={item} />
      <div className="field">
        <label className="field__label">{t('extensions.transport')}</label>
        <select
          className="select"
          value={item.transport}
          onChange={(e) => update('mcp', item.id, { transport: e.target.value as McpServer['transport'] })}
        >
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">http</option>
        </select>
      </div>
      {item.transport === 'stdio' ? (
        <div className="field">
          <label className="field__label">{t('extensions.command')}</label>
          <input
            className="input"
            value={item.command}
            onChange={(e) => update('mcp', item.id, { command: e.target.value })}
          />
        </div>
      ) : (
        <div className="field">
          <label className="field__label">{t('extensions.url')}</label>
          <input
            className="input"
            value={item.url}
            onChange={(e) => update('mcp', item.id, { url: e.target.value })}
          />
        </div>
      )}
      <div className="field">
        <label className="field__label">{t('extensions.tools')}</label>
        <ToolTags tools={item.tools} />
      </div>
    </section>
  )
}

function SubAgentDetail({ item }: { item: SubAgent }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead icon={Bot} kind="subagent" id={item.id} name={item.name} source={item.source} enabled={item.enabled} />
      <NameDescFields kind="subagent" item={item} />
      <div className="field">
        <label className="field__label">{t('extensions.model')}</label>
        <input
          className="input"
          value={item.model}
          onChange={(e) => update('subagent', item.id, { model: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.tools')}</label>
        <ToolTags tools={item.tools} />
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.systemPrompt')}</label>
        <textarea
          className="textarea"
          rows={6}
          value={item.prompt}
          onChange={(e) => update('subagent', item.id, { prompt: e.target.value })}
        />
      </div>
    </section>
  )
}

function ToolTags({ tools }: { tools: string[] }): React.JSX.Element {
  const { t } = useI18n()
  if (tools.length === 0) return <div className="ext-tools ext-tools--empty">{t('extensions.noTools')}</div>
  return (
    <div className="ext-tools">
      {tools.map((tool) => (
        <span key={tool} className="model-tag">
          {tool}
        </span>
      ))}
    </div>
  )
}
