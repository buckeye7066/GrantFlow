/**
 * sourceFailureDetector.js — THE per-source persistent-failure query.
 *
 * One source of truth for "this registry source failed every one of its last
 * N queried runs", consumed by BOTH the Sam check
 * (crawler.sourcePersistentFailure — the owner-visible finding) and the
 * same-domain self-repair sweep (enforceSourceUrlSelfRepair — the actor).
 * Detector and actor sharing one query is the registry+totality doctrine:
 * they cannot drift into flagging one set of sources and repairing another.
 */

/**
 * How far back a failure streak may reach. A source that STOPPED being planned
 * (a disease lane the condition gate now refuses, a retired registry row) keeps
 * its last N failing rows forever, so without a floor
 * `crawler.sourcePersistentFailure` reds every morning for a source nobody
 * queries and no repair can close — a finding that can never go green, which
 * this repo has already ruled is noise rather than a standard (the
 * `agent.anya.toolFailures` recency fix, one door over).
 */
const DEFAULT_WINDOW_HOURS = 24 * 14

function windowHours() {
  const raw = Number(process.env.SOURCE_FAILURE_WINDOW_HOURS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WINDOW_HOURS
}

/**
 * @param {object} db
 * @param {{streak?: number, windowHours?: number, now?: number}} [opts]
 *   `streak` — consecutive queried-run window (default 5).
 *   `windowHours` — recency floor (default 14d, env SOURCE_FAILURE_WINDOW_HOURS).
 * @returns {Promise<Array<{source_id, source_label, last_error, last_failure_at}>>}
 *   Ordered DETERMINISTICALLY (oldest last-failure first, then source_id).
 *   Empty on any query problem (fail open — callers report "no signal yet").
 *   KNOWN LIMITATION, deliberately left: a query/schema failure is returned as
 *   `[]`, identical to "nothing is failing", and the Sam check then renders the
 *   green line "No source has failed N consecutive queried runs." for a query
 *   that never ran. Distinguishing them requires changing both consumers
 *   (`samRegistry.js`, `enforceInvariants.js` — `failing.slice(0, LIMIT)`
 *   would throw on null), so it is reported rather than half-shipped.
 */
export async function findPersistentlyFailingSources(db, opts = {}) {
  const { streak = 5, now = Date.now() } = opts
  const STREAK = Math.max(2, Number.parseInt(streak, 10) || 5)
  const hours = Number.isFinite(Number(opts.windowHours)) && Number(opts.windowHours) > 0
    ? Number(opts.windowHours)
    : windowHours()
  // 'YYYY-MM-DD HH:MM:SS', NOT `toISOString()`. `crawler_source_runs.created_at`
  // is a real timestamp on prod Postgres but a bare `CURRENT_TIMESTAMP` STRING
  // on SQLite, where the comparison is lexicographic — and an ISO string's 'T'
  // separator (0x54) sorts above SQLite's space (0x20), so an ISO bound reads
  // wrong across a same-day boundary. This format sorts correctly against
  // SQLite's own spelling and still casts cleanly in Postgres.
  const since = new Date(now - hours * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  try {
    const rows = await db
      .prepare(
        // ORDER BY is load-bearing, not cosmetic. The sole actor
        // (`enforceSourceUrlSelfRepair`) takes `failing.slice(0, LIMIT)` with
        // LIMIT 3 and then `continue`s past overridden / exhausted /
        // in-cooldown / base_url-less entries INSIDE that slice — so with an
        // arbitrary-but-stable GROUP BY order, three unrepairable sources at
        // the head starve every other failing source for the whole cooldown.
        // That is the `enforceAmountEnrichment` starvation this repo already
        // fixed with "ordered fewest-attempts-first". Oldest-last-failure-first
        // gives the least recently attended source the budget; source_id makes
        // it total so two runs never disagree.
        `WITH recent AS (
           SELECT source_id, source_label, failed, error, created_at,
                  ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC) AS rn
             FROM crawler_source_runs
            WHERE queried
              AND created_at >= ?
         )
         SELECT source_id, MAX(source_label) AS source_label,
                MAX(CASE WHEN rn = 1 THEN error END) AS last_error,
                MAX(created_at) AS last_failure_at
           FROM recent
          WHERE rn <= ${STREAK}
          GROUP BY source_id
         HAVING COUNT(*) >= ${STREAK}
            AND SUM(CASE WHEN failed THEN 1 ELSE 0 END) = COUNT(*)
          ORDER BY MAX(created_at) ASC, source_id ASC`,
      )
      .all(since)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * Sibling detector for the ADAPTER-URL-DEFECT signature: a source whose recent
 * queried runs did NOT fail to fetch (`failed = false`) yet stored NOTHING
 * because the reality gate rejected every parsed candidate as `bad_url` — the
 * exact signature of an adapter emitting a URL the gate refuses (an http:// link
 * against the no-downgrade https floor; a malformed/search URL). This is a CODE
 * defect in the source adapter, categorically different from:
 *   - `failed = true`             (a fetch/connectivity failure — the sibling above),
 *   - `api_outage:*` / 4xx/5xx    (an external OWNER/ENV action — the amount checks),
 *   - `all_candidates_rejected:no_sponsor` / `:geo_stub` (intentional gate exclusions).
 * So it is matched ONLY on `bad_url` and routed as a code fix, never an outage.
 *
 * Verbatim motivating case (2026-08-22): `nih_guide` fed `http://grants.nih.gov`
 * item links and every run recorded `found:0, rejected>0, error:
 * all_candidates_rejected:bad_url` while `failed` stayed false — invisible to
 * every `failed`-keyed check. Fixed by scheme-normalizing the adapter's URL.
 *
 * @returns {Promise<Array<{source_id, source_label, last_error, last_failure_at, runs}>>}
 *   Ordered oldest-last-occurrence-first, then source_id (same starvation-safe
 *   order as the sibling), so an actor's bounded slice attends every source.
 */
export async function findSourcesRejectingAllUrls(db, opts = {}) {
  const STREAK = Math.max(2, Number.parseInt(opts.streak ?? 3, 10) || 3)
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now()
  const hours = Number.isFinite(Number(opts.windowHours)) && Number(opts.windowHours) > 0
    ? Number(opts.windowHours)
    : windowHours()
  // Same SQLite-vs-Postgres timestamp spelling rule as the sibling above.
  const since = new Date(now - hours * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  try {
    const rows = await db
      .prepare(
        `WITH recent AS (
           SELECT source_id, source_label, failed, error, found, rejected, created_at,
                  ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC) AS rn
             FROM crawler_source_runs
            WHERE queried
              AND created_at >= ?
         )
         SELECT source_id, MAX(source_label) AS source_label,
                MAX(CASE WHEN rn = 1 THEN error END) AS last_error,
                MAX(created_at) AS last_failure_at,
                COUNT(*) AS runs
           FROM recent
          WHERE rn <= ${STREAK}
          GROUP BY source_id
         HAVING COUNT(*) >= ${STREAK}
            -- every recent run: fetched OK, parsed candidates, stored none,
            -- all rejected as bad_url (an adapter URL defect, not an outage).
            AND SUM(CASE WHEN (NOT failed) AND COALESCE(found,0) = 0
                              AND COALESCE(rejected,0) > 0
                              AND error LIKE '%bad_url%' THEN 1 ELSE 0 END) = COUNT(*)
          ORDER BY MAX(created_at) ASC, source_id ASC`,
      )
      .all(since)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export default { findPersistentlyFailingSources, findSourcesRejectingAllUrls }
