import { useState } from 'react'
import {
  Sparkles,
  Plug,
  Bot,
  Trash2,
  Lock,
  Unlock,
  X,
  Plus,
  type LucideIcon
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useExtensions } from '../../store/extensions'
import { useModels } from '../../store/models'
import { Switch } from '../settings/Switch'
import { Markdown } from '../chat/Markdown'
import type { Skill, McpServer, McpKV, McpStatus, SubAgent } from '../../mock/extensions'

/** 子智能体可选的内置工具（与主进程 buildSubagentTools 的内置集合一致，排除 ask_user/skill/run_subagent）。 */
const BUILTIN_AGENT_TOOLS = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'web_fetch',
  'write_file',
  'edit_file',
  'run_command'
]

/**
 * 扩展中央详情：展示并编辑左侧选中的技能 / MCP 服务 / 子智能体。
 * 技能 / MCP 落盘生效；子智能体暂内存态。全局配置，与项目无关。
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
  enabled,
  source = 'custom'
}: {
  icon: LucideIcon
  kind: 'skill' | 'mcp' | 'subagent'
  id: string
  name: string
  enabled: boolean
  /** 内置项（source='builtin'）隐藏删除与启停，改渲染「内置」徽标。 */
  source?: 'builtin' | 'custom'
}): React.JSX.Element {
  const { t } = useI18n()
  const { toggle, remove } = useExtensions()
  const builtin = source === 'builtin'
  return (
    <header className="provider-detail__head">
      <span className="ext-detail__icon">
        <Icon size={18} />
      </span>
      <h2 className="provider-detail__name">{name}</h2>
      <span className="scope-badge">{t('common.global')}</span>
      {builtin && <span className="scope-badge">{t('extensions.builtin')}</span>}
      <div className="provider-detail__spacer" />
      {!builtin && (
        <>
          <button
            className="icon-btn"
            title={t('extensions.remove')}
            onClick={() => remove(kind, id)}
          >
            <Trash2 size={16} />
          </button>
          <span className="provider-detail__enable">{t('extensions.enable')}</span>
          <Switch checked={enabled} onChange={() => toggle(kind, id)} />
        </>
      )}
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

/**
 * 技能详情：**只读**，按 SKILL.md 规范结构化展示（不再手写表单）。
 * 创建仅经上传（.zip / SKILL.md）或对话（内置 create-skill → create_skill 工具）；正文用聊天同款 Markdown 渲染。
 */
function SkillDetail({ item }: { item: Skill }): React.JSX.Element {
  const { t } = useI18n()
  const builtin = item.source === 'builtin'
  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead
        icon={Sparkles}
        kind="skill"
        id={item.id}
        name={item.name}
        enabled={item.enabled}
        source={item.source}
      />
      {builtin && <p className="field__note">{t('extensions.createSkillHint')}</p>}
      <div className="field">
        <label className="field__label">{t('extensions.description')}</label>
        <p className="ext-detail__text">
          {item.desc || <span className="ext-detail__muted">{t('extensions.descEmpty')}</span>}
        </p>
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.trigger')}</label>
        <p className="ext-detail__text">
          {item.trigger || <span className="ext-detail__muted">{t('extensions.triggerEmpty')}</span>}
        </p>
        <p className="field__note">
          {t('extensions.triggerHint')} <code className="field__kbd">/{item.name}</code>
        </p>
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.allowedTools')}</label>
        <ToolTags tools={item.allowedTools} />
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.instructions')}</label>
        {item.instructions.trim() ? (
          <div className="ext-detail__md">
            <Markdown text={item.instructions} />
          </div>
        ) : (
          <p className="ext-detail__muted">{t('extensions.instructionsEmpty')}</p>
        )}
      </div>
    </section>
  )
}

// ── MCP 详情 ────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<McpStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  error: 'var(--danger)',
  disconnected: 'var(--border-strong)'
}

