import { contextBridge, ipcRenderer } from 'electron'
import type { EffortLevel } from '../shared/effort'
import type { UpdateState } from '../shared/update'
import type { DeliverableInfo } from '../shared/deliverables'
import type { BrowserLiveFrame, BrowserUiState } from '../shared/browser'

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

/** 思考等级：定义在主进程 / 渲染层共用模块（含模型能力表），此处转出供渲染层按既有方式取用。 */
export type { EffortLevel }

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
  /** 本对话生效的思考等级：发送时恒带上并落库（同 modelRef）。缺省 = 不改动已存值。 */
  effort?: EffortLevel
}

/**
 * 回合进行中插入一条消息：当前步骤结束后交给模型，来不及就在本轮结束后作为普通消息发出（model 此时作回落）。
 */
export interface ChatInsertRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
}

/** idle = 回合刚结束（改走普通发送）；busy = 正在跑的不接受插入（如定时任务）；empty = 正文为空。 */
export type ChatInsertResult = { ok: true } | { ok: false; reason: 'idle' | 'busy' | 'empty' }

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

/** 对话输入框切换本对话模型：立即落库（会话尚未建档则不建档，由覆盖层随首发落库）。 */
export interface ChatSetModelRequest {
  sessionId: string
  modelRef: string
}

/** 对话输入框切换本对话思考等级：立即落库（会话尚未建档则不建档，由覆盖层随首发落库）。 */
export interface ChatSetEffortRequest {
  sessionId: string
  effort: EffortLevel
}

/** 挂载 / 卸载本对话的聚焦工作区：立即落库（会话尚未建档则不建档，由覆盖层随首发落库）。 */
export interface ChatSetFocusRequest {
  sessionId: string
  /** 聚焦工作区绝对路径；null = 卸载回全机通用助手。 */
  focusRoot: string | null
}

export interface ChatRenameSessionRequest {
  sessionId: string
  /** 新标题；空串 = 恢复自动标题（由首条用户消息派生）。 */
  title: string
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
  /** 本对话思考等级；缺省 = 尚未定格（渲染层打开时定格为「最近使用」）。 */
  effort?: EffortLevel
  /** 已归档（不在左侧对话列表里显示）；缺省 = 未归档。 */
  archived?: boolean
}

/** 角色名片草稿（与 services/chat.ts 的 AgentDraft 对齐）。 */
export interface AgentDraft {
  name: string
  desc: string
  model: string
  prompt: string
}

/** 定时任务确认名片草稿（与 services/chat.ts 的 AutotaskDraft 对齐）。 */
export interface AutotaskDraft {
  title: string
  prompt: string
  schedule: { kind: 'once' | 'recurring'; at: string; cron: string; tz: string }
}

/** 重建历史用的展示块 / 消息（与 services/chat.ts 的 DisplayMessage 对齐）。 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  /** status=running 仅见于仍在后台运行的子智能体 Task 卡。 */
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error' | 'running'; summary?: string }
  | {
      kind: 'notice'
      code: 'truncated' | 'empty' | 'refused' | 'restored' | 'aborted' | 'step_limit' | 'repeated'
    }
  /** 较早历史已压缩：一行提示，摘要正文（已去掉写给模型的开头）默认折叠。 */
  | { kind: 'compaction'; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'agentcard'; id: string; draft: AgentDraft; status: 'pending' | 'accepted' | 'rejected' }
  /**
   * 定时任务确认名片（重建）：草稿从 create_task 入参归一化，status/taskId 由主进程 autotasks 边车还原。
   * pending = 待用户议定授权后创建；created = 已创建（taskId 指向独占会话）；dismissed = 已忽略。
   */
  | {
      kind: 'autotaskcard'
      id: string
      draft: AutotaskDraft
      status: 'pending' | 'created' | 'dismissed'
      taskId?: string
    }
  /**
   * ask_user 询问卡（重建）：问题从 tool_use 入参重解析，答案由主进程 asks 边车还原。
   * answers 有值（含空数组）= 已答/已取消（渲染为已答态，逐题回述，不可交互）；
   * null = 取消/中止（渲染层归一为空数组）；undefined = 从未答复（罕见：应用关闭于问询挂起时）。
   */
  | { kind: 'ask'; id: string; questions: AskQuestion[]; answers?: string[] | null }
  /**
   * exit_plan 计划卡（重建）：计划正文从 tool_use 入参（input.plan）还原，decision 由主进程 plans 边车还原。
   * 恒为终态：'approve'/'keep' = 用户的决定；'cancelled' = 中止 / 未决。重建卡一律只读、不再可点。
   * feedback = 继续完善时用户写的回复（未写则缺省）。
   */
  | {
      kind: 'plan'
      id: string
      plan: string
      decision: 'approve' | 'keep' | 'ignore' | 'cancelled'
      feedback?: string
    }
  /** 已完成的待办清单卡（重建）：画在令清单全部完成的那次 todo_write 处；其余 todo_write 不画。 */
  | { kind: 'todolist'; id: string; title: string; items: TodoItem[] }

export type DisplayMessage =
  | {
      role: 'user'
      text: string
      attachments: { name: string; kind: 'image' | 'document' | 'text' }[]
      /** 后台任务通知：展示为一行系统通知而非用户气泡，text 为其标题。 */
      notify?: true
    }
  /** durationMs：本轮耗时（未记录则缺省）。 */
  | { role: 'assistant'; blocks: DisplayBlock[]; durationMs?: number }

/** 回滚列表里每轮自身的改动量（与 services/checkpoints.ts 的 RewindTurnStat 对齐）。 */
export interface RewindTurnStat {
  turn: number
  fileCount: number
  added: number
  removed: number
  /** 含近似 / 二进制 / 过大等无法精确计数的文件。 */
  approx: boolean
  hasExec: boolean
}

