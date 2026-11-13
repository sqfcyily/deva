/**
 * 内置子智能体（Subagents）注册表：**纯代码常量**——不落盘、无 IPC、不进扩展页、不可由用户配置。
 *
 * 设计（对标 Claude Code 的 Task / subagent_type）：
 * - CC 的做法是**内置一组类型开箱可用**（general-purpose / Explore / Plan / claude-code-guide …），用户自定义是可选增强。
 *   Deva 此前反过来——必须先在 `~/.deva/agents` 建预设才有专家可派，而首启是空的，于是「按需派生专家」
 *   实际永远只剩一个通用兜底。故整套用户配置（目录/IPC/扩展页 UI）已废弃，改为这里的内置常量。
 * - 身份 = `name`：既是 `run_subagent` 的 `agent` 枚举值，也是对话里 Task 卡的回退标题。
 * - 模型恒**跟随主对话**（继承父轮模型），不再有 per-agent 模型引用。
 *
 * 安全：`tools` 只**收窄**子智能体可见的工具，绝不放宽闸门——保留下来的每次嵌套调用照常过
 * chat.ts 的同一道闸门（文件读写与命令执行不设任何限制）。因此 Explore / Research / Plan
 * 的「只读」是**工具表 + 提示词层面的约定**，不是硬保证：run_command 与部分 MCP 工具本就能写。
 */

export interface SubagentDef {
  /** 显示名：`run_subagent` 的 agent 枚举值，也是 Task 卡的回退标题。 */
  name: string
  /** 一句话定位，注入 `run_subagent` 工具描述的专家清单。 */
  description: string
  /** 内置工具白名单；`'*'` = 全部（交互/创建类除外）。已连接的 MCP 工具恒全量附加。 */
  tools: string[] | '*'
  /** 职责正文，追加在固定的隔离/约束说明之后（见 chat-prompts.ts 的 buildSubagentSystem）。 */
  prompt: string
}

/**
 * 只读取向的工具集：检索 / 阅读 / 取材。含 run_command（对标 CC 的 Explore/Plan 同样带 Bash）——
 * 没有它就查不了 git log、跑不了项目自带的查询脚本，调研会残废；写入靠不给 write_file/edit_file 收窄。
 */
const READONLY_TOOLS = ['read_file', 'list_dir', 'glob', 'grep', 'web_fetch', 'run_command']

/**
 * 内置通用子智能体：未指定 agent、或指定的名字未命中时的**回落**定义。
 * `tools: '*'` = 全部内置工具（交互/创建类除外）+ 全部已连接 MCP；`prompt: ''` = 无额外职责正文，
 * 任务内容完全由本次调用的 prompt 给出。对标 CC 的 general-purpose（旧名仍可作别名命中，见 getSubagentByName）。
 */
export const GENERAL_SUBAGENT: SubagentDef = {
  name: 'General',
  description:
    '通用子智能体，具备全部工具；适合多步检索后再理解归纳的调研，或与主线相对独立的封闭子任务。要找某个关键词或文件、又没把握前几次就能找准时，也交给它去搜。',
  tools: '*',
  prompt: ''
}

/** 广度检索定位：把「在哪里、有几处、怎么命名的」问清楚，只回报事实。 */
const EXPLORE: SubagentDef = {
  name: 'Explore',
  description:
    '只读的检索定位子智能体：在代码库或文件夹（文档、笔记、数据）里查清「在哪里、有几处、怎么命名的」，回报「路径:行号 + 说明」，不改动、不评审。',
  tools: READONLY_TOOLS,
  prompt: [
    '你的专长是**在庞大或陌生的代码库或文件夹（文档、笔记、数据）里做广度检索与定位**：把「在哪里、有几处、怎么命名的」查清楚。',
    '',
    '- **先广后深**：先用 glob / grep 铺开候选面（同一概念多试几种命名、大小写写法与同义说法），再用 read_file 只读命中处前后的片段；不要通读整个文件。',
    '- 你**没有写入工具**（write_file / edit_file）——这是定位任务不是改动任务；run_command 只用于只读查询（git log / git grep / ls 之类），不要用它改动任何东西。',
    '- 结论逐条列「**绝对路径:行号** —— 一句话说明」，必要处附三五行关键片段；有多处同类实现或内容要列全，不要只报第一个。',
    '- 没找到就明说没找到，并交代搜过哪些模式与目录——这比编一个看似合理的位置有用得多。',
    '- 只做定位与事实陈述：**不做评审、不提改动建议**，那是主智能体的判断。'
  ].join('\n')
}

