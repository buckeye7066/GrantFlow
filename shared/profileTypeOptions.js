/**
 * profileTypeOptions.js
 *
 * Single source of truth for the **curated, user-facing** profile-type
 * picker. Imported by every frontend selector (Quick Add, Profile
 * Creation Wizard, Comprehensive Application, Organizations filter,
 * Anya onboarding chips, OrganizationProfile edit dialog) AND by the
 * backend route that surfaces profile types over /api/profile-types.
 *
 * The full canonical registry (with strategies, recommended sources,
 * required fields, aliases, etc.) lives in
 *   backend/services/profileTypeRegistry.js
 *
 * That registry has node-only dependencies (sourceRegistry imports a
 * full source catalog), so the frontend cannot import it directly.
 * This file is kept dependency-free — pure JS data — and is what every
 * UI surface uses to render its picker. A small mission test
 * (tests/unit/profile-type-options.test.mjs) asserts that every id
 * here resolves through the backend `resolveProfileType` so the two
 * sides cannot drift.
 *
 * Mission goal #4: "Support many kinds of users and needs."
 *   The curated list intentionally surfaces every persona we have a
 *   recommended source plan and strategy for, so a county
 *   government, classroom teacher, or volunteer fire chief never has
 *   to pick "Other".
 *
 * Mission goal #5: "Let the system evolve as new profile types
 * appear." Add new types here (and to profileTypeRegistry.js) — every
 * UI surface picks them up automatically.
 */

/**
 * The curated, user-facing list. Grouped so selectors can render a
 * sensible <optgroup> hierarchy. Order within a group is
 * approximately by frequency of use.
 *
 * `id` MUST be a canonical id from backend/services/profileTypeRegistry.js
 * `label` is the human-readable label shown in pickers
 * `group` controls UI grouping (People / Education / Mission / Public / Business)
 * `description` is a short helper (<=80 chars) shown beneath the option
 *   when the picker has room (Comprehensive Application card grid)
 */
