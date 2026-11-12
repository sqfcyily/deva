import { randomBytes } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'
import { isEn } from '../locale'
import { estimateTextTokens } from '../../shared/context'
import type { ContentPart, Message } from '../providers/types'
import type { StoredSession } from './chat-store'

/**
 * 工具结果的上下文治理（对标 Claude Code）。
 *
 * 1. 超长输出存文件（spillLongOutput）：结果超过上限时，全文存进 `<DEVA_HOME>/data/tool-results/<对话 id>/`，
 *    模型只拿开头和结尾的预览加文件路径，需要时用 read_file / grep 自取。一次输出不会把上下文撑大，
 *    结尾的报错与汇总也不会像只留开头那样被截掉。
 *
 * 2. 缓存过期后清理旧结果（clearStaleToolResults）：开新一轮时，若距上次请求已超过服务商的提示缓存有效期，
 *    把较早的大块工具结果换成一行占位（原文存文件可查），只保留最近 KEEP_RECENT 个。
 *    **缓存还热时一律不动历史**：改写某处，其后的缓存全部失效，下一次请求要整段重算；缓存已过期时整段
 *    本来就要重算，此时清理不多花钱，之后每一步还都更小。清出量不到 CLEAR_AT_LEAST 也不动——收益太小。
 */

/** 对话 id → 目录名：只留白名单字符（同 chat-store 的 safeId），杜绝路径穿越。 */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '') || '_'
}

/** 某对话的工具结果文件夹（不创建）。没有对话 id（极少）时归到 `_misc`。 */
export function toolResultsDir(sessionId?: string): string {
  return join(getDevaHome(), 'data', 'tool-results', sessionId ? safeName(sessionId) : '_misc')
}

/** 删除对话时一并删掉它的工具结果文件夹。 */
export function removeToolResults(sessionId: string): void {
  try {
    rmSync(toolResultsDir(sessionId), { recursive: true, force: true })
  } catch {
    /* 删除失败无害：只是留下几个文本文件 */
  }
}

