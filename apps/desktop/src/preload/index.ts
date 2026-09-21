import { contextBridge, ipcRenderer } from 'electron'

/** 目录项（单层）。 */
export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

/** 打开文件夹结果。 */
export interface OpenFolderResult {
  path: string
  name: string
}

/** 读取文件结果（可能因过大 / 二进制而不含正文）。 */
export interface ReadFileResult {
  path: string
  content: string
  tooLarge?: boolean
  binary?: boolean
}

/** 会话「线缆类型」：与主进程 providers/chat 结构一致，按既定模式在 preload 内复述。 */
export interface ChatModelConfig {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
  model: string
}

export interface ChatSendRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
  workspaceRoot: string | null
  /** 用户经原生选择框挑选的附件绝对路径（正文由主进程读取，base64 不经渲染层）。 */
  attachments?: string[]
  /** 首发绑定的 persona id（对话优先外壳：一对话一身份，单选定值）。缺省 = 旧壳叠加行为。 */
  personaId?: string
  /** 本对话聚焦工作区绝对路径；null = 全机通用助手（无聚焦）。缺省 = 不改动已存值。 */
  focusRoot?: string | null
  /**
   * 本对话模型引用 `"providerId:modelId"`（快照固定/只改当前对话）：新建带角色偏好快照、聊天中切换即更新。
   * 缺省 = 不改动已存值；空串 = 显式回落全局默认。删除的模型由主进程 resolveModelRef 自动回落默认。
   */
  modelRef?: string
}

/** 手动 /compact 压缩请求（无用户文本、无后续模型轮；locale 在主进程解析）。 */
export interface ChatCompactRequest {
  sessionId: string
  model: ChatModelConfig
  workspaceRoot: string | null
}

/**
 * 立即建档一条空对话（对话优先外壳）：与角色开启新对话时即落盘，重启仍在。
 * 绑定信息（persona / 聚焦工作区 / 本对话模型）随之写入会话，与 chat:send 首发绑定同语义。
 */
export interface ChatCreateSessionRequest {
  sessionId: string
  workspaceRoot: string | null
  personaId?: string
  focusRoot?: string | null
  modelRef?: string
}

/** 附件类型（与 services/attachments.ts 对齐）。 */
export type AttachmentKind = 'image' | 'document' | 'text' | 'unsupported'

/** 一次挑选返回的附件描述（不含正文/base64）。 */
export interface PickedAttachment {
  path: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  supported: boolean
  reason?: string
}

/** 会话元信息（左侧列表用，与 chat-store.ts 对齐）。 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 绑定的 persona id（对话优先外壳：驱动列表头像/主题色）。旧壳会话缺省。 */
  personaId?: string
  /** 聚焦工作区绝对路径；null = 全机通用助手。 */
  focusRoot?: string | null
  /** 本对话模型引用 `"providerId:modelId"`；空串/缺省 = 跟随全局默认。见 ChatSendRequest.modelRef。 */
  model?: string
}

/** 角色名片草稿（与 services/chat.ts 的 AgentDraft 对齐）。 */
export interface AgentDraft {
  name: string
  desc: string
  color: string
  model: string
  prompt: string
}

/** 重建历史用的展示块 / 消息（与 services/chat.ts 的 DisplayMessage 对齐）。 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }
  | { kind: 'notice'; code: 'compacted' | 'truncated' | 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'agentcard'; id: string; draft: AgentDraft; status: 'pending' | 'accepted' | 'rejected' }
  /**
   * ask_user 询问卡（重建）：问题从 tool_use 入参重解析，答案由主进程 asks 边车还原。
   * answers 有值（含空数组）= 已答/已取消（渲染为已答态，逐题回述，不可交互）；
   * null = 取消/中止（渲染层归一为空数组）；undefined = 从未答复（罕见：应用关闭于问询挂起时）。
   */
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] | null }
  /**
   * exit_plan 计划卡（重建）：计划正文从 tool_use 入参（input.plan）还原，decision 由主进程 plans 边车还原。
   * decision 有值（approve/keep）= 已决（只读展示）；null = 中止未决；undefined = 从未决（罕见）。
   */
  | { kind: 'plan'; id: string; plan: string; decision?: 'approve' | 'keep' | null }

