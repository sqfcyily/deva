import { spawn } from 'node:child_process'
import { promises as fs, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { assertInside, isSensitivePath } from './fs-guard'
import { isDangerousCommand, resolveExecShell } from './exec-policy'
import { upsertSkill } from './skills'
import { upsertServer, type McpValue } from './mcp-config'
import type { ToolSpec } from '../providers/types'

/**
 * Agent 工具集。工具名遵循 ^[a-zA-Z0-9_-]{1,64}$（各家 API 均不允许点号），
 * 故用 read_file / list_dir / glob / grep / write_file / edit_file / web_fetch。
 * 文件类路径经 fs-guard 校验，严禁越出受信根；搜索类遍历默认跳过 node_modules/.git 等噪音目录。
 * web_fetch 是唯一的网络工具：仅 http/https、带超时与大小上限、HTML 自动转纯文本。
 */

export const toolSpecs: ToolSpec[] = [
  {
    name: 'read_file',
    description:
      '读取工作区内一个文本文件。默认返回带行号的完整内容（便于定位与后续精确编辑）；可选 offset（起始行，1 起）/ limit（行数）分段读取大文件。path 可相对项目根或绝对。注意：用 edit_file 时 old_string 应为「去掉行号前缀」的原文。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对项目根或绝对路径' },
        offset: { type: 'integer', description: '起始行号（1 起，含）。默认从第 1 行。' },
        limit: { type: 'integer', description: '读取行数。默认到文件末尾。' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_dir',
    description: '列出工作区内某个目录的直接子项（目录在前）。用于探索项目结构。不传 path 时默认列项目根。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对项目根或绝对路径。省略则默认项目根。' }
      }
    }
  },
  {
    name: 'glob',
    description:
      '按 glob 模式匹配工作区内的文件路径（支持 ** 任意层级、* 单层任意、? 单字符、{a,b} 分支，如 **/*.ts、src/**/*.{ts,tsx}），按最近修改时间倒序返回。默认忽略 node_modules/.git/dist 等目录。用于按名字/类型快速定位文件。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.ts、src/**/*.{ts,tsx}' },
        path: { type: 'string', description: '搜索根目录，相对项目根或绝对路径。默认项目根。' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'grep',
    description:
      '在工作区内按正则搜索文件内容，返回匹配行（格式 路径:行号: 内容）。可选 glob 限定文件范围（如 *.ts）、ignore_case 忽略大小写。默认忽略 node_modules/.git/dist 等目录，跳过二进制与超大文件。用于快速定位代码。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
        path: { type: 'string', description: '搜索根目录，相对项目根或绝对路径。默认项目根。' },
        glob: { type: 'string', description: '仅搜索匹配该 glob 的文件（如 *.ts、**/*.tsx）。可选。' },
        ignore_case: { type: 'boolean', description: '忽略大小写。默认 false。' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'web_fetch',
    description:
      '获取一个网页 / HTTP(S) 资源并转为可读文本：HTML 自动去标签、解码实体、保留正文；JSON / 纯文本原样返回。用于查在线文档、读网页、取 API 响应。仅支持 http/https，有超时与大小上限，超长内容会截断。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取的完整 URL（以 http:// 或 https:// 开头）' }
      },
      required: ['url']
    }
  },
  {
    name: 'write_file',
    description:
      '把内容写入工作区内的文件（覆盖式，不存在则创建）。仅限已打开的项目目录内。多用于新建文件；改动既有文件请优先用 edit_file。属敏感操作，需用户授权。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对项目根或绝对路径' },
        content: { type: 'string', description: '要写入的完整文本内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      '对工作区内「已存在」的文件做精确替换：把 old_string 匹配到的片段替换为 new_string。默认要求 old_string 在文件中唯一出现（否则报错——请多带上下文使其唯一）；replace_all=true 时替换所有匹配。这是修改代码的首选（优于覆盖式 write_file）。属敏感操作，需用户授权。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对项目根或绝对路径' },
        old_string: {
          type: 'string',
          description: '要被替换的原文（需与文件内容逐字符一致，含缩进/换行；去掉 read_file 的行号前缀）'
        },
        new_string: { type: 'string', description: '替换后的新内容' },
        replace_all: {
          type: 'boolean',
          description: '替换所有匹配（默认 false，仅当 old_string 唯一时替换）'
        }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'run_command',
    description:
      '在当前项目根目录下执行一条 shell 命令并返回标准输出/错误与退出码（非交互、一次性）。用于构建、测试、git、脚本等。' +
      (process.platform === 'win32'
        ? '命令在 bash 中运行（优先使用 Git Bash，请写 POSIX/bash 命令；若本机未装 Git Bash 则回落到 cmd.exe，此时请改用 Windows 命令）。'
        : '命令在 bash/sh 中运行，请写 POSIX/bash 命令。') +
      '工作目录锁定为已打开的项目根（无法切到项目外；未打开项目时不可用）。非交互运行（已禁用分页器/凭据提示/颜色，避免卡住）；默认超时 120000ms（可用 timeout 调整，最长 600000ms）；输出过长会被截断。属敏感操作，需用户授权；明显危险的命令会被安全策略直接拒绝。请勿运行交互式或长驻命令（如 dev server、vim、npm init——需交互请让用户改用终端面板），否则会阻塞到超时后被强制结束。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令（可含参数）。' },
        description: {
          type: 'string',
          description: '对该命令用途的简短说明（可选，用于界面展示）。'
        },
        timeout: {
          type: 'integer',
          description: '超时毫秒数（可选，默认 120000，最长 600000）。'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'ask_user',
    description:
      '向用户提出一个或多个问题并等待其作答——仅在需求有歧义、存在多个各有取舍的可行方案需用户抉择、或缺少无法合理默认的关键信息时使用。' +
      '能给出合理默认就直接做，不要为琐碎选择打断用户。' +
      '可一次问多个相关问题，用户会在同一张卡片里一次性回答全部（避免来回多轮打断）。' +
      '每个问题可给候选项（单选或多选，由 multiSelect 决定）；界面每题都已内置「自己输入」入口（用户点选后才出现输入框），因此不要在 options 里再加「自己输入 / 自定义 / 其他 / 手动输入 / Other」之类的兜底项——那会与内置入口重复。options 只列具体、有意义的选择。' +
      '尽量给具体候选项而非留空让用户干打字：候选项应覆盖常见取舍。若你有倾向，把推荐项放在 options 第一个并在其 label 末尾标注「（推荐）」，界面会高亮它，用户一键即可采纳。' +
      '对「缺了也能用合理默认继续」的澄清题，把该题的 required 设为 false——用户可留空跳过，工具会回灌「未作答」，你据此用合理默认继续、勿再追问同一件事。默认 required 为 true（必答）。' +
      '工具会返回用户对每个问题的最终选择/输入，你据此继续。' +
      '注意：这是「征求决策/澄清」，与「征求授权」不同——写入/执行的授权永远走工具自动弹出的授权按钮，切勿用本工具去问「是否允许」。',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description:
            '要问用户的问题列表（按序竖排展示）。通常一个；仅当多个问题彼此相关、适合一次性作答时才给多个，别硬凑。',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题文本（简洁、单一）。' },
              multiSelect: {
                type: 'boolean',
                description: '该问题是否允许多选（默认 false=单选）。选「可勾选的多个特性/项」时设为 true。'
              },
              required: {
                type: 'boolean',
                description:
                  '该问题是否必答（默认 true）。设为 false 表示「缺了也能合理默认」——用户可留空跳过，你据回灌的「未作答」自行默认、勿再追问。'
              },
              options: {
                type: 'array',
                description:
                  '候选项（按序展示）。每项一个简短标签，可选补充说明。只列具体、有意义的选择。可省略/留空表示该问题纯自由作答；界面每题都已内置「自己输入」入口，禁止把「自己输入 / 自定义 / 其他 / 手动输入 / Other」等兜底项写进 options（会与内置入口重复）。若有推荐项，放第一个并在 label 末尾标注「（推荐）」。',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项标签（简短）。' },
                    description: { type: 'string', description: '该选项的补充说明（可选）。' }
                  },
                  required: ['label']
                }
              }
            },
            required: ['question']
          }
        }
      },
      required: ['questions']
    }
  },
  {
    name: 'create_skill',
    description:
      '创建并启用一个新的**技能（Skill）**，写入用户的全局技能目录（~/.deva/skills）。' +
      '仅在用户明确想创建技能、且你已收集好要素并向用户复述确认后调用。' +
      '这是写入受保护目录的唯一途径——**严禁**用 write_file / run_command 去写 SKILL.md（那些工具无法写入该目录）。' +
      '创建后技能自动启用，用户可用 /技能名 触发。属敏感操作，需用户授权。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名，建议英文小写加短横线（如 code-review）；/技能名 据此触发。'
        },
        description: {
          type: 'string',
          description: '一句话说明「何时该用这个技能」，会进入系统提示词，务必精准。'
        },
        trigger: { type: 'string', description: '触发方式的自由文本说明（可选）。' },
        allowedTools: {
          type: 'array',
          description: '建议用到的工具名清单（仅提示，不授予任何权限；可选）。',
          items: { type: 'string' }
        },
        instructions: {
          type: 'string',
          description: '技能正文：完整操作步骤，用 Markdown 编写。这是技能的核心内容。'
        }
      },
      required: ['name', 'instructions']
    }
  },
  {
    name: 'propose_agent',
    description:
      '当用户想「用对话创建一个角色（Agent/性格身份）」时，据已厘清的需求生成一张**角色名片**供用户确认。' +
      '这只是**提议**：本工具不写入任何东西、不创建角色，只把你生成的参数以名片形式呈现给用户；' +
      '用户点名片、在编辑器里点「接受」后才真正建角色。' +
      '因此调用后**切勿声称角色已创建**，应告诉用户「名片已生成，请查收并确认」。' +
      '不要设置 model（你无法可靠得知 providerId:modelId），留给用户在编辑器里选。' +
      '不要设置头像：头像由系统按角色名自动生成，用户接受名片后可在编辑器里挑选部件与配色。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名（显示名，如「代码审查员」「产品经理小美」）。' },
        description: {
          type: 'string',
          description: '一句话专长/定位说明，会显示在名片与角色资料上。'
        },
        color: {
          type: 'string',
          description: '主题色，十六进制（如 #4f8cff）；用于名片与头像描边的强调色。'
        },
        prompt: {
          type: 'string',
          description: '角色的系统提示词：性格、语气、专长、行为准则等，用 Markdown 编写。这是角色的核心。'
        }
      },
      required: ['name', 'prompt']
    }
  },
  {
    name: 'create_task',
    description:
      '当用户想「创建一个自动执行的定时任务」时（周期定时或一次性，如「每天10点发我今天的热点新闻」「下午5点提醒我开会」），' +
      '据已厘清的需求生成一张**定时任务确认名片**供用户确认。' +
      '这只是**提议**：本工具不写入任何东西、不创建任务，只把你生成的参数以名片形式呈现给用户；' +
      '用户在名片里核对日程与授权、点「创建」后才真正建任务。' +
      '因此调用后**切勿声称任务已创建**，应告诉用户「确认名片已生成，请核对后点创建」。' +
      '**关键**：任务触发时会自动执行、期间不会再向用户确认。触发时所有工具默认可用（除凭据/系统等' +
      '硬底线目录与危险命令外），无需你或用户挑选工具；名片里只需核对日程，并可选运行身份（人格）与模型。' +
      '你只负责把日程和意图表达清楚。不要设置 model（你无法可靠得知 providerId:modelId）。' +
      'schedule.tz 若不确定可省略，由系统按用户本地时区填充。',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '任务的简短标题（如「每日热点新闻」「开会提醒」），显示在名片与定时任务列表里。'
        },
        prompt: {
          type: 'string',
          description:
            '触发时发给模型执行的指令正文。写成一条清晰、自足的指令（触发时无上下文、无用户在场），如「汇总今天的科技热点新闻，列出5条并附一句点评」。'
        },
        schedule: {
          type: 'object',
          description: '触发日程：一次性（once）或周期（recurring）。',
          properties: {
            kind: {
              type: 'string',
              enum: ['once', 'recurring'],
              description: 'once=一次性触发；recurring=周期触发。'
            },
            at: {
              type: 'string',
              description:
                "once：本地墙钟时间 ISO（无时区偏移），如 \"2026-09-21T17:00\"。必须是未来时刻。"
            },
            cron: {
              type: 'string',
              description:
                'recurring：5 段 cron 表达式（分 时 日 月 周），如 "0 10 * * *"=每天10:00、"*/30 * * * *"=每30分钟、"0 9 * * 1"=每周一09:00。'
            },
            tz: {
              type: 'string',
              description: 'IANA 时区名（如 "Asia/Shanghai"）；不确定则省略，由系统按用户本地时区填充。'
            }
          },
          required: ['kind']
        }
      },
      required: ['title', 'prompt', 'schedule']
    }
  },
  {
    name: 'create_mcp',
    description:
      '创建并启用一个新的 **MCP 服务**（Model Context Protocol server），写入用户的全局 MCP 配置（~/.deva/mcp.json）。' +
      '仅在用户明确想接入某个 MCP 服务、且你已收集好要素并向用户复述确认后调用。' +
      '这是写入受保护配置的唯一途径——**严禁**用 write_file / run_command 去写 mcp.json（那些工具无法写入该目录）。' +
      '**密钥零明文**：绝不把 API Key / Token 等真实密钥值写进本工具参数或对话；只在 secretEnv / secretHeaders 里列出这些字段的**名字**，' +
      '工具会写入占位符，真实值由用户稍后在「扩展」页加密填入。创建后服务自动启用，连接在下次启动或手动开关后建立。属敏感操作，需用户授权。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'MCP 服务显示名（如「GitHub」「文件系统」）。' },
        description: { type: 'string', description: '一句话说明该服务提供什么能力（可选）。' },
        transport: {
          type: 'string',
          enum: ['stdio', 'sse', 'http'],
          description:
            '传输方式：stdio=本地子进程（需 command/args）；sse / http=远程服务（需 url）。默认 stdio。'
        },
        command: { type: 'string', description: 'stdio：启动命令（如 npx、uvx、node）。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'stdio：命令参数清单（如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]）。'
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'stdio：非敏感环境变量，键值均为明文字符串（如 {"NODE_ENV": "production"}）。密钥请勿放这里。'
        },
        secretEnv: {
          type: 'array',
          items: { type: 'string' },
          description:
            'stdio：**密钥类**环境变量的名字清单（如 ["GITHUB_TOKEN"]）。工具只写占位符，真实值由用户后填；切勿在此放真实值。'
        },
        url: { type: 'string', description: 'sse / http：服务地址（如 https://example.com/mcp）。' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'sse / http：非敏感请求头，键值均为明文字符串。密钥请勿放这里。'
        },
        secretHeaders: {
          type: 'array',
          items: { type: 'string' },
          description:
            'sse / http：**密钥类**请求头的名字清单（如 ["Authorization"]）。工具只写占位符，真实值由用户后填。'
        }
      },
      required: ['name', 'transport']
    }
  }
]

