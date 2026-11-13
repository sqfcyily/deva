/**
 * 定时任务与主对话的交接：任务结果交给所属对话（需处理时唤醒、只告知时附在下一轮），
 * 以及主角色查看 / 询问 / 停止自己名下的定时任务。
 */
import type {
  ChatModelConfig
} from '../../shared/chat-protocol'
import { publishSessionsChanged } from './chat-bus'
import {
  type StopReason
} from '../providers/types'
import {
  type MemberListingItem
} from './listing'
import { MEMBER_NOTICE_TAG, NO_FOLDER, buildTaskMessage, findMember } from './members'
import { resolveDefaultModel, resolveModelRefOrNull } from './model-resolve'
import { findTaskBySession, tasksOwnedBy } from './tasks'
import type { TaskRecord } from './tasks-types'
import { describeSchedule } from './schedule'
import { buildHandoffBody, headOf, lastInformBody, parseHandoffArgs, type HandoffInput } from './handoff'
import { notifyReplyDone } from './reply-notify'
import { getSession, save as saveProject, type StoredSession } from './chat-store'
import {
  NOTIFY_MARKER
} from './compaction'
import { repairDanglingToolUses } from './chat-history'
import {
  busySessions,
  busySince,
  shuttingDown,
  pendingUndo,
  genId,
  personaName,
  getWindow,
  emit,
  historyLocked
} from './chat-state'
import { enqueueNotice } from './background-tasks'
import { type MemberToolResult } from './chat-members'
import { type TurnOutcome, emitTurnStart, runTurn, abortTurn } from './chat-turns'

// ── 定时任务的结果交接（见 handoff.ts） ────────────────────────────────────

/** 绑定任务交给主对话的一次结果：任务名、交接内容、交接时任务那一轮的模型（唤醒主角色时本对话模型解析不了才用）。 */
type Handoff = { title: string; input: HandoffInput; model: ChatModelConfig }

/** 主对话正忙时排队的交接（键 = 主对话 id），空闲时记进去（见 commitHandoffs）。 */
export const pendingHandoffs = new Map<string, Handoff[]>()

/**
 * 定时运行轮里已做的交接（键 = turnId）：一轮最多交接一次；随 runTurn 的结果交给调度器记进运行历史。
 * inform：只是告知的，要等本轮结束拿到最终回复原文才发进主对话（见 finishInform）。
 */
const turnHandoffs = new Map<
  string,
  {
    summary: string
    needsAction: boolean
    inform?: { ownerId: string; title: string; model: ChatModelConfig; fallback: string }
  }
>()

function addHandoff(mainId: string, h: Handoff): void {
  const queue = pendingHandoffs.get(mainId)
  if (queue) queue.push(h)
  else pendingHandoffs.set(mainId, [h])
  commitHandoffs(mainId)
}

/**
 * 主对话空闲时，把排队的交接记进主对话：
 *  · 只是告知的，每条是一轮——一条不显示的通知（轮的起点，交代给主智能体这是任务直接告知用户的）+ 一条以任务身份
 *    显示的回复「任务名：摘要」加全文（不调用模型；画法同成员交差，见渲染层 reportOf）；弹一次系统通知。
 *  · 需要处理的，合成一条通知消息（居中一行「任务名 摘要」，点开看全文）并唤醒主角色起一轮，由它派给成员；
 *    通知等成员回复或主角色汇总时再弹（主轮结束时照常）。
 */
