import type { AskQuestion } from './chat-protocol'
import type { PromptView } from './remote-views'
import type { WebReceipt } from './remote-web'

/**
 * 手机版交互卡处理之后的一行回执。电脑端按对话记录生成（remote/web/views.ts），手机按刚处理的卡片生成（处理完先显示，
 * 等对话记录里的那条到了再换过去）：两边用同一套文案，换的时候看不出来。
 */

/** 计划的标题：正文第一行去掉 Markdown 标记，太长截断。 */
function planTitle(plan: string): string {
  const line = plan.split('\n').find((l) => l.trim()) ?? ''
  const t = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').replace(/[*_`]/g, '').trim()
  return t.length > 30 ? `${t.slice(0, 30)}…` : t
}

/** answers：每题一项（空串 = 这题没答）；null = 没回答就结束了（取消 / 中止 / 超时）。 */
export function askReceipt(questions: Pick<AskQuestion, 'question'>[], answers: string[] | null): WebReceipt {
  if (answers === null || !questions.length) return { k: 'receipt', tone: 'off', text: '问题已结束，未作答' }
  const a = questions.map((_, i) => (answers[i] ?? '').trim())
  if (questions.length === 1)
    return a[0]
      ? { k: 'receipt', tone: 'ok', text: questions[0].question, strong: a[0] }
      : { k: 'receipt', tone: 'off', text: `${questions[0].question}　未作答` }
  const detail = questions.map((q, i) => `**${q.question}**  \n${a[i] || '未作答'}`).join('\n\n')
  return a.some(Boolean)
    ? { k: 'receipt', tone: 'ok', text: `已回答 ${questions.length} 个问题`, detail }
    : { k: 'receipt', tone: 'off', text: `已跳过 ${questions.length} 个问题`, detail }
}

export function planReceipt(plan: string, decision: 'approve' | 'keep' | 'ignore' | 'cancelled'): WebReceipt {
  const title = planTitle(plan)
  const detail = plan.trim() || undefined
  const lead =
    decision === 'approve' ? '已批准计划' : decision === 'keep' ? '继续完善计划' : decision === 'ignore' ? '已忽略计划' : '计划审阅已结束'
  return {
    k: 'receipt',
    tone: decision === 'approve' ? 'ok' : decision === 'keep' ? 'redo' : 'off',
    text: title ? `${lead}：${title}` : lead,
    detail
  }
}

export function mountReceipt(state: 'mounted' | 'skipped' | 'cancelled', root?: string): WebReceipt {
  if (state === 'mounted') {
    const name = root?.split(/[\\/]/).filter(Boolean).pop()
    return { k: 'receipt', tone: 'ok', text: '已挂载文件夹', strong: name || root }
  }
  return { k: 'receipt', tone: 'off', text: state === 'skipped' ? '已跳过挂载文件夹' : '挂载请求已结束' }
}

export function autotaskReceipt(title: string, created: boolean): WebReceipt {
  const name = title.trim() || '定时任务'
  return created
    ? { k: 'receipt', tone: 'ok', text: `已创建定时任务「${name}」` }
    : { k: 'receipt', tone: 'off', text: `已忽略定时任务「${name}」` }
}

export function agentReceipt(name: string, accepted: boolean): WebReceipt {
  const n = name.trim() || '新角色'
  return accepted
    ? { k: 'receipt', tone: 'ok', text: `已添加角色「${n}」` }
    : { k: 'receipt', tone: 'off', text: `已拒绝角色「${n}」` }
}

/** 已处理的交互卡 → 回执（还没处理的返回 null）。 */
export function promptReceipt(view: PromptView): WebReceipt | null {
  if (view.state === 'open') return null
  switch (view.kind) {
    case 'ask':
      return askReceipt(view.questions, view.state === 'answered' ? (view.answers ?? []) : null)
    case 'plan':
      return planReceipt(view.plan, view.state)
    case 'mount':
      return mountReceipt(view.state, view.root)
    case 'autotask':
      return autotaskReceipt(view.title, view.state === 'created')
    case 'agent':
      return agentReceipt(view.name, view.state === 'accepted')
  }
}
