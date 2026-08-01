/**
 * /api/hamilton/portal-sync/*
 *
 * Two-way portal ↔ GrantFlow data sync, driven by Hamilton's saved portal
 * SESSION (or saved login) for a profile. READ pulls real data out of a portal
 * (test scores, financial-aid awards, application status) into the profile /
 * pipeline; WRITE pushes GrantFlow funding sources/awards into the portal where
 * a form exists.
 *
 * Endpoints:
 *   POST /api/hamilton/portal-sync/read   { profileId, portalHost }            — read-only sync
 *   POST /api/hamilton/portal-sync/write  { profileId, portalHost }            — write-only sync
 *   POST /api/hamilton/portal-sync/sync   { profileId, portalHost }            — both directions
 *   GET  /api/hamilton/portal-sync/runs?profileId=&portalHost=                 — run history
 *   GET  /api/hamilton/portal-sync/connectors                                  — registered connectors
 *
 * Auth: every route requires an authenticated caller. Mutations require the
 * caller to own (or be admin for) the target profile — same posture as the rest
 * of the Hamilton surface. Browser automation must additionally be enabled via
 * HAMILTON_ENABLE_BROWSER_AUTOMATION (enforced inside runPortalSync).
 */

import express from 'express'
import rateLimit from 'express-rate-limit'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
  getAuthUserId,
} from '../utils/accessControl.js'
import { runPortalSync, listRuns, listConnectors, getConnectorForHost } from '../services/hamilton/portalSync/index.js'
import { normalizeHost } from '../services/hamilton/hamiltonCredentialSessionService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:hamilton-portal-sync')
const router = express.Router()

const limiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', retry_after_ms: 60_000 },
})

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (req.ctx?.isAdmin === true) return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // global access
  return accessible.has(String(profileId))
}

// A portal sync launches a real browser, navigates several authenticated pages,
// and runs a model extraction — it is inherently slower than an API call. The
// GLOBAL 30s request/response timeout (backend/server.js) therefore 504'd a run
// that had actually SUCCEEDED: the 2026-08-01 studentaid.gov run completed
// server-side in 36s, wrote to the profile, and recorded a `completed` row in
// portal_sync_runs — while the caller was told "the server took too long to
// respond". A sync that works but reports failure is worse than one that fails,
// because the user retries it and doubts correct data.
//
// These routes therefore raise their own socket deadline. The bound is real
// (not disabled): a wedged browser must still die rather than hold a
// connection forever. Runs are ALSO durably recorded, so a client that gives up
// early can still read the true outcome from GET /runs.
const SYNC_REQUEST_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.PORTAL_SYNC_REQUEST_TIMEOUT_MS) || 180_000,
)

