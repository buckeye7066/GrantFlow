// crawler-os/adapters/grantsGovAdapter.js
//
// Grants.gov — the U.S. federal grants catalog. Uses the real public Search2 JSON
// API (POST https://api.grants.gov/v1/api/search2). No API key required. Returns
// DIRECT_GRANT candidates whose apply_url is the canonical opportunity detail page.
//
// Optimized crawler behavior:
// - runs a small deterministic query set instead of one brittle keyword string;
// - marks the Search2 JSON contract as required so schema drift becomes a
//   PARSE_ERROR rather than a misleading empty result;
// - infers concrete need/applicant categories and funding flags from the source
//   row instead of relying on broad source-level wildcards.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { buildCrawlerQueries, inferCandidateProfile, inferFundingFlags } from '../crawlerVocabulary.js';
import { GRANTS_GOV_SEARCH2_URL } from '../../config/grantsGovEndpoints.js';
import {
  buildGrantsGovSearchPayload,
  grantsGovDetailUrl,
  normalizeGrantsGovDate,
  normalizeGrantsGovStatus,
} from '../../services/shared/grantsGovApiClient.js';

// Map our canonical applicant buckets → grants.gov applicant-eligibility codes
// (verified against the live Search2 eligibility facets). Filtering the query by
// these codes is server-side precision: a CHURCH (nonprofit) no longer receives
// school-district/IHE-only grants (OESE/OSEP special-ed etc.), which were
// scoring 85-95 as false positives because the adapter tagged every grant with
// the source row's broad org applicant types. '99' (unrestricted) is always
// included so genuinely-open grants still surface.
const GRANTS_GOV_ELIGIBILITY_CODES = Object.freeze({
  nonprofit: ['12', '13'],
  church: ['12', '13'],
  ministry: ['12', '13'],
  school: ['05', '06', '20'],
  government: ['00', '01', '02', '04', '07'],
  business: ['22', '23'],
  vfd: ['04', '02'],
  farm: ['25'],
  individual: ['21'],
  family: ['21'],
  student: ['21'],
  veteran: ['21'],
});
const UNRESTRICTED_ELIGIBILITY = '99';

/**
 * Build the grants.gov `eligibilities` filter for a thesis. Returns '' (no
 * filter — preserve recall) when the profile's applicant types are unknown or
 * explicitly broad ('*'); otherwise a comma-separated code list = the profile's
 * codes + unrestricted.
 */
export function eligibilitiesFor(thesis = {}) {
  const types = Array.isArray(thesis.applicant_types) ? thesis.applicant_types : [];
  if (types.length === 0 || types.includes('*')) return '';

  // A PARTIAL MAP CANNOT DESCRIBE THE PROFILE, SO IT MUST NOT NARROW THE QUERY.
  //
  // `GRANTS_GOV_ELIGIBILITY_CODES` covers 12 of the canonical applicant buckets.
  // `profileIntelligence.js` also emits `tribal` and `law_enforcement`
  // (ORG_APPLICANT_TYPES) and `teacher`, `candidate`, `active_duty`,
  // `guard_reserve`, `transitioning_service_member`, `military_spouse`,
  // `widow`/`widower`/`surviving_spouse`, `patient`, `dementia_patient`
  // (INDIVIDUAL_APPLICANT_TYPES) — none of which appear above.
  //
  // The old rule only skipped the filter when NOTHING mapped. So a tribal
  // organization that is also a nonprofit resolved to `99|12|13` and grants.gov
  // was asked, server-side, for nonprofit grants ONLY — silently excluding the
  // tribal-specific federal funding that is the whole reason that bucket exists.
  // Same for a teacher who is also a student, or a police/fire agency that is
  // also a government body. The profile lost the grants its own declared
  // identity qualifies it for, and nothing reported a gap.
  //
  // The fix is the posture this function already documents for the unknown case:
  // when we cannot express the profile, DO NOT CONSTRAIN — preserve recall and
  // let `matchEngine.computeMatchDecision` (the sole relevance authority) decide.
  // Deliberately NOT fixed by inventing codes: the mappings above are documented
  // as verified against the live Search2 facets, and guessing a code here would
  // be a fabricated claim about the API. Extending the map is a follow-up that
  // needs a live verification, not a guess.
  const unmapped = types.filter((t) => !GRANTS_GOV_ELIGIBILITY_CODES[String(t).toLowerCase()]);
  if (unmapped.length > 0) return '';

  const codes = new Set([UNRESTRICTED_ELIGIBILITY]);
  for (const t of types) {
    for (const c of GRANTS_GOV_ELIGIBILITY_CODES[String(t).toLowerCase()] ?? []) codes.add(c);
  }
  // Only 99 → nothing profile-specific mapped; don't constrain (recall).
  if (codes.size <= 1) return '';
  // grants.gov Search2 ORs eligibility codes with a PIPE delimiter. A comma
  // returns 0 hits (treated as one invalid token) — verified against the live
  // API — so the delimiter choice is load-bearing, not cosmetic.
  return [...codes].join('|');
}

