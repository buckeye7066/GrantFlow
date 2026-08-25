/**
 * amyScheduler.js
 *
 * Background runner for Amy, the synthetic crawler-training agent.
 * ON by default (owner directive 2026-06-29); opt out with AMY_ENABLED=false.
 * When enabled it keeps a durable once-per-day freshness target and generates
 * a target number of synthetic profiles — default 100 —
 * across all categories, runs them through Crawler-OS discovery, writes an
 * Anya handoff report, and cleans up the synthetic profiles.
 *
 * Env:
 *   AMY_ENABLED                 master switch (default true — owner directive).
 *                               Set AMY_ENABLED=false to turn the agent off.
 *   AMY_RUN_ON_SCHEDULE         daily run (default true when enabled)
 *   AMY_RUN_ON_STARTUP          force one run ~60s after EVERY boot (default
 *                               false — the overdue catch-up below already runs
 *                               a missed daily run shortly after boot, so every
 *                               redeploy does not fire a full run)
 *   AMY_DAILY_PROFILE_TARGET    profiles per day (default 100)
 *   AMY_PERSIST                 store discovered opportunities in the live catalog
 *                               (funding_opportunities) so agent Robert can parse
 *                               them (default true). The synthetic profile + its
 *                               scoped matches are still cleaned up; the real,
 *                               reality-gated, deduped opportunities are retained.
 *                               It ALSO gates the durable learning writes
 *                               (flywheel cohort, probe coverage, approval
 *                               ledger), so AMY_PERSIST=false is a run that
 *                               LEARNS NOTHING — an explicit measurement-only
 *                               opt-out, never a default.
 *   AMY_KEEP_PROFILES           leave profiles for Sam instead of auto-clean (default false)
 *   AMY_FLOOR                   match score floor for the crawler event (default DEFAULT_MIN_SCORE slider)
 *   AMY_IMPROVE                 run the Anya→Sam chain + tuning measurement (default true)
 *   AMY_APPLY_TUNING            auto-apply the proven, reversible floor change (default true)
 *   AMY_APPLY_WEIGHTS           auto-apply scoring-weight edits, re-crawl validated (default true)
 *   AMY_APPLY_COVERAGE          auto-apply additive source-coverage edits, validated (default true)
 *   AMY_APPLY_LEARNING          record per-archetype query-steering lessons the
 *                               live crawl consumes (additive-only; default true)
 *   AMY_GAP_LEARNING            refresh the fleet Coverage & Evidence gap
 *                               scoreboard at the start of each run and derive
 *                               Amy's cohort/task queue from it — gap-weighted
 *                               archetypes + adapter wishlist (default true;
 *                               owner directive 2026-07-06)
 *   AMY_GAP_SCAN_LIMIT          max active profiles scanned for the scoreboard
 *                               (default 100, capped 500)
 *   AMY_ANYA_APPLY              let Anya write code fixes (default false → analysis only)
 *   AMY_SAM_APPLY               let Sam apply+save its safe fixes (default true)
 *   AMY_INTERVAL_MS             override the report-freshness target (default 24h)
 *   AMY_FRESHNESS_POLL_MS       shorten the freshness poll (default/max hourly;
 *                               testing/ops only). The poll never launches Amy
 *                               while the latest completed report is still fresh.
 *
 * Safety: at most one run at a time (in-memory flag + DB scheduler lock); never
 * crashes the server; never blocks startup.
 *
 * NOT dry-run by default — the line here used to claim it was, and
 * `getAmyConfig()` below has read `AMY_PERSIST` with a default of TRUE for as
 * long as that comment has been wrong. A scheduled run DOES store the real,
 * reality-gated, deduped opportunities it discovers (the synthetic profile and
 * its scoped matches are still reaped), and `dryRunDiscovery` also gates the
 * three durable learning writes — flywheel cohort, probe coverage, approval
 * ledger — so a "dry" run is a run that learns nothing. `AMY_PERSIST=false` is
 * an explicit measurement-only opt-out, never the default.
 */

import { launchAmyRun } from './amyRunner.js'
import { readLatestAmyReport } from './amyReportStore.js'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
export const AMY_REPORT_FUTURE_TOLERANCE_MS = HOUR_MS

