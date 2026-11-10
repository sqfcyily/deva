/**
 * 模型上下文窗口与输出上限——主进程（压缩触发 / 每步输出预算）与渲染层（模型详情页显示「自动」值）共用的
 * 纯函数模块，不依赖 Node / DOM。
 *
 * 用户可在模型详情页为单个模型填写窗口 / 输出上限（存 config.json 的 ModelDef），留空即走这里的「自动」：
 *  - 窗口：模型 ID 自带（如 -128k / -1m）> 内置表 > 全局默认；
 *  - 输出：沿用引擎一直以来的默认（Claude 系给宽裕值，其余交给适配器 / 服务商默认）。
 * 内置表数据参照 models.dev 的模型目录（2026-11 核对），同一模型在不同服务商处上限不同时取官方端点的值。
 */

/** 对话模型的协议适配器（与 providers/* 一致）。 */
export type LimitAdapter = 'anthropic' | 'openai' | 'responses'

/** 表里查不到、ID 也不带窗口的模型所用的默认窗口（config.json 的 compaction.defaultWindow 可改）。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * 模型 → 上下文窗口（token）。规则按顺序匹配（小写模型 ID，不锚定首尾——中转常加前缀 `anthropic/`、
 * 后缀 `-20251001`），首条命中即用。拿不准的宁可报小：报小只是压缩来得早，报大则请求会被拒
 * （引擎会从报错里解析真实上限自愈，但白费一次请求）。
 * 2026 年起各家新一代模型多已 1M，按版本号划界：旧版维持原值，划界版本及以后给 1M——表里报小会让
 * 长对话过早、过频地压缩。
 */
