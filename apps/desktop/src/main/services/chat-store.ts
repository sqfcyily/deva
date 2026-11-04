import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import { hydrateMessages, mediaReplacer } from './media-store'
import type { EffortLevel, Message } from '../providers/types'
import type { CheckpointRec } from './checkpoints'
import type { TodoEntry } from './todos'

/**
 * 对话持久化（主进程）· 一对话一文件。
 * 对话优先外壳：对话不再「按项目分桶」，而是各自独立成文件 `<DEVA_HOME>/data/chats/<id>.json`，
 * 另有一份仅含元信息（不含正文）的索引 `_index.json` 供左侧列表 O(1) 读取（索引缺失则扫描目录自愈）。
 * 这样单条对话读写互不牵连，避免「每说一句就整文件全量重写所有历史对话」的瓶颈；
 * 对话极多时也只重写当前这一条 + 轻量索引，磁盘写放大与单点写坏风险都被限定在一条对话内。
 *
 * 主进程持有的 provider `Message[]` 是模型上下文的**唯一真源**（续聊时回灌给模型），因此持久化落在主
 * 进程；渲染层仅按需拉取会话清单 / 重建展示。明文 JSON，可手改 / 备份（对标 config.json）；
 * 根目录随 DEVA_HOME 覆盖 —— 便携安装 / 想整体挪到别的盘（如 D:）时设置该环境变量即可。
 *
 * **无「项目 / 分桶」概念**：对话优先外壳是唯一页面（旧 IDE 式 AppShell 已删），对话不再按项目归桶。
 * 每条对话独立成文件、直接落盘，`listSessions` 一次列全部（按 updatedAt 倒序），左侧列表就是全部对话。
 * 「挂载目录」纯粹是**对话属性** `focusRoot`（可挂/卸，决定聚焦工作区、终端 cwd、权限模式键），与「对话
 * 存在哪里 / 列不列出」彻底无关。历史文件里可能残留 `bucket` 字段（旧实现遗留），读时忽略、写时不再产生。
 */

