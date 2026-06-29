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

  // Make "no response → off" explicit: SMS consent requests that have sat in
  // `pending` past the expiry window become opted_out (they were already OFF;
  // this records the terminal state for the audit). Best-effort — never blocks
  // the sweep. Reuses the existing nightly scheduler (no new scheduler added).
  try {
    const { expirePendingConsent } = await import('../comms/smsConsentService.js')
    const expired = await expirePendingConsent(db)
    if (expired?.expired > 0) log.info('expired stale SMS consent requests', expired)
  } catch (err) {
    log.warn('SMS consent expiry sweep failed (non-fatal)', { error: err?.message })
  }

  // Run the FULL self-heal (baseline seed gating, uploads/doc repair, orphaned
  // job recovery, ALL product-invariant enforcement, dedup) on demand inside the
  // maintenance window — not just the lightweight runEnforceInvariants boot net.
  // Idempotent + safe to re-run live; the on-demand path downgrades a `force`
  // re-seed to 'auto', and the structured result is persisted (system_kv) so
  // Sam's diagnostics + Anya's status reader can see the last heal. Best-effort:
  // a heal failure must not abort the sweep (Sam still observes below).
  let selfHeal = null
  try {
    const { runSelfHealOnDemand } = await import('../../startup/selfHeal.js')
    selfHeal = await runSelfHealOnDemand(db)
    log.info('nightly self-heal complete', {
      ok: selfHeal?.ok,
      totalRepaired: selfHeal?.totalRepaired ?? 0,
      failures: selfHeal?.failures?.length ?? 0,
    })
  } catch (err) {
    log.warn('nightly self-heal failed (non-fatal)', { error: err?.message })
    selfHeal = { ok: false, error: err?.message }
  }

  // Sam cleanup sweep for Amy's synthetic crawler-training profiles. Amy tags
  // every profile it creates as synthetic + allow_sam_cleanup with an expiry,
  // so the system never clogs with training records. Gated OFF by default
  // (AMY_AUTO_CLEANUP=true to enable); only ever deletes EXPIRED Amy-owned rows,
  // guarded inside cleanupAmyProfiles. Best-effort — never blocks the sweep.
  if (String(process.env.AMY_AUTO_CLEANUP ?? 'false').toLowerCase() === 'true') {
    try {
      const { cleanupAmyProfiles } = await import('../amy/amyProfileStore.js')
      const amy = await cleanupAmyProfiles(db, { expiredOnly: true })
      if (amy?.deleted > 0) log.info('nightly Amy synthetic-profile cleanup', { deleted: amy.deleted, scanned: amy.scanned })
    } catch (err) {
      log.warn('nightly Amy cleanup failed (non-fatal)', { error: err?.message })
    }
  }

  let sam = null
  let criticals = 0
  try {
    const { runSam } = await import('../sam/samAgent.js')
    const { makeInternalHttpProbe } = await import('../sam/samHttpProbe.js')
    sam = await runSam({
      db,
      // Charter: the scheduler NEVER mutates code/data on a cron. The sweep ran
      // 'repair-safe' but supplied no fixIds, so it applied nothing anyway —
      // observe makes that explicit and removes the doc/behavior contradiction.
      mode: 'observe',
      dryRun: true,
      trigger: 'scheduled',
      persist: true,
      // John's per-run email belongs to the real 05:00 ET heavy code sweep, not
      // this light maintenance observe-pass — suppress it here to avoid a daily
      // duplicate. Findings are still persisted to sam_runs.
      emailReport: false,
      // Credentialed loopback probe so the nightly health verdict actually
      // executes the HTTP-class checks instead of fail-skipping them (this was
      // the one autonomous caller still missing the probe).
      httpProbe: makeInternalHttpProbe(),
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
    self_heal: selfHeal
      ? {
          ok: selfHeal.ok !== false && !selfHeal.error,
          total_repaired: selfHeal.totalRepaired ?? 0,
          failures: selfHeal.failures?.length ?? (selfHeal.error ? 1 : 0),
        }
      : null,
    at: now.toISOString(),
  }
}
