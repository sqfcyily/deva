/**
 * 子智能体派发（run_subagent 新派 / send_to_subagent 续聊）：前台等结论或后台运行。由 agent-loop.ts 的工具循环调用，
 * 子智能体自己再跑一遍 runAgentLoop；所需的父轮入参与状态经 LoopRun 传入。
 */
import type { ContentPart, Message } from '../providers/types'
import { runAgentLoop, type LoopRun } from './agent-loop'
import {
  GENERAL_SUBAGENT,
  FORK_AGENT,
  getSubagentByName,
  isForkAgent,
  subagentSummaries
} from './subagents'
import {
  isSubagentBusy,
  loadSubagent,
  newSubagentId,
  pruneSubagents,
  removeSessionSubagents,
  saveSubagent,
  setSubagentBusy,
  type SubagentRecord
} from './subagent-store'
import { getSession } from './chat-store'
import { markBrowserTurnEnded } from './browser'
import { modelMessages } from './compaction'
import { DANGLING_RESULT, turnToolIds } from './chat-history'
import { degenerateMessage } from './loop-support'
import {
  type BackgroundSubagent,
  backgroundSubagents,
  shuttingDown,
  emit,
  remoteTurns
} from './chat-state'
import { buildSubagentTools, CHANGE_REPORT_RULE, buildSubagentSystem } from './chat-prompts'
import { bgGroupsWaiting, setBackgroundState, enqueueNotice } from './background-tasks'

/**
 * fork 的起始历史：主对话历史的浅拷贝（消息对象按不可变对待、与主对话共享）+ 一条合成的回灌消息。
 * 派发时主历史的末条是本步含全部 tool_use 的 assistant 消息，协议要求每个 tool_use 紧跟结果：本次 fork
 * 调用自身与同一步的其它调用各补一条说明性结果（tool_result 排在最前），再接分身的任务指令。
 */
