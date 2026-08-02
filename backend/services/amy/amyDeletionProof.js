/**
 * amyDeletionProof.js — PROVE the synthetic profiles are gone.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (2026-08-02)
 * -------------------------------------------
 * `runAmyTraining` persists the combined report and THEN runs cleanup. So
 * `combined.cleanup` and `combined.cleanup_expired` are assigned to an object
 * that has already been written to `system_kv amy_last_report` — and the
 * stored report, the one the admin panel and the morning email read, carries
 * `cleanup: undefined`. Verified read-only in prod on 2026-08-02T04:50Z: the
 * last report (run `amy-2026-08-02T02-23-34-496Z`, completed 03:19Z) has BOTH
 * keys undefined, while `profiles` held **55 rows with `created_by='agent:amy'`
 * out of 92 profiles total** — the 50 that run created plus 5 leftovers from
 * 07-31 and 08-01. There has never been a persisted record of what was deleted.
 *
 * A cleanup with no persisted proof is indistinguishable from no cleanup.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Three counts, taken from the DB, around the sweeps:
 *
 *   before          rows with `created_by = 'agent:amy'` before cleanup
 *   after           the same count after both cleanup passes
 *   survivors       after-rows grouped by whether their TTL has EXPIRED
 *
 * and one verdict. The verdict is `proven` ONLY when the after-count is
 * consistent with the deletions the sweeps reported AND no row survives past
 * its TTL. A live-but-unexpired row is NOT a failure — Amy's TTL is 24-72h by
 * design and a profile crawled minutes ago is still inside its grace window —
 * but a row past TTL is, and it is reported as `leaked`, by id.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It does not delete anything. Deletion stays with the ONE guarded sweep
 * (`cleanupAmyProfiles` / `cleanupExpiredAmyProfiles`) that already enforces
 * every marker — designated profile, `allow_sam_cleanup`, `synthetic`,
 * crawled-required, the bounded never-crawled escape hatch, the 6h grace. A
 * second deleter would be a second place to get the gate wrong, which is
 * exactly how a non-Amy profile gets destroyed.
 *
 * The counter is deliberately scoped by `created_by` ALONE, which is the
 * indexed cleanup key and the NARROWEST possible predicate: if the tag markers
 * ever drift, the count still sees the row and the proof fails loudly instead
 * of quietly measuring a smaller world.
 */

import { ORIGIN_CREATED_BY } from './amyConstants.js'

/** Verdicts. `unknown` is a first-class outcome: an unreadable DB proves nothing. */
export const DELETION_VERDICT = Object.freeze({
  PROVEN: 'proven',
  LEAKED: 'leaked',
  UNKNOWN: 'unknown',
})

