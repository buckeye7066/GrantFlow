import express from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
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

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:auth')

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
  keyGenerator: (req) => `${normalizeEmail(req.body?.email ?? '')}|${req.ip}`,
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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
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

    // Cap enforced UNDER the lock (re-read). Locked codes stay locked.
    if (latest && Number(latest.attempt_count || 0) >= maxAttempts) {
      return 'locked_out'
    }

    const match = Array.isArray(active)
      ? active.find((row) => timingSafeEqualHex(row.code_hash, incomingHash))
      : null

    if (!match) {
      // Wrong code: raceless conditional increment of the active-code counter and
      // the credential counter. Serialized by the lock, so the cap is exact.
      if (latest?.id) {
        await tx
          .prepare(`UPDATE user_verification_codes SET attempt_count = attempt_count + 1 WHERE id = ? AND consumed_at IS NULL`)
          .run(latest.id)
      }
      await tx.prepare(`UPDATE user_credentials SET attempt_count = attempt_count + 1 WHERE id = ?`).run(credentialId)
      return 'invalid'
    }

    // Correct code: one-time consume — a single conditional UPDATE that MUST
    // affect exactly one row. A parallel winner already flipped consumed_at →
    // 0 rows → 'already_consumed' (no second session).
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
  })
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

  // No email_otp credential yet — but a users row may already exist for this
  // email (created via password, OAuth, phone, or import). Reuse it instead of
  // inserting a duplicate: a blind INSERT here violates ux_users_primary_email
  // and 500s the request, which blocks email-code login for EVERY pre-existing
  // user (anyone who didn't first sign in via email OTP). Mirror the find-or-
  // create pattern used by ensureUserForPasswordAuth().
  const existingUser = await getUserByEmail(db, email)
  let userId
  if (existingUser) {
    userId = existingUser.id
    // Keep admin flag correct for the admin email.
    await ensureAdminStatus(db, userId, email)
  } else {
    const displayName = email.split('@')[0] || 'New User'
    userId = crypto.randomUUID()
    await db.prepare('INSERT INTO users (id, display_name, primary_email, is_admin) VALUES (?, ?, ?, ?)').run(
      userId,
      displayName,
      email,
      isAdminEmail(email) ? true : false,
    )

    // Assign profile to user (designated or first available)
    await assignProfileToUser(db, userId, email)
  }

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

  // -------------------------------------------------------------------------
  // SESSION-RESUME login tracking (the admin "Logins" panel was stale).
  //
  // The frontend persists the refresh token in localStorage and this rotation
  // slides the 30-day refresh window forward every time, so a RETURNING user
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
      console.warn('[auth/email/start] Invalid email format:', emailRaw)
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
      routeLogger.info('[auth/email/start] Verification code stored in database for:', email)
    } catch (dbError) {
      routeLogger.error('[auth/email/start] Database error storing verification code:', dbError)
      return res.status(500).json({ 
        error: 'Failed to create verification code. Please try again.',
        error_type: 'database_error',
        details: process.env.NODE_ENV !== 'production' ? dbError.message : undefined
      })
    }

    // Attempt to send email with timeout (optional, not required for login)
    routeLogger.info('[auth/email/start] Attempting to send verification email to:', email)
    let emailSent = false
    try {
      // Add timeout to email sending to prevent hanging
      const emailPromise = sendVerificationEmail(email, code)
      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(false), Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000)) // default 15s
      })
      
      emailSent = await Promise.race([emailPromise, timeoutPromise])
      
      if (emailSent === true) {
        routeLogger.info('[auth/email/start] Verification email sent successfully to:', email)
      } else {
        console.warn('[auth/email/start] Email service unavailable, timed out, or failed for:', email)
      }
    } catch (emailError) {
      console.error('[auth/email/start] Unexpected error sending email:', emailError)
      emailSent = false
      // Don't fail the request if email fails - code is stored in DB
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
    refreshToken: session.refreshToken,
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

  // Send FIRST and inspect the result. Twilio can RESOLVE with a failed/
  // undelivered message without throwing, so a fire-and-forget send would tell
  // the user "code sent", stamp the resend cooldown, and deliver nothing. Only
  // persist the code + stamp last_sent_at + return 202 when the send actually
  // succeeded (or when no provider is configured — the dev path logs the code).
  const smsResult = await sendPhoneVerificationCode(normalized, code)
  if (smsResult && smsResult.ok === false && smsResult.skipped !== true) {
    return res.status(502).json({
      error: 'Could not send the verification code right now. Please try again.',
      error_type: 'sms_send_failed',
    })
  }

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
    refreshToken: session.refreshToken,
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

    return res.json({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
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

    return res.json({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
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
      }).catch((err) => console.error(`[auth/oauth/${provider}] admin geo crawl scheduler:`, err))
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
    // Pre-rotation expiry: lets the rotate choke point distinguish an
    // in-session token refresh (not a login; records nothing) from a RESUME
    // of a remembered session after the access token lapsed (a returning
    // sign-in; stamps last_login_at + client_sign_in for the admin panel).
    priorAccessExpiresAt: sessionRow.access_expires_at ?? null,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    identifier: user?.primary_email ?? null,
  })

  return res.json({
    ...tokens,
    tokenType: 'Bearer',
    user: await buildUserPayload(req.db, user, profiles, sessionRow.profile_id),
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
  // attempt cap (see atomicVerifyOtpCode).
  atomicVerifyOtpCode,
  EMAIL_MAX_VERIFY_ATTEMPTS,
}

export default router
