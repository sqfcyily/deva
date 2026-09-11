import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync
} from 'fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { unzipSync } from 'fflate'
import { getConfig, getDevaHome, setConfig } from './config'
import { fmArray, fmScalar, fmString, parseFrontmatter } from './frontmatter'

/**
 * 技能（Skills）服务：发现 / 解析 / 读写 `~/.deva/skills/<id>/SKILL.md`（全局，与项目无关）。
 *
 * 设计（对标 Claude Code 的渐进式披露）：
 * - **身份 = 文件夹名（id），显示名 = frontmatter `name`**。文件夹名恒定不改（改显示名只重写 frontmatter），
 *   故重命名不触发目录搬迁，UI 的「id 稳定 / name 可编辑」模型天然成立。
 * - 启用态**不入 SKILL.md**（避免手改正文时误触），集中存 `config.json` 的 `skills.enabled[id]`，默认关。
 * - `SKILL.md` = frontmatter（name/description/trigger/allowed-tools）+ 正文（instructions，即完整操作指令）。
 *
 * 运行期（chat.ts 同进程直接调用，无需 IPC）：
 * - `enabledSkillSummaries()`：把「已启用」技能的 name+description 注入系统提示词（便宜的清单段）。
 * - `loadSkillInstructionsByName()`：命中 `skill` 工具或 `/name` 显式触发时，才加载完整正文。
 *
 * 安全：`~/.deva` 在 fs-guard 的敏感硬地板内，Agent 自身文件工具读不到；技能配置由**主进程直读**（符合设计）。
 * `allowed-tools` 只作**建议文本**注入，绝不触碰权限闸门（evaluate）——技能不能借此自我提权。
 */

export interface SkillRecord {
  /** 文件夹名，稳定身份（选择/启用态键）。 */
  id: string
  /** frontmatter name，显示名，`/name` 与 skill 工具据此匹配（缺省回落 id）。 */
  name: string
  description: string
  /** 触发方式说明（自由文本，仅展示/提示，不参与判定）。 */
  trigger: string
  /** 建议工具清单（frontmatter allowed-tools，仅作提示注入）。 */
  allowedTools: string[]
  /** SKILL.md 正文 = 完整操作指令。 */
  instructions: string
  enabled: boolean
  /** 来源：`builtin` = 随应用二进制内置（不落盘、不可删/编辑、恒启用）；`custom` = 用户创建/导入。 */
  source: 'builtin' | 'custom'
}

/** 导入结果（供 skills:import IPC 回传渲染层）。 */
export interface SkillImportResult {
  ok: boolean
  id?: string
  name?: string
  error?: string
}

export interface SkillUpsertInput {
  /** 有 id → 覆盖该文件夹；无 id → 新建（据 name 生成稳定文件夹名）。 */
  id?: string
  name: string
  description?: string
  trigger?: string
  allowedTools?: string[]
  instructions?: string
  /** 可选：一并设置启用态（新建默认关）。 */
  enabled?: boolean
}

/**
 * 内置元技能 `create-skill` 的正文：指导模型引导用户创建自己的技能。
 * 关键约束写进正文——**必须调 `create_skill` 工具落盘，严禁 `write_file`**（`~/.deva` 在敏感硬地板，写不进）。
 */
const CREATE_SKILL_INSTRUCTIONS = `你正在帮助用户创建一个新的**技能（Skill）**。技能是一份结构化文档（SKILL.md），描述在特定场景下应如何完成某类任务；启用后，其摘要会进入系统提示词，用户输入 \`/技能名\` 或命中场景时加载完整正文。

请按以下步骤引导用户：

1. **弄清用途**：先问清这个技能要解决什么问题、在什么场景下触发、期望的产出是什么。
2. **收集要素**（逐项与用户确认，不要臆造）：
   - \`name\`：技能名，建议英文小写加短横线（如 \`code-review\`、\`release-notes\`），\`/name\` 据此触发。
   - \`description\`：一句话说明「何时该用这个技能」，会进系统提示词，务必精准。
   - \`trigger\`：触发方式的自由文本说明（可选）。
   - \`allowed-tools\`：建议用到的工具清单（**仅提示**，不授予任何权限；每次真实工具调用照常走权限闸）。
   - \`instructions\`：完整操作步骤，用 Markdown 写，这是技能的正文与核心。
3. **复述草案**：把整理好的要素向用户复述一遍，请其确认或修改。
4. **落盘**：用户确认后，**调用 \`create_skill\` 工具**写入（参数：name、description、trigger、allowedTools、instructions）。
   - ⚠️ **严禁用 \`write_file\` 或 \`run_command\` 去写 SKILL.md**——技能目录在受保护路径下，只有 \`create_skill\` 工具能写入，且会照常弹出权限确认。
5. **告知结果**：创建成功后技能会**自动启用**，告诉用户可以用 \`/技能名\` 触发它，也可在「扩展」页查看。

保持简洁友好，一次问清关键信息即可，不要连环追问。`

