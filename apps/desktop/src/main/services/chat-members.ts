/**
 * 项目成员协作：建成员、派任务、续聊、停止、查状态，成员向主角色汇报与 @提及，
 * 以及主对话里的成员进度胶囊。
 */
import type {
  ChatModelConfig
} from '../../shared/chat-protocol'
import { publishSessionsChanged } from './chat-bus'
import { statSync } from 'node:fs'
import { type ContentPart, type StopReason } from '../providers/types'
import { memberAddedRecord, type MemberListingItem } from './listing'
import {
  MAX_MEMBERS,
  MEMBER_NOTICE_TAG,
  MEMBER_TASK_MARKER,
  NO_FOLDER,
  activeMembers,
  buildTaskMessage,
  findMember,
  lastDirectUserText,
  lastReplyText,
  readMainPage,
  readMainRound,
  recentMainContext,
  resolveMemberFolder,
  rootLabel,
  type MemberProgressGroup,
  type MemberRef,
  type MemberRunStatus,
  type OpenTask
} from './members'
import { NEW_MEMBER_TOKENS } from '../../shared/mention'
import { withoutQuotes } from '../../shared/quote'
import { DEFAULT_PERSONA_ID, getPersona, listPersonas, resolvePersonaId } from './personas'
import { notifyReplyDone } from './reply-notify'
import { ensureSession, getSession, save as saveProject, type StoredSession } from './chat-store'
import { isEn } from '../locale'
import {
  browserHasHandoff
} from './browser'
import {
  NOTIFY_MARKER
} from './compaction'
import { seededShape } from '../../shared/avatar-shape'
import { repairDanglingToolUses } from './chat-history'
import {
  pendingAsk,
  pendingPlan,
  pendingMount,
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
import { pendingNotices, enqueueNotice } from './background-tasks'
import { ownedTasks, findOwnedTask, taskItem, taskStatusBlock, askTask, stopTask } from './chat-task-handoff'
import { requestMount } from './agent-loop'
import { emitTurnStart, insertMessage, runTurn, abortTurn } from './chat-turns'

/** 成员工具的执行结果（见 AgentLoopArgs.memberTool）。 */
export interface MemberToolResult {
  content: string
  summary: string
  isError: boolean
  /** 结果本身已告知了名单变化（create_member）：记为已告知，免得紧接着再附一遍名单。 */
  listing?: ReturnType<typeof memberAddedRecord>
}

// ── 项目成员（见 members.ts） ──────────────────────────────────────────────

/**
 * 一次派任务（member_send）：toolUseId 供按轮删除时撤回通知，model（当时主轮的模型）供主智能体空闲时自动起轮。
 * reportToMe = 派任务时要求完成后唤醒主智能体；group = 派出它的主轮 id：同一轮派出、都要唤醒的几项，等最后一个
 * 交差才唤醒一次（见 deliverConclusion）。task = 任务标题（交差标题用）。
 * delivered = 任务消息已到成员手里：空闲时派来的起轮即到；插进来的要等某一步送达，还在插入队列里的不算本轮交差。
 */
export interface MemberDispatch {
  toolUseId: string
  model: ChatModelConfig
  reportToMe: boolean
  group: string
  task: string
  delivered: boolean
}

/**
 * 成员会话 id → 还没交差的派发，按派出先后。成员正忙时插进来的追加在后面，各自交差一次：成员用 reply_task 先交回
 * 某一项，其余的由本轮最终回复一并交回（见 replyTask / reportMemberTurn）。
 */
export const memberDispatches = new Map<string, MemberDispatch[]>()

/** 全部成员还没交差的派发（查汇总组还有谁在做）。 */
function allDispatches(): MemberDispatch[] {
  return [...memberDispatches.values()].flat()
}

/** 派出 / 交差改动某成员的派发表（空了就删键）。 */
function setDispatches(sid: string, list: MemberDispatch[]): void {
  if (list.length) memberDispatches.set(sid, list)
  else memberDispatches.delete(sid)
}

/** 名单上还没交差的任务（兼容旧版只记一项的 openTask）。 */
function openTasksOf(ref: MemberRef): OpenTask[] {
  return ref.openTasks ?? (ref.openTask ? [ref.openTask] : [])
}

/** 改写名单上还没交差的任务（顺带去掉旧版字段）；调用方负责落盘。 */
export function setOpenTasks(ref: MemberRef, list: OpenTask[]): void {
  ref.openTask = undefined
  ref.openTasks = list.length ? list : undefined
}

/** 成员会话的插入消息送达了模型（见 chat-turns.ts takeInserts）：其中的派发从此算交到成员手里。 */
export function markDispatchesDelivered(sid: string, ids: string[]): void {
  for (const d of memberDispatches.get(sid) ?? []) if (ids.includes(d.toolUseId)) d.delivered = true
}

/** 已交到成员手里的派发 id（本轮收尾、还有插入没送达时，只有这几项随本轮的最终回复交差）。 */
export function deliveredDispatchIds(sid: string): Set<string> {
  return new Set((memberDispatches.get(sid) ?? []).filter((d) => d.delivered).map((d) => d.toolUseId))
}

/**
 * 成员会话 id → 本轮调用 report_to_main 时写的说明（要主智能体做什么）：本轮结束时结论改为唤醒主智能体处理，
 * 不以成员的身份直接回复用户（见 reportMemberTurn）。轮结束即取走。
 */
export const memberToMain = new Map<string, string>()

/** 同一轮派出、要唤醒主智能体的几项里，已有交差（未被停止）却还在等其余几项的组（见 reportMemberTurn）。 */
const memberGroupsWaiting = new Set<string>()

/**
 * 要主智能体汇总的派发组里已交差的成员（键 = 组，即派出它们的主轮 id），按交差先后：主对话据此显示
 * 「前端、后端已完成」的居中提示（见 emitMemberProgress）。组里没人还在做时整组删去，提示随之消失。
 */
export const memberGroupDone = new Map<string, { mainId: string; items: { sid: string; status: MemberRunStatus }[] }>()

/** 主对话里还有成员在做的汇总组：每组已交差的在前（按交差先后），还在做的在后。 */
function memberProgress(mainId: string): MemberProgressGroup[] {
  const main = getSession(mainId)
  if (!main) return []
  const nameOf = (sid: string): string | undefined => main.members?.find((m) => m.sessionId === sid)?.name
  const groups = new Map<string, MemberProgressGroup>()
  for (const [g, rec] of memberGroupDone) {
    if (rec.mainId !== mainId) continue
    const items = rec.items.flatMap((i) => {
      const name = nameOf(i.sid)
      return name ? [{ sid: i.sid, name, status: i.status }] : []
    })
    groups.set(g, { items })
  }
  for (const [sid, list] of memberDispatches) {
    if (getSession(sid)?.parentId !== mainId) continue
    const name = nameOf(sid)
    if (!name) continue
    for (const d of list) {
      if (!d.reportToMe) continue
      const g = groups.get(d.group) ?? { items: [] }
      // 同组里它还有一项在做：显示为进行中（先交回的那项不单列「已完成」，同一组一人只占一格）。
      if (!g.items.some((i) => i.sid === sid && i.status === 'running'))
        g.items = [...g.items.filter((i) => i.sid !== sid), { sid, name, status: 'running' }]
      groups.set(d.group, g)
    }
  }
  return [...groups.values()].filter((g) => g.items.some((i) => i.status === 'running'))
}

/** 推送主对话的成员进度（会话级，空 turnId）；先删去已没人在做的组。 */
function emitMemberProgress(mainId: string): void {
  const running = new Set(allDispatches().filter((d) => d.reportToMe).map((d) => d.group))
  for (const [g, rec] of memberGroupDone) if (rec.mainId === mainId && !running.has(g)) memberGroupDone.delete(g)
  emit('', mainId, { type: 'member_progress', groups: memberProgress(mainId) })
}

/** 汇总组里一位成员交差（status 为 null：成员已被移除，只从组里拿掉）。 */
function noteMemberDone(mainId: string, group: string, sid: string, status: MemberRunStatus | null): void {
  const rec = memberGroupDone.get(group) ?? { mainId, items: [] }
  rec.items = rec.items.filter((i) => i.sid !== sid)
  if (status) rec.items.push({ sid, status })
  memberGroupDone.set(group, rec)
  emitMemberProgress(mainId)
}

/**
 * 一次成员交差（见 commitMemberReports）：name 是成员名，headline 是「前端已完成：任务」（只给模型看，界面上
 * 画成该成员的回复、不显示这一行），conclusion 是成员的最终回复。
 */
type MemberReport = { name: string; headline: string; conclusion: string }

/** 主对话正忙时的成员交差：等主对话这一轮结束再记（不插在主智能体一轮的中间），见 commitMemberReports。 */
export const pendingMemberReports = new Map<string, MemberReport[]>()

/** 成员交差：以成员的身份在主对话里回一条（主对话正忙则排队，等空闲再记）。 */
function addMemberReport(mainId: string, report: MemberReport): void {
  const queue = pendingMemberReports.get(mainId)
  if (queue) queue.push(report)
  else pendingMemberReports.set(mainId, [report])
  commitMemberReports(mainId)
}

/**
 * 主对话空闲时，把排队的成员交差记进主对话：每条是一轮——一条不显示的成员通知（轮的起点，交代给主智能体这是
 * 系统代发的）+ 一条回复「前端已完成：任务」加成员的结论原文。界面上这条回复画成该成员说的话（成员的头像和名字，
 * 不显示标题行，见渲染层 reportOf）。不调用模型：主智能体此后的上下文与用户看到的一致，用户问起时它知道结论；
 * 用户也不必去翻成员的对话。
 */
export function commitMemberReports(mainId: string): void {
  const queue = pendingMemberReports.get(mainId)
  if (!queue?.length) return
  if (historyLocked(mainId)) return
  pendingMemberReports.delete(mainId)
  const main = getSession(mainId)
  if (!main) return
  repairDanglingToolUses(main)
  for (const r of queue) {
    main.messages.push({
      role: 'user',
      content:
        `${NOTIFY_MARKER}${r.headline}\n${MEMBER_NOTICE_TAG}\n` +
        `（系统自动发送：成员「${r.name}」交回了结论，下一条就是它的原话，已以它自己的身份（头像和名字）直接显示给用户，不是你说的话。不是用户发来的消息。）\n</成员通知>`
    })
    main.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: r.conclusion ? `${r.headline}\n\n${r.conclusion}` : r.headline }]
    })
  }
  // 新消息落进历史后，撤销上次回滚会把它一并抹掉——撤销快照就此失效（同 chat:send）。
  pendingUndo.delete(mainId)
  main.updatedAt = Date.now()
  saveProject(mainId)
  emit('', mainId, { type: 'member_report' })
  publishSessionsChanged()
  // 用户没在看 Deva 时同普通回复一样弹系统通知：标题是成员名（是它在说话），正文是它的回复。
  if (!shuttingDown) {
    const last = queue[queue.length - 1]
    notifyReplyDone(getWindow, {
      sessionId: mainId,
      title: last.name,
      text: last.conclusion || last.headline
    })
  }
}

