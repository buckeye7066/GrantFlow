import { REVIEW_SCORE, SCORE_FLOOR } from '../../config/matchThresholds.js'

const RESOURCE_KINDS = new Set([
  'DIRECTORY',
  'PAST_AWARD_INTEL',
  'SCHOOL_PORTAL',
  'REFERRAL',
])

const SCHOLARSHIP_TERMS = /\b(scholarship|fellowship|tuition|student aid|education award|educational award)\b/i
const BENEFIT_TERMS = /\b(benefit|assistance|relief|subsidy|voucher|medicaid|medicare|ssi|ssdi|snap|wic|tanf|liheap|section 8|housing choice)\b/i
const BUSINESS_TERMS = /\b(business|entrepreneur|startup|working capital|commercial|enterprise|small business|farm|farmer|ranch|agriculture)\b/i
const ORGANIZATION_TERMS = /\b(nonprofit|non-profit|organization|church|ministry|school district|municipal|community program|research institution)\b/i

const INSTITUTION_WORDS = new Set([
  'university', 'college', 'school', 'institute', 'academy', 'campus',
  'the', 'of', 'at', 'and', 'for',
])

const GENERIC_EDUCATION_SPONSORS = /\b(college board|scholarship america|bold\.?org|fastweb|scholarships?\.com|student aid|department of education|financial aid office|scholarship directory)\b/i

