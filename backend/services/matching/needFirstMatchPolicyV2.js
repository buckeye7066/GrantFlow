import { REVIEW_SCORE, SCORE_FLOOR } from '../../config/matchThresholds.js'

const RESOURCE_KINDS = new Set([
  'DIRECTORY',
  'PAST_AWARD_INTEL',
  'SCHOOL_PORTAL',
  'REFERRAL',
])

const SCHOLARSHIP_TERMS = /\b(scholarship|fellowship|tuition|student aid|education award|educational award)\b/i
const BENEFIT_TERMS = /\b(benefit|assistance|relief|subsidy|voucher|medicaid|medicare|ssi|ssdi|snap|wic|tanf|liheap|section 8|housing choice)\b/i
const BUSINESS_APPLICANT_TERMS = /\b(small business(?:es)?|business owners?|entrepreneurs?|startup companies?|commercial enterprises?|farmers?|ranchers?|agricultural producers?)\b/i
const ORGANIZATION_APPLICANT_TERMS = /\b(nonprofits?|non-profit organizations?|churches|ministries|school districts?|municipalities|local governments?|research institutions?)\b/i
const FUNDING_ACTION_TERMS = /\b(grant|award|funding|financial assistance|benefit|relief|scholarship|fellowship|tuition)\b/i

const INSTITUTION_WORDS = new Set([
  'university', 'college', 'school', 'institute', 'academy', 'campus',
  'the', 'of', 'at', 'and', 'for',
])

const GENERIC_EDUCATION_SPONSORS = /\b(college board|scholarship america|bold\.?org|fastweb|scholarships?\.com|student aid|department of education|financial aid office|scholarship directory)\b/i

const STUDENT_TYPES = new Set([
  'student',
  'high_school_student',
  'college_student',
  'graduate_student',
  'undergraduate_student',
  'adult_learner',
])

const BUSINESS_TYPES = new Set([
  'business',
  'small_business',
  'minority_owned_business',
  'women_owned_business',
  'farm',
])

const ORGANIZATION_TYPES = new Set([
  'organization',
  'nonprofit',
  'church',
  'ministry',
  'school',
  'public_school',
  'school_district',
  'municipality',
  'county_government',
  'public_agency',
  'tribal_government',
  'library',
])

const PROFESSION_RULES = Object.freeze([
  {
    id: 'nursing',
    label: 'nursing',
    opportunity: /\b(nurs(?:e|es|ing)|rn\b|lpn\b|nclex)\b/i,
    profile: /\b(nurs(?:e|es|ing)|rn\b|lpn\b|nclex)\b/i,
  },
  {
    id: 'ems',
    label: 'EMS/EMT/paramedic',
    opportunity: /\b(naemt|emt|aemt|paramedic|emergency medical services?|ems professional|first responder scholarship)\b/i,
    profile: /\b(emt|aemt|paramedic|emergency medical services?|ems\b|first responder)\b/i,
  },
  {
    id: 'chiropractic',
    label: 'chiropractic',
    opportunity: /\b(chiropractic|chiropractor|doctor of chiropractic)\b/i,
    profile: /\b(chiropractic|chiropractor|doctor of chiropractic)\b/i,
  },
  {
    id: 'medical_school',
    label: 'medical-school',
    opportunity: /\b(medical student|medical school|school of medicine|md program|osteopathic medical)\b/i,
    profile: /\b(medical student|medical school|medicine|pre[- ]?med|physician|md program|osteopathic)\b/i,
  },
  {
    id: 'dental',
    label: 'dental',
    opportunity: /\b(dental student|dentistry|dental hygien|dds program|dmd program)\b/i,
    profile: /\b(dental|dentistry|dental hygien|dds|dmd)\b/i,
  },
  {
    id: 'teaching',
    label: 'teaching/education profession',
    opportunity: /\b(teacher scholarship|educator grant|classroom grant|future teachers?|teaching credential)\b/i,
    profile: /\b(teacher|educator|teaching|education major|classroom)\b/i,
  },
  {
    id: 'law',
    label: 'law/legal profession',
    opportunity: /\b(law student|law school|legal studies|attorney scholarship|bar association scholarship|juris doctor)\b/i,
    profile: /\b(law student|law school|legal studies|attorney|lawyer|juris doctor|jd program)\b/i,
  },
  {
    id: 'welding_trade',
    label: 'welding/skilled trade',
    opportunity: /\b(welding|welder|skilled trades?|trade school|vocational trades?|hvac|machining)\b/i,
    profile: /\b(welding|welder|skilled trade|trade school|vocational|hvac|machining)\b/i,
  },
  {
    id: 'agriculture',
    label: 'agriculture/farming',
    opportunity: /\b(agriculture|agricultural|farmer|farming|rancher|livestock|crop science|ffa scholarship)\b/i,
    profile: /\b(agriculture|agricultural|farmer|farming|rancher|livestock|crop science|ffa)\b/i,
  },
  {
    id: 'veterinary',
    label: 'veterinary',
    opportunity: /\b(veterinary|veterinarian|vet school|animal medicine)\b/i,
    profile: /\b(veterinary|veterinarian|vet school|animal medicine)\b/i,
  },
])

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value.answers && typeof value.answers === 'object' ? value.answers : value
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value instanceof Set) return [...value]
  if (value === null || value === undefined || value === '') return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Fall through to delimiter splitting.
      }
    }
    return trimmed.split(/[,;|\n]+/).map((entry) => entry.trim()).filter(Boolean)
  }
  return [value]
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Must be declared before normalizeTextPreservingFragmentSeparator / signalText
// (eslint no-use-before-define). Pipe is not a word character — see joinTextFragments.
export const TEXT_FRAGMENT_SEPARATOR = ' | '

function normalizeTextPreservingFragmentSeparator(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9|]+/g, ' ')
    .replace(/\s*\|\s*/g, TEXT_FRAGMENT_SEPARATOR)
    .replace(/\s+/g, ' ')
    .trim()
}

