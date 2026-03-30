/**
 * Opportunity Normalizer
 *
 * Extracts structured eligibility fields from raw opportunity data.
 * Normalizes entity types allowed, need types supported, funding type,
 * deadline status, geography, and source trust.
 *
 * CONSERVATIVE DESIGN: Unknown applicability is preserved as applicabilityUnknown=true
 * rather than optimistically defaulting to ['individual']. This causes ambiguous
 * opportunities to become REVIEW rather than false ACCEPT.
 */

import crypto from 'crypto'
import { normalizeNeedCategory, NEED_ALIAS_MAP } from './profileNormalizer.js'

// ---------------------------------------------------------------------------
// Safe JSON parse helper
// ---------------------------------------------------------------------------
function safeParseArray(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

// ---------------------------------------------------------------------------
// Entity type indicators extracted from text
// ---------------------------------------------------------------------------
const ENTITY_PATTERNS = [
  { type: 'student', patterns: ['student', 'undergraduate', 'graduate', 'college student', 'k-12', 'high school', 'university student', 'enrolled student'] },
  { type: 'veteran', patterns: ['veteran', 'military', 'armed forces', 'service member', 'vets', 'active duty', 'military personnel'] },
  { type: 'nonprofit', patterns: ['nonprofit', 'non-profit', '501(c)(3)', '501c3', 'charitable organization', 'charity', 'faith-based', 'church', 'religious organization', 'ministry', 'faith organization'] },
  { type: 'business', patterns: ['business', 'small business', 'entrepreneur', 'startup', 'self-employed', 'sole proprietor', 'llc', 'corporation', 'microenterprise', 'business owner', 'for-profit'] },
  { type: 'individual', patterns: ['individual', 'person', 'resident', 'household', 'family', 'low-income', 'applicant', 'adult', 'senior'] },
  { type: 'researcher', patterns: ['researcher', 'academic', 'faculty', 'scientist', 'investigator', 'principal investigator', 'research institution', 'university'] },
  { type: 'artist', patterns: ['artist', 'creative', 'musician', 'performer', 'writer', 'filmmaker', 'visual artist'] },
  { type: 'caregiver', patterns: ['caregiver', 'parent', 'guardian', 'foster parent', 'foster care', 'family caregiver'] },
]

// ---------------------------------------------------------------------------
// Institutional / research-only indicators
// ---------------------------------------------------------------------------
const INSTITUTIONAL_PATTERNS = [
  'institution', 'higher education institution', 'research institution', 'university grants',
  'college grants', 'academic institution', 'research organization', 'federal agency',
  'state agency', 'local government', 'municipality', 'county government',
  'health system', 'hospital system', 'medical center', 'health care system',
  'principal investigator', 'faculty researcher', 'research project',
]

const RESEARCH_ONLY_PATTERNS = [
  'research grant', 'research award', 'research funding', 'scientific research',
  'biomedical research', 'clinical research', 'basic science', 'translational research',
  'r01', 'r21', 'r03', 'research proposal', 'research protocol',
]

// ---------------------------------------------------------------------------
// University / off-campus resource indicators (requires student status)
// ---------------------------------------------------------------------------
const UNIVERSITY_STUDENT_ONLY_PATTERNS = [
  'off-campus housing', 'off campus housing', 'student housing directory',
  'student emergency fund', 'university emergency assistance', 'college emergency fund',
  'bursar', 'financial aid office', 'tuition assistance program', 'student aid fund',
  'campus emergency', 'dean of students', 'student affairs',
  'enrolled student only', 'currently enrolled', 'enrollment verification',
  'student health fee', 'student services fee', 'university resource',
  'campus resource', 'college resource', 'university program',
]

// ---------------------------------------------------------------------------
// Disease-specific / condition-specific indicators
// NOTE: Avoid short patterns that could match common words (e.g. "als" matches "individuals")
// ---------------------------------------------------------------------------
const DISEASE_SPECIFIC_PATTERNS = [
  'cancer', 'diabetes', 'multiple sclerosis', 'amyotrophic lateral sclerosis',
  'parkinson', 'alzheimer', 'crohn', 'lupus', 'fibromyalgia', 'epilepsy',
  'cerebral palsy', 'muscular dystrophy', 'cystic fibrosis', 'sickle cell',
  'rare disease', 'rare disorder', 'specific diagnosis', 'diagnosed with',
  'living with this condition', 'condition-specific', 'disease-specific',
]

// ---------------------------------------------------------------------------
// Pro bono / in-kind / referral-only indicators
// ---------------------------------------------------------------------------
const PRO_BONO_PATTERNS = [
  'pro bono', 'free legal', 'legal aid',
  'volunteer services', 'donated services',
]

const IN_KIND_PATTERNS = [
  'in-kind', 'in kind', 'goods and services', 'non-monetary', 'material support',
  'household goods', 'furniture donation',
]

const REFERRAL_ONLY_PATTERNS = [
  'referral only', 'by referral', 'case manager referral', 'professional referral',
  'agency referral', 'social worker referral', 'no direct applications',
]

// ---------------------------------------------------------------------------
// DME / equipment indicators
// ---------------------------------------------------------------------------
const DME_PATTERNS = [
  'durable medical equipment', 'dme', 'wheelchair', 'adaptive equipment',
  'assistive technology', 'hearing aid', 'prosthetic', 'orthotic',
  'medical device', 'mobility aid', 'walker', 'power chair', 'scooter',
  'ramp', 'stairlift', 'accessible vehicle', 'home modification',
]

// ---------------------------------------------------------------------------
// Disaster / emergency context indicators
// ---------------------------------------------------------------------------
const DISASTER_CONTEXT_PATTERNS = [
  'fema', 'disaster relief', 'disaster assistance', 'disaster recovery',
  'flood relief', 'hurricane', 'tornado', 'wildfire', 'earthquake',
  'declared disaster', 'major disaster', 'emergency declaration',
  'presidentially declared', 'disaster area', 'disaster survivor',
]

// ---------------------------------------------------------------------------
// Caregiver program indicators
// ---------------------------------------------------------------------------
const CAREGIVER_PROGRAM_PATTERNS = [
  'family caregiver', 'unpaid caregiver', 'caregiver support', 'caregiver program',
  'respite care', 'caregiver relief', 'caregiver assistance', 'family support program',
  'foster care program', 'kinship care', 'adoption assistance',
]

// ---------------------------------------------------------------------------
// Need type indicators extracted from text
// ---------------------------------------------------------------------------
const NEED_TEXT_PATTERNS = Object.entries({
  housing: ['housing', 'rent', 'mortgage', 'eviction', 'shelter', 'home repair', 'homeless', 'rental assistance', 'homelessness'],
  utilities: ['utilities', 'electric', 'gas bill', 'water bill', 'heating', 'cooling', 'internet access', 'utility assistance'],
  health_medical: ['medical', 'health', 'healthcare', 'prescription', 'dental', 'vision', 'mental health', 'behavioral health', 'therapy', 'health care', 'patient assistance', 'patient aid', 'medical assistance', 'chronic illness', 'chronic condition', 'diabetes', 'cancer', 'disease', 'condition-specific', 'disease-specific', 'illness'],
  food: ['food', 'nutrition', 'groceries', 'hunger', 'snap', 'meal', 'food assistance', 'food insecurity'],
  education: ['education', 'tuition', 'scholarship', 'college', 'financial aid', 'student aid'],
  employment: ['employment', 'workforce', 'job training', 'job placement', 'career', 'vocational', 'work training', 'employment assistance', 'job search', 'resume', 'job readiness'],
  cash_assistance: ['cash assistance', 'financial assistance', 'emergency funds', 'direct payment', 'stipend', 'cash benefit', 'cash payment', 'monetary assistance', 'financial support'],
  legal: ['legal aid', 'legal assistance', 'legal services', 'attorney', 'lawyer', 'legal help', 'legal counsel', 'civil legal'],
  disability: ['disability', 'disabled', 'adaptive', 'assistive technology', 'wheelchair', 'dme', 'chronic illness', 'mobility', 'adaptive equipment'],
  family_life: ['childcare', 'child care', 'caregiver', 'family', 'parenting', 'foster', 'adoption', 'kinship'],
  transportation: ['transportation', 'vehicle', 'car', 'transit', 'bus pass', 'rideshare', 'vehicle assistance'],
  business: ['business', 'small business', 'entrepreneur', 'startup', 'self-employment', 'microenterprise', 'business grant'],
  nonprofit_ministry: ['nonprofit', 'ministry', 'church', 'faith-based', 'community organization', 'charitable'],
  research_arts: ['research', 'arts', 'artist', 'creative', 'culture', 'scientific', 'art grant'],
  emergency: ['emergency', 'crisis', 'disaster', 'fema', 'urgent', 'emergency assistance', 'disaster relief'],
  veteran: ['veteran', 'military service', 'armed forces', 'veterans benefits', 'veteran program'],
  clothing_goods: ['clothing', 'household goods', 'furniture', 'appliances', 'goods donation'],
})

// ---------------------------------------------------------------------------
// Funding type normalization
// ---------------------------------------------------------------------------
const FUNDING_TYPE_MAP = {
  grant: 'grant',
  scholarship: 'scholarship',
  loan: 'loan',
  voucher: 'voucher',
  reimbursement: 'reimbursement',
  emergency_assistance: 'emergency_assistance',
  emergency: 'emergency_assistance',
  pro_bono: 'pro_bono',
  in_kind: 'in_kind',
  service: 'service',
  benefit: 'benefit',
  subsidy: 'grant',
  fellowship: 'scholarship',
}

function normalizeFundingType(raw) {
  if (!raw) return 'unknown'
  const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_')
  return FUNDING_TYPE_MAP[key] ?? 'grant'
}

// ---------------------------------------------------------------------------
// Extract entity types from opportunity text
// ---------------------------------------------------------------------------
function extractEntityTypesFromText(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const types = new Set()
  for (const { type, patterns } of ENTITY_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) {
      types.add(type)
    }
  }
  return [...types]
}

