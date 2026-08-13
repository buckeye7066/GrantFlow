/**
 * orgNeedsTaxonomy.js — the PREDETERMINED NEEDS LIST a profile gets for free.
 *
 * Owner directive 2026-08-12: "when a profile identifies as a given org type,
 * automatically populate a predetermined list of candidate needs — unless
 * already shown to have it — plus whatever needs the owner types in
 * themselves, and run an honest, real search for each one."
 *
 * WHY THIS EXISTS
 * ---------------
 * Item search used to start from a blank box. `config/profileItemNeeds.js`
 * derives item needs from PERSON-shaped fields (DME, disability type, health
 * flags, credentialed role) — an organization profile walks in and derives
 * essentially nothing, so an org owner had to already know what to ask for.
 * That inverts the product: the whole value chain is DETERMINE THE NEED → run
 * the correct crawlers → use the profile's own facts to find real sources. This
 * module supplies the first link for entity applicants.
 *
 * THREE HARD RULES, each of which has a failing-first test
 * -------------------------------------------------------
 * 1. SUPPRESSION IS ONE-WAY AND EVIDENCE-ONLY. A need is withheld only when the
 *    profile carries POSITIVE evidence the org already has the thing. An empty
 *    list, an absent field, `''`, or `'unknown'` NEVER suppresses — absence of
 *    evidence is not evidence of possession. Getting this backwards would hide
 *    real needs from every under-filled profile, which is most of them.
 * 2. NOTHING IS SILENTLY DROPPED. Every blueprint need comes back in either
 *    `open` or `suppressed`, and every suppressed entry names the field and
 *    quotes the value that suppressed it. `candidates === open + suppressed` is
 *    asserted by a test, so a rule that silently eats a need fails CI.
 * 3. USER-ADDED NEEDS ARE FIRST-CLASS. Free text the owner typed is carried
 *    verbatim, is never adjudicated against this vocabulary before searching,
 *    and is never suppressed by it — the owner knows something we do not.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is NOT a matcher, a scorer, or an eligibility authority. It produces a
 * QUESTION LIST. `matchEngine.computeMatchDecision` remains the sole relevance
 * authority for anything the search returns, and nothing here manufactures a
 * percentage from a score (see the retired `fitPercent` 99%-scaler — that bug
 * class does not come back through this door).
 *
 * EXTENDING IT
 * ------------
 * Add an org type by adding one entry to `NEED_BLUEPRINTS` (or letting it fall
 * through to its group). Add a need by adding one entry to
 * `ORG_NEED_DEFINITIONS` and, if it can be already-held, one entry to
 * `SATISFACTION_RULES`. No other file changes.
 */

import { NEEDS_TAXONOMY, FUNDING_CATEGORY } from '../profileIntelligence/needsTaxonomy.js'
import {
  MISSION_ORG_TYPES,
  PUBLIC_ORG_TYPES,
  EDUCATION_ORG_TYPES,
  BUSINESS_TYPES,
  RESEARCH_ORG_TYPES,
  LEGACY_ORG_TYPES,
  isOrganizationProfileType,
} from '../../../shared/profileSectionApplicability.js'
import { canonicalizeProfileTypeId } from '../../../shared/profileTypeOptions.js'

export const ORG_NEEDS_TAXONOMY_VERSION = '1.0.0'

/** Cap on how many blueprint needs one profile can surface. Keeps the plan readable. */
export const MAX_PLAN_NEEDS = 24

/** Cap on user-typed needs folded into a plan. Mirrors MAX_ITEM_NEEDS' intent. */
export const MAX_USER_NEEDS = 12

// ---------------------------------------------------------------------------
// 1. Need definitions this repo did not already have
// ---------------------------------------------------------------------------
//
// `profileIntelligence/needsTaxonomy.js` already carries 38 vetted need
// definitions (facilities_repair, equipment, staffing_salary, technology,
// utilities_support, vehicles, ppe, training, program_operations,
// business_insurance, business_licensing, research_funding, …). Those are
// REUSED verbatim — this block only adds the ORG-CAPACITY needs that the
// existing taxonomy has no code for, in the SAME object shape so downstream
// consumers cannot tell them apart.

