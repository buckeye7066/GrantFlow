import express from 'express'
import crypto from 'crypto'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import twilio from 'twilio'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initializeAnyaOnLogin } from '../services/anyaLoginTrigger.js'
import { sendTwilioMessage } from '../services/sms.js'
import { requireResolvedIdentity } from '../utils/accessControl.js'
import { enforce as enforceOwnerBlocklist } from '../services/blocklist/ownerBlocklistService.js'
import { scheduleAdminGeoCrawlOnLogin } from '../services/adminGeoCrawlOnLogin.js'
import { recordClientSignInEvent } from '../services/adminLoginEventStore.js'
import { recordSuccessfulLogin } from '../services/firstLoginNotifier.js'
import { resolveGuidedCycleTourStatus, resolveForcedWelcomeVideo } from '../services/onboardingGates.js'
import { getOpenAIOptional } from '../utils/aiProviders.js'
import { loadEnv, getJwtSecretOrThrow } from '../config/env.js'

// Import email service (with fallback if main service fails to load)
import {
  sendVerificationEmail as mainSendEmail,
  sendPasswordSetupEmail as mainSendPasswordSetupEmail,
  sendAuthAttemptNotification as mainAuthNotify,
  isEmailServiceConfigured,
  EmailSendError,
} from '../services/email.js'
import {
  sendVerificationEmail as fallbackSendEmail,
  sendPasswordSetupEmail as fallbackSendPasswordSetupEmail,
} from '../services/emailFallback.js'

// Use main email service if available, otherwise fallback
const sendVerificationEmail = mainSendEmail || fallbackSendEmail
const sendPasswordSetupEmail = mainSendPasswordSetupEmail || fallbackSendPasswordSetupEmail
const sendAuthAttemptNotification = typeof mainAuthNotify === 'function' ? mainAuthNotify : async () => false
import { getDesignatedProfileForEmail } from '../config/userProfileMappings.js'
import { ADMIN_EMAIL, isAdminEmail } from '../config/constants.js'
import { ensureAdminUser, isAdminUserId } from '../utils/adminProfileLinks.js'
import { ensureProfileEmailSchema } from '../utils/accessControl.js'
import { runProfileDiscoveryLive } from '../services/crawlerOsService.js'
import bcrypt from 'bcryptjs'

import { createLogger, sanitizeLogValue } from '../utils/logger.js'
import { isLoginMaintenanceActive, LOGIN_MAINTENANCE_MESSAGE, LOGIN_MAINTENANCE_COPY } from '../config/maintenance.js'
const routeLogger = createLogger('route:auth')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const uploadDir = join(__dirname, '..', 'uploads')

const router = express.Router()

// LOGIN MAINTENANCE GUARD — while the upgrade maintenance flag is on, block
// every session-creating endpoint on this router with a 503. Existing
// sessions keep working: /refresh, /logout, and /onboarding-state (a logged-in
// user's state mutation, not session-creating) are exempt, and GET /api/auth/me
// lives in authMe.js which this guard never touches. /maintenance is also exempt
// so the runtime status probe (below) can answer while the fence is up — the
// Login page needs it to show the banner.
const MAINTENANCE_EXEMPT_PATHS = new Set(['/refresh', '/logout', '/onboarding-state', '/maintenance'])
router.use((req, res, next) => {
  if (!isLoginMaintenanceActive()) return next()
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path
  if (MAINTENANCE_EXEMPT_PATHS.has(path)) return next()
  if (req.method === 'GET' && path.endsWith('/callback')) {
    // An OAuth provider callback is a top-level BROWSER navigation, not an
    // XHR — hand the user to the frontend banner instead of raw JSON, the
    // same convention as every failure path in the callback handler itself.
    return res.redirect(buildRedirectUrl(defaultFrontendRedirect(req), { error: 'maintenance' }))
  }
  return res.status(503).json({
    error: 'maintenance',
    message: LOGIN_MAINTENANCE_MESSAGE,
  })
})

// Public status probe: the Login page asks this at runtime so the banner
// follows the server-side switch (LOGIN_MAINTENANCE env var) without a
// frontend rebuild. Never requires auth; exempt from the guard above.
router.get('/maintenance', (_req, res) => {
  res.json({ active: isLoginMaintenanceActive(), ...LOGIN_MAINTENANCE_COPY })
})

function getOpenAI() {
  const openai = getOpenAIOptional()
  if (!openai) {
    console.warn('[auth] OpenAI not configured; AI-backed crawlers will fall back when possible')
    return null
  }
  return openai
}

/**
 * Resolve JWT secret from environment variables.
 * CRITICAL: Must match server.js implementation to ensure consistency.
 * Production requires a stable, secure secret - NO runtime generation.
 */
let JWT_SECRET
try {
  JWT_SECRET = getJwtSecretOrThrow(process.env)
} catch (err) {
  console.error(`FATAL ERROR: ${err.message}`)
  process.exit(1)
}

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
const REFRESH_COOKIE_NAME = 'grantflow_refresh'
const REFRESH_RACE_GRACE_MS = Math.max(
  1_000,
  Number.parseInt(process.env.AUTH_REFRESH_RACE_GRACE_MS || '15000', 10) || 15_000,
)
const EMAIL_CODE_TTL = parseSeconds(process.env.AUTH_EMAIL_CODE_TTL, 600) // seconds
const EMAIL_RESEND_COOLDOWN = parseSeconds(process.env.AUTH_EMAIL_RESEND_SECONDS, 45) // seconds
// Max wrong /email/verify guesses against a single active code before it is
// invalidated (lockout). Bounds an ONLINE brute-force of the 6-digit space; the
// verifier is never exposed to the client, so there is no offline attack.
const EMAIL_MAX_VERIFY_ATTEMPTS = Math.max(3, parseInt(process.env.AUTH_EMAIL_MAX_VERIFY_ATTEMPTS, 10) || 6)
const PHONE_MAX_VERIFY_ATTEMPTS = Math.max(3, parseInt(process.env.AUTH_PHONE_MAX_VERIFY_ATTEMPTS, 10) || 6)
const PHONE_CODE_TTL = parseSeconds(process.env.AUTH_PHONE_CODE_TTL, 600) // seconds
const PHONE_RESEND_COOLDOWN = parseSeconds(process.env.AUTH_PHONE_RESEND_SECONDS, 60) // seconds
const OAUTH_STATE_TTL = parseSeconds(process.env.AUTH_OAUTH_STATE_TTL, 600) // seconds
const PASSWORD_SETUP_TTL = parseSeconds(process.env.AUTH_PASSWORD_SETUP_TTL, 30 * 60) // seconds (default: 30 minutes)

routeLogger.info('[auth] TTL configuration (seconds):', {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  EMAIL_CODE_TTL,
  EMAIL_RESEND_COOLDOWN,
  PHONE_CODE_TTL,
  PHONE_RESEND_COOLDOWN,
  OAUTH_STATE_TTL,
  PASSWORD_SETUP_TTL,
})

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || null
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || null
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || null

const AUTH_PUBLIC_URL = process.env.AUTH_PUBLIC_URL || process.env.PUBLIC_URL || null
const FRONTEND_BASE_URL = process.env.AUTH_FRONTEND_URL || process.env.FRONTEND_BASE_URL || null
const FRONTEND_APP_BASE =
  process.env.AUTH_FRONTEND_APP_BASE || process.env.APP_BASE_PATH || process.env.VITE_APP_BASE || '/'

function refreshCookiePaths() {
  const paths = new Set(['/api/auth'])
  const appBase = normalizeBasePath(FRONTEND_APP_BASE)
  if (appBase) paths.add(`${appBase}/api/auth`)
  return [...paths]
}

function isNativeAppOrigin(origin) {
  return origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function refreshCookieOptions(path, req) {
  const nativeOrigin = isNativeAppOrigin(req?.get?.('origin'))
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || nativeOrigin,
    // Native Capacitor requests are genuinely cross-site to Railway and require
    // None; the web app's Vercel rewrite is same-origin and stays Strict.
    sameSite: nativeOrigin ? 'none' : 'strict',
    path,
    maxAge: REFRESH_TOKEN_TTL * 1000,
  }
}

function setRefreshCookie(req, res, refreshToken) {
  for (const path of refreshCookiePaths()) {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(path, req))
  }
  res.setHeader('Cache-Control', 'no-store')
}

function clearRefreshCookie(req, res) {
  for (const path of refreshCookiePaths()) {
    const { maxAge: _maxAge, ...options } = refreshCookieOptions(path, req)
    res.clearCookie(REFRESH_COOKIE_NAME, options)
  }
  res.setHeader('Cache-Control', 'no-store')
}

function readCookie(req, name) {
  const raw = typeof req.headers?.cookie === 'string' ? req.headers.cookie : ''
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    if (key !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

function getRefreshCookie(req) {
  const value = readCookie(req, REFRESH_COOKIE_NAME)
  return typeof value === 'string' && value.length >= 20 ? value : null
}

function configuredAuthOrigins(req) {
  const origins = new Set([
    'http://localhost:5173',
    'http://localhost:3000',
    'https://app.axiombiolabs.org',
    'https://www.axiombiolabs.org',
    'https://localhost',
    'capacitor://localhost',
  ])
  for (const candidate of [FRONTEND_BASE_URL, AUTH_PUBLIC_URL]) {
    if (!candidate) continue
    try { origins.add(new URL(candidate).origin) } catch { /* invalid env is handled elsewhere */ }
  }
  for (const candidate of String(process.env.CORS_ORIGIN || '').split(',')) {
    if (!candidate.trim()) continue
    try { origins.add(new URL(candidate.trim()).origin) } catch { /* ignore malformed optional entry */ }
  }
  try { origins.add(new URL(getServerBaseUrl(req)).origin) } catch { /* request host unavailable */ }
  return origins
}

/**
 * Refresh and logout are authorized by an ambient cookie, so they must reject
 * cross-site browser requests even when the response would be unreadable by
 * CORS. The custom header also excludes HTML form submissions. Non-browser
 * clients may omit Origin/Sec-Fetch-Site, but must still opt in with the header.
 */
function requireRefreshRequestIntegrity(req, res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'csrf_check_failed' })
  }

  const origin = req.get('origin')
  const nativeOrigin = isNativeAppOrigin(origin)
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase()
  if (!nativeOrigin && fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return res.status(403).json({ error: 'csrf_check_failed' })
  }

  if (origin) {
    if (nativeOrigin) return next()
    let normalized = null
    try { normalized = new URL(origin).origin } catch { /* rejected below */ }
    if (!normalized || !configuredAuthOrigins(req).has(normalized)) {
      return res.status(403).json({ error: 'csrf_check_failed' })
    }
  }

  return next()
}

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

const passwordRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number.parseInt(process.env.AUTH_PASSWORD_RATE_LIMIT ?? '5', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
})

// Defense-in-depth on top of the atomic per-code attempt cap: bound the total
// /email/verify requests per (normalized email + IP) so an attacker can't cycle
// through many freshly-started codes for one victim from one host. `normalizeEmail`
// is a hoisted function declaration, so referencing it here is safe.
const emailVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number.parseInt(process.env.AUTH_EMAIL_VERIFY_RATE_LIMIT ?? '30', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Normalize the IP through the library helper: a raw IPv6 address is a /128,
  // so combining req.ip directly buckets every IPv6 client separately and
  // defeats the limit (and trips express-rate-limit's ERR_ERL_KEY_GEN_IPV6
  // validation at boot). ipKeyGenerator collapses IPv6 to its routable subnet.
  keyGenerator: (req) => `${normalizeEmail(req.body?.email ?? '')}|${ipKeyGenerator(req.ip)}`,
})

function normalizeEmail(email = '') {
  return email.trim().toLowerCase()
}

async function upsertProfileEmailLink(db, profileId, email, addedBy = 'auth-auto-assign') {
  const normalized = normalizeEmail(email || '')
  if (!profileId || !normalized) return
  try {
    await ensureProfileEmailSchema(db)
  } catch (schemaErr) {
    console.warn('[auth] upsertProfileEmailLink: schema ensure failed, skipping link:', schemaErr?.message || schemaErr)
    return
  }

  if (db?.dialect === 'postgres') {
    await db
      .prepare(
        `
          INSERT INTO profile_emails (id, profile_id, email, added_by)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (profile_id, email) DO NOTHING
        `,
      )
      .run(crypto.randomUUID(), String(profileId), normalized, String(addedBy || 'auth-auto-assign'))
    return
  }

  // sqlite
  await db
    .prepare(
      `
        INSERT OR IGNORE INTO profile_emails (id, profile_id, email, added_by)
        VALUES (?, ?, ?, ?)
      `,
    )
    .run(crypto.randomUUID(), String(profileId), normalized, String(addedBy || 'auth-auto-assign'))
}

