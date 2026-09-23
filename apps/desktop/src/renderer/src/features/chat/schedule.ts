/**
 * 日程编辑纯逻辑（cron 反解 / 拼装 / datetime-local 取值）——供「创建确认名片」与「任务编辑」共用，
 * 单一真源杜绝两处 cron 解析各自演化。均为无副作用纯函数，不依赖 React / preload。
 */

/** 周期模式（各类循环）。 */
export type RecurMode = 'daily' | 'weekly' | 'hourly' | 'everyN' | 'monthly' | 'custom'
/** 日程模式：一次性 + 各周期模式，统一由单个下拉选择。 */
export type ScheduleMode = 'once' | RecurMode

/** "YYYY-MM-DDTHH:MM"（datetime-local 值，本地墙钟无偏移）。 */
export function localDatetimeValue(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 归一星期集合：7→0（周日）、去重、升序；空集回落周一（编辑器恒保留至少一天）。 */
export function normalizeDows(dows: number[]): number[] {
  const set = new Set<number>()
  for (const d of dows) {
    if (!Number.isInteger(d) || d < 0 || d > 7) continue
    set.add(d === 7 ? 0 : d)
  }
  const out = [...set].sort((a, b) => a - b)
  return out.length ? out : [1]
}

/** 反解 cron 为周期编辑器的初始预设（匹配不上则落「自定义」，原样承载 cron 文本）。 */
export function parseRecur(cron: string): {
  mode: RecurMode
  time: string
  dows: number[]
  min: number
  n: number
  dom: number
  custom: string
} {
  const trimmed = cron.trim()
  const def = {
    mode: 'daily' as RecurMode,
    time: '10:00',
    dows: [1],
    min: 0,
    n: 30,
    dom: 1,
    custom: trimmed
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return { ...def, mode: trimmed ? 'custom' : 'daily' }
  const [m, h, dom, mon, dw] = parts
  const num = (s: string): number | null => (/^\d+$/.test(s) ? parseInt(s, 10) : null)
  // 纯数字列表（`2` / `2,4`）才认作「每周」预设；含区间/步长的复杂写法留给自定义原样承载
  const dowList = (s: string): number[] | null => {
    if (!/^\d+(,\d+)*$/.test(s)) return null
    const list = s.split(',').map((x) => parseInt(x, 10))
    return list.every((v) => v >= 0 && v <= 7) ? normalizeDows(list) : null
  }
  const fmt = (hh: string, mm: string): string =>
    `${String(parseInt(hh, 10)).padStart(2, '0')}:${String(parseInt(mm, 10)).padStart(2, '0')}`
  // 每天：分/时为数字，其余为 *
  if (dom === '*' && mon === '*' && dw === '*' && num(m) != null && num(h) != null)
    return { ...def, mode: 'daily', time: fmt(h, m) }
  // 每周：分/时为数字、星期为数字列表，日/月为 *
  const dows = dowList(dw)
  if (dom === '*' && mon === '*' && dows && num(m) != null && num(h) != null)
    return { ...def, mode: 'weekly', time: fmt(h, m), dows }
  // 每月：分/时/日为数字，月/星期为 *
  if (mon === '*' && dw === '*' && num(dom) != null && num(m) != null && num(h) != null)
    return { ...def, mode: 'monthly', time: fmt(h, m), dom: num(dom) as number }
  // 每小时：分为数字，其余为 *
  if (h === '*' && dom === '*' && mon === '*' && dw === '*' && num(m) != null)
    return { ...def, mode: 'hourly', min: num(m) as number }
  // 每 N 分钟：*/n，其余为 *
  const every = /^\*\/(\d+)$/.exec(m)
  if (every && h === '*' && dom === '*' && mon === '*' && dw === '*')
    return { ...def, mode: 'everyN', n: parseInt(every[1], 10) }
  return { ...def, mode: 'custom', custom: trimmed }
}

/** 由周期编辑器状态拼出 5 段 cron。 */
export function buildCron(
  mode: RecurMode,
  time: string,
  dows: number[],
  hourlyMin: number,
  everyN: number,
  dom: number,
  customCron: string
): string {
  const [hhRaw, mmRaw] = time.split(':')
  const h = String(parseInt(hhRaw || '0', 10) || 0)
  const m = String(parseInt(mmRaw || '0', 10) || 0)
  switch (mode) {
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${normalizeDows(dows).join(',')}`
    case 'monthly':
      return `${m} ${h} ${Math.max(1, Math.min(31, dom))} * *`
    case 'hourly':
      return `${Math.max(0, Math.min(59, hourlyMin))} * * * *`
    case 'everyN':
      return `*/${Math.max(1, everyN)} * * * *`
    default:
      return customCron.trim()
  }
}