const ORG_NEED_DEFINITIONS = Object.freeze({
  operating_licensing: {
    code: 'operating_licensing',
    label: 'Operating licences & permits (state and local)',
    description:
      'State and local licences, registrations, and permits required to legally operate — business licence, occupancy/use permit, state facility registration, and the fees to obtain or renew them.',
    synonyms: ['business licence', 'business license', 'operating permit', 'occupancy permit', 'state registration', 'permit fees', 'licensure'],
    related_entity_types: ['business', 'nonprofit', 'hospital', 'research_lab'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.LOAN, FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: ['small business licensing fee assistance grant', 'startup permit fee waiver program', 'state business license assistance'],
    scoring_hint: 'startup_and_early_stage_orgs',
    is_capital: false,
    is_operational: true,
  },
  federal_registration: {
    code: 'federal_registration',
    label: 'Federal registrations & eligibility prerequisites',
    description:
      'The federal registrations that gate access to federal funding — SAM.gov / UEI, Grants.gov, eRA Commons — plus the assistance to complete them.',
    synonyms: ['sam.gov registration', 'uei', 'grants.gov account', 'era commons', 'federal registration', 'duns'],
    related_entity_types: ['business', 'nonprofit', 'research_lab', 'government', 'hospital'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: ['SAM.gov registration assistance nonprofit', 'grant readiness technical assistance program', 'federal grant registration help'],
    scoring_hint: 'prerequisite_not_a_funding_target',
    is_capital: false,
    is_operational: true,
  },
  biosafety_certification: {
    code: 'biosafety_certification',
    label: 'Biosafety certification & containment approval',
    description:
      'Institutional Biosafety Committee (IBC) registration, BSL-level containment certification, select-agent registration, and annual biosafety cabinet certification.',
    synonyms: ['biosafety', 'ibc', 'bsl-2', 'bsl-3', 'containment certification', 'select agent registration', 'biosafety cabinet certification'],
    related_entity_types: ['research_lab', 'hospital', 'college'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.CONTRACT],
    example_search_terms: ['biosafety level 2 laboratory certification grant', 'IBC registration support program', 'laboratory containment upgrade funding'],
    scoring_hint: 'high_weight_for_research_lab',
    is_capital: false,
    is_operational: true,
  },
  clinical_lab_certification: {
    code: 'clinical_lab_certification',
    label: 'Clinical laboratory certification (CLIA / CAP)',
    description:
      'CLIA certification and CAP accreditation required before a laboratory may report clinical results, plus proficiency testing and inspection costs. Only applies to labs doing CLINICAL testing.',
    synonyms: ['clia', 'clia waiver', 'cap accreditation', 'clinical laboratory improvement amendments', 'lab accreditation', 'proficiency testing'],
    related_entity_types: ['research_lab', 'hospital'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.CONTRACT],
    example_search_terms: ['CLIA certification cost assistance laboratory', 'CAP accreditation grant clinical lab', 'clinical laboratory startup funding'],
    scoring_hint: 'clinical_labs_only',
    is_capital: false,
    is_operational: true,
  },
  controlled_substance_registration: {
    code: 'controlled_substance_registration',
    label: 'Controlled-substance registration (DEA / state)',
    description:
      'DEA researcher or practitioner registration plus the matching state controlled-substance licence, secure storage, and recordkeeping required to hold scheduled compounds.',
    synonyms: ['dea registration', 'dea license', 'controlled substance license', 'schedule ii', 'controlled substance storage'],
    related_entity_types: ['research_lab', 'hospital'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: ['DEA researcher registration cost assistance', 'controlled substance secure storage grant laboratory'],
    scoring_hint: 'only_when_scheduled_compounds_in_scope',
    is_capital: false,
    is_operational: true,
  },
  facility_space: {
    code: 'facility_space',
    label: 'Physical facility — lease, purchase, or buildout',
    description:
      'Getting into adequate space: lease or rent, purchase, tenant improvement and buildout, and for laboratories the BSL-rated fit-out (fume hoods, HVAC, negative pressure, benching).',
    synonyms: ['lease', 'rent', 'building', 'facility', 'buildout', 'build-out', 'tenant improvement', 'lab space', 'wet lab space', 'incubator space'],
    related_entity_types: ['business', 'nonprofit', 'research_lab', 'church', 'community_action'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.LOAN, FUNDING_CATEGORY.DONOR],
    example_search_terms: ['wet lab space grant startup', 'facility buildout grant nonprofit', 'tenant improvement funding small business', 'lab incubator subsidized space'],
    scoring_hint: 'capital_high_weight',
    is_capital: true,
    is_operational: false,
  },
  lab_consumables: {
    code: 'lab_consumables',
    label: 'Laboratory consumables & reagents',
    description:
      'The recurring supply spend a lab cannot operate without: reagents, media, enzymes, antibodies, plasticware, tips, gloves, and kits.',
    synonyms: ['reagents', 'consumables', 'media', 'plasticware', 'pipette tips', 'antibodies', 'assay kits', 'lab supplies'],
    related_entity_types: ['research_lab', 'college', 'school', 'hospital'],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR],
    example_search_terms: ['laboratory reagent grant small research lab', 'research supplies grant program', 'reagent donation program researchers'],
    scoring_hint: 'operational_recurring',
    is_capital: false,
    is_operational: true,
  },
  working_capital: {
    code: 'working_capital',
    label: 'Working capital / operating runway',
    description:
      'Unrestricted operating money that covers payroll, rent, and overhead between revenue or award events — general operating support, bridge funding, runway.',
    synonyms: ['working capital', 'operating runway', 'general operating support', 'bridge funding', 'unrestricted operating', 'cash flow', 'overhead'],
    related_entity_types: ['business', 'nonprofit', 'research_lab', 'community_action', 'cdfi'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.LOAN, FUNDING_CATEGORY.DONOR],
    example_search_terms: ['general operating support grant', 'working capital grant small business', 'bridge funding nonprofit operating'],
    scoring_hint: 'unrestricted_operating',
    is_capital: false,
    is_operational: true,
  },
  regulatory_compliance: {
    code: 'regulatory_compliance',
    label: 'Regulatory & research-ethics compliance',
    description:
      'IRB (human subjects) and IACUC (animal welfare) review, FDA submissions where relevant, quality-system documentation, and the staff time or fees those reviews cost.',
    synonyms: ['irb', 'institutional review board', 'iacuc', 'animal welfare', 'human subjects', 'fda submission', 'ind', 'regulatory compliance', 'quality system'],
    related_entity_types: ['research_lab', 'hospital', 'college', 'nonprofit'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.CONTRACT],
    example_search_terms: ['IRB review cost assistance small research organization', 'IACUC compliance funding', 'regulatory support grant research'],
    scoring_hint: 'research_and_clinical_only',
    is_capital: false,
    is_operational: true,
  },
  ip_legal: {
    code: 'ip_legal',
    label: 'Intellectual property & legal costs',
    description:
      'Patent search, provisional and non-provisional filing fees, prosecution, trademark, plus incorporation and contract legal work.',
    synonyms: ['patent', 'patent filing', 'provisional patent', 'intellectual property', 'ip', 'trademark', 'legal fees', 'technology transfer'],
    related_entity_types: ['business', 'research_lab', 'nonprofit'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.CONTRACT, FUNDING_CATEGORY.OFTEN_NOT_FUNDABLE],
    example_search_terms: ['patent filing cost assistance program startup', 'pro bono patent program inventors', 'intellectual property grant small business'],
    scoring_hint: 'often_pro_bono_rather_than_grant',
    is_capital: false,
    is_operational: true,
  },
  hazardous_waste_disposal: {
    code: 'hazardous_waste_disposal',
    label: 'Hazardous & biohazardous waste disposal',
    description:
      'Regulated waste streams — biohazard/sharps pickup, chemical waste manifesting and disposal, autoclave capacity, and radioactive waste where applicable.',
    synonyms: ['hazardous waste', 'biohazard disposal', 'sharps disposal', 'chemical waste', 'medical waste', 'autoclave', 'waste manifest'],
    related_entity_types: ['research_lab', 'hospital', 'college', 'business'],
    disallowed_entity_types: ['individual'],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.REBATE, FUNDING_CATEGORY.CONTRACT],
    example_search_terms: ['hazardous waste disposal cost assistance small laboratory', 'medical waste disposal grant program', 'chemical waste disposal subsidy'],
    scoring_hint: 'operational_recurring',
    is_capital: false,
    is_operational: true,
  },
  data_infrastructure: {
    code: 'data_infrastructure',
    label: 'IT & research data infrastructure',
    description:
      'Servers, storage, backup, compute, LIMS/ELN software, and the security controls needed to hold research or clinical data.',
    synonyms: ['lims', 'eln', 'data storage', 'server', 'compute', 'cloud credits', 'backup', 'cybersecurity', 'data infrastructure', 'hipaa compliant storage'],
    related_entity_types: ['research_lab', 'hospital', 'college', 'nonprofit', 'business'],
    disallowed_entity_types: [],
    funding_categories: [FUNDING_CATEGORY.GRANT, FUNDING_CATEGORY.DONOR, FUNDING_CATEGORY.REBATE],
    example_search_terms: ['research computing cloud credits grant', 'LIMS software grant laboratory', 'nonprofit data infrastructure technology grant'],
    scoring_hint: 'donated_credits_are_common',
    is_capital: true,
    is_operational: true,
  },
})

/**
 * Resolve a need code against the ORG additions first, then the pre-existing
 * shared taxonomy. One lookup so callers never need to know which file a code
 * came from.
 */
export function getNeedDefinition(code) {
  const key = String(code ?? '').trim().toLowerCase()
  if (!key) return null
  return ORG_NEED_DEFINITIONS[key] ?? NEEDS_TAXONOMY[key] ?? null
}

export { ORG_NEED_DEFINITIONS }

// ---------------------------------------------------------------------------
// 2. Blueprints — which needs a given org type gets, in priority order
// ---------------------------------------------------------------------------
//
// Ordered deliberately: the things that BLOCK operating (licences, space) come
// before the things that improve it (training, outreach), because the plan is
// read top-down and a truncated plan should keep the blockers.

/** Every entity applicant starts here. */
const ORG_BASELINE = Object.freeze([
  'operating_licensing',
  'federal_registration',
  'facility_space',
  'equipment',
  'staffing_salary',
  'working_capital',
  'business_insurance',
  'utilities_support',
  'technology',
  'training',
  'program_operations',
])

const MISSION_BLUEPRINT = Object.freeze([
  'federal_registration',
  'facility_space',
  'staffing_salary',
  'program_operations',
  'working_capital',
  'business_insurance',
  'equipment',
  'utilities_support',
  'technology',
  'vehicles',
  'facilities_repair',
  'training',
  'capital_campaign',
  'donor_support_private',
  'community_outreach',
])

const PUBLIC_BLUEPRINT = Object.freeze([
  'public_safety_equipment',
  'vehicles',
  'ppe',
  'equipment',
  'facilities_repair',
  'safety_upgrades',
  'training',
  'staffing_salary',
  'technology',
  'utilities_support',
  'disaster_recovery',
  'accessibility_upgrades',
])

const EDUCATION_BLUEPRINT = Object.freeze([
  'technology',
  'equipment',
  'stem_education',
  'training',
  'arts_equipment',
  'athletics_equipment',
  'facilities_repair',
  'accessibility_upgrades',
  'food_programs',
  'transportation_support',
  'staffing_salary',
  'safety_upgrades',
])

const BUSINESS_BLUEPRINT = Object.freeze([
  'business_licensing',
  'operating_licensing',
  'business_startup',
  'facility_space',
  'equipment',
  'working_capital',
  'business_insurance',
  'staffing_salary',
  'technology',
  'training',
  'ip_legal',
  'workforce_development',
])

/**
 * THE BIOLAB / RESEARCH-LAB BLUEPRINT.
 *
 * Covers the owner's stated minimum in order: licensing/permits (state,
 * federal, biosafety, CLIA/CAP, DEA) → facility → equipment (capital +
 * consumables) → staff → working capital → insurance → regulatory/compliance →
 * IP/legal → utilities/waste → IT/data.
 *
 * `clinical_lab_certification` and `controlled_substance_registration` are in
 * the blueprint but are CONDITIONAL (see `CONDITIONAL_NEEDS`): a bench research
 * lab that reports no clinical testing and holds no scheduled compounds should
 * not be told it needs CLIA or a DEA licence.
 */
const RESEARCH_LAB_BLUEPRINT = Object.freeze([
  'operating_licensing',
  'federal_registration',
  'biosafety_certification',
  'clinical_lab_certification',
  'controlled_substance_registration',
  'facility_space',
  'equipment',
  'lab_consumables',
  'staffing_salary',
  'working_capital',
  'business_insurance',
  'regulatory_compliance',
  'ip_legal',
  'utilities_support',
  'hazardous_waste_disposal',
  'data_infrastructure',
  'research_funding',
  'training',
])

/**
 * Per-type overrides. Anything not listed here falls through to its GROUP
 * blueprint (below), then to ORG_BASELINE — so adding a profile type never
 * silently produces an empty plan.
 */
const NEED_BLUEPRINTS = Object.freeze({
  research_lab: RESEARCH_LAB_BLUEPRINT,
  volunteer_fire_department: Object.freeze([
    'public_safety_equipment', 'ppe', 'vehicles', 'equipment', 'training',
    'facilities_repair', 'safety_upgrades', 'technology', 'utilities_support', 'disaster_recovery',
  ]),
  food_pantry: Object.freeze([
    'food_programs', 'equipment', 'vehicles', 'facility_space', 'staffing_salary',
    'working_capital', 'utilities_support', 'technology', 'business_insurance', 'donor_support_private',
  ]),
  library: Object.freeze([
    'technology', 'broadband', 'equipment', 'facilities_repair', 'accessibility_upgrades',
    'staffing_salary', 'training', 'community_outreach', 'arts_equipment', 'utilities_support',
  ]),
  church: Object.freeze([
    'facilities_repair', 'facility_space', 'utilities_support', 'accessibility_upgrades', 'safety_upgrades',
    'vehicles', 'technology', 'program_operations', 'food_programs', 'denomination_support',
    'donor_support_private', 'business_insurance',
  ]),
})

/** Group fallbacks, checked in order. First membership hit wins. */
const GROUP_BLUEPRINTS = Object.freeze([
  { key: 'research', types: RESEARCH_ORG_TYPES, needs: RESEARCH_LAB_BLUEPRINT },
  { key: 'public', types: PUBLIC_ORG_TYPES, needs: PUBLIC_BLUEPRINT },
  { key: 'education', types: EDUCATION_ORG_TYPES, needs: EDUCATION_BLUEPRINT },
  { key: 'mission', types: MISSION_ORG_TYPES, needs: MISSION_BLUEPRINT },
  { key: 'business', types: BUSINESS_TYPES, needs: BUSINESS_BLUEPRINT },
  { key: 'legacy_org', types: LEGACY_ORG_TYPES, needs: ORG_BASELINE },
])

export { NEED_BLUEPRINTS, GROUP_BLUEPRINTS, ORG_BASELINE }

/**
 * Which blueprint applies, and WHY. Returns the source so the API can explain
 * "you got the research-lab list because your profile type is research_lab"
 * rather than presenting an unexplained list.
 */
export function resolveBlueprint(rawProfileType) {
  const type = canonicalizeProfileTypeId(rawProfileType) || String(rawProfileType ?? '').trim().toLowerCase()
  if (!type) return { key: null, source: 'none', codes: [], profile_type: null }

  if (NEED_BLUEPRINTS[type]) {
    return { key: type, source: 'profile_type', codes: [...NEED_BLUEPRINTS[type]], profile_type: type }
  }
  for (const group of GROUP_BLUEPRINTS) {
    if (group.types.includes(type)) {
      return { key: group.key, source: 'org_group', codes: [...group.needs], profile_type: type }
    }
  }
  if (isOrganizationProfileType(type)) {
    return { key: 'org_baseline', source: 'org_baseline', codes: [...ORG_BASELINE], profile_type: type }
  }
  // Person profiles deliberately get NO org blueprint. Their needs come from
  // `config/profileItemNeeds.js`, which reads person-shaped fields. Returning an
  // empty list here (rather than a wrong one) is the honest answer.
  return { key: null, source: 'not_an_organization', codes: [], profile_type: type }
}

// ---------------------------------------------------------------------------
// 3. Conditional needs — in the blueprint, but only asked when relevant
// ---------------------------------------------------------------------------
//
// Distinct from suppression. Suppression means "you already have it".
// Conditional means "this need may not apply to you at all". Both are reported
// separately so neither can masquerade as the other.

const CONDITIONAL_NEEDS = Object.freeze({
  clinical_lab_certification: {
    reason: 'Only applies to laboratories reporting CLINICAL results on human specimens.',
    // Any of these signals present → ask. Nothing present → hold it back as
    // `not_applicable`, never as `open`.
    signals: ['clinical', 'diagnostic', 'patient', 'clia', 'cap ', 'human specimen', 'clinical trial', 'lab-developed test', 'ldt'],
  },
  controlled_substance_registration: {
    reason: 'Only applies to labs handling DEA-scheduled compounds.',
    signals: ['controlled substance', 'dea', 'schedule i', 'schedule ii', 'scheduled compound', 'narcotic', 'opioid', 'ketamine', 'psychedelic'],
  },
  denomination_support: {
    reason: 'Only applies to congregations affiliated with a denomination.',
    signals: ['denomination', 'diocese', 'synod', 'presbytery', 'conference', 'convention', 'district', 'archdiocese'],
  },
})

export { CONDITIONAL_NEEDS }

// ---------------------------------------------------------------------------
// 4. Satisfaction rules — the "unless already shown to have" half
// ---------------------------------------------------------------------------
//
// Rule kinds:
//   flag      — a boolean profile field being TRUE is possession
//   list_any  — any entry of a string-array field contains any listed keyword
//   value_in  — a scalar field's value is one of an explicit allow-list
//
// A rule NEVER fires on a falsy/empty/unknown value. That is the one-way
// property, and `orgNeedsTaxonomy.test.js` asserts it directly.

const SATISFACTION_RULES = Object.freeze({
  operating_licensing: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['business licen', 'operating permit', 'occupancy', 'state registration', 'state licen', 'permit'] },
  ],
  federal_registration: [
    { kind: 'flag', section: 'organization_details', field: 'sam_gov_registered' },
    { kind: 'flag', section: 'organization_details', field: 'grants_gov_account' },
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['sam.gov', 'sam gov', 'uei', 'grants.gov'] },
  ],
  biosafety_certification: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['biosafety', 'ibc', 'bsl-2', 'bsl2', 'bsl-3', 'bsl3', 'containment', 'select agent'] },
    { kind: 'list_any', section: 'organization_details', field: 'regulatory_approvals_held', keywords: ['biosafety', 'ibc', 'select agent'] },
  ],
  clinical_lab_certification: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['clia', 'cap accredit', 'college of american pathologists', 'clinical laboratory'] },
  ],
  controlled_substance_registration: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['dea', 'controlled substance'] },
  ],
  facility_space: [
    { kind: 'value_in', section: 'organization_details', field: 'facility_status', values: ['owned', 'leased'] },
  ],
  equipment: [
    { kind: 'list_any', section: 'organization_details', field: 'equipment_owned', keywords: null },
  ],
  business_insurance: [
    { kind: 'list_any', section: 'organization_details', field: 'insurance_held', keywords: null },
    { kind: 'list_any', section: 'nonprofit_compliance', field: 'insurance_coverage', keywords: null },
  ],
  regulatory_compliance: [
    { kind: 'list_any', section: 'organization_details', field: 'regulatory_approvals_held', keywords: ['irb', 'iacuc', 'institutional review', 'animal care', 'ind', 'fda'] },
  ],
  ip_legal: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['patent granted', 'issued patent', 'trademark registered'] },
  ],
  data_infrastructure: [
    { kind: 'list_any', section: 'organization_details', field: 'equipment_owned', keywords: ['lims', 'eln', 'server', 'storage array', 'data center', 'hpc cluster'] },
  ],
  business_licensing: [
    { kind: 'list_any', section: 'organization_details', field: 'licenses_held', keywords: ['business licen', 'operating permit', 'state licen'] },
  ],
  vehicles: [
    { kind: 'list_any', section: 'organization_details', field: 'equipment_owned', keywords: ['van', 'truck', 'bus', 'vehicle', 'ambulance', 'fleet'] },
  ],
  ppe: [
    { kind: 'list_any', section: 'organization_details', field: 'equipment_owned', keywords: ['ppe', 'turnout gear', 'bunker gear', 'scba', 'respirator'] },
  ],
  broadband: [
    // A profile explicitly flagged as UNSERVED is the opposite of satisfied, so
    // this rule reads the positive side only: adequate service on record.
    { kind: 'list_any', section: 'organization_details', field: 'equipment_owned', keywords: ['fiber', 'broadband', 'gigabit'] },
  ],
})