function normalizeSixDigitCode(value) {
  if (value === null || value === undefined) return null
  // Accept string OR number payloads; strip non-digits to tolerate copy/paste formatting.
  const digits = String(value).trim().replace(/[^\d]/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  return digits
}

function isValidEmail(email) {
  // Bounded quantifiers (RFC-plausible local/domain/TLD length caps) instead
  // of unbounded `+`: an unbounded run of `[^\s@]` chars before AND after a
  // literal `.` gives the regex engine many equivalent split points to try
  // when a long attacker-supplied string has several dots and no match at
  // the end, which is a polynomial ReDoS shape.
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/.test(email)
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

// Constant-time comparison of two hex digests (both are sha256 hex here). Avoids
// leaking, via response timing, how many leading bytes of the stored code hash a
// guess matched.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  let ba
  let bb
  try {
    ba = Buffer.from(a, 'hex')
    bb = Buffer.from(b, 'hex')
  } catch {
    return false
  }
  if (ba.length === 0 || ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function base64UrlToken(bytes = 32) {
  return base64UrlEncode(crypto.randomBytes(Math.max(16, Number(bytes) || 32)))
}

function isStrongPassword(password) {
  const value = String(password || '')
  if (value.length < 10) return { ok: false, error: 'Password must be at least 10 characters long' }
  const lower = value.toLowerCase()
  const common = new Set(['password', 'password1', 'password123', '1234567890', 'qwertyuiop', 'letmein'])
  if (common.has(lower)) return { ok: false, error: 'Password is too common' }
  return { ok: true }
}

/**
 * Determine if we're running in production environment.
 * Centralized helper to ensure consistent production detection across all auth routes.
 */
function isProductionEnvironment() {
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.RAILWAY_ENVIRONMENT === 'production' ||
    process.env.VERCEL_ENV === 'production'
  )
}

// ---------------------------------------------------------------------------
// OTP code sign-in is RETIRED in production (2026-07-11). Every sign-in
// surface uses the password flow: /access/check → /password/login, or an
// emailed /set-password link for accounts without a password yet. The code
// endpoints stay available OUTSIDE production for the local/dev/test harness;
// in production a stale cached frontend (or the pre-password Start.jsx) that
// still asks for a code gets a clear, actionable 410 instead of silently
// emailing 6-digit codes that confuse users ("a code popped up at login").
// Escape hatch: ALLOW_OTP_LOGIN=true re-enables them in production.
// ---------------------------------------------------------------------------
function isOtpLoginRetired() {
  return (
    isProductionEnvironment() &&
    String(process.env.ALLOW_OTP_LOGIN || '').toLowerCase() !== 'true'
  )
}

function otpLoginRetired(res) {
  return res.status(410).json({
    error_type: 'code_login_retired',
    error:
      "Sign-in codes are no longer used. Refresh the page and sign in with your email — we'll send you a secure password link instead.",
    redirect_to: '/Login',
  })
}

// SECURITY: a JWT is SIGNED, not ENCRYPTED — anyone holding this token can base64-
// decode its payload. It therefore MUST NOT carry the OTP verifier (a hash of the
// 6-digit code): sha256 is instant, so an exposed `sha256(email:code)` lets the
// holder brute-force all 1,000,000 codes offline and recover the real code. This
// token is now only an opaque, non-secret challenge REFERENCE (identifier + nonce)
// returned for client convenience; it is NEVER accepted as proof of possession.
// The authoritative verifier is the server-side one-time DB code row (hashed,
// expiring, attempt-limited) checked in /email/verify.
function signOtpToken({ kind, identifier, ttlSeconds }) {
  const jti = crypto.randomUUID()
  return jwt.sign(
    {
      typ: 'otp',
      kind,
      identifier,
      jti,
    },
    JWT_SECRET,
    { expiresIn: Math.max(30, Number(ttlSeconds) || 600) },
  )
}

/**
 * Atomically verify a submitted OTP against the server-side one-time code rows.
 *
 * Runs inside a SINGLE transaction so the attempt cap and one-time consumption
 * are race-free even under pooled/concurrent Postgres (the TOCTOU class):
 *   - Postgres locks the credential's active rows with `FOR UPDATE`; SQLite's
 *     `BEGIN IMMEDIATE` serializes writers — so concurrent verifies for the same
 *     credential execute one at a time.
 *   - The attempt cap is re-read UNDER the lock, so parallel WRONG guesses cannot
 *     all observe `attempt_count < max` and slip past the cap. Once the cap is
 *     reached the active code stays LOCKED (every further attempt — right or
 *     wrong — is rejected) until a fresh /start mints a new code.
 *   - A CORRECT guess consumes via a single conditional `UPDATE ... WHERE
 *     consumed_at IS NULL` that must affect exactly ONE row; two parallel correct
 *     submissions therefore yield exactly one success (one session) — the loser
 *     gets `already_consumed`, never a second session.
 *   - The code compare is constant-time (`timingSafeEqualHex`).
 *
 * Returns: 'ok' | 'invalid' | 'already_consumed' | 'locked_out'.
 */
async function atomicVerifyOtpCode(db, credentialId, incomingHash, maxAttempts) {
  return db.withTransaction(async (tx) => {
    const now = nowISOString()
    const lockClause = tx.dialect === 'postgres' ? ' FOR UPDATE' : ''

    const active = await tx
      .prepare(
        `
          SELECT id, code_hash, attempt_count
          FROM user_verification_codes
          WHERE credential_id = ?
            AND consumed_at IS NULL
            AND (expires_at IS NULL OR expires_at >= ?)
          ORDER BY created_at DESC
          LIMIT 10${lockClause}
        `,
      )
      .all(credentialId, now)

    const latest = Array.isArray(active) && active.length > 0 ? active[0] : null

    const match = Array.isArray(active)
      ? active.find((row) => timingSafeEqualHex(row.code_hash, incomingHash))
      : null

    if (match) {
      // Cap enforced on the MATCHED row (not merely the latest): a matched-but-
      // capped code is LOCKED, never consumed — even if it is an older row that a
      // fresh /start left behind. Combined with the single-active-code invariant
      // in insertFreshVerificationCode, this makes the per-code cap strict.
      if (Number(match.attempt_count || 0) >= maxAttempts) {
        return 'locked_out'
      }
      // One-time consume — a single conditional UPDATE that MUST affect exactly
      // one row. A parallel winner already flipped consumed_at → 0 rows →
      // 'already_consumed' (no second session).
      const consume = await tx
        .prepare(
          `UPDATE user_verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`,
        )
        .run(now, match.id, now)
      if (Number(consume?.changes ?? 0) !== 1) {
        return 'already_consumed'
      }
      await tx
        .prepare(`UPDATE user_credentials SET verified_at = COALESCE(verified_at, ?), attempt_count = 0 WHERE id = ?`)
        .run(now, credentialId)
      return 'ok'
    }

    // No match (wrong guess). If the latest active code is already capped, the
    // credential is locked out. Otherwise charge the miss to the latest active
    // code (raceless conditional increment) and the credential counter. Serialized
    // by the lock, so the cap is exact.
    if (latest && Number(latest.attempt_count || 0) >= maxAttempts) {
      return 'locked_out'
    }
    if (latest?.id) {
      await tx
        .prepare(`UPDATE user_verification_codes SET attempt_count = attempt_count + 1 WHERE id = ? AND consumed_at IS NULL`)
        .run(latest.id)
    }
    await tx.prepare(`UPDATE user_credentials SET attempt_count = attempt_count + 1 WHERE id = ?`).run(credentialId)
    return 'invalid'
  })
}

function nowISOString() {
  return new Date().toISOString()
}

function generateSixDigitCode() {
  // MUST be a CSPRNG. Math.random() is a seeded PRNG whose internal state is
  // recoverable from observed outputs, so an attacker who can mint codes for
  // their own address (self-service email/phone verification) can predict the
  // code issued to somebody else's. crypto.randomInt is uniform over the range
  // and unpredictable; the upper bound is exclusive, so this yields 100000-999999.
  return String(crypto.randomInt(100000, 1000000))
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
  // Auth redirects (OAuth callback, password-setup email links) must NEVER
  // invent a base URL from an untrusted Origin. An attacker page that POSTs
  // /password/setup/start with Origin: evil.example would otherwise put the
  // password-setup token in a link on the attacker's host.
  if (FRONTEND_BASE_URL) {
    return FRONTEND_BASE_URL.replace(/\/$/, '')
  }
  // Origin is honored ONLY when it already sits on the configured allowlist
  // (localhost Vite, app.axiombiolabs.org, CORS_ORIGIN, …). It must never
  // grow that allowlist.
  const origin = req.get('origin')
  if (origin) {
    try {
      const normalized = new URL(origin).origin
      if (configuredAuthOrigins(req).has(normalized)) {
        return normalized
      }
    } catch {
      // fall through
    }
  }
  return getServerBaseUrl(req)
}

function defaultFrontendRedirect(req) {
  const baseUrl = inferFrontendBaseUrl(req)
  const path = `${normalizeBasePath(FRONTEND_APP_BASE)}/auth/callback`.replace(/\/{2,}/g, '/')
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Resolve a post-OAuth frontend redirect. Only origins from
 * configuredAuthOrigins() are accepted — never the request Origin/Referer.
 *
 * Concrete trigger this closed: attacker hosts
 *   <a href="https://api…/api/auth/google?redirect_to=https://evil.example/steal">
 * Victim clicks (Referer: evil.example). The old allowlist ADDED the Referer
 * origin, stored redirect_to=evil.example, and after Google login redirected
 * to evil.example#handoff=<one-time-session-capability>. The attacker's page
 * then POSTs /oauth/complete and receives the victim's access token.
 */
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

  if (configuredAuthOrigins(req).has(redirectUrl.origin)) {
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

// Returns { ok, skipped?, error? }. `skipped` = no provider configured (dev):
// the code is logged and the flow proceeds. `ok:false` (no skip) = a real
// delivery failure — the caller must NOT claim "sent" or stamp the resend
// cooldown. Never throws.
async function sendPhoneVerificationCode(phone, code) {
  if (!twilioClient) {
    console.warn('[auth] Twilio credentials not configured; skipping SMS send. Code:', code, 'Phone:', phone)
    return { ok: false, skipped: true, error: 'sms_not_configured' }
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
      return { ok: false, skipped: true, error: 'sms_from_not_configured' }
    }
    // Checked send: Twilio can RESOLVE with a failed/undelivered message
    // (errorCode set) without throwing.
    const result = await sendTwilioMessage(twilioClient, payload)
    if (!result.ok) console.error('[auth] Twilio rejected verification SMS:', result.error)
    return result
  } catch (error) {
    console.error('[auth] Failed to send SMS code:', error.message)
    return { ok: false, error: error.message }
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
        SELECT id, display_name, organization_id, status, avatar_url
        FROM profiles
        WHERE user_id = ?
        ORDER BY created_at ASC
      `,
    )
    .all(userId)
}

async function buildUserPayload(db, userRow, profiles, activeProfileId) {
  // One-time forced welcome video gate (services/onboardingGates.js). Fail-open
  // (returns null on any error) so login can never break on this lookup. null
  // for everyone with no unconsumed forced row → zero behavior change.
  const forcedWelcomeVideo = await resolveForcedWelcomeVideo(db, userRow)
  return {
    id: userRow.id,
    display_name: userRow.display_name,
    primary_email: userRow.primary_email,
    primary_phone: userRow.primary_phone,
    avatar_url: userRow.avatar_url,
    is_admin: Boolean(userRow.is_admin),
    profiles,
    active_profile_id: activeProfileId ?? (userRow.is_admin ? null : profiles[0]?.id ?? null),
    // So the guided first-cycle tour can start immediately on login, without
    // waiting on a separate GET /api/auth/me round-trip (see setAuthenticatedUser's
    // payload.user branch, which maps this into the store's guidedCycleTourStatus).
    // Resolved through the canonical onboardingGates gate: an ADMIN account
    // that has already been interviewed (or has ever signed in before) is
    // NEVER served 'pending_reinterview' again — a secondary admin login must
    // not re-trigger Anya's interview (owner-directed, 2026-07-06). Non-admin
    // behavior is unchanged.
    guided_cycle_tour_status: resolveGuidedCycleTourStatus(userRow),
    // One-time forced welcome video — the frontend renders this above every
    // onboarding branch (new HIGHEST priority in OnboardingSequencer), then
    // POSTs consume so it never replays. null for everyone with no forced row.
    forced_welcome_video: forcedWelcomeVideo,
    // Pre-existing gap found alongside the above: this was never returned here,
    // so setAuthenticatedUser's `payload.user?.has_completed_onboarding` read
    // (used for hasSeenOnboarding/needsProfileCreation) was always reading
    // undefined -> false on every fresh login through this payload shape.
    has_completed_onboarding: Boolean(userRow.has_completed_onboarding),
    // Full parity with GET /api/auth/me's response (server.js) so
    // AnyaGuidedTour's version-gate and the guided-tour flows behave
    // identically whether the frontend just got this from a login response
    // or from a later bootstrap fetch.
    onboarding_completed_at: userRow.onboarding_completed_at ?? null,
    last_seen_manual_version: Number(userRow.last_seen_manual_version ?? 0),
    last_completed_tour_version: Number(userRow.last_completed_tour_version ?? 0),
    tour_dismissed_at: userRow.tour_dismissed_at ?? null,
  }
}

/**
 * Find a profile by email address.
 * Checks (in order): users.primary_email, profile_sections.basic_information (richest profile wins),
 * then profile_emails.
 *
 * basic_information is resolved before profile_emails so a fully filled intake profile wins over a
 * designated-roster stub that only has profile_emails / owner_email linkage for the same address.
 *
 * When multiple profiles list the same email in basic_information, prefer the profile with more
 * section rows (fuller data), then the most recently updated profile.
 *
 * Works with both Postgres and SQLite.
 * @param {Object} db - Database instance
 * @param {string} normalizedEmail - Normalized email address (lowercase)
 * @returns {Promise<{id: string, user_id: string|null}|null>} Profile row or null
 */
async function findProfileRowForEmail(db, normalizedEmail) {
  if (!normalizedEmail) return null

  // 1) users.primary_email: returning users who have an account
  try {
    const userRow = await db
      .prepare('SELECT id FROM users WHERE LOWER(TRIM(primary_email)) = ? LIMIT 1')
      .get(normalizedEmail)
    if (userRow?.id) {
      const profileRow = await db
        .prepare(
          `
            SELECT id, user_id
            FROM profiles
            WHERE user_id = ?
            ORDER BY created_at ASC NULLS LAST, id ASC
            LIMIT 1
          `,
        )
        .get(userRow.id)
      if (profileRow?.id) return profileRow
    }
  } catch {
    // ignore
  }

  // 2) profile_sections.basic_information.data.email (before profile_emails — see JSDoc)
  // Postgres: JSON ->> extraction is safe and fast.
  if (db?.dialect === 'postgres') {
    try {
      const pgRow = await db
        .prepare(
          `
            SELECT p.id, p.user_id
            FROM profiles p
            JOIN profile_sections ps ON ps.profile_id = p.id
            WHERE ps.section_key = 'basic_information'
              AND LOWER((ps.data::jsonb ->> 'email')) = ?
            ORDER BY (
              SELECT COUNT(*)::int FROM profile_sections ps2 WHERE ps2.profile_id = p.id
            ) DESC,
            COALESCE(p.updated_at, p.created_at) DESC NULLS LAST,
            p.id ASC
            LIMIT 1
          `,
        )
        .get(normalizedEmail)
      if (pgRow?.id) return pgRow
    } catch {
      // ignore
    }
  } else {
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
            ORDER BY (
              SELECT COUNT(*) FROM profile_sections ps2 WHERE ps2.profile_id = p.id
            ) DESC,
            COALESCE(p.updated_at, p.created_at) DESC NULLS LAST,
            p.id ASC
            LIMIT 1
          `,
        )
        .get(normalizedEmail)
      if (row?.id) return row
    } catch {
      // ignore and fall back to LIKE matching
    }

    // Fallback: match in JSON string (works even if json1 isn't enabled).
    const escapedEmail = normalizedEmail
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
    const needle = `"email":"${escapedEmail.toLowerCase()}"`
    try {
      const likeRow = await db
        .prepare(
          `
            SELECT p.id, p.user_id
            FROM profiles p
            JOIN profile_sections ps ON ps.profile_id = p.id
            WHERE ps.section_key = 'basic_information'
              AND LOWER(ps.data) LIKE ?
            ORDER BY (
              SELECT COUNT(*) FROM profile_sections ps2 WHERE ps2.profile_id = p.id
            ) DESC,
            COALESCE(p.updated_at, p.created_at) DESC NULLS LAST,
            p.id ASC
            LIMIT 1
          `,
        )
        .get(`%${needle}%`)
      if (likeRow?.id) return likeRow
    } catch {
      // ignore
    }
  }

  // 3) profile_emails: explicit access mapping (board members, alternates, designated stubs, etc.)
  try {
    await ensureProfileEmailSchema(db)
    const peRow = await db
      .prepare(
        `SELECT profile_id FROM profile_emails WHERE LOWER(TRIM(email)) = ? LIMIT 1`
      )
      .get(normalizedEmail)
    if (peRow?.profile_id) {
      const profileRow = await db
        .prepare('SELECT id, user_id FROM profiles WHERE id = ? LIMIT 1')
        .get(peRow.profile_id)
      if (profileRow?.id) return profileRow
    }
  } catch {
    // ignore
  }

  return null
}

async function assignProfileToUser(db, userId, email) {
  if (email && isAdminEmail(email)) {
    await ensureAdminUser(db)
    return null
  }

  if (email) {
    const normalizedEmail = normalizeEmail(email)
    const existingOwned = userId
      ? await db.prepare('SELECT id FROM profiles WHERE user_id = ? LIMIT 1').get(userId)
      : null

    // 1) Best-effort match to an existing profile by email captured in profile sections.
    // This is the safest way to ensure returning users re-claim their original profile
    // even when IDs/mappings drift across DB restores.
    const byEmail = await findProfileRowForEmail(db, normalizedEmail)
    if (byEmail?.id) {
      if (!byEmail.user_id || byEmail.user_id === userId) {
        // Respect "one owned profile per user" unique constraint.
        if (!existingOwned?.id || String(existingOwned.id) === String(byEmail.id)) {
          await db
            .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(userId, byEmail.id)
        }
        // Persist the email mapping so future access is stable.
        await upsertProfileEmailLink(db, byEmail.id, normalizedEmail, 'auth-auto-assign')
        return byEmail.id
      }
      if (await isAdminUserId(db, byEmail.user_id)) {
        if (!existingOwned?.id || String(existingOwned.id) === String(byEmail.id)) {
          await db
            .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(userId, byEmail.id)
        }
        await upsertProfileEmailLink(db, byEmail.id, normalizedEmail, 'auth-auto-assign')
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
          if (!existingOwned?.id || String(existingOwned.id) === String(designatedProfileId)) {
            await db
              .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(userId, designatedProfileId)
          }
          // Ensure the profile's basic_information.email is set so downstream matching can work.
          try {
            const row = await db
              .prepare(
                `
                  SELECT data
                  FROM profile_sections
                  WHERE profile_id = ?
                    AND section_key = 'basic_information'
                  LIMIT 1
                `,
              )
              .get(designatedProfileId)
            const parsed = row?.data ? JSON.parse(String(row.data)) : {}
            if (parsed && typeof parsed === 'object' && !String(parsed.email || '').trim()) {
              parsed.email = normalizedEmail
              await db
                .prepare(
                  `
                    UPDATE profile_sections
                    SET data = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
                    WHERE profile_id = ?
                      AND section_key = 'basic_information'
                  `,
                )
                .run(JSON.stringify(parsed), 'auth-auto-assign', designatedProfileId)
            }
          } catch {
            // ignore
          }

          // Persist the email mapping so future access is stable.
          await upsertProfileEmailLink(db, designatedProfileId, normalizedEmail, 'auth-auto-assign')
          return designatedProfileId
        }
        if (await isAdminUserId(db, designatedProfile.user_id)) {
          if (!existingOwned?.id || String(existingOwned.id) === String(designatedProfileId)) {
            await db
              .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(userId, designatedProfileId)
          }
          try {
            const row = await db
              .prepare(
                `
                  SELECT data
                  FROM profile_sections
                  WHERE profile_id = ?
                    AND section_key = 'basic_information'
                  LIMIT 1
                `,
              )
              .get(designatedProfileId)
            const parsed = row?.data ? JSON.parse(String(row.data)) : {}
            if (parsed && typeof parsed === 'object' && !String(parsed.email || '').trim()) {
              parsed.email = normalizedEmail
              await db
                .prepare(
                  `
                    UPDATE profile_sections
                    SET data = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
                    WHERE profile_id = ?
                      AND section_key = 'basic_information'
                  `,
                )
                .run(JSON.stringify(parsed), 'auth-auto-assign', designatedProfileId)
            }
          } catch {
            // ignore
          }

          await upsertProfileEmailLink(db, designatedProfileId, normalizedEmail, 'auth-auto-assign')
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
    await db
      .prepare('UPDATE users SET is_admin = TRUE WHERE id = ? AND COALESCE(is_admin, FALSE) = FALSE')
      .run(userId)
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
    // Ensure admin status is set if this is the admin email
    await ensureAdminStatus(db, existing.user_id, email)
    // Reload user to get updated admin status
    const updatedUser = await getUserById(db, existing.user_id)
    return {
      user: updatedUser,
      credential: existing,
    }
  }

  // First-ever email_otp login: create the user + credential ATOMICALLY and
  // IDEMPOTENTLY, SERIALIZED per identifier — so two concurrent first-ever
  // /email/start converge on ONE user, ONE credential, ONE profile (no duplicate
  // users, no UNIQUE(type,identifier) 500). A users row may already exist for this
  // email (password/OAuth/phone/import); reuse it instead of inserting a duplicate
  // (ux_users_primary_email).
  return db.withTransaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      await tx.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).get(`email_otp:${email}`)
    }
    // (SQLite BEGIN IMMEDIATE already serializes writers.)

    // Double-checked under the lock.
    let cred = await tx.prepare(`SELECT * FROM user_credentials WHERE type = 'email_otp' AND identifier = ?`).get(email)
    let userId
    if (cred) {
      userId = cred.user_id
      await ensureAdminStatus(tx, userId, email)
    } else {
      const existingUser = await getUserByEmail(tx, email)
      if (existingUser) {
        userId = existingUser.id
        await ensureAdminStatus(tx, userId, email)
      } else {
        // Serialized above, so select-then-insert is safe; ux_users_primary_email
        // is the DB backstop.
        userId = crypto.randomUUID()
        const displayName = email.split('@')[0] || 'New User'
        await tx
          .prepare('INSERT INTO users (id, display_name, primary_email, is_admin) VALUES (?, ?, ?, ?)')
          .run(userId, displayName, email, isAdminEmail(email) ? true : false)
        await assignProfileToUser(tx, userId, email)
      }
      const credentialId = crypto.randomUUID()
      await tx
        .prepare(`INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES (?, ?, 'email_otp', ?, 0) ON CONFLICT (type, identifier) DO NOTHING`)
        .run(credentialId, userId, email)
      cred = await tx.prepare(`SELECT * FROM user_credentials WHERE type = 'email_otp' AND identifier = ?`).get(email)
    }

    const user = await getUserById(tx, userId)
    return { user, credential: cred }
  })
}