export interface StoredSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /**
   * 上一轮真实输入 token 数（来自 provider 的 usage.input）。
   * 上下文压缩的**首选触发依据**（最准，天然覆盖图片/工具场景）；缺失时压缩逻辑回退字符估算。
   * 压缩后清零（历史已缩短，旧计数失效）。见 services/compaction.ts。
   */
  lastInputTokens?: number
  /**
   * 上一轮的**提示缓存**用量（provider 报告的命中 / 写入 token）。**纯观测字段，不参与任何判定**。
   * 用于核对缓存是否真的生效：命中长期为 0，说明前缀被破坏、或未达该模型的最小可缓存长度。
   * Anthropic 需显式断点才会非零；OpenAI/DeepSeek 是服务端自动前缀缓存，只有命中量没有写入量。
   */
  lastCacheRead?: number
  lastCacheWrite?: number
  /**
   * 绑定的 persona id（对话优先外壳：一对话一身份，单选当值）。
   * 缺省 = 旧版遗留的未绑定对话，执行与显示都按默认角色（见 personas.ts resolvePersonaId）。首发落库后绑定不再改。
   */
  personaId?: string
  /**
   * 该对话的聚焦工作区绝对路径；null/缺省 = 全机通用助手（无聚焦）。
   * 纯对话属性：决定聚焦范围/终端 cwd/权限作用域键，与「对话存哪里/列不列」无关（对话已无分桶概念）。
   */
  focusRoot?: string | null
  /**
   * 本对话的模型引用 `"providerId:modelId"`；空串/缺省 = 跟随全局默认模型（runTurn 的 config）。
   * **快照固定**：随角色新建对话时快照该角色当时的偏好模型（渲染层在 newSession 落进覆盖层、首发时随
   * chat:send 落库）；聊天中切换模型即更新此值——故一对话一模型，同角色的多个对话模型可各不相同，且
   * 日后改角色偏好模型不影响已建对话。偏好模型被删除时，runTurn 经 resolveModelRef 回落全局默认。
   */
  model?: string
  /**
   * 本对话的思考等级（与 model 同一套：对话输入框切换即落库，发送时恒记下生效值）。
   * 缺省 = 尚未定格——runTurn 按 'default'（不发思考参数）处理；渲染层打开对话时会把「最近使用」定格进来。
   */
  effort?: EffortLevel
  /**
   * 已归档：从左侧对话列表移走（经「新建对话」浮层底部的「已归档对话」查看），内容与上下文不受影响。
   * 缺省 = 未归档。在已归档的对话里开始新一轮（发消息 / 定时任务运行 / 后台任务通知）即自动取消。
   */
  archived?: boolean
  /**
   * 角色名片（propose_agent 提议）的终态边车，按 toolUseId 记录 accepted/rejected。
   * 名片本体随 Message[] 天然存活，但其接受/拒绝终态无处落——此边车确保重开不退回 pending、
   * 不重复建角色。pending 不入表（缺省即 pending）。见 chat.ts:chat:resolve-proposal。
   */
  proposals?: Record<string, 'accepted' | 'rejected'>
  /**
   * 回合终态提示（错误红框 / 截断 / 空回合）的持久化边车。
   * 这些是**纯展示产物**：请求失败、被截断、通篇无回复等，本身不属于模型上下文，故**绝不**写进
   * messages（不发给模型，保持上下文纯净）；但它们此前只作为易逝的流事件画在渲染层，重开对话就消失，
   * 用户只看得到自己发的消息。此边车让它们随对话落盘、重开时按位置还原。
   * `after` = 该提示产生时其前方的消息条数（= 插入位置）；压缩重排 messages 时随之调整/丢弃。
   * 见 chat.ts:toDisplayMessages / recordTurnNotice、compaction.ts 的锚点调整。
   */
  notices?: StoredNotice[]
  /**
   * ask_user 询问的答复边车，按 toolUseId 记录用户逐题答案（answers[i] 对应该次询问第 i 题）。
   * 问题本体可从 tool_use 入参重解析（parseAskQuestions），但用户答案只活在易逝的 tool_result 文本里，
   * 无法结构化还原——此边车让重开对话把问答卡忠实重建为「已答态·逐题回述」，而非退化成一张空工具卡。
   * `answers=null` = 用户取消/中止了该次询问。按 toolUseId 记录，故压缩重排 messages 时无需调整（同 proposals）。
   * 见 chat.ts:toDisplayMessages / runTurn 的 onAskAnswered。
   */
  asks?: Record<string, { answers: string[] | null }>
  /**
   * 工具调用结论摘要边车，按 toolUseId 记录 tool_result 的一句话 summary（如「已读取 20 行」）。
   * summary 是纯展示产物、不属于模型上下文（上下文里存的是完整 tool_result content），故绝不写进 messages；
   * 此前只作易逝流事件画在渲染层，重开即丢、工具卡只剩状态徽标。此边车让重开时补回结论摘要。
   * 按 toolUseId 记录，压缩重排 messages 时无需调整（同 proposals/asks）。见 chat.ts:runTurn 的 onToolSummary。
   */
  summaries?: Record<string, string>
  /**
   * 交付文件（present_files）边车，按 toolUseId 记录这次交付的文件：已解析为绝对路径（相对路径以调用时的
   * 工作区为基准）并去重。交付卡与「打开 / 在文件夹中显示」据此取路径；messages 里保留模型原样发出的参数——
   * 改写它会让模型看到的调用与它发出的不符，误以为自己没照做而反复重试。按轮删除时随 tool_use 修剪。
   */
  delivered?: Record<string, string[]>
  /**
   * 后台子智能体（run_in_background）的状态边车，按开出它的 run_subagent / send_to_subagent 调用 id 记录。
   * 历史里那条调用的 tool_result 只是「已在后台启动」，真正的结局在回合之外才揭晓，故 Task 卡的终态记在这里：
   * running=派出时写入（进程退出后仍是 running 即视为被中断），ok / error=结束时改写。按轮删除时随 tool_use 修剪。
   */
  background?: Record<string, 'running' | 'ok' | 'error'>
  /**
   * 回合耗时边车（毫秒），按该轮第一个 tool_use 的 id 记录：工作过程折叠条显示「已处理 X」。
   * 扣除了等用户作答 / 批准计划 / 挂载工作区的时间，只算 Deva 自己在干活的时长。没有工具调用的轮不记——
   * 重开后它没有可折叠的过程（思考块不重建）。按轮删除时随 tool_use 修剪。
   */
  durations?: Record<string, number>
  /**
   * @deprecated 已废弃的「项目分桶键」（旧 IDE 式外壳遗留）。对话优先外壳无项目概念、`listSessions` 列全部，
   * 故此字段不再读写；仅为兼容历史 JSON 保留可选声明（读时忽略、新存不产生）。见文件头注释。
   */
  bucket?: string
  /**
   * 计划模式（plan mode）exit_plan 的决定态边车，按 toolUseId 记录用户对该计划的决定。
   * 计划正文可从 tool_use 入参（input.plan）重解析还原，故此边车**只需记决定态**（同 proposals）：
   * 'approve'=已批准（该回合已退出计划模式转执行）/'keep'=用户选择继续完善/'ignore'=用户忽略该计划/
   * null=中止未决。feedback = 继续完善时用户在卡上写的回复（未写则缺省）。
   * 缺省即未决（pending）。按 toolUseId 记录，压缩重排 messages 时无需调整。
   * 见 chat.ts:toDisplayMessages / runTurn 的 onPlanDecided。
   */
  plans?: Record<string, { decision: 'approve' | 'keep' | 'ignore' | null; feedback?: string }>
  /**
   * 定时任务确认名片（create_task 提议）的终态边车，按 toolUseId 记录用户对该名片的决定。
   * 名片本体随 Message[] 天然存活（tool_use 入参含 title/kind/prompt/schedule），但其「已创建 / 已忽略」
   * 终态无处落——此边车确保重开不退回 pending、不重复建任务。`taskId` 记已创建任务的 id（供名片显示
   * 「打开该任务会话」跳转）。pending 不入表（缺省即 pending）。按 toolUseId 记录，压缩重排 messages
   * 时无需调整（同 proposals）。见 chat.ts:chat:resolve-autotask。
   */
  autotasks?: Record<string, { status: 'created' | 'dismissed'; taskId?: string }>
  /**
   * 待办清单（todo_write）的写入日志：每次调用记一条完整快照（按 toolUseId），清单现状由日志折叠得出。
   * 纯展示产物、不进模型上下文。按 toolUseId 记录，故压缩重排 messages 时无需调整；按轮删除 / 回滚时
   * 删掉被删轮里的那几条快照（**不按存活 tool_use 修剪**：被压缩掉的写入仍是清单的现状）。见 services/todos.ts。
   */
  todos?: TodoEntry[]
  /**
   * 已取消的清单 id（不再进行：模型 todo_write 传 cancel，或用户在面板里手动取消）：胶囊不再显示它，
   * 直到模型再次写入该清单（视为恢复）。见 services/todos.ts 文件头「取消」。
   */
  todoCancelled?: string[]
  /** 用户手动取消清单后待告知模型的说明：下一次 chat:send 作为独立 text 块注入，注入即清空（同 restoreNote）。 */
  todoCancelNote?: string
  /**
   * 文件检查点记录（供回滚），按 toolUseId 记录该次工具调用的写入 / 命令（子智能体的写入归到父级
   * run_subagent 的 id）。**不存轮下标**：回滚时由 tool_use 所在的轮反查，故压缩 / 删轮后不会错位。
   * 按轮删除 / 压缩时随 tool_use 一并清理（同 proposals）。见 services/checkpoints.ts。
   */
  checkpoints?: Record<string, CheckpointRec[]>
  /** 路径键 → Deva 最近一次写入或回滚后该文件内容的 hash（null = 不存在）。回滚时据此检测外部改动。 */
  lastKnown?: Record<string, string | null>
  /** 路径键 → 本会话第一次动这个文件前的内容 hash（给日后的完整 diff 功能留底）。 */
  baselines?: Record<string, string | null>
  /**
   * 「仅恢复代码」后待告知模型的说明：下一次 chat:send 作为该条用户消息的**首个**独立 text 块注入，
   * 注入即清空（展示层取最后一个 text 块，故不出现在气泡里）。
   */
  restoreNote?: string
}

