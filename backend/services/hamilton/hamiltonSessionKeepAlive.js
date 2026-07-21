/**
 * hamiltonSessionKeepAlive.js
 *
 * THE REGRESSION THIS KILLS: a captured portal session (MTSU/AcademicWorks,
 * studentaid.gov, TSAC…) silently expires, and the portal tile falls back to
 * "Can't auto-merge — open side-by-side login" — so the owner re-does the
 * side-by-side sign-in every few weeks and reads it as "Hamilton forgot how to
 * sign in". Nothing in the stack ever USED a session between runs, so sliding
 * cookie windows lapsed by pure inactivity.
 *
 * The sweep visits each saved session's portal on a cadence WITH the saved
 * storage state (same fingerprint the capture used — Akamai-class WAFs bind
 * cookies to the UA), and:
 *   - still signed in  → re-persists the context's post-visit storageState
 *     (the portal just issued fresh sliding-window cookies) → the session's
 *     real lifetime extends indefinitely while the account stays active;
 *   - auth challenge   → the session is genuinely dead: mark it expired and
 *     notify the household ONCE with the precise ask (one side-by-side login);
 *   - wall / outage    → INCONCLUSIVE: touch nothing. A datacenter bot wall
 *     (studentaid.gov's Akamai ERR_HTTP2_PROTOCOL_ERROR class) or a transient
 *     outage is OUR reachability problem, not the session's death — expiring
 *     on it would burn a working session (the "an outage never burns" rule).
 *
 * Bounded per tick (limit + time budget); driven from the Hamilton scheduler
 * tick alongside the email-verification recheck. Best-effort; never throws.
 */

import { createLogger } from '../../utils/logger.js'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import { classifyBlocker } from './hamiltonBlockerClassifier.js'
import {
  getSessionStorageState,
  importSession,
  markSessionExpired,
} from './hamiltonCredentialSessionService.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'

const log = createLogger('service:hamilton-session-keepalive')

// A session is DEAD only when the portal actually challenged for auth.
const AUTH_CHALLENGE_CATEGORIES = new Set([
  'login_required',
  'sso_required',
  'two_factor_required',
])

// Categories that mean WE could not conclusively read the portal — walls,
// outages, CAPTCHA interstitials. Never expire a session on these.
const INCONCLUSIVE_CATEGORIES = new Set([
  'portal_unreachable',
  'portal_anti_bot_block',
  'captcha_required',
])

const DEFAULT_INTERVAL_HOURS = 24
const DEFAULT_PROBE_TIMEOUT_MS = 25_000
const RENOTIFY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

function parseMeta(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

function refreshIntervalMs() {
  const hours = Number(process.env.HAMILTON_SESSION_KEEPALIVE_HOURS || DEFAULT_INTERVAL_HOURS)
  return Math.max(1, Number.isFinite(hours) ? hours : DEFAULT_INTERVAL_HOURS) * 60 * 60 * 1000
}

/**
 * A row is due when its last keep-alive touch (or, before any touch, its last
 * update) is older than the interval.
 */
export function isSessionDueForKeepAlive(row, nowMs, intervalMs) {
  const meta = parseMeta(row?.metadata_json ?? row?.metadata)
  const lastTouch = meta.keepalive_at || row?.updated_at || row?.established_at || null
  const t = lastTouch ? Date.parse(lastTouch) : NaN
  if (!Number.isFinite(t)) return true
  return nowMs - t >= intervalMs
}

async function openProbeContext(launchBrowser, storageState) {
  if (typeof launchBrowser === 'function') {
    const launched = await launchBrowser({ storageState })
    if (!launched) return null
    const browser = launched.browser ?? launched
    const context = launched.context
      ?? await browser.newContext({ storageState, userAgent: REALISTIC_PORTAL_UA })
    return { browser, context }
  }
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { return null }
  if (!chromium?.executablePath?.()) return null
  const { browser } = await launchPortalBrowser(chromium)
  const context = await browser.newContext({ storageState, userAgent: REALISTIC_PORTAL_UA })
  return { browser, context }
}

/**
 * Probe ONE saved session. Returns { outcome, detail } where outcome ∈
 * 'refreshed' | 'expired' | 'inconclusive' | 'skipped'.
 */
async function probeAndRefreshSession(db, row, { launchBrowser, probeTimeoutMs }) {
  const storageState = await getSessionStorageState(db, row.id)
  if (!storageState) return { outcome: 'skipped', detail: 'no durable storage state' }

  let handle = null
  try {
    handle = await openProbeContext(launchBrowser, storageState)
    if (!handle) return { outcome: 'skipped', detail: 'browser unavailable' }
    const { context } = handle
    const page = await context.newPage()

    const meta = parseMeta(row.metadata_json ?? row.metadata)
    const target = meta.landing_url || `https://${row.portal_host}/`
    let navError = null
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: probeTimeoutMs })
      // Give client-side auth redirects a moment to settle before reading.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    } catch (err) {
      navError = err?.message || String(err)
    }

    if (navError) {
      // Navigation itself failed — wall or outage; either way inconclusive.
      return { outcome: 'inconclusive', detail: navError.slice(0, 200) }
    }

    let pageText = ''
    try { pageText = await page.evaluate(() => document.body?.innerText || '') } catch { pageText = '' }
    const finalUrl = page.url()

    // A blank/thin page tells us nothing (JS shell that didn't render for the
    // probe) — never expire on silence.
    if (!pageText || pageText.trim().length < 40) {
      return { outcome: 'inconclusive', detail: 'thin page — could not read auth state' }
    }

    const category = classifyBlocker({ text: pageText.slice(0, 4000), url: finalUrl }).category
    if (INCONCLUSIVE_CATEGORIES.has(category)) {
      return { outcome: 'inconclusive', detail: `probe hit ${category}` }
    }
    if (AUTH_CHALLENGE_CATEGORIES.has(category)) {
      return { outcome: 'expired', detail: `portal challenged with ${category}` }
    }

    // Still signed in → persist the refreshed cookie jar so the sliding
    // window restarts from NOW.
    const refreshedState = await context.storageState()
    await importSession(db, {
      userId: row.user_id,
      profileId: row.profile_id,
      portalHost: row.portal_host,
      storageState: refreshedState,
      label: row.label || null,
      authenticationStrategy: row.authentication_strategy || null,
      // Advisory row expiry unknown after refresh — probe-based truth wins.
      expiresAt: null,
      metadata: {
        ...meta,
        keepalive_at: new Date().toISOString(),
        keepalive_refreshes: (Number(meta.keepalive_refreshes) || 0) + 1,
        imported_via: 'session_keepalive_refresh',
      },
    })
    return { outcome: 'refreshed', detail: null }
  } finally {
    try { await handle?.browser?.close?.() } catch { /* best-effort */ }
  }
}

