/**
 * 极简零依赖 frontmatter 解析（够用即可，不引 YAML 库以守免装铁律 + 减攻击面）。
 * 仅识别文件开头的 `---` 块，支持三类条目：
 *   key: 标量            → string（去引号）
 *   key: [a, b, c]       → string[]（内联数组）
 *   key:                 → string[]（其后若干 `- item` 缩进列表项）
 * 其余复杂 YAML 语法一律不支持——SKILL.md / agent.md 的 frontmatter 只需上述三型。
 * body 为 `---` 结束行之后的全部原文（保留换行，仅去掉紧随其后的一个空行）。
 */

export interface ParsedFrontmatter {
  data: Record<string, string | string[]>
  body: string
}

function stripQuotes(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    // 双引号：反转义 \\ 与 \"（与 fmScalar 的转义对称，保证往返一致）
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

function parseInlineArray(v: string): string[] {
  // 去掉外层 [ ]，按逗号分隔，逐项去引号；空项丢弃。
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '')
  return inner
    .split(',')
    .map((x) => stripQuotes(x))
    .filter((x) => x.length > 0)
}

/**
 * 解析 frontmatter。无有效 `---` 头部时 data 为空、body 为原文（容错，绝不抛错）。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^﻿/, '') // 去 BOM
  // 必须以 `---`（可含尾随空白）单独成行开头
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, body: text }

  // 找到结束的 `---`
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: text } // 没有闭合 → 视作无 frontmatter

  const data: Record<string, string | string[]> = {}
  let i = 1
  while (i < end) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = parseInlineArray(rest)
      i++
    } else if (rest === '') {
      // 其后若干 `- item` 缩进列表项
      const items: string[] = []
      let j = i + 1
      while (j < end) {
        const lm = /^\s*-\s+(.*)$/.exec(lines[j])
        if (!lm) break
        const val = stripQuotes(lm[1])
        if (val) items.push(val)
        j++
      }
      data[key] = items
      i = j
    } else {
      data[key] = stripQuotes(rest)
      i++
    }
  }

  // body：结束行之后，去掉紧随的一个空行
  let bodyStart = end + 1
  if (lines[bodyStart] !== undefined && lines[bodyStart].trim() === '') bodyStart++
  const body = lines.slice(bodyStart).join('\n')
  return { data, body }
}

/** 取标量字段（数组则取首项）；缺失返回 ''。 */
export function fmString(data: Record<string, string | string[]>, key: string): string {
  const v = data[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0] ?? ''
  return ''
}

/** 取字符串数组字段（标量则包成单元素数组，支持逗号分隔）；缺失返回 []。 */
export function fmArray(data: Record<string, string | string[]>, key: string): string[] {
  const v = data[key]
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return []
}

/** 把值序列化为 frontmatter 行的标量表示（含特殊字符时加双引号并转义）。 */
export function fmScalar(v: string): string {
  if (v === '') return '""'
  if (/[:#\[\]{}"'\n]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return v
}
