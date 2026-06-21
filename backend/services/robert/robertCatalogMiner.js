/**
 * robertCatalogMiner.js
 *
 * Robert's PRIMARY discovery surface: mine the EXISTING GrantFlow funding
 * catalog (`funding_opportunities`) — the universe the crawlers, school-portal
 * imports, the email→grant feeder, and manual curation have already populated —
 * and turn it into per-profile recommendations.
 *
 * This is deliberately NOT Yana-style live web lead discovery. Robert never
 * fetches the open web here. He reads rows that already exist in the catalog,
 * scores them against each profile with the CANONICAL matcher, drops the ones
 * the user has already acted on, applies the canonical relevance floor, and
 * queues recommendations through Robert's existing recommendation/notification
 * path. The directive: "SEARCH THE EXISTING GrantFlow funding database and match
 * it to every profile."
 *
 * Reuses (never re-implements) the canonical building blocks:
 *   - matchEngine.computeMatchDecision   (via robertMatchBridge.scoreOpportunityForProfile)
 *   - pipelineExclusion.filterOutPipelineMembers
 *   - config/relevanceFloor.{RELEVANCE_FLOOR,TRUSTED_RELEVANCE_FLOOR,isTrustedRecordOrigin}
 *   - robertRecommendationService.createRecommendationIfHelpful
 *
 * Posture: no silent failures (every swallowed error is logged + surfaced in the
 * returned summary), no fabricated opportunities (we only ever read real rows),
 * recall-over-suppression (a query error returns nothing for THAT profile but
 * never throws the whole run).
 */

import { createLogger } from '../../utils/logger.js'
import { filterOutPipelineMembers } from '../pipelineExclusion.js'
import { scoreOpportunityForProfile } from './robertMatchBridge.js'
import { createRecommendationIfHelpful } from './robertRecommendationService.js'
import {
  RELEVANCE_FLOOR,
  TRUSTED_RELEVANCE_FLOOR,
  isTrustedRecordOrigin,
} from '../../config/relevanceFloor.js'

const log = createLogger('robert-catalog-miner')

/**
 * The relevance floor a scored catalog row must clear before Robert will queue
 * a recommendation for it. Mirrors the canonical INSERT floor used by
 * `saveToProfilePipeline`: 55 for open-web rows, 40 for vetted/trusted origins
 * (curated catalog, scholarship/school crawlers, federal feeds, verified rows).
 * A REJECT decision is blocked regardless of origin (the matcher already zeroed
 * the score, but we guard explicitly too).
 */
export function effectiveFloorFor(opportunity, decision) {
  if (String(decision || '').toUpperCase() === 'REJECT') return Number.POSITIVE_INFINITY
  return isTrustedRecordOrigin(opportunity?.record_origin)
    ? TRUSTED_RELEVANCE_FLOOR
    : RELEVANCE_FLOOR
}

/**
 * Query a BROAD, capped slice of the catalog relevant to a profile: national
 * rows plus rows tagged to the profile's state/county. We deliberately favour
 * recall — the canonical matcher does the precise scoring downstream, and the
 * relevance floor + pipeline exclusion do the trimming. Geo is a soft signal
 * here (G4: geo mismatch reduces score, it does not hard-filter), so a profile
 * with no state still gets the national + recent slice.
 *
 * Returns [] on any failure (logged) so one profile's bad query never aborts the
 * whole mining pass.
 *
 * @param {object} db
 * @param {{ state?: string|null, county?: string|null }} geo
 * @param {number} cap
 */
export async function fetchCatalogForProfile(db, geo = {}, cap = 100) {
  if (!db?.prepare) return []
  const limit = Math.max(1, Math.min(Number(cap) || 100, 500))
  const state = norm(geo.state)
  const county = norm(geo.county)

  // Build the WHERE so we always include national + directory-style rows
  // (which must survive filtering per G4/directory rule) and, when we know the
  // profile's geo, the rows tagged to that state/county. Active + non-hidden
  // only. We intentionally do NOT filter on link_status (directory + freshly
  // ingested rows often start 'unverified'; link_unverified ≠ dead).
  const clauses = [
    "COALESCE(is_active, 1) IN (1, TRUE, 'true', 't')",
    "COALESCE(is_hidden, 0) IN (0, FALSE, 'false', 'f')",
  ]
  const geoOr = ["COALESCE(is_national, 0) IN (1, TRUE, 'true', 't')"]
  const params = []
  if (state) {
    geoOr.push('UPPER(state) = ?')
    params.push(state.toUpperCase())
    // also include rows with no state tag at all — neutral, not disqualifying
    geoOr.push("COALESCE(state, '') = ''")
  } else {
    // No profile geo: don't constrain by geo at all (recall).
    geoOr.length = 0
  }
  if (county) {
    geoOr.push('LOWER(geo_county) = ?')
    params.push(county.toLowerCase())
  }
  if (geoOr.length > 0) clauses.push(`(${geoOr.join(' OR ')})`)

  const sql = `SELECT *
                 FROM funding_opportunities
                WHERE ${clauses.join(' AND ')}
                ORDER BY COALESCE(updated_at, created_at) DESC
                LIMIT ?`
  try {
    return (await db.prepare(sql).all(...params, limit)) || []
  } catch (err) {
    log.warn('fetchCatalogForProfile failed (returning none for this profile)', {
      state,
      county,
      error: String(err?.message || err),
    })
    return []
  }
}

