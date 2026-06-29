/**
 * samDailyCodeSweep.js — Sam's daily 05:00 ET full code/function sweep.
 *
 * This is the detection half of the Sam→Anya morning pipeline. It runs Sam's
 * HEAVY code/function checks (source-tree scan, broken-import crawl, ESLint,
 * mission/SQL-safety audit) and persists the findings to sam_runs, so:
 *   - the sam-autofix GitHub Action (separate, 05:00 ET) corrects the
 *     deterministically auto-fixable issues and ships them to production, and
 *   - Anya's 09:00 ET owner report reads these findings and emails the human a
 *     digest of what still needs attention.
 *
 * It runs in 'advise' mode with the heavy checks forced ON: that gives the full
 * code/function sweep + a repair plan, but is strictly READ-ONLY (no writes, and
 * crucially NOT the gatekeeper production gates, which would run `npm build`
 * inside the prod container). The durable fixing lives in CI, not here.
 *
 * Best-effort: never throws on the scheduler hot path. Gated by
 * SAM_DAILY_CODE_SWEEP_ENABLED (default on).
 */

import { runSam as defaultRunSam } from './samAgent.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('samDailyCodeSweep')

export function isSamDailyCodeSweepEnabled() {
  return String(process.env.SAM_DAILY_CODE_SWEEP_ENABLED ?? 'true').toLowerCase() !== 'false'
}

/**
 * Run the heavy code/function sweep. Returns a compact summary (and the run id,
 * which the scheduler stores in system_kv so Anya's report reads exactly this
 * run). `runSam` is injectable for tests.
 */
export async function runSamDailyCodeSweep(db, { force = false, runSam = defaultRunSam } = {}) {
  if (!force && !isSamDailyCodeSweepEnabled()) return { ran: false, reason: 'disabled' }
  if (!db?.prepare) return { ran: false, reason: 'no_db' }

  let out = null
  try {
    out = await runSam({
      db,
      mode: 'advise', // read-only: heavy diagnostics + repair plan, no writes, no prod gates
      includeHeavy: true, // force the full code/function sweep (gatekeeper-class checks)
      dryRun: true,
      trigger: 'scheduled',
      persist: true,
    })
  } catch (err) {
    log.warn('daily code sweep failed', { error: err?.message })
    return { ran: false, reason: 'exception', error: String(err?.message || err) }
  }

  const findings = Array.isArray(out?.findings) ? out.findings : []
  const by = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) if (by[f?.severity] !== undefined) by[f.severity] += 1

  const summary = {
    ran: true,
    run_id: out?.run_id || null,
    status: out?.status || null,
    health_score: out?.health_score ?? null,
    production_ready: out?.production_ready ?? null,
    findings_total: findings.length,
    by_severity: by,
    auto_fixable: findings.filter((f) => f?.safe_auto_fix_available === true).length,
  }
  log.info('daily code sweep complete', summary)
  return summary
}