let _interval = null
let _stopped = false

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt
  return /^(1|true|yes|on)$/i.test(String(v))
}

export function getAmyConfig() {
  // ON by default (owner directive 2026-06-29). Amy is a login-independent
  // background agent: the scheduler starts at server boot (not on any user
  // login) and runs daily. Discovery PERSISTS by default (AMY_PERSIST=true, see
  // `persist` below — this comment used to say the opposite) and all tuning is
  // proven + reversible. Disable explicitly with AMY_ENABLED=false.
  const enabled = bool(process.env.AMY_ENABLED, true)
  const intervalMs = Number(process.env.AMY_INTERVAL_MS) > 0 ? Number(process.env.AMY_INTERVAL_MS) : DAY_MS
  const configuredPollMs = Number(process.env.AMY_FRESHNESS_POLL_MS)
  const requestedPollMs = configuredPollMs > 0 ? configuredPollMs : HOUR_MS
  return {
    enabled,
    runOnSchedule: bool(process.env.AMY_RUN_ON_SCHEDULE, true),
    runOnStartup: bool(process.env.AMY_RUN_ON_STARTUP, false),
    dailyTarget: Math.max(1, Math.min(5000, Number(process.env.AMY_DAILY_PROFILE_TARGET) || 100)),
    // Store discovered opportunities in funding_opportunities so Robert can parse
    // them. Real, reality-gated, deduped funding sources — not synthetic noise.
    persist: bool(process.env.AMY_PERSIST, true),
    keepProfiles: bool(process.env.AMY_KEEP_PROFILES, false),
    floor: process.env.AMY_FLOOR !== undefined ? Number(process.env.AMY_FLOOR) : undefined,
    improve: bool(process.env.AMY_IMPROVE, true),
    applyTuning: bool(process.env.AMY_APPLY_TUNING, true),
    applyWeights: bool(process.env.AMY_APPLY_WEIGHTS, true),
    applyCoverage: bool(process.env.AMY_APPLY_COVERAGE, true),
    applyLearning: bool(process.env.AMY_APPLY_LEARNING, true),
    gapLearning: bool(process.env.AMY_GAP_LEARNING, true),
    gapScanLimit: Math.max(1, Math.min(500, Number(process.env.AMY_GAP_SCAN_LIMIT) || 100)),
    anyaApply: bool(process.env.AMY_ANYA_APPLY, false),
    samApply: bool(process.env.AMY_SAM_APPLY, true),
    intervalMs,
    // Poll hourly in production. A deliberately shorter due interval used by
    // tests/ops must remain observable, so never poll slower than that target.
    freshnessPollMs: Math.min(HOUR_MS, intervalMs, requestedPollMs),
  }
}

/**
 * Kick off the full daily run (target profiles → crawl → Anya analysis → Sam
 * edits) in the BACKGROUND via the shared single-flight launcher. The launcher
 * owns the in-memory + DB lock so this never double-runs with a manual run.
 */
function kickOff({ db, logger, source = 'scheduler' }) {
  if (_stopped) return
  const cfg = getAmyConfig()
  return launchAmyRun({
    db,
    logger,
    source,
    opts: {
      targetCount: cfg.dailyTarget,
      dryRunDiscovery: !cfg.persist,
      keepProfiles: cfg.keepProfiles,
      floor: cfg.floor,
      improve: cfg.improve,
      applyTuning: cfg.applyTuning,
      applyWeights: cfg.applyWeights,
      applyCoverage: cfg.applyCoverage,
      applyLearning: cfg.applyLearning,
      gapLearning: cfg.gapLearning,
      gapScanLimit: cfg.gapScanLimit,
      anyaApply: cfg.anyaApply,
      samApply: cfg.samApply,
    },
  })
}

/**
 * True when the latest durable completed report has reached its freshness
 * deadline. A missing/invalid report is due. Small forward skew is tolerated,
 * but an implausibly future timestamp is due so one bad clock/write cannot
 * suppress Amy forever.
 */
