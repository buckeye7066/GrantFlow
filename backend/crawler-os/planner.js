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
import {
  isDiseaseSpecificSource,
  sourceServesDeclaredCondition,
  isMissionSpecificSource,
  sourceServesDeclaredMission,
} from '../config/sourceLanes.js';

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

/**
 * A CONDITION LANE MUST BE ASKED FOR A CONDITION.
 *
 * THE DEFECT, measured read-only in prod 2026-08-02 across all 33 real
 * profiles: **438 disease-lane selections**, 19 apiece even for profiles whose
 * declared health vocabulary is completely EMPTY (Demo College Student Persona, Admin Vault,
 * Tasha Reynolds). `servesNeed` admits a lane on a coarse `disability` /
 * `medical` need token, and a `disease_specific` source's whole identity is a
 * specific diagnosis — so the kidney fund, the amputee coalition, the HIV-care
 * locator and the rare-disease network all ran for people who evidence needing
 * none of them.
 *
 * The motivating profile is the sharp case. Demo Tennessee STEM Student declares
 * `demographics.disability_status = "Has disability"` and
 * `government_assistance.ssdi_recipient_self = true` — the disability signal is
 * REAL, not spurious, and the generic disability/benefit lanes (ssa_disability,
 * tn_ecf_choices, state_hcbs_waivers, the state portals) are right to run. But
 * her own medical sections say *"No confirmed medical conditions are present …
 * no chronic illnesses or disabilities noted"*. **Her disability has no named
 * condition**, and an unnamed disability is not evidence for every named
 * condition in the registry.
 *
 * THE RULE, and its two deliberate limits:
 *   - It applies ONLY to `disease_specific` lanes. Everything else is untouched.
 *   - It is satisfied by the source's own CURATED `keywords[]` naming something
 *     the profile declared, in either direction, via the single owner of that
 *     rule (`config/sourceLanes.sourceServesDeclaredCondition`) — never
 *     re-derived here.
 *
 * A profile with a real diagnosis keeps its lanes and loses nothing: measured,
 * Demo Assistive Technology Persona keeps 5 (brain injury, vision, mental health…), Brian Newman 7
 * (kidney, sleep apnea, vision…), Demo Health Education Persona 7 (arthritis, medical
 * transport, copay…) — including lanes matched from his `health_support` terms,
 * which is why the union of conditions and support is what the thesis carries.
 */
function servesDeclaredCondition(source, thesis) {
  if (!isDiseaseSpecificSource(source.source_id)) return true;
  // MISSING = NEUTRAL. An ABSENT `declared_health_terms` means this caller never
  // supplied the fact (a hand-built thesis, a cross-profile stub) — not that the
  // profile has nothing. Silence is never a denial, so the gate stays quiet and
  // the lane is selected exactly as before. An EMPTY ARRAY is different: it is a
  // read of the profile that found no health vocabulary, and the gate applies.
  if (!Array.isArray(thesis?.declared_health_terms)) return true;
  return sourceServesDeclaredCondition(source, thesis.declared_health_terms);
}

/**
 * A MISSION LANE MUST BE ASKED FOR ITS MISSION (2026-08-22 — the org-side
 * sibling of `servesDeclaredCondition`). Measured on the four real prod
 * profiles: Axiom BioLabs (a biotech lab) was handed petsmart/petco/aspca,
 * the sacred-places fleet, the native-agriculture fund, OVW, Second Chance
 * and LSC — each admitted on generic `nonprofit` plus ONE coarse shared org
 * need. The rule, its registry and its two admission doors live in
 * `config/sourceLanes.js` (MISSION_SPECIFIC_SOURCE_REQUIREMENTS /
 * `sourceServesDeclaredMission`) — never re-derived here.
 *
 * MISSING = NEUTRAL: a thesis with no `needs` ARRAY never supplied the facts
 * (a hand-built or cross-profile stub) — the gate stays quiet and selection
 * is unchanged. A present array (even a type-defaulted one) is a read, and
 * the gate applies: the lane is kept only when the needs name its mission
 * (type-defaulted sets carry a mission category only via a mission-declaring
 * TYPE) or a distinctive applicant identity (church/tribal/law_enforcement)
 * claims it.
 */
function servesDeclaredMission(source, thesis) {
  if (!isMissionSpecificSource(source.source_id)) return true;
  if (!Array.isArray(thesis?.needs)) return true;
  return sourceServesDeclaredMission(source, thesis);
}

/**
 * A POPULATION LANE MUST BE ASKED FOR ITS POPULATION (sourceRegistry
 * `populations`). MISSING = NEUTRAL: a thesis built without
 * `declared_populations` (older callers, tests) is not gated. ORG theses are
 * not gated either — an arts nonprofit reaches the NEA lane through its
 * mission, not through an "artist" population fact.
 */
const ORG_APPLICANT_TYPES = new Set([
  'nonprofit', 'government', 'school', 'school_district', 'business', 'small_business',
  'church', 'ministry', 'tribal', 'vfd', 'law_enforcement', 'hospital', 'university',
  'college', 'higher_education_institution', 'library', 'organization', 'farm',
]);

