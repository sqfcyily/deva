/**
 * 把 provider 消息记录归约成渲染层的展示消息（重开对话时重建对话流）。
 */
import type { AttachmentChip, DisplayBlock, DisplayMessage } from '../../shared/chat-protocol'
import { basename } from 'node:path'
import { type ContentPart, type Message } from '../providers/types'
import { TOOL_SEARCH, USAGE_SUMMARY, isUsageGateResult } from './tool-search'
import { MEMBER_NOTICE_TAG, MEMBER_TASK_MARKER, parseTaskMessage } from './members'
import { normalizeAgentDraft, normalizeAutotaskDraft } from '../../shared/drafts'
import {
  GENERAL_SUBAGENT
} from './subagents'
import { getSubagentMeta, subagentIdFor } from './subagent-store'
import {
  parseHandoff
} from './handoff'
import {
  type TodoEntry
} from './todos'
import { getSession, save as saveProject, type StoredNotice, type StoredSession } from './chat-store'
import {
  ATTACH_FOLDER_PREFIX,
  ATTACH_PATH_PREFIX,
  ATTACH_TEXT_PREFIX
} from './attachments'
import { isEn } from '../locale'
import {
  displaySummary,
  insertBody,
  isAutoNudge,
  isCompactionSummary,
  isTaskNotification,
  NOTIFY_MARKER
} from './compaction'
import { parseAskQuestions } from './ask-questions'
import { repairDanglingToolUses } from './chat-history'
import {
  TRUNCATED_FLAG
} from './loop-support'
import { busySessions, backgroundSubagents } from './chat-state'

/** base64 串解码后的字节数。 */
function base64Bytes(b64: string): number {
  return Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0))
}

/**
 * 图片附件的 ref。按轮删除后后面的消息下标会前移，同一个「下标:块下标」可能换成另一张图——带上内容指纹
 * （长度 + 中段几个字符，不必整串哈希），取图时对不上就不给，界面按 ref 缓存的缩略图也不会张冠李戴。
 */
export function imageRef(msgIndex: number, partIndex: number, data: string): string {
  const mid = Math.floor(data.length / 2)
  return `${msgIndex}:${partIndex}:${data.length.toString(36)}${data.slice(mid, mid + 8)}`
}

/** 插入成员当前工作的任务消息（见 members.ts）：执行步骤里显示时去掉标记前缀。 */
export function plainTaskText(text: string): string {
  return text.startsWith(MEMBER_TASK_MARKER) ? text.slice(MEMBER_TASK_MARKER.length) : text
}

/** 一条真实用户消息的展示：成员会话里主智能体派来的任务另带 task（见 members.ts），其余原样。 */
function userDisplay(text: string, attachments: AttachmentChip[]): DisplayMessage {
  const t = parseTaskMessage(text)
  if (!t) return { role: 'user', text, attachments }
  return {
    role: 'user',
    text: t.note,
    attachments,
    task: { owner: t.owner, title: t.task, quote: t.quote, note: t.note }
  }
}

/** StoredNotice → 展示块（错误红框 / 弱化提示）。 */
function noticeToBlock(nt: StoredNotice): DisplayBlock {
  if (nt.kind === 'error') return { kind: 'error', message: nt.message ?? (isEn() ? 'Request failed.' : '请求失败。') }
  return { kind: 'notice', code: nt.code ?? 'empty' }
}

/**
 * provider Message[] → 展示消息序列（供切换/重开会话时重建气泡）。
 * 工具结果回灌消息不单独成气泡，而是回填上一条 assistant 的工具卡状态；
 * 附件仅重建为「名称 + 类型」的贴片（不回传 base64）。思考块为易逝态，不重建。
 * `notices` 边车（错误红框 / 截断 / 空回合）按 after 位置就地插回——它们不在 messages 里
 * （不属于模型上下文），此处还原后重开对话即可再见，而不再只剩自己发的消息。
 */