/** 内置、不可删、恒启用的元技能，合成在代码里（永不落盘）。随 listSkills() 自动进系统提示词与 /create-skill。 */
const BUILTIN_CREATE_SKILL: SkillRecord = {
  id: 'create-skill',
  name: 'create-skill',
  description: '引导用户从零创建一个新技能：厘清用途、收集要素、确认后调 create_skill 工具落盘并启用。',
  trigger: '输入 /create-skill，或表达「帮我做/创建一个技能」时触发。',
  allowedTools: ['create_skill'],
  instructions: CREATE_SKILL_INSTRUCTIONS,
  enabled: true,
  source: 'builtin'
}

/** 保留 id：不可被磁盘技能占用（防同名目录影子），upsert/import 生成 id 时亦回避。 */
const RESERVED_IDS = new Set<string>(['create-skill'])

// 导入限额（防 zip 炸弹）：总解压体积 / 文件数 / 单文件体积上限。
const IMPORT_MAX_TOTAL_BYTES = 20 * 1024 * 1024
const IMPORT_MAX_FILES = 200
const IMPORT_MAX_SINGLE_BYTES = 10 * 1024 * 1024

function skillsDir(): string {
  return join(getDevaHome(), 'skills')
}

function skillFile(id: string): string {
  return join(skillsDir(), id, 'SKILL.md')
}

/** 读取 config.json 的 skills.enabled 映射（不存在则空）。 */
function enabledMap(): Record<string, boolean> {
  const skills = getConfig().skills
  const enabled = (skills as { enabled?: unknown })?.enabled
  if (enabled && typeof enabled === 'object') return enabled as Record<string, boolean>
  return {}
}

function writeEnabledMap(map: Record<string, boolean>): void {
  const skills = getConfig().skills
  const base = skills && typeof skills === 'object' ? (skills as Record<string, unknown>) : {}
  setConfig({ skills: { ...base, enabled: map } })
}

/** 校验文件夹名安全（防 `..` / 分隔符逃逸）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 据显示名生成安全、唯一的文件夹 id。 */
function makeId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const base = slug || 'skill'
  let id = base
  let n = 2
  // 回避已存在目录与保留 id（防用户以「create skill」等撞内置身份）。
  while (existsSync(join(skillsDir(), id)) || RESERVED_IDS.has(id)) {
    id = `${base}-${n++}`
  }
  return id
}

function parseSkill(id: string, raw: string, enabled: boolean): SkillRecord {
  const { data, body } = parseFrontmatter(raw)
  const name = fmString(data, 'name') || id
  return {
    id,
    name,
    description: fmString(data, 'description'),
    trigger: fmString(data, 'trigger'),
    allowedTools: fmArray(data, 'allowed-tools'),
    instructions: body.trim(),
    enabled,
    source: 'custom'
  }
}