/**
 * exit_plan 工具规格。常驻主轮工具集：模型对非平凡任务先只读调研，再调用它提交计划待用户批准。
 * 该工具在 runAgentLoop 内「闸门前特判」，不走 executeTool、不授予任何能力——批准仅让循环继续执行。
 */
export function buildPlanTool(): ToolSpec {
  return {
    name: 'exit_plan',
    description:
      '完成只读调研后调用此工具提交你的实施计划，等待用户批准。把面向用户的完整计划（Markdown 正文）放进 plan 参数。调用即暂停：用户批准后你直接按此计划执行，无需再次征求授权；用户若选择继续完善，请依其反馈调整后再重新提交，在收到新反馈前不要重复调用。',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: '面向用户批准的完整实施计划，Markdown 格式。' }
      },
      required: ['plan']
    }
  }
}

/**
 * 工具敏感度分类，供权限闸门判定：read 恒放行，edit=项目内写入，exec=执行类（命令执行），
 * mcp=外部 MCP 服务暴露的工具（默认 ask，可按会话记住；结果恒作数据）。
 */
export type ToolCategory = 'read' | 'edit' | 'exec' | 'mcp'

const EDIT_TOOLS = new Set(['write_file', 'edit_file'])
const EXEC_TOOLS = new Set<string>(['run_command']) // 执行类：命令行（受策略层 + 权限闸门约束）
/**
 * 明确的只读/无副作用内置工具白名单。ask_user / skill / run_subagent 均在循环内「闸门前特判」，
 * 恒放行执行（不真正走 evaluate），列在此处只是兜底：万一改动导致它们落到闸门，也按 read 放行。
 */
