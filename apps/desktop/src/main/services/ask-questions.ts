/**
 * ask_user 参数解析：把模型给的问题列表归一成问答卡能画的形状（剔除重复的「自己输入」选项、判定可跳过题）。
 */

import type {
  AskOption,
  AskQuestion
} from '../../shared/chat-protocol'

/**
 * 判定某选项 label 是否与界面内置的「自己输入」入口重复。界面每题都会追加该伪选项，
 * 模型仍常自作主张塞一个「自己输入 / 自定义 / 手动输入 / Custom / Enter your own」——需剔除以免重复。
 * 刻意只认「明确表示自行打字」的兜底措辞：`其他/Other` 这类含糊词可能是真实业务分类，
 * 交由工具描述约束、不在此自动过滤，避免误伤合法选项。
 */
const CUSTOM_ENTRY_LABELS = new Set([
  '自己输入',
  '自行输入',
  '自定义',
  '自定义输入',
  '自定义答案',
  '手动输入',
  '手动填写',
  '手动录入',
  '手填',
  'custom',
  'custom input',
  'custom answer',
  'enter your own',
  'type your own',
  'enter manually',
  'input manually'
])

function isCustomEntryLabel(label: string): boolean {
  // 归一：去首尾空白与尾部省略号/标点（…/./。/:/：），再小写比对。
  const k = label
    .trim()
    .replace(/[…\.。:：\s]+$/u, '')
    .toLowerCase()
  return CUSTOM_ENTRY_LABELS.has(k)
}

/**
 * 把模型给的「选项」值健壮地归一成 AskOption[]。刻意宽容：不同模型对候选项的写法五花八门，
 * 若只认「对象且 label 为字符串」会把纯字符串数组 / 别名键（value/title/text/name）全部静默丢掉，
 * 表现为「有问题却无选项、只剩自由输入」。这里逐项归一，尽量不丢用户本可点选的项。
 * 末尾剔除与内置「自己输入」入口重复的兜底项。
 */
function normalizeOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const out: AskOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) out.push({ label })
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const labelKey = ['label', 'value', 'title', 'text', 'name'].find(
        (k) => typeof o[k] === 'string' && (o[k] as string).trim()
      )
      if (!labelKey) continue
      const label = (o[labelKey] as string).trim()
      const description =
        typeof o.description === 'string' && o.description.trim() ? o.description : undefined
      out.push({ label, description })
    }
  }
  return out.filter((o) => !isCustomEntryLabel(o.label))
}

/**
 * 题干里表达「答案可留空」的口径（中英）。用于在模型漏设 required:false 时兜底识别为可选题。
 * 「可选」只认括号标记 [（(]可选[)）]，不认裸「可选」——避免误伤「可选方案/可选项」这类正常用词。
 */
const OPTIONAL_HINT_RE =
  /留空|选填|非必填|可不填|可不答|可跳过|可略过|可省略|无则不填|没有.{0,4}不填|[（(]\s*可选\s*[)）]|optional|leave\s+(?:it\s+|this\s+)?blank|if\s+(?:any|none)/i

/** 反向语：题干明说「不可留空/必填（排除『非必填』）」。命中则强制必答，抵消上面的误判。 */
const REQUIRED_HINT_RE = /(?<!非)必填|必须填|请勿留空|不要留空|不可留空|不能留空|勿留空/

/**
 * 判定某题是否可选（允许空答）。优先信模型显式的 required；未显式声明时，据题干口径兜底：
 * 出现「可留空/选填/optional」等且无「请勿留空/必填」反向语 → 视为可选。
 * 这弥补了「模型只在题干里用自然语言说可留空、却没设 required:false」导致界面强制必答的问题。
 */
function isQuestionOptional(question: string, explicit: unknown): boolean {
  if (explicit === false) return true
  if (explicit === true) return false
  return OPTIONAL_HINT_RE.test(question) && !REQUIRED_HINT_RE.test(question)
}

/**
 * 把 ask_user 工具入参健壮地解析成 AskQuestion[]。优先读多问格式 `questions`；
 * 若缺失/为空但存在顶层 `question`（旧式或跑偏调用），防御性收编成单元素；
 * 仍为空则兜底为一条通用问题——绝不向渲染层抛空卡。
 */
export function parseAskQuestions(args: unknown): AskQuestion[] {
  const a = (args ?? {}) as { questions?: unknown; question?: unknown; options?: unknown }
  const out: AskQuestion[] = []
  if (Array.isArray(a.questions)) {
    for (const item of a.questions) {
      if (!item || typeof item !== 'object') continue
      const q = item as Record<string, unknown>
      const question = typeof q.question === 'string' && q.question.trim() ? q.question : ''
      const options = normalizeOptions(q.options)
      // 无题干但有选项时兜底题干，避免整条问题因题干缺失被丢；题干与选项都空的项才跳过。
      if (!question && options.length === 0) continue
      out.push({
        question: question || '请选择：',
        options,
        multi: Boolean(q.multiSelect),
        // required 默认 true；模型显式 required:false 或题干口径含「可留空/选填」等 → 视为可跳过。
        required: !isQuestionOptional(question, q.required)
      })
    }
  }
  // 防御回退：模型仍按旧式单问格式调用（顶层 question/options）。
  if (out.length === 0 && typeof a.question === 'string' && a.question.trim()) {
    out.push({ question: a.question, options: normalizeOptions(a.options), multi: false, required: true })
  }
  // 最终兜底：绝不发空问答卡。
  if (out.length === 0) out.push({ question: '请选择：', options: [], multi: false, required: true })
  return out
}
