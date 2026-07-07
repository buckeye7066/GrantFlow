// crawler-os/adapters/propublica990Adapter.js
//
// ProPublica Nonprofit Explorer — IRS 990 grantmaker discovery. Free public
// JSON API, no key (https://projects.propublica.org/nonprofits/api/). This is
// the 990-backed foundation universe (what GrantWatch/Candid charge for):
// grantmaking foundations discovered by NTEE classification + state, surfaced
// as approach-the-funder PROGRAM rows. Honesty rules:
//
//   - only rows that are recognizably GRANTMAKERS (NTEE major group T —
//     Philanthropy/Grantmaking — or an unambiguous foundation/charitable-trust
//     name) become candidates; a service nonprofit is not presented as a funder;
//   - apply_url is NEVER invented — info_url is the real ProPublica profile page
//     (the funder is approached directly);
//   - no deadline and no award amount is fabricated (the search endpoint carries
//     neither); summary text states only what the filing data says.
//
// KNOWN QUIRK (prod logs): the search API returns HTTP 404 when cur_page runs
// past num_pages. A page-overrun 404 is an honest END OF PAGES, not a failure —
// benignFetchFailure() below tells the pipeline so. Every other failure (500s,
// network errors, schema drift) degrades honestly (FETCH_ERROR / PARSE_ERROR,
// the sbir_gov precedent).
//
// VENDORED logic from backend/src/integrations/propublica990.js and
// backend/constants/nteeMapping.js — copied, not imported: the crawler-os
// boundary (tests/legacy-crawler-ban.test.mjs) forbids reaching outside the OS.
// The need→NTEE map below is re-keyed to the OS need taxonomy
// (profileIntelligence NEED_KEYWORDS slugs), not the legacy taxonomy.
//
// Self-contained: imports only from within crawler-os.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

const PP_BASE = 'https://projects.propublica.org/nonprofits/api/v2';
const PP_ORG_URL = 'https://projects.propublica.org/nonprofits/organizations';

// ProPublica's search filter (`ntee[id]`) wants the numeric MAJOR GROUP (1-10),
// NOT a letter or full code — sending a letter returns HTTP 500. (Vendored.)
export const NTEE_LETTER_TO_GROUP = Object.freeze({
  A: 1,
  B: 2,
  C: 3, D: 3,
  E: 4, F: 4, G: 4, H: 4,
  I: 5, J: 5, K: 5, L: 5, M: 5, N: 5, O: 5, P: 5,
  Q: 6,
  R: 7, S: 7, T: 7, U: 7, V: 7, W: 7,
  X: 8,
  Y: 9,
  Z: 10,
});

// OS need slug → NTEE major-group LETTERS (vendored from constants/nteeMapping
// and re-keyed to the crawler-os need taxonomy). Conservative: only needs with
// an obvious NTEE home are mapped; unmapped needs simply add no extra group.
const OS_NEED_TO_NTEE = Object.freeze({
  arts_education: ['A'],
  library_media: ['A', 'B'],
  education: ['B'],
  scholarship: ['B'],
  tuition: ['B'],
  environmental_remediation: ['C'],
  water_sewer: ['C'],
  animal_welfare: ['D'],
  medical: ['E'],
  medical_bills: ['E'],
  medication: ['E'],
  cancer_support: ['G'],
  dementia_support: ['G'],
  mental_health: ['F'],
  substance_recovery: ['F'],
  legal: ['I'],
  employment: ['J'],
  workforce: ['J'],
  food: ['K'],
  agriculture: ['K'],
  school_nutrition: ['K'],
  housing: ['L'],
  housing_development: ['L'],
  emergency: ['M'],
  public_safety: ['M'],
  recreation: ['N'],
  disability: ['P'],
  caregiving: ['P'],
  transportation: ['P'],
  childcare: ['P'],
  survivor_benefits: ['P'],
  domestic_violence: ['P'],
  economic_development: ['S'],
  community_facilities: ['S'],
  infrastructure: ['S'],
  technology: ['U'],
  broadband: ['U'],
  veterans: ['W'],
});

// Reverse: NTEE letter → OS need slugs, so a found grantmaker's classification
// yields concrete need categories for the match engine (never invented ones).
const NTEE_LETTER_TO_OS_NEEDS = Object.freeze({
  A: ['arts_education', 'programs'],
  B: ['education'],
  C: ['environmental_remediation'],
  D: ['animal_welfare'],
  E: ['medical'],
  F: ['mental_health', 'substance_recovery'],
  G: ['medical', 'cancer_support'],
  H: ['medical'],
  I: ['legal'],
  J: ['employment', 'workforce'],
  K: ['food', 'agriculture'],
  L: ['housing'],
  M: ['emergency', 'public_safety'],
  N: ['recreation'],
  O: ['programs'],
  P: ['programs'],
  S: ['economic_development', 'community_facilities'],
  U: ['technology'],
  W: ['veterans', 'programs'],
  X: ['programs'],
});

/**
 * needsToNteeGroups — the OS-thesis equivalent of the vendored
 * needsToNteeCodes(): needs → NTEE letters → unique numeric major groups.
 * Group 7 (which contains T = Philanthropy/Grantmaking — the foundations that
 * fund others) is ALWAYS included, and first.
 */
export function needsToNteeGroups(needs = [], { limit = 3 } = {}) {
  const groups = [NTEE_LETTER_TO_GROUP.T]; // 7 — always search grantmakers
  for (const need of needs ?? []) {
    const letters = OS_NEED_TO_NTEE[String(need ?? '').trim().toLowerCase()] ?? [];
    for (const letter of letters) {
      const g = NTEE_LETTER_TO_GROUP[letter];
      if (g && !groups.includes(g)) groups.push(g);
    }
  }
  return groups.slice(0, Math.max(1, limit));
}

