import { createHash, randomUUID } from 'crypto'
import { type Dirent, promises as fsp, realpathSync, rmSync } from 'fs'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'path'
import { getDevaHome } from './config'
import { isProtectedPath, isSensitivePath } from './fs-guard'
import { looksBinary, writeTargetPath } from './tools'
import { lineCount, lineStats } from './line-stats'
import type { StoredSession } from './chat-store'

/**
 * 文件检查点 + 回滚（对标 Claude Code 的 /rewind）。
 *
 * **记录层**：write_file / edit_file 执行前把原文件存成内容寻址的 blob（sha256），执行后只记新内容的 hash。
 * 记录按 **toolUseId** 归属（子智能体的写入归到父级 run_subagent 的 id），**不存轮下标**——回滚第 k 轮时由
 * chat.ts 取「第 k 轮起全部 tool_use id」来查记录，故压缩 / 按轮删除后轮下标变化也不会错位。
 *
 * **回滚目标** = 第 k 轮起每个文件「最早那条记录」的写入前内容；写入后的 hash（lastKnown）只用于冲突检测：
 * 磁盘现状 ≠ Deva 最后一次写入/恢复后的状态 → 外部改过，默认跳过、由用户勾选才覆盖。
 *
 * 刻意不用影子 git：纯 JS、零外部依赖（免装铁律），且只追踪 Deva 自己写过的文件。run_command 的文件影响
 * 不追踪（只记命令本身，供回滚面板提示「运行过 N 条命令，影响无法撤销」）。
 *
 * 存储：`<DEVA_HOME>/data/checkpoints/<会话 id>/<sha256>`。blob 目录在 ~/.deva 下（Tier-1），Agent 工具本就
 * 读写不到；删会话即整目录删除，GC 只在本会话目录内做。
 *
 * 安全：回滚由用户在主进程触发、**不经工具闸门**，故自守三条——①路径只来自记录，绝不接受渲染层传入的路径；
 * ②符号链接 / 硬链接 / 真实路径漂移一律跳过（防写穿到别处）；③敏感目录与 .git 防御性跳过。
 */

/** 一条检查点记录。file：一次写入；exec：一次通过闸门的 run_command（影响不可撤销，仅作提示）。 */
export type CheckpointRec =
  | {
      kind: 'file'
      /** 目标文件绝对路径（字面形式，与工具实际写入的落点一致）。 */
      path: string
      /** 写入时的真实路径（跟随链接）；回滚时若漂移（祖先目录被换成链接等）则跳过。 */
      real?: string
      /** 写入前内容的 hash；null = 原本不存在；缺省 = 未备份（过大，或超出保留上限已释放）。 */
      pre?: string | null
      /** 写入后内容的 hash；null = 写入后不存在。 */
      post: string | null
      /** 会话内递增序号：同一文件多条记录时据此取「最早」（并行子智能体下比数组顺序可靠）。 */
      seq: number
      /** 本次写入自身的加减行数（写入前 → 写入后）。 */
      added?: number
      removed?: number
      approx?: boolean
      binary?: boolean
      tooLarge?: boolean
      /** 超出保留上限、blob 已释放（pre 随之删除）。 */
      released?: boolean
    }
  | { kind: 'exec'; command: string; seq: number }

/** 单文件备份上限：超出只记元信息，不存 blob（回滚时显示「过大，已跳过」）。 */
const MAX_BLOB_BYTES = 5 * 1024 * 1024
/** 保留有备份的轮数上限：更早的轮释放 blob（元信息保留），回滚到那里时相应文件显示「备份缺失」。 */
const MAX_TURNS = 100
/** 启动清扫：mtime 超过此时长的 blob 删除。 */
const RETAIN_MS = 30 * 24 * 3600 * 1000
/** GC 宽限：近期写入/触碰的 blob 不删（可能属于进行中回合、记录尚未落入）。 */
const GC_GRACE_MS = 60 * 1000
/** 半截临时文件的清理宽限。 */
const TMP_GRACE_MS = 3600 * 1000
/** 命令文本记录上限（仅作提示，截断无妨）。 */
const EXEC_TEXT_MAX = 500