/**
 * 成员的文件夹：以成员会话的 focusRoot 为准（用户在成员对话里挂 / 卸，同普通对话）；会话丢了才看名单。
 * 不跟随主对话：没给文件夹的成员就是没有文件夹。
 */
function memberFolder(m: MemberRef): string | null {
  const sub = getSession(m.sessionId)
  return sub ? (sub.focusRoot ?? null) : m.root
}

/** 名单里的一项交给模型时的写法（见 listing.ts memberListingPart）。 */
function memberItem(m: MemberRef, mainRoot: string | null): MemberListingItem {
  return {
    name: m.name,
    folder: rootLabel(memberFolder(m), mainRoot),
    duty: m.duty,
    ...(m.origin === 'mention' ? { fromRole: getPersona(m.personaId)?.name ?? m.name } : {})
  }
}

/** 主对话当前的成员名单（随消息下发）：成员 + 在本对话中运行的定时任务。 */
export function memberListing(mainId: string): MemberListingItem[] {
  const main = getSession(mainId)
  if (!main) return []
  return [
    ...activeMembers(main.members).map((m) => memberItem(m, main.focusRoot ?? null)),
    ...ownedTasks(main).map(taskItem)
  ]
}

/** 成员的模型：被 @ 的角色设了偏好模型就用它，否则跟随主对话。 */
function memberModelRef(m: MemberRef, main: StoredSession): string {
  if (m.origin === 'mention') {
    const own = getPersona(m.personaId)?.model
    if (own) return own
  }
  return main.model ?? ''
}