const READ_TOOLS = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'web_fetch',
  'ask_user',
  'skill',
  'run_subagent',
  // 惰性提议工具：不写盘、不弹权限框；真正的授权是用户在名片里点「接受」（走渲染层 personas:upsert）。
  'propose_agent',
  // 惰性提议工具：不写盘、不弹权限框；真正的授权是用户在名片里点「创建」（走渲染层 chat:resolve-autotask）。
  'create_task',
  // exit_plan：提交计划，循环内「闸门前特判」，恒不落到 executeTool；列此仅兜底。
  'exit_plan'
])

/** 已连接 MCP 服务注册的命名空间化工具名（serverId__toolName）。连接时注册、断开时反注册。 */
const mcpToolNames = new Set<string>()
export function registerMcpToolNames(names: string[]): void {
  for (const n of names) mcpToolNames.add(n)
}
export function unregisterMcpToolNames(names: string[]): void {
  for (const n of names) mcpToolNames.delete(n)
}
export function isMcpTool(name: string): boolean {
  return mcpToolNames.has(name)
}

export function toolCategory(name: string): ToolCategory {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (EXEC_TOOLS.has(name)) return 'exec'
  if (READ_TOOLS.has(name)) return 'read'
  if (mcpToolNames.has(name)) return 'mcp'
  // 未知/幻觉工具名：一律按 mcp 走闸（ask），绝不再默认成 read 自动放行——关后门。
  // 内置 create_skill 刻意不列入任何集合，天然落此默认分支 → 判 ask 过闸（与创建技能须经用户授权一致）。
  return 'mcp'
}

