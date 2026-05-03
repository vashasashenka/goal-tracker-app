import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import pg from 'pg'
import OpenAI from 'openai'
import nodemailer from 'nodemailer'
import path from 'node:path'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

dotenv.config()

const { Pool } = pg
const scrypt = promisify(scryptCallback)
const MIN_PASSWORD_LENGTH = 8
const PASSWORD_RESET_CODE_LENGTH = 6
const EMAIL_VERIFICATION_CODE_LENGTH = PASSWORD_RESET_CODE_LENGTH
const PASSWORD_RESET_TTL_MINUTES = Math.max(
  5,
  Math.trunc(Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 15)
)
const PASSWORD_RESET_RESEND_SECONDS = Math.max(
  30,
  Math.trunc(Number(process.env.PASSWORD_RESET_RESEND_SECONDS) || 60)
)
const EMAIL_VERIFICATION_TTL_MINUTES = Math.max(
  5,
  Math.trunc(Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES) || PASSWORD_RESET_TTL_MINUTES)
)
const EMAIL_VERIFICATION_RESEND_SECONDS = Math.max(
  30,
  Math.trunc(
    Number(process.env.EMAIL_VERIFICATION_RESEND_SECONDS) || PASSWORD_RESET_RESEND_SECONDS
  )
)
const smtpHost = String(process.env.SMTP_HOST || '').trim()
const smtpPort = Math.trunc(Number(process.env.SMTP_PORT) || 0)
const smtpSecure = /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE || '').trim())
const smtpUser = String(process.env.SMTP_USER || '').trim()
const smtpPassword = String(process.env.SMTP_PASSWORD || '').trim()
const smtpFrom = String(process.env.SMTP_FROM || '').trim()
const smtpReplyTo = String(process.env.SMTP_REPLY_TO || '').trim()

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

let mailTransportPromise = null
let schemaReadyPromise = null

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `)
  await pool.query('ALTER TABLE goals ADD COLUMN IF NOT EXISTS owner_key TEXT')
  await pool.query('ALTER TABLE completed_goals ADD COLUMN IF NOT EXISTS owner_key TEXT')
  await pool.query("ALTER TABLE goals ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Другое'")
  await pool.query('ALTER TABLE goals ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()')
  await pool.query("ALTER TABLE completed_goals ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'Другое'")
  await pool.query(
    'ALTER TABLE completed_goals ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()'
  )
  await pool.query(
    "UPDATE goals SET category = 'Другое' WHERE category IS NULL OR BTRIM(category) = ''"
  )
  await pool.query('UPDATE goals SET created_at = NOW() WHERE created_at IS NULL')
  await pool.query(
    "UPDATE completed_goals SET category = 'Другое' WHERE category IS NULL OR BTRIM(category) = ''"
  )
  await pool.query(
    'UPDATE completed_goals SET created_at = COALESCE(finished_at, NOW()) WHERE created_at IS NULL'
  )
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)')
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_id ON password_reset_codes(user_id)'
  )
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email ON email_verification_codes(email)'
  )
  await pool.query('CREATE INDEX IF NOT EXISTS idx_goals_owner_key ON goals(owner_key)')
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_completed_goals_owner_key ON completed_goals(owner_key)'
  )
}

function ensureSchemaReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = ensureSchema().catch(error => {
      console.error('Ошибка подготовки схемы БД:', error)
      schemaReadyPromise = null
      throw error
    })
  }

  return schemaReadyPromise
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))
}

function isValidPassword(password) {
  return String(password || '').length >= MIN_PASSWORD_LENGTH
}

function isValidResetCode(code, length = PASSWORD_RESET_CODE_LENGTH) {
  return new RegExp(`^\\d{${length}}$`).test(String(code || '').trim())
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

function createNumericCode(length = PASSWORD_RESET_CODE_LENGTH) {
  const safeLength = Math.max(4, Math.trunc(Number(length) || PASSWORD_RESET_CODE_LENGTH))
  const number = randomBytes(4).readUInt32BE(0) % 10 ** safeLength
  return String(number).padStart(safeLength, '0')
}

function isMailConfigured() {
  if (!smtpHost || !smtpPort || !smtpFrom) return false
  if ((smtpUser && !smtpPassword) || (!smtpUser && smtpPassword)) return false
  return true
}

function mailMisconfigured(res) {
  if (isMailConfigured()) return false

  res.status(503).json({
    error:
      'Письма для подтверждения почты и восстановления пароля пока не настроены: заполните SMTP_HOST, SMTP_PORT, SMTP_FROM и при необходимости SMTP_USER/SMTP_PASSWORD в backend/.env',
  })
  return true
}

function getMailTransport() {
  if (!isMailConfigured()) {
    throw new Error('mail-not-configured')
  }

  if (!mailTransportPromise) {
    mailTransportPromise = Promise.resolve(
      nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        ...(smtpUser || smtpPassword
          ? {
              auth: {
                user: smtpUser,
                pass: smtpPassword,
              },
            }
          : {}),
      })
    )
  }

  return mailTransportPromise
}

function formatMinutes(count) {
  const abs = Math.abs(Math.trunc(Number(count) || 0))
  const lastTwo = abs % 100
  const last = abs % 10
  if (lastTwo >= 11 && lastTwo <= 14) return `${abs} минут`
  if (last === 1) return `${abs} минуту`
  if (last >= 2 && last <= 4) return `${abs} минуты`
  return `${abs} минут`
}

function maskEmail(email) {
  const normalized = normalizeEmail(email)
  const [localPart, domain] = normalized.split('@')
  if (!localPart || !domain) return normalized
  const visible = localPart.slice(0, 2)
  const hidden = '*'.repeat(Math.max(localPart.length - visible.length, 1))
  return `${visible}${hidden}@${domain}`
}

async function sendPasswordResetCode({ email, name, code }) {
  const transport = await getMailTransport()
  const ttlText = formatMinutes(PASSWORD_RESET_TTL_MINUTES)
  const safeName = String(name || '').trim()
  const greeting = safeName ? `Здравствуйте, ${safeName}!` : 'Здравствуйте!'

  await transport.sendMail({
    from: smtpFrom,
    to: email,
    ...(smtpReplyTo ? { replyTo: smtpReplyTo } : {}),
    subject: 'Goal Tracker: код для сброса пароля',
    text: `${greeting}