const WINDOW_RULES: { match: RegExp; window: number }[] = [
  // ── Anthropic：4.6 起与 5 系 1M 已 GA（无需 beta 头）；Sonnet 4 / 4.5 的 1M beta 已退役，超 200K 即报错。
  { match: /claude-(fable|mythos)/, window: 1_000_000 },
  { match: /claude-(opus|sonnet)-4[-.][6-9](?!\d)|claude-(opus|sonnet|haiku)-[5-9]/, window: 1_000_000 },
  { match: /claude/, window: 200_000 },
  // ── OpenAI：GPT-5 系的输入另有上限（400K 档只收 272K、1.05M 档只收 922K，余下留给输出），
  //    这里记输入上限——压缩判定看的是输入。chat / instant / spark 与 mini / nano 先于通用规则。
  //    中转常把 5.5 写成 5-5 / 55：横杠与连写只认一位版本号，免得把 gpt-5-2025-08-07 的日期当成版本。
  { match: /codex-spark/, window: 100_000 },
  { match: /gpt-5(\.\d+)?-(chat|instant)/, window: 128_000 },
  { match: /gpt-5([.-]?[4-9](?!\d)|\.\d{2,})-(mini|nano)/, window: 272_000 },
  { match: /gpt-(5([.-]?[4-9](?!\d)|\.\d{2,})|[6-9])/, window: 922_000 },
  { match: /gpt-5/, window: 272_000 },
  { match: /gpt-4\.1/, window: 1_047_576 },
  { match: /gpt-oss/, window: 131_072 },
  { match: /(^|[^a-z0-9])o[134](-|$)/, window: 200_000 },
  { match: /gpt|chatgpt/, window: 128_000 },
  // ── xAI：4.1-fast 2M；4.20 / 4.3 为 1M；4.5 起为 500K（4.20 须先于「4.两位数」规则）。
  { match: /grok-4(\.1-fast|-1-fast|-fast)/, window: 2_000_000 },
  { match: /grok-4\.(20|3)(?!\d)/, window: 1_000_000 },
  { match: /grok-4\.([4-9]|\d{2,})/, window: 500_000 },
  { match: /grok-4|grok-code|grok-build/, window: 256_000 },
  { match: /grok/, window: 131_072 },
  // ── Google
  { match: /gemini/, window: 1_048_576 },
  { match: /gemma-?2/, window: 8_192 },
  { match: /gemma-4/, window: 262_144 },
  { match: /gemma/, window: 131_072 },
  // ── DeepSeek：V4 系（含 deepseek-flash / -pro 别名）1M；官方旧版 chat / reasoner 为 128K
  //    （开源权重标称 160K，多数服务商按 128K 开放）。
  { match: /deepseek-(v4|flash|pro)/, window: 1_000_000 },
  { match: /deepseek/, window: 128_000 },
  // ── 智谱 GLM：5.2 起 1M（火山引擎写作 glm-5-2-YYMMDD）；4.6 ~ 5.1 约 200K；视觉版 4.5v 64K、4.6v 128K。
  { match: /glm-4\.5v/, window: 64_000 },
  { match: /glm-4\.\d+v/, window: 128_000 },
  { match: /glm-5[.-][2-9](?!\d)|glm-[6-9]/, window: 1_000_000 },
  { match: /glm-(4\.([6-9]|\d{2,})|5)/, window: 200_000 },
  { match: /glm/, window: 128_000 },
  // ── 通义：plus / flash / turbo / coder-plus 商业版与 3.7 起的 max 为 1M；开源 dense 小模型多经本地跑，
  //    按原生 40K 保守。
  { match: /qwen-plus-character/, window: 32_768 },
  { match: /qwen3(\.\d+)?-coder-(plus|flash)/, window: 1_000_000 },
  { match: /qwen3\.\d+-(\w+-)?(plus|flash)|qwen-(plus|flash|turbo)/, window: 1_000_000 },
  { match: /qwen3\.([7-9]|\d{2,})-max/, window: 1_000_000 },
  { match: /qwen3(\.\d+)?-max/, window: 262_144 },
  { match: /qwen-?max/, window: 131_072 },
  { match: /qwen3\.\d+/, window: 262_144 },
  { match: /qwen3-(coder|next|vl-plus)|qwen3-.*2507/, window: 262_144 },
  { match: /qwen3[-:]\d+b/, window: 40_960 }, // 含 Ollama 的 qwen3:8b 写法
  { match: /qwen2/, window: 32_000 },
  { match: /qwq/, window: 131_072 },
  { match: /qwen/, window: 128_000 },
  // ── Moonshot：初版 kimi-k2（0711）为 128K，K2 后续各版 256K，K3 起 1M（Kimi 编程套餐写作 k3 / k3.1-pro）；
  //    moonshot-v1-8k/32k/128k 由 ID 自带窗口解析。
  { match: /kimi-k2(-0711|-instruct$|$)/, window: 131_072 },
  { match: /moonshot-v1/, window: 128_000 },
  { match: /kimi-k([3-9]|\d{2,})|kimi-for-coding(?!-highspeed)|(^|\/)k[3-9](\.\d+)?(-|$)/, window: 1_000_000 },
  { match: /kimi|moonshot/, window: 262_144 },
  // ── MiniMax：M1 与 M3 起 1M，M2 系约 200K。
  { match: /minimax-m(1|[3-9])/, window: 1_000_000 },
  { match: /minimax/, window: 196_608 },
  // ── 其余
  { match: /doubao-seed|(^|[^a-z])seed-[12]/, window: 256_000 },
  { match: /mimo-v2(\.\d+)?-pro|mimo-v2\.([5-9]|\d{2,})/, window: 1_000_000 },
  { match: /mimo/, window: 262_144 },
  { match: /(^|[^a-z0-9])hy[4-9](?!\d)/, window: 1_000_000 }, // 腾讯混元
  { match: /(^|[^a-z0-9])hy3(?!\d)/, window: 256_000 },
  { match: /longcat-[2-9]/, window: 1_000_000 },
  { match: /(^|[^a-z])step-[5-9]/, window: 1_000_000 }, // 阶跃星辰
  { match: /(^|[^a-z])step-3\.[5-9]/, window: 256_000 },
  { match: /mistral-large-4/, window: 1_000_000 },
  { match: /ministral-3b/, window: 128_000 },
  { match: /(mistral|devstral|codestral|magistral|ministral)[\w.-]*-(latest|2512|26\d\d)/, window: 256_000 },
  { match: /mistral|codestral|devstral|magistral/, window: 128_000 },
  { match: /llama/, window: 32_000 } // 本地 Llama：有效窗口常远小于标称，保守
]

/** 内置表里的窗口；查不到返回 undefined。 */
export function builtinContextWindow(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  return WINDOW_RULES.find((r) => r.match.test(id))?.window
}

/** 「自动」窗口：ID 自带（如 -128k / -1m）> 内置表 > fallback。 */
export function autoContextWindow(modelId: string, fallback = DEFAULT_CONTEXT_WINDOW): number {
  const km = /(\d+)k\b/i.exec(modelId)
  if (km) {
    const n = Number(km[1])
    if (n >= 4 && n <= 4000) return n * 1000
  }
  const mm = /(\d+)m\b/i.exec(modelId)
  if (mm) {
    const n = Number(mm[1])
    if (n >= 1 && n <= 10) return n * 1_000_000
  }
  return builtinContextWindow(modelId) ?? fallback
}

/** Claude 系的每步输出预算：带思考的新模型给小了会被思维链吃光，一字未出就撞限。 */
export const OUTPUT_BUDGET_WIDE = 32_000
/** 保守输出预算：Anthropic / Responses 适配器的默认值，也是被服务商拒绝后的降档值。 */
export const OUTPUT_BUDGET_SAFE = 8192

