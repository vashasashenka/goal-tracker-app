import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Briefcase,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChartBar,
  Database,
  Gear,
  GraduationCap,
  Leaf,
  Lightning,
  ListBullets,
  Lock,
  Plus,
  SignOut,
  Sparkle,
  Target,
  User,
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

function formatCompactDateTime(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date
    .toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
    })
    .replace(/\s?г\.$/, '')
    .replace(/\./g, '')
}

function getAgendaTaskSectionId(task, todayKey) {
  if (task?.completed) return 'completed'
  const dateKey = normalizeIsoDate(task?.recommendedDate)
  if (!dateKey || dateKey <= todayKey) return 'today'
  return 'planned'
}

function getAgendaTaskTone(task, todayKey) {
  if (task?.completed) return 'done'
  const dateKey = normalizeIsoDate(task?.recommendedDate)
  if (!dateKey) return 'open'
  if (dateKey < todayKey) return 'overdue'
  if (dateKey === todayKey) return 'today'
  return 'planned'
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
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [profileInfo, setProfileInfo] = useState('')

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
  const [showGoalMenu, setShowGoalMenu] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [selectedRecommendationId, setSelectedRecommendationId] = useState(null)
  const [profileMenuTarget, setProfileMenuTarget] = useState(null)
  const generatedDateInputRef = useRef(null)
  const generationInputRef = useRef(null)
  const agendaTasksRef = useRef(null)
  const recommendationsRef = useRef(null)
  const goalMenuRef = useRef(null)
  const notificationsRef = useRef(null)
  const userMenuRef = useRef(null)
  const profileSectionRef = useRef(null)
  const settingsSectionRef = useRef(null)

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
  const trimmedNameDraft = String(nameDraft || '').trim()
  const canSaveProfile =
    Boolean(trimmedNameDraft) &&
    trimmedNameDraft !== String(userName || '').trim() &&
    !profileBusy
  const activeGoalStorageKey = useMemo(
    () => makeScopedStorageKey(ACTIVE_GOAL_KEY, storageScope),
    [storageScope]
  )
  const goalsStorageKey = useMemo(() => makeScopedStorageKey(GOALS_KEY, storageScope), [storageScope])
  const completedGoalsStorageKey = useMemo(
    () => makeScopedStorageKey(COMPLETED_GOALS_KEY, storageScope),
    [storageScope]
  )
  const hasResettableData = goals.length > 0 || completedGoals.length > 0 || recentGenerations.length > 0

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
        setProfileError('')
        setProfileInfo('')
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
        setProfileError('')
        setProfileInfo('')
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

  const agendaTaskSections = useMemo(() => {
    const todayKey = toIsoDate(new Date())
    const groups = {
      today: [],
      planned: [],
      completed: [],
    }

    for (const task of agendaMicroTasks) {
      groups[getAgendaTaskSectionId(task, todayKey)].push(task)
    }

    return [
      {
        id: 'today',
        title: 'Сегодня',
        tone: 'today',
        items: groups.today,
      },
      {
        id: 'planned',
        title: 'Запланировано',
        tone: 'planned',
        items: groups.planned,
      },
      {
        id: 'completed',
        title: 'Выполнено',
        tone: 'completed',
        items: groups.completed,
      },
    ]
  }, [agendaMicroTasks])

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

  const selectedRecommendation = useMemo(() => {
    if (!selectedRecommendationId) return null
    return agendaRecommendations.find(item => item.id === selectedRecommendationId) || null
  }, [agendaRecommendations, selectedRecommendationId])

  const agendaNotifications = useMemo(() => {
    if (!activeGoal) return []

    const todayKey = toIsoDate(new Date())
    const overdueItems = agendaMicroTasks
      .filter(task => getAgendaTaskTone(task, todayKey) === 'overdue')
      .slice(0, 3)
      .map(task => ({
        id: `overdue-${task.id}`,
        type: 'task',
        tone: 'overdue',
        title: 'Просроченный шаг',
        text: task.text,
        taskId: task.id,
      }))

    const todayItems = agendaMicroTasks
      .filter(task => getAgendaTaskTone(task, todayKey) === 'today')
      .slice(0, 3)
      .map(task => ({
        id: `today-${task.id}`,
        type: 'task',
        tone: 'today',
        title: 'Шаг на сегодня',
        text: task.text,
        taskId: task.id,
      }))

    const suggestionItems =
      agendaRecommendations.length > 0
        ? [
            {
              id: `recommendations-${activeGoal.id}`,
              type: 'recommendation',
              tone: 'planned',
              title: 'Есть новые рекомендации',
              text: `Для цели «${activeGoal.text}» есть ${agendaRecommendations.length} новых шагов`,
            },
          ]
        : []

    return [...overdueItems, ...todayItems, ...suggestionItems]
  }, [activeGoal, agendaMicroTasks, agendaRecommendations])

  const userInitial = String(userName || userEmail || 'П')
    .trim()
    .charAt(0)
    .toUpperCase()

  useEffect(() => {
    function handlePointerDown(event) {
      if (showGoalMenu && goalMenuRef.current && !goalMenuRef.current.contains(event.target)) {
        setShowGoalMenu(false)
      }
      if (showNotifications && notificationsRef.current && !notificationsRef.current.contains(event.target)) {
        setShowNotifications(false)
      }
      if (showUserMenu && userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setShowUserMenu(false)
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setShowGoalMenu(false)
        setShowNotifications(false)
        setShowUserMenu(false)
        setSelectedRecommendationId(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [showGoalMenu, showNotifications, showUserMenu])

  useEffect(() => {
    setShowGoalMenu(false)
    setShowNotifications(false)
    setShowUserMenu(false)
    setSelectedRecommendationId(null)
  }, [activeTab, showProfile, activeGoalId])

  useEffect(() => {
    if (!selectedRecommendationId) return
    if (!selectedRecommendation) {
      setSelectedRecommendationId(null)
    }
  }, [selectedRecommendationId, selectedRecommendation])

  useEffect(() => {
    if (!showProfile || !profileMenuTarget) return

    const frame = requestAnimationFrame(() => {
      if (profileMenuTarget === 'profile') {
        profileSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else if (profileMenuTarget === 'settings') {
        settingsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      setProfileMenuTarget(null)
    })

    return () => cancelAnimationFrame(frame)
  }, [showProfile, profileMenuTarget])

  function setCurrentGoal(goalId) {
    setActiveGoalId(goalId)
    localStorage.setItem(activeGoalStorageKey, String(goalId))
    setRecommendations([])
    setShowGoalMenu(false)
    setShowUserMenu(false)
    setSelectedRecommendationId(null)
  }

  function openNewGoalFlow() {
    beginNewGoalGeneration()
    setShowGoalMenu(false)
    setShowNotifications(false)
    setShowUserMenu(false)
    setSelectedRecommendationId(null)
    setActiveTab('generate')
    setShowProfile(false)
  }

  function openProfileScreen(target = 'profile') {
    setShowUserMenu(false)
    setShowNotifications(false)
    setShowGoalMenu(false)
    setProfileMenuTarget(target)
    setShowProfile(true)
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

  function handleNotificationSelect(item) {
    if (!item) return
    if (item.type === 'recommendation') {
      recommendationsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (item.taskId) {
      highlightAgendaTasks([item.taskId])
      agendaTasksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    setShowNotifications(false)
  }

  async function handleMenuLogout() {
    setShowUserMenu(false)
    await logoutUser()
  }

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

    setShowGoalMenu(false)
    setShowNotifications(false)
    setShowUserMenu(false)
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
      setSelectedRecommendationId(null)
      await refillRecommendationSlotInPlace(item.id, saved)
    } catch (error) {
      console.error('Рекомендация в план:', error)
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
      console.error('Свой микрошаг в план:', error)
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
    setSelectedRecommendationId(null)
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
    setProfileError('')
    setProfileInfo('')
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

  function finalizeSignedOutState({
    nextAuthMode = 'login',
    preserveEmail = '',
    nextAuthInfo = '',
    nextResetStage = 'request',
  } = {}) {
    const nextEmail = normalizeEmail(preserveEmail)

    localStorage.removeItem(AUTH_TOKEN_KEY)
    localStorage.removeItem(USER_NAME_KEY)
    localStorage.removeItem(USER_EMAIL_KEY)
    setAuthToken('')
    setUserName('')
    setUserEmail('')
    setNameDraft('')
    resetRecoveryFlow({ keepEmail: Boolean(nextEmail) })
    setEmailDraft(nextEmail)
    setProfileBusy(false)
    setProfileError('')
    setProfileInfo('')
    setPasswordDraft('')
    setPasswordRepeatDraft('')
    setResetStage(nextResetStage)
    setAuthMode(nextAuthMode)
    setShowProfile(false)
    setActiveTab('agenda')
    setAiError('')
    setAuthError('')
    setAuthInfo(nextAuthInfo)
    setRecommendations([])
    setRecommendationsSource('')
    setRecommendationsCache({})
    closeTaskEditor()
    resetGenerationUi()
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
      finalizeSignedOutState()
    }
  }

  async function beginPasswordResetFromSettings() {
    const email = normalizeEmail(userEmail)
    if (!isValidEmail(email)) return

    const confirmed = window.confirm(
      'Мы отправим код на вашу почту и откроем экран восстановления пароля. Продолжить?'
    )
    if (!confirmed) return

    setAuthBusy(true)
    setAiError('')
    setAuthError('')
    setAuthInfo('')

    try {
      const payload = await apiRequest('/api/auth/password-reset/request', {
        method: 'POST',
        body: { email },
      })

      try {
        if (sessionToken) {
          await apiRequest('/api/auth/logout', {
            method: 'POST',
            sessionToken,
          })
        }
      } catch (error) {
        console.error('Выход перед восстановлением пароля:', error)
      }

      finalizeSignedOutState({
        nextAuthMode: 'reset',
        preserveEmail: email,
        nextAuthInfo: payload?.message || 'Мы отправили код для сброса пароля на вашу почту.',
        nextResetStage: 'confirm',
      })
    } catch (error) {
      console.error('Запуск восстановления пароля из настроек:', error)
      setAiError(error?.message || 'Не удалось открыть восстановление пароля')
    } finally {
      setAuthBusy(false)
    }
  }

  async function saveProfileSettings() {
    const nextName = String(nameDraft || '').trim()
    if (!sessionToken || !nextName || nextName === String(userName || '').trim()) return

    setProfileBusy(true)
    setProfileError('')
    setProfileInfo('')

    try {
      const payload = await apiRequest('/api/auth/profile', {
        method: 'PATCH',
        sessionToken,
        body: {
          name: nextName,
        },
      })

      const savedName = String(payload?.user?.name || nextName).trim()
      setUserName(savedName)
      setNameDraft(savedName)
      setProfileInfo('Имя сохранено')
    } catch (error) {
      console.error('Сохранение профиля:', error)
      setProfileError(error?.message || 'Не удалось сохранить имя')
    } finally {
      setProfileBusy(false)
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

      <div className="dashboard-shell">
        <aside className="app-sidebar" aria-label="Навигация">
          <div className="app-sidebar-top">
            <button
              type="button"
              className="sidebar-brand"
              onClick={() => {
                setShowProfile(false)
                setActiveTab('agenda')
              }}
            >
              Goal Tracker
            </button>

            <nav className="sidebar-nav">
              <button
                type="button"
                className={`sidebar-nav-item ${!showProfile && activeTab === 'agenda' ? 'sidebar-nav-item--active' : ''}`}
                onClick={() => {
                  setShowProfile(false)
                  setActiveTab('agenda')
                }}
              >
                <ListBullets size={20} weight={!showProfile && activeTab === 'agenda' ? 'fill' : 'regular'} aria-hidden />
                <span>План</span>
              </button>
              <button
                type="button"
                className={`sidebar-nav-item ${!showProfile && activeTab === 'generate' ? 'sidebar-nav-item--active' : ''}`}
                onClick={() => {
                  setShowProfile(false)
                  setActiveTab('generate')
                }}
              >
                <Sparkle size={20} weight={!showProfile && activeTab === 'generate' ? 'fill' : 'regular'} aria-hidden />
                <span>Генерация</span>
              </button>
              <button
                type="button"
                className={`sidebar-nav-item ${!showProfile && activeTab === 'journal' ? 'sidebar-nav-item--active' : ''}`}
                onClick={() => {
                  setShowProfile(false)
                  setActiveTab('journal')
                }}
              >
                <ChartBar size={20} weight={!showProfile && activeTab === 'journal' ? 'fill' : 'regular'} aria-hidden />
                <span>Статистика</span>
              </button>
            </nav>
          </div>

          <div className="app-sidebar-bottom">
            <button
              type="button"
              className={`sidebar-nav-item sidebar-nav-item--ghost ${showProfile ? 'sidebar-nav-item--active' : ''}`}
              onClick={() => setShowProfile(true)}
            >
              <Gear size={20} weight={showProfile ? 'fill' : 'regular'} aria-hidden />
              <span>Настройки</span>
            </button>

            <button type="button" className="sidebar-user-card" onClick={() => setShowProfile(true)}>
              <span className="sidebar-user-avatar" aria-hidden="true">
                {userInitial || 'П'}
              </span>
              <span className="sidebar-user-meta">
                <strong>{userName || 'Профиль'}</strong>
                <span>{userEmail || 'Без почты'}</span>
              </span>
              <CaretDown size={16} weight="bold" aria-hidden />
            </button>
          </div>
        </aside>

        <div className="dashboard-main">
      {!showProfile && activeTab === 'agenda' && (
        <section className="screen screen--agenda">
          <header className="screen-header screen-header--agenda">
            <div className="screen-header-copy">
              <h1>План</h1>
              <small className="screen-header-sub screen-header-sub--agenda">
                <span>{today}</span>
                <span className="screen-header-separator">·</span>
                <Lightning size={15} weight="fill" aria-hidden />
                <span>{utilization} продуктивность</span>
              </small>
            </div>
            <div className="agenda-header-actions">
              <button
                type="button"
                className="agenda-create-goal-button agenda-create-goal-button--desktop"
                onClick={openNewGoalFlow}
                aria-label="Новая цель"
              >
                <Plus size={18} weight="bold" aria-hidden />
                <span className="agenda-create-goal-button-label">Новая цель</span>
              </button>

              <div className="notification-shell notification-shell--desktop" ref={notificationsRef}>
                <button
                  type="button"
                  className="icon-button notification-button"
                  onClick={() => {
                    setShowNotifications(prev => !prev)
                    setShowGoalMenu(false)
                    setShowUserMenu(false)
                  }}
                  aria-label="Уведомления"
                >
                  <Bell size={20} weight="regular" aria-hidden />
                  {agendaNotifications.length > 0 ? (
                    <span className="notification-badge" aria-hidden="true">
                      {Math.min(agendaNotifications.length, 9)}
                    </span>
                  ) : null}
                </button>

                {showNotifications && (
                  <div className="notification-panel" role="dialog" aria-label="Уведомления">
                    <div className="notification-panel-head">
                      <strong>Уведомления</strong>
                      <span className="secondary-text">{agendaNotifications.length || 0}</span>
                    </div>

                    {agendaNotifications.length === 0 ? (
                      <p className="secondary-text notification-empty">
                        Пока всё спокойно: просроченных шагов и новых напоминаний нет.
                      </p>
                    ) : (
                      <div className="notification-list">
                        {agendaNotifications.map(item => (
                          <button
                            key={item.id}
                            type="button"
                            className={`notification-item notification-item--${item.tone}`}
                            onClick={() => handleNotificationSelect(item)}
                          >
                            <span className="notification-item-title">{item.title}</span>
                            <span className="notification-item-text">{item.text}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      className="text-button notification-settings-link"
                      onClick={() => {
                        setShowNotifications(false)
                        setShowProfile(true)
                      }}
                    >
                      Открыть настройки
                    </button>
                  </div>
                )}
              </div>

              <div className="user-menu-shell" ref={userMenuRef}>
                <button
                  type="button"
                  className={`icon-button user-menu-button ${showUserMenu ? 'user-menu-button--open' : ''}`}
                  onClick={() => {
                    setShowUserMenu(prev => !prev)
                    setShowNotifications(false)
                    setShowGoalMenu(false)
                  }}
                  aria-label="Меню пользователя"
                  aria-haspopup="menu"
                  aria-expanded={showUserMenu}
                >
                  <User size={20} weight="regular" aria-hidden />
                </button>

                {showUserMenu && (
                  <div className="user-menu-panel" role="menu" aria-label="Пользователь">
                    <button
                      type="button"
                      className="user-menu-item"
                      onClick={() => openProfileScreen('profile')}
                    >
                      <User size={18} weight="regular" aria-hidden />
                      <span>Профиль</span>
                    </button>
                    <button
                      type="button"
                      className="user-menu-item"
                      onClick={() => openProfileScreen('settings')}
                    >
                      <Gear size={18} weight="regular" aria-hidden />
                      <span>Настройки</span>
                    </button>
                    <button
                      type="button"
                      className="user-menu-item user-menu-item--danger"
                      onClick={handleMenuLogout}
                    >
                      <SignOut size={18} weight="regular" aria-hidden />
                      <span>Выйти</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {showUserMenu && (
            <button
              type="button"
              className="user-menu-backdrop"
              aria-hidden="true"
              tabIndex={-1}
              onClick={() => setShowUserMenu(false)}
            />
          )}

          <div className="agenda-layout">
            <div className="agenda-column agenda-column--main">
              <div className="section-heading-row section-heading-row--goal">
                <h2>Текущая цель</h2>
              </div>

              <div className="goal-summary-card">
                {!activeGoal ? (
                  <button
                    type="button"
                    className="goal-hero-empty-cta"
                    onClick={openNewGoalFlow}
                    aria-label="Написать новую цель"
                  >
                    <span className="goal-hero-empty-title">Напишите сюда цель</span>
                    <span className="secondary-text goal-hero-empty-hint">
                      Например: подготовиться к экзамену, начать бегать или навести порядок дома
                    </span>
                  </button>
                ) : (
                  <div className="goal-summary-main">
                    <span className="goal-summary-icon" aria-hidden="true">
                      <GoalCategoryIcon category={activeGoal.category} size={28} />
                    </span>

                    <div className="goal-summary-content">
                      <div className="goal-selector-shell" ref={goalMenuRef}>
                        <button
                          type="button"
                          className={`goal-selector-button ${showGoalMenu ? 'goal-selector-button--open' : ''}`}
                          aria-haspopup="menu"
                          aria-expanded={showGoalMenu}
                          onClick={() => {
                            setShowGoalMenu(prev => !prev)
                            setShowNotifications(false)
                            setShowUserMenu(false)
                          }}
                        >
                          <span className="goal-selector-button-label">{activeGoal.text}</span>
                          <CaretDown
                            size={18}
                            weight="bold"
                            aria-hidden
                            className={`goal-selector-caret ${showGoalMenu ? 'goal-selector-caret--open' : ''}`}
                          />
                        </button>

                        {showGoalMenu && (
                          <div className="goal-dropdown" role="menu" aria-label="Выбор текущей цели">
                            {safeGoals.map(goal => (
                              <button
                                key={goal.id}
                                type="button"
                                className={`goal-dropdown-item ${goal.id === activeGoal.id ? 'goal-dropdown-item--active' : ''}`}
                                onClick={() => setCurrentGoal(goal.id)}
                              >
                                <span className="goal-dropdown-item-title">{goal.text}</span>
                                <span className="goal-dropdown-item-meta">
                                  {(goal.microGoals || []).length} шагов
                                </span>
                              </button>
                            ))}

                            <button
                              type="button"
                              className="goal-dropdown-create"
                              onClick={openNewGoalFlow}
                            >
                              <Plus size={16} weight="bold" aria-hidden />
                              Новая цель
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="goal-progress-row">
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
                        <span className="type-accent-number goal-progress-value">
                          {activeGoalProgress.percent}%
                        </span>
                      </div>

                      <p className="secondary-text goal-progress-copy">
                        {activeGoalProgress.completedCount} из {activeGoalProgress.total} шагов выполнено
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div ref={agendaTasksRef} />
              <div className="section-heading-row section-heading-row--steps">
                <h2 className="section-h2-tight">Шаги</h2>
                {activeGoal ? (
                  <span className="task-section-count task-section-count--all">
                    {agendaMicroTasks.length}
                  </span>
                ) : null}
              </div>
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
                <div className="task-sections">
                  {agendaTaskSections.map((section, sectionIndex) => (
                    <section key={section.id} className={`task-section task-section--${section.id}`}>
                      <div className="task-section-head">
                        <div className="task-section-title-wrap">
                          <span
                            className={`task-section-marker task-section-marker--${section.tone}`}
                            aria-hidden="true"
                          />
                          <h3>{section.title}</h3>
                        </div>
                        <span className={`task-section-count task-section-count--${section.id}`}>
                          {section.items.length}
                        </span>
                      </div>

                      <div className="tasks-grid">
                        {section.items.length === 0 ? (
                          <p className="secondary-text task-section-empty">Пока пусто</p>
                        ) : null}
                        {section.items.map((task, index) => {
                          const todayKey = toIsoDate(new Date())
                          const visualTone = getAgendaTaskTone(task, todayKey)
                          const showWarning = isRecommendedDatePassed(task)

                          return (
                            <article
                              key={task.id}
                              className={`task-card micro-appear task-card--${visualTone} ${task.completed ? 'task-card--completed' : ''} ${highlightedTaskIds.includes(task.id) ? 'task-card--fresh' : ''}`}
                              style={{ '--appear-i': sectionIndex * 6 + index }}
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

                                <div className="task-card-body">
                                  <div className="task-card-content-row">
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

                                    {task.completed ? (
                                      <span className="task-date-badge task-date-badge--done">
                                        <CalendarBlank size={14} weight="regular" aria-hidden />
                                        {task.completedAt
                                          ? formatCompactDateTime(task.completedAt)
                                          : 'Выполнено'}
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className={`task-date-button ${showWarning ? 'task-date-button--overdue' : ''}`}
                                        aria-label="Выбрать дату для шага"
                                        onClick={() =>
                                          openGeneratedDateEditor('task', {
                                            goalId: activeGoal.id,
                                            taskId: task.id,
                                            value: normalizeIsoDate(task.recommendedDate),
                                          })
                                        }
                                      >
                                        <CalendarBlank size={14} weight="regular" aria-hidden />
                                        {task.recommendedDate
                                          ? formatRecommendedDate(task.recommendedDate)
                                          : 'Без даты'}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {showWarning && (
                                <span className="task-card-warning">Рекомендованная дата уже прошла</span>
                              )}
                            </article>
                          )
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}

              {activeGoal ? (
                <button
                  type="button"
                  className="tasks-add-button"
                  onClick={() => openTaskEditor(activeGoal.id)}
                >
                  <Plus size={18} weight="bold" aria-hidden />
                  Добавить шаг
                </button>
              ) : null}
            </div>

            <aside className="agenda-column agenda-column--side" ref={recommendationsRef}>
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
                        <button
                          type="button"
                          className="recommendation-card-preview"
                          onClick={() => setSelectedRecommendationId(item.id)}
                        >
                          <div className="recommendation-icon">
                            <Sparkle size={22} weight="regular" aria-hidden />
                          </div>
                          <p>{item.text}</p>
                        </button>
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
                              aria-label="Добавить в план"
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
                  ? 'Вот стартовый план. Добавляйте шаги по одному и сразу ставьте дату.'
                  : 'Опиши цель — мы разобьём её на шаги.'}
              </p>
            </div>
            <div />
          </header>

          {!showGeneratedResult && (
            <>
              <div className="generation-home-grid">
                <div className="generation-home-main">
                  <div className="empty-space" />
                  <h2 className="center-title generation-main-title">Опиши цель — мы разобьём её на шаги</h2>
                  <div className="generation-form-card">
                    <label htmlFor="generation-input" className="generation-label">
                      Цель
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
                    <div className="generation-preview-card" aria-hidden="true">
                      <div className="generation-preview-head">
                        <span className="generation-preview-icon" aria-hidden="true">🎯</span>
                        <span className="generation-label">Пример</span>
                      </div>
                      <div className="generation-preview-lines">
                        <strong>Выучить английский</strong>
                        <span>1. Выучить 10 новых слов</span>
                        <span>2. Посмотреть короткое видео</span>
                        <span>3. Составить диалог из 5 фраз</span>
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
                    {isGenerating ? 'Генерируем шаги…' : 'Получить шаги'}
                  </button>
                  {isGenerating ? (
                    <div className="generation-loading-card" aria-live="polite">
                      <strong>Генерируем шаги...</strong>
                      <span>⚡ Анализируем цель</span>
                      <span>⚡ Подбираем первые шаги</span>
                    </div>
                  ) : null}
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
                <h2 className="gen-micro-title">Вот план</h2>
                <p className="secondary-text gen-ai-sub">
                  Добавляйте шаги по одному и сразу переносите их в план.
                </p>
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
                          aria-label="Добавить в план и сгенерировать новый шаг"
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
                    aria-label="Добавить свой шаг в план"
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

      {selectedRecommendation && (
        <div className="modal-backdrop" onClick={() => setSelectedRecommendationId(null)}>
          <section
            className="task-modal recommendation-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Рекомендация"
            onClick={e => e.stopPropagation()}
          >
            <div className="task-modal-head">
              <h2>Рекомендация</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть"
                onClick={() => setSelectedRecommendationId(null)}
              >
                <X size={20} weight="regular" aria-hidden />
              </button>
            </div>

            <div className="recommendation-modal-body">
              <span className="recommendation-modal-badge">Идея для текущей цели</span>
              <p className="recommendation-modal-text">{selectedRecommendation.text}</p>
              <p className="secondary-text recommendation-modal-note">
                Сразу добавьте шаг в план или сначала выберите дату.
              </p>
            </div>

            <div className="task-modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  openGeneratedDateEditor('recommendation', {
                    recommendationId: selectedRecommendation.id,
                    value: normalizeIsoDate(selectedRecommendation.recommendedDate),
                  })
                }
              >
                Выбрать дату
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => addRecommendationToActiveGoal(selectedRecommendation)}
              >
                Добавить в план
              </button>
            </div>
          </section>
        </div>
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
            <div className="screen-header-copy">
              <h1>Настройки</h1>
              <p className="secondary-text settings-screen-copy">Управляйте своим профилем и приложением</p>
            </div>
            <div />
          </header>
          <div className="settings-sections">
            <section className="settings-section" ref={profileSectionRef}>
              <div className="settings-section-title">
                <span className="settings-section-icon" aria-hidden="true">
                  <User size={18} weight="regular" />
                </span>
                <h2>Профиль</h2>
              </div>
              <div className="settings-card">
                <div className="settings-input-row">
                  <label className="settings-field">
                    <span className="settings-info-label">Имя</span>
                    <input
                      type="text"
                      className="settings-text-input"
                      value={nameDraft}
                      onChange={event => {
                        setNameDraft(event.target.value)
                        setProfileError('')
                        setProfileInfo('')
                      }}
                      placeholder="Ваше имя"
                      maxLength={80}
                    />
                  </label>
                </div>
                <div className="settings-input-row">
                  <label className="settings-field settings-field--locked">
                    <span className="settings-info-label">Почта</span>
                    <span className="settings-input-shell settings-input-shell--locked">
                      <input
                        type="email"
                        className="settings-text-input settings-text-input--locked"
                        value={userEmail || ''}
                        readOnly
                        aria-readonly="true"
                      />
                      <span className="settings-input-trailing" aria-hidden="true">
                        <Lock size={16} weight="regular" />
                      </span>
                    </span>
                  </label>
                </div>
                <p className="secondary-text settings-card-note">Данные аккаунта</p>
                <div className="settings-card-actions">
                  {profileError ? <p className="settings-status-text settings-status-text--error">{profileError}</p> : null}
                  {!profileError && profileInfo ? (
                    <p className="settings-status-text settings-status-text--success">{profileInfo}</p>
                  ) : null}
                  <button
                    type="button"
                    className="primary-button settings-save-button"
                    onClick={saveProfileSettings}
                    disabled={!canSaveProfile}
                  >
                    {profileBusy ? 'Сохраняем…' : 'Сохранить изменения'}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-section" ref={settingsSectionRef}>
              <div className="settings-section-title">
                <span className="settings-section-icon" aria-hidden="true">
                  <Lock size={18} weight="regular" />
                </span>
                <h2>Безопасность</h2>
              </div>
              <div className="settings-card">
                <button
                  type="button"
                  className="settings-action-row"
                  onClick={beginPasswordResetFromSettings}
                  disabled={authBusy || !isValidEmail(userEmail)}
                >
                  <span>Восстановить пароль</span>
                  <CaretRight size={18} weight="bold" aria-hidden />
                </button>
                <p className="secondary-text settings-card-note">
                  Рекомендуем периодически обновлять пароль для защиты аккаунта.
                </p>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-title">
                <span className="settings-section-icon" aria-hidden="true">
                  <Database size={18} weight="regular" />
                </span>
                <h2>Данные</h2>
              </div>
              <div className="settings-card">
                <button
                  type="button"
                  className="settings-action-row"
                  onClick={clearCompletedHistory}
                  disabled={!hasResettableData}
                >
                  <span>Сбросить данные</span>
                  <CaretRight size={18} weight="bold" aria-hidden />
                </button>
                <p className="secondary-text settings-card-note">
                  {hasResettableData
                    ? 'Удаление данных очистит цели, завершённые цели и недавние генерации в этом аккаунте.'
                    : 'Пока нет данных для сброса.'}
                </p>
              </div>
            </section>

            <section className="settings-section settings-section--danger">
              <div className="settings-section-title settings-section-title--danger">
                <span className="settings-section-icon settings-section-icon--danger" aria-hidden="true">
                  <SignOut size={18} weight="regular" />
                </span>
                <h2>Выход</h2>
              </div>
              <div className="settings-card">
                <button type="button" className="settings-action-row settings-action-row--danger" onClick={logoutUser}>
                  <span>Выйти из аккаунта</span>
                  <CaretRight size={18} weight="bold" aria-hidden />
                </button>
                <p className="secondary-text settings-card-note">Вы будете перенаправлены на экран входа.</p>
              </div>
            </section>
          </div>
        </section>
      )}
        </div>
      </div>

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