/** 回滚对单个文件的动作：写回 / 删除（目标是不存在）/ 重建（现已不存在）/ 无需改动。 */
export type RewindAction = 'restore' | 'delete' | 'create' | 'none'
/** ok=可回滚；conflict=回滚点之后被外部改过；link=链接文件跳过。 */
export type RewindStatus = 'ok' | 'conflict' | 'link' | 'blob_missing' | 'too_large'

/** 回滚预览里的一个文件（只有摘要，不含内容；与 services/checkpoints.ts 的 RewindFile 对齐）。 */
export interface RewindFile {
  path: string
  rel: string
  action: RewindAction
  status: RewindStatus
  added?: number
  removed?: number
  approx?: boolean
  binary?: boolean
}

export interface RewindPreview {
  files: RewindFile[]
  /** 目标轮起跑过的命令：其影响无法撤销，面板只提示条数不逐条列出。 */
  commands: string[]
}

/** 回滚模式：both=代码与对话 / conversation=仅对话 / code=仅代码。 */
export type RewindMode = 'both' | 'conversation' | 'code'

export interface RewindApplyRequest {
  sessionId: string
  turn: number
  mode: RewindMode
  /** 勾选「仍然覆盖」的冲突文件路径（RewindFile.path）。 */
  force?: string[]
}

export type RewindApplyResult =
  | {
      ok: true
      messages: DisplayMessage[]
      restored: string[]
      skipped: { rel: string; reason: RewindStatus | 'error' }[]
    }
  | { ok: false; error: 'no-session' | 'busy' | 'bad-turn' }

export type RewindUndoResult =
  | { ok: true; messages: DisplayMessage[]; restored: string[]; skipped: string[] }
  | { ok: false; error: 'no-undo' | 'busy' }

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
  decision: 'approve' | 'keep' | 'ignore'
  /** 选「继续完善」时在卡上直接写的回复；缺省 / 空 = 未写。 */
  feedback?: string
}

/** 待办清单的一项（与 services/todos.ts 对齐）。 */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** 一个待办清单（同一清单的多次 todo_write 折叠后的现状）。 */
export interface TodoList {
  id: string
  /** 可为空串：界面回落通用名。 */
  title: string
  items: TodoItem[]
  createdAt: number
  updatedAt: number
}

/** 某会话待办清单的状态：胶囊显示的当前清单（无进行中的清单——没建过 / 已完成 / 已取消——则 null）。 */
export interface TodoState {
  active: TodoList | null
}

/** 用户对「请求挂载工作区」的回应：path=已选目录的绝对路径；null=暂不挂载。 */
export interface MountResponse {
  key: string
  path: string | null
}

/** 技能记录（与 services/skills.ts 的 SkillRecord 对齐）。 */
export interface SkillRecord {
  id: string
  name: string
  description: string
  trigger: string
  allowedTools: string[]
  license: string
  compatibility: string
  metadata: Record<string, string>
  instructions: string
  enabled: boolean
  /** 可用角色（角色 id）；null = 全部角色。内置技能恒为 null。 */
  roles: string[] | null
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

/** Agent 提示词记录（与 services/personas.ts 的 PersonaRecord 对齐）。 */
export interface PersonaRecord {
  id: string
  name: string
  /** 专长，一句话（frontmatter description）。 */
  description: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成）。 */
  avatar: string
  /**
   * 自定义头像图片（data URI；空串 = 无，回落生成头像）。**只读派生字段**：真源是主进程磁盘上的
   * 图片文件，不入 upsert 入参——改图走 setAvatarImage / clearAvatarImage。
   */
  avatarImage: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认。 */
  model: string
  /** 正文 = 追加进主智能体系统提示词的内容。 */
  prompt: string
  enabled: boolean
}

/** 本机用户资料（与 services/profile.ts 对齐）。 */
export interface UserProfile {
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 固定 seed 默认头像）。 */
  avatar: string
  /** 自定义头像图片（data URI；空串 = 无）。只读派生字段，改图走 profile.setAvatarImage。 */
  avatarImage: string
}

/** 记忆条目（全局 / 项目私有共用，与 services/memory.ts 对齐）。 */
export interface MemoryEntry {
  id: string
  content: string
  createdAt: number
  updatedAt: number
}
export interface MemorySnapshot {
  entries: MemoryEntry[]
  /** 当前总字数（与注入系统提示词同一口径）。 */
  used: number
  /** 总字数上限：写入后超出即拒写。 */
  budget: number
  maxEntries: number
  maxChars: number
}
export type MemoryErrorCode = 'empty' | 'tooLong' | 'full' | 'budget' | 'notFound' | 'duplicate'
export type MemoryIpcResult = { ok: true; snapshot: MemorySnapshot } | { ok: false; code: MemoryErrorCode }

/** Agent 提示词新建/更新入参（有 id 覆盖，无 id 新建）。 */
export interface PersonaUpsertInput {
  id?: string
  name: string
  description?: string
  avatar?: string
  model?: string
  prompt?: string
  enabled?: boolean
}

/** MCP「线缆类型」（与 services/mcp.ts + mcp-config.ts 对齐，按既定模式在 preload 内复述）。 */
export type McpTransport = 'stdio' | 'sse' | 'http'
export type McpStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'needs_config'
  | 'needs_secret'
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
  /** 可用角色（角色 id）；null = 全部角色。 */
  roles: string[] | null
  scope: 'global'
  source: 'custom'
  status: McpStatus
  toolCount: number
  lastError: string | null
  /** status=needs_secret 时尚未填写的密钥字段名。 */
  missingSecrets: string[]
  /** 已发现工具的展示清单（原始名 + 命名空间化名 + 描述）。 */
  tools: { name: string; fqName: string; description: string }[]
}

