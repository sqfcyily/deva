/**
 * 名片草稿：模型提议的原始工具参数归一化后的形状，主进程（重建历史）与渲染层（实时流）共用同一份。
 */

/** 角色名片草稿：propose_agent 原始参数归一化后的形状（编辑器 / 名片消费）。 */
export interface AgentDraft {
  name: string
  desc: string
  model: string
  prompt: string
}

/**
 * 定时任务确认名片草稿：create_task 原始参数归一化后的形状（名片 / 编辑器消费）。
 * schedule 扁平化为恒有 at/cron/tz 字符串（不适用者为空串），便于编辑器双向绑定；tz 空 = 创建时按本地时区补。
 * 授权信封（personaId / modelRef）不由模型提议——由用户在名片里议定，此草稿只承载模型的建议部分。
 */
export interface AutotaskDraft {
  title: string
  prompt: string
  schedule: { kind: 'once' | 'recurring'; at: string; cron: string; tz: string }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const record = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' ? v : {}) as Record<string, unknown>

/**
 * 归一化 propose_agent 的原始参数为角色草稿：description→desc、补空 model。
 * 头像不由模型提议（无从得知部件词表）：名片按 name 确定性渲染，用户接受后可在编辑器定制。
 */
export function normalizeAgentDraft(input: unknown): AgentDraft {
  const a = record(input)
  return {
    name: str(a.name).trim(),
    desc: str(a.description).trim(),
    model: '',
    prompt: str(a.prompt)
  }
}

/** 归一化 create_task 的原始参数为定时任务草稿。日程校验 / 时区补全留待创建时（createTask + 渲染层）。 */
export function normalizeAutotaskDraft(input: unknown): AutotaskDraft {
  const a = record(input)
  const sched = record(a.schedule)
  return {
    title: str(a.title).trim(),
    prompt: str(a.prompt),
    schedule: {
      kind: sched.kind === 'once' ? 'once' : 'recurring',
      at: str(sched.at).trim(),
      cron: str(sched.cron).trim(),
      tz: str(sched.tz).trim()
    }
  }
}
