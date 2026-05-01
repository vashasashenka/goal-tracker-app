import { useMemo, useState } from 'react'
import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import {
  countDaysInclusive,
  filterGoals,
  generateInsights,
  getAvgMicroPerDayInBounds,
  getBestWeekdayMicroFromGoals,
  getMaxMicroCompletionsPerDayInBounds,
  getMicroBarPercent,
  getMicroDailyDetailMap,
  getMicroDeltaPercentVersusPreviousPeriod,
  getMicroProgressForScopedGoals,
  getMicroStreakDays,
  getMicroStepActivityDateKey,
  getRecentCompleted,
  normalizeGoalForStats,
} from '../utils/statistics'

ChartJS.register(Tooltip, Legend, CategoryScale, LinearScale, BarElement)
ChartJS.defaults.font.family = "'Inter', system-ui, sans-serif"

const RANGE_OPTIONS = [
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Все время' },
]

const DOW_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

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

function formatChartLabel(key) {
  const date = new Date(`${key}T12:00:00`)
  if (Number.isNaN(date.getTime())) return key
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\./g, '')
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

  const timestamps = goals
    .map(goal => new Date(goal.completedAt || goal.createdAt).getTime())
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b)

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
    const key = cursor.toISOString().slice(0, 10)
    dates.push(key)
    cursor.setDate(cursor.getDate() + 1)
    guard += 1
  }
  return dates
}

function formatMonthBucketLabel(ym) {
  const [y, m] = ym.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym
  const d = new Date(y, m - 1, 1)
  return d
    .toLocaleDateString('ru-RU', {
      month: 'short',
      year: d.getFullYear() !== new Date().getFullYear() ? '2-digit' : undefined,
    })
    .replace(/\s?г\.$/, '')
    .replace(/\./g, '')
}

function bucketEntriesByMonth(entries) {
  const map = new Map()
  for (const item of entries) {
    const ym = String(item.date || '').slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(ym)) continue
    const prev = map.get(ym) || { count: 0, steps: [] }
    prev.count += Number(item.count) || 0
    prev.steps.push(...(item.steps || []))
    map.set(ym, prev)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, bucket]) => ({
      date: `${ym}-01`,
      count: bucket.count,
      steps: bucket.steps,
      label: formatMonthBucketLabel(ym),
    }))
}

function getCompactChartEntries(dailyEntries) {
  if (!dailyEntries.length) return []
  if (dailyEntries.length <= 31) return dailyEntries
  return bucketEntriesByMonth(dailyEntries)
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
    const dow = d.getDay()
    out.push({
      key,
      label: DOW_SHORT[dow],
      on: set.has(key),
    })
  }
  return out
}

