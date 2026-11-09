/**
 * 主对话里的「@名字」：渲染层（输入框上色）与主进程（chat.ts handleMentions 认人）共用同一套认法。
 */

/**
 * 「新建成员」的 @ 标记：联想里选「新建成员」写入 `@新建成员 `（英文界面 `@NewMember `），后面写需求；
 * 主进程见到它就请主智能体按需求建一位成员。几种写法都认；`@新成员` 是旧写法，留着让早先的消息照常显示成标签。
 */
export const NEW_MEMBER_TOKENS: readonly string[] = ['新建成员', '新成员', 'NewMember']

/**
 * 正文里会生效的 `@名字` 所在区间 [start, end)（含 @）：每个 @ 处取能接上的最长名字（「@设计师」不算作「@设计」），
 * 不要求名字后面有分隔——同主进程只看 `@名字` 是否出现。按出现先后返回，互不重叠。
 */
export function mentionRanges(text: string, names: readonly string[]): { start: number; end: number }[] {
  const sorted = [...new Set(names.filter((n) => n.trim()))].sort((a, b) => b.length - a.length)
  if (!sorted.length) return []
  const out: { start: number; end: number }[] = []
  let i = text.indexOf('@')
  while (i >= 0) {
    const name = sorted.find((n) => text.startsWith(n, i + 1))
    if (name) {
      out.push({ start: i, end: i + 1 + name.length })
      i = text.indexOf('@', i + 1 + name.length)
    } else i = text.indexOf('@', i + 1)
  }
  return out
}
