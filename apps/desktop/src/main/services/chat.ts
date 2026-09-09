import { ipcMain, type BrowserWindow } from 'electron'
import { streamChat } from '../providers'
import type { ContentPart, Message, StopReason } from '../providers/types'
import { evaluate, rememberSession, clearSession } from './permissions'
import { executeTool, toolSpecs, type ToolContext } from './tools'
import {
  deriveTitle,
  ensureSession,
  getSession,
  deleteSession as deleteStoredSession,
  listSessions,
  projectKey,
  save as saveProject,
  type ChatSessionMeta
} from './chat-store'
import { ATTACH_TEXT_PREFIX, buildAttachmentPart } from './attachments'

/**
 * 会话编排（Agent 主循环）。
 * 流式生成 → 收集工具调用 → 过权限闸门 → 执行 → 结果回灌 → 继续，直至无工具调用或达上限。
 * 对话历史只存主进程（sessions），渲染层仅发新用户文本；工具/密钥/文件访问都在主进程内闭环。
 */

type AdapterKind = 'anthropic' | 'openai'

interface ChatModelConfig {
  adapter: AdapterKind
  providerId: string
  baseURL: string
  model: string
}

interface ChatSendRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
  workspaceRoot: string | null
  /** 用户经原生选择框挑选的附件绝对路径（正文由主进程读取，base64 不经渲染层）。 */
  attachments?: string[]
}

/** 重建历史用的展示消息（主进程从 provider Message[] 归约，去掉 base64 负载）。 */
type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }

export type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

/**
 * provider Message[] → 展示消息序列（供切换/重开会话时重建气泡）。
 * 工具结果回灌消息不单独成气泡，而是回填上一条 assistant 的工具卡状态；
 * 附件仅重建为「名称 + 类型」的贴片（不回传 base64）。思考块为易逝态，不重建。
 */
function toDisplayMessages(messages: Message[]): DisplayMessage[] {
  const out: DisplayMessage[] = []
  let lastAssistant: Extract<DisplayMessage, { role: 'assistant' }> | null = null

  for (const m of messages) {
    if (m.role === 'assistant') {
      const parts: ContentPart[] =
        typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      const blocks: DisplayBlock[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) blocks.push({ kind: 'text', text: p.text })
        else if (p.type === 'tool_use')
          blocks.push({ kind: 'tool', id: p.id, name: p.name, args: p.input, status: 'ok' })
      }
      const msg: Extract<DisplayMessage, { role: 'assistant' }> = { role: 'assistant', blocks }
      out.push(msg)
      lastAssistant = msg
      continue
    }

    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', text: m.content, attachments: [] })
      continue
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
          if (b) b.status = p.isError ? 'error' : 'ok'
        }
      }
      continue
    }

    // 真实用户消息（可能带附件）：附件在前、提问正文在最后一个 text 块
    const atts: { name: string; kind: 'image' | 'document' | 'text' }[] = []
    const textParts = parts.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    for (const p of parts) {
      if (p.type === 'image') atts.push({ name: p.name ?? '图片', kind: 'image' })
      else if (p.type === 'document') atts.push({ name: p.name ?? '文档', kind: 'document' })
    }
    for (let i = 0; i < textParts.length - 1; i++) {
      const tp = textParts[i]
      if (tp.text.startsWith(ATTACH_TEXT_PREFIX))
        atts.push({ name: tp.text.slice(ATTACH_TEXT_PREFIX.length).split('\n')[0].trim(), kind: 'text' })
    }
    const question = textParts.length ? textParts[textParts.length - 1].text : ''
    out.push({ role: 'user', text: question, attachments: atts })
  }
  return out
}

interface PermissionResponse {
  key: string
  decision: 'allow' | 'deny'
  remember: boolean
}

