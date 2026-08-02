// crawler-os/profileIntelligence.js
//
// Profile -> funding thesis. Uses the FULL profile (top-level fields, sections,
// linked org, location, needs, documents, school data) — not just a field or two
// — to derive what to search for and how to score. Supports every GrantFlow
// profile type: individuals, families, students, businesses, churches,
// ministries, nonprofits, schools, volunteer fire departments, government/
// community entities, and more.
//
// Pure, no I/O. Output is a plain mutable object (the pipeline attaches env).
// (geoRadius reads the static `zipcodes` dataset — deterministic, no I/O.)

import { nearbyCities } from './geoRadius.js';
import { containsTermWholeWord } from '../services/shared/textMatch.js';
// ONE registry of what DECLARES an agricultural producer, shared with the
// eligibility gate (services/applicantTypeGate.js). If the discovery lane and
// the gate disagreed about who is a farmer, a profile could be planned INTO the
// USDA lanes and then hard-dropped by the gate on the way back — static
// tripwire in backend/tests/farmIdentity.test.js.
import { FARM_OCCUPATION_FLAG_KEYS, isAgricultureNaics } from '../services/eligibility/farmIdentity.js';

const APPLICANT_TYPE_SYNONYMS = {
  individual: ['individual', 'person', 'resident'],
  family: ['family', 'household', 'parent', 'parents', 'caregiver', 'widow', 'widower', 'surviving spouse'],
  student: ['student', 'scholar', 'undergraduate', 'graduate', 'pupil'],
  teacher: ['teacher', 'educator', 'classroom teacher'],
  nonprofit: ['nonprofit', 'non-profit', '501c3', '501(c)(3)', 'charity', 'ngo'],
  church: ['church', 'congregation', 'parish'],
  ministry: ['ministry', 'minister', 'pastor', 'clergy', 'faith-based', 'religious'],
  school: ['school', 'district', 'k-12', 'education', 'university', 'college'],
  vfd: ['volunteer fire', 'fire department', 'vfd', 'first responder', 'ems'],
  law_enforcement: ['law enforcement', 'police', 'sheriff', 'border patrol', 'public safety'],
  business: ['business', 'company', 'llc', 'startup', 'small business', 'employer', 'entrepreneur', 'food truck', 'restaurant', 'food service'],
  // NOTE: applicant-type synonyms must be IDENTITY words, not theme words.
  // 'rural'/'community'/'city'/'county' are themes that appear in almost any
  // mission statement — a rural church is not a "farm" applicant and a community
  // center is not a "government" applicant. They were pulling unrelated org
  // grants into every org's results, so they are excluded here (they remain
  // useful as NEED/geo signals elsewhere).
  farm: ['farm', 'farmer', 'agriculture', 'ranch'],
  government: ['government', 'municipal', 'municipality', 'county', 'parks department', 'federal agency'],
  tribal: ['tribal', 'tribe', 'indian tribe', 'native nation', 'reservation'],
  candidate: ['candidate', 'politician', 'political candidate', 'running for office'],
  veteran: ['veteran', 'former service member', 'prior service', 'ex military'],
  active_duty: ['active duty', 'currently serving', 'service member', 'servicemember', 'military member'],
  guard_reserve: ['national guard', 'reserve', 'reservist', 'guard member'],
  transitioning_service_member: ['transitioning service member', 'separating service member', 'retiring service member', 'transitioning out', 'ets'],
  military_spouse: ['military spouse', 'service member spouse', 'spouse of service member'],
};

const NEED_KEYWORDS = {
  housing: ['housing', 'rent', 'mortgage', 'homeless', 'shelter', 'utilities'],
  food: ['food assistance', 'food support', 'groceries', 'nutrition', 'meals', 'snap', 'pantry'],
  childcare: ['childcare', 'child care', 'daycare', 'day care', 'early childhood', 'after school care', 'dependent care'],
  transportation: ['transportation', 'transit', 'bus pass', 'bus passes', 'gas card', 'gas cards', 'rideshare', 'vehicle repair', 'medical transportation'],
  medical: ['medical', 'health', 'healthcare', 'health care', 'treatment', 'prescription', 'copay', 'co-pay'],
  disability: ['disability', 'disabled', 'special needs', 'accessibility', 'accommodation', 'assistive technology', 'adaptive equipment'],
  medical_bills: ['medical bill', 'medical bills', 'hospital bill', 'hospital bills', 'copay', 'co-pay', 'medical debt', 'patient assistance'],
  medication: ['medication', 'medicine', 'prescription', 'prescriptions', 'rx', 'pharmacy', 'drug assistance'],
  mental_health: ['mental health', 'behavioral health', 'counseling', 'therapy', 'psychiatric', 'suicide prevention', 'trauma support'],
  substance_recovery: ['substance recovery', 'substance use', 'addiction', 'opioid', 'sud', 'recovery program', 'treatment center'],
  education: ['education', 'tuition', 'scholarship', 'school', 'books', 'training', 'classroom', 'teacher supplies', 'student aid'],
  scholarship: ['scholarship', 'scholarships', 'award aid', 'merit aid', 'need based aid', 'need-based aid'],
  fafsa: ['fafsa', 'federal student aid', 'student aid application'],
  pell: ['pell', 'pell grant', 'federal pell'],
  fellowship: ['fellowship', 'fellowships', 'graduate award', 'research fellowship'],
  research_funding: ['research funding', 'research grant', 'dissertation grant', 'graduate research', 'research assistantship'],
  stipend: ['stipend', 'living stipend', 'monthly stipend'],
  tuition: ['tuition', 'fees', 'cost of attendance', 'coa', 'room and board'],
  textbooks: ['textbooks', 'textbook', 'books', 'course materials', 'school supplies'],
  college_prep: ['college prep', 'college preparation', 'sat prep', 'act prep', 'college application'],
  first_gen: ['first gen', 'first-gen', 'first generation', 'first-generation'],
  curriculum: ['curriculum', 'lesson plan', 'lesson plans', 'homeschool materials', 'instructional materials'],
  classroom_supplies: ['classroom supplies', 'teacher supplies', 'school supplies', 'student materials', 'instructional supplies'],
  stem_classroom: ['stem classroom', 'science classroom', 'math classroom', 'robotics', 'coding class', 'lab equipment'],
  arts_education: ['arts education', 'music education', 'visual arts', 'theater education', 'arts classroom'],
  professional_development: ['professional development', 'teacher training', 'educator training', 'certification training'],
  special_education: ['special education', 'idea', 'iep', 'special needs classroom', 'disability services'],
  school_nutrition: ['school nutrition', 'school meals', 'cafeteria', 'food service equipment', 'breakfast program', 'lunch program'],
  school_transportation: ['school transportation', 'school bus', 'bus fleet', 'student transportation', 'clean school bus'],
  library_media: ['library', 'library media', 'media center', 'school library', 'public library', 'museum'],
  emergency: ['emergency', 'disaster', 'fire', 'flood', 'crisis', 'relief', 'hazard mitigation', 'emergency management'],
  equipment: ['equipment', 'apparatus', 'gear', 'vehicle', 'truck', 'tools'],
  operations: ['operations', 'operating', 'general support', 'payroll'],
  capacity_building: ['capacity', 'capacity building', 'organizational capacity', 'staffing', 'strategic planning'],
  capital: ['capital', 'building', 'construction', 'renovation', 'facility'],
  programs: ['program', 'programming', 'services', 'outreach', 'project'],
  technology: ['technology', 'computers', 'software', 'internet', 'broadband'],
  community_facilities: ['community facility', 'community facilities', 'essential community facility', 'public facility'],
  infrastructure: ['infrastructure', 'public works', 'bridge', 'water system', 'sewer system', 'utility system'],
  roads_transportation: ['road project', 'road repair', 'roadway', 'bridge', 'bridges', 'transportation grant', 'safe streets', 'sidewalk', 'trail'],
  water_sewer: ['water system', 'water infrastructure', 'sewer', 'wastewater', 'drinking water', 'stormwater', 'clean water'],
  environmental_remediation: ['environmental remediation', 'brownfield', 'brownfields', 'cleanup', 'pollution', 'environmental justice'],
  housing_development: ['housing development', 'affordable housing', 'public housing', 'housing authority', 'rental development'],
  economic_development: ['economic development', 'business district', 'workforce development', 'job creation', 'downtown revitalization'],
  broadband: ['broadband', 'internet access', 'fiber', 'digital equity', 'connectivity'],
  veterans: ['veteran', 'va benefits'],
  active_duty_support: ['active duty', 'currently serving', 'servicemember', 'service member support', 'military onesource'],
  military_transition: ['transition assistance', 'tap', 'transitioning service member', 'separating from service', 'separation from service', 'retiring from service', 'ets'],
  military_spouse_support: ['military spouse', 'spouse education', 'spouse career', 'mycaa'],
  employment: ['employment', 'job', 'jobs', 'career', 'workforce', 'work study', 'work-study', 'campus job'],
  workforce: ['workforce', 'job training', 'career training', 'apprenticeship', 'reentry employment', 'work readiness'],
  energy: ['energy', 'heating', 'liheap', 'weatherization', 'solar', 'utility', 'utilities', 'electric bill', 'gas bill'],
  agriculture: ['agriculture', 'farm', 'farmer', 'ranch', 'livestock', 'crop', 'usda'],
  public_safety: ['public safety', 'law enforcement', 'police', 'sheriff', 'border patrol', 'security'],
  recreation: ['parks', 'recreation', 'parks recreation', 'parks and recreation', 'baseball', 'sports', 'summer program', 'athletics', 'youth sports'],
  legal: ['legal', 'attorney', 'lawyer', 'law firm', 'law practice', 'legal aid'],
  // HIGH-PRECISION only: the bare words 'campaign' (marketing/awareness/fundraising
  // campaigns) and 'election' (school-council elections, "election year", history
  // essays) are common theme words that falsely flagged students/individuals as
  // political candidates. Keep unambiguous, multi-word political-finance phrases.
  campaign: ['campaign finance', 'candidate filing', 'political committee', 'political campaign', 'running for office', 'run for office', 'campaign committee', 'ballot measure'],
  caregiving: ['caregiver', 'caregiving', 'respite', 'memory care', 'long term care', 'home care', 'dementia care', 'elder care', 'aging services', 'kinship', 'kinship care', 'grandfamily', 'grandfamilies', 'raising grandchildren', 'grandparent raising', 'grandparents raising'],
  survivor_benefits: ['survivor benefits', 'surviving spouse', 'widow benefits', 'widower benefits', 'death benefit'],
  cancer_support: ['cancer', 'oncology', 'chemotherapy', 'breast cancer', 'stage 4', 'metastatic'],
  dementia_support: ['dementia', 'alzheimers', 'alzheimer', 'memory care'],
  // Vision / brain-injury lanes (2026-07-26 adapter wishlist): whole-word
  // matched, so 'retina'/'anoxic' are precise; 'tbi' matches only as a token.
  vision_support: ['blind', 'blindness', 'visual impairment', 'visually impaired', 'low vision', 'vision loss', 'legally blind', 'macular degeneration', 'retina', 'retinal', 'retinopathy', 'glaucoma'],
  brain_injury_support: ['brain injury', 'traumatic brain injury', 'acquired brain injury', 'anoxic brain injury', 'anoxic', 'hypoxic', 'tbi', 'concussion', 'post-concussion'],
  black_lung_benefits: ['black lung', 'coal miner widow', 'coal miner survivor', 'miner survivor', 'coal miner benefits'],
  animal_welfare: ['animal shelter', 'animal rescue', 'animal welfare', 'humane society', 'spay', 'neuter', 'veterinary assistance'],
  domestic_violence: ['domestic violence', 'family violence', 'dv shelter', 'victim services', 'vawa', 'survivor advocacy'],
  reentry: ['reentry', 'second chance', 'justice involved', 'formerly incarcerated', 'reintegration'],
  startup: ['startup', 'start a business', 'starting a business', 'small business startup', 'entrepreneur', 'food truck', 'restaurant startup', 'mobile food', 'working capital'],
};

