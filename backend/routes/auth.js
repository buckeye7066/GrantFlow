import express from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import twilio from 'twilio'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initializeAnyaForAdmin } from '../services/anyaLoginTrigger.js'
import { recordClientSignInEvent } from '../services/adminLoginEventStore.js'
import { getOpenAIOptional } from '../utils/aiProviders.js'

// Import email service (with fallback if main service fails to load)
import { sendVerificationEmail as mainSendEmail, sendAuthAttemptNotification as mainAuthNotify } from '../services/email.js'
import { sendVerificationEmail as fallbackSendEmail } from '../services/emailFallback.js'

// Use main email service if available, otherwise fallback
const sendVerificationEmail = mainSendEmail || fallbackSendEmail
const sendAuthAttemptNotification = typeof mainAuthNotify === 'function' ? mainAuthNotify : async () => false
import { getDesignatedProfileForEmail } from '../config/userProfileMappings.js'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'
import { ensureAdminUser, isAdminUserId } from '../utils/adminProfileLinks.js'
import { triggerAutoDiscoveryCrawlers } from '../services/autoDiscoveryCrawlers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const uploadDir = join(__dirname, '..', 'uploads')

const router = express.Router()

function getOpenAI() {
  const openai = getOpenAIOptional()
  if (!openai) {
    console.warn('[auth] OpenAI not configured; AI-backed crawlers will fall back when possible')
    return null
  }
  return openai
}

function resolveJwtSecret() {
  const raw = String(process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || '').trim()
  const isProd = process.env.NODE_ENV === 'production'

  if (!raw) {
    // Production safety: do not hard-exit. A missing JWT secret otherwise causes a perpetual 502 on Railway.
    // We generate an ephemeral secret so the service can boot; all sessions will be invalidated on restart.
    if (isProd) {
      console.error(
        'ERROR: Missing AUTH_JWT_SECRET (or JWT_SECRET). Generating ephemeral secret so the service can start.\n' +
          'Fix: set AUTH_JWT_SECRET in Railway/Vercel env vars to a strong random secret (recommended: 32+ bytes).',
      )
      return crypto.randomBytes(32).toString('base64url')
    }
    console.warn('[auth] AUTH_JWT_SECRET not set; using insecure development default (DO NOT use in production).')
    return 'grantflow-dev-secret'
  }

  if (isProd && raw === 'grantflow-dev-secret') {
    console.error(
      'ERROR: AUTH_JWT_SECRET is set to the insecure development default. Generating ephemeral secret so the service can start.\n' +
        'Fix: set AUTH_JWT_SECRET in Railway/Vercel env vars to a strong random secret (recommended: 32+ bytes).',
    )
    return crypto.randomBytes(32).toString('base64url')
  }

  return raw
}

const JWT_SECRET = resolveJwtSecret()

function parseSeconds(value, fallback) {
  if (value === undefined || value === null) {
    return fallback
  }

  const trimmed = `${value}`.trim()
  if (trimmed === '') {
    return fallback
  }

  const directNumber = Number(trimmed)
  if (Number.isFinite(directNumber) && directNumber > 0) {
    return Math.round(directNumber)
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)(?:\s*)([a-z]+)?$/i)
  if (!match) {
    return fallback
  }

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    return fallback
  }

  const unitRaw = (match[2] || 's').toLowerCase()
  const unitMap = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 60 * 60,
    hr: 60 * 60,
    hrs: 60 * 60,
    hour: 60 * 60,
    hours: 60 * 60,
    d: 24 * 60 * 60,
    day: 24 * 60 * 60,
    days: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
    wk: 7 * 24 * 60 * 60,
    wks: 7 * 24 * 60 * 60,
    week: 7 * 24 * 60 * 60,
    weeks: 7 * 24 * 60 * 60,
  }

  const multiplier = unitMap[unitRaw]
  if (!multiplier) {
    return fallback
  }

  return Math.round(amount * multiplier)
}

const ACCESS_TOKEN_TTL = parseSeconds(process.env.AUTH_ACCESS_TOKEN_TTL, 10800) // Default: 3 hours (10800 seconds)
const REFRESH_TOKEN_TTL = parseSeconds(process.env.AUTH_REFRESH_TOKEN_TTL, 30 * 24 * 60 * 60) // seconds
const EMAIL_CODE_TTL = parseSeconds(process.env.AUTH_EMAIL_CODE_TTL, 600) // seconds
const EMAIL_RESEND_COOLDOWN = parseSeconds(process.env.AUTH_EMAIL_RESEND_SECONDS, 45) // seconds
const PHONE_CODE_TTL = parseSeconds(process.env.AUTH_PHONE_CODE_TTL, 600) // seconds
const PHONE_RESEND_COOLDOWN = parseSeconds(process.env.AUTH_PHONE_RESEND_SECONDS, 60) // seconds
const OAUTH_STATE_TTL = parseSeconds(process.env.AUTH_OAUTH_STATE_TTL, 600) // seconds

console.info('[auth] TTL configuration (seconds):', {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  EMAIL_CODE_TTL,
  EMAIL_RESEND_COOLDOWN,
  PHONE_CODE_TTL,
  PHONE_RESEND_COOLDOWN,
  OAUTH_STATE_TTL,
})

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || null
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || null
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || null

const AUTH_PUBLIC_URL = process.env.AUTH_PUBLIC_URL || process.env.PUBLIC_URL || null
const FRONTEND_BASE_URL = process.env.AUTH_FRONTEND_URL || process.env.FRONTEND_BASE_URL || null
const FRONTEND_APP_BASE =
  process.env.AUTH_FRONTEND_APP_BASE || process.env.APP_BASE_PATH || process.env.VITE_APP_BASE || '/grantflow'

const OAUTH_PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    supportsPKCE: true,
    useBasicAuth: false,
    extraAuthParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    userInfoUrl: 'https://graph.facebook.com/me?fields=id,name,email,picture.type(large)',
    scope: 'email,public_profile',
    supportsPKCE: false,
    useBasicAuth: false,
  },
  yahoo: {
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
    userInfoUrl: 'https://api.login.yahoo.com/openid/v1/userinfo',
    scope: 'openid email profile',
    supportsPKCE: true,
    useBasicAuth: true,
  },
}

let twilioClient = null
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  } catch (error) {
    console.error('[auth] Failed to initialize Twilio client:', error.message)
  }
}

const emailStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number.parseInt(process.env.AUTH_EMAIL_RATE_LIMIT ?? '10', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

const phoneStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number.parseInt(process.env.AUTH_PHONE_RATE_LIMIT ?? '6', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

function normalizeEmail(email = '') {
  return email.trim().toLowerCase()
}

function normalizeSixDigitCode(value) {
  if (value === null || value === undefined) return null
  // Accept string OR number payloads; strip non-digits to tolerate copy/paste formatting.
  const digits = String(value).trim().replace(/[^\d]/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  return digits
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function signOtpToken({ kind, identifier, codeHash, ttlSeconds }) {
  const jti = crypto.randomUUID()
  return jwt.sign(
    {
      typ: 'otp',
      kind,
      identifier,
      code_hash: codeHash,
      jti,
    },
    JWT_SECRET,
    { expiresIn: Math.max(30, Number(ttlSeconds) || 600) },
  )
}

function verifyOtpToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    if (!decoded || typeof decoded !== 'object') return null
    if (decoded.typ !== 'otp') return null
    if (decoded.kind !== 'email') return null
    if (typeof decoded.identifier !== 'string' || typeof decoded.code_hash !== 'string') return null
    return decoded
  } catch {
    return null
  }
}

async function findMatchingActiveVerificationCode(db, credentialId, incomingHash) {
  const now = nowISOString()
  const rows = await db
    .prepare(
      `
        SELECT *
        FROM user_verification_codes
        WHERE credential_id = ?
          AND consumed_at IS NULL
          AND (expires_at IS NULL OR expires_at >= ?)
        ORDER BY created_at DESC
        LIMIT 10
      `,
    )
    .all(credentialId, now)

  if (!Array.isArray(rows) || rows.length === 0) return null
  return rows.find((row) => row && row.code_hash === incomingHash) ?? null
}

function nowISOString() {
  return new Date().toISOString()
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function generateCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(48))
}

function generateCodeChallenge(codeVerifier) {
  return base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest())
}