export interface ToolContext {
  workspaceRoot: string | null
  /** 仅 run_command 使用：随 chat:abort 中止正在跑的子进程（杀树）。其他工具忽略。 */
  signal?: AbortSignal
}

export interface ToolResult {
  content: string
  summary: string
  isError?: boolean
}

const MAX_READ_BYTES = 2 * 1024 * 1024
/** 搜索类护栏：目录遍历文件数上限 / glob 返回上限 / grep 匹配行上限。 */
const WALK_MAX = 20_000
const GLOB_RESULT_MAX = 500
const GREP_MATCH_MAX = 200
/** web_fetch 护栏：请求超时 / 下载字节上限 / 返回文本字符上限。 */
const WEB_FETCH_TIMEOUT_MS = 30_000
const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
const WEB_TEXT_MAX = 100_000
/** run_command 护栏：输出字符上限 / 默认与最长超时 / 捕获字节上限（防暴产出）。 */
const EXEC_OUTPUT_MAX = 30_000
const EXEC_TIMEOUT_DEFAULT = 120_000
const EXEC_TIMEOUT_MAX = 600_000
const EXEC_CAPTURE_BYTES = 4 * EXEC_OUTPUT_MAX
/** 遍历时直接跳过、不进入的噪音目录。 */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage',
  '.cache', '.turbo', '.output', 'target', '.venv', '__pycache__', '.idea', '.vscode'
])

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * 读取类路径解析：把 path 解析为绝对路径，仅拒绝 Tier-1 敏感目录（凭据/系统）。
 * 刻意不校验受信根——读操作可及任意「非敏感」目录（对标 Claude Code：读不受工作区边界约束）。
 */
function resolveReadPath(root: string | null, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少有效的 path 参数')
  const abs = isAbsolute(p) ? resolve(p) : root ? join(root, p) : resolve(p)
  if (isSensitivePath(abs)) throw new Error('拒绝访问：凭据/系统敏感目录（安全策略），请勿重试。')
  return abs
}

/**
 * 写入类路径解析：在读取解析（含 Tier-1 拒绝）之上，再校验目标落在受信根内。
 * 越界写入由权限闸门的「越界卡」在授权后临时加根放行，故执行时此校验必过；
 * 未授权的越界写入到不了这里（闸门已拦）。
 */
function resolveWritePath(root: string | null, p: unknown): string {
  const abs = resolveReadPath(root, p)
  assertInside(abs)
  return abs
}

/**
 * 写入类工具（write_file / edit_file）的目标：目标文件绝对路径 abs 与授权目录 dir（父目录）。
 * 供权限闸门做 Tier-1 硬底 / Tier-2 保护目录(.git/.claude/.vscode) / 越界 三档分类。
 * 路径解析规则与 resolveWritePath 完全一致（相对路径基于项目根），确保「闸门判定 → 执行」一致。
 * 非写入类或缺 path → null（read/exec/mcp 走常规闸门，无路径越界概念）。
 */
export function writeTargetPath(
  name: string,
  args: unknown,
  root: string | null
): { abs: string; dir: string } | null {
  if (!EDIT_TOOLS.has(name)) return null
  const a = (args ?? {}) as Record<string, unknown>
  const p = a.path
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = isAbsolute(p) ? resolve(p) : root ? join(root, p) : resolve(p)
  return { abs, dir: dirname(abs) }
}

/** 解析「搜索根目录」（读取语义）：给了 path 用之，否则回落项目根；两者皆缺则报错。 */
function resolveReadDir(root: string | null, p: unknown): string {
  if (typeof p === 'string' && p.trim()) return resolveReadPath(root, p)
  if (!root) throw new Error('未打开项目，且未提供 path')
  const abs = resolve(root)
  if (isSensitivePath(abs)) throw new Error('拒绝访问：凭据/系统敏感目录（安全策略），请勿重试。')
  return abs
}

function toInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.floor(n) : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把 glob 模式编译为正则（匹配 posix 相对路径）。支持子集：
 * `**`（跨目录任意层级）、`*`（单层任意）、`?`（单字符）、`{a,b,c}`（字面量分支）。
 * 足够覆盖 **\/*.ts、src/**\/*.{ts,tsx} 这类日常用法；不支持字符类/否定等高级语法。
 */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/')
  let re = ''
  let i = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*' // **/ → 零或多段目录
          i += 3
        } else {
          re += '.*' // ** → 任意（含 /）
          i += 2
        }
      } else {
        re += '[^/]*' // * → 单层任意
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
        i += 1
      } else {
        const parts = g.slice(i + 1, end).split(',').map((s) => escapeRe(s))
        re += '(?:' + parts.join('|') + ')'
        i = end + 1
      }
    } else {
      re += escapeRe(c)
      i += 1
    }
  }
  return new RegExp('^' + re + '$')
}

/** 递归收集受信根内的文件（相对 posix 路径），跳过噪音目录；至多 WALK_MAX 个。 */
async function collectFiles(root: string): Promise<{ abs: string; rel: string }[]> {
  const out: { abs: string; rel: string }[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= WALK_MAX) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= WALK_MAX) return
      const childAbs = join(dir, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue
        // 读遍历（glob/grep）现可作用于任意目录，遍历时绝不进入 Tier-1 凭据/系统目录。
        if (isSensitivePath(childAbs)) continue
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        out.push({ abs: childAbs, rel: childRel })
      }
    }
  }
  await walk(root, '')
  return out
}

