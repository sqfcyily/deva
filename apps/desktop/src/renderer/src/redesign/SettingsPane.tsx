/**
 * 设置页：通用、扩展（技能 / MCP / 角色授权）、关于。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Cog,
  Info,
  Lock,
  Plug,
  Plus,
  Puzzle,
  ShieldCheck,
  Trash2,
  Unlock,
  Users,
  X
} from 'lucide-react'
import { UpdateSection } from './UpdateSection'
import devaIcon from '../../../../build/icon.svg'
import type { McpKV, McpServer, McpStatus, Persona, Skill } from '../mock/extensions'
import { Markdown } from '../features/chat/Markdown'
import { useExtensions } from '../store/extensions'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import { Select } from '../components/Select'
import { PersonaFace, parseAvatarSpec } from '../components/humation'
import { useTheme } from '../theme/ThemeContext'
import { readChatFontSize, saveChatFontSize, type ChatFontSize } from '../theme/chatFontSize'
import { ModelSettings } from '../features/settings/ModelSettings'
import { clipName, IS_MAC, AvatarStack, Segmented, Toggle } from './shell-common'

/* ============================ 系统设置（Part H） ============================ */
type SettingsSection = 'general' | 'models' | 'extensions' | 'about'

/** 打开设置时的落点：哪一页，以及（扩展页）直接打开哪一项的详情。 */
export type SettingsInit = { section?: SettingsSection; ext?: { kind: 'skill' | 'mcp'; id: string } }