// ---------------------------------------------------------------------------
// Check if text contains any pattern from a list
// ---------------------------------------------------------------------------
function matchesAnyPattern(text, patterns) {
  if (!text) return false
  const lower = text.toLowerCase()
  return patterns.some((p) => lower.includes(p))
}

// ---------------------------------------------------------------------------
// Extract need types from opportunity text
// ---------------------------------------------------------------------------
function extractNeedTypesFromText(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const needs = new Set()
  for (const [need, patterns] of NEED_TEXT_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) {
      needs.add(need)
    }
  }
  return [...needs]
}

// ---------------------------------------------------------------------------
// Determine deadline status
// ---------------------------------------------------------------------------
function normalizeDeadlineStatus(deadline, deadlineType) {
  if (deadlineType === 'rolling' || deadlineType === 'ongoing') return 'rolling'
  if (!deadline) return 'unknown'
  const d = new Date(deadline)
  if (isNaN(d.getTime())) return 'unknown'
  if (d < new Date()) return 'closed'
  return 'open'
}

// ---------------------------------------------------------------------------
// Normalize opportunity into canonical structure
// ---------------------------------------------------------------------------
export function normalizeOpportunity(rawOpp) {
  if (!rawOpp) return null

  const text = [
    rawOpp.title ?? '',
    rawOpp.description ?? '',
    rawOpp.sponsor ?? '',
    ...(safeParseArray(rawOpp.eligibility_bullets)),
  ].join(' ')

  // -- Entity types allowed --
  // CONSERVATIVE: do NOT default unknown to ['individual'].
  // Unknown applicability is tracked as applicabilityUnknown=true so the decision
  // engine can force REVIEW rather than producing a false ACCEPT.
  const explicitEntityTypes = safeParseArray(rawOpp.entity_types_allowed)
  const textEntityTypes = extractEntityTypesFromText(text)
  let entityTypesAllowed
  let applicabilityUnknown = false
  if (explicitEntityTypes.length > 0) {
    entityTypesAllowed = explicitEntityTypes
  } else if (textEntityTypes.length > 0) {
    entityTypesAllowed = textEntityTypes
  } else {
    // Truly unknown — do NOT assume individual
    entityTypesAllowed = []
    applicabilityUnknown = true
  }

  // -- Need types supported --
  const explicitNeedTypes = safeParseArray(rawOpp.need_types_supported)
  const catNeedTypes = safeParseArray(rawOpp.categories).map(normalizeNeedCategory).filter(Boolean)
  const keywordNeedTypes = safeParseArray(rawOpp.keywords).map(normalizeNeedCategory).filter(Boolean)
  const textNeedTypes = extractNeedTypesFromText(text)
  const allNeedTypes = [...new Set([
    ...explicitNeedTypes,
    ...catNeedTypes,
    ...keywordNeedTypes,
    ...textNeedTypes,
  ])]
  const needTypesSupported = allNeedTypes.length > 0 ? allNeedTypes : []

  // -- Funding type --
  const fundingType = normalizeFundingType(
    rawOpp.funding_type ?? rawOpp.opportunity_type ?? rawOpp.type
  )

  // -- Deadline status --
  const deadlineStatus = normalizeDeadlineStatus(
    rawOpp.deadline ?? rawOpp.deadline_at,
    rawOpp.deadline_type
  )

  // -- Geography --
  const isNational = Boolean(rawOpp.is_national) ||
    String(rawOpp.state ?? '').toLowerCase() === 'nationwide' ||
    String(rawOpp.state ?? '').toLowerCase() === 'national'

  const geography = {
    isNational,
    state: rawOpp.state ?? null,
    zip: rawOpp.geo_zip ?? null,
    county: rawOpp.geo_county ?? null,
  }

  // -- Is loan? --
  const isLoan = Boolean(rawOpp.is_loan) ||
    fundingType === 'loan' ||
    String(rawOpp.title ?? '').toLowerCase().includes('loan')

  // -- Pro bono / in-kind / referral-only flags --
  const isProBono = Boolean(rawOpp.is_pro_bono) ||
    fundingType === 'pro_bono' ||
    matchesAnyPattern(text, PRO_BONO_PATTERNS)

  const isInKind = Boolean(rawOpp.is_in_kind) ||
    fundingType === 'in_kind' ||
    matchesAnyPattern(text, IN_KIND_PATTERNS)

  const isReferralOnly = Boolean(rawOpp.is_referral_only) ||
    matchesAnyPattern(text, REFERRAL_ONLY_PATTERNS)

  // -- Institutional / research-only flags --
  const isInstitutionalOnly = Boolean(rawOpp.is_institutional_only) ||
    matchesAnyPattern(text, INSTITUTIONAL_PATTERNS)

  const isResearchOnly = Boolean(rawOpp.is_research_only) ||
    matchesAnyPattern(text, RESEARCH_ONLY_PATTERNS)

  // -- Disease-specific flag --
  const diseaseSpecific = Boolean(rawOpp.disease_specific) ||
    matchesAnyPattern(text, DISEASE_SPECIFIC_PATTERNS)

  // -- Disaster context required --
  const requiresDisasterContext = Boolean(rawOpp.requires_disaster_context) ||
    matchesAnyPattern(text, DISASTER_CONTEXT_PATTERNS)

  // -- DME / equipment --
  const isDmeOrEquipment = Boolean(rawOpp.is_dme) ||
    matchesAnyPattern(text, DME_PATTERNS)

  // -- Caregiver program --
  const isCaregiverProgram = Boolean(rawOpp.is_caregiver_program) ||
    matchesAnyPattern(text, CAREGIVER_PROGRAM_PATTERNS)

  // -- Veteran/student/nonprofit requirements --
  const requiresVeteran =
    Boolean(rawOpp.requires_veteran) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'veteran'))

  const requiresStudent =
    Boolean(rawOpp.requires_student) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'student')) ||
    matchesAnyPattern(text, UNIVERSITY_STUDENT_ONLY_PATTERNS)

  const requiresNonprofit =
    Boolean(rawOpp.requires_501c3) ||
    Boolean(rawOpp.requires_nonprofit) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'nonprofit'))

  const requiresBusiness =
    Boolean(rawOpp.requires_business) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'business'))

  // -- Has real application URL? --
  const hasApplicationUrl = Boolean(
    rawOpp.application_url ||
    rawOpp.apply_url ||
    rawOpp.source_url ||
    rawOpp.url
  )

  // -- Source trust score (computed separately, but store raw source info) --
  const sourceType = rawOpp.official_source_type ?? rawOpp.source_category ?? null
  const source = rawOpp.source ?? null

  return {
    id: rawOpp.id,
    title: rawOpp.title,
    entityTypesAllowed,
    applicabilityUnknown,
    needTypesSupported,
    fundingType,
    deadlineStatus,
    geography,
    isLoan,
    isProBono,
    isInKind,
    isReferralOnly,
    isInstitutionalOnly,
    isResearchOnly,
    diseaseSpecific,
    requiresDisasterContext,
    isDmeOrEquipment,
    isCaregiverProgram,
    requiresVeteran,
    requiresStudent,
    requiresNonprofit,
    requiresBusiness,
    hasApplicationUrl,
    sourceType,
    source,
    isNational,
  }
}

// ---------------------------------------------------------------------------
// Compute a deterministic fingerprint for a normalized opportunity
// ---------------------------------------------------------------------------
export function computeOpportunityFingerprint(normalizedOpp) {
  if (!normalizedOpp) return null
  const relevant = {
    title: normalizedOpp.title,
    entityTypesAllowed: (normalizedOpp.entityTypesAllowed ?? []).slice().sort(),
    applicabilityUnknown: normalizedOpp.applicabilityUnknown,
    needTypesSupported: (normalizedOpp.needTypesSupported ?? []).slice().sort(),
    fundingType: normalizedOpp.fundingType,
    geography: normalizedOpp.geography,
    isLoan: normalizedOpp.isLoan,
    isInstitutionalOnly: normalizedOpp.isInstitutionalOnly,
    isResearchOnly: normalizedOpp.isResearchOnly,
    diseaseSpecific: normalizedOpp.diseaseSpecific,
    requiresDisasterContext: normalizedOpp.requiresDisasterContext,
    requiresVeteran: normalizedOpp.requiresVeteran,
    requiresStudent: normalizedOpp.requiresStudent,
    requiresNonprofit: normalizedOpp.requiresNonprofit,
    requiresBusiness: normalizedOpp.requiresBusiness,
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
