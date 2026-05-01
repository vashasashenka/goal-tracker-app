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
  if (GOAL_CATEGORIES.includes(normalized)) {
    return normalized
  }
  return inferGoalCategory(fallbackText)
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
  return {
    id: String(step?.id ?? `step-${index}`),
    title: String(step?.title ?? step?.text ?? '').trim() || `Шаг ${index + 1}`,
    completed: Boolean(step?.completed),
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

    if (range === 'month') {
      return (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth()
      )
    }

    if (range === 'year') {
      return date.getFullYear() === today.getFullYear()
    }

    return true
  })
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
  return [
    data.bestDay
      ? `Ты чаще всего выполняешь цели по ${data.bestDay.byLabel}.`
      : 'Пока не хватает завершённых целей, чтобы определить самый продуктивный день.',
    data.avg > 0
      ? `Средняя активность: ${formatGoalsPerDayLabel(data.avg)}.`
      : 'Средняя активность появится после первых завершённых целей.',
    data.streak > 0
      ? `Серия: ${formatDaysLabel(data.streak)} подряд.`
      : 'Серия пока не началась — заверши цель сегодня, чтобы запустить streak.',
    data.progress.total > 0
      ? `Общий прогресс: ${data.progress.completed} из ${data.progress.total}.`
      : 'Добавь цели, чтобы система начала рассчитывать прогресс.',
  ]
}