// HIGH-PRECISION phrase → applicant-bucket safety net. Unlike the broad
// single-word synonym scan (which only runs as a last-resort fallback because
// theme words like "community"/"military" caused false positives), these are
// multi-word, unambiguous funding-IDENTITY phrases. They run ADDITIVELY for
// ORGANIZATION-class profiles only (never on a person/household primary
// identity) so a profile whose TYPE field is generic ('organization', 'other',
// blank) but whose text clearly says what it is still reaches the right
// sources. Canonical example: a profile typed 'organization' whose mission says
// "we are a volunteer fire department" must still pull FEMA AFG — it must never
// silently miss it again. Additive only → recall, never suppression; the match
// engine still scores relevance so this cannot flood.
// Deliberately NARROW. Earlier theme-prone buckets (farm/government/school/
// church via single words like "farm-area", "community", "education") caused
// exactly the over-broadening the 2026-06-23 false-positive audit guards
// against — a church whose mission mentioned "rural families / farm-area
// ministry" was wrongly typed farm. Those identities are already covered
// reliably by the declared-type PRIMARY_TYPE_TO_APPLICANT map. The ONE case
// that genuinely needs a free-text safety net is fire/EMS: a profile typed
// generically ('organization'/'other') but whose text clearly says it is a
// fire department must still reach FEMA AFG. These phrases are multi-word and
// unambiguous (they do not appear as themes in other orgs' missions), and the
// add is purely additive recall (the match engine still scores relevance).
const PHRASE_APPLICANT_TRIGGERS = Object.freeze([
  {
    add: 'vfd',
    label: 'fire / EMS / first-responder',
    re: /\b(volunteer\s+fire|fire\s+department|fire\s+district|fire\s+protection\s+district|fire\s+rescue|firefighter|first\s+responder|emergency\s+medical\s+services?|\bvfd\b|fema\s+afg|\bafg\s+grant|safer\s+grant|assistance\s+to\s+firefighter)/i,
  },
]);

/**
 * detectKeywordApplicantTriggers — scan free text for high-precision identity
 * phrases. Returns the buckets that fired with the matched phrase, so the
 * crawler-plan explainer (and Anya's plan-for-profile tool) can show EXACTLY
 * which keyword pulled in which source. ORG-only by design — pass
 * isIndividual=true to suppress (a person who volunteers at a fire dept is not
 * a VFD applicant).
 *
 * @param {string} blob lowercased profile text
 * @param {boolean} isIndividual whether the primary identity is a person/household
 * @returns {Array<{add:string,label:string,matched:string}>}
 */
export function detectKeywordApplicantTriggers(blob, isIndividual) {
  if (isIndividual) return [];
  const text = String(blob ?? '');
  const fired = [];
  for (const trig of PHRASE_APPLICANT_TRIGGERS) {
    const m = text.match(trig.re);
    if (m) fired.push({ add: trig.add, label: trig.label, matched: m[0].trim() });
  }
  return fired;
}

function lc(x) { return String(x ?? '').toLowerCase(); }

function key(x) {
  return lc(x)
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const NEGATIVE_TEXT_VALUES = new Set([
  '',
  '0',
  'false',
  'no',
  'none',
  'n/a',
  'na',
  'not applicable',
  'not-applicable',
  'not specified',
  'unspecified',
  'unknown',
  'prefer not to say',
]);

function valueText(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return 'true';
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return NEGATIVE_TEXT_VALUES.has(text.toLowerCase()) ? '' : text;
  }
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.values(value).map(valueText).filter(Boolean).join(' ');
  return String(value);
}

function gatherText(profile) {
  const parts = [];
  const push = (v) => {
    const text = valueText(v);
    if (text) parts.push(text);
  };
  // Identity fields are handled structurally by deriveApplicantTypes and
  // PRIMARY_TYPE_DEFAULT_NEEDS. Do not feed them into need-text scanning:
  // "animal_shelter" should not become only "housing" because it contains
  // "shelter", and "special_education_program" should not suppress the richer
  // special-ed defaults because it contains "education".
  push(profile?.name);
  push(profile?.description); push(profile?.summary); push(profile?.mission);
  push(profile?.needs); push(profile?.need_categories); push(profile?.tags);
  for (const s of profile?.sections ?? []) { push(s?.title); push(s?.body); push(s?.value); push(s?.data); }
  for (const o of profile?.organizations ?? []) { push(o?.name); push(o?.type); push(o?.mission); }
  for (const d of profile?.documents ?? []) { push(d?.name); push(d?.extracted_text); push(d?.summary); }
  if (profile?.school) { push(profile.school.name); push(profile.school.type); }
  return parts.join(' \n ').toLowerCase();
}

