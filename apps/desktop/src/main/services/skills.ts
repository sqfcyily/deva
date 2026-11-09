import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  watch,
  type FSWatcher
} from 'fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'
import { unzipSync } from 'fflate'
import { getConfig, getDevaHome, setConfig } from './config'
import { allowsPersona, getRoles, setRoles } from './ext-roles'
import { fmArray, fmMap, fmScalar, fmString, parseFrontmatter } from './frontmatter'

/**
 * 技能（Skills）服务：发现 / 解析 / 读写 `~/.deva/skills/<id>/SKILL.md`（全局，与项目无关）。
 *
 * 设计（对标 Claude Code 的渐进式披露）：
 * - **身份 = 文件夹名（id），显示名 = frontmatter `name`**。文件夹名恒定不改（改显示名只重写 frontmatter），
 *   故重命名不触发目录搬迁，UI 的「id 稳定 / name 可编辑」模型天然成立。
 * - 启用态**不入 SKILL.md**（避免手改正文时误触），集中存 `config.json` 的 `skills.enabled[id]`。
 *   **映射里没有即启用**（`!== false`）：模型用 write_file / 解压直接落盘的技能文件夹无需再开一道开关；
 *   只有用户在「扩展」页关掉的才显式存 `false` 并保持关闭。
 * - `SKILL.md` = frontmatter（name/description/trigger/allowed-tools）+ 正文（instructions，即完整操作指令）。
 *
 * 运行期（chat.ts 同进程直接调用，无需 IPC）：
 * - `enabledSkillSummaries()`：把「已启用」技能的 name+description 注入系统提示词（便宜的清单段）。
 * - `loadSkillInstructionsByName()`：命中 `skill` 工具或 `/name` 显式触发时，才加载完整正文。
 * - 两者都按对话绑定的角色过滤：技能可设为只给指定角色用（可用角色存 config.json，见 ext-roles.ts）。
 *
 * 文件读写不设路径限制：技能目录可被 read_file / write_file / 命令直接读写（多文件技能的子文档按需
 * read_file，安装可下载解压到技能目录）。技能目录有监听（`startSkillsWatcher`），渲染层的技能清单随之实时更新。
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
  /** 以下三项为标准 SKILL.md 的可选字段，仅供展示。 */
  license: string
  compatibility: string
  metadata: Record<string, string>
  /** SKILL.md 正文 = 完整操作指令。 */
  instructions: string
  enabled: boolean
  /** 可用角色（角色 id）；null = 全部角色。内置技能恒为 null。见 ext-roles.ts。 */
  roles: string[] | null
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
  /** 可选：一并设置启用态（新建默认开）。 */
  enabled?: boolean
}

/**
 * 内置元技能 `create-skill` 的正文：指导模型引导用户创建自己的技能。技能常常不止一个文件，
 * 故按「SKILL.md + scripts/ references/ assets/」的结构引导：先从用例规划可复用资源，再落盘、校验。
 * 单文件技能走 `create_skill`（校验 + 自动启用）；多文件技能直接写进技能目录。
 * 正文不写死目录路径：它是模块级常量，而路径依赖 DEVA_HOME——绝对路径由系统提示词【技能】段给出。
 */
