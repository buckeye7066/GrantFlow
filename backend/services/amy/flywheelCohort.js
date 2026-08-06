/**
 * flywheelCohort.js — the daily scoreboard for Amy's crawler-training flywheel.
 *
 * The flywheel's purpose: Amy creates synthetic profiles across every scope the
 * product serves and crawls them so eligibility/coverage blind spots surface as
 * per-profile FINDINGS (amyReport.evaluateDiscovery) instead of on real
 * clients. This module records isolated per-run receipts under an ET-day
 * scoreboard (system_kv `amy_flywheel_cohort`). A profile is CLEAN only when
 * its crawl has zero findings and every ACCEPT passes the bounded
 * synthetic-fixture oracle; this is regression evidence, never a claim that
 * the applicant qualifies or will receive an award.
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
const RUN_RECEIPT_CAP = 10
const RECEIPT_VERSION = 1

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
  if (Array.isArray(evaluation.findings) && evaluation.findings.length > 0) return false

  // ACCEPT is the match engine's decision, not independent qualification
  // proof. A clean Amy member must have every accepted opportunity exercised
  // by the bounded synthetic-fixture oracle in amyReport. Unknown/missing
  // evidence is explicitly not clean.
  const oracle = evaluation.opportunity_oracle
  const accepted = Number(evaluation.accepted)
  if (!Number.isInteger(accepted) || accepted <= 0) return false
  if (!oracle || oracle.status !== 'checked' || oracle.complete !== true) return false
  if (Number(oracle.accepted_claims) !== accepted) return false
  if (Number(oracle.checked_accepts) !== accepted) return false
  if (Number(oracle.unknown_accepts) !== 0 || Number(oracle.known_conflicts) !== 0) return false
  return true
}

function boundedTarget(target) {
  const n = Number(target)
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(5000, Math.trunc(n))) : 0
}

function memberId(value) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const id = value?.cohort_member_id ?? value?.scenario_id ?? value?.member_id
  return id === undefined || id === null || String(id).trim() === '' ? null : String(id).trim()
}

function evaluationMemberId(evaluation) {
  return memberId(evaluation)
}

function issueExample(evaluation) {
  const types = (Array.isArray(evaluation?.findings) && evaluation.findings.length > 0)
    ? [...new Set(evaluation.findings.map((finding) => String(finding?.type || 'unknown')))]
    : [`status_${evaluation?.status || 'unknown'}`]
  return {
    scenario: evaluation?.label || evaluationMemberId(evaluation),
    member_id: evaluationMemberId(evaluation),
    category: evaluation?.category || null,
    status: evaluation?.status || null,
    oracle_status: evaluation?.opportunity_oracle?.status || 'unavailable',
    types,
    findings: (Array.isArray(evaluation?.findings) ? evaluation.findings : [])
      .slice(0, FINDING_EVIDENCE_PER_EXAMPLE)
      .map((finding) => ({
        type: String(finding?.type || 'unknown'),
        excerpt: String(finding?.excerpt ?? finding?.message ?? '').slice(0, FINDING_EVIDENCE_EXCERPT_CHARS) || null,
      })),
  }
}

function outcomeFor(evaluation) {
  const status = String(evaluation?.status || '').toLowerCase()
  if (status === 'error') return 'errored'
  if (status === 'skipped') return 'skipped'
  if (!['ok', 'weak', 'zero'].includes(status)) return 'unevaluable'
  if (status === 'ok') {
    const oracleStatus = evaluation?.opportunity_oracle?.status
    if (!['checked', 'conflict'].includes(oracleStatus)) return 'unevaluable'
  }
  return isCleanEvaluation(evaluation) ? 'clean' : 'issue'
}

/**
 * PURE: build one isolated, auditable run receipt.
 *
 * Exactly-N means N planned member ids, exactly one evaluation row for every
 * member, and N evaluable outcomes. Errors, skips, missing rows, duplicates,
 * foreign-run rows, and bounded-oracle unknowns are reconciled separately and
 * can never be counted as clean.
 */
