import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import type { Message } from '../providers/types'

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
 * `bucket`（= 旧「项目键」projectKey）作为元信息随对话存留：新壳恒 `no-project`（聚焦目录由 focusRoot
 * 单独承载），旧 AppShell 仍按项目分桶 —— listSessions 据此过滤，两种外壳共用同一份存储，无需迁移。
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
   * 绑定的 persona id（对话优先外壳：一对话一身份，单选当值）。
   * 缺省 = 旧 AppShell 路径（叠加式 enabledPersonas，不做单身份注入）。首发落库后绑定不再改。
   */
  personaId?: string
  /**
   * 该对话的聚焦工作区绝对路径；null/缺省 = 全机通用助手（无聚焦）。
   * 与分桶（bucket）解耦：新壳对话统一落 no-project 桶，聚焦范围由此字段单独承载。
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
   * 归属桶（= projectKey）：左侧列表过滤用。新壳恒 'no-project'；旧壳为项目路径的稳定键。
   * 落库后不再变（对话归属固定）。
   */
  bucket?: string
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
}

/** 回合终态提示（持久化边车项）。见 StoredSession.notices。 */
export interface StoredNotice {
  /** 插入位置：该提示产生时其前方的消息条数（messages.length）。 */
  after: number
  /** error=请求失败红框（原样展示 message）；notice=弱化提示（按 code 在渲染层翻译）。 */
  kind: 'error' | 'notice'
  /** kind='error' 时的错误文案。 */
  message?: string
  /** kind='notice' 时的提示码。 */
  code?: 'truncated' | 'empty'
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
  bucket?: string
}

/** 工作区绝对路径 → 稳定的文件名安全键；未打开项目归入 no-project 桶。 */
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
    bucket: s.bucket
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

function persistIndex(): void {
  if (!indexCache) return
  try {
    writeFileSync(indexPath(), JSON.stringify([...indexCache.values()], null, 2), 'utf8')
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
    writeFileSync(fileForId(id), JSON.stringify(s, null, 2), 'utf8')
  } catch {
    /* 单条对话落盘失败静默，不影响内存态 */
    return
  }
  ensureIndex().set(id, metaOf(s))
  persistIndex()
}

/** 会话清单（按 bucket 过滤：新壳 'no-project'、旧壳项目键）；null/undefined = 全部。 */
export function listSessions(bucket?: string | null): ChatSessionMeta[] {
  const all = [...ensureIndex().values()]
  const filtered = bucket == null ? all : all.filter((m) => (m.bucket ?? 'no-project') === bucket)
  return filtered
    .map((m) => ({ ...m, focusRoot: m.focusRoot ?? null }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 取某对话全量（id 全局唯一，无需 bucket）。 */
export function getSession(id: string): StoredSession | undefined {
  return loadSessionFile(id)
}

/**
 * 取会话；不存在则新建（仅入内存缓存 + 索引，尚未落盘，待 save）。
 * `bucket`：新建时归属桶（listSessions 过滤用）；已存在会话仅当当前为空才补，不改归属。
 * `opts.personaId`/`opts.focusRoot`：首发绑定——新建时写入；已存在会话仅当当前为 undefined 才补 persona
 * （**绝不覆盖**已绑定值），focusRoot 可由 mountFocus 后续更新（显式提供即应用，含 null 卸载）。
 * `opts.model`：本对话模型引用（快照固定）——新建时写入角色偏好快照；已存在会话显式提供即应用（聊天中
 * 切换模型，与 focusRoot 同为「可变·显式即覆盖」；空串=显式回落全局默认）。见 StoredSession.model。
 */
export function ensureSession(
  bucket: string,
  id: string,
  opts?: { personaId?: string; focusRoot?: string | null; model?: string }
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
      bucket
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
    // bucket：归属固定，仅当历史遗留为空时补齐。
    if (!s.bucket) s.bucket = bucket
  }
  return s
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