const PROFESSION_RULES = Object.freeze([
  {
    id: 'nursing',
    label: 'nursing',
    opportunity: /\b(nurs(?:e|es|ing)|rn\b|lpn\b|nclex)\b/i,
    profile: /\b(nurs(?:e|es|ing)|rn\b|lpn\b|nclex)\b/i,
  },
  {
    id: 'ems',
    label: 'EMS/paramedic',
    opportunity: /\b(emt|aemt|paramedic|emergency medical services?|ems professional|first responder scholarship)\b/i,
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

function signalText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined || value === false) return ''
  if (value === true) return 'true'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((entry) => signalText(entry, depth + 1)).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    const parts = []
    for (const [key, entry] of Object.entries(value)) {
      if (entry === true) parts.push(key.replace(/_/g, ' '))
      else {
        const text = signalText(entry, depth + 1)
        if (text) parts.push(text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

function opportunityText(opportunity = {}) {
  return [
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
  ].filter(Boolean).join(' ')
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
  const words = normalizeText(value).split(' ').filter((word) => word && !['the', 'of', 'at', 'and', 'for'].includes(word))
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
    const name = typeof value === 'object' ? value?.name : value
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
    .map((application) => application?.name))
  const accepted = uniqueNames(applications
    .filter((application) => acceptedStatuses.has(String(application?.status ?? '').toLowerCase()))
    .map((application) => application?.name))
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
    applications.map((application) => application?.name),
  ])

  return {
    committed,
    accepted,
    current,
    target,
    authoritative: committed.length > 0 ? committed : current,
  }
}

function institutionCandidate(opportunity = {}, text = '') {
  if (!SCHOLARSHIP_TERMS.test(text)) return null
  const sponsor = String(opportunity.sponsor ?? opportunity.funder ?? '').trim()
  const title = String(opportunity.title ?? opportunity.name ?? '').trim()
  const schoolLike = /\b(university|college|school of|institute of technology|academy)\b/i
  if (sponsor && schoolLike.test(sponsor) && !GENERIC_EDUCATION_SPONSORS.test(sponsor)) return sponsor
  const titleMatch = title.match(/^(.{3,100}?\b(?:university|college|school|institute|academy)\b)/i)
  if (titleMatch && !GENERIC_EDUCATION_SPONSORS.test(titleMatch[1])) return titleMatch[1]
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

function profileHasChildren(profileContext = {}, profileNorm = null) {
  const family = asObject(profileContext?.sections?.family_life ?? profileContext?.sections?.family)
  return Boolean(
    profileNorm?.hasChildren ||
    profileNorm?.isCaregiver ||
    family.has_children === true ||
    family.caregiver === true ||
    family.is_caregiver === true ||
    Number(family.number_of_children ?? family.number_of_dependents ?? family.num_dependents ?? 0) > 0
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
  const status = normalizeText(demographics.immigrant_status ?? demographics.citizenship_status ?? profileNorm?.immigrationStatus)
  return Boolean(
    profileNorm?.isImmigrant || profileNorm?.isInternationalStudent ||
    /international|foreign student|non citizen|noncitizen|visa|refugee|asylee/.test(status)
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

export function evaluateNeedFirstMatchPolicy({
  profileContext = {},
  profileNorm = null,
  opportunity = {},
  oppNorm = null,
  dataPointEval = {},
  matchedNeeds = [],
} = {}) {
  const text = opportunityText(opportunity)
  const normalizedOppText = normalizeText(text)
  const resource = isNeedFirstResource(opportunity, oppNorm)
  const reasons = []
  const hardMismatches = []
  const purposeReasons = []
  const pointSummary = matchedPointSummary(dataPointEval)
  const profileText = profilePurposeText(profileContext, profileNorm)

  if (resource) {
    return {
      resource: true,
      purposeAnchor: true,
      reviewOnly: true,
      hardMismatch: false,
      scoreCap: null,
      decision: 'REVIEW',
      reasons: ['Resource/directory retained separately from direct funding'],
      purposeReasons: ['resource'],
      hardMismatches: [],
    }
  }

  const schools = collectProfileSchools(profileContext, profileNorm)
  const requiredInstitution = institutionCandidate(opportunity, text)
  let institutionMatch = false
  if (requiredInstitution) {
    const authoritative = schools.authoritative
    const relevant = authoritative.length > 0 ? authoritative : [...schools.accepted, ...schools.target]
    institutionMatch = relevant.some((school) => sameSchool(school, requiredInstitution))
    if (relevant.length > 0 && !institutionMatch) {
      hardMismatches.push(`Institution-specific funding is for ${requiredInstitution}, not the profile's current/committed/target institution`)
    } else if (institutionMatch) {
      purposeReasons.push(`Institution match: ${requiredInstitution}`)
    } else {
      reasons.push(`Institution eligibility for ${requiredInstitution} is unconfirmed`)
    }
  }

  const professionRule = PROFESSION_RULES.find((rule) => rule.opportunity.test(text)) ?? null
  const professionMatch = professionRule ? professionRule.profile.test(profileText) : false
  if (professionRule && !professionMatch) {
    hardMismatches.push(`Opportunity is restricted to ${professionRule.label}; the profile has no matching education or occupation signal`)
  } else if (professionRule) {
    purposeReasons.push(`Profession/major match: ${professionRule.label}`)
  }

  if (/\b(child care|childcare|day care|daycare|head start|wic\b|parents? of (?:young )?children)\b/i.test(text) &&
      !profileHasChildren(profileContext, profileNorm)) {
    hardMismatches.push('Child/dependent program requires a child or caregiver signal')
  }
  if (/\b(caregiver grant|caregiver support|family caregiver|respite care)\b/i.test(text) && !profileNorm?.isCaregiver) {
    hardMismatches.push('Caregiver-only program requires a caregiver signal')
  }
  if (/\b(survivor benefits?|surviving spouse|widow(?:er)?|orphan benefit|death benefit)\b/i.test(text) &&
      !profileHasSurvivorSignal(profileContext, profileNorm)) {
    hardMismatches.push('Survivor-only program requires widow, orphan, surviving-spouse, or Gold Star evidence')
  }
  if (/\b(international students? only|for international students?|non[- ]?u\.?s\.? citizens?|foreign students?)\b/i.test(text) &&
      !profileHasInternationalSignal(profileContext, profileNorm)) {
    hardMismatches.push('International-student program requires an international or immigration-status signal')
  }
  if (/\b(foster youth|former foster youth|aged out of foster care|chafee|education and training voucher)\b/i.test(text) &&
      !profileNorm?.hasFosterIndicator) {
    hardMismatches.push('Foster-youth program requires a current or former foster-youth signal')
  }

  if (pointSummary.needCredit > 0 || matchedNeeds.length > 0) {
    purposeReasons.push('Addresses a declared profile need')
  }
  if (pointSummary.declaredProgramCredit > 0) {
    purposeReasons.push('Matches a program explicitly declared in the profile')
  }

  const scholarship = SCHOLARSHIP_TERMS.test(text)
  const benefit = BENEFIT_TERMS.test(text)
  const business = BUSINESS_TERMS.test(text)
  const organization = ORGANIZATION_TERMS.test(text)
  const scholarshipKinds = new Set([
    'academic', 'financial', 'interest', 'sports', 'demographic', 'gender',
    'immigration', 'military', 'health', 'family', 'occupation', 'credential',
  ])
  const grantKinds = new Set([
    'financial', 'occupation', 'credential', 'ownership', 'organization',
    'military', 'health', 'family', 'demographic', 'assistance', 'immigration',
  ])
  const matchedScholarshipPurpose = [...pointSummary.kinds].some((kind) => scholarshipKinds.has(kind))
  const matchedGrantPurpose = [...pointSummary.kinds].some((kind) => grantKinds.has(kind))
  const isStudent = Boolean(profileNorm?.isStudent)
  const isBusiness = Boolean(profileNorm?.isBusiness)
  const isOrganization = Boolean(
    profileNorm?.isNonprofit || profileNorm?.isBusiness ||
    ['organization', 'nonprofit', 'church', 'ministry', 'school', 'municipality'].includes(String(profileNorm?.entityType ?? ''))
  )

  if (scholarship && isStudent && matchedScholarshipPurpose) {
    purposeReasons.push('Scholarship purpose matches the student profile')
  }
  if (benefit && (pointSummary.needCredit > 0 || pointSummary.kinds.has('assistance') || pointSummary.kinds.has('health') || pointSummary.kinds.has('family'))) {
    purposeReasons.push('Benefit purpose matches a declared need or assistance status')
  }
  if (business && isBusiness && (matchedGrantPurpose || pointSummary.needCredit > 0)) {
    purposeReasons.push('Business funding purpose matches the business profile')
  }
  if (organization && isOrganization && (matchedGrantPurpose || pointSummary.needCredit > 0)) {
    purposeReasons.push('Organizational funding purpose matches the organization profile')
  }
  if (professionMatch || institutionMatch) {
    // Already recorded above, but these are explicit direct-purpose anchors.
  }

  const purposeAnchor = purposeReasons.length > 0
  if (!purposeAnchor && hardMismatches.length === 0) {
    reasons.push('No declared need, institution, profession, program, or direct funding purpose in the profile matches this source')
  }

  const hardMismatch = hardMismatches.length > 0
  const reviewOnly = !hardMismatch && Boolean(requiredInstitution) && !institutionMatch
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
    reasons: [...hardMismatches, ...reasons],
    purposeReasons,
    hardMismatches,
    diagnostics: {
      need_credit: Math.round(pointSummary.needCredit * 10) / 10,
      declared_program_credit: Math.round(pointSummary.declaredProgramCredit * 10) / 10,
      matched_kinds: [...pointSummary.kinds].sort(),
      required_institution: requiredInstitution,
      institution_match: institutionMatch,
      profession_domain: professionRule?.id ?? null,
      profession_match: professionMatch,
      scholarship,
      benefit,
      business,
      organization,
      profile_text_excerpt: normalizedOppText ? undefined : undefined,
    },
  }
}

export function enforceNeedFirstDecision(current, policy) {
  const base = current && typeof current === 'object' ? current : {}
  if (!policy || policy.resource) return base
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
