/**
 * 扩展（技能 / MCP 服务 / 子智能体）的种子数据。全局配置，与项目无关。
 * 每一项都带有可在中央详情页展示与编辑的字段。后续接入真实存储时整体替换。
 */

export type ExtKind = 'skill' | 'mcp' | 'subagent'
export type ExtSource = 'builtin' | 'custom'

export interface Skill {
  id: string
  name: string
  desc: string
  /** 触发方式，如「手动 / 提交前」 */
  trigger: string
  /** 技能指令（提示词） */
  instructions: string
  source: ExtSource
  enabled: boolean
}

export interface McpServer {
  id: string
  name: string
  desc: string
  transport: 'stdio' | 'sse' | 'http'
  /** stdio：启动命令；sse/http：留空 */
  command: string
  /** sse/http：服务地址；stdio：留空 */
  url: string
  /** 该服务暴露的工具 */
  tools: string[]
  source: ExtSource
  enabled: boolean
}

export interface SubAgent {
  id: string
  name: string
  desc: string
  /** 使用的模型 ID */
  model: string
  /** 允许使用的工具 */
  tools: string[]
  /** 角色系统提示词 */
  prompt: string
  source: ExtSource
  enabled: boolean
}

export const seedSkills: Skill[] = [
  {
    id: 'code-review',
    name: 'code-review',
    desc: '按清单对改动做多维代码评审',
    trigger: '手动 / 提交前',
    instructions:
      '对暂存的改动逐一审查：正确性、可读性、边界条件、测试覆盖。\n按严重程度排序，给出可执行的修改建议。',
    source: 'builtin',
    enabled: true
  },
  {
    id: 'commit-message',
    name: 'commit-message',
    desc: '依据暂存改动生成规范提交信息',
    trigger: 'git 暂存后',
    instructions: '读取暂存 diff，生成 Conventional Commits 风格的提交信息，首行不超过 50 字符。',
    source: 'builtin',
    enabled: true
  },
  {
    id: 'sql-explain',
    name: 'sql-explain',
    desc: '解释执行计划并给出优化建议',
    trigger: '选中 SQL',
    instructions: '对选中的 SQL 执行 EXPLAIN，解读执行计划，指出全表扫描/缺失索引并给出优化建议。',
    source: 'builtin',
    enabled: false
  }
]

export const seedMcp: McpServer[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    desc: '受控访问本地文件系统',
    transport: 'stdio',
    command: 'npx -y @modelcontextprotocol/server-filesystem',
    url: '',
    tools: ['read_file', 'write_file', 'list_dir', 'search_files'],
    source: 'builtin',
    enabled: true
  },
  {
    id: 'github',
    name: 'github',
    desc: '仓库、Issue、PR 操作',
    transport: 'http',
    command: '',
    url: 'https://api.githubcopilot.com/mcp',
    tools: ['create_issue', 'get_pull_request', 'search_code'],
    source: 'custom',
    enabled: true
  },
  {
    id: 'playwright',
    name: 'playwright',
    desc: '浏览器自动化与抓取',
    transport: 'stdio',
    command: 'npx @playwright/mcp@latest',
    url: '',
    tools: ['browser_navigate', 'browser_click', 'browser_snapshot'],
    source: 'custom',
    enabled: false
  }
]

export const seedSubAgents: SubAgent[] = [
  {
    id: 'explorer',
    name: 'explorer',
    desc: '只读代码检索，快速定位实现',
    model: 'claude-3-5-haiku',
    tools: ['read_file', 'grep', 'glob'],
    prompt: '你是只读代码检索助手。定位相关实现并汇报文件与行号，不修改任何文件。',
    source: 'builtin',
    enabled: true
  },
  {
    id: 'planner',
    name: 'planner',
    desc: '拆解需求，产出实现方案',
    model: 'claude-3-7-sonnet',
    tools: ['read_file', 'search'],
    prompt: '你是方案设计助手。将需求拆解为可执行步骤，指出关键文件与取舍，不直接写代码。',
    source: 'builtin',
    enabled: true
  }
]