export { SATISFACTION_RULES }

// ---------------------------------------------------------------------------
// 5. Evidence evaluation
// ---------------------------------------------------------------------------

function readSectionValue(sections, sectionKey, fieldName) {
  const section = sections?.[sectionKey]
  if (!section || typeof section !== 'object' || Array.isArray(section)) return undefined
  return section[fieldName]
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Values that must NEVER count as possession. `'unknown'` is here on purpose:
 * a field a user left at its unknown default is silence, not a yes.
 */
const NON_EVIDENCE_VALUES = new Set(['', 'unknown', 'none', 'n/a', 'na', 'no', 'false', 'tbd', 'not applicable', '-'])

function isEvidenceText(value) {
  const t = normalizeText(value)
  if (!t) return false
  return !NON_EVIDENCE_VALUES.has(t)
}

/**
 * Evaluate ONE rule. Returns null when the rule does not fire.
 * Returns `{ field, value }` (the quotable evidence) when it does.
 */
function evaluateRule(rule, sections) {
  const raw = readSectionValue(sections, rule.section, rule.field)
  const fieldPath = `${rule.section}.${rule.field}`

  if (rule.kind === 'flag') {
    // Strict truthiness: SQLite booleans arrive as 0/1 and JSON booleans as
    // true/false; the string 'false' must not read as true.
    const t = normalizeText(raw)
    const on = raw === true || raw === 1 || t === 'true' || t === '1' || t === 'yes'
    return on ? { field: fieldPath, value: true } : null
  }

  if (rule.kind === 'value_in') {
    const t = normalizeText(raw)
    if (!isEvidenceText(t)) return null
    return rule.values.includes(t) ? { field: fieldPath, value: String(raw) } : null
  }

  if (rule.kind === 'list_any') {
    // Accept both an array field and a single string field (nonprofit_compliance
    // .insurance_coverage is a string), so one rule kind covers both shapes.
    const entries = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : [])
    for (const entry of entries) {
      if (!isEvidenceText(entry)) continue
      // keywords === null means "any non-empty entry is evidence" — used where
      // the field's very existence is the claim (equipment_owned, insurance_held).
      if (rule.keywords === null) return { field: fieldPath, value: String(entry).trim() }
      const t = normalizeText(entry)
      const hit = rule.keywords.find((kw) => t.includes(kw))
      if (hit) return { field: fieldPath, value: String(entry).trim(), matched_keyword: hit }
    }
    return null
  }

  return null
}