function gatherStructuredApplicantHints(profile) {
  const hints = [];
  const push = (v) => { if (v !== null && v !== undefined && v !== '') hints.push(lc(v)); };
  push(profile?.military_status);
  push(profile?.service_status);
  push(profile?.military_service_status);
  for (const section of profile?.sections ?? []) {
    const sectionKey = lc(section?.section_key ?? section?.key ?? section?.title);
    const isMilitarySection =
      sectionKey.includes('military') ||
      sectionKey.includes('service') ||
      sectionKey.includes('veteran') ||
      sectionKey === 'demographics';
    if (!isMilitarySection) continue;
    const data = section?.data ?? {};
    push(data?.military_status);
    push(data?.service_status);
    push(data?.status);
    push(data?.relationship_to_service_member);
    if (data?.is_veteran === true || data?.veteran === true) push('veteran');
    if (data?.is_active_duty === true || data?.active_duty === true) push('active duty');
    if (data?.is_guard_reserve === true || data?.guard_reserve === true || data?.is_reservist === true) push('guard reserve');
    if (data?.is_transitioning_service_member === true || data?.transitioning_service_member === true) push('transitioning service member');
    if (data?.is_military_spouse === true || data?.military_spouse === true) push('military spouse');
  }
  return hints;
}

// A deliberate occupation.farmer checkbox declares the profile an agricultural
// producer. Structured only — never the general text blob (a mission mentioning
// "farmers market" is not a farm). The check is scoped to the OCCUPATION
// section: either the raw boolean flag, or its canonicalized text form —
// sectionSignalText (crawlerOsPersistence) renders a section as the keys of its
// TRUE flags ("farmer small business owner"), so a word-bounded "farmer" inside
// the occupation section's own text is the same declared flag.
function hasStructuredFarmerFlag(profile) {
  if (profile?.farmer === true || profile?.is_farmer === true) return true;
  for (const flag of FARM_OCCUPATION_FLAG_KEYS) {
    if (profile?.occupation?.[flag] === true) return true;
  }
  for (const section of profile?.sections ?? []) {
    const sectionKey = lc(section?.section_key ?? section?.key ?? section?.title);
    // A NAICS sector-11 code on the business section is an unambiguous
    // structured self-declaration of an agricultural operation.
    if (sectionKey === 'small_business_details' && isAgricultureNaics(section?.data?.naics_code)) return true;
    if (sectionKey !== 'occupation') continue;
    for (const flag of FARM_OCCUPATION_FLAG_KEYS) {
      if (section?.data?.[flag] === true) return true;
    }
    const text = lc(valueText(section?.data) + ' ' + (section?.body ?? ''));
    if (/(^|[^a-z])farmer([^a-z]|$)/.test(text)) return true;
  }
  return false;
}

// Structured foster indicator (current/former foster youth OR foster parent),
// scoped to the FAMILY-shaped sections. Mirrors profileNormalizer's
// hasFosterIndicator: sectionSignalText renders true flags as their key words
// ("foster youth homeless"), so a word-bounded "foster" inside the family
// section's own text is the declared flag — never the general blob.
function hasStructuredFosterFlag(profile) {
  if (profile?.foster_youth === true || profile?.has_foster_indicator === true) return true;
  for (const section of profile?.sections ?? []) {
    const sectionKey = lc(section?.section_key ?? section?.key ?? section?.title);
    if (!/^family(_life)?$|^caregiving$/.test(sectionKey)) continue;
    const data = section?.data ?? {};
    if (data.foster_youth === true || data.former_foster_youth === true ||
        data.is_foster_parent === true || data.foster_care === true || data.has_foster_children === true) return true;
    const text = lc(valueText(data) + ' ' + (section?.body ?? ''));
    if (/(^|[^a-z])foster([^a-z]|$)/.test(text)) return true;
  }
  return false;
}

// System/bookkeeping tags that must never be treated as topical interests —
// they mark HOW a profile is managed, not WHAT it seeks funding for.
const RESERVED_PROFILE_TAGS = new Set([
  'designated', 'source-safe', 'source_safe', 'source', 'safe', 'synthetic',
  'test', 'demo', 'organization', 'individual', 'profile', 'active',
]);

// A declared type string that is recognizably an ORGANIZATION even when no
// exact map/synonym knows it ("Biotechnology / research organization",
// "community coalition", "research institute"). Used ONLY to keep free-text
// declared org identities out of the blob-scan fallback — never for scoring.
const RE_ORG_SHAPED_TYPE = /(organi[sz]ation|institut|universit|hospital|laborator|research|biotech|life scien|foundation|agency|coalition|consortium|company|enterprise)/i;

