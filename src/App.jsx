import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

function normalizeApiBase(url) {
  const s = String(url ?? '').trim()
  if (!s || s === '/') return ''
  if (s.startsWith('/')) return s.replace(/\/$/, '')
  if (s.startsWith('://')) return `http${s}`
  if (!/^https?:\/\//i.test(s)) return `http://${s.replace(/^\/+/, '')}`
  return s.replace(/\/$/, '')
}

const API_URL = normalizeApiBase(import.meta.env.VITE_API_URL)

async function parseApiErrorMessage(response) {
  try {
    const body = await response.json()
    if (typeof body?.error === 'string' && body.error.trim()) return body.error.trim()
  } catch {
    try {
      const text = await response.text()
      const cleaned = String(text || '').trim()
      if (cleaned) return cleaned.slice(0, 200)
    } catch {
      /* ignore */
    }
  }
  return null
}

const ACTIVE_GOAL_KEY = 'goal_tracker_active_goal_id'
const GOALS_KEY = 'goal_tracker_goals'
const COMPLETED_GOALS_KEY = 'goal_tracker_completed_goals'
const PROFILE_ID_KEY = 'goal_tracker_profile_id'
const USER_NAME_KEY = 'goal_tracker_user_name'
const SETTINGS_KEY = 'goal_tracker_settings'

/** Сколько подсказок ИИ держим на экране (после добавления одной — дозаполняем до этого числа). */
const AI_SUGGEST_SLOTS = 3
const CHECKPOINT_GAP_DAYS = [3, 4, 7, 7, 14, 14, 21]

function parseIsoDate(dateStr) {
  const value = String(dateStr || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }

  date.setHours(0, 0, 0, 0)
  return date
}

function toIsoDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeIsoDate(dateStr) {
  const parsed = parseIsoDate(dateStr)
  return parsed ? toIsoDate(parsed) : ''
}

function addDays(date, days) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  next.setDate(next.getDate() + Math.max(0, Math.trunc(Number(days) || 0)))
  return next
}

function checkpointGapForIndex(index) {
  if (index < CHECKPOINT_GAP_DAYS.length) return CHECKPOINT_GAP_DAYS[index]
  const overflow = index - CHECKPOINT_GAP_DAYS.length
  return 21 + Math.floor(overflow / 2) * 7
}

function checkpointOffsetForOrder(order) {
  const safeOrder = Math.max(1, Math.trunc(Number(order) || 1))
  let total = 0
  for (let i = 0; i < safeOrder; i += 1) {
    total += checkpointGapForIndex(i)
  }
  return total
}

function getNextCheckpointOrder(microGoals) {
  return (
    (Array.isArray(microGoals) ? microGoals : []).reduce((max, item) => {
      const current = Math.trunc(Number(item?.checkpointOrder) || 0)
      return current > max ? current : max
    }, 0) + 1
  )
}

function findPreviousCheckpoint(microGoals, checkpointOrder) {
  return [...(Array.isArray(microGoals) ? microGoals : [])]
    .filter(item => Number(item?.checkpointOrder) < checkpointOrder && normalizeIsoDate(item?.recommendedDate))
    .sort((a, b) => Number(a.checkpointOrder || 0) - Number(b.checkpointOrder || 0))
    .at(-1)
}

function inferRecommendedDate(checkpointOrder, microGoals) {
  const previous = findPreviousCheckpoint(microGoals, checkpointOrder)
  if (previous) {
    const prevDate = parseIsoDate(previous.recommendedDate)
    const prevOrder = Math.max(1, Math.trunc(Number(previous.checkpointOrder) || 1))
    if (prevDate) {
      const offset = checkpointOffsetForOrder(checkpointOrder) - checkpointOffsetForOrder(prevOrder)
      return toIsoDate(addDays(prevDate, offset))
    }
  }

  return toIsoDate(addDays(new Date(), checkpointOffsetForOrder(checkpointOrder)))
}

function normalizeMicroGoal(item, index, existingMicroGoals = []) {
  if (item == null) return null

  const checkpointOrderRaw = Math.trunc(Number(item.checkpointOrder) || 0)
  const checkpointOrder = checkpointOrderRaw > 0 ? checkpointOrderRaw : index + 1
  const recommendedDate =
    normalizeIsoDate(item.recommendedDate) || inferRecommendedDate(checkpointOrder, existingMicroGoals)

  return {
    ...item,
    completed: Boolean(item.completed),
    suggested: Boolean(item.suggested),
    checkpointOrder,
    recommendedDate,
  }
}

function normalizeMicroGoalsList(microGoals) {
  const normalized = []
  ;(Array.isArray(microGoals) ? microGoals : []).forEach((item, index) => {
    const nextItem = normalizeMicroGoal(item, index, normalized)
    if (nextItem) normalized.push(nextItem)
  })
  return normalized
}

function buildAppendedMicroGoal(existingMicroGoals, draft) {
  const normalizedExisting = normalizeMicroGoalsList(existingMicroGoals)
  const checkpointOrder = getNextCheckpointOrder(normalizedExisting)
  const {
    forceRecommendedDate,
    recommendedOffsetDays,
    ...restDraft
  } = draft || {}

  const allowPreferredDate = Boolean(forceRecommendedDate) || normalizedExisting.length === 0
  let recommendedDate = allowPreferredDate ? normalizeIsoDate(restDraft?.recommendedDate) : ''
  if (!recommendedDate && normalizedExisting.length === 0) {
    const offset = Number(recommendedOffsetDays)
    if (Number.isFinite(offset)) {
      recommendedDate = toIsoDate(addDays(new Date(), offset))
    }
  }

  return normalizeMicroGoal(
    {
      ...restDraft,
      checkpointOrder,
      recommendedDate: recommendedDate || inferRecommendedDate(checkpointOrder, normalizedExisting),
    },
    normalizedExisting.length,
    normalizedExisting
  )
}

function planSuggestedMicroGoals(items, goal = null) {
  const planned = normalizeMicroGoalsList(goal?.microGoals)
  return (Array.isArray(items) ? items : []).map(item => {
    const nextItem = buildAppendedMicroGoal(planned, {
      ...item,
      completed: false,
      suggested: item?.suggested ?? true,
    })
    planned.push(nextItem)
    return nextItem
  })
}

function formatRecommendedDate(dateStr, options = { day: 'numeric', month: 'short' }) {
  const parsed = parseIsoDate(dateStr)
  if (!parsed) return ''
  return parsed
    .toLocaleDateString('ru-RU', options)
    .replace(/\s?г\.$/, '')
    .replace(/\./g, '')
}

function isRecommendedDatePassed(task) {
  if (!task || task.completed) return false
  const parsed = parseIsoDate(task.recommendedDate)
  if (!parsed) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return parsed.getTime() < today.getTime()
}

function compareMicroGoalsByCheckpoint(a, b) {
  const aDate = parseIsoDate(a?.recommendedDate)?.getTime() ?? Number.MAX_SAFE_INTEGER
  const bDate = parseIsoDate(b?.recommendedDate)?.getTime() ?? Number.MAX_SAFE_INTEGER
  if (aDate !== bDate) return aDate - bDate

  const aOrder = Math.trunc(Number(a?.checkpointOrder) || 0)
  const bOrder = Math.trunc(Number(b?.checkpointOrder) || 0)
  if (aOrder !== bOrder) return aOrder - bOrder

  return String(a?.text || '').localeCompare(String(b?.text || ''), 'ru')
}

