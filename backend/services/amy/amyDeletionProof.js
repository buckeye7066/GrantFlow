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
 * design and a profile crawled minutes ago is still inside its grace window.
 * A row past TTL is classified (2026-08-03): one the sweep is deliberately
 * holding under a documented guard (the 6h crawled grace / the bounded
 * never-crawled window) is `grace_held`; one NO guard explains is `leaked`,
 * by id. See DELETION_VERDICT below for why the split exists.
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
import {
  AMY_EXPIRED_SWEEP_MIN_CRAWLED_AGE_MS,
  amyNeverCrawledMaxAgeMs,
} from './amyProfileStore.js'

/**
 * Verdicts. `unknown` is a first-class outcome: an unreadable DB proves nothing.
 *
 * `grace_held` (2026-08-03): a row past its TTL that the sweep is DELIBERATELY
 * still holding under one of its own documented guards — the 6h crawled grace
 * or the bounded never-crawled window — is not a leak; it is the sweep working
 * as designed, and it will be reaped on the first pass after the guard lapses.
 * Verified against prod 2026-08-03: the two "leaked" survivors in the owner's
 * morning report (b9ca2567, 67b6f184) were skipped by the expired sweep with
 * reason `crawled_too_recently` (its own persisted telemetry in
 * `amy_last_report.cleanup_expired.skipped_ids`) — every marker intact, simply
 * inside the grace. Reporting that as LEAKED made a by-design hold read as a
 * cleanup failure, which is the alarm-that-can-never-go-green shape.
 *
 * The verdict does NOT go soft: a survivor no documented guard explains — bad
 * markers, a stale crawl signal the sweep should have reaped, or a row so old
 * (past AMY_NEVER_CRAWLED_MAX_AGE_HOURS) that riding consecutive grace windows
 * means it is being starved by perpetual re-discovery — stays LEAKED.
 */
export const DELETION_VERDICT = Object.freeze({
  PROVEN: 'proven',
  LEAKED: 'leaked',
  GRACE_HELD: 'grace_held',
  UNKNOWN: 'unknown',
})

/** Survivor hold classes — the documented guard that explains a past-TTL row. */
export const SURVIVOR_HOLD = Object.freeze({
  /** Crawled/discovered within the sweep's grace window (crawled_too_recently). */
  CRAWL_GRACE: 'crawl_grace',
  /** Never crawled, still inside the bounded never-crawled reap window. */
  NEVER_CRAWLED_WINDOW: 'never_crawled_window',
})

/**
 * Which documented sweep guard (if any) explains a past-TTL survivor.
 * PURE. Returns a SURVIVOR_HOLD value, or null — null means NO guard explains
 * the row and it is a real leak.
 *
 * The rules MIRROR `cleanupAmyProfiles`' own skip logic (read-only — this
 * never decides deletion):
 *   - markers must be intact (`allow_sam_cleanup`/`synthetic` === true): a row
 *     the sweep can never reap is a leak no matter what else is true;
 *   - a row older than `neverCrawledMaxAgeMs` (default 96h — the sweep's own
 *     "far past TTL, never going to happen naturally" bound) is a leak even
 *     inside a crawl grace: a synthetic still riding 6h graces at that age is
 *     being starved by perpetual re-discovery, not protected mid-flight;
 *   - inside those bounds, a fresh crawl signal is the 6h grace and an absent
 *     one is the bounded never-crawled window.
 */
