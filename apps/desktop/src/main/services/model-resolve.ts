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
  adapter: 'anthropic' | 'openai' | 'responses'
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
 * 严格解析 `"providerId:modelId"` → ResolvedModel；任何失败（空 / 非法 / 找不到 / 读配置异常）返回 null。
 * 供 resolveModelRef（有 fallback）与 resolveDefaultModel（无 fallback）共享的底座，永不抛错。
 * providerId 由本应用生成、无冒号，按首个冒号切分即可。
 */
function resolveRefStrict(ref: string | null | undefined): ResolvedModel | null {
  if (!ref || typeof ref !== 'string') return null
  const idx = ref.indexOf(':')
  if (idx <= 0) return null
  const pid = ref.slice(0, idx).trim()
  const mid = ref.slice(idx + 1).trim()
  if (!pid || !mid) return null
  try {
    const models = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
    const provider = providers.find((p) => p && p.id === pid)
    if (!provider) return null
    const list = Array.isArray(provider.models) ? (provider.models as StoredModelDef[]) : []
    const model = list.find((m) => m && m.id === mid)
    if (!model || typeof model.id !== 'string') return null
    const adapter =
      provider.adapter === 'openai'
        ? 'openai'
        : provider.adapter === 'responses'
          ? 'responses'
          : 'anthropic'
    const baseURL = typeof provider.apiHost === 'string' ? provider.apiHost : ''
    return { adapter, providerId: pid, baseURL, model: model.id }
  } catch {
    return null
  }
}

/**
 * 把模型引用 `"providerId:modelId"` 解析为完整 ChatModelConfig。
 * - ref 为空 / 非法 / 找不到对应服务商或模型 → 返回 fallback（父轮模型，即「跟随主对话」）。
 */
export function resolveModelRef(
  ref: string | null | undefined,
  fallback: ResolvedModel
): ResolvedModel {
  return resolveRefStrict(ref) ?? fallback
}

/**
 * 严格解析模型引用（无 fallback）：命中返回 ResolvedModel，空/非法/悬空返回 null。
 * 供定时任务密封执行「先试信封模型、失败再回落全局默认」的两段式选择：
 * `resolveModelRefOrNull(auth.modelRef) ?? resolveDefaultModel()`。
 */
export function resolveModelRefOrNull(ref: string | null | undefined): ResolvedModel | null {
  return resolveRefStrict(ref)
}

/**
 * 解析全局默认模型（`config.models.activeModelId`，即用户最近一次在对话输入框选定的模型）。
 * 供无父轮可回落的场景使用——典型是定时任务密封执行（task.auth.modelRef 为空时的回落）。
 * 无配置 / 悬空引用 → 返回 null（调度器据此记「未配置默认模型」错误，绝不崩溃）。
 */
export function resolveDefaultModel(): ResolvedModel | null {
  try {
    const models = (getConfig().models ?? {}) as { activeModelId?: unknown }
    const active = typeof models.activeModelId === 'string' ? models.activeModelId : null
    return resolveRefStrict(active)
  } catch {
    return null
  }
}
