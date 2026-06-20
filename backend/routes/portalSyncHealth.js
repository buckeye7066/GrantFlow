/**
 * Admin-only health surface for Hamilton's two-way portal sync.
 *
 * Mounted at /api/admin/portal-sync. Every route requires a valid session
 * (ensureAuth) and an admin role (ensureAdmin) — same posture as the
 * agent-telemetry Mission Control API. This is the route Sam's
 * `hamilton.portalSync.health` diagnostic probes so portal sync is visible in
 * Mission Control even before the backend framework table is migrated in.
 *
 * Errors degrade to JSON `{ ok: false, ... }` (HTTP 200) so the diagnostic and
 * any dashboard render an honest empty/"not installed" state instead of 500ing.
 */

import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { withProfileScope } from '../middleware/profileContext.js'
import { getPortalSyncHealth } from '../services/hamilton/portalSync/portalSyncHealth.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:portal-sync-health')

router.use(ensureAuth)
router.use(ensureAdmin)

router.get('/health', (req, res) =>
  withProfileScope(
    { actorRole: 'admin_global', userId: req.user?.userId || null, route: req.originalUrl },
    () => getPortalSyncHealth(req.db),
  )
    .then((data) => res.json(data))
    .catch((err) => {
      log.error('portal-sync health handler failed', { err: err?.message })
      res.status(200).json({
        ok: false,
        installed: false,
        status: 'not_installed',
        connectors: [],
        connector_count: 0,
        latest_by_host: [],
        failing: 0,
        generated_at: new Date().toISOString(),
        notes: [`health_unavailable: ${err?.message || 'unknown'}`],
      })
    }),
)

export default router
