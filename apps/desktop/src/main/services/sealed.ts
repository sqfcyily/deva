import { isProtectedPath, isSensitivePath } from './fs-guard'
import { isDangerousCommand, touchesSensitivePath } from './exec-policy'
import { isMcpTool, toolCategory, writeTargetPath } from './tools'

/**
 * 密封无头执行的权限判定（纯函数，无 IPC、可单测）。
 *
 * 定时任务「创建时批准、执行时零交互」：触发执行时**绝不再弹任何确认**。本函数据不可协商的安全
 * 地板给出放行/拒绝——绝不弹窗、绝不挂起、绝不静默放行；拒绝时给清晰 tool_result 让模型改道
 *（而非整轮硬失败）。除下列硬底线与「交互/创建类」工具外，一律放行（与交互闸门同一策略）。
 *
 * 安全地板（不可协商，与交互闸门同源）：
 *  · Tier-1 敏感路径（凭据/密钥与本应用 ~/.deva）——文件工具通道永不可读写；
 *  · Tier-2 版本库内部（.git）——hooks/config 可提权、对象库写坏不可逆 → 拒绝；
 *  · 危险命令（isDangerousCommand）——恒拒；
 *  · 触及凭据路径的命令（touchesSensitivePath）——恒拒（启发式，补 exec 绕过 Tier-1 的缺口）。
 */

export interface SealedVerdict {
  allowed: boolean
  /** 拒绝时回灌模型的 tool_result 文本（清晰、可改道）。allowed=true 时为空串。 */
  denyContent: string
  /**
   * 允许写入时：需临时登记为受信根的目标绝对路径（执行后由调用方在 finally untrust）。
   * 密封会话无「打开文件夹」得来的受信根，故每次放行的写入都须临时精确放行使工具内 assertInside 通过；
   * 执行后立即撤销，避免长期扩大受信面。
   */
  trustPath?: string
}

/**
 * 密封执行永不放行的交互/创建类工具（无人在场无从交互/审阅，或不得创建持久实体）。
 * ask_user/run_subagent 在循环内受 allowAskUser/allowSubagents 门关闭后会落到闸门，须在此显式拒绝；
 * propose_agent/create_* 已被 buildSealedTools 从可见工具剔除，列此为纵深防御；
 * exit_plan 由循环内「闸门前特判」拦截（!interactive → 指导性 no-op），亦列此兜底。
 * 注意：`skill`（技能加载，headless-安全）已放开，不在此集。
 */
const SEALED_FORBIDDEN = new Set([
  'ask_user',
  'run_subagent',
  'create_skill',
  'propose_agent',
  'create_mcp',
  'create_task',
  'exit_plan'
])

/**
 * 判定密封模式下一次工具调用是否放行：除交互/创建类与硬底线外，一律放行。
 * @param toolName 工具名
 * @param args     工具入参（与交互闸门同一份，用于取目标路径 / 命令）
 * @param root     解析相对路径的基准根（密封任务无固定工作目录时为 null，相对路径回落进程 cwd）
 */
export function sealedDecision(toolName: string, args: unknown, root: string | null): SealedVerdict {
  // 交互/创建类：自动执行零交互，且不得再造技能/角色/MCP/任务/子智能体。
  if (SEALED_FORBIDDEN.has(toolName)) {
    return {
      allowed: false,
      denyContent: `定时任务在自动执行中，无法使用「${toolName}」（不支持交互/创建类操作）。请改用只读或写入/执行工具完成本次任务，或在结论中说明受限之处。`
    }
  }

  const cat = toolCategory(toolName)

  // 只读工具恒放行（Tier-1 敏感目录仍由工具内 resolveReadPath 兜底拒绝）。
  if (cat === 'read') return { allowed: true, denyContent: '' }

  if (cat === 'edit') {
    const target = writeTargetPath(toolName, args, root)
    const abs = target?.abs ?? null
    if (!abs) return { allowed: false, denyContent: '写入被拒绝：缺少有效的目标路径（path）。' }
    // 安全地板 Tier-1：凭据/密钥与本应用 ~/.deva，不可协商。
    if (isSensitivePath(abs))
      return {
        allowed: false,
        denyContent: `该路径受安全策略保护（凭据/密钥目录），拒绝写入：${abs}。请勿重试。`
      }
    // 安全地板 Tier-2：版本库内部（.git）——写入即可能是 hooks 提权或仓库损坏，一律拒绝。
    if (isProtectedPath(abs))
      return {
        allowed: false,
        denyContent: `该路径位于版本库内部（.git），定时任务不可自动写入：${abs}。请改用 git 命令操作仓库。`
      }
    // 其余目标一律放行；密封会话无受信根，故每次都需一次性精确受信（调用方 finally 撤销）。
    return { allowed: true, denyContent: '', trustPath: abs }
  }

  if (cat === 'exec') {
    const command =
      args && typeof (args as { command?: unknown }).command === 'string'
        ? (args as { command: string }).command
        : ''
    if (!command.trim()) return { allowed: false, denyContent: '命令为空，未执行。' }
    // 安全地板：危险命令恒拒。
    if (isDangerousCommand(command))
      return {
        allowed: false,
        denyContent:
          '该命令被安全策略拒绝（危险操作），未执行。请勿重试，改用更精确、非破坏性的命令。'
      }
    // 安全地板：触及凭据/密钥路径的命令恒拒（文件工具的 Tier-1 对 exec 无效，此处按命令文本兜底）。
    if (touchesSensitivePath(command))
      return {
        allowed: false,
        denyContent:
          '该命令涉及凭据/密钥路径（如 ~/.ssh、~/.deva），被安全策略拒绝，未执行。请勿重试或变形绕过。'
      }
    return { allowed: true, denyContent: '' }
  }

  // mcp：已连接的 MCP 工具一律放行；其余（幻觉工具名等）拒绝。
  if (isMcpTool(toolName)) return { allowed: true, denyContent: '' }
  return {
    allowed: false,
    denyContent: `工具「${toolName}」当前不可用，已拒绝。`
  }
}
