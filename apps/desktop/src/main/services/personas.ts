import { ipcMain } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  clearAvatarImage as clearAvatarImageFile,
  readAvatarImage as readAvatarImageFile,
  writeAvatarImage as writeAvatarImageFile
} from './avatar-image'
import { getConfig, getDevaHome, setConfig } from './config'
import { pruneRoles } from './ext-roles'
import { setSkillEnabled } from './skills'
import { setEnabled as setMcpEnabled } from './mcp-config'
import { DEFAULT_PERSONAS, LEGACY_PROMPT_HASHES, type DefaultPersona } from './default-personas'
import { fmScalar, fmString, parseFrontmatter } from './frontmatter'
import { reassignTaskPersona } from './tasks'

/**
 * Agent 提示词（Personas）服务：发现 / 解析 / 读写 `~/.deva/personas/<id>.md`（全局，与项目无关）。
 *
 * 定位（对标 ChatGPT「自定义指令」/ 人格 profile）：每条 persona 是一段命名的**附加系统提示词**
 * （性格、语气、行文风格、偏好等）。可多条并存、独立启停；**已启用**的会在每轮对话前**追加**进
 * 主智能体系统提示词（见 chat.ts `systemPrompt`）。与 skill/subagent 的启停模型一致（叠加，非单选）。
 *
 * 设计（照 agents.ts 裁剪，但更简单：**无 tools**——角色不收窄工具，全部工具按需可用）：
 * - **身份 = 文件名去扩展名（id），显示名 = frontmatter `name`**。文件名恒定不改（改显示名只重写
 *   frontmatter），故重命名不触发文件搬迁，UI 的「id 稳定 / name 可编辑」模型天然成立。
 * - 启用态**不入 .md**，集中存 `config.json` 的 `personas.enabled[id]`，默认关。
 * - `<id>.md` = frontmatter（name/description）+ 正文（prompt，即要追加的提示词）。
 * - 自定义头像图片（用户上传）另存 `personas/avatars/<id>.<ext>`，**不入 frontmatter**：有图即覆盖
 *   生成头像，一个 id 至多一张（重传先清变体），删角色时一并删（否则 id 复用会串脸）。
 *
 * 运行期（chat.ts 同进程直接调用，无需 IPC）：主轮只注入本对话角色这一条的 name+prompt（见 resolvePersonaId；
 * 子智能体有自己的系统提示词，刻意不注入，避免串味）。
 *
 * 安全：persona 配置由**主进程直读**。注入时以固定前言框定为「用户自定义附加指令，在不违反安全与工具使用原则的前提下遵循」——persona
 * 绝不能借此关闭「切勿用文字征求授权」等安全/工具铁律。
 */

/**
 * 默认角色 Deva 的固定 id（种子角色，见 deva-personas.ts；界面不允许删除）。
 * 未绑定角色、或绑定的角色已被删除时一律回落到它；按 id 绑定，用户改名不受影响。
 */
export const DEFAULT_PERSONA_ID = 'general'

export interface PersonaRecord {
  /** 文件名（去 .md），稳定身份（选择/启用态键）。 */
  id: string
  /** frontmatter name，显示名（缺省回落 id）。 */
  name: string
  /** 专长，一句话（frontmatter description）。 */
  description: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成。本层只当不透明串搬运）。 */
  avatar: string
  /**
   * 自定义头像图片，**只读派生字段**（data URI；空串 = 没传过图，回落 Humation 生成头像）。
   * 真源是磁盘上的 `personas/avatars/<id>.*` 是否存在——故**不入 frontmatter**、不进 upsert 输入，
   * 改图走独立的 set/clear IPC（见文件末）。渲染层 CSP 不许 `file:`，只能以 data URI 交付。
   *
   * **按需读取**：只有 IPC 出口（给渲染层显示）才填，主进程内部调用（组装系统提示词、
   * chat.ts 取角色）恒为空串——否则每轮对话都要把所有头像读盘 + base64 一遍，纯属白做功。
   */
  avatarImage: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认（见 model-resolve.ts）。 */
  model: string
  /** .md 正文 = 要追加进系统提示词的内容。 */
  prompt: string
  enabled: boolean
}

