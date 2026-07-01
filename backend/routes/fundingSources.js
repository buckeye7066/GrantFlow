/**
 * GET /api/profiles/:id/funding-sources
 *
 * The owner-facing, friendly list of funding sources matched to a profile by the
 * Crawler OS. Unlike the raw discovery catalog or Hamilton's mail/fax packet
 * list, this is the curated per-profile match list: profile_opportunity_matches
 * (the per-profile score — Crawler OS) joined to the global funding_opportunities
 * catalog, sorted by match score, geo-stubs excluded, grouped accept/review.
 *
 * Auth: authenticated caller, profile-access scoped (admin sees all; others only
 * profiles they can access) — same gate as the rest of the profile surface.
 */
import express from 'express'
import { requireAuthenticatedUser, getAccessibleProfileIds } from '../utils/accessControl.js'
import { isTemplatedGeoStub } from '../services/relevanceFilterRules.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:funding-sources')
const router = express.Router()

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (user?.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  return Array.isArray(accessible) && accessible.includes(profileId)
}

function jparse(v, fallback) {
  if (v === null || v === undefined) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

router.get('/profiles/:id/funding-sources', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const minScore = Number.isFinite(Number.parseInt(req.query.min_score, 10)) ? Number.parseInt(req.query.min_score, 10) : 50

  try {
    const profileContext = buildProfileFacets(await loadProfileContext(req.db, profileId))
    const rows = await req.db.prepare(
      `SELECT fo.id, fo.title, fo.sponsor, fo.description, fo.deadline, fo.deadline_type,
              fo.amount_min, fo.amount_max, fo.state, fo.is_national,
              fo.application_url, fo.apply_url, fo.source_url, fo.source, fo.source_id,
              fo.record_origin, fo.opportunity_kind, fo.opportunity_type, fo.type, fo.funding_type,
              fo.source_trust_tier, fo.categories, fo.keywords,
              pom.match_score, pom.match_decision, pom.match_explanation, pom.match_reasons
         FROM profile_opportunity_matches pom
         JOIN funding_opportunities fo ON fo.id = pom.opportunity_id
        WHERE pom.profile_id = ? AND pom.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          AND (fo.is_active IS NULL OR fo.is_active = 1)
          AND (fo.is_hidden IS NULL OR fo.is_hidden = 0)
        ORDER BY pom.match_score DESC, fo.updated_at DESC`,
    ).all(profileId)

    const mapped = rows.map((r) => ({
      ...r,
      match_score: r.match_score,
      match_decision: r.match_decision,
      match_explanation: r.match_explanation,
      match_reasons: jparse(r.match_reasons, []),
      url: r.application_url ?? r.apply_url ?? r.source_url ?? null,
      actionable_url: r.application_url ?? r.apply_url ?? r.source_url ?? null,
      is_directory: String(r.opportunity_kind ?? '').toUpperCase() === 'DIRECTORY' ||
        String(r.opportunity_kind ?? '').toUpperCase() === 'PAST_AWARD_INTEL',
    }))
    const canonical = canonicalizeOpportunityList(profileContext, mapped, {
      preserveDirectories: true,
      rejectHardIneligible: true,
    })
    const sources = []
    let geoStubsHidden = 0
    for (const r of canonical.kept) {
      if (isTemplatedGeoStub({ title: r.title, opportunity_kind: r.opportunity_kind })) { geoStubsHidden += 1; continue }
      const kind = String(r.opportunity_kind ?? '').toUpperCase()
      sources.push({
        id: r.id,
        title: r.title,
        sponsor: r.sponsor,
        summary: r.description,
        url: r.application_url ?? r.apply_url ?? r.source_url ?? null,
        deadline: r.deadline ?? null,
        is_rolling: r.deadline_type === 'rolling' || !r.deadline,
        amount_min: r.amount_min ?? null,
        amount_max: r.amount_max ?? null,
        geography: r.is_national ? 'National' : (r.state || null),
        categories: jparse(r.categories, []),
        match_score: r.match_score,
        match_decision: r.match_decision, // accept | review | reject
        why: r.match_explanation,
        is_directory: kind === 'DIRECTORY' || kind === 'PAST_AWARD_INTEL',
        trust_tier: r.source_trust_tier ?? null,
      })
    }

    const qualified = sources.filter((s) => Number(s.match_score) >= minScore)
    return res.json({
      profile_id: profileId,
      engine: 'crawler-os',
      min_score: minScore,
      total: qualified.length,
      // Honest grouping for the owner: apply-now vs worth-a-look vs directories.
      best_matches: qualified.filter((s) => String(s.match_decision).toLowerCase() === 'accept' && !s.is_directory),
      worth_reviewing: qualified.filter((s) => String(s.match_decision).toLowerCase() === 'review' && !s.is_directory),
      directories: qualified.filter((s) => s.is_directory),
      sources: qualified,
      geo_stubs_hidden: geoStubsHidden,
    })
  } catch (err) {
    log.warn('funding_sources.failed', { profileId, error: err?.message || String(err) })
    return res.status(200).json({ profile_id: profileId, total: 0, sources: [], best_matches: [], worth_reviewing: [], directories: [], note: 'funding sources unavailable' })
  }
})

export default router
