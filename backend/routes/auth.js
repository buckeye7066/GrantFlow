import express from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import twilio from 'twilio'
import { sendVerificationEmail } from '../services/email. js';
const router = express.Router()

const JWT_SECRET = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || 'grantflow-dev-secret'
const ACCESS_TOKEN_TTL = Number.parseInt(process.env.AUTH_ACCESS_TOKEN_TTL ?? '900', 10) // seconds
const REFRESH_TOKEN_TTL = Number.parseInt(process.env.AUTH_REFRESH_TOKEN_TTL ?? `${30 * 24 * 60 * 60}`, 10) // seconds
const EMAIL_CODE_TTL = Number.parseInt(process.env.AUTH_EMAIL_CODE_TTL ?? '600', 10) // seconds
const EMAIL_RESEND_COOLDOWN = Number.parseInt(process.env.AUTH_EMAIL_RESEND_SECONDS ?? '45', 10) // seconds
const PHONE_CODE_TTL = Number.parseInt(process.env.AUTH_PHONE_CODE_TTL ?? '600', 10) // seconds
const PHONE_RESEND_COOLDOWN = Number.parseInt(process.env.AUTH_PHONE_RESEND_SECONDS ?? '60', 10) // seconds
const OAUTH_STATE_TTL = Number.parseInt(process.env.AUTH_OAUTH_STATE_TTL ?? '600', 10) // seconds

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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
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

function getUserById(db, userId) {
  return db
    .prepare(
      `
        SELECT *
        FROM users
        WHERE id = ?
      `,
    )
    .get(userId)
}

function getUserProfiles(db, userId) {
  return db
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

function ensureEmailCredential(db, email) {
  const existing = db
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
    const user = getUserById(db, existing.user_id)
    return {
      user,
      credential: existing,
    }
  }

  const displayName = email.split('@')[0] || 'New User'
  const userId = crypto.randomUUID()
  db.prepare('INSERT INTO users (id, display_name, primary_email) VALUES (?, ?, ?)').run(userId, displayName, email)
  const credentialId = crypto.randomUUID()
  db.prepare(
    `
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES (?, ?, 'email_otp', ?, 0)
    `,
  ).run(credentialId, userId, email)

  const user = getUserById(db, userId)
  const credential = db.prepare('SELECT * FROM user_credentials WHERE id = ?').get(credentialId)

  return { user, credential }
}

function cleanupExpiredOAuthStates(db) {
  db.prepare(
    `
      DELETE FROM oauth_states
      WHERE expires_at <= CURRENT_TIMESTAMP
    `,
  ).run()
}

function createOAuthState(db, { provider, codeVerifier, redirectTo, metadata }) {
  cleanupExpiredOAuthStates(db)
  const state = base64UrlEncode(crypto.randomBytes(24))
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL * 1000).toISOString()
  db.prepare(
    `
      INSERT INTO oauth_states (provider, state, code_verifier, redirect_to, metadata, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(provider, state, codeVerifier ?? null, redirectTo ?? null, metadata ? JSON.stringify(metadata) : null, expiresAt)

  return { state, codeVerifier }
}

function consumeOAuthState(db, provider, state) {
  if (!state) return null
  const row = db
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
    db.prepare(
      `
        DELETE FROM oauth_states
        WHERE id = ?
      `,
    ).run(row.id)
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

function ensureProviderUser(db, provider, profile) {
  const providerAccountId = profile.providerAccountId
  if (!providerAccountId) {
    const error = new Error('Provider response missing account identifier')
    error.status = 400
    throw error
  }

  const linkedUser = db
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
    user = db
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
    db.prepare(
      `
        INSERT INTO users (id, display_name, primary_email, avatar_url)
        VALUES (?, ?, ?, ?)
      `,
    ).run(userId, profile.displayName ?? 'GrantFlow User', email, profile.avatarUrl ?? null)
    user = getUserById(db, userId)
    return user
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
    db.prepare(
      `
        UPDATE users
        SET ${updates.join(', ')},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    ).run(...params)
    user = getUserById(db, user.id)
  }

  return user
}

