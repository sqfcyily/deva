import type { TodoStatus, TodoItem, TodoList, TodoState } from '../../shared/chat-protocol'
/**
 * 待办清单（todo_write）· 纯函数，零依赖。
 *
 * 模型在多步任务（尤其是计划获批后）用 todo_write 列出并逐项勾选任务清单；界面在输入框上方以胶囊条显示
 * 当前进度（最多一个：正在进行的那个清单），点开看它的全部条目；清单全部完成后胶囊收起，改在对话流里落一张
 * 「已完成清单」卡。较早的清单不再单独展示。
 *
 * **存储＝写入日志**：每次 todo_write 记一条完整快照（todo_write 本就是整表覆盖），按 toolUseId 记录，
 * 同 asks / plans 边车。清单状态由日志折叠得出：同 listId 的最后一条快照即该清单现状。这样：
 *  · 压缩改写 messages 不影响清单（状态在边车里，不依赖 tool_use 还在不在历史里）；
 *  · 按轮删除 / 回滚只需删掉被删轮里那几次写入的快照，再折叠即回到删轮前的状态。
 * 「新开清单 / 更新当前清单」在写入时就判定好并记进 listId，重新折叠结果确定。
 *
 * **取消**：任务中途被暂停、此后不再进行的清单，记进「已取消」集合（StoredSession.todoCancelled），胶囊随之
 * 收起。两条路径：模型调 todo_write 传 cancel: true（新一轮开始时仍留着上一轮未完成的清单，会在该轮用户消息
 * 里提醒模型取舍，见 todoReminderText）；或用户在清单面板里手动取消（下一条消息告知模型，见 todoUserCancelNote）。
 * **不做**「本轮没更新就自动取消」：顺带问一句的回合模型不会碰清单，会误取消。
 * 模型此后又写入该清单（条目有重合）则视为恢复，移出已取消集合。
 *
 * 清单是**纯展示产物**：不写进 messages、不进模型上下文（模型自己的 tool_use 入参已记着它写过什么）；
 * 例外：压缩——被压掉的 tool_use 带走了清单，故把未完成的当前清单附在摘要后面（todoSnapshotText）；
 * 以及上面那两条随用户消息带给模型的提醒。
 */

export type { TodoStatus } from '../../shared/chat-protocol'

export type { TodoItem } from '../../shared/chat-protocol'

/** 一次 todo_write 的快照（StoredSession.todos 的元素）。 */
export interface TodoEntry {
  /** 该次 todo_write 的 toolUseId。 */
  id: string
  /** 所属清单。新开清单时取 `l_<toolUseId>`，此后的更新沿用。 */
  listId: string
  at: number
  /** 清单标题（新开时由模型给出；更新时可改，缺省沿用）。可为空串，界面回落通用名。 */
  title: string
  items: TodoItem[]
  /** 本次写入令该清单变成「全部完成」：对话流在这次调用处画「已完成清单」卡（重复写入不重复画）。 */
  done?: true
}

export type { TodoList } from '../../shared/chat-protocol'

export type { TodoState } from '../../shared/chat-protocol'

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])
/** 单个清单的条目上限：防模型把整份计划逐行塞进来，清单失去「一眼看进度」的意义。 */
const MAX_ITEMS = 50
const MAX_CONTENT = 200
const MAX_TITLE = 60

export function isListDone(items: TodoItem[]): boolean {
  return items.length > 0 && items.every((x) => x.status === 'completed')
}

/** 日志 → 清单（按首次出现的先后排列；每个清单取其最后一条快照）。 */
export function foldTodos(entries: TodoEntry[] = []): TodoList[] {
  const byId = new Map<string, TodoList>()
  for (const e of entries) {
    const cur = byId.get(e.listId)
    if (cur) {
      cur.items = e.items
      if (e.title) cur.title = e.title
      cur.updatedAt = e.at
    } else {
      byId.set(e.listId, { id: e.listId, title: e.title, items: e.items, createdAt: e.at, updatedAt: e.at })
    }
  }
  return [...byId.values()]
}

/**
 * 当前清单：最近一个清单，且尚未全部完成、也没被取消。全部完成的清单已在对话流里落成卡片，
 * 取消的清单不再进行，胶囊都随之收起。
 */
export function activeTodoList(entries: TodoEntry[] = [], cancelled: string[] = []): TodoList | null {
  const lists = foldTodos(entries)
  const last: TodoList | undefined = lists[lists.length - 1]
  return last && !isListDone(last.items) && !cancelled.includes(last.id) ? last : null
}

export function todoState(entries: TodoEntry[] = [], cancelled: string[] = []): TodoState {
  return { active: activeTodoList(entries, cancelled) }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** 解析 todo_write 入参；不合法返回给模型看的错误说明。 */
export function parseTodoInput(
  input: unknown
): { title: string; items: TodoItem[]; newList: boolean } | { cancel: true } | { error: string } {
  const a = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (a.cancel === true) return { cancel: true }
  if (!Array.isArray(a.todos)) return { error: 'todos 必须是数组：[{ content, status }]（取消清单请传 cancel: true）。' }
  const items: TodoItem[] = []
  for (const raw of a.todos) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const content = str(r.content).slice(0, MAX_CONTENT)
    if (!content) continue
    const status = STATUSES.has(r.status as TodoStatus) ? (r.status as TodoStatus) : 'pending'
    items.push({ content, status })
  }
  if (items.length === 0)
    return { error: 'todos 不能为空：至少给出一项 { content, status }（取消清单请传 cancel: true）。' }
  if (items.length > MAX_ITEMS)
    return { error: `清单最多 ${MAX_ITEMS} 项，请合并为更粗粒度的步骤后重写。` }
  return { title: str(a.title).slice(0, MAX_TITLE), items, newList: a.new_list === true }
}

