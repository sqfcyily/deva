import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../i18n/i18n'
import type { TaskSchedule } from '../../../../preload'
import { buildCron, localDatetimeValue, normalizeDows, parseRecur, type ScheduleMode } from './schedule'

/**
 * 日程编辑器（对齐 1.png）——「创建确认名片」与「任务编辑弹窗」共用的唯一日程控件。
 *
 * 形态：一枚模式下拉（间隔 / 每小时 / 每天 / 每周 / 每月 / 不重复 / 自定义 cron）+ 随模式切换的同行控件；
 * 「每周」另起一行给七枚可多选的星期药丸（对齐 1.png，周一起始，至少保留一天）。
 * 分钟与「第几天」用下拉而非数字框（离散有限值，杜绝键入越界），间隔用数字框 + 「分」单位后缀。
 *
 * 状态全内聚于本组件（模式切换保留各模式已填值），每次变更把拼好的 TaskSchedule 交给父层，
 * 由父层做实时 preview 校验与落盘——cron 反解/拼装仍走 ./schedule 单一真源。
 */

/** 星期展示序：周一…周日（对齐 1.png）；值为 cron dow（0=周日）。 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEK_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function ScheduleEditor({
  initial,
  tz,
  onChange
}: {
  /** 初值（草稿或既有任务的日程）；仅首挂载读取，后续由本组件自持。 */
  initial: TaskSchedule
  /** 落在输出日程上的时区（草稿时区 / 任务原时区 / 本地兜底，由父层议定）。 */
  tz: string
  /** 每次编辑把完整日程交回父层（preview 校验与落盘均在父层）。 */
  onChange: (schedule: TaskSchedule) => void
}): React.JSX.Element {
  const { t } = useI18n()

  // 一次性初值：记录带则用，缺则 now+1h（供从周期切到「不重复」时有合理默认）。
  const onceInit = useMemo(
    () => initial.at || localDatetimeValue(new Date(Date.now() + 3600_000)),
    [initial.at]
  )
  const [onceDate, setOnceDate] = useState(onceInit.slice(0, 10))
  const [onceTime, setOnceTime] = useState(onceInit.slice(11, 16) || '10:00')

  const initRecur = useMemo(() => parseRecur(initial.cron ?? ''), [initial.cron])
  const [mode, setMode] = useState<ScheduleMode>(
    initial.kind === 'once' ? 'once' : initRecur.mode
  )
  const [time, setTime] = useState(initRecur.time)
  const [dows, setDows] = useState<number[]>(initRecur.dows)
  const [hourlyMin, setHourlyMin] = useState(initRecur.min)
  const [everyN, setEveryN] = useState(initRecur.n)
  const [dom, setDom] = useState(initRecur.dom)
  const [customCron, setCustomCron] = useState(initRecur.custom)

  const schedule = useMemo<TaskSchedule>(
    () =>
      mode === 'once'
        ? { kind: 'once', at: `${onceDate}T${onceTime}`, tz }
        : {
            kind: 'recurring',
            cron: buildCron(mode, time, dows, hourlyMin, everyN, dom, customCron),
            tz
          },
    [mode, onceDate, onceTime, time, dows, hourlyMin, everyN, dom, customCron, tz]
  )

  // 派发给父层：onChange 走 ref，父层传内联函数也不会造成重复派发（依赖只认 schedule 本身）。
  const emit = useRef(onChange)
  emit.current = onChange
  useEffect(() => {
    emit.current(schedule)
  }, [schedule])

  /** 星期药丸多选：点已选则取消，但恒保留至少一天（否则 cron 的 dow 段无值可填）。 */
  const toggleDow = (d: number): void =>
    setDows((prev) =>
      prev.includes(d)
        ? prev.length > 1
          ? prev.filter((x) => x !== d)
          : prev
        : normalizeDows([...prev, d])
    )

  return (
    <div className="sched">
      <div className="sched__row">
        <select
          className="sched__ctl sched__mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as ScheduleMode)}
        >
          <option value="everyN">{t('tasks.recurEveryN')}</option>
          <option value="hourly">{t('tasks.recurHourly')}</option>
          <option value="daily">{t('tasks.recurDaily')}</option>
          <option value="weekly">{t('tasks.recurWeekly')}</option>
          <option value="monthly">{t('tasks.recurMonthly')}</option>
          <option value="once">{t('tasks.schedOnce')}</option>
          <option value="custom">{t('tasks.recurCustom')}</option>
        </select>

        {mode === 'everyN' && (
          <>
            <input
              type="number"
              min={1}
              className="sched__ctl sched__num"
              value={everyN}
              onChange={(e) => setEveryN(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
            <span className="sched__unit">{t('tasks.unitMinute')}</span>
          </>
        )}

        {mode === 'hourly' && (
          <>
            <select
              className="sched__ctl sched__pick"
              value={hourlyMin}
              onChange={(e) => setHourlyMin(parseInt(e.target.value, 10) || 0)}
            >
              {MINUTES.map((n) => (
                <option key={n} value={n}>
                  {pad2(n)}
                </option>
              ))}
            </select>
            <span className="sched__unit">{t('tasks.unitMinute')}</span>
          </>
        )}

        {mode === 'monthly' && (
          <select
            className="sched__ctl sched__pick sched__pick--dom"
            value={dom}
            onChange={(e) => setDom(parseInt(e.target.value, 10) || 1)}
          >
            {MONTH_DAYS.map((n) => (
              <option key={n} value={n}>
                {t('tasks.monthDay').replace('{n}', String(n))}
              </option>
            ))}
          </select>
        )}

        {mode === 'once' && (
          <>
            <input
              type="date"
              className="sched__ctl sched__date"
              value={onceDate}
              onChange={(e) => setOnceDate(e.target.value)}
            />
            <input
              type="time"
              className="sched__ctl sched__time"
              value={onceTime}
              onChange={(e) => setOnceTime(e.target.value)}
            />
          </>
        )}

        {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
          <input
            type="time"
            className="sched__ctl sched__time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        )}

        {mode === 'custom' && (
          <input
            className="sched__ctl sched__cron"
            value={customCron}
            placeholder="0 10 * * *"
            onChange={(e) => setCustomCron(e.target.value)}
          />
        )}
      </div>

      {mode === 'weekly' && (
        <div className="sched__days">
          {WEEK_ORDER.map((d) => {
            const on = dows.includes(d)
            return (
              <button
                key={d}
                type="button"
                className={`sched__day${on ? ' is-on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleDow(d)}
              >
                {t(`tasks.weekday.${WEEK_KEYS[d]}`)}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