function makeScopedStorageKey(base, userKey) {
  return `${base}::${userKey || 'guest'}`
}

function generateProfileId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function ensureProfileId() {
  const saved = String(localStorage.getItem(PROFILE_ID_KEY) || '').trim()
  if (saved) return saved
  const created = generateProfileId()
  localStorage.setItem(PROFILE_ID_KEY, created)
  return created
}

function readScopedGoalList(baseKey, userKey) {
  const raw = localStorage.getItem(makeScopedStorageKey(baseKey, userKey))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.map(normalizeGoal).filter(item => item && Number.isFinite(Number(item.id)))
      : []
  } catch {
    return []
  }
}

async function fetchPreviewMicrogoals(text, existingTexts, count = AI_SUGGEST_SLOTS) {
  const response = await fetch(`${API_URL}/api/preview-microgoals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, existingTexts, count }),
  })
  if (!response.ok) {
    const msg = await parseApiErrorMessage(response)
    throw new Error(msg || 'failed')
  }
  const data = await response.json()
  return (Array.isArray(data) ? data : [])
    .map((item, index) => ({
      id: String(item.id ?? `s-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 9)}`),
      text: item.text,
      recommendedDate: normalizeIsoDate(item?.recommendedDate),
      recommendedOffsetDays: Number.isFinite(Number(item?.recommendedOffsetDays))
        ? Math.max(0, Math.trunc(Number(item.recommendedOffsetDays)))
        : null,
      checkpointOrder: Number.isFinite(Number(item?.checkpointOrder))
        ? Math.max(1, Math.trunc(Number(item.checkpointOrder)))
        : null,
    }))
    .filter(item => item.text)
}

function normalizeGoal(goal) {
  if (goal == null) return null
  return {
    ...goal,
    microGoals: normalizeMicroGoalsList(goal.microGoals),
  }
}

function normalizeTaskText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'`«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function textSimilarity(a, b) {
  const left = normalizeTaskText(a)
  const right = normalizeTaskText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return 0.9

  const leftTokens = new Set(left.split(' '))
  const rightTokens = new Set(right.split(' '))
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size || 1
  return intersection / union
}

