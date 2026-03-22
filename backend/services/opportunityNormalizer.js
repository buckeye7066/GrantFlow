/**
 * Opportunity Normalizer
 *
 * Extracts structured eligibility fields from raw opportunity data.
 * Normalizes entity types allowed, need types supported, funding type,
 * deadline status, geography, and source trust.
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
  { type: 'student', patterns: ['student', 'undergraduate', 'graduate', 'college student', 'k-12', 'high school'] },
  { type: 'veteran', patterns: ['veteran', 'military', 'armed forces', 'service member', 'vets'] },
  { type: 'nonprofit', patterns: ['nonprofit', 'non-profit', '501(c)(3)', '501c3', 'charitable organization', 'charity', 'faith-based', 'church', 'religious organization'] },
  { type: 'business', patterns: ['business', 'small business', 'entrepreneur', 'startup', 'self-employed', 'sole proprietor', 'llc', 'corporation', 'microenterprise'] },
  { type: 'individual', patterns: ['individual', 'person', 'resident', 'household', 'family', 'low-income', 'applicant'] },
  { type: 'researcher', patterns: ['researcher', 'academic', 'faculty', 'scientist', 'investigator', 'principal investigator'] },
  { type: 'artist', patterns: ['artist', 'creative', 'musician', 'performer', 'writer', 'filmmaker'] },
  { type: 'caregiver', patterns: ['caregiver', 'parent', 'guardian', 'foster parent'] },
]

// ---------------------------------------------------------------------------
// Need type indicators extracted from text
// ---------------------------------------------------------------------------
const NEED_TEXT_PATTERNS = Object.entries({
  housing: ['housing', 'rent', 'mortgage', 'eviction', 'shelter', 'home repair', 'homeless'],
  utilities: ['utilities', 'electric', 'gas bill', 'water bill', 'heating', 'cooling', 'internet access'],
  health_medical: ['medical', 'health', 'healthcare', 'prescription', 'dental', 'vision', 'mental health', 'behavioral health', 'therapy'],
  food: ['food', 'nutrition', 'groceries', 'hunger', 'snap', 'meal'],
  education: ['education', 'tuition', 'scholarship', 'college', 'training', 'workforce', 'vocational', 'financial aid'],
  disability: ['disability', 'disabled', 'adaptive', 'assistive technology', 'wheelchair', 'dme', 'chronic illness'],
  family_life: ['childcare', 'child care', 'caregiver', 'family', 'parenting', 'foster', 'adoption'],
  transportation: ['transportation', 'vehicle', 'car', 'transit', 'bus pass', 'rideshare'],
  business: ['business', 'small business', 'entrepreneur', 'startup', 'self-employment', 'microenterprise'],
  nonprofit_ministry: ['nonprofit', 'ministry', 'church', 'faith-based', 'community organization'],
  research_arts: ['research', 'arts', 'artist', 'creative', 'culture', 'scientific'],
  emergency: ['emergency', 'crisis', 'disaster', 'fema', 'urgent'],
  veteran: ['veteran', 'military service', 'armed forces'],
  clothing_goods: ['clothing', 'household goods', 'furniture', 'appliances'],
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
  const explicitEntityTypes = safeParseArray(rawOpp.entity_types_allowed)
  const textEntityTypes = extractEntityTypesFromText(text)
  const entityTypesAllowed = explicitEntityTypes.length > 0
    ? explicitEntityTypes
    : textEntityTypes.length > 0 ? textEntityTypes : ['individual']

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

  // -- Veteran/student/nonprofit requirements --
  const requiresVeteran =
    Boolean(rawOpp.requires_veteran) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'veteran'))

  const requiresStudent =
    Boolean(rawOpp.requires_student) ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'student'))

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
    needTypesSupported,
    fundingType,
    deadlineStatus,
    geography,
    isLoan,
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
    needTypesSupported: (normalizedOpp.needTypesSupported ?? []).slice().sort(),
    fundingType: normalizedOpp.fundingType,
    geography: normalizedOpp.geography,
    isLoan: normalizedOpp.isLoan,
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