export type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

export interface PermissionResponse {
  key: string
  decision: 'allow' | 'deny'
  remember: boolean
}

/** ask_user 候选项（与 services/chat.ts 对齐）。 */
export interface AskOption {
  label: string
  description?: string
}

/** ask_user 单个问题：题干 + 候选项 + 是否多选 + 是否必答（与 services/chat.ts 对齐）。 */
export interface AskQuestion {
  question: string
  options: AskOption[]
  multi: boolean
  /** false=可跳过（允许空答）；缺省/true=必答。 */
  required?: boolean
}

export interface AskResponse {
  key: string
  /** 用户对每个问题的答复（answers[i] 对应 questions[i]）；null 表示取消。 */
  answers: string[] | null
}

/** 用户对 exit_plan 计划审阅的决定：approve=批准并执行 / keep=继续完善。 */
export interface PlanResponse {
  key: string
  decision: 'approve' | 'keep'
}

/** 技能记录（与 services/skills.ts 的 SkillRecord 对齐）。 */
export interface SkillRecord {
  id: string
  name: string
  description: string
  trigger: string
  allowedTools: string[]
  instructions: string
  enabled: boolean
  /** 来源：`builtin` = 应用内置（不可删/编辑、恒启用）；`custom` = 用户创建/导入。 */
  source: 'builtin' | 'custom'
}

/** 技能导入结果（skills:import 回传；error 为稳定错误码，渲染层据此本地化）。 */
export interface SkillImportResult {
  ok: boolean
  id?: string
  name?: string
  error?: string
}

/** 子智能体记录（与 services/agents.ts 的 AgentRecord 对齐）。 */
export interface AgentRecord {
  id: string
  name: string
  description: string
  /** 模型引用 `"providerId:modelId"`；空串 = 跟随主对话。 */
  model: string
  /** 工具白名单（内置 / MCP 名）；空数组 = 全部内置工具。 */
  tools: string[]
  /** 正文 = 子智能体系统提示词。 */
  prompt: string
  enabled: boolean
}

/** 子智能体新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface AgentUpsertInput {
  id?: string
  name: string
  description?: string
  model?: string
  tools?: string[]
  prompt?: string
  enabled?: boolean
}

/** Agent 提示词记录（与 services/personas.ts 的 PersonaRecord 对齐）。 */
export interface PersonaRecord {
  id: string
  name: string
  /** 专长，一句话（frontmatter description）。 */
  description: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成）。 */
  avatar: string
  /** 身份主题色（头像描边 / 名字色）。 */
  color: string
  /** 开场白 / 口头禅。 */
  tagline: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认。 */
  model: string
  /** 工具白名单（内置 / MCP 名）；空数组 = 全内置（只收窄可见性，不放宽闸门）。 */
  tools: string[]
  /** 正文 = 追加进主智能体系统提示词的内容。 */
  prompt: string
  enabled: boolean
}

/** Agent 提示词新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface PersonaUpsertInput {
  id?: string
  name: string
  description?: string
  avatar?: string
  color?: string
  tagline?: string
  model?: string
  tools?: string[]
  prompt?: string
  enabled?: boolean
}

/** MCP「线缆类型」（与 services/mcp.ts + mcp-config.ts 对齐，按既定模式在 preload 内复述）。 */
export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
/** env / header 值：明文字符串，或指向加密库的引用（真实值在主进程 `mcp:<id>:<secretRef>`）。 */
export type McpValue = string | { secretRef: string }

/** MCP 服务配置（不含运行期状态；`mcp:get` 返回此形状）。 */
export interface McpServerConfig {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
}