/** 回合终态提示（持久化边车项）。见 StoredSession.notices。 */
export interface StoredNotice {
  /** 插入位置：该提示产生时其前方的消息条数（messages.length）。 */
  after: number
  /** error=请求失败红框（原样展示 message）；notice=弱化提示（按 code 在渲染层翻译）。 */
  kind: 'error' | 'notice'
  /** kind='error' 时的错误文案。 */
  message?: string
  /** kind='notice' 时的提示码（aborted=用户中止了本轮，其前内容为中止前已产出的部分）。 */
  code?: 'truncated' | 'empty' | 'refused' | 'restored' | 'aborted' | 'step_limit' | 'repeated'
}

/** 会话元信息（左侧列表用，不含正文）。 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  personaId?: string
  focusRoot?: string | null
  /** 本对话的模型引用 `"providerId:modelId"`；空串/缺省 = 跟随全局默认。见 StoredSession.model。 */
  model?: string
  /** 本对话的思考等级。见 StoredSession.effort。 */
  effort?: EffortLevel
  /** 已归档。见 StoredSession.archived。 */
  archived?: boolean
}

/**
 * 工作区绝对路径 → 稳定的文件名安全键。**不再用于对话分桶**（对话已无项目概念）；
 * 现仅供权限系统按目录区分权限模式（permissions.ts）、以及 runTurn 的权限作用域键（modeKey）。
 * null（未挂载目录）统一映射到固定键，代表「全机通用助手」这一权限作用域。
 */
