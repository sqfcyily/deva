/**
 * 角色资料卡与角色编辑器。
 */
import { useMemo, useRef, useState } from 'react'
import { Folder, Plug, Puzzle, Sparkles } from 'lucide-react'
import type { Persona } from '../mock/extensions'
import type {
  PersonaUpsertInput
} from '../../../preload'
import { type AgentDraft, type SessionMeta, useChatActions } from '../store/chat'
import { useExtensions } from '../store/extensions'
import { useModels } from '../store/models'
import { useI18n } from '../i18n/i18n'
import { Select, type SelectEntry } from '../components/Select'
import {
  PersonaFace,
  seededShape,
  parseAvatarSpec,
  randomizeSpec,
  resolveSpec,
  serializeAvatarSpec,
  type AvatarSpec
} from '../components/humation'
import { AvatarEditor } from './AvatarEditor'
import { basename, DragBar, useRelativeTime } from './shell-common'
import { PersonaFolderField } from './PersonaFolderField'
import { PersonaPromptPage, PersonaPromptRow } from './PersonaPrompt'
import { useMemoryList } from './memory-editor'
import { RoleMemoryList } from './RoleMemoryTab'

/**
 * 角色编辑器打开态：新建 / 编辑（带原对象）/ 确认名片（propose：预填 LLM 草稿，接受才落盘）。
 * propose 态的 draft 取自不可变的名片块 → 关闭重开即回到 LLM 原始草稿（丢弃改动，兼作「重置」）。
 */
export type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; persona: Persona }
  | { mode: 'propose'; draft: AgentDraft; toolId: string }

/* ============================ 中列：角色资料卡 ============================ */
/** 资料卡下方的标签：与该角色的对话 / 它的专属能力 / 它的角色记忆。 */
type ProfileTab = 'chats' | 'caps' | 'memory'

/**
 * 角色资料卡：头像与名字并排、操作按钮，下面用「对话 / 能力」两个标签切换，一次只看一块。
 * 能力 = 在扩展页指定给这个角色的技能与 MCP（对所有角色开放的不在这里重复），点某项进入设置 › 扩展的详情；
 * 没有专属能力的角色不显示「能力」标签。标签选择跨角色保留，便于逐个查看各角色的能力。
 * 名片（头像到标签）固定不动，只有下方列表滚动。
 */