export function buildRunCohortReceipt({
  runId = null,
  target = null,
  expectedMembers = [],
  evaluations = [],
  at = null,
} = {}) {
  const requestedTarget = boundedTarget(target)
  const expectedIdsRaw = (Array.isArray(expectedMembers) ? expectedMembers : []).map(memberId)
  const invalidExpected = expectedIdsRaw.filter((id) => !id).length
  const expectedIds = expectedIdsRaw.filter(Boolean)
  const expectedSet = new Set(expectedIds)
  const expectedDuplicates = expectedIds.length - expectedSet.size
  const uniqueExpected = [...expectedSet]
  const byMember = new Map(uniqueExpected.map((id) => [id, []]))
  const unexpected = []
  const runMismatches = []

  for (const evaluation of Array.isArray(evaluations) ? evaluations : []) {
    const id = evaluationMemberId(evaluation)
    if (!runId || String(evaluation?.cohort_run_id || '') !== String(runId)) {
      runMismatches.push({ member_id: id, cohort_run_id: evaluation?.cohort_run_id ?? null })
      continue
    }
    if (!id || !expectedSet.has(id)) {
      unexpected.push({ member_id: id, cohort_run_id: evaluation?.cohort_run_id ?? null })
      continue
    }
    byMember.get(id).push(evaluation)
  }

  const outcomes = {
    clean: 0,
    issue: 0,
    errored: 0,
    skipped: 0,
    unevaluable: 0,
    missing: 0,
    duplicate: 0,
  }
  const findingTypes = {}
  const oracleExceptions = {}
  const issueExamples = []
  const members = []

  for (const id of uniqueExpected) {
    const rows = byMember.get(id) || []
    if (rows.length === 0) {
      outcomes.missing += 1
      members.push({ member_id: id, profile_id: null, outcome: 'missing', status: null, oracle_status: 'unavailable', finding_types: [] })
      continue
    }
    if (rows.length > 1) {
      outcomes.duplicate += 1
      members.push({ member_id: id, profile_id: rows[0]?.profile_id ?? null, outcome: 'duplicate', status: null, oracle_status: 'unavailable', finding_types: [] })
      continue
    }

    const evaluation = rows[0]
    const outcome = outcomeFor(evaluation)
    outcomes[outcome] += 1
    const types = [...new Set((evaluation.findings || []).map((finding) => String(finding?.type || 'unknown')))]
    for (const type of types) findingTypes[type] = (findingTypes[type] || 0) + 1
    for (const [type, count] of Object.entries(evaluation?.opportunity_oracle?.exception_classes || {})) {
      oracleExceptions[type] = (oracleExceptions[type] || 0) + Number(count || 0)
    }
    if (outcome !== 'clean' && issueExamples.length < ISSUE_EXAMPLE_CAP) issueExamples.push(issueExample(evaluation))
    members.push({
      member_id: id,
      profile_id: evaluation?.profile_id ?? null,
      outcome,
      status: evaluation?.status ?? null,
      oracle_status: evaluation?.opportunity_oracle?.status || 'unavailable',
      finding_types: types,
    })
  }

  const outcomeTotal = Object.values(outcomes).reduce((sum, count) => sum + Number(count || 0), 0)
  const evaluatedProfiles = outcomes.clean + outcomes.issue
  const targetMembershipGap = Math.abs(requestedTarget - uniqueExpected.length)
  const exceptionClasses = {
    ...(invalidExpected > 0 ? { invalid_expected_member: invalidExpected } : {}),
    ...(expectedDuplicates > 0 ? { duplicate_expected_member: expectedDuplicates } : {}),
    ...(outcomes.missing > 0 ? { missing_evaluation: outcomes.missing } : {}),
    ...(outcomes.duplicate > 0 ? { duplicate_evaluation: outcomes.duplicate } : {}),
    ...(outcomes.errored > 0 ? { crawler_error: outcomes.errored } : {}),
    ...(outcomes.skipped > 0 ? { discovery_skipped: outcomes.skipped } : {}),
    ...(outcomes.unevaluable > 0 ? { oracle_unevaluable: outcomes.unevaluable } : {}),
    ...(unexpected.length > 0 ? { unexpected_member: unexpected.length } : {}),
    ...(runMismatches.length > 0 ? { cohort_run_mismatch: runMismatches.length } : {}),
    ...(targetMembershipGap > 0 ? { target_membership_mismatch: targetMembershipGap } : {}),
    ...oracleExceptions,
  }
  const exceptionCount = Object.values(exceptionClasses).reduce((sum, count) => sum + Number(count || 0), 0)
  const membershipReconciles = outcomeTotal === uniqueExpected.length
  const rowReconciles = Array.isArray(evaluations) && evaluations.length === requestedTarget
  const complete = Boolean(runId) && requestedTarget > 0 &&
    uniqueExpected.length === requestedTarget && invalidExpected === 0 && expectedDuplicates === 0 &&
    unexpected.length === 0 && runMismatches.length === 0 && rowReconciles &&
    evaluatedProfiles === requestedTarget && membershipReconciles
  const allClean = complete && outcomes.clean === requestedTarget && exceptionCount === 0

  return {
    receipt_version: RECEIPT_VERSION,
    run_id: runId || null,
    recorded_at: at || null,
    requested_target: requestedTarget,
    planned_members: uniqueExpected.length,
    evaluation_rows: Array.isArray(evaluations) ? evaluations.length : 0,
    evaluated_profiles: evaluatedProfiles,
    clean: outcomes.clean,
    issues: Math.max(0, requestedTarget - outcomes.clean),
    issue_profiles: outcomes.issue,
    outcomes,
    finding_types: findingTypes,
    exception_classes: exceptionClasses,
    exception_count: exceptionCount,
    reconciliation: {
      membership_total: outcomeTotal,
      planned_members: uniqueExpected.length,
      requested_target: requestedTarget,
      evaluation_rows: Array.isArray(evaluations) ? evaluations.length : 0,
      clean_plus_nonclean: outcomeTotal,
      membership_reconciles: membershipReconciles,
      rows_equal_target: rowReconciles,
      target_membership_gap: targetMembershipGap,
    },
    membership_isolated: Boolean(runId) && runMismatches.length === 0 && unexpected.length === 0,
    complete,
    all_clean: allClean,
    qualification_proven: false,
    limitation: 'A clean receipt means the bounded synthetic regression and known-ineligibility oracle passed; it does not prove full eligibility, qualification, submission, or an award.',
    members,
    unexpected_members: unexpected.slice(0, 25),
    run_mismatches: runMismatches.slice(0, 25),
    issue_examples: issueExamples,
  }
}