export interface PersonaUpsertInput {
  /** 有 id → 覆盖该文件；无 id → 新建（据 name 生成稳定文件名）。 */
  id?: string
  name: string
  description?: string
  avatar?: string
  model?: string
  prompt?: string
  /** 可选：一并设置启用态（新建默认关）。 */
  enabled?: boolean
}

function personasDir(): string {
  return join(getDevaHome(), 'personas')
}

function personaFile(id: string): string {
  return join(personasDir(), `${id}.md`)
}

// ── 自定义头像图片（personas/avatars/<id>.<ext>）─────────────────────────────
// 落盘细节（一 id 一图、MIME 白名单、大小兜底）见 avatar-image.ts；此处只加 id 合法性守卫。

function avatarsDir(): string {
  return join(personasDir(), 'avatars')
}

function readAvatarImage(id: string): string {
  return isSafeId(id) ? readAvatarImageFile(avatarsDir(), id) : ''
}

function clearAvatarImage(id: string): void {
  if (isSafeId(id)) clearAvatarImageFile(avatarsDir(), id)
}

function writeAvatarImage(id: string, dataUri: string): string {
  return isSafeId(id) ? writeAvatarImageFile(avatarsDir(), id, dataUri) : ''
}

/** 读取 config.json 的 personas.enabled 映射（不存在则空）。 */
function enabledMap(): Record<string, boolean> {
  const personas = getConfig().personas
  const enabled = (personas as { enabled?: unknown })?.enabled
  if (enabled && typeof enabled === 'object') return enabled as Record<string, boolean>
  return {}
}

function writeEnabledMap(map: Record<string, boolean>): void {
  const personas = getConfig().personas
  const base = personas && typeof personas === 'object' ? (personas as Record<string, unknown>) : {}
  setConfig({ personas: { ...base, enabled: map } })
}

/**
 * 读取 config.json 的 personas.order（手动排序的 id 列表；不存在则空）。
 * 花名册的显示顺序由用户手动决定（拖拽 / 置顶），存 id 而非 name——id 恒定，故重命名不打乱顺序
 * （对标 IM「联系人手动排序」，规避「按名称排序在改名后跳位」的问题）。
 */
function orderList(): string[] {
  const personas = getConfig().personas
  const order = (personas as { order?: unknown })?.order
  if (Array.isArray(order)) return order.filter((x): x is string => typeof x === 'string')
  return []
}

function writeOrderList(order: string[]): void {
  const personas = getConfig().personas
  const base = personas && typeof personas === 'object' ? (personas as Record<string, unknown>) : {}
  setConfig({ personas: { ...base, order } })
}

/** 校验文件名安全（防 `..` / 分隔符逃逸）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/**
 * 据显示名生成安全、唯一的文件名 id：slug + 随机后缀，**绝不复用已删角色的 id**。
 * 定时任务、对话、IM 回复范围都按 id 引用角色；若只在撞名时加序号，中文名全被 slug 成同一个 `persona`，
 * 删掉一个角色后新建就会拿回同一个 id，旧引用便悄悄指向了新角色。
 */
function makeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'persona'
  let id: string
  do {
    id = `${base}-${randomBytes(4).toString('hex')}`
  } while (existsSync(personaFile(id)))
  return id
}

function parsePersona(id: string, raw: string, enabled: boolean, withImage: boolean): PersonaRecord {
  const { data, body } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || id
  return {
    id,
    name,
    description: fmString(data, 'description'),
    avatar: fmString(data, 'avatar'),
    avatarImage: withImage ? readAvatarImage(id) : '',
    model: fmString(data, 'model'),
    prompt: body.trim(),
    enabled
  }
}

/**
 * 列出所有 persona（扫描 personas 目录下每个 `<id>.md`）。解析失败的文件跳过，绝不抛错。
 * `withImages` 仅 IPC 出口传 true（见 avatarImage 字段注释）。
 */