Вы запросили восстановление пароля в Goal Tracker.

Ваш код для сброса пароля: ${code}

Код действует ${ttlText}. Если это были не вы, просто проигнорируйте письмо.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #101828; line-height: 1.6;">
        <p>${greeting}</p>
        <p>Вы запросили восстановление пароля в <strong>Goal Tracker</strong>.</p>
        <p>Ваш код для сброса пароля:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 16px 0;">${code}</p>
        <p>Код действует ${ttlText}.</p>
        <p>Если это были не вы, просто проигнорируйте письмо.</p>
      </div>
    `,
  })
}

async function sendEmailVerificationCode({ email, name, code }) {
  const transport = await getMailTransport()
  const ttlText = formatMinutes(EMAIL_VERIFICATION_TTL_MINUTES)
  const safeName = String(name || '').trim()
  const greeting = safeName ? `Здравствуйте, ${safeName}!` : 'Здравствуйте!'

  await transport.sendMail({
    from: smtpFrom,
    to: email,
    ...(smtpReplyTo ? { replyTo: smtpReplyTo } : {}),
    subject: 'Goal Tracker: подтверждение почты',
    text: `${greeting}

Подтвердите почту в Goal Tracker.

Ваш код подтверждения: ${code}

Код действует ${ttlText}. Если это были не вы, просто проигнорируйте письмо.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #101828; line-height: 1.6;">
        <p>${greeting}</p>
        <p>Подтвердите почту в <strong>Goal Tracker</strong>.</p>
        <p>Ваш код подтверждения:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; margin: 16px 0;">${code}</p>
        <p>Код действует ${ttlText}.</p>
        <p>Если это были не вы, просто проигнорируйте письмо.</p>
      </div>
    `,
  })
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
const ALLOWED_GOAL_CATEGORIES = ['Учёба', 'Работа', 'Личное', 'Другое']

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

function fallbackGoalCategory(text) {
  const normalized = normalizeTaskText(text)
  if (!normalized) return 'Другое'
  if (
    /(учеб|экзам|курс|лекц|урок|дз|домашк|сесс|диплом|реферат|зачет|англий|универс|колледж)/.test(
      normalized
    )
  ) {
    return 'Учёба'
  }
  if (/(работ|проект|клиент|митинг|созвон|офис|продаж|карьер|резюме|интервью)/.test(normalized)) {
    return 'Работа'
  }
  if (/(спорт|бег|здоров|сон|дом|семь|хобби|личн|путешеств|поряд|уборк)/.test(normalized)) {
    return 'Личное'
  }
  return 'Другое'
}

async function classifyGoalCategory(goalText) {
  const fallback = fallbackGoalCategory(goalText)
  if (!String(goalText || '').trim()) return fallback
  if (!process.env.YANDEX_API_KEY || !process.env.YANDEX_FOLDER_ID) return fallback

  const response = await yandex.chat.completions.create({
    model: `gpt://${process.env.YANDEX_FOLDER_ID}/yandexgpt-lite/latest`,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Определи категорию цели. Верни только одно слово из списка: Учёба, Работа, Личное, Другое.',
      },
      {
        role: 'user',
        content: `Цель: ${goalText}`,
      },
    ],
  })

  const content = String(response.choices?.[0]?.message?.content || '').trim()
  const exact = ALLOWED_GOAL_CATEGORIES.find(item => item.toLowerCase() === content.toLowerCase())
  return exact || fallback
}

