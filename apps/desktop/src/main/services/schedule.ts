import type { TaskSchedule } from './tasks-types'

/**
 * 定时任务调度引擎（自包含、纯函数、遵免装铁律零外部依赖）。
 *
 * 时区/DST 关键：墙钟按任务捕获的 IANA `tz` 经 `Intl.DateTimeFormat(...).formatToParts` 换算，
 * **绝不用裸 `Date` 的本机时区**——让「每天 10 点」跨夏令时仍锚定本地 10:00。
 * - spring-forward（不存在的墙钟分钟）：`once` 经偏移二次校正落到下一有效瞬间；`recurring` 按 UTC 分钟
 *   逐格前扫、由真实瞬间反推墙钟，故不存在的墙钟分钟自然不匹配（跳过当日该次）。
 * - fall-back（重复小时）：UTC 前扫先遇首次出现，故 `recurring` 取**首次**（符合既定语义）。
 *
 * 全部函数纯粹、无副作用、无 IPC，可用临时 node 脚本走查（本仓库无测试运行器，遵免装铁律）。
 */

// ── cron 解析 ────────────────────────────────────────────────────────────────

/** 解析后的 cron：五个字段各展开为「允许值集合」。 */
export interface ParsedCron {
  minute: Set<number> // 0-59
  hour: Set<number> // 0-23
  dom: Set<number> // 1-31
  month: Set<number> // 1-12
  dow: Set<number> // 0-6（0=周日）
  /** dom 字段是否为 `*`（决定 dom/dow 的 AND/OR 语义）。 */
  domStar: boolean
  /** dow 字段是否为 `*`。 */
  dowStar: boolean
}

interface FieldSpec {
  min: number
  max: number
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 } // day-of-week（7 与 0 同为周日）
]

/** 解析单个字段为允许值集合；非法返回 null。支持 星号、步长、区间（a-b）、列表（a,b,c）与纯数字组合。 */
function parseField(raw: string, spec: FieldSpec): Set<number> | null {
  const out = new Set<number>()
  const parts = raw.split(',')
  if (parts.length === 0) return null
  for (const partRaw of parts) {
    const part = partRaw.trim()
    if (!part) return null
    // 拆步长 `.../n`
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash >= 0) {
      range = part.slice(0, slash).trim()
      const stepStr = part.slice(slash + 1).trim()
      if (!/^\d+$/.test(stepStr)) return null
      step = parseInt(stepStr, 10)
      if (step <= 0) return null
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = spec.min
      hi = spec.max
    } else if (/^\d+$/.test(range)) {
      lo = hi = parseInt(range, 10)
      // 单数字带步长（如 `5/10`）在标准 cron 里等价 `5-max/10`
      if (slash >= 0) hi = spec.max
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range)
      if (!m) return null
      lo = parseInt(m[1], 10)
      hi = parseInt(m[2], 10)
    }
    if (lo < spec.min || hi > spec.max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? out : null
}

/**
 * 解析 5 段 cron（`min hour dom mon dow`）；非法返回 null。
 * 校验前置于**创建时**暴露（拒非法 cron），绝不留到触发时才失败。
 * dow 的 7 归一为 0（周日）。
 */
export function parseCron(expr: string): ParsedCron | null {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const sets: Set<number>[] = []
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(fields[i], FIELD_SPECS[i])
    if (!parsed) return null
    sets.push(parsed)
  }
  // dow：把 7 折成 0（周日）
  const dow = new Set<number>()
  for (const v of sets[4]) dow.add(v === 7 ? 0 : v)
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domStar: fields[2].trim() === '*',
    dowStar: fields[4].trim() === '*'
  }
}

// ── 时区换算（Intl，DST 安全）──────────────────────────────────────────────

/** 某 tz 的 DateTimeFormat 实例缓存（构造较贵，按 tz 复用）。 */
const dtfCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(tz)
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    dtfCache.set(tz, dtf)
  }
  return dtf
}

/** 校验一个 IANA 时区名是否被运行时支持（构造抛错即不支持）。 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface WallParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
}

/** 把某 UTC 瞬间在指定 tz 下的墙钟拆分。 */
function wallPartsAt(utcMs: number, tz: string): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs))
  const map: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
  let hour = parseInt(map.hour, 10)
  if (hour === 24) hour = 0 // 某些运行时 h23 边界仍可能给出 24
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10)
  }
}