function normalizeBasePath(basePath) {
  if (!basePath || basePath === '/') return ''
  if (!basePath.startsWith('/')) {
    return `/${basePath.replace(/^\/+/, '')}`.replace(/\/+$/, '')
  }
  return basePath.replace(/\/+$/, '')
}

function getServerBaseUrl(req) {
  if (AUTH_PUBLIC_URL) {
    return AUTH_PUBLIC_URL.replace(/\/$/, '')
  }
  const protocol = req.protocol || (req.headers['x-forwarded-proto'] || 'http').split(',')[0]
  const host = req.get('host')
  return `${protocol}://${host}`
}

function inferFrontendBaseUrl(req) {
  if (FRONTEND_BASE_URL) {
    return FRONTEND_BASE_URL.replace(/\/$/, '')
  }
  const origin = req.get('origin')
  if (origin) {
    return origin.replace(/\/$/, '')
  }
  return getServerBaseUrl(req)
}

function defaultFrontendRedirect(req) {
  const baseUrl = inferFrontendBaseUrl(req)
  const path = `${normalizeBasePath(FRONTEND_APP_BASE)}/auth/callback`.replace(/\/{2,}/g, '/')
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

function sanitizeRedirectTarget(req, target) {
  if (!target || typeof target !== 'string') {
    return defaultFrontendRedirect(req)
  }

  let redirectUrl = null
  try {
    redirectUrl = new URL(target)
  } catch {
    return defaultFrontendRedirect(req)
  }

  const allowedOrigins = new Set()

  if (FRONTEND_BASE_URL) {
    try {
      allowedOrigins.add(new URL(FRONTEND_BASE_URL).origin)
    } catch {
      // ignore malformed env
    }
  }

  const originHeader = req.get('origin')
  if (originHeader) {
    try {
      allowedOrigins.add(new URL(originHeader).origin)
    } catch {
      // ignore
    }
  }

  const referer = req.get('referer')
  if (referer) {
    try {
      allowedOrigins.add(new URL(referer).origin)
    } catch {
      // ignore
    }
  }

  if (allowedOrigins.size === 0) {
    try {
      allowedOrigins.add(new URL(defaultFrontendRedirect(req)).origin)
    } catch {
      // ignore
    }
  }

  if (allowedOrigins.has(redirectUrl.origin)) {
    return target
  }

  return defaultFrontendRedirect(req)
}

function normalizePhone(phone = '') {
  if (typeof phone !== 'string') return null
  const trimmed = phone.replace(/[()\s-]/g, '')
  if (!/^\+?[1-9]\d{7,14}$/.test(trimmed)) {
    return null
  }
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`
}

async function sendPhoneVerificationCode(phone, code) {
  if (!twilioClient) {
    console.warn('[auth] Twilio credentials not configured; skipping SMS send. Code:', code, 'Phone:', phone)
    return
  }

  try {
    const payload = {
      to: phone,
      body: `Your GrantFlow verification code is ${code}`,
    }
    if (TWILIO_MESSAGING_SERVICE_SID) {
      payload.messagingServiceSid = TWILIO_MESSAGING_SERVICE_SID
    } else if (TWILIO_FROM_NUMBER) {
      payload.from = TWILIO_FROM_NUMBER
    } else {
      console.warn('[auth] No TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID configured; skipping SMS send.')
      return
    }
    await twilioClient.messages.create(payload)
  } catch (error) {
    console.error('[auth] Failed to send SMS code:', error.message)
  }
}

async function getUserById(db, userId) {
  return await db
    .prepare(
      `
        SELECT *
        FROM users
        WHERE id = ?
      `,
    )
    .get(userId)
}

async function getUserProfiles(db, userId) {
  return await db
    .prepare(
      `
        SELECT id, display_name, organization_id, status
        FROM profiles
        WHERE user_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(userId)
}

function buildUserPayload(userRow, profiles, activeProfileId) {
  return {
    id: userRow.id,
    display_name: userRow.display_name,
    primary_email: userRow.primary_email,
    primary_phone: userRow.primary_phone,
    avatar_url: userRow.avatar_url,
    is_admin: Boolean(userRow.is_admin),
    profiles,
    active_profile_id: activeProfileId ?? profiles[0]?.id ?? null,
  }
}

async function assignProfileToUser(db, userId, email) {
  if (email && isAdminEmail(email)) {
    await ensureAdminUser(db)
    return null
  }

  async function findProfileRowForEmail(normalizedEmail) {
    if (!normalizedEmail) return null

    // Postgres: JSON ->> extraction is safe and fast.
    if (db?.dialect === 'postgres') {
      try {
        return (
          (await db
            .prepare(
              `
                SELECT p.id, p.user_id
                FROM profiles p
                JOIN profile_sections ps ON ps.profile_id = p.id
                WHERE ps.section_key = 'basic_information'
                  AND LOWER((ps.data::jsonb ->> 'email')) = ?
                LIMIT 1
              `,
            )
            .get(normalizedEmail)) ?? null
        )
      } catch {
        return null
      }
    }

    // SQLite: prefer json_extract when available.
    try {
      const row = await db
        .prepare(
          `
            SELECT p.id, p.user_id
            FROM profiles p
            JOIN profile_sections ps ON ps.profile_id = p.id
            WHERE ps.section_key = 'basic_information'
              AND LOWER(json_extract(ps.data, '$.email')) = ?
            LIMIT 1
          `,
        )
        .get(normalizedEmail)
      if (row?.id) return row
    } catch {
      // ignore and fall back to LIKE matching
    }

    // Fallback: match in JSON string (works even if json1 isn't enabled).
    const needle = `"email":"${normalizedEmail.replace(/"/g, '').toLowerCase()}"`
    try {
      return (
        (await db
          .prepare(
            `
              SELECT p.id, p.user_id
              FROM profiles p
              JOIN profile_sections ps ON ps.profile_id = p.id
              WHERE ps.section_key = 'basic_information'
                AND LOWER(ps.data) LIKE ?
              LIMIT 1
            `,
          )
          .get(`%${needle}%`)) ?? null
      )
    } catch {
      return null
    }
  }

  if (email) {
    const normalizedEmail = normalizeEmail(email)

    // 1) Best-effort match to an existing profile by email captured in profile sections.
    // This is the safest way to ensure returning users re-claim their original profile
    // even when IDs/mappings drift across DB restores.
    const byEmail = await findProfileRowForEmail(normalizedEmail)
    if (byEmail?.id) {
      if (!byEmail.user_id || byEmail.user_id === userId) {
        await db
          .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(userId, byEmail.id)
        return byEmail.id
      }
      if (await isAdminUserId(db, byEmail.user_id)) {
        await db
          .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(userId, byEmail.id)
        return byEmail.id
      }
      return byEmail.id
    }

    // 2) Next, apply explicit designated ID mappings (baseline profiles).
    const designatedProfileId = getDesignatedProfileForEmail(email)
    if (designatedProfileId) {
      const designatedProfile = await db
        .prepare('SELECT id, user_id FROM profiles WHERE id = ?')
        .get(designatedProfileId)
      if (designatedProfile) {
        if (!designatedProfile.user_id || designatedProfile.user_id === userId) {
          await db
            .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(userId, designatedProfileId)
          // TODO: Remove debug log - console.log(`[auth] Assigned designated profile ${designatedProfileId} to user ${userId} (${email})`)
          return designatedProfileId
        }
        if (await isAdminUserId(db, designatedProfile.user_id)) {
          await db
            .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(userId, designatedProfileId)
          // TODO: Remove debug log - console.log(`[auth] Reassigned designated profile ${designatedProfileId} from admin to user ${userId} (${email})`)
          return designatedProfileId
        }
        console.warn(`[auth] Designated profile ${designatedProfileId} already linked to another user`)
        return designatedProfileId
      }
      console.warn(`[auth] Designated profile ${designatedProfileId} not found for ${email}`)
    }
  }

  // 3) Otherwise, create a personal profile for the user.
  try {
    const profileId = crypto.randomUUID()
    const displayName =
      (email && email.split('@')[0]) ? email.split('@')[0] : `User ${String(userId).slice(0, 6)}`

    await db
      .prepare(
        `
          INSERT INTO profiles (id, user_id, display_name, primary_type, status, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
      )
      .run(profileId, userId, displayName, 'individual_need')

    return profileId
  } catch (e) {
    console.warn('[auth] Failed to create fallback profile for user:', e?.message || e)
    return null
  }
}

async function ensureAdminStatus(db, userId, email) {
  if (isAdminEmail(email)) {
    const result = await db
      .prepare('UPDATE users SET is_admin = TRUE WHERE id = ? AND COALESCE(is_admin, FALSE) = FALSE')
      .run(userId)
    if (result.changes > 0) {
      // TODO: Remove debug log - console.log(`[auth] Set admin status for user ${userId} (${email})`)
    }
  }
}

async function ensureEmailCredential(db, email) {
  const existing = await db
    .prepare(
      `
        SELECT uc.*, u.display_name AS user_display_name, u.primary_email, u.primary_phone, u.avatar_url, u.is_admin
        FROM user_credentials uc
        JOIN users u ON u.id = uc.user_id
        WHERE uc.type = 'email_otp'
          AND uc.identifier = ?
      `,
    )
    .get(email)

  if (existing) {
    const user = await getUserById(db, existing.user_id)
    // Ensure admin status is set if this is the admin email
    await ensureAdminStatus(db, existing.user_id, email)
    // Reload user to get updated admin status
    const updatedUser = await getUserById(db, existing.user_id)
    return {
      user: updatedUser,
      credential: existing,
    }
  }

  const displayName = email.split('@')[0] || 'New User'
  const userId = crypto.randomUUID()
  await db.prepare('INSERT INTO users (id, display_name, primary_email, is_admin) VALUES (?, ?, ?, ?)').run(
    userId, 
    displayName, 
    email,
    isAdminEmail(email) ? true : false
  )
  
  // Assign profile to user (designated or first available)
  await assignProfileToUser(db, userId, email)
  
  const credentialId = crypto.randomUUID()
  await db.prepare(
    `
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES (?, ?, 'email_otp', ?, 0)
    `,
  ).run(credentialId, userId, email)

  const user = await getUserById(db, userId)
  const credential = await db.prepare('SELECT * FROM user_credentials WHERE id = ?').get(credentialId)

  return { user, credential }
}

async function cleanupExpiredOAuthStates(db) {
  await db
    .prepare(
      `
        DELETE FROM oauth_states
        WHERE expires_at <= CURRENT_TIMESTAMP
      `,
    )
    .run()
}

async function createOAuthState(db, { provider, codeVerifier, redirectTo, metadata }) {
  await cleanupExpiredOAuthStates(db)
  const state = base64UrlEncode(crypto.randomBytes(24))
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL * 1000).toISOString()
  await db
    .prepare(
      `
        INSERT INTO oauth_states (provider, state, code_verifier, redirect_to, metadata, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(provider, state, codeVerifier ?? null, redirectTo ?? null, metadata ? JSON.stringify(metadata) : null, expiresAt)

  return { state, codeVerifier }
}

async function consumeOAuthState(db, provider, state) {
  if (!state) return null
  const row = await db
    .prepare(
      `
        SELECT *
        FROM oauth_states
        WHERE provider = ?
          AND state = ?
      `,
    )
    .get(provider, state)

  if (row) {
    await db
      .prepare(
        `
          DELETE FROM oauth_states
          WHERE id = ?
        `,
      )
      .run(row.id)
    if (row.metadata) {
      try {
        row.metadata = JSON.parse(row.metadata)
      } catch {
        row.metadata = null
      }
    }
  }

  return row
}

function getProviderConfig(provider, req) {
  const definition = OAUTH_PROVIDERS[provider]
  if (!definition) return null

  const upper = provider.toUpperCase()
  const clientId =
    process.env[`AUTH_${upper}_CLIENT_ID`] || process.env[`${upper}_CLIENT_ID`] || process.env[`OAUTH_${upper}_CLIENT_ID`] || null
  const clientSecret =
    process.env[`AUTH_${upper}_CLIENT_SECRET`] ||
    process.env[`${upper}_CLIENT_SECRET`] ||
    process.env[`OAUTH_${upper}_CLIENT_SECRET`] ||
    null

  const redirectOverride = process.env[`AUTH_${upper}_REDIRECT_URI`] || process.env[`${upper}_REDIRECT_URI`] || null
  const redirectUri = redirectOverride || `${getServerBaseUrl(req)}/api/auth/${provider}/callback`

  return {
    ...definition,
    clientId,
    clientSecret,
    redirectUri,
  }
}

function isProviderConfigured(config) {
  if (!config) return false
  if (!config.clientId || !config.clientSecret) {
    return false
  }
  return true
}

function buildAuthorizeUrl(provider, config, { state, codeVerifier }) {
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
  })

  if (config.supportsPKCE && codeVerifier) {
    authorizeParams.set('code_challenge', generateCodeChallenge(codeVerifier))
    authorizeParams.set('code_challenge_method', 'S256')
  }

  if (config.extraAuthParams) {
    Object.entries(config.extraAuthParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        authorizeParams.set(key, value)
      }
    })
  }

  return `${config.authUrl}?${authorizeParams.toString()}`
}