function signalText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined || value === false) return ''
  if (value === true) return 'true'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((entry) => signalText(entry, depth + 1)).filter(Boolean).join(TEXT_FRAGMENT_SEPARATOR)
  if (typeof value === 'object') {
    const source = value.answers && typeof value.answers === 'object' ? value.answers : value
    const parts = []
    for (const [key, entry] of Object.entries(source)) {
      if (entry === true) parts.push(key.replace(/_/g, ' '))
      else {
        const text = signalText(entry, depth + 1)
        if (text) parts.push(text)
      }
    }
    return parts.join(TEXT_FRAGMENT_SEPARATOR)
  }
  return ''
}

/**
 * Independent text fragments are joined with a PHRASE BOUNDARY, never a bare
 * space.
 *
 * WHY THIS EXISTS — the 2026-08-01 golden-outcome regression. Every rule below
 * that gates on a MULTI-WORD phrase (`family caregiver`, `respite care`,
 * `child care`, `foster youth`, `international students only`, the PROFESSION
 * and death-survivor patterns) is `.test()`ed against ONE string built by
 * joining independent fragments — a bare-space join makes the
 * boundary between two INDEPENDENT list members indistinguishable from the
 * space inside a real phrase, so any two adjacent tokens silently fabricate a
 * phrase no source ever wrote.
 *
 * It fired in prod on the owner-verified ECF CHOICES profiles. The
 * `tn_ecf_choices` registry row declares `applicant_types: ['individual',
 * 'family', 'veteran', 'disabled', 'caregiver']`, which `crawler-os/matchEngine
 * .opportunityToCanonicalOpportunity` folds into
 * `categories: [... 'family', 'caregiver']`. Joined with a space that is the
 * literal substring `"family caregiver"` → `hardMismatches` →
 * `decision: REJECT` → `crawlerOsPersistenceCore` drops the row (`decision ===
 * 'reject' → continue`) → the match store, which is a ROLLING SNAPSHOT, loses
 * it on the profile's next crawl. Measured 2026-08-01: **0** match rows for
 * `tn_ecf_choices` fleet-wide against 13 ACTIVE catalog rows and a lane
 * reporting `failed:false, found:13` minutes earlier; all 13 candidates score
 * REJECT with "Caregiver-only program requires a caregiver signal", and every
 * one of them is a Tennessee Medicaid-waiver page for the exact profiles that
 * the lane exists to serve.
 *
 * A `|` cannot appear inside any pattern here and is not a `\w` character, so
 * `\b` anchors either side of a real phrase still behave exactly as before —
 * the ONLY strings this removes are ones that span a fragment boundary, i.e.
 * ones no source ever published. This LOWERS no bar: a genuine
 * "Family Caregiver Support Program" still carries the phrase inside its own
 * title/description and is still hard-matched.
 *
 * NOT FIXED HERE (reported, no prod evidence of a live miss): the PROFILE side
 * (`profilePurposeText`/`signalText`) has the same shape, but its output is
 * passed through `normalizeText`, which strips `|` — fixing it needs
 * per-fragment normalization and its own evidence, so it is deliberately left
 * alone rather than changed blind.
 */
function joinTextFragments(parts) {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(TEXT_FRAGMENT_SEPARATOR)
}

function opportunityText(opportunity = {}) {
  return joinTextFragments([
    opportunity.title,
    opportunity.name,
    opportunity.sponsor,
    opportunity.funder,
    opportunity.description,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.eligibility_text,
    opportunity.eligibility_criteria,
    opportunity.restrictions,
    opportunity.opportunity_kind,
    opportunity.opportunity_type,
    opportunity.funding_type,
    ...asArray(opportunity.categories),
    ...asArray(opportunity.keywords),
  ])
}

function opportunityTargetingText(opportunity = {}) {
  return joinTextFragments([
    opportunity.title,
    opportunity.name,
    opportunity.description,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.eligibility_text,
    opportunity.eligibility_criteria,
    opportunity.restrictions,
    ...asArray(opportunity.categories),
    ...asArray(opportunity.keywords),
  ])
}

export function isNeedFirstResource(opportunity = {}, oppNorm = null) {
  const kind = String(
    opportunity.opportunity_kind ?? opportunity.opportunity_type ?? opportunity.type ?? '',
  ).trim().toUpperCase()
  const fundingType = String(opportunity.funding_type ?? '').trim().toLowerCase()
  return Boolean(
    oppNorm?.isDirectory ||
    opportunity.is_directory === true ||
    opportunity.is_directory_resource === true ||
    RESOURCE_KINDS.has(kind) ||
    fundingType === 'referral_service'
  )
}

function schoolTokens(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token && !INSTITUTION_WORDS.has(token))
}

function acronym(value) {
  const words = normalizeText(value)
    .split(' ')
    .filter((word) => word && !['the', 'of', 'at', 'and', 'for'].includes(word))
  return words.map((word) => word[0]).join('')
}

function sameSchool(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  if (/^[a-z0-9]{2,10}$/.test(a) && acronym(b) === a) return true
  if (/^[a-z0-9]{2,10}$/.test(b) && acronym(a) === b) return true

  const at = new Set(schoolTokens(a))
  const bt = new Set(schoolTokens(b))
  if (at.size === 0 || bt.size === 0) return false
  let overlap = 0
  for (const token of at) if (bt.has(token)) overlap += 1
  return overlap / Math.max(at.size, bt.size) >= 0.67
}

function uniqueNames(values) {
  const out = []
  for (const value of values.flatMap(asArray)) {
    const name = typeof value === 'object'
      ? value?.name ?? value?.school_name ?? value?.institution
      : value
    const text = String(name ?? '').trim()
    if (!text || out.some((existing) => sameSchool(existing, text))) continue
    out.push(text)
  }
  return out
}

