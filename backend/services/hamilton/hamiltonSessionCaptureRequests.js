/**
 * Hamilton session-capture request queue.
 *
 * The in-app "Capture login session" button cannot open the user's browser
 * (the backend is in the cloud), so it records an INTENT here. The owner's
 * local laptop-connector polls pending requests, opens a real browser to the
 * login URL for the human to complete username/password + 2FA, captures the
 * Playwright storageState, and uploads it to /sessions/import.
 *
 * Every request is bound to exactly one profile. /sessions/import verifies the
 * uploaded session's profile matches the request's profile before storing it —
 * so a captured session can never be filed under the wrong profile (the
 * safeguard for two users sharing one portal host, e.g. two MTSU students).
 *
 * Self-healing schema mirrors migration 111 / 0108 so the feature works even
 * before the migration runner has touched the DB (recall-over-suppression).
 */

import crypto from 'node:crypto'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamiltonSessionCaptureRequests')

/**
 * Plain-language disclaimer shown wherever a capture is initiated (UI panel,
 * connector terminal output, API response). Single source of truth so the app
 * and the local tool always say the same thing.
 */
export const CAPTURE_DISCLAIMER = {
  what:
    'Captures the authenticated browser SESSION (cookies) after you finish logging in — never your password or your 2FA code.',
  why:
    'Lets Hamilton reopen this portal later to prepare authorized forms, upload approved documents, and save drafts without making you repeat login or 2FA every time. You still complete final submission yourself.',
  how:
    'When you click capture, your computer\'s GrantFlow helper opens the real login page. You log in and clear 2FA yourself; the moment you\'re in, the session is captured and stored encrypted (AES-256-GCM).',
  scope:
    'The captured session is tied to THIS profile only and is reused only for this profile\'s work. You can revoke it at any time.',
}

const VALID_STATUSES = new Set(['pending', 'launched', 'completed', 'cancelled', 'expired'])

const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

export async function ensureCaptureRequestSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const ts = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
    const tsDefault = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS hamilton_session_capture_requests (
           id TEXT PRIMARY KEY,
           user_id TEXT,
           profile_id TEXT NOT NULL,
           portal_host TEXT NOT NULL,
           login_url TEXT,
           label TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           session_id TEXT,
           requested_by_email TEXT,
           reason TEXT,
           created_at ${ts} DEFAULT ${tsDefault},
           updated_at ${ts} DEFAULT ${tsDefault},
           completed_at ${ts},
           expires_at ${ts}
         )`,
      )
      .run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_profile ON hamilton_session_capture_requests(profile_id)').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status ON hamilton_session_capture_requests(status)').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_hamilton_capreq_status_created ON hamilton_session_capture_requests(status, created_at)').run()
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)
  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}

function str(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

/** Light host normalizer: strip scheme/path/port, lowercase. */
export function normalizeCaptureHost(value) {
  const raw = str(value)
  if (!raw) return null
  let host = raw
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname
  } catch { /* fall through to manual strip */ }
  host = host.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].split('#')[0]
  host = host.split('@').pop() // strip any user-info
  host = host.split(':')[0] // strip port
  return host.trim().toLowerCase() || null
}

/**
 * Create (or reuse) a pending capture request for a profile + portal host.
 * Idempotent for the pending state: if an open request already exists for the
 * same (profile, host), it is returned instead of duplicated.
 */
export async function createCaptureRequest(db, {
  userId = null, profileId, portalHost, loginUrl = null, label = null, requestedByEmail = null, expiresInHours = 72,
} = {}) {
  if (!db) throw new Error('db required')
  const profile = str(profileId)
  const host = normalizeCaptureHost(portalHost)
  if (!profile) throw new Error('profileId required')
  if (!host) throw new Error('portalHost required')
  await ensureCaptureRequestSchema(db)

  // Reuse an existing open request for this (profile, host) so repeated clicks
  // don't pile up duplicate intents the connector would all act on.
  const open = await db
    .prepare(
      `SELECT * FROM hamilton_session_capture_requests
        WHERE profile_id = ? AND portal_host = ? AND status IN ('pending','launched')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(profile, host)
  if (open) return rowToRequest(open)

  const id = crypto.randomUUID()
  const expiresAt =
    Number.isFinite(expiresInHours) && expiresInHours > 0
      ? new Date(Date.now() + expiresInHours * 3600_000).toISOString()
      : null
  await db
    .prepare(
      `INSERT INTO hamilton_session_capture_requests
         (id, user_id, profile_id, portal_host, login_url, label, status, requested_by_email, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, str(userId), profile, host, str(loginUrl), str(label), str(requestedByEmail), expiresAt)
  log.info('capture request created', { id, profileId: profile, host })
  return rowToRequest(await db.prepare('SELECT * FROM hamilton_session_capture_requests WHERE id = ?').get(id))
}

/**
 * List pending (or any-status) capture requests for a set of profile ids. The
 * connector calls this scoped to the profiles its operator can access.
 */
export async function listCaptureRequests(db, { profileIds = null, status = 'pending', limit = 100 } = {}) {
  if (!db) return []
  await ensureCaptureRequestSchema(db)
  await expireStaleRequests(db).catch(() => {})

  const where = []
  const params = []
  if (Array.isArray(profileIds)) {
    if (profileIds.length === 0) return []
    where.push(`profile_id IN (${profileIds.map(() => '?').join(',')})`)
    params.push(...profileIds.map(String))
  }
  if (status && status !== 'all' && VALID_STATUSES.has(status)) {
    where.push('status = ?')
    params.push(status)
  }
  const sql =
    `SELECT * FROM hamilton_session_capture_requests` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY created_at DESC LIMIT ?`
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)))
  const rows = await db.prepare(sql).all(...params)
  return (rows || []).map(rowToRequest)
}

