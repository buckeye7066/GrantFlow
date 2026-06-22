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

const SEARCH_ENDPOINT = 'https://api.grants.gov/v1/api/search2';
const DETAIL_BASE = 'https://www.grants.gov/search-results-detail';

export function createGrantsGovAdapter() {
  return createBaseAdapter({
    source_id: 'grants_gov',
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
      const id = raw.external_id != null ? String(raw.external_id) : null;
      const applyUrl = id ? `${DETAIL_BASE}/${encodeURIComponent(id)}` : null;
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: id,
        kind: OPPORTUNITY_KIND.DIRECT_GRANT,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'U.S. Federal Agency',
        summary: raw.summary ?? (raw.number ? `Funding opportunity ${raw.number} (${raw.opp_status ?? 'posted'}).` : null),
        deadline: normalizeGrantsDate(raw.deadline),
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
      opp_status: 'oppStatus',
    },
  };
}

// Grants.gov closeDate often arrives as MM/DD/YYYY; normalize to ISO date.
function normalizeGrantsDate(d) {
  if (!d) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(d).trim());
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return String(d);
}

export default { createGrantsGovAdapter };