async function getUserByEmail(db, email) {
  if (!email) return null
  return await db
    .prepare(
      `
        SELECT *
        FROM users
        WHERE primary_email = ?
      `,
    )
    .get(email)
}

async function ensureUserForPasswordAuth(db, email) {
  const existing = await getUserByEmail(db, email)
  if (existing) {
    // Ensure admin status is set if this is the admin email
    await ensureAdminStatus(db, existing.id, email)
    return await getUserById(db, existing.id)
  }

  const displayName = email.split('@')[0] || 'New User'
  const userId = crypto.randomUUID()
  await db
    .prepare('INSERT INTO users (id, display_name, primary_email, is_admin) VALUES (?, ?, ?, ?)')
    .run(userId, displayName, email, isAdminEmail(email) ? true : false)

  return await getUserById(db, userId)
}

async function consumePasswordSetupToken(db, tokenHash) {
  const now = nowISOString()
  // sqlite uses TEXT timestamps; postgres uses timestamptz; both compare fine as ISO strings in our abstraction.
  const row = await db
    .prepare(
      `
        SELECT *
        FROM password_setup_tokens
        WHERE token_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
        LIMIT 1
      `,
    )
    .get(tokenHash, now)
  return row ?? null
}

// Production hardening: protect password auth endpoints from schema drift / un-applied migrations.
// This is safe and idempotent (uses IF NOT EXISTS / tolerated sqlite duplicate-column errors).
let ensurePasswordAuthSchemaPromise = null

async function ensurePasswordAuthSchema(db) {
  if (!db) return
  if (ensurePasswordAuthSchemaPromise) return await ensurePasswordAuthSchemaPromise

  ensurePasswordAuthSchemaPromise = (async () => {
    try {
      if (db.dialect === 'postgres') {
        await db.exec(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

          CREATE TABLE IF NOT EXISTS password_setup_tokens (
            id TEXT PRIMARY KEY,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            consumed_at TIMESTAMPTZ NULL,
            request_ip TEXT NULL,
            user_agent TEXT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_token_hash ON password_setup_tokens(token_hash);
          CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id ON password_setup_tokens(user_id);
        `)
        return
      }

      if (db.dialect === 'sqlite') {
        try {
          await db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT;`)
        } catch (e) {
          const msg = String(e?.message || e || '').toLowerCase()
          if (!msg.includes('duplicate column')) throw e
        }

        await db.exec(`
          CREATE TABLE IF NOT EXISTS password_setup_tokens (
            id TEXT PRIMARY KEY,
            created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
            user_id TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT NULL,
            request_ip TEXT NULL,
            user_agent TEXT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_token_hash ON password_setup_tokens(token_hash);
          CREATE INDEX IF NOT EXISTS idx_password_setup_tokens_user_id ON password_setup_tokens(user_id);
        `)
      }
    } catch (error) {
      // Never throw from schema ensure: callers will handle degraded responses.
      console.warn('[auth/password] Unable to ensure password auth schema:', error?.message || String(error))
    }
  })()

  return await ensurePasswordAuthSchemaPromise
}

