import { createHash } from 'crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import type { ContentPart, Message } from '../providers/types'

/**
 * 消息里二进制附件（图片 / PDF 的 base64）的外置存储。
 *
 * 对话与子智能体记录落盘时，把 image / document 块的 base64 换成内容哈希引用 `{ blob }`，字节按哈希
 * 存为 `<DEVA_HOME>/data/media/<sha256>`（原始字节，免 base64 膨胀）；载入时按哈希读回。**内存里的
 * 消息结构不变**（data 仍是 base64），适配器、渲染层、压缩都无感。
 * 收益：对话 JSON 从「每张图一两 MB」降到几百字节一张，每次保存不再整段重写图片；同一张图在主对话、
 * fork、子智能体记录里只存一份。旧文件里内联的 base64 照常读取，下次保存即转成引用。
 *
 * 生命周期：内容寻址、只增不改；孤立文件（会话 / 记录删掉后）由启动清扫按引用回收。
 */

/** 落盘时用来替换 base64 的引用字段。 */
interface BlobRef {
  type: 'image' | 'document'
  mediaType: string
  name?: string
  blob: string
}

const HASH_RE = /^[0-9a-f]{64}$/
/** 启动清扫：刚写入、可能还没被对话文件引用上的 blob 留一小时宽限。 */
const SWEEP_GRACE_MS = 3600 * 1000

function mediaDir(): string {
  return join(getDevaHome(), 'data', 'media')
}

function blobFile(hash: string): string {
  return join(mediaDir(), hash)
}

/** 块对象 → 其 base64 的哈希（块按不可变对待，算一次即缓存；载入时读回的块也直接登记）。 */
const hashOf = new WeakMap<object, string>()
/** 本进程已确认落盘的 blob，免每次保存都 existsSync。 */
const stored = new Set<string>()

function isBinaryPart(v: unknown): v is { type: 'image' | 'document'; mediaType: string; data: string; name?: string } {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  return (p.type === 'image' || p.type === 'document') && typeof p.data === 'string' && typeof p.mediaType === 'string'
}

/** 确保 blob 已落盘；写不进返回 false（调用方保留内联 base64，不丢数据）。 */
function ensureBlob(hash: string, base64: string): boolean {
  if (stored.has(hash)) return true
  const file = blobFile(hash)
  try {
    if (!existsSync(file)) {
      const dir = mediaDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // 先写临时文件再 rename：进程中途被杀也不会留下半截 blob 被当成完整内容读回。
      const tmp = `${file}.tmp`
      writeFileSync(tmp, Buffer.from(base64, 'base64'))
      renameSync(tmp, file)
    }
    stored.add(hash)
    return true
  } catch (e) {
    console.warn('[media] blob 写入失败，本次保留内联数据：', (e as Error)?.message ?? e)
    return false
  }
}

/**
 * JSON.stringify 的 replacer：image / document 块的 base64 换成 blob 引用。
 * 用法：`JSON.stringify(obj, mediaReplacer, 2)`。
 */
export function mediaReplacer(_key: string, value: unknown): unknown {
  if (!isBinaryPart(value) || !value.data) return value
  let hash = hashOf.get(value)
  if (!hash) {
    hash = createHash('sha256').update(value.data).digest('hex')
    hashOf.set(value, hash)
  }
  if (!ensureBlob(hash, value.data)) return value
  const ref: BlobRef = { type: value.type, mediaType: value.mediaType, blob: hash }
  if (value.name) ref.name = value.name
  return ref
}

/** 按引用读回 base64；文件缺失 / 损坏返回 null。 */
function readBlob(hash: string): string | null {
  if (!HASH_RE.test(hash)) return null
  try {
    const data = readFileSync(blobFile(hash)).toString('base64')
    stored.add(hash)
    return data
  } catch {
    return null
  }
}

function isRef(v: unknown): v is BlobRef {
  return !!v && typeof v === 'object' && typeof (v as BlobRef).blob === 'string'
}

/** 把一个引用块原地还原成带 base64 的块；读不回返回 false。 */
function hydratePart(p: Record<string, unknown>): boolean {
  const hash = p.blob as string
  const data = readBlob(hash)
  if (data === null) return false
  delete p.blob
  p.data = data
  hashOf.set(p, hash)
  return true
}

/**
 * 载入后原地还原消息里的 blob 引用。读不回的（media 目录被手动清理等）不能留成空块发给模型——
 * 服务商会直接 400：消息里的独立块换成一行文字说明，工具结果里的图片去掉并在正文里注明。
 */
export function hydrateMessages(messages: Message[]): void {
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    m.content = m.content.map((part): ContentPart => {
      if (isRef(part)) {
        if (hydratePart(part as unknown as Record<string, unknown>)) return part
        const what = (part as unknown as BlobRef).type === 'document' ? '文档' : '图片'
        const name = (part as unknown as BlobRef).name
        return { type: 'text', text: `[${what}${name ? `「${name}」` : ''}的数据已丢失]` }
      }
      if (part.type === 'tool_result' && part.images?.length) {
        const kept = part.images.filter((img) => !isRef(img) || hydratePart(img as unknown as Record<string, unknown>))
        if (kept.length !== part.images.length) {
          const lost = part.images.length - kept.length
          return {
            ...part,
            content: `${part.content}\n（其中 ${lost} 张图片的数据已丢失。）`,
            images: kept.length ? kept : undefined
          }
        }
      }
      return part
    })
  }
}

/**
 * 启动清扫（异步，不阻塞启动）：删掉没有任何对话 / 子智能体记录引用的 blob。
 * 引用只存在于 data/chats 与 data/subagents 下的 JSON 里（只有它们经 mediaReplacer 落盘）。
 */
export async function sweepMedia(): Promise<void> {
  const root = join(getDevaHome(), 'data')
  let names: string[]
  try {
    names = await fsp.readdir(mediaDir())
  } catch {
    return
  }
  if (names.length === 0) return

  const referenced = new Set<string>()
  const refRe = /"blob":\s*"([0-9a-f]{64})"/g
  const scan = async (dir: string): Promise<boolean> => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e) {
      // 目录不存在 = 没有引用；读不了则放弃整次清扫，免得误删仍被引用的 blob。
      return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
    }
    for (const d of entries) {
      const p = join(dir, d.name)
      if (d.isDirectory()) {
        if (!(await scan(p))) return false
      } else if (d.name.endsWith('.json') || d.name.endsWith('.jsonl')) {
        // .jsonl = 对话拆分存盘的较早记录（见 chat-store.ts），里面同样引用 blob。
        try {
          const text = await fsp.readFile(p, 'utf8')
          for (const m of text.matchAll(refRe)) referenced.add(m[1])
        } catch {
          return false
        }
      }
    }
    return true
  }
  if (!(await scan(join(root, 'chats'))) || !(await scan(join(root, 'subagents')))) return

  const now = Date.now()
  for (const name of names) {
    const p = join(mediaDir(), name)
    // 残留的 .tmp 与未被引用的 blob 一并回收（都留宽限，避开正在写入的）。
    if (HASH_RE.test(name) && referenced.has(name)) continue
    try {
      if ((await fsp.stat(p)).mtimeMs < now - SWEEP_GRACE_MS) {
        rmSync(p, { force: true })
        stored.delete(name)
      }
    } catch {
      /* 单个文件失败不影响其余 */
    }
  }
}
