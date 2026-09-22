/**
 * 模型服务商与模型的种子数据。
 * 模型能力为全局配置，与项目无关（切换项目不变）。
 * 官方服务商只预置连接信息（不内置模型），模型由用户拉取或手动添加；也可「添加提供方」接入 OpenAI 兼容的自定义服务。
 * 密钥不在此存放——由主进程 safeStorage 加密保存（见 store/models 的 secrets 接线）。
 * adapter 决定走哪套协议：Anthropic Messages（'anthropic'）、OpenAI Chat Completions（'openai'，兼容绝大多数），
 * 或 OpenAI Responses（'responses'，OpenAI 官方新接口）。
 */

export interface ModelDef {
  /** 传给 API 的模型 ID，如 gpt-4o */
  id: string
  /** 展示名 */
  name: string
  /** 能力标签，如 视觉 / 推理 / 长上下文 */
  tags?: string[]
  enabled: boolean
}

// 协议适配器。前三者为对话/写作模型（LLM，走 streamChat）；'jev' 为决策模型厂商（TypeSafe·Jev），
// 走独立的 services/decision.ts 决策运行时（Phase 2），绝不进 LLM 的 streamChat / 对话选择器。
export type ProviderAdapter = 'anthropic' | 'openai' | 'responses' | 'jev'

// 能力用途（与 official/custom 正交的一根主轴）：
//  · 'llm'      对话/写作模型——参与对话生成、被对话与任务的模型选择器选取；
//  · 'decision' 决策模型（如 System One / Jev）——只产出「是否该做某事」的类型化概率决策，
//               不生成文本、不参与对话，故永不出现在对话/写作选择器里。
// 缺省视为 'llm'（向后兼容既有 config.json 中未带该字段的服务商）。
export type ProviderPurpose = 'llm' | 'decision'

export interface Provider {
  id: string
  name: string
  kind: 'official' | 'custom'
  /** 能力用途（缺省 = 'llm'）。决策模型与对话模型分组呈现、互不串用。 */
  purpose?: ProviderPurpose
  /** 品牌色圆点 */
  accent: string
  /** 归一化协议适配器 */
  adapter: ProviderAdapter
  /** API 基础地址（Base URL） */
  apiHost: string
  /** 获取密钥的文档地址 */
  docUrl?: string
  enabled: boolean
  /**
   * 决策模型专用：发起动作（如主动发起对话）的默认置信度阈值 [0,1]。
   * 仅 purpose==='decision' 有意义；定时任务的决策闸门以此为默认，可按任务覆盖（Phase 3）。
   */
  threshold?: number
  models: ModelDef[]
}

// 官方服务商只预置「连接信息」（地址/协议/文档），不再内置任何模型。
// 模型清单由用户配置密钥后从服务端拉取，或手动输入模型 ID 添加——避免内置清单很快过时。
export const seedProviders: Provider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'official',
    accent: '#d97757',
    adapter: 'anthropic',
    apiHost: 'https://api.anthropic.com',
    docUrl: 'https://console.anthropic.com/settings/keys',
    enabled: false,
    models: []
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'official',
    accent: '#10a37f',
    adapter: 'openai',
    apiHost: 'https://api.openai.com/v1',
    docUrl: 'https://platform.openai.com/api-keys',
    enabled: false,
    models: []
  },
  {
    // OpenAI 官方新接口（/responses）。与上方 Chat Completions 同址、同密钥，仅协议不同。
    id: 'openai-responses',
    name: 'OpenAI · Responses',
    kind: 'official',
    accent: '#10a37f',
    adapter: 'responses',
    apiHost: 'https://api.openai.com/v1',
    docUrl: 'https://platform.openai.com/api-keys',
    enabled: false,
    models: []
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'official',
    accent: '#4285f4',
    adapter: 'openai',
    apiHost: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docUrl: 'https://aistudio.google.com/apikey',
    enabled: false,
    models: []
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'official',
    accent: '#4d6bfe',
    adapter: 'openai',
    apiHost: 'https://api.deepseek.com',
    docUrl: 'https://platform.deepseek.com/api_keys',
    enabled: false,
    models: []
  },
  {
    id: 'moonshot',
    name: 'Moonshot · Kimi',
    kind: 'official',
    accent: '#16a085',
    adapter: 'openai',
    apiHost: 'https://api.moonshot.cn/v1',
    docUrl: 'https://platform.moonshot.cn/console/api-keys',
    enabled: false,
    models: []
  },
  {
    id: 'zhipu',
    name: '智谱 · GLM',
    kind: 'official',
    accent: '#3859ff',
    adapter: 'openai',
    apiHost: 'https://open.bigmodel.cn/api/paas/v4',
    docUrl: 'https://bigmodel.cn/usercenter/apikeys',
    enabled: false,
    models: []
  },
  {
    id: 'qwen',
    name: '通义千问 · Qwen',
    kind: 'official',
    accent: '#615ced',
    adapter: 'openai',
    apiHost: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docUrl: 'https://bailian.console.aliyun.com/',
    enabled: false,
    models: []
  },
  {
    id: 'ollama',
    name: 'Ollama · 本地',
    kind: 'official',
    accent: '#71717a',
    adapter: 'openai',
    apiHost: 'http://localhost:11434/v1',
    docUrl: 'https://ollama.com/library',
    enabled: false,
    models: []
  },
  {
    // 决策模型（TypeSafe · Jev / System One）：状态 + 类型化问题 → 类型化概率决策，
    // 非 LLM、无文本流式。独立于对话/写作模型：绝不进对话选择器，运行时走 services/decision.ts（Phase 2）。
    // apiHost / docUrl 为可编辑默认值（用户在设置页按自己的接入信息调整）。
    id: 'typesafe',
    name: 'TypeSafe · Jev',
    kind: 'official',
    purpose: 'decision',
    accent: '#6d5efc',
    adapter: 'jev',
    apiHost: 'https://api.typesafe.ai',
    docUrl: 'https://console.typesafe.ai',
    enabled: false,
    threshold: 0.6,
    models: []
  }
]

/**
 * 官方供应商预置目录：供编辑页「供应商」下拉一键套用（名称/协议/地址/文档）。
 * 只带连接信息、不带模型——模型仍由用户拉取或手动添加。
 * 与列表态解耦：列表只呈现已启用或已配密钥的，其余官方藏进此下拉。
 */
export const providerPresets: Provider[] = seedProviders.filter(
  (p) => p.kind === 'official' && (p.purpose ?? 'llm') === 'llm'
)
