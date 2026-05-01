export const GOAL_CATEGORIES = ['Учёба', 'Работа', 'Личное', 'Другое']

const CATEGORY_HINTS = {
  'Учёба': [
    'учеб',
    'экзам',
    'курс',
    'лекц',
    'урок',
    'дз',
    'домашк',
    'сесс',
    'диплом',
    'реферат',
    'статью',
    'статья',
    'тест',
    'зачет',
  ],
  'Работа': [
    'работ',
    'проект',
    'клиент',
    'созвон',
    'митинг',
    'задач',
    'дедлайн',
    'презент',
    'отчет',
    'резюме',
    'офис',
    'продаж',
    'интервью',
  ],
  'Личное': [
    'дом',
    'квартир',
    'здоров',
    'спорт',
    'бег',
    'трениров',
    'семь',
    'личн',
    'хобби',
    'отдых',
    'сон',
    'поряд',
    'уборк',
    'покуп',
  ],
}

const WEEKDAY_LABELS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
]

const WEEKDAY_BY_DAY_LABELS = [
  'воскресеньям',
  'понедельникам',
  'вторникам',
  'средам',
  'четвергам',
  'пятницам',
  'субботам',
]

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function normalizeDate(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

function startOfDay(value) {
  const date = normalizeDate(value)
  if (!date) return null
  date.setHours(0, 0, 0, 0)
  return date
}

function parseRecommendedDate(value) {
  const raw = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const [year, month, day] = raw.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

export function toLocalDateKey(value) {
  const date = normalizeDate(value)
  if (!date) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function recommendedDateOnlyKey(value) {
  const raw = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
}

/**
 * День для графика активности: фактическая дата выполнения (completedAt),
 * иначе — рекомендованная дата (если шаг завершён, но completedAt ещё не было в данных).
 */
export function getMicroStepActivityDateKey(step) {
  if (!step?.completed) return ''
  const rawDone = String(step.completedAt || '').trim()
  if (rawDone) {
    const k = toLocalDateKey(step.completedAt)
    if (k) return k
  }
  return recommendedDateOnlyKey(step.recommendedDate)
}

function getGoalRawTitle(goal) {
  return String(goal?.title ?? goal?.text ?? '').trim()
}

function getGoalRawSteps(goal) {
  if (Array.isArray(goal?.steps)) return goal.steps
  if (Array.isArray(goal?.microGoals)) return goal.microGoals
  return []
}

export function inferGoalCategory(text) {
  const normalized = normalizeText(text)
  if (!normalized) return 'Другое'

  for (const [category, patterns] of Object.entries(CATEGORY_HINTS)) {
    if (patterns.some(pattern => normalized.includes(pattern))) {
      return category
    }
  }

  return 'Другое'
}

export function normalizeGoalCategory(category, fallbackText = '') {
  const normalized = String(category || '').trim()
  if (GOAL_CATEGORIES.includes(normalized) && normalized !== 'Другое') {
    return normalized
  }
  const inferred = inferGoalCategory(fallbackText)
  if (inferred !== 'Другое') return inferred
  return GOAL_CATEGORIES.includes(normalized) ? normalized : 'Другое'
}

export function resolveGoalCreatedAt(goal) {
  const explicit = normalizeDate(goal?.createdAt)
  if (explicit) return explicit.toISOString()

  const earliestRecommended = getGoalRawSteps(goal)
    .map(step => parseRecommendedDate(step?.recommendedDate))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime())[0]
  if (earliestRecommended) return earliestRecommended.toISOString()

  const completedAt = normalizeDate(goal?.completedAt || goal?.finishedAt)
  if (completedAt) return completedAt.toISOString()

  return new Date().toISOString()
}

function normalizeStep(step, index) {
  const completed = Boolean(step?.completed)
  const completedAt =
    completed && step?.completedAt ? String(step.completedAt).trim() || null : null
  const recommendedDate = recommendedDateOnlyKey(step?.recommendedDate) || null
  return {
    id: String(step?.id ?? `step-${index}`),
    title: String(step?.title ?? step?.text ?? '').trim() || `Шаг ${index + 1}`,
    completed,
    completedAt,
    recommendedDate,
  }
}

export function normalizeGoalForStats(goal, { completed = false } = {}) {
  const title = getGoalRawTitle(goal) || 'Без названия'
  const completedAt = normalizeDate(goal?.completedAt || goal?.finishedAt)?.toISOString() || null

  return {
    id: String(goal?.id ?? `${title}-${goal?.createdAt || goal?.finishedAt || 'goal'}`),
    title,
    category: normalizeGoalCategory(goal?.category, title),
    createdAt: resolveGoalCreatedAt(goal),
    completed: Boolean(goal?.completed ?? completed ?? completedAt),
    completedAt,
    steps: getGoalRawSteps(goal).map(normalizeStep),
  }
}

function getGoalDateForRange(goal) {
  return normalizeDate(goal?.completedAt || goal?.createdAt)
}

export function filterGoals(goals, range, now = new Date()) {
  if (range === 'all') return [...goals]

  const today = startOfDay(now)
  if (!today) return []

  return goals.filter(goal => {
    const date = startOfDay(getGoalDateForRange(goal))
    if (!date) return false

    if (range === 'week') {
      const weekStart = new Date(today)
      weekStart.setDate(today.getDate() - 6)
      return date.getTime() >= weekStart.getTime() && date.getTime() <= today.getTime()
    }

    if (range === 'month') return date.getTime() >= addDays(today, -29).getTime()
    if (range === 'year') return date.getTime() >= addDays(today, -364).getTime()

    return true
  })
}

function addDays(value, deltaDays) {
  const date = new Date(value)
  date.setDate(date.getDate() + Math.trunc(Number(deltaDays) || 0))
  return date
}

export function getProgress(goals) {
  const total = goals.length
  const completed = goals.filter(goal => goal.completed).length
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)

  return { percent, completed, total }
}

export function getStreak(goals, now = new Date()) {
  const completedDates = goals
    .filter(goal => goal.completedAt)
    .map(goal => toLocalDateKey(goal.completedAt))
    .filter(Boolean)

  const uniqueDates = [...new Set(completedDates)].sort((a, b) => b.localeCompare(a))

  let streak = 0
  let currentDate = startOfDay(now)

  for (const key of uniqueDates) {
    if (!currentDate) break
    if (key === toLocalDateKey(currentDate)) {
      streak += 1
      currentDate.setDate(currentDate.getDate() - 1)
    } else {
      break
    }
  }

  return streak
}

export function getDailyStats(goals) {
  const stats = {}

  goals.forEach(goal => {
    if (!goal.completedAt) return
    const dateKey = toLocalDateKey(goal.completedAt)
    if (!dateKey) return
    stats[dateKey] = (stats[dateKey] || 0) + 1
  })

  return stats
}

export function countDaysInclusive(bounds) {
  if (!bounds?.start || !bounds?.end) return 0
  const a = startOfDay(bounds.start)
  const b = startOfDay(bounds.end)
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1
}

export function goalExistsDuringStatsRange(goal, bounds) {
  if (!bounds?.start || !bounds?.end) return true
  const startD = startOfDay(bounds.start)
  const endD = startOfDay(bounds.end)
  if (!startD || !endD) return true
  const created = startOfDay(normalizeDate(goal.createdAt))
  const finishedRaw = normalizeDate(goal.completedAt)
  const finishedDay = finishedRaw ? startOfDay(finishedRaw) : null
  if (!created || created.getTime() > endD.getTime()) return false
  if (finishedDay && finishedDay.getTime() < startD.getTime()) return false
  return true
}

export function getMicroProgressForScopedGoals(goals, bounds) {
  const scoped = bounds?.start && bounds?.end
    ? goals.filter(g => goalExistsDuringStatsRange(g, bounds))
    : [...goals]
  let total = 0
  let completed = 0
  for (const g of scoped) {
    for (const s of getGoalRawSteps(g)) {
      total += 1
      if (s.completed) completed += 1
    }
  }
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100)
  return { completed, total, percent }
}

