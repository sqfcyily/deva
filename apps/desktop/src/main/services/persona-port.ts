import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { unzipSync, zipSync, type Unzipped } from 'fflate'
import { writeFileAtomic } from './atomic-write'
import {
  avatarsDir,
  builtinPersonaIds,
  getPersona,
  isSafeId,
  makeId,
  personaKnowledgeDir,
  personasDir,
  readImportsMap,
  readPersonaMdRaw,
  setPersonaEnabled,
  writeImportsEntry,
  writePersonaMdRaw,
  type PersonaImportProvenance
} from './personas'
import { clearAvatarImage, readAvatarImage, writeAvatarImage } from './avatar-image'
import { fmString, parseFrontmatter } from './frontmatter'
import { getRoles, setRoles } from './ext-roles'
import { listSkills, skillsDir } from './skills'
import {
  getServerConfig,
  listServerConfigs,
  upsertServer,
  type McpServerConfig,
  type McpTransport
} from './mcp-config'
import { getSecret, setSecret } from './secrets'

/**
 * 角色包（persona bundle）导出 / 导入：把一条角色及其**从属内容**（专属技能、专属 MCP、知识库目录、
 * 自定义头像）打成单个 zip，在另一台机器 / 另一个 DEVA_HOME 上还原。设计与决策见
 * docs/plantree/plans/001-persona-export-import/（D1 id 判定序 / D2 内置硬闸 / D3 再导入=更新 / Q4 打包范围）。
 *
 * - persona.md 取磁盘**原文**（readPersonaMdRaw）：与用户磁盘上的工件字节一致，frontmatter 不加新键。
 * - 目录路径一律经 personas.ts 的 personasDir / avatarsDir / personaKnowledgeDir——角色相关路径的唯一出口，此处不出现字面量。
 * - 秘密链路：导出把 `{secretRef}` 经 getSecret 解成包内 `{ secret: 明文 }`（用户明示接受包内明文）；
 *   导入即重加密回本机 secrets.json（setSecret），此后明文不再落地。
 * - 簿记（personas.imports，见 personas.ts）让「同一包再次导入」走就地更新而非重复新建。
 */

export const BUNDLE_KIND = 'deva-persona-bundle'
export const BUNDLE_FORMAT = 1

// 限额（防 zip 炸弹）：角色包 ≈ prompt 文本 + ≤2MB 头像 + 技能/知识库目录，比技能包宽松但仍有界。
const BUNDLE_MAX_TOTAL_BYTES = 30 * 1024 * 1024
const BUNDLE_MAX_FILES = 500
const BUNDLE_MAX_SINGLE_BYTES = 10 * 1024 * 1024

/** 头像扩展名 → MIME（与 avatar-image.ts 的白名单对齐：webp/png/jpg 三种）。 */
const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg'
}

export interface PersonaExportResult {
  ok: boolean
  /** 成功时写出的 zip 绝对路径。 */
  path?: string
  /** 稳定错误码（渲染层本地化）：builtin / not-found / cancelled / too-large / save-failed。 */
  error?: string
  /** 解不出的 MCP 秘密字段（`mcp:<id>:<字段>` 清单）——包能导出，但那些字段没带上。 */
  warnings?: string[]
}

export interface PersonaImportResult {
  ok: boolean
  /** 稳定错误码：cancelled / bad-zip / bad-manifest / bad-persona / unsafe-path / too-large / too-many-files / write-failed / import-failed。 */
  error?: string
  id?: string
  name?: string
  /** true = 同源包的就地更新（D3）；false = 新建。 */
  updated?: boolean
  /** 包内技能 / MCP id → 本地落地 id（铸了新 id 时非恒等）。 */
  idMap?: { skills: Record<string, string>; mcp: Record<string, string> }
  warnings?: string[]
}

/** manifest.json（包内自描述；originalId 等来源信息只进这里，不污染 persona.md）。 */
interface BundleManifest {
  kind?: unknown
  format?: unknown
  exportedAt?: unknown
  appVersion?: unknown
  originalId?: unknown
  contents?: {
    skills?: unknown
    mcp?: unknown
    knowledge?: unknown
  }
}