// Shared handler for read/write/both — the only difference is the direction.
function syncHandler(direction) {
  return async (req, res) => {
    // Must run BEFORE any await: the global 30s deadline is already armed on
    // this socket, and re-arming it is what keeps a legitimate 36s sync alive.
    try {
      req.setTimeout?.(SYNC_REQUEST_TIMEOUT_MS)
      res.setTimeout?.(SYNC_REQUEST_TIMEOUT_MS)
    } catch { /* non-socket transports (tests) — nothing to re-arm */ }
    const user = requireAuthenticatedUser(req, res)
    if (!user) return undefined
    const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
    const portalHost = String(req.body?.portalHost || req.body?.portal_host || '').trim()
    if (!profileId || !portalHost) {
      return res.status(400).json({ error: 'profileId and portalHost are required' })
    }
    if (!(await userMayAccessProfile(req, user, profileId))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const host = normalizeHost(portalHost)
    if (!host) return res.status(400).json({ error: 'portalHost is not a valid host' })
    if (!getConnectorForHost(host)) {
      return res.status(422).json({ error: 'no_connector', detail: `no portal connector registered for host ${host}` })
    }
    try {
      const result = await runPortalSync(req.db, {
        profileId, portalHost: host, direction, actorUserId: getAuthUserId(user) || null,
      })
      // Honest status: a sync that ran but the connector couldn't act (gate /
      // no session / connector error) returns ok:false. We still respond 200
      // with the result body so the client sees the real outcome (ok + error)
      // rather than a fake success — the failure is in the payload, not hidden.
      return res.json(result)
    } catch (err) {
      log.error('portal_sync_failed', { direction, profileId, host, err: err?.message })
      return res.status(500).json({ ok: false, error: err?.message || 'portal_sync_failed' })
    }
  }
}

router.post('/read', limiter, syncHandler('read'))
router.post('/write', limiter, syncHandler('write'))
router.post('/sync', limiter, syncHandler('both'))

/**
 * POST /submit-awards — the ONE-CLICK submission the owner asked for
 * (2026-08-01): an ordinary sync fills the portal's outside-award form and
 * stops; this completes it.
 *
 * THE HUMAN CLICK IS THE AUTHORIZATION. That is the whole point of the
 * separation: an autonomous sync never submits on a real financial-aid account,
 * but a profile owner (or an admin acting for them) can send it deliberately,
 * and GrantFlow does the submitting — not the user retyping it on the portal.
 *
 * It RE-FILLS and submits in one live session rather than "resuming" the
 * earlier staged form: the browser and the portal's form state are destroyed
 * when a sync ends, so there is no half-filled page waiting anywhere. A click
 * that claimed to resume one would be fiction.
 *
 * Every submission records who authorized it on the run row (submit_authorized_by).
 */
router.post('/submit-awards', limiter, async (req, res) => {
  // Must run BEFORE any await — see SYNC_REQUEST_TIMEOUT_MS above.
  try {
    req.setTimeout?.(SYNC_REQUEST_TIMEOUT_MS)
    res.setTimeout?.(SYNC_REQUEST_TIMEOUT_MS)
  } catch { /* non-socket transports (tests) */ }

  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.body?.profileId || req.body?.profile_id || '').trim()
  const portalHost = String(req.body?.portalHost || req.body?.portal_host || '').trim()
  if (!profileId || !portalHost) {
    return res.status(400).json({ error: 'profileId and portalHost are required' })
  }
  // Owner-or-admin only: submitting to a portal acts on someone's real
  // financial-aid record, so it uses the same access gate as every mutation
  // here — never a shared or guessable id.
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const host = normalizeHost(portalHost)
  if (!host) return res.status(400).json({ error: 'portalHost is not a valid host' })

  try {
    const result = await runPortalSync(req.db, {
      profileId,
      portalHost: host,
      direction: 'write',
      actorUserId: getAuthUserId(user) || null,
      allowSubmit: true,
    })
    log.info('portal_sync_submit_awards', {
      profileId, host, submitted: result?.write?.submitted === true, actor: getAuthUserId(user) || null,
    })
    // 200 with the real outcome in the body: a portal with no submit control,
    // or a form that could not be reached, is reported honestly rather than
    // dressed up as a send.
    return res.json(result)
  } catch (err) {
    log.error('portal_sync_submit_failed', { profileId, host, err: err?.message })
    return res.status(500).json({ ok: false, error: err?.message || 'portal_sync_submit_failed' })
  }
})

router.get('/runs', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = req.query?.profileId ? String(req.query.profileId) : null
  const portalHost = req.query?.portalHost ? normalizeHost(String(req.query.portalHost)) : null
  // Scoping: a non-admin caller may only list runs for a profile they can access.
  if (profileId) {
    if (!(await userMayAccessProfile(req, user, profileId))) {
      return res.status(403).json({ error: 'forbidden' })
    }
  } else if (req.ctx?.isAdmin !== true) {
    // No profile filter from a non-admin → restrict to their accessible profiles.
    const accessible = await getAccessibleProfileIds(req.db, user)
    if (accessible !== null) {
      const all = []
      for (const pid of accessible) {
        const runs = await listRuns(req.db, { profileId: pid, portalHost, limit: 50 }).catch(() => [])
        all.push(...runs)
      }
      all.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      return res.json({ runs: all.slice(0, 100) })
    }
  }
  const runs = await listRuns(req.db, { profileId, portalHost, limit: 100 }).catch(() => [])
  return res.json({ runs })
})

router.get('/connectors', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  // RegExp isn't JSON-serializable; expose its source string.
  const connectors = listConnectors().map((c) => ({ id: c.id, label: c.label, host_match: c.hostMatch?.source || null }))
  return res.json({ connectors })
})

export default router
