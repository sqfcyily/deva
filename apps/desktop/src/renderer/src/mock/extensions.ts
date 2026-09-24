/**
 * 扩展（技能 / MCP 服务）的**类型定义**。全部为全局配置，与项目无关。
 * 用户内容首启为空态（由用户上传/对话创建，或手放于 ~/.deva 下，source='custom'）；
 * 唯一的内置项是系统元技能 `create-skill`（source='builtin'，随二进制内置、不落盘/不可删）。
 * 技能与 MCP 已接入真实存储（~/.deva/skills、~/.deva/mcp.json，经 deva.skills / deva.mcp IPC）。
 * 子智能体（通用 / Explore / Plan）是**内置能力**，不可配置、不在此列——见 main/services/subagents.ts。
 */

export type ExtKind = 'persona' | 'skill' | 'mcp'
/** 作用域：首版仅全局。 */
export type ExtScope = 'global'
/** 来源：`custom` = 用户自定义；`builtin` = 系统内置（目前仅元技能 create-skill）。 */
export type ExtSource = 'custom' | 'builtin'

export interface Skill {
  /** 文件夹名，稳定身份（与 deva.skills 的 SkillRecord.id 对齐）。 */
  id: string
  /** 显示名（frontmatter name）；对话中 /name 与 skill 工具据此匹配。 */
  name: string
  desc: string
  /** 触发方式说明（自由文本，仅展示）。 */
  trigger: string
  /** 建议工具（frontmatter allowed-tools，仅提示，不参与授权）。 */
  allowedTools: string[]
  /** 完整操作指令（SKILL.md 正文）。 */
  instructions: string
  scope: ExtScope
  source: ExtSource
  enabled: boolean
}

export type McpTransport = 'stdio' | 'sse' | 'http'
/** 运行期连接状态（不落盘；由主进程广播）。 */
export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** env / header 编辑行：键 + 明文值；secret=true 表示值经加密存储（写后不回显，value 恒空占位）。 */
export interface McpKV {
  key: string
  value: string
  secret: boolean
}

/** 已发现工具的展示项（原始名 + 命名空间化名 + 描述）。 */
export interface McpTool {
  name: string
  /** 命名空间化名（`id__tool`）；子智能体工具白名单据此匹配运行期工具表。 */
  fqName: string
  description: string
}

export interface McpServer {
  id: string
  name: string
  desc: string
  transport: McpTransport
  /** stdio：启动命令 */
  command: string
  /** stdio：命令参数（逐个） */
  args: string[]
  /** sse/http：服务地址 */
  url: string
  /** stdio：环境变量（明文或密钥引用） */
  env: McpKV[]
  /** sse/http：请求头（明文或密钥引用） */
  headers: McpKV[]
  scope: ExtScope
  source: ExtSource
  enabled: boolean
  /** ↓ 运行期（来自 deva.mcp.list / onStatus，不落盘） */
  status: McpStatus
  /** 已发现工具数 */
  toolCount: number
  /** 最近一次连接失败的中文说明（无则 null） */
  lastError: string | null
  /** 已发现工具清单（连接成功后有值） */
  tools: McpTool[]
}

/**
 * Agent 提示词（Persona）：对话优先外壳里的**完整身份**——name/头像/专长/开场白/
 * 偏好模型/工具白名单/提示词。旧壳仅用 name+prompt（叠加注入），新增字段可选、缺省安全。
 */
export interface Persona {
  id: string
  name: string
  desc: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成。见 components/humation）。 */
  avatar: string
  /**
   * 用户上传的自定义头像（data URI；空串 = 无，回落 avatar 生成头像）。**只读**：由主进程按磁盘上
   * 是否存在图片文件派生，不随 upsert 写回——改图走 store 的 setPersonaAvatarImage / clear。
   */
  avatarImage: string
  /** 开场白 / 口头禅。 */
  tagline: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认。 */
  model: string
  /** 工具白名单（内置 / MCP 名）；空数组 = 全内置（只收窄可见性，不放宽闸门）。 */
  tools: string[]
  /** 提示词正文（追加进主智能体系统提示词）。 */
  prompt: string
  scope: ExtScope
  source: ExtSource
  enabled: boolean
}