/** 包内 MCP 条目：env/headers 的秘密字段以 `{ secret: 明文 }` 与普通明文串区分，导入时分别处理。 */
interface BundleMcpEntry {
  id?: unknown
  name?: unknown
  description?: unknown
  transport?: unknown
  command?: unknown
  args?: unknown
  url?: unknown
  env?: Record<string, unknown>
  headers?: Record<string, unknown>
}

type BundleValue = string | { secret: string }

// ── 通用小工具 ────────────────────────────────────────────────────────────────

function utf8(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'utf8'))
}

/** 逐段 zip-slip 守卫：拒绝空段 / `.` / `..` / 含分隔符或盘符 / 绝对路径（与 skills.ts 同一取法）。 */
function isSafeBundlePath(rel: string): boolean {
  if (!rel || isAbsolute(rel)) return false
  return !rel.split('/').some((s) => s === '' || s === '.' || s === '..' || /[\\:\0]/.test(s))
}

interface BundleSizeState {
  count: number
  totalBytes: number
}

/** 递归收集目录下全部文件为「包内相对路径 → 字节」。返回 false = 超限额（调用方中止导出）。 */
function collectDirInto(
  root: string,
  relBase: string,
  out: Record<string, Uint8Array>,
  state: BundleSizeState
): boolean {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return true
  }
  for (const name of entries) {
    const abs = join(root, name)
    const rel = `${relBase}${name}`
    let st
    try {
      // lstat：符号链接一律跳过——链接到目录会带来环递归与越界拉取（对齐检查点模块的同类安全取法）。
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      if (!collectDirInto(abs, `${rel}/`, out, state)) return false
      continue
    }
    state.count += 1
    if (state.count > BUNDLE_MAX_FILES) return false
    if (st.size > BUNDLE_MAX_SINGLE_BYTES) return false
    state.totalBytes += st.size
    if (state.totalBytes > BUNDLE_MAX_TOTAL_BYTES) return false
    try {
      out[rel] = new Uint8Array(readFileSync(abs))
    } catch {
      continue
    }
  }
  return true
}

/** 把解压出的包文件按相对路径落到一个目标目录（先整删目标再落——更新语义；逐段守卫 + 断言在目标内）。 */
function extractDirInto(files: Unzipped, prefix: string, target: string): { ok: boolean; error?: string } {
  try {
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
  } catch {
    return { ok: false, error: 'write-failed' }
  }
  const guardedRoot = resolve(target)
  for (const [p, data] of Object.entries(files)) {
    if (!p.startsWith(prefix) || p.endsWith('/')) continue
    const rel = p.slice(prefix.length)
    if (!isSafeBundlePath(rel)) return { ok: false, error: 'unsafe-path' }
    const dest = resolve(target, rel)
    // 纵深防御：断言落在目标目录内（逐段守卫之外再验一次）。
    if (dest !== guardedRoot && !dest.startsWith(guardedRoot + sep)) continue
    try {
      mkdirSync(resolve(dest, '..'), { recursive: true })
      writeFileSync(dest, Buffer.from(data))
    } catch {
      return { ok: false, error: 'write-failed' }
    }
  }
  return { ok: true }
}

/** 铸一个 `<base>-2/-3…` 的空闲 id（占用探测由调用方传 has）。 */
function mintFreeId(base: string, has: (x: string) => boolean): string {
  let id = base
  let n = 2
  while (has(id)) id = `${base}-${n++}`
  return id
}

function stringIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// ── 导出 ──────────────────────────────────────────────────────────────────────

/**
 * 组包内 MCP 条目：`{secretRef}` 占位经 getSecret 解成包内 `{ secret: 明文 }`；
 * 解不出的字段（未配置 / 加密不可用）跳过并记警告——包能导出，但那些字段没带上。
 */
