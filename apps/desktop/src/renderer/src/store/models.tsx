import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { seedProviders, type Provider, type ModelDef, type ProviderPurpose } from '../mock/models'
import type { EffortLevel } from '../../../preload'

/**
 * 模型配置（全局，与项目无关）。
 * 服务商清单/模型/默认模型为内存状态（种子来自 mock/models）；
 * **API 密钥不进渲染层**——只经 window.deva.secrets 交主进程加密保存，这里仅持有「是否已配置」的布尔态。
 */
interface ModelsContextValue {
  providers: Provider[]
  selectedProviderId: string
  selectedProvider: Provider | undefined
  selectProvider: (id: string) => void
  /**
   * 最近使用的模型 "providerId:modelId"——本应用不设显式「默认模型」，
   * 用户最后一次在对话输入框切换的模型即充当**新对话未选时的默认**（兜底回落）。
   */
  activeModelId: string | null
  activeModel: { provider: Provider; model: ModelDef } | null
  /** 记录一次模型选择为「最近使用」（由对话输入框的模型选择器调用）。 */
  setActiveModel: (providerId: string, modelId: string) => void
  /** 最近使用的思考等级（同 activeModelId：充当尚未定格思考等级的对话的默认）。 */
  activeEffort: EffortLevel
  /** 记录一次思考等级选择为「最近使用」（由对话输入框的思考等级选择器调用）。 */
  setActiveEffort: (level: EffortLevel) => void
  updateProvider: (
    id: string,
    patch: Partial<Pick<Provider, 'name' | 'apiHost' | 'enabled' | 'adapter' | 'threshold'>>
  ) => void
  toggleModel: (providerId: string, modelId: string) => void
  /** 改单个模型的显示名 / 上下文窗口 / 输出上限（模型详情页）；值为 undefined 即恢复自动。 */
  updateModel: (
    providerId: string,
    modelId: string,
    patch: Partial<Pick<ModelDef, 'name' | 'contextWindow' | 'maxOutput'>>
  ) => void
  addModel: (providerId: string, id: string) => void
  /** 批量添加模型：去重并跳过已存在，一次落盘。用于从服务端清单多选添加。 */
  addModels: (providerId: string, ids: string[]) => void
  removeModel: (providerId: string, modelId: string) => void
  /**
   * 新建自定义服务商。purpose 决定其能力轴：
   * 'llm'（默认）= 对话模型（adapter openai，可切协议）；
   * 'decision' = 决策模型（adapter 固定 jev，带默认触发阈值，不生成文本、不入对话选择器）。
   * 返回新服务商 id（对话区「接入模型」引导据此写入地址/密钥/模型）。
   */
  addCustomProvider: (name: string, purpose?: ProviderPurpose) => string
  /**
   * 用官方预置一键套用到某个（自定义）服务商：覆盖名称/协议/地址/文档/品牌色，并替换模型清单。
   * 不改 kind（保持自定义）与 enabled（是否启用交由用户），也不动密钥。
   */
  applyPreset: (providerId: string, preset: Provider) => void
  /** 删除服务商（含其密钥、悬空默认模型的清理）。 */
  removeProvider: (id: string) => void
  // 密钥（安全存储，不回显明文）
  hasKey: (providerId: string) => boolean
  setApiKey: (providerId: string, key: string) => Promise<{ ok: boolean; available: boolean }>
  /** 当前环境是否支持加密存储（否则拒绝保存密钥，UI 需降级提示） */
  secretsAvailable: boolean
  /** 持久化配置是否已载入：之前 providers 只是种子（无模型），据此判「无可用模型」会在启动瞬间误判。 */
  ready: boolean
}

const ModelsContext = createContext<ModelsContextValue | null>(null)

export function findActive(providers: Provider[], activeId: string | null) {
  if (!activeId) return null
  // 按首个冒号切分：providerId 由本应用生成、无冒号，而模型 id 可以带冒号（Ollama 的 `qwen3:8b`），
  // 不能 split(':') 解构——那样 mid 只剩 `qwen3`，解析失败即误报「尚未选择模型」。
  const idx = activeId.indexOf(':')
  if (idx <= 0) return null
  const pid = activeId.slice(0, idx)
  const mid = activeId.slice(idx + 1)
  const provider = providers.find((p) => p.id === pid)
  const model = provider?.models.find((mm) => mm.id === mid)
  return provider && model ? { provider, model } : null
}

/** 是否至少有一个可在对话里选用的模型（已启用的对话服务商 × 已启用模型；与输入框模型选择器同口径）。 */
export function hasUsableModel(providers: Provider[]): boolean {
  return providers.some(
    (p) => p.enabled && (p.purpose ?? 'llm') === 'llm' && p.models.some((mm) => mm.enabled)
  )
}

