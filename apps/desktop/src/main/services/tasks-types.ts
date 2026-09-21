/**
 * 定时任务 / 自动任务（Scheduled / Automated Tasks）· 共享类型。
 *
 * 单独成文件（不含 electron / fs 依赖），供纯引擎 `schedule.ts`、store `tasks.ts`、
 * 调度器 `scheduler.ts` 与会话编排 `chat.ts` 共同引用而不产生循环依赖。
 *
 * 命名避坑：绝不复用「任务 / Task」这一 `run_subagent` 卡的词面——这里是**定时任务 / 自动任务**，
 * 工具 `create_task`、块 `autotaskcard`、IPC 命名空间 `tasks:` 严格区隔子智能体的 Task 卡。
 *
 * 核心约束（用户明确）：**创建时批准、执行时零交互**。授权信封（TaskAuthorization）在任务存在之前
 * 一次性议定，触发执行时绝不再弹任何确认（无权限框 / 无 ask_user / 无 exit_plan）。
 * 信封仅承载「以何身份/模型运行」（persona + model）；工具一律可用、写入除硬底线外不设限，
 * 由 sealedDecision 的安全地板统一把关——不再有工具白名单 / 写入根 / 通知开关。
 */

/**
 * 任务状态：
 * - `active`  正常调度中；
 * - `paused`  用户暂停（或连续错误达阈值自动暂停）；
 * - `completed` 一次性任务已触发完成（nextRunAt=null）；
 * - `error`   连续错误达阈值，转错误态（弹一次通知，等用户处理）。
 */
export type TaskStatus = 'active' | 'paused' | 'completed' | 'error'

/** 日程：一次性（墙钟 ISO）或周期（5 段 cron）；tz 为创建时捕获的 IANA 时区。 */
export interface TaskSchedule {
  kind: 'once' | 'recurring'
  /** 'once'：本地墙钟 ISO（无偏移），如 "2026-09-21T17:00"。 */
  at?: string
  /** 'recurring'：5 段 cron（min hour dom mon dow）。 */
  cron?: string
  /** 创建时捕获的 IANA 时区，如 "Asia/Shanghai"；跨 OS 时区变更后任务仍按此可预测求值。 */
  tz: string
}

/**
 * 授权信封：创建时议定「以何身份/模型运行」。工具一律可用、写入除硬底线外不设限。
 * 安全地板（Tier-1 敏感路径 / Tier-2 保护目录 / 危险命令）不可协商——sealedDecision 无条件强制。
 */
export interface TaskAuthorization {
  /** 绑定人格 id；null → 无人格（同 runTurn 无 persona 时行为）。人格被删则不注入人格提示。 */
  personaId: string | null
  /** 模型引用 `"providerId:modelId"`；null → 全局默认（resolveDefaultModel）。 */
  modelRef: string | null
}

/** 单次运行记录（有界环形，保留最近 ~50 条）。 */
export interface TaskRun {
  firedAt: number
  finishedAt?: number
  status: 'ok' | 'error' | 'skipped'
  /** ok：模型末轮可见文本首行摘要；skipped：追赶跳过说明。 */
  summary?: string
  /** error：失败原因（stopReason / 异常信息）。 */
  error?: string
}

/** 一条定时任务的完整记录（持久化于 ~/.deva/tasks.json）。 */
export interface TaskRecord {
  id: string
  title: string
  /** 触发时作为合成 user 消息发给模型的指令正文。 */
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
  /** 独占会话 id（创建时铸；每次触发向该会话追加一轮）。 */
  sessionId: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  /** 上次触发 UTC epoch ms；从未触发为 null。 */
  lastRunAt: number | null
  /** 下次触发 UTC epoch ms；每次触发后重算；once 完成 / 无更多触发为 null。 */
  nextRunAt: number | null
  /** 连续错误计数（成功清零；达阈值自动暂停/转错误态并弹一次通知）。 */
  consecutiveErrors: number
  /** 运行历史（有界环形，保留最近 ~50 条）。 */
  runs: TaskRun[]
}

/** 创建入参（渲染层经确认名片提交；日程/授权信封由用户编辑并授权）。 */
export interface TaskCreateInput {
  title: string
  prompt: string
  schedule: TaskSchedule
  auth: TaskAuthorization
}

/** 更新入参（部分字段；id 定位）。日程改变则重算 nextRunAt。 */
export interface TaskUpdateInput {
  id: string
  title?: string
  prompt?: string
  schedule?: TaskSchedule
  auth?: Partial<TaskAuthorization>
}

/** tasks.json 磁盘形状。 */
export interface TasksFile {
  version: 1
  tasks: TaskRecord[]
}

/** 运行历史环形上限。 */
export const MAX_RUNS_PER_TASK = 50

/** 连续错误达此阈值 → 自动转 error 态并弹一次通知。 */
export const ERROR_PAUSE_THRESHOLD = 5