export const PROFILE_TYPE_OPTIONS = Object.freeze([
  // People & households
  { id: 'individual',                     group: 'People',     label: 'Individual',                      description: 'Single adult seeking benefits, scholarships, or grants.' },
  { id: 'family',                         group: 'People',     label: 'Family',                          description: 'Household with children or dependents.' },
  { id: 'medical_need',                   group: 'People',     label: 'Medical / Healthcare Assistance',  description: 'Person or family with medical, disability, or caregiving needs.' },
  { id: 'homeschool_family',              group: 'People',     label: 'Homeschool Family',               description: 'Family educating children at home (curriculum, ESA, education funding).' },
  { id: 'senior',                         group: 'People',     label: 'Senior / Older Adult',            description: 'Adult 60+ seeking benefits, Medicare help, or senior programs.' },
  { id: 'veteran',                        group: 'People',     label: 'Veteran / Military Family',       description: 'Veteran or military family seeking benefits and support.' },
  { id: 'disabled_adult',                 group: 'People',     label: 'Adult with a Disability',         description: 'Person with a disability seeking benefits, services, or employment help.' },

  // Students
  { id: 'student',                        group: 'Education',  label: 'Student',                         description: 'Student of any level (will refine on the next step).' },
  { id: 'high_school_student',            group: 'Education',  label: 'High School Student',             description: 'Grades 9-12 seeking scholarships or college aid.' },
  { id: 'college_student',                group: 'Education',  label: 'College / Undergraduate Student', description: 'Undergraduate seeking scholarships, financial aid, or housing.' },
  { id: 'graduate_student',               group: 'Education',  label: 'Graduate Student',                description: 'Master\u2019s, PhD, or professional school student.' },
  { id: 'teacher',                        group: 'Education',  label: 'Teacher / Educator',              description: 'K-12, higher-ed, or community educator.' },
  { id: 'classroom_teacher',              group: 'Education',  label: 'Classroom Teacher',               description: 'PK-12 classroom teacher seeking classroom or program funding.' },
  { id: 'school_district',                group: 'Education',  label: 'School District',                 description: 'Public school district or LEA.' },
  { id: 'public_school',                  group: 'Education',  label: 'Public School',                   description: 'Single public school site (not the whole district).' },
  { id: 'special_education_program',      group: 'Education',  label: 'Special Education Program',       description: 'School special-education program seeking program or assistive-tech funding.' },
  { id: 'school_food_service',            group: 'Education',  label: 'School Nutrition / Food Service',  description: 'School meal or nutrition program seeking food-service funding.' },
  { id: 'school_transportation',          group: 'Education',  label: 'School Transportation',           description: 'School transportation/busing program seeking equipment or safety grants.' },
  { id: 'pta_pto',                        group: 'Education',  label: 'PTA / PTO / Parent Group',        description: 'Parent-teacher association or booster club funding classroom needs.' },
  { id: 'library',                        group: 'Education',  label: 'Library',                         description: 'Public, school, or tribal library.' },

  // Mission organizations
  { id: 'nonprofit',                      group: 'Mission',    label: 'Nonprofit Organization',          description: '501(c)(3) or other mission-driven nonprofit.' },
  { id: 'church',                         group: 'Mission',    label: 'Church / Faith Community',        description: 'Local church, parish, or congregation.' },
  { id: 'ministry',                       group: 'Mission',    label: 'Ministry',                        description: 'Faith-based ministry, evangelism, or outreach program.' },
  { id: 'food_pantry',                    group: 'Mission',    label: 'Food Pantry / Bank',              description: 'Food pantry, food bank, or feeding ministry.' },
  { id: 'homeless_shelter',               group: 'Mission',    label: 'Homeless Shelter / Housing',      description: 'Shelter, transitional housing, or street outreach.' },
  { id: 'animal_rescue',                  group: 'Mission',    label: 'Animal Rescue / Welfare',         description: 'Animal shelter, rescue, sanctuary, or welfare nonprofit.' },
  { id: 'mental_health_nonprofit',        group: 'Mission',    label: 'Mental Health Nonprofit',         description: 'Behavioral / mental-health nonprofit or clinic.' },
  { id: 'substance_recovery_org',         group: 'Mission',    label: 'Substance Recovery Org',          description: 'Addiction recovery, treatment, or harm-reduction nonprofit.' },
  { id: 'reentry_program',                group: 'Mission',    label: 'Reentry / Justice Program',       description: 'Reentry, second-chance, or justice-involved support nonprofit.' },
  { id: 'community_center',               group: 'Mission',    label: 'Community Center',                description: 'Neighborhood or community center serving local residents.' },
  { id: 'museum',                         group: 'Mission',    label: 'Museum / Cultural Org',           description: 'Museum, cultural institution, or arts nonprofit.' },

  // Public-sector / government
  { id: 'volunteer_fire_department',      group: 'Public',     label: 'Volunteer Fire / EMS',            description: 'Volunteer fire department, EMS squad, or rescue.' },
  { id: 'county_government',              group: 'Public',     label: 'County Government',               description: 'County office, board of commissioners, or county agency.' },
  { id: 'municipality',                   group: 'Public',     label: 'City / Town / Municipality',      description: 'City, town, village, or borough government.' },
  { id: 'public_agency',                  group: 'Public',     label: 'Public Agency',                   description: 'Other public-sector agency or authority.' },
  { id: 'local_housing_authority',        group: 'Public',     label: 'Public Housing Authority',        description: 'Local/regional public housing authority (CDBG, HUD programs).' },
  { id: 'parks_department',               group: 'Public',     label: 'Parks & Recreation Department',   description: 'Municipal or county parks, recreation, or trails department.' },
  { id: 'regional_planning_agency',       group: 'Public',     label: 'Regional Planning Agency',        description: 'MPO, council of governments, or regional planning body.' },
  { id: 'economic_development_agency',    group: 'Public',     label: 'Economic Development Agency',      description: 'County/regional economic development organization (EDA, CDBG).' },
  { id: 'tribal_government',              group: 'Public',     label: 'Tribal Government',               description: 'Federally recognized tribal government or tribal entity.' },
  { id: 'public_health_department',       group: 'Public',     label: 'Public Health Department',        description: 'Local, county, or state public health department.' },

  // Business
  { id: 'business',                       group: 'Business',   label: 'Small Business',                  description: 'For-profit small business or sole proprietorship.' },
  { id: 'minority_owned_business',        group: 'Business',   label: 'Minority-Owned Business',         description: 'Minority-owned for-profit business.' },
  { id: 'women_owned_business',           group: 'Business',   label: 'Women-Owned Business',            description: 'Women-owned for-profit business.' },

  // Catch-all
  { id: 'other',                          group: 'Other',      label: 'Other',                           description: 'None of these fit \u2014 we\u2019ll still match what we can.' },
])