export function classifySurvivorHold(
  survivor,
  {
    now = new Date(),
    minCrawledAgeMs = AMY_EXPIRED_SWEEP_MIN_CRAWLED_AGE_MS,
    neverCrawledMaxAgeMs = amyNeverCrawledMaxAgeMs(),
  } = {},
) {
  if (!survivor) return null
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(nowMs)) return null
  // Marker drift = unreachable by the sweep = leak.
  if (survivor.allow_sam_cleanup !== true || survivor.synthetic !== true) return null
  // Starvation escalation: far past the sweep's own never-going-to-happen bound.
  const createdMs = Date.parse(survivor.created_at ?? survivor.expires_at ?? '')
  const maxAge = Number(neverCrawledMaxAgeMs) || 0
  if (maxAge > 0 && Number.isFinite(createdMs) && nowMs - createdMs >= maxAge) return null
  const crawledMs = survivor.crawled_signal_at ? Date.parse(survivor.crawled_signal_at) : NaN
  if (Number.isFinite(crawledMs)) {
    return nowMs - crawledMs < (Number(minCrawledAgeMs) || 0) ? SURVIVOR_HOLD.CRAWL_GRACE : null
  }
  // No crawl signal at all: inside the bounded never-crawled window (checked
  // above), the sweep is documented NOT to reap it yet.
  if (maxAge > 0 && Number.isFinite(createdMs)) return SURVIVOR_HOLD.NEVER_CRAWLED_WINDOW
  return null
}

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
 *
 * PAGED, and it SAYS SO when it stops early (2026-08-21). The DELETER
 * (`cleanupExpiredAmyProfiles` → `listAmyProfiles`) is completely unbounded;
 * this proof used to read one `LIMIT 200` page and then decide expiry in JS on
 * whatever came back — the #944/#1080 post-`LIMIT` shape, aimed at the honesty
 * layer instead of at a repair. With more than 200 Amy rows alive (the nightly
 * target is ~50 and prod has held 55 from a single run plus leftovers), rows
 * past the bound were never examined, and `buildDeletionProof` treated the
 * truncated array as the COMPLETE leak set.
 *
 * It now walks pages of `limit` up to `maxScan` and marks the returned array
 * `truncated` if it stopped at the cap. The return type is unchanged (Array or
 * null); `truncated` is an extra own-property, so every existing consumer keeps
 * working and the ones that care can refuse to say `proven`.
 *
 * @returns {Promise<Array|null>} survivors, with a `truncated` boolean property
 */