export function listPersonas(withImages = false): PersonaRecord[] {
  const dir = personasDir()
  if (!existsSync(dir)) return []
  const map = enabledMap()
  const out: PersonaRecord[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const id = entry.slice(0, -3)
    if (!isSafeId(id)) continue
    try {
      const raw = readFileSync(personaFile(id), 'utf8')
      out.push(parsePersona(id, raw, map[id] === true, withImages))
    } catch {
      /* 读失败 → 跳过该文件 */
    }
  }
  // 手动排序：order 中出现的 id 按其位置在前（用户拖拽/置顶的结果）；未列出的（新角色）排在其后，
  // 并按名称本地化排序保证确定性。order 中已不存在的陈旧 id 自然被忽略（rank 命中但无对应记录）。
  const order = orderList()
  const rank = new Map(order.map((id, i) => [id, i]))
  out.sort((a, b) => {
    const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return a.name.localeCompare(b.name)
  })
  return out
}

/** 读一条 persona；`withImage` 仅 IPC 出口传 true（见 avatarImage 字段注释）。 */
export function getPersona(id: string, withImage = false): PersonaRecord | null {
  if (!isSafeId(id)) return null
  try {
    const raw = readFileSync(personaFile(id), 'utf8')
    return parsePersona(id, raw, enabledMap()[id] === true, withImage)
  } catch {
    return null
  }
}

/**
 * 对话归属的角色 id：未绑定、或绑定的角色已不存在（如手动删了角色文件）时回落默认角色。
 * 只在读取时换算，不改写对话里存的 personaId（绑定一次性、绝不覆盖）。渲染层的对话列表按同一规则显示。
 */
export function resolvePersonaId(id: string | undefined): string {
  return id && isSafeId(id) && existsSync(personaFile(id)) ? id : DEFAULT_PERSONA_ID
}

/** 组装 persona.md 文本（frontmatter + 正文）。 */
function composePersonaMd(input: {
  name: string
  description: string
  avatar: string
  model: string
  prompt: string
}): string {
  const lines = ['---', `name: ${fmScalar(input.name)}`]
  if (input.description) lines.push(`description: ${fmScalar(input.description)}`)
  // avatar 为 JSON 字符串（含引号/大括号），必须经 fmScalar 引号化 + 转义，方能安全存进 YAML 单行。
  if (input.avatar) lines.push(`avatar: ${fmScalar(input.avatar)}`)
  if (input.model) lines.push(`model: ${fmScalar(input.model)}`)
  lines.push('---', '', input.prompt.trim(), '')
  return lines.join('\n')
}

/** 新建或覆盖一条 persona，返回最终记录。 */
export function upsertPersona(input: PersonaUpsertInput): PersonaRecord {
  const name = (input.name || '').trim() || '未命名提示词'
  let id = input.id && isSafeId(input.id) ? input.id : ''
  const isNew = !id
  if (!id) id = makeId(name)

  const md = composePersonaMd({
    name,
    description: (input.description ?? '').trim(),
    avatar: (input.avatar ?? '').trim(),
    model: (input.model ?? '').trim(),
    prompt: input.prompt ?? ''
  })

  try {
    mkdirSync(personasDir(), { recursive: true })
    writeFileSync(personaFile(id), md, 'utf8')
  } catch {
    /* 写失败：返回内存态记录，UI 仍可用（下次可重试） */
  }

  // 启用态：新建默认关；显式传入则以传入为准。
  if (typeof input.enabled === 'boolean') setPersonaEnabled(id, input.enabled)
  else if (isNew) setPersonaEnabled(id, false)

  // 带图返回：渲染层用它整项替换列表，少了图会把已存头像「擦掉」到下次 refresh 才回来。
  return (
    getPersona(id, true) ?? {
      id,
      name,
      description: (input.description ?? '').trim(),
      avatar: (input.avatar ?? '').trim(),
      avatarImage: readAvatarImage(id),
      model: (input.model ?? '').trim(),
      prompt: input.prompt ?? '',
      enabled: input.enabled === true
    }
  )
}

/** 技能 / MCP 的可用角色里剔除 keep 不认的角色；指定的角色都没了的项改回所有角色并停用（MCP 随之断开）。 */
function pruneExtRoles(keep: (personaId: string) => boolean): void {
  const orphaned = pruneRoles(keep)
  for (const id of orphaned.skills) setSkillEnabled(id, false)
  for (const id of orphaned.mcp) setMcpEnabled(id, false)
}

