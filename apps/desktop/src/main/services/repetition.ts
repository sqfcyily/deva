/**
 * 复读检测：一段模型输出里是否有「同一段内容原样连续重复」的区域。模型退化时会原地打转——反复吐
 * `<|end|>` 之类的模板标记、同一句话或同一段落，具体是什么无从预料，共同点是逐字重复，故这里只看
 * 结构、不看内容。只认逐字符完全相同的周期：带递增序号的列表、每行内容不同的表格都不算，免得误伤
 * 正常输出（Cursor 的复读检测曾把整屏 PASS 的测试状态表误判为打转）。
 *
 * 两处用途：压缩摘要的把关（findRepetition，见 compaction.ts），扫描是 O(文本长 × MAX_PERIOD)，面向一次性
 * 检查的中短文本（摘要上限 4096 token）；回复流式输出中的实时拦截（watchRepetition，见 chat.ts），只查结尾。
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

/** 周期为 period 的重复区域至少多长才算复读（各档门槛取最宽松的那档）。 */
function minSpanFor(period: number): number {
  return Math.min(...RULES.map((r) => Math.max(r.minSpan, r.minCount * period)))
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

/**
 * 文本**结尾**是否正在复读：只看收尾于结尾的那段重复区域，周期从小到大试，第一个够格的即返回（区域取满，
 * 供调用方截掉）。逐周期从结尾往回比，对不上立刻换下一个周期，正常文本每次只做约 MAX_PERIOD 次比较；
 * 够格即停，复读中的文本也只比到门槛长度。命中条件同 findRepetition：结尾命中的区域在完整文本里必然也命中，
 * 故误报不会多于它（校准见 RULES）。
 */
export function trailingRepetition(text: string): RepetitionHit | null {
  const n = text.length
  const maxPeriod = Math.min(MAX_PERIOD, Math.floor(n / 2))
  for (let p = 1; p <= maxPeriod; p++) {
    const need = minSpanFor(p) - p // 够格所需的 run（span = run + p）
    if (need > n - p) continue
    let run = 0
    while (run < need && text.charCodeAt(n - 1 - run) === text.charCodeAt(n - 1 - run - p)) run++
    if (run < need) continue
    while (run < n - p && text.charCodeAt(n - 1 - run) === text.charCodeAt(n - 1 - run - p)) run++
    return { start: n - run - p, period: p, span: run + p }
  }
  return null
}

/** 流式检测的节流：文本每长出这么多字符才查一次结尾（复读一旦开始就停在结尾，晚几十字发现无妨）。 */
const WATCH_STEP = 32
/**
 * 看守只留结尾这么多字符：够格的区域最长 minSpanFor(MAX_PERIOD) = 4000，结尾整段都在复读时留够它就能判出。
 * 不拿全文查：流式拼出的长串每次读字符都要整串展平，几十万字的输出累计要好几秒。
 */
const WATCH_TAIL = 4096

/**
 * 流式输出的复读看守：逐段传入增量，结尾正在复读时返回命中（period 可用；start / span 相对看守自留的结尾，
 * 要截断全文请对全文另调 trailingRepetition），否则 null。一个看守只看一路文本（正文与思考各建一个），每步重建。
 */
export function watchRepetition(): (delta: string) => RepetitionHit | null {
  let tail = ''
  let pending = 0
  return (delta) => {
    tail += delta
    pending += delta.length
    if (tail.length > WATCH_TAIL * 2) tail = tail.slice(-WATCH_TAIL)
    if (pending < WATCH_STEP) return null
    pending = 0
    return trailingRepetition(tail)
  }
}