async function cleanupExpiredOAuthStates(db) {
  const expiredHandoffs = await db.prepare(
    `
      SELECT code_verifier AS session_id
      FROM oauth_states
      WHERE provider = ?
        AND expires_at <= CURRENT_TIMESTAMP
    `,
  ).all('grantflow-session')
  for (const row of expiredHandoffs) {
    if (!row?.session_id) continue
    await db.prepare(
      `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`,
    ).run(nowISOString(), row.session_id)
  }
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

async function createOAuthSessionHandoff(db, { sessionId, redirectTo }) {
  await cleanupExpiredOAuthStates(db)
  const handoff = base64UrlEncode(crypto.randomBytes(32))
  const handoffHash = hashValue(handoff)
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL * 1000).toISOString()
  await db.prepare(
    `
      INSERT INTO oauth_states (provider, state, code_verifier, redirect_to, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    'grantflow-session',
    handoffHash,
    sessionId,
    redirectTo ?? null,
    JSON.stringify({ purpose: 'oauth_session_handoff' }),
    expiresAt,
  )
  return handoff
}

async function consumeOAuthSessionHandoff(db, handoff) {
  const handoffHash = hashValue(handoff)
  const now = nowISOString()
  return db.withTransaction(async (tx) => {
    const row = await tx.prepare(
      `
        SELECT id, code_verifier, redirect_to
        FROM oauth_states
        WHERE provider = ?
          AND state = ?
          AND expires_at > ?
      `,
    ).get('grantflow-session', handoffHash, now)
    if (!row) return null

    const consumed = await tx.prepare(
      `DELETE FROM oauth_states WHERE id = ? AND provider = ? AND state = ?`,
    ).run(row.id, 'grantflow-session', handoffHash)
    if (Number(consumed?.changes ?? consumed?.rowCount ?? 0) !== 1) return null
    return { sessionId: row.code_verifier, redirectTo: row.redirect_to ?? null }
  })
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
    await assignProfileToUser(db, userId, email)
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
  // Fast path: the credential already exists (no transaction needed).
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

  // First-ever: create the user + credential ATOMICALLY and IDEMPOTENTLY,
  // SERIALIZED per identifier — so two concurrent first-ever /phone/start converge
  // on ONE user, ONE credential, ONE profile (no duplicates, no UNIQUE 500).
  return db.withTransaction(async (tx) => {
    if (tx.dialect === 'postgres') {
      // Serialize concurrent creators for this exact phone.
      await tx.prepare(`SELECT pg_advisory_xact_lock(hashtext(?))`).get(`phone_otp:${phone}`)
    }
    // (SQLite BEGIN IMMEDIATE already serializes writers.)

    // Double-checked under the lock: another creator may have just won.
    let cred = await tx.prepare(`SELECT * FROM user_credentials WHERE type = 'phone_otp' AND identifier = ?`).get(phone)
    if (!cred) {
      // Create-or-get the user by primary_phone idempotently (ux_users_primary_phone
      // backstop). Only the true creator assigns a profile.
      let user = await tx.prepare(`SELECT * FROM users WHERE primary_phone = ?`).get(phone)
      if (!user) {
        const userId = crypto.randomUUID()
        const displayName = `User ${phone.slice(-4)}`
        await tx
          .prepare(`INSERT INTO users (id, display_name, primary_phone) VALUES (?, ?, ?) ON CONFLICT (primary_phone) WHERE primary_phone IS NOT NULL DO NOTHING`)
          .run(userId, displayName, phone)
        user = await tx.prepare(`SELECT * FROM users WHERE primary_phone = ?`).get(phone)
        if (user && String(user.id) === String(userId)) {
          await assignProfileToUser(tx, userId, null)
        }
      }
      const credentialId = crypto.randomUUID()
      await tx
        .prepare(`INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count) VALUES (?, ?, 'phone_otp', ?, 0) ON CONFLICT (type, identifier) DO NOTHING`)
        .run(credentialId, user.id, phone)
      cred = await tx.prepare(`SELECT * FROM user_credentials WHERE type = 'phone_otp' AND identifier = ?`).get(phone)
    }
    const user = await getUserById(tx, cred.user_id)
    return { user, credential: cred }
  })
}

/**
 * Is `profileId` bound to `normalizedEmail`? Used to gate OTP-verify profile
 * ADOPTION: a verified email/phone code proves control of that CREDENTIAL, not
 * ownership of an arbitrary unowned profile id. Adoption is permitted only when
 * the profile is demonstrably the credential-holder's — via the designated map,
 * an explicit profile_emails access grant, its own basic_information.email, or
 * its owning user's verified primary email. (Security: tenant-takeover guard.)
 */
async function profileIsBoundToEmail(db, profileId, normalizedEmail) {
  if (!profileId || !normalizedEmail) return false

  // 1) Explicit designated mapping (baseline profiles).
  try {
    if (getDesignatedProfileForEmail(normalizedEmail) === profileId) return true
  } catch {
    // ignore
  }

  // 2) profile_emails explicit access mapping FOR THIS profile.
  try {
    await ensureProfileEmailSchema(db)
    const row = await db
      .prepare(
        `SELECT 1 AS ok FROM profile_emails WHERE profile_id = ? AND LOWER(TRIM(email)) = ? LIMIT 1`,
      )
      .get(profileId, normalizedEmail)
    if (row?.ok) return true
  } catch {
    // ignore
  }

  // 3) The profile's own basic_information.email.
  try {
    const secRow = await db
      .prepare(
        `SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information' LIMIT 1`,
      )
      .get(profileId)
    if (secRow?.data) {
      const parsed = JSON.parse(String(secRow.data))
      if (
        parsed &&
        typeof parsed === 'object' &&
        normalizeEmail(String(parsed.email || '')) === normalizedEmail
      ) {
        return true
      }
    }
  } catch {
    // ignore
  }

  // 4) The profile's owning user's primary email (same-account re-claim).
  try {
    const owner = await db
      .prepare(
        'SELECT u.primary_email AS email FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.id = ? LIMIT 1',
      )
      .get(profileId)
    if (owner?.email && normalizeEmail(String(owner.email)) === normalizedEmail) return true
  } catch {
    // ignore
  }

  return false
}

async function attachProfileToUser(db, userId, profileId, { verifiedEmail = null } = {}) {
  if (!profileId) {
    return null
  }
  const profile = await db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId)
  if (!profile) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }
  // Re-selecting a profile THIS user already owns is always allowed.
  if (profile.user_id && String(profile.user_id) === String(userId)) {
    return profileId
  }
  // Owned by someone else — never adoptable via a login credential.
  if (profile.user_id) {
    const error = new Error('Profile already linked to another user')
    error.status = 403
    throw error
  }
  // Unowned profile: ADOPTION must be bound to the PRESENTED credential. A
  // verified OTP proves control of an email/phone — NOT ownership of an
  // arbitrary unowned profile id — so an OTP holder who knows an unrelated,
  // unowned profile id must not be able to claim it (tenant takeover). Only
  // adopt when the profile's email matches the just-verified email. The phone
  // path passes no verifiedEmail (no equivalent verified phone→profile binding
  // exists), so it can only re-select an already-owned profile (handled above)
  // and can never adopt an unowned one.
  const normalizedVerifiedEmail = verifiedEmail ? normalizeEmail(verifiedEmail) : null
  const bound = normalizedVerifiedEmail
    ? await profileIsBoundToEmail(db, profileId, normalizedVerifiedEmail)
    : false
  if (!bound) {
    const error = new Error('Profile is not associated with the verified credential')
    error.status = 403
    throw error
  }
  await db
    .prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(userId, profileId)
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

function isUniqueViolation(err) {
  if (!err) return false
  const code = String(err.code || '')
  return code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE' || /unique constraint/i.test(String(err.message || ''))
}

/**
 * Mint a fresh OTP code AND invalidate every prior active code for this
 * credential in ONE transaction, so a credential has at most ONE consumable
 * active code at a time — SERIALIZED per credential so concurrent /start cannot
 * leave multiple active rows.
 *
 * Without the single-active-code invariant, /start APPENDED rows and left older
 * active rows unconsumed: a locked-out older code stayed verifiable after a fresh
 * start (lockout bypass; alternating /start + guess → unlimited attempts).
 *
 * Concurrency: one caller's invalidate+insert is atomic, but two callers for the
 * SAME credential could (on Postgres READ COMMITTED) both invalidate before
 * either insert was visible and leave TWO active rows. So:
 *   - Postgres locks the parent credential row (SELECT ... FOR UPDATE) FIRST, so
 *     a second concurrent /start waits, sees the first's inserted row, and
 *     invalidates it. SQLite's BEGIN IMMEDIATE already serializes writers.
 *   - The resend cooldown is RE-CHECKED under the lock (two racing /start can't
 *     both pass), and the credential metadata (secret_hash / last_sent_at /
 *     attempt reset) is updated in the SAME transaction so it can't interleave.
 *   - A partial unique index (credential_id WHERE consumed_at IS NULL) is the DB
 *     backstop: a second active row is rejected (23505) even if a future caller
 *     skips the lock — treated here as "another start won" (invariant still holds).
 *
 * Returns { minted: true } on success, or { minted: false, retryAfterSeconds }
 * when the cooldown (re-checked under the lock) or the backstop rejects the mint.
 */
async function insertFreshVerificationCode(db, credentialId, codeHash, expiresAtIso, { cooldownSeconds = 0 } = {}) {
  return db.withTransaction(async (tx) => {
    const now = nowISOString()

    // Serialize concurrent /start for THIS credential.
    if (tx.dialect === 'postgres') {
      await tx.prepare(`SELECT id FROM user_credentials WHERE id = ? FOR UPDATE`).get(credentialId)
    }

    // Re-check the resend cooldown UNDER the lock (raceless).
    if (cooldownSeconds > 0) {
      const cred = await tx.prepare(`SELECT last_sent_at FROM user_credentials WHERE id = ?`).get(credentialId)
      if (cred?.last_sent_at) {
        const elapsedMs = Date.now() - new Date(cred.last_sent_at).getTime()
        if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < cooldownSeconds * 1000) {
          return { minted: false, retryAfterSeconds: Math.ceil((cooldownSeconds * 1000 - elapsedMs) / 1000) }
        }
      }
    }

    await tx
      .prepare(`UPDATE user_verification_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE credential_id = ? AND consumed_at IS NULL`)
      .run(now, credentialId)
    let inserted
    try {
      inserted = await tx
        .prepare(`INSERT INTO user_verification_codes (credential_id, code_hash, expires_at) VALUES (?, ?, ?) RETURNING id`)
        .get(credentialId, codeHash, expiresAtIso)
    } catch (err) {
      // DB backstop tripped: another active code exists (a caller that skipped the
      // lock won the race). The one-active-code invariant still holds.
      if (isUniqueViolation(err)) {
        return { minted: false, retryAfterSeconds: Math.max(1, cooldownSeconds || 1) }
      }
      throw err
    }

    // Credential metadata in the SAME serialized transaction.
    await tx
      .prepare(`UPDATE user_credentials SET secret_hash = ?, last_sent_at = ?, attempt_count = 0 WHERE id = ?`)
      .run(codeHash, now, credentialId)

    // Return the EXACT minted code id + mint timestamp so a later send-failure can
    // compensate ONLY this mint (never a newer good code — see compensateFailedOtpSend).
    return { minted: true, codeId: inserted?.id ?? null, sentAt: now }
  })
}

/**
 * Compensate a mint whose delivery (email/SMS) FAILED after the code was minted.
 * The winner of the serialized mint sends AFTER minting; if the send then fails,
 * we must not leave (a) a verifiable code the user never received, or (b) a
 * cooldown that blocks a retry for a code that never arrived.
 *
 * SCOPED to the EXACT failing mint (`codeId` + `sentAt` from insertFreshVerificationCode):
 * a slow send that fails AFTER a retry already minted+sent a NEWER code must NOT
 * destroy that newer good code or erase its cooldown. So we only invalidate THIS
 * code row if it is STILL active, and only rewind last_sent_at if it STILL equals
 * this mint's timestamp (a newer mint moved it → leave it). Idempotent + safe to
 * call once even if the mint was already superseded.
 */
async function compensateFailedOtpSend(db, credentialId, { codeId = null, sentAt = null } = {}) {
  return db.withTransaction(async (tx) => {
    if (codeId) {
      await tx
        .prepare(`UPDATE user_verification_codes SET consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND consumed_at IS NULL`)
        .run(nowISOString(), codeId)
    }
    if (sentAt) {
      await tx
        .prepare(`UPDATE user_credentials SET last_sent_at = NULL WHERE id = ? AND last_sent_at = ?`)
        .run(credentialId, sentAt)
    }
  })
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

async function createSessionAndTokens(db, { user, profileId, userAgent, ipAddress, method = 'session', identifier = null }) {
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

  // Durable login audit at the SINGLE session-mint choke point. Every fresh
  // login mints exactly one user_sessions row here (token REFRESH rotates in
  // place via rotateSessionTokens and is NOT counted), so recording here keeps
  // the admin login tracker's durable source (audit_logs client_sign_in) in
  // lock-step with reality. This replaces the per-handler recording that was
  // scattered, admin-gated inconsistently, and missing entirely from the
  // password-login path — which is why client_sign_in audits had drifted far
  // behind user_sessions. Awaited but guarded: a logging failure never blocks
  // a login (recordClientSignInEvent swallows its own DB errors).
  try {
    await recordClientSignInEvent({
      db,
      identifier: identifier ?? user?.primary_email ?? null,
      method,
      userId: user?.id ?? null,
      profileId: profileId ?? null,
      ip: ipAddress ?? null,
      userAgent,
      sessionId,
    })
  } catch (auditErr) {
    console.warn('[auth] sign-in audit record failed:', auditErr?.message || auditErr)
  }

  // First-login owner notification + last_login_at stamp, at the same single
  // choke point as the sign-in audit (covers every method; refresh excluded).
  // Fire-and-forget: must never affect login latency or outcome.
  void recordSuccessfulLogin({
    db,
    user,
    method,
    identifier: identifier ?? user?.primary_email ?? null,
  })

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    accessExpires,
    refreshExpires,
    sessionId,
  }
}

