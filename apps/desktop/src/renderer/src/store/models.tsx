import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { seedProviders, type Provider, type ModelDef } from '../mock/models'

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
  /** 全局默认模型："providerId:modelId" */
  activeModelId: string | null
  activeModel: { provider: Provider; model: ModelDef } | null
  setActiveModel: (providerId: string, modelId: string) => void
  updateProvider: (
    id: string,
    patch: Partial<Pick<Provider, 'name' | 'apiHost' | 'enabled' | 'adapter'>>
  ) => void
  toggleModel: (providerId: string, modelId: string) => void
  addModel: (providerId: string, id: string) => void
  removeModel: (providerId: string, modelId: string) => void
  addCustomProvider: (name: string) => void
  /** 删除服务商（含其密钥、悬空默认模型的清理）。 */
  removeProvider: (id: string) => void
  // 密钥（安全存储，不回显明文）
  hasKey: (providerId: string) => boolean
  setApiKey: (providerId: string, key: string) => Promise<{ ok: boolean; available: boolean }>
  /** 当前环境是否支持加密存储（否则拒绝保存密钥，UI 需降级提示） */
  secretsAvailable: boolean
}

const ModelsContext = createContext<ModelsContextValue | null>(null)

function findActive(providers: Provider[], activeId: string | null) {
  if (!activeId) return null
  const [pid, mid] = activeId.split(':')
  const provider = providers.find((p) => p.id === pid)
  const model = provider?.models.find((mm) => mm.id === mid)
  return provider && model ? { provider, model } : null
}

export function ModelsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>(() =>
    seedProviders.map((p) => ({ ...p, models: p.models.map((mm) => ({ ...mm })) }))
  )
  const [selectedProviderId, setSelectedProviderId] = useState<string>(seedProviders[0].id)
  const [activeModelId, setActiveModelId] = useState<string | null>('anthropic:claude-3-7-sonnet')

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
          | { providers?: Provider[]; activeModelId?: string | null }
          | undefined
        if (!alive) return
        const savedProviders = saved?.providers
        if (Array.isArray(savedProviders) && savedProviders.length > 0) {
          // 已保存的为准，并追加用户尚未见过的新内置服务商（保留用户编辑 + 呈现新预置）
          const savedIds = new Set(savedProviders.map((p) => p.id))
          const merged = [...savedProviders, ...seedProviders.filter((p) => !savedIds.has(p.id))]
          setProviders(merged.map((p) => ({ ...p, models: p.models.map((mm) => ({ ...mm })) })))
        }
        if (saved && 'activeModelId' in saved) setActiveModelId(saved.activeModelId ?? null)
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
    void window.deva.config.set({ models: { providers, activeModelId } })
  }, [hydrated, providers, activeModelId])

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
      addModel: (pid, id) =>
        patchProvider(pid, (p) =>
          p.models.some((mm) => mm.id === id)
            ? p
            : { ...p, models: [...p.models, { id, name: id, enabled: true }] }
        ),
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
      addCustomProvider: (name) => {
        const id = `custom-${Date.now()}`
        setProviders((list) => [
          ...list,
          {
            id,
            name: name || '自定义服务商',
            kind: 'custom',
            accent: '#8a8a94',
            adapter: 'openai',
            apiHost: 'https://',
            enabled: false,
            models: []
          }
        ])
        setSelectedProviderId(id)
      },
      hasKey: (providerId) => Boolean(keyStatus[providerId]),
      setApiKey: async (providerId, key) => {
        const res = await window.deva.secrets.set(providerId, key)
        if (res.ok) setKeyStatus((s) => ({ ...s, [providerId]: Boolean(key) }))
        return res
      },
      secretsAvailable
    }),
    [providers, selectedProviderId, activeModelId, keyStatus, secretsAvailable]
  )

  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>
}

export function useModels(): ModelsContextValue {
  const ctx = useContext(ModelsContext)
  if (!ctx) throw new Error('useModels 必须在 ModelsProvider 内使用')
  return ctx
}
