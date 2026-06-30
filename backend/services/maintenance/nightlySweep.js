/**
 * nightlySweep.js — Sam's 0400 ET maintenance sweep.
 *
 *   1. (Optional) Enter maintenance (DOWN) with the same banner users see for a
 *      deploy — only when NIGHTLY_MAINTENANCE_USE_WINDOW=true.
 *   2. Run the self-heal (idempotent, safe to run live) + Sam in observe mode
 *      (read-only diagnostics — applies NO fixes).
 *   3. If a window was opened, reopen ONLY when "green" (no CRITICAL findings);
 *      if criticals remain, stay DOWN and surface it for a human.
 *
 * The window is OFF by default: the sweep is read-only (observe Sam) plus an
 * idempotent self-heal that is explicitly safe to run live, so taking the whole
 * app DOWN every night just to run diagnostics was needless downtime. Turn the
 * window back on (NIGHTLY_MAINTENANCE_USE_WINDOW=true) only if/when the sweep is
 * reconfigured to apply destructive fixes.
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

/** Whether to take the app DOWN for the sweep. OFF by default (sweep is read-only + live-safe). */
export function isNightlyMaintenanceWindowEnabled() {
  return String(process.env.NIGHTLY_MAINTENANCE_USE_WINDOW ?? 'false').toLowerCase() === 'true'
}

export async function runNightlyMaintenanceSweep(db, { force = false, now = new Date() } = {}) {
  if (!force && !isNightlySweepEnabled()) return { ran: false, reason: 'disabled' }
  const estimatedMinutes = Number(process.env.NIGHTLY_MAINTENANCE_MINUTES) || 20
  const useWindow = isNightlyMaintenanceWindowEnabled()

  if (useWindow) {
    await enterMaintenanceNow(db, {
      reason: 'nightly_sweep',
      estimatedMinutes,
      message: 'GrantFlow is running its nightly maintenance check (≈' + estimatedMinutes + ' min). You\'ll be signed back in shortly.',
      by: 'sam_nightly',
      now,
    })
  }

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
  // every profile it creates as synthetic + allow_sam_cleanup, marks it crawled
  // once discovery runs, and improves the crawler weights/coverage from the
  // cohort at run end. This is the STANDING NET that reaps profiles whose run
  // already finished but whose inline cleanup didn't (crashed run, pre-net rows)
  // — otherwise synthetic profiles accumulate forever.
  //
  // Policy: reap synthetic + allow_sam_cleanup profiles that have been CRAWLED
  // (their training + learning ran) and were crawled long enough ago that the
  // run is definitely complete (grace window). This is expiry-INDEPENDENT, so it
  // also clears legacy rows whose expires_at is missing/corrupted. Never-crawled
  // profiles are left alone (they may still get crawled). ON by default; set
  // AMY_AUTO_CLEANUP=false to disable, AMY_CLEANUP_GRACE_HOURS to tune the grace.
  // Best-effort — never blocks the sweep.
  if (String(process.env.AMY_AUTO_CLEANUP ?? 'true').toLowerCase() !== 'false') {
    try {
      const { cleanupAmyProfiles } = await import('../amy/amyProfileStore.js')
      const graceMs = Math.max(0, Number(process.env.AMY_CLEANUP_GRACE_HOURS || 2)) * 60 * 60 * 1000
      const amy = await cleanupAmyProfiles(db, { requireCrawled: true, minCrawledAgeMs: graceMs, now })
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
  if (useWindow) {
    if (green) {
      await endMaintenance(db, { by: 'sam_nightly' })
      log.info('nightly sweep complete — reopened', { fixes: sam?.appliedFixes?.length ?? sam?.fixes?.length ?? 0 })
    } else {
      log.warn('nightly sweep left maintenance ON — not green', { criticals })
    }
  } else {
    log.info('nightly sweep complete (no maintenance window)', { green, criticals })
  }

  return {
    ran: true,
    green,
    criticals,
    used_window: useWindow,
    reopened: useWindow ? green : false,
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