function upsertProviderAccount(db, { provider, providerAccountId, userId, tokens, profile }) {
  const existing = db
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
    db.prepare(
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
    ).run(
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
  db.prepare(
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
  ).run(
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

function ensurePhoneCredential(db, phone) {
  const existingCredential = db
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
    const user = getUserById(db, existingCredential.user_id)
    return { user, credential: existingCredential }
  }

  let user = db
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
    db.prepare(
      `
        INSERT INTO users (id, display_name, primary_phone)
        VALUES (?, ?, ?)
      `,
    ).run(userId, displayName, phone)
    user = getUserById(db, userId)
  }

  const credentialId = crypto.randomUUID()
  db.prepare(
    `
      INSERT INTO user_credentials (id, user_id, type, identifier, attempt_count)
      VALUES (?, ?, 'phone_otp', ?, 0)
    `,
  ).run(credentialId, user.id, phone)

  const credential = db.prepare('SELECT * FROM user_credentials where id = ?').get(credentialId)
  return { user, credential }
}

function attachProfileToUser(db, userId, profileId) {
  if (!profileId) {
    return null
  }
  const profile = db.prepare('SELECT id, user_id FROM profiles WHERE id = ?').get(profileId)
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
    db.prepare('UPDATE profiles SET user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId, profileId)
  }
  return profileId
}

function insertVerificationCode(db, credentialId, codeHash, expiresAtIso) {
  db.prepare(
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

function createSessionAndTokens(db, { user, profileId, userAgent, ipAddress }) {
  const sessionId = crypto.randomUUID()
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshHash = hashValue(refreshToken)
  const accessToken = signAccessToken(user, sessionId, profileId)
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString()
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()

  db.prepare(
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

function rotateSessionTokens(db, { sessionId, user, profileId }) {
  const refreshToken = crypto.randomBytes(48).toString('hex')
  const refreshHash = hashValue(refreshToken)
  const accessToken = signAccessToken(user, sessionId, profileId)
  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL * 1000).toISOString()
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString()

  db.prepare(
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
  const emailRaw = req.body?.email
  if (typeof emailRaw !== 'string') {
    return res.status(400).json({ error: 'email is required' })
  }
  const email = normalizeEmail(emailRaw)
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  const { user, credential } = ensureEmailCredential(req.db, email)
  const now = new Date()

  if (credential.last_sent_at) {
    const lastSent = new Date(credential.last_sent_at)
    if (now - lastSent < EMAIL_RESEND_COOLDOWN * 1000) {
      return res.status(429).json({
        error: 'Verification already sent',
        retry_after_seconds: Math.ceil((EMAIL_RESEND_COOLDOWN * 1000 - (now - lastSent)) / 1000),
      })
    }
  }

  const code = generateSixDigitCode()
  const codeHash = hashValue(`${email}:${code}`)
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_TTL * 1000).toISOString()
  insertVerificationCode(req.db, credential.id, codeHash, expiresAt)
  req.db
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

  console.info(`[auth] Email verification code for ${email}: ${code}`)
  await sendVerificationEmail(email, code)

  return res.status(202).json({
    message: 'Verification code sent',
    previewCode: process.env.NODE_ENV !== 'production' ? code : undefined,
    user_hint: {
      id: user.id,
      display_name: user.display_name,
      primary_email: user.primary_email,
    },
  })
})

router.post('/email/verify', (req, res) => {
  const emailRaw = req.body?.email
  const codeRaw = req.body?.code
  const requestedProfileId = req.body?.profile_id ?? null

  if (typeof emailRaw !== 'string' || typeof codeRaw !== 'string') {
    return res.status(400).json({ error: 'email and code are required' })
  }
  const email = normalizeEmail(emailRaw)
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Invalid email address' })
  }
  const code = codeRaw.trim()
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be a 6-digit number' })
  }

  const credential = req.db
    .prepare(
      `
        SELECT *
        FROM user_credentials
        WHERE type = 'email_otp'
          AND identifier = ?
      `,
    )
    .get(email)

  if (!credential) {
    return res.status(400).json({ error: 'Verification code not requested for this email' })
  }

  const codeRow = req.db
    .prepare(
      `
        SELECT *
        FROM user_verification_codes
        WHERE credential_id = ?
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(credential.id)

  if (!codeRow) {
    return res.status(400).json({ error: 'No active verification code. Request a new one.' })
  }

  const now = new Date()
  if (codeRow.expires_at && new Date(codeRow.expires_at) < now) {
    return res.status(400).json({ error: 'Verification code has expired. Request a new one.' })
  }

  const incomingHash = hashValue(`${email}:${code}`)
  if (incomingHash !== codeRow.code_hash) {
    req.db
      .prepare(
        `
          UPDATE user_verification_codes
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(codeRow.id)

    req.db
      .prepare(
        `
          UPDATE user_credentials
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(credential.id)

    return res.status(400).json({ error: 'Invalid verification code' })
  }

  req.db
    .prepare(
      `
        UPDATE user_verification_codes
        SET consumed_at = ?
        WHERE id = ?
      `,
    )
    .run(nowISOString(), codeRow.id)

  req.db
    .prepare(
      `
        UPDATE user_credentials
        SET verified_at = COALESCE(verified_at, ?),
            attempt_count = 0
        WHERE id = ?
      `,
    )
    .run(nowISOString(), credential.id)

  const user = getUserById(req.db, credential.user_id)
  if (!user) {
    return res.status(500).json({ error: 'User record missing for credential' })
  }

  let activeProfileId = null
  try {
    if (requestedProfileId) {
      activeProfileId = attachProfileToUser(req.db, user.id, requestedProfileId)
    }
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message })
  }

  const profiles = getUserProfiles(req.db, user.id)
  if (!activeProfileId && profiles.length > 0) {
    activeProfileId = profiles[0].id
  }

  const session = createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  })

  return res.json({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    tokenType: 'Bearer',
    user: buildUserPayload(user, profiles, activeProfileId),
  })
})

router.post('/phone/start', phoneStartLimiter, (req, res) => {
  const phoneRaw = req.body?.phone
  if (typeof phoneRaw !== 'string') {
    return res.status(400).json({ error: 'phone is required' })
  }
  const normalized = normalizePhone(phoneRaw)
  if (!normalized) {
    return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +1234567890)' })
  }

  const { user, credential } = ensurePhoneCredential(req.db, normalized)
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

  insertVerificationCode(req.db, credential.id, codeHash, expiresAt)
  req.db
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

  return res.status(202).json({
    message: 'Verification code sent',
    previewCode: process.env.NODE_ENV !== 'production' ? code : undefined,
    user_hint: {
      id: user.id,
      display_name: user.display_name,
      primary_phone: normalized,
    },
  })
})

router.post('/phone/verify', (req, res) => {
  const phoneRaw = req.body?.phone
  const codeRaw = req.body?.code
  const requestedProfileId = req.body?.profile_id ?? null

  if (typeof phoneRaw !== 'string' || typeof codeRaw !== 'string') {
    return res.status(400).json({ error: 'phone and code are required' })
  }

  const normalized = normalizePhone(phoneRaw)
  if (!normalized) {
    return res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +1234567890)' })
  }

  const code = codeRaw.trim()
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be a 6-digit number' })
  }

  const credential = req.db
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

  const codeRow = req.db
    .prepare(
      `
        SELECT *
        FROM user_verification_codes
        WHERE credential_id = ?
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(credential.id)

  if (!codeRow) {
    return res.status(400).json({ error: 'No active verification code. Request a new one.' })
  }

  const now = new Date()
  if (codeRow.expires_at && new Date(codeRow.expires_at) < now) {
    return res.status(400).json({ error: 'Verification code has expired. Request a new one.' })
  }

  const incomingHash = hashValue(`${normalized}:${code}`)
  if (incomingHash !== codeRow.code_hash) {
    req.db
      .prepare(
        `
          UPDATE user_verification_codes
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(codeRow.id)

    req.db
      .prepare(
        `
          UPDATE user_credentials
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(credential.id)

    return res.status(400).json({ error: 'Invalid verification code' })
  }

  req.db
    .prepare(
      `
        UPDATE user_verification_codes
        SET consumed_at = ?
        WHERE id = ?
      `,
    )
    .run(nowISOString(), codeRow.id)

  req.db
    .prepare(
      `
        UPDATE user_credentials
        SET verified_at = COALESCE(verified_at, ?),
            attempt_count = 0
        WHERE id = ?
      `,
    )
    .run(nowISOString(), credential.id)

  const user = getUserById(req.db, credential.user_id)
  if (!user) {
    return res.status(500).json({ error: 'User record missing for credential' })
  }

  if (user.primary_phone !== normalized) {
    req.db
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
      activeProfileId = attachProfileToUser(req.db, user.id, requestedProfileId)
    }
  } catch (error) {
    return res.status(error.status ?? 400).json({ error: error.message })
  }

  const profiles = getUserProfiles(req.db, user.id)
  if (!activeProfileId && profiles.length > 0) {
    activeProfileId = profiles[0].id
  }

  const session = createSessionAndTokens(req.db, {
    user,
    profileId: activeProfileId,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  })

  return res.json({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    tokenType: 'Bearer',
    user: buildUserPayload(user, profiles, activeProfileId),
  })
})

router.get('/:provider/start', (req, res) => {
  const provider = (req.params?.provider || '').toLowerCase()
  if (!OAUTH_PROVIDERS[provider]) {
    return res.status(404).json({ error: 'Unsupported provider' })
  }

  const config = getProviderConfig(provider, req)
  if (!isProviderConfigured(config)) {
    return res.status(503).json({ error: 'Provider not configured. Contact your administrator.' })
  }

  const requestedRedirect = typeof req.query?.redirect_to === 'string' ? req.query.redirect_to : null
  const sanitizedRedirect = sanitizeRedirectTarget(req, requestedRedirect)

  const codeVerifier = config.supportsPKCE ? generateCodeVerifier() : null
  const oauthState = createOAuthState(req.db, {
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
  return res.redirect(authorizeUrl)
})

router.get('/:provider/callback', async (req, res) => {
  const provider = (req.params?.provider || '').toLowerCase()
  if (!OAUTH_PROVIDERS[provider]) {
    return res.status(404).json({ error: 'Unsupported provider' })
  }

  const stateToken = typeof req.query?.state === 'string' ? req.query.state : null
  const error = req.query?.error_description || req.query?.error
  const code = typeof req.query?.code === 'string' ? req.query.code : null

  const stateRecord = consumeOAuthState(req.db, provider, stateToken)
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
    const user = ensureProviderUser(req.db, provider, profile)
    upsertProviderAccount(req.db, {
      provider,
      providerAccountId: profile.providerAccountId,
      userId: user.id,
      tokens,
      profile,
    })

    const profiles = getUserProfiles(req.db, user.id)
    const activeProfileId = profiles[0]?.id ?? null

    const session = createSessionAndTokens(req.db, {
      user,
      profileId: activeProfileId,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    })

    return redirectWithParams({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      activeProfileId: activeProfileId ?? undefined,
    })
  } catch (oauthError) {
    console.error(`[auth] ${provider} oauth callback failed:`, oauthError)
    return redirectWithParams({ error: 'oauth_exchange_failed' })
  }
})

router.post('/refresh', (req, res) => {
  const refreshToken = req.body?.refreshToken
  if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
    return res.status(400).json({ error: 'refreshToken is required' })
  }

  const refreshHash = hashValue(refreshToken)
  const sessionRow = req.db
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
    req.db
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

  const user = getUserById(req.db, sessionRow.user_id)
  if (!user) {
    return res.status(401).json({ error: 'User no longer exists' })
  }

  const profiles = getUserProfiles(req.db, user.id)
  const tokens = rotateSessionTokens(req.db, {
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

router.post('/logout', (req, res) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : null
  if (refreshToken) {
    const refreshHash = hashValue(refreshToken)
    req.db
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
    req.db
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
