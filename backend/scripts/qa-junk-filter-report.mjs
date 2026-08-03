/**
 * Per-profile "junk removed / kept" diff report (READ-ONLY, re-runnable).
 *
 * Owner deliverable, 2026-08-03 QA pass across all 36 profiles: after the
 * shared funding-result filter chain shipped (fundingResultFilters.js +
 * detectForeignOpportunity + the non_grant_notice_matches /
 * foreign_jurisdiction_matches boot nets), this script makes the cleanup
 * VERIFIABLE — run it before the boot sweeps to see what WILL be removed, run
 * it after to see what remains.
 *
 * For every profile carrying surfaced matches it classifies each surfaced
 * catalog row through the SAME classifiers the product uses (never a re-typed
 * copy):
 *   - regulatory_notice_title / federal_register_source  (classifyRegulatoryNotice)
 *   - lead_gen:<funder>                                  (isLeadGenScholarship)
 *   - expired:<class>                                    (isClearlyExpiredProgram)
 *   - unresolvable_funder                                (isAnonymizedFunder)
 *   - foreign:<host|funder>                              (detectForeignOpportunity)
 *   - resource:no_fundable_signal / resource:pointer     (classifyFundingResult)
 *   - kept                                               (everything else)
 *
 * This script mutates NOTHING. Prod usage (read-only):
 *   railway ssh --service GrantFlow -- "sh -c 'cd /app && node backend/scripts/qa-junk-filter-report.mjs'"
 * Add --json for machine-readable output; --examples=N to print N example
 * titles per junk class per profile (default 2).
 */

import { db } from '../db/index.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js'
import {
  classifyFundingResult,
  classifyRegulatoryNotice,
  isLeadGenScholarship,
  isClearlyExpiredProgram,
  isAnonymizedFunder,
  RESULT_BUCKETS,
} from '../config/fundingResultFilters.js'
import { detectForeignOpportunity } from '../config/opportunityJurisdiction.js'

const asJson = process.argv.includes('--json')
const exArg = process.argv.find((a) => a.startsWith('--examples='))
const EXAMPLES = Math.max(0, Number(exArg?.split('=')[1] ?? 2) || 2)

function classifyRow(row) {
  const regulatory = classifyRegulatoryNotice(row)
  if (regulatory) return regulatory
  const leadGen = isLeadGenScholarship(row)
  if (leadGen) return `lead_gen:${leadGen}`
  const expired = isClearlyExpiredProgram(row)
  if (expired) return `expired:${expired}`
  if (isAnonymizedFunder(row.sponsor)) return 'unresolvable_funder'
  const foreign = detectForeignOpportunity(row)
  if (foreign.foreign) return `foreign:${foreign.host ?? foreign.funder ?? foreign.cctld}`
  const verdict = classifyFundingResult(row)
  if (verdict.bucket === RESULT_BUCKETS.RESOURCE) {
    return verdict.reasons.includes('pointer_kind') ? 'resource:pointer' : 'resource:no_fundable_signal'
  }
  return 'kept'
}

async function main() {
  const rows = await db
    .prepare(
      `SELECT m.profile_id,
              COALESCE(p.display_name, m.profile_id) AS profile_name,
              fo.id, fo.title, fo.sponsor, fo.description, fo.source, fo.source_id,
              fo.source_url, fo.application_url, fo.evidence_url,
              fo.deadline, fo.deadline_type, fo.amount_min, fo.amount_max,
              fo.opportunity_kind, fo.state
         FROM profile_opportunity_matches m
         JOIN funding_opportunities fo ON fo.id = m.opportunity_id
         LEFT JOIN profiles p ON p.id = m.profile_id
        WHERE m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND (fo.is_active IS NULL OR fo.is_active = 1)`,
    )
    .all()

  const byProfile = new Map()
  for (const row of rows ?? []) {
    const key = row.profile_id
    if (!byProfile.has(key)) {
      byProfile.set(key, { profile_id: key, profile_name: row.profile_name, total: 0, kept: 0, junk: 0, classes: new Map() })
    }
    const p = byProfile.get(key)
    p.total += 1
    const cls = classifyRow(row)
    if (cls === 'kept') {
      p.kept += 1
      continue
    }
    // "resource:*" rows are ROUTED (directories bucket), the rest are HIDDEN/
    // PURGED classes — both are reported, separately named.
    p.junk += 1
    if (!p.classes.has(cls)) p.classes.set(cls, { count: 0, examples: [] })
    const c = p.classes.get(cls)
    c.count += 1
    if (c.examples.length < EXAMPLES) c.examples.push(row.title)
  }

  const report = [...byProfile.values()]
    .sort((a, b) => b.junk - a.junk)
    .map((p) => ({
      profile: p.profile_name,
      profile_id: p.profile_id,
      surfaced_total: p.total,
      kept_direct: p.kept,
      routed_or_removed: p.junk,
      classes: Object.fromEntries([...p.classes.entries()].map(([k, v]) => [k, { count: v.count, examples: v.examples }])),
    }))

  const fleet = {
    generated_at: new Date().toISOString(),
    profiles: report.length,
    surfaced_rows: rows?.length ?? 0,
    kept_direct: report.reduce((n, p) => n + p.kept_direct, 0),
    routed_or_removed: report.reduce((n, p) => n + p.routed_or_removed, 0),
  }

  if (asJson) {
    console.log(JSON.stringify({ fleet, report }, null, 2))
    return
  }

  console.log(`\nQA junk-filter report — ${fleet.generated_at}`)
  console.log(`Profiles with surfaced matches: ${fleet.profiles}; surfaced rows: ${fleet.surfaced_rows}`)
  console.log(`Kept as direct candidates: ${fleet.kept_direct}; routed/removed by the chain: ${fleet.routed_or_removed}\n`)
  for (const p of report) {
    console.log(`— ${p.profile} (${p.profile_id}): ${p.surfaced_total} surfaced, ${p.kept_direct} kept, ${p.routed_or_removed} routed/removed`)
    for (const [cls, v] of Object.entries(p.classes)) {
      console.log(`    ${cls}: ${v.count}${v.examples.length ? ` — e.g. ${v.examples.map((t) => JSON.stringify(t)).join(', ')}` : ''}`)
    }
  }
  console.log('\nNOTE: "resource:*" classes are ROUTED to Directories & resources (never deleted);')
  console.log('regulatory/lead-gen/expired classes are hidden at presentation AND their match rows')
  console.log('are purged by the non_grant_notice_matches boot net; foreign:* rows are purged by')
  console.log('foreign_jurisdiction_matches. Catalog rows are never deleted by any of these.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('qa-junk-filter-report failed:', err?.message ?? err)
    process.exit(1)
  })
