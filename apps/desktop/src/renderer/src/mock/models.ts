/**
 * 模型服务商与模型的种子数据。
 * 模型能力为全局配置，与项目无关（切换项目不变）。
 * 官方服务商预置常见模型，用户可增删；也可「添加提供方」接入 OpenAI 兼容的自定义服务。
 * 密钥不在此存放——由主进程 safeStorage 加密保存（见 store/models 的 secrets 接线）。
 * adapter 决定走哪套协议：Anthropic Messages（'anthropic'）或 OpenAI Chat Completions（'openai'，兼容绝大多数）。
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

export type ProviderAdapter = 'anthropic' | 'openai'

export interface Provider {
  id: string
  name: string
  kind: 'official' | 'custom'
  /** 品牌色圆点 */
  accent: string
  /** 归一化协议适配器 */
  adapter: ProviderAdapter
  /** API 基础地址（Base URL） */
  apiHost: string
  /** 获取密钥的文档地址 */
  docUrl?: string
  enabled: boolean
  models: ModelDef[]
}

const m = (id: string, name: string, enabled: boolean, tags?: string[]): ModelDef => ({
  id,
  name,
  enabled,
  tags
})

export const seedProviders: Provider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'official',
    accent: '#d97757',
    adapter: 'anthropic',
    apiHost: 'https://api.anthropic.com',
    docUrl: 'https://console.anthropic.com/settings/keys',
    enabled: true,
    models: [
      m('claude-3-7-sonnet', 'Claude 3.7 Sonnet', true, ['推理', '视觉']),
      m('claude-3-5-sonnet', 'Claude 3.5 Sonnet', true, ['视觉']),
      m('claude-3-5-haiku', 'Claude 3.5 Haiku', false, ['快速'])
    ]
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
    models: [
      m('gpt-4o', 'GPT-4o', true, ['视觉']),
      m('gpt-4o-mini', 'GPT-4o mini', true, ['快速']),
      m('o3-mini', 'o3-mini', false, ['推理'])
    ]
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
    models: [
      m('gemini-2.0-flash', 'Gemini 2.0 Flash', true, ['视觉', '快速']),
      m('gemini-1.5-pro', 'Gemini 1.5 Pro', false, ['长上下文'])
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'official',
    accent: '#4d6bfe',
    adapter: 'openai',
    apiHost: 'https://api.deepseek.com',
    docUrl: 'https://platform.deepseek.com/api_keys',
    enabled: true,
    models: [
      m('deepseek-chat', 'DeepSeek Chat', true),
      m('deepseek-reasoner', 'DeepSeek Reasoner', true, ['推理'])
    ]
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
    models: [
      m('moonshot-v1-8k', 'moonshot-v1-8k', true),
      m('moonshot-v1-128k', 'moonshot-v1-128k', false, ['长上下文'])
    ]
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
    models: [
      m('glm-4-plus', 'GLM-4-Plus', true),
      m('glm-4-flash', 'GLM-4-Flash', false, ['快速'])
    ]
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
    models: [
      m('qwen-max', 'Qwen-Max', true),
      m('qwen-plus', 'Qwen-Plus', false)
    ]
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
    models: [
      m('llama3.1', 'Llama 3.1', false),
      m('qwen2.5', 'Qwen 2.5', false)
    ]
  }
]
