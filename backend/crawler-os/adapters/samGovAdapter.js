// crawler-os/adapters/samGovAdapter.js
//
// SAM.gov assistance listings (formerly CFDA). Emits PROGRAM candidates (standing
// federal assistance programs). Loan/cost-share signals are carried through
// truthfully and gated per-profile by the reality gate + match engine. The
// adapter NEVER fabricates rows to fill a gap — a dead/empty response yields zero.
//
// ENDPOINT NOTE (2026-06-23): the legacy host `api.sam.gov/prod/sgs/v1/search`
// was retired (returns 404 "Page Not Found") — this silently produced ZERO
// SAM.gov results for every org/business profile in prod. The live search service
// is `sam.gov/api/prod/sgs/v1/search`, requires the `application/hal+json` Accept
// header (else 406), and is KEYLESS (the SAM_GOV_API_KEY only gates the rate-
// limited api.sam.gov data APIs). The response is HAL: `_embedded.results[]` with
// fields `programNumber`, `title`, `organizationHierarchy.name`, `isActive`,
// `isLatest`, `_id` (the FAL deep-link id). The historical index returns inactive
// listings too, so we drop `isActive === false` rows.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { buildCrawlerQueries, inferCandidateProfile, inferFundingFlags } from '../crawlerVocabulary.js';

const ENDPOINT = 'https://sam.gov/api/prod/sgs/v1/search';

export function createSamGovAdapter() {
  return createBaseAdapter({
    source_id: 'sam_gov',
    family: 'api',
    // No requiredEnv: the assistance-listings search is keyless. We still pass the
    // key when present (some SAM hosts raise limits for keyed callers).
    buildRequests(thesis, source, env) {
      const key = env?.SAM_GOV_API_KEY ?? '';
      const keyParam = key ? `&api_key=${encodeURIComponent(key)}` : '';
      return buildCrawlerQueries(thesis, source, { limit: 3 }).map((keyword) => {
        const q = encodeURIComponent(keyword || 'assistance');
        const url = `${ENDPOINT}?index=cfda&q=${q}&page=0&size=25${keyParam}`;
        return {
          url,
          query: keyword,
          init: { headers: { accept: 'application/hal+json' } },
          parseCfg: {
            listPath: '_embedded.results',
            requiredListPath: true,
            map: {
              external_id: 'programNumber',
              title: 'title',
              sponsor: 'organizationHierarchy.name',
              fal_id: '_id',
              is_active: 'isActive',
            },
          },
        };
      });
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      // Drop retired/historical listings — only standing (active) programs are fundable.
      if (raw.is_active === false) return null;
      const num = raw.external_id != null ? String(raw.external_id) : null;
      const falId = raw.fal_id != null ? String(raw.fal_id) : null;
      const infoUrl = falId
        ? `https://sam.gov/fal/${encodeURIComponent(falId)}/view`
        : 'https://sam.gov/content/assistance-listings';
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: num,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'U.S. Federal Agency',
        summary: raw.summary ?? null,
        deadline: null,
        is_rolling: true, // standing program
        apply_url: null, // a PROGRAM is not a single apply link
        info_url: infoUrl,
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

export default { createSamGovAdapter };