export function getMicroCompletionsInRange(goals, bounds) {
  if (!bounds?.start || !bounds?.end) return 0
  const a = toLocalDateKey(bounds.start)
  const b = toLocalDateKey(bounds.end)
  if (!a || !b) return 0
  let n = 0
  for (const g of goals) {
    for (const s of getGoalRawSteps(g)) {
      if (!s.completed) continue
      const k = getMicroStepActivityDateKey(s)
      if (k && k >= a && k <= b) n += 1
    }
  }
  return n
}

export function getMicroDailyDetailMap(goals, bounds) {
  const map = Object.create(null)
  const a = bounds?.start && bounds?.end ? toLocalDateKey(bounds.start) : null
  const b = bounds?.start && bounds?.end ? toLocalDateKey(bounds.end) : null
  for (const g of goals) {
    const goalTitle = getGoalRawTitle(g)
    for (const s of getGoalRawSteps(g)) {
      if (!s.completed) continue
      const k = getMicroStepActivityDateKey(s)
      if (!k) continue
      if (a && b && (k < a || k > b)) continue
      if (!map[k]) map[k] = { count: 0, steps: [] }
      map[k].count += 1
      const label = String(s.title || s.text || '').trim() || 'Шаг'
      map[k].steps.push(`${label} · ${goalTitle}`)
    }
  }
  return map
}