/**
 * Aliases the UI / backend should canonicalize on save. Keys are the
 * legacy or shorthand strings users / older forms / older Anya chips
 * have submitted; values are the canonical id in PROFILE_TYPE_OPTIONS.
 *
 * Anything not in this map AND not a known canonical id is preserved
 * verbatim so we never silently lose data; the backend route
 * additionally runs through profileTypeRegistry.resolveProfileType()
 * which has its own (richer) alias index.
 */
export const PROFILE_TYPE_UI_ALIASES = Object.freeze({
  // Legacy "small_business" → canonical "business"
  small_business: 'business',
  smallbusiness: 'business',
  'small-business': 'business',
  // Generic "organization" historically meant "nonprofit-or-similar"
  organization: 'nonprofit',
  // Volunteer fire variants
  volunteer_fire: 'volunteer_fire_department',
  vfd: 'volunteer_fire_department',
  fire_department: 'volunteer_fire_department',
  ems: 'volunteer_fire_department',
  // School variants
  school: 'public_school',
  k12_school: 'public_school',
  // Government rollups
  government: 'public_agency',
  local_government: 'municipality',
  city: 'municipality',
  town: 'municipality',
  // Medical
  medical_assistance: 'medical_need',
  medical: 'medical_need',
  health_profile: 'medical_need',
  // Individual / household legacy values
  individual_need: 'individual',
  // Faith / clergy
  minister: 'ministry',
  clergy: 'ministry',
})

const CANONICAL_IDS = new Set(PROFILE_TYPE_OPTIONS.map((option) => option.id))

/**
 * Resolve a raw profile-type string (id, alias, or display label) to a
 * canonical id from the curated list. Returns the original string if
 * we don't recognise it — callers should preserve unknown values
 * rather than throwing them away (mission rule: don't lose data).
 */
export function canonicalizeProfileTypeId(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return null
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (!normalized) return null
  if (CANONICAL_IDS.has(normalized)) return normalized
  if (PROFILE_TYPE_UI_ALIASES[normalized]) return PROFILE_TYPE_UI_ALIASES[normalized]
  return raw
}

/**
 * Convenience: the curated list grouped by `group` for selectors that
 * want to render <optgroup>s.
 */
export function getGroupedProfileTypeOptions() {
  const groups = new Map()
  for (const option of PROFILE_TYPE_OPTIONS) {
    if (!groups.has(option.group)) groups.set(option.group, [])
    groups.get(option.group).push(option)
  }
  return Array.from(groups.entries()).map(([group, options]) => ({ group, options }))
}

/**
 * Read-only set of all canonical ids in the curated list. Useful for
 * tests and validation (e.g. ensuring sectionMetadata enum is a
 * superset).
 */
export function listCanonicalProfileTypeIds() {
  return Array.from(CANONICAL_IDS)
}

export default {
  PROFILE_TYPE_OPTIONS,
  PROFILE_TYPE_UI_ALIASES,
  canonicalizeProfileTypeId,
  getGroupedProfileTypeOptions,
  listCanonicalProfileTypeIds,
}
