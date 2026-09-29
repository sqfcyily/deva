/**
 * 两段文本之间的「加减行数」统计（只计数，不产出 diff）。
 *
 * 用途：检查点回滚的预览只给轻量摘要（文件 + 动作 + +N −M），刻意不在任何地方渲染 diff——
 * diff 若要做，会作为一个完整独立的功能单独立项，而不是零散塞进对话流。
 *
 * 算法：换行统一为 LF 后按行切分 → 剥掉公共前后缀（绝大多数编辑只动中间一小段，剥完几乎为空）→
 * 对剩余中段跑 Myers O(ND) 求最短编辑距离 D。LCS = (N+M−D)/2，故 removed = N−LCS、added = M−LCS。
 * 中段过长或 D 超上限时退化为多重集近似（按行计数差），并标 approx 供 UI 显示「~」。
 * 纯 JS、零依赖（免装铁律）。
 */

export interface LineStats {
  added: number
  removed: number
  /** true = 超出精确计算上限，数字为多重集近似值。 */
  approx: boolean
}

/** 中段（剥公共前后缀后）两侧行数之和的精确计算上限。 */
const EXACT_MAX_LINES = 50_000
/** Myers 编辑距离上限：超出即放弃精确解（O(ND) 在 D 很大时退化成 O(N²)）。 */
const MAX_D = 2_000

/** 按行切分；末尾换行不单独算一行（"a\nb\n" 与 "a\nb" 都是 2 行）。 */
function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Myers 贪心：返回最短编辑距离 D；超过 maxD 返回 -1。a/b 为已剥公共前后缀的中段。 */
function myersDistance(a: string[], b: string[], maxD: number): number {
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  const max = Math.min(n + m, maxD)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return -1
}

/** 多重集近似：按行文本计数，逐行比较两侧出现次数差。 */
function multisetStats(a: string[], b: string[]): { added: number; removed: number } {
  const count = new Map<string, number>()
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1)
  for (const l of b) count.set(l, (count.get(l) ?? 0) - 1)
  let added = 0
  let removed = 0
  for (const c of count.values()) {
    if (c > 0) removed += c
    else if (c < 0) added -= c
  }
  return { added, removed }
}

/** 从 before 变到 after：新增 added 行、删除 removed 行（修改一行 = −1 +1，与 git 的口径一致）。 */
export function lineStats(before: string, after: string): LineStats {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length === 0 || midB.length === 0)
    return { added: midB.length, removed: midA.length, approx: false }

  if (midA.length + midB.length <= EXACT_MAX_LINES) {
    const d = myersDistance(midA, midB, MAX_D)
    if (d >= 0) {
      const lcs = (midA.length + midB.length - d) / 2
      return { added: midB.length - lcs, removed: midA.length - lcs, approx: false }
    }
  }
  return { ...multisetStats(midA, midB), approx: true }
}

/** 一段文本的行数（用于整文件新建 / 删除时的 +N / −N）。 */
export function lineCount(s: string): number {
  return splitLines(s).length
}
