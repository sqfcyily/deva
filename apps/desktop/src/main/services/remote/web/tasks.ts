import type { WebModel, WebTask, WebTaskAction, WebTaskStatus } from '../../../../shared/remote-web'
import { isEn } from '../../../locale'
import { getSession } from '../../chat-store'
import { deleteTask, getTask, listTasks, previewSchedule, runTaskNow, setTaskStatus } from '../../tasks'
import type { TaskRecord } from '../../tasks-types'
import { modelList } from './views'

/**
 * Deva 手机版的定时任务：抽屉「定时任务」的列表与详情（对比稿 design/mobile-tasks.html 方案 A）。
 * 第一版只看不改：暂停 / 恢复、立即运行、删除，与电脑端「定时任务」页同一套服务（main/services/tasks.ts）。
 */

/** 列表顺序：进行中（按下次运行）→ 出错 → 已暂停 → 已完成；同组按下次运行升序、再按创建时间降序。 */
const ORDER: Record<WebTaskStatus, number> = { active: 0, error: 1, paused: 2, completed: 3 }

export function taskList(): WebTask[] {
  const models = modelList()
  const locale = isEn() ? 'en' : 'zh-CN'
  return listTasks()
    .sort((a, b) => {
      const g = ORDER[a.status] - ORDER[b.status]
      if (g) return g
      const an = a.nextRunAt ?? Number.POSITIVE_INFINITY
      const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY
      return an !== bn ? an - bn : b.createdAt - a.createdAt
    })
    .map((t) => taskView(t, models, locale))
}

function taskView(t: TaskRecord, models: WebModel[], locale: 'en' | 'zh-CN'): WebTask {
  // 已完成的一次性任务时间必然已过：只读展示传 allowPast，照样给出人读摘要。
  const p = previewSchedule(t.schedule, locale, true)
  const last = t.runs[t.runs.length - 1]
  const owner = t.ownerSessionId ? getSession(t.ownerSessionId) : null
  return {
    id: t.id,
    title: t.title || (locale === 'en' ? 'Untitled' : '未命名任务'),
    schedule: p.ok ? p.description : (t.schedule.cron ?? t.schedule.at ?? ''),
    status: t.status,
    nextRunAt: t.status === 'active' ? t.nextRunAt : null,
    lastRun: last ? { at: last.firedAt, status: last.status } : undefined,
    personaId: t.auth.personaId ?? undefined,
    model: modelLabel(t.auth.modelRef, models),
    owner: owner && t.ownerSessionId ? { sid: t.ownerSessionId, title: owner.title || (locale === 'en' ? 'New chat' : '新对话') } : undefined,
    // 任务对话第一次运行时才建，被删了下次运行再建：不在就不给「查看对话」。
    sessionId: getSession(t.sessionId) ? t.sessionId : undefined
  }
}

/** 同电脑端任务详情：服务商 · 模型；跟随默认时缺省；模型已删则原样给出引用。 */
function modelLabel(ref: string | null, models: WebModel[]): string | undefined {
  if (!ref) return undefined
  const m = models.find((x) => x.ref === ref)
  return m ? `${m.provider} · ${m.name}` : ref
}

/** 手机上的操作。立即运行时任务已在运行 / 排队：ok 且 message 非空（手机提示一句，不算出错）。 */
export function taskAction(id: unknown, action: unknown): { ok: boolean; message: string } {
  const t = typeof id === 'string' ? getTask(id) : null
  if (!t) return { ok: false, message: '这个定时任务不存在或已被删除。' }
  switch (action as WebTaskAction) {
    case 'pause':
      if (t.status === 'active') setTaskStatus(t.id, 'paused')
      return { ok: true, message: '' }
    case 'resume':
      // 一次性任务已完成：再置为进行中也不会再触发（同电脑端不给「恢复」）。
      if (t.status === 'completed') return { ok: false, message: '这个一次性任务已经完成，不能恢复。' }
      if (t.status !== 'active') setTaskStatus(t.id, 'active')
      return { ok: true, message: '' }
    case 'run': {
      const r = runTaskNow(t.id)
      if (!r.ok) return { ok: false, message: r.reason === 'not-found' ? '这个定时任务不存在或已被删除。' : '电脑上的定时任务还没准备好，请稍后再试。' }
      return { ok: true, message: r.already ? '这个任务正在运行。' : '' }
    }
    case 'delete':
      deleteTask(t.id)
      return { ok: true, message: '' }
    default:
      return { ok: false, message: '不支持的操作。' }
  }
}
