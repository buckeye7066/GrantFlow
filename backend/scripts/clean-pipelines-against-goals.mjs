#!/usr/bin/env node
/**
 * clean-pipelines-against-goals.mjs
 *
 * CLI runner around `auditPipelinesAgainstGoals` so the same code path the
 * admin endpoint uses can be invoked from a shell on a deployed environment
 * (Postgres) or against the local dev SQLite without spinning up the API.
 *
 * Usage:
 *   node backend/scripts/clean-pipelines-against-goals.mjs           # dry-run (safe)
 *   node backend/scripts/clean-pipelines-against-goals.mjs --apply   # actually delete
 *
 * The script always uses the canonical `backend/db/index.js` so it works in
 * production (Postgres) the same way it works locally (SQLite).
 */
import { db } from '../db/index.js'
import { auditPipelinesAgainstGoals } from '../services/pipelineGoalCleanupService.js'

const apply = process.argv.includes('--apply')

async function main() {
  console.log(`[clean-pipelines-against-goals] mode=${apply ? 'APPLY' : 'DRY RUN'}`)
  const report = await auditPipelinesAgainstGoals(db, { dryRun: !apply })

  console.log('')
  console.log(`Total grants in pipeline: ${report.total_grants}`)
  console.log(`Profiles with at least one item: ${report.profiles_with_pipeline}`)
  console.log(`Items kept: ${report.kept}`)
  console.log(`Items ${apply ? 'removed' : 'flagged for removal'}: ${report.removed}`)
  console.log('Verdict totals:')
  for (const [k, v] of Object.entries(report.verdict_totals)) {
    console.log(`  ${k}: ${v}`)
  }
  console.log('')

  for (const p of report.per_profile) {
    if (p.removed_items.length === 0 && p.verdicts.keep === p.total) continue
    console.log(`── ${p.display_name} (type=${p.primary_type}, state=${p.profile_state || '?'}): ${p.total} items`)
    for (const r of p.removed_items) {
      console.log(`   ✕ [${r.verdict}] "${r.title}" — ${r.reason || '(no reason)'}`)
    }
    console.log('')
  }

  if (!apply) {
    console.log('Re-run with --apply to actually delete the flagged items.')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[clean-pipelines-against-goals] FATAL:', err)
    process.exit(1)
  })