async function exchangeAuthorizationCode(provider, config, code, stateRecord) {
  if (provider === 'facebook') {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      client_secret: config.clientSecret,
      code,
    })
    const response = await fetch(`${config.tokenUrl}?${params.toString()}`, { method: 'GET' })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Facebook token exchange failed: ${errorBody}`)
    }
    const data = await response.json()
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresIn: data.expires_in ?? null,
      idToken: null,
      scope: config.scope,
      raw: data,
    }
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
  })

  if (!config.useBasicAuth) {
    body.set('client_secret', config.clientSecret)
  }

  if (config.supportsPKCE && stateRecord.code_verifier) {
    body.set('code_verifier', stateRecord.code_verifier)
  }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (config.useBasicAuth) {
    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
    headers.Authorization = `Basic ${credentials}`
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`${provider} token exchange failed: ${errorBody}`)
  }

  const data = await response.json()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in ?? null,
    idToken: data.id_token ?? null,
    scope: data.scope ?? config.scope,
    raw: data,
  }
}

function decodeIdToken(idToken) {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

async function fetchProviderProfile(provider, config, tokens) {
  if (provider === 'google') {
    const claims = decodeIdToken(tokens.idToken)
    if (claims) {
      return {
        providerAccountId: claims.sub,
        email: claims.email ?? null,
        displayName: claims.name ?? claims.email ?? 'Google user',
        avatarUrl: claims.picture ?? null,
        raw: claims,
      }
    }

    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Google userinfo failed: ${errorBody}`)
    }
    const data = await response.json()
    return {
      providerAccountId: data.sub,
      email: data.email ?? null,
      displayName: data.name ?? data.email ?? 'Google user',
      avatarUrl: data.picture ?? null,
      raw: data,
    }
  }

  if (provider === 'facebook') {
    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Facebook userinfo failed: ${errorBody}`)
    }
    const data = await response.json()
    return {
      providerAccountId: data.id,
      email: data.email ?? null,
      displayName: data.name ?? 'Facebook user',
      avatarUrl: data.picture?.data?.url ?? null,
      raw: data,
    }
  }

  if (provider === 'yahoo') {
    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Yahoo userinfo failed: ${errorBody}`)
    }
    const data = await response.json()
    return {
      providerAccountId: data.sub ?? data.user_id ?? data.guid,
      email: data.email ?? data.preferred_username ?? null,
      displayName: data.name ?? data.nickname ?? data.email ?? 'Yahoo user',
      avatarUrl: data.picture ?? null,
      raw: data,
    }
  }

  throw new Error(`Unsupported provider: ${provider}`)
}

