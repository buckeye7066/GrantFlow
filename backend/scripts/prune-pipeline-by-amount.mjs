#!/usr/bin/env node
/**
 * prune-pipeline-by-amount.mjs
 *
 * Reversible, tombstoned prune of INSTITUTIONAL-scale grants that were
 * mis-matched into an INDIVIDUAL profile's pipeline (the ">$3M potential" bug).
 * This is the one-time cleanup companion to the PERMANENT boot-sweep net
 * `enforceIndividualAmountCeiling()` in startup/enforceInvariants.js — same
 * guardrails, but it goes through the canonical recordDismissal() path so each
 * removed source is TOMBSTONED (cannot be re-added by the funding_api feed) and
 * child rows are cascaded, exactly like DELETE /api/grants/:id.
 *
 * A grant is removed ONLY when ALL hold (mirrors the invariant):
 *   - profile is an INDIVIDUAL/student/family/veteran type,
 *   - amount_requested > threshold,
 *   - status is an early/discovery stage (discovered/discovery/interested/new/matched),
 *   - title/funder is not MTSU/portal-protected,
 *   - amount_awarded is NULL/<=0 (a real award is money in hand, preserved).
 *
 * Usage (dry-run):
 *   railway run node backend/scripts/prune-pipeline-by-amount.mjs --names "Robert"
 * Apply:
 *   railway run node backend/scripts/prune-pipeline-by-amount.mjs --names "Robert" --threshold 25000 --apply
 *
 * Demo Student's fabricated-award cleanup is owned by another process — her profile
 * is hard-excluded here.
 */
import { db } from '../db/index.js'
import { recordDismissal } from '../services/pipelineDismissals.js'
import { __testables } from '../startup/enforceInvariants.js'

const { isIndividualProfileType } = __testables

// Do not touch — owned by a separate cleanup process (scope guardrail).
const EXCLUDED_PROFILE_IDS = new Set(['00000000-0000-4000-8000-000000000001'])

const PIPELINE_ACTIVE_STATUSES = [
  'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
  'app_prep', 'application_prep', 'revision', 'portal', 'submitted',
  'pending_review', 'under_review', 'follow_up', 'report',
]
// Early/discovery stages that may be pruned (must match the invariant's allowlist).
const PURGEABLE = new Set(['discovered', 'discovery', 'interested', 'new', 'matched'])
const PROTECTED_NAME = /mtsu|middle tennessee state|portal/i

function argValue(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const isDryRun = !process.argv.includes('--apply')
const threshold = Number.parseFloat(argValue('--threshold', '25000')) || 25000
const names = String(argValue('--names', 'Robert')).split(',').map((s) => s.trim()).filter(Boolean)

function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }

async function pipelineTotal(profileId) {
  const ph = PIPELINE_ACTIVE_STATUSES.map(() => '?').join(',')
  const row = await db.prepare(
    `SELECT COALESCE(SUM(amount_requested),0) AS total, COUNT(*) AS n
       FROM grants WHERE profile_id = ? AND status IN (${ph})`,
  ).get(profileId, ...PIPELINE_ACTIVE_STATUSES)
  return { total: Number(row?.total || 0), n: Number(row?.n || 0) }
}

async function cascadeDeleteAndTombstone(grant) {
  let opportunity = null
  if (grant.funding_opportunity_id) {
    try {
      opportunity = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(grant.funding_opportunity_id)
    } catch { opportunity = null }
  }
  await db.prepare('DELETE FROM milestones WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM expenses WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM application_drafts WHERE grant_id = ?').run(grant.id)
  await db.prepare('UPDATE documents SET grant_id = NULL WHERE grant_id = ?').run(grant.id)
  await db.prepare('DELETE FROM grants WHERE id = ?').run(grant.id)
  if (grant.profile_id) {
    try {
      await recordDismissal(db, {
        profileId: grant.profile_id,
        grantRow: grant,
        opportunity,
        reason: `pruned_above_individual_ceiling_${threshold}`,
      })
    } catch (err) {
      console.warn(`  [tombstone] failed for grant=${grant.id}: ${err?.message || err}`)
    }
  }
}

async function main() {
  console.log(`[prune-amount] Mode: ${isDryRun ? 'DRY RUN (use --apply)' : 'APPLY — delete + tombstone'}`)
  console.log(`[prune-amount] Threshold: amount_requested > ${usd(threshold)} on individual profiles, early stages only`)
  console.log(`[prune-amount] Names: ${names.join(', ')}`)

  const profiles = []
  for (const name of names) {
    const found = await db.prepare(
      `SELECT id, display_name, primary_type, status FROM profiles
        WHERE lower(COALESCE(display_name,'')) LIKE ? AND (status IS NULL OR status <> 'deleted')`,
    ).all(`%${name.toLowerCase()}%`)
    for (const p of found) {
      if (EXCLUDED_PROFILE_IDS.has(p.id)) { console.log(`[prune-amount] SKIP excluded profile ${p.id}`); continue }
      profiles.push(p)
    }
  }
  if (profiles.length === 0) { console.log('[prune-amount] No target profiles. Nothing to do.'); return }

  let grandRemoved = 0
  for (const p of profiles) {
    const rawType = p.primary_type
    const individual = isIndividualProfileType(rawType)
    const before = await pipelineTotal(p.id)
    console.log(`\n[prune-amount] ${p.display_name} (${p.id}) type=${rawType} individual=${individual}`)
    console.log(`   BEFORE pipeline total: ${usd(before.total)} across ${before.n} active grants`)
    if (!individual) { console.log('   Not an individual profile — skipping (orgs may pursue large grants).'); continue }

    const ph = PIPELINE_ACTIVE_STATUSES.map(() => '?').join(',')
    const candidates = await db.prepare(
      `SELECT * FROM grants
        WHERE profile_id = ? AND status IN (${ph})
          AND amount_requested IS NOT NULL AND amount_requested > ?
          AND (amount_awarded IS NULL OR amount_awarded <= 0)
        ORDER BY amount_requested DESC`,
    ).all(p.id, ...PIPELINE_ACTIVE_STATUSES, threshold)

    const toRemove = candidates.filter((g) => {
      const status = g.status == null ? null : String(g.status)
      if (!(status === null || PURGEABLE.has(status))) return false
      if (PROTECTED_NAME.test(`${g.title || ''} ${g.funder || ''}`)) return false
      return true
    })

    console.log(`   Candidates > ${usd(threshold)}: ${candidates.length}; removable (early-stage, unprotected): ${toRemove.length}`)
    for (const g of toRemove) {
      console.log(`     - ${usd(g.amount_requested)}  [${g.status}]  ${String(g.title || '(untitled)').slice(0, 60)} | ${String(g.funder || '').slice(0, 30)}`)
      if (!isDryRun) { await cascadeDeleteAndTombstone(g); grandRemoved += 1 }
    }

    if (!isDryRun) {
      const after = await pipelineTotal(p.id)
      console.log(`   AFTER pipeline total:  ${usd(after.total)} across ${after.n} active grants`)
    } else {
      const projected = before.total - toRemove.reduce((s, g) => s + Number(g.amount_requested || 0), 0)
      console.log(`   PROJECTED after apply: ${usd(projected)}`)
    }
  }
  console.log(`\n[prune-amount] ${isDryRun ? 'DRY RUN complete — re-run with --apply.' : `Removed + tombstoned ${grandRemoved} source(s).`}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('[prune-amount] FATAL:', e); process.exit(1) })
