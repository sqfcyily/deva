import { contextBridge, ipcRenderer } from 'electron'

/** 目录项（单层）。 */
export interface DirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

/** 打开文件夹结果。 */
export interface OpenFolderResult {
  path: string
  name: string
}

/** 读取文件结果（可能因过大 / 二进制而不含正文）。 */
export interface ReadFileResult {
  path: string
  content: string
  tooLarge?: boolean
  binary?: boolean
}

/** 会话「线缆类型」：与主进程 providers/chat 结构一致，按既定模式在 preload 内复述。 */
export interface ChatModelConfig {
  adapter: 'anthropic' | 'openai'
  providerId: string
  baseURL: string
  model: string
}

export interface ChatSendRequest {
  sessionId: string
  text: string
  model: ChatModelConfig
  workspaceRoot: string | null
  /** 用户经原生选择框挑选的附件绝对路径（正文由主进程读取，base64 不经渲染层）。 */
  attachments?: string[]
}

/** 附件类型（与 services/attachments.ts 对齐）。 */
export type AttachmentKind = 'image' | 'document' | 'text' | 'unsupported'

/** 一次挑选返回的附件描述（不含正文/base64）。 */
export interface PickedAttachment {
  path: string
  name: string
  ext: string
  size: number
  kind: AttachmentKind
  supported: boolean
  reason?: string
}

/** 会话元信息（左侧列表用，与 chat-store.ts 对齐）。 */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

/** 重建历史用的展示块 / 消息（与 services/chat.ts 的 DisplayMessage 对齐）。 */
export type DisplayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; status: 'ok' | 'error'; summary?: string }

export type DisplayMessage =
  | { role: 'user'; text: string; attachments: { name: string; kind: 'image' | 'document' | 'text' }[] }
  | { role: 'assistant'; blocks: DisplayBlock[] }

export interface PermissionResponse {
  key: string
  decision: 'allow' | 'deny'
  remember: boolean
}

/** 每项目权限模式（与 services/permissions.ts 对齐）。 */
export type PermMode = 'ask' | 'acceptEdits' | 'auto'

/** 终端「线缆类型」（与 services/terminal.ts 对齐，按既定模式在 preload 内复述）。 */
export interface TerminalCreateOptions {
  cols: number
  rows: number
  cwd: string | null
}
export interface TerminalDataPayload {
  id: string
  data: string
}
export interface TerminalExitPayload {
  id: string
  exitCode: number
}

/** 服务商探针「线缆类型」（与 services/provider.ts 对齐）。 */
export interface ProbeConfig {
  adapter: 'anthropic' | 'openai'
  providerId: string
  baseURL: string
  model?: string
}

export interface ProviderTestResult {
  ok: boolean
  kind?: string
  message: string
  latencyMs?: number
}

export interface ProviderListModelsResult {
  ok: boolean
  models?: string[]
  kind?: string
  message?: string
}

/** 主进程 → 渲染层的富事件（与 services/chat.ts 的 ChatStreamEvent 对齐）。 */
export type ChatStreamEvent =
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

export interface ChatEventPayload {
  turnId: string
  sessionId: string
  event: ChatStreamEvent
}

/**
 * 白名单 API：只向渲染层暴露明确、受控的能力。
 * 绝不暴露原始 ipcRenderer 或任何 Node 模块。
 * 详见 docs/architecture/security.md。
 */