/**
 * PURE: fold one run's evaluations into the rolling store.
 *
 * @returns {{ store: object, day: object, receipt: object, goal_reached_now: boolean, duplicate: boolean }}
 *   goal_reached_now — this fold made today's cohort complete AND fully clean
 *   (regardless of the notified flag; the caller decides whether to notify).
 *   duplicate — this runId was ALREADY folded into this day: the store is
 *   returned unchanged and no counter moves. Only the runs[] list used to be
 *   deduped, so re-folding a run double-counted evaluated/clean/issues, could
 *   falsely trip day.complete, and could fire the one-shot owner GOAL
 *   notification on inflated numbers.
 */
export function buildCohortUpdate(prev, {
  dayKey,
  target,
  runId = null,
  at = null,
  evaluations = [],
  expectedMembers = [],
} = {}) {
  const base = prev && typeof prev === 'object' ? prev : {}
  const days = { ...(base.days && typeof base.days === 'object' ? base.days : {}) }
  const prevDay = days[dayKey] && typeof days[dayKey] === 'object' ? days[dayKey] : {}

  // Idempotence: a runId already folded into this day is a duplicate fold —
  // return the store unchanged BEFORE any counter increments.
  if (runId && Array.isArray(prevDay.run_receipts) && prevDay.run_receipts.some((receipt) => receipt?.run_id === runId)) {
    const existingReceipt = prevDay.run_receipts.find((receipt) => receipt?.run_id === runId) || null
    return {
      store: {
        days,
        goal_notified_at: base.goal_notified_at ?? null,
        goal_notified_receipt_version: base.goal_notified_receipt_version ?? null,
        goal_notified_run_id: base.goal_notified_run_id ?? null,
        updated_at: base.updated_at ?? null,
      },
      day: { ...prevDay },
      receipt: existingReceipt,
      goal_reached_now: false,
      duplicate: true,
    }
  }

  const receipt = buildRunCohortReceipt({ runId, target, expectedMembers, evaluations, at })
  const receipts = [
    ...(Array.isArray(prevDay.run_receipts) ? prevDay.run_receipts : []),
    receipt,
  ].slice(-RUN_RECEIPT_CAP)
  const runs = receipts.map((item) => item.run_id).filter(Boolean)
  // The day surface is the latest isolated run receipt, never a sum of profiles
  // from unrelated runs. Historical receipts remain available below it.
  const day = {
    day: dayKey,
    target: receipt.requested_target,
    evaluated: receipt.evaluated_profiles,
    clean: receipt.clean,
    issues: receipt.issues,
    complete: receipt.complete,
    all_clean: receipt.all_clean,
    finding_types: receipt.finding_types,
    exception_classes: receipt.exception_classes,
    reconciliation: receipt.reconciliation,
    membership_isolated: receipt.membership_isolated,
    qualification_proven: false,
    runs,
    latest_run_id: receipt.run_id,
    issue_examples: receipt.issue_examples,
    run_receipts: receipts,
  }
  days[dayKey] = day

  // Retention: keep the most recent RETENTION_DAYS keys (ISO keys sort).
  const keep = Object.keys(days).sort().slice(-RETENTION_DAYS)
  const trimmed = Object.fromEntries(keep.map((k) => [k, days[k]]))

  return {
    store: {
      days: trimmed,
      goal_notified_at: base.goal_notified_at ?? null,
      goal_notified_receipt_version: base.goal_notified_receipt_version ?? null,
      goal_notified_run_id: base.goal_notified_run_id ?? null,
      updated_at: at ?? base.updated_at ?? null,
    },
    day,
    receipt,
    goal_reached_now: receipt.complete && receipt.all_clean,
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
  return v || null
}

function goalEmail(day) {
  const subject = `[GrantFlow] Amy flywheel GOAL reached — all ${day.evaluated} synthetic profiles clean`
  const text = [
    'Amy\'s crawler-training flywheel produced one complete, isolated run receipt:',
    '',
    `Every one of the run's ${day.evaluated} synthetic profiles (requested target ${day.target}) passed`,
    'the bounded regression and known-ineligibility oracle with zero findings or unknowns.',
    '',
    `ET day: ${day.day}`,
    `Cohort run: ${day.latest_run_id || 'n/a'}`,
    '',
    'This is regression evidence, not proof of full eligibility, qualification, submission, or an award.',
    'Daily cohorts and future regressions continue to appear in Anya\'s morning report.',
  ].join('\n')
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;color:#0f172a;">
      <h2 style="margin:0 0 8px;">🎯 Amy flywheel goal reached</h2>
      <p style="font-size:14px;">Every one of today's <strong>${day.evaluated}</strong> synthetic profiles
      (requested target ${day.target}) passed the bounded regression and known-ineligibility oracle with
      zero findings or unknowns.</p>
      <p style="font-size:13px;color:#64748b;">ET day ${day.day} · cohort run: ${day.latest_run_id || 'n/a'}</p>
      <p style="font-size:13px;color:#334155;">This is regression evidence, not proof of full eligibility,
      qualification, submission, or an award. Daily cohorts and future regressions continue to appear in
      Anya's morning report.</p>
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
  expectedMembers = [],
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

    const { store, day, receipt, goal_reached_now, duplicate } = buildCohortUpdate(prev, {
      dayKey,
      target: Number(target) > 0 ? Number(target) : dailyTarget(),
      runId,
      at: at ?? when.toISOString(),
      evaluations,
      expectedMembers,
    })

    // Duplicate fold (same runId already recorded today): the store is
    // unchanged — nothing to persist, never notify.
    if (duplicate) {
      log.warn('flywheel cohort fold skipped: runId already recorded for this day', { run_id: runId, day: dayKey })
      return { ok: true, day, receipt, goal_reached: false, notified: false, duplicate: true }
    }

    let notified = false
    // A legacy notification may have been sent from the old day-aggregate
    // counter. It is not evidence that an isolated exact-run receipt passed,
    // so only a notification carrying this receipt version suppresses another.
    if (goal_reached_now && Number(store.goal_notified_receipt_version) !== RECEIPT_VERSION) {
      const to = goalRecipient()
      const { subject, text, html } = goalEmail(day)
      const res = to
        ? await send({ to, subject, text, html }).catch((err) => ({ ok: false, error: err?.message }))
        : { ok: false, skipped: true, error: 'owner_email_not_configured' }
      if (res?.ok) {
        store.goal_notified_at = when.toISOString()
        store.goal_notified_receipt_version = RECEIPT_VERSION
        store.goal_notified_run_id = day.latest_run_id || null
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
    return { ok: true, day, receipt, goal_reached: goal_reached_now, notified, duplicate: false }
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
  buildRunCohortReceipt,
  buildCohortUpdate,
  getFlywheelCohort,
  recordFlywheelCohort,
}