async function bundleMcpEntry(cfg: McpServerConfig, warnings: string[]): Promise<BundleMcpEntry | null> {
  const conv = async (
    map: Record<string, unknown> | undefined
  ): Promise<Record<string, BundleValue> | undefined> => {
    if (!map || typeof map !== 'object') return undefined
    const out: Record<string, BundleValue> = {}
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string') {
        out[k] = v
        continue
      }
      const ref = (v as { secretRef?: unknown })?.secretRef
      if (typeof ref !== 'string' || !ref) continue
      const val = await getSecret(`mcp:${cfg.id}:${ref}`)
      if (val) out[k] = { secret: val }
      else warnings.push(`mcp:${cfg.id}:${k}`)
    }
    return Object.keys(out).length ? out : undefined
  }
  const entry: BundleMcpEntry = {
    id: cfg.id,
    name: cfg.name,
    description: cfg.description,
    transport: cfg.transport
  }
  if (cfg.transport === 'stdio') {
    entry.command = cfg.command
    entry.args = cfg.args
    entry.env = await conv(cfg.env as unknown as Record<string, unknown>)
  } else {
    entry.url = cfg.url
    entry.headers = await conv(cfg.headers as unknown as Record<string, unknown>)
  }
  return entry
}

/**
 * 导出一条角色为 zip 包：主进程弹保存框（模态），写 `<name>.devapersona.zip`。
 * 本地只读（目录收集）+ 一次写盘，不改任何本地状态。canceled = 用户取消。
 */
