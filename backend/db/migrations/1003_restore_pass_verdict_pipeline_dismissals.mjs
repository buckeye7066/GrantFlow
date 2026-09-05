/**
 * Restore the pipeline rows the 2026-09-02 strict four-gate migrations (999,
 * 1000, 1001) tombstoned under the self-contradicting reason
 * `strict_pipeline:qualifies:applicant_type:pass`.
 *
 * The QUALIFIES gate demanded the single verdict reason
 * `explicit_applicant_types_match`, so every opportunity the canonical
 * applicant-type gate PASSED without an explicit restriction (Tennessee
 * Promise, the Gates Scholarship, TN Reconnect, Federal SEOG…) was dismissed,
 * its grant deleted, its match purged, and a sticky tombstone written so it
 * could never come back — 172 rows across 17 profiles in production.
 *
 * The gate now treats `pass` as pass (hamiltonFundingSourcePolicy). This
 * migration removes only those tombstones (and their durable promotion
 * outcomes) so the live qualified-promotion job and the boot linkers can
 * re-admit the rows through the ordinary canonical path. Nothing is inserted
 * here; admission stays subject to every current gate.
 *
 * It also clears the nightly promotion day-marker so the post-listen catch-up
 * promotes on the very next boot instead of waiting for tomorrow's 4 AM ET tick
 * (the marker was stamped today by a run that projected instead of promoting).
 */
const BAD_REASON = 'strict_pipeline:qualifies:applicant_type:pass'

export default async function up(db) {
  const tombstones = await db
    .prepare('SELECT profile_id, opportunity_id FROM pipeline_dismissals WHERE reason = ?')
    .all(BAD_REASON)
  for (const row of tombstones) {
    if (!row?.opportunity_id) continue
    try {
      await db
        .prepare('DELETE FROM pipeline_promotion_outcomes WHERE profile_id = ? AND opportunity_id = ?')
        .run(row.profile_id, row.opportunity_id)
    } catch { /* outcomes table absent in a minimal database */ }
  }
  await db.prepare('DELETE FROM pipeline_dismissals WHERE reason = ?').run(BAD_REASON)
  try {
    await db.prepare("DELETE FROM pipeline_promotion_outcomes WHERE mode = 'dry_run'").run()
  } catch { /* outcomes table absent in a minimal database */ }
  try {
    await db
      .prepare("DELETE FROM system_kv WHERE key IN ('qualified_pipeline_promotion_last_run', 'promotion_projection')")
      .run()
  } catch { /* system_kv absent in a minimal database */ }
}
