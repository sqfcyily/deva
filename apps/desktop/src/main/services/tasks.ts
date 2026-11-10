import { BrowserWindow, ipcMain } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getDevaHome } from './config'
import { publishSessionsChanged } from './chat-bus'
import { listSessions, rebindSessionPersona, syncSessionBinding } from './chat-store'
import { nextRun, parseCron, isValidTimeZone, describeSchedule, parseWallIso } from './schedule'
import {
  ERROR_PAUSE_THRESHOLD,
  MAX_RUNS_PER_TASK,
  type TaskAuthorization,
  type TaskCreateInput,
  type TaskRecord,
  type TaskRun,
  type TaskSchedule,
  type TaskStatus,
  type TaskUpdateInput,
  type TasksFile
} from './tasks-types'

/**
 * 定时任务 store（主进程）· 对标 skills.ts：模块级内存 Map + 懒加载 + 原子回写。
 *
 * 持久化：`~/.deva/tasks.json` = `{ version:1, tasks:TaskRecord[] }`，走 getDevaHome()（尊重 DEVA_HOME）。
 * 因是**单文件汇总所有任务**（不同于「一对话一文件」），采用「临时文件 + rename」原子回写，杜绝写坏半份。
 *
 * 执行不在此文件：本文件只管 CRUD 与持久化 + `tasks:changed` 广播。真正的无头触发由 scheduler.ts
 * 经**可注入运行器**（setTaskRunner）接管——避免 tasks.ts → chat.ts 的循环依赖。scheduler 未装载时
 * `tasks:run-now` 优雅降级（返回 ok:false）。
 */

// ── 内存态 + 持久化 ──────────────────────────────────────────────────────────

/** id → 任务（内存缓存，惰性载入）。 */
const cache = new Map<string, TaskRecord>()
let loaded = false

/** 广播用窗口取用器（registerTasksIpc 注入）。 */
let getWin: (() => BrowserWindow | null) | null = null

function tasksFile(): string {
  return join(getDevaHome(), 'tasks.json')
}

/** 惰性载入 tasks.json 到内存 Map；缺失/损坏 → 空表（绝不抛错）。 */
function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = readFileSync(tasksFile(), 'utf8')
    const parsed = JSON.parse(raw) as TasksFile
    if (parsed && Array.isArray(parsed.tasks)) {
      for (const t of parsed.tasks) {
        if (t && typeof t.id === 'string') cache.set(t.id, normalizeRecord(t))
      }
    }
  } catch {
    /* 首启无文件 / 解析失败 → 空表 */
  }
}

/** 逐字段容错，补齐可能缺失的运行期字段（向后兼容旧文件）。 */
function normalizeRecord(t: TaskRecord): TaskRecord {
  return {
    ...t,
    // 旧记录可能带已废弃的 auth.focusRoot/allowedTools/allowNotify 与顶层 kind：
    // 经 sanitizeAuth 收窄到 persona+model 形状（顶层残留字段无处读取，无害）。
    auth: sanitizeAuth(t.auth),
    consecutiveErrors: typeof t.consecutiveErrors === 'number' ? t.consecutiveErrors : 0,
    runs: Array.isArray(t.runs) ? t.runs : [],
    lastRunAt: typeof t.lastRunAt === 'number' ? t.lastRunAt : null,
    nextRunAt: typeof t.nextRunAt === 'number' ? t.nextRunAt : null,
    ...(typeof t.ownerSessionId === 'string' && t.ownerSessionId ? { ownerSessionId: t.ownerSessionId } : {}),
    ...(typeof t.originSessionId === 'string' && t.originSessionId ? { originSessionId: t.originSessionId } : {})
  }
}

/** 原子回写 tasks.json + 广播 tasks:changed（所有 CRUD 变更的唯一落盘点）。 */
function persist(): void {
  const file = tasksFile()
  const payload: TasksFile = { version: 1, tasks: [...cache.values()] }
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 落盘失败静默：内存态仍可用，下次成功保存即自愈 */
  }
  emitChanged()
}

function emitChanged(): void {
  try {
    getWin?.()?.webContents.send('tasks:changed', listTasks())
  } catch {
    /* 窗口不可用（关闭/隐藏）→ 忽略，渲染层下次打开经 tasks:list 追平 */
  }
}

// ── 纯 CRUD ──────────────────────────────────────────────────────────────────