async function rotateSessionTokens(db, {
  sessionId,
  user,
  profileId,
  expectedRefreshHash,
  // Login-tracker context (all optional; only the /refresh route passes them):
  priorAccessExpiresAt = null,
  ipAddress = null,
  userAgent = null,
  identifier = null,
}) {
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshHash = hashValue(refreshToken)
  const accessToken = signAccessToken(user, sessionId, profileId)
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString()
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()
  const rotatedAt = nowISOString()

  const rotate = async (tx) => {
    const result = await tx.prepare(
      `
        UPDATE user_sessions
        SET refresh_token_hash = ?,
            access_expires_at = ?,
            refresh_expires_at = ?,
            profile_id = COALESCE(?, profile_id),
            revoked_at = NULL
        WHERE id = ?
          AND refresh_token_hash = ?
          AND revoked_at IS NULL
      `,
    ).run(
      refreshHash,
      accessExpires,
      refreshExpires,
      profileId ?? null,
      sessionId,
      expectedRefreshHash,
    )

    if (Number(result?.changes ?? result?.rowCount ?? 0) !== 1) {
      const error = new Error('Refresh token was already rotated')
      error.code = 'AUTH_REFRESH_ROTATION_CONFLICT'
      throw error
    }

    await tx.prepare(
      `
        INSERT INTO auth_refresh_token_history (
          token_hash, session_id, replaced_at, expires_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING
      `,
    ).run(expectedRefreshHash, sessionId, rotatedAt, refreshExpires)
  }

  if (typeof db.withTransaction === 'function') {
    await db.withTransaction(rotate)
  } else {
    await rotate(db)
  }

  // -------------------------------------------------------------------------
  // SESSION-RESUME login tracking (the admin "Logins" panel was stale).
  //
  // The frontend persists the refresh session in an HttpOnly cookie and this
  // rotation slides the 30-day refresh window forward every time, so a RETURNING user
  // can use the app for months without ever hitting a session-mint path —
  // meaning createSessionAndTokens (the choke point that stamps
  // users.last_login_at and appends the durable client_sign_in audit the
  // admin panel reads) never ran again for them. The panel therefore showed
  // their initial sign-in forever: "logins aren't up to date".
  //
  // Semantics (the panel tab is "Logins", events are 'client_sign_in'):
  //   - An IN-SESSION rotation (the app proactively refreshing BEFORE the
  //     access token expires, while the user is actively using it) is NOT a
  //     login and records nothing — token refreshes are not counted.
  //   - A RESUME (the refresh arrives AFTER the session's access token had
  //     already lapsed: the user was away and came back, e.g. reopening the
  //     app tomorrow on a remembered session) IS a returning sign-in: stamp
  //     last_login_at and append a client_sign_in event (method
  //     'session_resume') so the admin panel reflects it.
  //
  // The discriminator is the session's own pre-rotation access_expires_at,
  // passed by the /refresh route — no client cooperation needed.
  // -------------------------------------------------------------------------
  const priorExpiryMs = priorAccessExpiresAt ? Date.parse(priorAccessExpiresAt) : NaN
  const resumedAfterExpiry = Number.isFinite(priorExpiryMs) && priorExpiryMs < Date.now()
  if (resumedAfterExpiry && user?.id) {
    try {
      await recordClientSignInEvent({
        db,
        identifier: identifier ?? user?.primary_email ?? null,
        method: 'session_resume',
        userId: user.id,
        profileId: profileId ?? null,
        ip: ipAddress ?? null,
        userAgent,
        sessionId,
      })
    } catch (auditErr) {
      console.warn('[auth] session-resume audit record failed:', auditErr?.message || auditErr)
    }
    // Fire-and-forget last_login_at stamp (same helper as the mint choke
    // point; its atomic NULL→set first-login email can only fire for a user
    // who somehow never had a recorded login — harmless and honest).
    void recordSuccessfulLogin({
      db,
      user,
      method: 'session_resume',
      identifier: identifier ?? user?.primary_email ?? null,
    })
  }

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    accessExpires,
    refreshExpires,
  }
}

router.post('/email/start', emailStartLimiter, async (req, res) => {
  if (isOtpLoginRetired()) return otpLoginRetired(res)
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
      // CodeQL js/log-injection (#567): logs the RAW value on the branch
      // where it just failed isValidEmail — by definition unsanitized.
      console.warn('[auth/email/start] Invalid email format:', sanitizeLogValue(emailRaw))
      return res.status(400).json({ 
        error: 'Invalid email address',
        error_type: 'validation_error'
      })
    }

    routeLogger.info('[auth/email/start] Processing email authentication request for:', email)

    // Use centralized production detection helper
    const isProd = isProductionEnvironment()

    // In production, enforce profile-email gating: allow only admin emails OR emails that match an existing profile.
    const normalizedEmail = normalizeEmail(email)

    // Owner blocklist: a blocked email cannot begin authentication. Any existing
    // account is marked `banned`. (No-op when the blocklist has no matching rule.)
    const blockStart = await enforceOwnerBlocklist(
      req.db,
      { email: normalizedEmail },
      { context: 'auth_email_start', banAccount: true },
    )
    if (blockStart.blocked) {
      console.warn('[auth/email/start] Blocked by owner blocklist:', normalizedEmail)
      return res.status(403).json({ error_type: 'blocked', error: 'This account has been blocked.' })
    }

    const isAdmin = isAdminEmail(normalizedEmail)
    const profileMatch = await findProfileRowForEmail(req.db, normalizedEmail)
    if (isProd && !isAdmin && !profileMatch) {
      console.warn('[auth/email/start] Unauthorized email in production (no matching profile):', email)
      return res.status(403).json({
        error_type: 'unauthorized_email',
        error: 'Access denied. This email is not authorized for login.',
        redirect_to: '/ServiceApplication',
      })
    }
    if (isProd) {
      routeLogger.info('[auth/email/start] Email authorized in production for:', email, 'profile_id:', profileMatch?.id ?? null)
    }

    // Database operations with error handling
    let user, credential
    try {
      const result = await ensureEmailCredential(req.db, email)
      user = result.user
      credential = result.credential
      routeLogger.info('[auth/email/start] User credential ensured for:', email, 'user_id:', user?.id)
    } catch (dbError) {
      routeLogger.error('[auth/email/start] Database error ensuring credential:', dbError)
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
    // The token carries NO verifier (see signOtpToken) — the code hash lives ONLY
    // in the server-side DB row below and is delivered to the user via email.
    const verificationToken = signOtpToken({
      kind: 'email',
      identifier: email,
      ttlSeconds: EMAIL_CODE_TTL,
    })
    
    let mintScope = null
    try {
      // Serialized single-active-code mint: invalidate prior active codes + insert
      // the fresh one + reset credential metadata in ONE per-credential-locked
      // transaction (cooldown re-checked under the lock). No locked-out older row
      // survives, and concurrent /start can't leave two active codes.
      const mint = await insertFreshVerificationCode(req.db, credential.id, codeHash, expiresAt, {
        cooldownSeconds: EMAIL_RESEND_COOLDOWN,
      })
      if (!mint.minted) {
        return res.status(429).json({
          error: `Please wait ${mint.retryAfterSeconds} seconds before requesting another code`,
          error_type: 'rate_limit_cooldown',
          retry_after_seconds: mint.retryAfterSeconds,
        })
      }
      // Scope any later compensation to EXACTLY this mint (never a newer good code).
      mintScope = { codeId: mint.codeId, sentAt: mint.sentAt }
      routeLogger.info('[auth/email/start] Verification code stored in database for:', email)
    } catch (dbError) {
      routeLogger.error('[auth/email/start] Database error storing verification code:', dbError)
      return res.status(500).json({ 
        error: 'Failed to create verification code. Please try again.',
        error_type: 'database_error',
        details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
      })
    }

    // The serialized mint already ran ABOVE, so only the WINNER reaches this send
    // (a racing /start 429s at the mint). Distinguish outcomes:
    //   'sent'    → delivered; keep the code.
    //   'failed'  → DEFINITIVE failure (only when CONFIGURED); COMPENSATE this mint
    //               + 502 — no verifiable code the user never received, retry not
    //               cooldown-blocked. Symmetric with phone.
    //   'timeout' → tolerant (202 + notice, keep the code) BUT, for a CONFIGURED
    //               provider, attach a LATE handler so a failure that resolves AFTER
    //               the route timeout still compensates this exact mint (else an
    //               active, verifiable, undelivered code + preserved cooldown would
    //               leak — the very failure mode r22 removed).
    routeLogger.info('[auth/email/start] Attempting to send verification email to:', email)
    // A DEFINITIVE failure only counts when the email service is actually
    // configured. Unconfigured/dev returns false — the deliberate "code stored,
    // delivery may be delayed" path, NOT a failure (compensating there would break
    // local/dev + queued providers).
    const emailConfigured = isEmailServiceConfigured()
    let emailSent = false
    let sendFailed = false
    try {
      const timeoutMs = Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000)
      // The underlying send promise (already catches its own rejection → 'failed').
      const sendPromise = Promise.resolve()
        .then(() => sendVerificationEmail(email, code))
        .then((ok) => (ok === true ? 'sent' : 'failed'), () => 'failed')
      const outcome = await Promise.race([
        sendPromise,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
      ])
      if (outcome === 'sent') {
        emailSent = true
        routeLogger.info('[auth/email/start] Verification email sent successfully to:', email)
      } else if (outcome === 'failed' && emailConfigured) {
        sendFailed = true
        console.warn('[auth/email/start] Configured email service failed for:', email)
      } else {
        // Unconfigured, or a timeout that may still be queued — tolerant; keep the code.
        console.warn('[auth/email/start] Email not sent (unconfigured or queued) for:', email)
        // Configured + timed out: watch the underlying send; if it LATER fails,
        // compensate THIS mint (scoped, so a retry's newer code is never touched).
        if (outcome === 'timeout' && emailConfigured && mintScope) {
          const scope = mintScope
          sendPromise.then((late) => {
            if (late !== 'sent') {
              compensateFailedOtpSend(req.db, credential.id, scope)
                .catch(e => console.warn('[auth/email/start] late compensation failed:', e?.message || e))
            }
          }, () => {
            compensateFailedOtpSend(req.db, credential.id, scope)
              .catch(e => console.warn('[auth/email/start] late compensation failed:', e?.message || e))
          })
        }
      }
    } catch (emailError) {
      console.error('[auth/email/start] Unexpected error sending email:', emailError)
      if (emailConfigured) sendFailed = true
    }

    if (sendFailed) {
      await compensateFailedOtpSend(req.db, credential.id, mintScope || {}).catch(e => console.warn('[auth/email/start] compensation failed:', e?.message || e))
      sendAuthAttemptNotification({ event: 'email_start', identifier: email, success: false, error: 'email_send_failed' }).catch(e => console.warn('[background]', e?.message || e))
      return res.status(502).json({
        error: 'Could not send the verification email right now. Please try again.',
        error_type: 'email_send_failed',
      })
    }

    // Return success response
    const responseData = {
      ok: true,
      message: emailSent 
        ? 'Verification code sent to your email' 
        : 'Verification code generated. Email delivery may be delayed.',
      email_sent: emailSent,
      verification_token: verificationToken,
      user_hint: {
        id: user.id,
        display_name: user.display_name,
        primary_email: user.primary_email,
      },
    }

    // Never return OTP codes in production.
    if (!isProd) {
      responseData.previewCode = code
    }

    // Also do not hard-fail if email delivery is slow/unavailable: providers can be async/queued,
    // and delivery may succeed shortly after the request completes.
    if (emailSent !== true) {
      responseData.notice =
        'We generated your login code, but email delivery may be delayed. Check spam/junk and try again in a minute.'
    }

    // Optional ops alert (never includes the code).
    sendAuthAttemptNotification({
      event: 'email_start',
      identifier: email,
      success: Boolean(emailSent),
      error: emailSent ? null : 'email_delivery_failed_or_unconfigured',
    }).catch(e => console.warn('[background]', e?.message || e))

    routeLogger.info('[auth/email/start] Request completed successfully for:', email, 'email_sent:', emailSent, 'isProd:', isProd)
    return res.status(202).json(responseData)
    
  } catch (error) {
    // Catch-all for any unexpected errors
    routeLogger.error('[auth/email/start] Unexpected error:', error)
    sendAuthAttemptNotification({
      event: 'email_start',
      identifier: typeof req.body?.email === 'string' ? req.body.email : 'unknown',
      success: false,
      error: error?.message || String(error),
    }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(500).json({ 
      error: 'An unexpected error occurred. Please try again.',
      error_type: 'internal_error',
      details: undefined // Never expose internal error details
    })
  }
})