/**
 * 往主对话名单里加一个成员（或恢复同名的已移除成员），建好成员会话。失败返回原因（成员已满 / 重名）。
 * root：成员的文件夹，null = 不指定（新成员没有文件夹；恢复的成员保留原来的文件夹）。
 * restored = 恢复的是之前移除的成员：会话与上下文都还在，调用方要如实告诉主智能体（别让它以为是新建的）。
 * 只改内存与磁盘，不通知渲染层——调用方汇总后 publishSessionsChanged。
 */
function addMember(
  main: StoredSession,
  p: { name: string; root: string | null; duty: string; origin: MemberRef['origin']; personaId: string }
): { ref: MemberRef; restored: boolean } | string {
  if (findMember(main.members, p.name)) return `已有名为「${p.name}」的成员。`
  if (activeMembers(main.members).length >= MAX_MEMBERS)
    return `成员已满 ${MAX_MEMBERS} 个，请先请用户在成员卡片里移除一个。`
  // 同名的已移除成员：恢复它（保留它的工作记录），职责与文件夹按这次的更新（这次没给的保留原样）。
  const prior = main.members?.find(
    (m) => m.removed && m.name.toLowerCase() === p.name.toLowerCase() && getSession(m.sessionId)
  )
  if (prior) {
    prior.removed = undefined
    prior.duty = p.duty || prior.duty
    const sub = getSession(prior.sessionId)
    prior.root = p.root ?? memberFolder(prior)
    saveProject(main.id)
    if (sub && p.root) {
      sub.focusRoot = p.root
      saveProject(sub.id)
    }
    return { ref: prior, restored: true }
  }
  const ref: MemberRef = {
    sessionId: genId('mem'),
    name: p.name,
    origin: p.origin,
    personaId: p.personaId,
    root: p.root,
    duty: p.duty,
    addedAt: Date.now()
  }
  // 主智能体建的成员：头像形状此刻挑定并存下（按会话 id，与头像部件同种子），以后形状库怎么改都不换
  if (ref.origin === 'created') ref.shape = seededShape(ref.sessionId)
  const sub = ensureSession(ref.sessionId, {
    personaId: ref.personaId,
    focusRoot: ref.root,
    model: memberModelRef(ref, main),
    effort: main.effort
  })
  sub.parentId = main.id
  sub.title = ref.name
  saveProject(sub.id)
  main.members = [...(main.members ?? []), ref]
  saveProject(main.id)
  return { ref, restored: false }
}

/**
 * 用户在成员会话里说话，而主智能体派来的任务还没做完（被停止、出错，或 Deva 重启中断了，见 MemberRef.openTasks）：
 * 这一轮算接着做这几项——任务标题不变，结束时照常交回主对话（成员以自己的身份回复，或按 report_to_me 唤醒主智能体）。
 * 停止时排给主智能体、还没送到的「已停止」通知随之作废。返回是否接上了。
 */
export function resumeMemberTask(sub: StoredSession, model: ChatModelConfig): boolean {
  if (memberDispatches.get(sub.id)?.length) return false
  const main = sub.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sub.id && !m.removed)
  const open = ref ? openTasksOf(ref) : []
  if (!main || !ref || !open.length) return false
  setDispatches(
    sub.id,
    open.map((o) => ({
      toolUseId: o.toolUseId,
      model,
      reportToMe: o.reportToMe,
      group: o.group,
      task: o.task ?? ref.task ?? '',
      delivered: true
    }))
  )
  const ids = new Set(open.map((o) => o.toolUseId))
  const queue = pendingNotices.get(main.id)
  if (queue) {
    const left = queue.filter((n) => !ids.has(n.toolUseId))
    if (left.length) pendingNotices.set(main.id, left)
    else pendingNotices.delete(main.id)
  }
  // 要汇总的组里它又在做了：从「已完成」里拿掉（同再派一次）。
  for (const o of open) {
    const groupDone = memberGroupDone.get(o.group)
    if (groupDone) groupDone.items = groupDone.items.filter((i) => i.sid !== sub.id)
  }
  emitMemberProgress(main.id)
  return true
}

/** 用户直接在成员会话里说了一句：取这条消息开头（≤20 字）记作成员当前的任务标题。 */
export function noteMemberDirectTask(sub: StoredSession, text: string): void {
  // 来不及插入、改作下一轮发出的派发任务（见 chat-turns.ts flushInserts）：标题派任务时已记好。
  if (text.startsWith(MEMBER_TASK_MARKER)) return
  const main = sub.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sub.id)
  const title = text.replace(/\s+/g, ' ').trim()
  if (!main || !ref || !title) return
  ref.task = title.length > 20 ? `${title.slice(0, 20)}…` : title
  saveProject(main.id)
  publishSessionsChanged()
}

/** 成员会话里用户亲自改了模型 / 思考等级：记到主对话名单上，此后派任务不再覆盖。 */
export function markMemberSetting(sub: StoredSession, field: 'modelSet' | 'effortSet'): void {
  const main = sub.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sub.id)
  if (!main || !ref || ref[field]) return
  ref[field] = true
  saveProject(main.id)
}

/**
 * 成员会话里挂载 / 卸载文件夹（null = 卸载，成员没有文件夹）：同步写回主对话名单（名单随消息下发，主智能体会收到更新）。
 */
export function setMemberFolder(sub: StoredSession, folder: string | null): void {
  const main = sub.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sub.id)
  if (main && ref) {
    ref.root = folder
    saveProject(main.id)
  }
  sub.focusRoot = folder
  saveProject(sub.id)
  publishSessionsChanged()
}

/**
 * create_member：主智能体为项目的一块创建成员。成员一律使用默认角色 Deva 的设定（不随主对话的角色：主角色的性格、
 * 风格是给用户看的，分工干活的成员用通用设定）；名字、职责由主智能体给出，头像按成员会话 id 随机生成。
 */
