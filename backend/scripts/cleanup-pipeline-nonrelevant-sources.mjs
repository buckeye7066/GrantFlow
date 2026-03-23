#!/usr/bin/env node
/**
 * cleanup-pipeline-nonrelevant-sources.mjs
 *
 * Removes pipeline rows (grants) whose linked funding opportunity comes from a
 * source that is NOT in the canonical allowlist (PIPELINE_ALLOWED_SOURCES).
 *
 * Grants where funding_opportunity_id IS NULL (manual entries) are never touched.
 *
 * Usage:
 *   node backend/scripts/cleanup-pipeline-nonrelevant-sources.mjs          # dry-run (safe)
 *   node backend/scripts/cleanup-pipeline-nonrelevant-sources.mjs --apply  # actually delete
 *
 * Safe to run multiple times (idempotent).
 */

import { db } from '../db/index.js'
import { PIPELINE_ALLOWED_SOURCES } from '../config/pipelineAllowedSources.js'

const isDryRun = !process.argv.includes('--apply')

async function main() {
  console.log('[cleanup-pipeline] Starting pipeline source cleanup')
  console.log(`[cleanup-pipeline] Mode: ${isDryRun ? 'DRY RUN (use --apply to delete)' : 'APPLY — will delete rows'}`)
  console.log(`[cleanup-pipeline] Allowed sources (${PIPELINE_ALLOWED_SOURCES.length}): ${PIPELINE_ALLOWED_SOURCES.join(', ')}`)

  // Build ? placeholders for the IN clause
  const placeholders = PIPELINE_ALLOWED_SOURCES.map(() => '?').join(', ')

  // ------------------------------------------------------------------
  // 1. Find disallowed sources currently in the pipeline
  // ------------------------------------------------------------------
  const sourceSummary = await db
    .prepare(
      `
        SELECT fo.source, COUNT(g.id) AS cnt
        FROM grants g
        JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
        WHERE g.funding_opportunity_id IS NOT NULL
          AND fo.source NOT IN (${placeholders})
        GROUP BY fo.source
        ORDER BY cnt DESC
      `,
    )
    .all(...PIPELINE_ALLOWED_SOURCES)

  if (sourceSummary.length === 0) {
    console.log('[cleanup-pipeline] No disallowed pipeline rows found — nothing to do.')
    return
  }

  let totalToDelete = 0
  console.log('\n[cleanup-pipeline] Disallowed sources found in pipeline:')
  for (const row of sourceSummary) {
    console.log(`  source="${row.source ?? 'NULL'}"  rows=${row.cnt}`)
    totalToDelete += Number(row.cnt)
  }
  console.log(`[cleanup-pipeline] Total rows to delete: ${totalToDelete}`)

  // ------------------------------------------------------------------
  // 2. Show per-profile impact
  // ------------------------------------------------------------------
  const profileSummary = await db
    .prepare(
      `
        SELECT g.profile_id, COUNT(g.id) AS cnt
        FROM grants g
        JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
        WHERE g.funding_opportunity_id IS NOT NULL
          AND fo.source NOT IN (${placeholders})
        GROUP BY g.profile_id
        ORDER BY cnt DESC
      `,
    )
    .all(...PIPELINE_ALLOWED_SOURCES)

  console.log(`\n[cleanup-pipeline] Profiles affected: ${profileSummary.length}`)
  for (const row of profileSummary) {
    console.log(`  profile_id=${row.profile_id}  rows_to_remove=${row.cnt}`)
  }

  if (isDryRun) {
    console.log('\n[cleanup-pipeline] DRY RUN complete — no rows deleted.')
    console.log('[cleanup-pipeline] Re-run with --apply to perform the deletion.')
    return
  }

  // ------------------------------------------------------------------
  // 3. Delete the disallowed pipeline rows
  // ------------------------------------------------------------------
  const deleteResult = await db
    .prepare(
      `
        DELETE FROM grants
        WHERE funding_opportunity_id IS NOT NULL
          AND funding_opportunity_id IN (
            SELECT fo.id
            FROM funding_opportunities fo
            WHERE fo.source NOT IN (${placeholders})
          )
      `,
    )
    .run(...PIPELINE_ALLOWED_SOURCES)

  const deleted = deleteResult?.changes ?? deleteResult?.rowCount ?? 0
  console.log(`\n[cleanup-pipeline] Deleted ${deleted} pipeline row(s) from disallowed sources.`)
  console.log('[cleanup-pipeline] Done.')
}

main().catch((err) => {
  console.error('[cleanup-pipeline] FATAL:', err)
  process.exit(1)
})
