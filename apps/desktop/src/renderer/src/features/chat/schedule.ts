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

/** 反解 cron 为周期编辑器的初始预设（匹配不上则落「自定义」，原样承载 cron 文本）。 */
export function parseRecur(cron: string): {
  mode: RecurMode
  time: string
  dow: number
  min: number
  n: number
  dom: number
  custom: string
} {
  const trimmed = cron.trim()
  const def = {
    mode: 'daily' as RecurMode,
    time: '10:00',
    dow: 1,
    min: 0,
    n: 30,
    dom: 1,
    custom: trimmed
  }
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return { ...def, mode: trimmed ? 'custom' : 'daily' }
  const [m, h, dom, mon, dw] = parts
  const num = (s: string): number | null => (/^\d+$/.test(s) ? parseInt(s, 10) : null)
  const fmt = (hh: string, mm: string): string =>
    `${String(parseInt(hh, 10)).padStart(2, '0')}:${String(parseInt(mm, 10)).padStart(2, '0')}`
  // 每天：分/时为数字，其余为 *
  if (dom === '*' && mon === '*' && dw === '*' && num(m) != null && num(h) != null)
    return { ...def, mode: 'daily', time: fmt(h, m) }
  // 每周：分/时/星期为数字，日/月为 *
  if (dom === '*' && mon === '*' && num(dw) != null && num(m) != null && num(h) != null)
    return { ...def, mode: 'weekly', time: fmt(h, m), dow: num(dw) as number }
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
  dow: number,
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
      return `${m} ${h} * * ${dow}`
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