/** 列出所有技能（扫描 skills 目录下每个含 SKILL.md 的子目录）。解析失败的目录跳过，绝不抛错。 */
export function listSkills(): SkillRecord[] {
  const dir = skillsDir()
  if (!existsSync(dir)) return []
  const map = enabledMap()
  const out: SkillRecord[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const id of entries) {
    if (!isSafeId(id)) continue
    if (RESERVED_IDS.has(id)) continue // 磁盘同名目录不得影子内置技能
    const file = skillFile(id)
    try {
      if (!statSync(join(dir, id)).isDirectory()) continue
      const raw = readFileSync(file, 'utf8')
      out.push(parseSkill(id, raw, map[id] === true))
    } catch {
      /* 无 SKILL.md / 读失败 → 跳过该目录 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  // 内置置顶：随本列表自动流经 systemPrompt 注入 / skill 工具 / /create-skill 加载。
  return [BUILTIN_CREATE_SKILL, ...out]
}

export function getSkill(id: string): SkillRecord | null {
  if (RESERVED_IDS.has(id)) return BUILTIN_CREATE_SKILL
  if (!isSafeId(id)) return null
  try {
    const raw = readFileSync(skillFile(id), 'utf8')
    return parseSkill(id, raw, enabledMap()[id] === true)
  } catch {
    return null
  }
}

/** 组装 SKILL.md 文本（frontmatter + 正文）。 */
function composeSkillMd(input: {
  name: string
  description: string
  trigger: string
  allowedTools: string[]
  instructions: string
}): string {
  const lines = ['---', `name: ${fmScalar(input.name)}`]
  if (input.description) lines.push(`description: ${fmScalar(input.description)}`)
  if (input.trigger) lines.push(`trigger: ${fmScalar(input.trigger)}`)
  if (input.allowedTools.length)
    lines.push(`allowed-tools: [${input.allowedTools.map(fmScalar).join(', ')}]`)
  lines.push('---', '', input.instructions.trim(), '')
  return lines.join('\n')
}

/** 新建或覆盖一个技能，返回最终记录。 */
export function upsertSkill(input: SkillUpsertInput): SkillRecord {
  // 内置身份不可被覆盖：命中保留 id 直接返回内置常量。
  if (input.id && RESERVED_IDS.has(input.id)) return BUILTIN_CREATE_SKILL
  const name = (input.name || '').trim() || '未命名技能'
  let id = input.id && isSafeId(input.id) ? input.id : ''
  const isNew = !id
  if (!id) id = makeId(name)

  const md = composeSkillMd({
    name,
    description: (input.description ?? '').trim(),
    trigger: (input.trigger ?? '').trim(),
    allowedTools: (input.allowedTools ?? []).filter((t) => typeof t === 'string' && t.trim()),
    instructions: input.instructions ?? ''
  })

  const folder = join(skillsDir(), id)
  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(skillFile(id), md, 'utf8')
  } catch {
    /* 写失败：返回内存态记录，UI 仍可用（下次可重试） */
  }

  // 启用态：新建默认关；显式传入则以传入为准。
  if (typeof input.enabled === 'boolean') setSkillEnabled(id, input.enabled)
  else if (isNew) setSkillEnabled(id, false)

  return getSkill(id) ?? {
    id,
    name,
    description: (input.description ?? '').trim(),
    trigger: (input.trigger ?? '').trim(),
    allowedTools: input.allowedTools ?? [],
    instructions: input.instructions ?? '',
    enabled: input.enabled === true,
    source: 'custom'
  }
}

export function deleteSkill(id: string): void {
  if (RESERVED_IDS.has(id)) return // 内置不可删
  if (!isSafeId(id)) return
  try {
    rmSync(join(skillsDir(), id), { recursive: true, force: true })
  } catch {
    /* 忽略删除失败 */
  }
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    writeEnabledMap(map)
  }
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  if (RESERVED_IDS.has(id)) return // 内置恒启用，不入 enabled 映射
  if (!isSafeId(id)) return
  const map = enabledMap()
  map[id] = enabled === true
  writeEnabledMap(map)
}

// ── 运行期（chat.ts 直接调用）───────────────────────────────────────────────

/** 已启用技能的 name+description 摘要，用于系统提示词注入（渐进式披露的便宜清单）。 */
export function enabledSkillSummaries(): { name: string; description: string }[] {
  return listSkills()
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, description: s.description }))
}

/** 是否存在已启用技能（决定是否向模型提供 skill 工具）。 */
export function hasEnabledSkills(): boolean {
  return listSkills().some((s) => s.enabled)
}

/**
 * 按显示名（大小写不敏感）加载**已启用**技能的完整正文。
 * 供 `skill` 工具与 `/name` 显式触发；未命中返回 null。
 */
export function loadSkillInstructionsByName(
  name: string
): { name: string; instructions: string } | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  for (const s of listSkills()) {
    if (!s.enabled) continue
    if (s.name.toLowerCase() === wanted || s.id.toLowerCase() === wanted) {
      return { name: s.name, instructions: s.instructions }
    }
  }
  return null
}

// ── 导入（上传 .zip / .md 创建技能）─────────────────────────────────────────

/**
 * 校验并落盘一个导入的技能：frontmatter 必须含 `name`；写入 `~/.deva/skills/<id>/SKILL.md`
 * 及（可选）已过守卫的附带文件；成功后**自动启用**。附带文件仅原样保留，运行期只注入 SKILL.md 正文。
 */
function writeImportedSkill(
  rawMd: string,
  extra: { path: string; data: Uint8Array }[]
): SkillImportResult {
  const { data } = parseFrontmatter(rawMd)
  const name = fmString(data, 'name').trim()
  if (!name) return { ok: false, error: 'missing-name' }

  const id = makeId(name)
  const folder = resolve(join(skillsDir(), id))
  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), rawMd, 'utf8')
    for (const f of extra) {
      const target = resolve(folder, f.path)
      // 纵深防御：断言落在技能目录内（逐段守卫之外再验一次）。
      if (target !== folder && !target.startsWith(folder + sep)) continue
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, f.data)
    }
  } catch {
    return { ok: false, error: 'write-failed' }
  }

  setSkillEnabled(id, true) // 自动启用
  return { ok: true, id, name }
}