/** 全部任务（按创建时间升序，稳定展示）。 */
export function listTasks(): TaskRecord[] {
  ensureLoaded()
  return [...cache.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export function getTask(id: string): TaskRecord | null {
  ensureLoaded()
  return cache.get(id) ?? null
}

/** 以某会话为任务对话的任务（没有则 null）。chat.ts 据此判断一轮定时运行属于哪个任务、绑定了哪个主对话。 */
export function findTaskBySession(sessionId: string): TaskRecord | null {
  ensureLoaded()
  for (const t of cache.values()) if (t.sessionId === sessionId) return t
  return null
}

/** 绑定在某个主对话上的任务（见 TaskRecord.ownerSessionId）。 */
export function tasksOwnedBy(ownerSessionId: string): TaskRecord[] {
  ensureLoaded()
  return [...cache.values()].filter((t) => t.ownerSessionId === ownerSessionId)
}

/**
 * 「在会话中运行」能选的会话：存在的普通对话（不是成员会话、不是任务自己的对话）。不合格返回 undefined（= 独立运行）。
 */
function validOwner(sessionId: unknown, taskSessionId?: string): string | undefined {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.startsWith('task-') || sessionId === taskSessionId)
    return undefined
  const meta = listSessions().find((s) => s.id === sessionId)
  return meta && !meta.parentId ? sessionId : undefined
}

/**
 * 会话被删除：在它里面运行的任务改为独立运行（任务和它的对话都保留，任务对话回到左侧列表）。
 * 返回改了几个任务。
 */
export function releaseTasksOwnedBy(ownerSessionId: string): number {
  ensureLoaded()
  let n = 0
  for (const t of cache.values()) {
    if (t.ownerSessionId !== ownerSessionId) continue
    delete t.ownerSessionId
    t.updatedAt = Date.now()
    n++
  }
  if (n) {
    persist()
    publishSessionsChanged()
  }
  return n
}

/** 创建结果：成功带记录，失败带稳定错误码（渲染层据此本地化）。 */
export type CreateTaskResult =
  | { ok: true; task: TaskRecord }
  | {
      ok: false
      error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' | 'expired'
    }

/** 规整授权信封（防越权字段渗入；只保留 persona + model 形状）。 */
function sanitizeAuth(auth: Partial<TaskAuthorization> | undefined): TaskAuthorization {
  const a = auth ?? {}
  return {
    personaId: typeof a.personaId === 'string' && a.personaId ? a.personaId : null,
    modelRef: typeof a.modelRef === 'string' && a.modelRef ? a.modelRef : null
  }
}

/**
 * 新建任务：schedule.ts 校验（拒非法 cron / 无效时区 / 已过期的 once）、算初始 nextRunAt、铸独占 sessionId。
 * **不落项目**：sessionId 恒 `task-<id>`（chat-store safeId 白名单安全）。
 */
export function createTask(input: TaskCreateInput): CreateTaskResult {
  ensureLoaded()
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid-input' }
  const title = (input.title || '').trim()
  const prompt = (input.prompt || '').trim()
  const sched = input.schedule
  if (!prompt || !sched || typeof sched !== 'object') return { ok: false, error: 'invalid-input' }
  if (!isValidTimeZone(sched.tz)) return { ok: false, error: 'invalid-tz' }

  if (sched.kind === 'recurring') {
    if (!parseCron(sched.cron ?? '')) return { ok: false, error: 'invalid-cron' }
    // 病态但语法合法的 cron（如 2/30、4/31 永不成日）：nextRun 扫满上限返回 null → 创建时拒绝。
    if (nextRun(sched, Date.now()) == null) return { ok: false, error: 'invalid-cron' }
  } else if (sched.kind === 'once') {
    // 校验墙钟可解析 + 未过期（nextRun 返回 null 即已过期或非法）。
    const at = nextRun(sched, Date.now())
    if (at == null) return { ok: false, error: 'invalid-once' }
  } else {
    return { ok: false, error: 'invalid-input' }
  }

  const now = Date.now()
  const id = randomUUID()
  const first = nextRun(sched, now)
  if (first == null && sched.kind === 'once') return { ok: false, error: 'expired' }

  const task: TaskRecord = {
    id,
    title: title || prompt.slice(0, 30),
    prompt,
    schedule: sched,
    auth: sanitizeAuth(input.auth),
    sessionId: `task-${id}`,
    ...(typeof input.originSessionId === 'string' && input.originSessionId
      ? { originSessionId: input.originSessionId }
      : {}),
    ...(validOwner(input.ownerSessionId) ? { ownerSessionId: input.ownerSessionId } : {}),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: first,
    consecutiveErrors: 0,
    runs: []
  }
  cache.set(id, task)
  persist()
  // 在会话中运行：任务对话不进左侧列表，那个会话的标题栏出现定时任务入口。
  if (task.ownerSessionId) publishSessionsChanged()
  return { ok: true, task }
}

/** 更新任务（部分字段）；日程/时区变更则重算 nextRunAt。找不到返回 null。 */
export function updateTask(input: TaskUpdateInput): TaskRecord | null {
  ensureLoaded()
  const t = cache.get(input.id)
  if (!t) return null
  if (typeof input.title === 'string') t.title = input.title.trim() || t.title
  if (typeof input.prompt === 'string' && input.prompt.trim()) t.prompt = input.prompt.trim()
  if (input.auth) {
    t.auth = sanitizeAuth({ ...t.auth, ...input.auth })
    // 角色 / 模型两边同步：任务的独占对话跟着改（对话还没建 = 从没运行过，首次运行时按任务建）。
    // 角色为空（= 默认角色）时不动对话，运行时由 runScheduledTurn 兜成默认角色。
    if (
      syncSessionBinding(t.sessionId, {
        personaId: t.auth.personaId ?? undefined,
        model: t.auth.modelRef ?? ''
      })
    )
      publishSessionsChanged()
  }
  // 运行方式：null = 独立运行，会话 id = 在该会话中运行（不合格的会话按独立运行处理）。切换后任务对话进出左侧列表。
  if (input.ownerSessionId !== undefined) {
    const owner = input.ownerSessionId === null ? undefined : validOwner(input.ownerSessionId, t.sessionId)
    if ((t.ownerSessionId ?? undefined) !== owner) {
      if (owner) t.ownerSessionId = owner
      else delete t.ownerSessionId
      publishSessionsChanged()
    }
  }
  if (input.schedule && typeof input.schedule === 'object') {
    const sched = input.schedule
    if (isValidTimeZone(sched.tz)) {
      const ok =
        sched.kind === 'recurring'
          ? !!parseCron(sched.cron ?? '')
          : sched.kind === 'once'
            ? nextRun(sched, Date.now()) != null
            : false
      if (ok) {
        t.schedule = sched
        t.nextRunAt = nextRun(sched, Date.now())
        // 日程改了 → 若之前已完成/错误，重新激活。
        if (t.status === 'completed' || t.status === 'error') t.status = 'active'
        t.consecutiveErrors = 0
      }
    }
  }
  t.updatedAt = Date.now()
  persist()
  return t
}

/**
 * 删除任务。绑定了主对话的任务连它的任务对话一起删（绑定后任务对话不在左侧列表，留下会成为看不到的孤儿对话）；
 * 独立运行的任务只删记录，任务对话留在对话列表里由用户自行删除。任务对话经 setTaskSessionPurger 注入的删除器删
 * （正在跑的一轮由它中止），chat.ts 装载前退化为只删记录。
 */
export function deleteTask(id: string): void {
  ensureLoaded()
  const t = cache.get(id)
  if (!t) return
  cache.delete(id)
  persist()
  if (t.ownerSessionId) purgeSessionImpl?.(t.sessionId)
}

/** 任务对话的删除器（chat.ts purgeSession）：删绑定任务时连任务对话一起删。 */
let purgeSessionImpl: ((sessionId: string) => void) | null = null
export function setTaskSessionPurger(fn: ((sessionId: string) => void) | null): void {
  purgeSessionImpl = fn
}

/**
 * 任务对话里切换了模型（chat:set-model）：同步为任务的模型——两边以同一个为准（反向见 updateTask）。
 * 空串 = 跟随全局默认（modelRef null）。不是任务对话 / 没变化则什么都不做。
 */
export function syncTaskModel(sessionId: string, modelRef: string): void {
  ensureLoaded()
  const ref = modelRef || null
  for (const t of cache.values()) {
    if (t.sessionId !== sessionId) continue
    if (t.auth.modelRef !== ref) {
      t.auth = sanitizeAuth({ ...t.auth, modelRef: ref })
      t.updatedAt = Date.now()
      persist()
    }
    return
  }
}

/**
 * 角色被删：绑定它的任务改由 `to` 执行（personas.ts deletePersona 调用）。任务的独占对话一并改挂——
 * 仍挂着被删角色的对话（含任务改过角色、对话还停在旧角色的）改挂任务当前的角色。
 */
export function reassignTaskPersona(from: string, to: string): void {
  ensureLoaded()
  if (from === to) return
  let changed = false
  let rebound = false
  for (const t of cache.values()) {
    if (t.auth.personaId === from) {
      t.auth = { ...t.auth, personaId: to }
      t.updatedAt = Date.now()
      changed = true
    }
    if (rebindSessionPersona(t.sessionId, from, t.auth.personaId ?? to)) rebound = true
  }
  if (changed) persist()
  if (rebound) publishSessionsChanged()
}

/**
 * 设置状态（暂停/恢复/手动激活）。转入 active 时重算 nextRunAt 并清连续错误（跨过错过时间取下一次）。
 * once 已完成不允许被 active 复活（其 nextRunAt 恒 null，靠改日程才重生）。
 */
export function setTaskStatus(id: string, status: TaskStatus): TaskRecord | null {
  ensureLoaded()
  const t = cache.get(id)
  if (!t) return null
  t.status = status
  if (status === 'active') {
    t.consecutiveErrors = 0
    t.nextRunAt = nextRun(t.schedule, Date.now())
    // once 已过期 → 无下次触发，回落 completed（避免卡在 active 却永不触发）。
    if (t.nextRunAt == null && t.schedule.kind === 'once') t.status = 'completed'
  }
  t.updatedAt = Date.now()
  persist()
  return t
}

/** 追加一条运行记录（有界环形，保留最近 MAX_RUNS_PER_TASK 条）。scheduler 触发后调用。 */
export function appendRun(id: string, run: TaskRun): TaskRecord | null {
  ensureLoaded()
  const t = cache.get(id)
  if (!t) return null
  t.runs.push(run)
  if (t.runs.length > MAX_RUNS_PER_TASK) t.runs.splice(0, t.runs.length - MAX_RUNS_PER_TASK)
  t.updatedAt = Date.now()
  persist()
  return t
}

/**
 * 触发后统一善后（scheduler 专用）：写 lastRunAt、重算 nextRunAt、退避/自动暂停、once 转完成。
 * `result.ok` 决定连续错误计数的清零/累加与是否转 error 态；`result.aborted`（被用户中止）既不算成功也不算
 * 失败：连续错误计数不动，一次性任务照常转完成，周期任务照常排下一次。
 * 返回 `{ task, autoPausedError }`——autoPausedError 为 true 时 scheduler 弹一次错误通知。
 */
export function applyRunResult(
  id: string,
  result: { ok: boolean; aborted?: boolean },
  firedAt: number
): { task: TaskRecord; autoPausedError: boolean } | null {
  ensureLoaded()
  const t = cache.get(id)
  if (!t) return null
  const now = Date.now()
  t.lastRunAt = firedAt
  const failed = !result.ok && !result.aborted

  let autoPausedError = false
  if (result.ok) {
    t.consecutiveErrors = 0
  } else if (failed) {
    t.consecutiveErrors += 1
  }

  if (t.schedule.kind === 'once') {
    // 一次性：无论成败都不再重排（错误也不重试——避免无声反复烧 token）。
    t.nextRunAt = null
    t.status = failed ? 'error' : 'completed'
    if (failed) autoPausedError = true
  } else {
    // 周期：达阈值转 error（弹一次 + 停排），否则重算下次。
    if (failed && t.consecutiveErrors >= ERROR_PAUSE_THRESHOLD) {
      t.status = 'error'
      t.nextRunAt = null
      autoPausedError = true
    } else {
      t.nextRunAt = nextRun(t.schedule, now)
      if (t.nextRunAt == null) t.status = 'completed'
      else if (t.status !== 'active') t.status = 'active'
    }
  }
  t.updatedAt = now
  persist()
  return { task: t, autoPausedError }
}

// ── 日程预览（确认名片实时校验 + 人读摘要 + 下次触发）──────────────────────

/** 预览结果：成功带人读摘要与下次触发（epoch ms，null=无更多触发）；失败带与 createTask 一致的错误码。 */
export type PreviewScheduleResult =
  | { ok: true; description: string; nextRunAt: number | null }
  | { ok: false; error: 'invalid-input' | 'invalid-tz' | 'invalid-cron' | 'invalid-once' }

/**
 * 校验一份日程并返回人读摘要 + 下次触发，供确认名片实时预览（与 createTask 校验同源，所见即所得）。
 * 纯读、不落盘、不建任务——名片编辑期的只读推演。
 *
 * `allowPast`（默认 false）：名片编辑态用默认——一次性时间已过视为错误（invalid-once），供用户改后重建。
 * 任务列表/详情为**已创建任务的只读展示**（如已完成的一次性任务其墙钟必然已过），传 true——
 * 一次性时间虽已过但日程本身合法时回落人读摘要（nextRunAt=null），避免把「已执行完毕」误标为「日程无效」。
 */
export function previewSchedule(
  schedule: TaskSchedule,
  locale: 'zh-CN' | 'en' = 'zh-CN',
  allowPast = false
): PreviewScheduleResult {
  if (!schedule || typeof schedule !== 'object') return { ok: false, error: 'invalid-input' }
  if (!isValidTimeZone(schedule.tz)) return { ok: false, error: 'invalid-tz' }
  if (schedule.kind === 'recurring') {
    if (!parseCron(schedule.cron ?? '')) return { ok: false, error: 'invalid-cron' }
    const next = nextRun(schedule, Date.now())
    if (next == null) return { ok: false, error: 'invalid-cron' } // 病态但语法合法（如 2/30）
    return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: next }
  }
  if (schedule.kind === 'once') {
    const next = nextRun(schedule, Date.now())
    if (next == null) {
      // 时间已过：仅当墙钟本身可解析（即合法但过期，非畸形）且允许过去时，回落人读摘要。
      if (allowPast && parseWallIso(schedule.at ?? ''))
        return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: null }
      return { ok: false, error: 'invalid-once' } // 非法或（编辑态下）已过期
    }
    return { ok: true, description: describeSchedule(schedule, locale), nextRunAt: next }
  }
  return { ok: false, error: 'invalid-input' }
}

