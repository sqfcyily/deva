/**
 * 复读检测：一段模型输出里是否有「同一段内容原样连续重复」的区域。模型退化时会原地打转——反复吐
 * `<|end|>` 之类的模板标记、同一句话或同一段落，具体是什么无从预料，共同点是逐字重复，故这里只看
 * 结构、不看内容。只认逐字符完全相同的周期：带递增序号的列表、每行内容不同的表格都不算，免得误伤
 * 正常输出（Cursor 的复读检测曾把整屏 PASS 的测试状态表误判为打转）。
 *
 * 目前用于压缩摘要的把关（见 compaction.ts）；扫描是 O(文本长 × MAX_PERIOD)，面向一次性检查的
 * 中短文本（摘要上限 4096 token）。
 */

export interface RepetitionHit {
  /** 重复区域在文本中的起点（含第一份）。 */
  start: number
  /** 重复单元长度（字符）。 */
  period: number
  /** 重复区域总长（字符，含第一份）。 */
  span: number
}

/** 认得出的最长重复单元（字符）：段落级复读也在此之内。 */
const MAX_PERIOD = 1000

/**
 * 判为复读的两档门槛（字符数；中文一字一字符，故不能按英文的长度设），满足其一即可：
 *  - 同一段话重复至少 4 遍、连续 250 字符以上（一段几十字的中文段落复读 4 遍即命中）；
 *  - 同一短单元重复至少 10 遍、连续 200 字符以上（同一行、同一个标记反复出现）。
 * 2026-11 用本机约 2.1 万段真实模型输出（Deva 对话与子智能体、Claude Code 会话里的正文 / 思考 /
 * 工具参数）校准：零命中；带序号的列表、逐行不同的状态表、64 个 00 的十六进制片段也不命中。
 */
const RULES: { minSpan: number; minCount: number }[] = [
  { minSpan: 250, minCount: 4 },
  { minSpan: 200, minCount: 10 }
]

function qualifies(span: number, period: number): boolean {
  return RULES.some((r) => span >= r.minSpan && span / period >= r.minCount)
}

/** 找出文本里最长的一段复读区域；没有则 null。 */
export function findRepetition(text: string): RepetitionHit | null {
  const n = text.length
  const maxPeriod = Math.min(MAX_PERIOD, Math.floor(n / 2))
  let best: RepetitionHit | null = null
  for (let p = 1; p <= maxPeriod; p++) {
    // run = 连续满足 text[i] === text[i - p] 的字符数；该区域总长 = run + p（加上第一份）。
    let run = 0
    for (let i = p; i <= n; i++) {
      if (i < n && text.charCodeAt(i) === text.charCodeAt(i - p)) {
        run++
        continue
      }
      if (run > 0) {
        const span = run + p
        if (qualifies(span, p) && (!best || span > best.span)) best = { start: i - span, period: p, span }
        run = 0
      }
    }
  }
  return best
}