/** 从响应体读取至多 cap 字节（超出即取消流），避免超大页面撑爆内存。 */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) {
    const ab = await res.arrayBuffer()
    return Buffer.from(ab).subarray(0, cap)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
      if (total >= cap) {
        try {
          await reader.cancel()
        } catch {
          /* 忽略取消异常 */
        }
        break
      }
    }
  }
  return Buffer.concat(chunks).subarray(0, cap)
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** 解码常见 HTML 实体（含十进制/十六进制数字实体）。&amp; 放最后解，避免二次解码。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, '&')
}

/**
 * 手写 HTML → 纯文本（零依赖）：抽取 <title>，剥离 script/style/注释/head，
 * 块级标签转换行，去尽剩余标签，解码实体，折叠空白。够用于读文档/正文，不求排版还原。
 */
function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
  // 块级/换行类标签（开合皆算）→ 换行
  s = s.replace(
    /<\/?(?:br|p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre)[^>]*>/gi,
    '\n'
  )
  s = s.replace(/<[^>]+>/g, ' ') // 去尽剩余标签
  s = decodeEntities(s)
  s = s
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: s }
}

/** run_command 一次执行的结果（供分支拼装 content/summary/isError）。 */
interface ExecOutcome {
  out: string
  code: number | null
  timedOut: boolean
  aborted: boolean
  spawnError?: string
}

/** 非交互环境：禁分页器、禁 git 凭据提示、禁颜色码，避免命令挂起或污染输出。 */
function execEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' }
}

