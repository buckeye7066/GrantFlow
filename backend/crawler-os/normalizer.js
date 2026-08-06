// crawler-os/normalizer.js
//
// Candidate + reality verdict -> canonical Opportunity (contract.makeOpportunity).
// The normalizer never upgrades trust or invents fields; it carries the source's
// trust tier and the gate's reality status onto the canonical row.
//
// Pure, no I/O. (resolveOpportunityAmounts is pure text/number resolution.)

import { makeOpportunity, TRUST_TIER } from './contract.js';
import { resolveOpportunityAmounts } from '../services/awardAmountExtractor.js';

/**
 * normalize — build the one canonical Opportunity shape.
 *
 * @param {object} candidate
 * @param {object} verdict   enforceReality() output (ok === true)
 * @param {{ source?:object, evidence?:object }} ctx
 * @returns {object} frozen Opportunity
 */
export function normalize(candidate, verdict, ctx = {}) {
  const source = ctx.source ?? {};
  const evidence = ctx.evidence ?? {};
  // Resolve the award amount HERE, the one place that builds the canonical row.
  //
  // This used to read structured numerics only, while the identical
  // resolveOpportunityAmounts() call ran a stage later at persistence
  // (crawlerOsPersistence). So within a single run the in-memory Opportunity
  // and the persisted DB row disagreed: a text-lane row whose page said
  // "grants of $1,000 to $5,000" reached the DB with real amounts but reached
  // the scorer, the recommendation list, and Amy's amount-recall evaluator as
  // null/null — which is what made amount_recall_miss over-report a gap the
  // run had actually closed.
  //
  // Safe to run twice: structured amounts win, so persistence's own call is a
  // pass-through. Carrying the plausibility guard this far up ALSO stops an
  // untrusted aggregator's program appropriation (the HUD Section 4 $42M
  // class) from ever reaching the scorer as a per-award ceiling.
  const amounts = resolveOpportunityAmounts({
    amount_min: numOrNull(candidate.amount_min),
    amount_max: numOrNull(candidate.amount_max),
    title: candidate.title,
    description: candidate.summary,
    amount_description: candidate.amount_description ?? null,
    trust_tier: source.trust_tier ?? candidate.trust_tier ?? null,
    source: candidate.source_id ?? source.source_id ?? null,
  });
  return makeOpportunity({
    external_id: candidate.external_id ?? null,
    source_id: candidate.source_id ?? source.source_id ?? null,
    kind: verdict.kind,
    title: clean(candidate.title),
    sponsor: clean(candidate.sponsor),
    summary: clean(candidate.summary),
    applicant_types: candidate.applicant_types ?? source.applicant_types ?? [],
    need_categories: candidate.need_categories ?? source.need_categories ?? [],
    geography: candidate.geography ?? source.geography ?? { national: false, states: [] },
    funding: {
      amount_min: amounts.amount_min,
      amount_max: amounts.amount_max,
      // Honest label when no per-award number is knowable ("amounts vary",
      // "contact funder", a demoted program-total excerpt). "$0" and "no amount
      // stated" are different facts and must not collapse into a silent blank.
      amount_text: amounts.amount_text ?? null,
      amount_status: amounts.amount_status ?? null,
      amount_confidence: amounts.amount_confidence ?? null,
      is_loan: candidate.is_loan === true,
      requires_cost_share: candidate.requires_cost_share === true,
      currency: candidate.currency ?? 'USD',
    },
    deadline: candidate.deadline ?? null,
    is_rolling: candidate.is_rolling === true,
    apply_url: candidate.apply_url ?? null,
    info_url: candidate.info_url ?? null,
    trust_tier: source.trust_tier ?? TRUST_TIER.UNVERIFIED,
    reality_status: verdict.reality_status,
    evidence: {
      url: evidence.url ?? candidate.apply_url ?? candidate.info_url ?? null,
      content_hash: evidence.content_hash ?? null,
      fetched_at: evidence.fetched_at ?? null,
    },
    eligibility_text: candidate.eligibility_text ?? null,
    eligibility_bullets: candidate.eligibility_bullets ?? [],
    page_fact_schema_version: candidate.page_fact_schema_version ?? null,
    field_provenance: candidate.field_provenance ?? null,
    raw: candidate.raw ?? null,
  });
}

function clean(s) {
  if (s == null) return null;
  return String(s).replace(/\s+/g, ' ').trim() || null;
}
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default { normalize };
