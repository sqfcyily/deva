/**
 * 内置子智能体（Subagents）注册表：**纯代码常量**——不落盘、无 IPC、不进扩展页、不可由用户配置。
 *
 * 设计（对标 Claude Code 的 Task / subagent_type）：
 * - CC 的做法是**内置一组类型开箱可用**（general-purpose / Explore / Plan …），用户自定义是可选增强。
 *   Deva 此前反过来——必须先在 `~/.deva/agents` 建预设才有专家可派，而首启是空的，于是「按需派生专家」
 *   实际永远只剩一个通用兜底。故整套用户配置（目录/IPC/扩展页 UI）已废弃，改为这里三个常量。
 * - 身份 = `name`：既是 `run_subagent` 的 `agent` 枚举值，也是对话里 Task 卡的回退标题。
 * - 模型恒**跟随主对话**（继承父轮模型），不再有 per-agent 模型引用。
 *
 * 安全：`tools` 只**收窄**子智能体可见的工具，绝不放宽闸门——保留下来的每次嵌套调用照常过
 * chat.ts 的同一道安全地板（Tier-1 凭据目录、.git 写入、危险命令，静默拒绝）。因此 Explore/Plan
 * 的「只读」是**工具表 + 提示词层面的约定**，不是硬保证：run_command 与部分 MCP 工具本就能写。
 */

export interface SubagentDef {
  /** 显示名：`run_subagent` 的 agent 枚举值，也是 Task 卡的回退标题。 */
  name: string
  /** 一句话定位，注入 `run_subagent` 工具描述的专家清单。 */
  description: string
  /** 内置工具白名单；`'*'` = 全部（交互/创建类除外）。已连接的 MCP 工具恒全量附加。 */
  tools: string[] | '*'
  /** 职责正文，追加在固定的隔离/约束说明之后（见 chat.ts 的 buildSubagentSystem）。 */
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
 * 任务内容完全由本次调用的 prompt 给出。对标 CC 的 general-purpose。
 */
export const GENERAL_SUBAGENT: SubagentDef = {
  name: '通用子智能体',
  description: '按主智能体现场给定的任务描述，独立完成一项封闭子任务；具备全部工具。',
  tools: '*',
  prompt: ''
}

/** 广度检索定位：把「在哪里、有几处、怎么命名的」问清楚，只回报事实。 */
const EXPLORE: SubagentDef = {
  name: 'Explore',
  description: '在代码库里做广度检索与定位，回报「路径:行号 + 说明」；只读，不改动、不评审。',
  tools: READONLY_TOOLS,
  prompt: [
    '你的专长是**在庞大或陌生的代码库里做广度检索与定位**：把「在哪里、有几处、怎么命名的」查清楚。',
    '',
    '- **先广后深**：先用 glob / grep 铺开候选面（同一概念多试几种命名与大小写写法），再用 read_file 只读命中处前后的片段；不要通读整个文件。',
    '- 你**没有写入工具**（write_file / edit_file）——这是定位任务不是改动任务；run_command 只用于只读查询（git log / git grep / ls 之类），不要用它改动任何东西。',
    '- 结论逐条列「**绝对路径:行号** —— 一句话说明」，必要处附三五行关键片段；有多处同类实现要列全，不要只报第一个。',
    '- 没找到就明说没找到，并交代搜过哪些模式与目录——这比编一个看似合理的位置有用得多。',
    '- 只做定位与事实陈述：**不做代码评审、不提改动建议**，那是主智能体的判断。'
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
    '- 拿不准的地方标注出来并给出你的建议取向，不要含糊带过，也不要为此停下来等人回答——你无法提问。',
    '- 你的结论会交回主智能体，并很可能由它整理后提交给**用户批准**（`exit_plan`）：请按「可直接给人读的实施方案」来写，别写成给自己看的调研流水账。你自己**不需要也无法**调用 exit_plan。'
  ].join('\n')
}

/** 全部内置子智能体（顺序即 `run_subagent` 工具描述里的展示顺序）。 */
export const BUILTIN_SUBAGENTS: SubagentDef[] = [GENERAL_SUBAGENT, EXPLORE, PLAN]

/** 内置子智能体的 name+description 摘要，用于 `run_subagent` 的 agent 枚举与工具描述。 */
export function subagentSummaries(): { name: string; description: string }[] {
  return BUILTIN_SUBAGENTS.map((a) => ({ name: a.name, description: a.description }))
}

/** 按名（大小写不敏感）取内置子智能体定义；未命中返回 null（调用方回落 GENERAL_SUBAGENT）。 */
export function getSubagentByName(name: string): SubagentDef | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  return BUILTIN_SUBAGENTS.find((a) => a.name.toLowerCase() === wanted) ?? null
}