async function ensureProviderUser(db, provider, profile) {
  const providerAccountId = profile.providerAccountId
  if (!providerAccountId) {
    const error = new Error('Provider response missing account identifier')
    error.status = 400
    throw error
  }

  const linkedUser = await db
    .prepare(
      `
        SELECT u.*
        FROM user_providers up
        JOIN users u ON u.id = up.user_id
        WHERE up.provider = ?
          AND up.provider_account_id = ?
      `,
    )
    .get(provider, providerAccountId)

  if (linkedUser) {
    return linkedUser
  }

  let user = null
  const email = profile.email?.trim().toLowerCase() ?? null
  if (email) {
    user = await db
      .prepare(
        `
          SELECT *
          FROM users
          WHERE primary_email = ?
        `,
      )
      .get(email)
  }

  if (!user) {
    const userId = crypto.randomUUID()
    const isAdmin = isAdminEmail(email) ? 1 : 0
    await db
      .prepare(
        `
          INSERT INTO users (id, display_name, primary_email, avatar_url, is_admin)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(userId, profile.displayName ?? 'GrantFlow User', email, profile.avatarUrl ?? null, isAdmin)
    user = await getUserById(db, userId)
    return user
  }

  // Ensure admin status is set for existing users
  if (email) {
    await ensureAdminStatus(db, user.id, email)
    user = await getUserById(db, user.id)
  }

  const updates = []
  const params = []
  if (!user.display_name && profile.displayName) {
    updates.push('display_name = ?')
    params.push(profile.displayName)
  }
  if (!user.avatar_url && profile.avatarUrl) {
    updates.push('avatar_url = ?')
    params.push(profile.avatarUrl)
  }
  if (updates.length > 0) {
    params.push(user.id)
    await db
      .prepare(
        `
          UPDATE users
          SET ${updates.join(', ')},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(...params)
    user = await getUserById(db, user.id)
  }

  return user
}

async function upsertProviderAccount(db, { provider, providerAccountId, userId, tokens, profile }) {
  const existing = await db
    .prepare(
      `
        SELECT *
        FROM user_providers
        WHERE provider = ?
          AND provider_account_id = ?
      `,
    )
    .get(provider, providerAccountId)

  const metadata = {
    profile,
    received_at: new Date().toISOString(),
  }

  const expiresAt =
    typeof tokens.expiresIn === 'number'
      ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      : tokens.expiresAt ?? null

  if (existing) {
    await db
      .prepare(
        `
          UPDATE user_providers
          SET user_id = ?,
              access_token = ?,
              refresh_token = ?,
              expires_at = ?,
              scopes = ?,
              metadata = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(
        userId,
        tokens.accessToken ?? null,
        tokens.refreshToken ?? null,
        expiresAt,
        tokens.scope ?? null,
        JSON.stringify(metadata),
        existing.id,
      )
    return existing.id
  }

  const providerId = crypto.randomUUID()
  await db
    .prepare(
      `
        INSERT INTO user_providers (
          id,
          user_id,
          provider,
          provider_account_id,
          access_token,
          refresh_token,
          expires_at,
          scopes,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      providerId,
      userId,
      provider,
      providerAccountId,
      tokens.accessToken ?? null,
      tokens.refreshToken ?? null,
      expiresAt,
      tokens.scope ?? null,
      JSON.stringify(metadata),
    )
  return providerId
}

function buildRedirectUrl(baseRedirect, params = {}) {
  const url = new URL(baseRedirect)
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .forEach(([key, value]) => url.searchParams.set(key, value))
  return url.toString()
}

async function ensurePhoneCredential(db, phone) {
  const existingCredential = await db
    .prepare(
      `
        SELECT uc.*, u.display_name AS user_display_name, u.primary_phone, u.primary_email
        FROM user_credentials uc
        JOIN users u ON u.id = uc.user_id
        WHERE uc.type = 'phone_otp'
          AND uc.identifier = ?
      `,
    )
    .get(phone)

  if (existingCredential) {
    const user = await getUserById(db, existingCredential.user_id)
    return { user, credential: existingCredential }
  }

  let user = await db
    .prepare(
      `
        SELECT *
        FROM users
        WHERE primary_phone = ?
      `,
    )
    .get(phone)

  if (!user) {
    const userId = crypto.randomUUID()
    const displayName = `User ${phone.slice(-4)}`
    await db.prepare(
      `
        INSERT INTO users (id, display_name, primary_phone)
        VALUES (?, ?, ?)
      `,
    ).run(userId, displayName, phone)
    
    // Assign profile to user (phone auth doesn't have email, so only first available)
    await assignProfileToUser(db, userId, null)
    
    user = await getUserById(db, userId)
  }

  const credentialId = crypto.randomUUID()
  await db.prepare(
    `
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES (?, ?, 'phone_otp', ?, 0)
    `,
  ).run(credentialId, user.id, phone)

  const credential = await db.prepare('SELECT * FROM user_credentials where id = ?').get(credentialId)
  return { user, credential }
}

async function attachProfileToUser(db, userId, profileId) {
  if (!profileId) {
    return null
  }
  const profile = await db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId)
  if (!profile) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }
  if (profile.user_id && profile.user_id !== userId) {
    const error = new Error('Profile already linked to another user')
    error.status = 403
    throw error
  }
  if (!profile.user_id) {
    await db
      .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(userId, profileId)
  }
  return profileId
}

async function insertVerificationCode(db, credentialId, codeHash, expiresAtIso) {
  await db.prepare(
    `
      INSERT INTO user_verification_codes (credential_id, code_hash, expires_at)
      VALUES (?, ?, ?)
    `,
  ).run(credentialId, codeHash, expiresAtIso)
}

function signAccessToken(user, sessionId, profileId) {
  const roles = []
  if (user.is_admin) {
    roles.push('admin')
  } else {
    roles.push('user')
  }
  const tokenPayload = {
    sub: user.id,
    sid: sessionId,
    profile_id: profileId ?? null,
    roles,
  }
  if (user.display_name) {
    tokenPayload.name = user.display_name
  }
  if (user.primary_email) {
    tokenPayload.email = user.primary_email
  }

  return jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL })
}

