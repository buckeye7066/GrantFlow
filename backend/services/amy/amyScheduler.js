/**
 * amyScheduler.js
 *
 * Background runner for Amy, the synthetic crawler-training agent.
 * ON by default (owner directive 2026-06-29); opt out with AMY_ENABLED=false.
 * When enabled it runs ONCE
 * per day and generates a target number of synthetic profiles — default 100 —
 * across all categories, runs them through Crawler-OS discovery, writes an
 * Anya handoff report, and cleans up the synthetic profiles.
 *
 * Env:
 *   AMY_ENABLED                 master switch (default true — owner directive).
 *                               Set AMY_ENABLED=false to turn the agent off.
 *   AMY_RUN_ON_SCHEDULE         daily run (default true when enabled)
 *   AMY_RUN_ON_STARTUP          one run shortly after boot (default true, so an
 *                               enabled deploy actually runs without waiting 24h)
 *   AMY_DAILY_PROFILE_TARGET    profiles per day (default 100)
 *   AMY_PERSIST                 store discovered opportunities in the live catalog
 *                               (funding_opportunities) so agent Robert can parse
 *                               them (default true). The synthetic profile + its
 *                               scoped matches are still cleaned up; the real,
 *                               reality-gated, deduped opportunities are retained.
 *                               Set AMY_PERSIST=false for measurement-only dry runs.
 *   AMY_KEEP_PROFILES           leave profiles for Sam instead of auto-clean (default false)
 *   AMY_FLOOR                   match score floor for the crawler event (default 75 slider)
 *   AMY_IMPROVE                 run the Anya→Sam chain + tuning measurement (default true)
 *   AMY_APPLY_TUNING            auto-apply the proven, reversible floor change (default true)
 *   AMY_APPLY_WEIGHTS           auto-apply scoring-weight edits, re-crawl validated (default true)
 *   AMY_APPLY_COVERAGE          auto-apply additive source-coverage edits, validated (default true)
 *   AMY_ANYA_APPLY              let Anya write code fixes (default false → analysis only)
 *   AMY_SAM_APPLY               let Sam apply+save its safe fixes (default true)
 *   AMY_INTERVAL_MS             override the 24h cadence (testing/ops)
 *
 * Safety: at most one run at a time (in-memory flag + DB scheduler lock); never
 * crashes the server; never blocks startup; dry-run by default so it never
 * pollutes the live catalog.
 */

import { launchAmyRun } from './amyRunner.js'
import { readLatestAmyReport } from './amyReportStore.js'

const DAY_MS = 24 * 60 * 60 * 1000

let _interval = null
let _stopped = false

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt
  return /^(1|true|yes|on)$/i.test(String(v))
}

export function getAmyConfig() {
  // ON by default (owner directive 2026-06-29). Amy is a login-independent
  // background agent: the scheduler starts at server boot (not on any user
  // login) and runs daily. Discovery stays dry-run (AMY_PERSIST=false) and all
  // tuning is proven + reversible. Disable explicitly with AMY_ENABLED=false.
  const enabled = bool(process.env.AMY_ENABLED, true)
  return {
    enabled,
    runOnSchedule: bool(process.env.AMY_RUN_ON_SCHEDULE, true),
    runOnStartup: bool(process.env.AMY_RUN_ON_STARTUP, true),
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
    anyaApply: bool(process.env.AMY_ANYA_APPLY, false),
    samApply: bool(process.env.AMY_SAM_APPLY, true),
    intervalMs: Number(process.env.AMY_INTERVAL_MS) > 0 ? Number(process.env.AMY_INTERVAL_MS) : DAY_MS,
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
  launchAmyRun({
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
      anyaApply: cfg.anyaApply,
      samApply: cfg.samApply,
    },
  })
}

/**
 * Startup catch-up: setInterval never fires at t=0 and resets on every redeploy,
 * so on a service that redeploys more than daily, Amy could run NEVER. Shortly
 * after boot, if there is no successful report within the daily window, run once.
 * Gated on "overdue" so a burst of redeploys does not trigger redundant runs.
 */
async function runStartupCatchUpIfOverdue({ db, logger, intervalMs }) {
  if (_stopped) return
  try {
    const latest = await readLatestAmyReport(db).catch(() => null)
    const last = latest?.completed_at ? Date.parse(latest.completed_at) : NaN
    const graceMs = 60 * 60 * 1000 // 1h grace so we don't pre-empt a fresh run
    const overdue = !Number.isFinite(last) || (Date.now() - last) >= (intervalMs - graceMs)
    if (overdue) {
      logger?.info?.('amy.scheduler.startup_catchup', {
        reason: Number.isFinite(last) ? 'overdue' : 'no_prior_run',
        last_run_at: latest?.completed_at || null,
      })
      kickOff({ db, logger, source: 'startup' })
    } else {
      logger?.info?.('amy.scheduler.startup_skip', { last_run_at: latest?.completed_at || null })
    }
  } catch (err) {
    logger?.error?.('amy.scheduler.startup_catchup_error', { message: String(err?.message || err) })
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
    const catchUp = setTimeout(() => runStartupCatchUpIfOverdue({ db, logger, intervalMs: cfg.intervalMs }), 90 * 1000)
    if (typeof catchUp.unref === 'function') catchUp.unref()
  }
  if (cfg.runOnSchedule) {
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => kickOff({ db, logger, source: 'scheduler' }), cfg.intervalMs)
    if (typeof _interval.unref === 'function') _interval.unref()
  }
  return { started: true, daily_target: cfg.dailyTarget, interval_ms: cfg.intervalMs, persist: cfg.persist }
}

export function stopAmyScheduler() {
  _stopped = true
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

export default { startAmyScheduler, stopAmyScheduler, getAmyConfig }
