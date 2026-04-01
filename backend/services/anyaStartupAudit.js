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
  if (_auditRunning) return
  if (!shouldRunAudit(db)) return

  _auditRunning = true
  const port = opts.port || process.env.PORT || 3001
  const baseUrl = `http://localhost:${port}`
  const adminToken = opts.adminToken || process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

  console.log('[anyaStartupAudit] Starting background CodeGuard audit...')

  // Run asynchronously — never block the request
  ;(async () => {
    const startTime = Date.now()
    const results = { endpoints: null, matchQuality: null, mission: null }

    try {
      results.endpoints = await testEndpoints(db, baseUrl, adminToken)
    } catch (e) {
      console.error('[anyaStartupAudit] Endpoint test failed:', e.message)
    }

    try {
      results.matchQuality = await auditMatchQuality(db)
    } catch (e) {
      console.error('[anyaStartupAudit] Match quality audit failed:', e.message)
    }

    try {
      results.mission = await verifyMissionGoals(db)
    } catch (e) {
      console.error('[anyaStartupAudit] Mission verification failed:', e.message)
    }

    try {
      markAuditComplete(db)
    } catch { /* non-critical */ }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[anyaStartupAudit] Background audit complete in ${elapsed}s`)

    if (results.mission) {
      console.log(`[anyaStartupAudit] Mission score: ${results.mission.score}% (${results.mission.pass}/${results.mission.total})`)
    }
  })().catch(e => {
    console.error('[anyaStartupAudit] Unexpected error:', e)
  }).finally(() => {
    _auditRunning = false
  })
}