async function createSessionAndTokens(db, { user, profileId, userAgent, ipAddress }) {
  const sessionId = crypto.randomUUID()
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshHash = hashValue(refreshToken)
  const accessToken = signAccessToken(user, sessionId, profileId)
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString()
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()

  await db.prepare(
    `
      INSERT INTO user_sessions (
        id,
        user_id,
        profile_id,
        issued_at,
        access_expires_at,
        refresh_expires_at,
        refresh_token_hash,
        ip_address,
        user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    sessionId,
    user.id,
    profileId ?? null,
    nowISOString(),
    accessExpires,
    refreshExpires,
    refreshHash,
    ipAddress ?? null,
    userAgent ?? null,
  )

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    accessExpires,
    refreshExpires,
    sessionId,
  }
}

async function rotateSessionTokens(db, { sessionId, user, profileId }) {
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshHash = hashValue(refreshToken)
  const accessToken = signAccessToken(user, sessionId, profileId)
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString()
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()

  await db.prepare(
    `
      UPDATE user_sessions
      SET refresh_token_hash = ?,
          access_expires_at = ?,
          refresh_expires_at = ?,
          profile_id = COALESCE(?, profile_id),
          revoked_at = NULL
      WHERE id = ?
    `,
  ).run(refreshHash, accessExpires, refreshExpires, profileId ?? null, sessionId)

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    accessExpires,
    refreshExpires,
  }
}

router.post('/email/start', emailStartLimiter, async (req, res) => {
  try {
    // Validate input
    const emailRaw = req.body?.email
    if (typeof emailRaw !== 'string') {
      console.warn('[auth/email/start] Missing email in request body')
      return res.status(400).json({ 
        error: 'email is required',
        error_type: 'validation_error'
      })
    }
    
    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) {
      console.warn('[auth/email/start] Invalid email format:', emailRaw)
      return res.status(400).json({ 
        error: 'Invalid email address',
        error_type: 'validation_error'
      })
    }

    console.info('[auth/email/start] Processing email authentication request for:', email)

    // Database operations with error handling
    let user, credential
    try {
      const result = await ensureEmailCredential(req.db, email)
      user = result.user
      credential = result.credential
      console.info('[auth/email/start] User credential ensured for:', email, 'user_id:', user?.id)
    } catch (dbError) {
      console.error('[auth/email/start] Database error ensuring credential:', dbError)
      return res.status(500).json({ 
        error: 'Database error occurred. Please try again.',
        error_type: 'database_error',
        details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
      })
    }

    // Check rate limiting cooldown
    const now = new Date()
    if (credential.last_sent_at) {
      const lastSent = new Date(credential.last_sent_at)
      const timeSinceLastSent = now - lastSent
      if (timeSinceLastSent < EMAIL_RESEND_COOLDOWN * 1000) {
        const retryAfter = Math.ceil((EMAIL_RESEND_COOLDOWN * 1000 - timeSinceLastSent) / 1000)
        console.warn('[auth/email/start] Rate limit cooldown for:', email, 'retry after:', retryAfter, 'seconds')
        return res.status(429).json({
          error: `Please wait ${retryAfter} seconds before requesting another code`,
          error_type: 'rate_limit_cooldown',
          retry_after_seconds: retryAfter,
        })
      }
    }

    // Generate and store verification code
    const code = generateSixDigitCode()
    const codeHash = hashValue(`${email}:${code}`)
    const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL * 1000).toISOString()
    const verificationToken = signOtpToken({
      kind: 'email',
      identifier: email,
      codeHash,
      ttlSeconds: EMAIL_CODE_TTL,
    })
    
    try {
      await insertVerificationCode(req.db, credential.id, codeHash, expiresAt)
      await req.db
        .prepare(
          `
            UPDATE user_credentials
            SET secret_hash = ?,
                last_sent_at = ?,
                attempt_count = 0
            WHERE id = ?
          `,
        )
        .run(codeHash, nowISOString(), credential.id)
      console.info('[auth/email/start] Verification code stored in database for:', email)
    } catch (dbError) {
      console.error('[auth/email/start] Database error storing verification code:', dbError)
      return res.status(500).json({ 
        error: 'Failed to create verification code. Please try again.',
        error_type: 'database_error',
        details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
      })
    }

    // Attempt to send email with timeout
    console.info('[auth/email/start] Attempting to send verification email to:', email)
    let emailSent = false
    try {
      // Add timeout to email sending to prevent hanging
      const emailPromise = sendVerificationEmail(email, code)
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(false), Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000)) // default 15s
      })
      
      emailSent = await Promise.race([emailPromise, timeoutPromise])
      
      if (emailSent === true) {
        console.info('[auth/email/start] Verification email sent successfully to:', email)
      } else {
        console.warn('[auth/email/start] Email service unavailable, timed out, or failed for:', email)
      }
    } catch (emailError) {
      console.error('[auth/email/start] Unexpected error sending email:', emailError)
      emailSent = false
      // Don't fail the request if email fails - code is stored in DB
    }

    // Return success response with code in development/when email fails
    const responseData = {
      message: emailSent 
        ? 'Verification code sent to your email' 
        : 'Verification code generated (email service unavailable)',
      email_sent: emailSent,
      verification_token: verificationToken,
      user_hint: {
        id: user.id,
        display_name: user.display_name,
        primary_email: user.primary_email,
      },
    }

    // Optional ops alert (never includes the code).
    sendAuthAttemptNotification({
      event: 'email_start',
      identifier: email,
      success: Boolean(emailSent),
      error: emailSent ? null : 'email_delivery_failed_or_unconfigured',
    }).catch(() => {})

    // SECURITY: never expose OTP codes in production responses.
    // IMPORTANT: do NOT hard-fail the login start flow if email delivery is slow/unavailable.
    // Many providers are async/queued and may deliver shortly after the request returns.
    // Treat hosted deployments as production even if NODE_ENV is mis-set.
    const isProd =
      process.env.NODE_ENV === 'production' ||
      process.env.RAILWAY_ENVIRONMENT === 'production' ||
      process.env.VERCEL_ENV === 'production'

    // Check if preview codes are explicitly allowed in production
    const allowPreviewInProd = String(
      process.env.AUTH_ALLOW_PREVIEW_CODE_IN_PROD ||
      process.env.AUTH_ALLOW_PREVIEW_CODE ||
      ''
    ).toLowerCase() === 'true'

    // In production: if email delivery fails and preview codes are not explicitly allowed,
    // return 503 to prevent silent failures that cause login lockouts.
    // Exception: allow admin failsafe to proceed if AUTH_ALLOW_ADMIN_PREVIEW_CODE is enabled.
    if (isProd && !emailSent && !allowPreviewInProd) {
      // Check if admin failsafe would apply
      const isAdminFailsafeEnabled = process.env.AUTH_ALLOW_ADMIN_PREVIEW_CODE === 'true'
      const shouldAllowAdminFailsafe = isAdminFailsafeEnabled && isAdminEmail(email)
      
      if (!shouldAllowAdminFailsafe) {
        console.error('[auth/email/start] Email delivery failed in production without preview code allowance for:', email)
        return res.status(503).json({
          error: 'Email delivery is unavailable. Please try again later or contact support.',
          error_type: 'email_delivery_unavailable'
        })
      }
    }

    // Developer experience: in non-production, return a preview code so local/test flows can proceed
    // even when email delivery is not configured.
    if (!isProd) {
      // Non-production only: useful for local/dev and automated tests.
      responseData.previewCode = code
    }

    // Production preview code: when explicitly enabled, return preview code for all users
    // This is useful for testing/development in production-like environments
    if (isProd && allowPreviewInProd) {
      responseData.previewCode = code
      responseData.preview_reason = 'preview_enabled_in_prod'
    }

    // FAILSAFE: Admin preview code when email fails in production
    // If email sending failed AND AUTH_ALLOW_ADMIN_PREVIEW_CODE is enabled,
    // return the OTP code for admin users ONLY to prevent lockout.
    // This does NOT weaken security for non-admin users.
    if (isProd && !emailSent && process.env.AUTH_ALLOW_ADMIN_PREVIEW_CODE === 'true') {
      if (isAdminEmail(email)) {
        console.warn('[auth/email/start] FAILSAFE: Returning preview code for admin user due to email failure:', email)
        responseData.previewCode = code
        responseData.preview_reason = 'admin_failsafe_email_failed'
      }
    }

    console.info('[auth/email/start] Request completed successfully for:', email, 'email_sent:', emailSent)
    return res.status(202).json(responseData)
    
  } catch (error) {
    // Catch-all for any unexpected errors
    console.error('[auth/email/start] Unexpected error:', error)
    sendAuthAttemptNotification({
      event: 'email_start',
      identifier: typeof req.body?.email === 'string' ? req.body.email : 'unknown',
      success: false,
      error: error?.message || String(error),
    }).catch(() => {})
    return res.status(500).json({ 
      error: 'An unexpected error occurred. Please try again.',
      error_type: 'internal_error',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    })
  }
})

router.post('/email/verify', async (req, res) => {
  const emailRaw = req.body?.email
  const codeRaw = req.body?.code
  const verificationTokenRaw = req.body?.verification_token ?? req.body?.verificationToken ?? null
  const requestedProfileId = req.body?.profile_id ?? null

  if (typeof emailRaw !== 'string' || (typeof codeRaw !== 'string' && typeof codeRaw !== 'number')) {
    return res.status(400).json({ error: 'email and code are required' })
  }
  const email = normalizeEmail(emailRaw)
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }
  const code = normalizeSixDigitCode(codeRaw)
  if (!code) return res.status(400).json({ error: 'Code must be a 6-digit number' })

  // Always compute the incoming hash.
  const incomingHash = hashValue(`${email}:${code}`)

  // Prefer stateless verification token (survives multi-instance / non-shared sqlite deployments).
  const tokenDecoded = typeof verificationTokenRaw === 'string' ? verifyOtpToken(verificationTokenRaw) : null
  const tokenOk =
    tokenDecoded &&
    normalizeEmail(tokenDecoded.identifier) === email &&
    tokenDecoded.code_hash === incomingHash

  // Ensure a credential exists (create if needed). This avoids "code not requested" across instances.
  let user = null
  let credential = null
  try {
    const ensured = await ensureEmailCredential(req.db, email)
    user = ensured.user
    credential = ensured.credential
  } catch (dbError) {
    return res.status(500).json({ error: 'Database error occurred. Please try again.' })
  }

  const codeRow = tokenOk ? { id: null } : await findMatchingActiveVerificationCode(req.db, credential.id, incomingHash)

  if (!codeRow) {
    // Provide a more accurate error (expired vs already used vs invalid) without exposing the code.
    const matchedAny = await req.db
      .prepare(
        `
          SELECT id, expires_at, consumed_at
          FROM user_verification_codes
          WHERE credential_id = ?
            AND code_hash = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(credential.id, incomingHash)

    if (matchedAny?.consumed_at) {
      sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'code_consumed' }).catch(() => {})
      return res.status(400).json({ error: 'Verification code already used. Request a new code.' })
    }
    if (matchedAny?.expires_at && matchedAny.expires_at < nowISOString()) {
      sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'code_expired' }).catch(() => {})
      return res.status(400).json({ error: 'Verification code expired. Request a new code.' })
    }

    const hasAnyActive = await req.db
      .prepare(
        `
          SELECT COUNT(*) as c
          FROM user_verification_codes
          WHERE credential_id = ?
            AND consumed_at IS NULL
            AND (expires_at IS NULL OR expires_at >= ?)
        `,
      )
      .get(credential.id, nowISOString())
      ?.c

    if (!hasAnyActive) {
      sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'no_active_codes' }).catch(() => {})
      return res.status(400).json({ error: 'Verification code expired. Request a new code.' })
    }

    // Increment attempt count on the latest active code (if any) to support abuse monitoring.
    const latest = await req.db
      .prepare(
        `
          SELECT id
          FROM user_verification_codes
          WHERE credential_id = ?
            AND consumed_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(credential.id)

    if (latest?.id) {
      await req.db
        .prepare(
          `
            UPDATE user_verification_codes
            SET attempt_count = attempt_count + 1
            WHERE id = ?
          `,
        )
        .run(latest.id)
    }

    await req.db
      .prepare(
        `
          UPDATE user_credentials
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(credential.id)

    sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'invalid_code' }).catch(() => {})
    return res.status(400).json({ error: 'Invalid verification code' })
  }

  // Best-effort consume in DB (may be absent in stateless flow on a different instance).
  if (codeRow.id) {
    await req.db
      .prepare(
        `
          UPDATE user_verification_codes
          SET consumed_at = ?
          WHERE id = ?
        `,
      )
      .run(nowISOString(), codeRow.id)
  }

  await req.db
    .prepare(
      `
        UPDATE user_credentials
        SET verified_at = COALESCE(verified_at, ?),
            attempt_count = 0
        WHERE id = ?
      `,
    )
    .run(nowISOString(), credential.id)

  // Reload user if needed.
  if (!user) {
    user = await getUserById(req.db, credential.user_id)
  }
  if (!user) return res.status(500).json({ error: 'User record missing for credential' })

  let activeProfileId = null
  try {
    if (requestedProfileId) {
      activeProfileId = await attachProfileToUser(req.db, user.id, requestedProfileId)
    }
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message })
  }

  let profiles = await getUserProfiles(req.db, user.id)

  // If the user has no linked profiles (common after DB restores or legacy imports),
  // self-heal by attaching an existing baseline profile or creating a minimal one.
  if (profiles.length === 0) {
    try {
      const attached = await assignProfileToUser(req.db, user.id, email)
      profiles = await getUserProfiles(req.db, user.id)
      if (!activeProfileId) {
        activeProfileId = attached ?? profiles[0]?.id ?? null
      }
    } catch (error) {
      console.warn('[auth/email] Failed to auto-attach profile for user:', error?.message || error)
    }
  }

  if (!activeProfileId && profiles.length > 0) {
    activeProfileId = profiles[0].id
  }

  const session = await createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  })

  // Initialize Anya for admin users on login
  let anyaInfo = null
  try {
    anyaInfo = await initializeAnyaForAdmin(req.db, user, activeProfileId, { uploadDir, getOpenAI })
  } catch (error) {
    console.error('[auth] Failed to initialize Anya:', error)
    // Don't fail the login if Anya initialization fails
  }

  // Auto-trigger discovery crawlers on email login (fire and forget)
  if (activeProfileId) {
    triggerAutoDiscoveryCrawlers(req.db, activeProfileId, { uploadDir, getOpenAI }).catch(err => {
      console.error('[auth/email] Failed to queue auto-discovery crawlers:', err)
    })
  }

  const response = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    accessExpires: session.accessExpires,
    refreshExpires: session.refreshExpires,
    tokenType: 'Bearer',
    user: buildUserPayload(user, profiles, activeProfileId),
  }

  // Include Anya session info if available
  if (anyaInfo) {
    response.anya = {
      session_id: anyaInfo.sessionId,
      jobs_created: Object.keys(anyaInfo.jobIds).length,
      profile_id: anyaInfo.profileId,
    }
  }
  
  // Trigger Anya's autonomous operations for admin login if configured
  if (req.db?.dialect !== 'postgres' && user.role === 'admin' && process.env.ANYA_RUN_ON_ADMIN_LOGIN === 'true') {
    import('../services/anyaAutonomousScheduler.js').then(({ runOnAdminLogin }) => {
      runOnAdminLogin(req.db, user.id).catch(err => {
        console.error('[Anya] Failed to run admin login operations:', err)
      })
    })
  }

  // Admin notice on successful sign-in (post-verify)
  sendAuthAttemptNotification({
    event: 'sign_in',
    identifier: email,
    success: true,
    context: {
      method: 'email',
      userId: user.id,
      profileId: activeProfileId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    },
  }).catch(() => {})

  // In-app admin notification (best-effort, stored in-memory).
  // Record only non-admin sign-ins so the Admin panel highlights client activity.
  if (!user?.is_admin) {
    recordClientSignInEvent({
      identifier: email,
      method: 'email',
      userId: user?.id ?? null,
      profileId: activeProfileId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
  }

  return res.json(response)
})

