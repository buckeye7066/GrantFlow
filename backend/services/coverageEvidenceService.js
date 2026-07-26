// coverageEvidenceService.js
//
// Per-profile "Coverage & Evidence" aggregation — the owner-directed dashboard
// that turns "bad recommendations" into diagnosable failure classes by
// answering four questions for ONE profile:
//
//   1. WHAT DID WE SEARCH   — which source LANES ran (federal grants, federal
//      benefits, state programs, county/city, community foundations, school
//      portals, private charities, disease-specific, 211/local).
//   2. WHAT DID WE MISS     — lanes NOT covered for this profile, as concrete
//      gap statements ("No state-programs source for TN", "No disease-specific
//      source lane for dementia", ...).
//   3. WHY DID EACH MATCH SURVIVE — per-match evidence extracted from the
//      stored match_explain_json (data points, needs, eligibility, geography,
//      deadline, amount, apply link, source trust, confidence).
//   4. WHAT SHOULD THE USER ANSWER NEXT — prioritized missing fields/questions
//      merged from readiness + field prompts + per-match missing eligibility
//      fields, ordered by how many potential matches each answer unblocks.
//
// This service is READ-ONLY and additive: it reuses the canonical primitives
// (crawlerPlanService plan explainer, sourceRegistry, profileReadinessService,
// profileFieldPrompts, matchSurfacing) and never re-scores or mutates data.

import { explainCrawlerPlan, rawReasonCode, HUMAN_REASON } from '../crawler-os/crawlerPlanExplainer.js';
import { allSources, STATE_BENEFITS_SOURCE_IDS } from '../crawler-os/sourceRegistry.js';
import { loadProfileContext } from './profileHelpers.js';
import { profileContextToThesisInput } from './crawlerOsPersistence.js';
import { computeDetailedReadiness } from './profileReadinessService.js';
import { getProfileFieldPrompts } from './profileFieldPrompts.js';
import { SURFACED_MATCHER_VERSIONS_SQL } from '../config/matchSurfacing.js';
import { normalizeState } from '../utils/stateNormalization.js';
// The SAME need gate `signals.needs` goes through in profileHelpers — so a support
// need this cannot resolve is genuinely one no source can match on.
import { normalizeNeedCategory } from './profileNormalizer.js';
import { shouldAskProfileQuestion } from './profileKnownFacts.js';

// ─────────────────────────────────────────────────────────────────────────────
// Lane taxonomy — the 9 owner-defined source lanes.
// ─────────────────────────────────────────────────────────────────────────────

export const LANES = Object.freeze([
  { lane: 'federal_grants', label: 'Federal grants' },
  { lane: 'federal_benefits', label: 'Federal benefits' },
  { lane: 'state_programs', label: 'State programs' },
  { lane: 'county_city', label: 'County & city programs' },
  { lane: 'community_foundations', label: 'Community foundations' },
  { lane: 'school_portals', label: 'School & student-aid portals' },
  { lane: 'private_charities', label: 'Private charities & foundations' },
  { lane: 'disease_specific', label: 'Disease-specific support' },
  { lane: 'local_211', label: '211 / local safety net' },
]);

const LANE_IDS = new Set(LANES.map((l) => l.lane));
const LANE_LABEL = Object.fromEntries(LANES.map((l) => [l.lane, l.label]));

/**
 * EVERY source_id in backend/crawler-os/sourceRegistry.js must appear here —
 * the guard test (coverageEvidenceService.test.js) asserts totality, so a new
 * adapter cannot silently fall out of the dashboard. Keep this in the service
 * (not the OS) so the crawler-os package stays self-contained.
 */
