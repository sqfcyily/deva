import { promises as fs, type Dirent } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { assertInside } from './fs-guard'
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
  }
]

/** 工具敏感度分类，供权限闸门判定：read 恒放行，edit=项目内写入，exec=执行类（预留）。 */
export type ToolCategory = 'read' | 'edit' | 'exec'

const EDIT_TOOLS = new Set(['write_file', 'edit_file'])
const EXEC_TOOLS = new Set<string>([]) // 预留：run_command / 终端等执行类工具（Phase 3）

export function toolCategory(name: string): ToolCategory {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (EXEC_TOOLS.has(name)) return 'exec'
  return 'read'
}

export interface ToolContext {
  workspaceRoot: string | null
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

    return { content: `未知工具：${name}`, summary: '未知工具', isError: true }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    return { content: `工具执行失败：${msg}`, summary: '失败', isError: true }
  }
}