router.post('/email/verify', emailVerifyLimiter, async (req, res) => {
  if (isOtpLoginRetired()) return otpLoginRetired(res)
  const emailRaw = req.body?.email
  const codeRaw = req.body?.code
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

  // Owner blocklist: a blocked email can never complete verification.
  const blockVerify = await enforceOwnerBlocklist(
    req.db,
    { email },
    { context: 'auth_email_verify', banAccount: true },
  )
  if (blockVerify.blocked) {
    console.warn('[auth/email/verify] Blocked by owner blocklist:', email)
    return res.status(403).json({ error_type: 'blocked', error: 'This account has been blocked.' })
  }

  // Always compute the incoming hash.
  const incomingHash = hashValue(`${email}:${code}`)

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

  // AUTHORITATIVE server-side verification: the OTP is proven ONLY by the
  // server-stored, one-time, expiring DB code row — never by any client-supplied
  // token (the token carries no verifier; see signOtpToken). This is what makes
  // /email/verify genuinely prove inbox possession (and thus makes the r17
  // credential-bound profile adoption sound).
  //
  // Done ATOMICALLY (row-locked transaction): the attempt cap and one-time
  // consumption cannot be raced — parallel wrong guesses can't slip past the cap,
  // and two parallel correct submissions of the one-time code mint exactly one
  // session (never two). See atomicVerifyOtpCode.
  let outcome
  try {
    outcome = await atomicVerifyOtpCode(req.db, credential.id, incomingHash, EMAIL_MAX_VERIFY_ATTEMPTS)
  } catch (dbError) {
    routeLogger.error('[auth/email/verify] Atomic verification failed:', dbError)
    return res.status(500).json({ error: 'Database error occurred. Please try again.' })
  }

  if (outcome === 'locked_out') {
    sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'too_many_attempts' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(429).json({ error: 'Too many attempts. Request a new code.', error_type: 'too_many_attempts' })
  }
  if (outcome === 'already_consumed') {
    sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'code_consumed' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(400).json({ error: 'Verification code already used. Request a new code.' })
  }
  if (outcome !== 'ok') {
    sendAuthAttemptNotification({ event: 'email_verify', identifier: email, success: false, error: 'invalid_code' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(400).json({ error: 'Invalid verification code' })
  }

  // Reload user if needed.
  if (!user) {
    user = await getUserById(req.db, credential.user_id)
  }
  if (!user) return res.status(500).json({ error: 'User record missing for credential' })

  let activeProfileId = null
  try {
    if (requestedProfileId) {
      // Bind adoption to the just-verified EMAIL credential (tenant-takeover guard).
      activeProfileId = await attachProfileToUser(req.db, user.id, requestedProfileId, {
        verifiedEmail: email,
      })
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

  if (!activeProfileId && profiles.length > 0 && !user.is_admin) {
    activeProfileId = profiles[0].id
  }

  const session = await createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
    method: 'email',
    identifier: email,
  })

  // Initialize Anya for every user on login (crawlers scoped to their profile)
  let anyaInfo = null
  try {
    anyaInfo = await initializeAnyaOnLogin(req.db, user, activeProfileId, { uploadDir, getOpenAI })
  } catch (error) {
    console.error('[auth] Failed to initialize Anya:', error)
  }

  if (user.is_admin || user.role === 'admin') {
    scheduleAdminGeoCrawlOnLogin(req.db, user, {
      uploadDir,
      getOpenAI,
      userId: user.id,
    }).catch((err) => console.error('[auth/email] admin geo crawl scheduler:', err))
  }

  // Auto-trigger discovery crawlers on email login (fire and forget)
  if (activeProfileId) {
    runProfileDiscoveryLive({ db: req.db, profileId: activeProfileId }).catch(err => {
      console.error('[auth/email] Failed to queue auto-discovery crawlers:', err)
    })
  }

  const response = {
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    accessExpires: session.accessExpires,
    refreshExpires: session.refreshExpires,
    tokenType: 'Bearer',
    user: await buildUserPayload(req.db, user, profiles, activeProfileId),
  }

  if (anyaInfo) {
    response.anya = {
      session_id: anyaInfo.sessionId,
      jobs_created: Object.keys(anyaInfo.jobIds).length,
      profile_id: anyaInfo.profileId,
    }
  }

  // Trigger Anya's autonomous scheduler for admin login if configured
  if ((user.is_admin || user.role === 'admin') && process.env.ANYA_RUN_ON_ADMIN_LOGIN === 'true') {
    import('../services/anyaAutonomousScheduler.js')
      .then(({ runOnAdminLogin }) => {
        runOnAdminLogin(req.db, user.id).catch(err => {
          console.error('[Anya] Failed to run admin login operations:', err)
        })
      })
      .catch((err) => {
        console.error('[Anya] Failed to import autonomous scheduler:', err?.message || err);
      })
  }

  // CodeGuard audit on admin login — self-throttles to once per 6 hours
  if (user.is_admin || user.role === 'admin') {
    import('../services/anyaStartupAudit.js')
      .then(({ triggerStartupAudit }) => {
        triggerStartupAudit(req.db).catch((err) => {
          console.error('[Anya] Failed to trigger startup audit:', err?.message || err)
        })
      })
      .catch((err) => {
        console.error('[Anya] Failed to import startup audit:', err?.message || err)
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
  }).catch(e => console.warn('[background]', e?.message || e))

  // Sign-in is recorded durably at the session-mint choke point
  // (createSessionAndTokens), so the admin login tracker can never drift.

  setRefreshCookie(req, res, session.refreshToken)
  return res.json(response)
})

router.post('/phone/start', phoneStartLimiter, async (req, res) => {
  if (isOtpLoginRetired()) return otpLoginRetired(res)
  const phoneRaw = req.body?.phone
  if (typeof phoneRaw !== 'string') {
    return res.status(400).json({ error: 'phone is required' })
  }
  const normalized = normalizePhone(phoneRaw)
  if (!normalized) {
    return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +1234567890)' })
  }

  let user, credential
  try {
    const result = await ensurePhoneCredential(req.db, normalized)
    user = result.user
    credential = result.credential
  } catch (dbError) {
    routeLogger.error('[auth/phone/start] Database error ensuring credential:', dbError)
    return res.status(500).json({ error: 'Database error occurred. Please try again.', error_type: 'database_error' })
  }
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

  // MINT FIRST (serialized), THEN send — so only the serialized WINNER sends. Two
  // concurrent /phone/start no longer both send an SMS (the loser 429s here,
  // before any send), which previously delivered the loser an UNSTORED code that
  // could never verify and cost a duplicate Twilio message.
  const mint = await insertFreshVerificationCode(req.db, credential.id, codeHash, expiresAt, {
    cooldownSeconds: PHONE_RESEND_COOLDOWN,
  })
  if (!mint.minted) {
    return res.status(429).json({
      error: 'Verification already sent',
      retry_after_seconds: mint.retryAfterSeconds,
    })
  }

  // Winner sends. Twilio can RESOLVE with a failed/undelivered message without
  // throwing. On a definitive failure (not the dev/no-provider "skipped" path),
  // COMPENSATE: invalidate the minted code + rewind last_sent_at, so there is no
  // verifiable code the user never received and a retry isn't cooldown-blocked.
  const smsResult = await sendPhoneVerificationCode(normalized, code)
  if (smsResult && smsResult.ok === false && smsResult.skipped !== true) {
    await compensateFailedOtpSend(req.db, credential.id, { codeId: mint.codeId, sentAt: mint.sentAt }).catch(e => console.warn('[auth/phone/start] compensation failed:', e?.message || e))
    return res.status(502).json({
      error: 'Could not send the verification code right now. Please try again.',
      error_type: 'sms_send_failed',
    })
  }

  // Optional ops alert (never includes the code).
  sendAuthAttemptNotification({
    event: 'phone_start',
    identifier: normalized,
    success: true,
  }).catch(e => console.warn('[background]', e?.message || e))

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
  if (isOtpLoginRetired()) return otpLoginRetired(res)
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

  // Same ATOMIC, race-free verification as the email path (row-locked tx): the
  // one-time phone code cannot mint two sessions under a concurrent double-submit,
  // and the attempt cap is exact under parallel wrong guesses.
  let outcome
  try {
    outcome = await atomicVerifyOtpCode(req.db, credential.id, incomingHash, PHONE_MAX_VERIFY_ATTEMPTS)
  } catch (dbError) {
    routeLogger.error('[auth/phone/verify] Atomic verification failed:', dbError)
    return res.status(500).json({ error: 'Database error occurred. Please try again.' })
  }

  if (outcome === 'locked_out') {
    sendAuthAttemptNotification({ event: 'phone_verify', identifier: normalized, success: false, error: 'too_many_attempts' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(429).json({ error: 'Too many attempts. Request a new code.', error_type: 'too_many_attempts' })
  }
  if (outcome === 'already_consumed') {
    sendAuthAttemptNotification({ event: 'phone_verify', identifier: normalized, success: false, error: 'code_consumed' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(400).json({ error: 'Verification code already used. Request a new code.' })
  }
  if (outcome !== 'ok') {
    sendAuthAttemptNotification({ event: 'phone_verify', identifier: normalized, success: false, error: 'invalid_code' }).catch(e => console.warn('[background]', e?.message || e))
    return res.status(400).json({ error: 'Invalid verification code' })
  }

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
      // No verifiedEmail: a verified phone code has no email→profile binding, so
      // attachProfileToUser can only RE-SELECT a profile this user already owns
      // and can never adopt an unowned one (tenant-takeover guard).
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

  if (!activeProfileId && profiles.length > 0 && !user.is_admin) {
    activeProfileId = profiles[0].id
  }

  const session = await createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
    method: 'phone',
    identifier: normalized,
  })

  // Initialize Anya for every user on login (crawlers scoped to their profile)
  let anyaInfo = null
  try {
    anyaInfo = await initializeAnyaOnLogin(req.db, user, activeProfileId, { uploadDir, getOpenAI })
  } catch (error) {
    console.error('[auth] Failed to initialize Anya:', error)
  }

  if (user.is_admin || user.role === 'admin') {
    scheduleAdminGeoCrawlOnLogin(req.db, user, {
      uploadDir,
      getOpenAI,
      userId: user.id,
    }).catch((err) => console.error('[auth/phone] admin geo crawl scheduler:', err))
  }

  // Auto-trigger discovery crawlers on phone login (fire and forget)
  if (activeProfileId) {
    runProfileDiscoveryLive({ db: req.db, profileId: activeProfileId }).catch(err => {
      console.error('[auth/phone] Failed to queue auto-discovery crawlers:', err)
    })
  }

  const response = {
    accessToken: session.accessToken,
    expiresIn: session.expiresIn,
    accessExpires: session.accessExpires,
    refreshExpires: session.refreshExpires,
    tokenType: 'Bearer',
    user: await buildUserPayload(req.db, user, profiles, activeProfileId),
  }

  // Include Anya session info if available
  if (anyaInfo) {
    response.anya = {
      session_id: anyaInfo.sessionId,
      jobs_created: Object.keys(anyaInfo.jobIds).length,
      profile_id: anyaInfo.profileId,
    }
  }

  // CodeGuard audit on admin phone login — self-throttles to once per 6 hours
  if (user.is_admin || user.role === 'admin') {
    import('../services/anyaStartupAudit.js')
      .then(({ triggerStartupAudit }) => {
        triggerStartupAudit(req.db)
      })
      .catch(() => { /* non-critical */ })
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
  }).catch(e => console.warn('[background]', e?.message || e))

  // Sign-in recorded durably at the session-mint choke point (createSessionAndTokens).

  setRefreshCookie(req, res, session.refreshToken)
  return res.json(response)
})

function buildPasswordSetupLink(req, token) {
  const baseUrl = inferFrontendBaseUrl(req)
  const basePath = normalizeBasePath(FRONTEND_APP_BASE)
  const url = new URL(baseUrl)
  url.pathname = `${basePath}/set-password`.replace(/\/{2,}/g, '/')
  url.searchParams.set('token', token)
  return url.toString()
}

/**
 * Single source of truth for the "secure link" sign-in flow: mint a
 * password-setup token for `user` and email `email` the /set-password link.
 * Used by BOTH POST /password/setup/start and the conversational onboarding
 * funnel (routes/onboarding.js), so login and signup can never drift apart.
 *
 * Never throws for email-delivery problems — returns { emailSent, emailSendError }
 * so callers can decide how loudly to complain. DB failures (after one
 * schema-ensure retry) DO throw: without a persisted token the link is dead.
 */
async function beginPasswordSetup(db, { user, email, req = null }) {
  const token = base64UrlToken(32)
  const tokenHash = hashValue(token)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_TTL * 1000).toISOString()
  const id = crypto.randomUUID()
  const insertToken = () =>
    db
      .prepare(
        `
          INSERT INTO password_setup_tokens (
            id, user_id, token_hash, expires_at, consumed_at, request_ip, user_agent
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        `,
      )
      .run(id, user.id, tokenHash, expiresAt, req?.ip ?? null, req?.headers?.['user-agent'] ?? null)

  try {
    await insertToken()
  } catch (dbError) {
    // Retry once after best-effort schema ensure (covers deploys where migrations lag).
    console.warn('[auth/password-setup] Initial DB error, retrying after schema ensure:', dbError?.message || dbError)
    await ensurePasswordAuthSchema(db)
    await insertToken()
  }

  routeLogger.info('[auth/password-setup] Token created:', {
    user_id: user.id,
    email,
    token_id: id,
    expires_at: expiresAt,
    ip: req?.ip ?? null,
  })

  const link = buildPasswordSetupLink(req, token)

  let emailSent = false
  /** @type {null | { name?: string, status?: any, provider?: any, message?: string }} */
  let emailSendError = null
  try {
    const sendPromise = sendPasswordSetupEmail(email, link)
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(false), Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000))
    })
    emailSent = (await Promise.race([sendPromise, timeoutPromise])) === true
  } catch (err) {
    emailSendError = {
      name: err?.name,
      status: err?.status,
      provider: err?.provider,
      message: err?.message || String(err),
    }
    emailSent = false
  }

  return { tokenId: id, token, link, emailSent, emailSendError }
}

/**
 * POST /api/auth/access/check
 * Check if an email is allowed to login (admin or has matching profile)
 * and whether they already have a password set up.
 */
router.post('/access/check', async (req, res) => {
  try {
    const emailRaw = req.body?.email
    if (typeof emailRaw !== 'string') {
      return res.status(400).json({ error: 'email is required', error_type: 'validation_error' })
    }

    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', error_type: 'validation_error' })
    }

    // Use centralized production detection helper
    const isProd = isProductionEnvironment()

    // Determine if user is admin
    const isAdmin = isAdminEmail(email)
    
    // Check for profile match
    const profileMatch = await findProfileRowForEmail(req.db, email)

    // Enforce profile-email gating: allow only admin emails OR emails that match an existing profile
    // In production, this is strict. In development, we still check but return 403 to maintain consistency.
    if (!isAdmin && !profileMatch) {
      return res.status(403).json({
        allowed: false,
        reason: 'no_profile_match',
        redirect_to: '/ServiceApplication',
      })
    }

    // Determine the reason for access - be explicit about why access was granted
    let reason
    if (isAdmin) {
      reason = 'admin'
    } else if (profileMatch) {
      reason = 'profile_match'
    } else {
      // This should not be reachable due to the check above, but defensive coding
      reason = 'unknown'
    }

    // Check if password is already set
    let hasPassword = false
    try {
      const user = await req.db
        .prepare('SELECT id, password_hash FROM users WHERE LOWER(primary_email) = ? LIMIT 1')
        .get(email)
      
      if (user && typeof user.password_hash === 'string' && user.password_hash.trim()) {
        hasPassword = true
      }
    } catch (error) {
      // If user doesn't exist yet, hasPassword remains false
      console.warn('[auth/access/check] Error checking password status:', error?.message || error)
    }

    return res.status(200).json({
      allowed: true,
      reason,
      hasPassword,
    })
  } catch (error) {
    routeLogger.error('[auth/access/check] Unexpected error:', error)
    return res.status(500).json({ error: 'An unexpected error occurred', error_type: 'internal_error' })
  }
})