// config.json 允许手改，也有外部工具写入，载入时逐条整理：格式不对的只丢这一条。
// 若任由某条抛错，载入会落到兜底，随后默认种子回写，用户全部服务商与模型都被清掉。
function normalizeModel(raw: unknown): ModelDef | null {
  const mm = raw as Partial<ModelDef> | null
  if (!mm || typeof mm !== 'object' || typeof mm.id !== 'string' || !mm.id) return null
  return {
    ...mm,
    id: mm.id,
    name: typeof mm.name === 'string' ? mm.name : mm.id,
    enabled: mm.enabled === true
  }
}

function normalizeProvider(raw: unknown): Provider | null {
  const p = raw as Partial<Provider> | null
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) return null
  const models = Array.isArray(p.models) ? (p.models as unknown[]) : []
  return {
    ...p,
    id: p.id,
    name: typeof p.name === 'string' ? p.name : p.id,
    apiHost: typeof p.apiHost === 'string' ? p.apiHost : '',
    enabled: p.enabled === true,
    models: models.map(normalizeModel).filter((mm): mm is ModelDef => mm !== null)
  } as Provider
}

export function ModelsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>(() =>
    seedProviders.map((p) => ({ ...p, purpose: p.purpose ?? 'llm', models: p.models.map((mm) => ({ ...mm })) }))
  )
  const [selectedProviderId, setSelectedProviderId] = useState<string>(seedProviders[0].id)
  // 不内置默认模型，也不设显式「默认」入口：新用户首次在对话输入框选择模型后即记为「最近使用」，
  // 之后新对话默认沿用它（在此之前对话顶部显示「选择模型」）。
  const [activeModelId, setActiveModelId] = useState<string | null>(null)
  const [activeEffort, setActiveEffort] = useState<EffortLevel>('default')

  // providerId -> 是否已配置密钥；以及加密是否可用
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [secretsAvailable, setSecretsAvailable] = useState(true)

  // 配置载入完成前不回写，避免用默认种子覆盖已存 ~/.deva/config.json
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [ids, available] = await Promise.all([
          window.deva.secrets.list(),
          window.deva.secrets.available()
        ])
        if (!alive) return
        setKeyStatus(Object.fromEntries(ids.map((id) => [id, true])))
        setSecretsAvailable(available)
      } catch {
        /* 首次运行或不可用：保持空态 */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 载入持久化的模型配置（~/.deva/config.json 的 models 段），与默认种子合并
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await window.deva.config.get()
        const saved = cfg?.models as
          | { providers?: unknown; activeModelId?: unknown; activeEffort?: EffortLevel }
          | undefined
        if (!alive) return
        const savedProviders = Array.isArray(saved?.providers)
          ? saved.providers.map(normalizeProvider).filter((p): p is Provider => p !== null)
          : []
        if (savedProviders.length > 0) {
          // 已保存的为准，并追加用户尚未见过的新内置服务商（保留用户编辑 + 呈现新预置，
          // 含新引入的决策模型 typesafe——老配置无该项时自动补齐）。
          const savedIds = new Set(savedProviders.map((p) => p.id))
          const merged = [...savedProviders, ...seedProviders.filter((p) => !savedIds.has(p.id))]
          // 向后兼容：既有配置里未带 purpose 的服务商一律视为对话模型（'llm'），显式落定以便持久化。
          setProviders(
            merged.map((p) => ({
              ...p,
              purpose: p.purpose ?? 'llm',
              models: p.models.map((mm) => ({ ...mm }))
            }))
          )
        }
        if (saved && 'activeModelId' in saved)
          setActiveModelId(typeof saved.activeModelId === 'string' ? saved.activeModelId : null)
        if (saved?.activeEffort) setActiveEffort(saved.activeEffort)
      } catch {
        /* 无配置 / 读取失败：沿用默认种子 */
      } finally {
        if (alive) setHydrated(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 变更后回写（仅在 hydrate 之后）。密钥不在此列——始终只在主进程加密存储。
  useEffect(() => {
    if (!hydrated) return
    // models 段整块替换（config:set 只做顶层浅合并），新增的兄弟字段必须一并写，漏写即被清掉。
    void window.deva.config.set({ models: { providers, activeModelId, activeEffort } })
  }, [hydrated, providers, activeModelId, activeEffort])

  const patchProvider = (id: string, fn: (p: Provider) => Provider): void =>
    setProviders((list) => list.map((p) => (p.id === id ? fn(p) : p)))

  const value = useMemo<ModelsContextValue>(
    () => ({
      providers,
      selectedProviderId,
      selectedProvider: providers.find((p) => p.id === selectedProviderId),
      selectProvider: setSelectedProviderId,
      activeModelId,
      activeModel: findActive(providers, activeModelId),
      setActiveModel: (pid, mid) => setActiveModelId(`${pid}:${mid}`),
      activeEffort,
      setActiveEffort,
      updateProvider: (id, patch) => {
        patchProvider(id, (p) => ({ ...p, ...patch }))
        // 禁用服务商时，若默认模型属于它则清空，避免对话页指向不可用模型
        if (patch.enabled === false) {
          setActiveModelId((cur) => (cur && cur.split(':')[0] === id ? null : cur))
        }
      },
      toggleModel: (pid, mid) =>
        patchProvider(pid, (p) => ({
          ...p,
          models: p.models.map((mm) => (mm.id === mid ? { ...mm, enabled: !mm.enabled } : mm))
        })),
      updateModel: (pid, mid, patch) =>
        patchProvider(pid, (p) => ({
          ...p,
          models: p.models.map((mm) => {
            if (mm.id !== mid) return mm
            const next = { ...mm, ...patch }
            // 恢复自动：删键而不是留 undefined，落盘的配置里不残留空字段。
            if (next.contextWindow === undefined) delete next.contextWindow
            if (next.maxOutput === undefined) delete next.maxOutput
            return next
          })
        })),
      // 新增模型即启用：模型本身 enabled:true，并顺带启用所属服务商
      //（服务商被禁用则模型不可用），使刚添加的模型立即可选。
      addModel: (pid, id) =>
        patchProvider(pid, (p) =>
          p.models.some((mm) => mm.id === id)
            ? p
            : { ...p, enabled: true, models: [...p.models, { id, name: id, enabled: true }] }
        ),
      addModels: (pid, ids) =>
        patchProvider(pid, (p) => {
          const have = new Set(p.models.map((mm) => mm.id))
          const fresh: ModelDef[] = []
          for (const raw of ids) {
            const id = raw.trim()
            if (!id || have.has(id)) continue // 跳过空串、已存在、以及本批次内重复
            have.add(id)
            fresh.push({ id, name: id, enabled: true })
          }
          return fresh.length ? { ...p, enabled: true, models: [...p.models, ...fresh] } : p
        }),
      removeModel: (pid, mid) => {
        patchProvider(pid, (p) => ({ ...p, models: p.models.filter((mm) => mm.id !== mid) }))
        // 删掉的正是默认模型 → 清空默认，避免悬空
        setActiveModelId((cur) => (cur === `${pid}:${mid}` ? null : cur))
      },
      removeProvider: (id) => {
        // 一并清理密钥、选中项与悬空默认模型；密钥删除交主进程（明文不经渲染层）
        void window.deva.secrets.delete(id)
        setProviders((list) => list.filter((p) => p.id !== id))
        setSelectedProviderId((cur) => {
          if (cur !== id) return cur
          const remaining = providers.filter((p) => p.id !== id)
          return remaining[0]?.id ?? ''
        })
        setActiveModelId((cur) => (cur && cur.split(':')[0] === id ? null : cur))
        setKeyStatus((s) => {
          const next = { ...s }
          delete next[id]
          return next
        })
      },
      applyPreset: (pid, preset) =>
        patchProvider(pid, (p) => ({
          ...p,
          name: preset.name,
          apiHost: preset.apiHost,
          adapter: preset.adapter,
          accent: preset.accent,
          docUrl: preset.docUrl,
          // 深拷贝预置模型，避免与预置目录共享引用
          models: preset.models.map((mm) => ({ ...mm }))
        })),
      addCustomProvider: (name, purpose = 'llm') => {
        const id = `custom-${Date.now()}`
        const isDecision = purpose === 'decision'
        setProviders((list) => [
          ...list,
          {
            id,
            name: name || (isDecision ? '自定义决策模型' : '自定义服务商'),
            kind: 'custom',
            purpose,
            accent: isDecision ? '#6d5efc' : '#8a8a94',
            // 决策模型仅有 jev 一种协议（不生成文本，走独立决策运行时）；对话模型默认 OpenAI 兼容。
            adapter: isDecision ? 'jev' : 'openai',
            apiHost: 'https://',
            enabled: false,
            ...(isDecision ? { threshold: 0.6 } : {}),
            models: []
          }
        ])
        setSelectedProviderId(id)
        return id
      },
      hasKey: (providerId) => Boolean(keyStatus[providerId]),
      setApiKey: async (providerId, key) => {
        const res = await window.deva.secrets.set(providerId, key)
        if (res.ok) {
          setKeyStatus((s) => ({ ...s, [providerId]: Boolean(key) }))
          // 填入密钥即自动启用该服务商，省去手动开关（清空密钥不动启用态）
          if (key) patchProvider(providerId, (p) => (p.enabled ? p : { ...p, enabled: true }))
        }
        return res
      },
      secretsAvailable,
      ready: hydrated
    }),
    [providers, selectedProviderId, activeModelId, activeEffort, keyStatus, secretsAvailable, hydrated]
  )

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
}

export function useModels(): ModelsContextValue {
  const ctx = useContext(ModelsContext)
  if (!ctx) throw new Error('useModels 必须在 ModelsProvider 内使用')
  return ctx
}
