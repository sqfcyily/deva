import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useI18n } from '../i18n/i18n'
import { useModels } from './models'
import { useWorkspace } from './workspace'

/**
 * 会话状态（渲染层）。
 * 真正的对话历史、工具执行、密钥与文件访问都在主进程闭环；对话历史「按项目绑定」并持久化，
 * 这里只：
 * 1) 维护「左侧会话列表 + 当前会话」，切项目/切会话时向主进程拉取清单 / 重建气泡；
 * 2) 采集用户输入（可带附件路径），带上「当前默认模型 + 当前项目根」发 chat:send；
 * 3) 订阅 chat:event 流，把富事件累积成可渲染的消息块（文本 / 思考 / 工具卡 / 权限卡 / 错误）。
 * 每个助手回合聚合为一条 assistant 消息，块按到达顺序排列。
 */

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied'

export type AttachKind = 'image' | 'document' | 'text'

/** 每项目权限模式（与 preload/主进程对齐）：逐次询问 / 自动接受项目内编辑 / 全自动。 */
export type PermMode = 'ask' | 'acceptEdits' | 'auto'

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: ToolStatus; summary?: string }
  | { kind: 'permission'; key: string; toolName: string; args: unknown; resolved?: 'allow' | 'deny' }
  | { kind: 'error'; message: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  /** 用户消息附件贴片（仅名称 + 类型，不含正文/base64）。 */
  attachments?: { name: string; kind: AttachKind }[]
}

/** 会话元信息（左侧列表用）。 */
export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** send 接受的附件（路径给主进程读取，名称/类型用于本地乐观气泡）。 */
export interface SendAttachment {
  path: string
  name: string
  kind: AttachKind
}

/**
 * 流式活跃状态（供底部"工作状态指示器"用）。
 * elapsedSec 本轮已用秒数（在跳=还活着）；reconnecting 非 null 表示主进程正在自动重连
 * （真实信号，来自 reconnecting 事件，非猜测）。非 streaming 时归零。
 */
export interface StreamStatus {
  elapsedSec: number
  reconnecting: { attempt: number; max: number } | null
}

/** 与 preload/主进程 DisplayMessage 结构一致（渲染层结构化复述）。 */
type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }
type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: AttachKind }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

/** 与 preload/主进程 ChatStreamEvent 结构一致（按既定模式在渲染层复述线缆类型）。 */
type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; summary: string; isError: boolean }
  | { type: 'permission_request'; key: string; toolName: string; args: unknown }
  | { type: 'usage'; input: number; output: number }
  | { type: 'reconnecting'; attempt: number; max: number }
  | { type: 'stream_reset' }
  | { type: 'error'; kind: string; message: string }
  | { type: 'done'; stopReason: string }

interface ChatContextValue {
  sessions: SessionMeta[]
  currentSessionId: string
  messages: ChatMessage[]
  streaming: boolean
  /** 流式实时状态（底部工作指示器用；非 streaming 时为归零值）。 */
  streamStatus: StreamStatus
  send: (text: string, attachments?: SendAttachment[]) => Promise<void>
  stop: () => void
  newSession: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  respondPermission: (key: string, decision: 'allow' | 'deny', remember: boolean) => void
  /** 当前项目的权限模式（授权姿态）。 */
  permMode: PermMode
  /** 切换当前项目的权限模式（即时持久化到 ~/.deva/permissions.json）。 */
  setPermMode: (mode: PermMode) => void
}

const ChatContext = createContext<ChatContextValue | null>(null)

/** 空闲态的流式状态（归零）。 */
const IDLE_STATUS: StreamStatus = { elapsedSec: 0, reconnecting: null }