/** 定时任务类型（与 services/tasks-types.ts 对齐，按既定模式在 preload 内复述）。 */
export type TaskStatus = 'active' | 'paused' | 'completed' | 'error'
export interface TaskSchedule {
  kind: 'once' | 'recurring'
  at?: string
  cron?: string
  tz: string
}
export interface TaskAuthorization {
  personaId: string | null
  modelRef: string | null
}
export interface TaskRun {
  firedAt: number
  finishedAt?: number
  status: 'ok' | 'error' | 'skipped' | 'aborted'
  summary?: string
  error?: string
}
export interface TaskRecord {
  id: string
  title: string
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
  sessionId: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt: number | null
  consecutiveErrors: number
  runs: TaskRun[]
}
export interface TaskCreateInput {
  title: string
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
}
export interface TaskUpdateInput {
  id: string
  title?: string
  prompt?: string
  schedule?: TaskSchedule
  auth?: Partial<TaskAuthorization>
}
/** 创建结果：成功带记录，失败带稳定错误码（渲染层据此本地化）。 */
export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' | 'expired' }

/** 日程预览结果（确认名片实时校验，与 services/tasks.ts 的 PreviewScheduleResult 对齐）。 */
export type PreviewScheduleResult =
  | { ok: true; description: string; nextRunAt: number | null }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' }

/** 确认名片决议结果（chat:resolve-autotask，与 services/chat.ts 的 ResolveAutotaskResult 对齐）。 */
export type ResolveAutotaskResult =
  | { ok: true; status: 'created'; taskId: string }
  | { ok: true; status: 'dismissed' }
  | {
      ok: false
      error:
        | 'invalid-input'
        | 'invalid-tz'
        | 'invalid-cron'
        | 'invalid-once'
        | 'expired'
        | 'no-session'
        | 'no-input'
    }

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
  mergeInProgress: boolean
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
  /** 本地分支为短名；远程分支含远程名前缀（origin/x） */
  name: string
  current: boolean
  /** 远程分支所属远程名；本地分支为 null */
  remote: string | null
  /** 本地分支的上游；无则 null */
  upstream: string | null
}
export type GitFailReason =
  | 'auth'
  | 'network'
  | 'rejected'
  | 'conflict'
  | 'dirty'
  | 'identity-needed'
  | 'empty'
  | 'unmerged'
  | 'no-git'
  | 'canceled'
  | 'error'
export type GitAvailable = { available: false } | { available: true; version: string; path: string }
export interface GitOpResult {
  ok: boolean
  reason?: GitFailReason
  message?: string
  /** delete-branch 回 unmerged 时：未合并到当前 HEAD 的提交数 */
  count?: number
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
  /** 被用户中断：text 为已生成的部分（可能为空串）。 */
  aborted?: boolean
  reason?: GitFailReason
  message?: string
}

/** 服务商探针「线缆类型」（与 services/provider.ts 对齐）。 */
export interface ProbeConfig {
  adapter: 'anthropic' | 'openai' | 'responses'
  providerId: string
  baseURL: string
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
  /**
   * depth>0 + agent + parent：来自某子智能体（折叠进 parent 那次 run_subagent 调用开出的 Task 卡）。
   * bg：来自后台运行的子智能体，不属于任何回合（turnId 为空串），Task 卡可能在任意一条历史消息里。
   */
  | {
      type: 'tool_call'
      id: string
      name: string
      args: unknown
      depth?: number
      agent?: string
      parent?: string
      bg?: true
    }
  | {
      type: 'tool_result'
      id: string
      name: string
      summary: string
      isError: boolean
      /** depth>0 + agent + parent：来自某子智能体的工具结果（折叠进 parent 那张 Task 卡）。 */
      depth?: number
      agent?: string
      parent?: string
      /** 后台子智能体：嵌套结果，或（depth 0）它结束时给自己那张 Task 卡定格的壳结果。 */
      bg?: true
    }
  | { type: 'ask_user'; key: string; questions: AskQuestion[] }
  /** 计划审阅：exit_plan 提交计划，暂停等待用户批准（approve/keep）。 */
  | { type: 'plan_review'; key: string; plan: string }
  /** 待办清单状态（会话级）：每次 todo_write、按轮删除 / 回滚 / 用户手动取消后推送；后几种 turnId 为空串。 */
  | { type: 'todos'; state: TodoState }
  /** 本次 todo_write 令清单全部完成：在对话流里落一张「已完成清单」卡。 */
  | { type: 'todo_done'; id: string; title: string; items: TodoItem[] }
  /**
   * 请求挂载工作区：未挂载工作区时，模型的某次调用缺「相对路径基准」（写相对路径 / 扫描类工具
   * 省略 path），暂停等待用户一键挂载或跳过。tool=触发的工具名，path=模型给的相对路径（可为空）。
   */
  | { type: 'mount_request'; key: string; tool: string; path: string }
  /** 用量。input 为总提示 token（含缓存命中/写入）；cacheRead/cacheWrite 供观测缓存是否生效。 */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'reconnecting'; attempt: number; max: number }
  /** 引擎自愈中（截断续写 / 空回合追问 / 上下文压缩重试 / 输出预算降档），显示为状态横幅。 */
  | {
      type: 'auto_retry'
      reason: 'truncated' | 'empty' | 'context' | 'output_limit' | 'effort'
      attempt: number
      max: number
      /** context：报错里解析出的真实窗口；output_limit：用户所设输出上限被拒后降到的值。 */
      limit?: number
    }
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  /** 上下文压缩结果（自动或手动 /compact）。 */
  | {
      type: 'compacted'
      scope: 'auto' | 'manual'
      status: 'compacted' | 'none' | 'failed'
      message?: string
    }
  /** 正在压缩上下文：开始请求摘要时 active=true，结束（不论结果）active=false，成对出现。 */
  | { type: 'compacting'; active: boolean }
  /** 某张交互卡已被答复（可能来自手机端）：渲染层据此把同 key 的卡收成已决态。 */
  | {
      type: 'interaction_resolved'
      key: string
      kind: 'ask' | 'plan' | 'mount'
      answers?: string[] | null
      decision?: 'approve' | 'keep' | 'ignore' | null
      feedback?: string
      path?: string | null
    }
  /** 角色名片 / 定时任务名片已决议（可能来自手机端）；不属于任何回合，turnId 为空串。 */
  | {
      type: 'card_resolved'
      card: 'agent' | 'autotask'
      toolUseId: string
      status: 'accepted' | 'rejected' | 'created' | 'dismissed'
      taskId?: string
    }
  /** 回合开始（本轮首个事件）：带本轮用户消息，供渲染层把别处发起的一轮当本地回合呈现。 */
  | {
      type: 'turn_start'
      /** notify：本轮由后台任务通知自动发起，text 为通知标题。 */
      user: { text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[]; notify?: true }
    }
  /** 插入的消息已随本步工具结果交给模型：执行步骤里添一个节点。 */
  | { type: 'insert'; text: string }
  /** 该对话待送达的插入消息（会话级，turnId 为空串）；空数组 = 没有。 */
  | { type: 'inserts'; pending: string[] }
  /** 回合被停止或出错，待送达的插入消息退回（会话级，turnId 为空串）：放回该对话的输入框。 */
  | { type: 'inserts_returned'; text: string }
  /** durationMs：本轮耗时（扣除等用户处置的时间）。 */
  | { type: 'done'; stopReason: string; durationMs?: number }