/** 杀掉子进程「整棵树」：win 用 taskkill /T /F，posix 杀进程组（spawn 时 detached 建了组）。 */
function killTree(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* ignore */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 在 cwd 下执行一条命令，合并捕获 stdout+stderr（按到达序），带超时与中止。
 * shell 由 exec-policy.resolveExecShell 决定（优先 Git Bash）；detached（posix）建进程组以便杀树。
 */
function execCapture(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ out: '', code: null, timedOut: false, aborted: true })
      return
    }
    const sh = resolveExecShell()
    const detached = process.platform !== 'win32'
    let child: import('node:child_process').ChildProcess
    try {
      child = sh.useShell
        ? spawn(command, { cwd, env: execEnv(), shell: true, windowsHide: true, detached })
        : spawn(sh.file, [...sh.args, command], {
            cwd,
            env: execEnv(),
            windowsHide: true,
            detached
          })
    } catch (e) {
      resolvePromise({
        out: '',
        code: null,
        timedOut: false,
        aborted: false,
        spawnError: (e as Error)?.message ?? String(e)
      })
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    let capped = false
    let timedOut = false
    let aborted = false
    let done = false

    const onData = (buf: Buffer): void => {
      if (capped) return
      chunks.push(buf)
      bytes += buf.length
      if (bytes >= EXEC_CAPTURE_BYTES) {
        capped = true
        killTree(child) // 暴产出：停止追加并杀树
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null, spawnError?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        out: Buffer.concat(chunks).toString('utf8'), // 先拼再解码，避免多字节被切断
        code,
        timedOut,
        aborted,
        spawnError
      })
    }

    child.on('error', (e) => finish(null, (e as Error)?.message ?? String(e)))
    child.on('close', (code) => finish(code)) // close 等 stdio EOF，比 exit 更完整
  })
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const a = (args ?? {}) as Record<string, unknown>
  try {
    if (name === 'read_file') {
      const abs = resolveReadPath(ctx.workspaceRoot, a.path)
      const stat = await fs.stat(abs)
      if (stat.size > MAX_READ_BYTES)
        return {
          content: '（文件超过 2MB，未加载；可用 offset/limit 分段，或用 grep 定位）',
          summary: '文件过大',
          isError: true
        }
      const buf = await fs.readFile(abs)
      if (looksBinary(buf))
        return { content: '（疑似二进制文件，未加载）', summary: '二进制', isError: true }
      if (buf.length === 0) return { content: '（空文件）', summary: '0 行' }
      // 行终止符统一：\r\n、孤立 \r（老式 Mac）、\n 一律视为换行，行内容不含 \r——
      // 与 GUI 显示、grep 行号、edit_file 匹配保持一致（此前 split('\n') 会把 \r 留在行内，
      // 显示层不可见却参与匹配，导致「所见非所匹配」）。
      const lines = buf.toString('utf8').split(/\r\n|\r|\n/)
      // 文件以换行结尾会在 split 后多出一个空尾元素（幽灵空行）——去掉这个由末尾终止符产生的空行。
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const total = lines.length
      const start = Math.min(Math.max(1, toInt(a.offset) ?? 1), total)
      const lim = toInt(a.limit)
      const end = lim && lim > 0 ? Math.min(start - 1 + lim, total) : total
      const numbered = lines
        .slice(start - 1, end)
        .map((ln, i) => `${String(start + i).padStart(6, ' ')}\t${ln}`)
        .join('\n')
      const ranged = start > 1 || end < total
      return {
        content: numbered || '（空文件）',
        summary: ranged ? `第 ${start}–${end}/${total} 行` : `${total} 行`
      }
    }

    if (name === 'list_dir') {
      // path 省略时回落项目根（与工具描述「默认项目根」一致）；resolveReadDir 兼顾默认与 Tier-1 拒绝。
      const abs = resolveReadDir(ctx.workspaceRoot, a.path)
      const dirents = await fs.readdir(abs, { withFileTypes: true })
      const rows = dirents
        .filter((d) => d.isDirectory() || d.isFile())
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((x, y) => (x.dir !== y.dir ? (x.dir ? -1 : 1) : x.name.localeCompare(y.name)))
      const listing = rows.map((r) => (r.dir ? `${r.name}/` : r.name)).join('\n')
      return { content: listing || '（空目录）', summary: `${rows.length} 项` }
    }

    if (name === 'glob') {
      const pattern = typeof a.pattern === 'string' ? a.pattern.trim() : ''
      if (!pattern) return { content: '缺少 pattern 参数', summary: '参数无效', isError: true }
      const dir = resolveReadDir(ctx.workspaceRoot, a.path)
      const re = globToRegExp(pattern)
      const files = await collectFiles(dir)
      const matched = files.filter((f) => re.test(f.rel))
      const stated = await Promise.all(
        matched.map(async (f) => {
          let mtime = 0
          try {
            mtime = (await fs.stat(f.abs)).mtimeMs
          } catch {
            /* 忽略无法 stat 的条目 */
          }
          return { rel: f.rel, mtime }
        })
      )
      stated.sort((x, y) => y.mtime - x.mtime)
      const shown = stated.slice(0, GLOB_RESULT_MAX)
      const more = stated.length > shown.length
      const listing = shown.map((f) => f.rel).join('\n')
      return {
        content:
          (listing || '（无匹配文件）') +
          (more ? `\n…（共 ${stated.length} 个，仅列前 ${GLOB_RESULT_MAX}）` : ''),
        summary: `${stated.length} 个文件`
      }
    }

    if (name === 'grep') {
      const pattern = typeof a.pattern === 'string' ? a.pattern : ''
      if (!pattern) return { content: '缺少 pattern 参数', summary: '参数无效', isError: true }
      let re: RegExp
      try {
        re = new RegExp(pattern, a.ignore_case === true ? 'i' : '')
      } catch (e) {
        return { content: `无效的正则：${(e as Error).message}`, summary: '正则错误', isError: true }
      }
      const target = resolveReadDir(ctx.workspaceRoot, a.path)
      let globRe: RegExp | null = null
      if (typeof a.glob === 'string' && a.glob.trim()) globRe = globToRegExp(a.glob.trim())
      // path 可为目录（递归遍历）或单个文件（直接搜该文件）——修复「path 指向文件时静默返回无匹配」。
      // 路径不存在则明确报错，而非误导性的空结果。
      let st: import('fs').Stats
      try {
        st = await fs.stat(target)
      } catch {
        return { content: `路径不存在：${String(a.path ?? '.')}`, summary: '路径不存在', isError: true }
      }
      const files = st.isFile()
        ? [{ abs: target, rel: basename(target) }]
        : await collectFiles(target)
      const rows: string[] = []
      let truncated = false
      outer: for (const f of files) {
        if (globRe && !globRe.test(f.rel)) continue
        let buf: Buffer
        try {
          buf = await fs.readFile(f.abs)
        } catch {
          continue
        }
        if (buf.length > MAX_READ_BYTES || looksBinary(buf)) continue
        // 与 read_file 一致的行拆分：\r 不残留在行内，正则锚点 ^/$ 与显示都基于同一「干净行」。
        const lines = buf.toString('utf8').split(/\r\n|\r|\n/)
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            rows.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
            if (rows.length >= GREP_MATCH_MAX) {
              truncated = true
              break outer
            }
          }
        }
      }
      return {
        content: rows.length
          ? rows.join('\n') + (truncated ? `\n…（匹配过多，仅列前 ${GREP_MATCH_MAX} 处）` : '')
          : '（无匹配）',
        summary: rows.length ? (truncated ? `${rows.length}+ 处` : `${rows.length} 处`) : '无匹配'
      }
    }

    if (name === 'web_fetch') {
      const url = typeof a.url === 'string' ? a.url.trim() : ''
      if (!url) return { content: '缺少 url 参数', summary: '参数无效', isError: true }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { content: `URL 无效：${url}`, summary: 'URL 无效', isError: true }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return {
          content: `仅支持 http/https（收到 ${parsed.protocol}）`,
          summary: '协议不支持',
          isError: true
        }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'user-agent': 'Deva/0.1 (+https://github.com/deva)',
            accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
          }
        })
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        const buf = await readCapped(res, WEB_FETCH_MAX_BYTES)
        if (!res.ok)
          return {
            content: `HTTP ${res.status} ${res.statusText}`.trim(),
            summary: `HTTP ${res.status}`,
            isError: true
          }
        const textual =
          ct.includes('html') ||
          ct.includes('json') ||
          ct.includes('xml') ||
          ct.includes('text') ||
          ct.includes('javascript') ||
          ct === ''
        if (!textual && looksBinary(buf))
          return {
            content: `（非文本内容：${ct || '未知类型'}，未加载）`,
            summary: '非文本',
            isError: true
          }
        const raw = buf.toString('utf8')
        const isHtml = ct.includes('html') || /^\s*(?:<!doctype html|<html)/i.test(raw)
        let title: string | null = null
        let text: string
        if (isHtml) {
          const r = htmlToText(raw)
          title = r.title
          text = r.text
        } else {
          text = raw
        }
        let cut = false
        if (text.length > WEB_TEXT_MAX) {
          text = text.slice(0, WEB_TEXT_MAX)
          cut = true
        }
        const header = [
          `URL: ${res.url || url}`,
          title ? `标题: ${title}` : null,
          `类型: ${ct || '未知'}`
        ]
          .filter(Boolean)
          .join('\n')
        const body = text.trim() || '（无可读文本内容）'
        return {
          content: `${header}\n\n${body}${cut ? `\n\n…（内容超过 ${WEB_TEXT_MAX} 字符，已截断）` : ''}`,
          summary: title ? title.slice(0, 40) : `${body.length} 字符`
        }
      } catch (e) {
        const err = e as Error
        if (err?.name === 'AbortError')
          return {
            content: `请求超时（>${WEB_FETCH_TIMEOUT_MS / 1000}s）`,
            summary: '超时',
            isError: true
          }
        return { content: `获取失败：${err?.message ?? String(e)}`, summary: '失败', isError: true }
      } finally {
        clearTimeout(timer)
      }
    }

    if (name === 'write_file') {
      const abs = resolveWritePath(ctx.workspaceRoot, a.path)
      const content = typeof a.content === 'string' ? a.content : ''
      await fs.writeFile(abs, content, 'utf8')
      return { content: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节`, summary: '已写入' }
    }

    if (name === 'edit_file') {
      const abs = resolveWritePath(ctx.workspaceRoot, a.path)
      const oldStr = typeof a.old_string === 'string' ? a.old_string : ''
      const newStr = typeof a.new_string === 'string' ? a.new_string : ''
      if (!oldStr)
        return { content: 'old_string 不能为空；新建文件请用 write_file', summary: '参数无效', isError: true }
      if (oldStr === newStr)
        return { content: 'old_string 与 new_string 相同，无需编辑', summary: '无变化', isError: true }
      let buf: Buffer
      try {
        buf = await fs.readFile(abs)
      } catch {
        return { content: `文件不存在或无法读取：${String(a.path)}`, summary: '不存在', isError: true }
      }
      if (looksBinary(buf))
        return { content: '（疑似二进制文件，拒绝编辑）', summary: '二进制', isError: true }
      const text = buf.toString('utf8')
      // 非重叠出现次数统计：唯一性是精确编辑的安全前提。
      const countOcc = (hay: string, needle: string): number => {
        let c = 0
        for (let idx = hay.indexOf(needle); idx !== -1; idx = hay.indexOf(needle, idx + needle.length))
          c++
        return c
      }
      // 两级匹配：
      // ① 精确匹配（逐字节）——命中即原样 split/join 替换，文件其余字节（含 CRLF）分毫不动。
      // ② 精确落空时，退回「换行规范化」匹配：把文件与 old/new 的 \r\n、孤立 \r 统一为 \n 再比对。
      //    这修复了「用户/模型从 read_file 的干净显示复制 old_string，在 CRLF 文件上必然匹配失败」的问题
      //    （read_file 现返回不含 \r 的行内容，old_string 天然无 \r，而磁盘文件是 \r\n）。
      const normEol = (s: string): string => s.replace(/\r\n|\r/g, '\n')
      let count = countOcc(text, oldStr)
      let workText = text
      let workOld = oldStr
      let workNew = newStr
      let normalized = false
      if (count === 0) {
        const tN = normEol(text)
        const oN = normEol(oldStr)
        const cN = countOcc(tN, oN)
        if (cN > 0) {
          normalized = true
          count = cN
          workText = tN
          workOld = oN
          workNew = normEol(newStr)
        }
      }
      if (count === 0)
        return {
          content: '未找到 old_string（需与文件内容逐字符一致，含缩进/换行）',
          summary: '未找到',
          isError: true
        }
      const replaceAll = a.replace_all === true
      if (count > 1 && !replaceAll)
        return {
          content: `old_string 匹配到 ${count} 处，不唯一。请多带上下文使其唯一，或传 replace_all。`,
          summary: '不唯一',
          isError: true
        }
      // split/join 逐字面量替换：绕开 String.replace 对 $ 的特殊解释。
      let result = workText.split(workOld).join(workNew)
      // 规范化匹配后需还原文件的主导换行风格：CRLF 主导则把 \n 复原为 \r\n（保「CRLF 文件换行保留」）。
      // 纯 LF / 纯 CRLF 文件均可无损往返；仅极少见的混合换行文件会被统一（此路径本就是精确匹配失败的兜底）。
      if (normalized) {
        const crlf = (text.match(/\r\n/g) || []).length
        const lfOnly = (text.match(/\n/g) || []).length - crlf
        if (crlf > 0 && crlf >= lfOnly) result = result.replace(/\n/g, '\r\n')
      }
      await fs.writeFile(abs, result, 'utf8')
      const n = replaceAll ? count : 1
      const note = normalized ? '（已按换行规范匹配）' : ''
      return { content: `已替换 ${n} 处${note}`, summary: replaceAll ? `已替换 ${n} 处` : '已编辑' }
    }

    if (name === 'run_command') {
      const command = typeof a.command === 'string' ? a.command.trim() : ''
      if (!command)
        return { content: '缺少有效的 command 参数', summary: '参数无效', isError: true }
      // cwd 硬锁项目根：无项目不 spawn；根须在受信集内（abs===root 通过）。
      if (!ctx.workspaceRoot)
        return {
          content:
            '未打开项目：无法执行命令，请先让用户打开一个项目文件夹（工作目录锁定为项目根）。',
          summary: '未打开项目',
          isError: true
        }
      try {
        assertInside(ctx.workspaceRoot)
      } catch {
        return { content: '项目根不在受信目录内，拒绝执行。', summary: '受信校验失败', isError: true }
      }
      // 纵深兜底：即便调用方绕过 evaluate 或项目模式为 auto，危险命令也在此 deny。
      if (isDangerousCommand(command))
        return {
          content: '该命令被安全策略拒绝（危险操作），未执行。请勿重试，改用更精确、非破坏性的命令。',
          summary: '已拒绝（安全策略）',
          isError: true
        }
      const timeoutMs = Math.min(
        Math.max(toInt(a.timeout) ?? EXEC_TIMEOUT_DEFAULT, 1000),
        EXEC_TIMEOUT_MAX
      )
      const r = await execCapture(command, ctx.workspaceRoot, timeoutMs, ctx.signal)
      // 先截断输出，再追加恒显状态行（截断藏不住成败信号）。
      let body = r.out
      if (body.length > EXEC_OUTPUT_MAX)
        body = body.slice(0, EXEC_OUTPUT_MAX) + `\n…（输出超过 ${EXEC_OUTPUT_MAX} 字符，已截断）`
      let status: string
      let summary: string
      if (r.spawnError) {
        status = `（无法执行：${r.spawnError}）`
        summary = '无法执行'
      } else if (r.aborted) {
        status = '（已中止）'
        summary = '已中止'
      } else if (r.timedOut) {
        status = `（超时 >${timeoutMs}ms，已强制结束）`
        summary = '超时'
      } else {
        status = `（退出码：${r.code}）`
        summary = `退出码 ${r.code}`
      }
      const isError = Boolean(r.spawnError) || r.aborted || r.timedOut || r.code !== 0
      const content = (body ? body + '\n' : '') + status
      return { content, summary, isError }
    }

    if (name === 'create_skill') {
      const skillName = typeof a.name === 'string' ? a.name.trim() : ''
      const instructions = typeof a.instructions === 'string' ? a.instructions.trim() : ''
      if (!skillName)
        return { content: '缺少技能 name（技能显示名，/技能名 据此触发）', summary: '参数无效', isError: true }
      if (!instructions)
        return { content: '缺少 instructions（技能正文，即完整操作步骤）', summary: '参数无效', isError: true }
      const allowedTools = Array.isArray(a.allowedTools)
        ? a.allowedTools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : []
      // 直调主进程 upsertSkill（渲染层写不进 ~/.deva；本工具已过权限闸）——自动启用。
      const rec = upsertSkill({
        name: skillName,
        description: typeof a.description === 'string' ? a.description : '',
        trigger: typeof a.trigger === 'string' ? a.trigger : '',
        allowedTools,
        instructions,
        enabled: true
      })
      return {
        content: `已创建并启用技能「${rec.name}」(id: ${rec.id})，用户可用 /${rec.name} 触发。`,
        summary: '已创建技能'
      }
    }

    if (name === 'propose_agent') {
      // 惰性工具：**不写任何东西**。草稿参数经 tool_call 事件的 args 到渲染层铸成名片，
      // 用户点「接受」后才走渲染层 personas:upsert 真正建角色（零提权）。
      const proposedName = typeof a.name === 'string' ? a.name.trim() : ''
      if (!proposedName)
        return { content: '缺少角色 name（角色显示名）', summary: '参数无效', isError: true }
      return {
        content: '已生成角色名片，等待用户在名片中查看并确认；请勿重复调用，也不要声称角色已创建。',
        summary: '已生成角色名片'
      }
    }

    if (name === 'create_task') {
      // 惰性工具：**不写任何东西**。草稿参数经 tool_call 事件的 args 到渲染层铸成确认名片，
      // 用户核对日程与授权、点「创建」后才走渲染层 chat:resolve-autotask 真正建任务（创建=授权时刻）。
      const title = typeof a.title === 'string' ? a.title.trim() : ''
      if (!title)
        return { content: '缺少任务 title（任务标题）', summary: '参数无效', isError: true }
      return {
        content:
          '已生成定时任务确认名片，等待用户核对日程与授权后点「创建」；请勿重复调用，也不要声称任务已创建。' +
          '提醒用户：任务触发时会自动执行、期间不再确认，一切授权须在此名片里议定。',
        summary: '已生成定时任务名片'
      }
    }

    if (name === 'create_mcp') {
      const serverName = typeof a.name === 'string' ? a.name.trim() : ''
      if (!serverName)
        return { content: '缺少 MCP 服务 name（显示名）', summary: '参数无效', isError: true }
      const transport: 'stdio' | 'sse' | 'http' =
        a.transport === 'sse' || a.transport === 'http' ? a.transport : 'stdio'

      // 明文 map（env / headers）：仅保留字符串键值，密钥不走这里。
      const plainMap = (v: unknown): Record<string, string> => {
        const out: Record<string, string> = {}
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            const key = k.trim()
            if (key && typeof val === 'string') out[key] = val
          }
        }
        return out
      }
      // 密钥字段名清单：模型只给「名字」，真实值由用户后填。
      const secretNames = (v: unknown): string[] =>
        Array.isArray(v)
          ? Array.from(
              new Set(
                v
                  .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                  .map((s) => s.trim())
              )
            )
          : []
      // 合成 env / headers：明文键值 + 密钥字段名 → { secretRef } 占位（占位本身非敏感）。
      const buildMap = (plainKey: string, secretKey: string): Record<string, McpValue> => {
        const map: Record<string, McpValue> = { ...plainMap(a[plainKey]) }
        for (const nm of secretNames(a[secretKey])) map[nm] = { secretRef: nm }
        return map
      }

      const input: Parameters<typeof upsertServer>[0] = {
        name: serverName,
        description: typeof a.description === 'string' ? a.description : '',
        transport,
        enabled: true
      }
      let secretFields: string[] = []
      if (transport === 'stdio') {
        const command = typeof a.command === 'string' ? a.command.trim() : ''
        if (!command)
          return { content: 'stdio 传输缺少 command（启动命令，如 npx）', summary: '参数无效', isError: true }
        input.command = command
        input.args = Array.isArray(a.args)
          ? a.args.filter((x): x is string => typeof x === 'string')
          : []
        input.env = buildMap('env', 'secretEnv')
        secretFields = secretNames(a.secretEnv)
      } else {
        const url = typeof a.url === 'string' ? a.url.trim() : ''
        if (!url)
          return { content: `${transport} 传输缺少 url（服务地址）`, summary: '参数无效', isError: true }
        input.url = url
        input.headers = buildMap('headers', 'secretHeaders')
        secretFields = secretNames(a.secretHeaders)
      }

      // 直调主进程 upsertServer（渲染层写不进 ~/.deva；本工具已过权限闸）——自动启用，但不在此连接。
      const rec = upsertServer(input)
      const secretHint = secretFields.length
        ? `\n⚠️ 以下字段为密钥占位、尚无真实值：${secretFields.join('、')}。请提示用户前往「扩展」页为该服务填写这些密钥（加密存储），否则连接会失败。`
        : ''
      return {
        content:
          `已创建并启用 MCP 服务「${rec.name}」(id: ${rec.id}，传输 ${rec.transport})。` +
          `连接将在下次启动应用、或在「扩展」页手动开关该服务后建立。${secretHint}`,
        summary: '已创建 MCP 服务'
      }
    }

    return { content: `未知工具：${name}`, summary: '未知工具', isError: true }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { content: `工具执行失败：${msg}`, summary: '失败', isError: true }
  }
}
