// crawler-os/planner.js
//
// Thesis -> plan. Selects which registry sources to run for a profile, with a
// recorded reason per source (selected or excluded). The plan also carries the
// profile's loan/cost-share preference so the reality gate and match engine can
// enforce it. No source is silently dropped — every decision is explainable.
//
// Pure, no I/O.

import { allSources } from './sourceRegistry.js';

function servesApplicant(source, thesis) {
  if (source.applicant_types?.includes('*')) return true;
  if (thesis.applicant_types?.includes('*')) return true; // broad/no-profile discovery
  const wanted = new Set(thesis.applicant_types ?? []);
  return (source.applicant_types ?? []).some((t) => wanted.has(t));
}

function servesNeed(source, thesis) {
  if (source.need_categories?.includes('*')) return true;
  if (!thesis.needs?.length) return true; // unknown needs -> don't exclude on needs
  const wanted = new Set(thesis.needs);
  return (source.need_categories ?? []).some((n) => wanted.has(n));
}

function servesGeo(source, thesis) {
  if (source.geography?.national) return true;
  const st = thesis.location?.state;
  if (!st) return true; // unknown location -> keep (matcher will down-weight)
  return (source.geography?.states ?? []).includes(st);
}

/**
 * plan — choose sources for this thesis.
 *
 * @param {object} thesis
 * @returns {{
 *   selected_source_ids: string[],
 *   source_decisions: Array<{source_id:string, selected:boolean, reasons:string[]}>,
 *   loan_allowed: boolean,
 *   cost_share_allowed: boolean
 * }}
 */
export function plan(thesis = {}) {
  const decisions = [];
  const selected = [];
  for (const source of allSources()) {
    const reasons = [];
    let ok = true;
    if (!servesApplicant(source, thesis)) { ok = false; reasons.push('applicant_type_not_served'); }
    if (!servesNeed(source, thesis)) { ok = false; reasons.push('need_category_not_covered'); }
    if (!servesGeo(source, thesis)) { ok = false; reasons.push('geography_out_of_scope'); }
    if (source.loan_allowed && !thesis.loan_allowed && source.default_kinds?.length === 1
        && source.default_kinds[0] === 'PROGRAM' && source.need_categories?.includes('*') === false) {
      // keep loan-capable broad programs; only note it. Loans are gated downstream.
      reasons.push('loan_capable_source_kept_loans_gated_downstream');
    }
    if (ok) {
      selected.push(source.source_id);
      reasons.unshift('selected');
    }
    decisions.push({ source_id: source.source_id, selected: ok, reasons });
  }
  // Deterministic order: highest priority first.
  const order = Object.fromEntries(allSources().map((s) => [s.source_id, s.priority_score ?? 0]));
  selected.sort((a, b) => (order[b] ?? 0) - (order[a] ?? 0));
  return {
    selected_source_ids: selected,
    source_decisions: decisions,
    loan_allowed: Boolean(thesis.loan_allowed),
    cost_share_allowed: Boolean(thesis.cost_share_allowed),
  };
}

export default { plan };