export function collectProfileSchools(profileContext = {}, profileNorm = null) {
  const sections = profileContext?.sections ?? {}
  const education = asObject(sections.education)
  const basic = asObject(sections.basic_information)
  const applicationsSection = asObject(sections.university_applications)
  const applications = Array.isArray(applicationsSection.applications)
    ? applicationsSection.applications
    : []

  const committedStatuses = new Set(['committed', 'enrolled', 'attending', 'matriculated'])
  const acceptedStatuses = new Set(['accepted', 'admitted'])
  const committed = uniqueNames(applications
    .filter((application) => committedStatuses.has(String(application?.status ?? '').toLowerCase()))
    .map((application) => application?.name ?? application?.school_name))
  const accepted = uniqueNames(applications
    .filter((application) => acceptedStatuses.has(String(application?.status ?? '').toLowerCase()))
    .map((application) => application?.name ?? application?.school_name))
  const current = uniqueNames([
    education.current_institution,
    education.current_college,
    education.current_school,
    basic.current_school,
    profileNorm?.education?.currentInstitution,
  ])
  const target = uniqueNames([
    education.target_colleges,
    profileNorm?.education?.targetColleges,
    applications.map((application) => application?.name ?? application?.school_name),
  ])
  const preCommit = uniqueNames([...current, ...accepted, ...target])

  return {
    committed,
    accepted,
    current,
    target,
    authoritative: committed.length > 0 ? committed : preCommit,
  }
}

function institutionCandidate(opportunity = {}, text = '') {
  if (!SCHOLARSHIP_TERMS.test(text)) return null
  const sponsor = String(opportunity.sponsor ?? opportunity.funder ?? '').trim()
  const title = String(opportunity.title ?? opportunity.name ?? '').trim()
  const schoolLike = /\b(university|college|school of|institute(?: of technology)?|academy)\b/i

  if (sponsor && schoolLike.test(sponsor) && !GENERIC_EDUCATION_SPONSORS.test(sponsor)) {
    return { name: sponsor, confidence: 'strong', source: 'sponsor' }
  }

  const prefix = title.match(/^(.{2,140}?)(?=\b(?:scholarship|fellowship|tuition|grant|award)\b)/i)?.[1]
    ?.replace(/[\s:–—-]+$/, '')
    ?.trim()
  if (!prefix || GENERIC_EDUCATION_SPONSORS.test(prefix)) return null
  if (schoolLike.test(prefix) || /^[A-Z0-9]{2,10}$/.test(prefix)) {
    return { name: prefix, confidence: 'weak', source: 'title' }
  }
  return null
}

function profilePurposeText(profileContext = {}, profileNorm = null) {
  const sections = profileContext?.sections ?? {}
  const selected = {
    education: sections.education,
    occupation: sections.occupation,
    employment: sections.employment,
    programs_services: sections.programs_services,
    military_service: sections.military_service,
    family_life: sections.family_life,
    government_assistance: sections.government_assistance,
    health_medical: sections.health_medical,
    demographics: sections.demographics,
  }
  return normalizeText([
    signalText(selected),
    signalText(profileNorm?.education),
    signalText(profileNorm?.academics),
    signalText(profileNorm?.occupation),
    signalText(profileNorm?.industry),
    signalText(profileNorm?.needCategories),
    signalText(profileNorm?.effectiveFacets),
  ].join(' '))
}

function profileType(profileContext = {}, profileNorm = null) {
  return normalizeText(
    profileNorm?.entityType ??
    profileContext?.profile?.applicant_type ??
    profileContext?.profile?.primary_type ??
    profileContext?.profile?.profile_type ??
    '',
  ).replace(/ /g, '_')
}

function profileIsStudent(profileContext = {}, profileNorm = null) {
  return Boolean(profileNorm?.isStudent || STUDENT_TYPES.has(profileType(profileContext, profileNorm)))
}

function profileIsBusiness(profileContext = {}, profileNorm = null) {
  return Boolean(profileNorm?.isBusiness || BUSINESS_TYPES.has(profileType(profileContext, profileNorm)))
}

function profileIsOrganization(profileContext = {}, profileNorm = null) {
  return Boolean(
    profileNorm?.isNonprofit || profileNorm?.isBusiness ||
    ORGANIZATION_TYPES.has(profileType(profileContext, profileNorm))
  )
}

function profileHasChildrenOrPregnancy(profileContext = {}, profileNorm = null) {
  const family = asObject(profileContext?.sections?.family_life ?? profileContext?.sections?.family)
  const demographics = asObject(profileContext?.sections?.demographics)
  const health = asObject(profileContext?.sections?.health_medical)
  return Boolean(
    profileNorm?.hasChildren ||
    family.has_children === true ||
    family.is_parent === true ||
    demographics.is_parent === true ||
    Number(family.number_of_children ?? family.number_of_dependents ?? family.num_dependents ?? 0) > 0 ||
    family.expecting_child === true ||
    health.pregnant === true ||
    health.pregnancy === true ||
    demographics.pregnant === true
  )
}

function profileIsCaregiver(profileContext = {}, profileNorm = null) {
  const family = asObject(profileContext?.sections?.family_life ?? profileContext?.sections?.family)
  const demographics = asObject(profileContext?.sections?.demographics)
  return Boolean(
    profileNorm?.isCaregiver ||
    family.caregiver === true ||
    family.is_caregiver === true ||
    demographics.is_caregiver === true ||
    demographics.caregiver_status === true ||
    /\bcaregiver\b/i.test(String(demographics.caregiver_status ?? ''))
  )
}

function profileHasSurvivorSignal(profileContext = {}, profileNorm = null) {
  const family = asObject(profileContext?.sections?.family_life ?? profileContext?.sections?.family)
  const military = asObject(profileContext?.sections?.military_service)
  return Boolean(
    family.widow_widower || family.orphan || family.surviving_spouse ||
    military.gold_star_family || military.surviving_spouse ||
    profileNorm?.isWidow || profileNorm?.isOrphan
  )
}