/** IM 机器人（远程通道）状态，与 services/remote/index.ts 的 BotView / ScanEvent 对齐。 */
export type BotPlatform = 'feishu' | 'telegram'
export type BotReplyMode = 'stream' | 'final'
/** 回复范围：all 全部 / personas 选中角色的对话 / sessions 选中的对话（两份清单都保留，切模式不丢）。 */
export interface BotReplyScope {
  mode: 'all' | 'personas' | 'sessions'
  personas: string[]
  sessions: string[]
}
export interface BotView {
  id: string
  platform: BotPlatform
  name: string
  region?: 'cn' | 'intl'
  username?: string
  enabled: boolean
  state: 'off' | 'connecting' | 'connected' | 'error'
  error?: string
  replyMode: BotReplyMode
  scope: BotReplyScope
  users: { id: string; name?: string; pairedAt: number }[]
}
export interface RemoteState {
  bots: BotView[]
}
export type BotScanEvent =
  | { scanId: string; status: 'done'; botId: string }
  | { scanId: string; status: 'denied' | 'expired' | 'cancelled' }
  | { scanId: string; status: 'error'; error: string }

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
    /** 窗口是否全屏（macOS 全屏时红绿灯隐藏，图标栏不再为它让位） */
    isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('window:is-fullscreen'),
    onFullScreen: (cb: (on: boolean) => void): (() => void) => {
      const listener = (_e: unknown, on: boolean): void => cb(on)
      ipcRenderer.on('window:fullscreen', listener)
      return () => ipcRenderer.removeListener('window:fullscreen', listener)
    },
    /** 主题切换时同步原生标题栏控件（min/max/close）的图标配色 */
    setOverlaySymbolColor: (color: string): Promise<void> =>
      ipcRenderer.invoke('window:set-overlay', color)
  },
  /** 工作区文件系统：打开文件夹、读目录、读写文件、挑选附件。 */
  fs: {
    openFolder: (): Promise<OpenFolderResult | null> => ipcRenderer.invoke('fs:open-folder'),
    /** 在系统文件管理器中打开目录（仅限受信根内的目录，文件一律拒绝） */
    revealFolder: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('fs:reveal-folder', path),
    readDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:read-dir', path),
    readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke('fs:read-file', path),
    writeFile: (path: string, content: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('fs:write-file', path, content),
    /** 原生多选对话框挑选附件；返回描述（含是否受支持），base64 留在主进程 */
    pickAttachments: (): Promise<PickedAttachment[]> => ipcRenderer.invoke('fs:pick-attachments'),
    /** 粘贴的文件（截图 / 复制的文件）：交字节由主进程落临时目录并授权；data=null 表示过大不读，仅报体积 */
    pasteAttachment: (file: {
      name: string
      mime: string
      size: number
      data: Uint8Array | null
    }): Promise<PickedAttachment> => ipcRenderer.invoke('fs:paste-attachment', file)
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
  /** 技能（全局 ~/.deva/skills）：列出 / 读取 / 上传导入 / 删除 / 启停。渲染层不写技能文件——创建经上传，或经对话（create_skill 工具 / 主智能体直接写技能目录）。 */
  skills: {
    list: (): Promise<SkillRecord[]> => ipcRenderer.invoke('skills:list'),
    get: (id: string): Promise<SkillRecord | null> => ipcRenderer.invoke('skills:get', id),
    import: (): Promise<SkillImportResult> => ipcRenderer.invoke('skills:import'),
    /** 删除 = 技能文件夹移到系统回收站；ok:false 表示未能移入，技能原样保留。 */
    remove: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('skills:remove', id),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke('skills:set-enabled', id, enabled),
    /** 设置可用角色（角色 id 数组；null = 全部角色）。内置技能不可设置。 */
    setRoles: (id: string, roles: string[] | null): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('skills:set-roles', id, roles),
    /** 订阅 skills:changed（技能目录变化后推送的全表），返回取消订阅函数（仿 tasks.onChanged）。 */
    onChanged: (cb: (skills: SkillRecord[]) => void): (() => void) => {
      const listener = (_e: unknown, skills: SkillRecord[]): void => cb(skills)
      ipcRenderer.on('skills:changed', listener)
      return () => ipcRenderer.removeListener('skills:changed', listener)
    }
  },
  /** 本机用户资料（个人资料面板）：头像 spec 存 config.json，图片另存 ~/.deva/profile/。 */
  profile: {
    get: (): Promise<UserProfile> => ipcRenderer.invoke('profile:get'),
    setAvatar: (spec: string): Promise<{ ok: true }> => ipcRenderer.invoke('profile:set-avatar', spec),
    /** 写入头像图片（data URI）；空串 = 清除。返回读回的 data URI（失败 / 清除为空串）。 */
    setAvatarImage: (dataUri: string): Promise<string> =>
      ipcRenderer.invoke('profile:set-avatar-image', dataUri)
  },
  /**
   * 记忆：查看 / 增改删 / 清空，与模型的 memory_* 工具同一套校验。
   * 末位可选 root：省略 = 全局记忆（~/.deva/memory.json）；给出 = 该工作区的项目私有记忆（~/.deva/projects/<key>/）。
   */
  memory: {
    list: (root?: string): Promise<MemorySnapshot> => ipcRenderer.invoke('memory:list', root),
    /** 无 id 新增，有 id 覆盖更新。 */
    write: (content: string, id?: string, root?: string): Promise<MemoryIpcResult> =>
      ipcRenderer.invoke('memory:write', content, id, root),
    remove: (id: string, root?: string): Promise<MemoryIpcResult> => ipcRenderer.invoke('memory:delete', id, root),
    clear: (root?: string): Promise<MemoryIpcResult> => ipcRenderer.invoke('memory:clear', root)
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
      ipcRenderer.invoke('personas:reorder', ids),
    /**
     * 写入自定义头像（data URI，png/jpeg/webp）。返回落盘后读回的 data URI；参数非法 / 写失败返回空串。
     * 同一 id 重复上传即覆盖。新建角色须**先 upsert 拿到 id** 再调用。
     */
    setAvatarImage: (id: string, dataUri: string): Promise<string> =>
      ipcRenderer.invoke('personas:set-avatar-image', id, dataUri),
    /** 清除自定义头像（回落 Humation 生成头像）。 */
    clearAvatarImage: (id: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('personas:clear-avatar-image', id)
  },
  /**
   * MCP 服务（全局 ~/.deva/mcp.json）：列出 / 读取 / 增改删 / 启停 / 重试 / 密钥。
   * 启用即连接：连接由主进程按启用态、配置、密钥自动对账，渲染层不直接连 / 断。
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
    /** 设置可用角色（角色 id 数组；null = 全部角色）。只影响哪些角色的对话里能用，不重连。 */
    setRoles: (id: string, roles: string[] | null): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('mcp:set-roles', id, roles),
    /** 连接失败后手动重试（按当前配置重新对账），返回最新视图。 */
    retry: (id: string): Promise<McpServerView | null> => ipcRenderer.invoke('mcp:retry', id),
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
  /** 服务商探针：拉取模型清单（在主进程发起，密钥不出主进程）。 */
  provider: {
    listModels: (cfg: ProbeConfig): Promise<ProviderListModelsResult> =>
      ipcRenderer.invoke('provider:list-models', cfg)
  },
  /** 会话：发送、中止、重置、列表/载入/删除、回应权限、订阅流式事件。 */
  chat: {
    send: (req: ChatSendRequest): Promise<{ turnId: string }> =>
      ipcRenderer.invoke('chat:send', req),
    /** 回合进行中插入一条消息（见 ChatInsertRequest）。 */
    insert: (req: ChatInsertRequest): Promise<ChatInsertResult> => ipcRenderer.invoke('chat:insert', req),
    /** 撤回某对话全部待送达的插入消息，返回合并后的原文（没有则为空串）。 */
    withdrawInserts: (sessionId: string): Promise<{ text: string }> =>
      ipcRenderer.invoke('chat:withdraw-inserts', sessionId),
    /** 手动压缩历史（/compact）：无后续模型轮，只回发 compacted + done 事件。 */
    compact: (req: ChatCompactRequest): Promise<{ turnId: string }> =>
      ipcRenderer.invoke('chat:compact', req),
    /** 立即建档一条空对话（对话优先外壳）：首发前即落盘，重启仍在。 */
    createSession: (req: ChatCreateSessionRequest): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:create-session', req),
    /** 切换本对话模型并立即落库（不等下一次发送）。 */
    setModel: (req: ChatSetModelRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:set-model', req),
    /** 切换本对话思考等级并立即落库（不等下一次发送）。 */
    setEffort: (req: ChatSetEffortRequest): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:set-effort', req),
    /** 挂载 / 卸载本对话的聚焦工作区并立即落库（不等下一次发送）。 */
    setFocus: (req: ChatSetFocusRequest): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:set-focus', req),
    /** 重命名对话并立即落库，回传最终标题（清空即恢复自动标题）；尚未建档的会话回 null。 */
    renameSession: (req: ChatRenameSessionRequest): Promise<{ title: string } | null> =>
      ipcRenderer.invoke('chat:rename-session', req),
    /** 归档 / 取消归档并立即落库（不改顺序）；尚未建档的会话回 ok:false。 */
    setArchived: (req: { sessionId: string; archived: boolean }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:set-archived', req),
    abort: (turnId: string): Promise<{ ok: true }> => ipcRenderer.invoke('chat:abort', turnId),
    /** 停止一个后台运行的子智能体（toolUseId = 其 Task 卡 id）；已结束 / 不存在回 ok:false。 */
    stopSubagent: (sessionId: string, toolUseId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:stop-subagent', sessionId, toolUseId),
    reset: (sessionId: string, workspaceRoot: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:reset', sessionId, workspaceRoot),
    /** 某项目下的会话清单（按 updatedAt 倒序） */
    listSessions: (workspaceRoot: string | null): Promise<ChatSessionMeta[]> =>
      ipcRenderer.invoke('chat:list-sessions', workspaceRoot),
    /** 载入某会话历史，重建展示气泡 */
    loadSession: (sessionId: string, workspaceRoot: string | null): Promise<DisplayMessage[]> =>
      ipcRenderer.invoke('chat:load-session', sessionId, workspaceRoot),
    /** 载入历史 + 进行中回合的 turnId（同一时刻取出，用于接上别处发起、仍在跑的一轮） */
    attachSession: (sessionId: string): Promise<{ messages: DisplayMessage[]; turnId: string | null }> =>
      ipcRenderer.invoke('chat:attach-session', sessionId),
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
    /** 待办清单：某会话的当前状态（切到该会话时拉取，此后的变化走 todos 事件）。 */
    todos: (sessionId: string): Promise<TodoState> => ipcRenderer.invoke('chat:todos', sessionId),
    /** 手动取消当前清单（回合进行中不受理）：胶囊收起，下一条消息告知模型。返回取消后的状态。 */
    cancelTodoList: (sessionId: string): Promise<TodoState> =>
      ipcRenderer.invoke('chat:todo-cancel', sessionId),
    /** 检查点回滚·列表：每轮的改动量 + 能否撤销上次回滚。 */
    rewindList: (sessionId: string): Promise<{ turns: RewindTurnStat[]; canUndo: boolean }> =>
      ipcRenderer.invoke('chat:rewind-list', sessionId),
    /** 检查点回滚·预览：回到第 turn 轮之前要动的文件与撤不回的命令；会话或轮不存在回 null。 */
    rewindPreview: (sessionId: string, turn: number): Promise<RewindPreview | null> =>
      ipcRenderer.invoke('chat:rewind-preview', sessionId, turn),
    /** 检查点回滚·执行（主进程重算计划，不信任渲染层预览）；返回重建的展示气泡。 */
    rewindApply: (req: RewindApplyRequest): Promise<RewindApplyResult> =>
      ipcRenderer.invoke('chat:rewind-apply', req),
    /** 撤销上次回滚（仅当其后没有新消息 / 压缩 / 删轮）。 */
    rewindUndo: (sessionId: string): Promise<RewindUndoResult> =>
      ipcRenderer.invoke('chat:rewind-undo', sessionId),
    /** 落定角色名片终态（接受/拒绝）：持久化 proposals 边车，防重开退回 pending / 重复建角色。 */
    resolveProposal: (
      sessionId: string,
      toolUseId: string,
      status: 'accepted' | 'rejected'
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:resolve-proposal', sessionId, toolUseId, status),
    /**
     * 落定定时任务确认名片——**唯一的授权时刻**：
     * create（带完整信封 taskInput）即在主进程建任务本体 + 独占会话，成功回 taskId；dismiss 记忽略。
     * 创建后触发零交互，故一切授权须在此 taskInput 里议定完毕。
     */
    resolveAutotask: (
      sessionId: string,
      toolUseId: string,
      action: 'create' | 'dismiss',
      taskInput?: TaskCreateInput
    ): Promise<ResolveAutotaskResult> =>
      ipcRenderer.invoke('chat:resolve-autotask', sessionId, toolUseId, action, taskInput),
    /** 回应 ask_user 询问（每题的选中项标签或自由输入；answers 为 null 表示取消） */
    respondAsk: (payload: AskResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:ask-response', payload),
    /** 回应 exit_plan 计划审阅（approve=批准并执行 / keep=继续完善） */
    respondPlan: (payload: PlanResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:plan-response', payload),
    /** 回应「请求挂载工作区」（path=已选目录 / null=暂不挂载） */
    respondMount: (payload: MountResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:mount-response', payload),
    /** 订阅 chat:event，返回取消订阅函数 */
    onEvent: (cb: (payload: ChatEventPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: ChatEventPayload): void => cb(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    },
    /** 对话清单在别处变了（手机上新建的空对话），需重新 listSessions；返回取消订阅函数 */
    onSessionsChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('chat:sessions-changed', listener)
      return () => ipcRenderer.removeListener('chat:sessions-changed', listener)
    }
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
    /** 检出远程分支为本地跟踪分支（checkout --track origin/x） */
    checkoutRemote: (dir: string, remoteRef: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:checkout-remote', dir, remoteRef),
    /** 合并 ref 到当前分支；冲突回 reason=conflict */
    merge: (dir: string, ref: string): Promise<GitOpResult> => ipcRenderer.invoke('git:merge', dir, ref),
    mergeAbort: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:merge-abort', dir),
    /** 删除本地分支；未合并时回 reason=unmerged + count，UI 确认后 force=true 强删 */
    deleteBranch: (dir: string, name: string, force: boolean): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:delete-branch', dir, name, force),
    renameBranch: (dir: string, oldName: string, newName: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:rename-branch', dir, oldName, newName),
    /** 删除远程分支（破坏性，UI 先确认） */
    deleteRemoteBranch: (dir: string, remote: string, branch: string): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:delete-remote-branch', dir, remote, branch),
    log: (dir: string, depth?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke('git:log', dir, depth),
    init: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:init', dir),
    fetch: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:fetch', dir),
    pull: (dir: string): Promise<GitOpResult> => ipcRenderer.invoke('git:pull', dir),
    /** 推送（无 upstream 时传 branch 触发 -u origin <branch> 首推，否则传 null） */
    push: (dir: string, setUpstreamBranch: string | null): Promise<GitOpResult> =>
      ipcRenderer.invoke('git:push', dir, setUpstreamBranch),
    /**
     * AI 生成提交信息：把「将要提交」的 diff 交模型生成（密钥在主进程解密，不经渲染层）；locale 跟随界面语言。
     * 带 reqId 时边生成边经 onCommitMessageDelta 推送原始片段，并可用 cancelCommitMessage 中断。
     */
    generateCommitMessage: (
      dir: string,
      model: GitGenModel,
      locale: GitGenLocale,
      reqId?: string
    ): Promise<GitGenerateResult> =>
      ipcRenderer.invoke('git:generate-commit-message', dir, model, locale, reqId),
    /** 中断 reqId 对应的生成（已结束则无操作） */
    cancelCommitMessage: (reqId: string): Promise<boolean> =>
      ipcRenderer.invoke('git:cancel-commit-message', reqId),
    /** 订阅生成中的原始文本片段，返回取消订阅函数 */
    onCommitMessageDelta: (cb: (reqId: string, text: string) => void): (() => void) => {
      const listener = (_e: unknown, reqId: string, text: string): void => cb(reqId, text)
      ipcRenderer.on('git:commit-gen-delta', listener)
      return () => ipcRenderer.removeListener('git:commit-gen-delta', listener)
    }
  },
  /**
   * 定时任务 / 自动任务（全局 ~/.deva/tasks.json）：列出 / 读取 / 创建 / 更新 / 删除 / 启停 / 立即运行。
   * 创建时批准、执行时零交互——授权信封在任务创建时议定，触发执行不再弹任何确认。
   */
  tasks: {
    list: (): Promise<TaskRecord[]> => ipcRenderer.invoke('tasks:list'),
    get: (id: string): Promise<TaskRecord | null> => ipcRenderer.invoke('tasks:get', id),
    create: (input: TaskCreateInput): Promise<CreateTaskResult> =>
      ipcRenderer.invoke('tasks:create', input),
    update: (input: TaskUpdateInput): Promise<TaskRecord | null> =>
      ipcRenderer.invoke('tasks:update', input),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('tasks:delete', id),
    setStatus: (id: string, status: TaskStatus): Promise<TaskRecord | null> =>
      ipcRenderer.invoke('tasks:set-status', id, status),
    /**
     * 立即运行（委托调度器串行队列；调度器未就绪则 ok:false）。
     * 同一任务已在运行 / 排队时不重复入队，返回 ok:true + already。
     */
    runNow: (
      id: string
    ): Promise<{ ok: boolean; reason?: string; already?: 'running' | 'queued' }> =>
      ipcRenderer.invoke('tasks:run-now', id),
    /**
     * 校验日程并返回人读摘要 + 下次触发（确认名片实时预览，只读不建任务）。
     * `allowPast`：任务列表/详情展示已创建任务时传 true——一次性时间虽已过但日程合法则回落人读摘要，
     * 不把「已完成」误标为「日程无效」（名片编辑态省略，默认严格：过期即报错）。
     */
    preview: (
      schedule: TaskSchedule,
      locale: 'zh-CN' | 'en',
      allowPast?: boolean
    ): Promise<PreviewScheduleResult> =>
      ipcRenderer.invoke('tasks:preview', schedule, locale, allowPast === true),
    /** 订阅 tasks:changed 全量广播，返回取消订阅函数（仿 mcp.onStatus）。 */
    onChanged: (cb: (tasks: TaskRecord[]) => void): (() => void) => {
      const listener = (_e: unknown, tasks: TaskRecord[]): void => cb(tasks)
      ipcRenderer.on('tasks:changed', listener)
      return () => ipcRenderer.removeListener('tasks:changed', listener)
    },
    /**
     * 订阅 tasks:navigate 导航意图，返回取消订阅函数。
     * 主进程发起：通知点击带 `{sessionId}`（打开定时任务独占会话 / 刚回复完的对话）；托盘「定时任务概览」带 `{pane:'tasks'}`（切到 Tasks 标签）。
     */
    onNavigate: (cb: (payload: { sessionId?: string; pane?: 'tasks' }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { sessionId?: string; pane?: 'tasks' }): void =>
        cb(payload)
      ipcRenderer.on('tasks:navigate', listener)
      return () => ipcRenderer.removeListener('tasks:navigate', listener)
    }
  },
  /**
   * 系统剪贴板纯文本读写（走主进程原生 clipboard）。
   * sandbox 下 navigator.clipboard.readText 不可靠，故读/写统一走这里。
   */
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
    writeText: (text: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('clipboard:write-text', text)
  },
  /**
   * 交付卡（present_files）。只传对话 id + 调用 id + 序号：路径由主进程从该对话历史里那次调用取，
   * 只能作用于模型交付给用户的文件。
   */
  deliverables: {
    inspect: (sessionId: string, toolUseId: string): Promise<DeliverableInfo[]> =>
      ipcRenderer.invoke('deliverables:inspect', sessionId, toolUseId),
    /** 系统缩略图（取不到回落文件图标）的 data URL；文件不存在等返回 null。 */
    thumbnail: (sessionId: string, toolUseId: string, index: number): Promise<string | null> =>
      ipcRenderer.invoke('deliverables:thumbnail', sessionId, toolUseId, index),
    /** 用默认应用打开（仅成品类扩展名，见 DeliverableInfo.openable）。 */
    open: (sessionId: string, toolUseId: string, index: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('deliverables:open', sessionId, toolUseId, index),
    /** 在系统文件管理器中显示并选中该文件。 */
    reveal: (sessionId: string, toolUseId: string, index: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('deliverables:reveal', sessionId, toolUseId, index)
  },
  /**
   * 检查更新（设置 → 关于）。状态由主进程持有，经 onState 推送；check / download / install 只负责触发。
   * download：Windows exe 安装的在应用内下载，其余在浏览器里打开安装包直链。
   */
  /**
   * 内置浏览器（Deva 操作网页用）。主窗口输入框上方的胶囊与「Deva 浏览器」窗口的外框共用：状态经 onState 推送；
   * 窗口收起时网页在屏幕外继续运行。
   */
  browser: {
    getState: (): Promise<BrowserUiState> => ipcRenderer.invoke('browser:state'),
    /** 外框界面载入完成，拉一次状态。 */
    ready: (): Promise<BrowserUiState> => ipcRenderer.invoke('browser:ready'),
    onState: (cb: (state: BrowserUiState) => void): (() => void) => {
      const listener = (_e: unknown, state: BrowserUiState): void => cb(state)
      ipcRenderer.on('browser:state', listener)
      return () => ipcRenderer.removeListener('browser:state', listener)
    },
    /** 展开窗口：切到指定标签，或某个对话的当前标签。 */
    open: (opts: { tab?: string; sessionId?: string } = {}): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:open', opts),
    /** 收起到胶囊（网页继续在后台运行）。 */
    dock: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:dock'),
    /** 关闭某对话打开的全部网页（正等用户操作时不关，返回 ok:false）。 */
    closeSession: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:close-session', sessionId),
    /** 胶囊预览卡「固定」着看哪个标签（null = 没固定）：用户正在看，Deva 关不掉、闲置也不回收。 */
    setPreviewPinned: (tab: string | null): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:preview-pinned', tab),
    /** 预览卡开始显示某个标签的实时画面（同一时间只推一个标签）；帧经 onLiveFrame 到达。 */
    liveStart: (tab: string): Promise<boolean> => ipcRenderer.invoke('browser:live-start', tab),
    liveStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:live-stop'),
    onLiveFrame: (cb: (frame: BrowserLiveFrame) => void): (() => void) => {
      const listener = (_e: unknown, frame: BrowserLiveFrame): void => cb(frame)
      ipcRenderer.on('browser:live-frame', listener)
      return () => ipcRenderer.removeListener('browser:live-frame', listener)
    },
    pin: (on: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:pin', on),
    activate: (tab: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:activate', tab),
    closeTab: (tab: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:close-tab', tab),
    nav: (tab: string, what: 'back' | 'forward' | 'reload' | 'stop'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:nav', tab, what),
    /**
     * 标签条「⋯」的系统菜单（前进 / 刷新 / 复制链接 / 在系统浏览器中打开），弹在窗口内坐标 at；菜单关闭后才返回。
     * labels 是各项文案（forward、reload、stopLoading、copyLink、openExternal），由外框按界面语言传入。
     */
    menu: (tab: string, labels: Record<string, string>, at: { x: number; y: number }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:menu', tab, labels, at),
    /** 网页当前画面的缩略图（data URL，宽 480）；取不到返回 null。 */
    thumbnail: (tab: string): Promise<string | null> => ipcRenderer.invoke('browser:thumbnail', tab),
    /** 等用户操作时的「完成，继续」/「跳过」。 */
    handoff: (sessionId: string, answer: 'done' | 'skip'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('browser:handoff', sessionId, answer),
    /** 停止该对话正在进行的回合。 */
    stop: (sessionId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('browser:stop', sessionId)
  },
  update: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get-state'),
    check: (): Promise<void> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on('update:state', listener)
      return () => ipcRenderer.removeListener('update:state', listener)
    }
  },
  /** 远程通道 / 手机端（飞书、Telegram 等 IM 机器人）。密钥只写不读。 */
  remote: {
    getState: (): Promise<RemoteState> => ipcRenderer.invoke('remote:get-state'),
    /** 开始扫码创建机器人：返回二维码（data URL）；结果经 onScan 推回。Telegram 需带 @BotFather 给的 Token。 */
    scanStart: (
      platform: BotPlatform,
      opts?: { token?: string }
    ): Promise<
      | { ok: true; scanId: string; qr: string; link?: string; userCode?: string; expiresAt: number }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('remote:scan-start', platform, opts),
    scanCancel: (scanId: string): Promise<{ ok: true }> => ipcRenderer.invoke('remote:scan-cancel', scanId),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('remote:set-enabled', id, enabled),
    setReplyMode: (id: string, mode: BotReplyMode): Promise<{ ok: true }> =>
      ipcRenderer.invoke('remote:set-reply-mode', id, mode),
    setScope: (id: string, scope: BotReplyScope): Promise<{ ok: true }> =>
      ipcRenderer.invoke('remote:set-scope', id, scope),
    deleteBot: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('remote:delete-bot', id),
    pairCode: (id: string): Promise<{ code: string; expiresAt: number }> =>
      ipcRenderer.invoke('remote:pair-code', id),
    pairCancel: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('remote:pair-cancel', id),
    removeUser: (id: string, userId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('remote:remove-user', id, userId),
    onChanged: (cb: (state: RemoteState) => void): (() => void) => {
      const listener = (_e: unknown, state: RemoteState): void => cb(state)
      ipcRenderer.on('remote:changed', listener)
      return () => ipcRenderer.removeListener('remote:changed', listener)
    },
    onScan: (cb: (ev: BotScanEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: BotScanEvent): void => cb(ev)
      ipcRenderer.on('remote:scan', listener)
      return () => ipcRenderer.removeListener('remote:scan', listener)
    }
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
