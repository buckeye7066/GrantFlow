import { resolveApplicationUrl } from '../../shared/applicationTarget.js'

/**
 * Discover catalog display keep rules.
 *
 * Backend ACCEPT and directory/referral rows must never be re-dropped by the
 * client slider. "Found but not displayed" is a bug, not a UX choice.
 */

export function isDirectoryDiscoverRow(opp) {
  return Boolean(
    opp?.is_directory ||
      opp?.is_directory_resource ||
      ['DIRECTORY', 'REFERRAL', 'SCHOOL_PORTAL', 'PAST_AWARD_INTEL'].includes(
        String(opp?.opportunity_kind ?? '').toUpperCase(),
      ),
  )
}

/**
 * @param {object} opp
 * @param {number} minScoreFloor
 * @param {boolean} recoveryApplied
 * @returns {boolean}
 */
export function normalizeDiscoverResultPayload(payload) {
  const normalized = payload?.data ?? payload ?? {}
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : {}
}

export function keepDiscoverCatalogRow(opp, minScoreFloor, recoveryApplied) {
  const decision = String(opp?.match_decision ?? opp?.decision ?? '').trim().toUpperCase()
  if (decision === 'ACCEPT') return true
  if (isDirectoryDiscoverRow(opp)) return true
  const score = Number(opp?.match_score ?? opp?.match ?? -Infinity)
  if (Number.isFinite(score) && score >= minScoreFloor) return true
  return Boolean(
    recoveryApplied &&
      (opp?.threshold_relaxed || opp?.eligibility_relaxed || opp?.geo_expanded),
  )
}

/** The catalog-to-Discover boundary consumed by SearchResults. */
export function mapDiscoverCatalogRow(opp) {
  return {
        id: opp.id,
        funding_opportunity_id: opp.funding_opportunity_id,
        opportunity_id: opp.opportunity_id,
        source_id: opp.source_id,
        fingerprint: opp.fingerprint,
        canonical_opportunity_key: opp.canonical_opportunity_key,
        title: opp.title,
        program_name: opp.title,
        sponsor: opp.sponsor || opp.funder,
        application_url: resolveApplicationUrl(opp),
        source_url: opp.source_url ?? opp.url ?? null,
        url: resolveApplicationUrl(opp) ?? opp.source_url ?? opp.url,
        deadline: opp.deadline,
        deadlineAt: opp.deadline,
        description: opp.description,
        descriptionMd: opp.description,
        match_score: opp.match_score,
        match: opp.match_score,
        match_decision: opp.match_decision ?? opp.decision ?? null,
        opportunity_kind: opp.opportunity_kind ?? opp.kind ?? null,
        matched_fields: opp.match_reasons ?? [],
        matchReasons: opp.match_reasons ?? [],
        source: opp.source || 'catalog',
        record_origin: opp.record_origin ?? null,
        usable_for_housing: opp.usable_for_housing ?? false,
        refund_potential: opp.refund_potential ?? false,
        funding_category: opp.funding_category ?? null,
        is_directory: Boolean(opp.is_directory) || isDirectoryDiscoverRow(opp),
        threshold_relaxed: opp.threshold_relaxed ?? false,
        eligibility_relaxed: opp.eligibility_relaxed ?? false,
        geo_expanded: opp.geo_expanded ?? false,
  }
}
