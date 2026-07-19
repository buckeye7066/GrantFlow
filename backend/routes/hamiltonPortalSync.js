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

// Shared handler for read/write/both — the only difference is the direction.
function syncHandler(direction) {
  return async (req, res) => {
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
