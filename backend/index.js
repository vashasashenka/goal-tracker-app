import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import pg from 'pg'
import OpenAI from 'openai'
import path from 'node:path'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

dotenv.config()

const { Pool } = pg
const scrypt = promisify(scryptCallback)
const MIN_PASSWORD_LENGTH = 8

const app = express()
const PORT = Number(process.env.PORT) || 5001
const dbHost = String(process.env.DB_HOST || '').trim()
const useDbSsl =
  /^(1|true|required)$/i.test(String(process.env.DB_SSL || '').trim()) ||
  (dbHost && dbHost !== 'localhost' && dbHost !== '127.0.0.1')

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(item => item.trim())
  : true

app.use(cors({ origin: corsOrigin }))
app.use(express.json())

const pool = new Pool({
  user: process.env.DB_USER,
  host: dbHost,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD || undefined,
  port: Number(process.env.DB_PORT),
  ssl: useDbSsl ? { rejectUnauthorized: false } : undefined,
})

const yandex = new OpenAI({
  apiKey: process.env.YANDEX_API_KEY || 'missing',
  baseURL: 'https://llm.api.cloud.yandex.net/v1',
})

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query('ALTER TABLE goals ADD COLUMN IF NOT EXISTS owner_key TEXT')
  await pool.query('ALTER TABLE completed_goals ADD COLUMN IF NOT EXISTS owner_key TEXT')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)')
  await pool.query('CREATE INDEX IF NOT EXISTS idx_goals_owner_key ON goals(owner_key)')
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_completed_goals_owner_key ON completed_goals(owner_key)'
  )
}

const schemaReady = ensureSchema().catch(error => {
  console.error('Ошибка подготовки схемы БД:', error)
  throw error
})

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))
}

function isValidPassword(password) {
  return String(password || '').length >= MIN_PASSWORD_LENGTH
}

function ownerKeyForUserId(userId) {
  return `user:${userId}`
}

function getSessionToken(req) {
  const headerToken = String(req.get('x-session-token') || '').trim()
  if (headerToken) return headerToken

  const authHeader = String(req.get('authorization') || '').trim()
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, '').trim() || null
  }

  return null
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = await scrypt(String(password || ''), salt, 64)
  return `${salt}:${Buffer.from(derivedKey).toString('hex')}`
}

async function verifyPassword(password, storedHash) {
  const [salt, hashed] = String(storedHash || '').split(':')
  if (!salt || !hashed) return false

  const storedBuffer = Buffer.from(hashed, 'hex')
  const derivedKey = Buffer.from(await scrypt(String(password || ''), salt, storedBuffer.length))
  if (storedBuffer.length !== derivedKey.length) return false

  return timingSafeEqual(storedBuffer, derivedKey)
}

function createSessionToken() {
  return randomBytes(32).toString('hex')
}

function buildAuthResponse(user, sessionToken) {
  return {
    sessionToken,
    user: {
      name: String(user?.name || '').trim(),
      email: normalizeEmail(user?.email),
    },
  }
}

async function migrateLegacyOwnerKey(client, email, ownerKey) {
  const legacyKey = normalizeEmail(email)
  if (!legacyKey || !ownerKey) return

  await client.query('UPDATE goals SET owner_key = $1 WHERE owner_key = $2', [ownerKey, legacyKey])
  await client.query('UPDATE completed_goals SET owner_key = $1 WHERE owner_key = $2', [
    ownerKey,
    legacyKey,
  ])
}

async function resolveAuth(req) {
  const sessionToken = getSessionToken(req)
  if (!sessionToken) return null

  const result = await pool.query(
    `
      SELECT u.id, u.name, u.email
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = $1
      LIMIT 1
    `,
    [sessionToken]
  )

  if (result.rows.length === 0) return null

  const row = result.rows[0]
  return {
    sessionToken,
    userId: Number(row.id),
    name: String(row.name || '').trim(),
    email: normalizeEmail(row.email),
    ownerKey: ownerKeyForUserId(row.id),
  }
}

