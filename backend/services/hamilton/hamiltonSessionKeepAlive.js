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
 *   - CONFIRMED signed in → re-persists the context's post-visit storageState
 *     (the portal just issued fresh sliding-window cookies) and records a
 *     lifetime observation. Reachable ONLY for hosts with a registered
 *     auth-gated probe path;
 *   - CONFIRMED signed out → the session is genuinely dead: mark it expired,
 *     record the death observation, notify the household ONCE with the precise
 *     ask (one side-by-side login);
 *   - UNVERIFIED       → cookies refreshed, but this host has no auth-gated
 *     probe path so liveness is unknown. Nothing is claimed, nothing recorded;
 *   - wall / outage    → INCONCLUSIVE: touch nothing. A datacenter bot wall
 *     (studentaid.gov's Akamai ERR_HTTP2_PROTOCOL_ERROR class) or a transient
 *     outage is OUR reachability problem, not the session's death — expiring
 *     on it would burn a working session (the "an outage never burns" rule).
 *
 * WHAT THIS IS NOT: a way to keep a short-lived session warm. Measured
 * 2026-08-01, a studentaid.gov session was authenticated at T+30s and refused
 * at T+~20min. No probe cadence this repo could responsibly run beats that, and
 * hammering an Akamai-fronted federal host to try would risk a permanent bot
 * wall — strictly worse than an expired session. Portals whose sessions are too
 * short to survive to a scheduled run are handled by SYNCING WHILE WARM (on
 * capture) and by the login-time prompt in `portalSyncStaleness.js`. This sweep
 * exists to catch genuine expiry and to MEASURE lifetimes, not to prevent them.
 *
 * Bounded per tick (limit + time budget); driven from the Hamilton scheduler
 * tick alongside the email-verification recheck. Best-effort; never throws.
 */

import { createLogger } from '../../utils/logger.js'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from './browserLaunch.js'
import {
  CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST,
  CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN,
  controlledBetaBrowserContextOptions,
  installControlledBetaBrowserEgressGuard,
  isHamiltonBrowserRequestAllowed,
  isHamiltonBrowserTargetAllowed,
} from './controlledBetaBrowserPolicy.js'
import { classifyBlocker } from './hamiltonBlockerClassifier.js'
import {
  getSessionStorageState,
  importSession,
  markSessionExpired,
} from './hamiltonCredentialSessionService.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { authProbeUrlForHost, isSignInSurfaceUrl } from '../../config/portalSessionProfiles.js'
import {
  recordSessionObservation,
  OBSERVATION_ALIVE,
  OBSERVATION_DEAD,
} from './portalSessionLifetime.js'

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

async function openProbeContext(launchBrowser, storageState, target) {
  if (typeof launchBrowser === 'function') {
    const launched = await launchBrowser({ storageState })
    if (!launched) return null
    const browser = launched.browser ?? launched
    const context = launched.context
      ?? await browser.newContext(controlledBetaBrowserContextOptions({ storageState, userAgent: REALISTIC_PORTAL_UA }))
    await installControlledBetaBrowserEgressGuard(context)
    return { browser, context }
  }
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { return null }
  if (!chromium?.executablePath?.()) return null
  const { browser } = await launchPortalBrowser(chromium, { targetUrl: target })
  const context = await browser.newContext(controlledBetaBrowserContextOptions({ storageState, userAgent: REALISTIC_PORTAL_UA }))
  await installControlledBetaBrowserEgressGuard(context)
  return { browser, context }
}

/**
 * Probe ONE saved session.
 *
 * OUTCOMES — three of these are verdicts about the SESSION, one is a verdict
 * about our ability to see it:
 *
 *   'refreshed'    CONFIRMED ALIVE. Only reachable when we requested an
 *                  auth-gated path (registry `authProbePath`) and were NOT sent
 *                  to a sign-in surface. Cookies re-saved; a lifetime
 *                  observation is recorded.
 *   'expired'      CONFIRMED DEAD. Either the classifier saw a real auth
 *                  challenge, or an auth-gated request landed on a sign-in
 *                  surface.
 *   'unverified'   Cookies re-saved opportunistically, but we CANNOT say
 *                  whether the session is alive — this host has no auth-gated
 *                  probe path, so the page we read renders the same signed in
 *                  or out. No observation recorded, no liveness claimed.
 *   'inconclusive' Wall / outage / CAPTCHA / thin page. Touch nothing.
 *
 * WHY 'unverified' EXISTS: the previous version had no such state. It probed
 * `https://<host>/` (a public homepage — `landing_url` was read here and
 * written nowhere in the backend) and treated "the classifier found no signal"
 * as proof of life. Verified live 2026-08-01 with a ZERO-cookie context:
 * collegefortn.org, leic.tennessee.edu and studentaid.gov ALL reported
 * "refreshed" while holding no session at all. Reading silence as confirmation
 * is how prod accumulated `keepalive_refreshes: 11` on a session whose sibling
 * the owner measured dying in ~20 minutes.
 */
async function probeAndRefreshSession(db, row, { launchBrowser, probeTimeoutMs }) {
  const meta = parseMeta(row.metadata_json ?? row.metadata)
  // The reserved fixture has an explicit auth-gated path so the positive
  // keepalive state machine remains testable without visiting a real domain.
  const syntheticProbeUrl = String(row.portal_host || '').toLowerCase() === CONTROLLED_BETA_SYNTHETIC_BROWSER_HOST
    ? `${CONTROLLED_BETA_SYNTHETIC_BROWSER_ORIGIN}/authenticated`
    : null
  const authProbeUrl = syntheticProbeUrl || authProbeUrlForHost(row.portal_host)
  const target = authProbeUrl || meta.landing_url || `https://${row.portal_host}/`
  if (!isHamiltonBrowserTargetAllowed(target)) {
    return { outcome: 'skipped', detail: 'session probe refused private/unsafe browser target' }
  }

  const storageState = await getSessionStorageState(db, row.id)
  if (!storageState) return { outcome: 'skipped', detail: 'no durable storage state' }

  let handle = null
  try {
    handle = await openProbeContext(launchBrowser, storageState, target)
    if (!handle) return { outcome: 'skipped', detail: 'browser unavailable' }
    const { context } = handle
    const page = await context.newPage()

    // An AUTH-GATED path is the only target whose response carries information
    // about our session. Without one we can still refresh cookies, but we may
    // never claim the session is alive.
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
    if (!isHamiltonBrowserRequestAllowed(finalUrl)) {
      return { outcome: 'inconclusive', detail: 'probe landed on a private/unsafe URL' }
    }

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
    // STRUCTURAL death signal: we asked for a page that requires auth and the
    // portal moved us to its sign-in surface. This is what studentaid.gov does
    // (`/my-activity/` -> `/fsa-id/sign-in/landing?redirectTo=%2Fmy-activity`)
    // and it survives copy changes in a way text classification does not —
    // that sign-in page itself classifies as `unknown`, i.e. the old rule read
    // a login wall as a healthy session.
    if (authProbeUrl && isSignInSurfaceUrl(finalUrl)) {
      return { outcome: 'expired', detail: `auth-gated probe redirected to sign-in (${finalUrl.slice(0, 120)})` }
    }

    // Re-persist the cookie jar so any sliding window restarts from NOW. This is
    // safe (and useful) whether or not we can confirm liveness.
    const refreshedState = await context.storageState()
    const confirmedAlive = Boolean(authProbeUrl)
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
        // Only stamped when a POSITIVE, auth-gated observation backs it. A
        // surface may present this as "last confirmed signed in"; it must never
        // be written by a probe that could not tell.
        ...(confirmedAlive ? { keepalive_confirmed_alive_at: new Date().toISOString() } : {}),
      },
    })
    return confirmedAlive
      ? { outcome: 'refreshed', detail: null }
      : {
        outcome: 'unverified',
        detail: `no auth-gated probe path for ${row.portal_host} — cookies refreshed, liveness unknown`,
      }
  } finally {
    try { await handle?.browser?.close?.() } catch { /* best-effort */ }
  }
}

