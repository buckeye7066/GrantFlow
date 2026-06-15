/**
 * anyaInterviewEngine.js
 *
 * Adaptive conversational onboarding driven by Anya. This is the SINGLE
 * entry funnel for new GrantFlow users — every answer here must round-trip
 * into a canonical profile shape that crawlers, the matching engine, and
 * Discover Grants already understand (mission goals 1-3, 5-7, 10).
 *
 * Architecture:
 *   - Each question is a self-contained node with `prompt`, `kind`,
 *     `options`, `help`, `validate(answer)`, `apply(state, answer)` (returns
 *     `{ answers, patch }`), and `next(state)` (returns the id of the next
 *     question, or `__complete__`).
 *   - `state.answers` keeps every raw answer keyed by question id so a user
 *     can step backwards and resume.
 *   - `state.patch` is the running materialised view of the profile we are
 *     about to create. It's organised by canonical section key so the
 *     completion handler can hand each section straight to
 *     `PUT /api/profiles/:id/sections/:sectionKey`.
 *
 * All canonical need ids in this file MUST resolve through
 * `backend/services/profileNormalizer.NEED_ALIAS_MAP`. A unit test asserts
 * this — keep the two in sync so matching never silently drops a signal.
 */

import { canonicalizeProfileTypeId } from '../../shared/profileTypeOptions.js'
import { normalizeNeedCategory } from './profileNormalizer.js'

export const INTERVIEW_VERSION = 1

// Lowercase keys are simpler when matching — every persona group below is
// tied to a specific branch in the tree.
const PERSONAL_TYPES = new Set([
  'individual', 'family', 'senior', 'veteran', 'disabled_adult', 'medical_need',
])
const STUDENT_TYPES = new Set([
  'student', 'high_school_student', 'college_student', 'graduate_student',
])
const BUSINESS_TYPES = new Set([
  'business', 'minority_owned_business', 'women_owned_business',
])
const ORG_MISSION_TYPES = new Set([
  'nonprofit', 'church', 'ministry', 'food_pantry', 'homeless_shelter',
  'animal_rescue', 'mental_health_nonprofit', 'community_center',
  'museum', 'reentry_program', 'substance_recovery_org',
])
const SCHOOL_TYPES = new Set([
  'public_school', 'school_district', 'classroom_teacher', 'pta_pto',
  'library', 'special_education_program', 'school_food_service',
  'school_transportation', 'teacher',
])
const GOV_TYPES = new Set([
  'county_government', 'municipality', 'public_agency', 'tribal_government',
  'public_health_department', 'local_housing_authority', 'parks_department',
  'regional_planning_agency', 'economic_development_agency',
])

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
export function makeInitialState() {
  return {
    version: INTERVIEW_VERSION,
    answers: {},
    patch: {
      primary_type: null,
      display_name: null,
      email: null,
      tags: [],
      sections: {
        basic_information: {},
        housing: {},
        employment: {},
        family: {},
        education: {},
        health_medical: {},
        organization_details: {},
        nonprofit_compliance: {},
        small_business_details: {},
        programs_services: { focus_areas: [], interests: [], keywords: [] },
        narrative: {},
        location_focus: {},
      },
    },
  }
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value))
}

function mergeSection(state, sectionKey, fields) {
  const next = clone(state)
  next.patch.sections[sectionKey] = {
    ...(next.patch.sections[sectionKey] ?? {}),
    ...fields,
  }
  return next
}

function appendToList(state, sectionKey, fieldName, values) {
  const next = clone(state)
  const section = next.patch.sections[sectionKey] ?? {}
  const existing = Array.isArray(section[fieldName]) ? section[fieldName] : []
  const set = new Set(existing)
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') set.add(value)
  }
  section[fieldName] = Array.from(set)
  next.patch.sections[sectionKey] = section
  return next
}

function appendTags(state, values) {
  const next = clone(state)
  const set = new Set(Array.isArray(next.patch.tags) ? next.patch.tags : [])
  for (const value of values) {
    if (value !== null && value !== undefined && value !== '') set.add(value)
  }
  next.patch.tags = Array.from(set)
  return next
}

function setPrimaryType(state, rawType) {
  const next = clone(state)
  next.patch.primary_type = canonicalizeProfileTypeId(rawType) || rawType
  return next
}