function createMember(main: StoredSession, rawName: string, folder: string, duty: string): MemberToolResult {
  const name = rawName.replace(/^@+/, '').trim()
  const fail = (content: string, summary = '未能添加成员'): MemberToolResult => ({ content, summary, isError: true })
  if (!name) return fail('缺少成员名（name）。')
  if (name.length > 16 || /[\s@]/.test(name)) return fail('成员名请用 2～6 个字、不含空格和 @，如「前端」。')
  const mainRoot = main.focusRoot ?? null
  // 没给文件夹 = 不指定：成员没有工作目录（不跟随主对话），用户之后可以在成员的对话里为它选。
  let root: string | null = null
  if (folder.trim()) {
    root = resolveMemberFolder(folder, mainRoot)
    if (!root) return fail('当前对话没有挂载工作区，folder 请用绝对路径，或省略。')
    let isDir = false
    try {
      isDir = statSync(root).isDirectory()
    } catch {
      /* 不存在 */
    }
    if (!isDir) return fail(`文件夹不存在：${root}。请确认路径，或省略 folder。`)
  }
  const r = addMember(main, {
    name,
    root,
    duty,
    origin: 'created',
    personaId: DEFAULT_PERSONA_ID
  })
  if (typeof r === 'string') return fail(r)
  publishSessionsChanged()
  const item = memberItem(r.ref, mainRoot)
  const where = item.folder === NO_FOLDER ? '（未指定文件夹）' : `（负责 ${item.folder}）`
  return {
    content: r.restored
      ? `已恢复之前移除的成员「${r.ref.name}」：${r.ref.duty || '（未写职责）'}${where}。它用的还是原来的会话，之前做过的任务和上下文都还在，不用把旧结论再交给它一遍。用 member_send 给它派任务。`
      : `已添加成员「${r.ref.name}」：${r.ref.duty || '（未写职责）'}${where}。用 member_send 给它派任务。`,
    summary: r.restored ? `已恢复成员「${r.ref.name}」` : `已添加成员「${r.ref.name}」`,
    isError: false,
    listing: memberAddedRecord(item)
  }
}

/** member_send：把任务交给成员，成员在后台开一轮（正忙则插入它当前的工作）。 */
function sendToMember(
  main: StoredSession,
  member: MemberRef,
  task: string,
  note: string,
  toolUseId: string,
  model: ChatModelConfig,
  reportToMe: boolean,
  group: string
): MemberToolResult {
  const sub = getSession(member.sessionId)
  if (!sub)
    return {
      content: `成员「${member.name}」的会话已丢失，无法派任务。`,
      summary: '成员会话已丢失',
      isError: true
    }
  const title = task || note.replace(/\s+/g, ' ').slice(0, 20)
  if (!title)
    return { content: '缺少任务标题（task）。', summary: '缺少任务', isError: true }
  const owner = personaName(main)
  const first = !sub.messages.some((m) => m.role === 'user')
  const busy = busySessions.has(sub.id)
  // 不附用户原话：任务由主智能体理解后派发，说明（message）由它写完整；首次派发附上主对话最近几轮作背景。
  // 正忙时插进它当前的工作：附上插入说明（无关的可先用 reply_task 单独交回）。
  const content = buildTaskMessage({
    owner,
    task: title,
    note: note || title,
    context: first ? recentMainContext(main.messages, owner) : '',
    inserted: busy
  })
  // 每次派任务都按主对话同步：模型（被 @ 的角色设了偏好模型就用它）、思考等级。用户在成员会话里亲自改过的
  // 以成员为准，不覆盖。文件夹是成员自己的，不跟随主对话。
  if (!member.modelSet) sub.model = memberModelRef(member, main)
  if (!member.effortSet && main.effort) sub.effort = main.effort
  const prevTask = member.task
  const prevOpen = openTasksOf(member)
  const open: OpenTask = { toolUseId, reportToMe, group, task: title }
  member.task = title
  // 正忙：追加在手上的任务后面，各自交差；空闲：取代没做完的旧任务（主智能体重新派了）。
  setOpenTasks(member, busy ? [...prevOpen, open] : [open])
  saveProject(main.id)
  const prevDispatches = memberDispatches.get(sub.id) ?? []
  const dispatch: MemberDispatch = { toolUseId, model, reportToMe, group, task: title, delivered: !busy }
  setDispatches(sub.id, busy ? [...prevDispatches, dispatch] : [dispatch])
  // 同一组里再派给已交差的成员：它又在做了，从「已完成」里拿掉。
  const groupDone = memberGroupDone.get(group)
  if (groupDone) groupDone.items = groupDone.items.filter((i) => i.sid !== sub.id)
  publishSessionsChanged()

  if (busy) {
    const r = insertMessage({ sessionId: sub.id, text: content, model }, false, toolUseId)
    if (!r.ok) {
      // 没派出去：派发表与名单上的任务都还是原来那几项。
      setDispatches(sub.id, prevDispatches)
      member.task = prevTask
      setOpenTasks(member, prevOpen)
      saveProject(main.id)
      return {
        content: `成员「${member.name}」正忙，暂时无法接收新任务，请等它完成后再派。`,
        summary: `「${member.name}」正忙`,
        isError: true
      }
    }
    emitMemberProgress(main.id)
    return {
      content: reportToMe
        ? `成员「${member.name}」正在处理上一项任务，这条已插入它当前的工作，完成后会唤醒你处理结果。`
        : `成员「${member.name}」正在处理上一项任务，这条已插入它当前的工作，完成后它会以自己的身份直接回复用户。`,
      summary: `已交给「${member.name}」`,
      isError: false
    }
  }
  repairDanglingToolUses(sub)
  sub.messages.push({ role: 'user', content })
  sub.updatedAt = Date.now()
  saveProject(sub.id)
  const turnId = genId('turn')
  emitTurnStart(turnId, sub.id, sub.messages)
  void runTurn(sub.id, turnId, model, null, 'member').catch((e) =>
    console.warn('[members] 成员回合异常：', (e as Error)?.message ?? e)
  )
  emitMemberProgress(main.id)
  return {
    content:
      `已交给成员「${member.name}」，它在后台工作。` +
      (reportToMe
        ? '完成后系统会唤醒你处理结果；'
        : '完成后它会以自己的身份在对话里直接回复用户（不经过你，你不必转述）；出错时系统会唤醒你处理；') +
      '在此之前不要等待、轮询或猜测它的结果，可以接着派其他成员、做别的事，或先简短回复用户（不用复述派了什么，界面上看得到）。',
    summary: `已交给「${member.name}」`,
    isError: false
  }
}

/** member_stop：中止成员当前的任务（它照常收尾，结论标为已停止）。 */
function stopMember(main: StoredSession, member: MemberRef): MemberToolResult {
  const turnId = busySessions.get(member.sessionId)
  if (!turnId)
    return {
      content: `成员「${member.name}」当前没有进行中的任务。`,
      summary: '没有进行中的任务',
      isError: false
    }
  // 主智能体叫停 = 手上的任务不要了：用户之后在成员会话里再说话，不再算接着做它们（见 MemberRef.openTasks）。
  if (openTasksOf(member).length) {
    setOpenTasks(member, [])
    saveProject(main.id)
  }
  abortTurn(turnId)
  return { content: `已中止成员「${member.name}」当前的任务。`, summary: `已中止「${member.name}」`, isError: false }
}