export async function getCaptureRequest(db, id) {
  if (!db || !id) return null
  await ensureCaptureRequestSchema(db)
  const row = await db.prepare('SELECT * FROM hamilton_session_capture_requests WHERE id = ?').get(String(id))
  return row ? rowToRequest(row) : null
}

async function setStatus(db, id, status, extra = {}) {
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const sets = ['status = ?', `updated_at = ${nowFn}`]
  const params = [status]
  if (extra.sessionId !== undefined) { sets.push('session_id = ?'); params.push(str(extra.sessionId)) }
  if (extra.reason !== undefined) { sets.push('reason = ?'); params.push(str(extra.reason)) }
  if (status === 'completed') sets.push(`completed_at = ${nowFn}`)
  params.push(String(id))
  await db
    .prepare(`UPDATE hamilton_session_capture_requests SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params)
  return getCaptureRequest(db, id)
}

export async function markLaunched(db, id) {
  await ensureCaptureRequestSchema(db)
  return setStatus(db, id, 'launched')
}

export async function completeCaptureRequest(db, id, { sessionId = null } = {}) {
  await ensureCaptureRequestSchema(db)
  return setStatus(db, id, 'completed', { sessionId })
}

export async function cancelCaptureRequest(db, id, { reason = null } = {}) {
  await ensureCaptureRequestSchema(db)
  return setStatus(db, id, 'cancelled', { reason })
}

/** Auto-expire pending/launched requests past their expires_at. */
export async function expireStaleRequests(db) {
  if (!db) return 0
  await ensureCaptureRequestSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const res = await db
    .prepare(
      `UPDATE hamilton_session_capture_requests
          SET status = 'expired', updated_at = ${nowFn}
        WHERE status IN ('pending','launched')
          AND expires_at IS NOT NULL AND expires_at < ${nowFn}`,
    )
    .run()
  return Number(res?.changes ?? res?.rowCount ?? 0)
}

function rowToRequest(row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id ?? null,
    profile_id: row.profile_id,
    portal_host: row.portal_host,
    login_url: row.login_url ?? null,
    label: row.label ?? null,
    status: row.status,
    session_id: row.session_id ?? null,
    requested_by_email: row.requested_by_email ?? null,
    reason: row.reason ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    completed_at: row.completed_at ?? null,
    expires_at: row.expires_at ?? null,
  }
}
