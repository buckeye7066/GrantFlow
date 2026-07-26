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
 * @param {object} db
 * @param {{streak?: number}} [opts] consecutive queried-run window (default 5)
 * @returns {Promise<Array<{source_id, source_label, last_error}>>}
 *   Empty on any query problem (fail open — callers report "no signal yet").
 */
export async function findPersistentlyFailingSources(db, { streak = 5 } = {}) {
  const STREAK = Math.max(2, Number.parseInt(streak, 10) || 5)
  try {
    const rows = await db
      .prepare(
        `WITH recent AS (
           SELECT source_id, source_label, failed, error,
                  ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY created_at DESC) AS rn
             FROM crawler_source_runs
            WHERE queried
         )
         SELECT source_id, MAX(source_label) AS source_label,
                MAX(CASE WHEN rn = 1 THEN error END) AS last_error
           FROM recent
          WHERE rn <= ${STREAK}
          GROUP BY source_id
         HAVING COUNT(*) >= ${STREAK}
            AND SUM(CASE WHEN failed THEN 1 ELSE 0 END) = COUNT(*)`,
      )
      .all()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

export default { findPersistentlyFailingSources }
