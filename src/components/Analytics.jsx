import { useMemo, useState } from 'react'
import { CalendarBlank, CaretRight } from '@phosphor-icons/react'
import CompletedGoalsPreview from './CompletedGoalsPreview'
import {
  getMicroProgressForScopedGoals,
  getMicroStepActivityDateKey,
  normalizeGoalForStats,
} from '../utils/statistics'

const RANGE_OPTIONS = [
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Все время' },
]

const DOW_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']
const MS_PER_DAY = 24 * 60 * 60 * 1000

function pluralize(count, forms) {
  const value = Math.abs(Math.trunc(Number(count) || 0))
  const lastTwo = value % 100
  const last = value % 10
  if (lastTwo >= 11 && lastTwo <= 14) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

function formatDashboardDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'Без даты'
  return date
    .toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    })
    .replace(/\s?г\.$/, '')
    .replace(/\./g, '')
}

function formatActivityHeading(key) {
  const date = new Date(`${key}T12:00:00`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/\s?г\.$/, '')
}

function formatShortMonth(dateLike) {
  const date = dateLike ? new Date(dateLike) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ru-RU', { month: 'short' }).replace(/\./g, '')
}

function formatFullMonth(dateLike) {
  const date = dateLike ? new Date(dateLike) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/\s?г\.$/, '')
}

function formatStepCount(count) {
  return `${count} ${pluralize(count, ['шаг', 'шага', 'шагов'])}`
}