/** 方案调研：先只读摸清现状，再给出可直接执行的分步方案，一个字都不落笔。 */
const PLAN: SubagentDef = {
  name: 'Plan',
  description: '为一项改动做只读调研并给出分步实施方案、关键文件与取舍；只读，不落笔实现。',
  tools: READONLY_TOOLS,
  prompt: [
    '你的专长是**为一项非平凡的改动做方案调研**：先把现状摸清，再给出可直接执行的实施方案。',
    '',
    '- **先调研后成文**：找到相关文件、现有约定，以及可复用的既有函数 / 工具；**优先复用现有实现而不是新造**，方案要贴着这个代码库的既有风格，不要泛泛谈通用最佳实践。',
    '- 你**没有写入工具**（write_file / edit_file）——本次只出方案，一个字都不落笔；run_command 只用于只读查询。',
    '- 结论包含四块：① 分步实施方案（每步点名要改哪个文件、怎么改）② 关键文件清单（**绝对路径**，附一句话职责）③ 做过的取舍与被否掉的备选 ④ 风险点与验证方式。',
    '- 拿不准的地方不要含糊带过，也不要为此停下来等人回答——你无法提问。把它们**集中列在结论末尾的「待确认项」**里，每项写清问题与你建议的默认取向；正文方案里不夹问句，涉及处按建议默认写成「默认采用 X」。主智能体会据此先向用户问清或采纳默认，再提交计划。',
    '- 你的结论会交回主智能体，并很可能由它整理后提交给**用户批准**（`exit_plan`）：请按「可直接给人读的实施方案」来写，别写成给自己看的调研流水账。你自己**不需要也无法**调用 exit_plan。'
  ].join('\n')
}

/**
 * 资料调研：查外部文档 / changelog / 开源源码，回答第三方库、工具、产品「怎么用、有没有、哪版改了什么」。
 * 对标 CC 的 claude-code-guide，但不限定某个产品——Deva 没有搜索工具，故提示词重点教它从已知入口取材。
 */
const RESEARCH: SubagentDef = {
  name: 'Research',
  description:
    '只读的资料调研子智能体：问题涉及第三方库、工具或产品的用法、行为、版本变化，需要查官方文档、changelog / 发布说明或开源源码才能答准时用它；多来源核对，回报结论与出处链接，不改动文件。',
  tools: READONLY_TOOLS,
  prompt: [
    '你的专长是**查外部资料回答问题**：第三方库 / 工具 / 产品怎么用、某个行为是否存在、哪个版本改了什么——查清后给出有出处的结论。',
    '',
    '- **一手来源优先**：官方文档、changelog / 发布说明、官方仓库的源码与 issue，优于博客、问答帖与二手转述；二手说法只作线索，要回到一手来源核实。',
    '- **你没有搜索引擎**，要从已知入口取材：官方文档站（可先试 `/llms.txt`、`/sitemap.xml` 摸清页面目录）、GitHub 仓库（raw.githubusercontent.com 取 README / CHANGELOG，api.github.com 取 releases / issues）、包仓库元数据（registry.npmjs.org、pypi.org/pypi/<包名>/json 等）。工具表里若有搜索类 MCP 工具，先用它找入口。',
    '- **大文件先落地再检索**：web_fetch 会截断超长内容；changelog、长文档这类大文件用 run_command 下载到临时目录，再用 grep 多换几种关键词与同义说法检索，用 read_file 读命中处上下文。',
    '- **对准版本**：问题涉及本机已装的工具或项目依赖时，先查实际版本（命令行 --version、package.json、lock 文件等），结论对应到那个版本，并写明所依据资料的版本或日期。',
    '- 结论分两类写清：**有明文依据**的附出处 URL（必要处摘一两句原文）；**推断或没找到**的如实标明，并交代查过哪些来源与关键词——不要拿看似合理的说法填空。',
    '- 你**没有写入工具**（write_file / edit_file）——只取材不改动；run_command 只用于下载与只读查询，下载的文件放临时目录，不要写进项目目录。'
  ].join('\n')
}

/** 全部内置子智能体（顺序即 `run_subagent` 工具描述里的展示顺序）。 */
export const BUILTIN_SUBAGENTS: SubagentDef[] = [GENERAL_SUBAGENT, EXPLORE, RESEARCH, PLAN]

/**
 * 分身（fork，对标 Claude Code 的 `subagent_type: "fork"`）：不在 BUILTIN_SUBAGENTS 里——它没有自己的
 * 系统提示词与工具白名单，而是**原样继承主对话**（历史 + 定格的 system / tools，同一模型），由 chat.ts
 * 在派发时直接构造。工具表与主对话一致只为共享提示缓存，禁用的交互/创建类工具由工具循环兜底拦截。
 */
export const FORK_AGENT = {
  name: 'fork',
  description:
    '继承你当前的完整对话上下文、使用同一模型；适合需要了解前文、又不想让中间过程占用主对话的子任务；主对话已经很长时慎用。'
}

export function isForkAgent(name: string): boolean {
  return name.trim().toLowerCase() === FORK_AGENT.name
}

/** 可派发子智能体的 name+description 摘要（含 fork），用于 `run_subagent` 的 agent 枚举与工具描述。 */
export function subagentSummaries(): { name: string; description: string }[] {
  return [
    ...BUILTIN_SUBAGENTS.map((a) => ({ name: a.name, description: a.description })),
    FORK_AGENT
  ]
}

/** 旧名别名（小写）：通用子智能体曾叫 general-purpose，模型也常沿用 CC 的叫法，照样直接命中、不报「未找到」。 */
const ALIASES: Record<string, SubagentDef> = { 'general-purpose': GENERAL_SUBAGENT }

/** 按名（大小写不敏感）取内置子智能体定义；未命中返回 null（调用方回落 GENERAL_SUBAGENT）。 */
export function getSubagentByName(name: string): SubagentDef | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  return BUILTIN_SUBAGENTS.find((a) => a.name.toLowerCase() === wanted) ?? ALIASES[wanted] ?? null
}