export function Settings({ initial, onClose }: { initial?: SettingsInit; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>(initial?.section ?? 'general')
  // 直达的扩展详情只在首次进入扩展页时生效；切到别的页再回来是普通的扩展列表。
  const [extTarget, setExtTarget] = useState(initial?.ext ?? null)
  const nav: Array<{ id: SettingsSection; icon: React.ReactNode; label: string }> = [
    { id: 'general', icon: <Cog size={15} />, label: t('settings.general') },
    { id: 'models', icon: <Brain size={15} />, label: t('settings.models') },
    { id: 'extensions', icon: <Puzzle size={15} />, label: t('activity.extensions') },
    { id: 'about', icon: <Info size={15} />, label: t('settings.about') }
  ]
  return (
    // 遮罩层不响应点击：设置弹框只能通过右上角关闭按钮手动关闭，避免误触丢失上下文
    <div className="cf-modal__backdrop">
      <div className="cf-modal" role="dialog" aria-label={t('cf.settings')}>
        <div className="cf-modal__head">
          <span className="cf-modal__title">{t('cf.settings')}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cf-modal__body">
          <nav className="cf-nav">
            {nav.map((n) => (
              <button
                key={n.id}
                className={`cf-nav__item${section === n.id ? ' is-active' : ''}`}
                onClick={() => {
                  setSection(n.id)
                  setExtTarget(null)
                }}
              >
                <span className="cf-nav__icon">{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
          <div className="cf-pane">
            {section === 'general' && <GeneralPane />}
            {section === 'models' && <ModelSettings />}
            {section === 'extensions' && <ExtensionsPane initialOpen={extTarget} />}
            {section === 'about' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  )
}

function GeneralPane(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n()
  const { mode, setMode } = useTheme()
  // 关窗驻留托盘：仅 Windows 呈现（macOS/Linux 关窗语义不同，主进程亦仅 win32 默认驻留）。
  const isWin = window.deva?.platform === 'win32'
  const [closeToTray, setCloseToTray] = useState<boolean>(() => {
    const v = window.deva?.config?.getSync?.().closeToTray
    return typeof v === 'boolean' ? v : true // win32 默认驻留（与主进程 close 判定一致）
  })
  const toggleTray = (): void => {
    const next = !closeToTray
    setCloseToTray(next)
    void window.deva?.config?.set?.({ closeToTray: next })
  }
  // 文字大小：点选即生效（写 <html data-chat-fs>）并落盘，见 theme/chatFontSize.ts
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(readChatFontSize)
  const pickChatFontSize = (v: string): void => {
    const next = v as ChatFontSize
    setChatFontSize(next)
    saveChatFontSize(next)
  }
  return (
    <>
      <h2 className="cf-pane__title">{t('settings.general')}</h2>
      <div className="cf-set">
        <div className="cf-set__row">
          <div className="cf-set__label">{t('settings.language')}</div>
          <Segmented
            value={locale}
            onChange={(v) => setLocale(v as 'zh-CN' | 'en')}
            options={[
              { v: 'zh-CN', label: '简体中文' },
              { v: 'en', label: 'English' }
            ]}
          />
        </div>
        <div className="cf-set__row">
          <div className="cf-set__label">
            {t('settings.theme')}
          </div>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'light' | 'dark' | 'system')}
            options={[
              { v: 'system', label: t('settings.themeSystem') },
              { v: 'light', label: t('settings.themeLight') },
              { v: 'dark', label: t('settings.themeDark') }
            ]}
          />
        </div>
        <div className="cf-set__row">
          <div className="cf-set__label">{t('settings.chatFontSize')}</div>
          <Segmented
            value={chatFontSize}
            onChange={pickChatFontSize}
            options={[
              { v: 'sm', label: t('settings.chatFontSm') },
              { v: 'md', label: t('settings.chatFontMd') },
              { v: 'lg', label: t('settings.chatFontLg') },
              { v: 'xl', label: t('settings.chatFontXl') }
            ]}
          />
        </div>
        {isWin && (
          <div className="cf-set__row">
            <div className="cf-set__label">
              {t('settings.closeToTray')}
            </div>
            <Toggle on={closeToTray} onChange={toggleTray} />
          </div>
        )}
      </div>
    </>
  )
}

function ExtensionsPane({
  initialOpen
}: {
  initialOpen?: { kind: 'skill' | 'mcp'; id: string } | null
}): React.JSX.Element {
  const { t } = useI18n()
  // 角色（persona）不在此列出：它有专属的「角色」tab 与资料卡来管理，扩展页只管技能 / MCP。
  // 子智能体亦不在此列：它是内置能力（通用 / Explore / Research / Plan），不可配置，见 main/services/subagents.ts。
  const { skills, mcp, toggle, refresh } = useExtensions()
  // 进入扩展页即从磁盘重拉最新：技能平时由主进程目录监听实时推送，这里兜底监听失效（如技能目录在网络盘）
  // 并顺带刷新 MCP。refresh 标识稳定，不会形成刷新循环。
  useEffect(() => {
    refresh()
  }, [refresh])

  // 钻取导航：点开某行 → 进入详情（对齐模型设置页的主从抽屉）。MCP 详情可编辑；技能详情只读，
  // 只提供删除与启停；内置技能不展示详情。新增经对话工具 / 上传 / 直接改盘，扩展页不放新增入口。
  const [open, setOpen] = useState<{ kind: 'skill' | 'mcp'; id: string } | null>(initialOpen ?? null)
  const openMcp = open?.kind === 'mcp' ? mcp.find((m) => m.id === open.id) : undefined
  const openSkill = open?.kind === 'skill' ? skills.find((s) => s.id === open.id) : undefined

  if (openMcp) {
    return <McpEditor item={openMcp} onBack={() => setOpen(null)} />
  }
  if (openSkill) {
    return <SkillDetail item={openSkill} onBack={() => setOpen(null)} />
  }

  type Item = {
    kind: 'skill' | 'mcp'
    id: string
    name: string
    enabled: boolean
    badge: string
    note?: string
    /** 注记以警示色显示（MCP 已启用却没连上：失败 / 待填密钥 / 待完善配置）。 */
    noteWarn?: boolean
    /** 可用角色（null = 所有角色，行尾不显示；内置技能不设）。 */
    roles?: string[] | null
    locked?: boolean
  }
  const items: Item[] = [
    ...skills.map(
      (s): Item => ({
        kind: 'skill',
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        badge: t('cf.kindSkill'),
        note: s.source === 'builtin' ? t('cf.builtin') : undefined,
        roles: s.source === 'builtin' ? undefined : s.roles,
        locked: s.source === 'builtin'
      })
    ),
    ...mcp.map(
      (m): Item => ({
        kind: 'mcp',
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        badge: t('cf.kindMcp'),
        // 未启用不加注记（开关本身已表达）；已启用则如实给出连接状态，没连上的原因用警示色。
        note: m.enabled ? t(`extensions.status.${m.status}`) : undefined,
        noteWarn: m.enabled && MCP_STATUS_WARN.has(m.status),
        roles: m.roles
      })
    )
  ]
  return (
    <>
      <h2 className="cf-pane__title">{t('activity.extensions')}</h2>
      {items.length === 0 ? (
        <div className="cf-empty">{t('cf.extEmpty')}</div>
      ) : (
        <div className="cf-rows">
          {items.map((x) => {
            const name = (
              <span className="cf-setrow__name">
                <span className="cf-setrow__label" title={x.name}>
                  {x.name}
                </span>
                <span className="cf-badge">{x.badge}</span>
                {x.note && (
                  <span className={`cf-setrow__note${x.noteWarn ? ' cf-setrow__note--warn' : ''}`}>
                    {x.note}
                  </span>
                )}
              </span>
            )
            return (
              <div key={`${x.kind}:${x.id}`} className="cf-setrow">
                {x.locked ? (
                  // 内置技能不展示详情：只读一行，开关禁用。
                  <div className="cf-setrow__main">{name}</div>
                ) : (
                  // 主区做按钮（点开详情），开关作兄弟节点独立触发（互不干扰）。
                  <button className="cf-setrow__open" onClick={() => setOpen({ kind: x.kind, id: x.id })}>
                    {name}
                    {x.roles !== undefined && <RolesBadge roles={x.roles} />}
                    <ChevronRight className="cf-setrow__chevron" size={15} />
                  </button>
                )}
                <Toggle on={x.enabled} disabled={x.locked} onChange={() => toggle(x.kind, x.id)} />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/** 可用角色里还存在的角色（按花名册顺序）；null = 所有角色。 */
function usePickedPersonas(roles: string[] | null): Persona[] {
  const { personas } = useExtensions()
  return useMemo(() => (roles === null ? [] : personas.filter((p) => roles.includes(p.id))), [personas, roles])
}

/**
 * 扩展列表行尾的可用角色：指定了角色显示头像堆叠，所有角色不显示。指定的角色都删了时主进程会把该项
 * 改回所有角色并停用（personas.ts pruneExtRoles），渲染层不再有「无可用角色」这一态。
 */
function RolesBadge({ roles }: { roles: string[] | null }): React.JSX.Element | null {
  const picked = usePickedPersonas(roles)
  return picked.length ? <AvatarStack personas={picked} /> : null
}

/**
 * 技能 / MCP 详情的「可用角色」：统一下拉框的多选模式。收起时显示「所有角色」或所选角色的头像堆叠与名字；
 * 浮层第一项「所有角色」（点了即收起），其下「只给这些角色」逐个勾选，即时生效。从所有角色点某个角色即只给它，
 * 取消到一个不剩即回到所有角色。
 */
/** 「所有角色」选项的值：角色 id 只含字母数字与 _.-，不会与之相撞。 */
const ROLES_GENERAL = '*'

function RolesPicker({
  kind,
  id,
  roles
}: {
  kind: 'skill' | 'mcp'
  id: string
  roles: string[] | null
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { personas, setRoles } = useExtensions()
  const picked = usePickedPersonas(roles)
  // 没有指定（或指定的角色刚被删、主进程正改回所有角色）都按所有角色显示。
  const all = picked.length === 0
  const sep = locale === 'en' ? ', ' : '、'

  const toggle = (pid: string): void => {
    if (pid === ROLES_GENERAL) {
      if (roles !== null) setRoles(kind, id, null)
      return
    }
    if (all) return setRoles(kind, id, [pid])
    const live = picked.map((p) => p.id)
    const next = live.includes(pid) ? live.filter((x) => x !== pid) : [...live, pid]
    setRoles(kind, id, next.length ? next : null)
  }

  const summary =
    picked.length <= 2
      ? picked.map((p) => p.name).join(sep)
      : t('extensions.rolesSummary')
          .replace('{names}', picked
            .slice(0, 2)
            .map((p) => p.name)
            .join(sep))
          .replace('{n}', String(picked.length))
          .replace('{rest}', String(picked.length - 2))

  const display = all ? (
    <>
      <span className="select__lead">
        <span className="select-icon">
          <Users size={12} />
        </span>
      </span>
      <span className="select__label">{t('extensions.rolesGeneral')}</span>
    </>
  ) : (
    <>
      <span className="select__lead">
        <AvatarStack personas={picked} size={20} />
      </span>
      <span className="select__label">{summary}</span>
    </>
  )

  return (
    <div className="ext-field">
      <label className="ext-field__label">{t('extensions.roles')}</label>
      <Select
        multiple
        aria-label={t('extensions.roles')}
        display={display}
        isSelected={(v) => (v === ROLES_GENERAL ? all : picked.some((p) => p.id === v))}
        onToggle={toggle}
        items={[
          {
            value: ROLES_GENERAL,
            label: t('extensions.rolesGeneral'),
            sub: t('extensions.rolesGeneralHint'),
            // 「所有角色」是一个整体，点了同单选一样收起；只有具体角色才多选。
            closeOnPick: true,
            lead: (
              <span className="select-icon">
                <Users size={14} />
              </span>
            )
          },
          { separator: true },
          { group: t('extensions.rolesOnly') },
          ...personas.map((p) => ({
            value: p.id,
            label: p.name,
            sub: p.desc || undefined,
            lead: (
              <span className="select-ava">
                <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} />
              </span>
            )
          }))
        ]}
      />
    </div>
  )
}

/**
 * 技能详情（对话优先外壳）：只读的钻取式主从抽屉，顶栏与名称分隔线同 MCP 详情（返回 · 删除 · 启用）。
 * 只展示名称、可用角色与 SKILL.md 正文；描述及其余 frontmatter 字段（compatibility / license / metadata /
 * allowed-tools，以及 Deva 自有的 trigger）一律不显示。整页撑满设置面板、不出外层滚动条：
 * 正文吃掉剩余高度、过长时框内滚动。删除 = 技能文件夹移到系统回收站。
 * 仅自定义技能可进入；内置技能在列表里不可点开。
 */
function SkillDetail({ item, onBack }: { item: Skill; onBack: () => void }): React.JSX.Element {
  const { t, locale } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const { toggle, removeSkill } = useExtensions()

  const onDelete = (): void => {
    const name = clipName(item.name)
    void (async () => {
      const ok = await dialog.confirm({
        title: locale === 'en' ? `Delete skill “${name}”?` : `删除技能 ${name} ？`,
        message: t(IS_MAC ? 'cf.skillDeleteConfirmMac' : 'cf.skillDeleteConfirm'),
        confirmText: t('cf.delete'),
        variant: 'danger'
      })
      if (!ok) return
      if (await removeSkill(item.id)) onBack()
      else toast.show({ variant: 'error', message: t('cf.skillDeleteFailed') })
    })()
  }

  return (
    <section className="provider-detail provider-detail--fill" key={item.id}>
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('common.back')}
        </button>
        <div className="provider-detail__spacer" />
        <button className="icon-btn provider-detail__del" title={t('extensions.remove')} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('extensions.enable')}</span>
        <Toggle on={item.enabled} onChange={() => toggle('skill', item.id)} />
      </div>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Puzzle size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono">{item.name}</h2>
      </header>

      <RolesPicker kind="skill" id={item.id} roles={item.roles} />

      <div className="ext-field ext-field--grow">
        <label className="ext-field__label">{t('extensions.instructions')}</label>
        {item.instructions ? (
          <div className="ext-detail__md">
            <Markdown text={item.instructions} />
          </div>
        ) : (
          <span className="ext-detail__muted">{t('extensions.instructionsEmpty')}</span>
        )}
      </div>
    </section>
  )
}

/** 详情页运行期状态字形（● 连接 / ! 错或待处理 / ○ 未启用）。 */
const MCP_STATUS_GLYPH: Record<McpStatus, string> = {
  connected: '●',
  connecting: '●',
  error: '!',
  needs_config: '!',
  needs_secret: '!',
  disconnected: '○'
}

/** 已启用却没连上、需要用户处理的状态（列表注记用警示色）。 */
const MCP_STATUS_WARN = new Set<McpStatus>(['error', 'needs_config', 'needs_secret'])

/**
 * MCP 详情编辑（对话优先外壳）：钻取式主从抽屉，形态对齐模型设置页（顶部返回 + 逐字段即时落盘）。
 * 传输 / 命令 / 参数 / 环境变量（或 URL / 请求头）经 update('mcp', …) round-trip 到 mcp.json；名称只读
 * （创建时定下，见 create_mcp：改名不改 id、也不刷新已发给模型的工具说明，故不提供）。
 * 密钥恒经 mcpSetSecret 加密另存、写后不回显（`{secretRef}` 占位符落盘，明文零留痕）。
 */
function McpEditor({ item, onBack }: { item: McpServer; onBack: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const { update, remove, toggle, mcpRetry, mcpSetSecret } = useExtensions()
  const [secretWarn, setSecretWarn] = useState(false)
  const isStdio = item.transport === 'stdio'

  // 写入密钥字段：加密不可用时亮出降级提示（空值即删除已存密钥）。
  // 返回落盘结果，供 McpKvEditor 呈现「保存中 / 已保存」反馈。
  const setSecret = (field: string, value: string): Promise<{ ok: boolean; available: boolean }> =>
    mcpSetSecret(item.id, field, value).then((r) => {
      if (value && !r.available) setSecretWarn(true)
      return r
    })

  const onDelete = (): void => {
    void (async () => {
      const ok = await dialog.confirm({
        title: item.name,
        message: t('cf.mcpDeleteConfirm'),
        confirmText: t('common.delete'),
        variant: 'danger'
      })
      if (ok) {
        remove('mcp', item.id)
        onBack()
      }
    })()
  }

  return (
    <section className="provider-detail" key={item.id}>
      {/* 顶部工具条「返回 + 删除/启用」同一行，对齐模型设置页 */}
      <div className="provider-detail__topbar">
        <button className="provider-detail__back" onClick={onBack}>
          <ChevronLeft size={16} />
          {t('common.back')}
        </button>
        <div className="provider-detail__spacer" />
        <button className="icon-btn provider-detail__del" title={t('extensions.remove')} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
        <span className="provider-detail__enable">{t('extensions.enable')}</span>
        <Toggle on={item.enabled} onChange={() => toggle('mcp', item.id)} />
      </div>
      <header className="provider-detail__head">
        <span className="ext-detail__icon">
          <Plug size={18} />
        </span>
        <h2 className="ext-detail__name ext-detail__name--mono ext-detail__name--clip" title={item.name}>
          {item.name}
        </h2>
        {/* 启用即连接：状态只读展示在标题行最右侧，唯一的动作是失败后「重试」。未启用一律显示「未启用」。 */}
        <span className={`ext-status__live ext-status__live--${item.enabled ? item.status : 'disconnected'}`}>
          {item.enabled
            ? `${MCP_STATUS_GLYPH[item.status]} ${t(`extensions.status.${item.status}`)}`
            : `${MCP_STATUS_GLYPH.disconnected} ${t('extensions.status.off')}`}
          {item.enabled && item.status === 'connected' && item.toolCount > 0
            ? ` · ${item.toolCount} ${t('extensions.tools')}`
            : ''}
        </span>
        {item.enabled && item.status === 'error' && (
          <button className="ext-linkbtn" onClick={() => mcpRetry(item.id)}>
            {t('extensions.retry')}
          </button>
        )}
      </header>
      {item.enabled && item.status === 'error' && item.lastError && (
        <div className="mcp-error">{item.lastError}</div>
      )}
      {item.enabled && item.status === 'needs_config' && item.lastError && (
        <div className="mcp-error mcp-error--warn">{item.lastError}</div>
      )}
      {item.enabled && item.status === 'needs_secret' && (
        <div className="mcp-error mcp-error--warn">
          {t('extensions.missingSecrets').replace('{fields}', item.missingSecrets.join(', '))}
        </div>
      )}

      <RolesPicker kind="mcp" id={item.id} roles={item.roles} />

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.transport')}</label>
        <Select<McpServer['transport']>
          mono
          aria-label={t('extensions.transport')}
          value={item.transport}
          onChange={(transport) => update('mcp', item.id, { transport })}
          items={[
            { value: 'stdio', label: 'stdio', sub: t('extensions.transportSub.stdio') },
            { value: 'sse', label: 'sse', sub: t('extensions.transportSub.sse') },
            { value: 'http', label: 'http (streamable)', sub: t('extensions.transportSub.http') }
          ]}
        />
      </div>

      {isStdio ? (
        <>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.command')}</label>
            <input
              className="ext-input ext-input--mono"
              placeholder={t('extensions.commandPlaceholder')}
              value={item.command}
              onChange={(e) => update('mcp', item.id, { command: e.target.value })}
            />
          </div>
          <McpArgsField item={item} />
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.env')}</label>
            <McpKvEditor
              serverId={item.id}
              rows={item.env}
              onChange={(rows) => update('mcp', item.id, { env: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      ) : (
        <>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.url')}</label>
            <input
              className="ext-input ext-input--mono"
              placeholder={t('extensions.urlPlaceholder')}
              value={item.url}
              onChange={(e) => update('mcp', item.id, { url: e.target.value })}
            />
          </div>
          <div className="ext-field">
            <label className="ext-field__label">{t('extensions.headers')}</label>
            <McpKvEditor
              serverId={item.id}
              rows={item.headers}
              onChange={(rows) => update('mcp', item.id, { headers: rows })}
              onSetSecret={setSecret}
            />
          </div>
        </>
      )}

      {secretWarn && (
        <p className="ext-field__note ext-field__note--warn">{t('extensions.secretUnavailable')}</p>
      )}

      <div className="ext-field">
        <label className="ext-field__label">{t('extensions.discoveredTools')}</label>
        {item.tools.length === 0 ? (
          <div className="ext-tools--empty">{t('extensions.noToolsYet')}</div>
        ) : (
          <ul className="mcp-tools">
            {item.tools.map((tool) => (
              <li key={tool.name} className="mcp-tools__item">
                <code className="mcp-tools__name">{tool.name}</code>
                {tool.description && <span className="mcp-tools__desc">{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 命令参数编辑：一行一个（本地字符串态，随服务切换 remount 自动重置）。 */
function McpArgsField({ item }: { item: McpServer }): React.JSX.Element {
  const { t } = useI18n()
  const { update } = useExtensions()
  const [text, setText] = useState(item.args.join('\n'))
  return (
    <div className="ext-field">
      <label className="ext-field__label">{t('extensions.args')}</label>
      <textarea
        className="ext-area ext-area--mono"
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

/**
 * 键值对编辑（env / headers）：明文即时落盘；密钥经 onSetSecret 加密。
 * 密钥字段对齐模型页 API-Key 交互：
 *  - 输入后**保留**遮罩草稿在框内（不再失焦即清空 → 不会「自动消失」）；
 *  - 防抖 ~600ms 自动保存 + 失焦 / 回车立即冲刷，落盘结果亮「保存中 / 已保存」；
 *  - 重新打开时草稿为空，据 hasSecret 亮「已配置」并提示「留空不修改」——始终不回显明文。
 */
function McpKvEditor({
  serverId,
  rows,
  onChange,
  onSetSecret
}: {
  serverId: string
  rows: McpKV[]
  onChange: (rows: McpKV[]) => void
  onSetSecret: (field: string, value: string) => Promise<{ ok: boolean; available: boolean }>
}): React.JSX.Element {
  const { t } = useI18n()
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saveState, setSaveState] = useState<Record<number, 'idle' | 'saving' | 'saved'>>({})
  const [configured, setConfigured] = useState<Record<number, boolean>>({})
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout> | null>>({})

  // 各密钥行是否已配置（布尔，不回显明文）；键集变化时重查，点亮「已配置」。
  const secretSig = JSON.stringify(rows.map((r) => (r.secret ? r.key.trim() : '')))
  useEffect(() => {
    const keys = JSON.parse(secretSig) as string[]
    let alive = true
    void (async () => {
      const next: Record<number, boolean> = {}
      await Promise.all(
        keys.map(async (key, i) => {
          if (key) next[i] = (await window.deva?.mcp?.hasSecret?.(serverId, key)) ?? false
        })
      )
      if (alive) setConfigured(next)
    })()
    return () => {
      alive = false
    }
  }, [serverId, secretSig])

  const setRow = (i: number, patch: Partial<McpKV>): void =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = (): void => onChange([...rows, { key: '', value: '', secret: false }])
  const removeRow = (i: number): void => onChange(rows.filter((_, idx) => idx !== i))

  const clearTimer = (i: number): void => {
    const tm = timersRef.current[i]
    if (tm) {
      clearTimeout(tm)
      timersRef.current[i] = null
    }
  }

  const doSaveSecret = async (i: number, key: string, value: string): Promise<void> => {
    if (!key || !value) return
    setSaveState((s) => ({ ...s, [i]: 'saving' }))
    const r = await onSetSecret(key, value)
    setSaveState((s) => ({ ...s, [i]: r.ok ? 'saved' : 'idle' }))
    if (r.ok) setConfigured((c) => ({ ...c, [i]: true }))
  }

  // 输入变化：更新草稿并防抖自动保存（不清空草稿，遮罩值留在框内）。
  const onSecretChange = (i: number, value: string): void => {
    setDrafts((d) => ({ ...d, [i]: value }))
    setSaveState((s) => ({ ...s, [i]: 'idle' }))
    clearTimer(i)
    const key = rows[i].key.trim()
    if (!key || !value) return
    timersRef.current[i] = setTimeout(() => {
      timersRef.current[i] = null
      void doSaveSecret(i, key, value)
    }, 600)
  }

  // 立即冲刷在途保存（失焦 / 回车）。
  const flushSecret = (i: number): void => {
    clearTimer(i)
    void doSaveSecret(i, rows[i].key.trim(), drafts[i] ?? '')
  }

  const toggleSecret = (i: number): void => {
    const r = rows[i]
    const key = r.key.trim()
    if (r.secret && key) void onSetSecret(key, '') // 转明文：清除已加密的旧值
    clearTimer(i)
    setRow(i, { secret: !r.secret, value: '' })
    setDrafts((d) => {
      const n = { ...d }
      delete n[i]
      return n
    })
    setSaveState((s) => {
      const n = { ...s }
      delete n[i]
      return n
    })
    setConfigured((c) => {
      const n = { ...c }
      delete n[i]
      return n
    })
  }

  return (
    <div className="kv-editor">
      {rows.map((r, i) => (
        <div className="kv-row-wrap" key={i}>
          <div className="kv-row">
            <input
              className="ext-input ext-input--mono kv-row__key"
              placeholder={t('extensions.kvKey')}
              value={r.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
            />
            {r.secret ? (
              <input
                className="ext-input ext-input--mono kv-row__val"
                type="password"
                placeholder={
                  configured[i]
                    ? t('extensions.secretPlaceholder')
                    : t('extensions.secretValuePlaceholder')
                }
                value={drafts[i] ?? ''}
                onChange={(e) => onSecretChange(i, e.target.value)}
                onBlur={() => flushSecret(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') flushSecret(i)
                }}
              />
            ) : (
              <input
                className="ext-input ext-input--mono kv-row__val"
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
          {r.secret && (saveState[i] === 'saving' || saveState[i] === 'saved' || configured[i]) && (
            <div className="kv-row__status">
              {saveState[i] === 'saving' ? (
                <span className="key-status">{t('extensions.secretSaving')}</span>
              ) : saveState[i] === 'saved' ? (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('extensions.secretSaved')}
                </span>
              ) : (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('extensions.secretConfigured')}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <button className="btn btn--ghost btn--sm kv-add" onClick={addRow}>
        <Plus size={13} /> {t('extensions.addRow')}
      </button>
    </div>
  )
}

function AboutPane(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <h2 className="cf-pane__title">{t('settings.about')}</h2>
      <div className="cf-about">
        <img className="cf-about__icon" src={devaIcon} alt="" aria-hidden />
        <div className="cf-about__name">{t('app.name')}</div>
        <div className="cf-about__ver">
          {t('settings.version')} {__APP_VERSION__}
        </div>
        {t('app.tagline') && <p className="cf-about__desc">{t('app.tagline')}</p>}
        <UpdateSection />
      </div>
    </>
  )
}
