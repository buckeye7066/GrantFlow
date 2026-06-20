#!/usr/bin/env node
/**
 * prune-pipeline-by-match-score.mjs
 *
 * Remove every funding source from a profile's pipeline whose match_score is
 * below a threshold (default 80). Each removed grant is TOMBSTONED via
 * recordDismissal first, so the boot reconcile sweep + per-insert DISMISSED
 * gates keep it from ever resurfacing (see services/pipelineDismissals.js).
 *
 * Deletion mirrors DELETE /api/grants/:id exactly: cascade child rows
 * (milestones, expenses, application_drafts), null out document.grant_id, write
 * the tombstone, then delete the grant.
 *
 * Profiles are resolved by a case-insensitive display_name / name match so you
 * can target people by first name ("Anastasia", "Robert").
 *
 * Usage:
 *   node backend/scripts/prune-pipeline-by-match-score.mjs --names "Anastasia,Robert"            # dry-run
 *   node backend/scripts/prune-pipeline-by-match-score.mjs --names "Anastasia,Robert" --apply    # delete
 *   node backend/scripts/prune-pipeline-by-match-score.mjs --names "Anastasia" --threshold 80 --apply
 *
 * Against production run with Railway env injected:
 *   railway run node backend/scripts/prune-pipeline-by-match-score.mjs --names "Anastasia,Robert" --apply
 *
 * Null/unknown match_score counts as "below threshold" (it does NOT meet the
 * >= threshold bar). Pass --keep-unscored to leave NULL-score rows in place.
 *
 * Idempotent and safe to re-run.
 */

import { db } from '../db/index.js'
import { recordDismissal } from '../services/pipelineDismissals.js'

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const isDryRun = !process.argv.includes('--apply')
const keepUnscored = process.argv.includes('--keep-unscored')
const threshold = Number.parseFloat(argValue('--threshold', '80')) || 80
const names = String(argValue('--names', 'Anastasia,Robert'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function resolveProfiles(name) {
  const like = `%${name.toLowerCase()}%`
  return db
    .prepare(
      `SELECT id, display_name, name, primary_type, status
         FROM profiles
        WHERE (lower(COALESCE(display_name, '')) LIKE ?
            OR lower(COALESCE(name, '')) LIKE ?)
          AND (status IS NULL OR status <> 'deleted')`,
    )
    .all(like, like)
}

async function cascadeDeleteAndTombstone(grant) {
  // Load the source opportunity (when the FK still resolves) so the tombstone
  // can key on fingerprint + opportunity_id + title.
  let opportunity = null
  if (grant.funding_opportunity_id) {
    try {
      opportunity = await db
        .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
        .get(grant.funding_opportunity_id)
    } catch {
      opportunity = null
    }
  }

  // Cascade child rows, mirroring DELETE /api/grants/:id.
  await db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(grant.id)
  await db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM grants WHERE id = ?').run(grant.id)

  // Tombstone so it never comes back.
  if (grant.profile_id) {
    try {
      await recordDismissal(db, {
        profileId: grant.profile_id,
        grantRow: grant,
        opportunity,
        reason: `pruned_below_${threshold}pct_match`,
      })
    } catch (err) {
      console.warn(`  [tombstone] failed for grant=${grant.id}: ${err?.message || err}`)
    }
  }
}

async function main() {
  console.log(`[prune] Mode: ${isDryRun ? 'DRY RUN (use --apply to delete)' : 'APPLY — will delete + tombstone'}`)
  console.log(`[prune] Threshold: match_score < ${threshold}${keepUnscored ? '' : ' (NULL scores also removed)'}`)
  console.log(`[prune] Target names: ${names.join(', ')}`)

  const targetProfiles = []
  for (const name of names) {
    const found = await resolveProfiles(name)
    if (found.length === 0) {
      console.warn(`[prune] No profile matched "${name}"`)
      continue
    }
    for (const p of found) {
      console.log(`[prune] Matched "${name}" -> profile ${p.id} (${p.display_name || p.name}, type=${p.primary_type})`)
      targetProfiles.push(p)
    }
  }

  if (targetProfiles.length === 0) {
    console.log('[prune] No target profiles resolved. Nothing to do.')
    return
  }

  let totalRemoved = 0
  for (const profile of targetProfiles) {
    const scoreFilter = keepUnscored
      ? 'AND match_score IS NOT NULL AND match_score < ?'
      : 'AND (match_score IS NULL OR match_score < ?)'
    const grants = await db
      .prepare(
        `SELECT * FROM grants
          WHERE profile_id = ?
          ${scoreFilter}
          ORDER BY match_score ASC NULLS FIRST`,
      )
      .all(profile.id, threshold)
      .catch(async () =>
        // NULLS FIRST is Postgres-only; retry without it for SQLite.
        db
          .prepare(`SELECT * FROM grants WHERE profile_id = ? ${scoreFilter} ORDER BY match_score ASC`)
          .all(profile.id, threshold),
      )

    console.log(`\n[prune] Profile ${profile.display_name || profile.name} (${profile.id}): ${grants.length} source(s) below ${threshold}%`)
    for (const g of grants) {
      const score = g.match_score === null || g.match_score === undefined ? 'NULL' : g.match_score
      console.log(`   - [${score}] ${g.title || '(untitled)'} — ${g.funder || 'unknown funder'}`)
      if (!isDryRun) {
        await cascadeDeleteAndTombstone(g)
        totalRemoved += 1
      }
    }
  }

  if (isDryRun) {
    console.log('\n[prune] DRY RUN complete — no rows deleted. Re-run with --apply to perform the deletion.')
  } else {
    console.log(`\n[prune] Removed + tombstoned ${totalRemoved} pipeline source(s).`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[prune] FATAL:', err)
    process.exit(1)
  })