/**
 * member_status：成员的当前状态与最近一次结论（结论取成员会话里最近一次收尾的回复全文，名单上只存了前 200 字）。
 * 对话压缩后较早的交差只剩摘要，主智能体汇总各成员情况时据此补全。
 */
function memberStatus(main: StoredSession, rawName: string): MemberToolResult {
  const list = activeMembers(main.members)
  const tasks = ownedTasks(main)
  if (!list.length && !tasks.length) return { content: '本对话还没有成员。', summary: '没有成员', isError: false }
  const name = rawName.replace(/^@+/, '').trim().toLowerCase()
  const pick = name ? list.filter((m) => m.name.toLowerCase() === name) : list
  // 名单里的定时任务（见 askTask）：点名时成员优先，不点名时成员之后一并列出。
  const pickTasks = name ? (pick.length ? [] : tasks.filter((t) => t.title.trim().toLowerCase() === name)) : tasks
  if (!pick.length && !pickTasks.length)
    return {
      content: `没有名为「${rawName}」的成员或定时任务。${rosterNames(main)}`,
      summary: '没有这个成员',
      isError: true
    }
  const now = Date.now()
  const ago = (t: number): string => {
    const min = Math.round((now - t) / 60000)
    if (min < 1) return '刚刚'
    if (min < 60) return `${min} 分钟前`
    if (min < 1440) return `${Math.round(min / 60)} 小时前`
    return `${Math.round(min / 1440)} 天前`
  }
  const waitingOf = (id: string): string =>
    [...pendingAsk.values()].some((p) => p.sessionId === id)
      ? '在等用户回答问题'
      : [...pendingPlan.values()].some((p) => p.sessionId === id)
        ? '在等用户批准计划'
        : [...pendingMount.values()].some((p) => p.sessionId === id)
          ? '在等用户选择文件夹'
          : browserHasHandoff(id)
            ? '在等用户在网页上操作（如登录）'
            : ''
  const mainRoot = main.focusRoot ?? null
  const blocks = pick.map((m) => {
    const item = memberItem(m, mainRoot)
    const lines = [
      `【${m.name}】${item.fromRole ? '（协助者）' : ''}${item.folder === NO_FOLDER ? '未指定文件夹' : `负责 ${item.folder}`}：${m.duty || '（未写职责）'}`
    ]
    if (busySessions.has(m.sessionId)) {
      const since = busySince.get(m.sessionId)
      const waiting = waitingOf(m.sessionId)
      lines.push(
        `状态：工作中${m.task ? `，正在做「${m.task}」` : ''}` +
          (since ? `，已用 ${Math.max(1, Math.round((now - since) / 60000))} 分钟` : '') +
          (waiting ? `；${waiting}` : '')
      )
    } else {
      lines.push('状态：空闲')
      // 派来的任务没做完（被停止、出错或 Deva 重启中断）：用户在成员会话里让它接着做时，完成后照常交回。
      const open = openTasksOf(m)
      if (open.length) {
        const titles = open.map((o) => o.task ?? m.task ?? '').filter(Boolean)
        lines.push(
          `上次派的任务${titles.length ? `「${titles.join('」「')}」` : ''}还没做完（被停止、出错或因 Deva 重启中断）。要现在接着做就用 member_send 再派一次。`
        )
      }
    }
    if (m.last) {
      const label = m.last.status === 'done' ? '已完成' : m.last.status === 'stopped' ? '已停止' : '未完成'
      const sub = getSession(m.sessionId)
      const full = (sub ? lastReplyText(sub.messages) : '') || m.last.text
      const text = full.length > 3000 ? `${full.slice(0, 3000)}…（后略）` : full
      lines.push(`最近一次交差（${ago(m.last.at)}，${label}）：`, text)
    } else lines.push('还没有交过结论。')
    return lines.join('\n')
  })
  blocks.push(...pickTasks.map((t) => taskStatusBlock(main, t, ago)))
  const counts = [
    pick.length ? `${pick.length} 个成员` : '',
    pickTasks.length ? `${pickTasks.length} 个定时任务` : ''
  ].filter(Boolean)
  return {
    content: blocks.join('\n\n'),
    summary: pick.length + pickTasks.length === 1 ? '已查看' : `已查看 ${counts.join('、')}`,
    isError: false
  }
}

/** 点错名字时告诉主角色现有哪些成员与定时任务。 */
function rosterNames(main: StoredSession): string {
  const members = activeMembers(main.members).map((m) => m.name)
  const tasks = ownedTasks(main).map((t) => t.title)
  return [
    `现有成员：${members.join('、') || '（无）'}。`,
    tasks.length ? `在本对话中运行的定时任务：${tasks.join('、')}。` : ''
  ].join('')
}

