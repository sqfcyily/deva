import type { ToolSpec } from '../providers/types'
import type { ToolContext, ToolResult } from './tools'
import {
  GLOBAL_SCOPE,
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  MEMORY_TYPES,
  deleteMemory,
  formatMemoryLine,
  isMemoryType,
  listMemories,
  memoryTypeLabel,
  scopeKindOfId,
  scopeLabel,
  type MemoryAccess,
  type MemoryEntry,
  type MemoryInput,
  type MemoryScope
} from './memory'
import { memoryDeletedRecord, memoryWrittenRecord } from './listing'
import { writeMemoryWithConsolidation } from './memory-consolidate'

/**
 * 记忆工具 memory_read / memory_write / memory_delete（方案 design/memory-v2-plan.html 第 6 节）：规格与执行。
 * 在 tools.ts 的工具表与 toolHandlers 里登记。各层能否写看本轮的 MemoryAccess（ToolContext.memoryAccess，由回合设置）。
 */

const SCOPES = ['global', 'role', 'project'] as const
type ScopeKind = (typeof SCOPES)[number]

export const MEMORY_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'memory_read',
    description:
      '读取记忆。带 ids：返回这些条目的类型、标题与正文；不带：返回全局、本角色、当前项目各层的完整索引。' +
      '记忆索引已由系统随对话消息附带（做事方式类附了正文）；处理与某条记忆相关的任务前，用它按 id 读取那条的正文。',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要读取正文的记忆 id（如 m_1a2b3c4d / r_1a2b3c4d / p_1a2b3c4d）；省略则返回完整索引。'
        }
      }
    }
  },
  {
    name: 'memory_write',
    description:
      '写入或更新一条长期记忆。每条有类型 type、一句话标题 title 和正文 body。' +
      'type：user = 用户的身份、职责、熟悉什么、偏好；feedback = 用户纠正过或确认过的做事方式（正文先写规则，再写「原因：」「何时适用：」各一行）；' +
      'project = 代码和文档里看不出来的进行中工作、决定、截止日期（日期写具体日期）；reference = 外部资料、工具在哪、做什么用。' +
      'scope：global = 用户本人、对所有角色都适用；role = 你这个角色做自己这类工作的经验；project = 只在当前工作区有用（须已挂载工作区）。' +
      '不带 id 为新增（type、title 必填）；带已有 id 为更新，省略的字段保持原值，scope 可省略（按 id 前缀定位：m_ 全局、r_ 角色、p_ 项目）。同一主题请带 id 更新，不要重复新增。' +
      '**必须**在写本轮最终回复之前调用（先记再回复，回复里顺带告知），严禁写完回复再补记——回复之后的调用会让整段回复被界面收进过程里。' +
      `标题 ≤${MEMORY_TITLE_MAX} 字，正文 ≤${MEMORY_BODY_MAX} 字；不得记录密码、密钥等敏感信息或一次性任务细节。写满时系统会先自动归纳旧条目再写入，结果里会说明。` +
      '请始终用本工具写入记忆（会做去重与上限校验），不要用 write_file 等直接改记忆文件。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '可选：要更新的已有记忆 id；省略则新增。' },
        scope: {
          type: 'string',
          enum: [...SCOPES],
          description: '写到哪一层：global / role / project。新增时省略即 global（项目成员为 project）；带 id 更新时可省略。'
        },
        type: { type: 'string', enum: [...MEMORY_TYPES], description: '类型：user / feedback / project / reference。新增时必填。' },
        title: { type: 'string', description: `一句话标题（≤${MEMORY_TITLE_MAX} 字），只看标题就能判断与什么任务相关。新增时必填。` },
        body: {
          type: 'string',
          description: '正文：事实或规则；feedback / project 类再写「原因：」「何时适用：」各一行。'
        }
      }
    }
  },
  {
    name: 'memory_delete',
    description:
      '删除一条记忆（用户要求忘记、或该记忆已过时、与新的要求或代码现状矛盾时使用）。按 id 前缀定位：m_ 全局、r_ 角色、p_ 项目。' +
      '同样**必须**在写本轮最终回复之前调用，严禁写完回复再补删。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的记忆 id。' }
      },
      required: ['id']
    }
  }
]

const NO_ACCESS: ToolResult = { content: '当前对话不能使用记忆。', summary: '不可用', isError: true }

function modeOf(kind: ScopeKind, access: MemoryAccess): 'rw' | 'ro' {
  return kind === 'global' ? access.global : kind === 'role' ? access.role.mode : access.project
}

/** 某层对应的作用域；项目层没挂载工作区时为 null。 */
function scopeOf(kind: ScopeKind, access: MemoryAccess, ctx: ToolContext): MemoryScope | null {
  if (kind === 'global') return GLOBAL_SCOPE
  if (kind === 'role') return { kind: 'role', personaId: access.role.personaId }
  return ctx.workspaceRoot ? { kind: 'project', root: ctx.workspaceRoot } : null
}

function layerName(kind: ScopeKind, access: MemoryAccess, ctx: ToolContext): string {
  return kind === 'global'
    ? '全局记忆'
    : kind === 'role'
      ? `角色记忆（${access.role.name}）`
      : `项目记忆（${ctx.workspaceRoot ?? '未挂载工作区'}）`
}

function readOnlyError(kind: ScopeKind, access: MemoryAccess): ToolResult {
  const why =
    kind === 'global'
      ? '全局记忆（用户本人的通用偏好）对你只读，由主对话的角色来记'
      : kind === 'role'
        ? `「${access.role.name}」的角色记忆对你只读，由这个角色在自己的对话里记`
        : '项目记忆对你只读'
  const can = SCOPES.filter((k) => modeOf(k, access) === 'rw')
  return {
    content: `${why}。${can.length ? `你可以写：${can.join(' / ')}。` : '本次执行中记忆全部只读。'}`,
    summary: '未写入',
    isError: true
  }
}

