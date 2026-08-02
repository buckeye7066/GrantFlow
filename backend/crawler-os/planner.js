// crawler-os/planner.js
//
// Thesis -> plan. Selects which registry sources to run for a profile, with a
// recorded reason per source (selected or excluded). The plan also carries the
// profile's loan/cost-share preference so the reality gate and match engine can
// enforce it. No source is silently dropped — every decision is explainable.
//
// Pure, no I/O.

import { allSources } from './sourceRegistry.js';
import { titleStatesTerm } from '../config/profileDerivedFacts.js';
import { STUDENT_AID_NEED_CATEGORIES, isStudentStage } from '../config/stageOfLifeEligibility.js';

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
 * ORDER IS A CLAIM ABOUT THE PROFILE, NOT A GLOBAL CONSTANT.
 *
 * THE DEFECT, measured read-only in prod 2026-08-02 on Anastasia White — a
 * dual-enrolled high-school senior whose `education.intended_major` is Forensic
 * Science. `plan()` selected 54 of 167 sources and ordered them by
 * `priority_score` alone, a number curated ONCE per source with no knowledge of
 * any profile. The result: her first 22 lanes were disease/disability lanes
 * (kidney fund, autism, arthritis, HIV care, amputee, rare disease…), admitted
 * by ONE generic `disability` need token derived from a household SSDI
 * entry — her `medical.disabilities` is literally `[]` — while `pell_grant`,
 * `fseog` and `studentaid_gov` ranked 23rd, 24th and 25th.
 *
 * The owner's rule is that the crawlers pull from the profile BEFORE crawling
 * and decide which crawlers are appropriate for its needs. A generic token must
 * not outrank a fact the applicant TYPED ABOUT HERSELF.
 *
 * THE RULE — PROMOTION, NEVER SUPPRESSION. Selection is unchanged: every source
 * that served before still serves, and nothing is dropped for lacking an
 * affinity. Two tiers rise above the default, both keyed on DECLARED facts with
 * provenance (`thesis.derived_facts`, from `config/profileDerivedFacts.js`):
 *
 *   0  `serves_declared_topic` — the source's CURATED vocabulary (its
 *      `keywords[]` and `need_categories[]`, never its free-text id or name —
 *      the #937 one-shared-word rule) names a topic the profile declared.
 *   1  `serves_declared_stage` — the profile's derived academic stage makes it
 *      a student, and this source serves student applicants AND declares a
 *      student-aid need category.
 *   2  default — `priority_score`, exactly as before.
 *
 * A profile that declares nothing lands entirely in tier 2 and its plan is
 * BYTE-IDENTICAL to the old one. That is the honest scope of this change.
 *
 * WHY RANKING AND NOT A FIELD-OF-STUDY SELECTOR: measured against the real
 * registry, sources carrying ANY curated topical vocabulary are 32 of 167, and
 * they are condition lanes (kidney, autism, hearing, vision…). ZERO serve
 * forensic science or criminal justice. A selector keyed on field of study
 * would have had nothing to select for the very profile that motivated it —
 * theatre. Tagging 167 rows with disciplines they do not serve would be worse:
 * inventing claims about sources. So the fix is the ordering, and the tier is
 * RECORDED in `source_decisions` so the crawl plan can explain itself.
 */
export const LANE_TIER = Object.freeze({
  DECLARED_TOPIC: 0,
  DECLARED_STAGE: 1,
  DEFAULT: 2,
});

/**
 * A source's CURATED vocabulary — `keywords[]` ONLY.
 *
 * Free-text `source_id`/`name` are excluded because they are not a vocabulary
 * (the #937 "floor of one shared word" rule: Reeve "covered" the condition
 * `physical` via "physical disability" in its NAME).
 *
 * `need_categories` are excluded too, and that exclusion was MEASURED. With
 * them in, this tier fired 240 times across 33 real prod profiles and its very
 * first hits were `benefits_gov`, `state_vocational_rehab` and `orr_refugee`
 * "serving" a forensic-science student — because her declared interest
 * "forensic science education programs" shares the token `education` with a
 * coarse need category. That is the same one-shared-word floor, one level up:
 * `need_categories` is the vocabulary the `servesNeed` GATE already owns, and
 * re-reading it here would rank a generic token as though it were a declared
 * topic — the exact defect this ranking exists to fix.
 */
function curatedVocabulary(source) {
  return (Array.isArray(source.keywords) ? source.keywords : [])
    .map((t) => String(t ?? '').toLowerCase().replace(/_/g, ' ').trim())
    .filter((t) => t.length >= 4 && t !== '*');
}

