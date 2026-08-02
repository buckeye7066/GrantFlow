/**
 * sourceLanes.js — the LANE TAXONOMY and the CONDITION VOCABULARY, in ONE place.
 *
 * WHY THIS MODULE EXISTS (2026-08-02). Both facts below were owned by
 * `services/coverageEvidenceService.js`, which imports `crawlerPlanExplainer` →
 * `crawler-os/planner`. So the planner — the code that decides WHICH CRAWLERS
 * RUN — could not consult either without a circular import, and the OS was left
 * to fire every condition lane it had for any profile carrying a coarse
 * `disability`/`medical` need. Measured read-only in prod 2026-08-02: **438
 * disease-lane selections across 33 real profiles**, including 19 apiece for
 * profiles whose health vocabulary is EMPTY (Robert White, Admin Vault, Tasha
 * Reynolds) and for Anastasia White, who declares `disability_status: "Has
 * disability"` while her own medical sections say *"no chronic illnesses or
 * disabilities noted"* — a disability with **no named condition**.
 *
 * `coverageEvidenceService` re-exports everything here verbatim, so every
 * existing consumer, and the totality test that pins `LANE_OF_SOURCE` against
 * the registry, are unaffected. This is a MOVE, not a fork: a second copy of
 * either fact is exactly what would let the dashboard and the planner disagree
 * about what a lane is.
 *
 * Pure data + pure predicates. No I/O.
 */

// The registry is pure data with no imports of its own, so reading it here
// cannot re-create the cycle this module exists to break.
import { STATE_BENEFITS_SOURCE_IDS } from '../crawler-os/sourceRegistry.js';

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
  // Agriculture coverage lanes (2026-08-01, the Anita class): the registry
  // reached USDA RD + NRCS but not FSA, SARE, VAPG or the extension network.
  usda_fsa_farm_programs: 'federal_grants',
  sare_farmer_rancher_grants: 'federal_grants',
  usda_value_added_producer_grants: 'federal_grants',
  nifa_extension_land_grant: 'federal_grants',
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
  // Kentucky's state-funded on-farm cost-share (KADF/CAIP) — the KY lane held
  // only kynect (household benefits), so a Kentucky farm reached no state
  // agriculture money at all (2026-08-01).
  ky_agricultural_development_fund: 'state_programs',
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
  // Soil-and-water conservation districts are a COUNTY-level delivery arm for
  // state/federal cost-share — the county lane, not the federal one.
  conservation_districts_directory: 'county_city',
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
  // Farm Credit — the producer-owned private lending system's YBS locator. Not
  // a charity, but it is the private (non-government) funder lane for a farm.
  farm_credit_young_beginning_small: 'private_charities',
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
 * Words that describe the SHAPE of a diagnosis rather than which disease it is.
 * Two sources sharing one of these share nothing — "chronic kidney disease" and
 * "alzheimer's disease" have `disease` in common and are not the same lane.
 * Laterality/severity are the same story: "left" is not an identity.
 */
export const GENERIC_CONDITION_WORDS = new Set([
  'disease', 'diseases', 'disorder', 'disorders', 'syndrome', 'condition', 'conditions',
  'illness', 'chronic', 'acute', 'severe', 'mild', 'moderate', 'stage', 'type',
  'left', 'right', 'bilateral', 'primary', 'secondary', 'early', 'late', 'onset',
  'support', 'care', 'health', 'medical', 'patient', 'assistance', 'general',
]);

/** Whole-word (token-boundary) containment: `renal` must NOT match inside `adrenal`. */
export function containsTerm(haystack, term) {
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

/**
 * Profile-side terms that name a CATEGORY OF PERSON, not a condition.
 *
 * THE DEFECT THEY FIX, measured 2026-08-02. `conditionCoveredBySource` matches
 * a term in EITHER direction, because `cancer` ⊂ "breast cancer" is the
 * load-bearing case. Run in reverse, the bare token `disability` sits inside
 * `autism_speaks_family_support`'s curated `developmental disability` and
 * `reeve_foundation_paralysis`'s `physical disability` — so a profile that
 * declares nothing but "has a disability" was covered by an autism lane and a
 * spinal-cord-injury lane. That is the #937 one-shared-word floor arriving from
 * the PROFILE side, and it is why an unnamed disability fired a named-condition
 * fleet.
 *
 * A term here is still a perfectly good NEED (`servesNeed` reads
 * `need_categories` and admits the generic disability/benefit lanes on exactly
 * this signal). It is only refused the power to claim a lane built around a
 * specific diagnosis.
 */
export const GENERIC_HEALTH_DESCRIPTORS = Object.freeze(new Set([
  'disability', 'disabled', 'disabilities', 'handicap', 'handicapped',
  'special needs', 'physical', 'physical disability', 'mental', 'medical',
  'health', 'healthcare', 'health care', 'chronic illness', 'chronic condition',
  'medical assistance', 'medical needs', 'support', 'general', 'unknown',
  'community support services', 'assistance',
]));

/**
 * Does this source's CURATED KEYWORD vocabulary name something the profile
 * actually DECLARED?
 *
 * Two deliberate narrowings versus `conditionCoveredBySource` above, and each
 * one was measured against the real registry and the real fleet:
 *
 *   1. **`keywords[]` ONLY — never `need_categories`.** `need_categories` is
 *      the coarse taxonomy the planner's `servesNeed` gate ALREADY reads; using
 *      it again here would let `disability` re-authorize itself, which is the
 *      whole defect. The curated keyword lists are real diagnosis vocabularies
 *      ("chronic kidney disease", "anoxic brain injury", "cpap", "prosthesis"),
 *      and every `disease_specific` source carries one (totality-tested).
 *   2. **`GENERIC_HEALTH_DESCRIPTORS` are refused on the PROFILE side**, so an
 *      unnamed disability cannot reach a named-condition lane in reverse.
 *
 * `conditionCoveredBySource` is deliberately left alone: it answers a DIFFERENT
 * question ("does a lane for this condition exist at all?") for the coverage
 * wishlist, where over-breadth costs an unfillable ask rather than a crawl.
 */
export function sourceServesDeclaredCondition(source, declaredTerms = []) {
  const terms = (Array.isArray(source?.keywords) ? source.keywords : [])
    .map((t) => String(t || '').toLowerCase().replace(/_/g, ' ').trim())
    .filter((t) => t.length >= 4 && !GENERIC_CONDITION_WORDS.has(t));
  if (terms.length === 0) return false;
  for (const declared of declaredTerms || []) {
    const raw = String(declared || '').trim().toLowerCase().replace(/_/g, ' ');
    if (!raw || raw.length < 4) continue;
    if (GENERIC_CONDITION_WORDS.has(raw) || GENERIC_HEALTH_DESCRIPTORS.has(raw)) continue;
    if (terms.some((term) => containsTerm(raw, term) || containsTerm(term, raw))) return true;
  }
  return false;
}

/** Source ids whose whole identity is a specific diagnosis or treatment need. */
export const DISEASE_SPECIFIC_SOURCE_IDS = Object.freeze(
  Object.entries(LANE_OF_SOURCE)
    .filter(([, lane]) => lane === 'disease_specific')
    .map(([id]) => id),
);

export function isDiseaseSpecificSource(sourceId) {
  return DISEASE_SPECIFIC_SOURCE_IDS.includes(String(sourceId ?? ''));
}
