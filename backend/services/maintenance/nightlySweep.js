/**
 * nightlySweep.js — Sam's 0400 ET maintenance sweep, run inside a maintenance
 * window so users aren't on a glitching app while Sam applies fixes.
 *
 *   1. Enter maintenance (DOWN) with the same banner users see for a deploy.
 *   2. Run Sam in repair-safe mode (diagnostics + whitelisted safe fixes).
 *   3. Reopen ONLY when the result is "green" — no CRITICAL findings remain.
 *      If criticals remain, stay in maintenance and surface it (so a human can
 *      finish) rather than reopening a broken app.
 *
 * Scheduled from server.js for 04:00 America/New_York daily. Gated by
 * NIGHTLY_MAINTENANCE_ENABLED (default on).
 */

import { enterMaintenanceNow, endMaintenance } from './maintenanceMode.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('nightlySweep')

export function isNightlySweepEnabled() {
  return String(process.env.NIGHTLY_MAINTENANCE_ENABLED ?? 'true').toLowerCase() !== 'false'
}

export async function runNightlyMaintenanceSweep(db, { force = false, now = new Date() } = {}) {
  if (!force && !isNightlySweepEnabled()) return { ran: false, reason: 'disabled' }
  const estimatedMinutes = Number(process.env.NIGHTLY_MAINTENANCE_MINUTES) || 20

  await enterMaintenanceNow(db, {
    reason: 'nightly_sweep',
    estimatedMinutes,
    message: 'GrantFlow is running its nightly maintenance check (≈' + estimatedMinutes + ' min). You\'ll be signed back in shortly.',
    by: 'sam_nightly',
    now,
  })

  let sam = null
  let criticals = 0
  try {
    const { runSam } = await import('../sam/samAgent.js')
    sam = await runSam({
      db,
      ctx: { samAuthorised: true }, // authorise repair-safe writes for the scheduled sweep
      mode: 'repair-safe',
      dryRun: false,
      trigger: 'scheduled',
      persist: true,
    })
    const findings = Array.isArray(sam?.findings) ? sam.findings : []
    criticals = findings.filter((f) => String(f?.severity || '').toLowerCase() === 'critical').length
  } catch (err) {
    log.warn('nightly Sam sweep failed', { error: err?.message })
    sam = { ok: false, error: err?.message }
    criticals = -1 // unknown — treat as not-green
  }

  // Reopen only when green (no criticals and the run didn't error).
  const green = sam && !sam.error && criticals === 0
  if (green) {
    await endMaintenance(db, { by: 'sam_nightly' })
    log.info('nightly sweep complete — reopened', { fixes: sam?.appliedFixes?.length ?? sam?.fixes?.length ?? 0 })
  } else {
    log.warn('nightly sweep left maintenance ON — not green', { criticals })
  }

  return {
    ran: true,
    green,
    criticals,
    reopened: green,
    applied_fixes: sam?.appliedFixes?.length ?? sam?.fixes?.length ?? 0,
    at: now.toISOString(),
  }
}
