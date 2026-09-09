import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import type { Message } from '../providers/types'

/**
 * 对话持久化（主进程）。
 * 对话历史「按项目绑定」：各项目各自一份 `~/.deva/chats/<projectKey>.json`。
 * 主进程持有的 provider `Message[]` 是模型上下文的**唯一真源**（续聊时回灌给模型），
 * 因此持久化落在主进程；渲染层仅按需拉取会话清单 / 重建展示。
 * 明文 JSON，可手改 / 备份（对标 config.json）；根目录可用 DEVA_HOME 覆盖。
 */

export interface StoredSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

/** 会话元信息（左侧列表用，不含正文）。 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

interface ProjectChats {
  sessions: StoredSession[]
}

/** 工作区绝对路径 → 稳定的文件名安全键；未打开项目归入 no-project 桶。 */
export function projectKey(workspaceRoot: string | null): string {
  if (!workspaceRoot) return 'no-project'
  const norm = workspaceRoot.replace(/[\\/]+$/, '').toLowerCase()
  return createHash('sha1').update(norm).digest('hex').slice(0, 24)
}

function chatsDir(): string {
  const dir = join(getDevaHome(), 'chats')
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* 创建失败：读写各自兜底 */
  }
  return dir
}

function fileFor(key: string): string {
  return join(chatsDir(), `${key}.json`)
}

// key -> 该项目的对话（内存缓存，惰性载入；messages 数组引用被 Agent 循环原地改写）
const cache = new Map<string, ProjectChats>()

function load(key: string): ProjectChats {
  const cached = cache.get(key)
  if (cached) return cached
  let data: ProjectChats = { sessions: [] }
  try {
    const raw = readFileSync(fileFor(key), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.sessions)) data = parsed as ProjectChats
  } catch {
    /* 首次运行 / 文件不存在 / 解析失败 → 空 */
  }
  cache.set(key, data)
  return data
}

export function save(key: string): void {
  const data = cache.get(key)
  if (!data) return
  try {
    writeFileSync(fileFor(key), JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* 持久化失败静默，不影响内存态 */
  }
}

export function listSessions(key: string): ChatSessionMeta[] {
  return load(key)
    .sessions.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(key: string, id: string): StoredSession | undefined {
  return load(key).sessions.find((s) => s.id === id)
}

/** 取会话；不存在则新建并入库（尚未落盘，待 save）。 */
export function ensureSession(key: string, id: string): StoredSession {
  const data = load(key)
  let s = data.sessions.find((x) => x.id === id)
  if (!s) {
    const now = Date.now()
    s = { id, title: '', createdAt: now, updatedAt: now, messages: [] }
    data.sessions.push(s)
  }
  return s
}

export function deleteSession(key: string, id: string): void {
  const data = load(key)
  data.sessions = data.sessions.filter((s) => s.id !== id)
  save(key)
}

/** 从首条用户文本派生标题（单行、截断）。 */
export function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine
}