/**
 * Mine the catalog for ALL the supplied profiles and queue recommendations for
 * strong matches.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {string[]} args.profileIds
 * @param {Function} args.getCtx            — async (db, profileId) => profileContext
 * @param {object}  args.config             — Robert config (toast thresholds etc.)
 * @param {string} [args.runId]
 * @param {boolean}[args.dryRun]            — score + report, but never insert a rec
 * @param {Function}[args.computeMatchDecision] — injectable canonical matcher
 * @param {number} [args.perProfileCap]     — catalog rows pulled per profile
 * @param {Array}  [args.errors]            — run summary errors array (appended to)
 * @param {Array}  [args.matched]           — run summary matched array (appended to)
 * @param {Array}  [args.recommendations]   — run summary recs array (appended to)
 * @param {object} [args.counters]          — run counters (incremented)
 * @returns {Promise<{ profiles_mined, rows_considered, excluded_pipeline, matched, recommendations_created }>}
 */
export async function mineCatalogForProfiles({
  db,
  profileIds = [],
  getCtx,
  config = {},
  runId = null,
  dryRun = false,
  computeMatchDecision = null,
  perProfileCap = null,
  errors = [],
  matched = [],
  recommendations = [],
  counters = {},
} = {}) {
  if (!db) throw new Error('mineCatalogForProfiles: db required')
  if (typeof getCtx !== 'function') throw new Error('mineCatalogForProfiles: getCtx required')

  const cap = Number(perProfileCap) || Number(config.maxOpportunitiesPerRun) || 100
  const out = {
    profiles_mined: 0,
    rows_considered: 0,
    excluded_pipeline: 0,
    below_floor: 0,
    matched: 0,
    recommendations_created: 0,
  }

  for (const profileId of profileIds) {
    let ctx
    try {
      ctx = await getCtx(db, profileId)
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200)
      errors.push({ stage: 'catalog_mine_load_ctx', profile_id: profileId, error: msg })
      log.warn('catalog mine: failed to load profile context', { profileId, error: msg })
      continue
    }
    if (!ctx?.profile) continue
    out.profiles_mined += 1

    const geo = extractGeo(ctx)
    const rows = await fetchCatalogForProfile(db, geo, cap)
    out.rows_considered += rows.length
    if (rows.length === 0) continue

    // Drop anything already in this profile's pipeline / dismissed. Strictly
    // profile-scoped; recall-over-suppression (returns input unfiltered on error).
    let candidates = rows
    try {
      const filtered = await filterOutPipelineMembers(db, profileId, rows)
      candidates = filtered.results
      out.excluded_pipeline += filtered.excluded
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200)
      errors.push({ stage: 'catalog_mine_exclusion', profile_id: profileId, error: msg })
      log.warn('catalog mine: pipeline exclusion failed (using unfiltered list)', { profileId, error: msg })
    }

    for (const opp of candidates) {
      let decision
      try {
        decision = await scoreOpportunityForProfile({
          profileContext: ctx,
          opportunity: opp,
          computeMatchDecision,
        })
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200)
        errors.push({ stage: 'catalog_mine_score', profile_id: profileId, opportunity_id: opp.id, error: msg })
        continue
      }
      if (!decision) continue

      const floor = effectiveFloorFor(opp, decision.decision)
      if (Number(decision.score) < floor) {
        out.below_floor += 1
        continue
      }

      out.matched += 1
      if (counters) counters.opportunities_matched = (counters.opportunities_matched || 0) + 1
      matched.push({
        profile_id: ctx.profile.id,
        opportunity_id: opp.id,
        score: decision.score,
        decision: decision.decision,
        source: 'catalog_mine',
      })

      if (dryRun) continue

      let recResult
      try {
        recResult = await createRecommendationIfHelpful({
          db,
          profileId: ctx.profile.id,
          opportunityId: opp.id,
          matchDecision: decision.decision,
          matchScore: decision.score,
          matchReasons: decision.reasons || [],
          missingProfileFields: decision.missingProfileFields || [],
          whyFound: `Robert matched this from the GrantFlow funding catalog (source: ${opp.source || opp.record_origin || 'catalog'}).`,
          searchQueryUsed: 'catalog_mine',
          opportunityCandidateId: null,
          robertRunId: runId,
          opportunityTitle: opp.title,
          profileDisplayName: ctx.profile.display_name || 'this profile',
          config,
        })
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200)
        errors.push({ stage: 'catalog_mine_recommend', profile_id: profileId, opportunity_id: opp.id, error: msg })
        continue
      }
      if (recResult?.created) {
        out.recommendations_created += 1
        if (counters) counters.recommendations_created = (counters.recommendations_created || 0) + 1
        recommendations.push({
          id: recResult.recommendation_id,
          profile_id: ctx.profile.id,
          opportunity_id: opp.id,
          decision: decision.decision,
          score: decision.score,
          source: 'catalog_mine',
        })
      }
    }
  }

  log.info('catalog mining pass complete', out)
  return out
}

/** Pull a {state, county} from a profile context (profile row + signals). */
export function extractGeo(ctx) {
  const profile = ctx?.profile || {}
  const sig = ctx?.signals || {}
  const sections = ctx?.sections || {}
  const state =
    profile.state ||
    sig.state ||
    sections?.location_focus?.state ||
    sections?.basic_information?.state ||
    null
  const county =
    profile.county ||
    sig.county ||
    sections?.location_focus?.county ||
    sections?.basic_information?.county ||
    sections?.housing?.county ||
    null
  return { state: norm(state), county: norm(county) }
}

function norm(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}