app.get('/', (req, res) => {
  res.send('Goal Tracker API is running')
})

app.post('/api/auth/register/request', async (req, res) => {
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
  if (mailMisconfigured(res)) return

  let client
  let verificationCodeHash = ''
  try {
    await ensureSchemaReady()
    client = await pool.connect()
    await client.query('BEGIN')

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Аккаунт с такой почтой уже существует' })
    }

    const latestCodeResult = await client.query(
      `
        SELECT created_at
        FROM email_verification_codes
        WHERE email = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [email]
    )

    if (latestCodeResult.rows.length > 0) {
      const createdAt = new Date(latestCodeResult.rows[0].created_at).getTime()
      const elapsedMs = Date.now() - createdAt
      const cooldownMs = EMAIL_VERIFICATION_RESEND_SECONDS * 1000 - elapsedMs

      if (cooldownMs > 0) {
        await client.query('ROLLBACK')
        return res.status(429).json({
          error: `Код уже отправлен. Попробуйте снова через ${Math.ceil(cooldownMs / 1000)} сек.`,
        })
      }
    }

    const passwordHash = await hashPassword(password)
    const code = createNumericCode(EMAIL_VERIFICATION_CODE_LENGTH)
    verificationCodeHash = await hashPassword(code)
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000)

    await client.query('DELETE FROM email_verification_codes WHERE email = $1', [email])
    await client.query(
      `
        INSERT INTO email_verification_codes (email, name, password_hash, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [email, name, passwordHash, verificationCodeHash, expiresAt]
    )

    await client.query('COMMIT')

    try {
      await sendEmailVerificationCode({
        email,
        name,
        code,
      })
    } catch (error) {
      console.error('Ошибка отправки письма для подтверждения почты:', error)
      await pool
        .query(
          `
            DELETE FROM email_verification_codes
            WHERE email = $1
              AND code_hash = $2
              AND used_at IS NULL
          `,
          [email, verificationCodeHash]
        )
        .catch(() => {})

      return res
        .status(500)
        .json({ error: 'Не удалось отправить письмо с кодом. Попробуйте позже.' })
    }

    res.status(202).json({
      message: `Код подтверждения отправлен на ${maskEmail(email)}.`,
    })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Аккаунт с такой почтой уже существует' })
    }
    console.error('Ошибка отправки кода регистрации:', error)
    res.status(500).json({ error: 'Не удалось отправить код. Попробуйте позже.' })
  } finally {
    client?.release()
  }
})