async function requireAuth(req, res) {
  const auth = await resolveAuth(req)
  if (auth) return auth

  res.status(401).json({ error: 'Нужно войти в аккаунт' })
  return null
}

function yandexMisconfigured(res) {
  const key = (process.env.YANDEX_API_KEY || '').trim()
  const folder = (process.env.YANDEX_FOLDER_ID || '').trim()
  if (!key || key === 'your_key_here') {
    res.status(503).json({
      error:
        'Не настроен Yandex GPT: укажите YANDEX_API_KEY в backend/.env (секретный ключ сервисного аккаунта)',
    })
    return true
  }
  if (!folder || folder === 'your_folder_id_here') {
    res.status(503).json({
      error:
        'Не настроен Yandex GPT: укажите YANDEX_FOLDER_ID в backend/.env (id каталога в Yandex Cloud)',
    })
    return true
  }
  return false
}

function mapAiError(error) {
  const msg = String(error?.message || '')
  if (msg.includes('ИИ вернул недостаточно')) return msg
  if (error?.status === 401 || msg.includes('401') || msg.toLowerCase().includes('unauthorized')) {
    return 'Yandex API отклонил запрос: проверьте ключ и права сервисного аккаунта на каталог'
  }
  return 'Не удалось получить ответ ИИ'
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

const CHECKPOINT_GAP_DAYS = [3, 4, 7, 7, 14, 14, 21]

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

function makeCheckpointHint(order) {
  const checkpointOrder = Math.max(1, Math.trunc(Number(order) || 1))
  return {
    checkpointOrder,
    recommendedOffsetDays: checkpointOffsetForOrder(checkpointOrder),
  }
}

async function generateMicroGoals(goalText, existingTexts = [], count = 3) {
  const existingPart =
    existingTexts.length > 0
      ? `Не повторяй такие варианты: ${existingTexts.join('; ')}.`
      : ''
  const requestedCount = Math.max(count * 4, count + 3)

  const response = await yandex.chat.completions.create({
    model: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite/latest`,
    temperature: 0.9,
    messages: [
      {
        role: 'system',
        content:
          'Ты помощник по достижению целей. Предлагай короткие, конкретные и разные микроцели на русском языке. Только список без вступления.',
      },
      {
        role: 'user',
        content: `Цель: ${goalText}. Предложи ${requestedCount} разных микроцелей без повторов по смыслу и формулировке. ${existingPart}`,
      },
    ],
  })

  const text = response.choices?.[0]?.message?.content || ''

  const parsed = text
    .split('\n')
    .map(t => t.replace(/^\d+[).\s-]*/, '').trim())
    .filter(Boolean)

  const deduped = []
  for (const candidate of parsed) {
    const duplicateInExisting = existingTexts.some(
      existing => textSimilarity(existing, candidate) >= 0.65
    )
    const duplicateInNew = deduped.some(item => textSimilarity(item, candidate) >= 0.65)
    if (!duplicateInExisting && !duplicateInNew) {
      deduped.push(candidate)
    }
    if (deduped.length >= count) break
  }

  if (deduped.length < count) {
    throw new Error('ИИ вернул недостаточно уникальных шагов')
  }

  return deduped
}

app.get('/', (req, res) => {
  res.send('Goal Tracker API is running')
})

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = normalizeEmail(req.body?.email)
  const password = String(req.body?.password || '')

  if (!name) {
    return res.status(400).json({ error: 'Имя обязательно' })
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (!isValidPassword(password)) {
    return res
      .status(400)
      .json({ error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` })
  }

  let client
  try {
    await schemaReady
    client = await pool.connect()
    await client.query('BEGIN')

    const passwordHash = await hashPassword(password)
    const createdUser = await client.query(
      `
        INSERT INTO users (email, name, password_hash)
        VALUES ($1, $2, $3)
        ON CONFLICT (email) DO NOTHING
        RETURNING id, name, email
      `,
      [email, name, passwordHash]
    )

    if (createdUser.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Аккаунт с такой почтой уже существует' })
    }

    const user = createdUser.rows[0]
    const ownerKey = ownerKeyForUserId(user.id)
    await migrateLegacyOwnerKey(client, email, ownerKey)

    const sessionToken = createSessionToken()
    await client.query('INSERT INTO user_sessions (token, user_id) VALUES ($1, $2)', [
      sessionToken,
      user.id,
    ])

    await client.query('COMMIT')
    res.status(201).json(buildAuthResponse(user, sessionToken))
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Ошибка регистрации:', error)
    res.status(500).json({ error: 'Не удалось создать аккаунт' })
  } finally {
    client?.release()
  }
})