export function getMicroStreakDays(goals, now = new Date()) {
  const dates = new Set()
  for (const g of goals) {
    for (const s of getGoalRawSteps(g)) {
      if (!s.completed) continue
      const k = getMicroStepActivityDateKey(s)
      if (k) dates.add(k)
    }
  }
  let streak = 0
  const cursor = startOfDay(now)
  if (!cursor) return 0
  const current = new Date(cursor)
  for (;;) {
    const key = toLocalDateKey(current)
    if (!key) break
    if (dates.has(key)) {
      streak += 1
      current.setDate(current.getDate() - 1)
    } else break
  }
  return streak
}

export function getAvgMicroPerDayInBounds(goals, bounds) {
  const total = getMicroCompletionsInRange(goals, bounds)
  const days = countDaysInclusive(bounds)
  if (days <= 0) return 0
  return total / days
}

export function getMaxMicroCompletionsPerDayInBounds(goals, bounds) {
  const map = getMicroDailyDetailMap(goals, bounds)
  let m = 0
  for (const k of Object.keys(map)) {
    m = Math.max(m, map[k].count)
  }
  return m
}

export function getMicroBarPercent(avgPerDay, maxPerDay) {
  if (!maxPerDay || maxPerDay <= 0) return 0
  return Math.min(100, Math.round((avgPerDay / maxPerDay) * 100))
}

function shiftBoundsBackByLength(bounds) {
  if (!bounds?.start || !bounds?.end) return null
  const len = countDaysInclusive(bounds)
  if (len <= 0) return null
  const s = new Date(bounds.start)
  const e = new Date(bounds.end)
  s.setDate(s.getDate() - len)
  e.setDate(e.getDate() - len)
  const start = startOfDay(s)
  const end = startOfDay(e)
  return start && end ? { start, end } : null
}

export function getMicroDeltaPercentVersusPreviousPeriod(goals, bounds) {
  const prev = shiftBoundsBackByLength(bounds)
  if (!prev?.start || !prev?.end) return null
  const cur = getMicroCompletionsInRange(goals, bounds)
  const p = getMicroCompletionsInRange(goals, prev)
  if (p === 0) return cur > 0 ? null : 0
  return Math.round(((cur - p) / p) * 100)
}

