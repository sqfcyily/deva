/**
 * 按需加载的工具（tool_search）：不常用、说明又长的工具，工具表里只放一句话描述与参数骨架（参数名、类型、
 * 可选值、必填项），完整说明与各参数的含义由 tool_search 按名称取回。
 *
 * 工具仍留在工具表里、按原名直接调用：工具表排在提示缓存前缀的最前面，查到后再往表里加工具会让整段对话的
 * 缓存失效；改成经通用入口代调又失去服务端按 schema 的参数约束。骨架与用法都由完整定义生成，完整定义是唯一来源。
 *
 * 没查用法就直接调用：不执行，结果里附上完整用法，模型照着重调即可（被拦一次就等于查过一次）。
 * 用法是否已在上下文里从历史折叠（listing.ts guidesAnnounced）：压缩 / 删轮抹掉后再调用会被拦一次，用法随之补上。
 * 界面上被拦下的调用画成一步「查看用法」，不画失败，也不铸名片（见 chat.ts 的工具循环与 toDisplayMessages）。
 */
import type { ListingRecord, Message, ToolSpec } from '../providers/types'
import { guideRecord, guidesAnnounced } from './listing'

export const TOOL_SEARCH = 'tool_search'

/** tool_search 成功、以及被拦下的调用在界面上的摘要（时间轴不显示它，见渲染层 QUIET_TOOLS）。 */
export const USAGE_SUMMARY = '已查看用法'

interface DeferredTool {
  spec: ToolSpec
  brief: string
  guide?: string
}

const deferred = new Map<string, DeferredTool>()

const LOOKUP_HINT = '调用前先用 tool_search 查看用法。'

/** 参数骨架：去掉各层说明文字，只留结构。properties 下的键是参数名（可能就叫 description），原样保留。 */
function skeleton(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(skeleton)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description') continue
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, skeleton(s)]))
        : skeleton(v)
  }
  return out
}

/**
 * 登记一个按需加载的工具，返回工具表里用的版本：一句话描述（写清做什么、什么时候用）+ 参数骨架。
 * guide：参数之外的补充说明，随用法一并给出。
 */
export function deferTool(spec: ToolSpec, brief: string, guide?: string): ToolSpec {
  deferred.set(spec.name, { spec, brief, guide })
  return {
    name: spec.name,
    description: `${brief}${LOOKUP_HINT}`,
    inputSchema: skeleton(spec.inputSchema) as Record<string, unknown>
  }
}

/** 工具表里有按需加载的工具时才需要带上 tool_search。 */
export function hasDeferredTools(tools: ToolSpec[]): boolean {
  return tools.some((t) => deferred.has(t.name))
}

/** 逐个列出参数及其含义；对象参数与对象数组缩进列出其字段。 */
function paramLines(schema: unknown, indent: string): string[] {
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: unknown; items?: unknown }
  if (!s.properties) return s.items ? paramLines(s.items, indent) : []
  const required = new Set(Array.isArray(s.required) ? s.required : [])
  const lines: string[] = []
  for (const [name, raw] of Object.entries(s.properties)) {
    const desc = (raw as { description?: unknown } | null)?.description
    const tag = required.has(name) ? '（必填）' : ''
    lines.push(`${indent}- ${name}${tag}${typeof desc === 'string' && desc ? `：${desc}` : ''}`)
    lines.push(...paramLines(raw, `${indent}  `))
  }
  return lines
}

/** 完整用法：原完整描述 + 各参数的含义 + 补充说明。不是按需加载的工具返回 null。 */
export function toolUsage(name: string): string | null {
  const d = deferred.get(name)
  if (!d) return null
  const lines = [`【${name} 用法】`, d.spec.description]
  const params = paramLines(d.spec.inputSchema, '')
  if (params.length) lines.push('参数：', ...params)
  if (d.guide) lines.push('补充说明：', d.guide)
  return lines.join('\n')
}

export function buildToolSearchTool(): ToolSpec {
  return {
    name: TOOL_SEARCH,
    description:
      '查看按需加载工具的完整用法（工具说明与各参数的含义）。工具描述里写着「调用前先用 tool_search 查看用法」的工具，第一次调用前先用本工具查看；查过的用法在上文仍可见时不必再查。可一次查看多个。',
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '要查看的工具名，如 ["browser"]。'
        }
      },
      required: ['names']
    }
  }
}

