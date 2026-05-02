import { useEffect, useMemo, useState } from 'react'
import { CalendarBlank } from '@phosphor-icons/react'
import {
  countDaysInclusive,
  filterGoals,
  generateInsights,
  getAvgMicroPerDayInBounds,
  getBestWeekdayMicroFromGoals,
  getMicroBarPercent,
  getMicroProgressForScopedGoals,
  getMicroStreakDays,
  getMicroStepActivityDateKey,
  getRecentCompleted,
  normalizeGoalForStats,
} from '../utils/statistics'

const RANGE_OPTIONS = [
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Все время' },
]

const DOW_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ']
const INSIGHT_ICONS = ['↗', '▥', '🔥']

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

function formatChartLabel(key) {
  const date = new Date(`${key}T12:00:00`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\./g, '')
}

function formatTimeLabel(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return 'Без времени'
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatStepCount(count) {
  return `${count} ${pluralize(count, ['шаг', 'шага', 'шагов'])}`
}

function formatMicroCount(count) {
  return `${count} ${pluralize(count, ['микрошаг', 'микрошага', 'микрошагов'])}`
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

function toLocalDateKey(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

function buildLastWeekStrip(now, completionKeys) {
  const end = startOfDay(now)
  if (!end) return []
  const set = completionKeys instanceof Set ? completionKeys : new Set(completionKeys)
  const out = []

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(end)
    d.setDate(d.getDate() - i)
    const key = toLocalDateKey(d)
    out.push({
      key,
      label: DOW_SHORT[d.getDay()],
      on: set.has(key),
    })
  }

  return out
}

function buildDailyActivityMap(goals, bounds) {
  const map = Object.create(null)
  const from = bounds?.start ? toLocalDateKey(bounds.start) : ''
  const to = bounds?.end ? toLocalDateKey(bounds.end) : ''

  for (const goal of goals) {
    for (const step of goal.steps || []) {
      if (!step.completed) continue
      const dateKey = getMicroStepActivityDateKey(step)
      if (!dateKey) continue
      if (from && to && (dateKey < from || dateKey > to)) continue

      if (!map[dateKey]) {
        map[dateKey] = { count: 0, details: [] }
      }

      const exactTime = String(step.completedAt || '').trim()
      const timeSort = exactTime
        ? new Date(exactTime).getTime()
        : new Date(`${dateKey}T23:59:59`).getTime()

      map[dateKey].count += 1
      map[dateKey].details.push({
        id: `${goal.id}-${step.id}-${dateKey}`,
        title: step.title,
        goalTitle: goal.title,
        timeLabel: exactTime ? formatTimeLabel(exactTime) : 'Без времени',
        timeSort,
      })
    }
  }

  return map
}

function Analytics({ goals, completedGoals, onClearHistory }) {
  const [range, setRange] = useState('month')
  const [selectedActivityDate, setSelectedActivityDate] = useState('')

  const statGoals = useMemo(
    () => [
      ...goals.map(goal => normalizeGoalForStats(goal, { completed: false })),
      ...completedGoals.map(goal => normalizeGoalForStats(goal, { completed: true })),
    ],
    [goals, completedGoals]
  )

  const filteredGoals = useMemo(() => filterGoals(statGoals, range), [statGoals, range])
  const rangeBounds = useMemo(() => getRangeBounds(range, statGoals), [range, statGoals])
  const rangeCaption = useMemo(() => getRangeCaption(range, rangeBounds), [range, rangeBounds])

  const microProgress = useMemo(
    () => getMicroProgressForScopedGoals(statGoals, rangeBounds),
    [rangeBounds, statGoals]
  )

  const completionKeysForStrip = useMemo(() => {
    const keys = new Set()
    for (const goal of statGoals) {
      for (const step of goal.steps || []) {
        if (!step.completed) continue
        const key = getMicroStepActivityDateKey(step)
        if (key) keys.add(key)
      }
    }
    return keys
  }, [statGoals])

  const microStreak = useMemo(() => getMicroStreakDays(statGoals), [statGoals])
  const weekStrip = useMemo(
    () => buildLastWeekStrip(new Date(), completionKeysForStrip),
    [completionKeysForStrip]
  )

  const dailyActivityMap = useMemo(
    () => buildDailyActivityMap(statGoals, rangeBounds),
    [rangeBounds, statGoals]
  )

  const dailyEntries = useMemo(() => {
    const keys = getRangeDates(rangeBounds)
    if (keys.length > 0) {
      return keys.map(date => ({
        date,
        count: Number(dailyActivityMap[date]?.count || 0),
        details: dailyActivityMap[date]?.details || [],
        label: formatChartLabel(date),
        heading: formatActivityHeading(date),
      }))
    }

    return Object.keys(dailyActivityMap)
      .sort()
      .map(date => ({
        date,
        count: dailyActivityMap[date].count,
        details: dailyActivityMap[date].details,
        label: formatChartLabel(date),
        heading: formatActivityHeading(date),
      }))
  }, [dailyActivityMap, rangeBounds])

  const maxMicroDay = useMemo(
    () => dailyEntries.reduce((max, item) => Math.max(max, item.count), 0),
    [dailyEntries]
  )

  const avgMicro = useMemo(
    () => getAvgMicroPerDayInBounds(statGoals, rangeBounds),
    [rangeBounds, statGoals]
  )

  const barPct = useMemo(() => getMicroBarPercent(avgMicro, maxMicroDay), [avgMicro, maxMicroDay])
  const recentCompleted = useMemo(() => getRecentCompleted(filteredGoals), [filteredGoals])
  const bestMicroDay = useMemo(
    () => getBestWeekdayMicroFromGoals(statGoals, rangeBounds),
    [rangeBounds, statGoals]
  )

  const insights = useMemo(
    () =>
      generateInsights({
        bestMicroDay,
        avgMicro,
        microStreak,
        microProgress,
      }).slice(0, 3),
    [avgMicro, bestMicroDay, microProgress, microStreak]
  )

  useEffect(() => {
    if (dailyEntries.length === 0) {
      if (selectedActivityDate) setSelectedActivityDate('')
      return
    }

    const hasSelected = dailyEntries.some(item => item.date === selectedActivityDate)
    if (hasSelected) return

    const preferred = [...dailyEntries].reverse().find(item => item.count > 0) || dailyEntries[dailyEntries.length - 1]
    if (preferred?.date) setSelectedActivityDate(preferred.date)
  }, [dailyEntries, selectedActivityDate])

  const selectedActivityEntry = useMemo(
    () =>
      dailyEntries.find(item => item.date === selectedActivityDate) ||
      dailyEntries[dailyEntries.length - 1] ||
      null,
    [dailyEntries, selectedActivityDate]
  )

  const selectedActivityDetails = useMemo(
    () =>
      [...(selectedActivityEntry?.details || [])].sort((a, b) => {
        if (a.timeSort !== b.timeSort) return a.timeSort - b.timeSort
        return String(a.title || '').localeCompare(String(b.title || ''), 'ru')
      }),
    [selectedActivityEntry]
  )

  const activityScale = useMemo(() => {
    const top = Math.max(3, maxMicroDay)
    return Array.from({ length: top + 1 }, (_, index) => top - index)
  }, [maxMicroDay])

  const latestCompletedGoal = recentCompleted[0] || null
  const latestCompletedCount = latestCompletedGoal
    ? (latestCompletedGoal.steps || []).filter(step => step.completed).length
    : 0
  const latestCompletedTotal = latestCompletedGoal?.steps?.length || 0

  const hasDailyData = dailyEntries.some(item => item.count > 0)
  const hasAnyGoals = statGoals.length > 0
  const daysInRange = countDaysInclusive(rangeBounds)
  const avgLabel = daysInRange > 0 ? `${avgMicro.toFixed(1).replace('.', ',')} за день` : '—'
  const rangeLabel = RANGE_OPTIONS.find(option => option.id === range)?.label || 'Все дни'

  return (
    <section className="screen screen--journal journal-screen stats-screen">
      <header className="screen-header stats-screen-header">
        <div>
          <h1>Статистика выполнения целей</h1>
          <p className="secondary-text stats-screen-copy">
            Микрошаги и прогресс по выбранному периоду
          </p>
        </div>
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

        <div className="stats-range-row">
          <span className="stats-range-pill">
            <span className="stats-range-pill-icon" aria-hidden="true">
              <CalendarBlank size={16} weight="regular" />
            </span>
            {rangeCaption}
          </span>
        </div>
      </div>

      <div className="stats-summary-grid">
        <article className="card stats-card stats-card--progress">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Общий прогресс</h2>
          </div>
          <div className="stats-progress-block">
            <div className="stats-progress-ring" style={{ '--progress': `${microProgress.percent}%` }}>
              <div className="stats-progress-ring-center">
                <span className="type-accent-number">{microProgress.percent}%</span>
              </div>
            </div>
            <div className="stats-progress-text">
              <span className="secondary-text">Выполнено</span>
              <strong>
                {microProgress.completed} из {microProgress.total}
              </strong>
              <small>{formatMicroCount(microProgress.total)} в целях периода</small>
            </div>
          </div>
        </article>

        <article className="card stats-card">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Серия дней</h2>
          </div>
          <div className="stats-streak-main">
            <span className="stats-big-number">{microStreak}</span>
            <span className="secondary-text stats-streak-suffix">
              {microStreak > 0 ? 'день подряд' : 'пока без серии'}
            </span>
          </div>
          <div className="stats-streak-week" aria-hidden="true">
            {weekStrip.map(day => (
              <div key={day.key} className="stats-streak-day">
                <span className={`stats-streak-dot ${day.on ? 'stats-streak-dot--on' : ''}`} />
                <span className="stats-streak-dow">{day.label}</span>
              </div>
            ))}
          </div>
          <p className="secondary-text stats-card-foot">
            День засчитывается, если отмечен микрошаг и есть дата выполнения или рекомендованная дата.
          </p>
        </article>

        <article className="card stats-card">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Средний прогресс</h2>
          </div>
          <div className="stats-avg-head">
            <span className="type-accent-number stats-avg-pct">{barPct}%</span>
            <p className="secondary-text stats-avg-sub">к лучшему дню в периоде</p>
          </div>
          <div className="stats-avg-bar" aria-hidden="true">
            <span style={{ width: `${barPct}%` }} />
          </div>
          <p className="secondary-text stats-card-foot">
            {maxMicroDay > 0
              ? `${avgLabel} · лучший день: ${maxMicroDay} ${pluralize(maxMicroDay, ['микрошаг', 'микрошага', 'микрошагов'])}.`
              : 'Завершите микрошаги — появится сравнение с лучшим днём.'}
          </p>
        </article>
      </div>

      <article className="card stats-panel stats-panel--activity">
        <div className="stats-card-head">
          <h2 className="stats-card-title">Активность</h2>
        </div>

        {!hasDailyData ? (
          <p className="secondary-text stats-empty-text">
            Здесь появится активность, когда вы начнёте отмечать микрошаги выполненными.
          </p>
        ) : (
          <div className="stats-activity-layout">
            <div className="stats-activity-chart">
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

                  <div className="stats-activity-bars">
                    {dailyEntries.map(item => {
                      const selected = item.date === selectedActivityEntry?.date
                      const height = item.count > 0 ? `${(item.count / activityScale[0]) * 100}%` : '16px'

                      return (
                        <button
                          key={item.date}
                          type="button"
                          className={`stats-activity-day ${selected ? 'stats-activity-day--selected' : ''}`}
                          onClick={() => setSelectedActivityDate(item.date)}
                        >
                          <div className="stats-activity-bar-wrap">
                            {selected && item.count > 0 && (
                              <span className="stats-activity-count-badge">{formatStepCount(item.count)}</span>
                            )}
                            <span
                              className={`stats-activity-bar ${item.count === 0 ? 'stats-activity-bar--empty' : ''}`}
                              style={{ height }}
                              aria-hidden="true"
                            />
                          </div>
                          <span className="stats-activity-date">{item.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>

            <aside className="stats-activity-detail">
              <div className="stats-activity-detail-head">
                <h3>
                  {selectedActivityEntry
                    ? `${selectedActivityEntry.heading} · ${formatStepCount(selectedActivityEntry.count)}`
                    : 'Нет активности'}
                </h3>
                <span className="stats-detail-pill">{rangeLabel}</span>
              </div>

              {selectedActivityDetails.length === 0 ? (
                <p className="secondary-text stats-empty-text">
                  За выбранный день пока нет завершённых шагов.
                </p>
              ) : (
                <div className="stats-activity-detail-list">
                  {selectedActivityDetails.map(item => (
                    <div key={item.id} className="stats-activity-detail-row">
                      <span className="stats-activity-detail-check" aria-hidden="true">
                        ✓
                      </span>
                      <div className="stats-activity-detail-main">
                        <strong>{item.title}</strong>
                        <span className="stats-activity-detail-meta">{item.goalTitle}</span>
                      </div>
                      <span className="stats-activity-detail-time">{item.timeLabel}</span>
                    </div>
                  ))}
                </div>
              )}
            </aside>
          </div>
        )}
      </article>

      <div className="stats-bottom-grid">
        <article className="card stats-panel stats-panel--latest">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Последние выполненные цели</h2>
          </div>

          {!latestCompletedGoal ? (
            <p className="secondary-text stats-empty-text">
              В выбранном периоде пока нет завершённых целей целиком.
            </p>
          ) : (
            <>
              <div className="stats-feature-goal">
                <span className="stats-feature-icon" aria-hidden="true">
                  📘
                </span>
                <div className="stats-feature-main">
                  <strong>{latestCompletedGoal.title}</strong>
                  <p className="secondary-text">
                    {latestCompletedCount} из {latestCompletedTotal} микрошагов · Завершено{' '}
                    {formatDashboardDate(latestCompletedGoal.completedAt)}
                  </p>
                </div>
                <span className="stats-feature-cta">Открыть журнал</span>
              </div>

              <span className="stats-view-link">Смотреть все завершённые цели</span>
            </>
          )}

          {typeof onClearHistory === 'function' && hasAnyGoals && (
            <button type="button" className="text-button stats-reset-button" onClick={onClearHistory}>
              Сбросить все данные
            </button>
          )}
        </article>

        <article className="card stats-panel">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Выводы и инсайты</h2>
          </div>

          <div className="stats-insights-list">
            {insights.map((text, index) => (
              <div key={`${index}-${text.slice(0, 24)}`} className="stats-insight-row">
                <span className={`stats-insight-icon stats-insight-icon--${index}`} aria-hidden="true">
                  {INSIGHT_ICONS[index] || '•'}
                </span>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  )
}

export default Analytics