/**
 * Is this need already satisfied by the profile's own record?
 * Returns `{ satisfied: false }` or `{ satisfied: true, evidence: {...} }`.
 * Exported so the suppression logic can be unit-tested directly.
 */
export function evaluateSatisfaction(code, sections) {
  const rules = SATISFACTION_RULES[code]
  if (!Array.isArray(rules) || rules.length === 0) return { satisfied: false, evidence: null }
  for (const rule of rules) {
    const hit = evaluateRule(rule, sections)
    if (hit) {
      return {
        satisfied: true,
        evidence: {
          field: hit.field,
          value: hit.value,
          matched_keyword: hit.matched_keyword ?? null,
          rule_kind: rule.kind,
        },
      }
    }
  }
  return { satisfied: false, evidence: null }
}

/**
 * Does a CONDITIONAL need apply to this profile? Scans the profile's own free
 * text (mission, notes, focus areas, item needs, licences) for the signal terms.
 * No signal → the need is held back as `not_applicable`, WITH its reason.
 */
function evaluateApplicability(code, sections) {
  const conditional = CONDITIONAL_NEEDS[code]
  if (!conditional) return { applicable: true, reason: null, matched_signal: null }

  const haystackParts = []
  for (const section of Object.values(sections ?? {})) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    for (const value of Object.values(section)) {
      if (typeof value === 'string') haystackParts.push(value)
      else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === 'string') haystackParts.push(v)
      }
    }
  }
  const haystack = normalizeText(haystackParts.join('  '))
  const matched = conditional.signals.find((signal) => haystack.includes(signal))
  return matched
    ? { applicable: true, reason: null, matched_signal: matched }
    : { applicable: false, reason: conditional.reason, matched_signal: null }
}