export function ProfileView({
  persona,
  sessions,
  onOpenThread,
  onStart,
  onEdit,
  onManageCaps
}: {
  persona: Persona
  sessions: SessionMeta[]
  onOpenThread: (id: string) => void
  onStart: () => void
  onEdit: () => void
  /** 打开设置 › 扩展里这一项的详情。 */
  onManageCaps: (target: { kind: 'skill' | 'mcp'; id: string }) => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { skills, mcp } = useExtensions()
  const rel = useRelativeTime()
  const [tab, setTab] = useState<ProfileTab>('chats')
  const convs = useMemo(
    () =>
      sessions
        .filter((s) => s.personaId === persona.id)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, persona.id]
  )
  // 专属能力：可用角色里点名了这个角色的技能与 MCP（停用的也列出、置灰，免得以为没配上）。
  const caps = useMemo(
    () => [
      ...skills
        .filter((s) => s.roles?.includes(persona.id))
        .map((s) => ({ kind: 'skill' as const, id: s.id, name: s.name, desc: s.desc, enabled: s.enabled })),
      ...mcp
        .filter((m) => m.roles?.includes(persona.id))
        .map((m) => ({
          kind: 'mcp' as const,
          id: m.id,
          name: m.name,
          desc: m.desc || (m.enabled ? t(`extensions.status.${m.status}`) : ''),
          enabled: m.enabled
        }))
    ],
    [skills, mcp, persona.id, t]
  )
  // 角色记忆（对比稿 design/memory-ui.html 方案 ①）：有记忆才显示「记忆」标签。
  const memList = useMemoryList({ personaId: persona.id })
  const memCount = memList.mem?.entries.length ?? 0
  // 没有专属能力 / 没有记忆就不显示对应标签；之前停在那里的回到「对话」。
  const current: ProfileTab =
    (tab === 'caps' && !caps.length) || (tab === 'memory' && !memCount) ? 'chats' : tab
  const tabs: [ProfileTab, string, number][] = [['chats', t('cf.profileTabChats'), convs.length]]
  if (caps.length) tabs.push(['caps', t('cf.profileTabCaps'), caps.length])
  if (memCount) tabs.push(['memory', t('cf.profileTabMemory'), memCount])
  const noConvs =
    locale === 'en' ? `No conversations with ${persona.name} yet` : `还没有和 ${persona.name} 的对话`

  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-profile cf-profile--persona">
        <div className="cf-profile__inner cf-profile__inner--persona">
          <div className="cf-phead">
            <div className="cf-profile__ava">
              <PersonaFace
                seed={persona.id}
                spec={parseAvatarSpec(persona.avatar)}
                image={persona.avatarImage}
                title={persona.name}
              />
            </div>
            <div className="cf-phead__id">
              <div className="cf-phead__name cf-profile__clip" title={persona.name}>
                {persona.name}
              </div>
              {persona.desc && (
                <div className="cf-phead__spec" title={persona.desc}>
                  {persona.desc}
                </div>
              )}
            </div>
          </div>

          <div className="cf-profile__actions">
            <button className="cf-profile__new" onClick={onStart}>
              ＋ {t('cf.startChat')}
            </button>
            <button className="cf-profile__edit" onClick={onEdit}>
              {t('cf.editPersona')}
            </button>
          </div>

          <div className="cf-ptabs" role="tablist">
            {tabs.map(([key, label, n]) => (
              <button
                key={key}
                role="tab"
                aria-selected={current === key}
                className={`cf-ptab${current === key ? ' is-on' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
                <span className="cf-ptab__n">{n}</span>
              </button>
            ))}
          </div>

          {/* 按角色 + 标签换 key：切标签或换角色时列表回到顶部，不沿用上一个列表的滚动位置。 */}
          <div key={`${persona.id}:${current}`} className="cf-ptabs__body" role="tabpanel">
            {current === 'chats' ? (
              convs.length === 0 ? (
                <div className="cf-ptabs__note cf-profile__clip" title={noConvs}>
                  {noConvs}
                </div>
              ) : (
                convs.map((s) => (
                  <button key={s.id} className="cf-convrow" onClick={() => onOpenThread(s.id)}>
                    <span className="cf-convrow__title">{s.title || t('chat.untitled')}</span>
                    {s.focusRoot && (
                      <span className="cf-convrow__proj" title={s.focusRoot}>
                        <Folder size={11} />
                        <span className="cf-convrow__projname">{basename(s.focusRoot)}</span>
                      </span>
                    )}
                    <span className="cf-convrow__time">{rel(s.updatedAt)}</span>
                  </button>
                ))
              )
            ) : current === 'memory' ? (
              <RoleMemoryList personaId={persona.id} list={memList} />
            ) : (
              caps.map((c) => (
                <button
                  key={`${c.kind}:${c.id}`}
                  className={`cf-cap${c.enabled ? '' : ' is-off'}`}
                  onClick={() => onManageCaps({ kind: c.kind, id: c.id })}
                >
                  <span className="cf-cap__ico">{c.kind === 'skill' ? <Puzzle size={15} /> : <Plug size={15} />}</span>
                  <span className="cf-cap__main">
                    <span className="cf-cap__name">{c.name}</span>
                    {c.desc && <span className="cf-cap__desc">{c.desc}</span>}
                  </span>
                  <span className="cf-cap__kind">
                    {c.enabled ? t(c.kind === 'skill' ? 'cf.kindSkill' : 'cf.kindMcp') : t('cf.capDisabled')}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/* ============================ 角色编辑器（Part G） ============================ */
export function PersonaEditor({
  initial,
  onClose
}: {
  initial: EditorState
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { providers } = useModels()
  const { upsertPersona, setPersonaAvatarImage } = useExtensions()
  const { resolveProposal } = useChatActions()
  const editing = initial.mode === 'edit' ? initial.persona : null
  // propose 态：预填 LLM 草稿，接受才落盘、拒绝不写；editing 恒 null → upsert 无 id → 只创建不覆盖。
  const proposing = initial.mode === 'propose' ? initial : null
  const draft = proposing?.draft

  const [name, setName] = useState(editing?.name ?? draft?.name ?? '')
  const [desc, setDesc] = useState(editing?.desc ?? draft?.desc ?? '')
  const [model, setModel] = useState(editing?.model ?? draft?.model ?? '')
  // 工作区：空 = 角色的默认工作区（~/Deva/Agents/<角色 id>）；名片草稿不带（目录只能由用户亲手在系统对话框里选）。
  const [workspace, setWorkspace] = useState(editing?.workspace ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? draft?.prompt ?? '')
  const [saving, setSaving] = useState(false)

  // 头像：初始化解析为**具体** spec，此后只处理显式值、保存也写显式值（杜绝漂移）。
  // 编辑=沿用已存（空则按 id 确定性生成，与各处显示一致）；名片=按角色名确定性生成（与聊天名片预览一致）；
  // 新建=默认随机一枚（每个新角色开箱即有独特头像）。名片与新建都算新角色，形状随机（名片按名字派生，与聊天名片预览一致）。
  // seed 只初始化取一次，故编辑期间不随输入名跳变。
  const avatarSeed = editing?.id || draft?.name || 'new-persona'
  const [avatar, setAvatar] = useState<AvatarSpec>(() =>
    editing
      ? resolveSpec(avatarSeed, parseAvatarSpec(editing.avatar))
      : proposing
        ? resolveSpec(avatarSeed, { shape: seededShape(avatarSeed) })
        : randomizeSpec()
  )
  // 自定义头像（用户上传的图，data URI）：非空即盖过上面的 spec 生成头像。编辑态取已存图，
  // 新建 / 名片态恒空。它不进 upsertPersona 入参——落盘要等 upsert 返回 id（见 save）。
  const [avatarImage, setAvatarImage] = useState<string>(editing?.avatarImage ?? '')
  // 头像编辑面板开关：点击信息表单里的头像缩略图进入。面板自持草稿：「完成」回写这里的
  // avatar/avatarImage、「取消」/ ✕ 直接收起即丢弃；两者都只切回表单，真正落盘仍走表单底部的保存/接受。
  const [avatarEditing, setAvatarEditing] = useState(false)
  // 系统提示词编辑页：表单里收起成一行，点了在同一个弹窗里换成编辑页（同头像面板），「完成」带回、「取消」丢弃。
  // 进来时把弹窗高度定格为表单当时的高度，切换前后弹窗大小不变、不抖动；回到表单再放开。
  const modalRef = useRef<HTMLDivElement>(null)
  const [promptEditing, setPromptEditing] = useState(false)
  const [lockedH, setLockedH] = useState<number | null>(null)
  const openPrompt = (): void => {
    setLockedH(modalRef.current?.getBoundingClientRect().height ?? null)
    setPromptEditing(true)
  }
  const closePrompt = (): void => {
    setPromptEditing(false)
    setLockedH(null)
  }
  // 顶部 ✕ / 点击背景：在头像面板 / 提示词编辑页时只退回信息表单（丢弃这次改动），否则关闭整个编辑器。
  const dismiss = (): void => {
    if (avatarEditing) setAvatarEditing(false)
    else if (promptEditing) closePrompt()
    else onClose()
  }
  const subEditing = avatarEditing || promptEditing

  // 模型下拉：「跟随默认」+ 按服务商分组的模型（同输入框的模型选择）→ "providerId:modelId"；空 = 跟随默认。
  // 决策模型（purpose==='decision'）不参与对话生成，排除在角色偏好模型之外。
  const llmProviders = useMemo(
    () => providers.filter((p) => (p.purpose ?? 'llm') === 'llm' && p.models.length > 0),
    [providers]
  )
  const modelItems = useMemo<SelectEntry<string>[]>(
    () => [
      {
        value: '',
        label: t('cf.defaultModel'),
        sub: t('cf.defaultModelHint'),
        lead: (
          <span className="select-icon">
            <Sparkles size={14} />
          </span>
        )
      },
      ...llmProviders.flatMap((p): SelectEntry<string>[] => [
        { separator: true },
        { group: p.name, lead: <span className="select-dot" style={{ background: p.accent }} /> },
        ...p.models.map((m) => ({ value: `${p.id}:${m.id}`, label: m.name }))
      ])
    ],
    [llmProviders, t]
  )
  // 收起态：选中模型带服务商色点；引用的模型已删除时如实显示原引用（与资料卡原先的兜底一致）。
  const modelDisplay = useMemo(() => {
    if (!model) return undefined
    const idx = model.indexOf(':')
    const p = idx > 0 ? llmProviders.find((x) => x.id === model.slice(0, idx)) : undefined
    const m = p?.models.find((x) => x.id === model.slice(idx + 1))
    if (!p || !m) return <span className="select__label select__placeholder">{model}</span>
    return (
      <>
        <span className="select__lead">
          <span className="select-dot" style={{ background: p.accent }} />
        </span>
        <span className="select__label">{m.name}</span>
      </>
    )
  }, [model, llmProviders])

  // 保存（create/edit）/ 接受（propose）：同一条渲染层 upsertPersona（用户点击即授权，零提权）。
  // propose 态额外落定名片终态为 accepted（重开不退回 pending、不重复建角色）。
  const save = (): void => {
    if (!name.trim() || saving) return
    setSaving(true)
    void (async () => {
      const input: PersonaUpsertInput = {
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        description: desc.trim(),
        // 存显式头像 spec（JSON 串）：所见即所存即所渲染。
        avatar: serializeAvatarSpec(avatar),
        model,
        workspace,
        prompt,
        enabled: true
      }
      const saved = await upsertPersona(input)
      // 自定义头像另走一路：它不入 frontmatter，且**新建角色要等 upsert 返回才有 id**。
      // 只在相对已存值真有变化时写（空串 = 清除），免得每次保存都重写一遍同一张图。
      if (saved && avatarImage !== (editing?.avatarImage ?? '')) {
        await setPersonaAvatarImage(saved.id, avatarImage)
      }
      setSaving(false)
      if (saved) {
        if (proposing) resolveProposal(proposing.toolId, 'accepted')
        onClose()
      }
    })()
  }

  // 拒绝（仅 propose 态）：不写任何东西，只把名片终态落为 rejected 并关闭。
  const reject = (): void => {
    if (!proposing) return
    resolveProposal(proposing.toolId, 'rejected')
    onClose()
  }

  return (
    <div className="cf-modal__backdrop" onClick={dismiss}>
      <div
        ref={modalRef}
        className="cf-modal is-editor"
        style={lockedH ? { height: lockedH } : undefined}
        role="dialog"
        aria-label={
          proposing
            ? t('cf.editorProposeTitle')
            : editing
              ? t('cf.editorEditTitle')
              : t('cf.editorNewTitle')
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-modal__head">
          <span className="cf-modal__title">
            {avatarEditing
              ? t('cf.fAvatar')
              : promptEditing
                ? t('cf.fPrompt')
                : proposing
                ? t('cf.editorProposeTitle')
                : editing
                  ? t('cf.editorEditTitle')
                  : t('cf.editorNewTitle')}
          </span>
          {/* ✕/背景：头像面板时退回信息表单；否则关闭（propose 态丢弃改动、保持 pending、可再开），不 resolve、不写。 */}
          <button
            className="cf-modal__close"
            title={subEditing ? t('cf.cancel') : proposing ? t('cf.close') : t('cf.cancel')}
            onClick={dismiss}
          >
            ✕
          </button>
        </div>
        {promptEditing ? (
          /* ===== 系统提示词编辑页：点表单里的提示词一行进入；「完成」回写并返回信息表单。
             不放进 .cf-editor（它自带内边距与滚动），正文与底栏的边距、横线由编辑页自己管 ===== */
          <PersonaPromptPage
            initial={prompt}
            onCancel={closePrompt}
            onDone={(next) => {
              setPrompt(next)
              closePrompt()
            }}
          />
        ) : (
          <div className="cf-editor">
          {avatarEditing ? (
            /* ===== 头像编辑面板：点击头像进入；「完成」回写并返回信息表单 ===== */
            <AvatarEditor
              seed={avatarSeed}
              initialSpec={avatar}
              initialImage={avatarImage}
              title={name}
              onCancel={() => setAvatarEditing(false)}
              onDone={(spec, image) => {
                setAvatar(spec)
                setAvatarImage(image)
                setAvatarEditing(false)
              }}
            />
          ) : (
            /* ===== 信息表单：头像收成一枚可点缩略图（点击进面板），其余字段照旧 ===== */
            <>
              {/* 头像独立成身份头：一枚缩略图 + 提示，点击切到头像编辑面板。 */}
              <div className="cf-field cf-field--avatar">
                <label className="cf-field__label">{t('cf.fAvatar')}</label>
                <button
                  type="button"
                  className="cf-avapick"
                  title={t('cf.avaEdit')}
                  onClick={() => setAvatarEditing(true)}
                >
                  <span className="cf-avapick__face">
                    <PersonaFace
                      seed={avatarSeed}
                      spec={avatar}
                      image={avatarImage}
                      title={name || t('cf.fAvatar')}
                    />
                  </span>
                  <span className="cf-avapick__hint">{t('cf.avaEditHint')}</span>
                </button>
              </div>

              <div className="cf-field">
                <label className="cf-field__label">{t('cf.fName')}</label>
                <input className="cf-input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div className="cf-field">
                <label className="cf-field__label">{t('cf.fSpecialty')}</label>
                <input className="cf-input" value={desc} onChange={(e) => setDesc(e.target.value)} />
              </div>

              <div className="cf-field">
                <label className="cf-field__label">{t('cf.fModel')}</label>
                <Select
                  aria-label={t('cf.fModel')}
                  value={model}
                  onChange={setModel}
                  items={modelItems}
                  display={modelDisplay}
                />
              </div>

              <PersonaFolderField personaId={editing?.id} value={workspace} onChange={setWorkspace} />

              <PersonaPromptRow value={prompt} onOpen={openPrompt} />

              <div className="cf-editor__actions">
                {/* propose：左=拒绝（不写+标记 rejected），右=接受（upsert+标记 accepted）；否则 取消/保存。 */}
                <button className="cf-btn" onClick={proposing ? reject : onClose}>
                  {proposing ? t('cf.reject') : t('cf.cancel')}
                </button>
                <button
                  className="cf-btn is-primary"
                  disabled={!name.trim() || saving}
                  onClick={save}
                >
                  {proposing ? t('cf.accept') : t('cf.save')}
                </button>
              </div>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
