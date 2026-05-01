import { useMemo, useState } from 'react'
import {
  CalendarBlank,
  ChartBar,
  Check,
  Flame,
  Lightbulb,
  Star,
  Tag,
  Target,
  TrendUp,
} from '@phosphor-icons/react'
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
} from 'chart.js'
import { Bar, Doughnut } from 'react-chartjs-2'
import {
  filterGoals,
  formatDaysLabel,
  formatGoalsPerDayLabel,
  generateInsights,
  getAveragePerDay,
  getBestDay,
  getCategoryStats,
  getDailyStats,
  getProgress,
  getRecentCompleted,
  getStreak,
  normalizeGoalForStats,
} from '../utils/statistics'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

const RANGE_OPTIONS = [
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Все время' },
]

const CATEGORY_COLORS = {
  Учёба: '#3d6df2',
  Работа: '#8a5cf6',
  Личное: '#f6be4f',
  Другое: '#57b26a',
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

/** Компактный график: до ~31 столбца по дням, иначе сумма по месяцам (как на референсе). */
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
    map.set(ym, (map.get(ym) || 0) + (Number(item.count) || 0))
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, count]) => ({
      date: `${ym}-01`,
      count,
      label: formatMonthBucketLabel(ym),
    }))
}

function getCompactChartEntries(dailyEntries) {
  if (!dailyEntries.length) return []
  if (dailyEntries.length <= 31) return dailyEntries
  return bucketEntriesByMonth(dailyEntries)
}

