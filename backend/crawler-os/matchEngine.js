// crawler-os/matchEngine.js
//
// THE canonical match authority. computeMatchDecision is the ONLY function in the
// system permitted to produce an ACCEPT / REVIEW / REJECT decision (doctrine #6,
// #7). Every agent, route, UI card, and crawler that needs a decision calls this.
// The score is ALWAYS per (opportunity, profile); it is never a property of the
// opportunity alone.
//
// Weight budget (sums to 100):
//   need 25 · applicant 20 · geo 15 · eligibility 15 · funding 10 · urgency 5
//   · amount 5 · trust 5
//
// Pure, no I/O.

import {
  MATCH_DECISION, TRUST_TIER_WEIGHT, OPPORTUNITY_KIND, APPLICABLE_KINDS,
} from './contract.js';

export const WEIGHTS = Object.freeze({
  need: 25, applicant: 20, geo: 15, eligibility: 15,
  funding: 10, urgency: 5, amount: 5, trust: 5,
});

/**
 * computeMatchDecision — score one opportunity against one profile thesis and
 * return a fully-explained decision.
 *
 * @param {object} opportunity canonical Opportunity
 * @param {object} thesis      profileIntelligence.buildThesis output
 * @param {{ floor?:number }} [opts]
 * @returns {{ profile_id:string|null, opportunity_id:string, match_score:number,
 *   decision:string, match_explain:object }}
 */
export function computeMatchDecision(opportunity, thesis, opts = {}) {
  const warnings = [];
  const breakdown = {};

  // need (25). Concrete inferred categories outrank a broad wildcard. A row
  // such as ['equipment', '*'] should score on the concrete equipment match, not
  // fall back to the generic wildcard band.
  const oppNeeds = stripWildcard(opportunity.need_categories);
  const matchedNeeds = intersect(oppNeeds.length ? oppNeeds : opportunity.need_categories, thesis.needs);
  const needWild = opportunity.need_categories.includes('*') && oppNeeds.length === 0;
  breakdown.need = needWild
    ? WEIGHTS.need * 0.6
    : ratioScore(matchedNeeds.length, Math.max(1, thesis.needs.length), WEIGHTS.need);
  if (!needWild && matchedNeeds.length === 0 && thesis.needs.length > 0) warnings.push('no need-category overlap');

  // applicant (20). Treat '*' as broad only when there is no concrete applicant
  // signal. If concrete applicant types exist, they control the match.
  const oppApplicants = stripWildcard(opportunity.applicant_types);
  const applicantWild = opportunity.applicant_types.includes('*') && oppApplicants.length === 0;
  const applicantFit = opportunity.applicant_types.length === 0
    ? 0.5
    : applicantWild ? 0.5 : (intersect(oppApplicants, thesis.applicant_types).length > 0 ? 1 : 0);
  breakdown.applicant = applicantFit * WEIGHTS.applicant;
  if (applicantFit === 0) warnings.push('applicant type not served by opportunity');

  // geo (15)
  const geo = scoreGeography(opportunity.geography, thesis.location);
  breakdown.geo = geo.score * WEIGHTS.geo;
  if (geo.score === 0) warnings.push('geography mismatch');

  // eligibility (15)
  const elig = scoreEligibility(opportunity);
  breakdown.eligibility = elig.score * WEIGHTS.eligibility;
  warnings.push(...elig.warnings);

  // funding mechanism acceptable? (10)
  let fundingScore = 1;
  if (opportunity.funding.is_loan && !thesis.loan_allowed) { fundingScore = 0; warnings.push('loan product, profile disallows loans'); }
  else if (opportunity.funding.requires_cost_share && !thesis.cost_share_allowed) { fundingScore = 0.3; warnings.push('requires cost-share, profile disallows'); }
  breakdown.funding = fundingScore * WEIGHTS.funding;

  // urgency (5)
  breakdown.urgency = scoreUrgency(opportunity) * WEIGHTS.urgency;

  // amount (5)
  const hasAmount = Number.isFinite(opportunity.funding.amount_max) || Number.isFinite(opportunity.funding.amount_min);
  breakdown.amount = (APPLICABLE_KINDS.includes(opportunity.kind) && hasAmount ? 1 : 0) * WEIGHTS.amount;

  // trust (5)
  breakdown.trust = (TRUST_TIER_WEIGHT[opportunity.trust_tier] ?? 0.25) * WEIGHTS.trust;

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const matchScore = Math.round(clamp(raw, 0, 100));
  const floor = Number.isFinite(opts.floor) ? opts.floor : (thesis.min_match_score ?? 55);
  const decision = decide(matchScore, floor, opportunity, warnings);

  return {
    profile_id: thesis.profile_id ?? null,
    opportunity_id: opportunity.id,
    match_score: matchScore,
    decision,
    match_explain: {
      matched_profile_type: applicantFit > 0,
      matched_needs: matchedNeeds,
      matched_location: geo.label,
      eligibility_fit: elig.label,
      why: buildWhy(matchScore, matchedNeeds, geo, applicantFit, opportunity),
      warnings,
      score_breakdown: roundBreakdown(breakdown),
      floor,
    },
  };
}