const CREATE_SKILL_INSTRUCTIONS = `你正在帮助用户创建一个新的**技能（Skill）**。技能是技能目录（绝对路径见系统提示词【技能】段）下的一个文件夹：入口 \`SKILL.md\` 说明「何时用、怎么做」，复杂的技能再附带脚本、参考文档、模板等资源。启用后只有 name 与 description 常驻模型看到的技能清单；命中场景或用户输入 \`/技能名\` 时才加载 SKILL.md 正文；附带资源在执行中按需读取或运行。

## 原则

- **精简**：上下文是所有内容共用的。只写模型本身不知道的东西（流程、约定、专有知识、易错点），不解释常识；示例优于长篇说明。
- **约束程度随任务的容错度而定**：多种做法都可行时，写原则与判断要点；有推荐做法时，给伪代码或带参数的脚本；操作容易出错、必须严格按顺序执行时，写成固定脚本，少留参数。
- **渐进式披露**：SKILL.md 正文控制在 500 行以内；大段参考资料拆到 \`references/\`，并在正文里写明「什么情况下读哪个文件」；上万字的大文件再附上可供 grep 的关键词。

## 目录结构

\`\`\`
<技能名>/
├── SKILL.md       （必需）frontmatter + 正文
├── scripts/       （可选）可执行脚本：每次都要重写的代码，或要求结果确定的操作
├── references/    （可选）参考文档：接口说明、数据结构、业务规则等，执行时按需 read_file
└── assets/        （可选）产出中要用到的文件：模板、图标、示例文件等，不读进上下文
\`\`\`

只建用得上的子目录，不要建空目录；不要写 README、CHANGELOG、安装说明之类的附属文件。

## 步骤

1. **从具体用例弄清用途**：技能要解决什么问题、用户会怎么说来触发它、期望的产出是什么。用户已经说清楚就直接往下做；不清楚时一次只问一两个关键问题，能先提出一份具体的功能草案让用户修改，就不要连环追问。
2. **规划可复用资源**：逐个用例想一遍：哪些代码每次都会重写（放 \`scripts/\`），哪些资料执行时需要查阅（放 \`references/\`），哪些文件要用进产出（放 \`assets/\`）。用户手头的文档、模板等素材，请用户提供后放进对应目录。规划下来没有任何附带资源，就是单文件技能。
3. **确定名称**：只用小写字母、数字和短横线，宜用动词短语（如「Plan Mode」写成 \`plan-mode\`）；文件夹名与 \`name\` 一致。先用 list_dir 查看技能目录，避开已有的文件夹和内置技能名（create-skill、create-agent、create-mcp）。
4. **落盘**：不必先向用户复述草案、等待确认，按技能形态二选一直接写入：
   - **单文件技能**：调用 \`create_skill\` 工具（参数：name、description、trigger、allowedTools、instructions）。
   - **多文件技能**：在技能目录下建 \`<技能名>/\`，先用 write_file 写各资源文件，脚本写完**必须用 run_command 实际运行一次**确认可用，最后写 SKILL.md。用户给了现成的压缩包或仓库时，也可以用 run_command 下载并解压到该文件夹。
   - 只在技能目录内写入，不要改配置目录里的其他文件（config.json、secrets.json 等）。
5. **校验**（多文件技能逐项检查，单文件技能由 create_skill 负责）：
   - SKILL.md 位于文件夹根目录，第一行是 \`---\`，frontmatter 以 \`---\` 结束；
   - \`name\` 存在且与文件夹名一致；\`description\` 存在且只占一行；
   - 正文不超过 500 行，引用的每个相对路径都真实存在，没有残留的 TODO；
   - 没有多余文件。发现问题先修好，再告知用户。
6. **告知结果**：技能落盘即自动启用，下一轮对话起进入技能清单。向用户列出 description 原文（它决定技能何时被调用）和文件清单（每个文件一句话说明），告诉用户可以用 \`/技能名\` 触发，也可以在「扩展」页查看或关闭；有不合意之处或实际用下来发现不足，再据此修改。

## SKILL.md 写法

\`\`\`
---
name: pdf-tools
description: 处理 PDF 文件：旋转、合并、拆分、提取文字。用户要编辑或转换 PDF 时使用。
trigger: （可选）触发方式的补充说明
allowed-tools: run_command, read_file
---

# PDF 工具

（一两句话说明这个技能能做什么）

## 用法

（操作步骤，用祈使句写）

## 资源

- \`scripts/rotate.py\`：旋转页面，用法 \`python <技能文件夹>/scripts/rotate.py <输入文件> <角度>\`
- \`references/forms.md\`：处理表单字段时读取
\`\`\`

- **description 决定何时触发**：只有它常驻技能清单，模型靠它判断要不要加载技能。写清做什么、什么时候用（场景、文件类型、用户的典型说法）。**必须写在一行内**，不支持 YAML 的多行写法（\`|\`、\`>\`）。
- \`trigger\`、\`allowed-tools\` 可选；\`allowed-tools\` 只是建议，不授予任何权限。
- 正文写给执行任务的模型看，用祈使句，不必重复 description。
- 引用文件写**相对技能文件夹**的路径；加载技能时会给出文件夹的绝对路径，届时用 read_file 读取、用 run_command 运行。
- 脚本的输出要便于模型阅读：成功或失败信息明确，长输出截断或分页，不要输出整屏的错误堆栈。脚本语言优先选用户机器上已有的（先用 run_command 查 \`python --version\` 或 \`node -v\`），并兼顾 Windows 与 macOS。`