async function notifySessionExpiredOnce(db, row, detail) {
  const meta = parseMeta(row.metadata_json ?? row.metadata)
  const lastNotified = meta.keepalive_notified_at ? Date.parse(meta.keepalive_notified_at) : NaN
  if (Number.isFinite(lastNotified) && Date.now() - lastNotified < RENOTIFY_COOLDOWN_MS) return
  try {
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: row.profile_id,
      profileUserId: row.user_id,
      type: 'hamilton_session_capture_needed',
      title: `Sign in once to ${row.portal_host}`,
      message: `Hamilton's saved session for ${row.portal_host} was ended by the portal (${detail || 'session expired'}). One side-by-side sign-in restores it — Hamilton then keeps it alive automatically.`,
      data: { portal_host: row.portal_host, profile_id: row.profile_id, source: 'session_keepalive' },
      severity: 'warning',
    })
  } catch (err) {
    log.warn('keepalive_notify_failed', { host: row.portal_host, err: err?.message })
  }
  // Best-effort cooldown stamp so a dead session doesn't re-page the household
  // every tick. markSessionExpired already rewrote metadata; fold the stamp in.
  try {
    const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    await db.prepare(
      `UPDATE hamilton_saved_sessions SET metadata_json = ?, updated_at = ${nowFn} WHERE id = ?`,
    ).run(JSON.stringify({
      ...meta,
      expired_reason: detail || 'session_expired',
      keepalive_notified_at: new Date().toISOString(),
    }), row.id)
  } catch { /* advisory only */ }
}

/**
 * The sweep. Options:
 *   limit          max sessions probed this tick (default 6)
 *   timeBudgetMs   wall-clock budget (default 120s)
 *   launchBrowser  injectable launcher (tests) — may return {browser, context}
 *   probeTimeoutMs per-page navigation timeout
 *
 * @returns {Promise<{checked, refreshed, expired, inconclusive, skipped, results}>}
 */
export async function runSessionKeepAliveSweep(db, {
  limit = 6,
  timeBudgetMs = 120_000,
  launchBrowser = null,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const out = { checked: 0, refreshed: 0, expired: 0, inconclusive: 0, skipped: 0, results: [] }
  if (!db) return out

  // Browser automation must be on unless a test injects its own launcher.
  if (!launchBrowser) {
    try {
      const { isBrowserAutomationEnabled } = await import('./hamiltonAutomationOrchestrator.js')
      if (!isBrowserAutomationEnabled()) return out
    } catch { return out }
  }

  let rows = []
  try {
    rows = await db.prepare(
      `SELECT * FROM hamilton_saved_sessions
        WHERE status = 'valid' AND storage_state_encrypted IS NOT NULL
        ORDER BY updated_at ASC`,
    ).all()
  } catch (err) {
    log.warn('keepalive_list_failed', { err: err?.message })
    return out
  }

  const intervalMs = refreshIntervalMs()
  const now = Date.now()
  const due = (rows || []).filter((r) => isSessionDueForKeepAlive(r, now, intervalMs)).slice(0, Math.max(0, limit))
  const deadline = now + Math.max(5_000, timeBudgetMs)

  for (const row of due) {
    if (Date.now() >= deadline) break
    out.checked += 1
    let result
    try {
      result = await probeAndRefreshSession(db, row, { launchBrowser, probeTimeoutMs })
    } catch (err) {
      result = { outcome: 'inconclusive', detail: err?.message || String(err) }
    }

    if (result.outcome === 'refreshed') {
      out.refreshed += 1
    } else if (result.outcome === 'expired') {
      out.expired += 1
      try { await markSessionExpired(db, row.id, result.detail || 'keepalive probe hit auth challenge') } catch { /* row update best-effort */ }
      await notifySessionExpiredOnce(db, row, result.detail)
    } else if (result.outcome === 'skipped') {
      out.skipped += 1
    } else {
      out.inconclusive += 1
    }
    out.results.push({
      session_id: row.id,
      profile_id: row.profile_id,
      portal_host: row.portal_host,
      outcome: result.outcome,
      detail: result.detail || null,
    })
  }

  if (out.checked > 0) {
    log.info('keepalive_sweep', {
      checked: out.checked, refreshed: out.refreshed, expired: out.expired,
      inconclusive: out.inconclusive, skipped: out.skipped,
    })
  }
  return out
}
