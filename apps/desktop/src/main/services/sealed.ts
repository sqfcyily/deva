import { isMcpTool, toolCategory } from './tools'

/**
 * 密封无头执行的权限判定（纯函数，无 IPC、可单测）。
 *
 * 定时任务「创建时批准、执行时零交互」：触发执行时**绝不再弹任何确认**。本函数给出放行/拒绝——
 * 绝不弹窗、绝不挂起；拒绝时给清晰 tool_result 让模型改道（而非整轮硬失败）。
 *
 * 文件读写与命令执行均不设任何限制（2026-10-09 起）；只拒绝「交互/创建类」工具与未知工具名。
 */

export interface SealedVerdict {
  allowed: boolean
  /** 拒绝时回灌模型的 tool_result 文本（清晰、可改道）。allowed=true 时为空串。 */
  denyContent: string
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
  'exit_plan',
  // 记忆写/删：无人值守不得改写用户记忆（已从密封工具表剔除，此处纵深防御）；memory_read 属 read 照常放行。
  'memory_write',
  'memory_delete'
])

/**
 * 判定密封模式下一次工具调用是否放行：除交互/创建类与未知工具外，一律放行。
 * @param toolName 工具名
 */
export function sealedDecision(toolName: string): SealedVerdict {
  // 交互/创建类：自动执行零交互，且不得再造技能/角色/MCP/任务/子智能体。
  if (SEALED_FORBIDDEN.has(toolName)) {
    return {
      allowed: false,
      denyContent: `定时任务在自动执行中，无法使用「${toolName}」（不支持交互/创建类操作）。请改用只读或写入/执行工具完成本次任务，或在结论中说明受限之处。`
    }
  }

  // 读写文件、执行命令恒放行，不设任何限制。
  const cat = toolCategory(toolName)
  if (cat === 'read' || cat === 'edit' || cat === 'exec') return { allowed: true, denyContent: '' }

  // mcp：已连接的 MCP 工具一律放行；其余（幻觉工具名等）拒绝。
  if (isMcpTool(toolName)) return { allowed: true, denyContent: '' }
  return {
    allowed: false,
    denyContent: `工具「${toolName}」当前不可用，已拒绝。`
  }
}
