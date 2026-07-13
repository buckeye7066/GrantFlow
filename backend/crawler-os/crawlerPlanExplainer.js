// crawler-os/crawlerPlanExplainer.js
//
// "Which crawlers fire for THIS profile, and WHY?" — a single explainable
// answer Anya (and the operator) can read. It runs the SAME deterministic
// path discovery uses (buildThesis -> plan) so the explanation can never
// drift from reality, then annotates every source decision with a plain
// reason, surfaces the high-precision keyword triggers that pulled in extra
// sources (so a VFD's FEMA AFG is provably accounted for), and flags any
// coverage gap an operator should look at.
//
// Mission alignment: this is observability over the planner, not a new filter.
// It NEVER removes a source — it explains selections and (via the thesis
// keyword safety net) ensures recall.
//
// SELF-CONTAINED: like every other backend/crawler-os/* module, this file
// imports ONLY from within crawler-os. The DB-bound "load a live profile and
// explain it" wrapper lives OUTSIDE the OS in
// backend/services/crawlerPlanService.js so the OS boundary stays clean.

import { buildThesis } from './profileIntelligence.js';
import { plan } from './planner.js';
import { allSources } from './sourceRegistry.js';

export const HUMAN_REASON = Object.freeze({
  selected: 'Selected — this source serves the profile.',
  applicant_type_not_served: 'Skipped — this source does not fund this applicant type.',
  need_category_not_covered: 'Skipped — none of the profile\'s needs match this source.',
  geography_out_of_scope: 'Skipped — the source is geographically out of scope for this profile.',
  loan_capable_source_kept_loans_gated_downstream: 'Kept — loan-capable program; loans gated downstream.',
});

const REASON_CODE_OF_HUMAN = Object.freeze(
  Object.fromEntries(Object.entries(HUMAN_REASON).map(([code, text]) => [text, code])),
);

/**
 * rawReasonCode — normalize an exclusion reason back to its raw code.
 * Plan reasons reach downstream consumers in BOTH forms depending on the
 * path (planner emits codes; explainCrawlerPlan humanizes them). Any consumer
 * that branches on a reason (e.g. coverageEvidenceService's by-design gap
 * suppression) MUST compare codes via this helper, never the display text —
 * comparing text is how the 2026-07-12 "school portals = 81% fleet gap"
 * regression slipped past the #921 not_applicable fix.
 */
export function rawReasonCode(reason) {
  const r = String(reason ?? '').trim();
  return REASON_CODE_OF_HUMAN[r] || r;
}

function humanize(reasons = []) {
  return reasons.map((r) => HUMAN_REASON[r] || r);
}

/**
 * explainCrawlerPlan — pure: given a thesis-input object (the shape
 * profileContextToThesisInput produces, or a minimal { profile_type, ... }),
 * return the full, human-readable crawler plan.
 *
 * @param {object} thesisInput
 * @returns {{
 *   applicant_types: string[],
 *   needs: string[],
 *   location: object,
 *   is_org: boolean,
 *   keyword_triggers: Array<{add:string,label:string,matched:string,already_present?:boolean}>,
 *   selected_sources: Array<{source_id:string,name:string,directory:boolean,kinds:string[],reasons:string[]}>,
 *   excluded_sources: Array<{source_id:string,name:string,reasons:string[]}>,
 *   funder_source_ids: string[],
 *   directory_source_ids: string[],
 *   coverage: { has_real_funder: boolean, directory_only: boolean, zero: boolean },
 *   notes: string[],
 * }}
 */
export function explainCrawlerPlan(thesisInput = {}) {
  const thesis = buildThesis(thesisInput);
  const planned = plan(thesis);
  const byId = Object.fromEntries(allSources().map((s) => [s.source_id, s]));

  const decisionById = Object.fromEntries(
    (planned.source_decisions || []).map((d) => [d.source_id, d]),
  );

  const selected_sources = (planned.selected_source_ids || []).map((id) => {
    const s = byId[id] || {};
    return {
      source_id: id,
      name: s.name || id,
      directory: Boolean(s.directory),
      kinds: s.default_kinds || [],
      reasons: humanize(decisionById[id]?.reasons || ['selected']),
    };
  });

  const excluded_sources = (planned.source_decisions || [])
    .filter((d) => !d.selected)
    .map((d) => ({
      source_id: d.source_id,
      name: byId[d.source_id]?.name || d.source_id,
      reasons: humanize(d.reasons || []),
    }));

  const funder_source_ids = selected_sources.filter((s) => !s.directory).map((s) => s.source_id);
  const directory_source_ids = selected_sources.filter((s) => s.directory).map((s) => s.source_id);

  const isPerson = thesis.is_org === false;
  const coverage = {
    has_real_funder: funder_source_ids.length > 0,
    directory_only: selected_sources.length > 0 && funder_source_ids.length === 0,
    zero: selected_sources.length === 0,
  };

  const notes = [];
  if (coverage.zero) {
    notes.push('NO sources selected — this is a mission-rule failure. Check applicant-type/need gating.');
  }
  // Directory-only is EXPECTED and acceptable for person/household profiles
  // (federal grant APIs don\'t fund individuals) but a RED FLAG for an org.
  if (coverage.directory_only && !isPerson) {
    notes.push('Organization profile resolved to directory-only sources — likely a type/keyword gap; verify applicant_types.');
  }
  for (const t of thesis.keyword_triggers || []) {
    if (!t.already_present) {
      notes.push(`Keyword "${t.matched}" pulled in applicant type "${t.add}" (${t.label}) — recall safety net.`);
    }
  }

  return {
    profile_id: thesis.profile_id ?? thesisInput.id ?? null,
    applicant_types: thesis.applicant_types,
    needs: thesis.needs,
    location: thesis.location,
    is_org: thesis.is_org,
    keyword_triggers: thesis.keyword_triggers || [],
    selected_sources,
    excluded_sources,
    funder_source_ids,
    directory_source_ids,
    coverage,
    notes,
  };
}

export default { explainCrawlerPlan };