export function createGrantsGovAdapter() {
  return createBaseAdapter({
    source_id: 'grants_gov',
    family: 'api',
    requiredEnv: [], // public API
    buildRequests(thesis, source) {
      const eligibilities = eligibilitiesFor(thesis);
      return buildCrawlerQueries(thesis, source, { limit: 4 }).map((keyword) => ({
        url: GRANTS_GOV_SEARCH2_URL,
        query: keyword,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          // Server-side eligibility filter scopes results to what the profile can
          // actually apply for (precision); omitted entirely for broad/unknown
          // profiles to preserve recall.
          body: JSON.stringify(buildGrantsGovSearchPayload({
            keyword,
            oppStatus: 'posted',
            rows: 25,
            startRow: 0,
            eligibilities,
          })),
        },
        parseCfg: grantsSearchParseCfg(),
      }));
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      // Search2 exposes both an internal numeric detail id and the public
      // opportunity number. The public number is the canonical source identity
      // used by the direct Grants.gov ingester; retaining the numeric id here
      // created two source identities for the same federal opportunity. Keep
      // the internal id only for the authoritative detail URL.
      const detailId = raw.external_id != null ? String(raw.external_id) : null;
      const opportunityNumber = raw.number != null ? String(raw.number).trim() : '';
      const sourceId = opportunityNumber || detailId;
      const applyUrl = grantsGovDetailUrl(detailId, opportunityNumber || null);
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: sourceId,
        kind: OPPORTUNITY_KIND.DIRECT_GRANT,
        title: raw.title ?? null,
        // Owner rule 2026-08-03: never anonymize the funder — a missing agency
        // stays NULL (honest missing) and rides the no-sponsor handling.
        sponsor: raw.sponsor ?? null,
        summary: raw.summary ?? (raw.number ? `Funding opportunity ${raw.number} (${raw.opp_status ?? 'posted'}).` : null),
        open_date: normalizeGrantsGovDate(raw.open_date),
        deadline: normalizeGrantsGovDate(raw.deadline),
        source_status: normalizeGrantsGovStatus(raw.opp_status),
        first_published_at: normalizeGrantsGovDate(raw.posted_date),
        is_rolling: false,
        application_method: 'grants.gov',
        apply_url: applyUrl,
        info_url: applyUrl,
        applicant_types: profile.applicant_types,
        need_categories: profile.need_categories,
        geography: source?.geography ?? { national: true, states: [] },
        is_loan: fundingFlags.is_loan,
        requires_cost_share: fundingFlags.requires_cost_share,
        raw,
      };
    },
  });
}

export function grantsSearchParseCfg() {
  return {
    listPath: 'data.oppHits',
    requiredListPath: true,
    map: {
      external_id: 'id',
      number: 'number',
      title: 'title',
      summary: 'synopsis',
      sponsor: 'agency',
      agency_code: 'agencyCode',
      deadline: 'closeDate',
      open_date: 'openDate',
      posted_date: 'postedDate',
      opp_status: 'oppStatus',
    },
  };
}

export default { createGrantsGovAdapter };
