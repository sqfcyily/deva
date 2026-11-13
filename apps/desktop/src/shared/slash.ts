import { isQuoteLine } from './quote'

/**
 * 消息里的「/技能名」：渲染层（输入框上色）与主进程（chat-turns.ts sendMessage 展开技能）共用同一套认法。
 *
 * `/` 须在消息开头（可有前导空白）或紧跟在空白之后，名字取最长的 [A-Za-z0-9_-]+；名字后面若紧跟 `/` `.` `:` `\`
 * 就不算（那是路径、文件名或网址，如「看下 /etc/hosts」「/tmp/a.txt」）。引用行（`>` 开头，右键「引用」带进来的
 * 别人的话）里的也不算。认出来的名字是否真是技能由调用方判定。
 * 按出现先后返回区间 [start, end)（含 /）与名字。
 */
export function slashTokens(text: string): { start: number; end: number; name: string }[] {
  const out: { start: number; end: number; name: string }[] = []
  for (const m of text.matchAll(/(^|\s)\/([A-Za-z0-9_-]+)(?![A-Za-z0-9_\-/.:\\])/g)) {
    const start = (m.index ?? 0) + m[1].length
    if (isQuoteLine(text.slice(text.lastIndexOf('\n', start - 1) + 1, start + 1))) continue
    out.push({ start, end: start + 1 + m[2].length, name: m[2] })
  }
  return out
}