/** MCP 新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface McpServerInput {
  id?: string
  name: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, McpValue>
  url?: string
  headers?: Record<string, McpValue>
  enabled?: boolean
}

/** 回渲染层的合并视图（配置 + 启用态 + 运行期状态）。 */
export interface McpServerView extends McpServerConfig {
  enabled: boolean
  scope: 'global'
  source: 'custom'
  status: McpStatus
  toolCount: number
  lastError: string | null
  /** 已发现工具的展示清单（原始名 + 命名空间化名 + 描述）。 */
  tools: { name: string; fqName: string; description: string }[]
}

/** 每项目权限模式（与 services/permissions.ts 对齐）。 */
export type PermMode = 'ask' | 'acceptEdits' | 'auto'

/** 终端「线缆类型」（与 services/terminal.ts 对齐，按既定模式在 preload 内复述）。 */
export interface TerminalCreateOptions {
  cols: number
  rows: number
  cwd: string | null
  /** 选定的 shell 配置 id（来自 listShells）；空则用主进程默认。 */
  shellId?: string | null
}
/** 可选 shell 配置（渲染层只见 id/label/isDefault；path/args 留在主进程）。 */
export interface ShellProfile {
  id: string
  label: string
  isDefault?: boolean
}
export interface TerminalDataPayload {
  id: string
  data: string
}
export interface TerminalExitPayload {
  id: string
  exitCode: number
}

/** Git「线缆类型」（与 services/git.ts 对齐，按既定模式在 preload 内复述）。 */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'U' | 'R' | 'C' | 'T'
export interface GitFileStatus {
  path: string
  rel: string
  name: string
  dir: string
  letter: GitStatusLetter
  staged: boolean
  unstaged: boolean
  conflicted: boolean
  untracked: boolean
}
export interface GitStatus {
  isRepo: boolean
  root: string
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  remotes: string[]
  staged: GitFileStatus[]
  unstaged: GitFileStatus[]
  conflicts: GitFileStatus[]
}
export interface GitDiffLine {
  type: 'ctx' | 'add' | 'del' | 'hunk'
  oldNo?: number
  newNo?: number
  text: string
}
export interface GitCommit {
  oid: string
  short: string
  author: string
  email: string
  timestamp: number
  subject: string
}
export interface GitBranch {
  name: string
  current: boolean
}
export type GitFailReason =
  | 'auth'
  | 'network'
  | 'rejected'
  | 'conflict'
  | 'dirty'
  | 'identity-needed'
  | 'empty'
  | 'no-git'
  | 'canceled'
  | 'error'
export type GitAvailable = { available: false } | { available: true; version: string; path: string }
export interface GitOpResult {
  ok: boolean
  reason?: GitFailReason
  message?: string
}

/** AI 生成提交信息所用的模型配置（与 chat 的模型形状一致；密钥仍在主进程按 providerId 解密）。 */
export interface GitGenModel {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
  model: string
}
/** 生成语言：跟随界面语言；主进程只区分 en 与其余（回退简体中文）。 */
export type GitGenLocale = 'zh-CN' | 'en'
/** 生成结果：成功时 text 为提交信息；失败时 reason/message 说明原因。 */
export interface GitGenerateResult {
  ok: boolean
  text?: string
  reason?: GitFailReason
  message?: string
}

/** 服务商探针「线缆类型」（与 services/provider.ts 对齐）。 */
export interface ProbeConfig {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
  model?: string
}

export interface ProviderTestResult {
  ok: boolean
  kind?: string
  message: string
  latencyMs?: number
}

export interface ProviderListModelsResult {
  ok: boolean
  models?: string[]
  kind?: string
  message?: string
}

