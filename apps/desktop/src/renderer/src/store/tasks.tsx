import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from 'react'
import type {
  CreateTaskResult,
  TaskCreateInput,
  TaskRecord,
  TaskStatus,
  TaskUpdateInput
} from '../../../preload'

/**
 * 定时任务渲染层 store（全局，与项目无关）。
 * 真值在主进程 services/tasks.ts；这里只镜像列表并订阅 `tasks:changed` 全量广播——
 * 增删改启停/立即运行都委托主进程 IPC，主进程处理后广播回全量列表，本 store 据此刷新（乐观留给广播）。
 * 独占会话由调度器首次触发时建，本 store 不碰会话——「打开任务会话」由外壳经 ChatProvider 完成。
 */
interface TasksContextValue {
  tasks: TaskRecord[]
  /**
   * 手动新建任务（管理页「添加任务」表单）；主进程校验日程、算首次触发、铸独占会话，广播回全量列表。
   * 与对话确认名片同一条落盘通路（tasks:create），故授权语义一致：创建即批准，触发时零交互。
   */
  create: (input: TaskCreateInput) => Promise<CreateTaskResult>
  /** 暂停 / 恢复（active↔paused）；completed/error 亦可经此重新置 active。 */
  setStatus: (id: string, status: TaskStatus) => Promise<void>
  /** 立即运行一次（委托调度器串行队列；调度器未就绪返回 ok:false）。 */
  runNow: (id: string) => Promise<{ ok: boolean; reason?: string }>
  /** 编辑任务（标题/指令/日程/人格/模型）；主进程校验日程并重算下次触发，广播回全量列表。 */
  update: (input: TaskUpdateInput) => Promise<TaskRecord | null>
  /** 删除任务（连同其运行历史；独占会话保留，由用户在对话列表自行删除）。 */
  remove: (id: string) => Promise<void>
}

const TasksContext = createContext<TasksContextValue | null>(null)

export function TasksProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [tasks, setTasks] = useState<TaskRecord[]>([])

  // 初始拉取 + 订阅全量广播（仿 useExtensions 对 mcp.onStatus 的处理）。
  useEffect(() => {
    let alive = true
    void window.deva?.tasks
      ?.list?.()
      .then((list) => {
        if (alive) setTasks(list)
      })
      .catch(() => {})
    const off = window.deva?.tasks?.onChanged?.((list) => setTasks(list))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // 创建：结果直接回给调用方（失败带稳定错误码供渲染层本地化）；成功后的列表刷新交由 tasks:changed 广播。
  const create = useCallback(
    (input: TaskCreateInput): Promise<CreateTaskResult> => window.deva.tasks.create(input),
    []
  )

  const setStatus = useCallback(async (id: string, status: TaskStatus): Promise<void> => {
    await window.deva.tasks.setStatus(id, status)
    // 刷新交由 tasks:changed 广播。
  }, [])

  const runNow = useCallback(
    (id: string): Promise<{ ok: boolean; reason?: string }> => window.deva.tasks.runNow(id),
    []
  )

  const update = useCallback(
    (input: TaskUpdateInput): Promise<TaskRecord | null> => window.deva.tasks.update(input),
    []
  )

  const remove = useCallback(async (id: string): Promise<void> => {
    await window.deva.tasks.remove(id)
  }, [])

  const value: TasksContextValue = { tasks, create, setStatus, runNow, update, remove }
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export function useTasks(): TasksContextValue {
  const ctx = useContext(TasksContext)
  if (!ctx) throw new Error('useTasks 必须在 TasksProvider 内使用')
  return ctx
}
