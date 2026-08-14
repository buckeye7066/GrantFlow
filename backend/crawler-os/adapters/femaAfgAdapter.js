// crawler-os/adapters/femaAfgAdapter.js
//
// FEMA Assistance to Firefighters Grants (AFG/SAFER/etc). Posted on the federal
// Grants.gov catalog, so this adapter uses the real public Search2 API (no key)
// and keeps only FEMA/firefighter-program hits. Filtering includes sponsor,
// agencyCode, and title/program signals so sub-agency naming does not silently
// lose good firefighter opportunities.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { grantsSearchParseCfg } from './grantsGovAdapter.js';
import {
  agencyLooksLike, buildCrawlerQueries, inferCandidateProfile, inferFundingFlags,
} from '../crawlerVocabulary.js';

const SEARCH_ENDPOINT = 'https://api.grants.gov/v1/api/search2';
const DETAIL_BASE = 'https://www.grants.gov/search-results-detail';
// NOTE the deliberate absence of the `i` flag on the two ACRONYMS. These are
// tested by `agencyLooksLike` against a haystack that joins title + summary +
// sponsor + agency + number + description, so `/\bSAFER\b/i` matched the
// ordinary comparative adjective "safer" ("make communities safer", "safer
// streets") — extremely common in DOT/HHS/DOJ abstracts — and admitted
// arbitrary federal grants into the `fema_afg` lane as DIRECT_GRANTs. AFG and
// SAFER are always upper-case in this feed, so case-sensitivity costs no real
// FEMA row and is strictly more precise. The multi-word phrases keep `i`
// because they cannot collide with an unrelated word.
const FEMA_PATTERNS = [
  /\bFEMA\b/i,
  /assistance to firefighters/i,
  /\bAFG\b/,
  /\bSAFER\b/,
  /firefighters? grants?/i,
  /fire prevention/i,
];

export function createFemaAfgAdapter() {
  return createBaseAdapter({
    source_id: 'fema_afg',
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
      if (!agencyLooksLike(raw, FEMA_PATTERNS)) return null;
      const id = raw.external_id != null ? String(raw.external_id) : null;
      const applyUrl = id ? `${DETAIL_BASE}/${encodeURIComponent(id)}` : null;
      const profile = inferCandidateProfile(raw, source);
      const fundingFlags = inferFundingFlags(raw);
      return {
        external_id: id,
        kind: OPPORTUNITY_KIND.DIRECT_GRANT,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'Federal Emergency Management Agency',
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

export default { createFemaAfgAdapter };
