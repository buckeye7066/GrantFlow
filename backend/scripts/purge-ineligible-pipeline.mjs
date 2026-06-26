/**
 * Purge applicant-type-INELIGIBLE rows from one (or all) profile pipelines.
 *
 * Removes institution-only opportunities that slipped into an INDIVIDUAL's
 * pipeline before the write-time applicant-type gate existed (e.g. OSEP
 * personnel preparation, NRSA institutional training grants, OESE comprehensive
 * centers, NSF Space Grant in a graduate student's pipeline). Directory-style
 * resources and demographic/field mismatches are left untouched (mission rules).
 *
 * Reversible: each removed row is tombstoned (re-add via the UI clears it).
 *
 * Usage (PowerShell):
 *   # Dry run (report only) for one profile:
 *   node backend/scripts/purge-ineligible-pipeline.mjs --profile <PROFILE_ID> --dry-run
 *   # Apply for one profile:
 *   node backend/scripts/purge-ineligible-pipeline.mjs --profile <PROFILE_ID>
 *   # All active profiles:
 *   node backend/scripts/purge-ineligible-pipeline.mjs --all
 */

import { db } from '../db/index.js'
import { sweepProfilePipelineApplicantType } from '../services/pipelineEligibilitySweep.js'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? true) : null
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const all = process.argv.includes('--all')
  const profileArg = arg('--profile')
  const profileId = typeof profileArg === 'string' ? profileArg : process.env.PROFILE_ID || null

  let profileIds = []
  if (all) {
    const rows = await db.prepare(`SELECT id FROM profiles WHERE status = 'active' ORDER BY created_at ASC`).all()
    profileIds = (rows || []).map((r) => r.id)
  } else if (profileId) {
    profileIds = [profileId]
  } else {
    console.error('Provide --profile <id> or --all (optionally --dry-run).')
    process.exit(2)
  }

  console.log(`[purge-ineligible-pipeline] ${dryRun ? 'DRY RUN' : 'APPLY'} over ${profileIds.length} profile(s)`)
  let totalFlagged = 0
  let totalRemoved = 0
  for (const pid of profileIds) {
    const res = await sweepProfilePipelineApplicantType(db, pid, { apply: !dryRun, userId: 'cli_purge_ineligible' })
    totalFlagged += res.flagged.length
    totalRemoved += res.removed
    if (res.flagged.length) {
      console.log(`\n  profile ${pid} (applicant_type=${res.applicantType ?? 'unknown'}) — ${res.flagged.length} ineligible of ${res.scanned} scanned, removed=${res.removed}`)
      for (const f of res.flagged) console.log(`    - [${f.reason}] ${f.title}`)
    }
  }
  console.log(`\n[purge-ineligible-pipeline] done — flagged=${totalFlagged} removed=${totalRemoved}${dryRun ? ' (dry run; nothing deleted)' : ''}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[purge-ineligible-pipeline] failed:', err?.stack || err?.message || err)
  process.exit(1)
})