let seq = 0
function genId(prefix = 'm'): string {
  seq = (seq + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

/** 主进程重建的展示消息 → 渲染层气泡。 */
function displayToMessages(dms: DisplayMessage[]): ChatMessage[] {
  return dms.map((dm) => {
    if (dm.role === 'user') {
      return {
        id: genId(),
        role: 'user',
        blocks: dm.text ? [{ kind: 'text', text: dm.text }] : [],
        attachments: dm.attachments.length ? dm.attachments : undefined
      }
    }
    const blocks: ChatBlock[] = dm.blocks.map((b) =>
      b.kind === 'text'
        ? { kind: 'text', text: b.text }
        : {
            kind: 'tool',
            id: b.id,
            name: b.name,
            args: b.args,
            status: b.status === 'error' ? 'error' : 'ok',
            summary: b.summary
          }
    )
    return { id: genId(), role: 'assistant', blocks }
  })
}

/** 把一个流事件并入助手消息的块序列（纯函数，返回新数组）。 */
function reduceBlocks(blocks: ChatBlock[], ev: StreamEvent): ChatBlock[] {
  const next = blocks.slice()
  const last = next[next.length - 1]
  switch (ev.type) {
    case 'text_delta':
      if (last?.kind === 'text') next[next.length - 1] = { ...last, text: last.text + ev.text }
      else next.push({ kind: 'text', text: ev.text })
      return next
    case 'thinking_delta':
      if (last?.kind === 'thinking') next[next.length - 1] = { ...last, text: last.text + ev.text }
      else next.push({ kind: 'thinking', text: ev.text })
      return next
    case 'tool_call':
      next.push({ kind: 'tool', id: ev.id, name: ev.name, args: ev.args, status: 'running' })
      return next
    case 'tool_result': {
      const i = next.findIndex((b) => b.kind === 'tool' && b.id === ev.id)
      if (i >= 0) {
        const b = next[i] as Extract<ChatBlock, { kind: 'tool' }>
        // 已被本地标记为 denied 的保持 denied（用户拒绝早于主进程回执到达）
        const status: ToolStatus =
          b.status === 'denied' ? 'denied' : ev.isError ? 'error' : 'ok'
        next[i] = { ...b, status, summary: status === 'denied' ? b.summary : ev.summary }
      }
      return next
    }
    case 'permission_request':
      next.push({ kind: 'permission', key: ev.key, toolName: ev.toolName, args: ev.args })
      return next
    case 'error':
      next.push({ kind: 'error', message: ev.message })
      return next
    default:
      return blocks
  }
}

/**
 * 重连前丢弃「当前步骤」已画出的残缺尾部。
 * 一个回合里，前序步骤必以工具块收尾（有工具结果才会有下一步）；中途断流时残缺内容
 * 永远是最后一个工具块之后那段 thinking/text。故截到最后一个工具块为止即可，主进程
 * 会带着已提交历史重跑该步、把这段重新生成。无工具块则整条清空。
 */
function dropStepPartial(blocks: ChatBlock[]): ChatBlock[] {
  let lastTool = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'tool') {
      lastTool = i
      break
    }
  }
  if (lastTool === blocks.length - 1) return blocks // 已在工具块处收尾，无残缺
  return blocks.slice(0, lastTool + 1)
}

function updateLastAssistant(
  list: ChatMessage[],
  fn: (blocks: ChatBlock[]) => ChatBlock[]
): ChatMessage[] {
  if (list.length === 0) return list
  const last = list[list.length - 1]
  if (last.role !== 'assistant') return list
  const nextBlocks = fn(last.blocks)
  if (nextBlocks === last.blocks) return list
  const copy = list.slice()
  copy[copy.length - 1] = { ...last, blocks: nextBlocks }
  return copy
}

