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

const SEARCH_ENDPOINT = 'https://api.grants.gov/v1/api/search2';
const DETAIL_BASE = 'https://www.grants.gov/search-results-detail';
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
        url: SEARCH_ENDPOINT,
        query: keyword,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ keyword, oppStatuses: 'posted', rows: 25, startRecordNum: 0 }),
        },
        parseCfg: grantsSearchParseCfg(),
      }));
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      if (!agencyLooksLike(raw, USDA_PATTERNS)) return null;
      const id = raw.external_id != null ? String(raw.external_id) : null;
      const applyUrl = id ? `${DETAIL_BASE}/${encodeURIComponent(id)}` : null;
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: id,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'U.S. Department of Agriculture',
        summary: raw.summary ?? (raw.number ? `Funding opportunity ${raw.number} (${raw.opp_status ?? 'posted'}).` : null),
        deadline: normalizeDate(raw.deadline),
        is_rolling: false,
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

function normalizeDate(d) {
  if (!d) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d).trim());
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return String(d);
}

export default { createUsdaRdAdapter };