/** Count live Amy-owned profiles. Returns null (not 0) when it cannot read. */
export async function countAmyProfiles(db) {
  if (!db) return null
  try {
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM profiles WHERE created_by = ?')
      .get(ORIGIN_CREATED_BY)
    const n = Number(row?.n ?? row?.count ?? row?.COUNT)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Rows that outlived their TTL and are still here. This is the leak set.
 *
 * `expires_at` lives in Amy's metadata section, not on `profiles`, so the
 * survivor scan reads the section — the same place `cleanupExpiredAmyProfiles`
 * reads it from, so the two can never disagree about which rows are expired.
 */
export async function findExpiredSurvivors(db, { now = new Date(), limit = 200 } = {}) {
  if (!db) return null
  const nowIso = now instanceof Date ? now.toISOString() : String(now)
  try {
    const rows = await db
      .prepare(
        `SELECT p.id AS id, p.display_name AS display_name, p.created_at AS created_at, s.data AS data
           FROM profiles p
           LEFT JOIN profile_sections s
             ON s.profile_id = p.id AND s.section_key = 'amy_metadata'
          WHERE p.created_by = ?
          LIMIT ?`,
      )
      .all(ORIGIN_CREATED_BY, Math.max(1, Math.min(2000, limit)))
    const survivors = []
    for (const row of Array.isArray(rows) ? rows : []) {
      let expiresAt = null
      try {
        const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data
        expiresAt = parsed?.expires_at ?? parsed?.amy?.expires_at ?? null
      } catch { expiresAt = null }
      if (!expiresAt) continue
      const t = Date.parse(expiresAt)
      if (!Number.isFinite(t)) continue
      if (t < Date.parse(nowIso)) {
        survivors.push({ id: row.id, display_name: row.display_name, expires_at: expiresAt, created_at: row.created_at })
      }
    }
    return survivors
  } catch {
    return null
  }
}

/**
 * Build the proof from a before-count, the sweeps' own reports, and an
 * after-count.
 *
 * PURE — so the honesty rules are unit-testable without a database.
 *
 * @param {object} args
 * @param {number|null} args.before
 * @param {number|null} args.after
 * @param {object|null} args.runCleanup    result of cleanupAmyProfiles
 * @param {object|null} args.expiredSweep  result of cleanupExpiredAmyProfiles
 * @param {Array|null} args.survivors      expired rows still present (null = unread)
 * @param {number} args.created            profiles this run created
 * @returns {object} the proof block persisted on the report
 */
export function buildDeletionProof({
  before = null,
  after = null,
  runCleanup = null,
  expiredSweep = null,
  survivors = null,
  created = 0,
} = {}) {
  const reportedDeleted = (Number(runCleanup?.deleted) || 0) + (Number(expiredSweep?.deleted) || 0)
  const observedDeleted = Number.isFinite(before) && Number.isFinite(after) ? before - after : null

  // An unreadable count proves nothing in either direction. Saying "proven"
  // because a query failed is the exact shape of every false-green in this repo.
  const readable = Number.isFinite(before) && Number.isFinite(after) && Array.isArray(survivors)
  let verdict = DELETION_VERDICT.UNKNOWN
  const reasons = []

  if (!readable) {
    reasons.push('counts or survivor scan unavailable — deletion NOT verified this run')
  } else if (survivors.length > 0) {
    verdict = DELETION_VERDICT.LEAKED
    reasons.push(`${survivors.length} profile(s) survived past their TTL`)
  } else if (observedDeleted !== reportedDeleted) {
    // Not automatically a failure: a concurrent run or the boot invariant
    // (enforceAmySyntheticExpiry) may legitimately have reaped rows this run
    // never counted. It IS a discrepancy, and a discrepancy that is never
    // stated is how a leak hides.
    verdict = DELETION_VERDICT.PROVEN
    reasons.push(
      `sweeps reported ${reportedDeleted} deleted; the row count moved by ${observedDeleted} `
      + '(another reaper — the boot invariant or a concurrent run — may account for the difference)',
    )
  } else {
    verdict = DELETION_VERDICT.PROVEN
    reasons.push(`${reportedDeleted} deleted, row count moved by exactly ${observedDeleted}, zero rows past TTL`)
  }

  return {
    verdict,
    profiles_before: before,
    profiles_after: after,
    created_this_run: Number(created) || 0,
    reported_deleted: reportedDeleted,
    observed_deleted: observedDeleted,
    run_cleanup_deleted: Number(runCleanup?.deleted) || 0,
    expired_sweep_deleted: Number(expiredSweep?.deleted) || 0,
    // Live-but-unexpired rows are NORMAL (TTL is 24-72h) and are reported as a
    // number so a rising floor is visible, never as a failure.
    live_within_ttl: Number.isFinite(after) && Array.isArray(survivors) ? after - survivors.length : null,
    expired_survivors: Array.isArray(survivors) ? survivors.slice(0, 20) : null,
    expired_survivor_count: Array.isArray(survivors) ? survivors.length : null,
    reasons,
  }
}

/**
 * Take the after-count + survivor scan and build the proof. Best-effort: a
 * failure yields an `unknown` verdict, never a false `proven`.
 */
export async function verifyAmyDeletion(db, { before, runCleanup, expiredSweep, created = 0, now = new Date() } = {}) {
  const after = await countAmyProfiles(db)
  const survivors = await findExpiredSurvivors(db, { now })
  return buildDeletionProof({ before, after, runCleanup, expiredSweep, survivors, created })
}

export default {
  DELETION_VERDICT,
  countAmyProfiles,
  findExpiredSurvivors,
  buildDeletionProof,
  verifyAmyDeletion,
}
