import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type KeyVerdict = 'ok' | 'forbidden' | 'error'

/**
 * 桌面密钥登记：桌面 id → 密钥的 SHA-256。某个 id 第一次连上来时登记，之后必须带同一把密钥，
 * 别的电脑拿不到密钥就冒充不了这个 id（与 apps/relay 相同）。
 *
 * 存在 <DATA_DIR>/desks.json，先写临时文件再改名，写到一半断电也不会损坏。
 * 文件损坏时拒绝启动：当作空表继续运行，等于把所有 id 让给先连上来的人重新登记。
 */
export class DeskKeys {
  private readonly file: string
  private readonly hashes = new Map<string, string>()

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'desks.json')
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${this.file} 不是有效的登记文件`)
    for (const [id, hash] of Object.entries(data)) if (typeof hash === 'string') this.hashes.set(id, hash)
  }

  get size(): number {
    return this.hashes.size
  }

  /** 校验桌面密钥；这个 id 还没登记过就登记下来。存盘失败时不登记，返回 error。 */
  verify(id: string, key: string): KeyVerdict {
    const hash = sha256(key)
    const stored = this.hashes.get(id)
    if (stored !== undefined) return sameHex(stored, hash) ? 'ok' : 'forbidden'
    this.hashes.set(id, hash)
    try {
      this.save()
    } catch (e) {
      this.hashes.delete(id)
      console.error(`[relay] 保存桌面登记失败：${(e as Error).message}`)
      return 'error'
    }
    console.log(`[relay] 登记了一台新电脑（共 ${this.hashes.size} 台）`)
    return 'ok'
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.hashes), null, 1) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** 两个十六进制哈希是否相同（定长比较；登记文件被手改坏时长度可能不同，直接算不同）。 */
function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}