export function projectKey(workspaceRoot: string | null): string {
  if (!workspaceRoot) return 'no-project'
  const norm = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

function chatsDir(): string {
  const dir = join(getDevaHome(), 'data', 'chats')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* 创建失败：读写各自兜底 */
  }
  return dir
}

/** 索引文件名（下划线前缀，与对话文件区分；扫描重建时据此排除自身）。 */
const INDEX_FILE = '_index.json'

/** 会话 id → 文件名安全化：id 来自渲染层，只保留白名单字符，杜绝路径穿越（../、盘符、分隔符）。 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

function fileForId(id: string): string {
  return join(chatsDir(), `${safeId(id)}.json`)
}

function indexPath(): string {
  return join(chatsDir(), INDEX_FILE)
}

// id -> 该对话全量（内存缓存，惰性载入；messages 数组引用被 Agent 循环原地改写）。
const sessionCache = new Map<string, StoredSession>()
// id -> 元信息（左侧列表的真源，内存态）。ensureSession 即时写入、save 落盘；null = 尚未载入。
let indexCache: Map<string, ChatSessionMeta> | null = null

function metaOf(s: StoredSession): ChatSessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    personaId: s.personaId,
    focusRoot: s.focusRoot ?? null,
    model: s.model,
    effort: s.effort,
    archived: s.archived
  }
}

/** 惰性载入索引；文件缺失/损坏则扫描目录里的对话文件重建（自愈），并回写一份。 */
function ensureIndex(): Map<string, ChatSessionMeta> {
  if (indexCache) return indexCache
  const map = new Map<string, ChatSessionMeta>()
  try {
    const raw = readFileSync(indexPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const m of parsed as ChatSessionMeta[]) if (m && typeof m.id === 'string') map.set(m.id, m)
      indexCache = map
      return map
    }
  } catch {
    /* 无索引 / 解析失败 → 落到扫描重建 */
  }
  // 扫描重建：读每个对话文件的头部信息，重建索引（首启无索引 / 索引损坏时的兜底）。
  try {
    for (const name of readdirSync(chatsDir())) {
      if (name === INDEX_FILE || !name.endsWith('.json')) continue
      try {
        const s = JSON.parse(readFileSync(join(chatsDir(), name), 'utf8')) as StoredSession
        if (s && typeof s.id === 'string') map.set(s.id, metaOf(s))
      } catch {
        /* 跳过坏文件 */
      }
    }
  } catch {
    /* 目录不可读 → 空索引 */
  }
  indexCache = map
  persistIndex()
  return map
}