/**
 * 应用一次 todo_write：
 *  · cancel → 返回要取消的当前清单 id（没有进行中的清单时为 null）；
 *  · 否则判定新开还是更新当前清单，产出要追加进日志的快照。新开清单：显式 new_list / 还没有清单 / 当前清单
 *    已全部完成或已取消，且新条目与它毫无重合（一项内容都对不上，说明是另一件事；有重合则是模型在原清单上
 *    继续——追加后续步骤或恢复已取消的清单，仍算同一个清单）。其余一律更新当前清单。
 */
export function applyTodoWrite(
  entries: TodoEntry[] = [],
  cancelled: string[] = [],
  id: string,
  input: unknown,
  now: number
): TodoEntry | { cancel: string | null } | { error: string } {
  const p = parseTodoInput(input)
  if ('error' in p) return p
  if ('cancel' in p) return { cancel: activeTodoList(entries, cancelled)?.id ?? null }
  const lists = foldTodos(entries)
  const cur: TodoList | undefined = lists[lists.length - 1]
  const overlap = (a: TodoItem[], b: TodoItem[]): boolean => {
    const set = new Set(a.map((x) => x.content))
    return b.some((x) => set.has(x.content))
  }
  const closed = (l: TodoList): boolean => isListDone(l.items) || cancelled.includes(l.id)
  const base = p.newList || !cur || (closed(cur) && !overlap(cur.items, p.items)) ? null : cur
  const done = isListDone(p.items) && (!base || !isListDone(base.items))
  return {
    id,
    listId: base ? base.id : `l_${id}`,
    at: now,
    title: p.title || (base ? base.title : ''),
    items: p.items,
    ...(done ? { done: true as const } : {})
  }
}

/** 回灌给模型的 tool_result 正文。 */
export function todoResultText(entry: TodoEntry): string {
  const total = entry.items.length
  const finished = entry.items.filter((x) => x.status === 'completed').length
  if (finished === total) return `清单已全部完成（${finished}/${total}）。`
  const doing = entry.items.filter((x) => x.status === 'in_progress').length
  const hint =
    doing === 0
      ? '当前没有进行中的项：开始下一项前先把它标为 in_progress。'
      : doing > 1
        ? '同一时刻只应有一项 in_progress，请收敛为一项。'
        : '继续推进：完成一项立即标为 completed，再开始下一项。'
  return `已更新待办清单（已完成 ${finished}/${total}）。${hint}`
}

/** 清单条目的纯文本形态（[x] 已完成 / [~] 进行中 / [ ] 待办），供压缩摘要与跨轮提醒。 */
function listLines(list: TodoList): string {
  const mark: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
  return list.items.map((x) => `- ${mark[x.status]} ${x.content}`).join('\n')
}

/** 压缩摘要后附的当前清单（模型从此只能从摘要里知道清单进度）。无进行中的清单返回空串。 */
export function todoSnapshotText(entries: TodoEntry[] = [], cancelled: string[] = [], zh: boolean): string {
  const cur = activeTodoList(entries, cancelled)
  if (!cur) return ''
  const head = zh
    ? `【当前待办清单${cur.title ? `：${cur.title}` : ''}】（[x] 已完成 / [~] 进行中 / [ ] 待办；继续用 todo_write 更新）`
    : `[Current todo list${cur.title ? `: ${cur.title}` : ''}] ([x] done / [~] in progress / [ ] pending; keep updating it with todo_write)`
  return `${head}\n${listLines(cur)}`
}

/**
 * 新一轮开始时仍留着上一轮未完成的清单（多为任务被暂停）：随本轮用户消息带给模型的提醒，请它取舍——
 * 继续就更新，不再进行就取消。无进行中的清单返回空串。
 */
export function todoReminderText(entries: TodoEntry[] = [], cancelled: string[] = []): string {
  const cur = activeTodoList(entries, cancelled)
  if (!cur) return ''
  const done = cur.items.filter((x) => x.status === 'completed').length
  return (
    `【待办清单提醒】此前留有一个未完成的待办清单${cur.title ? `「${cur.title}」` : ''}（已完成 ${done}/${cur.items.length}）：\n` +
    `${listLines(cur)}\n` +
    '若本轮继续这项任务，请照常用 todo_write 更新它；若用户已转向别的事、不再进行它，请调用 todo_write 并传 cancel: true 取消。'
  )
}

/** 用户在面板里手动取消了清单：随下一条用户消息告知模型，免得它不知情又把清单写回来。 */
export function todoUserCancelNote(list: TodoList): string {
  return (
    `【待办清单】用户已手动取消待办清单${list.title ? `「${list.title}」` : ''}，不要再继续更新它；` +
    '之后若要开始新的多步骤任务，请用 todo_write 传 new_list: true 另建清单。'
  )
}