function fullEntry(e: MemoryEntry, where: string): string {
  return [`[${e.id}] ${memoryTypeLabel(e.type)} · ${e.title}（${where}）`, e.body || '（无正文）'].join('\n')
}

export async function memoryReadTool(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const access = ctx.memoryAccess
  if (!access) return NO_ACCESS
  const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
  if (ids.length) {
    const out: string[] = []
    let found = 0
    for (const raw of ids) {
      const id = raw.trim()
      const kind = scopeKindOfId(id)
      const scope = scopeOf(kind, access, ctx)
      const hit = scope ? listMemories(scope).find((e) => e.id === id) : undefined
      if (hit) {
        found++
        out.push(fullEntry(hit, layerName(kind, access, ctx)))
      } else out.push(`[${id}] 不存在${scope ? '' : '（当前未挂载工作区，无法读取项目记忆）'}`)
    }
    return { content: out.join('\n\n'), summary: `${found} 条` }
  }
  const out: string[] = []
  let total = 0
  for (const kind of SCOPES) {
    const scope = scopeOf(kind, access, ctx)
    if (!scope) continue
    const entries = listMemories(scope)
    total += entries.length
    out.push(`【${layerName(kind, access, ctx)}】`, ...(entries.length ? entries.map(formatMemoryLine) : ['（暂无）']), '')
  }
  if (!ctx.workspaceRoot) out.push('（未挂载工作区，无项目记忆）')
  out.push('正文用 memory_read 带 ids 读取。')
  return { content: out.join('\n').trim(), summary: `${total} 条` }
}

export async function memoryWriteTool(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const access = ctx.memoryAccess
  if (!access) return NO_ACCESS
  const id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : undefined
  const explicit = SCOPES.find((k) => k === a.scope)
  // 省略 scope：带 id 按前缀定位；新增默认全局，全局只读时（项目成员）默认项目。
  const kind: ScopeKind =
    explicit ?? (id ? scopeKindOfId(id) : access.global === 'rw' ? 'global' : access.project === 'rw' ? 'project' : 'role')
  if (id && scopeKindOfId(id) !== kind)
    return {
      content: `id ${id} 属于${layerName(scopeKindOfId(id), access, ctx)}，与所给 scope 不符：更新时可省略 scope，按 id 自动定位；如要换层，请删除原条目后在新的一层新增。`,
      summary: '参数无效',
      isError: true
    }
  if (modeOf(kind, access) !== 'rw') return readOnlyError(kind, access)
  const scope = scopeOf(kind, access, ctx)
  if (!scope)
    return {
      content: id
        ? `${id} 是项目记忆，但当前未挂载工作区，无法定位`
        : '当前未挂载工作区，无法写入项目记忆：请改写到 global 或 role，或请用户先挂载项目。',
      summary: '未写入',
      isError: true
    }
  if (a.type !== undefined && !isMemoryType(a.type))
    return { content: `type 无效：只能是 ${MEMORY_TYPES.join(' / ')}。`, summary: '参数无效', isError: true }
  const input: MemoryInput = {
    ...(isMemoryType(a.type) ? { type: a.type } : {}),
    ...(typeof a.title === 'string' ? { title: a.title } : {}),
    ...(typeof a.body === 'string' ? { body: a.body } : {})
  }
  // 直调主进程 memory 服务（去重 + 上限在服务内校验）；撞上限时先自动归纳旧条目再写。
  const w = await writeMemoryWithConsolidation(input, id, scope, ctx.memoryModel, ctx.signal)
  const r = w.result
  const c = w.consolidated
  const note = c
    ? `${scopeLabel(scope)}已写满，已自动归纳：${c.before.count} 条 / 索引 ${c.before.used} 字 → ${c.after.count} 条 / 索引 ${c.after.used} 字（归纳前的内容已备份到 ${c.backup}；变化会随下一条消息的【记忆更新】告知）。\n`
    : ''
  if (!r.ok)
    return {
      content: `${note}${r.error}${w.failure ? `（自动归纳未成功：${w.failure}）` : ''}`,
      summary: '未写入',
      isError: true
    }
  // 本结果即告知：挂上记录，记忆索引折叠时视这条为已告知，不再随后重复附带。
  const verb = r.created ? '已记住' : id ? '已更新记忆' : '该记忆已存在'
  return {
    content: `${note}${verb}（${layerName(kind, access, ctx)}）：${formatMemoryLine(r.entry)}`,
    summary: c ? '已归纳并记住' : r.created ? '已记住' : id ? '已更新' : '已存在',
    listing: memoryWrittenRecord(r.entry)
  }
}

export async function memoryDeleteTool(a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const access = ctx.memoryAccess
  if (!access) return NO_ACCESS
  const id = typeof a.id === 'string' ? a.id.trim() : ''
  if (!id) return { content: '缺少要删除的记忆 id', summary: '参数无效', isError: true }
  const kind = scopeKindOfId(id)
  if (modeOf(kind, access) !== 'rw') return { ...readOnlyError(kind, access), summary: '未删除' }
  const scope = scopeOf(kind, access, ctx)
  if (!scope) return { content: `${id} 是项目记忆，但当前未挂载工作区，无法定位`, summary: '未找到', isError: true }
  const removed = deleteMemory(id, scope)
  if (!removed)
    return { content: `不存在 id 为 ${id} 的记忆（可先用 memory_read 查看）`, summary: '未找到', isError: true }
  return {
    content: `已删除记忆（${layerName(kind, access, ctx)}）：${formatMemoryLine(removed)}`,
    summary: '已删除',
    listing: memoryDeletedRecord(removed.id)
  }
}
