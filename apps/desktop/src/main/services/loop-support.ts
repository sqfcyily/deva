/**
 * agent 循环的辅助：自动重连的上限、输出预算与思考等级的降级记忆、引导模型自我纠正的提示语、
 * 参数残缺的工具调用如何记录与回灌。都不依赖会话状态。
 */

import type {
  ChatModelConfig
} from '../../shared/chat-protocol'
import { createHash } from 'node:crypto'
import {
  type BrokenCallCause,
  type ContentPart,
  type EffortLevel
} from '../providers/types'
import { clampEffort, effortRequest, type EffortRequest } from '../../shared/effort'
import {
  OUTPUT_BUDGET_SAFE, autoOutputBudget
} from '../../shared/context'
import { REPEAT_STOP } from '../../shared/limits'
import {
  modelOverrides
} from './model-resolve'
import { isEn } from '../locale'
import {
  AUTO_MARKER, learnedOutputBudget
} from './compaction'

/**
 * 单个步骤因可重试错误（断网 / 空闲僵死 / 429 / 5xx）自动重连的最大次数。退避 1s→2s→4s… 封顶
 * RECONNECT_MAX_DELAY_MS，服务端给了 retry-after 则以它为准（同样封顶）。合计约 1.5 分钟的耐心，
 * 足以扛过网关抖动与短时限流，而不必让用户回来发「继续」。
 */
export const MAX_RECONNECT = 6

export const RECONNECT_MAX_DELAY_MS = 30_000

/**
 * 每步输出预算（max_tokens）：用户在模型详情页填的值 > 自动（shared/context.ts 的 autoOutputBudget：
 * Claude 系 32K——旧的固定 8192 对带思考的新模型太小，思考吃光预算、一字未出就撞限，sess_muje1nu3_a
 * 即此例；其余维持适配器 / 服务商默认，以免撞上不认大预算的网关）。
 * 某模型拒绝该预算（400 output_limit）则进程内记住，降回保守值。键带预算值：用户改了设置就按新值重试。
 */
export const outputBudgetRejected = new Set<string>()

export function wantedOutputBudget(model: ChatModelConfig): number | undefined {
  return (
    modelOverrides(model.providerId, model.model).maxOutput ??
    autoOutputBudget(model.adapter, model.model) ??
    learnedOutputBudget(model)
  )
}

export function outputBudgetKey(model: ChatModelConfig, budget: number | undefined): string {
  return `${model.providerId}:${model.model}:${budget ?? 'default'}`
}

export function outputBudget(model: ChatModelConfig): number | undefined {
  const want = wantedOutputBudget(model)
  return outputBudgetRejected.has(outputBudgetKey(model, want)) ? OUTPUT_BUDGET_SAFE : want
}

/**
 * 被拒过的思考等级（键 `providerId:model:level`）：某模型 / 网关不认该档参数（400 effort_unsupported）则进程内
 * 记住，此后按「默认」发（不带参数），同 outputBudgetRejected。键带档位：OpenAI 系常只缺 xhigh，换低一档仍可用。
 */
export const effortRejected = new Set<string>()

export function effortKey(model: { providerId: string; model: string }, level: EffortLevel): string {
  return `${model.providerId}:${model.model}:${level}`
}

/**
 * 本次请求实际要发的思考参数：先按模型能力表把对话存的档位收敛到该模型支持的档（shared/effort.ts），
 * 再取该档的请求参数（格式按协议 + 服务地址判定）。'default' / 缺省 / 模型不支持 / 已被拒 → undefined。
 */
export function sentEffort(
  model: ChatModelConfig,
  level: EffortLevel | undefined
): { level: EffortLevel; req: EffortRequest } | undefined {
  const lv = clampEffort(model.adapter, model.model, level ?? 'default')
  const req = effortRequest(model.adapter, model.model, model.baseURL, lv)
  if (!req || effortRejected.has(effortKey(model, lv))) return undefined
  return { level: lv, req }
}

