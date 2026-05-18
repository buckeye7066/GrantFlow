/**
 * Backfill profile pipelines (grants) from existing funding_opportunities.
 *
 * - Idempotent: uses existing unique check in saveToProfilePipeline
 * - Traceable: prints summary counts per profile
 * - Reversible: run is non-destructive; it only adds missing pipeline rows
 *
 * Usage (PowerShell):
 *   node backend/scripts/backfill-profile-pipeline-from-opportunities.mjs
 *
 * Optional env:
 *   MATCH_THRESHOLD=50
 *   LIMIT_OPPS_PER_PROFILE=5000
 */

import { db } from '../db/index.js'
import { buildProfileContext } from '../services/profileHelpers.js'
import { saveToProfilePipeline } from '../services/opportunityMatcher.js'
import { evaluatePipelineSource } from '../config/pipelineAllowedSources.js'
import { trustedOriginClause } from '../utils/recordOrigins.js'

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

async function main() {
  const threshold = Math.max(0, Math.min(100, num(process.env.MATCH_THRESHOLD, 50)))
  const limitOpps = Math.max(100, Math.min(50_000, num(process.env.LIMIT_OPPS_PER_PROFILE, 5000)))

  const profiles = await db
    .prepare(`SELECT id, display_name FROM profiles WHERE status = 'active' ORDER BY created_at ASC`)
    .all()

  console.log('[backfill] start', {
    active_profiles: profiles.length,
    threshold,
    limitOpps,
  })

  let totalSaved = 0
  let totalEligible = 0
  let totalChecked = 0

  for (const p of profiles) {
    const profileId = String(p.id)
    const profileContext = await buildProfileContext(db, profileId)

    // Pull every candidate opportunity for this profile, then filter in JS
    // using the canonical pipeline-source gate. Pre-filtering by allowlist
    // here would silently drop legitimate domain-crawler rows (Goal 7
    // regression). The DB query still excludes synthetic/manual origins via
    // `trustedOriginClause` so we never even consider them.
    const opportunities = await db
      .prepare(
        `
          SELECT *
          FROM funding_opportunities
          WHERE (profile_id IS NULL OR profile_id = ?)
            AND ${trustedOriginClause()}
          ORDER BY updated_at DESC
          LIMIT ${limitOpps}
        `,
      )
      .all(profileId)
      .filter((opp) =>
        evaluatePipelineSource({ source: opp?.source, record_origin: opp?.record_origin }).allowed,
      )

    let saved = 0
    let checked = 0
    let eligible = 0

    for (const opp of opportunities || []) {
      checked += 1
      const res = await saveToProfilePipeline(db, opp, profileId, profileContext, null, threshold)
      const pct = typeof res?.matchPercentage === 'number' ? res.matchPercentage : null
      if (pct !== null && pct >= threshold) eligible += 1
      if (res?.saved) saved += 1
    }

    totalSaved += saved
    totalEligible += eligible
    totalChecked += checked

    console.log('[backfill] profile', {
      profile_id: profileId,
      display_name: p.display_name ?? null,
      opportunities_checked: checked,
      eligible,
      inserted: saved,
      threshold,
    })
  }

  console.log('[backfill] done', {
    profiles: profiles.length,
    opportunities_checked: totalChecked,
    eligible: totalEligible,
    inserted: totalSaved,
    threshold,
  })
}

await main()