// Word-boundary synonym match for the no-declared-identity blob fallback.
// Plain includes() was the applicant-type explosion driver: 'ets' matched
// "targets"/"assets", 'ems' matched "systems". Multi-word synonyms keep their
// internal spaces; regex specials are escaped.
function wordBoundaryMatch(text, synonym) {
  const escaped = String(synonym).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

// Applicant types that describe an ORGANIZATION (vs. a person/household).
const ORG_APPLICANT_TYPES = new Set(['nonprofit', 'church', 'ministry', 'school', 'vfd', 'law_enforcement', 'business', 'farm', 'government', 'tribal']);
const INDIVIDUAL_APPLICANT_TYPES = new Set([
  'individual', 'family', 'student', 'teacher', 'candidate', 'veteran', 'active_duty',
  'guard_reserve', 'transitioning_service_member', 'military_spouse',
  'widow', 'widower', 'surviving_spouse', 'patient', 'dementia_patient',
]);

// AUTHORITATIVE primary_type -> applicant-bucket map. The substring-synonym
// scan below cannot recognize multi-word canonical types whose stored
// primary_type uses underscores (e.g. 'volunteer_fire_department',
// 'food_pantry', 'local_housing_authority') — those silently fell through to
// the 'individual' default and were then HARD-EXCLUDED from grants_gov/sam_gov
// (their applicant_types omit 'individual'), producing zero real funding for
// fire departments, food pantries, shelters, libraries, government agencies,
// etc. — a mission-rule violation (zero-results / hard boolean filter).
// This map is consulted FIRST so every canonical type lands in the correct
// funding-eligibility bucket(s). Multiple buckets widen recall; the match
// engine still scores relevance so this never floods.
const PRIMARY_TYPE_TO_APPLICANT = Object.freeze({
  // Person / household (federal grant APIs don't serve these directly; they
  // get honest benefit/direct-aid directories and locators).
  individual: ['individual'],
  person: ['individual'],
  adult: ['individual'],
  individual_adult: ['individual'],
  low_income_individual: ['individual'],
  medical_need: ['individual'],
  medical_assistance: ['individual'],
  health_profile: ['individual'],
  medical_profile: ['individual'],
  patient_assistance: ['individual'],
  medical_hardship: ['individual'],
  cancer_patient: ['individual'],
  breast_cancer_patient: ['individual'],
  patient: ['individual'],
  senior: ['individual'],
  older_adult: ['individual'],
  elderly: ['individual'],
  veteran: ['veteran', 'individual'],
  active_duty: ['active_duty', 'individual'],
  active_duty_service_member: ['active_duty', 'individual'],
  servicemember: ['active_duty', 'individual'],
  service_member: ['active_duty', 'individual'],
  guard_reserve: ['guard_reserve', 'individual'],
  national_guard: ['guard_reserve', 'individual'],
  reservist: ['guard_reserve', 'individual'],
  transitioning_service_member: ['transitioning_service_member', 'active_duty', 'individual'],
  separating_service_member: ['transitioning_service_member', 'active_duty', 'individual'],
  military_spouse: ['military_spouse', 'family', 'individual'],
  disabled_adult: ['individual'],
  adult_with_disability: ['individual'],
  person_with_disability: ['individual'],
  widow: ['family', 'individual'],
  widower: ['family', 'individual'],
  surviving_spouse: ['family', 'individual'],
  domestic_violence_survivor: ['individual'],
  dv_survivor: ['individual'],
  abuse_survivor: ['individual'],
  coal_miner_widow: ['family', 'individual'],
  miner_widow: ['family', 'individual'],
  dementia_patient: ['family', 'individual'],
  teacher: ['teacher', 'individual'],
  classroom_teacher: ['teacher', 'individual'],
  educator: ['teacher', 'individual'],
  family: ['family', 'individual'],
  single_parent: ['family', 'individual'],
  single_mom: ['family', 'individual'],
  homeschool_family: ['family', 'individual'],
  // Public office / campaign profiles: funding is mostly campaign-finance
  // guidance and compliance resources, not grants. Keep it a distinct bucket.
  candidate: ['candidate', 'individual'],
  political_candidate: ['candidate', 'individual'],
  local_candidate: ['candidate', 'individual'],
  politician: ['candidate', 'individual'],
  campaign_committee: ['candidate'],
  // Students
  student: ['student', 'individual'],
  high_school_student: ['student', 'individual'],
  college_student: ['student', 'individual'],
  graduate_student: ['student', 'individual'],
  // Schools / education institutions
  school: ['school'],
  school_district: ['school', 'government'],
  public_school: ['school', 'government'],
  special_education_program: ['school'],
  school_food_service: ['school', 'government'],
  school_transportation: ['school', 'government'],
  library: ['nonprofit', 'government'],
  public_library: ['nonprofit', 'government'],
  county_library: ['nonprofit', 'government'],
  library_media_center: ['nonprofit', 'government'],
  pta_pto: ['nonprofit'],
  // Nonprofits / community orgs
  nonprofit: ['nonprofit'],
  organization: ['nonprofit'], // legacy seed string
  food_pantry: ['nonprofit'],
  food_bank: ['nonprofit'],
  food_shelf: ['nonprofit'],
  soup_kitchen: ['nonprofit'],
  homeless_shelter: ['nonprofit'],
  shelter: ['nonprofit'],
  emergency_shelter: ['nonprofit'],
  transitional_housing: ['nonprofit'],
  animal_rescue: ['nonprofit'],
  animal_shelter: ['nonprofit'],
  animal_welfare: ['nonprofit'],
  humane_society: ['nonprofit'],
  mental_health_nonprofit: ['nonprofit'],
  behavioral_health_nonprofit: ['nonprofit'],
  mh_nonprofit: ['nonprofit'],
  substance_recovery_org: ['nonprofit'],
  recovery_program: ['nonprofit'],
  sud_program: ['nonprofit'],
  reentry_program: ['nonprofit'],
  second_chance_program: ['nonprofit'],
  reintegration_program: ['nonprofit'],
  community_center: ['nonprofit'],
  neighborhood_center: ['nonprofit'],
  civic_center: ['nonprofit'],
  museum: ['nonprofit'],
  historical_museum: ['nonprofit'],
  art_museum: ['nonprofit'],
  domestic_violence_shelter: ['nonprofit'],
  dv_shelter: ['nonprofit'],
  family_violence_shelter: ['nonprofit'],
  community_development_corp: ['nonprofit'],
  community_development_corporation: ['nonprofit'],
  chdo: ['nonprofit'],
  community_action_agency: ['nonprofit'],
  disability_service_provider: ['nonprofit'],
  disability_services_provider: ['nonprofit'],
  disability_nonprofit: ['nonprofit'],
  workforce_board: ['nonprofit', 'government'],
  workforce_development_board: ['nonprofit', 'government'],
  chamber_of_commerce: ['nonprofit'],
  civic_club: ['nonprofit'],
  civic_organization: ['nonprofit'],
  rotary_club: ['nonprofit'],
  lions_club: ['nonprofit'],
  community_foundation: ['nonprofit'],
  hospital: ['nonprofit', 'government'],
  rural_hospital: ['nonprofit', 'government'],
  clinic: ['nonprofit'],
  health_clinic: ['nonprofit'],
  medical_clinic: ['nonprofit'],
  community_health_center: ['nonprofit'],
  rural_health_clinic: ['nonprofit'],
  fqhc: ['nonprofit'],
  // Faith-based (also nonprofit-eligible for federal/foundation funding)
  church: ['church', 'nonprofit'],
  ministry: ['ministry', 'nonprofit'],
  minister: ['church', 'ministry', 'nonprofit'],
  pastor: ['church', 'ministry', 'nonprofit'],
  clergy: ['church', 'ministry', 'nonprofit'],
  // Emergency services
  volunteer_fire_department: ['vfd', 'government'],
  fire_department: ['vfd', 'government'],
  ems_agency: ['vfd', 'government'],
  ems: ['vfd', 'government'],
  ambulance_service: ['vfd', 'government'],
  rescue_squad: ['vfd', 'government'],
  police_department: ['law_enforcement', 'government'],
  sheriff_department: ['law_enforcement', 'government'],
  law_enforcement_agency: ['law_enforcement', 'government'],
  border_patrol: ['law_enforcement', 'government'],
  federal_agency: ['government'],
  // Government / public agencies
  county_government: ['government'],
  city_government: ['government'],
  township_government: ['government'],
  local_government: ['government'],
  municipality: ['government'],
  public_agency: ['government'],
  state_local_gov: ['government'],
  local_housing_authority: ['government'],
  housing_authority: ['government'],
  phra: ['government'],
  public_housing_authority: ['government'],
  parks_department: ['government'],
  parks_recreation: ['government'],
  parks_recreation_department: ['government'],
  parks_and_rec: ['government'],
  county_parks_recreation: ['government'],
  public_recreation_program: ['government'],
  youth_sports_program: ['government', 'nonprofit'],
  regional_planning_agency: ['government'],
  economic_development_agency: ['government'],
  tribal_government: ['tribal', 'government'],
  indian_tribe: ['tribal', 'government'],
  native_nation: ['tribal', 'government'],
  reservation: ['tribal', 'government'],
  public_health_department: ['government'],
  health_department: ['government'],
  doh: ['government'],
  county_health_department: ['government'],
  local_health_department: ['government'],
  public_library_system: ['government'],
  // Business
  business: ['business'],
  small_business: ['business'], // legacy seed string
  entrepreneur: ['business'],
  veteran_entrepreneur: ['veteran', 'business', 'individual'],
  active_duty_entrepreneur: ['active_duty', 'business', 'individual'],
  military_spouse_entrepreneur: ['military_spouse', 'business', 'individual'],
  guard_reserve_entrepreneur: ['guard_reserve', 'business', 'individual'],
  transitioning_service_member_entrepreneur: ['transitioning_service_member', 'active_duty', 'business', 'individual'],
  food_truck: ['business'],
  food_truck_startup: ['business'],
  restaurant_startup: ['business'],
  attorney: ['business'],
  lawyer: ['business'],
  law_firm: ['business'],
  legal_practice: ['business'],
  attorney_practice: ['business'],
  minority_owned_business: ['business'],
  women_owned_business: ['business'],
  // Agriculture
  farm: ['farm'],
  farmer: ['farm'],
  ranch: ['farm'],
  rancher: ['farm'],
  agricultural_cooperative: ['farm', 'business'],
  farm_cooperative: ['farm', 'business'],
  farmers_cooperative: ['farm', 'business'],
  agricultural_coop: ['farm', 'business'],
  cooperative: ['business'],
});

// Sparse-profile starters. These are NOT exclusions and they are NOT match
// scores; they are the minimum useful search language for a declared identity
// when the profile has not filled every field yet. Empty fields stay neutral.
const PRIMARY_TYPE_DEFAULT_NEEDS = Object.freeze({
  individual: ['food', 'energy', 'housing', 'medical'],
  person: ['food', 'energy', 'housing', 'medical'],
  adult: ['food', 'energy', 'housing', 'medical'],
  individual_adult: ['food', 'energy', 'housing', 'medical'],
  low_income_individual: ['food', 'energy', 'housing', 'medical'],
  family: ['food', 'energy', 'housing', 'childcare', 'medical'],
  single_parent: ['food', 'energy', 'housing', 'childcare', 'medical'],
  single_mom: ['food', 'energy', 'housing', 'childcare', 'medical'],
  senior: ['medical', 'caregiving', 'food', 'energy', 'housing', 'transportation'],
  older_adult: ['medical', 'caregiving', 'food', 'energy', 'housing', 'transportation'],
  elderly: ['medical', 'caregiving', 'food', 'energy', 'housing', 'transportation'],
  disabled_adult: ['disability', 'medical', 'housing', 'transportation', 'employment'],
  adult_with_disability: ['disability', 'medical', 'housing', 'transportation', 'employment'],
  person_with_disability: ['disability', 'medical', 'housing', 'transportation', 'employment'],
  medical_need: ['medical', 'medical_bills', 'medication', 'transportation', 'caregiving'],
  medical_assistance: ['medical', 'medical_bills', 'medication', 'transportation', 'caregiving'],
  health_profile: ['medical', 'medical_bills', 'medication', 'transportation', 'caregiving'],
  medical_profile: ['medical', 'medical_bills', 'medication', 'transportation', 'caregiving'],
  patient_assistance: ['medical', 'medical_bills', 'medication', 'transportation', 'caregiving'],
  cancer_patient: ['cancer_support', 'medical', 'medical_bills', 'medication', 'transportation', 'housing'],
  breast_cancer_patient: ['cancer_support', 'medical', 'medical_bills', 'medication', 'transportation', 'housing'],
  dementia_patient: ['dementia_support', 'medical', 'caregiving', 'transportation'],
  widow: ['survivor_benefits', 'housing', 'food', 'medical'],
  widower: ['survivor_benefits', 'housing', 'food', 'medical'],
  surviving_spouse: ['survivor_benefits', 'housing', 'food', 'medical'],
  coal_miner_widow: ['black_lung_benefits', 'survivor_benefits', 'medical', 'caregiving', 'food'],
  miner_widow: ['black_lung_benefits', 'survivor_benefits', 'medical', 'caregiving', 'food'],
  domestic_violence_survivor: ['domestic_violence', 'housing', 'mental_health', 'legal'],
  dv_survivor: ['domestic_violence', 'housing', 'mental_health', 'legal'],
  abuse_survivor: ['domestic_violence', 'housing', 'mental_health', 'legal'],

  student: ['scholarship', 'education', 'housing', 'fafsa'],
  high_school_student: ['scholarship', 'college_prep', 'fafsa', 'first_gen'],
  college_student: ['scholarship', 'tuition', 'housing', 'textbooks', 'fafsa', 'pell'],
  graduate_student: ['fellowship', 'research_funding', 'tuition', 'stipend', 'scholarship'],
  homeschool_family: ['education', 'curriculum', 'scholarship', 'stem_classroom'],

  teacher: ['classroom_supplies', 'education', 'professional_development'],
  classroom_teacher: ['classroom_supplies', 'education', 'technology', 'professional_development'],
  educator: ['classroom_supplies', 'education', 'professional_development'],
  school: ['education', 'programs', 'technology', 'capital'],
  public_school: ['education', 'programs', 'technology', 'capital'],
  school_district: ['education', 'programs', 'technology', 'capital'],
  special_education_program: ['special_education', 'disability', 'education', 'classroom_supplies'],
  school_food_service: ['school_nutrition', 'food', 'equipment'],
  school_transportation: ['school_transportation', 'roads_transportation', 'equipment'],
  pta_pto: ['classroom_supplies', 'arts_education', 'stem_classroom', 'education'],
  library: ['library_media', 'education', 'technology', 'community_facilities'],
  public_library: ['library_media', 'education', 'technology', 'community_facilities'],
  county_library: ['library_media', 'education', 'technology', 'community_facilities'],
  library_media_center: ['library_media', 'education', 'technology'],

  nonprofit: ['capacity_building', 'programs', 'operations'],
  organization: ['capacity_building', 'programs', 'operations'],
  church: ['programs', 'food', 'housing', 'capacity_building'],
  ministry: ['programs', 'food', 'housing', 'capacity_building'],
  minister: ['programs', 'food', 'housing', 'capacity_building'],
  pastor: ['programs', 'food', 'housing', 'capacity_building'],
  clergy: ['programs', 'food', 'housing', 'capacity_building'],
  food_pantry: ['food', 'capacity_building', 'equipment'],
  food_bank: ['food', 'capacity_building', 'equipment'],
  food_shelf: ['food', 'capacity_building', 'equipment'],
  soup_kitchen: ['food', 'capacity_building', 'equipment'],
  homeless_shelter: ['housing', 'housing_development', 'mental_health', 'capacity_building'],
  shelter: ['housing', 'housing_development', 'mental_health', 'capacity_building'],
  emergency_shelter: ['housing', 'housing_development', 'mental_health', 'capacity_building'],
  transitional_housing: ['housing', 'housing_development', 'mental_health', 'capacity_building'],
  domestic_violence_shelter: ['domestic_violence', 'housing', 'mental_health', 'public_safety'],
  dv_shelter: ['domestic_violence', 'housing', 'mental_health', 'public_safety'],
  family_violence_shelter: ['domestic_violence', 'housing', 'mental_health', 'public_safety'],
  community_development_corp: ['housing_development', 'economic_development', 'community_facilities', 'capacity_building'],
  community_development_corporation: ['housing_development', 'economic_development', 'community_facilities', 'capacity_building'],
  chdo: ['housing_development', 'economic_development', 'community_facilities', 'capacity_building'],
  community_action_agency: ['programs', 'food', 'energy', 'housing', 'capacity_building'],
  disability_service_provider: ['disability', 'programs', 'capacity_building', 'equipment'],
  disability_services_provider: ['disability', 'programs', 'capacity_building', 'equipment'],
  disability_nonprofit: ['disability', 'programs', 'capacity_building', 'equipment'],
  workforce_board: ['workforce', 'employment', 'economic_development', 'programs'],
  workforce_development_board: ['workforce', 'employment', 'economic_development', 'programs'],
  chamber_of_commerce: ['economic_development', 'programs', 'capacity_building'],
  civic_club: ['programs', 'community_facilities', 'capacity_building'],
  civic_organization: ['programs', 'community_facilities', 'capacity_building'],
  rotary_club: ['programs', 'community_facilities', 'capacity_building'],
  lions_club: ['programs', 'community_facilities', 'capacity_building'],
  community_foundation: ['programs', 'capacity_building', 'operations'],
  hospital: ['medical', 'capital', 'equipment', 'operations'],
  rural_hospital: ['medical', 'capital', 'equipment', 'operations'],
  clinic: ['medical', 'equipment', 'programs', 'operations'],
  health_clinic: ['medical', 'equipment', 'programs', 'operations'],
  medical_clinic: ['medical', 'equipment', 'programs', 'operations'],
  community_health_center: ['medical', 'equipment', 'programs', 'operations'],
  rural_health_clinic: ['medical', 'equipment', 'programs', 'operations'],
  fqhc: ['medical', 'equipment', 'programs', 'operations'],
  reentry_program: ['reentry', 'workforce', 'employment', 'housing', 'mental_health'],
  second_chance_program: ['reentry', 'workforce', 'employment', 'housing', 'mental_health'],
  reintegration_program: ['reentry', 'workforce', 'employment', 'housing', 'mental_health'],
  substance_recovery_org: ['substance_recovery', 'mental_health', 'medical'],
  recovery_program: ['substance_recovery', 'mental_health', 'medical'],
  sud_program: ['substance_recovery', 'mental_health', 'medical'],
  mental_health_nonprofit: ['mental_health', 'medical', 'capacity_building'],
  behavioral_health_nonprofit: ['mental_health', 'medical', 'capacity_building'],
  mh_nonprofit: ['mental_health', 'medical', 'capacity_building'],
  animal_rescue: ['animal_welfare', 'capacity_building', 'equipment'],
  animal_shelter: ['animal_welfare', 'capacity_building', 'equipment'],
  animal_welfare: ['animal_welfare', 'capacity_building', 'equipment'],
  humane_society: ['animal_welfare', 'capacity_building', 'equipment'],
  community_center: ['community_facilities', 'programs', 'recreation', 'capacity_building'],
  neighborhood_center: ['community_facilities', 'programs', 'recreation', 'capacity_building'],
  civic_center: ['community_facilities', 'programs', 'recreation', 'capacity_building'],
  museum: ['library_media', 'arts_education', 'community_facilities', 'programs'],
  historical_museum: ['library_media', 'arts_education', 'community_facilities', 'programs'],
  art_museum: ['library_media', 'arts_education', 'community_facilities', 'programs'],

  volunteer_fire_department: ['public_safety', 'emergency', 'equipment', 'operations'],
  fire_department: ['public_safety', 'emergency', 'equipment', 'operations'],
  ems_agency: ['public_safety', 'emergency', 'equipment', 'operations'],
  ems: ['public_safety', 'emergency', 'equipment', 'operations'],
  ambulance_service: ['public_safety', 'emergency', 'equipment', 'operations'],
  rescue_squad: ['public_safety', 'emergency', 'equipment', 'operations'],
  police_department: ['public_safety', 'equipment', 'technology', 'programs'],
  sheriff_department: ['public_safety', 'equipment', 'technology', 'programs'],
  law_enforcement_agency: ['public_safety', 'equipment', 'technology', 'programs'],
  border_patrol: ['public_safety', 'equipment', 'technology', 'programs'],
  federal_agency: ['public_safety', 'technology', 'programs'],

  county_government: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  city_government: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  township_government: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  local_government: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  municipality: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  public_agency: ['infrastructure', 'community_facilities', 'public_safety', 'programs'],
  state_local_gov: ['infrastructure', 'community_facilities', 'public_safety', 'economic_development'],
  local_housing_authority: ['housing', 'housing_development', 'community_facilities'],
  housing_authority: ['housing', 'housing_development', 'community_facilities'],
  public_housing_authority: ['housing', 'housing_development', 'community_facilities'],
  parks_department: ['recreation', 'community_facilities', 'equipment'],
  parks_recreation: ['recreation', 'community_facilities', 'equipment'],
  parks_recreation_department: ['recreation', 'community_facilities', 'equipment'],
  parks_and_rec: ['recreation', 'community_facilities', 'equipment'],
  county_parks_recreation: ['recreation', 'community_facilities', 'equipment'],
  public_recreation_program: ['recreation', 'programs', 'equipment'],
  youth_sports_program: ['recreation', 'programs', 'equipment'],
  regional_planning_agency: ['economic_development', 'infrastructure', 'broadband'],
  economic_development_agency: ['economic_development', 'infrastructure', 'workforce'],
  public_health_department: ['medical', 'mental_health', 'substance_recovery', 'public_safety'],
  health_department: ['medical', 'mental_health', 'substance_recovery', 'public_safety'],
  county_health_department: ['medical', 'mental_health', 'substance_recovery', 'public_safety'],
  local_health_department: ['medical', 'mental_health', 'substance_recovery', 'public_safety'],
  tribal_government: ['housing_development', 'community_facilities', 'medical', 'public_safety', 'education', 'broadband', 'infrastructure', 'economic_development'],
  indian_tribe: ['housing_development', 'community_facilities', 'medical', 'public_safety', 'education', 'broadband', 'infrastructure', 'economic_development'],
  native_nation: ['housing_development', 'community_facilities', 'medical', 'public_safety', 'education', 'broadband', 'infrastructure', 'economic_development'],
  reservation: ['housing_development', 'community_facilities', 'medical', 'public_safety', 'education', 'broadband', 'infrastructure', 'economic_development'],

  business: ['startup', 'capital', 'operations'],
  small_business: ['startup', 'capital', 'operations'],
  entrepreneur: ['startup', 'capital', 'operations'],
  food_truck: ['startup', 'capital', 'equipment', 'operations'],
  food_truck_startup: ['startup', 'capital', 'equipment', 'operations'],
  restaurant_startup: ['startup', 'capital', 'equipment', 'operations'],
  attorney: ['legal', 'operations', 'technology'],
  lawyer: ['legal', 'operations', 'technology'],
  law_firm: ['legal', 'operations', 'technology'],
  legal_practice: ['legal', 'operations', 'technology'],
  attorney_practice: ['legal', 'operations', 'technology'],
  minority_owned_business: ['startup', 'capital', 'operations'],
  women_owned_business: ['startup', 'capital', 'operations'],
  veteran_entrepreneur: ['startup', 'capital', 'equipment', 'veteran_startup'],
  active_duty_entrepreneur: ['startup', 'capital', 'equipment', 'military_startup'],
  military_spouse_entrepreneur: ['startup', 'capital', 'equipment', 'military_startup'],
  guard_reserve_entrepreneur: ['startup', 'capital', 'equipment', 'military_startup'],
  transitioning_service_member_entrepreneur: ['startup', 'capital', 'equipment', 'military_startup'],
  farm: ['agriculture', 'equipment', 'operations', 'energy'],
  farmer: ['agriculture', 'equipment', 'operations', 'energy'],
  ranch: ['agriculture', 'equipment', 'operations', 'energy'],
  rancher: ['agriculture', 'equipment', 'operations', 'energy'],
  agricultural_cooperative: ['agriculture', 'economic_development', 'equipment', 'operations'],
  farm_cooperative: ['agriculture', 'economic_development', 'equipment', 'operations'],
  farmers_cooperative: ['agriculture', 'economic_development', 'equipment', 'operations'],
  agricultural_coop: ['agriculture', 'economic_development', 'equipment', 'operations'],
  cooperative: ['operations', 'capital', 'economic_development'],

  candidate: ['campaign', 'operations'],
  political_candidate: ['campaign', 'operations'],
  local_candidate: ['campaign', 'operations'],
  politician: ['campaign', 'operations'],
  campaign_committee: ['campaign', 'operations'],
});

const NEED_IMPLICATIONS = Object.freeze({
  disability: ['medical'],
  medical_bills: ['medical'],
  medication: ['medical'],
  mental_health: ['medical'],
  substance_recovery: ['medical', 'mental_health'],
  scholarship: ['education'],
  fafsa: ['education', 'scholarship'],
  pell: ['education', 'scholarship', 'fafsa'],
  fellowship: ['education', 'scholarship'],
  research_funding: ['education'],
  stipend: ['education'],
  tuition: ['education'],
  textbooks: ['education'],
  college_prep: ['education', 'scholarship'],
  first_gen: ['education', 'scholarship'],
  curriculum: ['education'],
  classroom_supplies: ['education'],
  stem_classroom: ['education', 'classroom_supplies'],
  arts_education: ['education', 'classroom_supplies'],
  professional_development: ['education'],
  special_education: ['education', 'disability'],
  school_nutrition: ['education', 'food'],
  school_transportation: ['education', 'transportation', 'roads_transportation'],
  library_media: ['education', 'community_facilities'],
  capacity_building: ['operations'],
  community_facilities: ['capital'],
  infrastructure: ['capital'],
  roads_transportation: ['infrastructure', 'transportation'],
  water_sewer: ['infrastructure'],
  environmental_remediation: ['infrastructure'],
  housing_development: ['housing', 'community_facilities'],
  economic_development: ['programs'],
  broadband: ['technology', 'infrastructure'],
  workforce: ['employment'],
  domestic_violence: ['housing', 'mental_health', 'public_safety'],
  reentry: ['employment', 'workforce', 'housing', 'mental_health'],
  cancer_support: ['medical'],
  dementia_support: ['medical', 'caregiving'],
  vision_support: ['medical', 'disability'],
  brain_injury_support: ['medical', 'disability', 'caregiving'],
  black_lung_benefits: ['medical', 'survivor_benefits'],
  veteran_startup: ['startup'],
  military_startup: ['startup'],
});

function deriveApplicantTypes(profile, blob, triggerCollector = null) {
  const explicit = []
    .concat(profile?.applicant_types ?? [])
    .concat(profile?.primary_type ?? [])
    .concat(profile?.type ?? [])
    .concat(profile?.profile_type ?? [])
    .concat(gatherStructuredApplicantHints(profile))
    .map(lc)
    .filter(Boolean);
  const found = new Set();

  // Applicant TYPE = WHO the applicant is. It comes from the DECLARED identity
  // (applicant_types / profile_type), never from free-text. Free text describes
  // NEEDS and CONTEXT — a student whose file mentions a parent's "military"
  // service, or a church whose mission mentions "education"/"community", is not
  // a veteran/school/government applicant. Augmenting the declared identity from
  // the blob was the root false-positive driver (veteran-only grants matched to
  // students; farm/government grants matched to a church). So:
  //   0. map EXACT canonical primary_type strings to their funding bucket(s)
  //      (authoritative — handles underscore multi-word types the synonym scan
  //      misses, e.g. volunteer_fire_department, food_pantry),
  //   1. canonicalize the EXPLICIT identity strings via synonyms (trusted), and
  //   2. ONLY when the profile declares no identity at all, fall back to a blob
  //      scan so a bare profile still searches something (never zero).
  const exactMapped = new Set();
  for (const e of explicit) {
    const mapped = PRIMARY_TYPE_TO_APPLICANT[e] ?? PRIMARY_TYPE_TO_APPLICANT[key(e)];
    if (mapped) {
      for (const bucket of mapped) found.add(bucket);
      exactMapped.add(e);
    }
  }
  for (const e of explicit) {
    if (APPLICANT_TYPE_SYNONYMS[e]) found.add(e); // already a canonical bucket
    // An exact canonical mapping is AUTHORITATIVE for its string — the fuzzy
    // synonym pass must not widen it ('homeschool_family' ⊃ "school" was
    // promoting a homeschool FAMILY into the org school bucket, surfacing
    // classroom-teacher funding like DonorsChoose it can never use).
    if (exactMapped.has(e)) continue;
    // Word-boundary matching on the underscore-normalized string — substring
    // includes() is the documented 13-bucket-explosion driver ('ets' inside
    // "targets", 'ems' inside "systems"); the same class applied here.
    const normalized = e.replace(/_/g, ' ');
    for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
      if (syns.some((s) => wordBoundaryMatch(normalized, s))) found.add(canon);
    }
  }
  // 1b. A FREE-TEXT declared org type ("Biotechnology / research organization")
  // that no exact map or synonym recognizes is still a DECLARED identity — it
  // must not fall through to the blob scan. The Axiom class (2026-07-06): the
  // fallback fired for exactly this shape and substring matching exploded to 13
  // applicant buckets ('ets' ⊂ "targets" → transitioning_service_member, 'ems'
  // ⊂ "systems" → vfd). Org-shaped declared text maps to the generic org
  // funding buckets; the match engine still scores actual relevance.
  if (found.size === 0 && explicit.some((e) => RE_ORG_SHAPED_TYPE.test(e))) {
    found.add('nonprofit');
    found.add('business');
  }
  if (found.size === 0) {
    // Fallback only — no declared identity at all. Infer from free text, with
    // WORD-BOUNDARY matching: substring includes() was the 13-bucket explosion
    // driver ('ets' inside "targets"/"assets", 'ems' inside "systems").
    for (const [canon, syns] of Object.entries(APPLICANT_TYPE_SYNONYMS)) {
      if (syns.some((s) => wordBoundaryMatch(blob, s))) found.add(canon);
    }
  }

  // Identity guard: a person/household primary identity must NOT carry
  // organizational applicant types (an individual is not an organization).
  // "high_school_student" CONTAINS "school", so detect person tokens with word
  // boundaries (+ a "student" catch-all) rather than a naive org-substring test.
  const primaryRaw = lc(profile?.primary_type ?? profile?.profile_type ?? profile?.type ?? '');
  const primaryKey = key(primaryRaw);
  const primaryIsIndividual =
    INDIVIDUAL_APPLICANT_TYPES.has(primaryRaw) ||
    INDIVIDUAL_APPLICANT_TYPES.has(primaryKey) ||
    primaryRaw.includes('student') ||
    /\b(individual|person|resident|family|household|parent|parents|caregiver|widow|widower|surviving spouse|surviving_spouse|patient|scholar|undergraduate|graduate|pupil|teacher|educator|candidate|politician|veteran|active duty|active_duty|servicemember|service member|national guard|guard_reserve|reservist|military spouse|transitioning service member)\b/.test(primaryRaw);
  if (primaryIsIndividual) {
    for (const t of [...found]) if (ORG_APPLICANT_TYPES.has(t)) found.delete(t);
    // A person applicant is an INDIVIDUAL applicant — ensure individual-eligible
    // opportunities still match even when the only declared subtype is e.g.
    // "student". This is a correct structural implication, not free-text noise.
    found.add('individual');
    // A structurally-declared FARMER (the occupation.farmer schema checkbox) is
    // an agricultural PRODUCER: USDA farm lanes (NRCS EQIP/CSP cost-share, FSA
    // beginning-farmer, conservation) serve individual producers, and stripping
    // the farm bucket planner-excluded them from their primary funding universe
    // (the Lowndes-County beginning-farmer class). A deliberate schema flag is
    // declared identity — not the free-text noise the guard exists to stop.
    if (hasStructuredFarmerFlag(profile)) found.add('farm');
  }

  // HIGH-PRECISION keyword safety net (ORG-class profiles only): pull in the
  // correct applicant bucket(s) for profiles whose TYPE is generic but whose
  // text unambiguously identifies them (e.g. type='organization' + mission
  // "volunteer fire department" → add 'vfd' so FEMA AFG fires). Additive only.
  const firedTriggers = detectKeywordApplicantTriggers(blob, primaryIsIndividual);
  for (const t of firedTriggers) {
    if (!found.has(t.add)) {
      found.add(t.add);
      if (Array.isArray(triggerCollector)) triggerCollector.push(t);
    } else if (Array.isArray(triggerCollector)) {
      triggerCollector.push({ ...t, already_present: true });
    }
  }

  // Structural implication: faith-based organizations (church / ministry) are
  // eligible for federal and foundation funding on the SAME basis as nonprofits
  // — grants.gov classifies faith-based orgs under its "Nonprofits" eligibility,
  // and HHS / CDBG / USDA community-facilities / FEMA programs are open to them.
  // Without this, a pure church/ministry profile (applicant_types=['church'])
  // is HARD-EXCLUDED from grants_gov + sam_gov at the planner (their
  // applicant_types omit church/ministry) → ZERO federal grants for a church,
  // a mission-rule violation ("hard boolean filters forbidden unless the source
  // is explicitly exclusive"; "avoid zero results"). We ADD nonprofit (keeping
  // the church/ministry identity tag) so federal/foundation sources fire; the
  // match engine still scores relevance, so this widens recall without flooding.
  if (!primaryIsIndividual && (found.has('church') || found.has('ministry'))) {
    found.add('nonprofit');
  }

  if (found.size === 0) found.add('individual'); // safe default; never zero
  return [...found];
}

