import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getDevaHome, setConfig } from './config'
import { DEFAULT_PERSONAS } from './default-personas'
import { fmArray, fmScalar, fmString, parseFrontmatter } from './frontmatter'

/**
 * Agent 提示词（Personas）服务：发现 / 解析 / 读写 `~/.deva/personas/<id>.md`（全局，与项目无关）。
 *
 * 定位（对标 ChatGPT「自定义指令」/ 人格 profile）：每条 persona 是一段命名的**附加系统提示词**
 * （性格、语气、行文风格、偏好等）。可多条并存、独立启停；**已启用**的会在每轮对话前**追加**进
 * 主智能体系统提示词（见 chat.ts `systemPrompt`）。与 skill/subagent 的启停模型一致（叠加，非单选）。
 *
 * 设计（照 agents.ts 裁剪，但更简单：**无 model、无 tools**）：
 * - **身份 = 文件名去扩展名（id），显示名 = frontmatter `name`**。文件名恒定不改（改显示名只重写
 *   frontmatter），故重命名不触发文件搬迁，UI 的「id 稳定 / name 可编辑」模型天然成立。
 * - 启用态**不入 .md**，集中存 `config.json` 的 `personas.enabled[id]`，默认关。
 * - `<id>.md` = frontmatter（name/description）+ 正文（prompt，即要追加的提示词）。
 *
 * 运行期（chat.ts 同进程直接调用，无需 IPC）：
 * - `enabledPersonas()`：把「已启用」persona 的 name+prompt 注入**主智能体**系统提示词（仅主轮；
 *   子智能体有自己的系统提示词，刻意不注入，避免串味）。
 *
 * 安全：`~/.deva` 在 fs-guard 的敏感硬地板内，Agent 自身文件工具读不到；persona 配置由**主进程直读**。
 * 注入时以固定前言框定为「用户自定义附加指令，在不违反安全与工具使用原则的前提下遵循」——persona
 * 绝不能借此关闭「切勿用文字征求授权」等安全/工具铁律。
 */

export interface PersonaRecord {
  /** 文件名（去 .md），稳定身份（选择/启用态键）。 */
  id: string
  /** frontmatter name，显示名（缺省回落 id）。 */
  name: string
  /** 专长，一句话（frontmatter description）。 */
  description: string
  /** 头像 spec（Humation AvatarSpec 的 JSON 字符串；空 → 由 id 确定性生成。本层只当不透明串搬运）。 */
  avatar: string
  /** 身份主题色（头像描边 / 名字色）。 */
  color: string
  /** 开场白 / 口头禅。 */
  tagline: string
  /** 偏好模型引用 `"providerId:modelId"`；空串 = 跟随主对话默认（见 model-resolve.ts）。 */
  model: string
  /** 工具白名单（内置 / MCP 名）；空数组 = 允许全部内置工具（只收窄可见性，不放宽闸门）。 */
  tools: string[]
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
  color?: string
  tagline?: string
  model?: string
  tools?: string[]
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

/** 据显示名生成安全、唯一的文件名 id。 */
function makeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'persona'
  let id = base
  let n = 2
  while (existsSync(personaFile(id))) {
    id = `${base}-${n++}`
  }
  return id
}

function parsePersona(id: string, raw: string, enabled: boolean): PersonaRecord {
  const { data, body } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || id
  return {
    id,
    name,
    description: fmString(data, 'description'),
    avatar: fmString(data, 'avatar'),
    color: fmString(data, 'color'),
    tagline: fmString(data, 'tagline'),
    model: fmString(data, 'model'),
    tools: fmArray(data, 'tools'),
    prompt: body.trim(),
    enabled
  }
}