const api = {
  platform: process.platform,
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    /** 主题切换时同步原生标题栏控件（min/max/close）的图标配色 */
    setOverlaySymbolColor: (color: string): Promise<void> =>
      ipcRenderer.invoke('window:set-overlay', color)
  },
  /** 工作区文件系统：打开文件夹、读目录、读写文件、挑选附件。 */
  fs: {
    openFolder: (): Promise<OpenFolderResult | null> => ipcRenderer.invoke('fs:open-folder'),
    readDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke('fs:read-dir', path),
    readFile: (path: string): Promise<ReadFileResult> => ipcRenderer.invoke('fs:read-file', path),
    writeFile: (path: string, content: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('fs:write-file', path, content),
    /** 原生多选对话框挑选附件；返回描述（含是否受支持），base64 留在主进程 */
    pickAttachments: (): Promise<PickedAttachment[]> => ipcRenderer.invoke('fs:pick-attachments')
  },
  /** 应用配置（~/.deva/config.json 非敏感项）：同步读（首帧防闪烁）+ 异步读/写。 */
  config: {
    /** 同步取整份配置，供首帧读取主题/语言，避免闪烁 */
    getSync: (): Record<string, unknown> => ipcRenderer.sendSync('config:get-sync'),
    get: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:get'),
    /** 顶层浅合并补丁（值为 undefined 删除该键） */
    set: (patch: Record<string, unknown>): Promise<{ ok: true }> =>
      ipcRenderer.invoke('config:set', patch)
  },
  /** 密钥安全存储：只写不读明文（set 空串即删除）。 */
  secrets: {
    set: (providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> =>
      ipcRenderer.invoke('secrets:set', providerId, key),
    has: (providerId: string): Promise<boolean> => ipcRenderer.invoke('secrets:has', providerId),
    delete: (providerId: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('secrets:delete', providerId),
    list: (): Promise<string[]> => ipcRenderer.invoke('secrets:list'),
    available: (): Promise<boolean> => ipcRenderer.invoke('secrets:available')
  },
  /** 服务商探针：连通性测试 + 拉取模型清单（均在主进程发起，密钥不出主进程）。 */
  provider: {
    test: (cfg: ProbeConfig): Promise<ProviderTestResult> =>
      ipcRenderer.invoke('provider:test', cfg),
    listModels: (cfg: ProbeConfig): Promise<ProviderListModelsResult> =>
      ipcRenderer.invoke('provider:list-models', cfg)
  },
  /** 会话：发送、中止、重置、列表/载入/删除、回应权限、订阅流式事件。 */
  chat: {
    send: (req: ChatSendRequest): Promise<{ turnId: string }> =>
      ipcRenderer.invoke('chat:send', req),
    abort: (turnId: string): Promise<{ ok: true }> => ipcRenderer.invoke('chat:abort', turnId),
    reset: (sessionId: string, workspaceRoot: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:reset', sessionId, workspaceRoot),
    /** 某项目下的会话清单（按 updatedAt 倒序） */
    listSessions: (workspaceRoot: string | null): Promise<ChatSessionMeta[]> =>
      ipcRenderer.invoke('chat:list-sessions', workspaceRoot),
    /** 载入某会话历史，重建展示气泡 */
    loadSession: (sessionId: string, workspaceRoot: string | null): Promise<DisplayMessage[]> =>
      ipcRenderer.invoke('chat:load-session', sessionId, workspaceRoot),
    /** 删除某会话 */
    deleteSession: (sessionId: string, workspaceRoot: string | null): Promise<{ ok: true }> =>
      ipcRenderer.invoke('chat:delete-session', sessionId, workspaceRoot),
    respondPermission: (payload: PermissionResponse): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:permission-response', payload),
    /** 订阅 chat:event，返回取消订阅函数 */
    onEvent: (cb: (payload: ChatEventPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: ChatEventPayload): void => cb(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },
  /** 权限模式（按项目，存于 ~/.deva/permissions.json）：读/写当前项目的授权姿态。 */
  perm: {
    getMode: (workspaceRoot: string | null): Promise<PermMode> =>
      ipcRenderer.invoke('perm:get-mode', workspaceRoot),
    setMode: (workspaceRoot: string | null, mode: PermMode): Promise<{ ok: true }> =>
      ipcRenderer.invoke('perm:set-mode', workspaceRoot, mode)
  },
  /** 集成终端：建 PTY、写输入、改尺寸、销毁；订阅数据/退出事件。 */
  terminal: {
    create: (opts: TerminalCreateOptions): Promise<{ id: string }> =>
      ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:input', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    dispose: (id: string): void => ipcRenderer.send('terminal:dispose', id),
    /** 订阅 terminal:data，返回取消订阅函数 */
    onData: (cb: (payload: TerminalDataPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: TerminalDataPayload): void => cb(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    /** 订阅 terminal:exit，返回取消订阅函数 */
    onExit: (cb: (payload: TerminalExitPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: TerminalExitPayload): void => cb(payload)
      ipcRenderer.on('terminal:exit', listener)
      return () => ipcRenderer.removeListener('terminal:exit', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('deva', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (仅在未启用隔离的回退场景)
  window.deva = api
}

export type DevaApi = typeof api