export const LANE_OF_SOURCE = Object.freeze({
  // ── Federal grants / federal agency funding programs ──
  grants_gov: 'federal_grants',
  sam_gov: 'federal_grants',
  sbir_gov: 'federal_grants',
  federal_register: 'federal_grants',
  nih_guide: 'federal_grants',
  us_dept_of_ed: 'federal_grants',
  usda_rd: 'federal_grants',
  fema_afg: 'federal_grants',
  usda_rd_community_facilities: 'federal_grants',
  fema_public_assistance: 'federal_grants',
  fema_hazard_mitigation: 'federal_grants',
  cdbg_state_local: 'federal_grants',
  eda_economic_development: 'federal_grants',
  dot_transportation_grants: 'federal_grants',
  epa_water_infrastructure: 'federal_grants',
  broadband_grants: 'federal_grants',
  ana_grants: 'federal_grants',
  bia_tribal_programs: 'federal_grants',
  imls_library_museum: 'federal_grants',
  cdc_grants: 'federal_grants',
  samhsa_grants: 'federal_grants',
  hud_homeless_assistance: 'federal_grants',
  ovw_grants: 'federal_grants',
  bja_second_chance: 'federal_grants',
  sba_grants: 'federal_grants',
  lsc_grants: 'federal_grants',
  dhs_grants: 'federal_grants',
  doj_grants: 'federal_grants',
  cops_grants: 'federal_grants',
  // Federal campaign-finance guidance (compliance resource, federal lane).
  fec_candidate_resources: 'federal_grants',
  // Orphaned lanes ported 2026-07-07: federal agency grant programs.
  arc_dra: 'federal_grants',
  dol_eta_workforce: 'federal_grants',
  nea_neh_arts: 'federal_grants',
  usda_conservation: 'federal_grants',
  hrsa_health_workforce: 'federal_grants',
  // Benchmark-gap lanes (2026-07-13): heirs'-property + beginning farmers.
  farmers_gov_heirs_property: 'federal_grants',
  farmers_gov_beginning_farmers: 'federal_grants',
  // ── Federal benefits / federal support programs for people ──
  benefits_gov: 'federal_benefits',
  liheap: 'federal_benefits',
  snap: 'federal_benefits',
  medicaid: 'federal_benefits',
  ssa_survivors: 'federal_benefits',
  ssa_disability: 'federal_benefits',
  // National Medicaid HCBS waiver index (CMS) — federal locator for every
  // state's waiver program (the legacy stateWaiverBenefitsCrawler scope).
  state_hcbs_waivers: 'federal_benefits',
  dol_black_lung_benefits: 'federal_benefits',
  hrsa_health_centers: 'federal_benefits',
  area_agency_on_aging: 'federal_benefits',
  state_vocational_rehab: 'federal_benefits',
  sba_veteran_business: 'federal_benefits',
  sba_vboc: 'federal_benefits',
  military_onesource: 'federal_benefits',
  dol_tap: 'federal_benefits',
  sba_boots_to_business: 'federal_benefits',
  // Orphaned lanes ported 2026-07-07: federal support programs for people.
  orr_refugee: 'federal_benefits',
  acf_chafee_foster: 'federal_benefits',
  ccdf_childcare: 'federal_benefits',
  va_housing_grants: 'federal_benefits',
  // Benchmark-gap lanes (2026-07-13): kinship/grandfamily caregiver support.
  acl_family_caregiver_support: 'federal_benefits',
  gks_network: 'federal_benefits',
  // ── State programs (state-specific portals & resources) ──
  // TennCare ECF CHOICES — TN Medicaid HCBS waiver (ported legacy ECF lane).
  tn_ecf_choices: 'state_programs',
  kynect_benefits: 'state_programs',
  wv_sbdc_funding: 'state_programs',
  wv_business_funding_resources: 'state_programs',
  oregon_parks_rec_grants: 'state_programs',
  pa_campaign_finance: 'state_programs',
  // OH + WA lanes (adapter wishlist 2026-07-08): official state benefits
  // portals + state financial-aid grants, mirroring the kynect (KY) shape.
  oh_benefits: 'state_programs',
  oh_college_opportunity_grant: 'state_programs',
  wa_connection_benefits: 'state_programs',
  wa_college_grant: 'state_programs',
  // State benefits portals (2026-07-12): every remaining state + DC + PR gets
  // its official benefits portal, generated in lockstep with the registry's
  // STATE_BENEFITS_PORTALS table — closes the fleet-wide per-state gap.
  ...Object.fromEntries(STATE_BENEFITS_SOURCE_IDS.map((id) => [id, 'state_programs'])),
  // ── County & city programs — geo-aware locators (2026-07-08; formerly the
  //    fleet's #1 structural gap: 22/22 profiles had no county_city source).
  //    countyCityDirectoryAdapter titles each candidate with the profile's own
  //    county/city and ZIP-deep-links where the site supports it. ──
  usa_gov_local_governments: 'county_city',
  hud_resource_locator: 'county_city',
  findhelp_local_programs: 'county_city',
  // ── Community foundations ──
  cof_locator: 'community_foundations',
  // ── School & student-aid portals ──
  pell_grant: 'school_portals',
  fseog: 'school_portals',
  federal_work_study: 'school_portals',
  teach_grant: 'school_portals',
  iraq_afghanistan_service_grant: 'school_portals',
  studentaid_gov: 'school_portals',
  donorschoose: 'school_portals',
  mycaa: 'school_portals',
  // ── Private charities & foundations ──
  petsmart_charities_grants: 'private_charities',
  petco_love_grants: 'private_charities',
  aspca_grants: 'private_charities',
  feeding_america: 'private_charities',
  // Benchmark-gap lane (2026-07-13): the homeschool-family direct-grant anchor.
  hslda_compassion_grants: 'private_charities',
  // IRS 990 grantmakers (ProPublica) — the private-foundation funder universe.
  propublica_990: 'private_charities',
  // ── Disease-specific support ──
  cancer_care: 'disease_specific',
  alzheimers_gov_services: 'disease_specific',
  // Copay/patient-assistance foundation finder (diagnosis-based aid).
  copay_assistance_foundations: 'disease_specific',
  // Mobility-impairment + neurodivergent lanes (adapter wishlist 2026-07-08);
  // registry `keywords` feed conditionCoveredBySource for gap detection.
  reeve_foundation_paralysis: 'disease_specific',
  autism_speaks_family_support: 'disease_specific',
  arthritis_foundation_help: 'disease_specific',
  samhsa_findtreatment: 'disease_specific',
  american_kidney_fund: 'disease_specific',
  needymeds_diagnosis_assistance: 'disease_specific',
  // Transportation / deaf / assistive-tech / sleep-apnea lanes (adapter
  // wishlist 2026-07-15); registry `keywords` feed conditionCoveredBySource.
  mercy_medical_angels: 'disease_specific',
  pan_foundation_nemt_directory: 'disease_specific',
  hlaa_financial_assistance: 'disease_specific',
  at3_state_at_programs: 'disease_specific',
  asaa_cpap_assistance: 'disease_specific',
  // Adapter-wishlist lanes (2026-07-26): vision loss, acquired brain injury,
  // medical debt / hospital charity care. dollar_for_charity_care sits in this
  // lane deliberately — the disease-lane loop only consults disease_specific
  // sources, and "medical debt" arrives as a health CONDITION on real profiles
  // (a diagnosis-field entry), so its covering source must live here (the
  // needymeds_diagnosis_assistance precedent: diagnosis-agnostic, same lane).
  vision_aware_resources: 'disease_specific',
  biausa_brain_injury_resources: 'disease_specific',
  dollar_for_charity_care: 'disease_specific',
  // Canonical-flag totality lanes (2026-07-26): hiv, amputee, rare_disease,
  // terminal — every HEALTH_DIAGNOSIS_FLAGS token must have a covering lane
  // (guard: "every canonical diagnosis flag has a covering source" below in
  // coverageEvidenceService.test.js).
  findhivcare_ryan_white: 'disease_specific',
  amputee_coalition_resources: 'disease_specific',
  nord_rare_disease_assistance: 'disease_specific',
  caringinfo_serious_illness: 'disease_specific',
  // ── 211 / local safety net ──
  community_211: 'local_211',
  united_way_211: 'local_211',
  community_action: 'local_211',
});