function McpDetail({ item }: { item: McpServer }): React.JSX.Element {
  const { t } = useI18n()
  const { update, mcpConnect, mcpDisconnect, mcpTest, mcpSetSecret } = useExtensions()
  const [secretWarn, setSecretWarn] = useState(false)
  const isStdio = item.transport === 'stdio'

  // 写入密钥字段：加密不可用时亮出降级提示。
  const setSecret = (field: string, value: string): void => {
    void mcpSetSecret(item.id, field, value).then((r) => {
      if (value && !r.available) setSecretWarn(true)
    })
  }

  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead icon={Plug} kind="mcp" id={item.id} name={item.name} enabled={item.enabled} />

      <div className="mcp-status">
        <span className="ext-dot" style={{ color: STATUS_TONE[item.status] }} />
        <span className="mcp-status__label">{t(`extensions.status.${item.status}`)}</span>
        {item.status === 'connected' && item.toolCount > 0 && (
          <span className="mcp-status__count">
            {item.toolCount} {t('extensions.tools')}
          </span>
        )}
        <div className="provider-detail__spacer" />
        <button className="btn btn--sm" onClick={() => mcpTest(item.id)}>
          {t('extensions.test')}
        </button>
        {item.status === 'connected' ? (
          <button className="btn btn--sm" onClick={() => mcpDisconnect(item.id)}>
            {t('extensions.disconnect')}
          </button>
        ) : (
          <button className="btn btn--sm" onClick={() => mcpConnect(item.id)}>
            {t('extensions.connect')}
          </button>
        )}
      </div>
      {item.status === 'error' && item.lastError && (
        <div className="mcp-error">{item.lastError}</div>
      )}

      <NameDescFields kind="mcp" item={item} />

      <div className="field">
        <label className="field__label">{t('extensions.transport')}</label>
        <select
          className="select"
          value={item.transport}
          onChange={(e) =>
            update('mcp', item.id, { transport: e.target.value as McpServer['transport'] })
          }
        >
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">http (streamable)</option>
        </select>
      </div>

      {isStdio ? (
        <>
          <div className="field">
            <label className="field__label">{t('extensions.command')}</label>
            <input
              className="input"
              placeholder={t('extensions.commandPlaceholder')}
              value={item.command}
              onChange={(e) => update('mcp', item.id, { command: e.target.value })}
            />
          </div>
          <ArgsField item={item} />
          <div className="field">
            <label className="field__label">{t('extensions.env')}</label>
            <KvEditor
              rows={item.env}
              onChange={(rows) => update('mcp', item.id, { env: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label className="field__label">{t('extensions.url')}</label>
            <input
              className="input"
              placeholder={t('extensions.urlPlaceholder')}
              value={item.url}
              onChange={(e) => update('mcp', item.id, { url: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('extensions.headers')}</label>
            <KvEditor
              rows={item.headers}
              onChange={(rows) => update('mcp', item.id, { headers: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      )}

      {secretWarn && <p className="field__note field__note--warn">{t('extensions.secretUnavailable')}</p>}

      <div className="field">
        <label className="field__label">{t('extensions.discoveredTools')}</label>
        {item.tools.length === 0 ? (
          <div className="ext-tools--empty">{t('extensions.noToolsYet')}</div>
        ) : (
          <ul className="mcp-tools">
            {item.tools.map((tool) => (
              <li key={tool.name} className="mcp-tools__item">
                <code className="mcp-tools__name">{tool.name}</code>
                {tool.description && (
                  <span className="mcp-tools__desc">{tool.description}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 命令参数编辑：一行一个（本地字符串态，随服务切换 remount 自动重置）。 */
function ArgsField({ item }: { item: McpServer }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  const [text, setText] = useState(item.args.join('\n'))
  return (
    <div className="field">
      <label className="field__label">{t('extensions.args')}</label>
      <textarea
        className="textarea"
        rows={3}
        placeholder={t('extensions.argsPlaceholder')}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          update('mcp', item.id, {
            args: e.target.value
              .split('\n')
              .map((a) => a.trim())
              .filter(Boolean)
          })
        }}
      />
    </div>
  )
}

/** 键值对编辑（env / headers）：明文即时落盘；密钥经 onSetSecret 加密（写后不回显）。 */
function KvEditor({
  rows,
  onChange,
  onSetSecret
}: {
  rows: McpKV[]
  onChange: (rows: McpKV[]) => void
  onSetSecret: (field: string, value: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Record<number, string>>({})

  const setRow = (i: number, patch: Partial<McpKV>): void =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void => onChange([...rows, { key: '', value: '', secret: false }])
  const removeRow = (i: number): void => onChange(rows.filter((_, idx) => idx !== i))

  const toggleSecret = (i: number): void => {
    const r = rows[i]
    const key = r.key.trim()
    if (r.secret && key) onSetSecret(key, '') // 转明文：清除已加密的旧值
    setRow(i, { secret: !r.secret, value: '' })
    setDrafts((d) => {
      const n = { ...d }
      delete n[i]
      return n
    })
  }

  const commitSecret = (i: number): void => {
    const r = rows[i]
    const key = r.key.trim()
    const v = drafts[i]
    if (key && v) {
      onSetSecret(key, v)
      setDrafts((d) => {
        const n = { ...d }
        delete n[i]
        return n
      })
    }
  }

  return (
    <div className="kv-editor">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input
            className="input kv-row__key"
            placeholder={t('extensions.kvKey')}
            value={r.key}
            onChange={(e) => setRow(i, { key: e.target.value })}
          />
          {r.secret ? (
            <input
              className="input kv-row__val"
              type="password"
              placeholder={t('extensions.secretPlaceholder')}
              value={drafts[i] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
              onBlur={() => commitSecret(i)}
            />
          ) : (
            <input
              className="input kv-row__val"
              placeholder={t('extensions.kvValue')}
              value={r.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
            />
          )}
          <button
            className={`icon-btn icon-btn--sm kv-row__lock${r.secret ? ' is-on' : ''}`}
            title={r.secret ? t('extensions.unmarkSecret') : t('extensions.markSecret')}
            onClick={() => toggleSecret(i)}
          >
            {r.secret ? <Lock size={13} /> : <Unlock size={13} />}
          </button>
          <button
            className="icon-btn icon-btn--sm"
            title={t('extensions.removeRow')}
            onClick={() => removeRow(i)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button className="btn btn--ghost btn--sm kv-add" onClick={addRow}>
        <Plus size={13} /> {t('extensions.addRow')}
      </button>
    </div>
  )
}

function SubAgentDetail({ item }: { item: SubAgent }): React.JSX.Element {
  const { t } = useI18n()
  const { update, mcp } = useExtensions()
  const { providers } = useModels()

  // 模型下拉：默认「跟随主对话」（空串）+ 各已启用服务商的已启用模型（值 = "pid:mid"）。
  const modelOptions = providers
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => m.enabled)
        .map((m) => ({ value: `${p.id}:${m.id}`, label: `${p.name} / ${m.name}` }))
    )
  // 已保存的模型引用当前不可用（服务商/模型被停用或删除）→ 仍单列出来，避免静默丢失选择。
  const modelKnown = !item.model || modelOptions.some((o) => o.value === item.model)

  // 工具多选：内置 + 已连接 MCP 工具。MCP 值用**命名空间化 fqName**（运行期工具表据此匹配）。
  const mcpTools = mcp.flatMap((s) =>
    s.tools.map((tool) => ({ value: tool.fqName, label: `${s.name} / ${tool.name}` }))
  )
  const selected = new Set(item.tools)
  const known = new Set<string>([...BUILTIN_AGENT_TOOLS, ...mcpTools.map((x) => x.value)])
  // 已选但当前不在可选清单（如服务已断开 / 手改配置）→ 单列出来，仍可见可删。
  const extraSelected = item.tools.filter((x) => !known.has(x))

  const toggleTool = (name: string): void => {
    const next = selected.has(name)
      ? item.tools.filter((x) => x !== name)
      : [...item.tools, name]
    update('subagent', item.id, { tools: next })
  }

  return (
    <section className="provider-detail" key={item.id}>
      <DetailHead icon={Bot} kind="subagent" id={item.id} name={item.name} enabled={item.enabled} />
      <NameDescFields kind="subagent" item={item} />
      <div className="field">
        <label className="field__label">{t('extensions.model')}</label>
        <select
          className="select"
          value={item.model}
          onChange={(e) => update('subagent', item.id, { model: e.target.value })}
        >
          <option value="">{t('extensions.followParent')}</option>
          {!modelKnown && (
            <option value={item.model}>
              {item.model} · {t('extensions.modelUnavailable')}
            </option>
          )}
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label">{t('extensions.tools')}</label>
        <p className="field__note">{t('extensions.toolsHint')}</p>
        <ToolPickGroup
          title={t('extensions.builtinTools')}
          tools={BUILTIN_AGENT_TOOLS.map((name) => ({ value: name, label: name }))}
          selected={selected}
          onToggle={toggleTool}
        />
        {mcpTools.length > 0 && (
          <ToolPickGroup
            title={t('extensions.mcpTools')}
            tools={mcpTools}
            selected={selected}
            onToggle={toggleTool}
          />
        )}
        {extraSelected.length > 0 && (
          <ToolPickGroup
            title={t('extensions.otherTools')}
            tools={extraSelected.map((name) => ({ value: name, label: name }))}
            selected={selected}
            onToggle={toggleTool}
          />
        )}
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

/** 一组可切换的工具「筹码」（多选）：点击即加入/移出白名单，title 显示完整（命名空间化）名。 */
function ToolPickGroup({
  title,
  tools,
  selected,
  onToggle
}: {
  title: string
  tools: { value: string; label: string }[]
  selected: Set<string>
  onToggle: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="tool-pick">
      <span className="tool-pick__title">{title}</span>
      <div className="tool-pick__chips">
        {tools.map((tool) => {
          const on = selected.has(tool.value)
          return (
            <button
              key={tool.value}
              type="button"
              className={`tool-chip${on ? ' is-on' : ''}`}
              title={tool.value}
              onClick={() => onToggle(tool.value)}
            >
              {tool.label}
            </button>
          )
        })}
      </div>
    </div>
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
