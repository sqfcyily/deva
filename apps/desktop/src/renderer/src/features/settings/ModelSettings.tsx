import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Eye,
  EyeOff,
  ExternalLink,
  Trash2,
  Check,
  X,
  ShieldCheck,
  Loader2,
  RotateCcw,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Zap
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useModels } from '../../store/models'
import { useDialog } from '../../components/DialogProvider'
import {
  seedProviders,
  providerPresets,
  type ProviderAdapter,
  type ProviderPurpose
} from '../../mock/models'
import { Switch } from './Switch'

/**
 * 模型设置页（设置 › 模型）。钻取式（主从抽屉）导航：列表态只列服务商，点进去为配置详情 + 返回。
 * 同一时刻单列，避免把设置弹框撑宽。
 * 支持官方与自定义（OpenAI / Anthropic 兼容）服务：配置密钥 / 协议 / 地址 / 模型清单，设默认模型，
 * 一键测试连通性，并可从服务端拉取模型清单辅助添加（支持手动输入与匹配选择）。
 */

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'
type FetchStatus = 'idle' | 'loading' | 'done' | 'error'

export function ModelSettings(): React.JSX.Element {
  const { t } = useI18n()
  const dialog = useDialog()
  const {
    providers,
    selectedProviderId,
    selectedProvider,
    selectProvider,
    updateProvider,
    toggleModel,
    addModel,
    addModels,
    removeModel,
    addCustomProvider,
    applyPreset,
    removeProvider,
    activeModelId,
    hasKey,
    setApiKey,
    secretsAvailable
  } = useModels()

  // 钻取导航：'list' 浏览服务商列表，'detail' 编辑单个服务商
  const [view, setView] = useState<'list' | 'detail'>('list')
  // 「新增」浮动菜单：选择新建对话模型 / 决策模型
  const [addMenu, setAddMenu] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [addingModel, setAddingModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  // 从服务端清单多选待添加的模型 id 集合（未落盘的选择态）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [keyDraft, setKeyDraft] = useState('')
  // 密钥自动保存的状态指示（替代原「保存」按钮的反馈）
  const [keySaveState, setKeySaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  // 输入防抖计时器：边打字边落盘，失焦/回车/测试前立即冲刷
  const keyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  // 「供应商」下拉的当前选择（仅自定义详情用；套用官方预置的便捷入口，不持久化）
  const [presetSel, setPresetSel] = useState('')
  const [testState, setTestState] = useState<{ status: TestStatus; message: string }>({
    status: 'idle',
    message: ''
  })
  const [fetchState, setFetchState] = useState<{ status: FetchStatus; list: string[] }>({
    status: 'idle',
    list: []
  })
  // 令牌：切换服务商或重新拉取时作废在途的旧请求，避免结果错配
  const fetchTokenRef = useRef(0)

  // 切换服务商：清空各类草稿与瞬态结果（避免跨服务商残留）
  useEffect(() => {
    clearKeyTimer() // 作废上一服务商的在途自动保存
    setKeyDraft('')
    setKeySaveState('idle')
    setShowKey(false)
    setAddingModel(false)
    setNewModelId('')
    setSelectedIds(new Set())
    setNameDraft(selectedProvider?.name ?? '')
    setPresetSel('')
    setTestState({ status: 'idle', message: '' })
    setFetchState({ status: 'idle', list: [] })
    fetchTokenRef.current++
  }, [selectedProviderId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载时清理防抖计时器，避免泄漏与卸载后 setState
  useEffect(() => () => clearKeyTimer(), [])

  const seedHost = useMemo(
    () => seedProviders.find((p) => p.id === selectedProviderId)?.apiHost,
    [selectedProviderId]
  )

  // 测试所用模型：优先最近使用的模型（若属于本服务商），否则首个启用的，再否则第一个
  const testModelId = useMemo(() => {
    const p = selectedProvider
    if (!p) return ''
    if (activeModelId && activeModelId.startsWith(`${p.id}:`)) return activeModelId.split(':')[1]
    return (p.models.find((mm) => mm.enabled) ?? p.models[0])?.id ?? ''
  }, [selectedProvider, activeModelId])

  const suggestions = useMemo(() => {
    if (fetchState.status !== 'done') return []
    const existing = new Set(selectedProvider?.models.map((mm) => mm.id))
    const q = newModelId.trim().toLowerCase()
    return fetchState.list
      .filter((id) => !existing.has(id))
      .filter((id) => !q || id.toLowerCase().includes(q))
      .slice(0, 60)
  }, [fetchState, newModelId, selectedProvider])

  // 列表只呈现「在用」的服务商：已启用 / 已配密钥，以及全部自定义（用户自建，恒显以免新建后走丢）。
  // 其余官方对话预置藏进编辑页的「供应商」下拉。决策模型无该下拉入口，故恒显（供用户配置）。
  // 对话模型与决策模型在同一扁平列表里呈现，用途差异由每行的「标签」标示（不再分组、不再显官方/自定义）。
  const visibleProviders = providers.filter(
    (p) => p.enabled || hasKey(p.id) || p.kind === 'custom' || p.purpose === 'decision'
  )

  const renderProviderRow = (p: (typeof providers)[number]): React.JSX.Element => {
    const isDecision = p.purpose === 'decision'
    return (
      <button key={p.id} className="provider-row" onClick={() => openProvider(p.id)}>
        <span
          className={`provider-row__dot${p.enabled ? ' is-on' : ''}`}
          title={p.enabled ? t('models.enabled') : t('models.disabled')}
        />
        <span className="provider-row__main">
          <span className="provider-row__name">
            <span className="provider-row__name-text">{p.name}</span>
            {/* 标签标示用途：对话模型 / 决策模型（取代原官方/自定义标签） */}
            <span className={`tag${isDecision ? ' tag--decision' : ''}`}>
              {isDecision ? t('models.tagDecision') : t('models.tagLLM')}
            </span>
          </span>
          <span className="provider-row__sub">
            {isDecision
              ? t('models.rowThreshold').replace('{n}', String(p.threshold ?? 0.6))
              : t('models.modelCount').replace('{count}', String(p.models.length))}
          </span>
        </span>
        <span className="provider-row__aside">
          {p.enabled && !hasKey(p.id) && <AlertTriangle className="provider-row__warn" size={14} />}
          <ChevronRight size={16} />
        </span>
      </button>
    )
  }

  // 编辑页「供应商」下拉：选官方预置即一键套用到当前（自定义）服务商。
  // 已有模型时先确认（避免覆盖用户既有清单）；套用后同步名称输入草稿。
  const onPickPreset = async (presetId: string): Promise<void> => {
    if (!selectedProvider) return
    const preset = providerPresets.find((p) => p.id === presetId)
    if (!preset) {
      setPresetSel('')
      return
    }
    if (selectedProvider.models.length > 0) {
      const ok = await dialog.confirm({
        title: preset.name,
        message: t('models.applyPresetConfirm'),
        confirmText: t('common.confirm')
      })
      if (!ok) {
        setPresetSel('')
        return
      }
    }
    applyPreset(selectedProvider.id, preset)
    setNameDraft(preset.name)
    setPresetSel(preset.id)
    setTestState({ status: 'idle', message: '' })
  }

  const commitName = (): void => {
    if (!selectedProvider) return
    const v = nameDraft.trim()
    const next = v || t('models.newProviderName')
    if (next !== selectedProvider.name) updateProvider(selectedProvider.id, { name: next })
    if (!v) setNameDraft(next)
  }

  const onDeleteProvider = async (): Promise<void> => {
    if (!selectedProvider) return
    const ok = await dialog.confirm({
      title: selectedProvider.name,
      message: t('models.deleteProviderConfirm'),
      confirmText: t('common.delete'),
      variant: 'danger'
    })
    if (ok) {
      removeProvider(selectedProvider.id)
      setView('list') // 删除后退回列表
    }
  }

  // 点击列表项：选中并钻入详情
  const openProvider = (id: string): void => {
    selectProvider(id)
    setView('detail')
  }

  // 「新增」浮动菜单：悬停即开、离开略延迟收起（容忍按钮→浮层途中的空档），对齐「添加角色」入口交互。
  const addMenuTimer = useRef<number | null>(null)
  const cancelAddClose = (): void => {
    if (addMenuTimer.current !== null) {
      window.clearTimeout(addMenuTimer.current)
      addMenuTimer.current = null
    }
  }
  const scheduleAddClose = (): void => {
    cancelAddClose()
    addMenuTimer.current = window.setTimeout(() => setAddMenu(false), 140)
  }
  useEffect(() => cancelAddClose, [])

  // 新建自定义服务商后直接进入其详情编辑（addCustomProvider 已把它设为选中项）。
  // purpose 决定新建的是对话模型还是决策模型；建后收起浮动菜单。
  const onAddProvider = (purpose: ProviderPurpose): void => {
    cancelAddClose()
    setAddMenu(false)
    addCustomProvider(
      purpose === 'decision' ? t('models.newDecisionName') : t('models.newProviderName'),
      purpose
    )
    setView('detail')
  }

  const resetHost = (): void => {
    if (selectedProvider && seedHost) updateProvider(selectedProvider.id, { apiHost: seedHost })
    setTestState({ status: 'idle', message: '' })
  }

  const onHostBlur = (): void => {
    if (!selectedProvider) return
    const v = selectedProvider.apiHost.trim().replace(/\/+$/, '')
    if (v !== selectedProvider.apiHost) updateProvider(selectedProvider.id, { apiHost: v })
  }

  const runTest = async (): Promise<void> => {
    if (!selectedProvider) return
    if (!testModelId) {
      setTestState({ status: 'fail', message: t('models.testNeedModel') })
      return
    }
    // 测试用的是「已保存」的密钥（主进程解密），不是输入框草稿。
    // 若草稿里有未保存的密钥，先落盘再测；两者皆空时直接给出清晰提示，避免裸 401。
    const draft = keyDraft.trim()
    if (!draft && !hasKey(selectedProvider.id)) {
      setTestState({ status: 'fail', message: t('models.testNeedKey') })
      return
    }
    if (draft) await flushKey(selectedProvider.id)
    setTestState({ status: 'testing', message: '' })
    try {
      const r = await window.deva.provider.test({
        // 探针仅用于对话模型；此路径下 adapter 必属 LLM 三协议（决策模型无测试按钮）。
        adapter: selectedProvider.adapter as 'anthropic' | 'openai' | 'responses',
        providerId: selectedProvider.id,
        baseURL: selectedProvider.apiHost,
        model: testModelId
      })
      if (r.ok) {
        setTestState({ status: 'ok', message: r.latencyMs != null ? `${r.latencyMs}ms` : '' })
      } else {
        setTestState({ status: 'fail', message: r.message })
      }
    } catch (e) {
      setTestState({ status: 'fail', message: (e as Error)?.message ?? String(e) })
    }
  }

  // 决策模型专属连通性测试：走独立运行时（decision:test），不需要模型，只判密钥+地址是否可达。
  const runDecisionTest = async (): Promise<void> => {
    if (!selectedProvider) return
    const draft = keyDraft.trim()
    if (!draft && !hasKey(selectedProvider.id)) {
      setTestState({ status: 'fail', message: t('models.testNeedKey') })
      return
    }
    if (draft) await flushKey(selectedProvider.id)
    setTestState({ status: 'testing', message: '' })
    try {
      const r = await window.deva.decision.test({
        // 此路径下 provider 必为决策模型，adapter 属决策适配器（当前仅 'jev'）。
        adapter: selectedProvider.adapter as 'jev',
        providerId: selectedProvider.id,
        baseURL: selectedProvider.apiHost,
        threshold: selectedProvider.threshold ?? 0.6
      })
      if (r.ok) {
        setTestState({ status: 'ok', message: r.latencyMs != null ? `${r.latencyMs}ms` : '' })
      } else {
        setTestState({ status: 'fail', message: r.message })
      }
    } catch (e) {
      setTestState({ status: 'fail', message: (e as Error)?.message ?? String(e) })
    }
  }

  const startAddModel = (): void => {
    setAddingModel(true)
    setNewModelId('')
    setSelectedIds(new Set())
    if (!selectedProvider) return
    const token = ++fetchTokenRef.current
    setFetchState({ status: 'loading', list: [] })
    window.deva.provider
      .listModels({
        // 仅对话模型可拉取清单；决策模型无「模型清单」，不会走到此处。
        adapter: selectedProvider.adapter as 'anthropic' | 'openai' | 'responses',
        providerId: selectedProvider.id,
        baseURL: selectedProvider.apiHost
      })
      .then((r) => {
        if (token !== fetchTokenRef.current) return
        if (r.ok && r.models) setFetchState({ status: 'done', list: r.models })
        else setFetchState({ status: 'error', list: [] })
      })
      .catch(() => {
        if (token === fetchTokenRef.current) setFetchState({ status: 'error', list: [] })
      })
  }

  const closeAddModel = (): void => {
    setAddingModel(false)
    setNewModelId('')
    setSelectedIds(new Set())
  }

  const confirmAddModel = (explicitId?: string): void => {
    const id = (explicitId ?? newModelId).trim()
    if (id && selectedProvider) addModel(selectedProvider.id, id)
    closeAddModel()
  }

  // 切换某个候选模型的选择态（多选，不关闭面板）
  const toggleSel = (id: string): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 当前筛选出的候选是否已全选（空列表视为未全选）
  const allFilteredSelected =
    suggestions.length > 0 && suggestions.every((id) => selectedIds.has(id))

  // 全选 / 清空：仅作用于当前筛选出的候选
  const toggleSelectAll = (): void =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) suggestions.forEach((id) => next.delete(id))
      else suggestions.forEach((id) => next.add(id))
      return next
    })

  // 确认添加：有勾选则批量添加所选，否则回退到「手动输入的单个 id」
  const confirmAdd = (): void => {
    if (selectedIds.size > 0) {
      if (selectedProvider) addModels(selectedProvider.id, [...selectedIds])
      closeAddModel()
      return
    }
    confirmAddModel()
  }

  function clearKeyTimer(): void {
    if (keyTimerRef.current) {
      clearTimeout(keyTimerRef.current)
      keyTimerRef.current = null
    }
  }

  // 真正落盘：仅保存非空草稿（清空交由「清除」按钮，避免误删已配置密钥）。
  // 不清空 keyDraft（自动保存要边打字边存，清空会打断输入）；切换服务商时才清。
  const doSaveKey = async (providerId: string, value: string): Promise<void> => {
    const key = value.trim()
    if (!key) return
    setKeySaveState('saving')
    const res = await setApiKey(providerId, key)
    setKeySaveState(res.ok ? 'saved' : 'idle')
  }

  // 输入变化：更新草稿并防抖自动保存（~600ms）
  const onKeyChange = (providerId: string, value: string): void => {
    setKeyDraft(value)
    setKeySaveState('idle')
    clearKeyTimer()
    if (!value.trim()) return
    keyTimerRef.current = setTimeout(() => {
      keyTimerRef.current = null
      void doSaveKey(providerId, value)
    }, 600)
  }

  // 立即冲刷在途保存（失焦 / 回车 / 测试前调用）
  const flushKey = async (providerId: string): Promise<void> => {
    clearKeyTimer()
    await doSaveKey(providerId, keyDraft)
  }

  return (
    <div className="models">
      {view === 'list' || !selectedProvider ? (
        /* 列表态：扁平行列表，与通用/扩展页同构；右上角图标按钮新增服务商 */
        <>
          <div className="models__head">
            <h2 className="models__title">{t('models.providers')}</h2>
            <div
              className="models__addwrap"
              onMouseEnter={() => {
                cancelAddClose()
                setAddMenu(true)
              }}
              onMouseLeave={scheduleAddClose}
            >
              <button
                className="models__add-btn"
                title={t('models.addProvider')}
                aria-label={t('models.addProvider')}
                aria-haspopup="menu"
                aria-expanded={addMenu}
                onClick={() => setAddMenu(true)}
              >
                <Plus size={16} />
              </button>
              {addMenu && (
                <div className="cf-addmenu__pop cf-addmenu__pop--fit" role="menu">
                  <button
                    className="cf-addmenu__item"
                    role="menuitem"
                    onClick={() => onAddProvider('llm')}
                  >
                    <MessageSquare size={15} className="cf-addmenu__icon" />
                    <span>{t('models.addChatModel')}</span>
                  </button>
                  <button
                    className="cf-addmenu__item"
                    role="menuitem"
                    onClick={() => onAddProvider('decision')}
                  >
                    <Zap size={15} className="cf-addmenu__icon" />
                    <span>{t('models.addDecisionModel')}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="models__rows">
            {visibleProviders.length === 0 ? (
              <div className="model-list__empty">{t('models.noProvidersYet')}</div>
            ) : (
              visibleProviders.map(renderProviderRow)
            )}
          </div>
        </>
      ) : (
        /* 详情态：编辑单个服务商，顶部工具条「返回 + 删除/启用」同一行 */
        <section className="provider-detail" key={selectedProvider.id}>
          <div className="provider-detail__topbar">
            <button className="provider-detail__back" onClick={() => setView('list')}>
              <ChevronLeft size={16} />
              {t('common.back')}
            </button>
            <div className="provider-detail__spacer" />
            {selectedProvider.kind === 'custom' && (
              <button
                className="icon-btn provider-detail__del"
                title={t('models.deleteProvider')}
                onClick={() => void onDeleteProvider()}
              >
                <Trash2 size={15} />
              </button>
            )}
            <span className="provider-detail__enable">{t('models.enableProvider')}</span>
            <Switch
              checked={selectedProvider.enabled}
              onChange={(v) => updateProvider(selectedProvider.id, { enabled: v })}
            />
          </div>
          <header className="provider-detail__head">
            {selectedProvider.kind === 'custom' ? (
              <input
                className="provider-detail__name-input"
                size={1}
                value={nameDraft}
                placeholder={t('models.providerNamePlaceholder')}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            ) : (
              <h2 className="provider-detail__name">{selectedProvider.name}</h2>
            )}
            {/* 用途标签：对话模型 / 决策模型（取代官方/自定义标签，与列表行一致） */}
            <span
              className={`tag${selectedProvider.purpose === 'decision' ? ' tag--decision' : ''}`}
            >
              {selectedProvider.purpose === 'decision'
                ? t('models.tagDecision')
                : t('models.tagLLM')}
            </span>
          </header>

          {/* 已启用但未配置密钥 → 提醒（本地 Ollama 之类可无钥，此处仅作提示不阻断） */}
          {selectedProvider.enabled && !hasKey(selectedProvider.id) && (
            <div className="provider-warn">
              <AlertTriangle size={13} />
              {t('models.keyMissingWarn')}
            </div>
          )}

          {/* 供应商快速选择（仅自定义对话模型）：选官方预置一键套用地址/协议/模型清单。
              决策模型无 LLM 预置，故不显示。 */}
          {selectedProvider.kind === 'custom' && selectedProvider.purpose !== 'decision' && (
            <div className="field">
              <label className="field__label">{t('models.selectProvider')}</label>
              <div className="field__control">
                <select
                  className="input select-input"
                  value={presetSel}
                  onChange={(e) => void onPickPreset(e.target.value)}
                >
                  <option value="">{t('models.presetCustomOption')}</option>
                  {providerPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* 协议（仅自定义对话模型可切换；决策模型协议固定为 jev，不暴露选择） */}
          {selectedProvider.kind === 'custom' && selectedProvider.purpose !== 'decision' && (
            <div className="field">
              <label className="field__label">{t('models.adapter')}</label>
              <div className="field__control">
                <select
                  className="input select-input"
                  value={selectedProvider.adapter}
                  onChange={(e) =>
                    updateProvider(selectedProvider.id, {
                      adapter: e.target.value as ProviderAdapter
                    })
                  }
                >
                  <option value="openai">{t('models.adapterOpenAI')}</option>
                  <option value="responses">{t('models.adapterResponses')}</option>
                  <option value="anthropic">{t('models.adapterAnthropic')}</option>
                </select>
              </div>
            </div>
          )}

          {/* API 密钥（安全存储：只写不回显） */}
          <div className="field">
            <label className="field__label">
              {t('models.apiKey')}
              {keySaveState === 'saving' ? (
                <span className="key-status">{t('models.keySaving')}</span>
              ) : keySaveState === 'saved' ? (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('models.keySaved')}
                </span>
              ) : hasKey(selectedProvider.id) ? (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('models.keyConfigured')}
                </span>
              ) : null}
            </label>
            <div className="field__control">
              {/* 眼睛按钮内嵌输入框右侧 */}
              <div className="input-affix">
                <input
                  className="input input--affix-r"
                  type={showKey ? 'text' : 'password'}
                  placeholder={
                    hasKey(selectedProvider.id)
                      ? t('models.keyReplaceHint')
                      : t('models.apiKeyPlaceholder')
                  }
                  value={keyDraft}
                  disabled={!secretsAvailable}
                  onChange={(e) => onKeyChange(selectedProvider.id, e.target.value)}
                  onBlur={() => void flushKey(selectedProvider.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void flushKey(selectedProvider.id)
                  }}
                />
                <button
                  className="input-affix__btn"
                  title={showKey ? 'hide' : 'show'}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            {!secretsAvailable && <div className="field__warn">{t('models.secretsUnavailable')}</div>}
            {selectedProvider.docUrl && (
              <a className="field__hint-link" href={selectedProvider.docUrl} target="_blank" rel="noreferrer">
                {t('models.getKey')}
                <ExternalLink size={11} />
              </a>
            )}
          </div>

          {/* API 地址 + 测试连接 */}
          <div className="field">
            <label className="field__label">{t('models.apiHost')}</label>
            <div className="field__control">
              <input
                className="input"
                type="text"
                value={selectedProvider.apiHost}
                onChange={(e) => {
                  updateProvider(selectedProvider.id, { apiHost: e.target.value })
                  if (testState.status !== 'idle') setTestState({ status: 'idle', message: '' })
                }}
                onBlur={onHostBlur}
              />
              {seedHost && selectedProvider.apiHost !== seedHost && (
                <button className="icon-btn" title={t('models.resetHost')} onClick={resetHost}>
                  <RotateCcw size={14} />
                </button>
              )}
              {/* 连通性测试：对话模型走 provider:test（需模型），决策模型走 decision:test（独立运行时，无需模型） */}
              {selectedProvider.purpose !== 'decision' ? (
                <button
                  className="btn btn--ghost"
                  disabled={testState.status === 'testing'}
                  onClick={() => void runTest()}
                >
                  {testState.status === 'testing' ? (
                    <>
                      <Loader2 size={13} className="icon-spin" />
                      {t('models.testConnTesting')}
                    </>
                  ) : (
                    t('models.testConn')
                  )}
                </button>
              ) : (
                <button
                  className="btn btn--ghost"
                  disabled={testState.status === 'testing'}
                  onClick={() => void runDecisionTest()}
                >
                  {testState.status === 'testing' ? (
                    <>
                      <Loader2 size={13} className="icon-spin" />
                      {t('models.testConnTesting')}
                    </>
                  ) : (
                    t('models.testConn')
                  )}
                </button>
              )}
            </div>
            {testState.status === 'ok' && (
              <div className="test-result test-result--ok">
                <Check size={13} />
                {t('models.testConnOk')}
                {testState.message && ` · ${testState.message}`}
              </div>
            )}
            {testState.status === 'fail' && (
              <div className="test-result test-result--fail">
                <AlertTriangle size={13} />
                {t('models.testConnFail')}
                {testState.message && ` · ${testState.message}`}
              </div>
            )}
          </div>

          {/* 触发置信度阈值（仅决策模型）：发起动作的默认置信度门槛 [0,1] */}
          {selectedProvider.purpose === 'decision' && (
            <div className="field">
              <label className="field__label">{t('models.threshold')}</label>
              <div className="field__control">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={selectedProvider.threshold ?? 0.6}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    updateProvider(selectedProvider.id, {
                      threshold: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.6
                    })
                  }}
                />
              </div>
              <p className="field__note">{t('models.thresholdHint')}</p>
            </div>
          )}

          {/* 模型清单（仅对话模型：决策模型无「模型清单」概念） */}
          {selectedProvider.purpose !== 'decision' && (
          <div className="field">
            <div className="field__row-between">
              <label className="field__label">{t('models.modelList')}</label>
              {!addingModel && (
                <button className="btn btn--ghost btn--sm" onClick={startAddModel}>
                  <Plus size={14} />
                  {t('models.addModel')}
                </button>
              )}
            </div>

            {addingModel && (
              <div className="model-combo">
                <div className="model-add">
                  <input
                    className="input"
                    autoFocus
                    placeholder={t('models.pickOrType')}
                    value={newModelId}
                    onChange={(e) => setNewModelId(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmAdd()
                      if (e.key === 'Escape') closeAddModel()
                    }}
                  />
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={selectedIds.size === 0 && !newModelId.trim()}
                    onClick={confirmAdd}
                  >
                    <Check size={14} />
                    {selectedIds.size > 0
                      ? t('models.addSelected').replace('{count}', String(selectedIds.size))
                      : t('models.add')}
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={closeAddModel}>
                    <X size={14} />
                  </button>
                </div>

                {fetchState.status === 'loading' && (
                  <div className="model-combo__hint">
                    <Loader2 size={13} className="icon-spin" />
                    {t('models.fetchingModels')}
                  </div>
                )}
                {fetchState.status === 'error' && (
                  <div className="model-combo__hint">{t('models.fetchModelsFail')}</div>
                )}
                {fetchState.status === 'done' && suggestions.length > 0 && (
                  <>
                    <div className="model-combo__bar">
                      <span className="model-combo__count">
                        {t('models.selectedCount').replace('{count}', String(selectedIds.size))}
                      </span>
                      <div className="model-combo__spacer" />
                      <button
                        className="model-combo__link"
                        onMouseDown={(e) => {
                          e.preventDefault()
                          toggleSelectAll()
                        }}
                      >
                        {allFilteredSelected ? t('models.clearSelection') : t('models.selectAll')}
                      </button>
                    </div>
                    <div className="model-combo__panel">
                      {suggestions.map((id) => {
                        const on = selectedIds.has(id)
                        return (
                          <button
                            key={id}
                            className={`model-combo__opt${on ? ' is-selected' : ''}`}
                            onMouseDown={(e) => {
                              // onMouseDown 先于 input blur，避免点击丢失焦点
                              e.preventDefault()
                              toggleSel(id)
                            }}
                          >
                            <span className="model-combo__check">{on && <Check size={13} />}</span>
                            <span className="model-combo__opt-id">{id}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="model-list">
              {selectedProvider.models.length === 0 && !addingModel && (
                <div className="model-list__empty">{t('models.noModels')}</div>
              )}
              {selectedProvider.models.map((mo) => (
                <div key={mo.id} className="model-row">
                  <span className="model-row__name">{mo.name}</span>
                  {mo.tags?.map((tg) => (
                    <span key={tg} className="model-tag">
                      {tg}
                    </span>
                  ))}
                  <div className="model-row__spacer" />
                  <button
                    className="icon-btn model-row__act"
                    title={t('models.remove')}
                    onClick={() => removeModel(selectedProvider.id, mo.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                  <Switch
                    checked={mo.enabled}
                    onChange={() => toggleModel(selectedProvider.id, mo.id)}
                  />
                </div>
              ))}
            </div>
          </div>
          )}
        </section>
      )}
    </div>
  )
}