/**
 * The session's TRUE establishment time — when a human last authenticated it,
 * not when the cookie jar was last re-saved. `session_established_at` is pinned
 * by importSession and carried across refreshes; `created_at` is the fallback
 * for rows written before that existed (prod's are, as of 2026-08-01).
 * Returns null when neither is usable, in which case NO observation is recorded
 * rather than one measured against an invented clock.
 */
function resolveSessionEstablishedAt(row, meta) {
  return meta?.session_established_at || row?.created_at || null
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
  const out = {
    checked: 0, refreshed: 0, expired: 0, inconclusive: 0, skipped: 0,
    unverified: 0, observed: 0, results: [],
  }
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

    // LEARN THE HOST'S REAL SESSION LIFETIME. Only the two CONFIRMED outcomes
    // produce an observation; 'unverified' / 'inconclusive' / 'skipped' record
    // nothing, because a failure to observe is not an observation (the same
    // rule that stops a wall from burning a working session two lines below).
    const rowMeta = parseMeta(row.metadata_json ?? row.metadata)
    const establishedAt = resolveSessionEstablishedAt(row, rowMeta)
    if (result.outcome === 'refreshed' || result.outcome === 'expired') {
      const rec = await recordSessionObservation(db, {
        host: row.portal_host,
        kind: result.outcome === 'refreshed' ? OBSERVATION_ALIVE : OBSERVATION_DEAD,
        establishedAt,
        sessionId: row.id,
      }).catch(() => ({ recorded: false }))
      if (rec?.recorded) out.observed += 1
    }

    if (result.outcome === 'refreshed') {
      out.refreshed += 1
    } else if (result.outcome === 'unverified') {
      out.unverified += 1
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
      unverified: out.unverified, observed: out.observed,
    })
  }
  return out
}