function addNeedPhrase(found, phrase) {
  const text = lc(phrase).trim();
  if (!text) return;
  const token = key(text);
  if (NEED_KEYWORDS[token] || NEED_IMPLICATIONS[token]) found.add(token);
  // Whole-word matching only: plain includes() let fragments claim needs —
  // "parental support" derived a housing need because 'rent' ⊂ "parental",
  // the same substring-explosion class as the 13-bucket applicant-type case.
  // The underscore token is compared in its spaced form so multi-word canon
  // keywords ("food assistance") still match phrases keyed to underscores.
  const spacedToken = token.replace(/_+/g, ' ');
  for (const [canon, kws] of Object.entries(NEED_KEYWORDS)) {
    if (kws.some((k) => containsTermWholeWord(text, k) || containsTermWholeWord(spacedToken, key(k).replace(/_+/g, ' ')))) {
      found.add(canon);
    }
  }
}

function addProfileTypeDefaultNeeds(found, profile) {
  const explicitTypes = []
    .concat(profile?.primary_type ?? [])
    .concat(profile?.profile_type ?? [])
    .concat(profile?.type ?? [])
    .concat(profile?.applicant_types ?? [])
    .map(key)
    .filter(Boolean);
  for (const t of explicitTypes) {
    for (const need of PRIMARY_TYPE_DEFAULT_NEEDS[t] ?? []) addNeedPhrase(found, need);
  }
}