/** 写入一个结果文件，返回绝对路径；写不进（磁盘满、没权限）返回 null。 */
function writeResultFile(sessionId: string | undefined, name: string, text: string): string | null {
  try {
    const dir = toolResultsDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${safeName(name)}.txt`)
    writeFileSync(file, text, 'utf8')
    return file
  } catch {
    return null
  }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ── 1. 超长输出存文件 ────────────────────────────────────────────────────────────

/** 预览的开头 / 结尾各取多少字符（CC 的预览约 2000 字节；结尾常是报错与汇总，两头都留）。 */
const PREVIEW_HEAD = 1500
const PREVIEW_TAIL = 1500

/** 取开头约 n 个字符，尽量断在换行处（不把一行切成两半）。 */
function headOf(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.lastIndexOf('\n', n)
  return s.slice(0, cut > n / 2 ? cut : n)
}

/** 取结尾约 n 个字符，尽量从换行处开始。 */
function tailOf(s: string, n: number): string {
  if (s.length <= n) return s
  const from = s.length - n
  const nl = s.indexOf('\n', from)
  return s.slice(nl >= 0 && nl < from + n / 2 ? nl + 1 : from)
}

/**
 * 结果超过 limit 字符时：全文存文件，返回「说明 + 路径 + 开头和结尾预览」；没超过原样返回。
 * 文件写不进时退回只给预览（开头、结尾各半个 limit），并写明其余内容已丢弃。
 * label 用作文件名前缀（如 command），便于用户在文件夹里分辨。
 */
export function spillLongOutput(
  text: string,
  limit: number,
  sessionId: string | undefined,
  label: string
): string {
  if (text.length <= limit) return text
  const en = isEn()
  const name = `${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const file = writeResultFile(sessionId, name, text)
  if (!file) {
    const head = headOf(text, Math.floor(limit / 2))
    const tail = tailOf(text, Math.floor(limit / 2))
    const omitted = text.length - head.length - tail.length
    return en
      ? `Output too long (${fmt(text.length)} characters) and could not be saved; only the start and end are shown, the rest was dropped. If the tool can filter or page its output, run it again for the part you need.\n\n${head}\n[… ${fmt(omitted)} characters omitted …]\n${tail}`
      : `输出过长（共 ${fmt(text.length)} 字符），且未能保存完整内容，以下只保留开头和结尾，其余已丢弃。如果工具能筛选或分页，请重新执行取需要的部分。\n\n${head}\n[……中间省略 ${fmt(omitted)} 字符……]\n${tail}`
  }
  const head = headOf(text, PREVIEW_HEAD)
  const tail = tailOf(text, PREVIEW_TAIL)
  const omitted = text.length - head.length - tail.length
  return en
    ? `Output too long (${fmt(text.length)} characters). Full output saved to: ${file}\nUse read_file to read it in parts, or grep to search it.\n\nPreview (start and end):\n${head}\n[… ${fmt(omitted)} characters omitted …]\n${tail}`
    : `输出过长（共 ${fmt(text.length)} 字符），完整内容已保存到：${file}\n需要细看时用 read_file 分段读取，或用 grep 搜索。\n\n预览（开头和结尾）：\n${head}\n[……中间省略 ${fmt(omitted)} 字符……]\n${tail}`
}

// ── 2. 缓存过期后清理旧结果 ──────────────────────────────────────────────────────

/** 只清理这些「可以重新获取、或原文另存即可」的工具的结果。 */
const CLEARABLE = new Set(['read_file', 'list_dir', 'glob', 'grep', 'web_fetch', 'run_command', 'browser'])

/**
 * 可清理的工具：上面这些 + MCP 工具（名字是 `服务id__工具名`，内置工具名都只用单下划线）。
 * 刻意不清：ask_user（用户的回答）、exit_plan（计划与意见）、run_subagent / send_to_subagent（子智能体的结论，
 * 重跑代价大）、skill（技能正文，清掉等于忘了技能怎么用）、记忆 / 待办 / 交付 / 名片等结果本身就短的工具。
 */
function clearable(name: string | undefined): boolean {
  return !!name && (CLEARABLE.has(name) || name.includes('__'))
}

/** 保留最近多少个可清理的结果（同 CC 的 keepToolUses）。 */
const KEEP_RECENT = 12
/** 至少能清出这么多 token 才动手（同 CC 的 clearAtLeastTokens）。 */
const CLEAR_AT_LEAST = 20_000
/** 原文不到这么多字符的结果不清：换成占位省不了几个字，白白改写历史。 */
const MIN_CLEAR_CHARS = 1_000
/** 一张图约计的 token（同 compaction 的估算）。 */
const IMAGE_TOKENS = 1600

/**
 * 提示缓存多久不用就过期。Claude 官方与中转的缓存默认 5 分钟；其余服务商的自动前缀缓存各家不一、多不公开
 * （OpenAI 闲置 5~10 分钟、最长约 1 小时，也有保留更久的），统一按 1 小时算，宁晚勿早——缓存还热时清理
 * 会让其后整段重新计费。各加几分钟余量（CC 对 1 小时缓存用的是 65 分钟）。
 */
const IDLE_CLAUDE_MS = 6 * 60_000
const IDLE_DEFAULT_MS = 65 * 60_000

function idleThreshold(model: { adapter: string; model: string }): number {
  return model.adapter === 'anthropic' && /claude/i.test(model.model) ? IDLE_CLAUDE_MS : IDLE_DEFAULT_MS
}

const CLEARED_ZH = '[较早的工具结果已清理'
const CLEARED_EN = '[Older tool result cleared'

function isCleared(content: string): boolean {
  return content.startsWith(CLEARED_ZH) || content.startsWith(CLEARED_EN)
}

function placeholder(chars: number, file: string | null, images: number, en: boolean): string {
  const img = images
    ? en
      ? ` Its ${images} image(s) were removed; read the file again if you need to see them.`
      : `其中 ${images} 张图片已移除，需要再看请重新读取。`
    : ''
  if (en)
    return file
      ? `${CLEARED_EN} to save context] The original (${fmt(chars)} characters) is saved at: ${file}. Use read_file if you need it; for files and searches, calling the tool again gives fresh results.${img}`
      : `${CLEARED_EN} to save context] The original (${fmt(chars)} characters) could not be saved; call the tool again if you need it.${img}`
  return file
    ? `${CLEARED_ZH}以节省上下文] 原结果 ${fmt(chars)} 字符，已保存到：${file}。需要时用 read_file 查看；文件、搜索类结果也可以重新调用工具获取最新内容。${img}`
    : `${CLEARED_ZH}以节省上下文] 原结果 ${fmt(chars)} 字符，未能保存；需要时请重新调用工具。${img}`
}

type ResultPart = Extract<ContentPart, { type: 'tool_result' }>

export interface ClearOutcome {
  /** 清理了几个结果。 */
  cleared: number
  /** 估算清出的 token 数。 */
  tokens: number
}

/**
 * 缓存已过期时清理较早的工具结果（就地改写 session.messages，不落盘——调用方随本轮一起保存）。
 * 只看模型仍看得到的部分：from = 对话记录里仍发给模型的起点（compaction.ts 的 modelStart），
 * 更早的已不发给模型，清了也省不下什么。
 * 返回 null = 没动（缓存可能还热、没有足够可清的内容）。
 * 只换 tool_result 的内容，不增删消息、不动成败标记：轮下标、工具卡状态、检查点（按 toolUseId）都不受影响。
 */
export function clearStaleToolResults(
  session: StoredSession,
  model: { adapter: string; model: string },
  from = 0,
  now = Date.now()
): ClearOutcome | null {
  const last = session.lastRequestAt ?? session.updatedAt
  if (!last || now - last < idleThreshold(model)) return null

  const msgs = session.messages
  const names = new Map<string, string>()
  for (const m of msgs)
    if (m.role === 'assistant' && typeof m.content !== 'string')
      for (const p of m.content) if (p.type === 'tool_use') names.set(p.id, p.name)

  // 按出现顺序收集可清理的结果；最近 KEEP_RECENT 个（含已清理过的）保留原样。
  const slots: { mi: number; pi: number; part: ResultPart }[] = []
  msgs.forEach((m, mi) => {
    if (mi < from || m.role !== 'user' || typeof m.content === 'string') return
    m.content.forEach((p, pi) => {
      if (p.type === 'tool_result' && clearable(names.get(p.toolUseId))) slots.push({ mi, pi, part: p })
    })
  })
  const candidates = slots
    .slice(0, Math.max(0, slots.length - KEEP_RECENT))
    .filter(({ part }) => !isCleared(part.content) && (part.content.length >= MIN_CLEAR_CHARS || part.images?.length))

  let tokens = 0
  for (const { part } of candidates)
    tokens += estimateTextTokens(part.content) + (part.images?.length ?? 0) * IMAGE_TOKENS
  if (tokens < CLEAR_AT_LEAST) return null

  const en = isEn()
  const touched = new Map<number, ContentPart[]>()
  for (const { mi, pi, part } of candidates) {
    const file = part.content ? writeResultFile(session.id, part.toolUseId, part.content) : null
    const parts = touched.get(mi) ?? [...(msgs[mi].content as ContentPart[])]
    touched.set(mi, parts)
    const next: ResultPart = {
      ...part,
      content: placeholder(part.content.length, file, part.images?.length ?? 0, en)
    }
    delete next.images
    parts[pi] = next
  }
  for (const [mi, parts] of touched) msgs[mi] = { ...(msgs[mi] as Message), content: parts }

  // 上一轮的真实用量是压缩触发依据：扣掉清出的部分，免得紧接着又按旧读数误触发一次摘要压缩。
  if (session.lastInputTokens) session.lastInputTokens = Math.max(0, Math.round(session.lastInputTokens - tokens))
  return { cleared: candidates.length, tokens: Math.round(tokens) }
}