/**
 * 「自动」输出上限：Claude 系 32K；其余 Anthropic / Responses 协议 8K（适配器默认）；
 * OpenAI Chat 协议返回 undefined = 不传，交给服务商默认。
 */
export function autoOutputBudget(adapter: LimitAdapter, modelId: string): number | undefined {
  if (/claude/i.test(modelId)) return OUTPUT_BUDGET_WIDE
  return adapter === 'openai' ? undefined : OUTPUT_BUDGET_SAFE
}

/** 用户可填的范围（token）：超出即视为无效输入。 */
export const CONTEXT_WINDOW_RANGE = { min: 1_000, max: 20_000_000 } as const
export const MAX_OUTPUT_RANGE = { min: 256, max: 2_000_000 } as const

/** config.json 里存的覆盖值是否可用（整数、落在范围内）。 */
export function validLimit(v: unknown, range: { min: number; max: number }): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= range.min && v <= range.max
}

/**
 * token 数的紧凑写法：1M / 1.05M / 200K / 128K（131072）/ 8K（8192）。
 * 先认十进制整数（128000 也能被 1024 整除，按二进制会显示成 125K），再认二进制整数。
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    if (n % 1_000_000 === 0) return `${n / 1_000_000}M`
    if (n % 1_048_576 === 0) return `${n / 1_048_576}M`
    return `${Number((n / 1_000_000).toFixed(2))}M`
  }
  if (n >= 1000) {
    if (n % 1000 === 0) return `${n / 1000}K`
    if (n % 1024 === 0) return `${n / 1024}K`
    return `${Number((n / 1000).toFixed(1))}K`
  }
  return String(n)
}

/** 解析用户输入的 token 数：支持 200000 / 200,000 / 200k / 1m / 1.5M；无法解析返回 null。 */
export function parseTokens(input: string): number | null {
  const s = input.replace(/[\s,_，]/g, '')
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(s)
  if (!m) return null
  const unit = m[2]?.toLowerCase()
  const n = Number(m[1]) * (unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1)
  return Number.isFinite(n) ? Math.round(n) : null
}

/**
 * 从服务商的「上下文超限」报错里解析真实窗口（token）；认不出返回 undefined。
 * 只认明确写着上下文上限的句式——输出上限超限（max_tokens > N）的数字不能当成窗口。
 */
export function parseContextLimit(body: string): number | undefined {
  const patterns = [
    /prompt is too long:\s*\d+\s*tokens?\s*>\s*(\d+)/i, // Anthropic
    /exceeds? (?:the )?context limit:\s*\d+\s*\+\s*\d+\s*>\s*(\d+)/i, // Anthropic：input + max_tokens 超窗
    /maximum context length is\s*(\d+)/i, // OpenAI / DeepSeek / vLLM
    /maximum number of tokens allowed\s*\((\d+)\)/i, // Gemini
    /input length should be\s*\[\s*\d+\s*,\s*(\d+)\s*\]/i, // 通义 DashScope
    /model token limit:?\s*(\d+)/i, // Moonshot
    /context (?:window|length) (?:of|is)\s*(\d+)/i
  ]
  for (const re of patterns) {
    const m = re.exec(body)
    if (!m) continue
    const n = Number(m[1])
    if (validLimit(n, CONTEXT_WINDOW_RANGE)) return n
  }
  return undefined
}

/** 拉丁文字等按约 3.5 字符 ≈ 1 token 估算。 */
const CHARS_PER_TOKEN = 3.5

/** 中日韩文字、全角符号：一字约 1 token（各家分词器在 0.6~1.5 之间，取 1 偏保守）。 */
function isCjk(c: number): boolean {
  return (
    (c >= 0x2e80 && c <= 0x9fff) || // 部首、标点、假名、汉字
    (c >= 0xac00 && c <= 0xd7af) || // 韩文
    (c >= 0xf900 && c <= 0xfaff) || // 兼容汉字
    (c >= 0xff00 && c <= 0xffef) // 全角字符
  )
}

/**
 * 文本的 token 估算（拿不到真实用量时用）。统一按 3.5 字符 ≈ 1 token 会把中文低估到三分之一左右，
 * 压缩线贴近窗口时容易估少撞上限，故中日韩字符单独按一字一 token 计。
 */
export function estimateTextTokens(s: string): number {
  let cjk = 0
  for (let i = 0; i < s.length; i++) if (isCjk(s.charCodeAt(i))) cjk++
  return cjk + (s.length - cjk) / CHARS_PER_TOKEN
}
