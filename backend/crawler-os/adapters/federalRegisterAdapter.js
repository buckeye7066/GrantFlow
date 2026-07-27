// crawler-os/adapters/federalRegisterAdapter.js
//
// Federal Register — the daily journal of the U.S. government. Agencies publish
// Notices of Funding Opportunity / Funding Availability (NOFO/NOFA) here, often
// BEFORE or alongside the Grants.gov listing, and many programs that never get a
// Grants.gov synopsis still appear here. Uses the free public JSON API
// (https://www.federalregister.gov/api/v1/documents.json) — NO API key.
//
// Each result is a PROGRAM candidate whose info_url is the canonical
// federalregister.gov document page. PROGRAM rows survive the reality gate with
// an info_url alone (no fabricated apply_url) and are stored for REVIEW — honest
// "here is the official notice; read it and apply through the agency" provenance.
//
// Self-contained: imports only from within crawler-os.

import { createBaseAdapter } from './baseAdapter.js';
import { OPPORTUNITY_KIND } from '../contract.js';

const DOCUMENTS_ENDPOINT = 'https://www.federalregister.gov/api/v1/documents.json';

// Bounded, deterministic query set. "funding opportunity" is the high-precision
// base term; we add up to two of the profile's derived needs so a fire
// department gets equipment/emergency NOFOs and a clinic gets medical ones,
// without an unbounded keyword fan-out.
function buildTerms(thesis = {}) {
  const terms = ['funding opportunity'];
  const needs = Array.isArray(thesis.needs) ? thesis.needs.filter(Boolean) : [];
  for (const n of needs.slice(0, 2)) terms.push(`funding ${n}`);
  return [...new Set(terms)].slice(0, 3);
}

function buildUrl(term) {
  const params = new URLSearchParams();
  params.set('conditions[term]', term);
  params.append('conditions[type][]', 'NOTICE');
  params.set('per_page', '20');
  params.set('order', 'newest');
  for (const f of ['document_number', 'title', 'html_url', 'abstract', 'publication_date', 'agencies']) {
    params.append('fields[]', f);
  }
  return `${DOCUMENTS_ENDPOINT}?${params.toString()}`;
}

// Funding-signal vocabulary. The Federal Register `term` search matches the
// phrase anywhere in the FULL document, but we only keep a notice's title +
// abstract — so a meeting / information-collection / correction notice that
// merely mentions "funding opportunity" deep in its body arrives with a
// title/abstract about something else. Requiring one of these signals in the
// kept text is the high-precision, recall-safe filter: a real NOFO's title or
// abstract virtually always carries funding language, so genuine opportunities
// survive while body-only matches (the junk) are dropped.
const FEDERAL_REGISTER_FUNDING_SIGNALS = [
  'funding opportunity', 'notice of funding', 'nofo', 'nofa',
  'funding availability', 'availability of funds', 'available funds',
  'cooperative agreement', 'financial assistance', 'assistance listing',
  'grant', 'grants', 'solicitation', 'request for application',
  'request for proposal', 'invites application', 'applications are invited',
  'apply for', 'award',
];

function hasFederalRegisterFundingSignal(...parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  return FEDERAL_REGISTER_FUNDING_SIGNALS.some((s) => hay.includes(s));
}

// PROCEDURAL EXCLUSION — outranks the funding-signal include above. A
// Paperwork Reduction Act / information-collection / comment notice often
// NAMES a real funding program in its title ("30-Day Notice of Proposed
// Information Collection: … Community Project Funding Grants"), so the
// funding vocabulary reads as a NOFO — but there is nothing to apply to, for
// anyone. LOCAL copy of RE_PROCEDURAL_NOTICE_TITLE in
// services/opportunityNormalizer.js (crawler-os stays self-contained); the
// drift tripwire in backend/tests/matchEngineResearchProgramGuard.test.js
// asserts the two regexes stay identical.
export const RE_PROCEDURAL_NOTICE_TITLE =
  /\b(?:30|60)[- ]day notice\b|\bnotice of proposed information collection\b|\bproposed information collection\b|\bpaperwork reduction act\b|\brequest for (?:comments?|information)\b|\bnotice of a federal advisory\b/i;

export function federalRegisterParseCfg() {
  return {
    listPath: 'results',
    requiredListPath: true, // schema drift -> honest PARSE_ERROR, never a silent empty
    map: {
      external_id: 'document_number',
      title: 'title',
      info_url: 'html_url',
      summary: 'abstract',
      agencies: 'agencies',
      publication_date: 'publication_date',
    },
  };
}

export function createFederalRegisterAdapter() {
  return createBaseAdapter({
    source_id: 'federal_register',
    family: 'api',
    requiredEnv: [], // public API, no key
    buildRequests(thesis, _source) {
      return buildTerms(thesis).map((term) => ({
        url: buildUrl(term),
        query: term,
        parseCfg: federalRegisterParseCfg(),
      }));
    },
    mapCandidate(raw, { source } = {}) {
      if (!raw || (!raw.external_id && !raw.title)) return null;
      // agencies is an array of { name, raw_name, ... }; first is the publisher.
      const agencyName = Array.isArray(raw.agencies) && raw.agencies.length
        ? (raw.agencies[0]?.name || raw.agencies[0]?.raw_name || null)
        : null;
      const infoUrl = typeof raw.info_url === 'string' ? raw.info_url.trim() : null;
      if (!infoUrl) return null; // no official notice URL -> nothing to surface honestly
      // PROCEDURAL EXCLUSION first: a PRA/comment notice naming a funding
      // program in its title would otherwise pass the funding-signal gate.
      if (RE_PROCEDURAL_NOTICE_TITLE.test(String(raw.title ?? ''))) return null;
      // PRECISION GATE (recall-safe): drop notices whose kept text (title +
      // abstract) shows no funding signal — these matched the term only in their
      // body and are meeting/rule/information-collection notices, not NOFOs.
      if (!hasFederalRegisterFundingSignal(raw.title, raw.summary)) return null;
      return {
        external_id: raw.external_id != null ? String(raw.external_id) : null,
        kind: OPPORTUNITY_KIND.PROGRAM,
        title: raw.title ?? null,
        sponsor: agencyName || 'U.S. Federal Agency',
        summary: raw.summary ?? null,
        // Federal Register notices don't carry a structured deadline; leave null
        // (the reality gate stores it as LINK_UNVERIFIED for REVIEW, never as a
        // fake "apply now" with an invented date).
        deadline: null,
        is_rolling: false,
        apply_url: null,         // PROGRAM: the official notice IS the info_url
        info_url: infoUrl,
        applicant_types: source?.applicant_types ?? ['nonprofit', 'school', 'government', 'business'],
        need_categories: source?.need_categories ?? ['*'],
        geography: source?.geography ?? { national: true, states: [] },
        is_loan: false,
        requires_cost_share: false,
        raw,
      };
    },
  });
}

export default { createFederalRegisterAdapter, federalRegisterParseCfg };
