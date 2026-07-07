/**
 * profileKnownFacts — the single "does the profile already answer this?" gate.
 *
 * Owner directive (2026-07-06): "Many of the qualifier questions are repeats of
 * information in the profile, like religion, gender, etc. Make sure there are
 * no duplicates because each data point matters for scoring."
 *
 * The duplicate class has TWO roots, and this module is the one choke point
 * for both:
 *
 *  1. ALIAS DRIFT — the same real-world fact lives under several section/field
 *     spellings (gender in basic_information AND demographics; veteran in
 *     military_service.veteran AND demographics.veteran_status AND
 *     family.veteran_status; funding amount in narrative, financial_information,
 *     programs_services, small_business_details…). Each question surface grew
 *     its own partial field list, so a fact stored under an alias the surface
 *     didn't know about got re-asked. CANONICAL_FACTS below enumerates, per
 *     fact, the canonical home + every known read-alias, so "already answered"
 *     means answered ANYWHERE the data actually lives.
 *
 *  2. TYPE-INAPPLICABILITY — person-demographic questions (gender, age,
 *     disability, veteran, household income…) asked of ORGANIZATION profiles,
 *     and org questions (organization type, population served, tax status)
 *     asked of individuals. APPLIES_TO below is the org/person matrix, derived
 *     from the same shared/profileSectionApplicability.js classification the
 *     profile editor uses.
 *
 * Every question-asking surface must run its outgoing questions through
 * shouldAskProfileQuestion():
 *   - profileReadinessService.computeDetailedReadiness (category questions)
 *   - profileFieldPrompts.getProfileFieldPrompts (match-page nudges)
 *   - profileGapInterview.buildProfileGapPlan (Anya login/gap interview)
 *   - coverageEvidenceService answer_next (merged dashboard questions —
 *     also kills STALE match_explain missing-fields: an explain computed
 *     before the user added their gender must not re-ask gender)
 *
 * Fail-open by design: an unknown question id, a missing profile, or an
 * undecidable profile side always returns "ask it". Filtering only ever
 * REMOVES a question when the fact is demonstrably present or demonstrably
 * inapplicable — it can never hide a real gap.
 *
 * Boolean semantics: schema-defaulted booleans (profile repair stamps every
 * default-false flag) only count as ANSWERED when true — a stored `false` is
 * indistinguishable from "never asked". String/number/tri-state fields count
 * when non-empty and not 'unknown'/'none' — an explicit "Not a veteran" IS an
 * answer.
 */

import {
  isOrganizationProfileType,
  isPersonProfileType,
  isStudentProfileType,
} from '../../shared/profileSectionApplicability.js'

// ─────────────────────────────────────────────────────────────────────────────
// Context + value helpers
// ─────────────────────────────────────────────────────────────────────────────

const UNANSWERED_STRINGS = new Set(['', 'unknown', 'none', 'n/a', 'na', 'unspecified'])

/** True when a stored STRING/NUMBER value is a real answer. */
function answeredValue(v) {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v === true // default-false repair stamps don't count
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.length > 0
  const s = String(v).trim().toLowerCase()
  return !UNANSWERED_STRINGS.has(s)
}

/** Sections may be stored raw or wrapped as { answers: {...} } / { data: {...} }. */
function sectionData(sections, key) {
  const raw = sections?.[key]
  if (!raw || typeof raw !== 'object') return {}
  if (raw.answers && typeof raw.answers === 'object') return raw.answers
  if (raw.data && typeof raw.data === 'object') return raw.data
  return raw
}

/** Number(null)/Number('') coerce to 0 — require a real value before testing. */
function finiteNum(v) {
  if (v === null || v === undefined || v === '') return false
  return Number.isFinite(Number(v))
}

function setHasAny(set, ...values) {
  if (!set) return false
  const has = (v) => (set instanceof Set ? set.has(v) : Array.isArray(set) && set.includes(v))
  return values.length === 0
    ? (set instanceof Set ? set.size > 0 : Array.isArray(set) && set.length > 0)
    : values.some(has)
}