export function ChatProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel } = useModels()
  const { activeProject } = useWorkspace()

  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [permMode, setPermModeState] = useState<PermMode>('ask')
  const [streamStatus, setStreamStatus] = useState<StreamStatus>(IDLE_STATUS)

  const sessionIdRef = useRef<string>('')
  const projectPathRef = useRef<string | null>(null)
  const currentTurnRef = useRef<string | null>(null)
  const streamingRef = useRef(false)
  // 计时锚点：本轮开始时刻（供"已用秒数"计时）。
  const startedAtRef = useRef(0)
  // 是否正处于自动重连中（真实信号，来自主进程 reconnecting 事件）。
  const reconnectingRef = useRef(false)
  const setStreamingBoth = (v: boolean): void => {
    streamingRef.current = v
    setStreaming(v)
  }

  const setCurrent = (id: string): void => {
    sessionIdRef.current = id
    setCurrentSessionId(id)
  }

  // 拉取当前项目会话清单（左侧只列真实已落盘的会话）。
  const refreshSessions = useCallback(async (): Promise<void> => {
    const path = projectPathRef.current
    const list = await window.deva.chat.listSessions(path)
    if (projectPathRef.current !== path) return // 项目已切换，丢弃过期结果
    setSessions(list)
  }, [])

  // 起一个全新的空会话：只切换当前会话 + 清空右侧，不往左侧插占位条目。
  // 会话在用户首次发送时由主进程惰性建档，随后 refreshSessions 才让它出现在左侧。
  const startFresh = useCallback((): void => {
    setCurrent(genId('sess'))
    setMessages([])
  }, [])

  // 切项目：重载会话清单 + 载入最近一条（无则起新会话）。
  useEffect(() => {
    const path = activeProject?.path ?? null
    projectPathRef.current = path
    let cancelled = false
    void (async () => {
      const list = await window.deva.chat.listSessions(path)
      if (cancelled || projectPathRef.current !== path) return
      if (list.length) {
        setSessions(list)
        const id = list[0].id
        setCurrent(id)
        const dms = await window.deva.chat.loadSession(id, path)
        if (cancelled || sessionIdRef.current !== id) return
        setMessages(displayToMessages(dms as DisplayMessage[]))
      } else {
        setSessions([])
        startFresh()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeProject?.path, startFresh])

  // 切项目：加载该项目的权限模式（各项目可不同；未设置默认 ask）。
  useEffect(() => {
    const path = activeProject?.path ?? null
    let cancelled = false
    void (async () => {
      const m = await window.deva.perm.getMode(path)
      if (!cancelled && projectPathRef.current === path) setPermModeState(m)
    })()
    return () => {
      cancelled = true
    }
  }, [activeProject?.path])

  // 订阅主进程流事件（挂载一次）。按 sessionId 过滤，忽略他会话事件。
  useEffect(() => {
    const unsub = window.deva.chat.onEvent((payload) => {
      if (payload.sessionId !== sessionIdRef.current) return
      const ev = payload.event as StreamEvent
      if (ev.type === 'done') {
        reconnectingRef.current = false
        setStreamingBoth(false)
        void refreshSessions() // 标题/排序可能已更新
        return
      }
      // 主进程真实信号：断流后正在自动重连（展示"连接中断，正在重连"横幅）。
      if (ev.type === 'reconnecting') {
        reconnectingRef.current = true
        setStreamStatus((s) => ({ ...s, reconnecting: { attempt: ev.attempt, max: ev.max } }))
        return
      }
      // 重连即将重跑当前步骤：丢弃这一步已画出的残缺尾部，避免重复内容。
      if (ev.type === 'stream_reset') {
        setMessages((prev) => updateLastAssistant(prev, dropStepPartial))
        return
      }
      if (ev.type === 'usage') return
      // 任何真实内容事件到达即视为"已恢复"，收起重连横幅。
      if (reconnectingRef.current) {
        reconnectingRef.current = false
        setStreamStatus((s) => ({ ...s, reconnecting: null }))
      }
      setMessages((prev) => updateLastAssistant(prev, (blocks) => reduceBlocks(blocks, ev)))
    })
    return unsub
  }, [refreshSessions])

  // 流式计时器：streaming 期间每秒刷新「已用秒数」（reconnecting 由事件驱动，不在此动）。
  // 非流式时整体归零（含清掉可能残留的重连横幅）。
  useEffect(() => {
    if (!streaming) {
      setStreamStatus(IDLE_STATUS)
      return
    }
    const tick = (): void => {
      const sec = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000))
      setStreamStatus((s) => ({ ...s, elapsedSec: sec }))
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [streaming])

  const value = useMemo<ChatContextValue>(() => {
    const send = async (text: string, attachments?: SendAttachment[]): Promise<void> => {
      const body = text.trim()
      const atts = attachments ?? []
      if ((!body && atts.length === 0) || streamingRef.current) return

      const model = activeModel
      const blocks: ChatBlock[] = body ? [{ kind: 'text', text: body }] : []
      const userMsg: ChatMessage = {
        id: genId(),
        role: 'user',
        blocks,
        attachments: atts.length ? atts.map((a) => ({ name: a.name, kind: a.kind })) : undefined
      }

      if (!model) {
        setMessages((prev) => [
          ...prev,
          userMsg,
          { id: genId(), role: 'assistant', blocks: [{ kind: 'error', message: t('chat.noModel') }] }
        ])
        return
      }

      setMessages((prev) => [...prev, userMsg, { id: genId(), role: 'assistant', blocks: [] }])
      // 计时锚点先于置流：计时器启动即读到有效起点，避免首帧秒数为负。
      startedAtRef.current = Date.now()
      reconnectingRef.current = false
      setStreamStatus(IDLE_STATUS)
      setStreamingBoth(true)
      try {
        const { turnId } = await window.deva.chat.send({
          sessionId: sessionIdRef.current,
          text: body,
          model: {
            adapter: model.provider.adapter,
            providerId: model.provider.id,
            baseURL: model.provider.apiHost,
            model: model.model.id
          },
          workspaceRoot: projectPathRef.current,
          attachments: atts.length ? atts.map((a) => a.path) : undefined
        })
        currentTurnRef.current = turnId
        // 主进程发送时已惰性建档并落盘：立即刷新左侧，让新会话即时出现并高亮
        void refreshSessions()
      } catch (e) {
        setStreamingBoth(false)
        const msg = (e as Error)?.message ?? String(e)
        setMessages((prev) =>
          updateLastAssistant(prev, (b) => [...b, { kind: 'error', message: msg }])
        )
      }
    }

    const stop = (): void => {
      if (currentTurnRef.current) void window.deva.chat.abort(currentTurnRef.current)
    }

    const newSession = (): void => {
      if (streamingRef.current) return
      startFresh()
    }

    const selectSession = (id: string): void => {
      if (id === sessionIdRef.current || streamingRef.current) return
      setCurrent(id)
      void (async () => {
        const dms = await window.deva.chat.loadSession(id, projectPathRef.current)
        if (sessionIdRef.current !== id) return
        setMessages(displayToMessages(dms as DisplayMessage[]))
      })()
    }

    const deleteSession = (id: string): void => {
      if (streamingRef.current) return
      void (async () => {
        await window.deva.chat.deleteSession(id, projectPathRef.current)
        const path = projectPathRef.current
        const list = await window.deva.chat.listSessions(path)
        if (projectPathRef.current !== path) return
        if (id === sessionIdRef.current) {
          if (list.length) {
            const nid = list[0].id
            setSessions(list)
            setCurrent(nid)
            const dms = await window.deva.chat.loadSession(nid, path)
            if (sessionIdRef.current !== nid) return
            setMessages(displayToMessages(dms as DisplayMessage[]))
          } else {
            setSessions([])
            startFresh()
          }
        } else {
          setSessions(list)
        }
      })()
    }

    const respondPermission = (
      key: string,
      decision: 'allow' | 'deny',
      remember: boolean
    ): void => {
      void window.deva.chat.respondPermission({ key, decision, remember })
      setMessages((prev) =>
        updateLastAssistant(prev, (blocks) => {
          const next = blocks.map((b) =>
            b.kind === 'permission' && b.key === key ? { ...b, resolved: decision } : b
          )
          if (decision === 'deny') {
            for (let i = next.length - 1; i >= 0; i--) {
              const b = next[i]
              if (b.kind === 'tool' && b.status === 'running') {
                next[i] = { ...b, status: 'denied', summary: undefined }
                break
              }
            }
          }
          return next
        })
      )
    }

    const setPermMode = (mode: PermMode): void => {
      setPermModeState(mode)
      void window.deva.perm.setMode(projectPathRef.current, mode)
    }

    return {
      sessions,
      currentSessionId,
      messages,
      streaming,
      streamStatus,
      send,
      stop,
      newSession,
      selectSession,
      deleteSession,
      respondPermission,
      permMode,
      setPermMode
    }
  }, [
    sessions,
    currentSessionId,
    messages,
    streaming,
    streamStatus,
    permMode,
    activeModel,
    t,
    startFresh,
    refreshSessions
  ])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat 必须在 ChatProvider 内使用')
  return ctx
}
