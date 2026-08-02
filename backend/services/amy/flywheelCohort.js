/**
 * flywheelCohort.js — the daily scoreboard for Amy's crawler-training flywheel.
 *
 * The flywheel's purpose: Amy creates synthetic profiles across every scope the
 * product serves and crawls them so eligibility/coverage blind spots surface as
 * per-profile FINDINGS (amyReport.evaluateDiscovery) instead of on real
 * clients. This module folds each run's evaluations into a per-ET-day cohort
 * scoreboard (system_kv `amy_flywheel_cohort`), where a profile is CLEAN only
 * when its crawl produced qualified results with zero findings — the
 * goals-and-rules bar, not just "didn't crash".
 *
 * The owner's standing directive (2026-07-05): run the flywheel at the daily
 * target until a FULL day's cohort comes back with every profile clean, then
 * notify — that's the signal the crawlers are optimized across all profile
 * types. The one-shot notification is gated by a durable flag in the store so
 * it fires exactly once; the daily digest (anyaDailyOwnerReport) reads this
 * store every morning either way.
 */

import { sendEmail as defaultSendEmail } from '../email.js'
import { ADMIN_EMAIL } from '../../config/constants.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('amy:flywheelCohort')

/** system_kv key holding the rolling per-day cohort scoreboard. */
export const KV_KEY = 'amy_flywheel_cohort'

/** How many ET-day buckets to retain. */
export const RETENTION_DAYS = 21

/** Cap on stored issue examples per day (observability, not a ledger). */
const ISSUE_EXAMPLE_CAP = 15
// Per-example finding evidence retention (see issue_examples below): enough to
// name the missed schools / accepted titles, small enough that a 15-example
// day stays a few KB in system_kv.
const FINDING_EVIDENCE_PER_EXAMPLE = 4
const FINDING_EVIDENCE_EXCERPT_CHARS = 240

/** The owner's configured daily target (same env knob the scheduler uses). */
export function dailyTarget() {
  const n = Number(process.env.AMY_DAILY_PROFILE_TARGET)
  if (!Number.isFinite(n)) return 100
  return Math.max(1, Math.min(5000, Math.trunc(n)))
}

/** ET calendar day key (YYYY-MM-DD) — cohort days are owner-clock days. */
export function etDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)
}

/** A profile evaluation is CLEAN only at the goals/rules bar. */
export function isCleanEvaluation(evaluation) {
  if (!evaluation) return false
  if (evaluation.status !== 'ok') return false
  return !(Array.isArray(evaluation.findings) && evaluation.findings.length > 0)
}

/**
 * PURE: fold one run's evaluations into the rolling store.
 *
 * @returns {{ store: object, day: object, goal_reached_now: boolean, duplicate: boolean }}
 *   goal_reached_now — this fold made today's cohort complete AND fully clean
 *   (regardless of the notified flag; the caller decides whether to notify).
 *   duplicate — this runId was ALREADY folded into this day: the store is
 *   returned unchanged and no counter moves. Only the runs[] list used to be
 *   deduped, so re-folding a run double-counted evaluated/clean/issues, could
 *   falsely trip day.complete, and could fire the one-shot owner GOAL
 *   notification on inflated numbers.
 */