/** 主对话的成员工具（create_member / member_send / member_stop / member_status）。 */
export async function mainMemberTool(
  mainId: string,
  tc: { id: string; name: string; args: unknown },
  model: ChatModelConfig,
  turnId: string
): Promise<MemberToolResult> {
  const main = getSession(mainId)
  if (!main) return { content: '对话不存在。', summary: '对话不存在', isError: true }
  const a = (tc.args ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  if (tc.name === 'member_status') return memberStatus(main, str('member'))
  if (tc.name === 'create_member') {
    let folder = str('folder')
    // 不知道文件夹在哪：在对话里弹选择文件夹的卡片请用户点选（复用挂载卡），不让用户打字报路径。
    if (!folder && a.pick_folder === true) {
      const name = str('name').replace(/^@+/, '')
      const picked = await requestMount(turnId, mainId, tc.name, '', name || '成员')
      if (picked) folder = picked
    }
    return createMember(main, str('name'), folder, str('duty'))
  }
  const member = findMember(main.members, str('member'))
  if (!member) {
    // 名单里的定时任务：member_send 转给它回答，member_stop 中止它这一次运行。
    const task = findOwnedTask(main, str('member'))
    if (task)
      return tc.name === 'member_stop'
        ? stopTask(task)
        : askTask(main, task, str('task'), str('message'), tc.id, model, a.report_to_me === true)
    return {
      content: `没有名为「${str('member')}」的成员或定时任务。${rosterNames(main)}`,
      summary: '没有这个成员',
      isError: true
    }
  }
  if (tc.name === 'member_stop') return stopMember(main, member)
  return sendToMember(main, member, str('task'), str('message'), tc.id, model, a.report_to_me === true, turnId)
}

/**
 * 成员会话的成员工具（read_main：往前翻主对话的正文；report_to_main：本轮结论交给主智能体处理；reply_task：先交回
 * 其中一项派来的任务）。
 */
export async function memberSideTool(
  memberId: string,
  tc: { id: string; name: string; args: unknown }
): Promise<MemberToolResult> {
  const sub = getSession(memberId)
  const main = sub?.parentId ? getSession(sub.parentId) : undefined
  if (!sub || !main) return { content: '找不到主对话（可能已被删除）。', summary: '找不到主对话', isError: true }
  const a = (tc.args ?? {}) as { before?: unknown; round?: unknown; offset?: unknown; reason?: unknown }
  const owner = personaName(main)
  if (tc.name === 'reply_task') {
    const r = (tc.args ?? {}) as { task?: unknown; conclusion?: unknown }
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    return replyTask(sub, main, str(r.task), str(r.conclusion))
  }
  if (tc.name === 'report_to_main') {
    const reason = typeof a.reason === 'string' ? a.reason.trim().replace(/\s+/g, ' ') : ''
    memberToMain.set(memberId, reason || '处理成员的结论')
    return {
      content:
        `已记下：本轮结束后，你的最终回复会作为结论交给${owner}处理（唤醒它），不再以你的身份直接回复用户。` +
        `现在写最终回复：写清要${owner}做什么，并原样附上它需要的材料（${owner}看不到你的工具调用和结果）。`,
      summary: `交给${owner}`,
      isError: false
    }
  }
  return {
    content:
      typeof a.round === 'number'
        ? readMainRound(main.messages, owner, a.round, typeof a.offset === 'number' ? a.offset : 0)
        : readMainPage(main.messages, owner, typeof a.before === 'number' ? a.before : undefined),
    summary: '已读取主对话',
    isError: false
  }
}

/** 交差标题：这几项派发的任务标题（旧记录没有时用名单上的当前任务）。 */
function titleOf(closing: MemberDispatch[], ref: MemberRef): string {
  const titles = [...new Set(closing.map((d) => d.task).filter(Boolean))]
  return titles.length ? titles.join('、') : (ref.task ?? '')
}

/**
 * 几项派发一起交差（调用方已把它们从派发表里拿掉）：名单记下最近一次结论；正常完成的从名单的未完成任务里去掉，
 * 被停止、出错的留着，用户在成员会话里接着说话时接上（见 resumeMemberTask）；汇总组更新进度。返回交差标题。
 */
function recordConclusion(
  main: StoredSession,
  ref: MemberRef,
  sid: string,
  closing: MemberDispatch[],
  status: MemberRunStatus,
  conclusion: string
): string {
  const title = titleOf(closing, ref)
  ref.last = {
    text: conclusion.length > 200 ? `${conclusion.slice(0, 200)}…` : conclusion,
    at: Date.now(),
    status,
    ...(title ? { task: title } : {})
  }
  const left = memberDispatches.get(sid) ?? []
  if (closing.length && status === 'done') {
    const leftIds = new Set(left.map((d) => d.toolUseId))
    setOpenTasks(ref, openTasksOf(ref).filter((o) => leftIds.has(o.toolUseId)))
  }
  // 还有没交差的：名单上的当前任务写最近派来的那项（成员卡片显示它）。
  if (left.length) ref.task = left[left.length - 1].task || ref.task
  saveProject(main.id)
  publishSessionsChanged()
  // 要汇总的组：更新主对话的进度提示（最后一位交差时提示消失，随后唤醒主智能体汇总）。
  for (const g of new Set(closing.filter((d) => d.reportToMe).map((d) => d.group)))
    noteMemberDone(main.id, g, sid, ref.removed ? null : status)
  return title
}

/**
 * 把几项派发的结论交回主对话（本轮结束时一起交，或成员用 reply_task 先交回一项）。正常完成时成员以自己的身份在
 * 主对话里回一条结论原文（不调用模型，见 commitMemberReports）；出错时不显示，唤醒主智能体处理；被停止的不显示
 * 也不唤醒。派任务时设了 report_to_me 的改为以通知唤醒主智能体处理（同一轮派出的几项等最后一个交差再唤醒一次）；
 * 成员调用了 report_to_main（toMain）的同样唤醒主智能体。
 */
function deliverConclusion(
  main: StoredSession,
  ref: MemberRef,
  closing: MemberDispatch[],
  title: string,
  status: MemberRunStatus,
  text: string,
  error: string | undefined,
  toMain: string | undefined
): void {
  const owner = personaName(main)
  const conclusion = text.trim() || (error ? `执行出错：${error}` : '（没有给出结论。）')
  const label = status === 'done' ? '已完成' : status === 'stopped' ? '已停止' : '未完成'
  // 通知挂在最近派来的那项上：所在轮次被删时据此撤回；自动起轮时用它的模型。
  const last = closing[closing.length - 1]
  // 唤醒主智能体：派任务时要了（report_to_me），且同一轮派出、要唤醒的其余几项都已交差。被停止的单独不唤醒，
  // 但同组已有交差在等它时照样唤醒（不然那几项的结论就没人处理了）。几项分属不同的组时，有一组齐了就唤醒。
  let wake = false
  // 有组还有在做的（含它自己手上同组的另一项）：交给那组最后一个交差的那次唤醒一并处理。
  let deferred = false
  const groups = new Set(closing.filter((d) => d.reportToMe).map((d) => d.group))
  if (groups.size) {
    const pending = allDispatches()
    for (const g of groups) {
      if (pending.some((d) => d.reportToMe && d.group === g)) {
        deferred = true
        if (status !== 'stopped') memberGroupsWaiting.add(g)
      } else {
        if (status !== 'stopped' || memberGroupsWaiting.has(g)) wake = true
        memberGroupsWaiting.delete(g)
      }
    }
  } else if (toMain) wake = true
  if (!wake && !deferred) {
    // 不要汇总、正常交回：成员以自己的身份（头像和名字）在主对话里回复（不调用模型，见 commitMemberReports）。
    if (status === 'done') {
      addMemberReport(main.id, {
        name: ref.name,
        headline: isEn()
          ? `${ref.name} finished${title ? `: ${title}` : ''}`
          : `${ref.name}已完成${title ? `：${title}` : ''}`,
        conclusion: text.trim()
      })
      return
    }
    // 出错：主对话里不显示，唤醒主智能体处理（补救或告诉用户）。被停止的（主智能体或用户叫停的）既不显示
    // 也不唤醒，随主智能体下一次开口一并告诉它。
    enqueueNotice(main.id, {
      toolUseId: last.toolUseId,
      headline: `成员「${ref.name}」${label}${title ? `：${title}` : ''}`,
      body: [
        MEMBER_NOTICE_TAG,
        `成员：${ref.name}`,
        ...(title ? [`任务：${title}`] : []),
        `状态：${label}${status === 'failed' && error ? `（${error}）` : ''}`,
        ...(text.trim() ? ['已有的结论：', text.trim()] : []),
        status === 'failed'
          ? '用户看不到这次出错。请你处理：能补救就补救（如换个做法再用 member_send 派一次，或改派给别的成员），补救不了再简短告诉用户原因和你的建议。'
          : '这项任务已被停止，用户没有看到它的结论；用户问起或需要时再处理。',
        '</成员通知>'
      ].join('\n'),
      wake: status === 'failed',
      model: last.model
    })
    return
  }
  // 要唤醒主智能体处理的（含同组还在等其余几项的）：结论以通知交给它，唤醒后由它回复用户。
  enqueueNotice(main.id, {
    toolUseId: last.toolUseId,
    headline: toMain
      ? `成员「${ref.name}」请${owner}处理：${toMain}`
      : `成员「${ref.name}」${label}${title ? `：${title}` : ''}`,
    body: [
      MEMBER_NOTICE_TAG,
      `成员：${ref.name}`,
      ...(title ? [`任务：${title}`] : []),
      `状态：${label}${status === 'failed' && error ? `（${error}）` : ''}`,
      ...(toMain ? [`要你做的事：${toMain}`] : []),
      '结论：',
      conclusion,
      ...(toMain
        ? [
            '成员没有直接回复用户，用户还没看到这份结论。请按成员的说明接着处理（只有你能做的事你来做，要别的成员配合的用 member_send 派），再回复用户。'
          ]
        : []),
      '</成员通知>'
    ].join('\n'),
    wake,
    model: last.model
  })
}

/**
 * reply_task：成员不等本轮结束，先交回其中一项派来的任务（正忙时插进来、与手上的无关的那项），交差方式同本轮结束时
 * （见 deliverConclusion）。只剩一项时不受理：那项由最终回复交差，免得本轮结束时最终回复无处可交。
 * 只认已送达成员的派发（还在插入队列里的，成员还没见过它的标题）。
 */
function replyTask(sub: StoredSession, main: StoredSession, rawTask: string, rawConclusion: string): MemberToolResult {
  const fail = (content: string): MemberToolResult => ({ content, summary: '未能交回', isError: true })
  const ref = main.members?.find((m) => m.sessionId === sub.id && !m.removed)
  if (!ref) return fail('你已不在主对话的成员名单里，无法交回结论。')
  const open = memberDispatches.get(sub.id) ?? []
  if (!open.length) return fail('当前没有派来的任务（这是用户直接跟你说的话），不用调用本工具，直接写最终回复即可。')
  if (open.length < 2) return fail('只剩这一项派来的任务，不用调用本工具，直接写最终回复即可。')
  const delivered = open.filter((d) => d.delivered)
  const want = rawTask.trim().replace(/^「/, '').replace(/」$/, '').trim()
  const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
  const hit = delivered.find((d) => d.task === want) ?? delivered.find((d) => norm(d.task) === norm(want))
  if (!hit)
    return fail(
      `没有标题为「${want}」的待交任务。还没交回的有：${delivered.map((d) => `「${d.task}」`).join('、')}。task 请原样填写其中一个标题。`
    )
  const conclusion = rawConclusion.trim()
  if (!conclusion) return fail('缺少结论（conclusion）。')
  setDispatches(sub.id, open.filter((d) => d !== hit))
  const title = recordConclusion(main, ref, sub.id, [hit], 'done', conclusion)
  deliverConclusion(main, ref, [hit], title, 'done', conclusion, undefined, undefined)
  const owner = personaName(main)
  return {
    content:
      (hit.reportToMe
        ? `已把「${hit.task}」的结论交给${owner}处理。`
        : `已把「${hit.task}」的结论以你的身份回复用户。`) + '接着做其余的任务；最终回复里不要再重复这项的结论。',
    summary: hit.reportToMe ? `已交给${owner}` : '已回复用户',
    isError: false
  }
}

/**
 * 成员会话一轮结束：本轮的最终回复作为结论，交回还没交差的派发（见 deliverConclusion）。only = 只交这几项：本轮
 * 收尾时还有插入没送达（马上作为下一轮发出），那几项留给下一轮的最终回复。
 * 不是派来的任务（用户直接跟成员说的话）：以不唤醒的通知同步给主智能体；成员本轮调用了 report_to_main（见
 * memberToMain）时改为唤醒主智能体处理。
 */
export function reportMemberTurn(
  sub: StoredSession,
  endReason: StopReason,
  text: string,
  error: string | undefined,
  model: ChatModelConfig,
  only?: ReadonlySet<string>
): void {
  const all = memberDispatches.get(sub.id) ?? []
  const closing = only ? all.filter((d) => only.has(d.toolUseId)) : all
  setDispatches(sub.id, only ? all.filter((d) => !only.has(d.toolUseId)) : [])
  const askedMain = memberToMain.get(sub.id)
  memberToMain.delete(sub.id)
  const main = sub.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sub.id)
  if (!main || !ref) return
  const status: MemberRunStatus =
    endReason === 'aborted'
      ? 'stopped'
      : endReason === 'error' || endReason === 'degenerate'
        ? 'failed'
        : 'done'
  // 成员要主智能体接着处理的事（report_to_main）；被停止的不算。
  const toMain = status === 'stopped' ? undefined : askedMain
  const owner = personaName(main)
  const conclusion = text.trim() || (error ? `执行出错：${error}` : '（没有给出结论。）')
  const title = recordConclusion(main, ref, sub.id, closing, status, conclusion)
  if (ref.removed) return
  if (closing.length) {
    deliverConclusion(main, ref, closing, title, status, text, error, toMain)
    return
  }
  // 不是派来的任务：用户直接在成员会话里说的话。同步给主智能体，但不为此唤醒它（用户正在跟成员说，
  // 主对话不必插话），随它下一次开口时一并看到。
  const said = lastDirectUserText(sub.messages)
  // 成员判断要主智能体处理（如建角色、呈交文件这类它没有工具的事）：唤醒主智能体。用户在成员会话里已看到成员的回复。
  if (toMain) {
    enqueueNotice(main.id, {
      toolUseId: '',
      headline: `成员「${ref.name}」请${owner}处理：${toMain}`,
      body: [
        MEMBER_NOTICE_TAG,
        `用户直接在成员「${ref.name}」的会话里说了话（不是你派的任务），成员把这件事交给你处理。`,
        `用户说：${said || '（无文字）'}`,
        `要你做的事：${toMain}`,
        '成员的结论：',
        conclusion,
        '用户在成员的会话里已看到上面的结论。请按成员的说明接着处理（只有你能做的事你来做，要别的成员配合的用 member_send 派），处理完在这里简短回复用户。',
        '</成员通知>'
      ].join('\n'),
      wake: true,
      model
    })
    return
  }
  enqueueNotice(main.id, {
    toolUseId: '',
    headline: `你和成员「${ref.name}」的对话`,
    body: [
      MEMBER_NOTICE_TAG,
      `用户直接在成员「${ref.name}」的会话里说了话（不是你派的任务），以下供你了解进展：`,
      `用户说：${said || '（无文字）'}`,
      `成员回复：${conclusion}`,
      '</成员通知>'
    ].join('\n'),
    wake: false,
    model,
    shown: true
  })
}