const INSIGHT_ICON_COMPONENTS = [TrendUp, Star, Target, Flame]

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
  const progress = useMemo(() => getProgress(filteredGoals), [filteredGoals])
  const streak = useMemo(() => getStreak(filteredGoals), [filteredGoals])
  const dailyStats = useMemo(() => getDailyStats(filteredGoals), [filteredGoals])
  const categoryStats = useMemo(() => getCategoryStats(filteredGoals), [filteredGoals])
  const recentCompleted = useMemo(() => getRecentCompleted(filteredGoals), [filteredGoals])
  const bestDay = useMemo(() => getBestDay(filteredGoals), [filteredGoals])
  const averagePerDay = useMemo(() => getAveragePerDay(filteredGoals), [filteredGoals])

  const insights = useMemo(
    () =>
      generateInsights({
        bestDay,
        avg: averagePerDay,
        streak,
        progress,
      }),
    [averagePerDay, bestDay, progress, streak]
  )

  const rangeBounds = useMemo(() => getRangeBounds(range, filteredGoals), [filteredGoals, range])
  const rangeCaption = useMemo(() => getRangeCaption(range, rangeBounds), [range, rangeBounds])

  const dailyEntries = useMemo(
    () => {
      const keys = getRangeDates(rangeBounds)
      if (keys.length > 0) {
        return keys.map(date => ({
          date,
          count: Number(dailyStats[date] || 0),
          label: formatChartLabel(date),
        }))
      }
      return Object.entries(dailyStats)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({
          date,
          count,
          label: formatChartLabel(date),
        }))
    },
    [dailyStats, rangeBounds]
  )

  const chartEntries = useMemo(() => getCompactChartEntries(dailyEntries), [dailyEntries])

  const dailyChartData = useMemo(
    () => ({
      labels: chartEntries.map(item => item.label),
      datasets: [
        {
          label: 'Завершённые цели',
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
            label: context => `${context.parsed.y} завершено`,
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
    []
  )

  const categoryChartData = useMemo(
    () => ({
      labels: categoryStats.map(item => item.category),
      datasets: [
        {
          data: categoryStats.map(item => item.count),
          backgroundColor: categoryStats.map(item => CATEGORY_COLORS[item.category]),
          borderWidth: 0,
          hoverOffset: 6,
        },
      ],
    }),
    [categoryStats]
  )

  const categoryChartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: context => {
              const percent = categoryStats[context.dataIndex]?.percent ?? 0
              return `${context.label}: ${context.parsed} (${percent}%)`
            },
          },
        },
      },
    }),
    [categoryStats]
  )

  const hasDailyData = chartEntries.length > 0
  const hasCategoryData = categoryStats.some(item => item.count > 0)
  const hasAnyGoals = statGoals.length > 0

  return (
    <section className="screen screen--journal journal-screen stats-screen">
      <header className="screen-header stats-screen-header">
        <div>
          <h1>Статистика выполнения целей</h1>
          <p className="secondary-text stats-screen-copy">
            Анализируйте свой прогресс и достигайте большего
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
        <span className="stats-range-pill">
          <span className="stats-range-pill-icon" aria-hidden="true">
            <CalendarBlank size={16} weight="regular" />
          </span>
          {rangeCaption}
        </span>
      </div>

      <div className="stats-summary-grid">
        <article className="card stats-card stats-card--progress">
          <div className="stats-card-head">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <Target size={16} weight="regular" />
              </span>
              Общий прогресс
            </h2>
          </div>
          <div className="stats-progress-block">
            <div className="stats-progress-ring" style={{ '--progress': `${progress.percent}%` }}>
              <div className="stats-progress-ring-center">
                <span className="type-accent-number">{progress.percent}%</span>
              </div>
            </div>
            <div className="stats-progress-text">
              <span className="secondary-text">Выполнено</span>
              <strong>
                {progress.completed} из {progress.total}
              </strong>
              <small>целей</small>
            </div>
          </div>
        </article>

        <article className="card stats-card">
          <div className="stats-card-head">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <Flame size={16} weight="regular" />
              </span>
              Серия дней
            </h2>
          </div>
          <div className="stats-big-number">{streak}</div>
          <p className="secondary-text stats-card-foot">
            {streak > 0 ? `${formatDaysLabel(streak)} подряд` : 'Пока нет активной серии'}
          </p>
        </article>

        <article className="card stats-card">
          <div className="stats-card-head">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <ChartBar size={16} weight="regular" />
              </span>
              Средняя активность
            </h2>
          </div>
          <div className="stats-big-number">{averagePerDay}</div>
          <p className="secondary-text stats-card-foot">
            {averagePerDay > 0 ? formatGoalsPerDayLabel(averagePerDay) : 'Нет завершений для расчёта'}
          </p>
        </article>
      </div>

      <div className="stats-main-grid">
        <article className="card stats-panel stats-panel--wide">
          <div className="stats-card-head stats-card-head--toolbar">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <CalendarBlank size={16} weight="regular" />
              </span>
              Активность по дням
            </h2>
            <span className="stats-chart-metric-pill">Завершённые цели</span>
          </div>
          {!hasDailyData ? (
            <p className="secondary-text stats-empty-text">
              Когда появятся завершённые цели, здесь сформируется график активности по дням.
            </p>
          ) : (
            <div className="stats-chart-wrap">
              <Bar data={dailyChartData} options={dailyChartOptions} />
            </div>
          )}
        </article>

        <article className="card stats-panel">
          <div className="stats-card-head">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <Tag size={16} weight="regular" />
              </span>
              Категории целей
            </h2>
          </div>
          {!hasCategoryData ? (
            <p className="secondary-text stats-empty-text">
              Пока нет целей в выбранном периоде, поэтому круговая диаграмма ещё пустая.
            </p>
          ) : (
            <div className="stats-category-layout">
              <div className="stats-category-chart">
                <Doughnut data={categoryChartData} options={categoryChartOptions} />
              </div>
              <div className="stats-category-legend">
                {categoryStats.map(item => (
                  <div key={item.category} className="stats-category-row">
                    <span className="stats-category-meta">
                      <span
                        className="stats-category-dot"
                        style={{ backgroundColor: CATEGORY_COLORS[item.category] }}
                      />
                      {item.category}
                    </span>
                    <strong>{item.percent}%</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>
      </div>

      <div className="stats-bottom-grid">
        <article className="card stats-panel">
          <div className="stats-card-head">
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <Check size={16} weight="bold" />
              </span>
              Последние выполненные
            </h2>
          </div>
          {recentCompleted.length === 0 ? (
            <p className="secondary-text stats-empty-text">
              В выбранном периоде пока нет завершённых целей.
            </p>
          ) : (
            <div className="stats-recent-list">
              {recentCompleted.map(goal => (
                <div key={goal.id} className="stats-recent-row">
                  <div className="stats-recent-main">
                    <span className="stats-recent-check">
                      <Check size={14} weight="bold" aria-hidden />
                    </span>
                    <div>
                      <strong>{goal.title}</strong>
                      <p className="secondary-text">{goal.category}</p>
                    </div>
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
            <h2 className="stats-card-title">
              <span className="stats-card-ico" aria-hidden="true">
                <Lightbulb size={16} weight="regular" />
              </span>
              Выводы и инсайты
            </h2>
          </div>
          <div className="stats-insights-list">
            {insights.map((text, index) => {
              const InsightIcon = INSIGHT_ICON_COMPONENTS[index % INSIGHT_ICON_COMPONENTS.length]
              return (
                <div key={text} className="stats-insight-row">
                  <span className="stats-insight-icon" aria-hidden="true">
                    <InsightIcon size={18} weight="regular" />
                  </span>
                  <p>{text}</p>
                </div>
              )
            })}
          </div>
        </article>
      </div>
    </section>
  )
}

export default Analytics
