import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../atomic-write'
import type { WebItem } from '../../../../shared/remote-web'

/**
 * 手机网页端的聊天记录（按配对用户分开保存）。IM 平台自己存聊天记录，网页端没有这个条件：
 * 桌面端替它保存最近的一段，手机每次连上整段同步，刷新、换设备、Deva 重启后记录都还在。
 *
 * 落盘 ~/.deva/remote/web-<botId>.json，写入合并去抖；超过上限的旧记录丢弃。
 */

const MAX_ITEMS = 300
const SAVE_DELAY_MS = 500

interface UserLog {
  seq: number
  items: WebItem[]
}

interface FileShape {
  v: 1
  users: Record<string, UserLog>
}

export class ItemLog {
  private users = new Map<string, UserLog>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(private file: string) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>
      if (!parsed || parsed.v !== 1 || !parsed.users || typeof parsed.users !== 'object') return
      for (const [uid, u] of Object.entries(parsed.users)) {
        if (!u || typeof u.seq !== 'number' || !Array.isArray(u.items)) continue
        this.users.set(uid, { seq: u.seq, items: u.items.filter((x) => x && typeof x.id === 'string') })
      }
    } catch {
      /* 损坏的记录文件：当作空，下次写入覆盖 */
    }
  }

  private user(uid: string): UserLog {
    let u = this.users.get(uid)
    if (!u) {
      u = { seq: 0, items: [] }
      this.users.set(uid, u)
    }
    return u
  }

  /** 分配下一个记录 id（同一用户内单调递增，字符串形式便于直接当消息句柄）。 */
  next(uid: string): string {
    const u = this.user(uid)
    u.seq++
    return String(u.seq)
  }

  items(uid: string, limit = 100): WebItem[] {
    const items = this.users.get(uid)?.items ?? []
    return items.length > limit ? items.slice(items.length - limit) : items.slice()
  }

  get(uid: string, id: string): WebItem | undefined {
    return this.users.get(uid)?.items.find((x) => x.id === id)
  }

  /** 新增或按 id 原地覆盖。 */
  put(uid: string, item: WebItem): void {
    const u = this.user(uid)
    const i = u.items.findIndex((x) => x.id === item.id)
    if (i >= 0) u.items[i] = item
    else {
      u.items.push(item)
      if (u.items.length > MAX_ITEMS) u.items.splice(0, u.items.length - MAX_ITEMS)
    }
    this.schedule()
  }

  remove(uid: string, id: string): boolean {
    const u = this.users.get(uid)
    if (!u) return false
    const i = u.items.findIndex((x) => x.id === id)
    if (i < 0) return false
    u.items.splice(i, 1)
    this.schedule()
    return true
  }

  /** 用户被移除：连记录一起删。 */
  drop(uid: string): void {
    if (this.users.delete(uid)) this.schedule()
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, SAVE_DELAY_MS)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data: FileShape = { v: 1, users: Object.fromEntries(this.users) }
    try {
      const dir = dirname(this.file)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileAtomic(this.file, JSON.stringify(data))
    } catch (e) {
      console.warn('[remote/web] 保存聊天记录失败：', (e as Error)?.message ?? e)
    }
  }
}