app.post('/api/auth/register/resend', async (req, res) => {
  const email = normalizeEmail(req.body?.email)

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (mailMisconfigured(res)) return

  let client
  let verificationCodeHash = ''
  try {
    await ensureSchemaReady()
    client = await pool.connect()
    await client.query('BEGIN')

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Аккаунт уже подтверждён. Войдите в него.' })
    }

    const pendingResult = await client.query(
      `
        SELECT name, password_hash, created_at
        FROM email_verification_codes
        WHERE email = $1
          AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [email]
    )

    if (pendingResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Начните регистрацию заново, чтобы получить код.' })
    }

    const createdAt = new Date(pendingResult.rows[0].created_at).getTime()
    const elapsedMs = Date.now() - createdAt
    const cooldownMs = EMAIL_VERIFICATION_RESEND_SECONDS * 1000 - elapsedMs

    if (cooldownMs > 0) {
      await client.query('ROLLBACK')
      return res.status(429).json({
        error: `Код уже отправлен. Попробуйте снова через ${Math.ceil(cooldownMs / 1000)} сек.`,
      })
    }

    const pending = pendingResult.rows[0]
    const code = createNumericCode(EMAIL_VERIFICATION_CODE_LENGTH)
    verificationCodeHash = await hashPassword(code)
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000)

    await client.query('DELETE FROM email_verification_codes WHERE email = $1', [email])
    await client.query(
      `
        INSERT INTO email_verification_codes (email, name, password_hash, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [email, pending.name, pending.password_hash, verificationCodeHash, expiresAt]
    )

    await client.query('COMMIT')

    try {
      await sendEmailVerificationCode({
        email,
        name: pending.name,
        code,
      })
    } catch (error) {
      console.error('Ошибка повторной отправки кода подтверждения:', error)
      await pool
        .query(
          `
            DELETE FROM email_verification_codes
            WHERE email = $1
              AND code_hash = $2
              AND used_at IS NULL
          `,
          [email, verificationCodeHash]
        )
        .catch(() => {})

      return res
        .status(500)
        .json({ error: 'Не удалось отправить письмо с кодом. Попробуйте позже.' })
    }

    res.json({
      message: `Новый код подтверждения отправлен на ${maskEmail(email)}.`,
    })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Ошибка повторной отправки кода регистрации:', error)
    res.status(500).json({ error: 'Не удалось отправить код. Попробуйте позже.' })
  } finally {
    client?.release()
  }
})

