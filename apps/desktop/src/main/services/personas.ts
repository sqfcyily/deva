import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getConfig, getDevaHome, setConfig } from './config'
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
  /** 头像 emoji（对话优先外壳用；旧壳忽略）。 */
  emoji: string
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
  emoji?: string
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
    emoji: fmString(data, 'emoji'),
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
  out.sort((a, b) => a.name.localeCompare(b.name))
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
  emoji: string
  color: string
  tagline: string
  model: string
  tools: string[]
  prompt: string
}): string {
  const lines = ['---', `name: ${fmScalar(input.name)}`]
  if (input.description) lines.push(`description: ${fmScalar(input.description)}`)
  if (input.emoji) lines.push(`emoji: ${fmScalar(input.emoji)}`)
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
    emoji: (input.emoji ?? '').trim(),
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
      emoji: (input.emoji ?? '').trim(),
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

/** 兜底「通用」persona 的系统提示词（附加指令，安全/工具铁律仍优先）。 */
const GENERAL_PERSONA_PROMPT =
  '你是「通用」，一位友好、务实的个人工作助手。可处理日常事务：整理文件、写作、查资料、跑命令、写代码等。回答简洁直接，动手前把关键步骤讲清楚。'

/**
 * 首启种子：确保存在 1 个「通用」persona 兜底（对话优先外壳的默认身份）。
 * 幂等 + 防复活：用 config.json 的 `personas.seededGeneral` 守卫位，独立于文件是否存在——
 * 用户之后删掉「通用」不会再生。
 */
export function ensureSeededPersonas(): void {
  const personas = getConfig().personas
  const base = personas && typeof personas === 'object' ? (personas as Record<string, unknown>) : {}
  if (base.seededGeneral === true) return

  upsertPersona({
    id: 'general',
    name: '通用',
    description: '全能通用助手',
    emoji: '🤖',
    color: '#7c7cf0',
    tagline: '有什么我能帮上忙的？',
    model: '',
    tools: [],
    prompt: GENERAL_PERSONA_PROMPT,
    enabled: true
  })

  // 置守卫位：读-合并，保住 upsert 刚写入的 enabled 映射（R3：setConfig 顶层浅合并，别清空子对象）。
  const after = getConfig().personas
  const merged = after && typeof after === 'object' ? (after as Record<string, unknown>) : {}
  setConfig({ personas: { ...merged, seededGeneral: true } })
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
}
