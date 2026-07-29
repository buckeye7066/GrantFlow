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
import {
  isFundingResource,
  partitionFundingSources,
} from '../services/matching/fundingSourcePresentation.js'
import { SURFACED_MATCHER_VERSIONS_SQL, qualifiesForDisplay } from '../config/matchSurfacing.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import {
  ensurePipelineDismissalsSchema,
  recordDismissal,
  reconcileDismissedGrants,
  reconcileDismissedMatches,
} from '../services/pipelineDismissals.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:funding-sources')
const router = express.Router()

/**
 * getAccessibleProfileIds returns a Set of ids, or null as its DB-backed admin
 * sentinel. Global access, however, is authorized only by req.ctx.isAdmin: a
 * second helper call can disagree with the already-built request context after
 * a transient lookup failure. A null returned while the canonical context says
 * non-admin therefore fails closed instead of widening access.
 *
 * Both Set and Array containers are accepted so the gate remains stable if the
 * helper's scoped return type is widened later.
 */
export async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (req.ctx?.isAdmin === true) return true

  const id = String(profileId)
  const contextAccessible = req.ctx?.accessibleProfileIds
  if (contextAccessible instanceof Set) return contextAccessible.has(id)
  if (Array.isArray(contextAccessible)) return contextAccessible.includes(id)

  // Compatibility fallback for direct/unit callers that do not run the request
  // context middleware. Null is deliberately denied here: only the explicit
  // isAdmin branch above may grant global access.
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible instanceof Set) return accessible.has(id)
  return Array.isArray(accessible) && accessible.includes(id)
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

  // Default = the canonical data-point-scale bar (8), NOT the retired 75/50
  // scale — a hard-coded 50 here returned near-nothing for any caller that
  // omitted min_score (the 2026-07-28 audit's stale-constant class). Clamp to
  // the slider range so a junk query param cannot go negative/absurd.
  const requestedMinScore = Number.parseInt(req.query.min_score, 10)
  const minScore = Number.isFinite(requestedMinScore)
    ? Math.max(0, Math.min(100, requestedMinScore))
    : DEFAULT_MIN_SCORE

  try {
    const profileContext = buildProfileFacets(await loadProfileContext(req.db, profileId))
    // Sticky deletes: a source the owner removed from this list must never
    // re-render, even if a discovery run re-upserted its match row between
    // boots (the boot sweep is the net; this predicate is the per-read gate).
    await ensurePipelineDismissalsSchema(req.db)
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
          AND NOT EXISTS (
            SELECT 1 FROM pipeline_dismissals d
             WHERE d.profile_id = pom.profile_id
               AND ((d.opportunity_id IS NOT NULL AND d.opportunity_id = pom.opportunity_id)
                 OR (d.title IS NOT NULL AND lower(d.title) = lower(fo.title)))
          )
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
      is_directory: isFundingResource(r),
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
        opportunity_kind: kind || null,
        is_directory: isFundingResource(r),
        trust_tier: r.source_trust_tier ?? null,
      })
    }

    // The canonical display gate — never an inlined score predicate (the
    // matchSurfacing.js contract): an engine ACCEPT below the floor still
    // surfaces (the Anastasia-HOPE class), a REJECT/low REVIEW never does, and
    // non-direct resources keep their own display floor.
    const qualified = sources.filter((s) => qualifiesForDisplay(s, minScore))
    const presented = partitionFundingSources(qualified)
    return res.json({
      profile_id: profileId,
      engine: 'crawler-os',
      min_score: minScore,
      ...presented,
      geo_stubs_hidden: geoStubsHidden,
    })
  } catch (err) {
    log.warn('funding_sources.failed', { profileId, error: err?.message || String(err) })
    return res.status(200).json({
      profile_id: profileId,
      total: 0,
      sources: [],
      best_matches: [],
      worth_reviewing: [],
      directories: [],
      resource_count: 0,
      note: 'funding sources unavailable',
    })
  }
})

/**
 * DELETE /api/profiles/:id/funding-sources/:opportunityId
 *
 * Owner-facing STICKY delete from the curated match list. Records a
 * pipeline_dismissals tombstone (the same store the pipeline's sticky-delete
 * rule uses, so the matcher / promotion / re-crawl loop can never resurrect
 * this source for this profile), then purges the match row and any pipeline
 * grant already created from it via the canonical reconcile sweeps.
 *
 * A deliberate re-add (POST /api/grants/from-opportunity) clears the
 * tombstone, so this is reversible by the user.
 */
router.delete('/profiles/:id/funding-sources/:opportunityId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.params?.id || '').trim()
  const opportunityId = String(req.params?.opportunityId || '').trim()
  if (!profileId || !opportunityId) {
    return res.status(400).json({ error: 'profile id and opportunity id required' })
  }
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const opportunity = await req.db.prepare(
      'SELECT * FROM funding_opportunities WHERE id = ?',
    ).get(opportunityId)

    // The match row may point at an already-purged catalog row (the dangling-
    // match class); a tombstone keyed on opportunity_id alone still blocks it.
    const dismissal = await recordDismissal(req.db, {
      profileId,
      opportunity: opportunity ?? { id: opportunityId },
      userId: user.id ?? user.email ?? null,
      reason: 'owner_removed_from_funding_sources',
    })
    if (!dismissal.recorded) {
      return res.status(422).json({ error: 'could not record dismissal', reason: dismissal.reason })
    }

    // Purge through the canonical sweeps (profile-scoped by tombstone), so
    // this delete and the boot net can never disagree on what "gone" means.
    const matchRowsRemoved = await reconcileDismissedMatches(req.db)
    const grantsRemoved = await reconcileDismissedGrants(req.db)

    log.info('funding_sources.dismissed', {
      profileId, opportunityId, matchRowsRemoved, grantsRemoved,
      alreadyExisted: dismissal.alreadyExisted === true,
    })
    return res.json({
      dismissed: true,
      profile_id: profileId,
      opportunity_id: opportunityId,
      match_rows_removed: matchRowsRemoved,
      pipeline_grants_removed: grantsRemoved,
    })
  } catch (err) {
    log.error('funding_sources.dismiss_failed', { profileId, opportunityId, error: err?.message || String(err) })
    return res.status(500).json({ error: 'failed to remove funding source' })
  }
})

export default router