app.post('/api/auth/register/confirm', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const code = String(req.body?.code || '').trim()

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (!isValidResetCode(code, EMAIL_VERIFICATION_CODE_LENGTH)) {
    return res.status(400).json({ error: 'Введите 6-значный код из письма' })
  }

  let client
  try {
    await ensureSchemaReady()
    client = await pool.connect()
    await client.query('BEGIN')

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Аккаунт уже существует. Войдите в него.' })
    }

    const verificationResult = await client.query(
      `
        SELECT id, name, password_hash, code_hash
        FROM email_verification_codes
        WHERE email = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [email]
    )

    if (verificationResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res
        .status(400)
        .json({ error: 'Код истёк или не найден. Запросите новый код.' })
    }

    const verification = verificationResult.rows[0]
    const codeOk = await verifyPassword(code, verification.code_hash)
    if (!codeOk) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Неверный код' })
    }

    const createdUser = await client.query(
      `
        INSERT INTO users (email, name, password_hash)
        VALUES ($1, $2, $3)
        RETURNING id, name, email
      `,
      [email, verification.name, verification.password_hash]
    )

    if (createdUser.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Не удалось создать аккаунт' })
    }

    const user = createdUser.rows[0]
    await client.query('UPDATE email_verification_codes SET used_at = NOW() WHERE id = $1', [
      verification.id,
    ])
    await migrateLegacyOwnerKey(client, email, ownerKeyForUserId(user.id))

    const sessionToken = createSessionToken()
    await client.query('INSERT INTO user_sessions (token, user_id) VALUES ($1, $2)', [
      sessionToken,
      user.id,
    ])

    await client.query('COMMIT')
    res.status(201).json(buildAuthResponse(user, sessionToken))
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Аккаунт с такой почтой уже существует' })
    }
    console.error('Ошибка подтверждения почты:', error)
    res.status(500).json({ error: 'Не удалось подтвердить почту. Попробуйте позже.' })
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
    await ensureSchemaReady()
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
    await ensureSchemaReady()
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

app.patch('/api/auth/profile', async (req, res) => {
  const name = String(req.body?.name || '').trim()

  if (!name) {
    return res.status(400).json({ error: 'Имя не может быть пустым' })
  }
  if (name.length > 80) {
    return res.status(400).json({ error: 'Имя должно быть короче 80 символов' })
  }

  try {
    await ensureSchemaReady()
    const auth = await requireAuth(req, res)
    if (!auth) return

    const result = await pool.query(
      `
        UPDATE users
        SET name = $1
        WHERE id = $2
        RETURNING name, email
      `,
      [name, auth.userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Аккаунт не найден' })
    }

    res.json({
      user: {
        name: String(result.rows[0].name || '').trim(),
        email: normalizeEmail(result.rows[0].email),
      },
    })
  } catch (error) {
    console.error('Ошибка обновления профиля:', error)
    res.status(500).json({ error: 'Не удалось сохранить профиль' })
  }
})

app.post('/api/auth/logout', async (req, res) => {
  try {
    await ensureSchemaReady()
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

app.post('/api/auth/password-reset/request', async (req, res) => {
  const email = normalizeEmail(req.body?.email)

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (mailMisconfigured(res)) return

  let client
  let resetUserId = null
  let resetCodeHash = ''

  try {
    await ensureSchemaReady()
    client = await pool.connect()
    await client.query('BEGIN')

    const userResult = await client.query(
      'SELECT id, name, email FROM users WHERE email = $1 LIMIT 1',
      [email]
    )

    if (userResult.rows.length === 0) {
      await client.query('COMMIT')
      return res.json({
        message: 'Если аккаунт с такой почтой существует, мы отправили код для сброса пароля.',
      })
    }

    const user = userResult.rows[0]
    resetUserId = Number(user.id)

    const latestCodeResult = await client.query(
      `
        SELECT created_at
        FROM password_reset_codes
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [resetUserId]
    )

    if (latestCodeResult.rows.length > 0) {
      const createdAt = new Date(latestCodeResult.rows[0].created_at).getTime()
      const elapsedMs = Date.now() - createdAt
      const cooldownMs = PASSWORD_RESET_RESEND_SECONDS * 1000 - elapsedMs

      if (cooldownMs > 0) {
        await client.query('ROLLBACK')
        return res.status(429).json({
          error: `Код уже отправлен. Попробуйте снова через ${Math.ceil(cooldownMs / 1000)} сек.`,
        })
      }
    }

    await client.query('DELETE FROM password_reset_codes WHERE user_id = $1', [resetUserId])

    const code = createNumericCode(PASSWORD_RESET_CODE_LENGTH)
    resetCodeHash = await hashPassword(code)
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000)

    await client.query(
      `
        INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
        VALUES ($1, $2, $3)
      `,
      [resetUserId, resetCodeHash, expiresAt]
    )

    await client.query('COMMIT')

    try {
      await sendPasswordResetCode({
        email: user.email,
        name: user.name,
        code,
      })
    } catch (error) {
      console.error('Ошибка отправки письма для сброса пароля:', error)
      await pool
        .query(
          `
            DELETE FROM password_reset_codes
            WHERE user_id = $1
              AND code_hash = $2
              AND used_at IS NULL
          `,
          [resetUserId, resetCodeHash]
        )
        .catch(() => {})

      return res
        .status(500)
        .json({ error: 'Не удалось отправить письмо с кодом. Попробуйте позже.' })
    }

    res.json({
      message: `Код для сброса пароля отправлен на ${maskEmail(user.email)}.`,
    })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Ошибка запроса сброса пароля:', error)
    res.status(500).json({ error: 'Не удалось отправить код. Попробуйте позже.' })
  } finally {
    client?.release()
  }
})