// ---------------------------------------------------------------------------
// 6. Search subjects — turning a need into something a crawler can actually run
// ---------------------------------------------------------------------------

/**
 * The phrase handed to `itemNeedSearch.searchItemNeed` as the search subject.
 *
 * Deliberately the need's own LABEL plus its most concrete example term, NOT a
 * synthesised sentence: `liveWebSearch.buildNeedWebQueries` already layers the
 * profile's geography and entity words on top, and `shared/needTaxonomy.expandNeed`
 * expands synonyms. Stacking a third rewriting layer here is how a query turns
 * into soup that matches nothing.
 */
/**
 * Blueprint-scoped subject overrides.
 *
 * WHY THIS EXISTS. `example_search_terms[0]` is a property of the NEED, but the
 * need definitions in `profileIntelligence/needsTaxonomy.js` are SHARED across
 * entity types, and their first example is written for whichever entity the
 * author had in mind. `staffing_salary`'s is "SAFER grant fire department";
 * `training`'s is "firefighter training grant"; `utilities_support`'s is the
 * household program "LIHEAP utility assistance". Handing those to the crawler
 * for a research lab does not merely miss — it confidently searches for the
 * WRONG THING and returns real, reachable, useless results (measured live
 * 2026-08-13: the biolab staffing subject returned FEMA SAFER, IAFF firefighter
 * guidance, and a state firefighters' association).
 *
 * ONLY PROVABLY-FOREIGN subjects are overridden. A merely GENERIC subject
 * ("equipment grant nonprofit") is left alone — a nonprofit lab may legitimately
 * use it, and inventing a narrower claim is the failure mode this file's own
 * suppression rules exist to avoid. Positive evidence acts; silence does not.
 */