/** 指定瞬间下 tz 相对 UTC 的偏移（ms，东为正）。 */
function tzOffsetAt(utcMs: number, tz: string): number {
  const w = wallPartsAt(utcMs, tz)
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asIfUtc - utcMs
}

/**
 * 把「tz 下的墙钟 y-mo-d h:mi」转为 UTC epoch ms。
 * 二次偏移校正处理 DST 边界：spring-forward 不存在的墙钟落到下一有效瞬间；
 * fall-back 重复墙钟取（偏移校正后的）确定解。
 */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0)
  const off1 = tzOffsetAt(guess, tz)
  let ts = guess - off1
  const off2 = tzOffsetAt(ts, tz)
  if (off2 !== off1) ts = guess - off2
  return ts
}

/** 由墙钟 y-mo-d 求周几（0=周日），与 tz 无关（纯历法）。 */
function dowOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

// ── 一次性 ISO 解析 ──────────────────────────────────────────────────────────

/** 解析 'once' 的墙钟 ISO（无偏移，如 "2026-09-21T17:00" 或含秒），返回字段；非法 null。 */
export function parseWallIso(
  at: string
): { y: number; mo: number; d: number; h: number; mi: number } | null {
  if (typeof at !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(at.trim())
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  const h = +m[4]
  const mi = +m[5]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  return { y, mo, d, h, mi }
}

// ── nextRun ──────────────────────────────────────────────────────────────────

/**
 * recurring 前扫上限（分钟）：~8 年。
 * 连续两个 2/29 最长相隔 8 年（跨世纪非闰年，如 2096→2104，因 2100 非闰年），故需覆盖 8 年。
 * 因「整日不匹配即跳过一天」的优化，非匹配日每天仅一次迭代，即便扫满上限也只 ~3000 次日检，代价可忽略。
 * 永不匹配的病态 cron（如 2/30、4/31）会扫满上限返回 null——createTask 据此在创建时拒绝。
 */
const MAX_SCAN_MINUTES = (366 * 8 + 10) * 24 * 60

/**
 * 求「> after」的下一次触发（UTC epoch ms）；无更多触发返回 null。
 * - `once`：把墙钟 `at` 按 `tz` 转 UTC，> after 返回，否则 null（已过期）。
 * - `recurring`：从 after 的下一分钟起按 UTC 分钟前扫，反推 tz 墙钟比对 cron；命中即返回。
 *   非匹配日整日跳过（跳到下一本地午夜），把病态 cron 的扫描收敛到 ~370 次日检 + 命中日的分钟扫描。
 */
export function nextRun(schedule: TaskSchedule, after: number): number | null {
  if (!schedule || !isValidTimeZone(schedule.tz)) return null

  if (schedule.kind === 'once') {
    const p = parseWallIso(schedule.at ?? '')
    if (!p) return null
    const ts = wallClockToUtc(p.y, p.mo, p.d, p.h, p.mi, schedule.tz)
    return ts > after ? ts : null
  }

  // recurring
  const cron = parseCron(schedule.cron ?? '')
  if (!cron) return null
  const tz = schedule.tz

  // 从 after 之后的下一个整分开始（对齐分钟格）。
  let cursor = Math.floor(after / 60000) * 60000 + 60000
  const limit = cursor + MAX_SCAN_MINUTES * 60000

  // 夏令时 spring-forward 缺口填充：本地墙钟因前跳（如 02:00→03:00）而某目标分钟根本不存在时，
  // 于跳变后的首个有效分钟触发——对齐 Vixie cron / systemd「补跑被跳过时刻」语义，
  // 而非把该次触发整天跳过（否则每天 02:30 的提醒会在换季当天无声消失）。
  // 判据：同一本地日内相邻两分钟的 minute-of-day 出现「前跳」（curMod > prevMod+1）。
  // fall-back（墙钟回拨、01:xx 重复）使 minute-of-day 后退，不满足前跳条件 → 天然取首次出现，无重复。
  let prevDayKey = -1
  let prevMod = -1

  while (cursor < limit) {
    const w = wallPartsAt(cursor, tz)
    const monthOk = cron.month.has(w.month)
    let dayOk: boolean
    if (monthOk) {
      const domMatch = cron.dom.has(w.day)
      const dowMatch = cron.dow.has(dowOf(w.year, w.month, w.day))
      // 标准 cron：dom 与 dow 都受限（非 *）时取 OR；有一个为 * 则只看另一个。
      if (cron.domStar && cron.dowStar) dayOk = true
      else if (cron.domStar) dayOk = dowMatch
      else if (cron.dowStar) dayOk = domMatch
      else dayOk = domMatch || dowMatch
    } else {
      dayOk = false
    }

    if (!monthOk || !dayOk) {
      // 整日不匹配 → 跳到下一本地午夜（至少前进 1 分钟，杜绝死循环）。缺口跟踪跨日重置。
      const minsIntoDay = w.hour * 60 + w.minute
      const advance = 24 * 60 - minsIntoDay // 恒 >= 1
      prevDayKey = -1
      prevMod = -1
      cursor += advance * 60000
      continue
    }

    // 精确命中当前墙钟分钟。
    if (cron.hour.has(w.hour) && cron.minute.has(w.minute)) return cursor

    // spring-forward 缺口：同一本地日内墙钟由上一分钟前跳，若被跳过的某分钟正是目标，
    // 则在跳变后首个有效分钟（当前 cursor）触发。
    const curMod = w.hour * 60 + w.minute
    const dayKey = w.year * 10000 + w.month * 100 + w.day
    if (dayKey === prevDayKey && curMod > prevMod + 1) {
      for (let t = prevMod + 1; t < curMod; t++) {
        if (cron.hour.has(Math.floor(t / 60)) && cron.minute.has(t % 60)) return cursor
      }
    }

    prevDayKey = dayKey
    prevMod = curMod
    cursor += 60000
  }
  return null
}

// ── 人读摘要 ────────────────────────────────────────────────────────────────

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 名片/列表用的人读摘要。尽量把常见 cron 说人话（每天 / 每周 X / 每小时 / 每 N 分钟），
 * 兜不住的复杂表达式回落原始 cron 串。once 显示墙钟日期时间。
 */
export function describeSchedule(schedule: TaskSchedule, locale: 'zh-CN' | 'en'): string {
  const zh = locale !== 'en'
  if (!schedule) return ''

  if (schedule.kind === 'once') {
    const p = parseWallIso(schedule.at ?? '')
    if (!p) return schedule.at ?? ''
    const dt = `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`
    return zh ? `${dt} 一次` : `once at ${dt}`
  }

  const cron = parseCron(schedule.cron ?? '')
  if (!cron) return schedule.cron ?? ''

  const fields = (schedule.cron ?? '').trim().split(/\s+/)
  const [minF, hourF, domF, monF, dowF] = fields
  const single = (s: Set<number>): number | null => (s.size === 1 ? [...s][0] : null)

  // 每 N 分钟：min = */n, 其余 *
  const everyNMin = /^\*\/(\d+)$/.exec(minF)
  if (everyNMin && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    const n = everyNMin[1]
    return zh ? `每 ${n} 分钟` : `every ${n} min`
  }

  // 每小时（第 m 分）：min 为单值，hour = *
  const m = single(cron.minute)
  if (m != null && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    return zh ? `每小时第 ${m} 分` : `hourly at :${pad2(m)}`
  }

  const h = single(cron.hour)
  const timeStr = h != null && m != null ? `${pad2(h)}:${pad2(m)}` : null

  // 每天 HH:MM：min/hour 单值，dom/mon/dow 全 *
  if (timeStr && domF === '*' && monF === '*' && dowF === '*') {
    return zh ? `每天 ${timeStr}` : `daily at ${timeStr}`
  }

  // 每周某几天 HH:MM：min/hour 单值，dom/mon 为 *，dow 受限
  if (timeStr && domF === '*' && monF === '*' && dowF !== '*') {
    const days = [...cron.dow].sort((a, b) => a - b)
    const names = days.map((d) => (zh ? WEEK_ZH[d] : WEEK_EN[d]))
    const joined = zh ? names.join('、') : names.join(', ')
    return zh ? `每${joined} ${timeStr}` : `${joined} at ${timeStr}`
  }

  // 每月某日 HH:MM：min/hour 单值，dom 受限，mon/dow 为 *
  const dom = single(cron.dom)
  if (timeStr && dom != null && monF === '*' && dowF === '*') {
    return zh ? `每月 ${dom} 日 ${timeStr}` : `monthly on day ${dom} at ${timeStr}`
  }

  // 兜底：原始 cron 表达式
  return zh ? `cron：${schedule.cron}` : `cron: ${schedule.cron}`
}