/** Does this source's curated vocabulary name something the profile DECLARED? */
function servesDeclaredTopic(source, declaredTerms) {
  if (declaredTerms.length === 0) return false;
  const vocab = curatedVocabulary(source);
  if (vocab.length === 0) return false;
  // Containment in EITHER direction, on token boundaries: 'cancer' ⊂ "breast
  // cancer" is the load-bearing direction, and 'renal' must not hit inside
  // 'adrenal'. Same rule as the condition-coverage floor.
  return vocab.some((term) => declaredTerms.some(
    (declared) => titleStatesTerm(term, declared) || titleStatesTerm(declared, term),
  ));
}

/** Does this source serve the student the profile's DERIVED stage says it is? */
function servesDeclaredStage(source, stage) {
  if (!isStudentStage(stage)) return false;
  const types = Array.isArray(source.applicant_types) ? source.applicant_types : [];
  if (!types.includes('student') && !types.includes('*')) return false;
  const needs = Array.isArray(source.need_categories) ? source.need_categories : [];
  if (needs.includes('*')) return false; // a catch-all lane is not a student-aid lane
  return needs.some((n) => STUDENT_AID_NEED_CATEGORIES.includes(String(n ?? '').toLowerCase()));
}

/** The declared, provenanced terms a lane can be ranked against. */
function declaredTermsOf(thesis) {
  const terms = thesis?.derived_facts?.topicalTerms;
  return Array.isArray(terms)
    ? terms.map((t) => String(t?.term ?? '').toLowerCase().trim()).filter(Boolean)
    : [];
}

/**
 * plan — choose sources for this thesis.
 *
 * @param {object} thesis
 * @returns {{
 *   selected_source_ids: string[],
 *   source_decisions: Array<{source_id:string, selected:boolean, reasons:string[], lane_tier?:number}>,
 *   loan_allowed: boolean,
 *   cost_share_allowed: boolean
 * }}
 */
export function plan(thesis = {}) {
  const decisions = [];
  const selected = [];
  const declaredTerms = declaredTermsOf(thesis);
  const stage = thesis?.derived_facts?.stageOfLife?.value ?? null;
  const tierOf = new Map();
  for (const source of allSources()) {
    const reasons = [];
    let ok = true;
    if (!servesApplicant(source, thesis)) { ok = false; reasons.push('applicant_type_not_served'); }
    if (!servesNeed(source, thesis)) { ok = false; reasons.push('need_category_not_covered'); }
    if (!servesGeo(source, thesis)) { ok = false; reasons.push('geography_out_of_scope'); }
    // Research-restricted sources (SBIR/STTR solicitations) serve ONLY profiles
    // whose thesis declares research capability — explicit and explainable, so
    // the applicant/need heuristics can't leak solicitations to a food pantry.
    if (source.research_only && !thesis.is_research_org) { ok = false; reasons.push('research_org_only'); }
    if (source.loan_allowed && !thesis.loan_allowed && source.default_kinds?.length === 1
        && source.default_kinds[0] === 'PROGRAM' && source.need_categories?.includes('*') === false) {
      // keep loan-capable broad programs; only note it. Loans are gated downstream.
      reasons.push('loan_capable_source_kept_loans_gated_downstream');
    }
    let tier = LANE_TIER.DEFAULT;
    if (ok) {
      // Affinity is computed ONLY for selected sources: it decides ORDER, never
      // membership, so an excluded source must not carry a rank that implies it
      // was considered for one.
      if (servesDeclaredTopic(source, declaredTerms)) {
        tier = LANE_TIER.DECLARED_TOPIC;
        reasons.push('serves_declared_topic');
      } else if (servesDeclaredStage(source, stage)) {
        tier = LANE_TIER.DECLARED_STAGE;
        reasons.push('serves_declared_stage');
      }
      selected.push(source.source_id);
      reasons.unshift('selected');
    }
    tierOf.set(source.source_id, tier);
    decisions.push({ source_id: source.source_id, selected: ok, reasons, lane_tier: ok ? tier : null });
  }
  // Deterministic order: declared-fact affinity first, then curated priority,
  // then source_id so two equally-ranked lanes never swap between runs.
  const order = Object.fromEntries(allSources().map((s) => [s.source_id, s.priority_score ?? 0]));
  selected.sort((a, b) => (tierOf.get(a) - tierOf.get(b))
    || ((order[b] ?? 0) - (order[a] ?? 0))
    || (a < b ? -1 : a > b ? 1 : 0));
  return {
    selected_source_ids: selected,
    source_decisions: decisions,
    loan_allowed: Boolean(thesis.loan_allowed),
    cost_share_allowed: Boolean(thesis.cost_share_allowed),
  };
}

export default { plan, LANE_TIER };