export function commitHandoffs(mainId: string): void {
  if (shuttingDown) return
  const queue = pendingHandoffs.get(mainId)
  if (!queue?.length) return
  if (historyLocked(mainId)) return
  pendingHandoffs.delete(mainId)
  const main = getSession(mainId)
  if (!main) return
  repairDanglingToolUses(main)
  const infos = queue.filter((h) => !h.input.needsAction)
  const acts = queue.filter((h) => h.input.needsAction)
  for (const h of infos) {
    const headline = `${h.title}：${h.input.summary}`
    main.messages.push({
      role: 'user',
      content: `${NOTIFY_MARKER}${headline}\n${buildHandoffBody(h.title, h.input)}`
    })
    main.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `${headline}\n\n${h.input.content}` }]
    })
  }
  if (acts.length)
    main.messages.push({
      role: 'user',
      content:
        `${NOTIFY_MARKER}${acts.map((h) => `${h.title}：${h.input.summary}`).join('；')}\n` +
        acts.map((h) => buildHandoffBody(h.title, h.input)).join('\n\n')
    })
  // 新消息落进历史后，撤销上次回滚会把它一并抹掉——撤销快照就此失效（同 chat:send）。
  pendingUndo.delete(mainId)
  main.updatedAt = Date.now()
  saveProject(mainId)
  if (infos.length) {
    emit('', mainId, { type: 'member_report' })
    publishSessionsChanged()
    const last = infos[infos.length - 1]
    notifyReplyDone(getWindow, { sessionId: mainId, title: last.title, text: last.input.content })
  }
  if (acts.length) {
    const turnId = genId('turn')
    emitTurnStart(turnId, mainId, main.messages)
    void runTurn(mainId, turnId, acts[acts.length - 1].model, null)
  }
}

/** deliver_result（绑定任务的定时运行轮）：把本次结果交给主对话；一轮只交接一次。 */
export function deliverResult(
  task: TaskRecord,
  ownerId: string,
  tc: { id: string; name: string; args: unknown },
  model: ChatModelConfig,
  turnId: string
): MemberToolResult {
  const owner = getSession(ownerId)
  if (!owner)
    return { content: '绑定的主对话已不存在，无法交接。请在收尾里写清结果。', summary: '主对话已不存在', isError: true }
  const ownerName = personaName(owner)
  if (turnHandoffs.has(turnId))
    return {
      content: '本次运行已经交接过一次，不要重复交接；有补充就写在收尾里。',
      summary: '已交接过',
      isError: true
    }
  const parsed = parseHandoffArgs(tc.args)
  if (typeof parsed === 'string') return { content: parsed, summary: '参数不全', isError: true }
  const title = findTaskBySession(task.sessionId)?.title || task.title
  if (!parsed.needsAction) {
    // 只是告知：发出去的是本轮的最终回复原文，等本轮结束再发（见 finishInform）。
    turnHandoffs.set(turnId, {
      summary: parsed.summary,
      needsAction: false,
      inform: { ownerId, title, model, fallback: parsed.content }
    })
    return {
      content:
        `好。现在把要给用户看的完整内容写成你的最终回复：本轮结束后，这条回复会原文以本任务的身份发到「${ownerName}」的对话里。` +
        '直接写内容本身，不要写「已告知」「已交接」之类的话；这之后不要再调用工具。',
      summary: `告知「${ownerName}」`,
      isError: false
    }
  }
  turnHandoffs.set(turnId, { summary: parsed.summary, needsAction: true })
  addHandoff(ownerId, { title, input: parsed, model })
  return {
    content: `已交给「${ownerName}」处理，它会安排后续。现在一句话收尾即可（说明交了什么），不要再做别的。`,
    summary: `已交给「${ownerName}」`,
    isError: false
  }
}

/**
 * 只是告知的交接在本轮结束时发出：内容 = 最终回复原文（没有回复才用模型填的 content 兜底），摘要缺了取首行。
 * 本轮没做完（中止 / 出错 / 步数上限 / 原地打转）不发——半截内容不该当结果告知用户，运行记录也就不记交接。
 * 返回给调度器记进运行历史的交接信息（没发出则 undefined）。
 */
export function finishInform(turnId: string, endReason: StopReason, replyText: string): TurnOutcome['handoff'] {
  const h = turnHandoffs.get(turnId)
  turnHandoffs.delete(turnId)
  if (!h) return undefined
  if (!h.inform) return { summary: h.summary, needsAction: h.needsAction }
  const done = !['aborted', 'error', 'step_limit', 'repeated', 'degenerate'].includes(endReason)
  const content = replyText.trim() || h.inform.fallback
  if (!done || !content) return undefined
  const summary = h.summary || headOf(content)
  addHandoff(h.inform.ownerId, {
    title: h.inform.title,
    input: { summary, content, needsAction: false },
    model: h.inform.model
  })
  return { summary, needsAction: false }
}

// ── 在会话中运行的定时任务当成员用（见 handoff.ts 顶部） ─────────────────────────

