// crawler-os/contract.js
//
// THE canonical contract for GrantFlow Crawler OS.
//
// ONE normalized Opportunity shape. ONE set of opportunity kinds, trust tiers,
// crawler outcome statuses, match decisions, reason codes, and telemetry shapes.
// Every adapter, parser, reality gate, normalizer, match engine, and storage row
// speaks THIS language. No component invents its own shape or its own
// ACCEPT/REVIEW/REJECT logic.
//
// Pure data + tiny pure helpers. No I/O, no DB, no network.

import { createHash } from 'node:crypto';

/**
 * Opportunity kinds. The kind drives how the reality gate and match engine treat
 * a row. A DIRECTORY is honestly a pointer to more sources, NOT an "apply now"
 * grant. A PAST_AWARD_INTEL row is market intelligence, NOT an open opportunity.
 */
export const OPPORTUNITY_KIND = Object.freeze({
  DIRECT_GRANT: 'DIRECT_GRANT',       // an actual open funding opportunity you apply to
  PROGRAM: 'PROGRAM',                 // a standing funding program (opens/closes on cycles)
  DIRECTORY: 'DIRECTORY',             // a locator/list of funders — a pointer, not an application
  SCHOLARSHIP: 'SCHOLARSHIP',         // education award for an individual
  IN_KIND: 'IN_KIND',                 // non-cash support (goods, services, space)
  BENEFIT: 'BENEFIT',                 // government/social benefit (SNAP, LIHEAP, etc.)
  PAST_AWARD_INTEL: 'PAST_AWARD_INTEL', // historical award data — intelligence, never "apply now"
});
export const OPPORTUNITY_KINDS = Object.freeze(Object.values(OPPORTUNITY_KIND));

/** Kinds a user can actually apply to right now. */
export const APPLICABLE_KINDS = Object.freeze([
  OPPORTUNITY_KIND.DIRECT_GRANT,
  OPPORTUNITY_KIND.PROGRAM,
  OPPORTUNITY_KIND.SCHOLARSHIP,
  OPPORTUNITY_KIND.IN_KIND,
  OPPORTUNITY_KIND.BENEFIT,
]);

/** Source trust tiers. Higher = more trustworthy provenance. */
export const TRUST_TIER = Object.freeze({
  OFFICIAL_API: 'OFFICIAL_API',           // government/official structured API (Grants.gov, SAM.gov)
  OFFICIAL_HTML: 'OFFICIAL_HTML',         // official agency website, scraped HTML
  VERIFIED_FOUNDATION: 'VERIFIED_FOUNDATION', // known foundation / 990-backed funder
  AGGREGATOR: 'AGGREGATOR',               // reputable aggregator/directory (211, foundation locator)
  UNVERIFIED: 'UNVERIFIED',               // discovered via open web search, not yet corroborated
});

/** Numeric weight 0..1 for each trust tier, used by the match engine. */
export const TRUST_TIER_WEIGHT = Object.freeze({
  [TRUST_TIER.OFFICIAL_API]: 1.0,
  [TRUST_TIER.OFFICIAL_HTML]: 0.85,
  [TRUST_TIER.VERIFIED_FOUNDATION]: 0.75,
  [TRUST_TIER.AGGREGATOR]: 0.5,
  [TRUST_TIER.UNVERIFIED]: 0.25,
});

/**
 * Reality status — the verdict of the reality gate. The SINGLE source of truth
 * for "is this real and apply-able". Honesty is mandatory.
 */
export const REALITY_STATUS = Object.freeze({
  VERIFIED: 'verified',               // real sponsor, safe URL, evidence captured, active
  ROLLING: 'rolling',                 // real, no fixed deadline (accepts applications continuously)
  LINK_UNVERIFIED: 'link_unverified', // plausible but evidence URL not yet confirmed
  DIRECTORY: 'directory',             // honestly a directory/locator, not a direct application
  INTEL_ONLY: 'intel_only',           // past-award / market intel, never "apply now"
  EXPIRED: 'expired',                 // deadline clearly passed
  REJECTED: 'rejected',               // failed the reality gate
});

/** Reality statuses acceptable to store as live catalog rows. */
export const ACCEPTABLE_REALITY_STATUSES = Object.freeze([
  REALITY_STATUS.VERIFIED,
  REALITY_STATUS.ROLLING,
  REALITY_STATUS.LINK_UNVERIFIED,
  REALITY_STATUS.DIRECTORY,
  REALITY_STATUS.INTEL_ONLY,
]);

/** Crawler outcome statuses for a source run (telemetry, not opportunity state). */
export const CRAWLER_OUTCOME = Object.freeze({
  OK: 'ok',                   // ran and produced results
  EMPTY: 'empty',             // ran cleanly but produced zero results
  SKIPPED: 'skipped',         // honestly skipped (e.g. missing API key) — NOT a failure, NOT fake data
  RATE_LIMITED: 'rate_limited',
  FETCH_ERROR: 'fetch_error',
  PARSE_ERROR: 'parse_error',
  BLOCKED: 'blocked',         // robots/policy blocked
  ERROR: 'error',
});

