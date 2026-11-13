import { getConfig } from './config'
import { isEffortLevel, type EffortLevel } from '../providers/types'
import { CONTEXT_WINDOW_RANGE, MAX_OUTPUT_RANGE, validLimit } from '../../shared/context'

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
  contextWindow?: unknown
  maxOutput?: unknown
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

/** 用户在模型详情页填写的上下文窗口 / 输出上限；未填即「自动」（见 shared/context.ts）。 */
export interface ModelOverrides {
  contextWindow?: number
  maxOutput?: number
}

/**
 * 读某模型的用户覆盖值（`config.models.providers[].models[]` 的 contextWindow / maxOutput）。
 * 按 providerId + 模型 ID 现查配置，主对话、子智能体、定时任务共用一处，改了即对下一次请求生效。
 * 未填 / 非法 / 找不到 → 对应字段缺省（= 自动），永不抛错。
 */
export function modelOverrides(providerId: string, modelId: string): ModelOverrides {
  try {
    const models = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
    const provider = providers.find((p) => p && p.id === providerId)
    const list = Array.isArray(provider?.models) ? (provider.models as StoredModelDef[]) : []
    const model = list.find((m) => m && m.id === modelId)
    if (!model) return {}
    const out: ModelOverrides = {}
    if (validLimit(model.contextWindow, CONTEXT_WINDOW_RANGE)) out.contextWindow = model.contextWindow
    if (validLimit(model.maxOutput, MAX_OUTPUT_RANGE)) out.maxOutput = model.maxOutput
    return out
  } catch {
    return {}
  }
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

/**
 * 解析全局「最近使用」思考等级（`config.models.activeEffort`，用户最近一次在对话输入框选定的档位）。
 * 供不经渲染层的发送（远程通道）给尚未定格思考等级的对话兜底。无配置 / 非法值 → 'default'（不发思考参数）。
 */
/**
 * 入站发送共用的模型解析链（审查 F3）：显式 modelRef → 会话快照 → 角色偏好 → 全局默认。
 * hub（IM）与 channel-server 调同一份，杜绝两处手写漂移。
 */
export function resolveModelRefForSend(opts: {
  explicitRef?: string | null
  sessionModel?: string | null
  personaModel?: string | null
}): ResolvedModel | null {
  return (
    (opts.explicitRef ? resolveModelRefOrNull(opts.explicitRef) : null) ??
    resolveModelRefOrNull(opts.sessionModel ?? null) ??
    resolveModelRefOrNull(opts.personaModel ?? null) ??
    resolveDefaultModel()
  )
}

export function resolveDefaultEffort(): EffortLevel {
  try {
    const models = (getConfig().models ?? {}) as { activeEffort?: unknown }
    return isEffortLevel(models.activeEffort) ? models.activeEffort : 'default'
  } catch {
    return 'default'
  }
}

export interface ListedModel {
  /** `"providerId:modelId"`，可直接用于 send 的 modelRef。 */
  ref: string
  /** 模型显示名。 */
  name: string
  /** 提供方显示名。 */
  provider: string
}

/**
 * 通道/设备端的只读模型清单。口径与 resolveRefStrict 一致：只看 id 是否可解析，不按 enabled 过滤
 * （提供方没配模型自然为空；密钥与 apiHost 不在此出——非敏感明文项）。
 */
export function listEnabledModels(): ListedModel[] {
  try {
    const models = (getConfig().models ?? {}) as { providers?: unknown }
    const providers = Array.isArray(models.providers) ? (models.providers as StoredProvider[]) : []
    const out: ListedModel[] = []
    for (const p of providers) {
      if (!p || typeof p.id !== 'string') continue
      const pname = typeof (p as { name?: unknown }).name === 'string' ? (p as { name: string }).name : p.id
      const list = Array.isArray(p.models) ? (p.models as StoredModelDef[]) : []
      for (const m of list) {
        if (!m || typeof m.id !== 'string') continue
        const mname = typeof (m as { name?: unknown }).name === 'string' ? (m as { name: string }).name : m.id
        out.push({ ref: `${p.id}:${m.id}`, name: mname, provider: pname })
      }
    }
    return out
  } catch {
    return []
  }
}

/** 当前全局默认模型引用（config 的 activeModelId；未配置返回 null）。 */
export function activeModelRef(): string | null {
  try {
    const models = (getConfig().models ?? {}) as { activeModelId?: unknown }
    return typeof models.activeModelId === 'string' && models.activeModelId ? models.activeModelId : null
  } catch {
    return null
  }
}
