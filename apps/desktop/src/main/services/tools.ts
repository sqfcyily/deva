import { spawn } from 'node:child_process'
import { promises as fs, type Dirent } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { assertInside, isInsideRoot } from './fs-guard'
import { isDangerousCommand, resolveExecShell } from './exec-policy'
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
    description: '列出工作区内某个目录的直接子项（目录在前）。用于探索项目结构。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，相对项目根或绝对路径。默认项目根。' }
      },
      required: ['path']
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
      '向用户提出一个单选问题并等待其选择——仅在需求有歧义、存在多个可行方案需用户抉择、或缺少无法合理默认的关键信息时使用。' +
      '能给出合理默认就直接做，不要为琐碎选择打断用户，也不要一次问多个问题。' +
      '用户可从你给的候选项里选，也可自行输入答案；工具会返回用户的最终选择/输入，你据此继续。' +
      '注意：这是「征求决策/澄清」，与「征求授权」不同——写入/执行的授权永远走工具自动弹出的授权按钮，切勿用本工具去问「是否允许」。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题（简洁、单一）。' },
        options: {
          type: 'array',
          description:
            '候选项（竖排单选，按序展示）。每项一个简短标签，可选补充说明。可省略/留空表示纯自由作答；界面总会额外提供「自己输入」项，无需你列出。',
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
]

/** 工具敏感度分类，供权限闸门判定：read 恒放行，edit=项目内写入，exec=执行类（命令执行）。 */
export type ToolCategory = 'read' | 'edit' | 'exec'

const EDIT_TOOLS = new Set(['write_file', 'edit_file'])
const EXEC_TOOLS = new Set<string>(['run_command']) // 执行类：命令行（受策略层 + 权限闸门约束）

export function toolCategory(name: string): ToolCategory {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (EXEC_TOOLS.has(name)) return 'exec'
  return 'read'
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

/** 把工具参数里的 path 解析为绝对路径并校验受信根。 */
function resolvePath(root: string | null, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error('缺少有效的 path 参数')
  const abs = isAbsolute(p) ? resolve(p) : root ? join(root, p) : resolve(p)
  assertInside(abs)
  return abs
}

/** 目标为「目录」的路径类工具（授权粒度取目录本身，而非其父目录）。 */
const DIR_TARGET_TOOLS = new Set(['list_dir', 'glob', 'grep'])
/** 目标为「文件」的路径类工具（授权粒度取父目录）。 */
const FILE_TARGET_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])

/**
 * 「项目外访问」预检：若该工具调用要访问的目标落在受信根之外，返回其绝对路径 abs 与
 * 建议信任目录 dir；否则 null。路径解析规则与 resolvePath 完全一致（相对路径基于项目根），
 * 以保证「预检判定在外 → 授权加根 → 执行时 assertInside 必过」的一致性。
 * dir：目录类工具取目标目录本身，文件类工具取其父目录（契合 isInsideRoot 的子树前缀语义）。
 * web_fetch 无 path、run_command 的 cwd 单独在执行处校验，均返回 null（走常规闸门）。
 */
export function outsideRootTarget(
  name: string,
  args: unknown,
  root: string | null
): { abs: string; dir: string } | null {
  const isDir = DIR_TARGET_TOOLS.has(name)
  if (!isDir && !FILE_TARGET_TOOLS.has(name)) return null
  const a = (args ?? {}) as Record<string, unknown>
  const p = a.path
  // glob/grep 缺 path 时回落项目根（在根内，不触发）；文件类缺 path 交由执行处报参数错。
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = isAbsolute(p) ? resolve(p) : root ? join(root, p) : resolve(p)
  if (isInsideRoot(abs)) return null
  return { abs, dir: isDir ? abs : dirname(abs) }
}

/** 解析「搜索根目录」：给了 path 用之，否则回落项目根；两者皆缺则报错。 */
function resolveDir(root: string | null, p: unknown): string {
  if (typeof p === 'string' && p.trim()) return resolvePath(root, p)
  if (!root) throw new Error('未打开项目，且未提供 path')
  assertInside(root)
  return resolve(root)
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
      const abs = resolvePath(ctx.workspaceRoot, a.path)
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
      const lines = buf.toString('utf8').split('\n')
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
      const abs = resolvePath(ctx.workspaceRoot, a.path)
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
      const dir = resolveDir(ctx.workspaceRoot, a.path)
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
      const dir = resolveDir(ctx.workspaceRoot, a.path)
      let globRe: RegExp | null = null
      if (typeof a.glob === 'string' && a.glob.trim()) globRe = globToRegExp(a.glob.trim())
      const files = await collectFiles(dir)
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
        const lines = buf.toString('utf8').split('\n')
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
      const abs = resolvePath(ctx.workspaceRoot, a.path)
      const content = typeof a.content === 'string' ? a.content : ''
      await fs.writeFile(abs, content, 'utf8')
      return { content: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节`, summary: '已写入' }
    }

    if (name === 'edit_file') {
      const abs = resolvePath(ctx.workspaceRoot, a.path)
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
      // 统计出现次数（非重叠）：唯一性是精确编辑的安全前提。
      let count = 0
      for (let idx = text.indexOf(oldStr); idx !== -1; idx = text.indexOf(oldStr, idx + oldStr.length))
        count++
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
      await fs.writeFile(abs, text.split(oldStr).join(newStr), 'utf8')
      const n = replaceAll ? count : 1
      return { content: `已替换 ${n} 处`, summary: replaceAll ? `已替换 ${n} 处` : '已编辑' }
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

    return { content: `未知工具：${name}`, summary: '未知工具', isError: true }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { content: `工具执行失败：${msg}`, summary: '失败', isError: true }
  }
}