/** 内置、不可删、恒启用的元技能，合成在代码里（永不落盘）。随 listSkills() 自动进系统提示词与 /create-skill。 */
const BUILTIN_CREATE_SKILL: SkillRecord = {
  id: 'create-skill',
  name: 'create-skill',
  description:
    '引导用户从零创建一个新技能：从用例规划脚本、参考文档、模板等资源，落盘、校验并启用（单文件调 create_skill，多文件直接写进技能目录）。',
  trigger: '输入 /create-skill，或表达「帮我做/创建一个技能」时触发。',
  allowedTools: ['create_skill', 'list_dir', 'write_file', 'read_file', 'run_command'],
  license: '',
  compatibility: '',
  metadata: {},
  instructions: CREATE_SKILL_INSTRUCTIONS,
  enabled: true,
  roles: null,
  source: 'builtin'
}

/**
 * 内置元技能 `create-agent` 的正文：指导模型引导用户「用对话创建角色（Agent/性格身份）」。
 * 关键约束——**必须调 `propose_agent` 工具生成名片**，且该工具只提议、不落盘；用户点「接受」后才真正建角色。
 */
const CREATE_AGENT_INSTRUCTIONS = `你正在帮助用户创建一个新的**角色（Agent / 性格身份）**。角色是一个带专属系统提示词的对话身份——它决定助手的性格、语气、专长与行为准则；创建并启用后，用户可在角色列表里选它发起对话。

请按以下步骤引导用户：

1. **弄清用途（最多问一次）**：用一次 ask_user 问清这个角色是干什么的——面向什么任务/领域、期望怎样的性格与语气，名字和该做/不该做的准则可设为选填。用户的话里已说清用途和性格时不必再问。
2. **拟定要素**：据用户的回答拟定，用户没给的按用途合理补全：
   - \`name\`：角色显示名（如「代码审查员」「产品经理小美」）。
   - \`description\`：一句话专长/定位，会显示在名片与角色资料上。
   - \`prompt\`：**系统提示词**——角色的核心。用 Markdown 写清性格、语气、专长、行为准则；这决定角色「是谁、怎么说话、怎么做事」。
   - ⚠️ **不要设置 model**：你无法可靠得知可用的模型 id，留空即可（角色跟随默认模型，用户可在编辑器里自己选）。
   - ⚠️ **不要设置头像**：头像由系统按角色名自动生成，用户接受名片后可在编辑器里挑部件与配色。
3. **生成名片**：拿到回答后**直接调用 \`propose_agent\` 工具**（参数：name、description、prompt）。**不要先复述草案、也不要再用 ask_user 确认**——名片本身就是给用户确认的草案，用户可点开查看、在编辑器里微调后再接受。
   - ⚠️ 该工具**只是生成一张「角色名片」供用户确认，并不会真正创建角色**；不要用 \`create_skill\`/\`write_file\` 等去创建角色。
4. **告知结果**：调用后**不要声称角色已创建**。应告诉用户：「角色名片已生成，请点开名片查看——你还能在里面微调，满意后点『接受』即可加入角色列表。」

保持简洁友好，一次问清关键信息即可，不要连环追问。`

/** 内置、不可删、恒启用的「对话创建角色」元技能。随 listSkills() 自动进系统提示词与 /create-agent。 */
const BUILTIN_CREATE_AGENT: SkillRecord = {
  id: 'create-agent',
  name: 'create-agent',
  description: '引导用户用对话创建一个新角色：最多问一次厘清用途，随即调 propose_agent 生成名片供确认。',
  trigger: '输入 /create-agent，或表达「帮我做/创建一个角色/性格/身份」时触发。',
  allowedTools: ['propose_agent'],
  license: '',
  compatibility: '',
  metadata: {},
  instructions: CREATE_AGENT_INSTRUCTIONS,
  enabled: true,
  roles: null,
  source: 'builtin'
}