export async function findExpiredSurvivors(db, { now = new Date(), limit = 200, maxScan = 5000 } = {}) {
  if (!db) return null
  const nowIso = now instanceof Date ? now.toISOString() : String(now)
  try {
    // Tolerant of older/test schemas without profiles.last_discovery_at — the
    // same fallback `listAmyProfiles` (the sweep's own reader) uses; the crawl
    // signal then comes from amy_metadata alone.
    const bound = Math.max(1, Math.min(2000, limit))
    const cap = Math.max(bound, Math.min(100000, Number(maxScan) || 0))
    // ORDER BY is required for stable paging; `id` is the only column
    // guaranteed present and unique on every schema this reader supports.
    const pageSql = (withDiscovery) => `
      SELECT p.id AS id, p.display_name AS display_name, p.created_at AS created_at,
             ${withDiscovery ? 'p.last_discovery_at AS last_discovery_at,' : ''} s.data AS data
        FROM profiles p
        LEFT JOIN profile_sections s
          ON s.profile_id = p.id AND s.section_key = 'amy_metadata'
       WHERE p.created_by = ?
       ORDER BY p.id
       LIMIT ? OFFSET ?`

    let withDiscovery = true
    const rows = []
    let truncated = false
    for (let offset = 0; ; offset += bound) {
      if (offset >= cap) { truncated = true; break }
      const pageSize = Math.min(bound, cap - offset)
      let page
      try {
        page = await db.prepare(pageSql(withDiscovery)).all(ORIGIN_CREATED_BY, pageSize, offset)
      } catch {
        if (!withDiscovery) throw new Error('amy survivor scan failed')
        withDiscovery = false
        page = await db.prepare(pageSql(false)).all(ORIGIN_CREATED_BY, pageSize, offset)
      }
      const got = Array.isArray(page) ? page : []
      rows.push(...got)
      if (got.length < pageSize) break
    }

    const survivors = []
    survivors.truncated = truncated
    for (const row of Array.isArray(rows) ? rows : []) {
      let meta = null
      try {
        const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data
        // Same precedence as before this change: the flat shape wins, the
        // nested `amy` shape is the fallback.
        meta = parsed?.expires_at ? parsed : (parsed?.amy?.expires_at ? parsed.amy : parsed)
      } catch { meta = null }
      const expiresAt = meta?.expires_at ?? null
      if (!expiresAt) continue
      const t = Date.parse(expiresAt)
      if (!Number.isFinite(t)) continue
      if (t < Date.parse(nowIso)) {
        const survivor = {
          id: row.id,
          display_name: row.display_name,
          expires_at: expiresAt,
          created_at: row.created_at,
          // Same coalesced proof-of-crawl signal `cleanupAmyProfiles` uses, so
          // the detector and the sweep can never disagree about the grace.
          crawled_signal_at: meta?.last_crawled_at || meta?.crawled_at || row.last_discovery_at || null,
          allow_sam_cleanup: meta?.allow_sam_cleanup === true,
          synthetic: meta?.synthetic === true,
        }
        survivor.hold = classifySurvivorHold(survivor, { now })
        survivors.push(survivor)
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
 * @param {boolean} [args.scanTruncated]   the survivor scan stopped at its cap;
 *   defaults to the `truncated` property `findExpiredSurvivors` sets on the
 *   array it returns. A PARTIALLY-read world proves nothing, exactly like an
 *   unreadable count — see the docblock on `findExpiredSurvivors`.
 * @returns {object} the proof block persisted on the report
 */
export function buildDeletionProof({
  before = null,
  after = null,
  runCleanup = null,
  expiredSweep = null,
  survivors = null,
  created = 0,
  scanTruncated = null,
} = {}) {
  const reportedDeleted = (Number(runCleanup?.deleted) || 0) + (Number(expiredSweep?.deleted) || 0)
  const observedDeleted = Number.isFinite(before) && Number.isFinite(after) ? before - after : null

  // An unreadable count proves nothing in either direction. Saying "proven"
  // because a query failed is the exact shape of every false-green in this repo.
  const readable = Number.isFinite(before) && Number.isFinite(after) && Array.isArray(survivors)
  let verdict = DELETION_VERDICT.UNKNOWN
  const reasons = []

  // Split past-TTL survivors by whether a DOCUMENTED sweep guard explains them.
  // A survivor with no `hold` key (an old-shape caller) counts as LEAKED — the
  // classification failing must fail toward the alarm, never away from it.
  const allSurvivors = Array.isArray(survivors) ? survivors : []
  const graceHeld = allSurvivors.filter(
    (s) => s?.hold === SURVIVOR_HOLD.CRAWL_GRACE || s?.hold === SURVIVOR_HOLD.NEVER_CRAWLED_WINDOW,
  )
  const leaked = allSurvivors.filter((s) => !graceHeld.includes(s))

  // A scan that stopped at its cap read PART of the world. Absence of a leak in
  // the part it read is not evidence there is none — but a leak it DID find is
  // still a leak, so the alarm is checked first and truncation only ever blocks
  // the comfortable verdicts.
  const truncatedScan = scanTruncated === null || scanTruncated === undefined
    ? survivors?.truncated === true
    : scanTruncated === true

  if (!readable) {
    reasons.push('counts or survivor scan unavailable — deletion NOT verified this run')
  } else if (leaked.length > 0) {
    verdict = DELETION_VERDICT.LEAKED
    reasons.push(
      `${leaked.length} profile(s) survived past their TTL with no documented guard holding them`
      + (graceHeld.length > 0 ? ` (${graceHeld.length} more are held by the sweep's grace windows)` : ''),
    )
    if (truncatedScan) {
      reasons.push('the survivor scan also hit its bound — there may be MORE past-TTL rows it never examined')
    }
  } else if (truncatedScan) {
    // No leak in the part that was read, but the scan stopped short. The
    // deleter is unbounded; only the proof was truncated, so the honest answer
    // is that this run did not verify deletion — never a comfortable `proven`.
    verdict = DELETION_VERDICT.UNKNOWN
    reasons.push(
      'the survivor scan hit its bound — rows past it were never examined, so finding no '
      + 'past-TTL row is NOT evidence there is none; deletion NOT verified this run',
    )
  } else if (graceHeld.length > 0) {
    verdict = DELETION_VERDICT.GRACE_HELD
    reasons.push(
      `${graceHeld.length} profile(s) are past TTL but inside the sweep's documented grace `
      + '(crawled/discovered recently or within the bounded never-crawled window) — '
      + 'deliberately held, reaped on the first sweep after the grace lapses',
    )
    if (observedDeleted !== reportedDeleted) {
      reasons.push(`sweeps reported ${reportedDeleted} deleted; the row count moved by ${observedDeleted}`)
    }
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
    // ALL past-TTL rows (meaning unchanged); the split below says which of them
    // are a real leak vs a documented hold.
    expired_survivors: Array.isArray(survivors) ? survivors.slice(0, 20) : null,
    expired_survivor_count: Array.isArray(survivors) ? survivors.length : null,
    leaked_survivors: Array.isArray(survivors) ? leaked.slice(0, 20) : null,
    leaked_survivor_count: Array.isArray(survivors) ? leaked.length : null,
    grace_held_survivors: Array.isArray(survivors) ? graceHeld.slice(0, 20) : null,
    grace_held_count: Array.isArray(survivors) ? graceHeld.length : null,
    // Persisted so the admin panel / morning report can tell "we looked at
    // everything and found nothing" from "we ran out of scan budget".
    survivor_scan_truncated: truncatedScan,
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
  SURVIVOR_HOLD,
  classifySurvivorHold,
  countAmyProfiles,
  findExpiredSurvivors,
  buildDeletionProof,
  verifyAmyDeletion,
}