export async function exportPersonaBundle(
  getWindow: () => BrowserWindow | null,
  id: string
): Promise<PersonaExportResult> {
  const win = getWindow()
  if (builtinPersonaIds().has(id)) return { ok: false, error: 'builtin' } // D2：内置不导出
  const raw = readPersonaMdRaw(id)
  if (raw === null) return { ok: false, error: 'not-found' }
  const rec = getPersona(id)
  const warnings: string[] = []

  const files: Record<string, Uint8Array> = { 'persona.md': utf8(raw) }
  const contents: { skills: string[]; mcp: string[]; knowledge: boolean } = {
    skills: [],
    mcp: [],
    knowledge: false
  }
  const state: BundleSizeState = { count: 1, totalBytes: Buffer.byteLength(raw, 'utf8') }

  // 自定义头像（.webp/.png/.jpg 任一存在；无图则包里也不带）
  const avatarDataUri = readAvatarImage(avatarsDir(), id)
  const avatarM = avatarDataUri ? /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(avatarDataUri) : null
  if (avatarM) {
    const ext = avatarM[1] === 'jpeg' ? 'jpg' : avatarM[1]
    if (MIME_BY_EXT[ext]) {
      files[`avatar.${ext}`] = new Uint8Array(Buffer.from(avatarM[2], 'base64'))
      state.count += 1
      state.totalBytes += files[`avatar.${ext}`].length
    }
  }

  // 知识库目录（issue#65 档 0 约定，personas/knowledge/<id>/）
  if (existsSync(personaKnowledgeDir(id))) {
    if (!collectDirInto(personaKnowledgeDir(id), `knowledge/${id}/`, files, state)) {
      return { ok: false, error: 'too-large' }
    }
    contents.knowledge = true
  }

  // 专属技能：可用角色列表（ext-roles）含该角色才随包——共享给全部角色（无 roles 键）的不打包
  for (const s of listSkills()) {
    if (s.source !== 'custom') continue
    const roles = getRoles('skills', s.id)
    if (!roles || !roles.includes(id)) continue
    const before = state.count
    if (!collectDirInto(join(skillsDir(), s.id), `skills/${s.id}/`, files, state)) {
      return { ok: false, error: 'too-large' }
    }
    if (state.count > before) contents.skills.push(s.id)
  }
  // 专属 MCP：配置 + 解密秘密
  const mcpEntries: BundleMcpEntry[] = []
  for (const cfg of listServerConfigs()) {
    const roles = getRoles('mcp', cfg.id)
    if (!roles || !roles.includes(id)) continue
    const entry = await bundleMcpEntry(cfg, warnings)
    if (entry) {
      mcpEntries.push(entry)
      contents.mcp.push(cfg.id)
    }
  }
  if (mcpEntries.length) files['mcp.json'] = utf8(JSON.stringify({ servers: mcpEntries }, null, 2))

  const manifest = {
    kind: BUNDLE_KIND,
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    originalId: id,
    contents
  }
  files['manifest.json'] = utf8(JSON.stringify(manifest, null, 2))

  const safeName = (rec?.name || id).replace(/[\\/:*?"<>|]/g, '_').trim() || id
  const opts = {
    defaultPath: `${safeName}.devapersona.zip`,
    filters: [{ name: '角色包', extensions: ['zip'] }]
  }
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (res.canceled || !res.filePath) return { ok: false, error: 'cancelled' }
  try {
    writeFileAtomic(res.filePath, Buffer.from(zipSync(files)))
  } catch {
    return { ok: false, error: 'save-failed' }
  }
  return { ok: true, path: res.filePath, warnings: warnings.length ? warnings : undefined }
}

// ── 导入 ──────────────────────────────────────────────────────────────────────

/** 解包 + 限额 + 全路径守卫 + manifest 校验；失败给出稳定错误码。 */
function unzipBundle(filePath: string): { files: Unzipped; manifest: BundleManifest } | { error: string } {
  let files: Unzipped
  try {
    files = unzipSync(readFileSync(filePath))
  } catch {
    return { error: 'bad-zip' }
  }
  const paths = Object.keys(files).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'))
  if (paths.length > BUNDLE_MAX_FILES) return { error: 'too-many-files' }
  let total = 0
  for (const p of paths) {
    if (!isSafeBundlePath(p)) return { error: 'unsafe-path' }
    total += files[p].length
    if (files[p].length > BUNDLE_MAX_SINGLE_BYTES) return { error: 'too-large' }
    if (total > BUNDLE_MAX_TOTAL_BYTES) return { error: 'too-large' }
  }
  let manifest: BundleManifest
  try {
    manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8')) as BundleManifest
  } catch {
    return { error: 'bad-manifest' }
  }
  if (manifest?.kind !== BUNDLE_KIND || manifest?.format !== BUNDLE_FORMAT) return { error: 'bad-manifest' }
  if (!files['persona.md']) return { error: 'bad-persona' }
  return { files, manifest }
}

/** 包内 persona.md 的校验解析（name 提取供铸 id；写盘走 writePersonaMdRaw 原样字节）。 */
function parseBundlePersona(
  files: Unzipped,
  fallbackName: string
): { name: string; description: string; avatar: string; model: string; prompt: string } | null {
  try {
    const { data, body } = parseFrontmatter(Buffer.from(files['persona.md']).toString('utf8'))
    const name = fmString(data, 'name').trim() || fallbackName
    return {
      name,
      description: fmString(data, 'description'),
      avatar: fmString(data, 'avatar'),
      model: fmString(data, 'model'),
      prompt: body.trim()
    }
  } catch {
    return null
  }
}

/**
 * id 判定序（决策 D1 + D3）：原 id 安全、非内置且空闲 → 沿用（新建）；
 * 已被占且簿记在案（同源包之前导入过）→ 就地更新；其余（撞了别的角色 / 外来 id / 内置）→ 铸随机新 id。
 */
function resolveImportId(
  originalId: string,
  localName: string
): { finalId: string; updated: boolean; keepOriginal: boolean } {
  const builtin = builtinPersonaIds()
  const usable = isSafeId(originalId) && !builtin.has(originalId)
  if (usable) {
    if (!existsSync(join(personasDir(), `${originalId}.md`))) {
      return { finalId: originalId, updated: false, keepOriginal: true }
    }
    if (readImportsMap()[originalId]) return { finalId: originalId, updated: true, keepOriginal: true }
  }
  return { finalId: makeId(localName), updated: false, keepOriginal: false }
}

/** 落头像：包里带图则覆盖写；不带则清掉本地旧图（包是该角色外观的真源，更新后不留旧脸）。 */
function installAvatar(files: Unzipped, finalId: string): void {
  clearAvatarImage(avatarsDir(), finalId)
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const data = files[`avatar.${ext}`]
    if (!data) continue
    writeAvatarImage(avatarsDir(), finalId, `data:${MIME_BY_EXT[ext]};base64,${Buffer.from(data).toString('base64')}`)
    return
  }
}

/**
 * 随包技能：id 判定优先回访簿记映射（映射到的本地技能已被删则当作没映射过），其次占用空闲原名，
 * 冲突才铸 `<id>-2` 新名（记警告）。落地后可用角色收窄为仅该角色（Q4：不保留原多角色分配）。
 */
function installBundledSkills(
  files: Unzipped,
  bundleSkillIds: string[],
  prov: PersonaImportProvenance | undefined,
  finalPersonaId: string,
  warnings: string[]
): Record<string, string> {
  const idMap: Record<string, string> = {}
  for (const bundleId of bundleSkillIds) {
    const prefix = `skills/${bundleId}/`
    if (!isSafeId(bundleId) || !Object.keys(files).some((p) => p.startsWith(prefix))) continue
    let target = prov?.skills?.[bundleId]
    if (target && !existsSync(join(skillsDir(), target))) target = ''
    if (!target) {
      if (!existsSync(join(skillsDir(), bundleId))) {
        target = bundleId
      } else {
        target = mintFreeId(bundleId, (x) => existsSync(join(skillsDir(), x)))
        warnings.push(`skill:${bundleId}→${target}`)
      }
    }
    const r = extractDirInto(files, prefix, join(skillsDir(), target))
    if (!r.ok) {
      warnings.push(`skill:${bundleId}:${r.error}`)
      continue
    }
    setRoles('skills', target, [finalPersonaId])
    idMap[bundleId] = target
  }
  return idMap
}

/**
 * 随包 MCP：秘密明文重加密回本机 secrets.json（加密不可用的字段跳过并记警告，留待用户手填），
 * 配置落 mcp.json（upsertServer 的变更通知驱动连接），导入即启用，角色收窄为仅该角色。
 */
async function installBundledMcp(
  files: Unzipped,
  bundleMcpIds: string[],
  prov: PersonaImportProvenance | undefined,
  finalPersonaId: string,
  warnings: string[]
): Promise<Record<string, string>> {
  const idMap: Record<string, string> = {}
  let entries: BundleMcpEntry[] = []
  try {
    const parsed = JSON.parse(Buffer.from(files['mcp.json'] ?? utf8('{"servers":[]}')).toString('utf8'))
    if (Array.isArray(parsed?.servers)) entries = parsed.servers as BundleMcpEntry[]
  } catch {
    warnings.push('mcp:unreadable')
  }
  const existing = new Set(listServerConfigs().map((s) => s.id))
  const conv = async (
    mid: string,
    map: Record<string, unknown> | undefined
  ): Promise<Record<string, string | { secretRef: string }> | undefined> => {
    if (!map || typeof map !== 'object') return undefined
    const out: Record<string, string | { secretRef: string }> = {}
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === 'string') {
        out[k] = v
        continue
      }
      const secret = (v as { secret?: unknown })?.secret
      if (typeof secret !== 'string' || !secret) continue
      const r = await setSecret(`mcp:${mid}:${k}`, secret)
      if (!r.ok) {
        warnings.push(`mcp:${mid}:${k}:secret-unavailable`)
        continue
      }
      out[k] = { secretRef: k }
    }
    return Object.keys(out).length ? out : undefined
  }
  for (const e of entries) {
    const bundleId = typeof e.id === 'string' ? e.id : ''
    if (!bundleId || !bundleMcpIds.includes(bundleId) || !isSafeId(bundleId)) continue
    let mid = prov?.mcp?.[bundleId]
    if (mid && !getServerConfig(mid)) mid = '' // 映射到的本地服务已被删：当作没映射过
    if (!mid) {
      if (!existing.has(bundleId)) {
        mid = bundleId
      } else {
        mid = mintFreeId(bundleId, (x) => existing.has(x))
        warnings.push(`mcp:${bundleId}→${mid}`)
      }
    }
    existing.add(mid)
    const transport: McpTransport = e.transport === 'sse' || e.transport === 'http' ? e.transport : 'stdio'
    upsertServer({
      id: mid,
      name: typeof e.name === 'string' && e.name.trim() ? e.name : bundleId,
      description: typeof e.description === 'string' ? e.description : '',
      transport,
      ...(transport === 'stdio'
        ? {
            command: typeof e.command === 'string' ? e.command : '',
            args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [],
            env: await conv(mid, e.env)
          }
        : {
            url: typeof e.url === 'string' ? e.url : '',
            headers: await conv(mid, e.headers)
          }),
      enabled: true
    })
    setRoles('mcp', mid, [finalPersonaId])
    idMap[bundleId] = mid
  }
  return idMap
}