/**
 * 一步以 max_tokens 收尾且**没有工具调用**（只有思考 / 半截正文）时，注入引导让模型接着做，而不是
 * 交还用户等「继续」。hadText 区分两种症状，给出不同的纠偏：没写出东西 → 少想、直接动手；
 * 写了半截 → 从断点续写。
 */
export function truncatedNudge(hadText: boolean): string {
  return hadText
    ? `${AUTO_MARKER}
（系统自动续写）你上一条回复因达到单次输出长度上限被截断。请从断点处直接接着写，` +
        '不要重复已写出的内容；如果剩余内容仍很长，改为写入文件并分段（write_file + append）。'
    : `${AUTO_MARKER}
（系统自动续写）你上一步把单次输出额度全部耗在了思考上，没有产出任何正文或工具调用，` +
        '被截断了。请减少思考、直接行动：先做最小的一步（调用工具或给出简短回复），' +
        '大段内容写入文件并分段（write_file + append）。'
}

/** 定时任务到达步数上限后的收尾请求：不再执行工具，让模型就已有结果给出总结（见 AgentLoopArgs.maxSteps）。 */
export function stepLimitNudge(max: number): string {
  return (
    `${AUTO_MARKER}
（系统提示）本次运行已达到步数上限（${max} 步），不能再调用工具，即使调用也不会执行。` +
    '请基于目前已有的结果直接给出最终总结：说明已完成的部分、尚未完成的部分及原因。'
  )
}

/** 原地打转提醒：附在第 REPEAT_WARN 次起的工具结果之后（照常执行，不打断）。 */
export function repeatReminder(tool: string, count: number): string {
  return (
    `\n\n（系统提示）你已用相同参数连续 ${count} 次调用 ${tool}，结果都没有变化。` +
    `请换个做法，或直接基于已有结果给出结论；连续 ${REPEAT_STOP} 次将停止调用工具。`
  )
}

/** 原地打转到 REPEAT_STOP 次后的收尾请求：同 stepLimitNudge，不再执行工具，让模型说明卡在哪里。 */
export function repeatStopNudge(tool: string, count: number): string {
  return (
    `${AUTO_MARKER}
（系统提示）你已用相同参数连续 ${count} 次调用 ${tool}，结果都没有变化，工具调用已停止，即使调用也不会执行。` +
    '请基于目前已有的结果直接给出回复：说明已完成的部分、卡在哪里，以及建议的下一步。'
  )
}

/**
 * 回复陷入逐字复读、重试后仍如此而停下时的说明（自愈⑤）：子智能体据此给父轮交「执行失败」结论，
 * 定时任务记进运行历史。对话里的提示由渲染层按 notice 码 degenerate 另行翻译。
 */
export function degenerateMessage(): string {
  return isEn()
    ? 'The model kept repeating the same text verbatim, even after a retry, so the reply was stopped. Long context often causes this; try compacting or switching models.'
    : '模型输出陷入逐字重复，重试后仍如此，已停止。上下文过长常会导致这种情况，可压缩上下文或换个模型再试。'
}

/**
 * 一次工具调用的指纹（工具名 + 参数 + 结果，含错误标记与图片）：原地打转判定用。取哈希而非拼接原文，
 * 免得截图等大结果在内存里多留一份。
 */
export function callFingerprint(
  name: string,
  args: unknown,
  r: Extract<ContentPart, { type: 'tool_result' }>
): string {
  const h = createHash('sha1')
  h.update(name).update('\0').update(JSON.stringify(args) ?? '').update('\0')
  h.update(r.isError ? '1' : '0').update(r.content)
  for (const img of r.images ?? []) h.update('\0').update(img.data)
  return h.digest('hex')
}

/** 本轮自然结束却没有任何可见输出时的追问（每轮最多一次）。 */
export const EMPTY_NUDGE =
  `${AUTO_MARKER}
（系统自动追问）你上一步没有输出任何内容就结束了。请继续完成用户的任务；` +
  '如果任务已经完成，请简要告诉用户结果；如果确实需要用户决定，请用 ask_user 提问。'