function setEmail(state, email) {
  const trimmed = String(email ?? '').trim().toLowerCase()
  const next = clone(state)
  next.patch.email = trimmed
  next.patch.sections.basic_information = {
    ...(next.patch.sections.basic_information ?? {}),
    email: trimmed,
  }
  return next
}

function setDisplayName(state, name) {
  const trimmed = String(name ?? '').trim()
  const next = clone(state)
  next.patch.display_name = trimmed
  next.patch.sections.basic_information = {
    ...(next.patch.sections.basic_information ?? {}),
    full_name: trimmed,
  }
  return next
}

function setLocation(state, { zip, stateCode, city, county }) {
  const next = clone(state)
  const basic = { ...(next.patch.sections.basic_information ?? {}) }
  if (zip) basic.zip_code = String(zip).trim()
  if (stateCode) basic.state = String(stateCode).trim().toUpperCase()
  if (city) basic.city = String(city).trim()
  if (county) basic.county = String(county).trim()
  next.patch.sections.basic_information = basic
  return next
}

// ---------------------------------------------------------------------------
// Group classifiers — used by `next()` to branch
// ---------------------------------------------------------------------------
function personaGroup(state) {
  const t = state.patch.primary_type
  if (!t) return 'unknown'
  if (PERSONAL_TYPES.has(t)) return 'personal'
  if (STUDENT_TYPES.has(t)) return 'student'
  if (BUSINESS_TYPES.has(t)) return 'business'
  if (ORG_MISSION_TYPES.has(t)) return 'org_mission'
  if (SCHOOL_TYPES.has(t)) return 'school'
  if (GOV_TYPES.has(t)) return 'gov'
  if (t === 'volunteer_fire_department') return 'vfd'
  if (t === 'other') return 'personal' // fall back to personal needs flow
  return 'personal'
}