function profileHasInternationalSignal(profileContext = {}, profileNorm = null) {
  const demographics = asObject(profileContext?.sections?.demographics)
  const status = normalizeText(
    demographics.immigrant_status ??
    demographics.citizenship_status ??
    profileNorm?.immigrationStatus,
  )
  return Boolean(
    profileNorm?.isImmigrant || profileNorm?.isInternationalStudent ||
    demographics.is_refugee_or_immigrant === true ||
    demographics.is_international_student === true ||
    /international|foreign student|non citizen|noncitizen|visa|refugee|asylee/.test(status)
  )
}

function profileHasFosterSignal(profileContext = {}, profileNorm = null) {
  const family = asObject(profileContext?.sections?.family_life ?? profileContext?.sections?.family)
  const demographics = asObject(profileContext?.sections?.demographics)
  return Boolean(
    profileNorm?.hasFosterIndicator ||
    family.foster_youth === true ||
    family.former_foster_youth === true ||
    demographics.foster_care_alumni === true ||
    demographics.former_foster_youth === true ||
    demographics.in_foster_care === true
  )
}

function matchedPointSummary(dataPointEval = {}) {
  const matched = Array.isArray(dataPointEval?.matched) ? dataPointEval.matched : []
  const kinds = new Set()
  let needCredit = 0
  let declaredProgramCredit = 0
  for (const point of matched) {
    const kind = String(point?.kind ?? '')
    const credit = Number(point?.credit ?? 0) || 0
    if (kind) kinds.add(kind)
    if (kind === 'need') needCredit += credit
    if (point?.via === 'declared_program') declaredProgramCredit += credit
  }
  return { matched, kinds, needCredit, declaredProgramCredit }
}

// "young people who spent their teen years in foster care", "youth from
// foster care", "foster care alumni" — the Foster Care to Success class,
// stored at REVIEW 67 for a student whose family section states no foster
// history (2026-09-05).
const FOSTER_PROGRAM_RX = /\b(foster youth|former foster youth|aged out of foster care|chafee|education and training voucher|foster care (?:alumni|to success)|(?:youth|young people|young adults|students?|children|teens?)[^.]{0,30}\b(?:from|in|out of) foster care|(?:were|are|have been|spent[^.]{0,20}) in foster care)\b/i

function deathSurvivorRestriction(text) {
  return /\b(surviving spouses?|surviving (?:children|child|families|family members?|dependents?)|widow(?:er)?s?|orphan benefit|death benefit|gold star)\b/i.test(text) ||
    (/\bsurvivor benefits?\b/i.test(text) && /\b(social security|ssa|death|deceased)\b/i.test(text)) ||
    // "for students whose parent or guardian died as a result of military
    // service in Iraq or Afghanistan" — the Iraq and Afghanistan Service Grant
    // class, which reached an 18-year-old whose profile states no such loss.
    /\b(?:parent|guardian|spouse)s?\b[^.]{0,40}\b(?:died|deceased|killed)\b/i.test(text) ||
    /\b(?:died|killed)\b[^.]{0,30}\b(?:as a result of|in the line of|while (?:serving|on active duty))\b/i.test(text)
}

/**
 * POSITIVE-FACT population rules. Each returns a mismatch string ONLY when the
 * profile positively states a fact that makes the program impossible for it —
 * never on silence (G4: missing is neutral). A resource/benefit/directory is
 * held to the same rules as direct funding: a person facing eviction who is
 * handed the Eldercare Locator, a survivors-benefit page, or a homeschool
 * grant is worse served than one handed nothing (the 2026-09-05 student crawl
 * that stored all four at REVIEW).
 */