export function isAmyReportDue(latest, { intervalMs = DAY_MS, nowMs = Date.now() } = {}) {
  const lastMs = latest?.completed_at ? Date.parse(latest.completed_at) : NaN
  if (!Number.isFinite(lastMs)) return true
  const targetMs = Number(intervalMs) > 0 ? Number(intervalMs) : DAY_MS
  const currentMs = Number(nowMs)
  if (!Number.isFinite(currentMs)) return true
  const ageMs = currentMs - lastMs
  if (ageMs < -AMY_REPORT_FUTURE_TOLERANCE_MS) return true
  return ageMs >= targetMs
}

/**
 * One scheduler tick: read durable freshness first and launch only when due.
 * A lock-held launch writes no completed report, so the report remains due and
 * the next hourly tick retries automatically. Local state + the DB lock still
 * guarantee that the retry cannot overlap a live Amy run.
 */
export async function runAmyFreshnessCheck({
  db,
  logger = console,
  intervalMs = getAmyConfig().intervalMs,
  source = 'scheduler',
  nowMs = Date.now(),
} = {}) {
  if (_stopped) return { triggered: false, reason: 'scheduler_stopped' }
  try {
    const latest = await readLatestAmyReport(db)
    if (isAmyReportDue(latest, { intervalMs, nowMs })) {
      const completedMs = Date.parse(latest?.completed_at || '')
      const reason = !Number.isFinite(completedMs)
        ? 'no_prior_run'
        : completedMs - Number(nowMs) > AMY_REPORT_FUTURE_TOLERANCE_MS
          ? 'future_timestamp'
          : 'overdue'
      logger?.info?.('amy.scheduler.freshness_due', {
        source,
        reason,
        last_run_at: latest?.completed_at || null,
      })
      const launch = kickOff({ db, logger, source })
      return { triggered: true, reason, last_run_at: latest?.completed_at || null, launch }
    }
    logger?.info?.('amy.scheduler.freshness_skip', { source, last_run_at: latest?.completed_at || null })
    return { triggered: false, reason: 'report_fresh', last_run_at: latest?.completed_at || null }
  } catch (err) {
    logger?.error?.('amy.scheduler.freshness_error', { source, message: String(err?.message || err) })
    return { triggered: false, reason: 'freshness_check_failed', error: String(err?.message || err) }
  }
}

/**
 * Start the Amy scheduler if env allows. Safe to call multiple times.
 */
export function startAmyScheduler({ db, logger = console } = {}) {
  _stopped = false
  const cfg = getAmyConfig()
  if (!cfg.enabled) return { started: false, reason: 'amy_disabled' }
  if (!cfg.runOnSchedule && !cfg.runOnStartup) {
    return { started: false, reason: 'no_runtime_triggers_enabled' }
  }

  if (cfg.runOnStartup) {
    // Explicit "always run on boot" opt-in.
    const initial = setTimeout(() => kickOff({ db, logger, source: 'startup' }), 60 * 1000)
    if (typeof initial.unref === 'function') initial.unref()
  } else if (cfg.runOnSchedule) {
    // Default path: only run on boot if the daily run is actually overdue, so a
    // freshly-deployed (or frequently-redeployed) service still gets its daily
    // run without anyone logged in — but redeploy bursts don't pile up runs.
    const catchUp = setTimeout(() => {
      void runAmyFreshnessCheck({ db, logger, intervalMs: cfg.intervalMs, source: 'startup' })
    }, 90 * 1000)
    if (typeof catchUp.unref === 'function') catchUp.unref()
  }
  if (cfg.runOnSchedule) {
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => {
      void runAmyFreshnessCheck({ db, logger, intervalMs: cfg.intervalMs, source: 'scheduler' })
    }, cfg.freshnessPollMs)
    if (typeof _interval.unref === 'function') _interval.unref()
  }
  return {
    started: true,
    daily_target: cfg.dailyTarget,
    interval_ms: cfg.intervalMs,
    poll_interval_ms: cfg.freshnessPollMs,
    persist: cfg.persist,
  }
}

export function stopAmyScheduler() {
  _stopped = true
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

export default {
  startAmyScheduler,
  stopAmyScheduler,
  getAmyConfig,
  AMY_REPORT_FUTURE_TOLERANCE_MS,
  isAmyReportDue,
  runAmyFreshnessCheck,
}
