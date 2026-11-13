/**
 * Markdown 引用行（`>` 开头，前面至多 3 个空格）：用户消息开头右键「引用」带进来的别人的话。
 * 引用里的「/技能名」「@名字」不算用户的指令（见 shared/slash.ts、主进程 chat-members.ts 的 handleMentions）。
 */
export const isQuoteLine = (line: string): boolean => /^ {0,3}>/.test(line)

/** 去掉引用行，只留用户自己写的部分。 */
export function withoutQuotes(text: string): string {
  return text
    .split('\n')
    .filter((l) => !isQuoteLine(l))
    .join('\n')
}