function decide(score, floor, opportunity, warnings) {
  // Directories and intel are never an ACCEPT ("apply now"): they go to REVIEW.
  if (opportunity.kind === OPPORTUNITY_KIND.DIRECTORY || opportunity.kind === OPPORTUNITY_KIND.PAST_AWARD_INTEL) {
    return MATCH_DECISION.REVIEW;
  }
  if (score < floor) return MATCH_DECISION.REJECT;
  const hardWarn = warnings.some((w) => /disallows|not served|no apply URL/i.test(w));
  if (hardWarn) return MATCH_DECISION.REVIEW;
  if (score >= Math.max(floor, 70)) return MATCH_DECISION.ACCEPT;
  return MATCH_DECISION.REVIEW;
}

function scoreGeography(geo, location) {
  if (!geo) return { score: 0, label: 'unknown' };
  if (geo.national) return { score: 1, label: 'national' };
  const state = location?.state;
  if (state && geo.states?.includes(state)) {
    if (location.county && geo.counties?.includes(location.county)) return { score: 1, label: `county:${location.county}` };
    if (location.zip && geo.zips?.includes(location.zip)) return { score: 1, label: `zip:${location.zip}` };
    return { score: 0.85, label: `state:${state}` };
  }
  if (!state && (geo.states?.length || geo.counties?.length)) return { score: 0.4, label: 'profile-location-unknown' };
  return { score: 0, label: 'mismatch' };
}

function scoreEligibility(opportunity) {
  const warnings = [];
  if (!APPLICABLE_KINDS.includes(opportunity.kind)) {
    return { score: 0.2, label: `${opportunity.kind.toLowerCase()} (not directly applicable)`, warnings };
  }
  if (!opportunity.apply_url) {
    warnings.push('no apply URL present');
    return { score: 0.5, label: 'applicable but no apply URL', warnings };
  }
  return { score: 1, label: 'eligible', warnings };
}

function scoreUrgency(opportunity) {
  if (opportunity.is_rolling || opportunity.reality_status === 'rolling') return 0.6;
  const ts = Date.parse(opportunity.deadline ?? '');
  if (!Number.isFinite(ts)) return 0.4;
  const days = (ts - Date.now()) / (24 * 3600 * 1000);
  if (days < 0) return 0;
  if (days <= 30) return 1;
  if (days <= 90) return 0.7;
  return 0.5;
}

function buildWhy(score, matchedNeeds, geo, applicantFit, opportunity) {
  const bits = [`score ${score}/100`];
  if (matchedNeeds.length) bits.push(`needs: ${matchedNeeds.join(', ')}`);
  bits.push(`geo: ${geo.label}`);
  bits.push(applicantFit > 0 ? 'applicant type served' : 'applicant type not served');
  bits.push(`kind: ${opportunity.kind}`);
  return bits.join('; ');
}

// ---- helpers --------------------------------------------------------------
function stripWildcard(values = []) { return (values ?? []).filter((x) => String(x).toLowerCase() !== '*'); }
function intersect(a = [], b = []) {
  const setB = new Set((b ?? []).map((x) => String(x).toLowerCase()));
  return [...new Set((a ?? []).map((x) => String(x).toLowerCase()))].filter((x) => setB.has(x));
}
function ratioScore(matched, total, weight) { if (total <= 0) return 0; return clamp(matched / total, 0, 1) * weight; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function roundBreakdown(b) { const o = {}; for (const [k, v] of Object.entries(b)) o[k] = Math.round(v * 100) / 100; return o; }

export default { computeMatchDecision, WEIGHTS };