/**
 * 主角色用 member_send 转给定时任务的话（键 = 任务对话 id）：任务这一轮在自己的对话里回答，结束时交回主对话
 * （见 reportTaskAsk）。subject = member_send 的任务标题，作交回那条的摘要。
 */
export const taskAsks = new Map<
  string,
  { mainId: string; toolUseId: string; model: ChatModelConfig; reportToMe: boolean; subject: string }
>()

/** 在这个会话中运行的定时任务。与成员同名的让给成员（member_send 按名字找，先找成员）。 */
export function ownedTasks(main: StoredSession): TaskRecord[] {
  return tasksOwnedBy(main.id).filter((t) => !findMember(main.members, t.title))
}

export function findOwnedTask(main: StoredSession, name: string): TaskRecord | undefined {
  const want = name.trim().replace(/^@/, '').toLowerCase()
  if (!want) return undefined
  return ownedTasks(main).find((t) => t.title.trim().toLowerCase() === want)
}

/** 指令的第一行（≤60 字）：名单与 member_status 里说明这个任务做什么。 */
function taskGist(t: TaskRecord): string {
  const line = t.prompt.split('\n').find((l) => l.trim())?.trim() ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/** 名单里的定时任务一项。不写暂停与否：忙闲、启停随时在变，进名单会反复重发（member_status 里有）。 */
export function taskItem(t: TaskRecord): MemberListingItem {
  return { name: t.title, folder: NO_FOLDER, duty: taskGist(t), schedule: describeSchedule(t.schedule, 'zh-CN') }
}

const RUN_LABEL: Record<TaskRecord['runs'][number]['status'], string> = {
  ok: '成功',
  error: '失败',
  aborted: '已中止',
  skipped: '已跳过'
}

/** member_status 里一个定时任务的情况：日程、状态、最近一次运行，以及最近一次发给用户的全文（主对话里那条）。 */
export function taskStatusBlock(main: StoredSession, t: TaskRecord, ago: (at: number) => string): string {
  const lines = [
    `【${t.title}】定时任务（在本对话中运行）：${describeSchedule(t.schedule, 'zh-CN')}；指令：${taskGist(t) || '（无）'}`
  ]
  if (busySessions.has(t.sessionId)) {
    const since = busySince.get(t.sessionId)
    lines.push(
      `状态：正在运行${taskAsks.has(t.sessionId) ? '（在回答转给它的问题）' : ''}` +
        (since ? `，已用 ${Math.max(1, Math.round((Date.now() - since) / 60000))} 分钟` : '')
    )
  } else if (t.status === 'paused' || t.status === 'error') lines.push('状态：已暂停')
  else if (t.status === 'completed') lines.push('状态：已完成（一次性任务，不会再按时运行）')
  else
    lines.push(
      `状态：空闲${t.nextRunAt ? `，下次运行 ${new Date(t.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`
    )
  const run = t.runs[t.runs.length - 1]
  if (run)
    lines.push(
      `最近一次运行：${ago(run.firedAt)}，${RUN_LABEL[run.status]}${run.status === 'error' && run.error ? `（${run.error}）` : ''}`
    )
  const sent = lastInformBody(main.messages, t.title)
  if (sent)
    lines.push('最近一次发给用户的内容（全文）：', sent.length > 12000 ? `${sent.slice(0, 12000)}…（后略）` : sent)
  else lines.push('还没有发给用户过内容。')
  return lines.join('\n')
}

/**
 * member_send 转给定时任务：把这条记进任务对话，按任务的模型在那里开一轮回答（无人值守：不能问用户，见 runTurn
 * 的 taskAsk）。回答在本轮结束时以任务的身份发进主对话（见 reportTaskAsk）。任务正在运行时不插话，请主角色稍后再转。
 */
export function askTask(
  main: StoredSession,
  task: TaskRecord,
  subjectRaw: string,
  note: string,
  toolUseId: string,
  model: ChatModelConfig,
  reportToMe: boolean
): MemberToolResult {
  const sub = getSession(task.sessionId)
  if (!sub)
    return {
      content: `定时任务「${task.title}」还没有运行过，没有可以问它的内容。`,
      summary: '还没有运行过',
      isError: true
    }
  if (busySessions.has(sub.id))
    return {
      content: `定时任务「${task.title}」正在运行，等它这次运行完再转给它。`,
      summary: `「${task.title}」正在运行`,
      isError: true
    }
  const subject = subjectRaw || note.replace(/\s+/g, ' ').slice(0, 20)
  if (!subject) return { content: '缺少任务标题（task）。', summary: '缺少任务', isError: true }
  repairDanglingToolUses(sub)
  sub.messages.push({
    role: 'user',
    content: buildTaskMessage({ owner: personaName(main), task: subject, note: note || subject, context: '' })
  })
  sub.updatedAt = Date.now()
  saveProject(sub.id)
  taskAsks.set(sub.id, { mainId: main.id, toolUseId, model, reportToMe, subject })
  // 用任务自己的模型（同按时运行，见 runScheduledTurn），解析不了才用主角色这一轮的。
  const taskModel = resolveModelRefOrNull(task.auth.modelRef) ?? resolveDefaultModel() ?? model
  const turnId = genId('turn')
  emitTurnStart(turnId, sub.id, sub.messages)
  void runTurn(sub.id, turnId, taskModel, null, 'member').catch((e) =>
    console.warn('[tasks] 回答转来的问题异常：', (e as Error)?.message ?? e)
  )
  return {
    content:
      `已转给定时任务「${task.title}」，它在自己的对话里回答。` +
      (reportToMe
        ? '回答后系统会唤醒你处理；'
        : '回答会以它的身份直接显示给用户（不经过你，你不必转述）；出错时系统会唤醒你处理；') +
      '在此之前不要等待、轮询或猜测它的回答，可以接着做别的事，或先简短回复用户。',
    summary: `已转给「${task.title}」`,
    isError: false
  }
}

/** member_stop 点到定时任务：中止它正在进行的这一轮（按时运行或回答转来的问题）。 */
export function stopTask(task: TaskRecord): MemberToolResult {
  const turnId = busySessions.get(task.sessionId)
  if (!turnId)
    return { content: `定时任务「${task.title}」当前没有在运行。`, summary: '没有在运行', isError: false }
  abortTurn(turnId)
  return { content: `已中止定时任务「${task.title}」这一次运行。`, summary: `已中止「${task.title}」`, isError: false }
}

/**
 * 回答转来的问题的那一轮结束（见 askTask）：正常答完、不要求唤醒 → 回答原文以任务的身份发进主对话（同只是告知，
 * 见 commitHandoffs）；要求唤醒（report_to_me）、出错、没答完 → 以通知交给主角色；被停止的不唤醒。
 */
export function reportTaskAsk(sub: StoredSession, endReason: StopReason, text: string, error: string | undefined): void {
  const ask = taskAsks.get(sub.id)
  taskAsks.delete(sub.id)
  if (!ask || !getSession(ask.mainId)) return
  const title = findTaskBySession(sub.id)?.title || sub.title || '定时任务'
  const reply = text.trim()
  const stopped = endReason === 'aborted'
  const done =
    !stopped && !['error', 'step_limit', 'repeated', 'degenerate'].includes(endReason) && !!reply
  if (done && !ask.reportToMe) {
    addHandoff(ask.mainId, {
      title,
      input: { summary: ask.subject, content: reply, needsAction: false },
      model: ask.model
    })
    return
  }
  const label = done ? '已回答' : stopped ? '已停止' : '未完成'
  enqueueNotice(ask.mainId, {
    toolUseId: ask.toolUseId,
    headline: `定时任务「${title}」${label}：${ask.subject}`,
    body: [
      MEMBER_NOTICE_TAG,
      `定时任务：${title}`,
      `转给它的问题：${ask.subject}`,
      `状态：${label}${error && endReason === 'error' ? `（${error}）` : ''}`,
      ...(reply ? ['它的回答：', reply] : []),
      done
        ? '用户还没看到这个回答。请据此接着处理，再回复用户。'
        : stopped
          ? '这次已被停止，用户没有看到回答；用户问起时再处理。'
          : '用户看不到这次出错。请你处理：能补救就补救（如换个说法再转一次），补救不了再简短告诉用户原因。',
      '</成员通知>'
    ].join('\n'),
    wake: !stopped,
    model: ask.model
  })
}