app.post('/api/auth/password-reset/confirm', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const code = String(req.body?.code || '').trim()
  const newPassword = String(req.body?.newPassword || '')

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Введите корректную почту' })
  }
  if (!isValidResetCode(code)) {
    return res.status(400).json({ error: 'Введите 6-значный код из письма' })
  }
  if (!isValidPassword(newPassword)) {
    return res
      .status(400)
      .json({ error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов` })
  }

  let client
  try {
    await ensureSchemaReady()
    client = await pool.connect()
    await client.query('BEGIN')

    const userResult = await client.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    )
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Неверный код или почта' })
    }

    const userId = Number(userResult.rows[0].id)
    const resetCodeResult = await client.query(
      `
        SELECT id, code_hash
        FROM password_reset_codes
        WHERE user_id = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [userId]
    )

    if (resetCodeResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res
        .status(400)
        .json({ error: 'Код истёк или не найден. Запросите новый код.' })
    }

    const resetRow = resetCodeResult.rows[0]
    const codeOk = await verifyPassword(code, resetRow.code_hash)
    if (!codeOk) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Неверный код' })
    }

    const nextPasswordHash = await hashPassword(newPassword)
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [nextPasswordHash, userId])
    await client.query('UPDATE password_reset_codes SET used_at = NOW() WHERE id = $1', [
      resetRow.id,
    ])
    await client.query('DELETE FROM user_sessions WHERE user_id = $1', [userId])

    await client.query('COMMIT')
    res.status(204).end()
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('Ошибка подтверждения сброса пароля:', error)
    res.status(500).json({ error: 'Не удалось обновить пароль. Попробуйте позже.' })
  } finally {
    client?.release()
  }
})

app.get('/api/goals', async (req, res) => {
  try {
    await ensureSchemaReady()
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query('SELECT * FROM goals WHERE owner_key = $1 ORDER BY id DESC', [
      auth.ownerKey,
    ])

    res.json(
      result.rows.map(row => ({
        id: Number(row.id),
        text: row.text,
        category: row.category,
        createdAt: row.created_at,
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
    await ensureSchemaReady()
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
        category: row.category,
        createdAt: row.created_at,
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

app.post('/api/classify-goal-category', async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Текст цели обязателен' })

  try {
    const category = await classifyGoalCategory(text)
    res.json({ category })
  } catch (error) {
    console.error('Ошибка классификации цели:', error)
    res.json({ category: fallbackGoalCategory(text) })
  }
})

app.post('/api/goals', async (req, res) => {
  const { text, microGoals: rawMicroGoals, category = 'Другое', createdAt } = req.body

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Текст цели обязателен' })
  }

  let microGoals
  try {
    await ensureSchemaReady()
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
    const normalizedCreatedAt = createdAt || new Date().toISOString()
    await pool.query(
      'INSERT INTO goals (id, text, category, created_at, micro_goals, owner_key) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, text, category, normalizedCreatedAt, JSON.stringify(microGoals), auth.ownerKey]
    )

    res.status(201).json({
      id,
      text,
      category,
      createdAt: normalizedCreatedAt,
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
    await ensureSchemaReady()
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
  const { text, microGoals, category = 'Другое', createdAt } = req.body

  try {
    await ensureSchemaReady()
    const auth = await requireAuth(req, res)
    if (!auth) return
    const result = await pool.query(
      `
      UPDATE goals
      SET text = $1, micro_goals = $2, category = $3, created_at = COALESCE($4, created_at)
      WHERE id = $5 AND owner_key = $6
      RETURNING *
      `,
      [text, JSON.stringify(microGoals), category, createdAt || null, goalId, auth.ownerKey]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Цель не найдена' })
    }

    const row = result.rows[0]

    res.json({
      id: Number(row.id),
      text: row.text,
      category: row.category,
      createdAt: row.created_at,
      microGoals: row.micro_goals,
    })
  } catch (error) {
    console.error('Ошибка обновления цели:', error)
    res.status(500).json({ error: 'Ошибка сервера' })
  }
})

app.delete('/api/goals', async (req, res) => {
  try {
    await ensureSchemaReady()
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
    await ensureSchemaReady()
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
  const { id, text, microGoals, finishedAt, category = 'Другое', createdAt } = req.body

  try {
    await ensureSchemaReady()
    const auth = await requireAuth(req, res)
    if (!auth) return
    await pool.query(
      `
      INSERT INTO completed_goals (id, text, category, created_at, micro_goals, finished_at, owner_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO NOTHING
      `,
      [id, text, category, createdAt || finishedAt || new Date().toISOString(), JSON.stringify(microGoals), finishedAt || null, auth.ownerKey]
    )

    await pool.query('DELETE FROM goals WHERE id = $1 AND owner_key = $2', [id, auth.ownerKey])

    res.status(201).json({
      id,
      text,
      category,
      createdAt: createdAt || finishedAt || new Date().toISOString(),
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
    await ensureSchemaReady()
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