/**
 * 用户在主对话里 @ 了角色或成员（见 startTurn）：还不是成员的角色自动加入名单，并给主智能体写一段说明
 * （作为本条用户消息里正文之前的独立 text 块，气泡里看不到），请它把这条消息交给被点名的成员。
 */
export function handleMentions(main: StoredSession, text: string): ContentPart | null {
  // 引用行（右键「引用」带进来的别人的话）里的 @ 不算点名；引用照样算这条消息的内容（下面 rest 用全文）。
  const own = withoutQuotes(text)
  if (!own.includes('@')) return null
  const has = (name: string): boolean => own.includes(`@${name}`)
  const ownerId = resolvePersonaId(main.personaId)
  const named: MemberRef[] = activeMembers(main.members).filter((m) => has(m.name))
  const added: { ref: MemberRef; restored: boolean }[] = []
  const full: string[] = []
  // 名字长的先匹配：「@设计师」不该再算作「@设计」。
  const roles = listPersonas()
    .filter((p) => p.enabled && p.id !== ownerId && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length)
  for (const p of roles) {
    if (!has(p.name) || named.some((m) => m.name.toLowerCase() === p.name.toLowerCase())) continue
    if (named.some((m) => m.name.includes(p.name)) || added.some((a) => a.ref.name.includes(p.name))) continue
    // @ 请来协助本对话：带上主对话当前的文件夹（成为它自己的，用户可在它的对话里卸载 / 换）。
    const r = addMember(main, {
      name: p.name,
      root: main.focusRoot ?? null,
      duty: p.description,
      origin: 'mention',
      personaId: p.id
    })
    if (typeof r === 'string') full.push(p.name)
    else added.push(r)
  }
  // 「@新建成员」（@ 联想里的「新建成员」，见 shared/mention.ts）：请主智能体按用户写的需求建一位成员。
  // 有成员或角色正好叫这个名字时，按点名处理。
  const newTokens = NEW_MEMBER_TOKENS.filter(
    (tk) => has(tk) && !named.some((m) => m.name === tk) && !roles.some((p) => p.name === tk)
  )
  if (!named.length && !added.length && !full.length && !newTokens.length) return null
  if (added.length) publishSessionsChanged()
  const mainRoot = main.focusRoot ?? null
  const mentioned = [...added.map((a) => a.ref), ...named]
  const targets = mentioned.map((m) => `「${m.name}」`).join('、')
  // 去掉 @ 之后还剩没有话：用户只是把人加进来（或点个名），没有要它做的事。
  let rest = text
  for (const m of mentioned) rest = rest.split(`@${m.name}`).join('')
  for (const n of full) rest = rest.split(`@${n}`).join('')
  for (const tk of newTokens) rest = rest.split(`@${tk}`).join('')
  const onlyMention = !rest.replace(/[\s\p{P}\p{S}]/gu, '')
  const lines = [
    mentioned.length || full.length
      ? '（系统附注：用户在这条消息里 @ 了成员。）'
      : '（系统附注：用户在这条消息里选了「新建成员」。）'
  ]
  if (newTokens.length)
    lines.push(
      onlyMention
        ? `- 用户选了「新建成员」（消息里的「@${newTokens[0]}」），但没写需求：简短问用户要新成员负责什么（能给选项就给选项），先不要建。`
        : `- 用户要新建一位成员（消息里的「@${newTokens[0]}」，其余是需求）：按需求用 create_member 建一位成员——名字、职责、负责的文件夹由你按需求定；需求里没说清文件夹、这块工作又需要文件夹时，传 pick_folder 请用户选。这是用户明确要求，不用再判断值不值得建成员。新成员只在本对话中协助工作，不是全局角色。需求里有要它马上做的事，建好后用 member_send 交给它；没有就简短告诉用户已建好、负责什么。`
    )
  for (const a of added)
    lines.push(
      a.restored
        ? `- 「${a.ref.name}」是之前移除的成员，已按用户的 @ 恢复：它用的还是原来的会话，之前的上下文都还在。`
        : `- 角色「${a.ref.name}」已按用户的 @ 作为协助者加入本对话（${a.ref.duty || '未写职责'}）：它是来帮忙的，你原来的工作照常自己做。`
    )
  if (targets)
    lines.push(
      onlyMention
        ? `- 用户只是 @ 了${targets}，没有交代要做的事：不要给它派任务，简短告诉用户已加入即可。`
        : `- 这条消息里如果有要交给${targets}做的事，用 member_send 交给它，不要自己代做（它完成后会以自己的身份直接回复用户，派完简短回一句即可）；如果只是把它加进来、没有具体要求（如「把你加进来」），就不要派任务，简短告诉用户已加入即可。`
    )
  if (full.length)
    lines.push(
      `- ${full.map((n) => `「${n}」`).join('、')}未能加入：成员已满 ${MAX_MEMBERS} 个。请告诉用户先在成员卡片里移除一个。`
    )
  const listed = added.map((a) => memberAddedRecord(memberItem(a.ref, mainRoot)).listed).flat()
  return {
    type: 'text',
    text: lines.join('\n'),
    ...(listed.length ? { listing: { kind: 'members' as const, listed } } : {})
  }
}