router.post('/password/setup/start', passwordRateLimiter, async (req, res) => {
  try {
    await ensurePasswordAuthSchema(req.db)

    const emailRaw = req.body?.email
    if (typeof emailRaw !== 'string') {
      return res.status(400).json({ error: 'email is required', error_type: 'validation_error' })
    }

    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', error_type: 'validation_error' })
    }

    const isProd = isProductionEnvironment()

    const isAdmin = isAdminEmail(email)
    const profileMatch = await findProfileRowForEmail(req.db, email)

    if (isProd && !isAdmin && !profileMatch) {
      return res.status(403).json({
        ok: false,
        redirect_to: '/ServiceApplication',
      })
    }

    const user = await ensureUserForPasswordAuth(req.db, email)
    if (!user) {
      return res.status(503).json({ error: 'Unable to start password setup', error_type: 'service_unavailable' })
    }

    if (typeof user.password_hash === 'string' && user.password_hash.trim()) {
      return res.status(200).json({ ok: true, status: 'password_exists' })
    }

    // In production, email MUST be configured. Fail loudly if not.
    if (isProd && !isEmailServiceConfigured()) {
      const missingVars = []
      if (!process.env.RESEND_API_KEY) missingVars.push('RESEND_API_KEY')
      if (!process.env.FROM_EMAIL && !process.env.EMAIL_FROM) missingVars.push('FROM_EMAIL or EMAIL_FROM')
      
      console.error('[auth/password/setup/start] Email service not configured in production:', {
        missing: missingVars,
        email: email,
        user_id: user.id,
        has_resend_key: Boolean(process.env.RESEND_API_KEY),
        has_from_email: Boolean(process.env.FROM_EMAIL || process.env.EMAIL_FROM),
        node_env: process.env.NODE_ENV,
        railway_env: process.env.RAILWAY_ENVIRONMENT,
      })
      
      return res.status(503).json({
        error_type: 'email_not_configured',
        error: 'Email service is not configured. Please contact support.',
      })
    }

    let setup
    try {
      setup = await beginPasswordSetup(req.db, { user, email, req })
    } catch (dbError) {
      // Structured logging (failure) - DO NOT log the token itself
      console.error('[auth/password/setup/start] DB error creating token (after retry):', {
        error: dbError?.message || dbError,
        user_id: user.id,
        email: email,
        ip: req.ip,
      })
      return res.status(503).json({
        error_type: 'service_unavailable',
        error: 'Login is temporarily unavailable. Please try again in a minute.',
      })
    }

    const { token, link, emailSent, emailSendError } = setup

    const response = { ok: true, status: 'password_setup_email_sent', email_sent: emailSent }
    if (emailSent !== true) {
      response.notice = 'We created your password setup link, but email delivery may be delayed. Please try again in a minute.'
      if (isProd) {
        // Production diagnostics: distinguish delivery failures from misconfiguration.
        response.error_type = 'email_delivery_failed'
        console.error('[auth/password/setup/start] Email send failed in production:', {
          email: email,
          user_id: user.id,
          token_id: setup.tokenId,
          error_name: emailSendError?.name,
          error_provider: emailSendError?.provider ?? null,
          error_status: emailSendError?.status ?? null,
          error_message: emailSendError?.message ?? null,
        })
      }
      // Dev-only convenience: if email isn't configured, return a preview token/link so local users can proceed.
      if (!isProd) {
        response.preview_token = token
        response.preview_url = link
      }
    }

    return res.status(202).json(response)
  } catch (error) {
    routeLogger.error('[auth/password/setup/start] Unexpected error:', error)
    return res.status(500).json({ error: 'An unexpected error occurred', error_type: 'internal_error' })
  }
})

// Password reset: always send a one-time link (even if a password already exists).
router.post('/password/reset/start', passwordRateLimiter, async (req, res) => {
  try {
    await ensurePasswordAuthSchema(req.db)

    const emailRaw = req.body?.email
    if (typeof emailRaw !== 'string') {
      return res.status(400).json({ error: 'email is required', error_type: 'validation_error' })
    }

    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', error_type: 'validation_error' })
    }

    const isProd = isProductionEnvironment()

    const isAdmin = isAdminEmail(email)
    const profileMatch = await findProfileRowForEmail(req.db, email)
    if (isProd && !isAdmin && !profileMatch) {
      return res.status(403).json({
        error_type: 'unauthorized_email',
        error: 'Access denied. This email is not authorized for login.',
        redirect_to: '/ServiceApplication',
      })
    }

    // In production, email MUST be configured.
    if (isProd && !isEmailServiceConfigured()) {
      const missingVars = []
      if (!process.env.RESEND_API_KEY) missingVars.push('RESEND_API_KEY')
      if (!process.env.FROM_EMAIL && !process.env.EMAIL_FROM) missingVars.push('FROM_EMAIL or EMAIL_FROM')

      console.error('[auth/password/reset/start] Email service not configured in production:', {
        missing: missingVars,
        email: email,
        has_resend_key: Boolean(process.env.RESEND_API_KEY),
        has_from_email: Boolean(process.env.FROM_EMAIL || process.env.EMAIL_FROM),
        node_env: process.env.NODE_ENV,
        railway_env: process.env.RAILWAY_ENVIRONMENT,
      })

      return res.status(503).json({
        error_type: 'email_not_configured',
        error: 'Email service is not configured. Please contact support.',
      })
    }

    const user = await ensureUserForPasswordAuth(req.db, email)
    if (!user) {
      return res.status(503).json({ error: 'Unable to start password reset', error_type: 'service_unavailable' })
    }

    const token = base64UrlToken(32)
    const tokenHash = hashValue(token)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_TTL * 1000).toISOString()
    const id = crypto.randomUUID()

    await req.db
      .prepare(
        `
          INSERT INTO password_setup_tokens (
            id, user_id, token_hash, expires_at, consumed_at, request_ip, user_agent
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        `,
      )
      .run(id, user.id, tokenHash, expiresAt, req.ip ?? null, req.headers['user-agent'] ?? null)

    const link = buildPasswordSetupLink(req, token)

    let emailSent = false
    /** @type {null | { name?: string, status?: any, provider?: any, message?: string }} */
    let emailSendError = null
    try {
      const sendPromise = sendPasswordSetupEmail(email, link)
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(false), Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000))
      })
      emailSent = await Promise.race([sendPromise, timeoutPromise])
    } catch (err) {
      if (err instanceof EmailSendError) {
        emailSendError = { name: err.name, status: err.status, provider: err.provider, message: err.message }
      } else {
        emailSendError = { name: err?.name, status: err?.status, provider: err?.provider, message: err?.message || String(err) }
      }
      emailSent = false
    }

    const response = { ok: true, status: 'password_reset_email_sent', email_sent: emailSent }
    if (emailSent !== true) {
      response.notice = 'We created your password reset link, but email delivery may be delayed. Please try again in a minute.'
      if (isProd) {
        response.error_type = 'email_delivery_failed'
        console.error('[auth/password/reset/start] Email send failed in production:', {
          email: email,
          user_id: user.id,
          token_id: id,
          error_name: emailSendError?.name,
          error_provider: emailSendError?.provider ?? null,
          error_status: emailSendError?.status ?? null,
          error_message: emailSendError?.message ?? null,
        })
      }
      if (!isProd) {
        response.preview_token = token
        response.preview_url = link
      }
    }

    return res.status(202).json(response)
  } catch (error) {
    routeLogger.error('[auth/password/reset/start] Unexpected error:', error)
    return res.status(500).json({ error: 'An unexpected error occurred', error_type: 'internal_error' })
  }
})

router.post('/password/setup/complete', passwordRateLimiter, async (req, res) => {
  try {
    await ensurePasswordAuthSchema(req.db)

    const tokenRaw = req.body?.token
    const passwordRaw = req.body?.password
    if (typeof tokenRaw !== 'string' || typeof passwordRaw !== 'string') {
      return res.status(400).json({ error: 'token and password are required', error_type: 'validation_error' })
    }

    const token = tokenRaw.trim()
    if (!token) return res.status(400).json({ error: 'token is required', error_type: 'validation_error' })

    const pwCheck = isStrongPassword(passwordRaw)
    if (!pwCheck.ok) {
      return res.status(400).json({ error: pwCheck.error, error_type: 'weak_password' })
    }

    const tokenHash = hashValue(token)
    const record = await consumePasswordSetupToken(req.db, tokenHash)
    if (!record) {
      return res.status(400).json({ error: 'invalid_or_expired_token', error_type: 'invalid_or_expired_token' })
    }

    const user = await getUserById(req.db, record.user_id)
    if (!user) {
      return res.status(400).json({ error: 'invalid_or_expired_token', error_type: 'invalid_or_expired_token' })
    }

    const passwordHash = await bcrypt.hash(passwordRaw, 15)
    await req.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(passwordHash, user.id)

    await req.db
      .prepare('UPDATE password_setup_tokens SET consumed_at = ? WHERE id = ?')
      .run(nowISOString(), record.id)

    // Ensure the user's profile link is established (self-heals after DB restores/imports).
    let activeProfileId = null
    try {
      const attached = await assignProfileToUser(req.db, user.id, user.primary_email ?? null)
      const profiles = await getUserProfiles(req.db, user.id)
      activeProfileId = attached ?? profiles[0]?.id ?? null
    } catch (e) {
      console.warn('[auth/password/setup/complete] Failed to auto-attach profile:', e?.message || e)
    }

    const profiles = await getUserProfiles(req.db, user.id)
    if (!activeProfileId && profiles.length > 0 && !user.is_admin) activeProfileId = profiles[0].id

    const session = await createSessionAndTokens(req.db, {
      user,
      profileId: activeProfileId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      method: 'password_setup_complete',
      identifier: user?.primary_email ?? null,
    })

    setRefreshCookie(req, res, session.refreshToken)
    return res.json({
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      accessExpires: session.accessExpires,
      refreshExpires: session.refreshExpires,
      tokenType: 'Bearer',
      user: await buildUserPayload(req.db, user, profiles, activeProfileId),
    })
  } catch (error) {
    routeLogger.error('[auth/password/setup/complete] Unexpected error:', error)
    return res.status(500).json({ error: 'An unexpected error occurred', error_type: 'internal_error' })
  }
})

router.post('/password/login', passwordRateLimiter, async (req, res) => {
  try {
    await ensurePasswordAuthSchema(req.db)

    const emailRaw = req.body?.email
    const passwordRaw = req.body?.password
    if (typeof emailRaw !== 'string' || typeof passwordRaw !== 'string') {
      return res.status(400).json({ error: 'email and password are required', error_type: 'validation_error' })
    }

    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email address', error_type: 'validation_error' })
    }

    const isProd = isProductionEnvironment()

    // Owner blocklist: a blocked email cannot log in with a password either.
    const blockLogin = await enforceOwnerBlocklist(
      req.db,
      { email },
      { context: 'auth_password_login', banAccount: true },
    )
    if (blockLogin.blocked) {
      console.warn('[auth/password/login] Blocked by owner blocklist:', email)
      return res.status(403).json({ error_type: 'blocked', error: 'This account has been blocked.' })
    }

    const isAdmin = isAdminEmail(email)
    const profileMatch = await findProfileRowForEmail(req.db, email)
    if (isProd && !isAdmin && !profileMatch) {
      return res.status(403).json({
        error_type: 'unauthorized_email',
        error: 'Access denied. This email is not authorized for login.',
        redirect_to: '/ServiceApplication',
      })
    }

    const user = await getUserByEmail(req.db, email)
    if (!user) {
      return res.status(401).json({ error: 'invalid_credentials', error_type: 'invalid_credentials' })
    }

    const storedHash = typeof user.password_hash === 'string' ? user.password_hash : ''
    if (!storedHash.trim()) {
      return res.status(400).json({ error: 'password_not_set', error_type: 'password_not_set', hint: 'use password setup email' })
    }

    const ok = await bcrypt.compare(passwordRaw, storedHash)
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials', error_type: 'invalid_credentials' })
    }

    // Ensure the user's profile link is established (self-heals after DB restores/imports).
    let activeProfileId = null
    try {
      const attached = await assignProfileToUser(req.db, user.id, user.primary_email ?? null)
      const profiles = await getUserProfiles(req.db, user.id)
      activeProfileId = attached ?? profiles[0]?.id ?? null
    } catch (e) {
      console.warn('[auth/password/login] Failed to auto-attach profile:', e?.message || e)
    }

    const profiles = await getUserProfiles(req.db, user.id)
    if (!activeProfileId && profiles.length > 0 && !user.is_admin) activeProfileId = profiles[0].id

    const session = await createSessionAndTokens(req.db, {
      user,
      profileId: activeProfileId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      method: 'password',
      identifier: user?.primary_email ?? null,
    })

    if (user.is_admin || user.role === 'admin') {
      scheduleAdminGeoCrawlOnLogin(req.db, user, {
        uploadDir,
        getOpenAI,
        userId: user.id,
      }).catch((err) => console.error('[auth/password/login] admin geo crawl scheduler:', err))
    }

    setRefreshCookie(req, res, session.refreshToken)
    return res.json({
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      accessExpires: session.accessExpires,
      refreshExpires: session.refreshExpires,
      tokenType: 'Bearer',
      user: await buildUserPayload(req.db, user, profiles, activeProfileId),
    })
  } catch (error) {
    routeLogger.error('[auth/password/login] Unexpected error:', error)
    return res.status(500).json({ error: 'An unexpected error occurred', error_type: 'internal_error' })
  }
})