/**
 * Match decision band. Doctrine-mandated triad: ACCEPT / REVIEW / REJECT.
 * Produced ONLY by matchEngine.computeMatchDecision. No other component may
 * invent these.
 */
export const MATCH_DECISION = Object.freeze({
  ACCEPT: 'accept',   // strong, recommend to the user (a.k.a. "recommend")
  REVIEW: 'review',   // plausible but needs a human look
  REJECT: 'reject',   // below floor / disqualified
});

/** Stable reason codes used by the reality gate and the zero-result ladder. */
export const REASON = Object.freeze({
  NO_SOURCES_SELECTED: 'no_sources_selected',
  ALL_SOURCES_SKIPPED: 'all_sources_skipped',
  ALL_FETCHES_FAILED: 'all_fetches_failed',
  NO_CANDIDATES_PARSED: 'no_candidates_parsed',
  ALL_REJECTED_BY_REALITY: 'all_rejected_by_reality',
  ALL_BELOW_MATCH_FLOOR: 'all_below_match_floor',
  BAD_URL: 'bad_url',
  PLACEHOLDER_CONTENT: 'placeholder_content',
  LOAN_NOT_ALLOWED: 'loan_not_allowed',
  COST_SHARE_NOT_ALLOWED: 'cost_share_not_allowed',
  EXPIRED_DEADLINE: 'expired_deadline',
  NO_SPONSOR: 'no_sponsor',
  NO_EVIDENCE: 'no_evidence',
  SEARCH_URL_AS_APPLY: 'search_url_as_apply',
  GEO_STUB: 'geo_stub',
  DUPLICATE: 'duplicate',
});

/**
 * deterministicOpportunityId — stable id derived from identity-bearing fields so
 * the same real opportunity from the same source produces the same id across
 * runs (idempotent upsert). Profile is NOT part of the id: the catalog row is
 * global; match scores live per-profile elsewhere.
 *
 * @param {{ source_id?:string, sponsor?:string, title?:string, apply_url?:string, external_id?:string }} parts
 * @returns {string} sha256 hex digest
 */
export function deterministicOpportunityId(parts = {}) {
  const source = String(parts.source_id ?? '').trim().toLowerCase();
  const external = String(parts.external_id ?? '').trim().toLowerCase();
  const identity = external
    ? `ext:${external}`
    : [
        String(parts.sponsor ?? '').trim().toLowerCase(),
        String(parts.title ?? '').trim().toLowerCase(),
        normalizeUrlForId(parts.apply_url),
      ].join('|');
  return createHash('sha256').update(`${source}::${identity}`).digest('hex');
}

/**
 * canonicalOpportunityKey — SOURCE-INDEPENDENT identity of a real-world
 * opportunity, used for durable cross-run / cross-source dedup. Unlike
 * deterministicOpportunityId (which folds in source_id so each crawler's find is
 * traceable), this collapses the same real opportunity surfaced by different
 * crawlers to ONE key, so the global catalog and recommendation list are never
 * inflated. Persisted on funding_opportunities.canonical_opportunity_key and
 * consulted by storage.upsertOpportunity on every write — the single durable
 * dedup authority.
 *
 * Identity precedence:
 *   1. external_id — authoritative structured id (e.g. a grants.gov OPP number).
 *   2. token-sorted title(+sponsor) — collapses LLM paraphrase variants of the
 *      SAME program extracted from different pages ("NAEMT EMS Scholarship -
 *      Paramedics (to advance ems education)" vs "… – Paramedics (to advance
 *      education in ems)" were 7 distinct URL-keyed catalog rows).
 *   3. normalized URL, then raw id — last resorts for title-less rows.
 *
 * @param {{ title?:string, sponsor?:string, apply_url?:string, info_url?:string, external_id?:string, id?:string }} opp
 * @returns {string}
 */
export function canonicalOpportunityKey(opp = {}) {
  const ext = String(opp.external_id ?? '').trim().toLowerCase();
  if (ext) return `ext:${ext}`;
  const titleKey = titleIdentityKey(opp.title, opp.sponsor);
  if (titleKey) return `t:${titleKey}`;
  const url = normalizeUrlForId(opp.apply_url || opp.info_url || '');
  return url ? `u:${url}` : `id:${opp.id ?? ''}`;
}

/**
 * titleIdentityKey — punctuation-insensitive, word-order-insensitive identity
 * for a title + sponsor pair. Unicode dashes fold to ASCII, punctuation is
 * stripped, filler words dropped, remaining tokens SORTED — so hyphen/en-dash
 * variants and re-worded parentheticals of the same program collapse while
 * genuinely different programs (different substantive tokens) stay distinct.
 * Exported for the catalog re-key/merge sweep and the legacy inserter.
 */
export function titleIdentityKey(title, sponsor) {
  const t = tokenSortedKey(title);
  if (!t) return '';
  const s = tokenSortedKey(sponsor);
  return s ? `${s}::${t}` : t;
}