function normalizeCtx(ctx = {}) {
  return {
    profile: ctx.profile ?? null,
    sections: ctx.sections ?? {},
    signals: ctx.signals ?? null,
    // both spellings seen in the codebase (profileNorm from loadProfileContext,
    // normalized from normalizeProfile callers)
    normalized: ctx.normalized ?? ctx.profileNorm ?? null,
  }
}

function declaredType(ctx) {
  const { profile, sections } = ctx
  const basic = sectionData(sections, 'basic_information')
  return (
    profile?.applicant_type ??
    profile?.primary_type ??
    profile?.primary_profile_type ??
    basic.profile_category ??
    null
  )
}

const ORG_ENTITY_TYPES = new Set(['nonprofit', 'business', 'government', 'school', 'institution', 'organization', 'farm'])
const PERSON_ENTITY_TYPES = new Set(['individual', 'caregiver', 'student', 'veteran', 'family', 'senior', 'researcher'])

/**
 * Which side of the org/person matrix is this profile on?
 * Declared identity only — section PRESENCE never promotes a person to an org
 * (the Kimberly Botts hallucinated-org-section class). Unknown → 'unknown'
 * (never used to filter).
 *
 * @returns {'person'|'org'|'unknown'}
 */
export function resolveProfileSide(rawCtx) {
  const ctx = normalizeCtx(rawCtx)
  const basic = sectionData(ctx.sections, 'basic_information')
  const kind = String(basic.applicant_kind ?? '').trim().toLowerCase()
  if (kind === 'organization') return 'org'
  if (kind === 'individual') return 'person'

  const type = declaredType(ctx)
  if (type) {
    if (isOrganizationProfileType(type)) return 'org'
    if (isPersonProfileType(type)) return 'person'
  }

  const n = ctx.normalized
  if (n) {
    if (n.isNonprofit === true || n.isBusiness === true) return 'org'
    const et = String(n.entityType ?? '').trim().toLowerCase()
    if (ORG_ENTITY_TYPES.has(et)) return 'org'
    if (PERSON_ENTITY_TYPES.has(et)) return 'person'
  }
  return 'unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// The canonical fact registry.
//
// Each fact:
//   canonical  — schema-preferred home ("section.field"); WRITES should target
//                this; question surfaces deep-link here.
//   aliases    — every other place the fact is known to live in real data.
//   applies_to — 'person' | 'org' | 'both'.
//   answeredBy(ctx) — true when the fact is present ANYWHERE (sections read
//                canonical + aliases; derived signals/normalized views are
//                consulted so imported/free-text facts count too).
// ─────────────────────────────────────────────────────────────────────────────

function anyAnswered(ctx, specs) {
  for (const [sectionKey, ...fields] of specs) {
    const data = sectionData(ctx.sections, sectionKey)
    for (const f of fields) {
      if (answeredValue(data[f])) return true
    }
  }
  return false
}

function profileRowAnswered(ctx, ...fields) {
  const p = ctx.profile
  if (!p || typeof p !== 'object') return false
  return fields.some((f) => answeredValue(p[f]))
}

export const CANONICAL_FACTS = Object.freeze({
  // ── person demographics ────────────────────────────────────────────────────
  gender: {
    canonical: 'basic_information.gender',
    aliases: ['demographics.gender'],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['basic_information', 'gender'],
        ['demographics', 'gender'],
      ]) ||
      setHasAny(ctx.signals?.genders) ||
      answeredValue(ctx.normalized?.gender),
  },

  age: {
    canonical: 'basic_information.date_of_birth',
    aliases: ['basic_information.age', 'demographics.age', 'demographics.age_group', 'demographics.date_of_birth'],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['basic_information', 'date_of_birth', 'age'],
        ['demographics', 'date_of_birth', 'age', 'age_group'],
      ]) ||
      (finiteNum(ctx.normalized?.age) && Number(ctx.normalized?.age) > 0) ||
      answeredValue(ctx.normalized?.ageGroup) ||
      setHasAny(ctx.signals?.demographics, 'youth', 'young_adult', 'senior'),
  },

  ethnicity: {
    canonical: 'demographics.ethnicity',
    aliases: [
      'demographics.race',
      'demographics.african_american', 'demographics.hispanic_latino', 'demographics.asian_american',
      'demographics.native_american', 'demographics.white_caucasian',
    ],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['demographics', 'ethnicity', 'race', 'african_american', 'hispanic_latino',
          'asian_american', 'native_american', 'white_caucasian'],
      ]) ||
      answeredValue(ctx.normalized?.ethnicityBucket) ||
      setHasAny(ctx.signals?.demographics, 'african_american', 'hispanic_latino', 'asian_american',
        'native_american', 'white_caucasian'),
  },

  // religion / faith affiliation — an org can be faith-based too, so 'both'.
  faith_affiliation: {
    canonical: 'demographics.religious_affiliation',
    aliases: [
      'demographics.religious_denomination', 'demographics.religion', 'basic_information.religion',
      'organization_details.is_faith_based',
    ],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['demographics', 'religious_affiliation', 'religious_denomination', 'religion'],
        ['basic_information', 'religion'],
        ['organization_details', 'is_faith_based', 'faith_based'],
        ['occupation', 'clergy', 'missionary'],
      ]) ||
      ['church', 'ministry'].includes(String(declaredType(ctx) ?? '').toLowerCase()) ||
      ctx.normalized?.isFaithBased === true ||
      ctx.normalized?.hasFaithIndicator === true ||
      setHasAny(ctx.normalized?.affiliations, 'faith_based', 'church') ||
      (ctx.signals?.keywordSet instanceof Set && ctx.signals.keywordSet.has('faith_based')),
  },

  veteran: {
    canonical: 'military_service.veteran',
    aliases: [
      'demographics.veteran_status', 'family.veteran_status',
      'military_service.active_duty_military', 'military_service.disabled_veteran',
      'military_service.military_spouse', 'military_service.military_branch',
    ],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['military_service', 'veteran', 'active_duty_military', 'national_guard',
          'disabled_veteran', 'military_spouse', 'military_dependent', 'gold_star_family', 'military_branch'],
        ['demographics', 'veteran_status'],
        ['family', 'veteran_status'],
      ]) ||
      ctx.normalized?.isVeteran === true ||
      setHasAny(ctx.signals?.military) ||
      String(declaredType(ctx) ?? '').toLowerCase() === 'veteran',
  },

  disability: {
    canonical: 'demographics.disability_status',
    aliases: [
      'health_medical.disability_type', 'family.disability_status', 'demographics.disability',
      'health_medical.chronic_illness', 'health_medical.conditions',
    ],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['demographics', 'disability_status', 'disability'],
        ['family', 'disability_status'],
        ['health_medical', 'disability_type', 'chronic_illness', 'chronic_illness_type', 'conditions',
          'wheelchair_user', 'visual_impairment', 'hearing_impairment'],
        ['medical_history', 'primary_condition'],
      ]) ||
      ctx.normalized?.hasDisabilityNeed === true ||
      ctx.normalized?.hasChronicIllness === true ||
      setHasAny(ctx.signals?.health) ||
      ['disabled_adult', 'medical_need'].includes(String(declaredType(ctx) ?? '').toLowerCase()),
  },

  household_income: {
    canonical: 'financial_information.household_income',
    aliases: [
      'financial.household_income', 'financial_information.annual_income',
      'financial_information.income_range', 'employment.income_range',
      'financial_information.low_income', 'financial_information.below_poverty_line',
      'financial_information.financial_need_level',
    ],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['financial_information', 'household_income', 'annual_income', 'income_range',
          'low_income', 'below_poverty_line', 'financial_need_level'],
        ['financial', 'household_income', 'annual_income'],
        ['employment', 'income_range'],
      ]) ||
      finiteNum(ctx.signals?.financial?.householdIncome) ||
      ctx.normalized?.financial?.belowPovertyLine === true ||
      (Array.isArray(ctx.normalized?.assistanceFlags) && ctx.normalized.assistanceFlags.length > 0) ||
      (Array.isArray(ctx.normalized?.enrolledPrograms) && ctx.normalized.enrolledPrograms.length > 0),
  },

  household_size: {
    canonical: 'financial_information.household_size',
    aliases: ['family.household_size'],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['financial_information', 'household_size'],
        ['family', 'household_size'],
      ]) || finiteNum(ctx.signals?.financial?.householdSize),
  },

  student: {
    canonical: 'education.highest_level',
    aliases: [
      'education.is_student', 'education.enrollment_status', 'education.current_institution',
      'education.school_type', 'education.fafsa_completed', 'education.fafsa_status',
      'education.pell_grant_eligible', 'education.pell_eligible',
    ],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['education', 'is_student', 'highest_level', 'enrollment_status', 'current_institution',
          'school_type', 'fafsa_completed', 'fafsa_status', 'pell_grant_eligible', 'pell_eligible'],
      ]) ||
      ctx.normalized?.isStudent === true ||
      isStudentProfileType(declaredType(ctx)) ||
      setHasAny(ctx.normalized?.effectiveFacets, 'student'),
  },

  caregiver: {
    canonical: 'family_life.caregiver',
    aliases: ['family_life.family_caregiver', 'family.caregiver', 'family.is_caregiver', 'family.responsibilities'],
    applies_to: 'person',
    answeredBy: (ctx) => {
      const familyResp = String(sectionData(ctx.sections, 'family').responsibilities ?? '')
      return (
        anyAnswered(ctx, [
          ['family_life', 'caregiver', 'family_caregiver', 'foster_parent', 'grandparent_raising_grandchildren'],
          ['family', 'caregiver', 'is_caregiver'],
        ]) ||
        /caregiv/i.test(familyResp) ||
        ctx.normalized?.isCaregiver === true ||
        setHasAny(ctx.signals?.family, 'caregiver', 'foster_parent', 'grandparent_raising_grandchildren')
      )
    },
  },

  dv_survivor: {
    canonical: 'family_life.domestic_violence_survivor',
    aliases: [],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [['family_life', 'domestic_violence_survivor', 'trafficking_survivor']]) ||
      ctx.normalized?.isDvSurvivor === true ||
      setHasAny(ctx.signals?.family, 'domestic_violence_survivor'),
  },

  immigration: {
    canonical: 'demographics.immigration_status',
    aliases: ['demographics.immigrant_status', 'demographics.citizenship', 'demographics.us_citizen', 'basic_information.nationality'],
    applies_to: 'person',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['demographics', 'immigration_status', 'immigrant_status', 'citizenship', 'us_citizen'],
        ['basic_information', 'nationality'],
      ]) ||
      setHasAny(ctx.signals?.immigration) ||
      setHasAny(ctx.signals?.demographics, 'us_citizen'),
  },

  tribal_affiliation: {
    canonical: 'demographics.tribal_affiliation',
    aliases: ['demographics.native_american', 'organization_details.is_tribal_government'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['demographics', 'tribal_affiliation', 'native_american'],
        ['organization_details', 'is_tribal_government'],
      ]) ||
      String(declaredType(ctx) ?? '').toLowerCase() === 'tribal_government' ||
      setHasAny(ctx.normalized?.affiliations, 'tribal') ||
      setHasAny(ctx.normalized?.demographics, 'native_american', 'tribal_affiliation'),
  },

  agricultural_producer: {
    canonical: 'occupation.farmer',
    aliases: [],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [['occupation', 'farmer']]) ||
      ctx.normalized?.isFarmer === true ||
      String(ctx.normalized?.entityType ?? '').toLowerCase() === 'farm' ||
      (Array.isArray(ctx.normalized?.needCategories) && ctx.normalized.needCategories.includes('agriculture')),
  },

  // ── shared identity / location / intent facts ─────────────────────────────
  applicant_type: {
    canonical: 'profiles.primary_type',
    aliases: ['basic_information.profile_category', 'basic_information.applicant_kind'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      profileRowAnswered(ctx, 'applicant_type', 'primary_type', 'primary_profile_type') ||
      anyAnswered(ctx, [['basic_information', 'profile_category', 'applicant_kind']]),
  },

  state: {
    canonical: 'basic_information.state',
    aliases: ['location_focus.state', 'location_focus.focus_state'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['basic_information', 'state'],
        ['location_focus', 'state', 'focus_state'],
      ]) ||
      profileRowAnswered(ctx, 'state') ||
      answeredValue(ctx.signals?.location?.state),
  },

  city: {
    canonical: 'basic_information.city',
    aliases: ['location_focus.city'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['basic_information', 'city'],
        ['location_focus', 'city'],
      ]) ||
      profileRowAnswered(ctx, 'city') ||
      answeredValue(ctx.signals?.location?.city),
  },

  zip: {
    canonical: 'basic_information.zip',
    aliases: ['basic_information.zip_code', 'location_focus.zip', 'location_focus.zip_code'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['basic_information', 'zip', 'zip_code'],
        ['location_focus', 'zip', 'zip_code'],
      ]) ||
      profileRowAnswered(ctx, 'zip', 'zip_code', 'postal_code') ||
      answeredValue(ctx.signals?.location?.zip),
  },

  // composite "where are you" fact used by prompts/readiness/answer_next
  state_zip: {
    canonical: 'basic_information.state',
    aliases: ['basic_information.zip'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      CANONICAL_FACTS.state.answeredBy(ctx) || CANONICAL_FACTS.zip.answeredBy(ctx),
  },

  primary_need: {
    canonical: 'programs_services.focus_areas',
    aliases: [
      'programs_services.keywords', 'programs_services.interests', 'funding_needs.need_categories',
      'narrative.primary_goal', 'narrative.mission', 'narrative.target_population',
      'profiles.keywords', 'profiles.interests', 'profiles.tags',
    ],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['programs_services', 'focus_areas', 'keywords', 'interests'],
        ['funding_needs', 'need_categories'],
        ['narrative', 'primary_goal', 'mission', 'target_population', 'summary'],
      ]) ||
      profileRowAnswered(ctx, 'keywords', 'interests', 'tags') ||
      setHasAny(ctx.signals?.needs) ||
      (Array.isArray(ctx.normalized?.needCategories) && ctx.normalized.needCategories.length > 0),
  },

  funding_amount: {
    canonical: 'narrative.funding_amount_needed',
    aliases: [
      'financial_information.funding_amount_needed', 'narrative.amount_requested', 'narrative.budget_total',
      'programs_services.amount_requested', 'small_business_details.requested_amount',
      'organization_details.annual_budget', 'comprehensive_application.funding_amount_needed',
    ],
    applies_to: 'both',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['narrative', 'funding_amount_needed', 'amount_requested', 'budget_total'],
        ['financial_information', 'funding_amount_needed'],
        ['financial', 'funding_amount_needed'],
        ['programs_services', 'amount_requested'],
        ['small_business_details', 'requested_amount'],
        ['organization_details', 'annual_budget'],
        ['comprehensive_application', 'funding_amount_needed'],
      ]) ||
      (Number(ctx.profile?.amount_requested) > 0) ||
      profileRowAnswered(ctx, 'funding_amount_needed'),
  },

  eligibility_traits: {
    canonical: 'demographics',
    aliases: ['financial_information', 'military_service', 'health_medical'],
    applies_to: 'both',
    answeredBy: (ctx) =>
      CANONICAL_FACTS.household_income.answeredBy(ctx) ||
      CANONICAL_FACTS.veteran.answeredBy(ctx) ||
      CANONICAL_FACTS.disability.answeredBy(ctx) ||
      CANONICAL_FACTS.ethnicity.answeredBy(ctx) ||
      CANONICAL_FACTS.immigration.answeredBy(ctx) ||
      anyAnswered(ctx, [
        ['demographics', 'lgbtq', 'minority_owned'],
        ['financial_information', 'annual_revenue'],
        ['organization_details', 'is_minority_serving', 'cert_mbe', 'cert_wbe', 'cert_8a', 'cert_sdvosb', 'cert_hubzone'],
        ['small_business_details', 'certifications'],
        // the exact clue fields the readiness category historically read
        ['programs_services', 'eligibility_notes'],
        ['narrative', 'eligibility_notes'],
        ['organization_details', 'constraints'],
        ['housing', 'housing_status', 'status'],
        ['education', 'school_type'],
        ['health_medical', 'health_status'],
      ]),
  },

  // ── organization facts ─────────────────────────────────────────────────────
  organization_type: {
    canonical: 'organization_details.organization_type',
    aliases: ['organization_details.entity_type', 'organization_details.legal_form', 'basic_information.organization_type', 'small_business_details.legal_form'],
    applies_to: 'org',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['organization_details', 'organization_type', 'entity_type', 'legal_form'],
        ['basic_information', 'organization_type'],
        ['small_business_details', 'legal_form'],
      ]) ||
      // A declared specific org type (church, nonprofit, municipality…) IS the answer.
      isOrganizationProfileType(declaredType(ctx)),
  },

  org_status: {
    // "registered org + tax identity" — answered only when BOTH a tax id and a
    // tax status are known (the field-prompt asks for whichever is missing, so
    // a partial answer must NOT suppress the prompt).
    canonical: 'nonprofit_compliance.is_501c3',
    aliases: [
      'organization_details.ein', 'organization_details.uei', 'nonprofit_compliance.ein', 'nonprofit_compliance.uei',
      'organization_details.is_501c3_public_charity', 'organization_details.is_501c3_private_foundation',
      'organization_details.tax_status', 'organization_details.tax_exempt_status',
      'nonprofit_compliance.tax_status', 'nonprofit_compliance.tax_exempt_status',
      'small_business_details.tax_classification',
    ],
    applies_to: 'org',
    answeredBy: (ctx) => {
      const hasTaxId = anyAnswered(ctx, [
        ['organization_details', 'ein', 'uei'],
        ['nonprofit_compliance', 'ein', 'uei'],
        ['basic_information', 'ein'],
      ])
      const hasTaxStatus = anyAnswered(ctx, [
        ['nonprofit_compliance', 'is_501c3', 'is_501c3_public_charity', 'is_501c3_private_foundation',
          'tax_exempt_status', 'tax_status', 'fiscal_sponsor'],
        ['organization_details', 'is_501c3', 'is_501c3_public_charity', 'is_501c3_private_foundation',
          'tax_exempt_status', 'tax_status'],
        ['small_business_details', 'tax_classification'],
      ])
      return hasTaxId && hasTaxStatus
    },
  },

  population_served: {
    canonical: 'organization_details.population_served',
    aliases: ['narrative.target_population'],
    applies_to: 'org',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['organization_details', 'population_served'],
        ['narrative', 'target_population'],
      ]) || answeredValue(ctx.normalized?.populationServed),
  },

  mission_focus: {
    canonical: 'organization_details.mission_focus',
    aliases: ['organization_details.mission', 'narrative.mission'],
    applies_to: 'org',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [
        ['organization_details', 'mission_focus', 'mission'],
        ['narrative', 'mission'],
      ]) || answeredValue(ctx.normalized?.missionFocus),
  },

  program_descriptions: {
    canonical: 'programs_services.program_descriptions',
    aliases: ['programs_services.description', 'programs_services.notes'],
    applies_to: 'org',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [['programs_services', 'program_descriptions', 'description']]) ||
      (Array.isArray(ctx.normalized?.programDescriptions) && ctx.normalized.programDescriptions.length > 0),
  },

  cdc_certification: {
    canonical: 'organization_details.cdc_certified',
    aliases: [],
    applies_to: 'org',
    answeredBy: (ctx) =>
      anyAnswered(ctx, [['organization_details', 'cdc_certified', 'is_community_action_agency', 'is_cdfi']]) ||
      /community development/i.test(
        `${ctx.normalized?.missionFocus ?? ''} ${ctx.normalized?.organizationType ?? ''}`,
      ),
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Question-field → fact aliasing. Every field id any surface can emit maps to
// exactly one fact above. Missing entries FAIL OPEN (question is asked).
// Keys cover: matchEngine.evaluateEligibility missingFields, coverageEvidence
// canonical fields, profileFieldPrompts fields, readiness category keys,
// profileGapInterview FACET/GAP ids, and profileCoverage FIELD_DEFS keys.
// ─────────────────────────────────────────────────────────────────────────────
export const QUESTION_FIELD_TO_FACT = Object.freeze({
  // person demographics
  gender: 'gender',
  age: 'age',
  is_senior: 'age',
  date_of_birth: 'age',
  ethnicity: 'ethnicity',
  race: 'ethnicity',
  faith_based_affiliation: 'faith_affiliation',
  religion: 'faith_affiliation',
  religious_affiliation: 'faith_affiliation',
  veteran: 'veteran',
  is_veteran: 'veteran',
  veteran_status: 'veteran',
  disability: 'disability',
  has_disability: 'disability',
  disability_status: 'disability',
  disability_or_medical_need_for_equipment: 'disability',
  income_eligibility: 'household_income',
  household_income: 'household_income',
  household_size: 'household_size',
  student_aid: 'student',
  student_status: 'student',
  is_student: 'student',
  caregiver_status: 'caregiver',
  is_caregiver: 'caregiver',
  dv_survivor_status: 'dv_survivor',
  immigration_status: 'immigration',
  immigrant_status: 'immigration',
  tribal_affiliation: 'tribal_affiliation',
  agricultural_producer_status: 'agricultural_producer',

  // identity / location / intent
  applicant_type: 'applicant_type',
  identity: 'applicant_type',
  entity_type: 'applicant_type',
  entityType: 'applicant_type',
  is_organization: 'applicant_type',
  who: 'applicant_type',
  state: 'state',
  city: 'city',
  zip: 'zip',
  state_zip: 'state_zip',
  location: 'state_zip',
  profile_location: 'state_zip',
  primary_need: 'primary_need',
  funding_needs: 'primary_need',
  needs: 'primary_need',
  needCategories: 'primary_need',
  funding_amount: 'funding_amount',
  amount: 'funding_amount',
  fundingAmountNeeded: 'funding_amount',
  funding_amount_needed: 'funding_amount',
  eligibility_traits: 'eligibility_traits',
  eligibility: 'eligibility_traits',

  // organization
  org_status: 'org_status',
  nonprofit_status: 'org_status',
  business_or_self_employment: 'org_status',
  org_type: 'organization_type',
  organizationType: 'organization_type',
  organization_type: 'organization_type',
  population: 'population_served',
  populationServed: 'population_served',
  population_served: 'population_served',
  mission: 'mission_focus',
  missionFocus: 'mission_focus',
  mission_focus: 'mission_focus',
  programs: 'program_descriptions',
  programDescriptions: 'program_descriptions',
  program_descriptions: 'program_descriptions',
  cdc_certification: 'cdc_certification',
})

export function factForQuestionField(fieldOrFactId) {
  const key = String(fieldOrFactId ?? '').trim()
  if (!key) return null
  const factId = QUESTION_FIELD_TO_FACT[key] ?? (CANONICAL_FACTS[key] ? key : null)
  return factId ? { id: factId, ...CANONICAL_FACTS[factId] } : null
}

/**
 * Is this fact already present in the profile (any canonical/alias location,
 * any derived view)? Unknown fields → false (never claim knowledge we can't
 * verify).
 */
export function profileAlreadyAnswers(fieldOrFactId, rawCtx) {
  const fact = factForQuestionField(fieldOrFactId)
  if (!fact) return false
  const ctx = normalizeCtx(rawCtx)
  try {
    return fact.answeredBy(ctx) === true
  } catch {
    return false // fail open — a predicate error must never hide a question
  }
}

/**
 * Does this question even apply to this profile's side of the org/person
 * matrix? Unknown fields or an undecidable profile side → true (ask).
 */
export function questionAppliesToProfile(fieldOrFactId, rawCtx) {
  const fact = factForQuestionField(fieldOrFactId)
  if (!fact || fact.applies_to === 'both') return true
  const side = resolveProfileSide(rawCtx)
  if (side === 'unknown') return true
  return fact.applies_to === side
}

/**
 * THE choke point every question surface must call before emitting a question:
 * ask only when the question applies to this profile type AND the profile does
 * not already contain the answer.
 */
export function shouldAskProfileQuestion(fieldOrFactId, rawCtx) {
  return questionAppliesToProfile(fieldOrFactId, rawCtx) && !profileAlreadyAnswers(fieldOrFactId, rawCtx)
}

export default {
  CANONICAL_FACTS,
  QUESTION_FIELD_TO_FACT,
  factForQuestionField,
  profileAlreadyAnswers,
  questionAppliesToProfile,
  shouldAskProfileQuestion,
  resolveProfileSide,
}