/**
 * 原子写：先写同目录 `<file>.tmp` 再 rename 覆盖。进程在写到一半时被杀（强退 / 断电 / 崩溃）
 * 最多丢掉这一次的新内容，**绝不会把旧文件截成半截 JSON**——否则 loadSessionFile 解析失败即
 * 当作「对话不存在」，整条对话凭空消失。
 * 仅当 rename 失败（Windows 上目标文件被杀毒 / 索引服务短暂占用时可能 EPERM）才回退为直接覆盖写
 * （与旧行为一致）并清掉残留 tmp；tmp 本身写不进（磁盘满等）则原样抛出——此时再去直写只会把
 * 旧文件也截断。`.json.tmp` 不以 `.json` 结尾，扫描重建索引时天然被排除。
 */
export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, data, 'utf8')
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败无害：下次写入会覆盖 */
    }
  }
}

function persistIndex(): void {
  if (!indexCache) return
  try {
    writeFileAtomic(indexPath(), JSON.stringify([...indexCache.values()], null, 2))
  } catch {
    /* 索引落盘失败静默：单条对话文件已是真源，下次成功保存即自愈 */
  }
}

/** 载入单条对话（缓存优先；不存在 / 解析失败 → undefined）。 */
function loadSessionFile(id: string): StoredSession | undefined {
  const cached = sessionCache.get(id)
  if (cached) return cached
  try {
    const s = JSON.parse(readFileSync(fileForId(id), 'utf8')) as StoredSession
    if (s && typeof s.id === 'string') {
      if (Array.isArray(s.messages)) hydrateMessages(s.messages)
      sessionCache.set(id, s)
      return s
    }
  } catch {
    /* 首次运行 / 文件不存在 / 解析失败 → undefined */
  }
  return undefined
}

/**
 * 保存单条对话：写该对话文件 + 刷新其索引条目并落盘。
 * 只重写这一条 + 轻量索引，与其它对话无关（这是一对话一文件的核心收益）。
 */
export function save(id: string): void {
  const s = sessionCache.get(id)
  if (!s) return
  try {
    // 图片 / PDF 的 base64 外置为 blob 引用（见 media-store.ts），对话文件只留哈希。
    writeFileAtomic(fileForId(id), JSON.stringify(s, mediaReplacer, 2))
  } catch {
    /* 单条对话落盘失败静默，不影响内存态 */
    return
  }
  ensureIndex().set(id, metaOf(s))
  persistIndex()
}