/** 从 .zip 技能包导入：定位 SKILL.md（根或唯一顶层目录）+ zip-slip 守卫 + 三重限额。 */
function importZipSkill(filePath: string): SkillImportResult {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(readFileSync(filePath))
  } catch {
    return { ok: false, error: 'bad-zip' }
  }

  const entryPaths = Object.keys(files).filter(
    (p) => !p.endsWith('/') && !p.startsWith('__MACOSX/')
  )

  // 定位 SKILL.md：优先根目录，否则恰好一个顶层目录下。
  let base = ''
  if (!entryPaths.includes('SKILL.md')) {
    const depth1 = entryPaths.filter((p) => /^[^/]+\/SKILL\.md$/.test(p))
    if (depth1.length === 1) base = depth1[0].slice(0, depth1[0].length - 'SKILL.md'.length)
    else return { ok: false, error: 'no-skill-md' }
  }

  const skillMdPath = `${base}SKILL.md`
  const skillMdBytes = files[skillMdPath]
  if (!skillMdBytes) return { ok: false, error: 'no-skill-md' }
  const rawMd = Buffer.from(skillMdBytes).toString('utf8')

  const underBase = entryPaths.filter((p) => (base ? p.startsWith(base) : true))
  const extra: { path: string; data: Uint8Array }[] = []
  let count = 1 // 含 SKILL.md
  let totalBytes = skillMdBytes.length
  if (skillMdBytes.length > IMPORT_MAX_SINGLE_BYTES) return { ok: false, error: 'too-large' }

  for (const p of underBase) {
    if (p === skillMdPath) continue
    const rel = base ? p.slice(base.length) : p
    const segs = rel.split('/')
    // 逐段 zip-slip 守卫：拒绝空段 / `.` / `..` / 含分隔符或盘符 / 绝对路径。
    if (
      isAbsolute(rel) ||
      segs.some((s) => s === '' || s === '.' || s === '..' || /[\\:\0]/.test(s))
    ) {
      return { ok: false, error: 'unsafe-path' }
    }
    const bytes = files[p]
    count += 1
    if (count > IMPORT_MAX_FILES) return { ok: false, error: 'too-many-files' }
    if (bytes.length > IMPORT_MAX_SINGLE_BYTES) return { ok: false, error: 'too-large' }
    totalBytes += bytes.length
    if (totalBytes > IMPORT_MAX_TOTAL_BYTES) return { ok: false, error: 'too-large' }
    extra.push({ path: rel, data: bytes })
  }

  return writeImportedSkill(rawMd, extra)
}

/**
 * 导入一个技能文件：`.md`（单个 SKILL.md）或 `.zip`（技能包）。
 * 失败返回 `{ ok:false, error }`（error 为稳定错误码，渲染层据此本地化），绝不抛出。
 */
export function importSkillFromFile(filePath: string): SkillImportResult {
  try {
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.md')) {
      const raw = readFileSync(filePath, 'utf8')
      return writeImportedSkill(raw, [])
    }
    if (lower.endsWith('.zip')) return importZipSkill(filePath)
    return { ok: false, error: 'unsupported-type' }
  } catch {
    return { ok: false, error: 'import-failed' }
  }
}

/** 技能读写 IPC（全局；启用态入 config.json）。 */
export function registerSkillsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('skills:list', (): SkillRecord[] => listSkills())
  ipcMain.handle('skills:get', (_e, id: string): SkillRecord | null => getSkill(id))
  ipcMain.handle('skills:remove', (_e, id: string): { ok: true } => {
    deleteSkill(id)
    return { ok: true }
  })
  ipcMain.handle('skills:set-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setSkillEnabled(id, Boolean(enabled))
    return { ok: true }
  })
  // 上传导入：原生对话框选文件（模态） → importSkillFromFile。取消返回 { ok:false, error:'cancelled' }。
  ipcMain.handle('skills:import', async (): Promise<SkillImportResult> => {
    const win = getWindow()
    const opts = {
      properties: ['openFile' as const],
      filters: [
        { name: '技能包', extensions: ['zip', 'md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return { ok: false, error: 'cancelled' }
    return importSkillFromFile(res.filePaths[0])
  })
}
