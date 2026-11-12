/**
 * 内置工具目录：每个内置工具的权限分类、路径语义与适用范围集中在这一张表里。原先散在 chat.ts / tools.ts /
 * sealed.ts 的几份名单（子智能体 / 定时任务 / 成员会话不给哪些、哪些可并发、闸门怎么分类、哪些带路径）
 * 都由它派生。
 *
 * 新增内置工具：规格写在 tools.ts（或对应模块）、执行写进 tools.ts 的 toolHandlers（循环内特判的除外），
 * 再在这里加一行，写清它属于哪类、哪些场景不给。没在这里登记的工具按 mcp 走闸、各场景都给。
 *
 * 只收窄可见工具：被保留的每个调用仍照常过同一道权限闸门（无提权）。
 */

/**
 * 权限闸门分类：read = 只读 / 无副作用，edit = 写入文件，exec = 执行类（命令、会提交表单的浏览器）。
 * 不填 = 落默认分支（按 mcp 走闸，见 tools.toolCategory）：如 create_skill、写 / 删记忆、成员工具。
 */
type BuiltinCategory = 'read' | 'edit' | 'exec'

interface ToolTraits {
  category?: BuiltinCategory
  /** 同一步里全部调用都是这类工具时并发执行：无副作用、彼此无先后依赖（见工具循环的 readRuns）。 */
  parallel?: true
  /**
   * path 参数的语义（挂载工作区提示卡的判据，见 tools.needsWorkspaceMount）：file = 必填的单文件落点，
   * 相对写法以项目根为基准；scan = 省略即隐含项目根的扫描类。
   */
  path?: 'file' | 'scan'
  /** false = 子智能体不给：交互 / 创建 / 管理类，或只对主对话有意义（待办清单、交付物、项目成员）。 */
  subagent?: false
  /** false = 定时任务等无人值守的回合不给：要等用户回答或批准、要用户在名片上确认、或会改写用户记忆。 */
  unattended?: false
  /**
   * 成员会话：false = 不给（创建类归主对话；交付物由主智能体呈给用户，成员的产出经结论交回）；
   * 'with-folder' = 成员有文件夹时才给（没有文件夹只剩全局记忆，而全局记忆对成员只读）。
   */
  member?: false | 'with-folder'
}

const CATALOG: Record<string, ToolTraits> = {
  // ── 读 ──
  read_file: { category: 'read', parallel: true, path: 'file' },
  list_dir: { category: 'read', parallel: true, path: 'scan' },
  glob: { category: 'read', parallel: true, path: 'scan' },
  grep: { category: 'read', parallel: true, path: 'scan' },
  web_fetch: { category: 'read', parallel: true },
  // 读记忆：主进程直读 ~/.deva 下的全局 / 项目记忆，无路径入参。
  memory_read: { category: 'read', parallel: true },

  // ── 写 / 执行 ──
  write_file: { category: 'edit', path: 'file' },
  edit_file: { category: 'edit', path: 'file' },
  run_command: { category: 'exec' },
  // 内置浏览器会提交表单、改变网页状态，同归执行类（定时任务照常可用）。
  browser: { category: 'exec' },

  // ── 循环内特判（闸门前处理，category 只是兜底：万一落到闸门也按只读放行）──
  ask_user: { category: 'read', subagent: false, unattended: false },
  // 子智能体在工具循环里另有兜底（depth > 0 时回「无需 exit_plan」），不必从工具表剔除。
  exit_plan: { category: 'read', unattended: false },
  // 待办清单是主对话给用户看的进度，子智能体的步骤收在 Task 卡里。
  todo_write: { category: 'read', subagent: false },
  skill: { category: 'read', subagent: false },
  tool_search: { category: 'read' },
  run_subagent: { category: 'read', subagent: false },
  send_to_subagent: { category: 'read', subagent: false },

  // ── 创建 / 提议类：要用户在名片上确认，或直接造持久实体 ──
  create_skill: { subagent: false, unattended: false, member: false },
  // 惰性提议：不写盘、不弹权限框；真正的授权是用户在名片里点「接受」/「创建」。
  propose_agent: { category: 'read', subagent: false, unattended: false, member: false },
  create_task: { category: 'read', subagent: false, unattended: false, member: false },
  create_mcp: { subagent: false, unattended: false, member: false },

  // ── 写 / 删记忆：无人看管时不得改写（免得被任务抓取的外部内容悄悄污染）──
  memory_write: { subagent: false, unattended: false, member: 'with-folder' },
  memory_delete: { subagent: false, unattended: false, member: 'with-folder' },

  // ── 交付文件：只核对文件存在，不读内容、不写盘 ──
  present_files: { category: 'read', subagent: false, member: false },

  // ── 项目成员（主对话）：由主智能体管理 ──
  create_member: { subagent: false },
  member_send: { subagent: false },
  member_stop: { subagent: false },
  member_status: { subagent: false }
}

const traitsOf = (name: string): ToolTraits | undefined =>
  Object.prototype.hasOwnProperty.call(CATALOG, name) ? CATALOG[name] : undefined

const namesWhere = (pred: (t: ToolTraits) => boolean): ReadonlySet<string> =>
  new Set(Object.keys(CATALOG).filter((n) => pred(CATALOG[n])))

/** 内置工具的闸门分类；未登记或未填 = undefined（由调用方按 mcp 处理）。 */
export function builtinCategory(name: string): BuiltinCategory | undefined {
  return traitsOf(name)?.category
}

/** 内置工具 path 参数的语义；不带路径的为 undefined。 */
export function pathKind(name: string): 'file' | 'scan' | undefined {
  return traitsOf(name)?.path
}

/** 子智能体不给的工具（普通子智能体的工具表里没有；fork 沿用主对话工具表，靠工具循环里 depth > 0 拦下）。 */
export const SUBAGENT_EXCLUDED = namesWhere((t) => t.subagent === false)
/** 定时任务等无人值守的回合从工具表里剔除的工具。 */
export const UNATTENDED_EXCLUDED = namesWhere((t) => t.unattended === false)
/** 成员会话不给的工具。 */
export const MEMBER_EXCLUDED = namesWhere((t) => t.member === false)
/** 成员会话有文件夹时才给的工具。 */
export const MEMBER_FOLDER_ONLY = namesWhere((t) => t.member === 'with-folder')
/** 同一步里可并发执行的只读工具。 */
export const PARALLEL_READ_TOOLS = namesWhere((t) => t.parallel === true)
/** 写入文件的工具（检查点记录 / 回滚据此识别改动）。 */
export const EDIT_TOOLS = namesWhere((t) => t.category === 'edit')