/**
 * Conservative fallback so a NOT-YET-MAPPED source still renders somewhere in
 * prod (the guard test fails CI on an unmapped id, so this is a safety net,
 * not a substitute for updating LANE_OF_SOURCE).
 */
function inferLane(source) {
  if (!source) return 'private_charities';
  const states = source.geography?.states;
  if (Array.isArray(states) && states.length > 0) return 'state_programs';
  const url = String(source.base_url || '');
  if (/\.gov(\/|$)/i.test(url) || /\.mil(\/|$)/i.test(url)) return 'federal_grants';
  return 'private_charities';
}

/** @returns {string} lane id for a source_id (explicit mapping, else inferred) */
export function laneForSource(sourceId, source = null) {
  const mapped = LANE_OF_SOURCE[sourceId];
  if (mapped && LANE_IDS.has(mapped)) return mapped;
  return inferLane(source ?? allSources().find((s) => s.source_id === sourceId));
}

// ─────────────────────────────────────────────────────────────────────────────
// answer_next helpers
// ─────────────────────────────────────────────────────────────────────────────

// Canonicalize field ids so readiness categories, field prompts, and match
// missing-eligibility fields that describe the SAME fact dedup to one item.
const FIELD_ALIASES = Object.freeze({
  identity: 'applicant_type',
  entity_type: 'applicant_type',
  location: 'state_zip',
  profile_location: 'state_zip',
  funding_needs: 'primary_need',
  amount: 'funding_amount',
  eligibility: 'eligibility_traits',
  nonprofit_status: 'org_status',
  business_or_self_employment: 'org_status',
  student_status: 'student_aid',
});

// missingFields values that are OPPORTUNITY-side facts (or engine bookkeeping),
// not questions a user can answer — excluded from answer_next.
const NON_USER_FIELDS = new Set([
  'application_url',
  'profile',
  'opportunity',
  'education_level_mismatch_k12',
  'local_award_out_of_state',
]);

const MISSING_FIELD_QUESTIONS = Object.freeze({
  income_eligibility: 'What is your household income (or income range)?',
  age: 'What is your date of birth or age?',
  gender: 'What is your gender?',
  ethnicity: 'What is your race or ethnicity?',
  student_aid: 'Are you currently enrolled as a student, and at what level?',
  org_status: 'Is this a registered organization (EIN / 501(c)(3) or business status)?',
  caregiver_status: 'Are you a caregiver for a family member?',
  dv_survivor_status: 'Are you a survivor of domestic violence?',
  agricultural_producer_status: 'Are you a farmer or agricultural producer?',
  faith_based_affiliation: 'Do you have a church or ministry affiliation?',
  tribal_affiliation: 'Do you have a tribal affiliation?',
  cdc_certification: 'Is the organization a certified Community Development Corporation?',
  disability_or_medical_need_for_equipment: 'Is there a disability or medical need for this equipment?',
  state_zip: 'What is your state or ZIP code?',
  applicant_type: 'What kind of applicant are you (individual, family, nonprofit, school, business)?',
});

function canonicalField(field) {
  const key = String(field || '').trim();
  return FIELD_ALIASES[key] ?? key;
}

function humanizeField(field) {
  return String(field || '').replace(/_/g, ' ').trim();
}