const TITLE_IDENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'on', 'at', 'by', 'with',
]);

function tokenSortedKey(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/&(?:amp|ndash|mdash|nbsp|#\d+);/g, ' ') // stray HTML entities
    .replace(/[‐-―−]/g, '-')           // unicode dashes → hyphen
    .replace(/[^a-z0-9\s-]/g, ' ')                    // strip punctuation
    .replace(/-/g, ' ')                               // hyphens split tokens
    .split(/\s+/)
    .filter((w) => w && !TITLE_IDENTITY_STOPWORDS.has(w))
    .sort()
    .join(' ');
}

/** Strip query/fragment/trailing slash so trivially different URLs collapse. */
function normalizeUrlForId(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

/**
 * makeOpportunity — construct a canonical normalized Opportunity. The ONE shape
 * stored in the catalog and consumed by the match engine. Returns a frozen plain
 * object. Required at minimum: source_id, kind, title. id derived if absent.
 */
export function makeOpportunity(input = {}) {
  const kind = input.kind ?? OPPORTUNITY_KIND.DIRECT_GRANT;
  if (!OPPORTUNITY_KINDS.includes(kind)) {
    throw new Error(`makeOpportunity: unknown kind "${kind}"`);
  }
  const id =
    input.id ||
    deterministicOpportunityId({
      source_id: input.source_id,
      sponsor: input.sponsor,
      title: input.title,
      apply_url: input.apply_url,
      external_id: input.external_id,
    });
  return Object.freeze({
    id,
    external_id: input.external_id ?? null,
    source_id: input.source_id ?? null,
    kind,
    title: input.title ?? null,
    sponsor: input.sponsor ?? null,
    summary: input.summary ?? null,
    applicant_types: Object.freeze([...(input.applicant_types ?? [])]),
    need_categories: Object.freeze([...(input.need_categories ?? [])]),
    geography: Object.freeze({
      national: input.geography?.national ?? false,
      states: Object.freeze([...(input.geography?.states ?? [])]),
      counties: Object.freeze([...(input.geography?.counties ?? [])]),
      zips: Object.freeze([...(input.geography?.zips ?? [])]),
    }),
    funding: Object.freeze({
      amount_min: input.funding?.amount_min ?? null,
      amount_max: input.funding?.amount_max ?? null,
      // Amount VISIBILITY travels with the canonical row (normalizer resolves it
      // via awardAmountExtractor). "$0" and "no amount stated" are different
      // facts: when no per-award number is knowable the row still carries the
      // honest label + status ('varies' | 'contact_required' | 'not_listed' | …)
      // instead of a silent blank. This block is a WHITELIST — a key absent here
      // is dropped from the canonical row without warning, so any new amount
      // field must be added in both places.
      amount_text: input.funding?.amount_text ?? null,
      amount_status: input.funding?.amount_status ?? null,
      amount_confidence: input.funding?.amount_confidence ?? null,
      is_loan: input.funding?.is_loan ?? false,
      requires_cost_share: input.funding?.requires_cost_share ?? false,
      currency: input.funding?.currency ?? 'USD',
    }),
    deadline: input.deadline ?? null,
    is_rolling: input.is_rolling ?? false,
    apply_url: input.apply_url ?? null,
    info_url: input.info_url ?? null,
    trust_tier: input.trust_tier ?? TRUST_TIER.UNVERIFIED,
    reality_status: input.reality_status ?? REALITY_STATUS.LINK_UNVERIFIED,
    evidence: Object.freeze({
      url: input.evidence?.url ?? null,
      content_hash: input.evidence?.content_hash ?? null,
      fetched_at: input.evidence?.fetched_at ?? null,
    }),
    created_at: input.created_at ?? new Date().toISOString(),
    raw: input.raw ?? null,
  });
}

/**
 * makeSourceRun — telemetry shape for a single source's run. NEVER silent: an
 * honest skip is CRAWLER_OUTCOME.SKIPPED with a reason, not success.
 */
export function makeSourceRun(input = {}) {
  return {
    source_id: input.source_id ?? null,
    outcome: input.outcome ?? CRAWLER_OUTCOME.ERROR,
    reason: input.reason ?? null,
    queries: input.queries ?? [],
    fetched: input.fetched ?? 0,
    parsed_candidates: input.parsed_candidates ?? 0,
    rejected: input.rejected ?? 0,
    stored: input.stored ?? 0,
    rejections: input.rejections ?? [],
    error: input.error ?? null,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
  };
}

export const CONTRACT_VERSION = '1.1.0';

export default {
  OPPORTUNITY_KIND, OPPORTUNITY_KINDS, APPLICABLE_KINDS,
  TRUST_TIER, TRUST_TIER_WEIGHT,
  REALITY_STATUS, ACCEPTABLE_REALITY_STATUSES,
  CRAWLER_OUTCOME, MATCH_DECISION, REASON,
  deterministicOpportunityId, makeOpportunity, makeSourceRun, CONTRACT_VERSION,
};
