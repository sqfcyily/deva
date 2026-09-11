import { getConfig } from './config'

/**
 * 模型引用解析（主进程）。子智能体可指定一个「已配置模型」运行，其引用格式与全局默认模型一致：
 * `"providerId:modelId"`（见 store/models.tsx 的 activeModelId 约定）。为空 / 不可解析时回落父轮模型
 * （即「跟随主对话」）。**永不抛错**——解析失败一律回落，保证子智能体总能开跑。
 *
 * 只读 `config.json` 的 `models.providers`（明文非敏感项）；API 密钥不在此解析——
 * 由 providers/index.ts 的 streamChat 按 providerId 于主进程内解密注入，密钥永不出主进程。
 */

/** 与 chat.ts 的 ChatModelConfig 结构一致（结构化兼容，避免跨文件耦合导入）。 */
export interface ResolvedModel {
  adapter: 'anthropic' | 'openai'
  providerId: string
  baseURL: string
  model: string
}

/** config.json 内存的服务商 / 模型形状（宽松读取，逐字段容错）。 */
interface StoredModelDef {
  id?: unknown
  enabled?: unknown
}
interface StoredProvider {
  id?: unknown
  adapter?: unknown
  apiHost?: unknown
  models?: unknown
}

/**
 * 把模型引用 `"providerId:modelId"` 解析为完整 ChatModelConfig。
 * - ref 为空 / 非法 / 找不到对应服务商或模型 → 返回 fallback（父轮模型，即「跟随主对话」）。
 * - providerId 可能自身含冒号？不会（服务商 id 由本应用生成，无冒号）；按首个冒号切分即可。
 */
export function resolveModelRef(
  ref: string | null | undefined,
  fallback: ResolvedModel
): ResolvedModel {
  if (!ref || typeof ref !== 'string') return fallback
  const idx = ref.indexOf(':')
  if (idx <= 0) return fallback
  const pid = ref.slice(0, idx).trim()
  const mid = ref.slice(idx + 1).trim()
  if (!pid || !mid) return fallback
  try {
    const models = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
    const provider = providers.find((p) => p && p.id === pid)
    if (!provider) return fallback
    const list = Array.isArray(provider.models) ? (provider.models as StoredModelDef[]) : []
    const model = list.find((m) => m && m.id === mid)
    if (!model || typeof model.id !== 'string') return fallback
    const adapter = provider.adapter === 'openai' ? 'openai' : 'anthropic'
    const baseURL = typeof provider.apiHost === 'string' ? provider.apiHost : ''
    return { adapter, providerId: pid, baseURL, model: model.id }
  } catch {
    return fallback
  }
}