/**
 * 内置元技能 `create-mcp` 的正文：指导模型引导用户「用对话接入一个 MCP 服务」。
 * 关键约束——**必须调 `create_mcp` 工具落盘**（它负责校验配置与写密钥占位，直接写 mcp.json 会绕过这些）；
 * 且**密钥零明文**：模型只收集密钥字段的「名字」，真实值由用户稍后在「扩展」页加密填入。
 */
const CREATE_MCP_INSTRUCTIONS = `你正在帮助用户接入一个新的 **MCP 服务（Model Context Protocol server）**。MCP 服务对外暴露一组工具/资源；接入并连接后，其工具会自动出现在助手的可用工具里。

请按以下步骤引导用户：

1. **弄清用途**：先问清用户想接入哪个 MCP 服务、它提供什么能力、从哪里获取（官方文档 / npm 包名 / 服务地址）。
2. **确定传输方式**（这是关键分叉）：
   - \`stdio\`（本地子进程，最常见）：需要 \`command\`（如 \`npx\`、\`uvx\`、\`node\`）与 \`args\`（参数清单，如 \`["-y", "@modelcontextprotocol/server-filesystem", "/some/path"]\`）。
   - \`sse\` / \`http\`（远程服务）：需要 \`url\`（服务地址）。
3. **收集要素**（逐项与用户确认，不要臆造包名/命令）：
   - stdio：\`command\`、\`args\`、非敏感环境变量 \`env\`（明文键值）。
   - sse/http：\`url\`、非敏感请求头 \`headers\`（明文键值）。
   - **密钥（API Key / Token 等）**：⚠️ **绝不要向用户索要、也绝不要把真实密钥值写进工具参数或对话**。你只需问清「有哪些字段是密钥」，把这些**字段名**放进 \`secretEnv\`（环境变量名，如 \`GITHUB_TOKEN\`）或 \`secretHeaders\`（请求头名，如 \`Authorization\`）。工具只写占位符，真实值由用户稍后在「扩展」页加密填入。
4. **复述草案**：先在回复正文里完整列出整理好的要素（传输方式、命令/地址、参数、哪些字段是密钥），再用 ask_user 请用户确认或修改——问题卡片里看不到你没写出来的内容。
5. **落盘**：用户确认后，**调用 \`create_mcp\` 工具**写入。
   - ⚠️ **不要用 \`write_file\` 或 \`run_command\` 直接写 mcp.json**——\`create_mcp\` 会校验配置并写入密钥占位符，直接写会绕过这些。
6. **告知结果**：创建成功后服务会**自动启用并在后台连接**，连上后其工具从用户的**下一条消息**起可用。若存在密钥占位字段，务必提醒用户：**去「扩展」页为该服务填写这些密钥（加密存储）**，填好后会自动连接，无需其他操作。

保持简洁友好，一次问清关键信息即可，不要连环追问。`

/** 内置、不可删、恒启用的「对话接入 MCP 服务」元技能。随 listSkills() 自动进系统提示词与 /create-mcp。 */
const BUILTIN_CREATE_MCP: SkillRecord = {
  id: 'create-mcp',
  name: 'create-mcp',
  description: '引导用户用对话接入一个 MCP 服务：厘清用途与传输方式、收集要素（密钥仅收字段名）、确认后调 create_mcp 工具落盘并启用。',
  trigger: '输入 /create-mcp，或表达「帮我接入/添加/创建一个 MCP（服务）」时触发。',
  allowedTools: ['create_mcp'],
  license: '',
  compatibility: '',
  metadata: {},
  instructions: CREATE_MCP_INSTRUCTIONS,
  enabled: true,
  roles: null,
  source: 'builtin'
}