// ---------------------------------------------------------------------------
// Question definitions
// ---------------------------------------------------------------------------
export const QUESTIONS = Object.freeze({
  // -------------------------------------------------------------------------
  intro: {
    id: 'intro',
    kind: 'announce',
    prompt:
      "Hi — I'm Anya. I help you find real funding that fits who you actually are. " +
      "Grants, benefits, scholarships, programs — whatever's out there for your situation. " +
      "I'll ask a handful of quick questions (about 2 minutes), then I'll start looking. " +
      "Sound good?",
    cta: "Yes, let's start",
    apply: (state) => state,
    next: () => 'who',
  },

  // -------------------------------------------------------------------------
  who: {
    id: 'who',
    kind: 'choice',
    prompt: "First — who am I helping today?",
    help: "Pick the closest match. We'll narrow it down on the next screen.",
    options: [
      { value: 'personal_group',  label: 'Myself or my family' },
      { value: 'student',         label: 'A student' },
      { value: 'business',        label: 'A small business' },
      { value: 'org_mission',     label: 'A nonprofit, church, or ministry' },
      { value: 'school',          label: 'A school, classroom, or library' },
      { value: 'volunteer_fire_department', label: 'A volunteer fire / EMS dept' },
      { value: 'gov',             label: 'A city, county, or public agency' },
      { value: 'other',           label: "Something else" },
    ],
    apply: (state, answer) => {
      const provisional = {
        personal_group: 'individual',
        student: 'student',
        business: 'business',
        org_mission: 'nonprofit',
        school: 'public_school',
        volunteer_fire_department: 'volunteer_fire_department',
        gov: 'public_agency',
        other: 'other',
      }[answer] ?? 'other'
      let next = setPrimaryType(state, provisional)
      next.answers = { ...next.answers, who: answer }
      return next
    },
    next: () => 'location',
  },

  // -------------------------------------------------------------------------
  location: {
    id: 'location',
    kind: 'location',
    prompt:
      "Where are you (or the org/school/department) located? " +
      "Even just a ZIP and state helps me find local programs first.",
    help: "City and county are optional — they help me match neighborhood-level funding.",
    fields: [
      { name: 'zip',   label: 'ZIP code',  required: true,  format: 'zip' },
      { name: 'state', label: 'State',     required: true,  format: 'state' },
      { name: 'city',  label: 'City',      required: false, format: 'text' },
      { name: 'county', label: 'County',   required: false, format: 'text' },
    ],
    validate: (answer) => {
      if (!answer || typeof answer !== 'object') return 'Tell me where you are.'
      const zip = String(answer.zip ?? '').trim()
      const stateCode = String(answer.state ?? '').trim().toUpperCase()
      if (!/^\d{5}(-\d{4})?$/.test(zip)) return 'ZIP needs to be 5 digits (or ZIP+4).'
      if (!/^[A-Z]{2}$/.test(stateCode)) return 'State should be a 2-letter code, like TN or CA.'
      return null
    },
    apply: (state, answer) => {
      let next = setLocation(state, {
        zip: answer.zip,
        stateCode: answer.state,
        city: answer.city,
        county: answer.county,
      })
      // Also stash a focus_state so the matching engine can geo-rank.
      next = mergeSection(next, 'location_focus', {
        focus_state: String(answer.state ?? '').trim().toUpperCase(),
        focus_county: answer.county ? String(answer.county).trim() : undefined,
      })
      next.answers = { ...next.answers, location: answer }
      return next
    },
    next: (state) => {
      const group = personaGroup(state)
      switch (group) {
        case 'personal': return 'personal_subtype'
        case 'student':  return 'student_level'
        case 'business': return 'business_subtype'
        case 'org_mission': return 'org_subtype'
        case 'school':   return 'school_subtype'
        case 'gov':      return 'gov_subtype'
        case 'vfd':      return 'vfd_focus'
        default:         return 'personal_subtype'
      }
    },
  },

  // -------------------------------------------------------------------------
  // Personal branch
  // -------------------------------------------------------------------------
  personal_subtype: {
    id: 'personal_subtype',
    kind: 'choice',
    prompt: "Which best describes you?",
    options: [
      { value: 'individual',     label: "Just me (single adult)" },
      { value: 'family',         label: "My family / household" },
      { value: 'senior',         label: "Older adult (60+)" },
      { value: 'veteran',        label: "Veteran or military family" },
      { value: 'disabled_adult', label: "Adult with a disability" },
      { value: 'medical_need',   label: "Someone with a medical / health need" },
    ],
    apply: (state, answer) => {
      const next = setPrimaryType(state, answer)
      next.answers = { ...next.answers, personal_subtype: answer }
      return next
    },
    next: () => 'needs_personal',
  },

  needs_personal: {
    id: 'needs_personal',
    kind: 'multi_choice',
    prompt:
      "What kinds of help would actually matter to you right now? " +
      "Pick everything that applies — I'll keep all of these in mind.",
    help: "If you're not sure, pick a few that come closest. You can always add more later.",
    options: [
      { value: 'housing',          label: "Rent, mortgage, or housing repair" },
      { value: 'utilities',        label: "Utility bills (electric, gas, water, internet)" },
      { value: 'food',             label: "Food / groceries" },
      { value: 'health_medical',   label: "Medical bills, prescriptions, or health care" },
      { value: 'family_life',      label: "Childcare, caregiving, or family support" },
      { value: 'employment',       label: "Job training, employment, or workforce help" },
      { value: 'education',        label: "Education, tuition, or scholarships" },
      { value: 'transportation',   label: "Transportation or vehicle help" },
      { value: 'disability',       label: "Disability or adaptive equipment" },
      { value: 'cash_assistance',  label: "Cash assistance or income support" },
      { value: 'emergency',        label: "Emergency / crisis assistance" },
      { value: 'legal',            label: "Legal help" },
      { value: 'technology_equipment', label: "A device, computer, or internet access" },
      { value: 'clothing_goods',   label: "Clothing, furniture, or household goods" },
    ],
    validate: (answer) => {
      if (!Array.isArray(answer) || answer.length === 0) {
        return "Pick at least one — even 'I'm not sure' is fine."
      }
      return null
    },
    apply: (state, answer) => {
      const canonical = answer
        .map(normalizeNeedCategory)
        .filter(Boolean)
      let next = appendTags(state, canonical)
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', canonical)
      // Surface housing intent on the housing section so the matching engine
      // can read it directly without re-reading tags.
      if (canonical.includes('housing')) {
        next = mergeSection(next, 'housing', { status: 'at_risk' })
      }
      // Same for employment intent.
      if (canonical.includes('employment')) {
        next = mergeSection(next, 'employment', { current_status: 'unemployed_seeking' })
      }
      next.answers = { ...next.answers, needs_personal: answer }
      return next
    },
    next: () => 'situations',
  },

  situations: {
    id: 'situations',
    kind: 'multi_choice',
    prompt:
      "Anything going on right now I should know about? " +
      "These open up programs that aren't available to everyone.",
    help: "Totally optional. Skip if none apply.",
    optional: true,
    options: [
      { value: 'recently_laid_off',     label: "Recently laid off / unemployed" },
      { value: 'caregiver',             label: "Caring for a family member" },
      { value: 'disaster_survivor',     label: "Disaster survivor (fire, flood, storm)" },
      { value: 'chronic_illness',       label: "Living with a chronic illness" },
      { value: 'experiencing_homelessness', label: "Currently without stable housing" },
      { value: 'recently_released',     label: "Recently released (reentry / second chance)" },
      { value: 'in_recovery',           label: "In recovery from substance use" },
      { value: 'foster_alumni',         label: "Foster care alumni" },
      { value: 'refugee_immigrant',     label: "Refugee, asylee, or new immigrant" },
      { value: 'domestic_violence',     label: "Survivor of domestic violence" },
      { value: 'on_strike',             label: "On strike or locked out" },
    ],
    apply: (state, answer) => {
      const list = Array.isArray(answer) ? answer : []
      let next = appendTags(state, list)
      next = appendToList(next, 'programs_services', 'keywords', list)

      // Targeted section writes so the matching engine sees the signal even
      // without keyword scanning the tag bag.
      if (list.includes('recently_laid_off')) {
        next = mergeSection(next, 'employment', { current_status: 'unemployed_seeking' })
      }
      if (list.includes('experiencing_homelessness')) {
        next = mergeSection(next, 'housing', { status: 'homeless' })
      }
      if (list.includes('chronic_illness') || list.includes('in_recovery')) {
        next = mergeSection(next, 'health_medical', { has_active_need: true })
      }
      if (list.includes('caregiver')) {
        next = mergeSection(next, 'family', { responsibilities: 'caregiver' })
      }

      next.answers = { ...next.answers, situations: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // Student branch
  // -------------------------------------------------------------------------
  student_level: {
    id: 'student_level',
    kind: 'choice',
    prompt: "What level of student?",
    options: [
      { value: 'high_school_student', label: "High school (grades 9-12)" },
      { value: 'college_student',     label: "College / undergraduate" },
      { value: 'graduate_student',    label: "Graduate school" },
      { value: 'student',             label: "Trade / vocational / other" },
    ],
    apply: (state, answer) => {
      let next = setPrimaryType(state, answer)
      next = mergeSection(next, 'education', {
        highest_level:
          answer === 'high_school_student' ? 'in_high_school'
            : answer === 'college_student' ? 'in_undergraduate'
              : answer === 'graduate_student' ? 'in_graduate'
                : 'in_training',
      })
      next.answers = { ...next.answers, student_level: answer }
      return next
    },
    next: () => 'student_focus',
  },

  student_focus: {
    id: 'student_focus',
    kind: 'multi_choice',
    prompt: "What are you most hoping funding can help with?",
    options: [
      { value: 'tuition',          label: "Tuition or fees" },
      { value: 'scholarship',      label: "Scholarships" },
      { value: 'textbooks',        label: "Books and supplies" },
      { value: 'housing',          label: "Housing / dorm / rent" },
      { value: 'food',             label: "Food / meal plan" },
      { value: 'technology_equipment', label: "Laptop or technology" },
      { value: 'cash_assistance',  label: "Living expenses" },
      { value: 'research',         label: "Research / fellowship funding" },
      { value: 'emergency',        label: "Emergency student aid" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, canonical)
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', canonical)
      next = appendTags(next, ['education'])
      next.answers = { ...next.answers, student_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // Business branch
  // -------------------------------------------------------------------------
  business_subtype: {
    id: 'business_subtype',
    kind: 'choice',
    prompt: "What kind of business?",
    options: [
      { value: 'business',                label: "Small business" },
      { value: 'minority_owned_business', label: "Minority-owned business" },
      { value: 'women_owned_business',    label: "Women-owned business" },
    ],
    apply: (state, answer) => {
      const next = setPrimaryType(state, answer)
      next.answers = { ...next.answers, business_subtype: answer }
      return next
    },
    next: () => 'business_focus',
  },

  business_focus: {
    id: 'business_focus',
    kind: 'multi_choice',
    prompt: "What's the funding for? Pick everything that applies.",
    options: [
      { value: 'startup',       label: "Startup capital" },
      { value: 'equipment',     label: "Equipment or facility" },
      { value: 'employment',    label: "Hiring or workforce training" },
      { value: 'inventory',     label: "Inventory or working capital" },
      { value: 'research',      label: "Innovation, R&D, or new products" },
      { value: 'emergency',     label: "Disaster recovery" },
      { value: 'business',      label: "General growth / just exploring" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, canonical)
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', canonical)
      next = mergeSection(next, 'small_business_details', { stage: 'unspecified' })
      next.answers = { ...next.answers, business_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // Mission organization branch
  // -------------------------------------------------------------------------
  org_subtype: {
    id: 'org_subtype',
    kind: 'choice',
    prompt: "What kind of organization?",
    options: [
      { value: 'nonprofit',         label: "Nonprofit (501c3)" },
      { value: 'church',            label: "Church or congregation" },
      { value: 'ministry',          label: "Ministry / outreach program" },
      { value: 'food_pantry',       label: "Food pantry / food bank" },
      { value: 'homeless_shelter',  label: "Homeless shelter / housing program" },
      { value: 'animal_rescue',     label: "Animal rescue / welfare" },
      { value: 'mental_health_nonprofit', label: "Mental health nonprofit" },
      { value: 'community_center',  label: "Community center" },
      { value: 'museum',            label: "Museum / arts / cultural org" },
    ],
    apply: (state, answer) => {
      let next = setPrimaryType(state, answer)
      next = mergeSection(next, 'organization_details', {
        entity_type: answer,
      })
      next.answers = { ...next.answers, org_subtype: answer }
      return next
    },
    next: () => 'org_compliance',
  },

  org_compliance: {
    id: 'org_compliance',
    kind: 'choice',
    prompt: "Quick compliance check — is the organization a registered 501(c)(3)?",
    help: "If you're a fiscally sponsored project, pick 'fiscal sponsor'. " +
          "We'll still find programs you can apply to.",
    options: [
      { value: 'yes',           label: "Yes, registered 501(c)(3)" },
      { value: 'fiscal_sponsor', label: "Fiscally sponsored" },
      { value: 'pending',       label: "Pending or in-process" },
      { value: 'no',            label: "No / not sure" },
    ],
    apply: (state, answer) => {
      const map = { yes: true, fiscal_sponsor: 'fiscal_sponsor', pending: 'pending', no: false }
      const next = mergeSection(state, 'nonprofit_compliance', {
        is_501c3: map[answer],
      })
      next.answers = { ...next.answers, org_compliance: answer }
      return next
    },
    next: () => 'org_focus',
  },

  org_focus: {
    id: 'org_focus',
    kind: 'multi_choice',
    prompt: "What's the funding for? Pick everything that applies.",
    options: [
      { value: 'program_funding',   label: "Program / project funding" },
      { value: 'capacity_building', label: "Capacity, operations, or staff" },
      { value: 'equipment',         label: "Equipment, vehicles, or supplies" },
      { value: 'building',          label: "Building or facility" },
      { value: 'training',          label: "Staff training or development" },
      { value: 'research',          label: "Research or evaluation" },
      { value: 'emergency',         label: "Disaster recovery" },
      { value: 'food',              label: "Food / hunger relief" },
      { value: 'housing',           label: "Housing or shelter" },
      { value: 'health_medical',    label: "Health or behavioral health" },
      { value: 'family_life',       label: "Children, youth, or family" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, canonical)
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', canonical)
      next.answers = { ...next.answers, org_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // School branch
  // -------------------------------------------------------------------------
  school_subtype: {
    id: 'school_subtype',
    kind: 'choice',
    prompt: "Which best describes the school side?",
    options: [
      { value: 'public_school',     label: "Single school" },
      { value: 'school_district',   label: "School district" },
      { value: 'classroom_teacher', label: "Classroom teacher (DonorsChoose-style)" },
      { value: 'pta_pto',           label: "PTA / PTO / parent group" },
      { value: 'library',           label: "Library" },
      { value: 'special_education_program', label: "Special education program" },
      { value: 'school_food_service', label: "School nutrition / food service" },
      { value: 'school_transportation', label: "School transportation" },
    ],
    apply: (state, answer) => {
      const next = setPrimaryType(state, answer)
      next.answers = { ...next.answers, school_subtype: answer }
      return next
    },
    next: () => 'school_focus',
  },

  school_focus: {
    id: 'school_focus',
    kind: 'multi_choice',
    prompt: "What's the funding for?",
    options: [
      { value: 'classroom_supplies', label: "Classroom supplies / materials" },
      { value: 'technology_equipment', label: "Technology / devices" },
      { value: 'special_education', label: "Special education programming" },
      { value: 'stem_curriculum',   label: "STEM or curriculum" },
      { value: 'arts',              label: "Arts, music, or extracurricular" },
      { value: 'building',          label: "Building or facility" },
      { value: 'food',              label: "Food service / school nutrition" },
      { value: 'transportation',    label: "Transportation / busing" },
      { value: 'safety',            label: "Safety or security" },
      { value: 'training',          label: "Teacher training / professional development" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, [...canonical, 'education'])
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', canonical)
      next.answers = { ...next.answers, school_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // VFD branch (no subtype — it's already specific)
  // -------------------------------------------------------------------------
  vfd_focus: {
    id: 'vfd_focus',
    kind: 'multi_choice',
    prompt: "What's the most pressing need?",
    options: [
      { value: 'apparatus',     label: "Fire / EMS apparatus or vehicle" },
      { value: 'ppe',           label: "PPE, SCBA, or turnout gear" },
      { value: 'communications', label: "Radios / communications equipment" },
      { value: 'training',      label: "Training (live fire, EMS, certifications)" },
      { value: 'building',      label: "Station building or facility" },
      { value: 'recruitment',   label: "Recruitment / retention" },
      { value: 'wildland',      label: "Wildland or rural fire equipment" },
      { value: 'medical_supplies', label: "Medical supplies / AEDs" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, [...canonical, 'public_safety', 'equipment'])
      next = appendToList(next, 'programs_services', 'focus_areas', ['public_safety', ...canonical])
      next = appendToList(next, 'programs_services', 'keywords', answer)
      next.answers = { ...next.answers, vfd_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // Local government branch
  // -------------------------------------------------------------------------
  gov_subtype: {
    id: 'gov_subtype',
    kind: 'choice',
    prompt: "Which best describes the agency?",
    options: [
      { value: 'municipality',         label: "City, town, or village" },
      { value: 'county_government',    label: "County government" },
      { value: 'public_health_department', label: "Public health department" },
      { value: 'tribal_government',    label: "Tribal government" },
      { value: 'local_housing_authority', label: "Public housing authority" },
      { value: 'parks_department',     label: "Parks & recreation" },
      { value: 'regional_planning_agency', label: "Regional planning agency / MPO" },
      { value: 'economic_development_agency', label: "Economic development agency" },
      { value: 'public_agency',        label: "Other public agency" },
    ],
    apply: (state, answer) => {
      const next = setPrimaryType(state, answer)
      next.answers = { ...next.answers, gov_subtype: answer }
      return next
    },
    next: () => 'gov_focus',
  },

  gov_focus: {
    id: 'gov_focus',
    kind: 'multi_choice',
    prompt: "What's the funding for?",
    options: [
      { value: 'infrastructure',  label: "Infrastructure (roads, bridges)" },
      { value: 'water',           label: "Water, sewer, or stormwater" },
      { value: 'public_safety',   label: "Public safety / first responders" },
      { value: 'parks_recreation', label: "Parks or recreation" },
      { value: 'broadband',       label: "Broadband / digital access" },
      { value: 'economic_development', label: "Economic development" },
      { value: 'emergency',       label: "Disaster recovery / hazard mitigation" },
      { value: 'housing',         label: "Affordable housing" },
      { value: 'health_medical',  label: "Public health programs" },
      { value: 'community_facilities', label: "Community facilities" },
    ],
    validate: (answer) => (Array.isArray(answer) && answer.length > 0)
      ? null
      : "Pick at least one.",
    apply: (state, answer) => {
      const canonical = answer.map(normalizeNeedCategory).filter(Boolean)
      let next = appendTags(state, [...canonical, 'public_sector'])
      next = appendToList(next, 'programs_services', 'focus_areas', canonical)
      next = appendToList(next, 'programs_services', 'keywords', answer)
      next.answers = { ...next.answers, gov_focus: answer }
      return next
    },
    next: () => 'narrative',
  },

  // -------------------------------------------------------------------------
  // Final shared steps: narrative → name → email → COMPLETE
  // -------------------------------------------------------------------------
  narrative: {
    id: 'narrative',
    kind: 'long_text',
    prompt:
      "In your own words — what's going on, or what are you hoping funding will help with? " +
      "Even a sentence or two helps me match what's actually relevant.",
    help: "Optional, but real words from you give me the most to work with.",
    optional: true,
    placeholder: "e.g. 'Our church wants to start a weekly food pantry but we need a freezer and shelving.'",
    apply: (state, answer) => {
      const trimmed = String(answer ?? '').trim()
      let next = state
      if (trimmed) {
        next = mergeSection(state, 'narrative', { summary: trimmed })
      }
      next.answers = { ...next.answers, narrative: trimmed }
      return next
    },
    next: () => 'name',
  },

  name: {
    id: 'name',
    kind: 'text',
    prompt: "What should I call this profile?",
    help: "This is just a label so you can find it later — your real name, your org name, or anything that makes sense.",
    placeholder: "e.g. 'Jordan Smith' or 'Hope Community Church'",
    validate: (answer) => {
      const trimmed = String(answer ?? '').trim()
      if (!trimmed) return 'Give me a name to call this profile.'
      if (trimmed.length > 200) return 'Keep it under 200 characters.'
      return null
    },
    apply: (state, answer) => {
      const next = setDisplayName(state, answer)
      next.answers = { ...next.answers, name: String(answer ?? '').trim() }
      return next
    },
    next: () => 'email',
  },

  email: {
    id: 'email',
    kind: 'email',
    prompt:
      "Last thing — what's the best email to send your matches to? " +
      "I'll send a quick sign-in code there so we can save your work.",
    help: "I never share or sell your email. It's only used for sign-in and your funding alerts.",
    placeholder: "you@example.com",
    validate: (answer) => {
      const trimmed = String(answer ?? '').trim().toLowerCase()
      if (!trimmed) return 'I need an email to set up your profile.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "That doesn't look like a valid email."
      return null
    },
    apply: (state, answer) => {
      const next = setEmail(state, answer)
      next.answers = { ...next.answers, email: String(answer ?? '').trim().toLowerCase() }
      return next
    },
    next: () => '__complete__',
  },
})

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const FIRST_QUESTION_ID = 'intro'
export const COMPLETION_TOKEN = '__complete__'

export function getQuestion(questionId) {
  return QUESTIONS[questionId] ?? null
}

export function getFirstQuestion() {
  return QUESTIONS[FIRST_QUESTION_ID]
}

/**
 * Apply an answer and return `{ state, nextQuestionId }`.
 * Throws on validation failure.
 */
export function applyAnswer(state, questionId, answer) {
  const question = QUESTIONS[questionId]
  if (!question) {
    throw Object.assign(new Error(`Unknown question: ${questionId}`), {
      code: 'UNKNOWN_QUESTION',
      statusCode: 400,
    })
  }
  if (typeof question.validate === 'function') {
    const err = question.validate(answer)
    if (err) {
      throw Object.assign(new Error(err), {
        code: 'INVALID_ANSWER',
        statusCode: 400,
      })
    }
  }
  const nextState = question.apply(state, answer)
  const nextQuestionId = question.next(nextState)
  return { state: nextState, nextQuestionId }
}

/**
 * Serialize a question for the wire (drops apply/next/validate fns).
 */
export function serializeQuestion(question) {
  if (!question) return null
  const {
    id, kind, prompt, help, options, fields, cta, optional, placeholder,
  } = question
  return {
    id,
    kind,
    prompt,
    help: help ?? null,
    options: options ?? null,
    fields: fields ?? null,
    cta: cta ?? null,
    optional: optional ?? false,
    placeholder: placeholder ?? null,
  }
}