function applyNeedImplications(found) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [need, implied] of Object.entries(NEED_IMPLICATIONS)) {
      if (!found.has(need)) continue;
      for (const parent of implied) {
        if (!found.has(parent)) {
          found.add(parent);
          changed = true;
        }
      }
    }
  }
}

function deriveNeeds(profile, blob) {
  const explicit = []
    .concat(profile?.needs ?? [])
    .concat(profile?.need_categories ?? [])
    .map(lc)
    .filter(Boolean)
    // Bookkeeping tags mark HOW a profile is managed, not WHAT it needs —
    // 'designated'/'synthetic'/'individual' must never seed a need scan.
    .filter((e) => !RESERVED_PROFILE_TAGS.has(e) && !RESERVED_PROFILE_TAGS.has(key(e)));
  const found = new Set();
  for (const e of explicit) addNeedPhrase(found, e);
  // WHOLE-WORD blob scan. Substring includes() was the phantom-need driver:
  // 'rent' ⊂ "parent"/"current" → housing for nearly every profile, 'ets' ⊂
  // "targets"/"assets" → military_transition, 'sud' ⊂ "sudden" →
  // substance_recovery, 'coa' ⊂ "coach"/"coast" → tuition. Phantom needs are
  // doubly harmful on the need-anchored scale: they dilute the coverage
  // denominator for the profile's REAL needs and they spawn junk web queries.
  for (const [canon, kws] of Object.entries(NEED_KEYWORDS)) {
    if (kws.some((k) => containsTermWholeWord(blob, k))) found.add(canon);
  }
  if (found.size === 0) addProfileTypeDefaultNeeds(found, profile);
  applyNeedImplications(found);
  if ((found.has('veterans') || /\b(veteran|former service member|prior service|ex[-\s]?military|service-disabled)\b/i.test(blob)) &&
      (found.has('startup') || found.has('capital') || found.has('operations') || found.has('equipment'))) {
    found.add('veteran_startup');
  }
  if ((found.has('active_duty_support') || found.has('military_transition') || found.has('military_spouse_support') ||
      /\b(active duty|currently serving|servicemember|service member|national guard|reservist|military spouse|transitioning out|separating from service|ets)\b/i.test(blob)) &&
      (found.has('startup') || found.has('capital') || found.has('operations') || found.has('equipment'))) {
    found.add('military_startup');
  }
  applyNeedImplications(found);
  return [...found];
}

