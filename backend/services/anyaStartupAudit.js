import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaStartupAudit')
/**
 * anyaStartupAudit.js — Automatic CodeGuard audits on admin startup.
 *
 * When an admin session begins (login or first request), this module
 * kicks off background audits without blocking the response. Results
 * are stored in Anya's brain so she can reference them in conversation.
 *
 * Audit cadence: at most once every 6 hours (configurable in codeGuardService).
 */

import {
  testEndpoints,
  auditMatchQuality,
  verifyMissionGoals,
  shouldRunAudit,
  markAuditComplete,
} from './codeGuardService.js'

let _auditRunning = false

/**
 * Trigger the full CodeGuard audit suite in the background.
 * Safe to call on every admin request — it self-throttles.
 *
 * @param {Object} db - Database connection
 * @param {Object} [opts]
 * @param {number} [opts.port] - Server port for endpoint testing (default 3001)
 * @param {string} [opts.adminToken] - Bearer token for authed endpoints
 */
export function triggerStartupAudit(db, opts = {}) {
  if (!db) {
    console.warn('[anyaStartupAudit] No DB connection provided â audit skipped')
    return
  }
  if (_auditRunning) return

  _auditRunning = true
  const port = opts.port || process.env.PORT || 3001
  const baseUrl = `http://localhost:${port}`
  const adminToken = opts.adminToken || process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

  // Run asynchronously — never block the request
  ;(async () => {
    if (!(await shouldRunAudit(db))) return

    log.info('[anyaStartupAudit] Starting background CodeGuard audit...')

    const startTime = Date.now()
    const results = { endpoints: null, matchQuality: null, mission: null }

    try {
      results.endpoints = await testEndpoints(db, baseUrl, adminToken)
    } catch (e) {
      log.error('[anyaStartupAudit] Endpoint test failed:', e.message)
    }

    try {
      results.matchQuality = await auditMatchQuality(db)
    } catch (e) {
      log.error('[anyaStartupAudit] Match quality audit failed:', e.message)
    }

    try {
      results.mission = await verifyMissionGoals(db)
    } catch (e) {
      log.error('[anyaStartupAudit] Mission verification failed:', e.message)
    }

    try {
      await markAuditComplete(db)
    } catch (e) {
      console.warn('[anyaStartupAudit] markAuditComplete failed (non-critical):', e?.message)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    log.info(`[anyaStartupAudit] Background audit complete in ${elapsed}s`)

    if (results.mission) {
      log.info(`[anyaStartupAudit] Mission score: ${results.mission.score}% (${results.mission.pass}/${results.mission.total})`)
    }
  })().catch(e => {
    log.error('[anyaStartupAudit] Unexpected error:', e)
  }).finally(() => {
    _auditRunning = false
  })
}
