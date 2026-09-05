/**
 * hamiltonScheduler.js
 *
 * Optional, opt-in background runner for Hamilton (Application Autopilot).
 *
 * WHY THIS EXISTS
 * ---------------
 * The orchestrator defers out-of-window AUTONOMOUS portal runs to
 * status='waiting_for_window' with next_retry_at = the next window start
 * (see hamiltonAutomationOrchestrator.js). The thing that actually RE-PICKS
 * those due tasks is HamiltonAgentAdapter.start(): it SELECTs
 *   application_tasks WHERE status='waiting_for_window'
 *     AND next_retry_at <= now()
 * (alongside queued/auth-blocked tasks) and re-invokes automateSingleSource
 * with options.autonomous=true.
 *
 * That adapter was only ever invoked by a manually-created Agent Control
 * run, so without this scheduler nothing re-attempts deferred portal runs
 * when their window opens — the task just sits at waiting_for_window forever.
 * This tiny poller closes that gap by driving the same adapter on a timer,
 * exactly like robert/yana/john/sam have their own schedulers.
 *
 * DEFAULT CHANGED 2026-09-04: this poller now defaults ON.
 *
 * It was previously opt-in (an unset HAMILTON_RUN_ON_SCHEDULE meant "never
 * run"), and it was left unset in both .env.example files and in production.
 * The consequence was that a profile could be fully authorized for autonomous
 * end-to-end submission — submit_applications granted, require_human_review
 * swept clear, hamilton_autopilot and hamilton_auto_submit both true — and
 * Hamilton would still never act on it, because nothing on any timer ever
 * re-picked the queue. The owner reported this repeatedly as "the code blocks
 * him from working autonomously e2e"; this was the mechanism.
 *
 * Arming the poller does NOT bypass any consent or evidence gate. Every
 * downstream check still applies to every task it picks up: the per-grant
 * authorization record, allow_auto_submit, the require_human_review veto, the
 * missing_info completeness gate, the SSRF/portal-policy floor, and the
 * compare-and-swap submission lease. This flag only decides whether those
 * checks are ever REACHED unattended, not what they decide.
 *
 * Set HAMILTON_RUN_ON_SCHEDULE=false to force the old opt-in behaviour.
 *
 * Env contract:
 *   HAMILTON_RUN_ON_SCHEDULE=true            master switch (DEFAULT ON;
 *                                            set false to disarm the poller)
 *   HAMILTON_ENABLE_BROWSER_AUTOMATION=true  REQUIRED — the scheduler only
 *                                            arms when browser automation is
 *                                            globally enabled, so a disabled
 *                                            fleet never auto-drives portals
 *   HAMILTON_SCHEDULE_INTERVAL_MS=300000     poll cadence (default 5 min,
 *                                            floored at 60s)
 *   HAMILTON_SCHEDULE_BATCH_SIZE=5           tasks per tick (1..25)
 *
 * It never throws on the hot path, never overlaps two runs, and never pins
 * the event loop open (timer is unref'd).
 */

import { HamiltonAgentAdapter } from '../agentControl/agentAdapters/hamiltonAgentAdapter.js'
import { isBrowserAutomationEnabled } from './hamiltonAutomationOrchestrator.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 1000

let timer = null
let running = false
let stopped = false

/**
 * Same default-ON semantics the orchestrator uses for
 * HAMILTON_ENABLE_BROWSER_AUTOMATION (hamiltonAutomationOrchestrator.js:200):
 * unset / empty / 'undefined' / 'null' means the default; only an explicit
 * false/0/off/no disables. Previously this file used an opt-IN isTrue() test,
 * which is why an unset variable silently disarmed autonomous operation.
 */