function normalizeState(state) {
  if (!state) return null;
  const s = String(state).trim();
  // 2-letter codes are uppercased; full names pass through unchanged.
  return s.length === 2 ? s.toUpperCase() : s;
}

function deriveLocation(profile) {
  const loc = profile?.location ?? profile?.address ?? {};
  const zip = loc.zip ?? loc.postal_code ?? profile?.zip ?? null;
  const city = loc.city ?? profile?.city ?? null;
  return {
    state: normalizeState(loc.state ?? loc.region ?? profile?.state ?? null),
    county: loc.county ?? profile?.county ?? null,
    zip,
    city,
    // Distinct towns within the product's 25-mile "local" radius of the ZIP.
    // City/county name tokens alone cannot reach a funder one town over (or
    // across a county/state line); the web-query builder searches these by name.
    nearby_cities: nearbyCities(zip, { excludeCity: city }),
  };
}

/**
 * buildThesis — derive the funding thesis from a profile.
 *
 * @param {object} profile
 * @returns {object} thesis
 */
export function buildThesis(profile = {}) {
  const blob = gatherText(profile);
  const keywordTriggers = [];
  const applicant_types = deriveApplicantTypes(profile, blob, keywordTriggers);
  const needs = deriveNeeds(profile, blob);
  const location = deriveLocation(profile);

  // Loans and cost-share are OFF unless the profile explicitly opts in. This is
  // the doctrine default: never surface loans as grants.
  const loan_allowed = profile?.allow_loans === true || profile?.preferences?.allow_loans === true;
  const cost_share_allowed =
    profile?.allow_cost_share === true || profile?.preferences?.allow_cost_share === true;

  const isStudent = applicant_types.includes('student') || Boolean(profile?.school);
  const isOrg = applicant_types.some((t) =>
    ['nonprofit', 'church', 'ministry', 'school', 'vfd', 'law_enforcement', 'business', 'farm', 'government', 'tribal'].includes(t));

  // Research-capable organization (the Axiom BioLabs archetype, 2026-07-06):
  // a biotech/life-science/R&D org whose funding universe (SBIR/STTR, federal
  // research solicitations, state innovation matching funds) is reached by
  // NONE of the generic org queries — the whole catalog had ZERO SBIR-class
  // rows because no lane ever searched for them. This flag is QUERY BREADTH
  // ONLY (like interest_terms — never used for scoring/eligibility), so a
  // text scan is safe here: worst case an org that merely mentions research
  // gets a few extra SBIR queries whose results still face the match gates.
  const RE_RESEARCH_ORG = /\b(biotech\w*|life sciences?|biomedical|bioscience|genomic(?:s)?|laborator(?:y|ies)|r&d|research (?:and development|organi[sz]ation|institute|laboratory))\b/i;
  // The DECLARED type text is the strongest research signal of all and is
  // deliberately excluded from the blob (identity fields are handled
  // structurally) — read it directly so "Biotechnology / research organization"
  // counts even when the narrative never repeats the word.
  const declaredTypeText = [profile?.profile_type, profile?.primary_type, profile?.type]
    .concat(profile?.applicant_types ?? [])
    .filter((v) => typeof v === 'string')
    .join(' ');
  const is_research_org = isOrg && (RE_RESEARCH_ORG.test(declaredTypeText) || RE_RESEARCH_ORG.test(blob));
  // The concrete research TOPIC for query building ("biotechnology", "genomics"
  // ...), extracted from the declared type first, then the profile's own text,
  // so the SBIR queries search the org's actual field. Never trusts tag
  // ordering (see RESERVED_PROFILE_TAGS).
  const RE_RESEARCH_TOPIC = /\b(biotechnology|biotech|genomics?|bioinformatics|genetic engineering|life sciences?|biomedical(?: research)?|pharmaceutical|biopharmaceutical|bioscience)\b/i;
  const research_topic = is_research_org
    ? ((declaredTypeText.match(RE_RESEARCH_TOPIC)?.[1] ?? blob.match(RE_RESEARCH_TOPIC)?.[1])?.toLowerCase() ?? 'biotechnology')
    : null;

  // Free-text interest / field-of-study / career-goal / talent seeds the applicant
  // entered (major, intended career, demographic scholarship tags). These do NOT
  // affect matching — they are ONLY searchable seeds for the open-web query
  // builder, so a student reaches field-specific scholarships (e.g. "nursing
  // scholarships") instead of only generic ones. Deduped against needs/types and
  // bounded so a verbose profile can't explode the query set.
  // DERIVED FIRST, MINED SECOND. `derived_interest_terms` is the ranked,
  // provenanced read of the profile's OWN topical statements
  // (`config/profileDerivedFacts.js`) — declared major, then declared education
  // interests, then curated programs/services topics. The `tags` fallback below
  // is the legacy mined bag and is UNRANKED: taking `.slice(0, 12)` of it spent
  // a forensic-science student's entire topical budget on her first name and
  // twelve gender synonyms (measured in prod 2026-08-02). Derived terms are
  // placed first so the bound truncates the WEAKEST evidence, never the major.
  const derivedTerms = Array.isArray(profile?.derived_interest_terms)
    ? profile.derived_interest_terms
    : [];
  const interest_terms = [...new Set(
    []
      .concat(derivedTerms)
      .concat(profile?.tags ?? [])
      .concat(profile?.interests ?? [])
      .concat(profile?.keywords ?? [])
      .map((t) => String(t ?? '').trim().toLowerCase())
      .filter(Boolean)
      .filter((t) => t.length > 2 && t.length < 40)
      .filter((t) => !needs.includes(t) && !applicant_types.includes(t))
      // System/bookkeeping tags are NOT topics. 'designated' (owner-profile
      // marker) and 'source-safe' leaked in as interests[0] and became the
      // web-query topic ("SBIR STTR designated solicitation") — garbage in,
      // garbage searched. Generic entity words carry no topical signal either.
      .filter((t) => !RESERVED_PROFILE_TAGS.has(t)),
  )].slice(0, 12);

  return {
    profile_id: profile?.id ?? profile?.profile_id ?? null,
    applicant_types,
    needs,
    location,
    loan_allowed,
    cost_share_allowed,
    is_student: isStudent,
    is_org: isOrg,
    is_research_org,
    research_topic,
    // Structured eligibility facts the canonical engine's hard gates need but
    // the thesis previously dropped (the OS match path passes no sections, so
    // a 73-year-old's age-contradicted foster-youth program could never
    // hard-gate — it REVIEW-capped as "status unknown" instead).
    age: Number.isFinite(Number(profile?.age)) ? Number(profile.age) : null,
    has_foster_indicator: hasStructuredFosterFlag(profile),
    school: profile?.school ?? null,
    // Concrete institution / field-of-study / employer seeds — the highest-signal
    // way to reach institution-specific endowments/departmental scholarships and
    // employer education programs (findable ONLY by name). Breadth seeds for the
    // open-web query builder; never used for scoring. See buildWebQueries.
    schools: Array.isArray(profile?.schools)
      ? profile.schools.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 3)
      : [],
    field_of_study: profile?.field_of_study ? String(profile.field_of_study).trim() : null,
    employer: profile?.employer ? String(profile.employer).trim() : null,
    // Match floor / slider. Individuals get a slightly lower floor so they are
    // not starved; the planner/match engine can override per-run.
    min_match_score: Number.isFinite(profile?.min_match_score)
      ? profile.min_match_score
      : (isOrg ? 60 : 55),
    // Searchable keyword seeds (deduped) for the planner's query builders.
    // Research orgs add the terms that reach SBIR/STTR and research NOFOs in
    // the structured feeds (grants.gov keyword search) — absent these, a
    // biotech org's federal query set looks identical to a food pantry's.
    keywords: [...new Set([
      ...needs,
      ...applicant_types,
      ...(is_research_org ? ['sbir', 'biotechnology', 'research'] : []),
    ])],
    // Field-of-study / interest seeds for the open-web query builder (breadth
    // only; never used for scoring). See buildWebQueries.
    interest_terms,
    // The derived-fact set with provenance, carried through so LANE SELECTION
    // (planner.plan) reads the same derivation the query builder does.
    derived_facts: profile?.derived_facts ?? null,
    // Which high-precision identity phrases (if any) pulled in an applicant
    // bucket from free text — surfaced so the crawler-plan explainer / Anya can
    // show WHY a source fired (e.g. "FEMA AFG fired because the mission text
    // says 'volunteer fire department'"). Empty for individuals and for
    // profiles whose declared type already covered everything.
    keyword_triggers: keywordTriggers,
    raw_profile_present: Boolean(profile && Object.keys(profile).length),
  };
}

export default { buildThesis };
