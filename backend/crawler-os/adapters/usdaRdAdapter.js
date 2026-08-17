// crawler-os/adapters/usdaRdAdapter.js
//
// USDA Rural Development — community facilities, rural utilities, and related
// rural programs. These are surfaced through the public Grants.gov Search2 API
// and filtered back to USDA/Rural Development signals. The filter is intentionally
// broader than `/usda/` alone because live feeds often identify sub-agencies in
// agencyCode/title instead of the sponsor string.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { grantsSearchParseCfg } from './grantsGovAdapter.js';
import {
  agencyLooksLike, buildCrawlerQueries, inferCandidateProfile, inferFundingFlags,
} from '../crawlerVocabulary.js';
import {
  GRANTS_GOV_SEARCH2_URL,
  buildGrantsGovSearchPayload,
  normalizeGrantsGovDate,
  resolveGrantsGovIdentity,
} from '../../../shared/grantsGovProtocol.js';

const USDA_PATTERNS = [
  /\bUSDA\b/i,
  /department of agriculture/i,
  /rural development/i,
  /rural utilities/i,
  /rural housing/i,
  /^RD[\s-]/i,
];

export function createUsdaRdAdapter() {
  return createBaseAdapter({
    source_id: 'usda_rd',
    family: 'api',
    requiredEnv: [], // public API
    buildRequests(thesis, source) {
      return buildCrawlerQueries(thesis, source, { limit: 4 }).map((keyword) => ({
        url: GRANTS_GOV_SEARCH2_URL,
        query: keyword,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(buildGrantsGovSearchPayload({
            keyword, oppStatus: 'posted', rows: 25, startRow: 0,
          })),
        },
        parseCfg: grantsSearchParseCfg(),
      }));
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      if (!agencyLooksLike(raw, USDA_PATTERNS)) return null;
      const identity = resolveGrantsGovIdentity(raw);
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: identity.sourceId,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'U.S. Department of Agriculture',
        summary: raw.summary ?? (raw.number ? `Funding opportunity ${raw.number} (${raw.opp_status ?? 'posted'}).` : null),
        deadline: normalizeGrantsGovDate(raw.deadline),
        is_rolling: false,
        apply_url: identity.detailUrl,
        info_url: identity.detailUrl,
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

export default { createUsdaRdAdapter };
