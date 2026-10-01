import type { TurnBlock } from './types'

/**
 * 按字符预算把块序列切成多页。长正文在预算处切开（优先在换行处），切口落在代码块里时
 * 本页补上收尾 ```、下一页重开同语言的 ```，保证每页单独渲染都正确。
 */
export function paginate(blocks: TurnBlock[], budget: number): TurnBlock[][] {
  const pages: TurnBlock[][] = [[]]
  let used = 0
  const newPage = (): void => {
    pages.push([])
    used = 0
  }
  const cur = (): TurnBlock[] => pages[pages.length - 1]
  for (const b of blocks) {
    if (b.kind !== 'text') {
      const cost = b.kind === 'error' || b.kind === 'notice' ? Math.min(b.text.length, 600) + 40 : 160
      if (used + cost > budget && cur().length > 0) newPage()
      cur().push(b)
      used += cost
      continue
    }
    let rest = b.text
    while (used + rest.length > budget) {
      const room = budget - used
      if (room < 400 && cur().length > 0) {
        newPage()
        continue
      }
      const nl = rest.lastIndexOf('\n', room)
      const cut = nl > room * 0.6 ? nl + 1 : room
      let chunk = rest.slice(0, cut)
      rest = rest.slice(cut)
      const fences = chunk.match(/^\s*```.*$/gm) ?? []
      if (fences.length % 2 === 1) {
        const opener = fences[fences.length - 1].trim()
        chunk += '\n```'
        rest = `${opener}\n${rest}`
      }
      cur().push({ kind: 'text', text: chunk })
      newPage()
    }
    if (rest) {
      cur().push({ kind: 'text', text: rest })
      used += rest.length
    }
  }
  return pages
}