/** 内置元技能按 id 索引（generalize：不同保留 id 返回各自的内置常量，勿一律返回 create-skill）。 */
const BUILTIN_SKILLS: SkillRecord[] = [BUILTIN_CREATE_SKILL, BUILTIN_CREATE_AGENT, BUILTIN_CREATE_MCP]
const BUILTIN_BY_ID = new Map<string, SkillRecord>(BUILTIN_SKILLS.map((s) => [s.id, s]))

/** 保留 id：不可被磁盘技能占用（防同名目录影子），upsert/import 生成 id 时亦回避。 */
const RESERVED_IDS = new Set<string>(BUILTIN_BY_ID.keys())

// 导入限额（防 zip 炸弹）：总解压体积 / 文件数 / 单文件体积上限。
const IMPORT_MAX_TOTAL_BYTES = 20 * 1024 * 1024
const IMPORT_MAX_FILES = 200
const IMPORT_MAX_SINGLE_BYTES = 10 * 1024 * 1024

/**
 * 技能根目录（绝对路径）。chat.ts 把它写进系统提示词与 skill 工具结果，供模型读写多文件技能；
 * 进程内恒定（DEVA_HOME 只在启动时读取），不破坏 §4.18 的提示缓存前缀稳定性。
 */
export function skillsDir(): string {
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
    license: fmString(data, 'license'),
    compatibility: fmString(data, 'compatibility'),
    metadata: fmMap(data, 'metadata'),
    instructions: body.trim(),
    enabled,
    roles: getRoles('skills', id),
    source: 'custom'
  }
}