function envFlagEnabled(raw, defaultOn = true) {
  const v = String(raw ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase()
  if (v === '' || v === 'undefined' || v === 'null') return defaultOn
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no'
}

export function shouldRunOnSchedule() {
  // Both gates must hold: Hamilton is armed for scheduled runs AND browser
  // automation is globally enabled. The browser-automation gate is the same
  // authority the orchestrator enforces before opening a browser, so we never
  // arm a poller that the rest of the system would refuse.
  //
  // Both now default ON, so authorized autonomous work actually runs unattended.
  // Per-grant authorization and every evidence guard still gate each task.
  return envFlagEnabled(process.env.HAMILTON_RUN_ON_SCHEDULE, true) && isBrowserAutomationEnabled()
}

export function resolveIntervalMs() {
  const raw = Number.parseInt(process.env.HAMILTON_SCHEDULE_INTERVAL_MS || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_INTERVAL_MS
  return Math.max(MIN_INTERVAL_MS, raw)
}

export function resolveBatchSize() {
  const raw = Number.parseInt(process.env.HAMILTON_SCHEDULE_BATCH_SIZE || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return 5
  return Math.max(1, Math.min(25, raw))
}

/**
 * Run one Hamilton tick: drive the existing adapter, which re-picks due
 * waiting_for_window (+ queued/auth-blocked) tasks and re-runs the
 * orchestrator with autonomous=true. The adapter is the single source of
 * truth for which tasks are due and how they run — we never duplicate that
 * SELECT here.
 */
async function tick({ db, logger = console } = {}) {
  if (stopped || running) return { skipped: true, reason: running ? 'overlap' : 'stopped' }
  // Re-check the gate every tick so an operator can flip it off at runtime
  // without restarting the server.
  if (!shouldRunOnSchedule()) return { skipped: true, reason: 'disabled' }

  running = true
  try {
    const result = await runWithSchedulerLock(db, {
      lockName: 'hamilton:autopilot',
      ttlMs: 30 * 60 * 1000,
      logger,
    }, async () => {
      // Self-heal first: requeue in-flight tasks orphaned by a crash or a
      // Railway redeploy (in-process work dies with the container; the DB rows
      // survive but nothing else re-picks transient statuses). 45 min stale
      // window — a live portal run with 3 resolver attempts can legitimately
      // hold filling_portal for ~30 minutes, so we never demote active work.
      try {
        const { reconcileOrphanedApplicationTasks } = await import('../../startup/hamiltonTaskRecovery.js')
        await reconcileOrphanedApplicationTasks(db, { staleMinutes: 45, logger })
      } catch (err) {
        logger?.warn?.('[hamilton:scheduler] task recovery failed:', err?.message || err)
      }

      const adapter = new HamiltonAgentAdapter()
      // Provide an inert signal: this is a headless scheduled run with no Agent
      // Control run row, so there is no stop/pause channel and heartbeats/events
      // are no-ops. The adapter already tolerates an absent/partial signal.
      return await adapter.start({
        db,
        controlRunId: null,
        stepId: null,
        options: {
          allow_hamilton_autopilot: true,
          hamilton_batch_size: resolveBatchSize(),
        },
        signal: {
          shouldStop: () => stopped,
          shouldPause: () => false,
          isEmergency: () => false,
          heartbeat: async () => {},
          recordEvent: async () => {},
        },
      })
    })
    if (result?.skipped) return result

    // Auto-resume portal accounts that are AWAITING EMAIL VERIFICATION: re-check
    // each due one (poll John's mailbox for the confirmation link + click it, or
    // detect the user already clicked it) so a brand-new account finishes the
    // moment its email is verified — no human "resume" step. Best-effort; a
    // failure here never fails the tick. Only runs when browser automation is on
    // (recheckEmailVerification refuses to launch otherwise).
    let verificationSummary = null
    try {
      const { recheckDuePortalVerifications } = await import('./hamiltonPortalAutopilotIdentity.js')
      verificationSummary = await recheckDuePortalVerifications(db, { limit: resolveBatchSize() })
      if (verificationSummary?.checked > 0) {
        logger?.info?.('[hamilton:scheduler] email-verification re-check', {
          checked: verificationSummary.checked,
          verified: verificationSummary.verified,
          still_pending: verificationSummary.still_pending,
          exhausted: verificationSummary.exhausted,
        })
      }
    } catch (err) {
      logger?.warn?.('[hamilton:scheduler] verification re-check failed:', err?.message || err)
    }

    // Keep captured portal sessions ALIVE: visit each saved session's portal on
    // a cadence with the saved cookies so sliding-window sessions never lapse
    // from pure inactivity (the "Can't auto-merge — open side-by-side login"
    // regression the owner kept re-doing sign-ins for). A genuinely dead
    // session is marked expired + notified once; walls/outages touch nothing.
    let keepAliveSummary = null
    try {
      const { runSessionKeepAliveSweep } = await import('./hamiltonSessionKeepAlive.js')
      keepAliveSummary = await runSessionKeepAliveSweep(db, { limit: resolveBatchSize() })
      if (keepAliveSummary?.checked > 0) {
        logger?.info?.('[hamilton:scheduler] session keep-alive', {
          checked: keepAliveSummary.checked,
          refreshed: keepAliveSummary.refreshed,
          expired: keepAliveSummary.expired,
          inconclusive: keepAliveSummary.inconclusive,
        })
      }
    } catch (err) {
      logger?.warn?.('[hamilton:scheduler] session keep-alive failed:', err?.message || err)
    }

    // Full-automation hygiene: settle quarantined "verify the portal" cards
    // whose retained run shows a contact/newsletter form (no application was
    // submitted), and re-queue "waiting for review" cards a full-automation
    // profile never needed to review. Both bounded + idempotent; a failure
    // here never fails the tick.
    let autonomySweeps = null
    try {
      const { resolveContactFormVerifications, releaseParkedReviewsUnderFullAutomation } = await import('./hamiltonAutonomySweeps.js')
      const verifications = await resolveContactFormVerifications(db, { limit: 50 })
      const releases = await releaseParkedReviewsUnderFullAutomation(db, { limit: 200 })
      autonomySweeps = { verifications, releases }
      if ((verifications?.resolved || 0) > 0 || (releases?.released || 0) > 0) {
        logger?.info?.('[hamilton:scheduler] autonomy sweeps', {
          contact_forms_resolved: verifications?.resolved || 0,
          reviews_released: releases?.released || 0,
          reviews_kept: releases?.kept || 0,
        })
      }
    } catch (err) {
      logger?.warn?.('[hamilton:scheduler] autonomy sweeps failed:', err?.message || err)
    }
    // Post-submit verification: re-check parked submission_verification_required
    // tasks (bounded, spaced, read-only portal probes) so a submission that DID
    // go through gets confirmed autonomously instead of waiting for a human.
    let verificationRecheckSummary = null
    try {
      const { runSubmissionVerificationSweep } = await import('./hamiltonSubmissionVerifier.js')
      verificationRecheckSummary = await runSubmissionVerificationSweep(db, { limit: resolveBatchSize() })
      if (verificationRecheckSummary?.checked > 0) {
        logger?.info?.('[hamilton:scheduler] submission verification re-check', verificationRecheckSummary)
      }
    } catch (err) {
      logger?.warn?.('[hamilton:scheduler] submission verification re-check failed:', err?.message || err)
    }

    const summary = result?.summary || {}
    if ((summary.attempted || 0) > 0) {
      // no_run is the honest half of this line: `processed` only means the call
      // returned, and prod spent 32+ hours logging processed:5/failed:0 while
      // opening zero autopilot runs. When nothing opened a run the line must
      // say so, with the reasons.
      logger?.[summary.no_run === summary.attempted ? 'warn' : 'info']?.('[hamilton:scheduler] tick', {
        attempted: summary.attempted,
        processed: summary.processed,
        no_run: summary.no_run,
        no_run_reasons: summary.no_run_reasons,
        failed: summary.failed,
        blocked: summary.blocked,
      })
    }
    return { ran: true, result, verification: verificationSummary, keepAlive: keepAliveSummary, autonomySweeps, submissionVerification: verificationRecheckSummary }
  } catch (err) {
    logger?.warn?.('[hamilton:scheduler] tick failed:', err?.message || err)
    return { ran: false, error: err?.message || String(err) }
  } finally {
    running = false
  }
}

/**
 * Arm the poller if the env gates allow. Safe to call multiple times; a second
 * call while already armed is a no-op. Returns a small status object mirroring
 * the other agent schedulers.
 */
export function startHamiltonScheduler({ db, logger = console } = {}) {
  stopped = false
  if (timer) return { started: false, reason: 'already_started' }
  if (!envFlagEnabled(process.env.HAMILTON_RUN_ON_SCHEDULE, true)) {
    return { started: false, reason: 'HAMILTON_RUN_ON_SCHEDULE=false' }
  }
  if (!isBrowserAutomationEnabled()) {
    return { started: false, reason: 'HAMILTON_ENABLE_BROWSER_AUTOMATION!=true' }
  }

  const intervalMs = resolveIntervalMs()
  timer = setInterval(() => {
    tick({ db, logger }).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  // Kick one tick shortly after boot instead of waiting a full interval: a
  // redeploy interrupts any in-process Hamilton batch, and this makes the
  // queue (plus the recovery sweep inside tick) resume within a minute of the
  // new container coming up rather than after the first 5-minute poll.
  const kickoff = setTimeout(() => {
    tick({ db, logger }).catch(() => {})
  }, 45 * 1000)
  if (typeof kickoff.unref === 'function') kickoff.unref()

  return { started: true, intervalMs, batchSize: resolveBatchSize() }
}

export function stopHamiltonScheduler() {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
    return { stopped: true }
  }
  return { stopped: false }
}

// Test-only: clear the module-level run/stop flags so a test that drives
// tick() directly isn't affected by a prior stopHamiltonScheduler() call.
function _resetState() {
  stopped = false
  running = false
}

export const __testing__ = {
  tick,
  shouldRunOnSchedule,
  resolveIntervalMs,
  resolveBatchSize,
  _resetState,
}