/** 主进程 → 渲染层的富事件（与 services/chat.ts 的 ChatStreamEvent 对齐）。 */
export type ChatStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /** depth>0 + agent：本事件来自某子智能体（渲染层据此折叠进「子智能体任务」卡）。 */
  | { type: 'tool_call'; id: string; name: string; args: unknown; depth?: number; agent?: string }
  | {
      type: 'tool_result'
      id: string
      name: string
      summary: string
      isError: boolean
      /** depth>0 + agent：来自子智能体的工具结果（折叠进 Task 卡）。 */
      depth?: number
      agent?: string
    }
  | { type: 'ask_user'; key: string; questions: AskQuestion[] }
  /** 计划审阅：exit_plan 提交计划，暂停等待用户批准（approve/keep）。 */
  | { type: 'plan_review'; key: string; plan: string }
  | {
      type: 'permission_request'
      key: string
      toolName: string
      args: unknown
      /** 「项目外访问」授权：被访问目标的完整绝对路径。 */
      outsideRoot?: string
      /** 「项目外访问」授权：点「信任目录」将加入受信根的目录。 */
      trustDir?: string
      /** Tier-2 保护目录（.git/.claude/.vscode）写入：逐次授权，仅「仅此次/拒绝」。 */
      protectedWrite?: boolean
      /** depth>0 + agent：该权限请求来自某子智能体（权限卡照常浮出，可附子智能体标签）。 */
      depth?: number
      agent?: string
    }
  | { type: 'usage'; input: number; output: number }
  | { type: 'reconnecting'; attempt: number; max: number }
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  /** 上下文压缩结果（自动或手动 /compact）。 */
  | {
      type: 'compacted'
      scope: 'auto' | 'manual'
      status: 'compacted' | 'none' | 'failed'
      message?: string
    }
  | { type: 'done'; stopReason: string }

export interface ChatEventPayload {
  turnId: string
  sessionId: string
  event: ChatStreamEvent
}

/**
 * 白名单 API：只向渲染层暴露明确、受控的能力。
 * 绝不暴露原始 ipcRenderer 或任何 Node 模块。
 * 详见 docs/architecture/security.md。
 */