/**
 * 工具参数没能完整解析（适配器报 tool_call_truncated：撞上输出上限、被内容策略截断、或参数不是合法
 * JSON）：连续这么多步都如此就停下，交回「已截断」提示。前几次记成失败的工具调用、回灌纠正提示，
 * 模型拆小后自然接着做；一直拆不小（比如每次都在长篇思考上耗光预算）则不再空转。主轮步数不设上限，
 * 这道闸必须有。
 */
export const MAX_TRUNCATED_STREAK = 4

/** 写进被截断调用 tool_use 里的标记：展示层据此一律画成普通工具卡（它不是能被答复的问答 / 计划 / 名片）。 */
export const TRUNCATED_FLAG = '__truncated'

/**
 * 被截断调用在历史里的 input：残缺参数不可执行，也不值得每步重发——只留能捞出的目标路径
 * （path 通常是第一个字段，截断多发生在其后的大段内容里）与截断标记。
 */
export function truncatedCallInput(partialArgs: string): Record<string, unknown> {
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialArgs)
  let path: string | undefined
  if (m)
    try {
      path = JSON.parse(`"${m[1]}"`) as string
    } catch {
      /* 转义残缺：不带路径 */
    }
  return { ...(path ? { path } : {}), [TRUNCATED_FLAG]: true }
}

/** 参数残缺调用的工具卡摘要。 */
export const BROKEN_CALL_LABEL: Record<BrokenCallCause, string> = {
  max_tokens: '输出超长，未执行',
  refusal: '内容被拦截，未执行',
  invalid: '参数无效，未执行'
}

/**
 * 参数残缺调用的回灌结果：讲清「没执行、没改动」及原因，并给一个模型能照做的尺度——按它这次写到的
 * 字符数折半（连续第二次再折成三分之一），它数不准 token，但能估字符与行数。
 */
export function truncatedCallResult(
  name: string,
  partialChars: number,
  cause: BrokenCallCause,
  streak: number
): string {
  const limit = Math.max(1000, Math.floor(partialChars / (streak + 1) / 100) * 100)
  const split =
    name === 'write_file'
      ? '先用 write_file 写入开头一部分，再用 append: true 分次追加其余部分。'
      : '把内容拆成多次较小的调用依次完成。'
  if (cause === 'refusal')
    return (
      `内容被拦截：本次 ${name} 调用的参数写到约 ${partialChars} 字符时被服务商的内容安全审核拦截，` +
      `未执行，没有产生任何改动。${streak > 1 ? `这已是连续第 ${streak} 次被拦截。` : ''}` +
      `可换种表述或拆成更小的几段重试；仍被拦截就停下，告诉用户哪部分内容写不进去。`
    )
  if (cause === 'invalid')
    return (
      `参数无效：本次 ${name} 调用的参数（约 ${partialChars} 字符）不是完整、合法的 JSON，无法解析，` +
      `未执行，没有产生任何改动。${streak > 1 ? `这已是连续第 ${streak} 次参数无效，请把每段切得更小。` : ''}` +
      `参数过长时容易被中途截断，请重新调用并确保参数是合法 JSON；内容较长时请分段完成，` +
      `每段控制在约 ${limit} 字符以内：${split}`
    )
  return (
    `输出长度超限：本次 ${name} 调用的参数写到约 ${partialChars} 字符时达到单次回复的输出上限，被截断，` +
    `未执行，没有产生任何改动。${streak > 1 ? `这已是连续第 ${streak} 次截断，请把每段切得更小。` : ''}` +
    `请分段完成，每段控制在约 ${limit} 字符以内：${split}`
  )
}

/** 可被取消打断的睡眠：正常到点 resolve(true)，signal 触发则 resolve(false)。 */
export function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