// Bounded pagination depth per NTEE group. Overrun 404s are benign (see
// benignFetchFailure), so a group with a single page of results costs one
// harmless extra request, never a fake FETCH_ERROR.
const PAGES_PER_GROUP = 2;

function buildSearchUrl({ nteeGroup, state, page }) {
  // ProPublica expects filters as array-style indexed params (state[id],
  // ntee[id]); bare `state=`/`ntee=` make the API 500. URL-encoded bracket keys
  // are accepted. (Vendored contract from src/integrations/propublica990.js.)
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (nteeGroup) params.set('ntee[id]', String(nteeGroup));
  if (state) params.set('state[id]', String(state).toUpperCase());
  return `${PP_BASE}/search.json?${params.toString()}`;
}

export function propublica990ParseCfg() {
  return {
    listPath: 'organizations',
    requiredListPath: true, // schema drift -> honest PARSE_ERROR, never silent empty
    map: {
      external_id: 'ein',
      name: 'name',
      city: 'city',
      state: 'state',
      ntee_code: 'ntee_code',
      subsection_code: 'subseccd',
      score: 'score',
    },
  };
}

// A search hit is surfaced ONLY when it is recognizably a grantmaker: NTEE
// major group T (Philanthropy, Voluntarism & Grantmaking) or an unambiguous
// foundation/charitable-trust name. Service nonprofits are not funders.
const RE_GRANTMAKER_NAME = /\b(foundation|charitable trust|philanthropic|philanthropy|grantmak\w*)\b/i;
export function looksLikeGrantmaker(raw = {}) {
  const ntee = String(raw.ntee_code ?? '').trim().toUpperCase();
  if (ntee.startsWith('T')) return true;
  return RE_GRANTMAKER_NAME.test(String(raw.name ?? ''));
}

function normalizeEin(ein) {
  const digits = String(ein ?? '').replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

export function createPropublica990Adapter() {
  return createBaseAdapter({
    source_id: 'propublica_990',
    family: 'api',
    requiredEnv: [], // free public API, no key
    buildRequests(thesis, _source) {
      const groups = needsToNteeGroups(thesis?.needs ?? []);
      const rawState = thesis?.location?.state;
      const state = typeof rawState === 'string' && /^[a-z]{2}$/i.test(rawState.trim())
        ? rawState.trim().toUpperCase()
        : null; // full state names are not a valid state[id] filter — omit
      const requests = [];
      for (const nteeGroup of groups) {
        for (let page = 0; page < PAGES_PER_GROUP; page += 1) {
          requests.push({
            url: buildSearchUrl({ nteeGroup, state, page }),
            query: `ntee:${nteeGroup}${state ? ` state:${state}` : ''} page:${page}`,
            meta: { pp_page: page },
            parseCfg: propublica990ParseCfg(),
          });
        }
      }
      return requests;
    },
    // KNOWN QUIRK: the search API 404s when the requested page runs past
    // num_pages. That is an honest end-of-pages for THIS lane — the pipeline
    // treats it as a clean empty page instead of a FETCH_ERROR. Only a 404
    // whose body carries NO organizations qualifies; any body that still
    // contains organizations (or any other status) degrades honestly.
    benignFetchFailure(resp = {}, req = {}) {
      if (resp.status !== 404) return false;
      if (!req?.meta || req.meta.pp_page == null || req.meta.pp_page < 1) return false;
      if (typeof resp.body === 'string' && resp.body.trim()) {
        try {
          const parsed = JSON.parse(resp.body);
          const orgs = parsed?.organizations;
          if (Array.isArray(orgs) && orgs.length > 0) return false; // data lost — real error
        } catch {
          // non-JSON 404 body (ProPublica's HTML error page) — still an overrun
        }
      }
      return true;
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw) return null;
      const ein = normalizeEin(raw.external_id);
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (!ein || !name) return null;
      if (!looksLikeGrantmaker(raw)) return null; // only real grantmakers become funder rows
      const ntee = String(raw.ntee_code ?? '').trim().toUpperCase() || null;
      const nteeNeeds = ntee ? (NTEE_LETTER_TO_OS_NEEDS[ntee.charAt(0)] ?? null) : null;
      const orgState = typeof raw.state === 'string' && /^[a-z]{2}$/i.test(raw.state.trim())
        ? raw.state.trim().toUpperCase()
        : null;
      return {
        external_id: ein,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: `${name} — Foundation/Grantmaker`,
        sponsor: name,
        summary: [
          raw.city && orgState ? `Location: ${String(raw.city).trim()}, ${orgState}` : null,
          ntee ? `NTEE: ${ntee}` : null,
          'IRS 990-listed grantmaking organization (approach the funder directly; no open deadline is implied).',
        ].filter(Boolean).join(' | '),
        deadline: null, // grantmaker entity, not a dated solicitation — never invented
        is_rolling: false,
        apply_url: null, // NEVER invented — the funder is approached directly
        info_url: `${PP_ORG_URL}/${ein}`,
        applicant_types: source?.applicant_types ?? ['nonprofit'],
        need_categories: nteeNeeds ?? source?.need_categories ?? ['*'],
        // Conservative geo: scope to the foundation's own state when known
        // (requests are already state-filtered from the thesis); national only
        // when the filing carries no state.
        geography: orgState ? { national: false, states: [orgState] } : (source?.geography ?? { national: true, states: [] }),
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createPropublica990Adapter, propublica990ParseCfg, needsToNteeGroups, looksLikeGrantmaker, NTEE_LETTER_TO_GROUP };