export function toDisplayMessages(
  messages: Message[],
  proposals: Record<string, 'accepted' | 'rejected'> = {},
  notices: StoredNotice[] = [],
  asks: Record<string, { answers: string[] | null }> = {},
  summaries: Record<string, string> = {},
  plans: NonNullable<StoredSession['plans']> = {},
  autotasks: Record<string, { status: 'created' | 'dismissed'; taskId?: string }> = {},
  todos: TodoEntry[] = [],
  /** 子智能体 id → 类型与任务标题（来自子智能体记录索引），给续聊卡补标题。 */
  subagentLookup?: (id: string) => { agent: string; description: string } | undefined,
  background: Record<string, 'running' | 'ok' | 'error'> = {},
  durations: Record<string, number> = {},
  /** messages[0] 在整份对话记录里的下标：只转换末尾几条时（如 emitTurnStart）图片的 ref 仍指向记录里的真实位置。 */
  indexBase = 0
): DisplayMessage[] {
  const out: DisplayMessage[] = []
  /** 正在处理的消息在整份对话记录里的下标（图片附件的 ref 用）。 */
  let curIndex = indexBase
  let lastAssistant: Extract<DisplayMessage, { role: 'assistant' }> | null = null

  // 预扫：收集所有已存在 tool_result 的 toolUseId。用于判定 ask_user 是否「曾被答复过」——
  // 旧数据（本次修复前建的对话）无 asks 边车但有 tool_result，据此仍渲染为已答态（逐题回落「未作答」），
  // 而非误显为一张可再次点选的交互卡。真正从未答复的（无 result 无边车）才留作交互态。
  // 顺带收集每次 run_subagent 派出的子智能体（id 由调用 id 确定性派生），记录已被清理时续聊卡仍能取到标题。
  const resultIds = new Set<string>()
  // 没查用法就调用、被拦下的按需加载工具（见 tool-search.ts）：画成一步「查看用法」（同流式），不画失败、不铸名片。
  const gatedIds = new Set<string>()
  const subagentOrigins = new Map<string, { agent: string; description: string }>()
  for (const m of messages) {
    if (typeof m.content === 'string') continue
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        resultIds.add(p.toolUseId)
        if (isUsageGateResult(p.content)) gatedIds.add(p.toolUseId)
      } else if (p.type === 'tool_use' && p.name === 'run_subagent') {
        const input = (p.input ?? {}) as { agent?: unknown; description?: unknown }
        subagentOrigins.set(subagentIdFor(p.id), {
          agent: typeof input.agent === 'string' && input.agent.trim() ? input.agent.trim() : GENERAL_SUBAGENT.name,
          description: typeof input.description === 'string' ? input.description.trim() : ''
        })
      }
    }
  }
  const lookupSubagent = (id: string): { agent: string; description: string } | undefined =>
    subagentLookup?.(id) ?? subagentOrigins.get(id)
  const todoById = new Map(todos.map((e) => [e.id, e]))

  // after → 该位置应插入的提示（一轮通常至多一条，用数组以防同位置多条）。
  const noticesAfter = new Map<number, StoredNotice[]>()
  for (const nt of notices) {
    const arr = noticesAfter.get(nt.after)
    if (arr) arr.push(nt)
    else noticesAfter.set(nt.after, [nt])
  }
  const flushNotices = (n: number): void => {
    const arr = noticesAfter.get(n)
    if (!arr) return
    for (const nt of arr) {
      // 与流式同形（渲染层把终态提示追加进本轮 assistant 气泡）：前一条展示消息是 assistant 即并入其末尾，
      // 不另起气泡（否则重开后多出一个头像，像一条新回复）；本轮无任何 assistant 输出（前一条是用户气泡）
      // 时才自成一条，同流式那条仅含提示的占位气泡。
      const prev = out[out.length - 1]
      if (prev?.role === 'assistant') prev.blocks.push(noticeToBlock(nt))
      else out.push({ role: 'assistant', blocks: [noticeToBlock(nt)] })
      // 提示锚在回合末，其后紧随新用户轮——断开 tool_result 回填链，避免误填。
      lastAssistant = null
    }
  }

  // 处理单条消息（早退用 return 代替原 for...of 的 continue，以便每条处理完统一 flush 提示）。
  // next = 下一条消息（压缩摘要据此分辨两轮之间 / 一轮进行中）。
  const processOne = (m: Message, next: Message | undefined): void => {
    if (m.role === 'assistant') {
      const parts: ContentPart[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      const blocks: DisplayBlock[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) blocks.push({ kind: 'text', text: p.text })
        else if (p.type === 'tool_use') {
          // propose_agent 铸成角色名片（惰性提议）；ask_user 铸成提问卡（含答复回填）；其余工具照常铸工具卡。
          // 被输出上限截断的调用一律是普通工具卡（与流式一致）：它参数残缺、从未执行，不是能答复的卡。
          const kind = (p.input as Record<string, unknown> | null)?.[TRUNCATED_FLAG] === true ? '' : p.name
          if (gatedIds.has(p.id))
            blocks.push({
              kind: 'tool',
              id: p.id,
              name: TOOL_SEARCH,
              args: { names: [p.name] },
              status: 'ok',
              summary: USAGE_SUMMARY
            })
          else if (kind === 'propose_agent')
            blocks.push({
              kind: 'agentcard',
              id: p.id,
              draft: normalizeAgentDraft(p.input),
              status: proposals[p.id] ?? 'pending'
            })
          else if (kind === 'create_task')
            blocks.push({
              kind: 'autotaskcard',
              id: p.id,
              draft: normalizeAutotaskDraft(p.input),
              status: autotasks[p.id]?.status ?? 'pending',
              taskId: autotasks[p.id]?.taskId
            })
          else if (kind === 'ask_user')
            blocks.push({
              kind: 'ask',
              id: p.id,
              questions: parseAskQuestions(p.input),
              // 有边车 → 用边车答复（null=取消）；无边车但有 tool_result（旧数据）→ 空数组占位，
              // 逐题回落「未作答」；两者皆无（真正未答复）→ undefined，重开后仍是可交互卡。
              answers: asks[p.id] ? asks[p.id].answers : resultIds.has(p.id) ? [] : undefined
            })
          else if (kind === 'exit_plan')
            blocks.push({
              kind: 'plan',
              id: p.id,
              plan: typeof (p.input as { plan?: unknown })?.plan === 'string'
                ? ((p.input as { plan: string }).plan)
                : '',
              // 有边车 → 用边车决定（null = 中止/取消 → cancelled）；无边车但有 tool_result（旧数据）→
              // 视为已决（keep）占位；两者皆无（回合半途夭折）→ cancelled。一律终态、只读。
              decision: plans[p.id]
                ? (plans[p.id].decision ?? 'cancelled')
                : resultIds.has(p.id)
                  ? 'keep'
                  : 'cancelled',
              ...(plans[p.id]?.feedback ? { feedback: plans[p.id].feedback } : {})
            })
          else if (kind === 'todo_write') {
            // 只有令清单全部完成的那次写入落成「已完成清单」卡；其余写入不画（进度在胶囊里）。
            const e = todoById.get(p.id)
            if (e?.done) blocks.push({ kind: 'todolist', id: p.id, title: e.title, items: e.items })
          } else
            blocks.push({
              kind: 'tool',
              id: p.id,
              name: p.name,
              args:
                kind === 'run_subagent' || kind === 'send_to_subagent'
                  ? subagentDisplayArgs(kind, p.input, lookupSubagent, background[p.id] !== undefined)
                  : p.input,
              status: 'ok',
              summary: summaries[p.id]
            })
        }
      }
      // 同一轮内、仅被 tool_result 隔开的连续 assistant 段并入上一条展示气泡（与流式「一轮一头像」对齐）：
      // 有工具调用时，一轮在持久化历史里是多条 assistant 被 tool_result(user) 隔开，逐条成气泡会让重开后
      // 每段各显一个头像（像输出了多次）。lastAssistant 非空即代表「自上条 assistant 起只隔了 tool_result
      // 回灌」——真实用户轮 / 压缩摘要 / 提示气泡都会把它置空，从而使其后的 assistant 另起新气泡（新头像）。
      if (lastAssistant) {
        lastAssistant.blocks.push(...blocks)
      } else {
        const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks }
        out.push(msg)
        lastAssistant = msg
      }
      // 耗时记在本轮第一个 tool_use 上，落到它所在的展示气泡（一轮一气泡）。
      for (const p of parts)
        if (p.type === 'tool_use' && durations[p.id] !== undefined) lastAssistant.durationMs = durations[p.id]
      return
    }

    // user

    // 压缩摘要（带标记的 user 消息）：被压的消息照常显示，这里只在边界画一条提示（摘要正文默认折叠）。
    if (isCompactionSummary(m) && typeof m.content === 'string') {
      const summary = displaySummary(m.content)
      // 一轮进行中压缩（其后紧跟助手消息）：画成这一轮执行步骤里的一个节点，不断开合并链——其后的步骤仍并入
      // 同一个气泡。步数同折叠条的算法（工具调用 / 提问 / 计划各一步）。旧版压缩把本轮请求挪到了摘要前、
      // 删掉了已完成的步骤，这时还没有气泡，节点开一个新气泡、步数为 0。
      if (next?.role === 'assistant') {
        const steps = lastAssistant
          ? lastAssistant.blocks.filter((b) => b.kind === 'tool' || b.kind === 'ask' || b.kind === 'plan').length
          : 0
        const block: DisplayBlock = { kind: 'compaction', summary, steps }
        if (lastAssistant) lastAssistant.blocks.push(block)
        else {
          const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks: [block] }
          out.push(msg)
          lastAssistant = msg
        }
        return
      }
      // 两轮之间：自成一条（不画头像与角色名），其后紧跟真实用户轮。
      out.push({
        role: 'assistant',
        blocks: [{ kind: 'compaction', summary, ...(out.length === 0 ? { first: true } : {}) }]
      })
      lastAssistant = null
      return
    }

    // 引擎注入的自愈引导（截断续写 / 空回合追问）：不是用户说的话，不成气泡，也不断开合并链——
    // 其后的助手续写并入同一个气泡，看起来就是一次连贯的回复。
    if (isAutoNudge(m)) return

    // 后台任务通知：一轮的起点（与 isTurnStart 同义，轮下标照常对齐），展示为一行系统通知（取标记后的首行）。
    if (isTaskNotification(m) && typeof m.content === 'string') {
      const handoff = parseHandoff(m.content)
      out.push({
        role: 'user',
        text: noticeHeadline(m.content),
        attachments: [],
        notify: true,
        ...(m.content.includes(MEMBER_NOTICE_TAG) || (handoff && !handoff.needsAction) ? { quiet: true as const } : {}),
        ...(handoff ? { handoff } : {})
      })
      lastAssistant = null
      return
    }

    if (typeof m.content === 'string') {
      out.push(userDisplay(m.content, []))
      // 真实用户轮：断开 assistant 合并链，其后的 assistant 段另起新气泡（新头像）。
      lastAssistant = null
      return
    }
    const parts = m.content
    if (parts.some((p) => p.type === 'tool_result')) {
      // 工具结果回灌：回填上一条 assistant 的工具卡状态，不生成气泡
      if (lastAssistant) {
        for (const p of parts) {
          if (p.type !== 'tool_result') continue
          const b = lastAssistant.blocks.find(
            (x): x is Extract<DisplayBlock, { kind: 'tool' }> => x.kind === 'tool' && x.id === p.toolUseId
          )
          if (!b) continue
          b.status = p.isError && !gatedIds.has(b.id) ? 'error' : 'ok'
          // 后台子智能体：这条结果只是「已在后台启动」，Task 卡的真实状态看运行表与 background 边车。
          const bg = background[b.id]
          if (backgroundSubagents.has(b.id)) b.status = 'running'
          else if (bg === 'running') {
            // 边车停在 running 却已不在运行：派出后应用退出过（或回滚撤销复活了被中止的那次派发），它没能跑完。
            b.status = 'error'
            b.summary = '后台运行已中断'
          } else if (bg) b.status = bg
        }
        // 随这步工具结果交给模型的插入消息：执行步骤里的一个节点，排在本步之后。
        for (const p of parts) {
          if (p.type !== 'text') continue
          const inserted = insertBody(p.text)
          if (inserted !== null) lastAssistant.blocks.push({ kind: 'insert', text: plainTaskText(inserted) })
        }
      }
      return
    }

    // 真实用户消息（可能带附件）：附件在前、提问正文在最后一个 text 块
    const atts: AttachmentChip[] = []
    const textParts = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    parts.forEach((p, pi) => {
      if (p.type === 'image')
        atts.push({ name: p.name ?? '图片', kind: 'image', size: base64Bytes(p.data), ref: imageRef(curIndex, pi, p.data) })
      else if (p.type === 'document') atts.push({ name: p.name ?? '文档', kind: 'document', size: base64Bytes(p.data) })
    })
    for (let i = 0; i < textParts.length - 1; i++) {
      const tp = textParts[i]
      if (tp.text.startsWith(ATTACH_TEXT_PREFIX)) {
        // 注入形如「前缀 + 文件名\n```\n正文\n```」，大小按正文算。
        const body = tp.text.slice(tp.text.indexOf('\n') + 1).replace(/^```\n/, '').replace(/\n```$/, '')
        atts.push({
          name: tp.text.slice(ATTACH_TEXT_PREFIX.length).split('\n')[0].trim(),
          kind: 'text',
          size: Buffer.byteLength(body, 'utf8')
        })
      } else if (tp.text.startsWith(ATTACH_FOLDER_PREFIX)) {
        const dir = tp.text.slice(ATTACH_FOLDER_PREFIX.length).split('\n')[0].trim()
        atts.push({ name: basename(dir) || dir, kind: 'folder', path: dir })
      } else if (tp.text.startsWith(ATTACH_PATH_PREFIX)) {
        const file = tp.text.slice(ATTACH_PATH_PREFIX.length).split('\n')[0].trim()
        atts.push({ name: basename(file) || file, kind: 'file', path: file })
      }
    }
    const question = textParts.length ? textParts[textParts.length - 1].text : ''
    out.push(userDisplay(question, atts))
    // 真实用户轮：断开 assistant 合并链，其后的 assistant 段另起新气泡（新头像）。
    lastAssistant = null
  }

  // 提示可能锚在最前（after=0，几乎不出现）、任意消息之后、或全部消息之后（after=length，最常见）。
  flushNotices(0)
  for (let i = 0; i < messages.length; i++) {
    curIndex = indexBase + i
    processOne(messages[i], messages[i + 1])
    flushNotices(i + 1)
  }
  return out
}

