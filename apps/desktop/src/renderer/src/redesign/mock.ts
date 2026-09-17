/*
 * 「对话优先」外壳的界面原型 —— 纯假数据，不接任何后端。
 * 这里只承载视觉/交互所需的数据形状，方便后续接真实 store 时对照。
 *
 * 本版定下的方向（借鉴 IM 应用）：
 *  - 像聊天应用：左栏「消息 / 角色」两个 tab，角色即联系人
 *  - 一对话一身份：Thread.ownerPersonaId 只挂一位；Message.authorId 只会是 user 或那一位
 *  - 可对同一角色发起多个对话：多条 Thread 可共享同一 ownerPersonaId（近 ChatGPT 的多会话，按角色归堆）
 *  - 完整身份档案（带专长）：Persona 有 emoji/color/specialty/model/tools/tagline，可查看资料卡
 *  - 工作区可选：Thread.project 可有可无，有则头部显示「聚焦中」chip，无则是全机通用助手
 *  - 动手全内联：没有文件/变更/终端面板，读写以 Message.tools 的内联条呈现
 */

export interface Persona {
  id: string
  name: string
  handle: string // @handle，用于检索/标识
  emoji: string
  color: string // 身份主题色（头像描边、名字色）
  specialty: string // 专长，一句话
  model: string // 偏好模型
  tools: string[] // 擅长/授权的工具
  tagline: string // 开场白/口头禅
}

export interface ToolCall {
  icon: string
  label: string
  detail?: string // 展开后看到的内容（假的）
}

export interface Message {
  id: string
  authorId: string // persona id 或 'user'
  text: string
  tools?: ToolCall[]
}

export interface Thread {
  id: string
  title: string
  snippet: string
  time: string
  ownerPersonaId: string // 这条对话归属的唯一身份
  project?: string // 已挂载的工作区名；无则是全机通用助手
  unread?: boolean
}

/** 身份花名册（团队）。首启内置几位有魅力的角色制造第一印象。 */
export const PERSONAS: Persona[] = [
  {
    id: 'sauce',
    name: '小酱',
    handle: 'sauce',
    emoji: '🍥',
    color: '#e0559a',
    specialty: '编码主力 · 把脏活累活接走',
    model: 'Opus 4.8',
    tools: ['读写文件', '终端', 'Git'],
    tagline: '交给我，写完喊你验收～',
  },
  {
    id: 'kay',
    name: '老K',
    handle: 'kay',
    emoji: '🧭',
    color: '#d9860b',
    specialty: '架构审阅 · 只读不动手',
    model: 'Opus 4.8',
    tools: ['只读浏览', '静态分析'],
    tagline: '先想清楚，再动键盘。',
  },
  {
    id: 'yan',
    name: '阿研',
    handle: 'yan',
    emoji: '🔍',
    color: '#12a594',
    specialty: '调研 · 找资料、抄好设计',
    model: 'Sonnet 5',
    tools: ['网络检索', 'MCP'],
    tagline: '这个我查过，给你三条参考。',
  },
  {
    id: 'muse',
    name: '缪',
    handle: 'muse',
    emoji: '🎀',
    color: '#7c7cf0',
    specialty: '产品 & 文案 · 把话说人话',
    model: 'Sonnet 5',
    tools: ['写作', '总结'],
    tagline: '要不要我帮你润一版？',
  },
]

export const personaById = (id: string): Persona | undefined =>
  PERSONAS.find((p) => p.id === id)

/** 左栏「消息」tab 的对话列表。多条可共享同一 ownerPersonaId（同一角色的多个对话）。 */
export const THREADS: Thread[] = [
  {
    id: 't1',
    title: '清理桌面日志文件',
    snippet: '小酱：保留 install.log，其余 5 个已删除，腾出 11.8 MB。',
    time: '刚刚',
    ownerPersonaId: 'sauce',
  },
  {
    id: 't2',
    title: '重构成对话优先外壳',
    snippet: '小酱：那我按「对话为根 + 工作区可挂载」来出组件…',
    time: '昨天',
    ownerPersonaId: 'sauce',
    project: 'deva',
  },
  {
    id: 't3',
    title: '调研 MCP 生态',
    snippet: '阿研：主流客户端都走 stdio + SSE 两种传输…',
    time: '14:20',
    ownerPersonaId: 'yan',
    unread: true,
  },
  {
    id: 't4',
    title: '本周周报草稿',
    snippet: '缪：帮你压成三段，重点放前面。',
    time: '周一',
    ownerPersonaId: 'muse',
  },
  {
    id: 't5',
    title: '修复终端底部黑边',
    snippet: '小酱：是 xterm fit 时机的问题，已经改好。',
    time: '周一',
    ownerPersonaId: 'sauce',
    project: 'deva',
  },
  {
    id: 't6',
    title: '审一遍权限模型',
    snippet: '老K：读写不对称这块没问题，Tier-1 硬地板要再确认一处。',
    time: '上周',
    ownerPersonaId: 'kay',
  },
]

/** 某角色名下的全部对话（资料卡里「与TA的对话」用）。 */
export const threadsByPersona = (personaId: string): Thread[] =>
  THREADS.filter((t) => t.ownerPersonaId === personaId)

/**
 * 当前活动对话的消息（单身份 + 内联工具示例）。
 * 演示「全机通用助手」：无工作区也能清桌面、往 D 盘写文件；读→确认→动手，全部内联。
 * 其余对话此原型不展开。
 */
export const ACTIVE_MESSAGES: Message[] = [
  {
    id: 'm1',
    authorId: 'user',
    text: '帮我把桌面上的日志文件清理一下，太乱了。',
  },
  {
    id: 'm2',
    authorId: 'sauce',
    text: '我扫了一遍桌面，找到 6 个日志文件，一共 12.4 MB。动手前你先确认下清单，要我全删，还是留哪个？',
    tools: [
      {
        icon: '📄',
        label: '读取桌面 · 命中 6 个 .log',
        detail:
          'Desktop/\n  update.log            4.2 MB\n  update.log.1          3.1 MB\n  cursor-cpuprof.log    2.0 MB\n  npm-debug.log         1.6 MB\n  vite.log              0.9 MB\n  install.log           0.6 MB',
      },
    ],
  },
  {
    id: 'm3',
    authorId: 'user',
    text: '除了 install.log 都删。',
  },
  {
    id: 'm4',
    authorId: 'sauce',
    text: '好，保留 install.log，其余 5 个已经删掉了，腾出 11.8 MB。',
    tools: [
      {
        icon: '🗑',
        label: '删除 5 个文件',
        detail:
          '已删除：\n  update.log · update.log.1 · cursor-cpuprof.log · npm-debug.log · vite.log\n保留：\n  install.log',
      },
    ],
  },
  {
    id: 'm5',
    authorId: 'user',
    text: '顺手帮我生成一份今天的科技新闻，存到 D 盘。',
  },
  {
    id: 'm6',
    authorId: 'sauce',
    text: '抓好了，今日科技要闻整理成 5 条，已经写到 D:\\news\\2026-09-16.md。要我把摘要念一遍吗？',
    tools: [
      {
        icon: '🌐',
        label: '检索今日科技新闻',
        detail: '来源：36氪 / TechCrunch / Hacker News —— 汇总 5 条要闻',
      },
      {
        icon: '💾',
        label: '写入 D:\\news\\2026-09-16.md',
        detail: '新建文件 · 5 条 · 2.3 KB',
      },
    ],
  },
]