router.post('/phone/start', phoneStartLimiter, async (req, res) => {
  const phoneRaw = req.body?.phone
  if (typeof phoneRaw !== 'string') {
    return res.status(400).json({ error: 'phone is required' })
  }
  const normalized = normalizePhone(phoneRaw)
  if (!normalized) {
    return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +1234567890)' })
  }

  const { user, credential } = await ensurePhoneCredential(req.db, normalized)
  const now = new Date()

  if (credential.last_sent_at) {
    const lastSent = new Date(credential.last_sent_at)
    if (now - lastSent < PHONE_RESEND_COOLDOWN * 1000) {
      return res.status(429).json({
        error: 'Verification already sent',
        retry_after_seconds: Math.ceil((PHONE_RESEND_COOLDOWN * 1000 - (now - lastSent)) / 1000),
      })
    }
  }

  const code = generateSixDigitCode()
  const codeHash = hashValue(`${normalized}:${code}`)
  const expiresAt = new Date(now.getTime() + PHONE_CODE_TTL * 1000).toISOString()

  await insertVerificationCode(req.db, credential.id, codeHash, expiresAt)
  await req.db
    .prepare(
      `
        UPDATE user_credentials
        SET secret_hash = ?,
            last_sent_at = ?,
            attempt_count = 0
        WHERE id = ?
      `,
    )
    .run(codeHash, nowISOString(), credential.id)

  sendPhoneVerificationCode(normalized, code)

  // Optional ops alert (never includes the code).
  sendAuthAttemptNotification({
    event: 'phone_start',
    identifier: normalized,
    success: true,
  }).catch(() => {})

  return res.status(202).json({
    message: 'Verification code sent',
    user_hint: {
      id: user.id,
      display_name: user.display_name,
      primary_phone: normalized,
    },
  })
})

