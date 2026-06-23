// Throwaway diagnostic: for each canonical profile primary_type, show the
// derived applicant_types and which crawler-os sources the planner selects.
// Surfaces any type that ends up with ZERO relatable funding sources (mission
// failure) or only directory pointers.
import { buildThesis } from '../backend/crawler-os/profileIntelligence.js'
import { plan } from '../backend/crawler-os/planner.js'
import { allSources } from '../backend/crawler-os/sourceRegistry.js'

const DIRECTORY_IDS = new Set(
  allSources().filter((s) => s.directory).map((s) => s.source_id),
)

// Canonical primary_type strings as stored on profiles.primary_type.
const TYPES = [
  'individual', 'family', 'medical_need', 'senior', 'veteran', 'disabled_adult',
  'student', 'high_school_student', 'college_student', 'graduate_student',
  'teacher', 'classroom_teacher', 'school_district', 'public_school',
  'special_education_program', 'pta_pto', 'library',
  'nonprofit', 'church', 'ministry', 'food_pantry', 'homeless_shelter',
  'animal_rescue', 'mental_health_nonprofit', 'community_center', 'museum',
  'volunteer_fire_department', 'county_government', 'municipality',
  'public_agency', 'local_housing_authority', 'parks_department',
  'tribal_government', 'public_health_department',
  'business', 'minority_owned_business', 'women_owned_business',
  // legacy strings still present in seed data:
  'organization', 'small_business',
]

let zeroCount = 0
let dirOnlyCount = 0
for (const t of TYPES) {
  const thesis = buildThesis({ profile_type: t, type: t })
  const p = plan(thesis)
  const sel = p.selected_source_ids
  const funders = sel.filter((id) => !DIRECTORY_IDS.has(id))
  const flag = sel.length === 0 ? '  <<< ZERO SOURCES'
    : funders.length === 0 ? '  <<< DIRECTORY-ONLY'
      : ''
  if (sel.length === 0) zeroCount += 1
  else if (funders.length === 0) dirOnlyCount += 1
  console.log(
    `${t.padEnd(28)} apps=[${thesis.applicant_types.join(',')}]`.padEnd(70) +
    ` -> [${sel.join(', ')}]${flag}`,
  )
}
console.log(`\nZERO-source types: ${zeroCount}   DIRECTORY-ONLY types: ${dirOnlyCount}`)