// ───────────────────────── 路径与 blob ─────────────────────────

/** 会话 id → 目录名（与 chat-store 的 safeId 同一白名单）：id 来自渲染层，杜绝路径穿越。 */
export function checkpointDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

function checkpointsRoot(): string {
  return join(getDevaHome(), 'data', 'checkpoints')
}

/** 会话的 blob 目录；id 安全化后为空 → null（绝不能退化成根目录本身，否则删会话 = 删全部）。 */
function sessionDir(id: string): string | null {
  const name = checkpointDirName(id)
  return name ? join(checkpointsRoot(), name) : null
}

/** 同一文件的归并键：绝对路径，win32 大小写不敏感。 */
function pathKey(p: string): string {
  const abs = resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 真实路径（跟随链接）；文件不存在则对父目录做 realpath 再接回文件名；都失败退回字面。 */
function realOf(abs: string): string {
  try {
    return realpathSync.native(abs)
  } catch {
    /* 文件不存在 → 试父目录 */
  }
  try {
    return join(realpathSync.native(dirname(abs)), basename(abs))
  } catch {
    return resolve(abs)
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 写 blob：先写临时文件再 rename（半截文件不会顶着正式名字）；已存在则刷新 mtime（防被 30 天清扫误删）。 */
async function writeBlob(dir: string, hash: string, buf: Buffer): Promise<void> {
  const file = join(dir, hash)
  const now = new Date()
  try {
    await fsp.utimes(file, now, now)
    return
  } catch {
    /* 不存在 → 写入 */
  }
  await fsp.mkdir(dir, { recursive: true })
  const tmp = join(dir, `${hash}.tmp-${randomUUID()}`)
  await fsp.writeFile(tmp, buf)
  try {
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    // 并发下对方已落同名 blob（内容相同）即算成功；否则如实抛出
    try {
      await fsp.access(file)
    } catch {
      throw e
    }
  }
}

/** 读 blob 并核对 hash：文件缺失 / 内容被篡改或损坏 → null（当作备份缺失）。 */
async function readBlob(sessionId: string, hash: string): Promise<Buffer | null> {
  const dir = sessionDir(sessionId)
  if (!dir) return null
  try {
    const buf = await fsp.readFile(join(dir, hash))
    return sha256(buf) === hash ? buf : null
  } catch {
    return null
  }
}

/** 磁盘现状：missing / 链接或特殊文件 / 过大 / 普通文件字节。 */
type DiskState =
  | { kind: 'missing' }
  | { kind: 'special' }
  | { kind: 'tooLarge' }
  | { kind: 'file'; buf: Buffer }

async function readDisk(abs: string): Promise<DiskState> {
  try {
    const st = await fsp.lstat(abs)
    // 符号链接、硬链接（nlink>1）、目录等一律视作特殊：回滚写入会穿到别处或写坏共享 inode
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) return { kind: 'special' }
    if (st.size > MAX_BLOB_BYTES) return { kind: 'tooLarge' }
    return { kind: 'file', buf: await fsp.readFile(abs) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'special' }
  }
}

/** 两段内容的加减行数；任一侧二进制 → binary。null = 不存在（整文件新增 / 删除）。 */
function statsBetween(
  from: Buffer | null,
  to: Buffer | null
): { added?: number; removed?: number; approx?: boolean; binary?: boolean } {
  if ((from && looksBinary(from)) || (to && looksBinary(to))) return { binary: true }
  if (!from && !to) return { added: 0, removed: 0 }
  if (!from) return { added: lineCount(to!.toString('utf8')), removed: 0 }
  if (!to) return { added: 0, removed: lineCount(from.toString('utf8')) }
  const s = lineStats(from.toString('utf8'), to.toString('utf8'))
  return s.approx ? s : { added: s.added, removed: s.removed }
}

// ───────────────────────── 记录层 ─────────────────────────

/** before() 的快照：写入前状态，交给 after() 结算成一条记录。 */
export interface WriteSnap {
  abs: string
  key: string
  pre: string | null | undefined
  preBuf: Buffer | null
  tooLarge: boolean
  seq: number
}

export interface Recorder {
  /** 写入类工具执行前调用：解析落点、备份原文件。非写入类 / 无法解析 / 特殊文件 → null（不记录）。 */
  before(name: string, args: unknown, root: string | null): Promise<WriteSnap | null>
  /** 执行后调用：内容未变（含写入失败）则丢弃；否则记入 checkpoints[ownerId]。 */
  after(snap: WriteSnap, ownerId: string): Promise<void>
  /** run_command 通过闸门执行后调用：只记命令文本。 */
  exec(command: string, ownerId: string): void
}

function maxSeq(s: StoredSession): number {
  let m = 0
  for (const recs of Object.values(s.checkpoints ?? {})) for (const r of recs) if (r.seq > m) m = r.seq
  return m
}

/**
 * 为一次回合创建记录器（主轮与其子智能体共用同一个，seq 因而全局递增）。
 * 调用方须把每个方法包在 try/catch 里：**记录失败绝不影响工具执行**。
 */
export function createRecorder(s: StoredSession): Recorder {
  let seq = maxSeq(s)
  return {
    async before(name, args, root) {
      const target = writeTargetPath(name, args, root)
      if (!target) return null
      const abs = target.abs
      const disk = await readDisk(abs)
      if (disk.kind === 'special') return null
      const snap: WriteSnap = {
        abs,
        key: pathKey(abs),
        pre: undefined,
        preBuf: null,
        tooLarge: disk.kind === 'tooLarge',
        seq: ++seq
      }
      if (disk.kind === 'missing') snap.pre = null
      else if (disk.kind === 'file') {
        const dir = sessionDir(s.id)
        if (!dir) return null
        const hash = sha256(disk.buf)
        await writeBlob(dir, hash, disk.buf)
        snap.pre = hash
        snap.preBuf = disk.buf
      }
      return snap
    },

    async after(snap, ownerId) {
      let postBuf: Buffer | null = null
      try {
        const st = await fsp.lstat(snap.abs)
        if (!st.isFile()) return
        postBuf = await fsp.readFile(snap.abs)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return
      }
      const post = postBuf ? sha256(postBuf) : null
      if (!snap.tooLarge && post === snap.pre) return // 未改动（或写入失败）

      const rec: CheckpointRec = {
        kind: 'file',
        path: snap.abs,
        real: realOf(snap.abs),
        post,
        seq: snap.seq,
        ...(snap.tooLarge ? { tooLarge: true } : statsBetween(snap.preBuf, postBuf))
      }
      if (snap.pre !== undefined) rec.pre = snap.pre
      const cps = (s.checkpoints ??= {})
      ;(cps[ownerId] ??= []).push(rec)
      ;(s.lastKnown ??= {})[snap.key] = post
      // 基线 = 本会话第一次动这个文件前的内容（给日后完整的 diff 功能留底；未备份的不记，免得与「原本不存在」混淆）
      const bl = (s.baselines ??= {})
      if (snap.pre !== undefined && !(snap.key in bl)) bl[snap.key] = snap.pre
    },

    exec(command, ownerId) {
      const cps = (s.checkpoints ??= {})
      ;(cps[ownerId] ??= []).push({ kind: 'exec', command: command.slice(0, EXEC_TEXT_MAX), seq: ++seq })
    }
  }
}

// ───────────────────────── 保留与清理 ─────────────────────────

/** 只保留仍在 messages 里的 tool_use 的记录（压缩重写历史后调用；按轮删除走 chat.ts 的同款 prune）。 */
export function pruneCheckpoints(s: StoredSession): void {
  if (!s.checkpoints) return
  const live = new Set<string>()
  for (const m of s.messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) if (p.type === 'tool_use') live.add(p.id)
  }
  const out: Record<string, CheckpointRec[]> = {}
  for (const [id, recs] of Object.entries(s.checkpoints)) if (live.has(id)) out[id] = recs
  s.checkpoints = out
}

/**
 * 保留上限：有备份的轮超过 MAX_TURNS 时，释放最老那些轮的 blob（pre 删除、标 released，元信息保留）。
 * 释放后回滚到那些轮，相应文件如实显示「备份缺失」，而不是悄悄恢复到一个错误的中间状态。
 * turnIds[k] = 第 k 轮的全部 tool_use id（由 chat.ts 按 turnRanges 给出）。
 */
export function enforceCap(s: StoredSession, turnIds: string[][], max = MAX_TURNS): void {
  const cps = s.checkpoints
  if (!cps) return
  const holdsBlob = (ids: string[]): boolean =>
    ids.some((id) => cps[id]?.some((r) => r.kind === 'file' && typeof r.pre === 'string'))
  const turns = turnIds.filter(holdsBlob)
  for (const ids of turns.slice(0, Math.max(0, turns.length - max)))
    for (const id of ids)
      for (const r of cps[id] ?? [])
        if (r.kind === 'file' && typeof r.pre === 'string') {
          delete r.pre
          r.released = true
        }
}

/**
 * 删掉本会话目录里不再被引用的 blob（引用 = 各记录的 pre + baselines）。
 * 调用方须保证会话不忙、且没有待撤销的回滚（撤销快照里的记录仍引用旧 blob）。
 * 另以 mtime 宽限兜底：GC 开始后才写入/触碰的 blob 一律不删。
 */
export async function gcBlobs(s: StoredSession): Promise<void> {
  const dir = sessionDir(s.id)
  if (!dir) return
  const keep = new Set<string>()
  for (const recs of Object.values(s.checkpoints ?? {}))
    for (const r of recs) if (r.kind === 'file' && typeof r.pre === 'string') keep.add(r.pre)
  for (const h of Object.values(s.baselines ?? {})) if (typeof h === 'string') keep.add(h)
  const cutoff = Date.now() - GC_GRACE_MS
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (keep.has(name)) continue
    const p = join(dir, name)
    try {
      if ((await fsp.stat(p)).mtimeMs >= cutoff) continue
      await fsp.rm(p, { force: true })
    } catch {
      /* 单个失败静默，下次再清 */
    }
  }
}