function startOfDay(dateLike) {
  const date = new Date(dateLike)
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(dateLike, days) {
  const date = startOfDay(dateLike)
  if (!date) return null
  date.setDate(date.getDate() + Number(days || 0))
  return date
}

function startOfMonth(dateLike) {
  const date = startOfDay(dateLike)
  if (!date) return null
  date.setDate(1)
  return date
}

function toLocalDateKey(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toMonthKey(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function getRangeBounds(range, goals, now = new Date()) {
  const end = startOfDay(now)
  if (!end) return null

  if (range === 'week') return { start: addDays(end, -6), end }
  if (range === 'month') return { start: addDays(end, -29), end }
  if (range === 'year') return { start: addDays(end, -364), end }

  const timestamps = []
  for (const goal of goals) {
    const goalTime = new Date(goal.completedAt || goal.createdAt).getTime()
    if (Number.isFinite(goalTime)) timestamps.push(goalTime)

    for (const step of goal.steps || []) {
      const activityKey = getMicroStepActivityDateKey(step)
      if (!activityKey) continue
      const stepTime = new Date(`${activityKey}T12:00:00`).getTime()
      if (Number.isFinite(stepTime)) timestamps.push(stepTime)
    }
  }

  timestamps.sort((a, b) => a - b)
  if (timestamps.length === 0) return { start: null, end: null }

  return {
    start: startOfDay(timestamps[0]),
    end: startOfDay(timestamps[timestamps.length - 1]),
  }
}

function getRangeCaption(range, bounds) {
  if (!bounds?.start || !bounds?.end) {
    return range === 'all' ? 'За всё время' : 'По выбранному периоду'
  }
  return `${formatDashboardDate(bounds.start)} — ${formatDashboardDate(bounds.end)}`
}

function getRangeDates(bounds, limit = 500) {
  if (!bounds?.start || !bounds?.end) return []
  const dates = []
  let cursor = new Date(bounds.start)
  let guard = 0

  while (cursor.getTime() <= bounds.end.getTime() && guard < limit) {
    dates.push(toLocalDateKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
    guard += 1
  }

  return dates
}

function getRangeMonths(bounds, limit = 120) {
  if (!bounds?.start || !bounds?.end) return []
  const months = []
  const end = startOfMonth(bounds.end)
  let cursor = startOfMonth(bounds.start)
  let guard = 0

  while (cursor && end && cursor.getTime() <= end.getTime() && guard < limit) {
    months.push(toMonthKey(cursor))
    cursor.setMonth(cursor.getMonth() + 1)
    guard += 1
  }

  return months
}

function formatWeekHeading(startKey, endKey) {
  return `${formatDashboardDate(`${startKey}T12:00:00`)} — ${formatDashboardDate(`${endKey}T12:00:00`)}`
}

function formatWeekLabel(startKey, endKey) {
  const start = new Date(`${startKey}T12:00:00`)
  const end = new Date(`${endKey}T12:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return startKey

  const startDay = start.getDate()
  const endDay = end.getDate()
  const startMonth = formatShortMonth(start)
  const endMonth = formatShortMonth(end)

  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startDay}–${endDay} ${endMonth}`
  }

  return `${startDay} ${startMonth} – ${endDay} ${endMonth}`
}

function getLabelStep(total, view) {
  if (view === 'day') {
    if (total <= 10) return 1
    if (total <= 20) return 2
    return 3
  }
  if (view === 'week') {
    if (total <= 8) return 1
    if (total <= 16) return 2
    return 4
  }
  if (total <= 12) return 1
  if (total <= 24) return 2
  return 3
}

function createActivityBuckets(bounds, view) {
  if (!bounds?.start || !bounds?.end) return []

  if (view === 'month') {
    return getRangeMonths(bounds).map(key => {
      const date = new Date(`${key}-01T12:00:00`)
      return {
        key,
        label: formatShortMonth(date),
        subLabel: String(date.getFullYear()),
        heading: formatFullMonth(date),
        count: 0,
      }
    })
  }

  if (view === 'week') {
    const buckets = []
    let cursor = new Date(bounds.start)
    let guard = 0

    while (cursor.getTime() <= bounds.end.getTime() && guard < 120) {
      const bucketStart = new Date(cursor)
      const bucketEnd = addDays(bucketStart, 6)
      if (bucketEnd && bucketEnd.getTime() > bounds.end.getTime()) {
        bucketEnd.setTime(bounds.end.getTime())
      }

      const startKey = toLocalDateKey(bucketStart)
      const endKey = toLocalDateKey(bucketEnd)

      buckets.push({
        key: `${startKey}:${endKey}`,
        label: formatWeekLabel(startKey, endKey),
        subLabel: '',
        heading: formatWeekHeading(startKey, endKey),
        count: 0,
      })

      cursor = addDays(bucketStart, 7)
      guard += 1
    }

    return buckets
  }

  return getRangeDates(bounds).map(key => {
    const date = new Date(`${key}T12:00:00`)
    return {
      key,
      label: String(date.getDate()),
      subLabel: DOW_SHORT[date.getDay()]?.toLowerCase?.() || '',
      heading: formatActivityHeading(key),
      count: 0,
    }
  })
}

function buildActivityEntries(goals, bounds, view) {
  const buckets = createActivityBuckets(bounds, view)
  if (buckets.length === 0) return []

  const entries = buckets.map(bucket => ({ ...bucket }))
  const startTime = bounds?.start?.getTime?.() || 0
  const fromKey = bounds?.start ? toLocalDateKey(bounds.start) : ''
  const toKey = bounds?.end ? toLocalDateKey(bounds.end) : ''

  for (const goal of goals) {
    for (const step of goal.steps || []) {
      if (!step.completed) continue
      const dateKey = getMicroStepActivityDateKey(step)
      if (!dateKey) continue
      if (fromKey && toKey && (dateKey < fromKey || dateKey > toKey)) continue

      const stepDate = new Date(`${dateKey}T12:00:00`)
      const stepTime = stepDate.getTime()
      if (!Number.isFinite(stepTime)) continue

      let entry = null
      if (view === 'month') {
        entry = entries.find(item => item.key === dateKey.slice(0, 7)) || null
      } else if (view === 'week') {
        const diffDays = Math.floor((stepTime - startTime) / MS_PER_DAY)
        const bucketIndex = Math.floor(diffDays / 7)
        entry = entries[bucketIndex] || null
      } else {
        entry = entries.find(item => item.key === dateKey) || null
      }
      if (!entry) continue

      entry.count += 1
    }
  }

  const labelStep = getLabelStep(entries.length, view)
  return entries.map((entry, index) => ({
    ...entry,
    showLabel: index % labelStep === 0 || index === entries.length - 1,
  }))
}

function Analytics({ goals, completedGoals, onOpenCompletedGoals, onResetProgress }) {
  const [range, setRange] = useState('month')
  const [activityKeyPreference, setActivityKeyPreference] = useState('')

  const completedStatGoals = useMemo(
    () => completedGoals.map(goal => normalizeGoalForStats(goal, { completed: true })),
    [completedGoals]
  )

  const statGoals = useMemo(
    () => [
      ...goals.map(goal => normalizeGoalForStats(goal, { completed: false })),
      ...completedStatGoals,
    ],
    [goals, completedStatGoals]
  )

  const rangeBounds = useMemo(() => getRangeBounds(range, statGoals), [range, statGoals])
  const rangeCaption = useMemo(() => getRangeCaption(range, rangeBounds), [range, rangeBounds])
  const microProgress = useMemo(
    () => getMicroProgressForScopedGoals(statGoals, rangeBounds),
    [rangeBounds, statGoals]
  )

  const activityView = useMemo(
    () => (range === 'all' ? 'month' : range === 'year' ? 'week' : 'day'),
    [range]
  )

  const activityEntries = useMemo(
    () => buildActivityEntries(statGoals, rangeBounds, activityView),
    [activityView, rangeBounds, statGoals]
  )

  const maxActivityCount = useMemo(
    () => activityEntries.reduce((max, item) => Math.max(max, item.count), 0),
    [activityEntries]
  )

  const activityScale = useMemo(() => {
    const top = Math.max(3, maxActivityCount)
    return Array.from({ length: top + 1 }, (_, index) => top - index)
  }, [maxActivityCount])

  const defaultActivityKey = useMemo(() => {
    if (activityEntries.length === 0) return ''
    return (
      [...activityEntries].reverse().find(item => item.count > 0)?.key ||
      activityEntries[activityEntries.length - 1]?.key ||
      ''
    )
  }, [activityEntries])

  const activeActivityKey = useMemo(() => {
    if (activityEntries.some(item => item.key === activityKeyPreference)) {
      return activityKeyPreference
    }
    return defaultActivityKey
  }, [activityEntries, activityKeyPreference, defaultActivityKey])

  const activeActivityEntry = useMemo(
    () => activityEntries.find(item => item.key === activeActivityKey) || null,
    [activityEntries, activeActivityKey]
  )

  const hasActivity = activityEntries.some(item => item.count > 0)
  const activityTitle =
    activityView === 'month'
      ? 'Активность по месяцам'
      : activityView === 'week'
        ? 'Активность по неделям'
        : 'Активность по дням'

  const activityChartStyle = {
    '--activity-columns': String(Math.max(activityEntries.length, 1)),
    '--activity-gap':
      activityView === 'month'
        ? '12px'
        : activityEntries.length > 20
          ? '6px'
          : '8px',
    '--activity-bar-width':
      activityView === 'month'
        ? '16px'
        : activityEntries.length > 20
          ? '9px'
          : '11px',
  }

  return (
    <section className="screen screen--journal journal-screen stats-screen">
      <header className="screen-header stats-screen-header">
        <div className="screen-header-copy">
          <h1>Статистика</h1>
          <p className="secondary-text stats-screen-copy">
            Микрошаги, прогресс и завершённые цели
          </p>
        </div>
        {typeof onResetProgress === 'function' ? (
          <button
            type="button"
            className="text-button stats-reset-button"
            onClick={onResetProgress}
          >
            Сбросить весь прогресс
          </button>
        ) : null}
      </header>

      <div className="stats-toolbar">
        <div className="stats-filter-row" role="tablist" aria-label="Период статистики">
          {RANGE_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={`stats-filter-chip ${range === option.id ? 'stats-filter-chip--active' : ''}`}
              onClick={() => setRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="stats-range-row stats-range-row--desktop">
          <div className="stats-range-pill">
            <span className="stats-range-pill-icon" aria-hidden="true">
              <CalendarBlank size={16} weight="regular" />
            </span>
            <span>{rangeCaption}</span>
            <CaretRight size={16} weight="bold" aria-hidden />
          </div>
        </div>
      </div>

      <div className="stats-overview-grid">
        <article className="card stats-card stats-card--progress">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Прогресс</h2>
          </div>
          <div className="stats-progress-block">
            <div className="stats-progress-ring" style={{ '--progress': `${microProgress.percent}%` }}>
              <div className="stats-progress-ring-center">
                <span className="type-accent-number">{microProgress.percent}%</span>
              </div>
            </div>
            <div className="stats-progress-text">
              <strong>
                {microProgress.completed} из {microProgress.total}
              </strong>
              <small>микрошагов в целях периода</small>
            </div>
          </div>
        </article>

        <CompletedGoalsPreview
          goals={completedGoals}
          onOpenAll={onOpenCompletedGoals}
          className="stats-card stats-card--completed"
        />
      </div>

      <article className="card stats-panel stats-panel--activity stats-panel--simple">
        <div className="stats-card-head stats-card-head--activity">
          <h2 className="stats-card-title">{activityTitle}</h2>
        </div>

        {!hasActivity ? (
          <div className="stats-empty-block">
            <strong>Пока нет активности</strong>
            <p className="secondary-text">Когда вы начнёте завершать микрошаги, здесь появится график.</p>
          </div>
        ) : (
          <div className="stats-activity-chart stats-activity-chart--full">
            <div className="stats-activity-plot">
              <div className="stats-activity-axis" aria-hidden="true">
                {activityScale.map(value => (
                  <span key={value}>{value}</span>
                ))}
              </div>

              <div className="stats-activity-bars-shell">
                {activityScale
                  .filter(value => value > 0)
                  .map(value => (
                    <span
                      key={value}
                      className="stats-activity-gridline"
                      style={{ bottom: `${(value / activityScale[0]) * 100}%` }}
                      aria-hidden="true"
                    />
                  ))}

                <div
                  className={`stats-activity-bars stats-activity-bars--${activityView}`}
                  style={activityChartStyle}
                >
                  {activityEntries.map(item => {
                    const selected = item.key === activeActivityEntry?.key
                    const height =
                      item.count > 0
                        ? `${Math.max(18, (item.count / activityScale[0]) * 186)}px`
                        : '10px'

                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`stats-activity-day ${selected ? 'stats-activity-day--selected' : ''} stats-activity-day--${activityView} ${item.count === 0 ? 'stats-activity-day--empty' : ''}`}
                        onMouseEnter={() => setActivityKeyPreference(item.key)}
                        onFocus={() => setActivityKeyPreference(item.key)}
                        onClick={() => setActivityKeyPreference(item.key)}
                        aria-pressed={selected}
                      >
                        <div className="stats-activity-bar-wrap">
                          {selected ? (
                            <span className="stats-activity-tooltip">
                              <span>{item.heading}</span>
                              <strong>{formatStepCount(item.count)}</strong>
                            </span>
                          ) : null}
                          <span
                            className={`stats-activity-bar ${item.count === 0 ? 'stats-activity-bar--empty' : ''}`}
                            style={{ height }}
                            aria-hidden="true"
                          />
                        </div>
                        <span className="stats-activity-label">
                          <span className="stats-activity-date">{item.showLabel ? item.label : ''}</span>
                          {item.subLabel ? (
                            <span className="stats-activity-subdate">{item.showLabel ? item.subLabel : ''}</span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="stats-activity-footer">
          <div className="stats-range-pill stats-range-pill--mobile">
            <span className="stats-range-pill-icon" aria-hidden="true">
              <CalendarBlank size={16} weight="regular" />
            </span>
            <span>{rangeCaption}</span>
            <CaretRight size={16} weight="bold" aria-hidden />
          </div>
        </div>
      </article>
    </section>
  )
}

export default Analytics