const BLUEPRINT_SEARCH_SUBJECTS = Object.freeze({
  research: Object.freeze({
    staffing_salary: 'research staff salary support grant laboratory',
    training: 'laboratory staff training certification grant',
    utilities_support: 'laboratory facility utility cost assistance',
  }),
  research_lab: Object.freeze({
    staffing_salary: 'research staff salary support grant laboratory',
    training: 'laboratory staff training certification grant',
    utilities_support: 'laboratory facility utility cost assistance',
  }),
})

export { BLUEPRINT_SEARCH_SUBJECTS }

export function buildSearchSubject(code, blueprintKey = null) {
  const def = getNeedDefinition(code)
  const override = blueprintKey ? BLUEPRINT_SEARCH_SUBJECTS[blueprintKey]?.[code] : null
  if (override) return override
  if (!def) return String(code ?? '').replace(/_/g, ' ').trim()
  const example = Array.isArray(def.example_search_terms) ? def.example_search_terms[0] : null
  return example || def.label || String(code).replace(/_/g, ' ')
}

// ---------------------------------------------------------------------------
// 7. User-added needs
// ---------------------------------------------------------------------------

const USER_NEED_FIELDS = Object.freeze([
  { section: 'financial_information', field: 'item_needs' },
  { section: 'financial_information', field: 'assistance_needs' },
])