function App() {
  const initialUserName = String(localStorage.getItem(USER_NAME_KEY) || '').trim()
  const initialProfileId = ensureProfileId()
  const [goals, setGoals] = useState(() => readScopedGoalList(GOALS_KEY, initialProfileId))
  const [completedGoals, setCompletedGoals] = useState(() =>
    readScopedGoalList(COMPLETED_GOALS_KEY, initialProfileId)
  )
  const [activeGoalId, setActiveGoalId] = useState(() => {
    const raw = localStorage.getItem(makeScopedStorageKey(ACTIVE_GOAL_KEY, initialProfileId))
    if (!raw || raw === 'undefined' || raw === 'null') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  })
  const [activeTab, setActiveTab] = useState('agenda')
  const [showProfile, setShowProfile] = useState(false)

  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [aiError, setAiError] = useState('')
  const [recommendations, setRecommendations] = useState([])
  /** Текст цели/задачи, по которому запрошены рекомендации (в т.ч. из поля Генерации без созданной цели). */
  const [recommendationsSource, setRecommendationsSource] = useState('')

  const [userName, setUserName] = useState(() => initialUserName)
  /** Черновик в поле имени; не смешиваем с сохранённым именем — иначе после одной буквы экран онбординга закрывается. */
  const [nameDraft, setNameDraft] = useState('')
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem(makeScopedStorageKey(SETTINGS_KEY, initialProfileId))
    if (!saved) {
      return {
        calendarAccess: true,
        geoAccess: false,
        analytics: true,
        notifications: true,
        mode: 'Стандарт',
      }
    }
    try {
      return JSON.parse(saved)
    } catch {
      return {
        calendarAccess: true,
        geoAccess: false,
        analytics: true,
        notifications: true,
        mode: 'Стандарт',
      }
    }
  })

  const [generationInput, setGenerationInput] = useState('')
  const [generatedSteps, setGeneratedSteps] = useState([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [showGeneratedResult, setShowGeneratedResult] = useState(false)
  const [genCustomInput, setGenCustomInput] = useState('')
  const [genRowBusyId, setGenRowBusyId] = useState(null)
  const [isAddingOwnStep, setIsAddingOwnStep] = useState(false)
  const [taskEditor, setTaskEditor] = useState(null)
  const [taskDraft, setTaskDraft] = useState('')
  const [taskDateDraft, setTaskDateDraft] = useState('')
  const [taskEditorBusy, setTaskEditorBusy] = useState(false)
  const [expandedHistoryId, setExpandedHistoryId] = useState(null)

  const userKey = initialProfileId
  const activeGoalStorageKey = useMemo(() => makeScopedStorageKey(ACTIVE_GOAL_KEY, userKey), [userKey])
  const goalsStorageKey = useMemo(() => makeScopedStorageKey(GOALS_KEY, userKey), [userKey])
  const completedGoalsStorageKey = useMemo(
    () => makeScopedStorageKey(COMPLETED_GOALS_KEY, userKey),
    [userKey]
  )
  const settingsStorageKey = useMemo(() => makeScopedStorageKey(SETTINGS_KEY, userKey), [userKey])

  function resetGenerationUi() {
    setGenerationInput('')
    setGeneratedSteps([])
    setShowGeneratedResult(false)
    setGenCustomInput('')
    setIsGenerating(false)
    setGenRowBusyId(null)
    setIsAddingOwnStep(false)
  }

  useEffect(() => {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings))
  }, [settings, settingsStorageKey])

  useEffect(() => {
    const saved = localStorage.getItem(settingsStorageKey)
    if (!saved) {
      setSettings({
        calendarAccess: true,
        geoAccess: false,
        analytics: true,
        notifications: true,
        mode: 'Стандарт',
      })
      return
    }
    try {
      setSettings(JSON.parse(saved))
    } catch {
      setSettings({
        calendarAccess: true,
        geoAccess: false,
        analytics: true,
        notifications: true,
        mode: 'Стандарт',
      })
    }
  }, [settingsStorageKey])

  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    setGoals(readScopedGoalList(GOALS_KEY, userKey))
    setCompletedGoals(readScopedGoalList(COMPLETED_GOALS_KEY, userKey))
  }, [userKey])

  useEffect(() => {
    localStorage.setItem(goalsStorageKey, JSON.stringify(goals))
  }, [goals, goalsStorageKey])

  useEffect(() => {
    localStorage.setItem(completedGoalsStorageKey, JSON.stringify(completedGoals))
  }, [completedGoals, completedGoalsStorageKey])

  useEffect(() => {
    if (!Array.isArray(goals) || goals.length === 0) {
      setActiveGoalId(null)
      localStorage.removeItem(activeGoalStorageKey)
      return
    }

    const idOk = activeGoalId != null && Number.isFinite(Number(activeGoalId))
    const exists = idOk && goals.some(g => g.id === activeGoalId)
    if (!idOk || !exists) {
      setActiveGoalId(goals[0].id)
      localStorage.setItem(activeGoalStorageKey, String(goals[0].id))
    }
  }, [goals, activeGoalId, activeGoalStorageKey])

  const safeGoals = useMemo(() => (Array.isArray(goals) ? goals : []), [goals])
  const safeCompletedGoals = useMemo(
    () => (Array.isArray(completedGoals) ? completedGoals : []),
    [completedGoals]
  )

  const activeGoal = normalizeGoal(safeGoals.find(g => g.id === activeGoalId) ?? null)

  const agendaMicroTasks = useMemo(() => {
    const list = activeGoal?.microGoals
    if (!Array.isArray(list)) return []
    return [...list].filter(t => !t.completed).sort(compareMicroGoalsByCheckpoint)
  }, [activeGoal])

  function switchActiveGoal(delta) {
    if (safeGoals.length <= 1) return
    const idx = safeGoals.findIndex(g => g.id === activeGoalId)
    if (idx === -1) return
    const len = safeGoals.length
    const nextIdx = (idx + delta + len) % len
    const nextGoal = safeGoals[nextIdx]
    setActiveGoalId(nextGoal.id)
    localStorage.setItem(activeGoalStorageKey, String(nextGoal.id))
    setRecommendations([])
  }

  const goalSwipe = useRef({ x: null })

  const utilization = useMemo(() => {
    const count = agendaMicroTasks.length
    if (count >= 6) return 'Высокая'
    if (count >= 3) return 'Средняя'
    return 'Низкая'
  }, [agendaMicroTasks])

  /** Последние 7 календарных дней (включая сегодня): сколько целей завершено за каждый день. */
  const journalBars = useMemo(() => {
    const strip = []
    const now = new Date()
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - i)
      strip.push({
        date: d,
        count: 0,
        weekday: d.toLocaleDateString('ru-RU', { weekday: 'short' }),
        dayNum: d.getDate(),
      })
    }

    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()

    safeCompletedGoals.forEach(goal => {
      const when = new Date(goal.finishedAt || Date.now())
      const slot = strip.find(s => sameDay(s.date, when))
      if (slot) slot.count += 1
    })

    const values = strip.map(s => s.count)
    const max = Math.max(...values, 0)
    const hasData = max > 0
    const heights = values.map(v => {
      if (!hasData) return 0
      if (v === 0) return 12
      return Math.max(24, Math.round((v / max) * 100))
    })

    return { strip, values, hasData, heights, max }
  }, [safeCompletedGoals])

  const journalRangeLabel = useMemo(() => {
    const strip = journalBars.strip
    if (!strip?.length) return ''
    const a = strip[0].date
    const b = strip[strip.length - 1].date
    const o = { day: 'numeric', month: 'short' }
    return `${a.toLocaleDateString('ru-RU', o)} — ${b.toLocaleDateString('ru-RU', o)}`
  }, [journalBars.strip])

  const efficiencyStats = useMemo(() => {
    const allTasks = [...safeGoals, ...safeCompletedGoals].flatMap(g => g.microGoals || [])
    if (allTasks.length === 0) {
      return { hasData: false, done: 0, pending: 0 }
    }

    const doneCount = allTasks.filter(t => t.completed).length
    const pendingCount = allTasks.filter(t => !t.completed).length
    const total = allTasks.length || 1
    const base = [
      { key: 'done', value: (doneCount / total) * 100 },
      { key: 'pending', value: (pendingCount / total) * 100 },
    ]
    const rounded = base.map(item => ({ ...item, rounded: Math.floor(item.value) }))
    const sum = rounded.reduce((acc, item) => acc + item.rounded, 0)
    let remainder = 100 - sum
    const order = [...rounded].sort(
      (a, b) => b.value - b.rounded - (a.value - a.rounded)
    )
    for (let i = 0; i < order.length && remainder > 0; i += 1) {
      const target = rounded.find(item => item.key === order[i].key)
      if (target) {
        target.rounded += 1
        remainder -= 1
      }
    }

    const pick = key => rounded.find(item => item.key === key)?.rounded ?? 0
    return {
      hasData: true,
      done: pick('done'),
      pending: pick('pending'),
    }
  }, [safeGoals, safeCompletedGoals])

  function hasSimilarTaskDuplicate(goal, text) {
    const normalized = normalizeTaskText(text)
    if (!normalized) return false
    return (goal?.microGoals || []).some(
      item => textSimilarity(item.text, normalized) >= 0.65
    )
  }

  /** Совпадение формулировки цели в поле генерации и сохранённой цели (чтобы не смешивать темы). */
  function goalTitlesAlign(a, b) {
    const ta = String(a ?? '').trim()
    const tb = String(b ?? '').trim()
    if (!ta || !tb) return false
    if (normalizeTaskText(ta) === normalizeTaskText(tb)) return true
    return textSimilarity(ta, tb) >= 0.72
  }

  function findGoalByTitle(goalsList, title) {
    const t = String(title ?? '').trim()
    if (!t) return null
    return goalsList.find(g => goalTitlesAlign(g.text, t)) ?? null
  }

  const historyItems = useMemo(() => {
    return [...safeCompletedGoals]
      .sort(
        (a, b) =>
          new Date(b.finishedAt || 0).getTime() - new Date(a.finishedAt || 0).getTime()
      )
      .map(goal => {
        const when = new Date(goal.finishedAt || Date.now())
        const y = when.getFullYear()
        const nowY = new Date().getFullYear()
        const microGoals = normalizeMicroGoalsList(goal.microGoals).sort(compareMicroGoalsByCheckpoint)
        return {
          id: goal.id,
          text: goal.text,
          microGoals,
          when,
          dateStr: when.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
            ...(y !== nowY ? { year: 'numeric' } : {}),
          }),
          timeStr: when.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          stepsCount: microGoals.length,
        }
      })
  }, [safeCompletedGoals])

  function openTaskEditor(goalId, task = null) {
    const goal = normalizeGoal(safeGoals.find(item => item.id === goalId) ?? null)
    const checkpointOrder = task?.checkpointOrder ?? getNextCheckpointOrder(goal?.microGoals)
    const recommendedDate =
      normalizeIsoDate(task?.recommendedDate) ||
      inferRecommendedDate(checkpointOrder, goal?.microGoals || [])

    setTaskEditor({
      goalId,
      taskId: task?.id ?? null,
      mode: task ? 'edit' : 'create',
      checkpointOrder,
    })
    setTaskDraft(String(task?.text || ''))
    setTaskDateDraft(recommendedDate)
    setAiError('')
  }

  function closeTaskEditor() {
    setTaskEditor(null)
    setTaskDraft('')
    setTaskDateDraft('')
    setTaskEditorBusy(false)
  }

  async function saveTaskDate(goalId, taskId, nextDate) {
    const goal = safeGoals.find(item => item.id === goalId)
    if (!goal) return

    const normalizedDate = normalizeIsoDate(nextDate)
    if (!normalizedDate) return

    const otherMicroGoals = (goal.microGoals || []).filter(item => item.id !== taskId)
    const microGoals = (goal.microGoals || []).map(item =>
      item.id === taskId
        ? normalizeMicroGoal(
            {
              ...item,
              recommendedDate: normalizedDate,
            },
            0,
            otherMicroGoals
          )
        : item
    )

    const saved = normalizeGoal(await updateGoalLocally({ ...goal, microGoals }))
    setGoals(prev => prev.map(item => (item.id === saved.id ? saved : item)))

    if (taskEditor?.goalId === goalId && taskEditor?.taskId === taskId) {
      setTaskDateDraft(normalizedDate)
    }
  }

  const editingTask = useMemo(() => {
    if (!taskEditor) return null
    const goal = safeGoals.find(item => item.id === taskEditor.goalId)
    if (!goal) return null
    return (goal.microGoals || []).find(item => item.id === taskEditor.taskId) || null
  }, [taskEditor, safeGoals])

  async function updateGoalLocally(updatedGoal) {
    const gid = updatedGoal?.id
    if (gid == null || !Number.isFinite(Number(gid))) {
      console.error('Обновление цели: нет корректного id', updatedGoal)
      return updatedGoal
    }
    return normalizeGoal(updatedGoal)
  }

  async function createGoal(text) {
    const normalized = normalizeGoal({
      id: Date.now(),
      text,
      microGoals: [],
    })
    setGoals(prev => [normalized, ...prev])
    setActiveGoalId(normalized.id)
    localStorage.setItem(activeGoalStorageKey, String(normalized.id))
    return normalized
  }

  async function completeMicroGoal(goalId, microId) {
    const goal = safeGoals.find(item => item.id === goalId)
    if (!goal) return

    const target = goal.microGoals.find(m => m.id === microId)
    if (!target || target.completed) return

    const microGoals = goal.microGoals.map(item =>
      item.id === microId ? { ...item, completed: true } : item
    )
    const updatedGoal = { ...goal, microGoals }
    const allDone = microGoals.length > 0 && microGoals.every(item => item.completed)

    if (allDone) {
      const finishedGoal = { ...updatedGoal, finishedAt: new Date().toISOString() }
      setGoals(prev => prev.filter(item => item.id !== goalId))
      setCompletedGoals(prev => [finishedGoal, ...prev])
      return
    }

    const saved = await updateGoalLocally(updatedGoal)
    setGoals(prev => prev.map(item => (item.id === saved.id ? saved : item)))
  }

  async function refillRecommendationSlotInPlace(removedItemId, savedGoal) {
    const titleText = String(savedGoal?.text || '').trim()
    if (!titleText) return

    const real = recommendations.filter(r => !r.placeholder)
    const idx = real.findIndex(r => r.id === removedItemId)
    if (idx === -1) return

    const t = Date.now()
    const ph = {
      id: `ph-rec-${t}-0`,
      text: '',
      icon: '✨',
      placeholder: true,
    }
    const onScreenTexts = real.filter(r => r.id !== removedItemId).map(r => r.text)

    setRecommendations([...real.slice(0, idx), ph, ...real.slice(idx + 1)])

    try {
      const existingTexts = [
        ...(savedGoal.microGoals || []).map(m => m.text),
        ...onScreenTexts,
      ]
      const fresh = await fetchPreviewMicrogoals(titleText, existingTexts, 1)
      const one = planSuggestedMicroGoals(fresh, savedGoal)[0]
      const textOk = String(one?.text || '').trim()
      setRecommendations(prev => {
        if (!textOk) return prev.filter(r => r.id !== ph.id)
        return prev.map(r =>
          r.id === ph.id && r.placeholder
            ? {
                id: String(one?.id ?? `r-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`),
                text: textOk,
                icon: '✨',
                checkpointOrder: one.checkpointOrder,
                recommendedDate: one.recommendedDate,
                recommendedOffsetDays: one.recommendedOffsetDays ?? null,
                instantEnter: true,
              }
            : r
        )
      })
    } catch (error) {
      console.error('Дозаполнение рекомендаций:', error)
      setRecommendations(prev => prev.filter(r => r.id !== ph.id))
    }
  }

  const requestPreviewSuggestions = useCallback(async sourceText => {
    const trimmed = String(sourceText || '').trim()
    if (!trimmed) return
    setRecommendationsSource(trimmed)
    try {
      const existingTexts = (activeGoal?.microGoals || []).map(item => item.text)
      const clean = await fetchPreviewMicrogoals(trimmed, existingTexts, AI_SUGGEST_SLOTS)
      const planned = planSuggestedMicroGoals(clean, activeGoal)
      setRecommendations(
        planned.map(item => ({
          ...item,
          id: item.id,
          icon: '✨',
        }))
      )
    } catch (error) {
      console.error('Ошибка получения рекомендаций:', error)
      setRecommendations([])
    }
  }, [activeGoal])

  useEffect(() => {
    if (activeTab === 'agenda' && activeGoal?.text) {
      requestPreviewSuggestions(activeGoal.text)
    }
  }, [activeTab, activeGoal?.id, activeGoal?.text, requestPreviewSuggestions])

  async function addRecommendationToActiveGoal(item) {
    if (item.placeholder) return

    setAiError('')
    try {
      let goal = activeGoal
      if (!goal) {
        const title = String(recommendationsSource || '').trim() || 'Моя цель'
        const existing = findGoalByTitle(safeGoals, title)
        if (existing) {
          goal = normalizeGoal(existing)
          setActiveGoalId(existing.id)
          localStorage.setItem(activeGoalStorageKey, String(existing.id))
        } else {
          const created = await createGoal(title)
          if (!created) return
          goal = normalizeGoal(created)
        }
      }

      if (hasSimilarTaskDuplicate(goal, item.text)) return
      const nextMicroGoal = buildAppendedMicroGoal(goal?.microGoals, {
        id: Date.now(),
        text: item.text,
        completed: false,
        suggested: true,
        recommendedDate: item.recommendedDate,
        recommendedOffsetDays: item.recommendedOffsetDays,
      })
      const updatedGoal = {
        ...goal,
        microGoals: [
          ...(goal.microGoals || []),
          nextMicroGoal,
        ],
      }
      const saved = await updateGoalLocally(updatedGoal)
      setGoals(prev => prev.map(g => (g.id === saved.id ? saved : g)))
      await refillRecommendationSlotInPlace(item.id, saved)
    } catch (error) {
      console.error('Рекомендация в повестку:', error)
      setAiError('Не удалось добавить рекомендацию')
    }
  }

  async function handleGenerate(excludeTexts = []) {
    const text = generationInput.trim()
    if (!text) return
    const safeExcludeTexts = Array.isArray(excludeTexts) ? excludeTexts : []

    setIsGenerating(true)
    setAiError('')
    setShowGeneratedResult(true)
    setGeneratedSteps([])

    try {
      const baseGoal =
        findGoalByTitle(safeGoals, text) ||
        (activeGoal && goalTitlesAlign(text, activeGoal.text) ? activeGoal : null)
      const existingTexts = [
        ...safeExcludeTexts,
        ...(baseGoal?.microGoals || []).map(item => item.text),
      ]
      const clean = await fetchPreviewMicrogoals(text, existingTexts, AI_SUGGEST_SLOTS)

      if (clean.length === 0) {
        throw new Error('empty')
      }

      setGeneratedSteps(planSuggestedMicroGoals(clean, baseGoal))
    } catch (error) {
      console.error('Ошибка генерации:', error)
      const m = error?.message
      setAiError(
        m && m !== 'failed' && m !== 'empty'
          ? m
          : 'Не удалось сгенерировать. Попробуйте позже'
      )
      setShowGeneratedResult(false)
    } finally {
      setIsGenerating(false)
    }
  }

  async function addOwnMicroStepToAgenda() {
    const goalTitle = generationInput.trim()
    const t = genCustomInput.trim()
    if (!goalTitle || !t || isAddingOwnStep) return

    setIsAddingOwnStep(true)
    setAiError('')

    try {
      const baseGoal =
        findGoalByTitle(safeGoals, goalTitle) ||
        (activeGoal && goalTitlesAlign(goalTitle, activeGoal.text) ? activeGoal : null)

      if (baseGoal && hasSimilarTaskDuplicate(baseGoal, t)) {
        setAiError('Похожий шаг уже есть в этой цели')
        return
      }

      if (baseGoal) {
        const microGoals = [
          ...(baseGoal.microGoals || []),
          buildAppendedMicroGoal(baseGoal.microGoals, {
            id: Date.now() + Math.floor(Math.random() * 1000),
            text: t,
            completed: false,
            suggested: false,
          }),
        ]
        const updated = await updateGoalLocally({ ...baseGoal, microGoals })
        const savedGoal = normalizeGoal(updated)
        setGoals(prev => prev.map(g => (g.id === savedGoal.id ? savedGoal : g)))
        setActiveGoalId(savedGoal.id)
        localStorage.setItem(activeGoalStorageKey, String(savedGoal.id))
      } else {
        const created = await createGoal(goalTitle)
        if (!created) return
        const microGoals = [
          buildAppendedMicroGoal(created.microGoals, {
            id: Date.now(),
            text: t,
            completed: false,
            suggested: false,
          }),
        ]
        const updated = await updateGoalLocally({
          ...created,
          text: goalTitle,
          microGoals,
        })
        const savedGoal = normalizeGoal(updated)
        if (savedGoal?.id != null) {
          setGoals(prev => prev.map(g => (g.id === savedGoal.id ? savedGoal : g)))
        }
      }

      setGenCustomInput('')
    } catch (error) {
      console.error('Свой микрошаг на повестку:', error)
      setAiError('Не удалось добавить шаг')
    } finally {
      setIsAddingOwnStep(false)
    }
  }

  function beginNewGoalGeneration() {
    setShowGeneratedResult(false)
    setGeneratedSteps([])
    setGenerationInput('')
    setGenCustomInput('')
    setGenRowBusyId(null)
    setIsAddingOwnStep(false)
    setAiError('')
  }

  async function addGeneratedStepToAgendaAndRefill(stepId) {
    const goalTitle = generationInput.trim()
    if (!goalTitle || genRowBusyId) return
    const step = generatedSteps.find(s => s.id === stepId)
    const stepText = String(step?.text || '').trim()
    if (!stepText) return

    const otherPreviewTexts = generatedSteps.filter(s => s.id !== stepId).map(s => s.text)

    setGenRowBusyId(stepId)
    setAiError('')

    try {
      let baseGoal =
        findGoalByTitle(safeGoals, goalTitle) ||
        (activeGoal && goalTitlesAlign(goalTitle, activeGoal.text) ? activeGoal : null)

      let savedGoal = baseGoal ? normalizeGoal(baseGoal) : null

      if (savedGoal && !hasSimilarTaskDuplicate(savedGoal, stepText)) {
        const microGoals = [
          ...(savedGoal.microGoals || []),
          buildAppendedMicroGoal(savedGoal.microGoals, {
            id: Date.now() + Math.floor(Math.random() * 1000),
            text: stepText,
            completed: false,
            suggested: true,
            recommendedDate: step.recommendedDate,
            recommendedOffsetDays: step.recommendedOffsetDays,
          }),
        ]
        const updated = await updateGoalLocally({ ...savedGoal, microGoals })
        savedGoal = normalizeGoal(updated)
        setGoals(prev => prev.map(g => (g.id === savedGoal.id ? savedGoal : g)))
        setActiveGoalId(savedGoal.id)
        localStorage.setItem(activeGoalStorageKey, String(savedGoal.id))
      } else if (!savedGoal) {
        const created = await createGoal(goalTitle)
        if (!created) return
        const microGoals = [
          buildAppendedMicroGoal(created.microGoals, {
            id: Date.now(),
            text: stepText,
            completed: false,
            suggested: true,
            recommendedDate: step.recommendedDate,
            recommendedOffsetDays: step.recommendedOffsetDays,
          }),
        ]
        const updated = await updateGoalLocally({
          ...created,
          text: goalTitle,
          microGoals,
        })
        savedGoal = normalizeGoal(updated)
        if (savedGoal?.id != null) {
          setGoals(prev => prev.map(g => (g.id === savedGoal.id ? savedGoal : g)))
        }
      } else {
        savedGoal = normalizeGoal(
          safeGoals.find(g => g.id === savedGoal.id) || savedGoal
        )
      }

      const existingTexts = [
        ...(savedGoal?.microGoals || []).map(m => m.text),
        ...otherPreviewTexts,
      ].filter(Boolean)

      const fresh = await fetchPreviewMicrogoals(goalTitle, existingTexts, 1)
      const one = planSuggestedMicroGoals(fresh, savedGoal)[0]
      const newText = String(one?.text || '').trim()

      setGeneratedSteps(prev => {
        const idx = prev.findIndex(s => s.id === stepId)
        if (idx === -1) return prev
        if (!newText) {
          return prev.filter(s => s.id !== stepId)
        }
        const next = [...prev]
        next[idx] = {
          id: String(one?.id ?? `s-${Date.now()}-${idx}-${Math.random().toString(16).slice(2, 9)}`),
          text: newText,
          checkpointOrder: one.checkpointOrder,
          recommendedDate: one.recommendedDate,
          recommendedOffsetDays: one.recommendedOffsetDays ?? null,
          instantEnter: true,
        }
        return next
      })
    } catch (error) {
      console.error('Добавление микрошага с экрана генерации:', error)
      setAiError('Не удалось добавить шаг или получить новую подсказку')
    } finally {
      setGenRowBusyId(null)
    }
  }

  async function saveTaskEditor() {
    if (!taskEditor || taskEditorBusy) return
    const text = String(taskDraft || '').trim()
    if (!text) return

    const goal = safeGoals.find(item => item.id === taskEditor.goalId)
    if (!goal) return

    const duplicate = (goal.microGoals || []).some(
      item => item.id !== taskEditor.taskId && textSimilarity(item.text, text) >= 0.65
    )
    if (duplicate) {
      setAiError('Похожий микрошаг уже есть в этой цели')
      return
    }

    setTaskEditorBusy(true)
    try {
      const otherMicroGoals = (goal.microGoals || []).filter(item => item.id !== taskEditor.taskId)
      const microGoals =
        taskEditor.mode === 'create'
          ? [
              ...(goal.microGoals || []),
              buildAppendedMicroGoal(goal.microGoals, {
                id: Date.now() + Math.floor(Math.random() * 1000),
                text,
                completed: false,
                suggested: false,
                recommendedDate: taskDateDraft,
                forceRecommendedDate: true,
              }),
            ]
          : (goal.microGoals || []).map(item =>
              item.id === taskEditor.taskId
                ? normalizeMicroGoal(
                    {
                      ...item,
                      text,
                      recommendedDate:
                        normalizeIsoDate(taskDateDraft) ||
                        inferRecommendedDate(item.checkpointOrder, otherMicroGoals),
                    },
                    0,
                    otherMicroGoals
                  )
                : item
            )

      const saved = normalizeGoal(await updateGoalLocally({ ...goal, microGoals }))
      setGoals(prev => prev.map(item => (item.id === saved.id ? saved : item)))
      closeTaskEditor()
    } catch (error) {
      console.error('Сохранение микрошагa:', error)
      setAiError('Не удалось сохранить микрошаг')
    } finally {
      setTaskEditorBusy(false)
    }
  }

  async function deleteTaskFromGoal(goalId, taskId) {
    const goal = safeGoals.find(item => item.id === goalId)
    if (!goal || taskEditorBusy) return

    setTaskEditorBusy(true)
    try {
      const microGoals = (goal.microGoals || []).filter(item => item.id !== taskId)
      const saved = normalizeGoal(await updateGoalLocally({ ...goal, microGoals }))
      setGoals(prev => prev.map(item => (item.id === saved.id ? saved : item)))
      closeTaskEditor()
    } catch (error) {
      console.error('Удаление микрошагa:', error)
      setAiError('Не удалось удалить микрошаг')
    } finally {
      setTaskEditorBusy(false)
    }
  }

  async function clearCompletedHistory() {
    const confirmed = window.confirm(
      'Удалить всю историю завершённых целей и все активные цели с микрошагами? Это действие нельзя отменить.'
    )
    if (!confirmed) return

    try {
      setCompletedGoals([])
      setGoals([])
      setActiveGoalId(null)
      localStorage.removeItem(activeGoalStorageKey)
      setRecommendations([])
      setRecommendationsSource('')
      resetGenerationUi()
    } catch (error) {
      console.error('Ошибка очистки:', error)
      setAiError('Не удалось очистить данные. Попробуйте позже')
    }
  }

  function saveUserName() {
    const name = String(nameDraft || '').trim()
    if (!name) return
    localStorage.setItem(USER_NAME_KEY, name)
    setUserName(name)
  }

  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  })

  if (!String(userName || '').trim()) {
    return (
      <main className="app-shell onboarding-shell">
        <section className="onboarding-card">
          <div className="logo-badge">✦</div>
          <h1 className="screen-title">Как вас зовут?</h1>
          <p className="secondary-text">Имя появится в профиле; дальше — повестка, генерация и журнал.</p>
          <input
            type="text"
            className="big-input"
            placeholder="Введите имя"
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                saveUserName()
              }
            }}
            autoFocus
            autoComplete="name"
          />
          <button
            type="button"
            className="primary-button"
            disabled={!String(nameDraft || '').trim()}
            onClick={saveUserName}
          >
            Продолжить
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      {!isOnline && <div className="banner-error">Нет соединения. Работаем офлайн</div>}
      {aiError && <div className="banner-error">{aiError}</div>}

      {!showProfile && activeTab === 'agenda' && (
        <section className="screen screen--agenda">
          <header className="screen-header">
            <div>
              <h1>{today}</h1>
              <small>⚡ {utilization}</small>
            </div>
            <button className="icon-button" onClick={() => setShowProfile(true)}>
              ⚙️
            </button>
          </header>

          <div className="agenda-layout">
            <div className="agenda-column agenda-column--main">
              <div className="section-heading-row">
                <h2>{safeGoals.length > 1 ? 'Текущие цели' : 'Моя основная цель'}</h2>
                {safeGoals.length > 1 && activeGoal && (
                  <span className="goal-pill" aria-live="polite">
                    {safeGoals.findIndex(g => g.id === activeGoal.id) + 1} / {safeGoals.length}
                  </span>
                )}
              </div>

              <div
                role={safeGoals.length > 1 && activeGoal ? 'region' : undefined}
                aria-label={safeGoals.length > 1 && activeGoal ? 'Текущая цель, листайте свайпом' : undefined}
                tabIndex={safeGoals.length > 1 && activeGoal ? 0 : undefined}
                className={`goal-hero-card ${safeGoals.length > 1 ? 'goal-hero-card--switchable' : ''}`}
                onKeyDown={
                  safeGoals.length > 1 && activeGoal
                    ? e => {
                        if (e.key === 'ArrowLeft') {
                          e.preventDefault()
                          switchActiveGoal(-1)
                        } else if (e.key === 'ArrowRight') {
                          e.preventDefault()
                          switchActiveGoal(1)
                        }
                      }
                    : undefined
                }
                onTouchStart={
                  safeGoals.length > 1 && activeGoal
                    ? e => {
                        goalSwipe.current.x = e.targetTouches[0].clientX
                      }
                    : undefined
                }
                onTouchEnd={
                  safeGoals.length > 1 && activeGoal
                    ? e => {
                        const start = goalSwipe.current.x
                        if (start == null) return
                        const end = e.changedTouches[0].clientX
                        const dx = end - start
                        goalSwipe.current.x = null
                        if (Math.abs(dx) < 48) return
                        if (dx < 0) switchActiveGoal(1)
                        else switchActiveGoal(-1)
                      }
                    : undefined
                }
              >
                {!activeGoal ? (
                  <p className="secondary-text goal-hero-empty">
                    Пока нет целей. Откройте ✨ Генерацию и добавьте первую.
                  </p>
                ) : (
                  <div className="goal-hero-top">
                    <div className="goal-hero-text-block">
                      <p className="goal-hero-title">{activeGoal.text}</p>
                      {safeGoals.length <= 1 && (
                        <p className="secondary-text goal-hero-hint">
                          Добавьте вторую цель в ✨ Генерации — появятся стрелки для переключения.
                        </p>
                      )}
                    </div>
                    {safeGoals.length > 1 && (
                      <div className="goal-hero-arrows" role="group" aria-label="Переключение цели">
                        <button
                          type="button"
                          className="goal-arrow"
                          aria-label="Предыдущая цель"
                          onClick={() => switchActiveGoal(-1)}
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          className="goal-arrow"
                          aria-label="Следующая цель"
                          onClick={() => switchActiveGoal(1)}
                        >
                          ›
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <h2 className="section-h2-tight">Микрошаги</h2>
              {activeGoal && (
                <p className="secondary-text section-subline">под цель «{activeGoal.text}»</p>
              )}
              {activeGoal && (
                <button
                  type="button"
                  className="text-button section-inline-action"
                  onClick={() => openTaskEditor(activeGoal.id)}
                >
                  + Добавить свой микрошаг
                </button>
              )}
              {!activeGoal || agendaMicroTasks.length === 0 ? (
                <p className="secondary-text">
                  {activeGoal
                    ? 'Нет микрошагов для этой цели. Нажмите [+] чтобы добавить или сгенерировать'
                    : 'Выберите цель выше — здесь появятся её шаги'}
                </p>
              ) : (
                <div className="tasks-grid">
                  {agendaMicroTasks.map((task, index) => (
                    <article
                      key={task.id}
                      className="task-card micro-appear"
                      style={{ '--appear-i': index }}
                    >
                      <button
                        type="button"
                        className="task-card-main"
                        onClick={() => openTaskEditor(activeGoal.id, task)}
                      >
                        <span className="task-card-check">☐</span>
                        <strong>{task.text}</strong>
                      </button>
                      <div className="task-card-actions">
                        <label
                          className={`task-date-button ${isRecommendedDatePassed(task) ? 'task-date-button--overdue' : ''}`}
                        >
                          {task.recommendedDate
                            ? `Дата: ${formatRecommendedDate(task.recommendedDate)}`
                            : 'Выбрать дату'}
                          <input
                            type="date"
                            className="task-date-native"
                            value={normalizeIsoDate(task.recommendedDate)}
                            onChange={e => saveTaskDate(activeGoal.id, task.id, e.target.value)}
                          />
                        </label>
                      </div>
                      {isRecommendedDatePassed(task) && (
                        <span className="task-card-warning">Рекомендованная дата уже прошла</span>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <aside className="agenda-column agenda-column--side">
              <h2 className="section-h2-tight">Рекомендации ассистента</h2>
              {activeGoal && (
                <p className="secondary-text section-subline">под цель «{activeGoal.text}»</p>
              )}
              <div className="recommendations-row">
                {recommendations.length === 0 ? (
                  <p className="secondary-text">
                    {!activeGoal
                      ? 'Добавьте цель — здесь появятся идеи ИИ именно для неё'
                      : 'Пока нет рекомендаций ИИ для этой цели. Смените цель — подгрузим идеи для другой'}
                  </p>
                ) : (
                  recommendations.map((item, index) =>
                    item.placeholder ? (
                      <article
                        key={item.id}
                        className="recommendation-card recommendation-card--placeholder micro-appear-instant"
                      >
                        <div className="rec-placeholder-shine" aria-hidden />
                      </article>
                    ) : (
                      <article
                        key={item.id}
                        className={`recommendation-card ${item.instantEnter ? 'micro-appear-instant' : 'micro-appear'}`}
                        style={item.instantEnter ? undefined : { '--appear-i': index }}
                      >
                        <div className="recommendation-icon">{item.icon}</div>
                        {item.recommendedDate && (
                          <span className="checkpoint-date-chip">
                            до {formatRecommendedDate(item.recommendedDate)}
                          </span>
                        )}
                        <p>{item.text}</p>
                        <button type="button" onClick={() => addRecommendationToActiveGoal(item)}>
                          ➕
                        </button>
                      </article>
                    )
                  )
                )}
              </div>
              {activeGoal && (
                <button
                  type="button"
                  className="secondary-button side-action-button"
                  onClick={() => openTaskEditor(activeGoal.id)}
                >
                  Добавить шаг вручную
                </button>
              )}
            </aside>
          </div>

          <button className="fab" onClick={() => setActiveTab('generate')}>
            +
          </button>
        </section>
      )}

      {!showProfile && activeTab === 'generate' && (
        <section className="screen screen--generate">
          <header className="screen-header">
            <button className="text-button" onClick={() => setActiveTab('agenda')}>
              ← Назад
            </button>
            <h1>{showGeneratedResult ? 'Результат' : 'Генерация'}</h1>
            <div />
          </header>

          {!showGeneratedResult && (
            <>
              <div className="empty-space" />
              <h2 className="center-title">Что нужно разбить на микрошаги?</h2>
              <textarea
                className="big-input"
                value={generationInput}
                onChange={e => setGenerationInput(e.target.value)}
                placeholder="Напишите задачу или опишите контекст"
              />
              {activeGoal && (
                <p className="secondary-text generation-goal-hint">
                  {!generationInput.trim()
                    ? `Если тема совпадёт с «${activeGoal.text}», шаги добавятся к ней; иначе появится новая цель.`
                    : goalTitlesAlign(generationInput.trim(), activeGoal.text)
                      ? `Микрошаги добавятся к текущей цели «${activeGoal.text}».`
                      : `Будет отдельная цель «${generationInput.trim()}» (не «${activeGoal.text}»).`}
                </p>
              )}
              <p className="secondary-text">
                Примеры: «Подготовиться к экзамену», «Навести порядок дома», «Начать бегать по утрам»
              </p>
              <button
                className="primary-button"
                disabled={isGenerating}
                onClick={() => handleGenerate()}
              >
                {isGenerating ? 'Генерируем…' : 'Сгенерировать'}
              </button>
            </>
          )}

          {showGeneratedResult && (
            <div className="fade-in gen-result">
              <div className="result-goal-header">
                <p className="secondary-text result-source-line">
                  Исходная задача: «{generationInput}»
                </p>
                <button
                  type="button"
                  className="text-button result-new-goal-link"
                  disabled={isGenerating || isAddingOwnStep}
                  onClick={beginNewGoalGeneration}
                >
                  Новая цель для микрошагов
                </button>
              </div>

              <div className="gen-ai-heading">
                <h2 className="gen-micro-title">Микрошаги, сгенерированные ИИ</h2>
                <p className="secondary-text gen-ai-sub">Подсказки модели по задаче выше — добавляйте по одной кнопкой «+»</p>
              </div>

              {isGenerating && (
                <div className="skeleton-wrap">
                  <div className="skeleton-card" />
                  <div className="skeleton-card" />
                  <div className="skeleton-card" />
                </div>
              )}

              {!isGenerating && (
                <ul className="gen-step-list">
                  {generatedSteps.map((step, index) => (
                    <li
                      key={step.id}
                      className={`gen-step-row ${step.instantEnter ? 'micro-appear-instant' : 'micro-appear'} ${genRowBusyId === step.id ? 'gen-step-row--busy' : ''}`}
                      style={step.instantEnter ? undefined : { '--appear-i': index }}
                    >
                      <span className="gen-step-num">{index + 1}.</span>
                      <div className="gen-step-main">
                        {step.recommendedDate && (
                          <span className="checkpoint-date-chip">
                            до {formatRecommendedDate(step.recommendedDate)}
                          </span>
                        )}
                        <span className="gen-step-text">{step.text}</span>
                      </div>
                      <div className="gen-step-actions">
                        <button
                          type="button"
                          className="gen-step-icon-btn gen-step-add-btn"
                          aria-label="Добавить в повестку и сгенерировать новый шаг"
                          disabled={
                            isGenerating || isAddingOwnStep || genRowBusyId === step.id
                          }
                          onClick={() => addGeneratedStepToAgendaAndRefill(step.id)}
                        >
                          {genRowBusyId === step.id ? '…' : '+'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {!isGenerating && (
                <div className="gen-own-row">
                  <input
                    type="text"
                    className="gen-own-input"
                    placeholder="Добавить свой микрошаг…"
                    value={genCustomInput}
                    onChange={e => setGenCustomInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addOwnMicroStepToAgenda()
                      }
                    }}
                    disabled={isAddingOwnStep}
                  />
                  <button
                    type="button"
                    className="gen-step-icon-btn gen-step-add-btn gen-own-add-btn"
                    aria-label="Добавить свой шаг на повестку"
                    disabled={isAddingOwnStep || !genCustomInput.trim()}
                    onClick={addOwnMicroStepToAgenda}
                  >
                    {isAddingOwnStep ? '…' : '+'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {!showProfile && activeTab === 'journal' && (
        <section className="screen screen--journal journal-screen">
          <header className="screen-header">
            <div>
              <h1>Статистика</h1>
              <small className="journal-subtitle">
                Завершённые цели за 7 дней · {journalRangeLabel}
              </small>
            </div>
          </header>

          <h2 className="journal-section-title">Завершённые цели по дням</h2>
          {!journalBars.hasData ? (
            <div className="journal-empty-card">
              <p className="journal-empty-title">Пока пусто</p>
              <p className="secondary-text">
                На повестке отметьте все микрошаги цели — она попадёт сюда, и график заполнится.
              </p>
            </div>
          ) : (
            <div className="bars-wrap bars-wrap--journal">
              {journalBars.strip.map((slot, index) => (
                <div key={slot.date.getTime()} className="bar-col">
                  <div
                    className={`bar ${journalBars.values[index] === 0 ? 'bar--empty' : ''}`}
                    style={{ height: `${journalBars.heights[index]}px` }}
                  />
                  <small className="bar-weekday">{slot.weekday}</small>
                  <small className="bar-daynum">{slot.dayNum}</small>
                  <small className="bar-count">{journalBars.values[index]}</small>
                </div>
              ))}
            </div>
          )}

          <h2 className="journal-section-title journal-micro-h2">Микрошаги</h2>
          <div className="card journal-efficiency-card">
            {!efficiencyStats.hasData ? (
              <div className="journal-efficiency-empty">
                <p className="secondary-text">
                  Когда появятся микрошаги на повестке или в истории, здесь будут доли «Сделано» и «В работе».
                </p>
              </div>
            ) : (
              <ul className="journal-efficiency-list journal-micro-simple">
                <li>
                  <span className="eff-dot eff-dot--ai" />
                  Сделано — <strong>{efficiencyStats.done}%</strong>
                </li>
                <li>
                  <span className="eff-dot eff-dot--pending" />
                  В работе — <strong>{efficiencyStats.pending}%</strong>
                </li>
              </ul>
            )}
          </div>

          <div className="journal-history-head">
            <h2 className="journal-section-title journal-section-title--inline">История</h2>
            <button type="button" className="text-button journal-clear-btn" onClick={clearCompletedHistory}>
              Очистить
            </button>
          </div>
          {historyItems.length === 0 ? (
            <p className="secondary-text journal-history-empty">
              Завершённые цели появятся здесь с датой и временем.
            </p>
          ) : (
            <div className="journal-history-list">
              {historyItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`history-row history-row--rich ${expandedHistoryId === item.id ? 'history-row--expanded' : ''}`}
                  onClick={() => setExpandedHistoryId(prev => (prev === item.id ? null : item.id))}
                >
                  <div className="history-row-main">
                    <span className="history-check">✓</span>
                    <span className="history-title">{item.text}</span>
                  </div>
                  <div className="history-meta">
                    <span>{item.dateStr}</span>
                    <span className="history-meta-sep">·</span>
                    <span>{item.timeStr}</span>
                    {item.stepsCount > 0 && (
                      <>
                        <span className="history-meta-sep">·</span>
                        <span>микрошагов: {item.stepsCount}</span>
                      </>
                    )}
                  </div>
                  {expandedHistoryId === item.id && (
                    <div className="history-details">
                      {item.microGoals.length === 0 ? (
                        <p className="secondary-text history-details-empty">Для этой цели микрошаги не сохранены.</p>
                      ) : (
                        <ul className="history-steps-list">
                          {item.microGoals.map(step => (
                            <li key={step.id}>
                              <span className={`history-step-mark ${step.completed ? 'history-step-mark--done' : ''}`}>
                                {step.completed ? '✓' : '•'}
                              </span>
                              <div className="history-step-body">
                                <span>{step.text}</span>
                                <div className="history-step-meta">
                                  {step.recommendedDate && (
                                    <span>до {formatRecommendedDate(step.recommendedDate, { day: 'numeric', month: 'long' })}</span>
                                  )}
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {showProfile && (
        <section className="screen screen--profile">
          <header className="screen-header">
            <button className="text-button" onClick={() => setShowProfile(false)}>
              ← Повестка
            </button>
            <h1>Настройки</h1>
            <div />
          </header>
          <div className="profile-head">
            <div className="avatar">Аватар</div>
            <strong>{userName || 'Без имени'}</strong>
            <small>user@email.com</small>
          </div>
          <button
            type="button"
            className="text-button profile-change-name"
            onClick={() => {
              localStorage.removeItem(USER_NAME_KEY)
              setUserName('')
              setNameDraft('')
              setShowProfile(false)
            }}
          >
            Сменить имя
          </button>
          <div className="settings-list">
            <div className="list-row"><span>Режим работы</span><span>{settings.mode}</span></div>
            <button className="list-row" onClick={() => setSettings(s => ({ ...s, calendarAccess: !s.calendarAccess }))}>
              <span>Доступ к календарю</span><span>{settings.calendarAccess ? 'Вкл' : 'Выкл'}</span>
            </button>
            <button className="list-row" onClick={() => setSettings(s => ({ ...s, geoAccess: !s.geoAccess }))}>
              <span>Геолокация</span><span>{settings.geoAccess ? 'Вкл' : 'Выкл'}</span>
            </button>
            <button className="list-row" onClick={() => setSettings(s => ({ ...s, notifications: !s.notifications }))}>
              <span>Уведомления</span><span>{settings.notifications ? 'Вкл' : 'Выкл'}</span>
            </button>
            <div className="list-row"><span>О приложении</span><span>{'>'}</span></div>
            <div className="list-row"><span>Экспорт данных</span><span>{'>'}</span></div>
          </div>
          <button className="secondary-button">Выйти</button>
        </section>
      )}

      {!showProfile && (
        <nav className="tab-bar">
          <button className={activeTab === 'agenda' ? 'active' : ''} onClick={() => setActiveTab('agenda')}>
            ⚑ Повестка
          </button>
          <button
            className={activeTab === 'generate' ? 'active' : ''}
            onClick={() => {
              setActiveTab('generate')
              requestPreviewSuggestions(generationInput || activeGoal?.text || '')
            }}
          >
            ✨ Генерация
          </button>
          <button className={activeTab === 'journal' ? 'active' : ''} onClick={() => setActiveTab('journal')}>
            📅 Журнал
          </button>
        </nav>
      )}

      {taskEditor && (
        <div className="modal-backdrop" onClick={closeTaskEditor}>
          <section
            className="task-modal"
            role="dialog"
            aria-modal="true"
            aria-label={taskEditor.mode === 'create' ? 'Новый микрошаг' : 'Редактирование микрошагa'}
            onClick={e => e.stopPropagation()}
          >
            <div className="task-modal-head">
              <h2>{taskEditor.mode === 'create' ? 'Новый микрошаг' : 'Микрошаг'}</h2>
              <button type="button" className="icon-button" onClick={closeTaskEditor}>
                ✕
              </button>
            </div>
            <textarea
              className="big-input task-modal-input"
              value={taskDraft}
              onChange={e => setTaskDraft(e.target.value)}
              placeholder="Опишите шаг"
              autoFocus
            />
            <div className="task-modal-field">
              <label htmlFor="task-recommended-date" className="task-modal-label">
                Дата
              </label>
              <input
                id="task-recommended-date"
                type="date"
                className="task-date-input"
                value={taskDateDraft}
                onChange={e => setTaskDateDraft(e.target.value)}
              />
            </div>
            <div className="task-modal-actions">
              {editingTask && (
                <button
                  type="button"
                  className="success-button"
                  disabled={taskEditorBusy || editingTask.completed}
                  onClick={async () => {
                    await completeMicroGoal(taskEditor.goalId, editingTask.id)
                    closeTaskEditor()
                  }}
                >
                  Отметить выполненным
                </button>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={taskEditorBusy || !String(taskDraft || '').trim()}
                onClick={saveTaskEditor}
              >
                Сохранить
              </button>
              {editingTask && (
                <button
                  type="button"
                  className="danger-button"
                  disabled={taskEditorBusy}
                  onClick={() => deleteTaskFromGoal(taskEditor.goalId, editingTask.id)}
                >
                  Удалить
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