/**
 * 启动清扫（异步，不阻塞启动）：会话已不存在的目录整个删掉；过期 blob 与残留临时文件删掉。
 * 被删的 blob 对应的记录之后如实显示「备份缺失」。liveIds = 当前全部会话 id。
 */
export async function sweepCheckpoints(liveIds: Iterable<string>): Promise<void> {
  const root = checkpointsRoot()
  const live = new Set<string>()
  for (const id of liveIds) live.add(checkpointDirName(id))
  let dirs: Dirent[]
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name) continue
    const p = join(root, d.name)
    try {
      if (!live.has(d.name)) {
        // 刚建的目录可能属于清扫开始后才新建的会话：留一小时宽限
        if ((await fsp.stat(p)).mtimeMs < now - TMP_GRACE_MS)
          await fsp.rm(p, { recursive: true, force: true })
        continue
      }
      for (const name of await fsp.readdir(p)) {
        const f = join(p, name)
        const age = now - (await fsp.stat(f)).mtimeMs
        if (age > RETAIN_MS || (name.includes('.tmp-') && age > TMP_GRACE_MS))
          await fsp.rm(f, { force: true })
      }
    } catch {
      /* 单个目录失败静默 */
    }
  }
}

/** 删会话时连带删除其 blob 目录。 */
export function removeSessionCheckpoints(id: string): void {
  const dir = sessionDir(id)
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删除失败静默：启动清扫会兜底 */
  }
}

