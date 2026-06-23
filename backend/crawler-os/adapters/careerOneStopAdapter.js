// crawler-os/adapters/careerOneStopAdapter.js
//
// CareerOneStop Scholarship Finder (U.S. Department of Labor) — the first REAL
// specific-opportunity source for INDIVIDUALS (students/families/veterans). The
// public API requires a free DOL token (CAREERONESTOP_USER_ID + CAREERONESTOP_TOKEN);
// without them the adapter reports the missing env and the pipeline records an
// honest SKIPPED(missing_env) — it NEVER fabricates scholarships.
//
// API (documented): GET
//   https://api.careeronestop.org/v1/scholarships/{userId}/{keyword}/{sort}/{sortDir}/{startRecord}/{limit}/{ascending}
//   Authorization: Bearer {token}
//   -> { Scholarships: [ { ScholarshipId, ScholarshipName, OrganizationName,
//        Purpose, AwardAmountDescription/MaximumAward, DeadlineDate, Url, ... } ],
//        RecordCount }
//
// NOTE: the response FIELD NAMES below are mapped to the documented schema but
// have NOT been verified against a live response (no token available at build
// time). If DOL's field casing differs, the pipeline raises an honest
// PARSE_ERROR (requiredListPath) on the first real run rather than emitting
// wrong/empty data — confirm the map against one live payload when the token is
// set.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';
import { buildCrawlerQueries } from '../crawlerVocabulary.js';

const API_BASE = 'https://api.careeronestop.org/v1/scholarships';

export function createCareerOneStopAdapter() {
  return createBaseAdapter({
    source_id: 'careeronestop_scholarships',
    family: 'api',
    requiredEnv: ['CAREERONESTOP_USER_ID', 'CAREERONESTOP_TOKEN'],
    buildRequests(thesis, source, env) {
      const userId = env?.CAREERONESTOP_USER_ID ?? '';
      const token = env?.CAREERONESTOP_TOKEN ?? '';
      // Profile-keyword queries (study area / need), defaulting to a broad
      // scholarship search so an under-specified individual profile still
      // returns real awards.
      const keywords = buildCrawlerQueries(thesis, source, { limit: 3 });
      const list = keywords.length ? keywords : ['scholarship'];
      return list.map((kw) => {
        const keyword = encodeURIComponent(kw || 'scholarship');
        // path: {userId}/{keyword}/{sortColumns}/{sortDirection}/{startRecord}/{limit}/{ascending}
        const url = `${API_BASE}/${encodeURIComponent(userId)}/${keyword}/AwardAmount/DESC/0/25/false`;
        return {
          url,
          query: kw,
          init: { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } },
          parseCfg: {
            listPath: 'Scholarships',
            requiredListPath: true,
            map: {
              external_id: 'ScholarshipId',
              title: 'ScholarshipName',
              sponsor: 'OrganizationName',
              summary: 'Purpose',
              award_text: 'AwardAmountDescription',
              award_max: 'MaximumAward',
              deadline: 'DeadlineDate',
              apply_url: 'Url',
              level: 'Level',
            },
          },
        };
      });
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      const id = raw.external_id != null ? String(raw.external_id) : null;
      // A scholarship's own application URL is the actionable link; fall back to
      // the CareerOneStop detail page when the award didn't carry one.
      const applyUrl =
        (typeof raw.apply_url === 'string' && /^https?:\/\//i.test(raw.apply_url) ? raw.apply_url : null) ||
        (id ? `https://www.careeronestop.org/Toolkit/Training/find-scholarships.aspx` : null);
      const amountMax = Number(raw.award_max);
      return {
        external_id: id,
        kind: OPPORTUNITY_KIND.SCHOLARSHIP,
        title: raw.title ?? null,
        sponsor: raw.sponsor ?? 'Scholarship sponsor',
        summary: raw.summary ?? raw.award_text ?? null,
        deadline: normalizeDate(raw.deadline),
        is_rolling: !raw.deadline,
        apply_url: applyUrl,
        info_url: applyUrl,
        // This source is, by construction, individual-facing.
        applicant_types: ['student', 'individual', 'family', 'veteran'],
        need_categories: ['education'],
        geography: source?.geography ?? { national: true, states: [] },
        funding: Number.isFinite(amountMax) && amountMax > 0 ? { amount_max: amountMax } : undefined,
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

// CareerOneStop deadlines arrive in mixed formats; pass ISO through, coerce
// MM/DD/YYYY, else return as-is (the reality gate handles unparseable dates).
function normalizeDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return s;
}

export default { createCareerOneStopAdapter };