/**
 * Free-text needs the profile owner typed, carried VERBATIM.
 *
 * These are never adjudicated against `NEEDS_TAXONOMY` before searching and are
 * never suppressed by a satisfaction rule — the owner asserting a need
 * outranks our inference that they already have it. `matched_code` is
 * best-effort provenance only; a null there does not demote the entry.
 */
export function collectUserNeeds(sections) {
  const out = []
  const seen = new Set()
  for (const { section, field } of USER_NEED_FIELDS) {
    const raw = readSectionValue(sections, section, field)
    const entries = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : [])
    for (const entry of entries) {
      const text = String(entry ?? '').trim()
      if (!text) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        code: null,
        label: text,
        source: 'user_added',
        origin_field: `${section}.${field}`,
        search_subject: text,
        is_capital: null,
        funding_categories: [],
      })
      if (out.length >= MAX_USER_NEEDS) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 8. The public entry point
// ---------------------------------------------------------------------------

/**
 * Derive the full needs plan for a profile.
 *
 * @param {object} args
 * @param {object} args.profile  profiles row (needs `primary_type`)
 * @param {object} args.sections profile_sections keyed by section_key
 * @returns {{
 *   taxonomy_version: string,
 *   profile_type: string|null,
 *   blueprint: {key: string|null, source: string},
 *   candidate_count: number,
 *   open: Array<object>,
 *   suppressed: Array<object>,
 *   not_applicable: Array<object>,
 *   user_added: Array<object>,
 *   truncated: number,
 * }}
 *
 * INVARIANT (test-enforced): candidate_count === open.length + suppressed.length
 * + not_applicable.length + truncated. Nothing is dropped without a named reason.
 */