export function buildCohortUpdate(prev, { dayKey, target, runId = null, at = null, evaluations = [] } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const days = { ...(base.days && typeof base.days === 'object' ? base.days : {}) }
  const prevDay = days[dayKey] && typeof days[dayKey] === 'object' ? days[dayKey] : {}

  // Idempotence: a runId already folded into this day is a duplicate fold —
  // return the store unchanged BEFORE any counter increments.
  if (runId && Array.isArray(prevDay.runs) && prevDay.runs.includes(runId)) {
    return {
      store: {
        days,
        goal_notified_at: base.goal_notified_at ?? null,
        updated_at: base.updated_at ?? null,
      },
      day: { ...prevDay },
      goal_reached_now: false,
      duplicate: true,
    }
  }

  const day = {
    day: dayKey,
    target: Number(target) > 0 ? Number(target) : Number(prevDay.target) || 0,
    evaluated: Number(prevDay.evaluated) || 0,
    clean: Number(prevDay.clean) || 0,
    issues: Number(prevDay.issues) || 0,
    finding_types: { ...(prevDay.finding_types || {}) },
    runs: Array.isArray(prevDay.runs) ? [...prevDay.runs] : [],
    issue_examples: Array.isArray(prevDay.issue_examples) ? [...prevDay.issue_examples] : [],
  }
  if (runId && !day.runs.includes(runId)) day.runs.push(runId)

  for (const ev of Array.isArray(evaluations) ? evaluations : []) {
    day.evaluated += 1
    if (isCleanEvaluation(ev)) {
      day.clean += 1
      continue
    }
    day.issues += 1
    const types = (Array.isArray(ev?.findings) && ev.findings.length > 0)
      ? [...new Set(ev.findings.map((f) => String(f?.type || 'unknown')))]
      : [`status_${ev?.status || 'unknown'}`]
    for (const t of types) day.finding_types[t] = (Number(day.finding_types[t]) || 0) + 1
    if (day.issue_examples.length < ISSUE_EXAMPLE_CAP) {
      day.issue_examples.push({
        scenario: ev?.label || ev?.scenario_id || null,
        category: ev?.category || null,
        status: ev?.status || null,
        types,
        // The CONCRETE evidence (the missed school names, the accepted
        // ineligible titles, the amount-less rows) — bounded. Without this the
        // store retains only type COUNTS while the synthetic profiles and
        // their match rows are reaped next run, so a day-old cohort failure is
        // unattributable post-hoc (measured 2026-08-02: the 2026-08-01 day's
        // 13 issues could not be traced to a single title). A finding must
        // name work someone can do — and outlive the reaper.
        findings: (Array.isArray(ev?.findings) ? ev.findings : [])
          .slice(0, FINDING_EVIDENCE_PER_EXAMPLE)
          .map((f) => ({
            type: String(f?.type || 'unknown'),
            excerpt: String(f?.excerpt ?? f?.message ?? '').slice(0, FINDING_EVIDENCE_EXCERPT_CHARS) || null,
          })),
      })
    }
  }

  day.complete = day.target > 0 && day.evaluated >= day.target
  day.all_clean = day.evaluated > 0 && day.issues === 0
  days[dayKey] = day

  // Retention: keep the most recent RETENTION_DAYS keys (ISO keys sort).
  const keep = Object.keys(days).sort().slice(-RETENTION_DAYS)
  const trimmed = Object.fromEntries(keep.map((k) => [k, days[k]]))

  return {
    store: {
      days: trimmed,
      goal_notified_at: base.goal_notified_at ?? null,
      updated_at: at ?? base.updated_at ?? null,
    },
    day,
    goal_reached_now: day.complete && day.all_clean,
    duplicate: false,
  }
}

function goalRecipient() {
  const v = (
    process.env.AMY_FLYWHEEL_REPORT_EMAIL ||
    process.env.ANYA_DAILY_REPORT_EMAIL ||
    ADMIN_EMAIL ||
    ''
  ).trim()
  return v || 'buckeye7066@gmail.com'
}

