// crawler-os/normalizer.js
//
// Candidate + reality verdict -> canonical Opportunity (contract.makeOpportunity).
// The normalizer never upgrades trust or invents fields; it carries the source's
// trust tier and the gate's reality status onto the canonical row.
//
// Pure, no I/O.

import { makeOpportunity, TRUST_TIER } from './contract.js';

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
      amount_min: numOrNull(candidate.amount_min),
      amount_max: numOrNull(candidate.amount_max),
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