router.post('/phone/verify', async (req, res) => {
  const phoneRaw = req.body?.phone
  const codeRaw = req.body?.code
  const requestedProfileId = req.body?.profile_id ?? null

  if (typeof phoneRaw !== 'string' || (typeof codeRaw !== 'string' && typeof codeRaw !== 'number')) {
    return res.status(400).json({ error: 'phone and code are required' })
  }

  const normalized = normalizePhone(phoneRaw)
  if (!normalized) {
    return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +1234567890)' })
  }

  const code = normalizeSixDigitCode(codeRaw)
  if (!code) return res.status(400).json({ error: 'Code must be a 6-digit number' })

  const credential = await req.db
    .prepare(
      `
        SELECT *
        FROM user_credentials
        WHERE type = 'phone_otp'
          AND identifier = ?
      `,
    )
    .get(normalized)

  if (!credential) {
    return res.status(400).json({ error: 'Verification code not requested for this phone number' })
  }

  const incomingHash = hashValue(`${normalized}:${code}`)
  const codeRow = await findMatchingActiveVerificationCode(req.db, credential.id, incomingHash)

  if (!codeRow) {
    const latest = await req.db
      .prepare(
        `
          SELECT id
          FROM user_verification_codes
          WHERE credential_id = ?
            AND consumed_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `,
      )
      .get(credential.id)

    if (latest?.id) {
      await req.db
        .prepare(
          `
            UPDATE user_verification_codes
            SET attempt_count = attempt_count + 1
            WHERE id = ?
          `,
        )
        .run(latest.id)
    }

    await req.db
      .prepare(
        `
          UPDATE user_credentials
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(credential.id)

    sendAuthAttemptNotification({
      event: 'phone_verify',
      identifier: normalized,
      success: false,
      error: 'invalid_code',
    }).catch(() => {})
    return res.status(400).json({ error: 'Invalid verification code' })
  }

  await req.db
    .prepare(
      `
        UPDATE user_verification_codes
        SET consumed_at = ?
        WHERE id = ?
      `,
    )
    .run(nowISOString(), codeRow.id)

  await req.db
    .prepare(
      `
        UPDATE user_credentials
        SET verified_at = COALESCE(verified_at, ?),
            attempt_count = 0
        WHERE id = ?
      `,
    )
    .run(nowISOString(), credential.id)

  const user = await getUserById(req.db, credential.user_id)
  if (!user) {
    return res.status(500).json({ error: 'User record missing for credential' })
  }

  if (user.primary_phone !== normalized) {
    await req.db
      .prepare(
        `
          UPDATE users
          SET primary_phone = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
      )
      .run(normalized, user.id)
  }

  let activeProfileId = null
  try {
    if (requestedProfileId) {
      activeProfileId = await attachProfileToUser(req.db, user.id, requestedProfileId)
    }
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message })
  }

  let profiles = await getUserProfiles(req.db, user.id)

  // Self-heal: ensure every signed-in user has at least one profile.
  if (profiles.length === 0) {
    try {
      const attached = await assignProfileToUser(req.db, user.id, null)
      profiles = await getUserProfiles(req.db, user.id)
      if (!activeProfileId) {
        activeProfileId = attached ?? profiles[0]?.id ?? null
      }
    } catch (error) {
      console.warn('[auth/phone] Failed to auto-attach profile for user:', error?.message || error)
    }
  }

  if (!activeProfileId && profiles.length > 0) {
    activeProfileId = profiles[0].id
  }

  const session = await createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  })

  // Initialize Anya for admin users on login
  let anyaInfo = null
  try {
    anyaInfo = await initializeAnyaForAdmin(req.db, user, activeProfileId, { uploadDir, getOpenAI })
  } catch (error) {
    console.error('[auth] Failed to initialize Anya:', error)
    // Don't fail the login if Anya initialization fails
  }

  // Auto-trigger discovery crawlers on phone login (fire and forget)
  if (activeProfileId) {
    triggerAutoDiscoveryCrawlers(req.db, activeProfileId, { uploadDir, getOpenAI }).catch(err => {
      console.error('[auth/phone] Failed to queue auto-discovery crawlers:', err)
    })
  }

  const response = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    accessExpires: session.accessExpires,
    refreshExpires: session.refreshExpires,
    tokenType: 'Bearer',
    user: buildUserPayload(user, profiles, activeProfileId),
  }

  // Include Anya session info if available
  if (anyaInfo) {
    response.anya = {
      session_id: anyaInfo.sessionId,
      jobs_created: Object.keys(anyaInfo.jobIds).length,
      profile_id: anyaInfo.profileId,
    }
  }

  // Admin notice on successful sign-in (post-verify)
  sendAuthAttemptNotification({
    event: 'sign_in',
    identifier: normalized,
    success: true,
    context: {
      method: 'phone',
      userId: user.id,
      profileId: activeProfileId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    },
  }).catch(() => {})

  if (!user?.is_admin) {
    recordClientSignInEvent({
      identifier: normalized,
      method: 'phone',
      userId: user?.id ?? null,
      profileId: activeProfileId ?? null,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    })
  }

  return res.json(response)
})

router.get('/:provider/start', async (req, res) => {
  const provider = (req.params?.provider || '').toLowerCase()
  
  console.info(`[auth] OAuth start requested for provider: ${provider}`)
  
  if (!OAUTH_PROVIDERS[provider]) {
    console.warn(`[auth] Unsupported OAuth provider requested: ${provider}`)
    return res.status(404).json({ error: 'Unsupported provider' })
  }

  try {
    const config = getProviderConfig(provider, req)
    if (!isProviderConfigured(config)) {
      console.warn(`[auth] OAuth provider ${provider} not configured (missing client ID or secret)`)
      return res.status(503).json({ 
        error: 'Provider not configured. Contact your administrator.',
        provider,
        details: 'OAuth credentials are missing or incomplete'
      })
    }

    const requestedRedirect = typeof req.query?.redirect_to === 'string' ? req.query.redirect_to : null
    const sanitizedRedirect = sanitizeRedirectTarget(req, requestedRedirect)

    const codeVerifier = config.supportsPKCE ? generateCodeVerifier() : null
    const oauthState = await createOAuthState(req.db, {
      provider,
      codeVerifier,
      redirectTo: sanitizedRedirect,
      metadata: {
        redirect_to: sanitizedRedirect,
        user_agent: req.headers['user-agent'] ?? null,
      },
    })

    const authorizeUrl = buildAuthorizeUrl(provider, config, {
      state: oauthState.state,
      codeVerifier,
    })
    
    console.info(`[auth] Redirecting to ${provider} OAuth authorization page`)
    return res.redirect(authorizeUrl)
  } catch (error) {
    console.error(`[auth] Error starting OAuth flow for ${provider}:`, error)
    return res.status(500).json({ 
      error: 'Failed to initiate OAuth flow',
      provider,
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    })
  }
})