// ───────────────────────── 回滚 ─────────────────────────

/** 回滚列表里每轮的摘要（该轮自身的改动量，来自记录里存的统计）。 */
export interface RewindTurnStat {
  turn: number
  fileCount: number
  added: number
  removed: number
  /** 含近似 / 二进制 / 过大等无法精确计数的文件。 */
  approx: boolean
  hasExec: boolean
}

export function summarizeTurns(s: StoredSession, turnIds: string[][]): RewindTurnStat[] {
  return turnIds.map((ids, turn) => {
    const keys = new Set<string>()
    let added = 0
    let removed = 0
    let approx = false
    let hasExec = false
    for (const id of ids)
      for (const r of s.checkpoints?.[id] ?? []) {
        if (r.kind === 'exec') {
          hasExec = true
          continue
        }
        keys.add(pathKey(r.path))
        added += r.added ?? 0
        removed += r.removed ?? 0
        if (r.approx || r.binary || r.tooLarge) approx = true
      }
    return { turn, fileCount: keys.size, added, removed, approx, hasExec }
  })
}

export type RewindAction = 'restore' | 'delete' | 'create' | 'none'
export type RewindStatus = 'ok' | 'conflict' | 'link' | 'blob_missing' | 'too_large' | 'protected'

/** 预览里的一个文件（发给渲染层；不含任何内容，只有摘要）。 */
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