function safeJsonParse(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Match evidence extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the per-match evidence block from a stored match_explain_json +
 * catalog row. Tolerant of every shape drift:
 *  - dataPointEvidence is rendered WHEN PRESENT (a concurrent PR adds it);
 *    matchedNeeds / scoreBreakdown remain the fallback evidence.
 *  - missing eligibility fields are read from missingEligibilityFields OR
 *    missingFields (both spellings have shipped).
 */
export function extractMatchEvidence(explainRaw, opp = {}) {
  const explain = safeJsonParse(explainRaw) ?? {};
  const sb = explain.scoreBreakdown ?? {};
  const cc = explain.confidence_components ?? {};
  const matchedSignals = Array.isArray(explain.matchedSignals) ? explain.matchedSignals : [];
  const geoSignal = matchedSignals.find((s) => typeof s === 'string' && s.startsWith('geo:')) || null;
  const missingFields = Array.isArray(explain.missingEligibilityFields)
    ? explain.missingEligibilityFields
    : Array.isArray(explain.missingFields)
      ? explain.missingFields
      : [];

  const registrySource = opp.source ? allSources().find((s) => s.source_id === opp.source) : null;

  return {
    // NEW dataPointEvidence key ({ total, matched_count, credit, matched:[...] })
    // — render when present; null means "fall back to matched_needs/breakdown".
    data_points: explain.dataPointEvidence ?? null,
    matched_needs: Array.isArray(explain.matchedNeeds) ? explain.matchedNeeds : [],
    need_coverage: Number.isFinite(Number(sb.need_coverage)) ? Number(sb.need_coverage) : null,
    applicant_type: {
      matched: matchedSignals.includes('applicant_type') || Number(sb.applicant_type) > 0,
    },
    geography: {
      tier: geoSignal ? geoSignal.slice(4) : null,
      factor: sb.geo_factor ?? null,
    },
    eligibility: {
      factor: sb.eligibility_factor ?? null,
      mismatches: Array.isArray(sb.eligibility_mismatches) ? sb.eligibility_mismatches : [],
      missing_fields: missingFields,
    },
    deadline: { date: opp.deadline ?? null, type: opp.deadline_type ?? null },
    amount: {
      min: opp.amount_min ?? null,
      max: opp.amount_max ?? null,
      text: opp.amount_text ?? null,
      status: opp.amount_status ?? null,
    },
    apply_url: opp.apply_url || opp.application_url || opp.source_url || null,
    source: opp.source ?? null,
    trust_tier: opp.source_trust_tier ?? registrySource?.trust_tier ?? null,
    confidence: Number.isFinite(Number(explain.confidence)) ? Number(explain.confidence) : null,
    source_trust: cc.sourceTrust ?? null,
    reasons: Array.isArray(explain.reasons) ? explain.reasons.slice(0, 6) : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main aggregation
// ─────────────────────────────────────────────────────────────────────────────

const MATCH_CAP = 200;

async function loadStoredMatches(db, profileId) {
  try {
    return await db
      .prepare(
        `SELECT m.opportunity_id, m.match_score, m.match_decision, m.match_explain_json,
                m.source_query, m.discovered_via,
                o.title, o.sponsor, o.source, o.deadline, o.deadline_type,
                o.amount_min, o.amount_max, o.amount_text, o.amount_status,
                o.application_url, o.apply_url, o.source_url, o.source_trust_tier
           FROM profile_opportunity_matches m
           JOIN funding_opportunities o ON o.id = m.opportunity_id
          WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
          ORDER BY COALESCE(m.match_score, -1) DESC
          LIMIT ${MATCH_CAP}`,
      )
      .all(profileId);
  } catch {
    return [];
  }
}

function needCoveredBySources(need, sources) {
  const n = String(need || '').toLowerCase();
  if (!n) return true;
  return sources.some((s) => {
    const cats = Array.isArray(s.need_categories) ? s.need_categories : [];
    return cats.includes('*') || cats.some((c) => String(c).toLowerCase() === n);
  });
}

/**
 * Words that describe the SHAPE of a diagnosis rather than which disease it is.
 * Two sources sharing one of these share nothing — "chronic kidney disease" and
 * "alzheimer's disease" have `disease` in common and are not the same lane.
 * Laterality/severity are the same story: "left" is not an identity.
 */
const GENERIC_CONDITION_WORDS = new Set([
  'disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'condition', 'conditions',
  'illness', 'chronic', 'acute', 'severe', 'mild', 'moderate', 'stage', 'type',
  'left', 'right', 'bilateral', 'primary', 'secondary', 'early', 'late', 'onset',
  'support', 'care', 'health', 'medical', 'patient', 'assistance', 'general',
]);

/** Whole-word (token-boundary) containment: `renal` must NOT match inside `adrenal`. */
function containsTerm(haystack, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
}

/**
 * Does this source's CURATED vocabulary name the profile's condition?
 *
 * THE HAYSTACK IS THE DEFECT, NOT JUST THE RULE. This used to read
 * `need_categories + source_id + name + keywords` and return true when ANY ≥4-char
 * word of the condition appeared anywhere in it. `source_id`/`name` are free text,
 * so that was a floor of ONE SHARED WORD — the #937/#943 class ("a shared word is a
 * coincidence, not an identity"), and it fired in prod: the Reeve Foundation
 * "covers" the condition `physical` purely because its name carries
 * "physical disability", and any source whose name contains "disease" "covered"
 * chronic kidney disease.
 *
 * The fix is to match ONLY against the curated vocabulary a human wrote for exactly
 * this purpose — `keywords[]` + `need_categories[]` — which is why every
 * `disease_specific` source must carry `keywords` (totality-tested). Free-text
 * `source_id`/`name` are deliberately NOT consulted.
 *
 * The load-bearing direction is `keyword ⊂ condition`: the keyword is the specific
 * term, the condition is the user's free text, so `cancer` ⊂ "breast cancer",
 * `dementia` ⊂ "vascular dementia", `diabetes` ⊂ "type 2 diabetes". The reverse
 * (`condition ⊂ keyword`) is also honoured so a bare "cancer" still reaches a
 * source keyed to "breast cancer".
 *
 * REJECTED ALTERNATIVE (recorded so it is not re-attempted): "every distinctive
 * token of the condition must appear". Measured against the real registry it flips
 * ten true covers to false — `breast cancer`, `vascular dementia`, `wheelchair user`,
 * `type 2 diabetes`, `complex ptsd`, `obstructive sleep apnea`… — because the
 * haystack never contained the qualifier. It is also VACUOUSLY TRUE for an
 * all-generic condition like "chronic condition" (empty distinctive set matches every
 * source), and `chronic_illness` is a real health signal. Strictness in the rule
 * cannot repair a haystack made of the wrong words.
 *
 * @param {string} condition free-text condition from the profile
 * @param {object} source registry source
 * @param {Set<string>} [overlay] condition keys already covered by an ADOPTED source
 */
export function conditionCoveredBySource(condition, source, overlay = null) {
  // `_` → ' ' is NOT cosmetic. Health signals arrive in two shapes: free text from
  // the profile ("breast cancer") and CANONICAL FLAG tokens minted with underscores
  // ("hearing_impairment", "visual_impairment", "rare_disease" — profileHelpers).
  // The old rule split the condition on `_` before matching, so it saw "hearing";
  // matching the raw string instead silently stopped covering every underscore flag
  // — `hearing_impairment` became a false "no source lane exists" the moment this
  // rule shipped, even though hlaa_financial_assistance is right there. Normalise
  // both sides to the same word-separated shape before comparing.
  const raw = String(condition || '').trim().toLowerCase().replace(/_/g, ' ');
  if (!raw) return false;
  // An adopted, fully-gated source retires the gap — see conditionCoverageKey.
  if (overlay && overlay.has(conditionCoverageKey(raw))) return true;

  const terms = [
    ...(Array.isArray(source.keywords) ? source.keywords : []),
    ...(Array.isArray(source.need_categories) ? source.need_categories : []),
  ]
    .map((t) => String(t || '').toLowerCase().replace(/_/g, ' ').trim())
    .filter((t) => t.length >= 4 && !GENERIC_CONDITION_WORDS.has(t));

  return terms.some((term) => containsTerm(raw, term) || containsTerm(term, raw));
}

/** Stable key for a condition across the gap scoreboard and the adoption overlay. */
export function conditionCoverageKey(condition) {
  return String(condition || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** system_kv key: conditions a fully-gated, ADOPTED source now covers (see the overlay note). */
export const CONDITION_COVERAGE_KV_KEY = 'condition_source_coverage';

/** Diagnoses checked per profile. A truncation is REPORTED, never silent. */
const MAX_CONDITIONS_SCANNED = 8;

/** Support needs checked per profile. */
const MAX_SUPPORT_NEEDS_SCANNED = 8;

/**
 * Conditions an ADOPTED source already covers.
 *
 * THIS IS WHAT MAKES THE WISHLIST CONVERGE. `conditionCoveredBySource` matches
 * against the STATIC sourceRegistry, but a source found by the wishlist consumer and
 * accepted by the full gate stack lands in `funding_opportunities` — which the
 * registry never sees. Without this overlay, Amy could find and adopt a real
 * epilepsy source and the scoreboard would STILL report "No disease-specific source
 * lane exists for epilepsy" every night forever, permanently occupying one of the 10
 * wishlist slots and starving genuinely new gaps. That is "never converges, but with
 * a footnote" — and it fails the canonical rule that discovered sources RETIRE
 * wishlist items.
 *
 * Only URLs that survived fetch → extract → reality gate → match engine are written
 * here (see markGapCandidateOutcomes), so this can never manufacture coverage (G0).
 */
export async function loadConditionCoverageOverlay(db) {
  if (!db?.prepare) return new Set();
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(CONDITION_COVERAGE_KV_KEY);
    if (!row?.value) return new Set();
    const parsed = JSON.parse(row.value);
    const keys = Array.isArray(parsed?.conditions) ? parsed.conditions : Array.isArray(parsed) ? parsed : [];
    return new Set(keys.map((k) => conditionCoverageKey(k)).filter(Boolean));
  } catch {
    // A missing/corrupt overlay must never fail the coverage report — it only means
    // an adopted source is not yet credited, which self-heals on the next adoption.
    return new Set();
  }
}

/**
 * Support LEVELS / generic flags that are not diseases.
 *
 * NOT LOAD-BEARING — do not grow this expecting the wishlist to converge. It is an
 * exact-match Set, so it can only ever suppress the canonical-token branch of
 * `profileHelpers`' health signals; the noisy wishlist entries ("lodging",
 * "unsteady gait", "clawing effect in hands") are FREE TEXT and can never match it.
 * It could not even cover its own branch — `mobility_needs` leaked past it into prod.
 * The real fix is provenance: only `signals.health_conditions` reaches the
 * disease-lane loop now. This stays as a cheap belt-and-braces for legacy callers.
 */
export const NON_DISEASE_HEALTH_SIGNALS = new Set([
  'high_support_needs', 'disability', 'chronic_illness', 'mental_health', 'recovery',
  'mobility_needs', 'dme', 'physical',
]);

/**
 * dominantExclusionReason — the reason a lane with zero selected sources gets
 * blamed on, picked from its excluded sources' reason codes.
 *
 * Only IN-GEOGRAPHIC-SCOPE exclusions can explain a profile's lane: a state
 * lane always carries ~50 OTHER states' sources whose geography votes
 * numerically drown the in-state story (the 2026-07-25 "geographically out of
 * scope ×5 profiles" class — a profile whose own state's sources were skipped
 * for by-design reasons still read as a GEOGRAPHY gap, which no owner action
 * could ever fix). So sources carrying a geography exclusion are dropped from
 * the vote when ANY in-scope exclusion exists. When NO source is in geographic
 * scope at all (unparseable state like "USA", or a place genuinely uncovered),
 * the geographic statement IS the honest one and is kept.
 *
 * Reasons arrive in BOTH forms (planner codes and humanized text) — always
 * normalized via rawReasonCode before comparing (the 2026-07-12 class).
 *
 * @param {Array<{reasons?: string[]}>} excludedSources
 * @returns {string} dominant raw reason code
 */
export function dominantExclusionReason(excludedSources) {
  const all = Array.isArray(excludedSources) ? excludedSources : [];
  const inScope = all.filter(
    (s) => !(s.reasons || []).some((r) => rawReasonCode(r) === 'geography_out_of_scope'),
  );
  const voting = inScope.length > 0 ? inScope : all;
  const counts = new Map();
  for (const s of voting) {
    for (const r of s.reasons || []) {
      const code = rawReasonCode(r);
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'not applicable to this profile';
}

/**
 * buildCoverageEvidence — the per-profile Coverage & Evidence aggregation.
 *
 * @param {object} db
 * @param {string} profileId
 * @returns {Promise<object>} { profile_id, display_name, primary_type, plan,
 *   lanes[], gaps[], matches[], answer_next[], generated_at } or
 *   { profile_id, error: 'profile_not_found' }.
 */
export async function buildCoverageEvidence(db, profileId) {
  if (!db || !profileId) throw new Error('buildCoverageEvidence: db and profileId required');

  // ── Load the profile context ONCE (plan + health signals share it) ──
  let ctx;
  try {
    ctx = await loadProfileContext(db, profileId);
  } catch (err) {
    if (/not found|no such|does not exist/i.test(String(err?.message || ''))) {
      return { profile_id: profileId, error: 'profile_not_found' };
    }
    throw err;
  }
  if (!ctx?.profile) return { profile_id: profileId, error: 'profile_not_found' };

  const plan = explainCrawlerPlan(profileContextToThesisInput(ctx));
  const registry = allSources();
  const registryById = Object.fromEntries(registry.map((s) => [s.source_id, s]));
  // Loaded ONCE per profile: conditions an adopted (fully-gated) source now covers,
  // so a wishlist entry the consumer actually closed stops re-emitting forever.
  const conditionOverlay = await loadConditionCoverageOverlay(db);

  // ── Which selected sources currently HAVE stored matches ──
  let contributing = new Set();
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT o.source AS source
           FROM profile_opportunity_matches m
           JOIN funding_opportunities o ON o.id = m.opportunity_id
          WHERE m.profile_id = ? AND m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
            AND o.source IS NOT NULL`,
      )
      .all(profileId);
    contributing = new Set((rows || []).map((r) => r.source).filter(Boolean));
  } catch {
    contributing = new Set();
  }

  // ── 1. Lanes: bucket the plan's selected / excluded sources ──
  const laneBuckets = Object.fromEntries(
    LANES.map((l) => [l.lane, {
      lane: l.lane,
      label: l.label,
      status: 'missing',
      selected_sources: [],
      excluded_sources: [],
      registry_source_count: 0,
      gap: null,
    }]),
  );
  for (const s of registry) {
    laneBuckets[laneForSource(s.source_id, s)].registry_source_count += 1;
  }
  for (const s of plan.selected_sources || []) {
    const lane = laneForSource(s.source_id, registryById[s.source_id]);
    laneBuckets[lane].selected_sources.push({
      source_id: s.source_id,
      name: s.name,
      directory: Boolean(s.directory),
      with_results: contributing.has(s.source_id),
      reasons: s.reasons || [],
    });
  }
  for (const s of plan.excluded_sources || []) {
    const lane = laneForSource(s.source_id, registryById[s.source_id]);
    laneBuckets[lane].excluded_sources.push({
      source_id: s.source_id,
      name: s.name,
      reasons: s.reasons || [],
    });
  }

  const location = plan.location || {};
  const state = normalizeState(location.state) || null;
  const county = location.county || null;
  const placeHint = [county, state].filter(Boolean).join(', ') || state || 'this profile’s area';

  // ── 2. Gaps ──
  const gaps = [];

  for (const bucket of Object.values(laneBuckets)) {
    if (bucket.selected_sources.length > 0) {
      bucket.status = bucket.selected_sources.some((s) => s.with_results) ? 'searched' : 'no_results';
      continue;
    }
    bucket.status = 'missing';
    if (bucket.registry_source_count === 0) {
      bucket.gap = `No ${bucket.label.toLowerCase()} source adapters exist in the source registry yet.`;
      gaps.push({
        lane: bucket.lane,
        statement: bucket.gap,
        profile_fact: `location=${placeHint}`,
        suggested_action: `Add a ${bucket.label.toLowerCase()} source adapter (e.g. for ${placeHint}) to backend/crawler-os/sourceRegistry.js.`,
      });
    } else {
      // Dominant exclusion reason for the lane's candidates. Reasons arrive in
      // BOTH forms (planner codes and explainCrawlerPlan's humanized text), so
      // normalize to the raw code before counting/branching — comparing the
      // display text is how the 2026-07-12 "school portals = 81% fleet gap"
      // regression slipped past the not_applicable fix below.
      const topReason = dominantExclusionReason(bucket.excluded_sources);
      // A lane whose sources are excluded because they DON'T SERVE this
      // applicant type / need is working AS DESIGNED (a nonprofit not getting
      // FAFSA portals is correct eligibility gating, not missing coverage) —
      // 2026-07-11 this class alone read as an "86% fleet coverage gap".
      // Only geography-shaped exclusions (the lane exists but not for this
      // profile's place) remain a real, actionable gap.
      const BY_DESIGN_REASONS = new Set(['applicant_type_not_served', 'need_category_not_covered', 'research_org_only']);
      if (BY_DESIGN_REASONS.has(topReason)) {
        bucket.status = 'not_applicable';
        bucket.gap = `None of the ${bucket.registry_source_count} known ${bucket.label.toLowerCase()} sources fund this applicant type/need — correctly skipped, not a coverage gap.`;
      } else {
        bucket.gap = `None of the ${bucket.registry_source_count} known ${bucket.label.toLowerCase()} sources apply to this profile — ${HUMAN_REASON[topReason] || topReason}`;
        gaps.push({
          lane: bucket.lane,
          statement: bucket.gap,
          profile_fact: `applicant_types=${(plan.applicant_types || []).join('/') || 'unknown'}`,
          suggested_action: 'Review the exclusion reasons: either the profile is missing a fact (type, need, location) or the lane needs a broader source.',
        });
      }
    }
  }

  // (c1) Profile state with no state-specific source covering it. Scoped to
  // the state_programs LANE: a multi-state FEDERAL source (e.g. arc_dra, the
  // Appalachian Regional Commission's 13-state footprint) is not a state
  // benefits/scholarship/agency source and must not suppress this gap.
  if (state) {
    const stateCovered = registry.some((s) => {
      if (laneForSource(s.source_id, s) !== 'state_programs') return false;
      const states = s.geography?.states;
      return Array.isArray(states) && states.map((x) => String(x).toUpperCase()).includes(state);
    });
    if (!stateCovered) {
      gaps.push({
        lane: 'state_programs',
        statement: `No ${state}-specific state-programs source (benefits, scholarship, or agency adapter) exists in the source registry.`,
        profile_fact: `state=${state}`,
        suggested_action: `Add a ${state} state benefits/scholarship source to backend/crawler-os/sourceRegistry.js so this profile's state lane is real, not just national sources.`,
      });
    }
  }

  // (c2) DIAGNOSES with no disease-specific coverage (or coverage that exists in
  // the registry but was not selected for this profile).
  //
  // Reads `health_conditions`, NOT the `health` union. The union mixes diagnoses
  // with support needs, disability descriptors and support flags, so iterating it
  // asked "does a disease-specific source lane exist for X?" about `lodging` (a
  // support need), `unsteady gait` (a symptom) and `mobility_needs` (a flag) — 4 of
  // the 10 wishlist items the owner was asked to action on 2026-07-16. Those are
  // unanswerable by construction, and no denylist can fix it because the values are
  // free text. Provenance can, and is recorded at the write site
  // (profileHelpers.js). Falls back to the union for a caller with older signals.
  const conditionSignals = ctx.signals?.health_conditions instanceof Set
    ? [...ctx.signals.health_conditions]
    : Array.isArray(ctx.signals?.health_conditions)
      ? ctx.signals.health_conditions
      : ctx.signals?.health instanceof Set
        ? [...ctx.signals.health]
        : Array.isArray(ctx.signals?.health) ? ctx.signals.health : [];
  const diseaseSources = registry.filter((s) => laneForSource(s.source_id, s) === 'disease_specific');
  const selectedIds = new Set((plan.selected_sources || []).map((s) => s.source_id));
  // A silent cap is a silent miss (the one thing the lane pillar forbids): report
  // the truncation instead of dropping a 9th diagnosis on the floor.
  if (conditionSignals.length > MAX_CONDITIONS_SCANNED) {
    gaps.push({
      lane: 'disease_specific',
      statement: `Only the first ${MAX_CONDITIONS_SCANNED} of ${conditionSignals.length} conditions were checked for a disease-specific lane.`,
      profile_fact: `health_conditions_count=${conditionSignals.length}`,
      suggested_action: `Raise MAX_CONDITIONS_SCANNED or split this profile — ${conditionSignals.length - MAX_CONDITIONS_SCANNED} condition(s) are currently unchecked.`,
    });
  }
  for (const condition of conditionSignals.slice(0, MAX_CONDITIONS_SCANNED)) {
    if (NON_DISEASE_HEALTH_SIGNALS.has(String(condition))) continue;
    const covering = diseaseSources.filter((s) => conditionCoveredBySource(condition, s, conditionOverlay));
    if (covering.length === 0) {
      gaps.push({
        lane: 'disease_specific',
        statement: `No disease-specific source lane exists for "${condition}".`,
        profile_fact: `health_condition=${condition}`,
        suggested_action: `Add a ${condition} patient-assistance / support source to the registry (like cancer_care / alzheimers_gov_services).`,
      });
    } else if (!covering.some((s) => selectedIds.has(s.source_id))) {
      const names = covering.map((s) => s.name).join(', ');
      gaps.push({
        lane: 'disease_specific',
        statement: `${names} covers "${condition}" but was not selected for this profile.`,
        profile_fact: `health_condition=${condition}`,
        suggested_action: 'Add the matching need category to the profile (or broaden the source coverage) so the disease-specific lane fires.',
      });
    }
  }

  // (c2b) SUPPORT NEEDS ("lodging", "copay_assistance") and disability descriptors.
  // These are not diagnoses, so they are a NEED-coverage question, not a disease-lane
  // one. Routing them here is what turns an unfillable ask ("add a lodging disease
  // lane") into a finite, convergent one ("teach the matcher that lodging is
  // housing"). `normalizeNeedCategory` is the SAME gate `signals.needs` already goes
  // through (profileHelpers), so a value it cannot resolve is genuinely a value no
  // source can match on — which canonical_rules calls out directly: "a field a
  // source cannot match on shouldn't be collected".
  const supportSignals = ctx.signals?.health_support instanceof Set
    ? [...ctx.signals.health_support]
    : Array.isArray(ctx.signals?.health_support) ? ctx.signals.health_support : [];
  const declaredNeeds = new Set((plan.needs || []).map((n) => String(n).toLowerCase()));
  // The sources this run actually searched — the same set (c3) judges need coverage
  // against, resolved once and shared so the two loops cannot disagree.
  const searchedSources = (plan.selected_sources || [])
    .map((s) => registryById[s.source_id])
    .filter(Boolean);
  for (const support of supportSignals.slice(0, MAX_SUPPORT_NEEDS_SCANNED)) {
    const canonical = normalizeNeedCategory(String(support));
    if (!canonical) {
      gaps.push({
        lane: null,
        statement: `Profile support need "${support}" is not in the matcher's need vocabulary, so no source can match on it.`,
        profile_fact: `support_need=${support}`,
        suggested_action: `Add "${support}" to NEED_ALIAS_MAP (backend/services/profileNormalizer.js) pointing at the canonical need it means — a one-line, finite fix. Do NOT add a disease lane: this is not a diagnosis.`,
      });
      continue;
    }
    // Already declared as a canonical need → (c3) below is the authority on whether
    // a source covers it; emitting here too would double-count the same gap.
    if (declaredNeeds.has(canonical)) continue;
    if (!needCoveredBySources(canonical, searchedSources)) {
      gaps.push({
        lane: null,
        statement: `No searched source covers the support need "${support}" (canonical need "${canonical}").`,
        profile_fact: `support_need=${support}`,
        suggested_action: `Add or broaden a source covering the "${canonical}" need category.`,
      });
    }
  }

  // (c3) Declared needs that NO searched source selects on. Shares
  // `searchedSources` with (c2b) so the two need-coverage answers cannot diverge.
  for (const need of (plan.needs || []).slice(0, 12)) {
    if (!needCoveredBySources(need, searchedSources)) {
      gaps.push({
        lane: null,
        statement: `No searched source covers the profile need "${need}".`,
        profile_fact: `need=${need}`,
        suggested_action: 'Add or broaden a source covering this need category, or refine the profile need wording to a covered category.',
      });
    }
  }

  // ── 3. Matches with evidence ──
  const matchRows = await loadStoredMatches(db, profileId);
  const missingFieldCounts = new Map(); // canonical field -> match count
  const matches = (matchRows || []).map((row) => {
    const evidence = extractMatchEvidence(row.match_explain_json, row);
    for (const f of evidence.eligibility.missing_fields) {
      const key = canonicalField(f);
      if (NON_USER_FIELDS.has(key) || NON_USER_FIELDS.has(String(f))) continue;
      missingFieldCounts.set(key, (missingFieldCounts.get(key) || 0) + 1);
    }
    return {
      id: row.opportunity_id,
      title: row.title,
      sponsor: row.sponsor ?? null,
      score: row.match_score ?? null,
      decision: row.match_decision ?? null,
      source_query: row.source_query ?? null,
      discovered_via: row.discovered_via ?? null,
      evidence,
    };
  });

  // ── 4. answer_next — merged, deduped, priority-ordered ──
  // Known-facts choke point (profileKnownFacts.js): a question is emitted only
  // when the profile does not already answer it (under ANY alias section) and
  // it applies to this profile's org/person side. This also neutralises STALE
  // match_explain_json — an explain computed before the user supplied their
  // gender/faith/income must not re-ask for it here.
  const factCtx = { profile: ctx.profile, sections: ctx.sections, signals: ctx.signals, normalized: ctx.profileNorm };
  const answerNextByField = new Map();
  const pushItem = (item) => {
    const key = canonicalField(item.field);
    if (!key || NON_USER_FIELDS.has(key)) return;
    if (!shouldAskProfileQuestion(key, factCtx)) return;
    const existing = answerNextByField.get(key);
    if (existing) {
      // merge: keep first question/why, fill in missing metadata.
      if (!existing.section_key && item.section_key) existing.section_key = item.section_key;
      if (!existing.why && item.why) existing.why = item.why;
      existing.blocked_matches = Math.max(existing.blocked_matches, item.blocked_matches || 0);
      return;
    }
    answerNextByField.set(key, { ...item, field: key });
  };

  // (a) fields blocking the most matches FIRST.
  const blocked = [...missingFieldCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [field, count] of blocked) {
    pushItem({
      field,
      question: MISSING_FIELD_QUESTIONS[field] || `Provide your ${humanizeField(field)}.`,
      why: `Confirms eligibility for ${count} potential match${count === 1 ? '' : 'es'} that currently cannot be verified.`,
      section_key: null,
      blocked_matches: count,
      source: 'match_gap',
    });
  }

  // (b) high-value profile field prompts.
  let prompts = [];
  try { prompts = await getProfileFieldPrompts(db, profileId); } catch { prompts = []; }
  for (const p of prompts) {
    pushItem({
      field: p.field,
      question: p.label,
      why: p.why,
      section_key: p.section_key ?? null,
      blocked_matches: 0,
      source: 'field_prompt',
    });
  }

  // (c) detailed readiness — per-category recommended questions.
  let readiness = null;
  try { readiness = await computeDetailedReadiness(db, profileId); } catch { readiness = null; }
  for (const cat of readiness?.categories || []) {
    if (cat.present) continue;
    const question = cat.recommended_questions?.[0] || cat.missing_items?.[0];
    if (!question) continue;
    pushItem({
      field: cat.key,
      question,
      why: cat.missing_items?.join(' ') || readiness?.impact_on_matching || '',
      section_key: null,
      blocked_matches: 0,
      source: 'readiness',
    });
  }

  const answer_next = [...answerNextByField.values()].sort(
    (a, b) => (b.blocked_matches - a.blocked_matches),
  );

  return {
    profile_id: profileId,
    display_name: ctx.profile.display_name ?? ctx.profile.name ?? null,
    primary_type: ctx.profile.primary_type ?? ctx.profile.applicant_type ?? null,
    generated_at: new Date().toISOString(),
    plan: {
      applicant_types: plan.applicant_types || [],
      needs: plan.needs || [],
      location,
      is_org: Boolean(plan.is_org),
      coverage: plan.coverage || {},
      readiness_score: readiness?.readiness_score ?? null,
    },
    lanes: LANES.map((l) => laneBuckets[l.lane]),
    gaps,
    matches,
    answer_next,
  };
}

export default { LANES, LANE_OF_SOURCE, laneForSource, extractMatchEvidence, buildCoverageEvidence };