/** 列出所有技能（扫描 skills 目录下每个含 SKILL.md 的子目录）。解析失败的目录跳过，绝不抛错。 */
export function listSkills(): SkillRecord[] {
  const dir = skillsDir()
  // 目录尚未创建（首次运行、还没建过任何自定义技能）：内置元技能是代码合成常量、永不落盘，
  // 不依赖磁盘目录存在，故此处仍须返回它们，否则「扩展」页首启会误显空态。
  if (!existsSync(dir)) return [...BUILTIN_SKILLS]
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
      out.push(parseSkill(id, raw, map[id] !== false))
    } catch {
      /* 无 SKILL.md / 读失败 → 跳过该目录 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  // 内置置顶：随本列表自动流经 systemPrompt 注入 / skill 工具 / /create-skill、/create-agent 加载。
  return [...BUILTIN_SKILLS, ...out]
}

export function getSkill(id: string): SkillRecord | null {
  const builtin = BUILTIN_BY_ID.get(id)
  if (builtin) return builtin
  if (!isSafeId(id)) return null
  try {
    const raw = readFileSync(skillFile(id), 'utf8')
    return parseSkill(id, raw, enabledMap()[id] !== false)
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
  // 内置身份不可被覆盖：命中保留 id 直接返回对应内置常量。
  if (input.id) {
    const builtin = BUILTIN_BY_ID.get(input.id)
    if (builtin) return builtin
  }
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

  // 启用态：新建默认开（与「映射里没有即启用」一致）；显式传入则以传入为准。
  if (typeof input.enabled === 'boolean') setSkillEnabled(id, input.enabled)
  else if (isNew) setSkillEnabled(id, true)

  return getSkill(id) ?? {
    id,
    name,
    description: (input.description ?? '').trim(),
    trigger: (input.trigger ?? '').trim(),
    allowedTools: input.allowedTools ?? [],
    license: '',
    compatibility: '',
    metadata: {},
    instructions: input.instructions ?? '',
    enabled: input.enabled !== false,
    roles: getRoles('skills', id),
    source: 'custom'
  }
}

/**
 * 删除技能：整个文件夹移到系统回收站（技能常带用户自己写的脚本与资料，误删可还原）。
 * 文件夹已不在（如在外部手动删掉）视为成功；移入回收站失败则不动启用态，返回 ok:false。
 */
export async function deleteSkill(id: string): Promise<{ ok: boolean }> {
  if (RESERVED_IDS.has(id)) return { ok: false } // 内置不可删
  if (!isSafeId(id)) return { ok: false }
  const folder = join(skillsDir(), id)
  if (existsSync(folder)) {
    try {
      await shell.trashItem(folder)
    } catch {
      return { ok: false }
    }
  }
  const map = enabledMap()
  if (id in map) {
    delete map[id]
    writeEnabledMap(map)
  }
  setRoles('skills', id, null)
  return { ok: true }
}

export function setSkillEnabled(id: string, enabled: boolean): void {
  if (RESERVED_IDS.has(id)) return // 内置恒启用，不入 enabled 映射
  if (!isSafeId(id)) return
  const map = enabledMap()
  map[id] = enabled === true
  writeEnabledMap(map)
}

// ── 运行期（chat.ts 直接调用）───────────────────────────────────────────────

/**
 * 内置元技能离不开的工具。对话里没有这个工具时（成员会话、定时任务、子智能体都剔除了创建类工具），该技能既不列出
 * 也不加载——不然模型看到清单会以为自己能做，加载后才发现调不了。
 */
const BUILTIN_REQUIRES: Record<string, string> = {
  'create-skill': 'create_skill',
  'create-agent': 'propose_agent',
  'create-mcp': 'create_mcp'
}

/**
 * 技能在这个角色的对话里是否可用：已启用，且可用角色含该角色（内置技能恒可用）。
 * hasTool = 本轮是否提供某个工具（省略 = 不按工具筛）：内置元技能所需的工具不在时不可用。
 */
function usableBy(s: SkillRecord, personaId: string, hasTool?: (name: string) => boolean): boolean {
  if (!s.enabled) return false
  if (s.source !== 'builtin') return allowsPersona('skills', s.id, personaId)
  const need = BUILTIN_REQUIRES[s.id]
  return !need || !hasTool || hasTool(need)
}

/** 该角色可用技能的 name+description 摘要，随消息下发给模型（渐进式披露的便宜清单）。hasTool 见 usableBy。 */
export function enabledSkillSummaries(
  personaId: string,
  hasTool?: (name: string) => boolean
): { name: string; description: string }[] {
  return listSkills()
    .filter((s) => usableBy(s, personaId, hasTool))
    .map((s) => ({ name: s.name, description: s.description }))
}

/** 是否存在已启用技能（决定是否向模型提供 skill 工具）。 */
export function hasEnabledSkills(): boolean {
  return listSkills().some((s) => s.enabled)
}

/**
 * 按显示名（大小写不敏感）加载该角色**可用**技能的完整正文（已启用且对该角色开放）。
 * 供 `skill` 工具与 `/name` 显式触发；未命中返回 null。hasTool 见 usableBy。
 * `dir` = 自定义技能的文件夹绝对路径（内置技能不落盘，无此项）：多文件技能正文里的相对路径
 * 以它为基准，调用方须一并告知模型，否则子文档无从定位。
 */
export function loadSkillInstructionsByName(
  name: string,
  personaId: string,
  hasTool?: (name: string) => boolean
): { name: string; instructions: string; allowedTools: string[]; dir?: string } | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  for (const s of listSkills()) {
    if (!usableBy(s, personaId, hasTool)) continue
    if (s.name.toLowerCase() === wanted || s.id.toLowerCase() === wanted) {
      return {
        name: s.name,
        instructions: s.instructions,
        allowedTools: s.allowedTools,
        ...(s.source === 'custom' ? { dir: join(skillsDir(), s.id) } : {})
      }
    }
  }
  return null
}

// ── 导入（上传 .zip / .md 创建技能）─────────────────────────────────────────

/**
 * 校验并落盘一个导入的技能：frontmatter 必须含 `name`；写入 `~/.deva/skills/<id>/SKILL.md`
 * 及（可选）已过守卫的附带文件；成功后**自动启用**。运行期只注入 SKILL.md 正文，附带文件由模型
 * 按需 read_file（skill 工具结果会给出文件夹绝对路径）。
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

// ── 目录监听（技能装上 / 删掉 / 改了即推送渲染层）──────────────────────────────

/** 一串文件事件（如解压技能包）合并成一次重读的防抖时长。 */
const WATCH_DEBOUNCE_MS = 300

/**
 * 只有影响技能清单的变化才重读：技能目录下一级条目增删改名，或某个 `<id>/SKILL.md` 变化。
 * 技能里的 scripts / assets 等改动不影响清单，忽略。filename 为空 = 事件缓冲溢出、细节丢失
 * （瞬间写入大量文件时会出现），只能当作有变化。
 */