// ── 可注入运行器（scheduler 装载后接管 run-now / 触发）──────────────────────

/**
 * 立即运行一个任务：由 scheduler 提供实现（enqueue 到串行队列）。
 * 返回 'enqueued' 已入队；'running' / 'queued' 表示同一任务正在运行 / 已在排队，本次不重复入队。
 */
export type TaskRunner = (taskId: string) => 'enqueued' | 'running' | 'queued'
let runNowImpl: TaskRunner | null = null

/** scheduler.ts 于 startScheduler 内注入真正的运行器。 */
export function setTaskRunner(fn: TaskRunner | null): void {
  runNowImpl = fn
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** 任务读写 IPC（全局；持久化于 ~/.deva/tasks.json）。 */
export function registerTasksIpc(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow

  ipcMain.handle('tasks:list', (): TaskRecord[] => listTasks())
  ipcMain.handle('tasks:get', (_e, id: string): TaskRecord | null => getTask(id))
  // 管理页手动新建的任务不属于任何对话（originSessionId 只由对话里的确认名片带上，见 chat.ts resolveAutotask）。
  ipcMain.handle('tasks:create', (_e, input: TaskCreateInput): CreateTaskResult =>
    createTask({ ...input, originSessionId: undefined })
  )
  ipcMain.handle('tasks:update', (_e, input: TaskUpdateInput): TaskRecord | null =>
    updateTask(input)
  )
  ipcMain.handle('tasks:delete', (_e, id: string): { ok: true } => {
    deleteTask(id)
    return { ok: true }
  })
  ipcMain.handle('tasks:set-status', (_e, id: string, status: TaskStatus): TaskRecord | null =>
    setTaskStatus(id, status)
  )
  // 确认名片实时预览：校验日程 + 人读摘要 + 下次触发（只读，不建任务）。
  ipcMain.handle(
    'tasks:preview',
    (_e, schedule: TaskSchedule, locale: 'zh-CN' | 'en', allowPast?: boolean): PreviewScheduleResult =>
      previewSchedule(schedule, locale === 'en' ? 'en' : 'zh-CN', allowPast === true)
  )
  // 立即运行：委托 scheduler 的串行队列（未装载则优雅降级）。
  // 同一任务已在运行 / 排队时不重复入队，经 already 告知渲染层（仍 ok:true——不是错误，只是无需再跑）。
  ipcMain.handle(
    'tasks:run-now',
    (_e, id: string): { ok: boolean; reason?: string; already?: 'running' | 'queued' } => {
      if (!runNowImpl) return { ok: false, reason: 'scheduler-not-ready' }
      const t = getTask(id)
      if (!t) return { ok: false, reason: 'not-found' }
      const r = runNowImpl(id)
      return r === 'enqueued' ? { ok: true } : { ok: true, already: r }
    }
  )
}