export function buildForkHistory(history: Message[], forkCallId: string, prompt: string): Message[] {
  const out = [...history]
  const last = out[out.length - 1]
  const uses =
    last && last.role === 'assistant' && typeof last.content !== 'string'
      ? last.content.filter((p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use')
      : []
  const results: ContentPart[] = uses.map((u) => ({
    type: 'tool_result',
    toolUseId: u.id,
    content:
      u.id === forkCallId
        ? '（已派生分身，任务见下。）'
        : '（这是同一步里的其他调用，由主智能体处理，结果你看不到。）'
  }))
  out.push({
    role: 'user',
    content: [
      ...results,
      {
        type: 'text',
        text:
          '你是主智能体派生出的分身（fork），上面是你们共享的全部对话。现在只专注完成下面这项子任务：' +
          '直接动手，不要再派发子智能体，也不要向用户提问；完成后给出简洁的结论，作为交回主智能体的答复。' +
          CHANGE_REPORT_RULE +
          '\n\n任务：' +
          prompt
      }
    ]
  })
  return out
}

/** 子智能体历史末尾若是没等到结果的 tool_use（运行中途出错），补占位结果，续聊时协议才完整。 */
function closeDanglingTail(messages: Message[]): void {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return
  const uses = last.content.filter((p) => p.type === 'tool_use')
  if (uses.length === 0) return
  messages.push({
    role: 'user',
    content: uses.map((u) => ({
      type: 'tool_result' as const,
      toolUseId: (u as Extract<ContentPart, { type: 'tool_use' }>).id,
      content: DANGLING_RESULT,
      isError: true
    }))
  })
}

/**
 * 这次 run_subagent / send_to_subagent 是否在后台运行：默认后台，模型设 foreground 才在前台等结论
 * （run_in_background: false 是改默认之前的写法，同样当前台）。后台只在用户在场时可用：定时任务里一律前台跑完
 * （后台结束要靠通知唤起新一轮，无人值守时不该这样续命）；成员会话同样一律前台（后台结束唤起的成员新一轮
 * 没有派发记录，交差会被当成用户直接跟成员说的话）。Task 卡的「后台」徽标与实际派发共用这一个判断。
 */
export function runsInBackground(run: LoopRun, callArgs: unknown): boolean {
  const { sessionId, interactive } = run.args
  const { isSub } = run
  const a = (callArgs ?? {}) as { foreground?: unknown; run_in_background?: unknown }
  return (
    !isSub &&
    interactive &&
    !getSession(sessionId)?.parentId &&
    a.foreground !== true &&
    a.run_in_background !== false
  )
}

/**
 * 新派出一个子智能体（run_subagent）：建好它的记录（隔离历史 / 系统提示词 / 工具表），但不运行。
 * 未指定 / 未命中 → 一律回落内置通用子智能体，**绝不因此失败**（对标 Claude Code：未知 subagent_type
 * 同样落到 general-purpose）；名字落空时在结论前缀一行说明，免得模型以为点名的那位生效了。
 * fork 原样继承主对话：同一份历史（浅拷贝）+ 定格的 system / tools，提示缓存可整段命中。
 */
function prepareNewSubagent(
  run: LoopRun,
  tc: { id: string; args: unknown }
): { label: string; note: string; rec?: SubagentRecord; error?: string } {
  const { sessionId, history, system, tools, personaId, ctx } = run.args
  const a = (tc.args ?? {}) as { agent?: unknown; prompt?: unknown; description?: unknown }
  const wantedAgent = typeof a.agent === 'string' ? a.agent.trim() : ''
  const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
  const fork = isForkAgent(wantedAgent)
  const picked = wantedAgent && !fork ? getSubagentByName(wantedAgent) : null
  const def = picked ?? GENERAL_SUBAGENT
  const label = fork ? FORK_AGENT.name : def.name
  const note =
    wantedAgent && !fork && !picked
      ? `（没有名为「${wantedAgent}」的子智能体，已改用通用子智能体 ${GENERAL_SUBAGENT.name} 完成。可选：${subagentSummaries()
          .map((x) => x.name)
          .join('、')}。）\n`
      : ''
  if (!prompt) return { label, note, error: `派生子智能体「${label}」失败：缺少任务描述（prompt）。` }
  const now = Date.now()
  return {
    label,
    note,
    rec: {
      id: newSubagentId(sessionId, tc.id),
      sessionId,
      agent: label,
      description: typeof a.description === 'string' ? a.description.trim() : '',
      originToolId: tc.id,
      toolIds: [tc.id],
      workspaceRoot: ctx.workspaceRoot,
      system: fork ? system : buildSubagentSystem(def, ctx.workspaceRoot),
      tools: fork ? tools : buildSubagentTools(def, personaId),
      // 普通子智能体只带本次任务描述，不继承父对话（避免上下文串味与预算膨胀）。
      // fork 继承的是父对话里模型看到的那部分（压缩过就从摘要起），不是完整记录。
      messages: fork
        ? buildForkHistory(modelMessages(history), tc.id, prompt)
        : [{ role: 'user', content: prompt }],
      createdAt: now,
      updatedAt: now
    }
  }
}

/**
 * 续聊一个已派出的子智能体（send_to_subagent）：读出它落盘的记录，把这条消息接到它自己的历史后面。
 * 工作目录若已变化（其系统提示词里写的仍是旧目录），在消息前讲明新的相对路径基准。
 */
function prepareContinueSubagent(
  run: LoopRun,
  tc: { id: string; args: unknown }
): { label: string; note: string; rec?: SubagentRecord; error?: string } {
  const { sessionId, ctx } = run.args
  const a = (tc.args ?? {}) as { to?: unknown; message?: unknown }
  const to = typeof a.to === 'string' ? a.to.trim() : ''
  const message = typeof a.message === 'string' ? a.message.trim() : ''
  const rec = to ? loadSubagent(sessionId, to) : undefined
  const label = rec?.agent || to || '子智能体'
  if (!to || !message)
    return { label, note: '', error: '续聊子智能体失败：需要 to（子智能体 ID）与 message。' }
  if (!rec)
    return {
      label,
      note: '',
      error: `子智能体 ${to} 已不可用（已被清理、所在轮次被删除，或 ID 有误），请用 run_subagent 重新派发。`
    }
  if (isSubagentBusy(sessionId, to))
    return {
      label,
      note: '',
      error: [...backgroundSubagents.values()].some((b) => b.sessionId === sessionId && b.subagentId === to)
        ? `子智能体 ${to} 正在后台运行，结束后会自动通知你；请等通知到了再给它发消息。`
        : `子智能体 ${to} 正在处理另一条消息，请等它完成后再发。`
    }
  closeDanglingTail(rec.messages)
  const moved = rec.workspaceRoot !== ctx.workspaceRoot
  rec.messages.push({
    role: 'user',
    content: moved
      ? `（提示：当前工作目录已变为 ${ctx.workspaceRoot ?? '（未挂载工作区）'}，相对路径以此为准。）\n${message}`
      : message
  })
  rec.workspaceRoot = ctx.workspaceRoot
  rec.toolIds.push(tc.id)
  return { label, note: '', rec }
}

/**
 * 在子智能体记录自己的历史上跑一次 runAgentLoop（新派出与续聊共用），把结果映射成交回父轮的结论。
 * 派生本身不设闸——子智能体的每一次嵌套工具调用仍在其 runAgentLoop 内照常过同一道闸门（无后门）。
 * 递归深度上限 1：子轮 allowSubagents=false，杜绝子派生子。结束后（含中止 / 出错）落盘并解除忙状态。
 * bg：后台运行——用它自己的取消控制器（不随本轮中止），事件以空 turnId 发出并盖 bg 戳。
 */
async function runSubagentLoop(
  run: LoopRun,
  rec: SubagentRecord,
  tc: { id: string },
  bg?: AbortController
): Promise<{ conclusion: string; isErr: boolean; aborted: boolean }> {
  const { turnId, sessionId, personaId, model, effort, ctx, controller, maxSteps, depth, interactive } = run.args
  const args = run.args
  const label = rec.agent
  try {
    const sub = await runAgentLoop({
      turnId: bg ? '' : turnId,
      sessionId,
      history: rec.messages,
      system: rec.system,
      tools: rec.tools,
      personaId,
      // 子智能体恒跟随主对话（继承本轮模型与思考等级）。
      model,
      effort,
      ctx: bg ?{ workspaceRoot: ctx.workspaceRoot, signal: bg.signal } : ctx,
      controller: bg ?? controller,
      // 定时任务里派出的子智能体同受步数上限（主对话里为 undefined = 不限）。
      maxSteps,
      depth: depth + 1,
      // 跟随父轮：用户在场时照常过交互权限闸门；定时任务里同样无人值守（走 sealedDecision）。
      interactive,
      allowAskUser: false,
      allowSubagents: false,
      agentName: label,
      // 嵌套事件据此归入**本次调用**开出的那张 Task 卡（并行时唯一可靠依据）。
      parentToolId: tc.id,
      background: !!bg,
      // 子轮写入归到本次调用的 id（见 agent-loop.ts runGatedTool 的 owner），随父轮一起回滚。
      recorder: args.recorder
    })
    const aborted = sub.stopReason === 'aborted'
    const degenerate = sub.stopReason === 'degenerate'
    const isErr = sub.stopReason === 'error' || aborted || degenerate
    const partial = sub.text.trim()
    // 中止时的 text 只是半截过程输出，不能当成结论交给模型——明确标注「未完成」，
    // 免得下一轮模型把它当作子任务的正式结果继续推进。输出陷入复读而停下的同理。
    const conclusion = aborted
      ? `子智能体「${label}」被用户中止，未完成。` + (partial ? `\n中止前的最近输出：\n${partial}` : '')
      : degenerate
        ? `子智能体「${label}」执行失败：${sub.errorMessage ?? degenerateMessage()}` +
          (partial ? `\n停止前的最近输出：\n${partial}` : '')
        : partial ||
        (isErr && sub.errorMessage
          ? `子智能体「${label}」执行失败：${sub.errorMessage}`
          : '（子智能体未产生文本结论。）')
    return { conclusion, isErr, aborted }
  } catch (e) {
    return {
      conclusion: `子智能体「${label}」执行出错：${(e as Error)?.message ?? String(e)}`,
      isErr: true,
      aborted: false
    }
  } finally {
    closeDanglingTail(rec.messages)
    saveSubagent(rec)
    setSubagentBusy(sessionId, rec.id, false)
  }
}

/**
 * 执行一次 run_subagent / send_to_subagent，只把结论文本交回父轮；任何解析/执行失败都捕获成结论，
 * 父轮继续，绝不整轮失败。结论末尾附子智能体 ID，供模型之后用 send_to_subagent 找回它。
 * **可并发调用**：完成即定格自己那张 Task 卡（按调用 id 归属，与完成先后无关）。
 */
export async function runSubagentCall(
  run: LoopRun,
  tc: { id: string; name: string; args: unknown }
): Promise<{ conclusion: string; isErr: boolean }> {
  const { turnId, sessionId } = run.args
  const args = run.args
  const { evMeta } = run
  const prep =
    tc.name === 'send_to_subagent' ? prepareContinueSubagent(run, tc) : prepareNewSubagent(run, tc)
  // 默认后台（定时任务与成员会话一律前台，见 runsInBackground）。
  if (prep.rec && runsInBackground(run, tc.args)) return launchBackgroundSubagent(run, tc, prep.rec, prep.note)
  let conclusion: string
  let isErr = true
  let aborted = false
  if (prep.rec) {
    // 同步占住（首个 await 之前）：同一步里对同一子智能体的第二条消息会在准备阶段被拒。
    setSubagentBusy(sessionId, prep.rec.id, true)
    const r = await runSubagentLoop(run, prep.rec, tc)
    conclusion =
      prep.note +
      r.conclusion +
      `\n\n[子智能体 ID：${prep.rec.id}——用 send_to_subagent 发消息可让它在保留上下文的基础上继续]`
    isErr = r.isErr
    aborted = r.aborted
  } else {
    conclusion = prep.note + (prep.error ?? '')
  }

  // 摘要只写结局：界面上它紧挨着子智能体的名称显示，再带上名称就重复了。
  const subSummary = aborted ? '已中止' : isErr ? '未完成' : '已完成'
  args.onToolSummary?.(tc.id, subSummary)
  // 父轮（depth 0）事件不盖戳：run_subagent 这张卡本身即 Task 卡的「壳」，
  // 其内部嵌套事件已在递归调用里各自盖了 depth+parent 戳并折叠进来。
  emit(turnId, sessionId, {
    type: 'tool_result',
    id: tc.id,
    name: tc.name,
    summary: subSummary,
    isError: isErr,
    ...(evMeta ?? {})
  })
  return { conclusion, isErr }
}

/**
 * 后台派出（默认；见 runsInBackground）：子智能体在自己的取消控制器下开跑，本次调用立即带着「已在后台启动」交回
 * 父轮；Task 卡保持运行中，嵌套事件照常收进卡里。它结束时定格 Task 卡、写边车，并把结论排进通知队列——
 * 主智能体正忙就在下一步带上，空闲就自动起一轮（见 wakeForNotices）。
 */
function launchBackgroundSubagent(
  run: LoopRun,
  tc: { id: string; name: string; args: unknown },
  rec: SubagentRecord,
  note: string
): { conclusion: string; isErr: boolean } {
  const { turnId, sessionId, model } = run.args
  const label = rec.agent
  const own = (tc.args as { description?: unknown } | null)?.description
  const title = (typeof own === 'string' && own.trim()) || rec.description || label
  const bg = new AbortController()
  // 派发它的这一轮是手机端发起的：它结束后起的那一轮同样按手机端算（回复推到手机，桌面不弹提醒）。
  const fromRemoteTurn = remoteTurns.has(turnId)
  const entry: BackgroundSubagent = {
    sessionId,
    subagentId: rec.id,
    controller: bg,
    silent: false,
    stoppedByUser: false,
    group: turnId
  }
  setSubagentBusy(sessionId, rec.id, true)
  backgroundSubagents.set(tc.id, entry)
  setBackgroundState(sessionId, tc.id, 'running', '后台运行中')
  void runSubagentLoop(run, rec, tc, bg)
    .then((r) => {
      backgroundSubagents.delete(tc.id)
      // 它开的后台网页同回合结束一样计时（用户停止的不会自动起轮，见下）
      markBrowserTurnEnded(sessionId)
      // 同组（同一轮派出）还有在跑的：交给最后结束的那一个唤醒主智能体，一并汇总（见下）。
      const othersPending = [...backgroundSubagents.values()].some((b) => b.group === entry.group)
      if (entry.silent) {
        if (!othersPending) bgGroupsWaiting.delete(entry.group)
        // 所在轮次 / 会话已被删：它刚落盘的记录同样作废（删除那一刻它还在跑，剪枝跳过了它）。
        // 退出途中被中止的不算，记录留着，重启后仍可续聊。
        if (!shuttingDown) {
          const s = getSession(sessionId)
          if (s) pruneSubagents(sessionId, new Set(turnToolIds(s.messages).flat()))
          else removeSessionSubagents(sessionId)
        }
        return
      }
      const stopped = entry.stoppedByUser
      // 摘要只写结局（界面上紧挨着子智能体名称显示）；通知标题另写全称。
      const summary = stopped ? '已停止' : r.isErr ? '未完成' : '已完成'
      setBackgroundState(sessionId, tc.id, r.isErr ? 'error' : 'ok', summary)
      emit('', sessionId, { type: 'tool_result', id: tc.id, name: tc.name, summary, isError: r.isErr, bg: true })
      const status = stopped ? '已被用户停止' : r.isErr ? '未完成' : '已完成'
      // 同一轮派出的后台子智能体是一组，等最后一个结束才唤醒主智能体一次、一并汇总（对话里不会一个结论起一轮）。
      // 先结束的通知照常排队：主智能体正忙就随下一步带上，空闲就等着。用户亲手停的单独不唤醒，但同组已有
      // 结论在等它时照样唤醒（不然那几项的结论就没人处理了）。同成员的汇总组，见 reportMemberTurn。
      let wake = false
      if (othersPending) {
        if (!stopped) bgGroupsWaiting.add(entry.group)
      } else {
        wake = !stopped || bgGroupsWaiting.has(entry.group)
        bgGroupsWaiting.delete(entry.group)
      }
      enqueueNotice(sessionId, {
        toolUseId: tc.id,
        headline: `后台子智能体「${title}」${status}`,
        body: [
          '<后台子智能体通知>',
          `子智能体：${label}（ID：${rec.id}）`,
          `任务：${title}`,
          `状态：${status}`,
          '结论：',
          r.conclusion,
          `（用 send_to_subagent 给 ${rec.id} 发消息可让它在保留上下文的基础上继续。）`,
          '</后台子智能体通知>'
        ].join('\n'),
        wake,
        model,
        remote: fromRemoteTurn,
        subagent: stopped ? 'stopped' : r.isErr ? 'failed' : 'done'
      })
    })
    .catch((e) => console.warn('[subagents] 后台子智能体收尾失败：', e))
  return {
    conclusion:
      note +
      `子智能体「${label}」已在后台启动（ID：${rec.id}）。它结束后系统会自动通知你（这一轮派出的几个会等全部结束再一起通知），` +
      '届时再据结论继续；在此之前不要轮询、等待或查看它的进度：接着做不依赖它结论的事；没有的话简短告诉用户交给了子智能体在查什么，结束这一轮等通知。',
    isErr: false
  }
}