/**
 * A POPULATION-SPECIFIC declared need is itself a declaration of the
 * population: a household that declares `caregiving` is a caregiver household
 * for the ECF CHOICES / caregiver-support lanes; `childcare` declares a parent
 * of young children; `agriculture` a farmer. Coarse needs (education, medical,
 * employment, programs) imply nothing — that coarse-token admission is the
 * defect this gate closes.
 */
const POPULATION_NEED_IMPLICATIONS = Object.freeze({
  caregiver: ['caregiving'],
  kinship_caregiver: ['kinship_care'],
  disabled: ['disability', 'assistive_technology'],
  older_adult: ['aging', 'senior'],
  military_family: ['veterans', 'military_transition', 'military_spouse_support', 'active_duty_support'],
  survivor: ['survivor_benefits'],
  farmer: ['agriculture'],
  job_seeker: ['workforce', 'job_training'],
  parent_of_young_children: ['childcare'],
  foster_youth: ['foster_care'],
  refugee: ['refugee_services'],
});

function servesDeclaredPopulation(source, thesis) {
  const wanted = Array.isArray(source?.populations) ? source.populations : [];
  if (wanted.length === 0) return true;
  if (!Array.isArray(thesis?.declared_populations)) return true;
  const applicantTypes = Array.isArray(thesis?.applicant_types) ? thesis.applicant_types : [];
  if (applicantTypes.includes('*')) return true;
  if (applicantTypes.some((t) => ORG_APPLICANT_TYPES.has(String(t)))) return true;
  const declared = new Set(thesis.declared_populations.map((v) => String(v)));
  const needs = new Set((Array.isArray(thesis?.needs) ? thesis.needs : []).map((n) => String(n ?? '').toLowerCase()));
  for (const [population, impliedBy] of Object.entries(POPULATION_NEED_IMPLICATIONS)) {
    if (impliedBy.some((need) => needs.has(need))) declared.add(population);
  }
  return wanted.some((population) => declared.has(String(population)));
}

function servesGeo(source, thesis) {
  if (source.geography?.national) return true;
  const profileStates = new Set([
    thesis.location?.state,
    ...(Array.isArray(thesis.location?.states) ? thesis.location.states : []),
  ].map((state) => String(state ?? '').trim().toUpperCase()).filter(Boolean));
  if (profileStates.size === 0) return true; // unknown location -> keep (matcher will down-weight)
  return (source.geography?.states ?? [])
    .some((state) => profileStates.has(String(state ?? '').trim().toUpperCase()));
}

/**
 * ORDER IS A CLAIM ABOUT THE PROFILE, NOT A GLOBAL CONSTANT.
 *
 * THE DEFECT, measured read-only in prod 2026-08-02 on Demo Tennessee STEM Student — a
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
  DECLARED_CRITICAL_NEED: -1,
  DECLARED_TOPIC: 0,
  DECLARED_STAGE: 1,
  DEFAULT: 2,
});

function servesDeclaredCriticalNeed(source, thesis) {
  // Promote only needs explicitly supplied by the profile. Hand-built theses
  // and type-defaulted needs preserve the historical priority ordering.
  if (thesis?.needs_defaulted !== false) return false;
  const priorityNeeds = Array.isArray(source?.priority_need_categories)
    ? source.priority_need_categories
    : [];
  if (priorityNeeds.length === 0) return false;
  const declared = new Set(Array.isArray(thesis?.needs) ? thesis.needs : []);
  return priorityNeeds.some((need) => declared.has(need));
}

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
    // A condition lane must be asked for a condition (see servesDeclaredCondition).
    if (!servesDeclaredCondition(source, thesis)) { ok = false; reasons.push('condition_not_declared'); }
    // A mission lane must be asked for its mission (see servesDeclaredMission).
    if (!servesDeclaredMission(source, thesis)) { ok = false; reasons.push('mission_not_declared'); }
    // A population lane must be asked for its population (see servesDeclaredPopulation).
    if (!servesDeclaredPopulation(source, thesis)) { ok = false; reasons.push('population_not_declared'); }
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
      if (servesDeclaredCriticalNeed(source, thesis)) {
        tier = LANE_TIER.DECLARED_CRITICAL_NEED;
        reasons.push('serves_declared_critical_need');
      } else if (servesDeclaredTopic(source, declaredTerms)) {
        tier = LANE_TIER.DECLARED_TOPIC;
        reasons.push('serves_declared_topic');
      } else if (servesDeclaredStage(source, stage)) {
        tier = LANE_TIER.DECLARED_STAGE;
        reasons.push('serves_declared_stage');
      }
      const routedType = thesis?.profile_route?.canonical_profile_type;
      if (routedType) reasons.push(`profile_type_route:${routedType}`);
      const needsSource = thesis?.profile_route?.needs_source;
      if (needsSource) reasons.push(`profile_needs_source:${needsSource}`);
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
    profile_route: thesis?.profile_route ?? null,
    loan_allowed: Boolean(thesis.loan_allowed),
    cost_share_allowed: Boolean(thesis.cost_share_allowed),
  };
}

export default { plan, LANE_TIER };