/** 启动时清理：可用角色里已不存在的角色（手改配置、旧版本留下的）一并按删除角色处理。 */
export function pruneOrphanExtRoles(): void {
  const ids = new Set(listPersonas().map((p) => p.id))
  // 种子之后至少有默认角色：读出空表多半是角色目录读失败，这时清理会把所有指定了角色的项都停掉，宁可跳过。
  if (!ids.size) return
  pruneExtRoles((p) => ids.has(p))
}

export function deletePersona(id: string): void {
  if (!isSafeId(id)) return
  try {
    rmSync(personaFile(id), { force: true })
  } catch {
    /* 忽略删除失败 */
  }
  // 连自定义头像一起删：不留孤儿文件（旧版 makeId 会复用已删角色的 id，遗留的图曾挂到新角色脸上）。
  clearAvatarImage(id)
  // 绑定该角色的定时任务改由默认角色 Deva 执行（连同其独占对话），任务照常运行。
  reassignTaskPersona(id, DEFAULT_PERSONA_ID)
  // 从技能 / MCP 的可用角色里剔除；只给它用的那些改回所有角色并停用。
  pruneExtRoles((p) => p !== id)
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    writeEnabledMap(map)
  }
  // 一并从手动排序中剔除，避免留下陈旧 id（listPersonas 会忽略，但保持 config 整洁）。
  const order = orderList()
  if (order.includes(id)) writeOrderList(order.filter((x) => x !== id))
}

/**
 * 覆盖手动排序：以传入 id 列表为准（去重、过滤非法 id）。花名册整表重排（拖拽落定 / 置顶）走此路径。
 * 只记录顺序，不校验角色是否仍存在——陈旧项对 listPersonas 无害（见其排序注释）。
 */
export function reorderPersonas(ids: string[]): void {
  if (!Array.isArray(ids)) return
  const seen = new Set<string>()
  const clean: string[] = []
  for (const id of ids) {
    if (typeof id === 'string' && isSafeId(id) && !seen.has(id)) {
      seen.add(id)
      clean.push(id)
    }
  }
  writeOrderList(clean)
}

export function setPersonaEnabled(id: string, enabled: boolean): void {
  if (!isSafeId(id)) return
  const map = enabledMap()
  map[id] = enabled === true
  writeEnabledMap(map)
}

/**
 * 首启种子：逐条种入 `DEFAULT_PERSONAS`（默认角色，见 default-personas.ts），对话优先外壳的默认身份。
 *
 * 幂等 + 防复活 + 可增量补种：用 config.json 的 `personas.seeded[id]` **按 id** 记录已种入者，独立于
 * 文件是否存在——
 *  - 已种过（或用户之后删掉）→ 不再种、不复活；
 *  - 将来往 `DEFAULT_PERSONAS` 新增一条 → 下次启动只补种这条新的，老角色不动。
 *
 *
 * 提示词跟随新版：`personas.seededPrompt[id]` 记下最近一次种入 / 更新写进去的默认提示词哈希（基线）。
 * 默认提示词变了且磁盘上的仍等于基线（用户没改过）→ 换成新版；用户改过 → 保留其版本。只看提示词，
 * 名称、头像等其余字段用户常改，不参与比对也不被覆盖。
 *
 * 迁移：历史用户的旧守卫位 `personas.seededGeneral === true` 一次性并入 `seeded.general = true`
 * 并删除旧键，保持 config 整洁。
 */
