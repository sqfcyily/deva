import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Eye,
  EyeOff,
  ExternalLink,
  Trash2,
  Check,
  X,
  Star,
  ShieldCheck,
  Loader2,
  RotateCcw,
  AlertTriangle
} from 'lucide-react'
import { useI18n } from '../../i18n/i18n'
import { useModels } from '../../store/models'
import { seedProviders, type ProviderAdapter } from '../../mock/models'
import { Switch } from './Switch'

/**
 * 模型设置页（设置 › 模型）。左侧服务商列表 + 右侧配置详情。
 * 支持官方与自定义（OpenAI / Anthropic 兼容）服务：配置密钥 / 协议 / 地址 / 模型清单，设默认模型，
 * 一键测试连通性，并可从服务端拉取模型清单辅助添加（支持手动输入与匹配选择）。
 */

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'
type FetchStatus = 'idle' | 'loading' | 'done' | 'error'

export function ModelSettings(): React.JSX.Element {
  const { t } = useI18n()
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
    removeProvider,
    activeModelId,
    setActiveModel,
    hasKey,
    setApiKey,
    secretsAvailable
  } = useModels()

  const [showKey, setShowKey] = useState(false)
  const [addingModel, setAddingModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  // 从服务端清单多选待添加的模型 id 集合（未落盘的选择态）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [keyDraft, setKeyDraft] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
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
    setKeyDraft('')
    setShowKey(false)
    setAddingModel(false)
    setNewModelId('')
    setSelectedIds(new Set())
    setNameDraft(selectedProvider?.name ?? '')
    setTestState({ status: 'idle', message: '' })
    setFetchState({ status: 'idle', list: [] })
    fetchTokenRef.current++
  }, [selectedProviderId]) // eslint-disable-line react-hooks/exhaustive-deps

  const seedHost = useMemo(
    () => seedProviders.find((p) => p.id === selectedProviderId)?.apiHost,
    [selectedProviderId]
  )

  // 测试所用模型：优先默认模型（若属于本服务商），否则首个启用的，再否则第一个
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

  const commitName = (): void => {
    if (!selectedProvider) return
    const v = nameDraft.trim()
    const next = v || t('models.newProviderName')
    if (next !== selectedProvider.name) updateProvider(selectedProvider.id, { name: next })
    if (!v) setNameDraft(next)
  }

  const onDeleteProvider = (): void => {
    if (!selectedProvider) return
    if (window.confirm(t('models.deleteProviderConfirm'))) removeProvider(selectedProvider.id)
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
    if (draft) await saveKey(selectedProvider.id)
    setTestState({ status: 'testing', message: '' })
    try {
      const r = await window.deva.provider.test({
        adapter: selectedProvider.adapter,
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

  const startAddModel = (): void => {
    setAddingModel(true)
    setNewModelId('')
    setSelectedIds(new Set())
    if (!selectedProvider) return
    const token = ++fetchTokenRef.current
    setFetchState({ status: 'loading', list: [] })
    window.deva.provider
      .listModels({
        adapter: selectedProvider.adapter,
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

  const saveKey = async (providerId: string): Promise<void> => {
    const key = keyDraft.trim()
    if (!key) return
    setSavingKey(true)
    try {
      await setApiKey(providerId, key)
      setKeyDraft('')
      setShowKey(false)
    } finally {
      setSavingKey(false)
    }
  }

  const clearKey = async (providerId: string): Promise<void> => {
    setSavingKey(true)
    try {
      await setApiKey(providerId, '')
      setKeyDraft('')
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div className="models">
      {/* 左：服务商列表 */}
      <aside className="models__list">
        <div className="models__list-title">{t('models.providers')}</div>
        <div className="models__list-scroll">
          {providers.map((p) => (
            <button
              key={p.id}
              className={`provider-row${p.id === selectedProviderId ? ' is-active' : ''}`}
              onClick={() => selectProvider(p.id)}
            >
              <span className="provider-row__dot" style={{ background: p.accent }} />
              <span className="provider-row__name">{p.name}</span>
              {p.enabled && !hasKey(p.id) && (
                <AlertTriangle className="provider-row__warn" size={13} />
              )}
              {p.enabled && <span className="provider-row__on" />}
            </button>
          ))}
        </div>
        <button className="models__add" onClick={() => addCustomProvider(t('models.newProviderName'))}>
          <Plus size={15} />
          {t('models.addProvider')}
        </button>
      </aside>

      {/* 右：配置详情 */}
      {selectedProvider ? (
        <section className="provider-detail" key={selectedProvider.id}>
          <header className="provider-detail__head">
            <span className="provider-detail__dot" style={{ background: selectedProvider.accent }} />
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
            <span className={`tag${selectedProvider.kind === 'official' ? ' tag--official' : ''}`}>
              {selectedProvider.kind === 'official' ? t('models.official') : t('models.custom')}
            </span>
            <div className="provider-detail__spacer" />
            {selectedProvider.kind === 'custom' && (
              <button
                className="icon-btn provider-detail__del"
                title={t('models.deleteProvider')}
                onClick={onDeleteProvider}
              >
                <Trash2 size={15} />
              </button>
            )}
            <span className="provider-detail__enable">{t('models.enableProvider')}</span>
            <Switch
              checked={selectedProvider.enabled}
              onChange={(v) => updateProvider(selectedProvider.id, { enabled: v })}
            />
          </header>

          {/* 已启用但未配置密钥 → 提醒（本地 Ollama 之类可无钥，此处仅作提示不阻断） */}
          {selectedProvider.enabled && !hasKey(selectedProvider.id) && (
            <div className="provider-warn">
              <AlertTriangle size={13} />
              {t('models.keyMissingWarn')}
            </div>
          )}

          {/* 协议（仅自定义服务商可切换） */}
          {selectedProvider.kind === 'custom' && (
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
                  <option value="anthropic">{t('models.adapterAnthropic')}</option>
                </select>
              </div>
            </div>
          )}

          {/* API 密钥（安全存储：只写不回显） */}
          <div className="field">
            <label className="field__label">
              {t('models.apiKey')}
              {hasKey(selectedProvider.id) && (
                <span className="key-status">
                  <ShieldCheck size={12} />
                  {t('models.keyConfigured')}
                </span>
              )}
            </label>
            <div className="field__control">
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                placeholder={
                  hasKey(selectedProvider.id)
                    ? t('models.keyReplaceHint')
                    : t('models.apiKeyPlaceholder')
                }
                value={keyDraft}
                disabled={!secretsAvailable}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveKey(selectedProvider.id)
                }}
              />
              <button
                className="icon-btn"
                title={showKey ? 'hide' : 'show'}
                onClick={() => setShowKey((v) => !v)}
              >
                {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button
                className="btn btn--primary btn--sm"
                disabled={!keyDraft.trim() || savingKey || !secretsAvailable}
                onClick={() => void saveKey(selectedProvider.id)}
              >
                {t('models.saveKey')}
              </button>
              {hasKey(selectedProvider.id) && (
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={savingKey}
                  onClick={() => void clearKey(selectedProvider.id)}
                >
                  {t('models.clearKey')}
                </button>
              )}
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

          {/* 模型清单 */}
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
              {selectedProvider.models.map((mo) => {
                const isDefault = activeModelId === `${selectedProvider.id}:${mo.id}`
                return (
                  <div key={mo.id} className={`model-row${isDefault ? ' is-default' : ''}`}>
                    <span className="model-row__name">{mo.name}</span>
                    {mo.tags?.map((tg) => (
                      <span key={tg} className="model-tag">
                        {tg}
                      </span>
                    ))}
                    {isDefault && <span className="model-row__default">{t('models.default')}</span>}
                    <div className="model-row__spacer" />
                    <button
                      className="icon-btn model-row__act"
                      title={t('models.setDefault')}
                      onClick={() => setActiveModel(selectedProvider.id, mo.id)}
                    >
                      <Star size={14} fill={isDefault ? 'currentColor' : 'none'} />
                    </button>
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
                )
              })}
            </div>
          </div>
        </section>
      ) : (
        <section className="provider-detail provider-detail--empty">{t('models.empty')}</section>
      )}
    </div>
  )
}