/** 通知消息（NOTIFY_MARKER 开头）的展示标题：标记之后的首行。 */
function noticeHeadline(content: string): string {
  return content.slice(NOTIFY_MARKER.length).split('\n')[0].trim()
}

/**
 * send_to_subagent 的展示参数：补上原子智能体的类型（agent）与任务标题（description，本次未给时沿用
 * 原标题），让续聊卡与原 Task 卡同名。只用于展示（实时事件 / 重开重建），不改写入历史的原参数。
 */
function withSubagentMeta(
  args: unknown,
  lookup: (id: string) => { agent: string; description: string } | undefined
): unknown {
  const a = (args ?? {}) as Record<string, unknown>
  const to = typeof a.to === 'string' ? a.to.trim() : ''
  const meta = to ? lookup(to) : undefined
  if (!meta) return args
  const own = typeof a.description === 'string' ? a.description.trim() : ''
  return { ...a, agent: meta.agent, description: own || meta.description }
}

/**
 * run_subagent / send_to_subagent 的展示参数：续聊卡补原标题（withSubagentMeta），后台运行的再标上
 * background，渲染层据此给 Task 卡挂「后台」徽标。后台与否看不出自调用参数（默认后台，定时任务与成员会话
 * 一律前台；旧对话里前台的调用又不带参数），由调用方给出：实时看这次实际怎么派，重开看 background 边车
 * （只有后台派出的才有）。只用于展示，不改写入历史的原参数。
 */