/** 本次请求的工具表里、用法还不在上下文里的按需加载工具。 */
export function unknownUsages(history: Message[], offered: Set<string>): Set<string> {
  const known = guidesAnnounced(history)
  return new Set([...deferred.keys()].filter((n) => offered.has(n) && !known.has(n)))
}

/** tool_search 调用里要查的工具名（规范成登记时的大小写）。 */
export function searchedNames(args: unknown): string[] {
  const raw = (args as { names?: unknown } | null)?.names
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const names = list
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map((n) => {
      const t = n.trim()
      return [...deferred.keys()].find((k) => k.toLowerCase() === t.toLowerCase()) ?? t
    })
  return [...new Set(names)]
}

export interface UsageResult {
  content: string
  summary: string
  isError: boolean
  listing?: ListingRecord
}

/** 执行 tool_search：只给本次工具表里有的按需加载工具。 */
export function runToolSearch(args: unknown, offered: Set<string>): UsageResult {
  const found: { key: string; text: string }[] = []
  const notes: string[] = []
  for (const name of searchedNames(args)) {
    const usage = offered.has(name) ? toolUsage(name) : null
    if (usage) found.push({ key: name, text: usage })
    else if (offered.has(name)) notes.push(`「${name}」的完整说明已在工具表里，直接调用即可。`)
    else if (deferred.has(name)) notes.push(`「${name}」在当前对话中不可用。`)
    else notes.push(`没有名为「${name}」的工具。`)
  }
  if (found.length)
    return {
      content: [...found.map((f) => f.text), ...notes].join('\n\n'),
      summary: USAGE_SUMMARY,
      isError: false,
      listing: guideRecord(found)
    }
  const available = [...deferred.values()]
    .filter((d) => offered.has(d.spec.name))
    .map((d) => `- ${d.spec.name}：${d.brief}`)
  return {
    content: [
      ...(notes.length ? notes : ['没有给出要查看的工具名。']),
      ...(available.length ? ['可查看用法的工具：', ...available] : [])
    ].join('\n'),
    summary: '未找到该工具',
    isError: true
  }
}

const GATE_PREFIX = '未执行：调用前需先查看用法。'

/** 历史里的这条结果是不是「没查用法就调用」被拦下的（重开对话时据此画成「查看用法」）。 */
export function isUsageGateResult(content: string): boolean {
  return content.startsWith(GATE_PREFIX)
}

/**
 * 没查用法就调用：不执行，附上完整用法请模型重调。given：用法已在本步的其他结果里给出（同一步的 tool_search、
 * 先一个被拦下的调用或加载的技能），只提示去看，不重复附。
 */
export function usageGateResult(name: string, given: boolean): { content: string; listing?: ListingRecord } {
  if (given) return { content: `${GATE_PREFIX}「${name}」的用法已在本步的其他结果里给出，请阅读后按用法重新调用。` }
  const usage = toolUsage(name) ?? ''
  return {
    content: `${GATE_PREFIX}以下是「${name}」的完整用法（无需再用 tool_search 查看），请按用法重新调用。\n\n${usage}`,
    listing: guideRecord([{ key: name, text: usage }])
  }
}

/**
 * 加载技能时一并给出它 allowed-tools 里、用法还没给过的按需加载工具的用法：内置的创建技能 / 创建角色 /
 * 接入 MCP 等技能接着就要调用这些工具，省得再查一步。pending：本步还没给过用法的工具。
 */
export function skillToolUsages(
  allowedTools: string[],
  pending: Set<string>
): { text: string; names: string[]; listing: ListingRecord } | null {
  const entries = [...new Set(allowedTools)]
    .filter((n) => pending.has(n))
    .map((n) => ({ key: n, text: toolUsage(n) ?? '' }))
    .filter((e) => e.text)
  if (!entries.length) return null
  return {
    text: `本技能用到的工具用法：\n\n${entries.map((e) => e.text).join('\n\n')}`,
    names: entries.map((e) => e.key),
    listing: guideRecord(entries)
  }
}
