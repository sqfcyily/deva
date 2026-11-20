import type { AskQuestion } from './chat-protocol'

/**
 * 远程通道的出站视图（hub 产出，各平台适配器渲染）与卡片动作。
 * 放在 shared：手机网页端（src/mobile）直接按这些形状渲染，与主进程共用一份定义。
 */

export type ActionValue =
  | { k: 'ask'; key: string }
  | { k: 'plan'; key: string; d: 'approve' | 'keep' | 'ignore' }
  | { k: 'mount'; key: string }
  | { k: 'use'; sid: string }
  /** /new 角色卡上选中某个角色（pid = 角色 id）。 */
  | { k: 'new'; pid: string }
  /** 名片决议：带 sid + 工具调用 id，处理时从会话历史里取草稿（无状态，重启后按钮照样有效）。 */
  | { k: 'autotask'; sid: string; tool: string; a: 'create' | 'dismiss' }
  | { k: 'agent'; sid: string; tool: string; a: 'accept' | 'reject' }
  | { k: 'stop'; turn: string }

/** 回合正文块。工具调用不在 IM 上展示，只在状态行提示「正在…」。 */
export type TurnBlock = { kind: 'text'; text: string } | { kind: 'notice'; text: string } | { kind: 'error'; text: string }

export type TurnStatus = 'running' | 'waiting' | 'retrying' | 'done' | 'aborted' | 'error'

/**
 * 一轮回复的实时视图。内容过长时 hub 分页（每页一条平台消息），适配器只渲染单页。
 * 只有末页带状态与操作按钮；前面的页是已定格的正文。
 */
export interface TurnPage {
  turnId: string
  sessionTitle: string
  personaName: string
  index: number
  /** 是否末页（显示状态、耗时、停止按钮）。 */
  last: boolean
  blocks: TurnBlock[]
  status: TurnStatus
  /** 状态补充（正在做什么 / 重连进度 / 中断原因 …）。 */
  statusText?: string
  elapsedSec: number
}

export type PromptView =
  | {
      kind: 'ask'
      key: string
      sessionId: string
      sessionTitle: string
      questions: AskQuestion[]
      state: 'open' | 'answered' | 'cancelled'
      answers?: string[]
    }
  | {
      kind: 'plan'
      key: string
      sessionId: string
      sessionTitle: string
      plan: string
      state: 'open' | 'approve' | 'keep' | 'ignore' | 'cancelled'
    }
  | {
      kind: 'mount'
      key: string
      sessionId: string
      sessionTitle: string
      /** 卡片上的问句（模型调用 mount_workspace 时给的，可缺省）。 */
      question?: string
      state: 'open' | 'mounted' | 'skipped' | 'cancelled'
      root?: string
      /** 为成员选文件夹：成员名（主角色建成员时的 pick_folder，或成员做到一半来要）。 */
      member?: string
    }
  /** 定时任务确认名片（key = create_task 的工具调用 id）。 */
  | {
      kind: 'autotask'
      key: string
      sessionId: string
      sessionTitle: string
      title: string
      prompt: string
      /** 日程人读摘要；日程无效时为 null，error 给原因。 */
      schedule: string | null
      nextRunAt: number | null
      personaName: string
      modelName: string
      state: 'open' | 'created' | 'dismissed'
      error?: string
    }
  /** 角色名片（key = propose_agent 的工具调用 id）。 */
  | {
      kind: 'agent'
      key: string
      sessionId: string
      sessionTitle: string
      name: string
      desc: string
      prompt: string
      state: 'open' | 'accepted' | 'rejected'
    }

/** 聊天式回复（回复方式 =「仅最终结果」）的一条消息：Markdown 正文，note 为末尾一行补充说明（被截断等）。 */
export interface ReplyView {
  text: string
  note?: string
}

/** 一条通知（指令回执 / 定时任务完成 …）。buttons 为可选的快捷动作。 */
export interface NoticeView {
  title?: string
  text: string
  /** 关联的对话（手机网页端把通知挂到该对话上；IM 适配器不用）。 */
  sessionId?: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  buttons?: { label: string; value: ActionValue; primary?: boolean }[]
  /** row = 按钮横排一行（少量快捷动作）；column = 每个按钮独占一行、撑满宽度（列表选择）。 */
  buttonLayout?: 'row' | 'column'
}