function affectsList(filename: string | null): boolean {
  if (!filename) return true
  const parts = filename.split(/[\\/]/)
  return parts.length === 1 || (parts.length === 2 && parts[1].toLowerCase() === 'skill.md')
}

/**
 * 监听技能目录，技能经任何途径变化（对话 create_skill、模型下载解压、手动拷入、外部删除…）后
 * 防抖重读，向渲染层推送 `skills:changed`（全表），输入框的 / 联想与扩展页随之更新。
 * 主进程运行期（chat.ts）本来就每次现读磁盘，不依赖这里。
 *
 * - 先建好技能目录再监听，绝不退而监听上级目录（否则无关文件事件会频繁唤醒进程）。
 * - Windows / macOS：系统原生递归监听，只持有技能目录一个句柄（不妨碍把技能子文件夹移进回收站）。
 * - 其余平台（Linux）：Node 的递归监听会给每个文件各挂一个 inotify 监听，技能里带大目录时代价大；
 *   改为监听技能目录 + 各技能第一层文件夹（SKILL.md 所在层），数量 = 技能数 + 1。
 * - 监听出错即整体关闭，退回扩展页进入时重拉的兜底。
 */
export function startSkillsWatcher(getWindow: () => BrowserWindow | null): void {
  const root = skillsDir()
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    return
  }

  let timer: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      getWindow()?.webContents.send('skills:changed', listSkills())
    }, WATCH_DEBOUNCE_MS)
  }

  const watchers = new Map<string, FSWatcher>()
  const stopAll = (err: unknown): void => {
    console.warn('[skills] 技能目录监听已停止：', err)
    for (const w of watchers.values()) w.close()
    watchers.clear()
  }
  const add = (key: string, w: FSWatcher): void => {
    w.on('error', stopAll)
    watchers.set(key, w)
  }

  try {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      add(
        root,
        watch(root, { recursive: true, persistent: false }, (_e, f) => {
          if (affectsList(f)) schedule()
        })
      )
      return
    }

    // 各技能第一层文件夹的监听与磁盘对齐：新出现的补上，已消失的关掉。
    const syncChildren = (): void => {
      let names: string[] = []
      try {
        names = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && isSafeId(d.name))
          .map((d) => d.name)
      } catch {
        /* 读失败：本轮不调整 */
      }
      const live = new Set(names)
      for (const [key, w] of watchers) {
        if (key !== root && !live.has(key)) {
          w.close()
          watchers.delete(key)
        }
      }
      for (const id of names) {
        if (watchers.has(id)) continue
        try {
          add(
            id,
            watch(join(root, id), { persistent: false }, (_e, f) => {
              if (affectsList(f ? join(id, f) : null)) schedule()
            })
          )
        } catch {
          /* 文件夹刚被删：下次对齐时自然跳过 */
        }
      }
    }
    add(
      root,
      watch(root, { persistent: false }, () => {
        syncChildren()
        schedule()
      })
    )
    syncChildren()
  } catch (err) {
    stopAll(err)
  }
}

/** 技能读写 IPC（全局；启用态入 config.json）。 */
export function registerSkillsIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('skills:list', (): SkillRecord[] => listSkills())
  ipcMain.handle('skills:get', (_e, id: string): SkillRecord | null => getSkill(id))
  ipcMain.handle('skills:remove', (_e, id: string): Promise<{ ok: boolean }> => deleteSkill(id))
  ipcMain.handle('skills:set-enabled', (_e, id: string, enabled: boolean): { ok: true } => {
    setSkillEnabled(id, Boolean(enabled))
    return { ok: true }
  })
  // 可用角色：null = 全部角色。内置技能恒对全部角色开放，不接受设置。
  ipcMain.handle('skills:set-roles', (_e, id: string, roles: string[] | null): { ok: boolean } => {
    if (RESERVED_IDS.has(id) || !isSafeId(id)) return { ok: false }
    setRoles('skills', id, Array.isArray(roles) ? roles : null)
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