interface PlanItem extends RewindFile {
  key: string
  /** 回滚目标内容；null = 目标是「不存在」。 */
  targetBuf: Buffer | null
  targetHash: string | null
  /** 磁盘现状字节；null = 不存在。status 非 ok/conflict 时无意义。 */
  curBuf: Buffer | null
}

export interface RewindPlan {
  items: PlanItem[]
  commands: string[]
}

/** 显示用路径：在聚焦工作区内的给相对路径（正斜杠），否则给绝对路径。 */
function displayPath(abs: string, focusRoot: string | null): string {
  if (focusRoot) {
    const rel = relative(focusRoot, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/')
  }
  return abs
}

/**
 * 计算回滚计划：ownerIds = 目标轮起全部 tool_use id。每个文件取最早记录的 pre 为目标，
 * 与磁盘现状比对出动作与状态；+N −M 是「现状 → 目标」，即这次回滚实际要加减的行数。
 * 每次执行前都在主进程重算，绝不信任渲染层回传的预览。
 */
export async function planRewind(
  s: StoredSession,
  ownerIds: Iterable<string>,
  focusRoot: string | null
): Promise<RewindPlan> {
  const earliest = new Map<string, Extract<CheckpointRec, { kind: 'file' }>>()
  const execs: { command: string; seq: number }[] = []
  for (const id of ownerIds)
    for (const r of s.checkpoints?.[id] ?? []) {
      if (r.kind === 'exec') {
        execs.push(r)
        continue
      }
      const key = pathKey(r.path)
      const prev = earliest.get(key)
      if (!prev || r.seq < prev.seq) earliest.set(key, r)
    }

  const items: PlanItem[] = []
  for (const [key, rec] of earliest) {
    const item: PlanItem = {
      path: rec.path,
      rel: displayPath(rec.path, focusRoot),
      key,
      action: 'none',
      status: 'ok',
      targetBuf: null,
      targetHash: null,
      curBuf: null
    }
    items.push(item)

    if (isSensitivePath(rec.path) || isProtectedPath(rec.path)) {
      item.status = 'protected'
      continue
    }
    if (rec.real && pathKey(realOf(rec.path)) !== pathKey(rec.real)) {
      item.status = 'link'
      continue
    }
    const disk = await readDisk(rec.path)
    if (disk.kind === 'special') {
      item.status = 'link'
      continue
    }
    if (disk.kind === 'tooLarge') {
      item.status = 'too_large'
      continue
    }
    item.curBuf = disk.kind === 'file' ? disk.buf : null
    const curHash = item.curBuf ? sha256(item.curBuf) : null

    if (rec.pre === undefined) {
      item.status = rec.tooLarge ? 'too_large' : 'blob_missing'
      continue
    }
    if (rec.pre !== null) {
      const buf = await readBlob(s.id, rec.pre)
      if (!buf) {
        item.status = 'blob_missing'
        continue
      }
      item.targetBuf = buf
      item.targetHash = rec.pre
    }

    if (curHash === item.targetHash) continue // 现状已等于目标：无事可做
    item.action = item.targetHash === null ? 'delete' : curHash === null ? 'create' : 'restore'
    Object.assign(item, statsBetween(item.curBuf, item.targetBuf))
    const known = s.lastKnown?.[key]
    if (known === undefined || known !== curHash) item.status = 'conflict'
  }

  items.sort((a, b) => a.rel.localeCompare(b.rel))
  execs.sort((a, b) => a.seq - b.seq)
  return { items, commands: execs.map((e) => e.command) }
}

/** 计划 → 发给渲染层的预览（剥掉内容字节与内部键）。 */
export function publicPreview(plan: RewindPlan): { files: RewindFile[]; commands: string[] } {
  return {
    files: plan.items.map(({ path, rel, action, status, added, removed, approx, binary }) => ({
      path,
      rel,
      action,
      status,
      added,
      removed,
      approx,
      binary
    })),
    commands: plan.commands
  }
}

/** 撤销上次回滚所需的单文件快照：回滚前的字节 + 回滚写入的 hash（撤销时核对仍未被动过）。 */
export interface UndoFile {
  path: string
  rel: string
  bytes: Buffer | null
  wrote: string | null
}

export interface ApplyResult {
  restored: string[]
  skipped: { rel: string; reason: RewindStatus | 'error' }[]
  undo: UndoFile[]
}

/**
 * 执行文件回滚：只动 ok 的文件，外加 force 里勾选的冲突文件（force 只认计划里的冲突路径）。
 * 链接 / 备份缺失 / 过大 / 受保护的文件（计划里动作为 none）如实记入 skipped，与预览里的「跳过」一致；
 * 单个文件失败也记入 skipped，其余照常继续；每写成一个就更新 lastKnown。
 */
export async function applyFiles(
  s: StoredSession,
  plan: RewindPlan,
  force: Set<string>
): Promise<ApplyResult> {
  const out: ApplyResult = { restored: [], skipped: [], undo: [] }
  for (const it of plan.items) {
    if (it.status !== 'ok' && it.status !== 'conflict') {
      out.skipped.push({ rel: it.rel, reason: it.status })
      continue
    }
    if (it.action === 'none') continue
    const allowed = it.status === 'ok' || force.has(it.path)
    if (!allowed) {
      out.skipped.push({ rel: it.rel, reason: it.status })
      continue
    }
    try {
      if (it.targetBuf === null) await fsp.rm(it.path, { force: true })
      else {
        await fsp.mkdir(dirname(it.path), { recursive: true })
        await fsp.writeFile(it.path, it.targetBuf)
      }
      ;(s.lastKnown ??= {})[it.key] = it.targetHash
      out.restored.push(it.rel)
      out.undo.push({ path: it.path, rel: it.rel, bytes: it.curBuf, wrote: it.targetHash })
    } catch {
      out.skipped.push({ rel: it.rel, reason: 'error' })
    }
  }
  return out
}

/** 撤销文件回滚：只写回「现状仍等于回滚写入内容」的文件，其余（回滚后又被改过）报告跳过。 */
export async function undoFiles(undo: UndoFile[]): Promise<{ restored: string[]; skipped: string[] }> {
  const out = { restored: [] as string[], skipped: [] as string[] }
  for (const u of undo) {
    const disk = await readDisk(u.path)
    const cur = disk.kind === 'file' ? sha256(disk.buf) : disk.kind === 'missing' ? null : undefined
    if (cur !== u.wrote) {
      out.skipped.push(u.rel)
      continue
    }
    try {
      if (u.bytes === null) await fsp.rm(u.path, { force: true })
      else {
        await fsp.mkdir(dirname(u.path), { recursive: true })
        await fsp.writeFile(u.path, u.bytes)
      }
      out.restored.push(u.rel)
    } catch {
      out.skipped.push(u.rel)
    }
  }
  return out
}

/**
 * 「仅恢复代码」后，下一条用户消息要带给模型的说明：对话还记着旧改动，但磁盘已回到较早状态，
 * 不告诉它就会基于过期认知继续编辑。
 */
export function buildRestoreNote(rels: string[]): string {
  const MAX = 30
  const list = rels.slice(0, MAX).map((r) => `- ${r}`)
  if (rels.length > MAX) list.push(`- ……另 ${rels.length - MAX} 个文件`)
  return [
    '【系统提示】用户刚用检查点回滚把以下文件恢复到了较早的状态（对话记录保持不变），你在此之后对它们的改动已被撤销：',
    ...list,
    '这些文件请以磁盘现状为准：需要时先重新读取，不要依据对话里的旧内容继续编辑。'
  ].join('\n')
}
