import type { WebDelivered, WebMessage, WebPart, WebPersona, WebSession, WebTask } from '../shared/remote-web'

/**
 * 本机缓存（IndexedDB）：对话列表、角色、最近打开过的对话的最新一页。打开时先显示缓存，
 * 连上后再同步——电脑不在线时也有内容可看。缓存只是副本，丢了不影响使用（IndexedDB 不可用时全部静默跳过）。
 */

/** 某对话已拉到的一段：展示投影里 [start, total) 归约出的消息（total = 拉取时投影的总条数，也就是这一段的末尾）。 */
export interface CachedHistory {
  messages: WebMessage[]
  start: number
  total: number
}

export interface DeskSnapshot {
  sessions: WebSession[]
  personas: WebPersona[]
  /** 旧缓存里没有。 */
  tasks?: WebTask[]
  syncedAt: number
}

const DB_NAME = 'deva-mobile'
const STORE = 'kv'
/** 最多缓存这么多个对话的历史（按最近打开）。 */
const MAX_HISTORIES = 30

let dbp: Promise<IDBDatabase | null> | null = null

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

async function get<T>(key: string): Promise<T | undefined> {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

async function set(key: string, value: unknown): Promise<void> {
  const d = await db()
  if (!d) return
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
  } catch {
    /* 空间不足等：放弃这次缓存 */
  }
}

async function del(key: string): Promise<void> {
  const d = await db()
  if (!d) return
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)
  } catch {
    /* ignore */
  }
}

export function loadSnapshot(deskId: string): Promise<DeskSnapshot | undefined> {
  return get<DeskSnapshot>(`${deskId}:snap`)
}

export function saveSnapshot(deskId: string, snap: DeskSnapshot): void {
  void set(`${deskId}:snap`, snap)
}

/** 发布前开发版的缓存里助手消息是整轮一段正文：转成 parts，免得升级后打开缓存的对话出错。 */
type LegacyReply = { id: string; role: 'assistant'; text?: string; notes?: string[]; files?: WebDelivered[]; durationMs?: number }

function upgrade(m: WebMessage): WebMessage {
  if (m.role !== 'assistant' || Array.isArray(m.parts)) return m
  const old = m as unknown as LegacyReply
  const parts: WebPart[] = [
    ...(old.text ? [{ k: 'text' as const, text: old.text }] : []),
    ...(old.files ?? []).map((file) => ({ k: 'file' as const, file })),
    ...(old.notes ?? []).map((text) => ({ k: 'note' as const, text }))
  ]
  return { id: old.id, role: 'assistant', parts, durationMs: old.durationMs }
}

export async function loadHistory(deskId: string, sid: string): Promise<CachedHistory | undefined> {
  const h = await get<CachedHistory>(`${deskId}:h:${sid}`)
  return h && Array.isArray(h.messages) ? { ...h, messages: h.messages.map(upgrade) } : undefined
}

/** 只存最新的一页（往前翻出来的更早部分不存，下次打开再按需拉）。 */
export async function saveHistory(deskId: string, sid: string, h: CachedHistory): Promise<void> {
  // 从一条完整消息的开头切（「12.1」这类是第 12 条拆出来的后半部分，前半部分没切进来就一起丢掉）。
  let tail = h.messages.slice(-60)
  while (tail.length && !Number.isInteger(Number(tail[0].id))) tail = tail.slice(1)
  const start = tail.length ? Number(tail[0].id) : h.total
  await set(`${deskId}:h:${sid}`, { messages: tail, start, total: h.total })
  const idxKey = `${deskId}:hidx`
  const idx = ((await get<string[]>(idxKey)) ?? []).filter((x) => x !== sid)
  idx.unshift(sid)
  for (const old of idx.splice(MAX_HISTORIES)) void del(`${deskId}:h:${old}`)
  await set(idxKey, idx)
}

/** 断开某台电脑：清掉它的全部缓存。 */
export async function dropDesk(deskId: string): Promise<void> {
  const idx = (await get<string[]>(`${deskId}:hidx`)) ?? []
  for (const sid of idx) await del(`${deskId}:h:${sid}`)
  await del(`${deskId}:hidx`)
  await del(`${deskId}:snap`)
}