function Analytics({ goals, completedGoals, onClearHistory }) {
  const [range, setRange] = useState('month')

  const statGoals = useMemo(
    () => [
      ...goals.map(goal => normalizeGoalForStats(goal, { completed: false })),
      ...completedGoals.map(goal => normalizeGoalForStats(goal, { completed: true })),
    ],
    [goals, completedGoals]
  )

  const filteredGoals = useMemo(() => filterGoals(statGoals, range), [statGoals, range])
  const rangeBounds = useMemo(() => getRangeBounds(range, statGoals), [statGoals, range])
  const rangeCaption = useMemo(() => getRangeCaption(range, rangeBounds), [range, rangeBounds])

  const microDaily = useMemo(
    () => getMicroDailyDetailMap(statGoals, rangeBounds),
    [statGoals, rangeBounds]
  )

  const microProgress = useMemo(
    () => getMicroProgressForScopedGoals(statGoals, rangeBounds),
    [statGoals, rangeBounds]
  )

  const microStreak = useMemo(() => getMicroStreakDays(statGoals), [statGoals])

  const avgMicro = useMemo(() => getAvgMicroPerDayInBounds(statGoals, rangeBounds), [statGoals, rangeBounds])
  const maxMicroDay = useMemo(
    () => getMaxMicroCompletionsPerDayInBounds(statGoals, rangeBounds),
    [statGoals, rangeBounds]
  )
  const barPct = useMemo(() => getMicroBarPercent(avgMicro, maxMicroDay), [avgMicro, maxMicroDay])

  const deltaPercent = useMemo(
    () =>
      range !== 'all' && rangeBounds?.start && rangeBounds?.end
        ? getMicroDeltaPercentVersusPreviousPeriod(statGoals, rangeBounds)
        : null,
    [range, rangeBounds, statGoals]
  )

  const recentCompleted = useMemo(() => getRecentCompleted(filteredGoals), [filteredGoals])
  const bestMicroDay = useMemo(
    () => getBestWeekdayMicroFromGoals(statGoals, rangeBounds),
    [statGoals, rangeBounds]
  )

  const completionKeysForStrip = useMemo(() => {
    const s = new Set()
    for (const g of statGoals) {
      const steps = g.steps || []
      for (const step of steps) {
        if (!step.completed) continue
        const k = getMicroStepActivityDateKey(step)
        if (k) s.add(k)
      }
    }
    return s
  }, [statGoals])

  const weekStrip = useMemo(() => buildLastWeekStrip(new Date(), completionKeysForStrip), [completionKeysForStrip])

  const insights = useMemo(
    () =>
      generateInsights({
        bestMicroDay,
        avgMicro,
        microStreak,
        microProgress,
      }),
    [avgMicro, bestMicroDay, microProgress, microStreak]
  )

  const dailyEntries = useMemo(() => {
    const keys = getRangeDates(rangeBounds)
    if (keys.length > 0) {
      return keys.map(date => ({
        date,
        count: Number(microDaily[date]?.count || 0),
        steps: microDaily[date]?.steps || [],
        label: formatChartLabel(date),
      }))
    }
    return Object.keys(microDaily)
      .sort()
      .map(date => ({
        date,
        count: microDaily[date].count,
        steps: microDaily[date].steps,
        label: formatChartLabel(date),
      }))
  }, [microDaily, rangeBounds])

  const chartEntries = useMemo(() => getCompactChartEntries(dailyEntries), [dailyEntries])

  const dailyChartData = useMemo(
    () => ({
      labels: chartEntries.map(item => item.label),
      datasets: [
        {
          label: 'Микрошаги',
          data: chartEntries.map(item => item.count),
          backgroundColor: '#3d6df2',
          borderRadius: 10,
          borderSkipped: false,
          maxBarThickness: chartEntries.length <= 14 ? 22 : 14,
        },
      ],
    }),
    [chartEntries]
  )

  const dailyChartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: items => (items[0] ? items[0].label : ''),
            label: item => {
              const n = item.parsed.y
              if (!Number.isFinite(n) || n <= 0) return 'Нет завершённых микрошагов за этот день'
              return `Микрошагов: ${n}`
            },
            afterBody: items => {
              const idx = items[0]?.dataIndex
              if (idx == null) return []
              const steps = chartEntries[idx]?.steps || []
              if (!steps.length) return []
              const max = 12
              const lines = steps.slice(0, max).map(t => `· ${t}`)
              if (steps.length > max) lines.push(`… и ещё ${steps.length - max}`)
              return lines
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#727887',
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            font: { size: 10 },
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            precision: 0,
            color: '#727887',
            maxTicksLimit: 5,
            font: { size: 10 },
          },
          grid: {
            color: 'rgba(23, 33, 61, 0.06)',
          },
        },
      },
    }),
    [chartEntries]
  )

  const hasDailyData = chartEntries.some(e => e.count > 0)
  const hasAnyGoals = statGoals.length > 0
  const daysInRange = countDaysInclusive(rangeBounds)
  const avgLabel =
    daysInRange > 0 ? `${avgMicro.toFixed(1).replace('.', ',')} за день` : '—'

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
        <span className="stats-range-pill">{rangeCaption}</span>
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
              <small>микрошагов в целях периода</small>
            </div>
          </div>
          {range !== 'all' && deltaPercent != null && (
            <div className="stats-card-footer">
              <p className={`stats-card-delta ${deltaPercent >= 0 ? 'stats-card-delta--up' : 'stats-card-delta--down'}`}>
                {deltaPercent >= 0 ? '+' : ''}
                {deltaPercent}% микрошагов к прошлому такому же периоду
              </p>
            </div>
          )}
        </article>

        <article className="card stats-card">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Серия дней</h2>
          </div>
          <div className="stats-streak-main">
            <span className="stats-big-number">{microStreak}</span>
            <span className="secondary-text stats-streak-suffix">
              {microStreak > 0 ? 'дней подряд' : 'пока без серии'}
            </span>
          </div>
          <div className="stats-streak-week" aria-hidden="true">
            {weekStrip.map(d => (
              <div key={d.key} className="stats-streak-day">
                <span className={`stats-streak-dot ${d.on ? 'stats-streak-dot--on' : ''}`} />
                <span className="stats-streak-dow">{d.label}</span>
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
              ? `${avgLabel} · лучший день: ${maxMicroDay} микрошаг.`
              : 'Завершите микрошаги — появится сравнение с лучшим днём.'}
          </p>
        </article>
      </div>

      <article className="card stats-panel stats-panel--wide stats-panel--activity">
        <div className="stats-card-head stats-card-head--toolbar">
          <h2 className="stats-card-title">Активность</h2>
          <span className="stats-chart-metric-pill">Завершённые микрошаги по дням</span>
        </div>
        {!hasDailyData ? (
          <p className="secondary-text stats-empty-text">
            Здесь появятся столбцы, когда есть завершённые микрошаги с датой выполнения или с выбранной
            рекомендованной датой. Наведите на столбец — список шагов.
          </p>
        ) : (
          <div className="stats-chart-wrap">
            <Bar data={dailyChartData} options={dailyChartOptions} />
          </div>
        )}
      </article>

      <div className="stats-bottom-grid">
        <article className="card stats-panel">
          <div className="stats-card-head">
            <h2 className="stats-card-title">Последние выполненные цели</h2>
          </div>
          {recentCompleted.length === 0 ? (
            <p className="secondary-text stats-empty-text">
              В выбранном периоде пока нет завершённых целей целиком.
            </p>
          ) : (
            <div className="stats-recent-list">
              {recentCompleted.map(goal => (
                <div key={goal.id} className="stats-recent-row">
                  <div className="stats-recent-main">
                    <strong>{goal.title}</strong>
                  </div>
                  <span className="stats-recent-date">{formatDashboardDate(goal.completedAt)}</span>
                </div>
              ))}
            </div>
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
          <p className="secondary-text stats-insights-source">
            Короткие выводы считаются в приложении из ваших целей и микрошагов, без отдельной базы только для
            текстов.
          </p>
          <div className="stats-insights-list">
            {insights.map((text, i) => (
              <div key={`${i}-${text.slice(0, 24)}`} className="stats-insight-row">
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