const OLDER_ADULT_PROGRAM_RX = /\b(older adults?|senior citizens?|elderly|eldercare|aging services|area agency on aging|age(?:d)? (?:60|62|65)\+?(?: and older| or older| and over)?|adults? (?:60|62|65) (?:and|or) older|medicare(?! advantage plan for the disabled))\b/i
const YOUTH_SENIOR_RX = /\b(high school|graduating|college|university|class of \d{4}) seniors?\b|\bsenior (?:year|thesis|project|design)\b/i
const HOMEOWNER_PROGRAM_RX = /\b(foreclosure|mortgage (?:assistance|relief|help|payments?|forbearance)|homeowners?(?:'|’)? (?:assistance|relief|grants?|repair)|home ?repair (?:grants?|assistance|loans?)|property tax (?:relief|exemption))\b/i
const HOMESCHOOL_PROGRAM_RX = /\bhome ?school(?:ing|ers?|ed)?\b/i

function profileAgeYears(profileContext = {}, profileNorm = null) {
  const explicit = Number(profileNorm?.age)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const basic = asObject(profileContext?.sections?.basic_information)
  const demographics = asObject(profileContext?.sections?.demographics)
  const stated = Number(basic.age ?? demographics.age)
  if (Number.isFinite(stated) && stated > 0) return stated
  const dob = Date.parse(String(basic.date_of_birth ?? demographics.date_of_birth ?? ''))
  if (!Number.isFinite(dob)) return null
  return Math.floor((Date.now() - dob) / (365.25 * 24 * 60 * 60 * 1000))
}

function profileIsOlderAdult(profileContext = {}, profileNorm = null) {
  const type = profileType(profileContext, profileNorm)
  if (type === 'senior' || type === 'elderly' || type === 'retiree') return true
  const demographics = asObject(profileContext?.sections?.demographics)
  const ageGroup = normalizeText(demographics.age_group ?? '')
  if (/senior|older adult|elder/.test(ageGroup)) return true
  const age = profileAgeYears(profileContext, profileNorm)
  return Number.isFinite(age) && age >= 60
}

/** Age is POSITIVELY known and below the older-adult line. */
function profileProvablyNotOlderAdult(profileContext = {}, profileNorm = null) {
  if (profileIsOlderAdult(profileContext, profileNorm)) return false
  const age = profileAgeYears(profileContext, profileNorm)
  return Number.isFinite(age) && age < 60
}

function profileHousingStatus(profileContext = {}) {
  const housing = asObject(profileContext?.sections?.housing)
  const basic = asObject(profileContext?.sections?.basic_information)
  return normalizeText(housing.status ?? housing.housing_status ?? housing.tenure ?? basic.housing_status ?? '')
}

/** Housing tenure is POSITIVELY stated and is not ownership. */
function profileProvablyNotHomeowner(profileContext = {}, profileNorm = null) {
  const housing = asObject(profileContext?.sections?.housing)
  if (housing.owns_home === true || housing.homeowner === true || housing.is_homeowner === true || profileNorm?.isHomeowner) return false
  const status = profileHousingStatus(profileContext)
  if (!status) return false
  if (/\b(own|owner|owned|mortgage|homeowner)\b/.test(status)) return false
  return /\b(rent|renting|renter|tenant|with family|with parents|with relatives|family|dorm|campus|student housing|shelter|homeless|transitional|temporary|couch)\b/.test(status)
}

/** The profile declares a non-homeschool education path (school named, or a college/university/public/community type). */
function profileProvablyNotHomeschooled(profileContext = {}) {
  const education = asObject(profileContext?.sections?.education)
  if (education.homeschool === true || education.homeschooled === true || education.is_homeschooled === true) return false
  const schools = Array.isArray(education.schools) ? education.schools : (education.schools ? [education.schools] : [])
  const declared = [
    education.current_institution, education.school, education.school_name, education.high_school,
    ...schools.map((school) => [school?.name, school?.type].filter(Boolean).join(' ')),
  ].filter(Boolean).map((v) => normalizeText(String(v)))
  if (declared.length === 0) return false
  if (declared.some((v) => /home ?school/.test(v))) return false
  return declared.some((v) => /\b(college|university|community college|public|high school|academy|institute|state)\b/.test(v) || v.length > 3)
}

const MILITARY_TERMS = '(?:veterans?|service ?members?|military (?:families|family|spouses?|dependents?|members?|personnel)|active[- ]duty|national guard|reservists?|gold star)'
const MILITARY_TITLE_RX = new RegExp(`\\b${MILITARY_TERMS}\\b`, 'i')
const MILITARY_RESTRICTION_RX = new RegExp(`\\b(?:for|only for|exclusively for|serving|supports?|restricted to|available to)\\s+(?:the\\s+)?(?:u\\.?s\\.?\\s+)?${MILITARY_TERMS}\\b`, 'i')
const REFUGEE_TERMS = '(?:refugees?|asylees?|asylum seekers?|resettlement|newly arrived|newcomers?)'
const REFUGEE_TITLE_RX = new RegExp(`\\b${REFUGEE_TERMS}\\b`, 'i')
const REFUGEE_RESTRICTION_RX = new RegExp(`\\b(?:for|only for|exclusively for|serving|supports?|restricted to|available to)\\s+${REFUGEE_TERMS}\\b`, 'i')
const FARMER_TERMS = '(?:beginning farmers?|farmers? and ranchers?|agricultural producers?|farm (?:loans?|grants?|operations?)|ranchers?)'
const FARMER_TITLE_RX = new RegExp(`\\b${FARMER_TERMS}\\b`, 'i')
const FARMER_RESTRICTION_RX = new RegExp(`\\b(?:for|only for|exclusively for|serving|supports?|restricted to|available to)\\s+${FARMER_TERMS}\\b`, 'i')

function opportunityTitleText(opportunity = {}) {
  return String(opportunity?.title ?? opportunity?.name ?? '')
}

/** Military affiliation is POSITIVELY denied across every flag the section carries. */
function profileProvablyNotMilitary(profileContext = {}, profileNorm = null) {
  if (profileNorm?.isVeteran || profileNorm?.isMilitary || profileNorm?.isMilitarySpouse) return false
  const military = asObject(profileContext?.sections?.military_service)
  const flags = ['veteran', 'is_veteran', 'active_duty', 'is_active_duty', 'military_spouse', 'is_military_spouse',
    'military_dependent', 'is_military_dependent', 'gold_star_family', 'guard_reserve', 'is_guard_reserve', 'reservist']
  const stated = flags.filter((flag) => military[flag] === true || military[flag] === false)
  if (stated.length === 0) return false
  if (stated.some((flag) => military[flag] === true)) return false
  const status = normalizeText(military.military_status ?? military.service_status ?? military.status ?? '')
  return !/veteran|active|guard|reserve|spouse|dependent/.test(status)
}

/** Citizenship/immigration status is POSITIVELY stated and is not a refugee/asylee status. */
function profileProvablyNotRefugee(profileContext = {}, profileNorm = null) {
  if (profileNorm?.isRefugee) return false
  const demographics = asObject(profileContext?.sections?.demographics)
  if (demographics.is_refugee === true || demographics.is_asylee === true || demographics.is_refugee_or_immigrant === true) return false
  const status = normalizeText([demographics.immigrant_status, demographics.citizenship_status, demographics.citizenship].filter(Boolean).join(' '))
  if (!status) return false
  return !/refugee|asylee|asylum|resettl|newcomer|parolee/.test(status)
}

/** The occupation section POSITIVELY denies farming. */
function profileProvablyNotFarmer(profileContext = {}, profileNorm = null) {
  if (profileNorm?.isFarmer || profileNorm?.isBusiness) return false
  const occupation = asObject(profileContext?.sections?.occupation)
  if (occupation.farmer === true || occupation.rancher === true || occupation.agricultural_producer === true) return false
  return occupation.farmer === false || occupation.rancher === false || occupation.agricultural_producer === false
}

/**
 * Programs whose NAME is the eligibility statement: a Katie Beckett waiver
 * serves children under 18 with disabilities, full stop. A disabled 62+ senior
 * was handed "Katie Beckett Program" at ACCEPT 89 (2026-09-05) because the
 * enumerated TennCare sub-page carried no eligibility text for the engine to
 * read. The profile's age is a positive fact; silence on age stays neutral.
 */
const CHILD_ONLY_PROGRAM_RX = /\bkatie beckett\b|\b(?:children|kids|youth|minors)\s+(?:under|below|younger than)\s+(?:age\s+)?(?:18|19|21)\b|\bunder (?:age )?18 (?:with|who)\b|\bpediatric\b/i

function profileProvablyAdult(profileContext = {}, profileNorm = null) {
  const age = profileAgeYears(profileContext, profileNorm)
  if (Number.isFinite(age)) return age >= 19
  if (profileIsOlderAdult(profileContext, profileNorm)) return true
  const demographics = asObject(profileContext?.sections?.demographics)
  const group = normalizeText(demographics.age_group ?? demographics.age_range ?? '')
  if (!group) return false
  return /senior|older adult|elder|retire|adult|6[0-9]\s*\+|[2-9][0-9]\s*(?:-|to)\s*[2-9][0-9]/.test(group) && !/youth|child|teen|minor|under 18/.test(group)
}

function positivePopulationMismatches(profileContext, profileNorm, targetingText, opportunity = {}) {
  const out = []
  const title = opportunityTitleText(opportunity)
  if (CHILD_ONLY_PROGRAM_RX.test(`${title} ${targetingText}`) && profileProvablyAdult(profileContext, profileNorm)) {
    out.push('Program serves children under 18; the profile states an adult age')
  }
  if ((MILITARY_TITLE_RX.test(title) || MILITARY_RESTRICTION_RX.test(targetingText)) &&
      !/\b(civilian|everyone|all applicants|general public|and their families)\b/i.test(title) &&
      profileProvablyNotMilitary(profileContext, profileNorm)) {
    out.push('Military/veteran program does not fit a profile whose military section states no service, spouse, or dependent affiliation')
  }
  if ((REFUGEE_TITLE_RX.test(title) || REFUGEE_RESTRICTION_RX.test(targetingText)) &&
      profileProvablyNotRefugee(profileContext, profileNorm)) {
    out.push('Refugee/asylee program does not fit a profile that states a non-refugee citizenship or immigration status')
  }
  if ((FARMER_TITLE_RX.test(title) || FARMER_RESTRICTION_RX.test(targetingText)) &&
      profileProvablyNotFarmer(profileContext, profileNorm)) {
    out.push('Farmer/rancher program does not fit a profile whose occupation section states it does not farm')
  }
  // A caregiver keeps an older-adult program ONLY when the program itself
  // names caregivers; an aging-services locator is for the older adult.
  const caregiverServed = profileIsCaregiver(profileContext, profileNorm) && /\bcaregivers?\b/i.test(targetingText)
  if (OLDER_ADULT_PROGRAM_RX.test(targetingText) && !YOUTH_SENIOR_RX.test(targetingText) &&
      profileProvablyNotOlderAdult(profileContext, profileNorm) && !caregiverServed) {
    out.push(`Older-adult program (60+) does not fit a profile that states its age as ${profileAgeYears(profileContext, profileNorm)}`)
  }
  if (HOMEOWNER_PROGRAM_RX.test(targetingText) && profileProvablyNotHomeowner(profileContext, profileNorm)) {
    out.push(`Homeowner/mortgage program does not fit a profile whose stated housing status is "${profileHousingStatus(profileContext)}"`)
  }
  if (HOMESCHOOL_PROGRAM_RX.test(targetingText) && profileProvablyNotHomeschooled(profileContext)) {
    out.push('Homeschool program does not fit a profile that declares a school, college, or university education path')
  }
  return out
}

function professionDependentContext(text) {
  return /\b(children?|dependents?|spouses?|famil(?:y|ies)|sons?|daughters?|grandchildren)\s+(?:of|for)\b/i.test(text) ||
    /\b(?:child|dependent|spouse|family)\s+of\s+(?:a|an)?\s{0,10}(?:nurse|emt|paramedic|teacher|veteran|first responder)\b/i.test(text)
}

export function evaluateNeedFirstMatchPolicy({
  profileContext = {},
  profileNorm = null,
  opportunity = {},
  oppNorm = null,
  dataPointEval = {},
  matchedNeeds = [],
} = {}) {
  const text = opportunityText(opportunity)
  const targetingText = opportunityTargetingText(opportunity)
  const resource = isNeedFirstResource(opportunity, oppNorm)
  const reasons = []
  const hardMismatches = []
  const purposeReasons = []
  const pointSummary = matchedPointSummary(dataPointEval)
  const profileText = profilePurposeText(profileContext, profileNorm)

  if (resource) {
    // A resource is retained separately from direct funding — but it is still
    // a claim that THIS profile can use it. The exclusive-population rules
    // below (survivor, older-adult, homeowner, homeschool, foster, caregiver,
    // child, international, organization-only) apply to it exactly as to a
    // direct award; only the purpose/institution scoring is skipped.
    const resourceHard = []
    if (deathSurvivorRestriction(targetingText) && !profileHasSurvivorSignal(profileContext, profileNorm)) {
      resourceHard.push('Death-survivor program requires widow, orphan, surviving-spouse, or Gold Star evidence')
    }
    if (FOSTER_PROGRAM_RX.test(targetingText) &&
        !profileHasFosterSignal(profileContext, profileNorm)) {
      resourceHard.push('Foster-youth program requires a current or former foster-youth signal')
    }
    if (/\b(child care|childcare|day care|daycare|head start|wic\b|parents? of (?:young )?children)\b/i.test(targetingText) &&
        !profileHasChildrenOrPregnancy(profileContext, profileNorm)) {
      resourceHard.push('Child/dependent program requires a child, dependent, or pregnancy signal')
    }
    if (/\b(caregiver grant|caregiver support|family caregiver|respite care)\b/i.test(targetingText) &&
        !profileIsCaregiver(profileContext, profileNorm)) {
      resourceHard.push('Caregiver-only program requires a caregiver signal')
    }
    if (/\b(international students? only|exclusively for international students?|non[- ]?u\.?s\.? citizens? only|foreign students? only)\b/i.test(targetingText) &&
        !profileHasInternationalSignal(profileContext, profileNorm)) {
      resourceHard.push('International-student-only program requires an international or immigration-status signal')
    }
    resourceHard.push(...positivePopulationMismatches(profileContext, profileNorm, targetingText, opportunity))
    const resourceTypeKnown = Boolean(profileType(profileContext, profileNorm))
    if (resourceTypeKnown && !profileIsOrganization(profileContext, profileNorm) &&
        /\b(?:only|exclusively|restricted to|must be)\b[^.]{0,60}\b(nonprofits?|non-profit organizations?|school districts?|municipalities|local governments?|units? of government|institutions?)\b/i.test(targetingText)) {
      resourceHard.push('Organization-only funding requires an organization applicant profile')
    }
    const resourceHardMismatch = resourceHard.length > 0
    return {
      resource: true,
      purposeAnchor: true,
      reviewOnly: !resourceHardMismatch,
      hardMismatch: resourceHardMismatch,
      scoreCap: resourceHardMismatch ? SCORE_FLOOR : null,
      decision: resourceHardMismatch ? 'REJECT' : 'REVIEW',
      reasons: resourceHardMismatch
        ? [...new Set(resourceHard)]
        : ['Resource/directory retained separately from direct funding'],
      purposeReasons: ['resource'],
      hardMismatches: [...new Set(resourceHard)],
      diagnostics: { resource: true },
    }
  }

  const schools = collectProfileSchools(profileContext, profileNorm)
  const requiredInstitution = institutionCandidate(opportunity, text)
  let institutionMatch = false
  let institutionUnconfirmed = false
  if (requiredInstitution) {
    institutionMatch = schools.authoritative.some((school) => sameSchool(school, requiredInstitution.name))
    if (institutionMatch) {
      purposeReasons.push(`Institution match: ${requiredInstitution.name}`)
    } else if (schools.authoritative.length === 0) {
      institutionUnconfirmed = true
      reasons.push(`Institution eligibility for ${requiredInstitution.name} is unconfirmed`)
    } else if (requiredInstitution.confidence === 'strong') {
      hardMismatches.push(
        `Institution-specific funding is for ${requiredInstitution.name}, not the profile's current, committed, accepted, or target institution`,
      )
    } else {
      institutionUnconfirmed = true
      reasons.push(`Possible institution restriction for ${requiredInstitution.name} is unconfirmed`)
    }
  }

  const dependentProfessionProgram = professionDependentContext(targetingText)
  const professionRules = dependentProfessionProgram
    ? []
    : PROFESSION_RULES.filter((rule) => rule.opportunity.test(targetingText))
  const professionMatches = professionRules.filter((rule) => rule.profile.test(profileText))
  if (professionRules.length > 0 && professionMatches.length === 0) {
    hardMismatches.push(
      `Opportunity is restricted to ${professionRules.map((rule) => rule.label).join(' or ')}; the profile has no matching education or occupation signal`,
    )
  } else if (professionMatches.length > 0) {
    purposeReasons.push(...professionMatches.map((rule) => `Profession/major match: ${rule.label}`))
  }

  if (/\b(child care|childcare|day care|daycare|head start|wic\b|parents? of (?:young )?children)\b/i.test(targetingText) &&
      !profileHasChildrenOrPregnancy(profileContext, profileNorm)) {
    hardMismatches.push('Child/dependent program requires a child, dependent, or pregnancy signal')
  }
  if (/\b(caregiver grant|caregiver support|family caregiver|respite care)\b/i.test(targetingText) &&
      !profileIsCaregiver(profileContext, profileNorm)) {
    hardMismatches.push('Caregiver-only program requires a caregiver signal')
  }
  if (deathSurvivorRestriction(targetingText) && !profileHasSurvivorSignal(profileContext, profileNorm)) {
    hardMismatches.push('Death-survivor program requires widow, orphan, surviving-spouse, or Gold Star evidence')
  }
  hardMismatches.push(...positivePopulationMismatches(profileContext, profileNorm, targetingText, opportunity))
  if (/\b(international students? only|exclusively for international students?|non[- ]?u\.?s\.? citizens? only|foreign students? only)\b/i.test(targetingText) &&
      !profileHasInternationalSignal(profileContext, profileNorm)) {
    hardMismatches.push('International-student-only program requires an international or immigration-status signal')
  }
  if (FOSTER_PROGRAM_RX.test(targetingText) &&
      !profileHasFosterSignal(profileContext, profileNorm)) {
    hardMismatches.push('Foster-youth program requires a current or former foster-youth signal')
  }

  const scholarship = SCHOLARSHIP_TERMS.test(text)
  const benefit = BENEFIT_TERMS.test(text)
  const businessApplicant = !scholarship && BUSINESS_APPLICANT_TERMS.test(targetingText)
  const organizationApplicant = !scholarship && ORGANIZATION_APPLICANT_TERMS.test(targetingText)
  const isStudent = profileIsStudent(profileContext, profileNorm)
  const isBusiness = profileIsBusiness(profileContext, profileNorm)
  const isOrganization = profileIsOrganization(profileContext, profileNorm)
  // MISSING = NEUTRAL (G4): a hard mismatch is a claim the profile PROVES.
  // A profile with no resolvable type (a wildcard/broad-discovery thesis, a
  // bare stub) is UNKNOWN — "not proven org" must not read as "proven
  // not-org". The canonical engine holds exactly this line for its own
  // nonprofit/business gates (`profileTypeIsMissingOrGeneric` → REVIEW, not
  // REJECT); the overlay must not out-reject the engine on silence. A profile
  // whose type IS known (student, senior, church…) still hard-mismatches.
  const typeKnown = Boolean(profileType(profileContext, profileNorm))

  if (businessApplicant && typeKnown && !isBusiness) {
    hardMismatches.push('Business-only funding requires a business applicant profile')
  }
  if (organizationApplicant && typeKnown && !isOrganization) {
    hardMismatches.push('Organization-only funding requires an organization applicant profile')
  }

  if (pointSummary.needCredit > 0 || matchedNeeds.length > 0) {
    purposeReasons.push('Addresses a declared profile need')
  }
  if (pointSummary.declaredProgramCredit > 0) {
    purposeReasons.push('Matches a program explicitly declared in the profile')
  }

  const scholarshipKinds = new Set([
    'academic', 'financial', 'interest', 'sports', 'demographic', 'gender',
    'immigration', 'military', 'health', 'family', 'occupation', 'credential',
  ])
  const directPurposeKinds = new Set([
    'financial', 'occupation', 'credential', 'ownership', 'organization',
    'military', 'health', 'family', 'demographic', 'assistance', 'immigration',
    'interest', 'academic',
  ])
  const matchedScholarshipPurpose = [...pointSummary.kinds].some((kind) => scholarshipKinds.has(kind))
  const matchedDirectPurpose = [...pointSummary.kinds].some((kind) => directPurposeKinds.has(kind))

  if (scholarship && isStudent && matchedScholarshipPurpose) {
    purposeReasons.push('Scholarship purpose matches the student profile')
  }
  if (benefit && matchedDirectPurpose) {
    purposeReasons.push('Benefit purpose matches profile evidence')
  }
  if (businessApplicant && isBusiness && matchedDirectPurpose) {
    purposeReasons.push('Business funding purpose matches the business profile')
  }
  if (organizationApplicant && isOrganization && matchedDirectPurpose) {
    purposeReasons.push('Organizational funding purpose matches the organization profile')
  }
  if (!scholarship && !businessApplicant && !organizationApplicant &&
      FUNDING_ACTION_TERMS.test(text) && matchedDirectPurpose) {
    purposeReasons.push('Direct funding purpose matches substantive profile evidence')
  }

  const purposeAnchor = purposeReasons.length > 0
  if (!purposeAnchor && hardMismatches.length === 0) {
    reasons.push('No declared need, institution, profession, program, or direct funding purpose in the profile matches this source')
  }

  const hardMismatch = hardMismatches.length > 0
  const reviewOnly = !hardMismatch && institutionUnconfirmed
  // NOTE: the LIVE decision for the `!purposeAnchor` case is re-derived by
  // needFirstMatchPolicy.recomputePolicy, which RETAINS an applicant-type-
  // compatible unanchored source as a low-scored REVIEW (recall over
  // suppression) instead of the hard REJECT computed here. This value is only
  // consumed by V2-direct callers that assert on hardMismatches, not decision.
  const decision = hardMismatch || !purposeAnchor ? 'REJECT' : (reviewOnly ? 'REVIEW' : null)
  const scoreCap = hardMismatch
    ? SCORE_FLOOR
    : !purposeAnchor
      ? Math.max(SCORE_FLOOR, REVIEW_SCORE - 1)
      : reviewOnly
        ? REVIEW_SCORE
        : null

  return {
    resource: false,
    purposeAnchor,
    reviewOnly,
    hardMismatch,
    scoreCap,
    decision,
    reasons: [...new Set([...hardMismatches, ...reasons])],
    purposeReasons: [...new Set(purposeReasons)],
    hardMismatches: [...new Set(hardMismatches)],
    diagnostics: {
      need_credit: Math.round(pointSummary.needCredit * 10) / 10,
      declared_program_credit: Math.round(pointSummary.declaredProgramCredit * 10) / 10,
      matched_kinds: [...pointSummary.kinds].sort(),
      required_institution: requiredInstitution?.name ?? null,
      institution_source: requiredInstitution?.source ?? null,
      institution_confidence: requiredInstitution?.confidence ?? null,
      institution_match: institutionMatch,
      profession_domains: professionRules.map((rule) => rule.id),
      profession_matches: professionMatches.map((rule) => rule.id),
      dependent_profession_program: dependentProfessionProgram,
      scholarship,
      benefit,
      business_applicant: businessApplicant,
      organization_applicant: organizationApplicant,
      profile_is_student: isStudent,
      profile_is_business: isBusiness,
      profile_is_organization: isOrganization,
    },
  }
}

export function enforceNeedFirstDecision(current, policy) {
  const base = current && typeof current === 'object' ? current : {}
  if (!policy) return base
  // A resource is retained at REVIEW by the adapter — unless it positively
  // excludes this profile, in which case the REJECT below stands.
  if (policy.resource && !policy.hardMismatch) return base
  if (policy.decision === 'REJECT') {
    return {
      ...base,
      decision: 'REJECT',
      explanation: policy.hardMismatch
        ? `Not a profile match: ${policy.hardMismatches.join('; ')}.`
        : 'Not a profile match: this source does not address a declared need or other direct funding purpose in the profile.',
      reasons: [...(Array.isArray(base.reasons) ? base.reasons : []), ...policy.reasons],
    }
  }
  if (policy.reviewOnly && String(base.decision || '').toUpperCase() === 'ACCEPT') {
    return {
      ...base,
      decision: 'REVIEW',
      explanation: 'Potentially relevant, but a required institution or other exclusive eligibility fact is unconfirmed.',
      reasons: [...(Array.isArray(base.reasons) ? base.reasons : []), ...policy.reasons],
    }
  }
  return base
}

export default {
  collectProfileSchools,
  enforceNeedFirstDecision,
  evaluateNeedFirstMatchPolicy,
  isNeedFirstResource,
}