function goalEmail(day) {
  const subject = `[GrantFlow] Amy flywheel GOAL reached — all ${day.evaluated} synthetic profiles clean`
  const text = [
    'Amy\'s crawler-training flywheel hit the goal you set:',
    '',
    `Every one of today's ${day.evaluated} synthetic profiles (target ${day.target}) came back with`,
    'ZERO issues against the goals/rules bar — qualified results, no eligibility leaks, no',
    'coverage gaps (institution/hyperlocal), no field-mapping misses, no zero-results.',
    '',
    `ET day: ${day.day}`,
    `Runs contributing: ${day.runs.join(', ') || 'n/a'}`,
    '',
    'The crawlers are now clean across every profile scope Amy generates. Daily cohorts and',
    'any future regressions continue to appear in Anya\'s morning report.',
  ].join('\n')
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;">
      <h2 style="margin:0 0 8px;">🎯 Amy flywheel goal reached</h2>
      <p style="font-size:14px;">Every one of today's <strong>${day.evaluated}</strong> synthetic profiles
      (target ${day.target}) came back <strong style="color:#16a34a;">clean</strong> against the goals/rules bar —
      qualified results, no eligibility leaks, no institution/hyperlocal coverage gaps, no field-mapping
      misses, no zero-results.</p>
      <p style="font-size:13px;color:#64748b;">ET day ${day.day} · runs: ${day.runs.join(', ') || 'n/a'}</p>
      <p style="font-size:13px;color:#334155;">The crawlers are now clean across every profile scope Amy
      generates. Daily cohorts and any future regressions continue to appear in Anya's morning report.</p>
    </div>`
  return { subject, text, html }
}

async function ensureKv(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
}

/** Read the rolling cohort store (Sam check / Anya digest / admin). */
export async function getFlywheelCohort(db) {
  if (!db?.prepare) return null
  try {
    await ensureKv(db)
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    return row?.value ? JSON.parse(row.value) : null
  } catch {
    return null
  }
}

/**
 * Record one Amy run's evaluations into the daily cohort; send the one-shot
 * goal-reached owner email the first time a full day's cohort is 100% clean.
 * Best-effort: never throws (scoreboard failures must never fail a training run).
 */
export async function recordFlywheelCohort(db, {
  evaluations = [],
  runId = null,
  at = null,
  now = null,
  target = null,
  send = defaultSendEmail,
} = {}) {
  if (!db?.prepare) return { ok: false, skipped: true }
  try {
    await ensureKv(db)
    const when = now instanceof Date ? now : (at ? new Date(at) : new Date())
    const dayKey = etDayKey(when)
    const prevRow = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    const prev = prevRow?.value ? JSON.parse(prevRow.value) : null

    const { store, day, goal_reached_now, duplicate } = buildCohortUpdate(prev, {
      dayKey,
      target: Number(target) > 0 ? Number(target) : dailyTarget(),
      runId,
      at: at ?? when.toISOString(),
      evaluations,
    })

    // Duplicate fold (same runId already recorded today): the store is
    // unchanged — nothing to persist, never notify.
    if (duplicate) {
      log.warn('flywheel cohort fold skipped: runId already recorded for this day', { run_id: runId, day: dayKey })
      return { ok: true, day, goal_reached: false, notified: false, duplicate: true }
    }

    let notified = false
    if (goal_reached_now && !store.goal_notified_at) {
      const to = goalRecipient()
      const { subject, text, html } = goalEmail(day)
      const res = await send({ to, subject, text, html }).catch((err) => ({ ok: false, error: err?.message }))
      if (res?.ok) {
        store.goal_notified_at = when.toISOString()
        notified = true
        log.info('flywheel goal-reached notification sent', { to, day: day.day, evaluated: day.evaluated })
      } else if (!res?.skipped) {
        log.warn('flywheel goal-reached notification failed (will retry next qualifying run)', { error: res?.error })
      }
    }

    const value = JSON.stringify(store)
    const ts = when.toISOString()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, ts, KV_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(KV_KEY, value, ts)
    }
    return { ok: true, day, goal_reached: goal_reached_now, notified, duplicate: false }
  } catch (err) {
    log.warn('flywheel cohort record failed (non-fatal)', { error: err?.message })
    return { ok: false, error: err?.message }
  }
}

export default {
  KV_KEY,
  RETENTION_DAYS,
  dailyTarget,
  etDayKey,
  isCleanEvaluation,
  buildCohortUpdate,
  getFlywheelCohort,
  recordFlywheelCohort,
}