const api = {
  platform: process.platform,
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    /** 主题切换时同步原生标题栏控件（min/max/close）的图标配色 */
    setOverlaySymbolColor: (color: string): Promise<void> =>
      ipcRenderer.invoke('window:set-overlay', color)
  },
  /** 工作区文件系统：打开文件夹、读目录、读写文件、挑选附件。 */
  fs: {
    openFolder: (): Promise<OpenFolderResult | null> => ipcRenderer.invoke('fs:open-folder'),
    /** 按已知路径打开（无对话框，登记受信根）：供「记住最近项目」自动重开 / 点击历史项 */
    openPath: (path: string): Promise<OpenFolderResult | null> =>
      ipcRenderer.invoke('fs:open-path', path),
    readDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:read-dir', path),
    readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke('fs:read-file', path),
    writeFile: (path: string, content: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('fs:write-file', path, content),
    /** 原生多选对话框挑选附件；返回描述（含是否受支持），base64 留在主进程 */
    pickAttachments: (): Promise<PickedAttachment[]> => ipcRenderer.invoke('fs:pick-attachments')
  },
  /** 应用配置（~/.deva/config.json 非敏感项）：同步读（首帧防闪烁）+ 异步读/写。 */
  config: {
    /** 同步取整份配置，供首帧读取主题/语言，避免闪烁 */
    getSync: (): Record<string, unknown> => ipcRenderer.sendSync('config:get-sync'),
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:get'),
    /** 顶层浅合并补丁（值为 undefined 删除该键） */
    set: (patch: Record<string, unknown>): Promise<{ ok: true }> =>
      ipcRenderer.invoke('config:set', patch)
  },
  /** 技能（全局 ~/.deva/skills）：列出 / 读取 / 上传导入 / 删除 / 启停。创建仅经上传或对话（create_skill 工具），无手写落盘。 */
  skills: {
    list: (): Promise<SkillRecord[]> => ipcRenderer.invoke('skills:list'),
    get: (id: string): Promise<SkillRecord | null> => ipcRenderer.invoke('skills:get', id),
    import: (): Promise<SkillImportResult> => ipcRenderer.invoke('skills:import'),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('skills:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('skills:set-enabled', id, enabled)
  },
  /** 子智能体（全局 ~/.deva/agents）：列出 / 读取 / 新建更新 / 删除 / 启停。 */
  agents: {
    list: (): Promise<AgentRecord[]> => ipcRenderer.invoke('agents:list'),
    get: (id: string): Promise<AgentRecord | null> => ipcRenderer.invoke('agents:get', id),
    upsert: (input: AgentUpsertInput): Promise<AgentRecord> =>
      ipcRenderer.invoke('agents:upsert', input),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('agents:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('agents:set-enabled', id, enabled)
  },
  /** Agent 提示词（全局 ~/.deva/personas）：列出 / 读取 / 新建更新 / 删除 / 启停。 */
  personas: {
    list: (): Promise<PersonaRecord[]> => ipcRenderer.invoke('personas:list'),
    get: (id: string): Promise<PersonaRecord | null> => ipcRenderer.invoke('personas:get', id),
    upsert: (input: PersonaUpsertInput): Promise<PersonaRecord> =>
      ipcRenderer.invoke('personas:upsert', input),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('personas:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('personas:set-enabled', id, enabled),
    /** 覆盖手动排序：整表按传入 id 顺序落盘（花名册拖拽 / 置顶）。 */
    reorder: (ids: string[]): Promise<{ ok: true }> =>
      ipcRenderer.invoke('personas:reorder', ids)
  },
  /**
   * MCP 服务（全局 ~/.deva/mcp.json）：列出 / 读取 / 增改删 / 启停 / 连接管理 / 密钥。
   * 连接、子进程 spawn、密钥解密全部在主进程；渲染层只见配置与运行期状态，明文密钥永不回传。
   */
  mcp: {
    list: (): Promise<McpServerView[]> => ipcRenderer.invoke('mcp:list'),
    get: (id: string): Promise<McpServerConfig | null> => ipcRenderer.invoke('mcp:get', id),
    upsert: (input: McpServerInput): Promise<McpServerConfig> =>
      ipcRenderer.invoke('mcp:upsert', input),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('mcp:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('mcp:set-enabled', id, enabled),
    /** 连接（或重连）一个服务，返回其最新视图（失败视图带 lastError）。 */
    connect: (id: string): Promise<McpServerView | null> => ipcRenderer.invoke('mcp:connect', id),
    disconnect: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('mcp:disconnect', id),
    /** 测试连通 = 连接一次并返回结果视图（成功即保持连接）。 */
    test: (id: string): Promise<McpServerView | null> => ipcRenderer.invoke('mcp:test', id),
    /** 写入某服务的某密钥字段（空串即删除；明文永不回渲染层）。 */
    setSecret: (
      id: string,
      field: string,
      value: string
    ): Promise<{ ok: boolean; available: boolean }> =>
      ipcRenderer.invoke('mcp:set-secret', id, field, value),
    /** 是否已配置某密钥字段（布尔，不回显明文）。 */
    hasSecret: (id: string, field: string): Promise<boolean> =>
      ipcRenderer.invoke('mcp:has-secret', id, field),
    /** 订阅 mcp:status 状态广播，返回取消订阅函数（仿 chat.onEvent）。 */
    onStatus: (cb: (view: McpServerView) => void): (() => void) => {
      const listener = (_e: unknown, view: McpServerView): void => cb(view)
      ipcRenderer.on('mcp:status', listener)
      return () => ipcRenderer.removeListener('mcp:status', listener)
    }
  },
  /** 密钥安全存储：只写不读明文（set 空串即删除）。 */
  secrets: {
    set: (providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> =>
      ipcRenderer.invoke('secrets:set', providerId, key),
    has: (providerId: string): Promise<boolean> => ipcRenderer.invoke('secrets:has', providerId),
    delete: (providerId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('secrets:delete', providerId),
    list: (): Promise<string[]> => ipcRenderer.invoke('secrets:list'),
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available')
  },
  /** 服务商探针：连通性测试 + 拉取模型清单（均在主进程发起，密钥不出主进程）。 */
  provider: {
    test: (cfg: ProbeConfig): Promise<ProviderTestResult> =>
      ipcRenderer.invoke('provider:test', cfg),
    listModels: (cfg: ProbeConfig): Promise<ProviderListModelsResult> =>
      ipcRenderer.invoke('provider:list-models', cfg)
  },
  /** 会话：发送、中止、重置、列表/载入/删除、回应权限、订阅流式事件。 */
  chat: {
    send: (req: ChatSendRequest): Promise<{ turnId: string }> =>
      ipcRenderer.invoke('chat:send', req),
    /** 手动压缩历史（/compact）：无后续模型轮，只回发 compacted + done 事件。 */
    compact: (req: ChatCompactRequest): Promise<{ turnId: string }> =>
      ipcRenderer.invoke('chat:compact', req),
    /** 立即建档一条空对话（对话优先外壳）：首发前即落盘，重启仍在。 */
    createSession: (req: ChatCreateSessionRequest): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:create-session', req),
    abort: (turnId: string): Promise<{ ok: true }> => ipcRenderer.invoke('chat:abort', turnId),
    reset: (sessionId: string, workspaceRoot: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:reset', sessionId, workspaceRoot),
    /** 某项目下的会话清单（按 updatedAt 倒序） */
    listSessions: (workspaceRoot: string | null): Promise<ChatSessionMeta[]> =>
      ipcRenderer.invoke('chat:list-sessions', workspaceRoot),
    /** 载入某会话历史，重建展示气泡 */
    loadSession: (sessionId: string, workspaceRoot: string | null): Promise<DisplayMessage[]> =>
      ipcRenderer.invoke('chat:load-session', sessionId, workspaceRoot),
    /** 删除某会话 */
    deleteSession: (sessionId: string, workspaceRoot: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:delete-session', sessionId, workspaceRoot),
    /**
     * 按「轮」删除对话（同步删上下文）：turnIndices 为 0 基轮下标集合，
     * 返回删除后重建的展示气泡（供渲染层就地替换，保证展示与落盘一致、重启不变）。
     */
    deleteTurns: (
      sessionId: string,
      workspaceRoot: string | null,
      turnIndices: number[]
    ): Promise<DisplayMessage[]> =>
      ipcRenderer.invoke('chat:delete-turns', sessionId, workspaceRoot, turnIndices),
    /** 落定角色名片终态（接受/拒绝）：持久化 proposals 边车，防重开退回 pending / 重复建角色。 */
    resolveProposal: (
      sessionId: string,
      toolUseId: string,
      status: 'accepted' | 'rejected'
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:resolve-proposal', sessionId, toolUseId, status),
    respondPermission: (payload: PermissionResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:permission-response', payload),
    /** 回应 ask_user 询问（每题的选中项标签或自由输入；answers 为 null 表示取消） */
    respondAsk: (payload: AskResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:ask-response', payload),
    /** 回应 exit_plan 计划审阅（approve=批准并执行 / keep=继续完善） */
    respondPlan: (payload: PlanResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:plan-response', payload),
    /** 订阅 chat:event，返回取消订阅函数 */
    onEvent: (cb: (payload: ChatEventPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: ChatEventPayload): void => cb(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },
  /** 权限模式（按项目，存于 ~/.deva/permissions.json）：读/写当前项目的授权姿态。 */
  perm: {
    getMode: (workspaceRoot: string | null): Promise<PermMode> =>
      ipcRenderer.invoke('perm:get-mode', workspaceRoot),
    setMode: (workspaceRoot: string | null, mode: PermMode): Promise<{ ok: true }> =>
      ipcRenderer.invoke('perm:set-mode', workspaceRoot, mode)
  },
  /** 集成终端：列出已装 shell、建 PTY、写输入、改尺寸、销毁；订阅数据/退出事件。 */
  terminal: {
    /** 本机可用 shell 清单（PowerShell / cmd / Git Bash / pwsh 等，按平台探测） */
    listShells: (): Promise<ShellProfile[]> => ipcRenderer.invoke('terminal:list-shells'),
    create: (opts: TerminalCreateOptions): Promise<{ id: string }> =>
      ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    dispose: (id: string): void => ipcRenderer.send('terminal:dispose', id),
    /** 订阅 terminal:data，返回取消订阅函数 */
    onData: (cb: (payload: TerminalDataPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: TerminalDataPayload): void => cb(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    /** 订阅 terminal:exit，返回取消订阅函数 */
    onExit: (cb: (payload: TerminalExitPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: TerminalExitPayload): void => cb(payload)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.removeListener('terminal:exit', listener)
    }
  },
  /**
   * Git 源代码管理（调用系统 git，对标 VS Code）。
   * 凭据全交系统 git / 凭据管理器——此处**无任何凭据相关方法**。
   * 所有涉及仓库的方法都收 `dir`（受信项目根），主进程先 assertInside 校验。
   */
  git: {
    /** git 是否可用（定位成功 + --version 跑通） */
    available: (): Promise<GitAvailable> => ipcRenderer.invoke('git:available'),
    /** 完整状态（分支 / upstream / ahead-behind / 分组文件） */
    status: (dir: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', dir),
    /** 文件级 diff（staged=index↔HEAD；否则 worktree↔index；untracked=读全文件当新增） */
    diff: (
      dir: string,
      path: string,
      opts: { staged?: boolean; untracked?: boolean }
    ): Promise<GitDiffLine[]> => ipcRenderer.invoke('git:diff', dir, path, opts),
    stage: (dir: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:stage', dir, paths),
    unstage: (dir: string, paths: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:unstage', dir, paths),
    /** 丢弃（破坏性，UI 先确认）：tracked→checkout HEAD 还原；untracked→删文件 */
    discard: (dir: string, tracked: string[], untracked: string[]): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:discard', dir, tracked, untracked),
    commit: (dir: string, message: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:commit', dir, message),
    /** 设置身份（identity-needed 后回写；global 决定 --global/--local） */
    setConfig: (dir: string, name: string, email: string, global: boolean): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:set-config', dir, name, email, global),
    branches: (dir: string): Promise<GitBranch[]> => ipcRenderer.invoke('git:branches', dir),
    checkout: (dir: string, ref: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:checkout', dir, ref),
    createBranch: (dir: string, name: string, checkout: boolean): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:create-branch', dir, name, checkout),
    log: (dir: string, depth?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke('git:log', dir, depth),
    init: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:init', dir),
    fetch: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:fetch', dir),
    pull: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:pull', dir),
    /** 推送（无 upstream 时传 branch 触发 -u origin <branch> 首推，否则传 null） */
    push: (dir: string, setUpstreamBranch: string | null): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:push', dir, setUpstreamBranch),
    /** AI 生成提交信息：把「将要提交」的 diff 交模型生成（密钥在主进程解密，不经渲染层）；locale 跟随界面语言 */
    generateCommitMessage: (
      dir: string,
      model: GitGenModel,
      locale: GitGenLocale
    ): Promise<GitGenerateResult> =>
      ipcRenderer.invoke('git:generate-commit-message', dir, model, locale)
  },
  /**
   * 系统剪贴板纯文本读写（走主进程原生 clipboard）。
   * sandbox 下 navigator.clipboard.readText 不可靠，故读/写统一走这里。
   */
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
    writeText: (text: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('clipboard:write-text', text)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('deva', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (仅在未启用隔离的回退场景)
  window.deva = api
}

export type DevaApi = typeof api
