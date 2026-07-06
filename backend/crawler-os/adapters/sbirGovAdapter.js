// crawler-os/adapters/sbirGovAdapter.js
//
// SBIR.gov — Small Business Innovation Research / Small Business Technology
// Transfer (SBIR/STTR) solicitations. This is the PRIMARY federal funding
// universe for a small research-capable company (biotech, life sciences,
// deep tech): ~$4B/yr in set-aside R&D awards across 11 agencies. Uses the
// free public JSON API (https://api.www.sbir.gov/public/api/solicitations)
// — NO API key.
//
// Response shape (documented public schema): a BARE ARRAY of solicitation
// objects — hence parseCfg.listPath = '' (root list) + requiredListPath so any
// schema drift (or the API's known "not available at this time" JSON object)
// surfaces as an honest PARSE_ERROR, never a silent empty result.
//
// NOTE (2026-07-06): the SBIR public API is currently returning
// "The SBIR Public API is not available at this time" service-wide. The
// adapter is built to the documented schema and reports honestly until the
// service returns (same posture as the CareerOneStop precedent).
//
// Each result is a PROGRAM candidate: agencies run their own submission
// portals, so apply_url is the agency solicitation link when present and the
// sbir.gov detail page is the info_url. Deadlines map from close_date.
// Self-contained: imports only from within crawler-os.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

const SOLICITATIONS_ENDPOINT = 'https://api.www.sbir.gov/public/api/solicitations';

// Bounded, deterministic keyword set: the org's extracted research topic first,
// then a broad SBIR sweep so a niche topic can't zero out the lane.
function buildKeywords(thesis = {}) {
  const keywords = [];
  const topic = typeof thesis.research_topic === 'string' ? thesis.research_topic.trim() : '';
  if (topic) keywords.push(topic);
  keywords.push('research');
  return [...new Set(keywords)].slice(0, 2);
}

function buildUrl(keyword) {
  const params = new URLSearchParams();
  params.set('keyword', keyword);
  params.set('open', '1'); // open solicitations only — closed ones are not actionable
  return `${SOLICITATIONS_ENDPOINT}?${params.toString()}`;
}

export function sbirGovParseCfg() {
  return {
    listPath: '', // the response IS the list (bare JSON array at the root)
    requiredListPath: true, // schema drift / API-down object -> honest PARSE_ERROR
    map: {
      external_id: 'solicitation_number',
      title: 'solicitation_title',
      program: 'program',
      phase: 'phase',
      agency: 'agency',
      branch: 'branch',
      close_date: 'close_date',
      open_date: 'open_date',
      current_status: 'current_status',
      info_url: 'sbir_solicitation_link',
      agency_url: 'solicitation_agency_url',
      topics: 'solicitation_topics',
    },
  };
}

/** First ~3 topic titles as an honest summary — never invented text. */
function summarizeTopics(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return null;
  const titles = topics
    .map((t) => (t && typeof t === 'object' ? t.topic_title || t.title : null))
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(0, 3);
  if (!titles.length) return null;
  const suffix = topics.length > titles.length ? ` (+${topics.length - titles.length} more topics)` : '';
  return `Topics: ${titles.join('; ')}${suffix}`;
}

export function createSbirGovAdapter() {
  return createBaseAdapter({
    source_id: 'sbir_gov',
    family: 'api',
    requiredEnv: [], // public API, no key
    buildRequests(thesis, _source) {
      return buildKeywords(thesis).map((keyword) => ({
        url: buildUrl(keyword),
        query: keyword,
        parseCfg: sbirGovParseCfg(),
      }));
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.title && !raw.external_id)) return null;
      const infoUrl = typeof raw.info_url === 'string' && raw.info_url.trim() ? raw.info_url.trim() : null;
      const agencyUrl = typeof raw.agency_url === 'string' && raw.agency_url.trim() ? raw.agency_url.trim() : null;
      if (!infoUrl && !agencyUrl) return null; // nothing official to point at -> not surfaced
      const program = raw.program ? String(raw.program).toUpperCase() : 'SBIR';
      const phaseText = raw.phase ? ` Phase ${raw.phase}` : '';
      return {
        external_id: raw.external_id != null ? String(raw.external_id) : null,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: raw.title ?? null,
        sponsor: raw.agency
          ? `${raw.agency} (${program}${phaseText})`
          : `U.S. ${program} Program`,
        summary: summarizeTopics(raw.topics),
        // close_date is the solicitation's real close; leave null when absent
        // (never an invented "apply now" date).
        deadline: raw.close_date ?? null,
        is_rolling: false,
        apply_url: agencyUrl,
        info_url: infoUrl ?? agencyUrl,
        applicant_types: ['business', 'nonprofit'],
        need_categories: ['research_funding', 'technology', 'startup'],
        geography: source?.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createSbirGovAdapter, sbirGovParseCfg };
