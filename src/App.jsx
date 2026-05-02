import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Briefcase,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  ChartBar,
  Gear,
  GraduationCap,
  Leaf,
  Lightning,
  ListBullets,
  Plus,
  Sparkle,
  Target,
  X,
} from '@phosphor-icons/react'
import Analytics from './components/Analytics'
import { normalizeGoalCategory, resolveGoalCreatedAt } from './utils/statistics'

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
const RECENT_GENERATIONS_KEY = 'goal_tracker_recent_generations'
const PROFILE_ID_KEY = 'goal_tracker_profile_id'
const USER_NAME_KEY = 'goal_tracker_user_name'
const USER_EMAIL_KEY = 'goal_tracker_user_email'
const AUTH_TOKEN_KEY = 'goal_tracker_auth_token'
const RESET_CODE_LENGTH = 6
const GENERATION_INPUT_LIMIT = 300

/** Сколько подсказок ИИ держим на экране (после добавления одной — дозаполняем до этого числа). */
const AI_SUGGEST_SLOTS = 3
const CHECKPOINT_GAP_DAYS = [3, 4, 7, 7, 14, 14, 21]
const GENERATION_EXAMPLES = [
  'Подготовиться к диплому',
  'Начать бегать по утрам',
  'Изучить английский',
  'Прочитать книгу',
]

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))
}

function isValidResetCode(code) {
  return new RegExp(`^\\d{${RESET_CODE_LENGTH}}$`).test(String(code || '').trim())
}