/**
 * 导入一个角色包（主进程弹选择框）。同源包再导入 = 就地更新（D3）；绝不覆盖非本包来源的同 id 角色。
 * 角色工件经 upsert 原子写、目录先整删再落，失败绝不半写角色本体。
 */
export async function importPersonaBundle(getWindow: () => BrowserWindow | null): Promise<PersonaImportResult> {
  const win = getWindow()
  const opts = {
    properties: ['openFile' as const],
    filters: [{ name: '角色包', extensions: ['zip'] }]
  }
  const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (picked.canceled || !picked.filePaths.length) return { ok: false, error: 'cancelled' }
  return importPersonaBundleFrom(picked.filePaths[0])
}

/** 从指定路径导入（IPC 与验证脚本共用入口）。 */
export async function importPersonaBundleFrom(filePath: string): Promise<PersonaImportResult> {
  const warnings: string[] = []
  try {
    const parsed = unzipBundle(filePath)
    if ('error' in parsed) return { ok: false, error: parsed.error }
    const { files, manifest } = parsed

    const originalId = typeof manifest.originalId === 'string' ? manifest.originalId : ''
    const persona = parseBundlePersona(files, originalId || 'imported-persona')
    if (!persona) return { ok: false, error: 'bad-persona' }

    const { finalId, updated, keepOriginal } = resolveImportId(originalId, persona.name)
    const prov = keepOriginal ? readImportsMap()[finalId] : undefined

    // 角色本体：**原样写包内字节**，不做 frontmatter 重组——手改键与未来字段（knowledge/workspace）不在往返中丢失。
    // 启用态：新建默认关（与 upsert 既有语义一致）；更新不动启用态。
    if (!writePersonaMdRaw(finalId, Buffer.from(files['persona.md']).toString('utf8'))) {
      return { ok: false, error: 'write-failed' }
    }
    if (!updated) setPersonaEnabled(finalId, false)

    // 头像 / 知识库 / 随包技能 / 随包 MCP
    installAvatar(files, finalId)
    const bundleSkillIds = stringIds(manifest.contents?.skills).filter((x) => isSafeId(x))
    const skillMap = bundleSkillIds.length
      ? installBundledSkills(files, bundleSkillIds, prov, finalId, warnings)
      : {}
    const bundleMcpIds = stringIds(manifest.contents?.mcp).filter((x) => isSafeId(x))
    const mcpMap = bundleMcpIds.length
      ? await installBundledMcp(files, bundleMcpIds, prov, finalId, warnings)
      : {}
    if (manifest.contents?.knowledge === true) {
      const originalPrefix = `knowledge/${originalId}/`
      if (Object.keys(files).some((p) => p.startsWith(originalPrefix))) {
        const r = extractDirInto(files, originalPrefix, personaKnowledgeDir(finalId))
        if (!r.ok) warnings.push(`knowledge:${r.error}`)
      }
    }

    // 簿记（D3 的再次导入判定依据）：skills/mcp 合并旧映射——上次导入装过、本次包里没带的从属内容仍在本地，映射继续有效
    const bundleHash = createHash('sha256')
      .update(files['persona.md'])
      .update(utf8(JSON.stringify(manifest.contents ?? {})))
      .digest('hex')
    writeImportsEntry(finalId, {
      originalId: keepOriginal ? originalId : finalId,
      bundleHash,
      skills: { ...(prov?.skills ?? {}), ...skillMap },
      mcp: { ...(prov?.mcp ?? {}), ...mcpMap }
    })

    return {
      ok: true,
      id: finalId,
      name: persona.name,
      updated,
      idMap: { skills: skillMap, mcp: mcpMap },
      warnings: warnings.length ? warnings : undefined
    }
  } catch {
    return { ok: false, error: 'import-failed' }
  }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

/** 角色包读写 IPC：导出弹保存框、导入弹选择框（模态，取主窗口）。 */
export function registerPersonaPortIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('personas:export', (_e, id: string): Promise<PersonaExportResult> =>
    exportPersonaBundle(getWindow, String(id ?? ''))
  )
  ipcMain.handle('personas:import', (): Promise<PersonaImportResult> => importPersonaBundle(getWindow))
}