/** 全部会话清单（无分桶——对话优先外壳一次列全部，按 updatedAt 倒序）。 */
export function listSessions(): ChatSessionMeta[] {
  return [...ensureIndex().values()]
    .map((m) => ({ ...m, focusRoot: m.focusRoot ?? null }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 取某对话全量（id 全局唯一）。 */
export function getSession(id: string): StoredSession | undefined {
  return loadSessionFile(id)
}

/**
 * 取会话；不存在则新建（仅入内存缓存 + 索引，尚未落盘，待 save）。对话无分桶概念，故无归属参数。
 * `opts.personaId`/`opts.focusRoot`：首发绑定——新建时写入；已存在会话仅当当前为 undefined 才补 persona
 * （**绝不覆盖**已绑定值），focusRoot 可由 mountFocus 后续更新（显式提供即应用，含 null 卸载）。
 * `opts.model`：本对话模型引用（快照固定）——新建时写入角色偏好快照；已存在会话显式提供即应用（聊天中
 * 切换模型，与 focusRoot 同为「可变·显式即覆盖」；空串=显式回落全局默认）。见 StoredSession.model。
 * `opts.effort`：本对话思考等级，同 model「可变·显式即覆盖」。见 StoredSession.effort。
 */
export function ensureSession(
  id: string,
  opts?: { personaId?: string; focusRoot?: string | null; model?: string; effort?: EffortLevel }
): StoredSession {
  let s = loadSessionFile(id)
  if (!s) {
    const now = Date.now()
    s = {
      id,
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      personaId: opts?.personaId,
      focusRoot: opts?.focusRoot ?? null,
      model: opts?.model,
      effort: opts?.effort
    }
    sessionCache.set(id, s)
    ensureIndex().set(id, metaOf(s))
  } else {
    // personaId：一次性绑定，绝不覆盖已绑定值。
    if (s.personaId === undefined && opts?.personaId !== undefined) s.personaId = opts.personaId
    // focusRoot：可变（挂/卸），显式提供（含 null 卸载）即应用；未提供（undefined）则不动。
    if (opts && opts.focusRoot !== undefined) s.focusRoot = opts.focusRoot
    // model：可变（聊天中切换），显式提供即应用（空串=回落默认）；未提供（undefined）则不动。
    if (opts && opts.model !== undefined) s.model = opts.model
    if (opts && opts.effort !== undefined) s.effort = opts.effort
  }
  return s
}

/**
 * 改绑对话角色：仅当当前绑定的是 `from` 时改为 `to`，返回是否改动。常规对话的角色一次性绑定
 * （见 ensureSession）；这里只供「绑定的角色被删、由别的角色接管」时用。不动 updatedAt，列表顺序不变。
 */
export function rebindSessionPersona(id: string, from: string, to: string): boolean {
  // 先查索引：不相干的对话不必读整份历史。
  if (ensureIndex().get(id)?.personaId !== from) return false
  const s = loadSessionFile(id)
  if (!s || s.personaId !== from) return false
  s.personaId = to
  save(id)
  return true
}

/**
 * 定时任务改了角色 / 模型：同步到它的独占对话（两边以同一个为准，见 tasks.ts updateTask）。对话不存在
 * （任务从没运行过）则什么都不做。personaId 缺省 = 不动；model 空串 = 跟随全局默认。
 * 返回是否改动。不动 updatedAt，列表顺序不变。
 */
export function syncSessionBinding(id: string, b: { personaId?: string; model: string }): boolean {
  if (!ensureIndex().has(id)) return false
  const s = loadSessionFile(id)
  if (!s) return false
  let changed = false
  if (b.personaId && s.personaId !== b.personaId) {
    s.personaId = b.personaId
    changed = true
  }
  if ((s.model ?? '') !== b.model) {
    s.model = b.model
    changed = true
  }
  if (changed) save(id)
  return changed
}

/** 归档 / 取消归档并落盘，返回是否找到该对话。不动 updatedAt（列表顺序不变）。 */
export function setSessionArchived(id: string, archived: boolean): boolean {
  const s = loadSessionFile(id)
  if (!s) return false
  if (!!s.archived === archived) return true
  if (archived) s.archived = true
  else delete s.archived
  save(id)
  return true
}

/** 删除某对话：清缓存 + 索引 + 磁盘文件。 */
export function deleteSession(id: string): void {
  sessionCache.delete(id)
  if (ensureIndex().delete(id)) persistIndex()
  try {
    rmSync(fileForId(id), { force: true })
  } catch {
    /* 删除失败静默 */
  }
}

/** 从首条用户文本派生标题（单行、截断）。 */
export function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine
}