export function deriveOrgNeeds({ profile = {}, sections = {} } = {}) {
  const primaryType = profile?.primary_type ?? null
  const blueprint = resolveBlueprint(primaryType)

  const open = []
  const suppressed = []
  const notApplicable = []

  const candidates = blueprint.codes
  let truncated = 0

  for (const code of candidates) {
    const def = getNeedDefinition(code)
    if (!def) {
      // A blueprint naming a code with no definition is a BUG, not a silent
      // skip. Surface it as an unresolved entry so it cannot hide.
      notApplicable.push({
        code,
        label: String(code).replace(/_/g, ' '),
        reason: 'no_definition',
        detail: 'This need code has no definition in the taxonomy. Report it — the blueprint is out of sync.',
      })
      continue
    }

    const base = {
      code: def.code,
      label: def.label,
      description: def.description,
      is_capital: Boolean(def.is_capital),
      is_operational: Boolean(def.is_operational),
      funding_categories: [...(def.funding_categories ?? [])],
      search_subject: buildSearchSubject(def.code, blueprint.key),
      source: 'profile_type_blueprint',
      blueprint: blueprint.key,
    }

    const applicability = evaluateApplicability(def.code, sections)
    if (!applicability.applicable) {
      notApplicable.push({ ...base, reason: 'conditional_signal_absent', detail: applicability.reason })
      continue
    }

    const satisfaction = evaluateSatisfaction(def.code, sections)
    if (satisfaction.satisfied) {
      suppressed.push({
        ...base,
        reason: 'already_held',
        // Quote the evidence so the owner can see WHY it vanished and correct
        // the record if we are wrong. A silent disappearance would be the same
        // defect class as a silent no-op.
        evidence: satisfaction.evidence,
      })
      continue
    }

    if (open.length >= MAX_PLAN_NEEDS) {
      truncated += 1
      continue
    }
    open.push(base)
  }

  const userAdded = collectUserNeeds(sections)

  return {
    taxonomy_version: ORG_NEEDS_TAXONOMY_VERSION,
    profile_type: blueprint.profile_type,
    blueprint: { key: blueprint.key, source: blueprint.source },
    candidate_count: candidates.length,
    open,
    suppressed,
    not_applicable: notApplicable,
    user_added: userAdded,
    truncated,
  }
}

export default {
  ORG_NEEDS_TAXONOMY_VERSION,
  ORG_NEED_DEFINITIONS,
  NEED_BLUEPRINTS,
  SATISFACTION_RULES,
  CONDITIONAL_NEEDS,
  getNeedDefinition,
  resolveBlueprint,
  evaluateSatisfaction,
  collectUserNeeds,
  buildSearchSubject,
  deriveOrgNeeds,
}
