/**
 * amyScheduler.js
 *
 * Optional background runner for Amy, the synthetic crawler-training agent.
 * Disabled by default (like every sibling agent). When enabled it runs ONCE
 * per day and generates a target number of synthetic profiles — default 100 —
 * across all categories, runs them through Crawler-OS discovery, writes an
 * Anya handoff report, and cleans up the synthetic profiles.
 *
 * Env:
 *   AMY_ENABLED                 master switch (default false)
 *   AMY_RUN_ON_SCHEDULE         daily run (default true when enabled)
 *   AMY_RUN_ON_STARTUP          one run shortly after boot (default false)
 *   AMY_DAILY_PROFILE_TARGET    profiles per day (default 100)
 *   AMY_PERSIST                 flush discovery to live catalog (default false → dry-run)
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

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAmyTraining } from './amyAgent.js'
import { runWithSchedulerLock } from '../schedulerLock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../')
const DAY_MS = 24 * 60 * 60 * 1000

let _running = false
let _interval = null
let _stopped = false

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt
  return /^(1|true|yes|on)$/i.test(String(v))
}

export function getAmyConfig() {
  const enabled = bool(process.env.AMY_ENABLED, false)
  return {
    enabled,
    runOnSchedule: bool(process.env.AMY_RUN_ON_SCHEDULE, true),
    runOnStartup: bool(process.env.AMY_RUN_ON_STARTUP, false),
    dailyTarget: Math.max(1, Math.min(5000, Number(process.env.AMY_DAILY_PROFILE_TARGET) || 100)),
    persist: bool(process.env.AMY_PERSIST, false),
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

async function makeArtifactWriter() {
  const dir = path.join(REPO_ROOT, 'audit-reports')
  await fs.mkdir(dir, { recursive: true })
  return async (relName, jsonStr) => {
    const full = path.join(dir, relName)
    await fs.writeFile(full, jsonStr, 'utf8')
    return path.relative(REPO_ROOT, full)
  }
}

async function kickOff({ db, logger }) {
  if (_stopped || _running) return
  _running = true
  try {
    await runWithSchedulerLock(db, { lockName: 'amy:training', ttlMs: 2 * 60 * 60 * 1000, logger }, async () => {
      const cfg = getAmyConfig()
      let writeArtifact = null
      try {
        writeArtifact = await makeArtifactWriter()
      } catch {
        writeArtifact = null
      }
      const out = await runAmyTraining({
        db,
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
        writeArtifact,
        logger,
      })
      if (logger?.info) {
        logger.info('amy.scheduler.run', {
          run_id: out.run_id,
          target: cfg.dailyTarget,
          ...out.summary,
          tuned: out.combined?.tuning?.applied?.applied ? `${out.combined.tuning.from}->${out.combined.tuning.to}` : 'none',
          approvals: out.combined?.approval_queue?.length ?? 0,
          cleaned: out.cleanup?.deleted ?? 0,
          handoff: out.artifacts?.handoffPath || null,
        })
      }
      return out
    })
  } catch (err) {
    if (logger?.error) logger.error('amy.scheduler.error', { message: String(err?.message || err) })
  } finally {
    _running = false
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
    const initial = setTimeout(() => kickOff({ db, logger }), 60 * 1000)
    if (typeof initial.unref === 'function') initial.unref()
  }
  if (cfg.runOnSchedule) {
    if (_interval) clearInterval(_interval)
    _interval = setInterval(() => kickOff({ db, logger }), cfg.intervalMs)
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