app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const password = String(req.body?.password || '')

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (!password) {
    return res.status(400).json({ error: 'Введите пароль' })
  }

  let client
  try {
    await schemaReady
    client = await pool.connect()
    await client.query('BEGIN')

    const userResult = await client.query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1 LIMIT 1',
      [email]
    )

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(401).json({ error: 'Неверная почта или пароль' })
    }

    const user = userResult.rows[0]
    const passwordOk = await verifyPassword(password, user.password_hash)
    if (!passwordOk) {
      await client.query('ROLLBACK')
      return res.status(401).json({ error: 'Неверная почта или пароль' })
    }

    await migrateLegacyOwnerKey(client, email, ownerKeyForUserId(user.id))

    const sessionToken = createSessionToken()
    await client.query('INSERT INTO user_sessions (token, user_id) VALUES ($1, $2)', [
      sessionToken,
      user.id,
    ])

    await client.query('COMMIT')
    res.json(buildAuthResponse(user, sessionToken))
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Ошибка входа:', error)
    res.status(500).json({ error: 'Не удалось выполнить вход' })
  } finally {
    client?.release()
  }
})

app.get('/api/auth/me', async (req, res) => {
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return

    res.json({
      user: {
        name: auth.name,
        email: auth.email,
      },
    })
  } catch (error) {
    console.error('Ошибка получения профиля:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.post('/api/auth/logout', async (req, res) => {
  try {
    await schemaReady
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      await pool.query('DELETE FROM user_sessions WHERE token = $1', [sessionToken])
    }
    res.status(204).end()
  } catch (error) {
    console.error('Ошибка выхода:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.get('/api/goals', async (req, res) => {
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query('SELECT * FROM goals WHERE owner_key = $1 ORDER BY id DESC', [
      auth.ownerKey,
    ])

    res.json(
      result.rows.map(row => ({
        id: Number(row.id),
        text: row.text,
        microGoals: row.micro_goals,
      }))
    )
  } catch (error) {
    console.error('Ошибка получения целей:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.get('/api/completed-goals', async (req, res) => {
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query(
      'SELECT * FROM completed_goals WHERE owner_key = $1 ORDER BY finished_at DESC NULLS LAST',
      [auth.ownerKey]
    )

    res.json(
      result.rows.map(row => ({
        id: Number(row.id),
        text: row.text,
        microGoals: row.micro_goals,
        finishedAt: row.finished_at,
      }))
    )
  } catch (error) {
    console.error('Ошибка получения завершённых целей:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})
app.post('/api/preview-microgoals', async (req, res) => {
  const { text, existingTexts, count: rawCount } = req.body

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Текст цели обязателен' })
  }

  if (yandexMisconfigured(res)) return

  const n = Number(rawCount)
  const count = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 6) : 3

  try {
    const generated = await generateMicroGoals(
      text,
      Array.isArray(existingTexts) ? existingTexts : [],
      count
    )

    const microGoals = generated.map((t, i) => ({
      id: Date.now() + i,
      text: t,
      completed: false,
      suggested: true,
      ...makeCheckpointHint(i + 1),
    }))

    res.json(microGoals)
  } catch (error) {
    console.error('Ошибка preview микроцелей:', error)
    res.status(500).json({ error: mapAiError(error) })
  }
})
app.post('/api/goals', async (req, res) => {
  const { text, microGoals: rawMicroGoals } = req.body

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Текст цели обязателен' })
  }

  let microGoals
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return

    if (Array.isArray(rawMicroGoals)) {
      microGoals = rawMicroGoals
    } else {
      if (yandexMisconfigured(res)) return

      let generated
      try {
        generated = await generateMicroGoals(text, [], 3)
      } catch (error) {
        console.error('Ошибка создания цели (ИИ):', error)
        return res.status(500).json({ error: mapAiError(error) })
      }

      microGoals = generated.map((t, i) => ({
        id: Date.now() + i,
        text: t,
        completed: false,
        suggested: true,
        ...makeCheckpointHint(i + 1),
      }))
    }

    const id = Date.now()
    await pool.query(
      'INSERT INTO goals (id, text, micro_goals, owner_key) VALUES ($1, $2, $3, $4)',
      [id, text, JSON.stringify(microGoals), auth.ownerKey]
    )

    res.status(201).json({
      id,
      text,
      microGoals,
    })
  } catch (error) {
    console.error('Ошибка создания цели:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.post('/api/goals/:id/generate-one', async (req, res) => {
  const goalId = Number(req.params.id)

  if (yandexMisconfigured(res)) return

  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query('SELECT * FROM goals WHERE id = $1 AND owner_key = $2', [
      goalId,
      auth.ownerKey,
    ])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Цель не найдена' })
    }

    const row = result.rows[0]
    const microGoals = row.micro_goals || []

    const existingTexts = microGoals.map(m => m.text)
    const generated = await generateMicroGoals(row.text, existingTexts, 1)

    const newMicroGoal = {
      id: Date.now(),
      text: generated[0] || 'Следующий маленький шаг',
      completed: false,
      suggested: true,
      ...makeCheckpointHint((Array.isArray(microGoals) ? microGoals.length : 0) + 1),
    }

    res.json(newMicroGoal)
  } catch (error) {
    console.error('Ошибка генерации микроцели:', error)
    res.status(500).json({ error: mapAiError(error) })
  }
})

app.put('/api/goals/:id', async (req, res) => {
  const goalId = Number(req.params.id)
  const { text, microGoals } = req.body

  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query(
      'UPDATE goals SET text = $1, micro_goals = $2 WHERE id = $3 AND owner_key = $4 RETURNING *',
      [text, JSON.stringify(microGoals), goalId, auth.ownerKey]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Цель не найдена' })
    }

    const row = result.rows[0]

    res.json({
      id: Number(row.id),
      text: row.text,
      microGoals: row.micro_goals,
    })
  } catch (error) {
    console.error('Ошибка обновления цели:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.delete('/api/goals', async (req, res) => {
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    await pool.query('DELETE FROM goals WHERE owner_key = $1', [auth.ownerKey])
    res.json({ message: 'Все активные цели удалены' })
  } catch (error) {
    console.error('Ошибка удаления целей:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.delete('/api/goals/:id', async (req, res) => {
  const goalId = Number(req.params.id)

  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    await pool.query('DELETE FROM goals WHERE id = $1 AND owner_key = $2', [goalId, auth.ownerKey])
    res.json({ message: 'Цель удалена' })
  } catch (error) {
    console.error('Ошибка удаления цели:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.post('/api/completed-goals', async (req, res) => {
  const { id, text, microGoals, finishedAt } = req.body

  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    await pool.query(
      `
      INSERT INTO completed_goals (id, text, micro_goals, finished_at, owner_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
      `,
      [id, text, JSON.stringify(microGoals), finishedAt || null, auth.ownerKey]
    )

    await pool.query('DELETE FROM goals WHERE id = $1 AND owner_key = $2', [id, auth.ownerKey])

    res.status(201).json({
      id,
      text,
      microGoals,
      finishedAt,
    })
  } catch (error) {
    console.error('Ошибка переноса завершённой цели:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.delete('/api/completed-goals', async (req, res) => {
  try {
    await schemaReady
    const auth = await requireAuth(req, res)
    if (!auth) return
    await pool.query('DELETE FROM completed_goals WHERE owner_key = $1', [auth.ownerKey])
    res.json({ message: 'История очищена' })
  } catch (error) {
    console.error('Ошибка очистки истории:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
  })
}

export default app