/** 列出所有 persona（扫描 personas 目录下每个 `<id>.md`）。解析失败的文件跳过，绝不抛错。 */
export function listPersonas(): PersonaRecord[] {
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
      out.push(parsePersona(id, raw, map[id] === true))
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

export function getPersona(id: string): PersonaRecord | null {
  if (!isSafeId(id)) return null
  try {
    const raw = readFileSync(personaFile(id), 'utf8')
    return parsePersona(id, raw, enabledMap()[id] === true)
  } catch {
    return null
  }
}

/** 组装 persona.md 文本（frontmatter + 正文）。 */
function composePersonaMd(input: {
  name: string
  description: string
  avatar: string
  color: string
  tagline: string
  model: string
  tools: string[]
  prompt: string
}): string {
  const lines = ['---', `name: ${fmScalar(input.name)}`]
  if (input.description) lines.push(`description: ${fmScalar(input.description)}`)
  // avatar 为 JSON 字符串（含引号/大括号），必须经 fmScalar 引号化 + 转义，方能安全存进 YAML 单行。
  if (input.avatar) lines.push(`avatar: ${fmScalar(input.avatar)}`)
  // 颜色多为 `#rrggbb`，必须经 fmScalar 引号化，否则 `#` 被 YAML 当注释吃掉。
  if (input.color) lines.push(`color: ${fmScalar(input.color)}`)
  if (input.tagline) lines.push(`tagline: ${fmScalar(input.tagline)}`)
  if (input.model) lines.push(`model: ${fmScalar(input.model)}`)
  if (input.tools.length) lines.push(`tools: [${input.tools.map(fmScalar).join(', ')}]`)
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
    color: (input.color ?? '').trim(),
    tagline: (input.tagline ?? '').trim(),
    model: (input.model ?? '').trim(),
    tools: (input.tools ?? []).filter((t) => typeof t === 'string' && t.trim()),
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

  return (
    getPersona(id) ?? {
      id,
      name,
      description: (input.description ?? '').trim(),
      avatar: (input.avatar ?? '').trim(),
      color: (input.color ?? '').trim(),
      tagline: (input.tagline ?? '').trim(),
      model: (input.model ?? '').trim(),
      tools: input.tools ?? [],
      prompt: input.prompt ?? '',
      enabled: input.enabled === true
    }
  )
}

export function deletePersona(id: string): void {
  if (!isSafeId(id)) return
  try {
    rmSync(personaFile(id), { force: true })
  } catch {
    /* 忽略删除失败 */
  }
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

// ── 运行期（chat.ts 直接调用）───────────────────────────────────────────────

/** 已启用 persona 的 name+prompt（追加进主智能体系统提示词）；prompt 为空的条目跳过。 */
export function enabledPersonas(): { name: string; prompt: string }[] {
  return listPersonas()
    .filter((p) => p.enabled && p.prompt.trim())
    .map((p) => ({ name: p.name, prompt: p.prompt }))
}

/**
 * 首启种子：逐条种入 `DEFAULT_PERSONAS`（默认角色，见 default-personas.ts），对话优先外壳的默认身份。
 *
 * 幂等 + 防复活 + 可增量补种：用 config.json 的 `personas.seeded[id]` **按 id** 记录已种入者，独立于
 * 文件是否存在——
 *  - 已种过（或用户之后删掉）→ 不再种、不复活；
 *  - 将来往 `DEFAULT_PERSONAS` 新增一条 → 下次启动只补种这条新的，老角色不动。
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
  const hadLegacyGuard = base.seededGeneral === true
  if (hadLegacyGuard) seeded.general = true // 旧守卫位 → 视 general 已种入（不再重种 / 不改现有显示名）

  let changed = false
  for (const def of DEFAULT_PERSONAS) {
    if (seeded[def.id] === true) continue // 已种过（或被用户删除）→ 跳过，绝不复活
    upsertPersona({
      id: def.id,
      name: def.name,
      description: def.description,
      // avatar 省略 → 由 id 确定性生成一枚稳定 Humation 头像（用户可在编辑器改）。
      avatar: def.avatar ?? '',
      color: def.color,
      tagline: def.tagline,
      model: def.model ?? '',
      tools: def.tools ?? [],
      prompt: def.prompt,
      enabled: def.enabled
    })
    seeded[def.id] = true
    changed = true
  }

  // 无新增且无遗留旧守卫位需清理 → 不必落盘。
  if (!changed && !hadLegacyGuard) return

  // 置守卫位：读-合并，保住 upsert 刚写入的 enabled 映射（R3：setConfig 顶层浅合并，别清空子对象）。
  const after = getConfig().personas
  const merged = after && typeof after === 'object' ? (after as Record<string, unknown>) : {}
  delete merged.seededGeneral // 迁移后去掉历史键（已并入 seeded）
  setConfig({ personas: { ...merged, seeded } })
}

/** Agent 提示词读写 IPC（全局；启用态入 config.json）。 */
export function registerPersonasIpc(): void {
  ipcMain.handle('personas:list', (): PersonaRecord[] => listPersonas())
  ipcMain.handle('personas:get', (_e, id: string): PersonaRecord | null => getPersona(id))
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
}
