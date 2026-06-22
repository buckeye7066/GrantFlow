// crawler-os/adapters/samGovAdapter.js
//
// SAM.gov assistance listings (formerly CFDA). The real API requires a key
// (SAM_GOV_API_KEY). Without the key the adapter reports the missing env and the
// pipeline records an honest SKIPPED(missing_env) — it NEVER fabricates rows to
// fill the gap. With a key, it emits PROGRAM candidates (standing programs).
//
// Listings can include loan/cost-share programs; those signals are carried
// through truthfully and gated per-profile by the reality gate + match engine.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { buildCrawlerQueries, inferCandidateProfile, inferFundingFlags } from '../crawlerVocabulary.js';

const ENDPOINT = 'https://api.sam.gov/prod/sgs/v1/search';

export function createSamGovAdapter() {
  return createBaseAdapter({
    source_id: 'sam_gov',
    family: 'api',
    requiredEnv: ['SAM_GOV_API_KEY'],
    buildRequests(thesis, source, env) {
      const key = env?.SAM_GOV_API_KEY ?? '';
      return buildCrawlerQueries(thesis, source, { limit: 3 }).map((keyword) => {
        const q = encodeURIComponent(keyword || 'assistance');
        const url = `${ENDPOINT}?api_key=${encodeURIComponent(key)}&index=cfda&q=${q}&size=25`;
        return {
          url,
          query: keyword,
          init: { headers: { accept: 'application/json' } },
          parseCfg: {
            listPath: '_embedded.results',
            requiredListPath: true,
            map: {
              external_id: 'programNumber',
              title: 'title',
              sponsor: 'organizationName',
              summary: 'objective',
              assistance_type: 'assistanceType',
            },
          },
        };
      });
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      const num = raw.external_id != null ? String(raw.external_id) : null;
      const infoUrl = num
        ? `https://sam.gov/fal/${encodeURIComponent(num)}/view`
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