export function subagentDisplayArgs(
  name: string,
  args: unknown,
  lookup: (id: string) => { agent: string; description: string } | undefined,
  background: boolean
): unknown {
  const shown = name === 'send_to_subagent' ? withSubagentMeta(args, lookup) : args
  return background ? { ...((shown ?? {}) as Record<string, unknown>), background: true } : shown
}

// 载入某会话的历史（重建展示气泡）。id 全局唯一 → 无需 workspaceRoot（IPC 仍传，忽略即可）。
export function loadDisplay(sessionId: string): DisplayMessage[] {
  const s = getSession(sessionId)
  // 载入即自愈并落盘：崩溃 / 强退遗留的悬空 tool_use 补成「未完成」，工具卡随之定格而不是永远转圈。
  // 回合进行中不碰（那时的悬空是工具正在执行）。
  if (s && !busySessions.has(sessionId) && repairDanglingToolUses(s)) saveProject(sessionId)
  return s ? displayOf(s) : []
}

/** 会话 → 展示气泡（载入 / 按轮删除 / 回滚后回传渲染层）：消息 + 各展示边车。 */
export function displayOf(s: StoredSession): DisplayMessage[] {
  return toDisplayMessages(
    s.messages,
    s.proposals ?? {},
    s.notices ?? [],
    s.asks ?? {},
    s.summaries ?? {},
    s.plans ?? {},
    s.autotasks ?? {},
    s.todos ?? [],
    (to) => getSubagentMeta(s.id, to),
    s.background ?? {},
    s.durations ?? {}
  )
}