export function getBestWeekdayMicroFromGoals(goals, bounds) {
  const days = {}
  for (const g of goals) {
    for (const s of getGoalRawSteps(g)) {
      if (!s.completed) continue
      const k = getMicroStepActivityDateKey(s)
      if (!k) continue
      if (bounds?.start && bounds?.end) {
        const a = toLocalDateKey(bounds.start)
        const b = toLocalDateKey(bounds.end)
        if (k < a || k > b) continue
      }
      const day = new Date(`${k}T12:00:00`).getDay()
      days[day] = (days[day] || 0) + 1
    }
  }
  const best = Object.entries(days).sort((a, b) => Number(b[1]) - Number(a[1]))[0]
  if (!best) return null
  const dayIndex = Number(best[0])
  return {
    dayIndex,
    count: Number(best[1]),
    label: WEEKDAY_LABELS[dayIndex] || 'этот день',
  }
}

export function getCategoryStats(goals) {
  const counts = Object.fromEntries(GOAL_CATEGORIES.map(category => [category, 0]))

  goals.forEach(goal => {
    const category = normalizeGoalCategory(goal?.category, goal?.title)
    counts[category] = (counts[category] || 0) + 1
  })

  const total = goals.length

  return GOAL_CATEGORIES.map(category => ({
    category,
    count: counts[category] || 0,
    percent: total === 0 ? 0 : Math.round(((counts[category] || 0) / total) * 100),
  }))
}

export function getRecentCompleted(goals) {
  return [...goals]
    .filter(goal => goal.completed && goal.completedAt)
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
    .slice(0, 5)
}

export function getBestDay(goals) {
  const days = {}

  goals.forEach(goal => {
    if (!goal.completedAt) return
    const day = new Date(goal.completedAt).getDay()
    if (Number.isNaN(day)) return
    days[day] = (days[day] || 0) + 1
  })

  const best = Object.entries(days).sort((a, b) => Number(b[1]) - Number(a[1]))[0]
  if (!best) return null

  const dayIndex = Number(best[0])
  return {
    dayIndex,
    count: Number(best[1]),
    label: WEEKDAY_LABELS[dayIndex] || 'день',
    byLabel: WEEKDAY_BY_DAY_LABELS[dayIndex] || 'дням',
  }
}

export function getAveragePerDay(goals) {
  const stats = getDailyStats(goals)
  const values = Object.values(stats)
  if (values.length === 0) return 0
  return Math.round(values.reduce((acc, value) => acc + value, 0) / values.length)
}

function pluralize(count, forms) {
  const value = Math.abs(Math.trunc(Number(count) || 0))
  const lastTwo = value % 100
  const last = value % 10
  if (lastTwo >= 11 && lastTwo <= 14) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

export function formatDaysLabel(count) {
  return `${count} ${pluralize(count, ['день', 'дня', 'дней'])}`
}

export function formatGoalsPerDayLabel(count) {
  return `${count} ${pluralize(count, ['цель', 'цели', 'целей'])} в день`
}

export function generateInsights(data) {
  const avgMicro =
    typeof data.avgMicro === 'number' ? data.avgMicro.toFixed(1).replace('.', ',') : '0'
  return [
    data.bestMicroDay
      ? `Чаще всего вы закрываете микрошаги в ${data.bestMicroDay.label}.`
      : 'Пока мало завершённых микрошагов с датой — картина по дням недели проявится позже.',
    data.avgMicro > 0
      ? `В среднем за день в выбранном периоде: ${avgMicro} микрошага.`
      : 'Средняя активность по микрошагам появится после первых отметок «выполнено».',
    data.microStreak > 0
      ? `Серия по микрошагам: ${formatDaysLabel(data.microStreak)} подряд.`
      : 'Серия по микрошагам начнётся, если выполнять хотя бы один шаг каждый день.',
    data.microProgress?.total > 0
      ? `В целях выбранного периода: ${data.microProgress.completed} из ${data.microProgress.total} микрошагов закрыто.`
      : 'Добавьте цели и шаги — появится сводный прогресс.',
  ]
}