async function apiRequest(path, { method = 'GET', body, sessionToken } = {}) {
  const headers = {}
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (sessionToken) {
    headers['x-session-token'] = sessionToken
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (!response.ok) {
    const msg = await parseApiErrorMessage(response)
    throw new Error(msg || 'failed')
  }

  if (response.status === 204) return null
  return response.json()
}

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

  const completed = Boolean(item.completed)
  const rawAt = String(item.completedAt || '').trim()
  return {
    ...item,
    completed,
    completedAt: completed ? rawAt || null : null,
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

function formatRecentGenerationDate(dateStr) {
  const date = new Date(dateStr || Date.now())
  if (Number.isNaN(date.getTime())) return 'только что'
  return date.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
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

function GoalCategoryIcon({ category, size = 22 }) {
  const p = { size, weight: 'regular', 'aria-hidden': true }
  if (category === 'Учёба') return <GraduationCap {...p} />
  if (category === 'Работа') return <Briefcase {...p} />
  if (category === 'Личное') return <Leaf {...p} />
  return <Target {...p} />
}

function getRecommendationCacheKey(goal, sourceText = '') {
  const goalId = goal?.id
  if (goalId != null && Number.isFinite(Number(goalId))) {
    return `goal:${goalId}`
  }

  const trimmed = String(sourceText || '').trim()
  return trimmed ? `text:${normalizeTaskText(trimmed)}` : ''
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

function sanitizeRecentGenerationStep(step, index) {
  const text = String(step?.text || step?.title || '').trim()
  if (!text) return null
  return {
    id: String(step?.id ?? `recent-step-${index}`),
    text,
    recommendedDate: normalizeIsoDate(step?.recommendedDate),
    recommendedOffsetDays: Number.isFinite(Number(step?.recommendedOffsetDays))
      ? Math.max(0, Math.trunc(Number(step.recommendedOffsetDays)))
      : null,
    checkpointOrder: Number.isFinite(Number(step?.checkpointOrder))
      ? Math.max(1, Math.trunc(Number(step.checkpointOrder)))
      : null,
  }
}

function readScopedRecentGenerations(userKey) {
  const raw = localStorage.getItem(makeScopedStorageKey(RECENT_GENERATIONS_KEY, userKey))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed
          .map(item => {
            const title = String(item?.title || '').trim()
            const steps = (Array.isArray(item?.steps) ? item.steps : [])
              .map(sanitizeRecentGenerationStep)
              .filter(Boolean)
            if (!title || steps.length === 0) return null
            return {
              id: String(item?.id || `recent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
              title,
              createdAt: String(item?.createdAt || new Date().toISOString()),
              steps,
            }
          })
          .filter(Boolean)
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

async function fetchGoalCategory(text) {
  const response = await fetch(`${API_URL}/api/classify-goal-category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) {
    const msg = await parseApiErrorMessage(response)
    throw new Error(msg || 'failed')
  }
  const payload = await response.json()
  return normalizeGoalCategory(payload?.category, text)
}

function normalizeGoal(goal) {
  if (goal == null) return null
  const text = String(goal.text || goal.title || '').trim()
  const finishedAt = String(goal.finishedAt || goal.completedAt || '').trim() || null
  return {
    ...goal,
    text,
    category: normalizeGoalCategory(goal.category, text),
    createdAt: resolveGoalCreatedAt(goal),
    finishedAt,
    completedAt: finishedAt,
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
  const initialUserEmail = normalizeEmail(localStorage.getItem(USER_EMAIL_KEY) || '')
  const initialAuthToken = String(localStorage.getItem(AUTH_TOKEN_KEY) || '').trim()
  const initialProfileId = ensureProfileId()
  const initialStorageScope = initialUserEmail || initialProfileId
  const [goals, setGoals] = useState(() => readScopedGoalList(GOALS_KEY, initialStorageScope))
  const [completedGoals, setCompletedGoals] = useState(() =>
    readScopedGoalList(COMPLETED_GOALS_KEY, initialStorageScope)
  )
  const [activeGoalId, setActiveGoalId] = useState(() => {
    const raw = localStorage.getItem(makeScopedStorageKey(ACTIVE_GOAL_KEY, initialStorageScope))
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
  const [userEmail, setUserEmail] = useState(() => initialUserEmail)
  const [nameDraft, setNameDraft] = useState(() => initialUserName)
  const [emailDraft, setEmailDraft] = useState(() => initialUserEmail)
  const [authToken, setAuthToken] = useState(() => initialAuthToken)
  const [authMode, setAuthMode] = useState('login')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [passwordRepeatDraft, setPasswordRepeatDraft] = useState('')
  const [resetStage, setResetStage] = useState('request')
  const [resetCodeDraft, setResetCodeDraft] = useState('')
  const [resetNewPasswordDraft, setResetNewPasswordDraft] = useState('')
  const [resetNewPasswordRepeatDraft, setResetNewPasswordRepeatDraft] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authChecked, setAuthChecked] = useState(() => !initialAuthToken)
  const [authError, setAuthError] = useState('')
  const [authInfo, setAuthInfo] = useState('')

  const [generationInput, setGenerationInput] = useState('')
  const [generatedSteps, setGeneratedSteps] = useState([])
  const [recentGenerations, setRecentGenerations] = useState(() =>
    readScopedRecentGenerations(initialStorageScope)
  )
  const [isGenerating, setIsGenerating] = useState(false)
  const [showGeneratedResult, setShowGeneratedResult] = useState(false)
  const [genCustomInput, setGenCustomInput] = useState('')
  const [genCustomDateDraft, setGenCustomDateDraft] = useState('')
  const [genRowBusyId, setGenRowBusyId] = useState(null)
  const [generatedDateEditor, setGeneratedDateEditor] = useState(null)
  const [isAddingOwnStep, setIsAddingOwnStep] = useState(false)
  const [taskEditor, setTaskEditor] = useState(null)
  const [taskDraft, setTaskDraft] = useState('')
  const [taskDateDraft, setTaskDateDraft] = useState('')
  const [taskEditorBusy, setTaskEditorBusy] = useState(false)
  const [inlineEditTaskId, setInlineEditTaskId] = useState(null)
  const [inlineEditText, setInlineEditText] = useState('')
  const [inlineEditBusy, setInlineEditBusy] = useState(false)
  const [recommendationsCache, setRecommendationsCache] = useState({})
  const [highlightedTaskIds, setHighlightedTaskIds] = useState([])
  const generatedDateInputRef = useRef(null)
  const generationInputRef = useRef(null)
  const agendaTasksRef = useRef(null)

  const normalizedUserEmail = normalizeEmail(userEmail)
  const sessionToken = String(authToken || '').trim()
  const storageScope = normalizedUserEmail || initialProfileId
  const hasAccountAccess = Boolean(sessionToken)
  const isAuthenticated =
    authChecked &&
    Boolean(sessionToken) &&
    Boolean(String(userName || '').trim()) &&
    isValidEmail(normalizedUserEmail)
  const canSubmitLogin = isValidEmail(emailDraft) && String(passwordDraft || '').length >= 8
  const canSubmitRegister =
    Boolean(String(nameDraft || '').trim()) &&
    isValidEmail(emailDraft) &&
    String(passwordDraft || '').length >= 8 &&
    passwordDraft === passwordRepeatDraft
  const canSubmitResetRequest = isValidEmail(emailDraft)
  const canSubmitResetConfirm =
    isValidEmail(emailDraft) &&
    isValidResetCode(resetCodeDraft) &&
    String(resetNewPasswordDraft || '').length >= 8 &&
    resetNewPasswordDraft === resetNewPasswordRepeatDraft
  const activeGoalStorageKey = useMemo(
    () => makeScopedStorageKey(ACTIVE_GOAL_KEY, storageScope),
    [storageScope]
  )
  const goalsStorageKey = useMemo(() => makeScopedStorageKey(GOALS_KEY, storageScope), [storageScope])
  const completedGoalsStorageKey = useMemo(
    () => makeScopedStorageKey(COMPLETED_GOALS_KEY, storageScope),
    [storageScope]
  )

  function resetGenerationUi() {
    setGenerationInput('')
    setGeneratedSteps([])
    setShowGeneratedResult(false)
    setGenCustomInput('')
    setGenCustomDateDraft('')
    setIsGenerating(false)
    setGenRowBusyId(null)
    setGeneratedDateEditor(null)
    setIsAddingOwnStep(false)
  }

  function resetRecoveryFlow({ keepEmail = true } = {}) {
    setResetStage('request')
    setResetCodeDraft('')
    setResetNewPasswordDraft('')
    setResetNewPasswordRepeatDraft('')
    if (!keepEmail) {
      setEmailDraft('')
    }
  }

  useEffect(() => {
    if (!generatedDateEditor) return
    const frame = requestAnimationFrame(() => {
      const input = generatedDateInputRef.current
      if (!input) return
      input.focus()
      try {
        input.showPicker?.()
      } catch {
        /* noop */
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [generatedDateEditor])

  useEffect(() => {
    if (activeTab !== 'generate' || showGeneratedResult) return
    const frame = requestAnimationFrame(() => {
      generationInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [activeTab, showGeneratedResult])

  useEffect(() => {
    if (highlightedTaskIds.length === 0) return undefined
    const frame = requestAnimationFrame(() => {
      agendaTasksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    const timeout = window.setTimeout(() => setHighlightedTaskIds([]), 3600)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
    }
  }, [highlightedTaskIds])

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
    if (userName) localStorage.setItem(USER_NAME_KEY, userName)
    else localStorage.removeItem(USER_NAME_KEY)
  }, [userName])

  useEffect(() => {
    if (normalizedUserEmail) localStorage.setItem(USER_EMAIL_KEY, normalizedUserEmail)
    else localStorage.removeItem(USER_EMAIL_KEY)
  }, [normalizedUserEmail])

  useEffect(() => {
    if (sessionToken) localStorage.setItem(AUTH_TOKEN_KEY, sessionToken)
    else localStorage.removeItem(AUTH_TOKEN_KEY)
  }, [sessionToken])

  useEffect(() => {
    let cancelled = false

    if (!sessionToken) {
      setAuthChecked(true)
      return undefined
    }

    setAuthChecked(false)
    async function loadCurrentUser() {
      try {
        const payload = await apiRequest('/api/auth/me', { sessionToken })
        if (cancelled) return

        const nextName = String(payload?.user?.name || '').trim()
        const nextEmail = normalizeEmail(payload?.user?.email)
        if (!nextName || !isValidEmail(nextEmail)) {
          throw new Error('bad-session')
        }

        setUserName(nextName)
        setUserEmail(nextEmail)
        setNameDraft(nextName)
        setEmailDraft(nextEmail)
        setAuthError('')
        setAuthInfo('')
      } catch (error) {
        if (cancelled) return
        console.error('Проверка сессии:', error)
        localStorage.removeItem(AUTH_TOKEN_KEY)
        localStorage.removeItem(USER_NAME_KEY)
        localStorage.removeItem(USER_EMAIL_KEY)
        setAuthToken('')
        setUserName('')
        setUserEmail('')
        setNameDraft('')
        setEmailDraft('')
        setAuthError('Сессия истекла. Войдите снова.')
        setAuthInfo('')
      } finally {
        if (!cancelled) {
          setAuthChecked(true)
        }
      }
    }

    loadCurrentUser()
    return () => {
      cancelled = true
    }
  }, [sessionToken])

  useEffect(() => {
    const rawActiveGoalId = localStorage.getItem(makeScopedStorageKey(ACTIVE_GOAL_KEY, storageScope))
    if (!rawActiveGoalId || rawActiveGoalId === 'undefined' || rawActiveGoalId === 'null') {
      setActiveGoalId(null)
    } else {
      const nextActiveGoalId = Number(rawActiveGoalId)
      setActiveGoalId(Number.isFinite(nextActiveGoalId) ? nextActiveGoalId : null)
    }
    setGoals(readScopedGoalList(GOALS_KEY, storageScope))
    setCompletedGoals(readScopedGoalList(COMPLETED_GOALS_KEY, storageScope))
    setRecentGenerations(readScopedRecentGenerations(storageScope))
    setRecommendations([])
    setRecommendationsSource('')
    setRecommendationsCache({})
    setHighlightedTaskIds([])
    setTaskEditor(null)
    setTaskDraft('')
    setTaskDateDraft('')
    setTaskEditorBusy(false)
    cancelInlineTaskEdit()
    setGenerationInput('')
    setGeneratedSteps([])
    setShowGeneratedResult(false)
    setGenCustomInput('')
    setGenCustomDateDraft('')
    setIsGenerating(false)
    setGenRowBusyId(null)
    setGeneratedDateEditor(null)
    setIsAddingOwnStep(false)
  }, [storageScope])

  useEffect(() => {
    let cancelled = false
    if (!hasAccountAccess || !authChecked) return undefined

    async function loadAccountData() {
      try {
        const [remoteGoals, remoteCompletedGoals] = await Promise.all([
          apiRequest('/api/goals', { sessionToken }),
          apiRequest('/api/completed-goals', { sessionToken }),
        ])
        if (cancelled) return
        setGoals(Array.isArray(remoteGoals) ? remoteGoals.map(normalizeGoal) : [])
        setCompletedGoals(
          Array.isArray(remoteCompletedGoals)
            ? remoteCompletedGoals.map(normalizeGoal)
            : []
        )
      } catch (error) {
        console.error('Ошибка загрузки аккаунта:', error)
      }
    }

    loadAccountData()
    return () => {
      cancelled = true
    }
  }, [authChecked, hasAccountAccess, sessionToken])

  useEffect(() => {
    localStorage.setItem(goalsStorageKey, JSON.stringify(goals))
  }, [goals, goalsStorageKey])

  useEffect(() => {
    localStorage.setItem(completedGoalsStorageKey, JSON.stringify(completedGoals))
  }, [completedGoals, completedGoalsStorageKey])

  useEffect(() => {
    localStorage.setItem(
      makeScopedStorageKey(RECENT_GENERATIONS_KEY, storageScope),
      JSON.stringify(recentGenerations)
    )
  }, [recentGenerations, storageScope])

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

  const activeGoal = useMemo(
    () => normalizeGoal(safeGoals.find(g => g.id === activeGoalId) ?? null),
    [safeGoals, activeGoalId]
  )

  const agendaMicroTasks = useMemo(() => {
    const list = activeGoal?.microGoals
    if (!Array.isArray(list)) return []
    return [...list].sort((a, b) => {
      if (Boolean(a.completed) !== Boolean(b.completed)) {
        return Number(a.completed) - Number(b.completed)
      }
      return compareMicroGoalsByCheckpoint(a, b)
    })
  }, [activeGoal])

  const activeGoalProgress = useMemo(() => {
    const total = activeGoal?.microGoals?.length || 0
    const completedCount = (activeGoal?.microGoals || []).filter(item => item.completed).length
    const percent = total === 0 ? 0 : Math.round((completedCount / total) * 100)
    return { total, completedCount, percent }
  }, [activeGoal])

  const agendaRecommendations = useMemo(() => {
    if (!activeGoal?.text) return []

    const activeGoalText = normalizeTaskText(activeGoal.text)
    const sourceText = normalizeTaskText(recommendationsSource)
    if (!sourceText || sourceText !== activeGoalText) return []

    return (Array.isArray(recommendations) ? recommendations : []).slice(0, AI_SUGGEST_SLOTS)
  }, [activeGoal?.text, recommendations, recommendationsSource])

  function setCurrentGoal(goalId) {
    setActiveGoalId(goalId)
    localStorage.setItem(activeGoalStorageKey, String(goalId))
  }

  function replaceGoalInState(nextGoal) {
    if (!nextGoal?.id) return
    setGoals(prev => {
      const exists = prev.some(item => item.id === nextGoal.id)
      return exists ? prev.map(item => (item.id === nextGoal.id ? nextGoal : item)) : [nextGoal, ...prev]
    })
  }

  function rememberGeneration(title, steps) {
    const safeTitle = String(title || '').trim()
    const safeSteps = (Array.isArray(steps) ? steps : [])
      .map(sanitizeRecentGenerationStep)
      .filter(Boolean)
    if (!safeTitle || safeSteps.length === 0) return
    const entry = {
      id: `recent-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      title: safeTitle,
      createdAt: new Date().toISOString(),
      steps: safeSteps,
    }
    setRecentGenerations(prev => [entry, ...prev.filter(item => item.title !== safeTitle)].slice(0, 6))
  }

  function highlightAgendaTasks(taskIds = []) {
    const uniqueIds = [...new Set((Array.isArray(taskIds) ? taskIds : []).filter(Boolean))]
    if (uniqueIds.length === 0) return
    setHighlightedTaskIds(uniqueIds)
  }

  function switchActiveGoal(delta) {
    if (safeGoals.length <= 1) return
    const idx = safeGoals.findIndex(g => g.id === activeGoalId)
    if (idx === -1) return
    const len = safeGoals.length
    const nextIdx = (idx + delta + len) % len
    const nextGoal = safeGoals[nextIdx]
    setCurrentGoal(nextGoal.id)
    setRecommendations([])
  }

  const goalSwipe = useRef({ x: null })

  const utilization = useMemo(() => {
    const count = agendaMicroTasks.length
    if (count >= 6) return 'Высокая'
    if (count >= 3) return 'Средняя'
    return 'Низкая'
  }, [agendaMicroTasks])

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

  function startInlineTaskEdit(task) {
    if (!task) return
    setInlineEditTaskId(task.id)
    setInlineEditText(String(task.text || ''))
    setAiError('')
  }

  function cancelInlineTaskEdit() {
    setInlineEditTaskId(null)
    setInlineEditText('')
    setInlineEditBusy(false)
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
    closeGeneratedDateEditor()
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
    const normalizedGoal = normalizeGoal(updatedGoal)
    if (!hasAccountAccess) {
      return normalizedGoal
    }

    return normalizeGoal(
      await apiRequest(`/api/goals/${gid}`, {
        method: 'PUT',
        body: {
          text: normalizedGoal.text,
          microGoals: normalizedGoal.microGoals,
          category: normalizedGoal.category,
          createdAt: normalizedGoal.createdAt,
        },
        sessionToken,
      })
    )
  }

  async function createGoal(text) {
    const goalText = String(text || '').trim()
    if (!goalText) return null
    let category = normalizeGoalCategory('', goalText)
    try {
      category = await fetchGoalCategory(goalText)
    } catch {
      category = normalizeGoalCategory('', goalText)
    }
    const createdAt = new Date().toISOString()

    const normalized = hasAccountAccess
      ? normalizeGoal(
          await apiRequest('/api/goals', {
            method: 'POST',
            body: {
              text: goalText,
              microGoals: [],
              category,
              createdAt,
            },
            sessionToken,
          })
        )
      : normalizeGoal({
          id: Date.now(),
          text: goalText,
          category,
          createdAt,
          microGoals: [],
        })
    setGoals(prev => [normalized, ...prev])
    setActiveGoalId(normalized.id)
    localStorage.setItem(activeGoalStorageKey, String(normalized.id))
    return normalized
  }

  async function completeMicroGoal(goalId, microId, nextCompleted = true) {
    const goal = safeGoals.find(item => item.id === goalId)
    if (!goal) return

    const target = goal.microGoals.find(m => m.id === microId)
    if (!target || target.completed === nextCompleted) return

    const microGoals = goal.microGoals.map(item => {
      if (item.id !== microId) return item
      if (nextCompleted) {
        return { ...item, completed: true, completedAt: new Date().toISOString() }
      }
      return { ...item, completed: false, completedAt: null }
    })
    const updatedGoal = { ...goal, microGoals }
    const allDone = microGoals.length > 0 && microGoals.every(item => item.completed)

    if (allDone) {
      const finishedAt = new Date().toISOString()
      const finalizedMicro = microGoals.map(m => ({
        ...m,
        completed: true,
        completedAt: m.completedAt || finishedAt,
      }))
      const finishedGoal = { ...updatedGoal, microGoals: finalizedMicro, finishedAt, completedAt: finishedAt }
      if (hasAccountAccess) {
        const savedFinishedGoal = normalizeGoal(
          await apiRequest('/api/completed-goals', {
            method: 'POST',
            body: finishedGoal,
            sessionToken,
          })
        )
        setGoals(prev => prev.filter(item => item.id !== goalId))
        setCompletedGoals(prev => [savedFinishedGoal, ...prev])
        return
      }

      setGoals(prev => prev.filter(item => item.id !== goalId))
      setCompletedGoals(prev => [normalizeGoal(finishedGoal), ...prev])
      return
    }

    const saved = await updateGoalLocally(updatedGoal)
    replaceGoalInState(saved)
  }

  const storeRecommendationsInCache = useCallback((goal, sourceText, items) => {
    const key = getRecommendationCacheKey(goal, sourceText)
    if (!key) return
    setRecommendationsCache(prev => ({
      ...prev,
      [key]: Array.isArray(items) ? items.map(item => ({ ...item })) : [],
    }))
  }, [])

  function openGeneratedDateEditor(mode, payload = {}) {
    setGeneratedDateEditor({
      mode,
      ...payload,
    })
  }

  function closeGeneratedDateEditor() {
    setGeneratedDateEditor(null)
  }

  async function saveStepsToGoal(goalTitle, steps, { suggested = true } = {}) {
    const safeTitle = String(goalTitle || '').trim()
    const sourceSteps = Array.isArray(steps) ? steps : []
    if (!safeTitle || sourceSteps.length === 0) return null

    let savedGoal =
      findGoalByTitle(safeGoals, safeTitle) ||
      (activeGoal && goalTitlesAlign(safeTitle, activeGoal.text) ? activeGoal : null)

    if (!savedGoal) {
      savedGoal = await createGoal(safeTitle)
      if (!savedGoal) return null
    }

    savedGoal = normalizeGoal(savedGoal)
    const nextMicroGoals = [...(savedGoal.microGoals || [])]
    const addedIds = []

    sourceSteps.forEach((step, index) => {
      const stepText = String(step?.text || step?.title || '').trim()
      if (!stepText || hasSimilarTaskDuplicate({ microGoals: nextMicroGoals }, stepText)) {
        return
      }

      const nextItem = buildAppendedMicroGoal(nextMicroGoals, {
        id: Date.now() + index + Math.floor(Math.random() * 1000),
        text: stepText,
        completed: false,
        suggested,
        recommendedDate: step?.recommendedDate,
        recommendedOffsetDays: step?.recommendedOffsetDays,
        forceRecommendedDate: Boolean(step?.userPickedDate),
      })
      nextMicroGoals.push(nextItem)
      addedIds.push(nextItem.id)
    })

    if (addedIds.length === 0) {
      setCurrentGoal(savedGoal.id)
      return { goal: savedGoal, addedIds }
    }

    const updated = await updateGoalLocally({
      ...savedGoal,
      text: safeTitle,
      microGoals: nextMicroGoals,
    })
    const normalizedGoal = normalizeGoal(updated)
    replaceGoalInState(normalizedGoal)
    setCurrentGoal(normalizedGoal.id)
    highlightAgendaTasks(addedIds)
    return { goal: normalizedGoal, addedIds }
  }

  function openRecentGeneration(item) {
    if (!item) return
    setGenerationInput(String(item.title || ''))
    setGeneratedSteps([])
    setShowGeneratedResult(false)
    setAiError('')
    setActiveTab('generate')
  }

  async function applyRecentGeneration(item) {
    if (!item) return
    try {
      setAiError('')
      const result = await saveStepsToGoal(item.title, item.steps, { suggested: true })
      if (!result?.goal) return
      setGenerationInput(String(item.title || ''))
      setActiveTab('agenda')
    } catch (error) {
      console.error('Повторное добавление генерации:', error)
      setAiError('Не удалось добавить шаги из недавней генерации')
    }
  }

  function removeRecentGeneration(itemId) {
    setRecentGenerations(prev => prev.filter(item => item.id !== itemId))
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
      placeholder: true,
    }
    const onScreenTexts = real.filter(r => r.id !== removedItemId).map(r => r.text)
    const placeholderList = [...real.slice(0, idx), ph, ...real.slice(idx + 1)]
    setRecommendations(placeholderList)
    storeRecommendationsInCache(savedGoal, titleText, placeholderList)

    try {
      const existingTexts = [
        ...(savedGoal.microGoals || []).map(m => m.text),
        ...onScreenTexts,
      ]
      const fresh = await fetchPreviewMicrogoals(titleText, existingTexts, 1)
      const one = planSuggestedMicroGoals(fresh, savedGoal)[0]
      const textOk = String(one?.text || '').trim()
      setRecommendations(prev => {
        const nextRecommendations = !textOk
          ? prev.filter(r => r.id !== ph.id)
          : prev.map(r =>
          r.id === ph.id && r.placeholder
            ? {
                id: String(one?.id ?? `r-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`),
                text: textOk,
                checkpointOrder: one.checkpointOrder,
                recommendedDate: one.recommendedDate,
                recommendedOffsetDays: one.recommendedOffsetDays ?? null,
                instantEnter: true,
              }
            : r
        )
        storeRecommendationsInCache(savedGoal, titleText, nextRecommendations)
        return nextRecommendations
      })
    } catch (error) {
      console.error('Дозаполнение рекомендаций:', error)
      setRecommendations(prev => {
        const nextRecommendations = prev.filter(r => r.id !== ph.id)
        storeRecommendationsInCache(savedGoal, titleText, nextRecommendations)
        return nextRecommendations
      })
    }
  }

  const requestPreviewSuggestions = useCallback(async sourceText => {
    const trimmed = String(sourceText || '').trim()
    if (!trimmed) return
    setRecommendationsSource(trimmed)
    const cacheKey = getRecommendationCacheKey(activeGoal, trimmed)
    const cached = cacheKey ? recommendationsCache[cacheKey] : null
    if (Array.isArray(cached) && cached.length > 0) {
      setRecommendations(cached.map(item => ({ ...item })))
      return
    }
    try {
      const existingTexts = (activeGoal?.microGoals || []).map(item => item.text)
      const clean = await fetchPreviewMicrogoals(trimmed, existingTexts, AI_SUGGEST_SLOTS)
      const planned = planSuggestedMicroGoals(clean, activeGoal)
      const nextRecommendations = planned.map(item => ({
          ...item,
          id: item.id,
        }))
      setRecommendations(nextRecommendations)
      storeRecommendationsInCache(activeGoal, trimmed, nextRecommendations)
    } catch (error) {
      console.error('Ошибка получения рекомендаций:', error)
      setRecommendations([])
    }
  }, [activeGoal, recommendationsCache, storeRecommendationsInCache])

  useEffect(() => {
    if (!activeGoal) {
      setRecommendations([])
      setRecommendationsSource('')
      return
    }

    if (activeTab === 'agenda' && activeGoal?.text) {
      requestPreviewSuggestions(activeGoal.text)
    }
  }, [activeTab, activeGoal, requestPreviewSuggestions])

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
        forceRecommendedDate: Boolean(item.userPickedDate),
      })
      const updatedGoal = {
        ...goal,
        microGoals: [
          ...(goal.microGoals || []),
          nextMicroGoal,
        ],
      }
      const saved = await updateGoalLocally(updatedGoal)
      replaceGoalInState(saved)
      highlightAgendaTasks([nextMicroGoal.id])
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
    setShowGeneratedResult(false)

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

      const planned = planSuggestedMicroGoals(clean, baseGoal)
      const result = await saveStepsToGoal(text, planned, { suggested: true })
      if (!result?.goal) {
        throw new Error('save-failed')
      }
      if (result.addedIds.length === 0) {
        setAiError('Похожие шаги уже есть в этой цели')
      }
      rememberGeneration(text, planned)
      setGeneratedSteps(planned)
      setActiveTab('agenda')
    } catch (error) {
      console.error('Ошибка генерации:', error)
      const m = error?.message
      setAiError(
        m && m !== 'failed' && m !== 'empty' && m !== 'save-failed'
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
            recommendedDate: genCustomDateDraft,
            forceRecommendedDate: Boolean(genCustomDateDraft),
          }),
        ]
        const updated = await updateGoalLocally({ ...baseGoal, microGoals })
        const savedGoal = normalizeGoal(updated)
        replaceGoalInState(savedGoal)
        setCurrentGoal(savedGoal.id)
        highlightAgendaTasks([microGoals[microGoals.length - 1]?.id])
      } else {
        const created = await createGoal(goalTitle)
        if (!created) return
        const microGoals = [
          buildAppendedMicroGoal(created.microGoals, {
            id: Date.now(),
            text: t,
            completed: false,
            suggested: false,
            recommendedDate: genCustomDateDraft,
            forceRecommendedDate: Boolean(genCustomDateDraft),
          }),
        ]
        const updated = await updateGoalLocally({
          ...created,
          text: goalTitle,
          microGoals,
        })
        const savedGoal = normalizeGoal(updated)
        if (savedGoal?.id != null) {
          replaceGoalInState(savedGoal)
          setCurrentGoal(savedGoal.id)
          highlightAgendaTasks([microGoals[microGoals.length - 1]?.id])
        }
      }

      setGenCustomInput('')
      setGenCustomDateDraft('')
      closeGeneratedDateEditor()
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
    setGenCustomDateDraft('')
    setGenRowBusyId(null)
    closeGeneratedDateEditor()
    setIsAddingOwnStep(false)
    setAiError('')
  }

  function updateGeneratedStepDate(stepId, nextDate) {
    const normalizedDate = normalizeIsoDate(nextDate)
    setGeneratedSteps(prev =>
      prev.map(step =>
        step.id === stepId
          ? {
              ...step,
              recommendedDate: normalizedDate,
              userPickedDate: Boolean(normalizedDate),
            }
          : step
      )
    )
    closeGeneratedDateEditor()
  }

  function updateRecommendationDate(itemId, nextDate) {
    const normalizedDate = normalizeIsoDate(nextDate)
    if (!normalizedDate) return

    setRecommendations(prev => {
      const nextRecommendations = prev.map(item =>
        item.id === itemId
          ? {
              ...item,
              recommendedDate: normalizedDate,
              userPickedDate: true,
            }
          : item
      )
      storeRecommendationsInCache(activeGoal, recommendationsSource, nextRecommendations)
      return nextRecommendations
    })
    closeGeneratedDateEditor()
  }

  function updateOwnGeneratedDate(nextDate) {
    setGenCustomDateDraft(normalizeIsoDate(nextDate))
    closeGeneratedDateEditor()
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
            forceRecommendedDate: Boolean(step.userPickedDate),
          }),
        ]
        const updated = await updateGoalLocally({ ...savedGoal, microGoals })
        savedGoal = normalizeGoal(updated)
        replaceGoalInState(savedGoal)
        setCurrentGoal(savedGoal.id)
        highlightAgendaTasks([microGoals[microGoals.length - 1]?.id])
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
            forceRecommendedDate: Boolean(step.userPickedDate),
          }),
        ]
        const updated = await updateGoalLocally({
          ...created,
          text: goalTitle,
          microGoals,
        })
        savedGoal = normalizeGoal(updated)
        if (savedGoal?.id != null) {
          replaceGoalInState(savedGoal)
          setCurrentGoal(savedGoal.id)
          highlightAgendaTasks([microGoals[microGoals.length - 1]?.id])
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
      closeGeneratedDateEditor()
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
      replaceGoalInState(saved)
      if (taskEditor.mode === 'create') {
        highlightAgendaTasks([microGoals[microGoals.length - 1]?.id])
      }
      closeTaskEditor()
    } catch (error) {
      console.error('Сохранение микрошагa:', error)
      setAiError('Не удалось сохранить микрошаг')
    } finally {
      setTaskEditorBusy(false)
    }
  }

  async function saveInlineTaskEdit(goalId, taskId) {
    if (inlineEditBusy) return
    const goal = safeGoals.find(item => item.id === goalId)
    if (!goal) return
    const text = String(inlineEditText || '').trim()
    if (!text) return

    const duplicate = (goal.microGoals || []).some(
      item => item.id !== taskId && textSimilarity(item.text, text) >= 0.65
    )
    if (duplicate) {
      setAiError('Похожий микрошаг уже есть в этой цели')
      return
    }

    setInlineEditBusy(true)
    try {
      const otherMicroGoals = (goal.microGoals || []).filter(item => item.id !== taskId)
      const microGoals = (goal.microGoals || []).map(item =>
        item.id === taskId
          ? normalizeMicroGoal(
              {
                ...item,
                text,
                recommendedDate:
                  normalizeIsoDate(item.recommendedDate) ||
                  inferRecommendedDate(item.checkpointOrder, otherMicroGoals),
              },
              0,
              otherMicroGoals
            )
          : item
      )
      const saved = normalizeGoal(await updateGoalLocally({ ...goal, microGoals }))
      replaceGoalInState(saved)
      cancelInlineTaskEdit()
    } catch (error) {
      console.error('Инлайн-редактирование микрошага:', error)
      setAiError('Не удалось сохранить микрошаг')
      setInlineEditBusy(false)
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
      if (hasAccountAccess) {
        await Promise.all([
          apiRequest('/api/goals', { method: 'DELETE', sessionToken }),
          apiRequest('/api/completed-goals', { method: 'DELETE', sessionToken }),
        ])
      }
      setCompletedGoals([])
      setGoals([])
      setActiveGoalId(null)
      localStorage.removeItem(activeGoalStorageKey)
      setRecommendations([])
      setRecommendationsSource('')
      setRecentGenerations([])
      localStorage.removeItem(makeScopedStorageKey(RECENT_GENERATIONS_KEY, storageScope))
      resetGenerationUi()
      cancelInlineTaskEdit()
    } catch (error) {
      console.error('Ошибка очистки:', error)
      setAiError('Не удалось очистить данные. Попробуйте позже')
    }
  }

  function applyAuthPayload(payload) {
    const nextToken = String(payload?.sessionToken || '').trim()
    const nextName = String(payload?.user?.name || '').trim()
    const nextEmail = normalizeEmail(payload?.user?.email)

    if (!nextToken || !nextName || !isValidEmail(nextEmail)) {
      throw new Error('bad-auth-payload')
    }

    setAuthToken(nextToken)
    setUserName(nextName)
    setUserEmail(nextEmail)
    setNameDraft(nextName)
    setEmailDraft(nextEmail)
    setPasswordDraft('')
    setPasswordRepeatDraft('')
    setAuthMode('login')
    setAuthError('')
    setAuthInfo('')
    setAiError('')
    setAuthChecked(true)
    resetRecoveryFlow()
  }

  async function submitLogin() {
    const email = normalizeEmail(emailDraft)
    const password = String(passwordDraft || '')
    if (!isValidEmail(email) || !password) return

    setAuthBusy(true)
    setAuthError('')
    setAuthInfo('')
    try {
      const payload = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: {
          email,
          password,
        },
      })
      applyAuthPayload(payload)
    } catch (error) {
      console.error('Вход:', error)
      setAuthError(error?.message || 'Не удалось войти')
    } finally {
      setAuthBusy(false)
    }
  }

  async function submitRegister() {
    const name = String(nameDraft || '').trim()
    const email = normalizeEmail(emailDraft)
    const password = String(passwordDraft || '')
    const passwordRepeat = String(passwordRepeatDraft || '')

    if (!name || !isValidEmail(email) || !password || password !== passwordRepeat) return

    setAuthBusy(true)
    setAuthError('')
    setAuthInfo('')
    try {
      const payload = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: {
          name,
          email,
          password,
        },
      })
      applyAuthPayload(payload)
    } catch (error) {
      console.error('Регистрация:', error)
      setAuthError(error?.message || 'Не удалось создать аккаунт')
    } finally {
      setAuthBusy(false)
    }
  }

  async function submitPasswordResetRequest() {
    const email = normalizeEmail(emailDraft)
    if (!isValidEmail(email)) return

    setAuthBusy(true)
    setAuthError('')
    setAuthInfo('')
    try {
      const payload = await apiRequest('/api/auth/password-reset/request', {
        method: 'POST',
        body: { email },
      })
      setResetStage('confirm')
      setResetCodeDraft('')
      setResetNewPasswordDraft('')
      setResetNewPasswordRepeatDraft('')
      setAuthInfo(payload?.message || 'Мы отправили код для сброса пароля на вашу почту.')
    } catch (error) {
      console.error('Запрос сброса пароля:', error)
      setAuthError(error?.message || 'Не удалось отправить код')
    } finally {
      setAuthBusy(false)
    }
  }

  async function submitPasswordResetConfirm() {
    const email = normalizeEmail(emailDraft)
    const code = String(resetCodeDraft || '').trim()
    const newPassword = String(resetNewPasswordDraft || '')

    if (!isValidEmail(email) || !isValidResetCode(code) || !newPassword) return

    setAuthBusy(true)
    setAuthError('')
    setAuthInfo('')
    try {
      await apiRequest('/api/auth/password-reset/confirm', {
        method: 'POST',
        body: {
          email,
          code,
          newPassword,
        },
      })
      setAuthMode('login')
      setPasswordDraft('')
      setPasswordRepeatDraft('')
      resetRecoveryFlow()
      setAuthInfo('Пароль обновлён. Теперь войдите с новым паролем.')
    } catch (error) {
      console.error('Подтверждение сброса пароля:', error)
      setAuthError(error?.message || 'Не удалось обновить пароль')
    } finally {
      setAuthBusy(false)
    }
  }

  async function logoutUser() {
    try {
      if (sessionToken) {
        await apiRequest('/api/auth/logout', {
          method: 'POST',
          sessionToken,
        })
      }
    } catch (error) {
      console.error('Выход из аккаунта:', error)
    } finally {
      localStorage.removeItem(AUTH_TOKEN_KEY)
      localStorage.removeItem(USER_NAME_KEY)
      localStorage.removeItem(USER_EMAIL_KEY)
      setAuthToken('')
      setUserName('')
      setUserEmail('')
      setNameDraft('')
      setEmailDraft('')
      setPasswordDraft('')
      setPasswordRepeatDraft('')
      resetRecoveryFlow({ keepEmail: false })
      setShowProfile(false)
      setActiveTab('agenda')
      setAiError('')
      setAuthError('')
      setAuthInfo('')
      setRecommendations([])
      setRecommendationsSource('')
      setRecommendationsCache({})
      closeTaskEditor()
      resetGenerationUi()
    }
  }

  const today = new Date().toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  })

  if (!authChecked) {
    return (
      <main className="app-shell onboarding-shell">
        <section className="onboarding-card">
          <div className="logo-badge">✦</div>
          <h1 className="screen-title">Проверяем вход…</h1>
          <p className="secondary-text onboarding-copy">Секунду, открываем ваш аккаунт.</p>
        </section>
      </main>
    )
  }

  if (!isAuthenticated) {
    return (
      <main className="app-shell onboarding-shell">
        <section className="onboarding-card">
          <div className="logo-badge">✦</div>
          {authMode !== 'reset' && (
            <div className="auth-switcher">
              <button
                type="button"
                className={`auth-switcher-button ${authMode === 'login' ? 'auth-switcher-button--active' : ''}`}
                onClick={() => {
                  setAuthMode('login')
                  setAuthError('')
                  setAuthInfo('')
                  setPasswordDraft('')
                  setPasswordRepeatDraft('')
                  resetRecoveryFlow()
                }}
              >
                Войти
              </button>
              <button
                type="button"
                className={`auth-switcher-button ${authMode === 'register' ? 'auth-switcher-button--active' : ''}`}
                onClick={() => {
                  setAuthMode('register')
                  setAuthError('')
                  setAuthInfo('')
                  setPasswordDraft('')
                  setPasswordRepeatDraft('')
                  resetRecoveryFlow()
                }}
              >
                Зарегистрироваться
              </button>
            </div>
          )}
          <h1 className="screen-title">
            {authMode === 'register'
              ? 'Регистрация'
              : authMode === 'reset'
                ? resetStage === 'confirm'
                  ? 'Сброс пароля'
                  : 'Забыли пароль?'
                : 'Вход в аккаунт'}
          </h1>
          <p className="secondary-text onboarding-copy">
            {authMode === 'register'
              ? 'Создайте аккаунт: имя, почта и пароль. Потом сможете входить с любого устройства.'
              : authMode === 'reset'
                ? resetStage === 'confirm'
                  ? 'Введите код из письма и задайте новый пароль.'
                  : 'Укажите почту аккаунта. Мы отправим 6-значный код для сброса пароля.'
                : 'Введите почту и пароль, чтобы открыть свои цели и историю.'}
          </p>
          <div className="onboarding-fields">
            {authMode === 'register' && (
              <input
                type="text"
                className="onboarding-input"
                placeholder="Имя"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && canSubmitRegister) {
                    e.preventDefault()
                    submitRegister()
                  }
                }}
                autoFocus
                autoComplete="name"
              />
            )}
            <input
              type="email"
              className="onboarding-input"
              placeholder="Почта"
              value={emailDraft}
              onChange={e => setEmailDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (authMode === 'register' ? canSubmitRegister : canSubmitLogin)) {
                  e.preventDefault()
                  if (authMode === 'register') submitRegister()
                  else submitLogin()
                }
              }}
              autoFocus={authMode !== 'register'}
              autoComplete="email"
              inputMode="email"
            />
            {authMode !== 'reset' && (
              <input
                type="password"
                className="onboarding-input"
                placeholder="Пароль"
                value={passwordDraft}
                onChange={e => setPasswordDraft(e.target.value)}
                onKeyDown={e => {
                  if (
                    e.key === 'Enter' &&
                    (authMode === 'register' ? canSubmitRegister : canSubmitLogin)
                  ) {
                    e.preventDefault()
                    if (authMode === 'register') submitRegister()
                    else submitLogin()
                  }
                }}
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              />
            )}
            {authMode === 'register' && (
              <input
                type="password"
                className="onboarding-input"
                placeholder="Повторите пароль"
                value={passwordRepeatDraft}
                onChange={e => setPasswordRepeatDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && canSubmitRegister) {
                    e.preventDefault()
                    submitRegister()
                  }
                }}
                autoComplete="new-password"
              />
            )}
            {authMode === 'reset' && resetStage === 'confirm' && (
              <>
                <input
                  type="text"
                  className="onboarding-input"
                  placeholder="6-значный код"
                  value={resetCodeDraft}
                  onChange={e => setResetCodeDraft(e.target.value.replace(/\D/g, '').slice(0, RESET_CODE_LENGTH))}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canSubmitResetConfirm) {
                      e.preventDefault()
                      submitPasswordResetConfirm()
                    }
                  }}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                />
                <input
                  type="password"
                  className="onboarding-input"
                  placeholder="Новый пароль"
                  value={resetNewPasswordDraft}
                  onChange={e => setResetNewPasswordDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canSubmitResetConfirm) {
                      e.preventDefault()
                      submitPasswordResetConfirm()
                    }
                  }}
                  autoComplete="new-password"
                />
                <input
                  type="password"
                  className="onboarding-input"
                  placeholder="Повторите новый пароль"
                  value={resetNewPasswordRepeatDraft}
                  onChange={e => setResetNewPasswordRepeatDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && canSubmitResetConfirm) {
                      e.preventDefault()
                      submitPasswordResetConfirm()
                    }
                  }}
                  autoComplete="new-password"
                />
              </>
            )}
          </div>
          {String(emailDraft || '').trim() && !isValidEmail(emailDraft) && (
            <p className="onboarding-error">Введите корректную почту</p>
          )}
          {authMode === 'register' && String(passwordDraft || '').length > 0 && String(passwordDraft || '').length < 8 && (
            <p className="onboarding-error">Пароль должен быть не короче 8 символов</p>
          )}
          {authMode === 'register' &&
            String(passwordRepeatDraft || '').length > 0 &&
            passwordDraft !== passwordRepeatDraft && (
              <p className="onboarding-error">Пароли не совпадают</p>
            )}
          {authMode === 'reset' && resetStage === 'confirm' && String(resetCodeDraft || '').length > 0 && !isValidResetCode(resetCodeDraft) && (
            <p className="onboarding-error">Введите 6-значный код из письма</p>
          )}
          {authMode === 'reset' &&
            resetStage === 'confirm' &&
            String(resetNewPasswordDraft || '').length > 0 &&
            String(resetNewPasswordDraft || '').length < 8 && (
              <p className="onboarding-error">Новый пароль должен быть не короче 8 символов</p>
            )}
          {authMode === 'reset' &&
            resetStage === 'confirm' &&
            String(resetNewPasswordRepeatDraft || '').length > 0 &&
            resetNewPasswordDraft !== resetNewPasswordRepeatDraft && (
              <p className="onboarding-error">Пароли не совпадают</p>
            )}
          {authInfo && <p className="onboarding-note">{authInfo}</p>}
          {authError && <p className="onboarding-error">{authError}</p>}
          <button
            type="button"
            className="primary-button"
            disabled={
              authBusy ||
              (authMode === 'register'
                ? !canSubmitRegister
                : authMode === 'reset'
                  ? resetStage === 'confirm'
                    ? !canSubmitResetConfirm
                    : !canSubmitResetRequest
                  : !canSubmitLogin)
            }
            onClick={
              authMode === 'register'
                ? submitRegister
                : authMode === 'reset'
                  ? resetStage === 'confirm'
                    ? submitPasswordResetConfirm
                    : submitPasswordResetRequest
                  : submitLogin
            }
          >
            {authBusy
              ? 'Подождите…'
              : authMode === 'register'
                ? 'Зарегистрироваться'
                : authMode === 'reset'
                  ? resetStage === 'confirm'
                    ? 'Сбросить пароль'
                    : 'Отправить код'
                  : 'Войти'}
          </button>
          {authMode === 'login' && (
            <button
              type="button"
              className="text-button auth-toggle-link"
              onClick={() => {
                setAuthMode('reset')
                setAuthError('')
                setAuthInfo('')
                setPasswordDraft('')
                setPasswordRepeatDraft('')
                resetRecoveryFlow()
              }}
            >
              Забыли пароль?
            </button>
          )}
          {authMode === 'reset' && resetStage === 'confirm' && (
            <button
              type="button"
              className="text-button auth-toggle-link"
              onClick={submitPasswordResetRequest}
              disabled={authBusy || !canSubmitResetRequest}
            >
              Отправить код ещё раз
            </button>
          )}
          <button
            type="button"
            className="text-button auth-toggle-link"
            onClick={() => {
              if (authMode === 'reset') {
                setAuthMode('login')
              } else {
                setAuthMode(prev => (prev === 'login' ? 'register' : 'login'))
              }
              setAuthError('')
              setAuthInfo('')
              setPasswordDraft('')
              setPasswordRepeatDraft('')
              resetRecoveryFlow()
            }}
          >
            {authMode === 'register'
              ? 'Уже есть аккаунт? Войти'
              : authMode === 'reset'
                ? 'Вспомнили пароль? Войти'
                : 'Нет аккаунта? Зарегистрироваться'}
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
              <small className="screen-header-sub">
                <Lightning size={15} weight="fill" aria-hidden />
                {utilization}
              </small>
            </div>
            <button type="button" className="icon-button" onClick={() => setShowProfile(true)} aria-label="Настройки">
              <Gear size={20} weight="regular" aria-hidden />
            </button>
          </header>

          <div className="agenda-layout">
            <div className="agenda-column agenda-column--main">
              <div className="section-heading-row">
                <h2>{safeGoals.length > 1 ? 'Мои цели' : 'Моя цель'}</h2>
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
                  <button
                    type="button"
                    className="goal-hero-empty-cta"
                    onClick={() => {
                      beginNewGoalGeneration()
                      setActiveTab('generate')
                    }}
                    aria-label="Написать новую цель"
                  >
                    <span className="goal-hero-empty-title">Напишите сюда цель</span>
                    <span className="secondary-text goal-hero-empty-hint">
                      Например: подготовиться к экзамену, начать бегать или навести порядок дома
                    </span>
                  </button>
                ) : (
                  <div className="goal-hero-top">
                    <div className="goal-hero-text-block">
                      <div className="goal-hero-title-row">
                        <span className="goal-hero-icon" aria-hidden="true">
                          <GoalCategoryIcon category={activeGoal.category} />
                        </span>
                        <p className="goal-hero-title">{activeGoal.text}</p>
                      </div>
                    </div>
                    {safeGoals.length > 1 && (
                      <div className="goal-hero-arrows" role="group" aria-label="Переключение цели">
                        <button
                          type="button"
                          className="goal-arrow"
                          aria-label="Предыдущая цель"
                          onClick={() => switchActiveGoal(-1)}
                        >
                          <CaretLeft size={22} weight="bold" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="goal-arrow"
                          aria-label="Следующая цель"
                          onClick={() => switchActiveGoal(1)}
                        >
                          <CaretRight size={22} weight="bold" aria-hidden />
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="goal-new-button"
                      aria-label="Новая цель"
                      onClick={() => {
                        beginNewGoalGeneration()
                        setActiveTab('generate')
                      }}
                    >
                      <Plus size={16} weight="bold" aria-hidden />
                      Новая цель
                    </button>
                  </div>
                )}
              </div>

              {activeGoal && (
                <div className="goal-progress-card">
                  <div className="goal-progress-head">
                    <span>Прогресс по цели</span>
                    <span className="type-accent-number">{activeGoalProgress.percent}%</span>
                  </div>
                  <div
                    className="goal-progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={activeGoalProgress.percent}
                    aria-label="Прогресс по цели"
                  >
                    <span
                      className="goal-progress-fill"
                      style={{ width: `${activeGoalProgress.percent}%` }}
                    />
                  </div>
                  <p className="secondary-text goal-progress-copy">
                    Выполнено: {activeGoalProgress.completedCount} из {activeGoalProgress.total} шагов
                  </p>
                </div>
              )}

              <div ref={agendaTasksRef} />
              <h2 className="section-h2-tight">Шаги</h2>
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
                activeGoal ? (
                  <button
                    type="button"
                    className="task-empty-cta"
                    onClick={() => openTaskEditor(activeGoal.id)}
                  >
                    <strong>Добавьте первый микрошаг</strong>
                    <span className="secondary-text">
                      Или используйте рекомендации справа
                    </span>
                  </button>
                ) : (
                  <p className="secondary-text">Выберите цель выше — здесь появятся её шаги</p>
                )
              ) : (
                <div className="tasks-grid">
                  {agendaMicroTasks.map((task, index) => (
                    <article
                      key={task.id}
                      className={`task-card micro-appear ${task.completed ? 'task-card--completed' : ''} ${highlightedTaskIds.includes(task.id) ? 'task-card--fresh' : ''}`}
                      style={{ '--appear-i': index }}
                    >
                      <div className="task-card-main">
                        <button
                          type="button"
                          className={`task-card-check ${task.completed ? 'task-card-check--done' : ''}`}
                          aria-label={task.completed ? 'Вернуть шаг в работу' : 'Отметить шаг выполненным'}
                          onClick={() => completeMicroGoal(activeGoal.id, task.id, !task.completed)}
                        >
                          {task.completed ? '✓' : ''}
                        </button>
                        <button
                          type="button"
                          className="task-card-text-button"
                          onClick={() => startInlineTaskEdit(task)}
                        >
                          {inlineEditTaskId === task.id ? (
                            <span className="task-inline-edit">
                              <input
                                type="text"
                                className="task-inline-input"
                                value={inlineEditText}
                                onChange={e => setInlineEditText(e.target.value)}
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    saveInlineTaskEdit(activeGoal.id, task.id)
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    cancelInlineTaskEdit()
                                  }
                                }}
                              />
                              <span className="task-inline-actions">
                                <button
                                  type="button"
                                  className="text-button task-inline-action"
                                  disabled={inlineEditBusy || !inlineEditText.trim()}
                                  onClick={e => {
                                    e.stopPropagation()
                                    saveInlineTaskEdit(activeGoal.id, task.id)
                                  }}
                                >
                                  Сохранить
                                </button>
                                <button
                                  type="button"
                                  className="text-button task-inline-action task-inline-action--muted"
                                  disabled={inlineEditBusy}
                                  onClick={e => {
                                    e.stopPropagation()
                                    cancelInlineTaskEdit()
                                  }}
                                >
                                  Отмена
                                </button>
                              </span>
                            </span>
                          ) : (
                            <strong>{task.text}</strong>
                          )}
                        </button>
                      </div>
                      <div className="task-card-actions">
                        <button
                          type="button"
                          className={`task-date-button ${isRecommendedDatePassed(task) ? 'task-date-button--overdue' : ''}`}
                          aria-label="Выбрать дату для шага"
                          onClick={() =>
                            openGeneratedDateEditor('task', {
                              goalId: activeGoal.id,
                              taskId: task.id,
                              value: normalizeIsoDate(task.recommendedDate),
                            })
                          }
                        >
                          {task.recommendedDate
                            ? `Дата: ${formatRecommendedDate(task.recommendedDate)}`
                            : 'Выбрать дату'}
                        </button>
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
              <h2 className="section-h2-tight">Рекомендации</h2>
              <p className="secondary-text section-subline">Идеи шагов для вашей цели</p>
              <div className="recommendations-row">
                {agendaRecommendations.length === 0 ? (
                  <p className="secondary-text">
                    {!activeGoal
                      ? 'Добавьте цель — здесь появятся идеи ИИ именно для неё'
                      : 'Пока нет рекомендаций ИИ для этой цели. Смените цель — подгрузим идеи для другой'}
                  </p>
                ) : (
                  agendaRecommendations.map((item, index) =>
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
                        <div className="recommendation-icon">
                          <Sparkle size={22} weight="regular" aria-hidden />
                        </div>
                        <p>{item.text}</p>
                        <div className="recommendation-card-actions">
                          <div className="recommendation-card-buttons">
                            <button
                              type="button"
                              className={`gen-step-icon-btn gen-step-calendar-btn ${generatedDateEditor?.mode === 'recommendation' && generatedDateEditor?.recommendationId === item.id ? 'gen-step-calendar-btn--active' : ''} ${item.userPickedDate ? 'gen-step-calendar-btn--selected' : ''}`}
                              aria-label="Выбрать дату"
                              onClick={() =>
                                openGeneratedDateEditor('recommendation', {
                                  recommendationId: item.id,
                                  value: normalizeIsoDate(item.recommendedDate),
                                })
                              }
                            >
                              <CalendarBlank size={20} weight="regular" aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="gen-step-icon-btn gen-step-add-btn"
                              aria-label="Добавить в повестку"
                              onClick={() => addRecommendationToActiveGoal(item)}
                            >
                              <Plus size={20} weight="bold" aria-hidden />
                            </button>
                          </div>
                        </div>
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

          <button
            type="button"
            className="fab"
            aria-label={activeGoal ? 'Создать новый микрошаг' : 'Создать новую цель'}
            onClick={() => {
              if (activeGoal) {
                openTaskEditor(activeGoal.id)
              } else {
                beginNewGoalGeneration()
                setActiveTab('generate')
              }
            }}
          >
            <Plus size={28} weight="bold" aria-hidden />
          </button>
        </section>
      )}

      {!showProfile && activeTab === 'generate' && (
        <section className="screen screen--generate">
          <header className="screen-header">
            <button type="button" className="text-button text-button--with-icon" onClick={() => setActiveTab('agenda')}>
              <ArrowLeft size={18} weight="regular" aria-hidden />
              Назад
            </button>
            <div className="screen-header-copy screen-header-copy--generation">
              <h1 className="screen-title-with-icon">
                <Sparkle size={18} weight="fill" aria-hidden />
                <span>{showGeneratedResult ? 'Результат' : 'Генерация'}</span>
              </h1>
              <p className="secondary-text generation-screen-copy">
                {showGeneratedResult
                  ? 'Добавляйте шаги по одному и сразу планируйте дату.'
                  : 'Опишите цель, и мы предложим стартовые шаги.'}
              </p>
            </div>
            <div />
          </header>

          {!showGeneratedResult && (
            <>
              <div className="generation-home-grid">
                <div className="generation-home-main">
                  <div className="empty-space" />
                  <h2 className="center-title generation-main-title">Что нужно разбить на шаги?</h2>
                  <div className="generation-form-card">
                    <label htmlFor="generation-input" className="generation-label">
                      Опишите вашу цель или задачу
                    </label>
                    <textarea
                      ref={generationInputRef}
                      id="generation-input"
                      className="big-input"
                      maxLength={GENERATION_INPUT_LIMIT}
                      value={generationInput}
                      onChange={e => setGenerationInput(e.target.value)}
                      placeholder="Напишите цель или задачу, которую хотите достичь..."
                    />
                    <div className="generation-input-meta">
                      <span className="secondary-text" />
                      <span className="secondary-text">
                        {generationInput.length} / {GENERATION_INPUT_LIMIT}
                      </span>
                    </div>
                    <div className="generation-examples-block">
                      <span className="generation-label generation-label--muted">Примеры целей</span>
                      <div className="generation-example-row">
                        {GENERATION_EXAMPLES.map(example => (
                          <button
                            key={example}
                            type="button"
                            className="generation-example-chip"
                            onClick={() => {
                              setGenerationInput(example)
                              setShowGeneratedResult(false)
                            }}
                          >
                            {example}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {(activeGoal || generationInput.trim()) && (
                    <p className="secondary-text generation-goal-hint">
                      Шаги добавятся к существующей цели или создадут новую
                    </p>
                  )}
                  <p className="secondary-text generation-inline-note">Генерируем 3 стартовых шага для цели</p>
                  <button
                    className="primary-button"
                    disabled={isGenerating || !generationInput.trim()}
                    onClick={() => handleGenerate()}
                  >
                    {isGenerating ? 'Создаём план…' : 'Сгенерировать шаги'}
                  </button>
                </div>

              {recentGenerations.length > 0 && (
                <aside className="recent-generations recent-generations--compact">
                  <div className="section-heading-row">
                    <h2>Недавние генерации</h2>
                  </div>
                  <div className="recent-generations-list">
                    {recentGenerations.map(item => (
                      <article key={item.id} className="recent-generation-card">
                        <div className="recent-generation-main">
                          <strong>{item.title}</strong>
                          <p className="secondary-text">
                            {item.steps.length} шага · {formatRecentGenerationDate(item.createdAt)}
                          </p>
                        </div>
                        <div className="recent-generation-actions">
                          <button
                            type="button"
                            className="text-button recent-generation-link"
                            onClick={() => openRecentGeneration(item)}
                          >
                            Открыть
                          </button>
                          <button
                            type="button"
                            className="text-button recent-generation-link"
                            onClick={() => applyRecentGeneration(item)}
                          >
                            Добавить
                          </button>
                          <button
                            type="button"
                            className="text-button recent-generation-link recent-generation-link--danger"
                            onClick={() => removeRecentGeneration(item.id)}
                          >
                            Удалить
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </aside>
              )}
              </div>
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
                        <span className="gen-step-text">{step.text}</span>
                      </div>
                      <div className="gen-step-actions">
                        <button
                          type="button"
                          className={`gen-step-icon-btn gen-step-calendar-btn ${generatedDateEditor?.mode === 'generated' && generatedDateEditor?.stepId === step.id ? 'gen-step-calendar-btn--active' : ''} ${step.userPickedDate ? 'gen-step-calendar-btn--selected' : ''}`}
                          aria-label="Выбрать дату"
                          disabled={isGenerating || isAddingOwnStep || genRowBusyId === step.id}
                          onClick={() =>
                            openGeneratedDateEditor('generated', {
                              stepId: step.id,
                              value: normalizeIsoDate(step.recommendedDate),
                            })
                          }
                        >
                          <CalendarBlank size={20} weight="regular" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="gen-step-icon-btn gen-step-add-btn"
                          aria-label="Добавить в повестку и сгенерировать новый шаг"
                          disabled={
                            isGenerating || isAddingOwnStep || genRowBusyId === step.id
                          }
                          onClick={() => addGeneratedStepToAgendaAndRefill(step.id)}
                        >
                          {genRowBusyId === step.id ? '…' : <Plus size={20} weight="bold" aria-hidden />}
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
                  <div className="gen-own-actions">
                    <button
                      type="button"
                      className={`gen-step-icon-btn gen-step-calendar-btn ${generatedDateEditor?.mode === 'own' ? 'gen-step-calendar-btn--active' : ''} ${genCustomDateDraft ? 'gen-step-calendar-btn--selected' : ''}`}
                      aria-label="Выбрать дату для своего шага"
                      disabled={isAddingOwnStep}
                      onClick={() =>
                        openGeneratedDateEditor('own', {
                          value: genCustomDateDraft,
                        })
                      }
                    >
                      <CalendarBlank size={20} weight="regular" aria-hidden />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="gen-step-icon-btn gen-step-add-btn gen-own-add-btn"
                    aria-label="Добавить свой шаг на повестку"
                    disabled={isAddingOwnStep || !genCustomInput.trim()}
                    onClick={addOwnMicroStepToAgenda}
                  >
                    {isAddingOwnStep ? '…' : <Plus size={20} weight="bold" aria-hidden />}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {generatedDateEditor && (
        <div className="modal-backdrop" onClick={closeGeneratedDateEditor}>
          <section
            className="date-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Выбор даты"
            onClick={e => e.stopPropagation()}
          >
            <div className="date-picker-modal-head">
              <h2>Дата</h2>
              <button type="button" className="icon-button" aria-label="Закрыть" onClick={closeGeneratedDateEditor}>
                <X size={20} weight="regular" aria-hidden />
              </button>
            </div>
            <div className="task-modal-field">
              <label htmlFor="generated-date-input" className="task-modal-label">
                Выберите дату
              </label>
              <input
                ref={generatedDateInputRef}
                id="generated-date-input"
                type="date"
                className="task-date-input"
                value={generatedDateEditor.value || ''}
                onChange={e => {
                  if (generatedDateEditor.mode === 'generated') {
                    updateGeneratedStepDate(generatedDateEditor.stepId, e.target.value)
                  } else if (generatedDateEditor.mode === 'recommendation') {
                    updateRecommendationDate(generatedDateEditor.recommendationId, e.target.value)
                  } else if (generatedDateEditor.mode === 'task') {
                    saveTaskDate(generatedDateEditor.goalId, generatedDateEditor.taskId, e.target.value)
                  } else {
                    updateOwnGeneratedDate(e.target.value)
                  }
                }}
              />
            </div>
          </section>
        </div>
      )}

      {!showProfile && activeTab === 'journal' && (
        <Analytics
          goals={safeGoals}
          completedGoals={safeCompletedGoals}
          onClearHistory={clearCompletedHistory}
        />
      )}

      {showProfile && (
        <section className="screen screen--profile">
          <header className="screen-header">
            <button type="button" className="text-button text-button--with-icon" onClick={() => setShowProfile(false)}>
              <ArrowLeft size={18} weight="regular" aria-hidden />
              План
            </button>
            <h1>Настройки</h1>
            <div />
          </header>
          <div className="settings-list">
            <div className="list-row list-row--stacked">
              <span className="list-row-label">Имя</span>
              <strong>{userName || 'Без имени'}</strong>
            </div>
            <div className="list-row list-row--stacked">
              <span className="list-row-label">Почта</span>
              <strong>{userEmail || 'Не указана'}</strong>
            </div>
          </div>
          <button type="button" className="danger-button profile-logout-button" onClick={logoutUser}>
            Выйти
          </button>
        </section>
      )}

      {!showProfile && (
        <nav className="tab-bar">
          <button
            type="button"
            className={activeTab === 'agenda' ? 'active' : ''}
            onClick={() => setActiveTab('agenda')}
          >
            <span className="tab-bar-inner">
              <ListBullets size={22} weight={activeTab === 'agenda' ? 'fill' : 'regular'} aria-hidden />
              <span>План</span>
            </span>
          </button>
          <button
            type="button"
            className={activeTab === 'generate' ? 'active' : ''}
            onClick={() => {
              beginNewGoalGeneration()
              setActiveTab('generate')
            }}
          >
            <span className="tab-bar-inner">
              <Sparkle size={22} weight={activeTab === 'generate' ? 'fill' : 'regular'} aria-hidden />
              <span>Генерация</span>
            </span>
          </button>
          <button type="button" className={activeTab === 'journal' ? 'active' : ''} onClick={() => setActiveTab('journal')}>
            <span className="tab-bar-inner">
              <ChartBar size={22} weight={activeTab === 'journal' ? 'fill' : 'regular'} aria-hidden />
              <span>Статистика</span>
            </span>
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
              <button type="button" className="icon-button" aria-label="Закрыть" onClick={closeTaskEditor}>
                <X size={20} weight="regular" aria-hidden />
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
                  disabled={taskEditorBusy}
                  onClick={async () => {
                    await completeMicroGoal(taskEditor.goalId, editingTask.id, !editingTask.completed)
                    closeTaskEditor()
                  }}
                >
                  {editingTask.completed ? 'Вернуть в работу' : 'Отметить выполненным'}
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