router.get('/:provider/start', async (req, res) => {
  const provider = (req.params?.provider || '').toLowerCase()
  
  routeLogger.info(`[auth] OAuth start requested for provider: ${provider}`)
  
  if (!OAUTH_PROVIDERS[provider]) {
    // CodeQL js/log-injection (#578): logs the raw route param on the
    // branch where it just failed the OAUTH_PROVIDERS whitelist check.
    console.warn(`[auth] Unsupported OAuth provider requested: ${sanitizeLogValue(provider)}`)
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
    
    routeLogger.info(`[auth] Redirecting to ${provider} OAuth authorization page`)
    return res.redirect(authorizeUrl)
  } catch (error) {
    routeLogger.error(`[auth] Error starting OAuth flow for ${provider}:`, error)
    return res.status(500).json({ 
      error: 'Failed to initiate OAuth flow',
      provider,
      details: undefined // Never expose internal error details
    })
  }
})

router.post('/oauth/complete', requireRefreshRequestIntegrity, async (req, res) => {
  const handoff = typeof req.body?.handoff === 'string' ? req.body.handoff.trim() : ''
  if (handoff.length < 32 || handoff.length > 256) {
    return res.status(400).json({ error: 'oauth_handoff_required' })
  }

  const consumed = await consumeOAuthSessionHandoff(req.db, handoff)
  if (!consumed?.sessionId) {
    return res.status(401).json({ error: 'oauth_handoff_invalid_or_expired' })
  }

  const sessionRow = await req.db.prepare(
    `
      SELECT s.*
      FROM user_sessions s
      WHERE s.id = ?
    `,
  ).get(consumed.sessionId)
  if (!sessionRow || sessionRow.revoked_at) {
    return res.status(401).json({ error: 'oauth_session_invalid' })
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
    expectedRefreshHash: sessionRow.refresh_token_hash,
    priorAccessExpiresAt: sessionRow.access_expires_at ?? null,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    identifier: user?.primary_email ?? null,
  })

  setRefreshCookie(req, res, tokens.refreshToken)
  return res.json({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    accessExpires: tokens.accessExpires,
    refreshExpires: tokens.refreshExpires,
    tokenType: 'Bearer',
    user: await buildUserPayload(req.db, user, profiles, sessionRow.profile_id),
  })
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
      method: `oauth:${provider}`,
      identifier: profile?.email ? normalizeEmail(profile.email) : `${provider}:${profile?.providerAccountId || 'unknown'}`,
    })

    if (user.is_admin || user.role === 'admin') {
      scheduleAdminGeoCrawlOnLogin(req.db, user, {
        uploadDir,
        getOpenAI,
        userId: user.id,
      }).catch((err) => console.error('[auth/oauth/%s] admin geo crawl scheduler:', provider, err))
    }

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
    }).catch(e => console.warn('[background]', e?.message || e))

    // Sign-in recorded durably at the session-mint choke point (createSessionAndTokens).

    // Auto-trigger discovery crawlers on OAuth login (fire and forget)
    if (activeProfileId) {
      runProfileDiscoveryLive({ db: req.db, profileId: activeProfileId }).catch(err => {
        console.error('[auth/%s] Failed to queue auto-discovery crawlers:', provider, err)
      })
    }

    const handoff = await createOAuthSessionHandoff(req.db, {
      sessionId: session.sessionId,
      redirectTo: redirectBase,
    })

    // Put the one-time handoff in the URL fragment. Fragments are not sent in
    // HTTP requests or Referer headers, so Vercel/Railway access logs and static
    // asset requests never receive the bearer capability.
    const completedRedirect = new URL(buildRedirectUrl(redirectBase, {
      provider,
      activeProfileId: activeProfileId ?? undefined,
    }))
    completedRedirect.hash = new URLSearchParams({ handoff }).toString()
    return res.redirect(completedRedirect.toString())
  } catch (oauthError) {
    console.error('[auth] %s oauth callback failed:', provider, oauthError)
    return redirectWithParams({ error: 'oauth_exchange_failed' })
  }
})

/**
 * NOTE: There is no `router.get('/me', ...)` handler here. GET /api/auth/me
 * is served by an identically-pathed handler registered directly on `app`
 * in backend/server.js (before this router is mounted at /api/auth), which
 * therefore always wins Express's route-matching order. A near-duplicate
 * handler used to live here too -- confirmed via `railway connect`-style
 * direct API probing (2026-07-06) to be fully unreachable, zero live
 * traffic, zero test coverage (the auth-identity-matrix tests spawn the
 * real server.js and were unknowingly exercising the OTHER handler) -- and
 * was deleted rather than left as a maintenance trap. If GET /me behavior
 * needs to change, edit the handler in server.js instead.
 */

/**
 * PATCH /api/auth/onboarding-state
 * Persists durable onboarding / tour state to the users table.
 * Accepts any subset of: has_completed_onboarding, last_seen_manual_version,
 * last_completed_tour_version, tour_dismissed_at.
 */
router.patch('/onboarding-state', async (req, res) => {
  try {
    // /api/auth* is exempt from the global enforceResolvedIdentity gate (identity-
    // ESTABLISHING endpoints must run pre-identity). But this is a user-scoped
    // STATE MUTATION — a deleted-user JWT or synthetic-id collision keeps
    // ctx.userId through the exemption and would write auth state / mutate the
    // reserved system_admin_token row. Gate on the DB-backed identity here, and
    // use req.ctx.userId ONLY (never a raw req.user.userId/id fallback).
    if (!requireResolvedIdentity(req, res)) return
    const userId = req.ctx?.userId ?? null
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const {
      has_completed_onboarding,
      last_seen_manual_version,
      last_completed_tour_version,
      tour_dismissed_at,
      guided_cycle_tour_status,
    } = req.body ?? {}

    const updates = []
    const values = []

    if (typeof has_completed_onboarding === 'boolean') {
      updates.push('has_completed_onboarding = ?')
      values.push(has_completed_onboarding ? 1 : 0)
      if (has_completed_onboarding) {
        updates.push('onboarding_completed_at = ?')
        values.push(new Date().toISOString())
      }
    }

    if (typeof last_seen_manual_version === 'number') {
      updates.push('last_seen_manual_version = ?')
      values.push(last_seen_manual_version)
    }

    if (typeof last_completed_tour_version === 'number') {
      updates.push('last_completed_tour_version = ?')
      values.push(last_completed_tour_version)
    }

    if (typeof tour_dismissed_at === 'string') {
      updates.push('tour_dismissed_at = ?')
      values.push(tour_dismissed_at)
    }

    if (['completed', 'skipped'].includes(guided_cycle_tour_status)) {
      updates.push('guided_cycle_tour_status = ?')
      values.push(guided_cycle_tour_status)
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' })
    }

    // Safety note: `updates` array contains only hardcoded column-name fragments
    // (e.g. 'has_completed_onboarding = ?'). All values go through ? placeholders.
    // No user input enters the SQL template itself.
    values.push(userId)
    const result = await req.db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    // A zero-row update means no such users row (e.g. a stale token for a deleted
    // user that slipped the gate). Never report a no-op write as success.
    if ((result?.changes ?? 0) === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Return updated state (is_admin + last_login_at feed the admin
    // reinterview gate so this echo matches what login//me will serve).
    const row = await req.db.prepare(
      `SELECT id, primary_email, has_completed_onboarding, onboarding_completed_at,
              last_seen_manual_version, last_completed_tour_version, tour_dismissed_at,
              guided_cycle_tour_status, is_admin, last_login_at
       FROM users WHERE id = ?`
    ).get(userId)

    // Mirror the forced welcome video gate so this echo matches what login//me
    // serves. Fail-open to null (resolveForcedWelcomeVideo swallows errors).
    const forcedWelcomeVideo = await resolveForcedWelcomeVideo(req.db, row)

    return res.json({
      hasCompletedOnboarding: Boolean(row?.has_completed_onboarding),
      onboardingCompletedAt: row?.onboarding_completed_at ?? null,
      lastSeenManualVersion: Number(row?.last_seen_manual_version ?? 0),
      lastCompletedTourVersion: Number(row?.last_completed_tour_version ?? 0),
      tourDismissedAt: row?.tour_dismissed_at ?? null,
      guidedCycleTourStatus: resolveGuidedCycleTourStatus(row),
      forcedWelcomeVideo,
    })
  } catch (error) {
    routeLogger.error('[auth/onboarding-state] Unexpected error:', error)
    return res.status(500).json({
      error: 'An unexpected error occurred',
      error_type: 'internal_error',
      details: undefined // Never expose internal error details,
    })
  }
})

router.post('/refresh', requireRefreshRequestIntegrity, async (req, res) => {
  if (typeof req.body?.refreshToken === 'string') {
    return res.status(400).json({ error: 'refresh_token_body_not_allowed' })
  }

  const refreshToken = getRefreshCookie(req)
  if (!refreshToken) {
    clearRefreshCookie(req, res)
    return res.status(401).json({ error: 'refresh_cookie_required' })
  }

  await req.db.prepare(
    `DELETE FROM auth_refresh_token_history WHERE expires_at <= ?`,
  ).run(nowISOString())

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
    const history = await req.db.prepare(
      `
        SELECT token_hash, session_id, replaced_at
        FROM auth_refresh_token_history
        WHERE token_hash = ?
      `,
    ).get(refreshHash)

    if (history) {
      const replacedAtMs = Date.parse(history.replaced_at)
      const isLikelyConcurrentRotation =
        Number.isFinite(replacedAtMs) && Date.now() - replacedAtMs <= REFRESH_RACE_GRACE_MS

      if (isLikelyConcurrentRotation) {
        return res.status(409).json({
          error: 'refresh_in_progress',
          retryable: true,
        })
      }

      const detectedAt = nowISOString()
      await req.db.withTransaction(async (tx) => {
        await tx.prepare(
          `UPDATE auth_refresh_token_history SET reuse_detected_at = COALESCE(reuse_detected_at, ?) WHERE token_hash = ?`,
        ).run(detectedAt, refreshHash)
        await tx.prepare(
          `UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`,
        ).run(detectedAt, history.session_id)
      })
      clearRefreshCookie(req, res)
      return res.status(401).json({ error: 'refresh_token_reuse_detected' })
    }

    clearRefreshCookie(req, res)
    return res.status(401).json({ error: 'Invalid refresh token' })
  }
  if (sessionRow.revoked_at) {
    clearRefreshCookie(req, res)
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
    clearRefreshCookie(req, res)
    return res.status(401).json({ error: 'Refresh token has expired' })
  }

  const user = await getUserById(req.db, sessionRow.user_id)
  if (!user) {
    clearRefreshCookie(req, res)
    return res.status(401).json({ error: 'User no longer exists' })
  }

  const profiles = await getUserProfiles(req.db, user.id)
  let tokens
  try {
    tokens = await rotateSessionTokens(req.db, {
      sessionId: sessionRow.id,
      user,
      profileId: sessionRow.profile_id,
      expectedRefreshHash: refreshHash,
      // Pre-rotation expiry: lets the rotate choke point distinguish an
      // in-session token refresh (not a login; records nothing) from a RESUME
      // of a remembered session after the access token lapsed (a returning
      // sign-in; stamps last_login_at + client_sign_in for the admin panel).
      priorAccessExpiresAt: sessionRow.access_expires_at ?? null,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      identifier: user?.primary_email ?? null,
    })
  } catch (error) {
    if (error?.code === 'AUTH_REFRESH_ROTATION_CONFLICT') {
      return res.status(409).json({ error: 'refresh_in_progress', retryable: true })
    }
    throw error
  }

  setRefreshCookie(req, res, tokens.refreshToken)
  return res.json({
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    accessExpires: tokens.accessExpires,
    refreshExpires: tokens.refreshExpires,
    tokenType: 'Bearer',
    user: await buildUserPayload(req.db, user, profiles, sessionRow.profile_id),
  })
})

router.post('/logout', requireRefreshRequestIntegrity, async (req, res) => {
  if (typeof req.body?.refreshToken === 'string') {
    return res.status(400).json({ error: 'refresh_token_body_not_allowed' })
  }

  const refreshToken = getRefreshCookie(req)
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
    clearRefreshCookie(req, res)
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

  clearRefreshCookie(req, res)
  return res.status(204).send()
})

// ---------------------------------------------------------------------------
// Named exports — used by sibling routes that need to drive the same
// email-OTP flow programmatically (e.g. the conversational onboarding funnel
// in routes/onboarding.js calls ensureEmailCredential + insertVerificationCode
// after creating a profile so the user gets a sign-in code in one step).
//
// These are pure helpers — they do not touch req/res — so re-exporting them
// keeps a single source of truth for the OTP plumbing instead of forcing the
// onboarding route to duplicate hash/sign/insert logic.
// ---------------------------------------------------------------------------
export {
  ensureEmailCredential,
  insertVerificationCode,
  generateSixDigitCode,
  hashValue,
  signOtpToken,
  sendVerificationEmail,
  EMAIL_CODE_TTL,
  // Password-link sign-in flow — the conversational onboarding funnel
  // (routes/onboarding.js) finishes signup through the SAME flow the login
  // page uses, so a "6-digit code" can never reappear at any sign-in surface.
  ensurePasswordAuthSchema,
  ensureUserForPasswordAuth,
  beginPasswordSetup,
  // Exported for the tenant-takeover regression suite: OTP-verify profile
  // adoption must be bound to the presented credential (see attachProfileToUser).
  attachProfileToUser,
  profileIsBoundToEmail,
  // Exported for the OTP-atomicity regression suite: one-time consume + raceless
  // attempt cap (see atomicVerifyOtpCode); single-active-code minting.
  atomicVerifyOtpCode,
  insertFreshVerificationCode,
  compensateFailedOtpSend,
  ensurePhoneCredential,
  EMAIL_MAX_VERIFY_ATTEMPTS,
  // Exported for the OAuth open-redirect regression suite: post-login
  // redirect_to must resolve against configuredAuthOrigins only.
  sanitizeRedirectTarget,
  configuredAuthOrigins,
  inferFrontendBaseUrl,
}

export default router
