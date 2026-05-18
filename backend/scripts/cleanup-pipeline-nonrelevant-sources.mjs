#!/usr/bin/env node
/**
 * cleanup-pipeline-nonrelevant-sources.mjs
 *
 * Removes pipeline rows (grants) whose linked funding opportunity fails the
 * canonical pipeline-source gate (denylist + untrusted record_origin). Grants
 * where funding_opportunity_id IS NULL (manual entries) are never touched.
 *
 * NOTE: This script previously used a raw SQL `NOT IN (PIPELINE_ALLOWED_SOURCES)`
 * filter, which silently deleted every legitimate domain-crawler row (e.g.
 * "Student Endowments", "Trade School Grants") because those labels were never
 * in the static allowlist. We now evaluate each row in JavaScript using
 * `evaluatePipelineSource`, the same predicate used by:
 *   • POST /api/grants/from-opportunity (routes/grants.js)
 *   • saveToProfilePipeline (services/opportunityMatcher.js)
 *   • startup cleanup (utils/seedOnStartup.js)
 *
 * Usage:
 *   node backend/scripts/cleanup-pipeline-nonrelevant-sources.mjs          # dry-run (safe)
 *   node backend/scripts/cleanup-pipeline-nonrelevant-sources.mjs --apply  # actually delete
 *
 * Safe to run multiple times (idempotent).
 */

import { db } from '../db/index.js'
import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js'

const isDryRun = !process.argv.includes('--apply')

async function main() {
  console.log('[cleanup-pipeline] Starting pipeline source cleanup')
  console.log(`[cleanup-pipeline] Mode: ${isDryRun ? 'DRY RUN (use --apply to delete)' : 'APPLY — will delete rows'}`)

  // ------------------------------------------------------------------
  // 1. Pull every pipeline row joined to its funding_opportunity, then
  //    classify in JS using evaluatePipelineSource. We can't push the
  //    decision into SQL because the heuristic combines source label tokens
  //    with record_origin trust, which the gate routes also use.
  // ------------------------------------------------------------------
  const rows = await db
    .prepare(
      `
        SELECT g.id AS grant_id,
               g.profile_id,
               fo.source,
               fo.record_origin
        FROM grants g
        JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
        WHERE g.funding_opportunity_id IS NOT NULL
      `,
    )
    .all()

  const toDelete = []
  const sourceCounts = new Map()
  const profileCounts = new Map()

  for (const row of rows) {
    const gate = evaluatePipelineSource({
      source: row.source,
      record_origin: row.record_origin,
    })
    if (gate.allowed) continue
    toDelete.push(row)

    const sourceKey = `${row.source ?? 'NULL'} (origin=${row.record_origin ?? 'NULL'}, reason=${gate.reason})`
    sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1)
    profileCounts.set(row.profile_id, (profileCounts.get(row.profile_id) ?? 0) + 1)
  }

  if (toDelete.length === 0) {
    console.log('[cleanup-pipeline] No disallowed pipeline rows found — nothing to do.')
    return
  }

  console.log('\n[cleanup-pipeline] Disallowed sources found in pipeline:')
  for (const [src, cnt] of sourceCounts.entries()) {
    console.log(`  ${src}  rows=${cnt}`)
  }
  console.log(`[cleanup-pipeline] Total rows to delete: ${toDelete.length}`)

  console.log(`\n[cleanup-pipeline] Profiles affected: ${profileCounts.size}`)
  for (const [profileId, cnt] of profileCounts.entries()) {
    console.log(`  profile_id=${profileId}  rows_to_remove=${cnt}`)
  }

  if (isDryRun) {
    console.log('\n[cleanup-pipeline] DRY RUN complete — no rows deleted.')
    console.log('[cleanup-pipeline] Re-run with --apply to perform the deletion.')
    return
  }

  // ------------------------------------------------------------------
  // 2. Delete each disallowed pipeline row by id (per-row to keep the
  //    JS-side classification authoritative).
  // ------------------------------------------------------------------
  let deleted = 0
  for (const row of toDelete) {
    try {
      const res = await db.prepare('DELETE FROM grants WHERE id = ?').run(row.grant_id)
      deleted += res?.changes ?? res?.rowCount ?? 0
    } catch (err) {
      console.warn(`[cleanup-pipeline] Failed to delete grant=${row.grant_id}:`, err?.message ?? err)
    }
  }

  console.log(`\n[cleanup-pipeline] Deleted ${deleted} pipeline row(s) from disallowed sources.`)
  console.log('[cleanup-pipeline] Done.')
}

main().catch((err) => {
  console.error('[cleanup-pipeline] FATAL:', err)
  process.exit(1)
})