export function ensureSeededPersonas(): void {
  const personas = getConfig().personas
  const base = personas && typeof personas === 'object' ? (personas as Record<string, unknown>) : {}

  const seeded: Record<string, boolean> =
    base.seeded && typeof base.seeded === 'object'
      ? { ...(base.seeded as Record<string, boolean>) }
      : {}
  const seededPrompt: Record<string, string> =
    base.seededPrompt && typeof base.seededPrompt === 'object'
      ? { ...(base.seededPrompt as Record<string, string>) }
      : {}
  const hadLegacyGuard = base.seededGeneral === true
  if (hadLegacyGuard) seeded.general = true // 旧守卫位 → 视 general 已种入（不再重种 / 不改现有显示名）

  let changed = false
  for (const def of DEFAULT_PERSONAS) {
    const target = promptHash(def.prompt)
    if (seeded[def.id] === true) {
      // 已种过（或被用户删除）→ 绝不复活；只在默认提示词有新版时尝试跟随。
      if (seededPrompt[def.id] === target) continue
      if (refreshDefaultPrompt(def, seededPrompt[def.id], target)) {
        seededPrompt[def.id] = target
        changed = true
      }
      continue
    }
    upsertPersona({
      id: def.id,
      name: def.name,
      description: def.description,
      // avatar 省略 → 由 id 确定性生成一枚稳定 Humation 头像（用户可在编辑器改）。
      avatar: def.avatar ?? '',
      model: def.model ?? '',
      prompt: def.prompt,
      enabled: def.enabled
    })
    seeded[def.id] = true
    seededPrompt[def.id] = target
    changed = true
  }

  // 无新增 / 更新且无遗留旧守卫位需清理 → 不必落盘。
  if (!changed && !hadLegacyGuard) return

  // 置守卫位：读-合并，保住 upsert 刚写入的 enabled 映射（R3：setConfig 顶层浅合并，别清空子对象）。
  const after = getConfig().personas
  const merged = after && typeof after === 'object' ? (after as Record<string, unknown>) : {}
  delete merged.seededGeneral // 迁移后去掉历史键（已并入 seeded）
  setConfig({ personas: { ...merged, seeded, seededPrompt } })
}

/** 提示词指纹：统一换行、去首尾空白后取 sha256（落盘时正文本就 trim 过，读回来可直接比）。 */
function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/**
 * 让已种入的默认角色跟随新版默认提示词；返回 true 表示磁盘上已是新版（调用方据此记为新基线）。
 * 「用户没改过」= 磁盘上的提示词等于基线；本机制之前种入的老安装没有基线，改比对历史默认版本
 * （`LEGACY_PROMPT_HASHES`）。只替换正文，frontmatter 原样保留；角色已被删或提示词被改过 → 不动。
 */
function refreshDefaultPrompt(
  def: DefaultPersona,
  baseline: string | undefined,
  target: string
): boolean {
  const cur = getPersona(def.id)
  if (!cur) return false
  const curHash = promptHash(cur.prompt)
  if (curHash === target) return true
  const untouched = baseline
    ? curHash === baseline
    : (LEGACY_PROMPT_HASHES[def.id] ?? []).includes(curHash)
  if (!untouched) return false
  try {
    writeFileSync(personaFile(def.id), composePersonaMd({ ...cur, prompt: def.prompt }), 'utf8')
    return true
  } catch {
    return false // 写失败：不记基线，下次启动再试
  }
}

/** Agent 提示词读写 IPC（全局；启用态入 config.json）。 */
export function registerPersonasIpc(): void {
  ipcMain.handle('personas:list', (): PersonaRecord[] => listPersonas(true))
  ipcMain.handle('personas:get', (_e, id: string): PersonaRecord | null => getPersona(id, true))
  ipcMain.handle('personas:upsert', (_e, input: PersonaUpsertInput): PersonaRecord =>
    upsertPersona(input)
  )
  ipcMain.handle('personas:remove', (_e, id: string): { ok: true } => {
    deletePersona(id)
    return { ok: true }
  })
  ipcMain.handle('personas:set-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setPersonaEnabled(id, Boolean(enabled))
    return { ok: true }
  })
  ipcMain.handle('personas:reorder', (_e, ids: string[]): { ok: true } => {
    reorderPersonas(Array.isArray(ids) ? ids : [])
    return { ok: true }
  })
  // 自定义头像：与 upsert 分开，因为它不入 frontmatter，且新建角色要等 upsert 返回 id 后才能落图。
  ipcMain.handle('personas:set-avatar-image', (_e, id: string, dataUri: string): string =>
    writeAvatarImage(String(id ?? ''), String(dataUri ?? ''))
  )
  ipcMain.handle('personas:clear-avatar-image', (_e, id: string): { ok: true } => {
    clearAvatarImage(String(id ?? ''))
    return { ok: true }
  })
}
