import { strFromU8, unzipSync } from 'fflate'

/**
 * 从 Office Open XML 文件（.docx / .xlsx / .pptx）里取出纯文字，供 read_file 读取（附件按路径交给模型时，
 * Word / Excel / PowerPoint 文件靠它读）。这三种文件都是 zip 包里的 XML：只解压需要的那几项，按标签取文字，
 * 不保留格式、不含图片。旧版二进制格式（.doc / .xls / .ppt）与加密文件不是 zip，解析失败返回 null。
 */

/** read_file 能取文字的 Office 文件扩展名。 */
export const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx'])

/** XML 实体解码（文字节点里的 &lt; &amp; &#20013; 等）。 */
function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e: string) => {
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'amp') return '&'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

/** 收尾：去掉行尾空白，连续空行最多留一个。 */
function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 按文件名里的数字排序（slide2 在 slide10 之前）。 */
function byNumber(a: string, b: string): number {
  const n = (s: string): number => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0)
  return n(a) - n(b)
}

/**
 * 段落类文字（Word 正文、PowerPoint 页面）：文字节点拼接，段落结束换行；表格里一行一行写，单元格之间用「 | 」。
 * ns 是标签前缀：Word 为 w，DrawingML（PowerPoint）为 a。
 */
function paragraphText(xml: string, ns: 'w' | 'a'): string {
  const re = new RegExp(
    `<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab/>|<${ns}:(?:br|cr)\\b[^>]*/>|</${ns}:p>|<${ns}:tbl(?:\\s[^>]*)?>|</${ns}:tbl>|</${ns}:tc>|</${ns}:tr>`,
    'g'
  )
  let out = ''
  let depth = 0
  for (const m of xml.matchAll(re)) {
    const tag = m[0]
    if (m[1] !== undefined) out += m[1]
    else if (tag === `<${ns}:tab/>`) out += '\t'
    else if (tag.startsWith(`<${ns}:br`) || tag.startsWith(`<${ns}:cr`) || tag === `</${ns}:p>`)
      out += depth ? ' ' : '\n'
    else if (tag.startsWith(`<${ns}:tbl`)) {
      depth++
      if (out && !out.endsWith('\n')) out += '\n'
    } else if (tag === `</${ns}:tbl>`) depth = Math.max(0, depth - 1)
    else if (tag === `</${ns}:tc>`) out = `${out.replace(/ +$/, '')} | `
    else if (tag === `</${ns}:tr>`) out = `${out.replace(/ \| $/, '')}\n`
  }
  return tidy(decodeXml(out))
}

function docxText(files: Record<string, Uint8Array>): string | null {
  const doc = files['word/document.xml']
  return doc ? paragraphText(strFromU8(doc), 'w') : null
}

function pptxText(files: Record<string, Uint8Array>): string | null {
  const slides = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(byNumber)
  if (!slides.length) return null
  return slides
    .map((n, i) => {
      const body = paragraphText(strFromU8(files[n]), 'a')
      return `## 第 ${i + 1} 页\n${body}`.trim()
    })
    .join('\n\n')
}

/** 「AB12」→ 列下标（A = 0）。 */
function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? ''
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 一段富文本里的全部 <t> 文字（共享字符串、行内字符串）。 */
function runsText(xml: string): string {
  let s = ''
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += m[1]
  return decodeXml(s)
}

function xlsxText(files: Record<string, Uint8Array>): string | null {
  const shared: string[] = []
  const ss = files['xl/sharedStrings.xml']
  if (ss) for (const m of strFromU8(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(runsText(m[1]))

  // 工作表名与对应文件：workbook.xml 的 <sheet name r:id> → 关系文件里的 Target；对不上的按文件名顺序补。
  const sheets: { name: string; path: string }[] = []
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : ''
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : ''
  const target = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1]
    const t = /\bTarget="([^"]+)"/.exec(m[1])?.[1]
    if (id && t) target.set(id, t.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1]
    const id = /\br:id="([^"]+)"/.exec(m[1])?.[1]
    const path = id ? target.get(id) : undefined
    if (name !== undefined && path && files[path]) sheets.push({ name: decodeXml(name), path })
  }
  const listed = new Set(sheets.map((s) => s.path))
  Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n) && !listed.has(n))
    .sort(byNumber)
    .forEach((path) => sheets.push({ name: path.slice(path.lastIndexOf('/') + 1, -4), path }))
  if (!sheets.length) return null

  const parts = sheets.map(({ name, path }) => {
    const lines: string[] = []
    // 空行可能是自闭合的 <row r="5"/>，须单独认出，否则会吞掉下一行。
    for (const row of strFromU8(files[path]).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!row[2]) continue
      const cells: string[] = []
      for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]
        const inner = c[2] ?? ''
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1]
        let val = ''
        if (type === 's') val = v !== undefined ? (shared[Number(v)] ?? '') : ''
        else if (type === 'inlineStr') val = runsText(inner)
        else if (type === 'b') val = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : ''
        else val = v !== undefined ? decodeXml(v) : ''
        const at = ref ? colIndex(ref) : cells.length
        while (cells.length < at) cells.push('')
        cells[at] = val.replace(/[\t\r\n]+/g, ' ')
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      if (!cells.length) continue
      const r = /\br="(\d+)"/.exec(row[1])?.[1] ?? String(lines.length + 1)
      lines.push(`${r}\t${cells.join('\t')}`)
    }
    return `## 工作表：${name}\n${lines.length ? lines.join('\n') : '（空）'}`
  })
  return `（每行开头是表格的行号，其后各列以制表符分隔）\n\n${parts.join('\n\n')}`
}

/** 取 Office 文件的文字；不是这三种格式、不是 zip（旧版二进制 / 加密）或缺少正文部件时返回 null。 */
export function officeText(buf: Uint8Array, ext: string): string | null {
  const e = ext.toLowerCase()
  if (!OFFICE_EXT.has(e)) return null
  const want =
    e === '.docx'
      ? (n: string) => n === 'word/document.xml'
      : e === '.pptx'
        ? (n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n)
        : (n: string) =>
            n === 'xl/sharedStrings.xml' ||
            n === 'xl/workbook.xml' ||
            n === 'xl/_rels/workbook.xml.rels' ||
            /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buf, { filter: (f) => want(f.name) })
  } catch {
    return null
  }
  try {
    return e === '.docx' ? docxText(files) : e === '.pptx' ? pptxText(files) : xlsxText(files)
  } catch {
    return null
  }
}