router.get('/:provider/callback', async (req, res) => {
  const provider = (req.params?.provider || '').toLowerCase()
  if (!OAUTH_PROVIDERS[provider]) {
    return res.status(404).json({ error: 'Unsupported provider' })
  }

  const stateToken = typeof req.query?.state === 'string' ? req.query.state : null
  const error = req.query?.error_description || req.query?.error
  const code = typeof req.query?.code === 'string' ? req.query.code : null

  const stateRecord = await consumeOAuthState(req.db, provider, stateToken)
  const redirectBase = stateRecord?.redirect_to || defaultFrontendRedirect(req)
  const redirectWithParams = (params) => res.redirect(buildRedirectUrl(redirectBase, { provider, ...params }))

  if (error) {
    return redirectWithParams({ error })
  }

  if (!stateRecord || !code) {
    return redirectWithParams({ error: 'oauth_state_invalid' })
  }

  const config = getProviderConfig(provider, req)
  if (!isProviderConfigured(config)) {
    return redirectWithParams({ error: 'provider_not_configured' })
  }

  try {
    const tokens = await exchangeAuthorizationCode(provider, config, code, stateRecord)
    const profile = await fetchProviderProfile(provider, config, tokens)
    const user = await ensureProviderUser(req.db, provider, profile)
    await upsertProviderAccount(req.db, {
      provider,
      providerAccountId: profile.providerAccountId,
      userId: user.id,
      tokens,
      profile,
    })

    let profiles = await getUserProfiles(req.db, user.id)
    let activeProfileId = profiles[0]?.id ?? null

    // OAuth users should also get a profile link automatically.
    if (profiles.length === 0) {
      try {
        const attached = await assignProfileToUser(req.db, user.id, profile?.email ? normalizeEmail(profile.email) : null)
        profiles = await getUserProfiles(req.db, user.id)
        activeProfileId = attached ?? profiles[0]?.id ?? null
      } catch (error) {
        console.warn('[auth/oauth] Failed to auto-attach profile for user:', error?.message || error)
      }
    }

    const session = await createSessionAndTokens(req.db, {
      user,
      profileId: activeProfileId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    })

    // Admin notice on successful sign-in (OAuth)
    sendAuthAttemptNotification({
      event: 'sign_in',
      identifier: profile?.email ? normalizeEmail(profile.email) : `${provider}:${profile?.providerAccountId || 'unknown'}`,
      success: true,
      context: {
        method: `oauth:${provider}`,
        userId: user.id,
        profileId: activeProfileId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      },
    }).catch(() => {})

    if (!user?.is_admin) {
      recordClientSignInEvent({
        identifier: profile?.email ? normalizeEmail(profile.email) : `${provider}:${profile?.providerAccountId || 'unknown'}`,
        method: `oauth:${provider}`,
        userId: user?.id ?? null,
        profileId: activeProfileId ?? null,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      })
    }

    // Auto-trigger discovery crawlers on OAuth login (fire and forget)
    if (activeProfileId) {
      triggerAutoDiscoveryCrawlers(req.db, activeProfileId, { uploadDir, getOpenAI }).catch(err => {
        console.error(`[auth/${provider}] Failed to queue auto-discovery crawlers:`, err)
      })
    }

    return redirectWithParams({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      accessExpires: session.accessExpires,
      refreshExpires: session.refreshExpires,
      activeProfileId: activeProfileId ?? undefined,
    })
  } catch (oauthError) {
    console.error(`[auth] ${provider} oauth callback failed:`, oauthError)
    return redirectWithParams({ error: 'oauth_exchange_failed' })
  }
})

router.get('/me', async (req, res) => {
  try {
    // Return current user information based on the JWT token
    // The server middleware populates req.user from the Authorization header
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    let user, profiles
    
    try {
      user = await getUserById(req.db, req.user.userId)
    } catch (dbError) {
      console.error('[auth/me] Database error fetching user:', dbError)
      return res.status(500).json({ 
        error: 'Database error occurred',
        error_type: 'database_error',
        details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
      })
    }
    
    if (!user) {
      // Self-heal for hosted environments where the SQLite file can reset between deploys/restarts.
      // If the request is authenticated (signed JWT), recreate a minimal user record so sessions
      // and admin tools don't become brittle.
      try {
        const userId = req.user.userId
        const email = typeof req.user.email === 'string' ? req.user.email : null
        const displayName = typeof req.user.full_name === 'string' ? req.user.full_name : null
        const isAdmin = req.user.role === 'admin' || req.user.is_admin === true

        await req.db.prepare(
          `
            INSERT INTO users (id, display_name, primary_email, is_admin)
            VALUES (?, ?, ?, ?)
          `,
        ).run(userId, displayName, email, isAdmin)

        if (email) {
          await ensureAdminStatus(req.db, userId, normalizeEmail(email))
        }

        user = await getUserById(req.db, userId)
      } catch (repairError) {
        console.error('[auth/me] Unable to self-heal missing user:', repairError)
      }

      if (!user) {
        return res.status(404).json({ error: 'User not found' })
      }
    }

    try {
      profiles = await getUserProfiles(req.db, user.id)
    } catch (dbError) {
      console.error('[auth/me] Database error fetching profiles:', dbError)
      // Return user data without profiles if profiles query fails
      profiles = []
    }
    
    const activeProfileId = req.user.profileId || null

    return res.json({
      user: buildUserPayload(user, profiles, activeProfileId),
    })
  } catch (error) {
    console.error('[auth/me] Unexpected error:', error)
    return res.status(500).json({ 
      error: 'An unexpected error occurred',
      error_type: 'internal_error',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    })
  }
})

router.post('/refresh', async (req, res) => {
  const refreshToken = req.body?.refreshToken
  if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
    return res.status(400).json({ error: 'refreshToken is required' })
  }

  const refreshHash = hashValue(refreshToken)
  const sessionRow = await req.db
    .prepare(
      `
        SELECT s.*, u.display_name, u.primary_email, u.primary_phone, u.avatar_url, u.is_admin
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = ?
      `,
    )
    .get(refreshHash)

  if (!sessionRow) {
    return res.status(401).json({ error: 'Invalid refresh token' })
  }
  if (sessionRow.revoked_at) {
    return res.status(401).json({ error: 'Session has been revoked' })
  }
  if (sessionRow.refresh_expires_at && new Date(sessionRow.refresh_expires_at) < new Date()) {
    await req.db
      .prepare(
        `
          UPDATE user_sessions
          SET revoked_at = ?
          WHERE id = ?
        `,
      )
      .run(nowISOString(), sessionRow.id)
    return res.status(401).json({ error: 'Refresh token has expired' })
  }

  const user = await getUserById(req.db, sessionRow.user_id)
  if (!user) {
    return res.status(401).json({ error: 'User no longer exists' })
  }

  const profiles = await getUserProfiles(req.db, user.id)
  const tokens = await rotateSessionTokens(req.db, {
    sessionId: sessionRow.id,
    user,
    profileId: sessionRow.profile_id,
  })

  return res.json({
    ...tokens,
    tokenType: 'Bearer',
    user: buildUserPayload(user, profiles, sessionRow.profile_id),
  })
})

router.post('/logout', async (req, res) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null
  if (refreshToken) {
    const refreshHash = hashValue(refreshToken)
    await req.db
      .prepare(
        `
          UPDATE user_sessions
          SET revoked_at = ?
          WHERE refresh_token_hash = ?
        `,
      )
      .run(nowISOString(), refreshHash)
    return res.status(204).send()
  }

  if (req.user?.sessionId) {
    await req.db
      .prepare(
        `
          UPDATE user_sessions
          SET revoked_at = ?
          WHERE id = ?
        `,
      )
      .run(nowISOString(), req.user.sessionId)
  }

  return res.status(204).send()
})

export default router