/** 发往渲染层的富事件（比 provider 的 StreamEvent 多了工具执行/权限阶段）。 */
export type ChatStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; summary: string; isError: boolean }
  | { type: 'permission_request'; key: string; toolName: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  /** 连接中断、正在自动重连（transient；attempt/max 供 UI 显示进度）。 */
  | { type: 'reconnecting'; attempt: number; max: number }
  /** 重连前置：丢弃本步骤已画出的残缺尾部，随后重新流式（无法无缝续传，只能重发本步）。 */
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  | { type: 'done'; stopReason: StopReason }

const MAX_STEPS = 25
/** 单个步骤因可重试网络错误自动重连的最大次数。 */
const MAX_RECONNECT = 3

/** 可被取消打断的睡眠：正常到点 resolve(true)，signal 触发则 resolve(false)。 */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
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

const activeTurns = new Map<string, AbortController>()
const pending = new Map<string, { resolve: (r: { decision: 'allow' | 'deny'; remember: boolean }) => void; turnId: string }>()

let idCounter = 0
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

function systemPrompt(workspaceRoot: string | null): string {
  const loc = workspaceRoot
    ? `当前工作目录：${workspaceRoot}。路径可用相对该目录的写法。`
    : '当前未打开任何项目文件夹；涉及文件的操作需先请用户打开项目。'
  return [
    '你是 Deva，一个面向开发者的桌面编程助手（类似 Codex / Claude Code）。',
    '你能通过工具读取、浏览、写入用户已打开项目中的文件，帮助用户理解与修改代码。',
    loc,
    '工具使用原则：先用 read_file / list_dir 了解现状，再动手；write_file 会覆盖整个文件，务必先读后写、保留无关内容。',
    '关于授权：当你决定写入/修改文件时，**直接调用 write_file 工具**即可——应用会自动弹出授权界面，由用户在界面上点「允许」或「拒绝」。',
    '**切勿**在回复文字里询问「是否允许写入 / 是否同意覆盖 / 请确认」之类的话——用户无法用文字回复授权，只能通过应用弹出的授权按钮操作；用文字征求授权等于让操作卡死。',
    '需要动手时就调用相应工具，不要只声明打算做什么便停下等待确认。若工具调用被用户拒绝，再据此说明或改用其他不需该操作的方式。',
    '回答使用简体中文，简洁、准确，必要时给出关键文件路径与行号。'
  ].join('\n')
}

export function registerChatIpc(getWindow: () => BrowserWindow | null): void {
  function emit(turnId: string, sessionId: string, event: ChatStreamEvent): void {
    getWindow()?.webContents.send('chat:event', { turnId, sessionId, event })
  }

  function requestPermission(
    turnId: string,
    sessionId: string,
    toolName: string,
    args: unknown
  ): Promise<{ decision: 'allow' | 'deny'; remember: boolean }> {
    const key = genId('perm')
    emit(turnId, sessionId, { type: 'permission_request', key, toolName, args })
    return new Promise((resolve) => pending.set(key, { resolve, turnId }))
  }

  async function runTurn(
    key: string,
    sessionId: string,
    turnId: string,
    config: ChatModelConfig,
    workspaceRoot: string | null
  ): Promise<void> {
    const controller = new AbortController()
    activeTurns.set(turnId, controller)
    const ctx: ToolContext = { workspaceRoot }
    const session = ensureSession(key, sessionId)
    const history = session.messages

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        let assistantText = ''
        let toolCalls: { id: string; name: string; args: unknown }[] = []
        let stopReason: StopReason = 'end_turn'

        // 单步流式 + 自动重连：遇可重试网络错误（含空闲僵死）→ 丢弃残缺尾部、退避后重发本步。
        // 无状态中转不支持断点续流，只能整步重发；已完成的前序步骤（工具卡/文本）不受影响。
        reconnect: for (let attempt = 0; ; attempt++) {
          assistantText = ''
          toolCalls = []
          stopReason = 'end_turn'
          let retryableDrop = false
          let fatal = false

          for await (const ev of streamChat(
            { adapter: config.adapter, providerId: config.providerId, baseURL: config.baseURL },
            {
              model: config.model,
              system: systemPrompt(workspaceRoot),
              messages: history,
              tools: toolSpecs,
              signal: controller.signal
            }
          )) {
            if (ev.type === 'text_delta') {
              assistantText += ev.text
              emit(turnId, sessionId, { type: 'text_delta', text: ev.text })
            } else if (ev.type === 'thinking_delta') {
              emit(turnId, sessionId, { type: 'thinking_delta', text: ev.text })
            } else if (ev.type === 'tool_call') {
              toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
              emit(turnId, sessionId, { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args })
            } else if (ev.type === 'usage') {
              emit(turnId, sessionId, { type: 'usage', input: ev.input, output: ev.output })
            } else if (ev.type === 'error') {
              // 可重试且非用户中止 → 暂不上报，走自动重连；否则作为致命错误立即上报。
              if (ev.error.retryable && !controller.signal.aborted) retryableDrop = true
              else {
                fatal = true
                emit(turnId, sessionId, { type: 'error', kind: ev.error.kind, message: ev.error.message })
              }
            } else if (ev.type === 'done') {
              stopReason = ev.stopReason
            }
          }

          if (controller.signal.aborted) {
            emit(turnId, sessionId, { type: 'done', stopReason: 'aborted' })
            return
          }
          if (fatal) {
            emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
            return
          }
          if (retryableDrop) {
            if (attempt >= MAX_RECONNECT) {
              emit(turnId, sessionId, {
                type: 'error',
                kind: 'network',
                message: `连接多次中断，已重试 ${MAX_RECONNECT} 次仍失败，已停止。`
              })
              emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
              return
            }
            emit(turnId, sessionId, { type: 'reconnecting', attempt: attempt + 1, max: MAX_RECONNECT })
            const resumed = await delay(Math.min(1000 * 2 ** attempt, 8000), controller.signal)
            if (!resumed) {
              emit(turnId, sessionId, { type: 'done', stopReason: 'aborted' })
              return
            }
            // 通知渲染层丢弃本步已画出的残缺尾部，随后 continue 重发本步
            emit(turnId, sessionId, { type: 'stream_reset' })
            continue reconnect
          }
          break // 本步干净结束
        }

        // 落地本轮助手消息（文本 + 工具调用）
        const content: ContentPart[] = []
        if (assistantText) content.push({ type: 'text', text: assistantText })
        for (const tc of toolCalls)
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
        if (content.length) history.push({ role: 'assistant', content })

        if (stopReason === 'aborted' || stopReason === 'error') {
          emit(turnId, sessionId, { type: 'done', stopReason })
          return
        }
        if (toolCalls.length === 0) {
          emit(turnId, sessionId, { type: 'done', stopReason })
          return
        }

        // 逐个执行工具（过权限闸门），结果回灌为一条 user 消息
        const resultParts: ContentPart[] = []
        for (const tc of toolCalls) {
          if (controller.signal.aborted) {
            emit(turnId, sessionId, { type: 'done', stopReason: 'aborted' })
            return
          }
          let allowed = evaluate(sessionId, key, tc.name) === 'allow'
          if (!allowed) {
            const r = await requestPermission(turnId, sessionId, tc.name, tc.args)
            allowed = r.decision === 'allow'
            if (allowed && r.remember) rememberSession(sessionId, tc.name)
          }

          if (!allowed) {
            emit(turnId, sessionId, {
              type: 'tool_result',
              id: tc.id,
              name: tc.name,
              summary: '已拒绝',
              isError: true
            })
            resultParts.push({
              type: 'tool_result',
              toolUseId: tc.id,
              content: '用户拒绝了该操作。',
              isError: true
            })
            continue
          }

          const res = await executeTool(tc.name, tc.args, ctx)
          emit(turnId, sessionId, {
            type: 'tool_result',
            id: tc.id,
            name: tc.name,
            summary: res.summary,
            isError: Boolean(res.isError)
          })
          resultParts.push({
            type: 'tool_result',
            toolUseId: tc.id,
            content: res.content,
            isError: res.isError
          })
        }
        history.push({ role: 'user', content: resultParts })
      }

      // 达到步数上限
      emit(turnId, sessionId, {
        type: 'error',
        kind: 'server',
        message: `已达到单轮最大工具步数（${MAX_STEPS}），已停止。`
      })
      emit(turnId, sessionId, { type: 'done', stopReason: 'end_turn' })
    } catch (e) {
      emit(turnId, sessionId, {
        type: 'error',
        kind: 'unknown',
        message: (e as Error)?.message ?? String(e)
      })
      emit(turnId, sessionId, { type: 'done', stopReason: 'error' })
    } finally {
      activeTurns.delete(turnId)
      // 本轮对 history 的原地改写落盘；更新时间用于左侧列表排序
      session.updatedAt = Date.now()
      saveProject(key)
    }
  }

  // 发送用户消息 → 启动一轮（fire-and-forget），返回 turnId
  ipcMain.handle('chat:send', async (_e, payload: ChatSendRequest): Promise<{ turnId: string }> => {
    const { sessionId, text, model, workspaceRoot, attachments } = payload
    const key = projectKey(workspaceRoot)
    const session = ensureSession(key, sessionId)
    const history = session.messages

    // 构建本条用户消息：附件内容块在前，提问正文（最后一个 text 块）在后
    const parts: ContentPart[] = []
    const notes: string[] = []
    if (attachments?.length) {
      for (const path of attachments) {
        const { part, note } = await buildAttachmentPart(path, model.adapter)
        if (part) parts.push(part)
        if (note) notes.push(note)
      }
    }
    const question = text.trim() || (parts.length ? '请理解并处理上述附件。' : '')
    const questionText = notes.length ? `${question}\n（${notes.join('；')}）` : question
    if (parts.length) {
      parts.push({ type: 'text', text: questionText })
      history.push({ role: 'user', content: parts })
    } else {
      history.push({ role: 'user', content: questionText })
    }

    // 首条用户文本派生会话标题
    if (!session.title) session.title = deriveTitle(text) || deriveTitle(questionText)
    session.updatedAt = Date.now()
    saveProject(key)

    const turnId = genId('turn')
    void runTurn(key, sessionId, turnId, model, workspaceRoot)
    return { turnId }
  })

  // 左侧会话列表（按项目）
  ipcMain.handle(
    'chat:list-sessions',
    (_e, workspaceRoot: string | null): ChatSessionMeta[] => listSessions(projectKey(workspaceRoot))
  )

  // 载入某会话的历史（重建展示气泡）
  ipcMain.handle(
    'chat:load-session',
    (_e, sessionId: string, workspaceRoot: string | null): DisplayMessage[] => {
      const s = getSession(projectKey(workspaceRoot), sessionId)
      return s ? toDisplayMessages(s.messages) : []
    }
  )

  // 删除某会话（含会话级授权）
  ipcMain.handle(
    'chat:delete-session',
    (_e, sessionId: string, workspaceRoot: string | null): { ok: true } => {
      deleteStoredSession(projectKey(workspaceRoot), sessionId)
      clearSession(sessionId)
      return { ok: true }
    }
  )

  // 中止某一轮：取消流并把该轮的待决权限一律按拒绝解开
  ipcMain.handle('chat:abort', (_e, turnId: string): { ok: true } => {
    activeTurns.get(turnId)?.abort()
    for (const [key, p] of pending) {
      if (p.turnId === turnId) {
        pending.delete(key)
        p.resolve({ decision: 'deny', remember: false })
      }
    }
    return { ok: true }
  })

  // 重置会话历史与会话级授权（清空该会话正文但保留会话条目）
  ipcMain.handle(
    'chat:reset',
    (_e, sessionId: string, workspaceRoot: string | null): { ok: true } => {
      const key = projectKey(workspaceRoot)
      const s = getSession(key, sessionId)
      if (s) {
        s.messages = []
        s.updatedAt = Date.now()
        saveProject(key)
      }
      clearSession(sessionId)
      return { ok: true }
    }
  )

  // 用户对权限请求的答复
  ipcMain.handle('chat:permission-response', (_e, payload: PermissionResponse): { ok: boolean } => {
    const p = pending.get(payload.key)
    if (!p) return { ok: false }
    pending.delete(payload.key)
    p.resolve({ decision: payload.decision, remember: payload.remember })
    return { ok: true }
  })
}
