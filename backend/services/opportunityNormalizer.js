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
  { type: 'nonprofit', patterns: ['nonprofit', 'non-profit', '501(c)(3)', '501c3', 'charitable organization', 'charity', 'faith-based', 'church', 'religious organization', 'ministry', 'faith organization', 'volunteer fire', 'fire department', 'fire station', 'ems organization', 'first responder organization', 'rescue squad', 'emergency services organization'] },
  { type: 'business', patterns: ['business', 'small business', 'entrepreneur', 'startup', 'self-employed', 'sole proprietor', 'llc', 'corporation', 'microenterprise', 'business owner', 'for-profit'] },
  { type: 'individual', patterns: ['individual', 'person', 'resident', 'household', 'family', 'low-income', 'adult', 'senior'] },
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
  technology_equipment: ['computer', 'laptop', 'desktop', 'tablet', 'internet', 'hotspot',
    'wifi', 'broadband', 'digital', 'technology', 'device', 'equipment grant',
    'digital equity', 'digital inclusion', 'connectivity', 'tech assistance',
    'computer access', 'internet access'],
  mental_health: ['mental health', 'behavioral health', 'counseling', 'therapy', 'psychiatric',
    'suicide prevention', 'emotional wellness', 'psychological'],
  substance_recovery: ['substance abuse', 'addiction', 'recovery', 'rehab', 'drug treatment',
    'opioid', 'alcohol treatment', 'sober living'],
  senior: ['senior', 'elderly', 'aging', 'older adult', '65+', 'retiree', 'aarp',
    'aging in place', 'elder care'],
  children_youth: ['children', 'youth', 'at-risk youth', 'juvenile', 'young people',
    'after school', 'youth development', 'teen', 'adolescent'],
  women: ['women', 'female', 'women-owned', 'domestic violence', 'maternal',
    'women in business', 'gender equity', 'girls'],
  minority: ['minority', 'bipoc', 'african american', 'hispanic', 'latino', 'latina',
    'underrepresented', 'people of color', 'diversity', 'racial equity'],
  immigrant_refugee: ['immigrant', 'refugee', 'resettlement', 'asylum', 'asylee',
    'newcomer', 'english language learner', 'ell', 'migration'],
  tribal: ['tribal', 'native american', 'indigenous', 'indian nation', 'alaska native',
    'native hawaiian', 'first nations', 'tribal government'],
  public_safety: ['fire department', 'volunteer fire', 'ems', 'first responder',
    'homeland security', 'emergency services', 'firefighter', 'paramedic'],
  municipality: ['municipality', 'county government', 'city government', 'local government',
    'town', 'township', 'municipal'],
  environment: ['environment', 'conservation', 'climate', 'sustainability',
    'clean energy', 'renewable', 'green', 'pollution', 'ecosystem'],
  agriculture: ['agriculture', 'farming', 'ranch', 'usda', 'crop', 'livestock',
    'agribusiness', 'food production', 'farm'],
  community_development: ['community development', 'economic development', 'revitalization',
    'neighborhood', 'hud', 'cdbg', 'community block grant', 'infrastructure'],
  rural: ['rural', 'appalachian', 'small town', 'underserved', 'remote community',
    'rural health', 'rural development'],
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
  // Unrecognized funding types must stay 'unknown' (→ REVIEW downstream), never
  // silently default to 'grant'. Mislabeling e.g. a "loan" or "prize" as a grant
  // would let it pass as direct grant funding it is not. (Mission System 2.)
  return FUNDING_TYPE_MAP[key] ?? 'unknown'
}

// ---------------------------------------------------------------------------
// Extract entity types from opportunity text
// ---------------------------------------------------------------------------
function extractEntityTypesFromText(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const types = new Set()
  for (const { type, patterns } of ENTITY_PATTERNS) {
    if (patterns.some((p) => containsSearchPhrase(lower, p))) {
      types.add(type)
    }
  }
  return [...types]
}

// ---------------------------------------------------------------------------
// Check if text contains any pattern from a list
// ---------------------------------------------------------------------------
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsSearchPhrase(lower, phrase) {
  const p = String(phrase || '').toLowerCase().trim()
  if (!p) return false
  // Single words must match word boundaries so "als" does not match "individuals",
  // and "applicant" style generic language does not inflate entity detection.
  // We allow an optional trailing "s" so the singular pattern "resident" still
  // matches the word "residents" — a common-English regression of strict
  // boundary matching that would otherwise silently drop legitimate matches.
  if (/^[a-z0-9]+$/.test(p)) {
    return new RegExp(`\\b${escapeRegex(p)}s?\\b`, 'i').test(lower)
  }
  return lower.includes(p)
}

function matchesAnyPattern(text, patterns) {
  if (!text) return false
  const lower = text.toLowerCase()
  return patterns.some((p) => containsSearchPhrase(lower, p))
}

// ---------------------------------------------------------------------------
// Extract need types from opportunity text
// ---------------------------------------------------------------------------
function extractNeedTypesFromText(text) {
  if (!text) return []
  const lower = text.toLowerCase()
  const needs = new Set()
  for (const [need, patterns] of NEED_TEXT_PATTERNS) {
    if (patterns.some((p) => containsSearchPhrase(lower, p))) {
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
// Exclusive applicant-entity requirement detection.
//
// These patterns flag opportunities that are *only* open to a specific
// entity class. Used by `requiresVeteran/Student/Nonprofit/Business` so the
// hard eligibility gate in computeMatchDecision can reject mismatched
// profiles before scoring (per project rule "Hard boolean filters must be
// avoided unless the funding source is explicitly exclusive").
// ---------------------------------------------------------------------------
const EXCLUSIVE_ENTITY_REQUIREMENTS = {
  veteran: [
    /\b(veterans?|service members?|active duty|military personnel)\s+(only|required|eligible)\b/i,
    /\b(must be|limited to|exclusively for|only for)\s+(?:u\.?s\.?\s+)?(?:military\s+)?veterans?\b/i,
  ],
  student: [
    /\b(students?|undergraduates?|graduates?|enrolled students?)\s+(only|required|eligible)\b/i,
    /\b(must be|limited to|exclusively for|only for)\s+(?:currently\s+)?enrolled students?\b/i,
    /\bcurrently enrolled\b/i,
    /\benrollment verification\b/i,
    /\bfor\s+(?:tn\s+|state\s+)?students?\s+(?:with|pursuing|enrolled|attending)\b/i,
    /\b(?:female|women(?:'s)?)\s+students?\b/i,
    /\bscholarships?\s+for\s+(?:female\s+)?students?\b/i,
    // Program-name signals. "HOPE" and "STEP UP" are common English phrases on
    // their own, so require an explicit program qualifier (scholarship / grant /
    // aid / award) to avoid false positives on opportunity titles such as
    // "Tennessee HOPE Initiative" (housing nonprofit) or "Step Up for Families".
    // The remaining acronyms (TSAA, Pell, FSEOG, FAFSA) and the multi-word
    // "Tennessee Promise" are program-specific enough to keep as bare matches.
    /\b(?:hope|step\s+up|tennessee\s+promise)\s+(?:scholarship|grant|aid|award|program)s?\b/i,
    /\b(?:tsaa|pell|fseog|fafsa|tennessee\s+promise)\b/i,
    /\bcost\s+of\s+attendance\b/i,
    /\broom\s+and\s+board\b/i,
  ],
  nonprofit: [
    /\b(nonprofits?|non-profit organizations?|501\(c\)\(3\)|501c3|charitable organizations?)\s+(only|required|eligible)\b/i,
    /\b(must be|limited to|exclusively for|only for)\s+(?:a\s+)?(?:nonprofit|non-profit|501\(c\)\(3\)|501c3)\b/i,
    /\b501\(c\)\(3\)\s+status\s+required\b/i,
    /\bein required\b/i,
  ],
  business: [
    /\b(small businesses?|business owners?|entrepreneurs?|for-profit businesses?|sole proprietors?)\s+(only|required|eligible)\b/i,
    /\b(must be|limited to|exclusively for|only for)\s+(?:a\s+)?(?:small business|business owner|entrepreneur|for-profit|sole proprietor)\b/i,
    /\beligible applicants?\s+(?:are|include)\s+(?:small businesses?|business owners?|entrepreneurs?|for-profit businesses?)\b/i,
  ],
}

function matchesExclusiveEntityRequirement(text, type) {
  const patterns = EXCLUSIVE_ENTITY_REQUIREMENTS[type] ?? []
  return patterns.some((rx) => rx.test(text))
}

// ---------------------------------------------------------------------------
// Explicit identity restriction detection (ethnicity / heritage / gender).
//
// Canonical rule (docs/canonical_rules.md G4): "Population/eligibility
// mismatches reduce score, not discard results UNLESS the opportunity is
// EXPLICITLY EXCLUSIVE." Ethnicity/gender-exclusive scholarships (UNCF =
// African-American-only, HSF = Hispanic-only, women-only STEM awards, etc.)
// ARE explicitly exclusive, so they must be HARD-GATED when a profile clearly
// does not qualify — and only then. A casual, inclusive mention ("we welcome
// diverse applicants", "open to all backgrounds") is NEVER a restriction.
//
// Each canonical ethnicity bucket maps to the same tokens the profile
// normalizer emits on profileNorm.demographics + the free-text ethnicity
// string, so matchEngine can compare apples to apples.
// ---------------------------------------------------------------------------
const ETHNICITY_RESTRICTION_PATTERNS = {
  african_american: [
    /\b(?:for|to)\s+(?:african[\s-]?american|black)\s+(?:students?|applicants?|individuals?|men|women|youth)\b/i,
    /\b(?:african[\s-]?american|black)\s+(?:students?|applicants?|individuals?)\s+(?:only|exclusively)\b/i,
    /\bmust be\s+(?:african[\s-]?american|black)\b/i,
    /\b(?:open|available|restricted|limited)\s+(?:only\s+)?(?:to|for)\s+(?:african[\s-]?american|black)\b/i,
    /\bunited negro college fund\b/i,
    /\buncf\b/i,
  ],
  hispanic_latino: [
    /\b(?:for|to)\s+(?:hispanic|latino|latina|latinx|latin[\s-]?american)\s+(?:students?|applicants?|individuals?|heritage)\b/i,
    /\b(?:hispanic|latino|latina|latinx)\s+(?:students?|applicants?|individuals?)\s+(?:only|exclusively)\b/i,
    /\bmust be\s+(?:hispanic|latino|latina|latinx)\b/i,
    /\b(?:hispanic|latino|latina|latinx)\s+heritage\s+(?:required|only)\b/i,
    /\b(?:open|available|restricted|limited)\s+(?:only\s+)?(?:to|for)\s+(?:hispanic|latino|latina|latinx)\b/i,
    /\bhispanic scholarship fund\b/i,
  ],
  native_american: [
    /\b(?:for|to)\s+(?:native[\s-]?american|american indian|alaska native|indigenous)\s+(?:students?|applicants?|individuals?|peoples?)\b/i,
    /\b(?:native[\s-]?american|american indian|indigenous)\s+(?:students?|applicants?)\s+(?:only|exclusively)\b/i,
    /\bmust be\s+(?:native[\s-]?american|american indian|an enrolled (?:tribal )?member)\b/i,
    /\benrolled (?:tribal )?members?\s+(?:only|of a federally recognized tribe)\b/i,
    /\b(?:open|available|restricted|limited)\s+(?:only\s+)?(?:to|for)\s+(?:native[\s-]?american|american indian|indigenous)\b/i,
  ],
  asian_american: [
    /\b(?:for|to)\s+(?:asian[\s-]?american|asian|pacific islander)\s+(?:students?|applicants?|individuals?)\b/i,
    /\b(?:asian[\s-]?american|asian|pacific islander)\s+(?:students?|applicants?)\s+(?:only|exclusively)\b/i,
    /\bmust be\s+(?:asian[\s-]?american|asian|pacific islander)\b/i,
  ],
}

// Profile ethnicity free-text → canonical bucket. Used to decide whether a
// profile clearly DOES NOT satisfy an explicit ethnicity restriction.
const ETHNICITY_TOKEN_TO_BUCKET = [
  { bucket: 'african_american', rx: /\b(african[\s-]?american|black)\b/i },
  { bucket: 'hispanic_latino', rx: /\b(hispanic|latino|latina|latinx|latin[\s-]?american)\b/i },
  { bucket: 'native_american', rx: /\b(native[\s-]?american|american indian|alaska native|indigenous|tribal)\b/i },
  { bucket: 'asian_american', rx: /\b(asian[\s-]?american|asian|pacific islander)\b/i },
  { bucket: 'white', rx: /\b(white|caucasian|european[\s-]?american)\b/i },
]

/**
 * Map a free-text ethnicity string to a canonical bucket, or null when it
 * cannot be confidently classified (→ treated as UNKNOWN/neutral downstream).
 * @param {string|null} raw
 * @returns {string|null}
 */
export function ethnicityToBucket(raw) {
  if (!raw || typeof raw !== 'string') return null
  for (const { bucket, rx } of ETHNICITY_TOKEN_TO_BUCKET) {
    if (rx.test(raw)) return bucket
  }
  return null
}

/**
 * Detect EXPLICIT ethnicity restrictions in opportunity text. Returns the
 * canonical buckets the opportunity is exclusively for, or [] when none.
 * @param {string} text
 * @returns {string[]}
 */
function detectEthnicityRestrictions(text) {
  const out = []
  for (const [bucket, patterns] of Object.entries(ETHNICITY_RESTRICTION_PATTERNS)) {
    if (patterns.some((rx) => rx.test(text))) out.push(bucket)
  }
  return out
}

// Explicit gender restriction (women-only / men-only). `requiresWomen` already
// covers the female-only case for back-compat; this adds an explicit
// male-only signal and a structured requiresGender field.
const MEN_ONLY_PATTERNS = [
  /\b(?:for|to)\s+men\s+only\b/i,
  /\bmen[\s-]?only\b/i,
  /\bmale\s+(?:students?|applicants?)\s+only\b/i,
  /\bmust be (?:a )?male\b/i,
]
const WOMEN_ONLY_RESTRICTION_PATTERNS = [
  /\bwomen[\s-]?only\b/i,
  /\bfor\s+women\s+only\b/i,
  /\bfemale\s+(?:students?|applicants?)\s+only\b/i,
  /\bmust be (?:a )?(?:woman|female)\b/i,
  /\bwomen\s+in\s+(?:stem|engineering|business|science|technology)\b/i,
  /\bfor\s+women\b/i,
]

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
  const catNeedTypes = safeParseArray(rawOpp.categories).map(cat => NEED_ALIAS_MAP[cat?.toLowerCase()] || cat).filter(Boolean)
  const keywordNeedTypes = safeParseArray(rawOpp.keywords).map(kw => NEED_ALIAS_MAP[kw?.toLowerCase()] || kw).filter(Boolean)
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

  const oppState = rawOpp.state ?? rawOpp.stateRestriction ?? null
  const geography = {
    isNational,
    state: oppState,
    zip: rawOpp.geo_zip ?? null,
    county: rawOpp.geo_county ?? null,
  }

  // -- Is loan? --
  // Inspect the FULL opportunity text (title + description + sponsor + eligibility),
  // plus funding_type / opportunity_type / type metadata — not the title alone — so
  // a loan disclosed only in the body is still caught. (Mission System 2.)
  // Exempts loan forgiveness, repayment assistance, and similar non-loan programs
  // that mention "loan" in the context of helping borrowers, not lending.
  const loanText = [
    text,
    rawOpp.funding_type ?? '',
    rawOpp.opportunity_type ?? '',
    rawOpp.type ?? '',
  ].join(' ').toLowerCase()
  const loanAssistanceExempt = /loan\s+(forgiveness|repayment|discharge|cancellation|redemption|relief|assistance)|repay\w*\s+\w*\s*loan|pslf|income.driven repayment/i.test(loanText)
  const mentionsLoan = /\bloans?\b/i.test(loanText) ||
    /\bmicroloans?\b/i.test(loanText) ||
    /\blending\b/i.test(loanText)
  const isLoan = Boolean(rawOpp.is_loan) ||
    fundingType === 'loan' ||
    (!loanAssistanceExempt && mentionsLoan)

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
    matchesExclusiveEntityRequirement(text, 'veteran') ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'veteran'))

  const requiresStudent =
    Boolean(rawOpp.requires_student) ||
    matchesExclusiveEntityRequirement(text, 'student') ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'student')) ||
    matchesAnyPattern(text, UNIVERSITY_STUDENT_ONLY_PATTERNS)

  const requiresNonprofit =
    Boolean(rawOpp.requires_501c3) ||
    Boolean(rawOpp.requires_nonprofit) ||
    matchesExclusiveEntityRequirement(text, 'nonprofit') ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'nonprofit'))

  const requiresBusiness =
    Boolean(rawOpp.requires_business) ||
    matchesExclusiveEntityRequirement(text, 'business') ||
    (entityTypesAllowed.length > 0 && entityTypesAllowed.every(t => t === 'business'))

  const requiresWomen =
    Boolean(rawOpp.requires_women) ||
    matchesAnyPattern(text, [
      /\bfemale\s+students?\b/i,
      /\bwomen(?:'s)?\s+engineers?\b/i,
      /\bwomen\s+only\b/i,
      /\bfor\s+women\b/i,
      /\bwomen\s+in\s+(?:stem|engineering|business)\b/i,
    ]) ||
    (allNeedTypes.includes('women') &&
      (allNeedTypes.includes('education') || /\bstudents?\b/i.test(text)))

  // -- Explicit identity (ethnicity / gender) restrictions --
  // Only set when EXPLICITLY exclusive (per canonical_rules G4). These are the
  // hard-gate signals the decision engine uses to reject a profile whose
  // demographics clearly do NOT qualify (and ONLY then; unknown = neutral).
  const requiresEthnicity = Array.isArray(rawOpp.requires_ethnicity)
    ? rawOpp.requires_ethnicity.map((e) => String(e).toLowerCase().trim()).filter(Boolean)
    : detectEthnicityRestrictions(text)

  let requiresGender = null
  const rawRequiresGender = rawOpp.requires_gender
    ? String(rawOpp.requires_gender).toLowerCase().trim()
    : null
  if (rawRequiresGender === 'male' || rawRequiresGender === 'men') requiresGender = 'male'
  else if (rawRequiresGender === 'female' || rawRequiresGender === 'women') requiresGender = 'female'
  else if (matchesAnyPattern(text, MEN_ONLY_PATTERNS)) requiresGender = 'male'
  else if (requiresWomen || matchesAnyPattern(text, WOMEN_ONLY_RESTRICTION_PATTERNS)) requiresGender = 'female'

  // -- Has real application URL? --
  const hasApplicationUrl = Boolean(
    rawOpp.application_url ||
    rawOpp.apply_url ||
    rawOpp.source_url ||
    rawOpp.url
  )

  // -- Directory-like detection --
  const rawType = String(rawOpp.type || '').trim().toUpperCase()
  const rawOppType = String(rawOpp.opportunity_type || '').trim().toLowerCase()
  const rawOrigin = String(rawOpp.record_origin || '').trim().toLowerCase()
  const isDirectory = rawType === 'DIRECTORY' ||
    rawOrigin.includes('directory') ||
    rawOppType.includes('directory')

  // -- Placeholder detection --
  const PLACEHOLDER_TEXT_RX = [
    /\blorem\b/i, /\bipsum\b/i, /\bcoming\s+soon\b/i, /\bplaceholder\b/i,
    /\btbd\b/i, /\btest opportunity\b/i, /\bsample opportunity\b/i,
    /\bfoo bar\b/i, /^test$/i, /\bstub\b/i,
  ]
  const titleDesc = `${rawOpp.title || ''} ${rawOpp.description || ''}`
  const isPlaceholder = PLACEHOLDER_TEXT_RX.some(rx => rx.test(titleDesc))

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
    requiresWomen,
    requiresGender,
    requiresEthnicity,
    requiresNonprofit,
    requiresBusiness,
    hasApplicationUrl,
    isDirectory,
    isPlaceholder,
    sourceType,
    source,
    isNational,
  }
}

// ---------------------------------------------------------------------------
// Infer housing classification for an opportunity that lacks explicit fields.
// This is used as a fallback when funding_category / usable_for_housing are not
// persisted (e.g. legacy rows or opportunities from other crawlers).
// ---------------------------------------------------------------------------

const REFUND_ELIGIBLE_PATTERNS = [
  /\brefund\b/i, /\bexcess\b.{0,30}\baid\b/i, /\bcost.of.attendance\b/i,
  /\bcoa\b/i, /\bstipend\b/i, /\bdisburs/i, /\bover.?award\b/i,
]
const STIPEND_PATTERNS = [
  /\bstipend\b/i, /\bpaid\s+directly\s+to\s+(the\s+)?student\b/i,
  /\bmonthly\s+payment\b/i, /\bweekly\s+allowance\b/i,
  /\bunrestricted\s+(cash|award|payment)\b/i,
  /\bno\s+restrictions\s+on\s+(its\s+)?use\b/i,
]
const HOUSING_DIRECT_PATTERNS = [
  /\bfree\s+(campus\s+)?housing\b/i, /\bhousing\s+stipend\b/i,
  /\bra\s+program\b/i, /\bresident\s+assist/i, /\broom\s+(and\s+board|&\s+board)\b/i,
  /\bcampus\s+housing\b.{0,30}\bfree\b/i,
]
const FAITH_BASED_PATTERNS = [
  /\bchurch\b/i, /\bfaith.based\b/i, /\bdenomination\b/i, /\bchristian\b/i,
  /\bcatholic\b/i, /\bbaptist\b/i, /\bmethodist\b/i, /\bpresbyterian\b/i,
  /\bluthera\b/i, /\bevangelical\b/i, /\bdiocese\b/i, /\bministry\b/i,
  /\bcongregat/i, /\bseminary\b/i,
]
const TALENT_BASED_PATTERNS = [
  /\bmusic\b/i, /\bperforming arts\b/i, /\borchestra\b/i, /\bchoir\b/i,
  /\bband\s+scholarship\b/i, /\btalent.based\b/i, /\barts?\s+scholarship\b/i,
  /\bathletic\s+scholarship\b/i, /\bcompetition\s+award\b/i,
]
const COA_ADJUSTMENT_PATTERNS = [
  /\bcost\s+of\s+attendance\b/i, /\bcoa\s+adjust/i,
  /\bprofessional\s+judgment\b/i, /\bfinancial\s+aid\s+appeal\b/i,
]

/**
 * Infer funding_category and housing usability from opportunity text.
 * Returns: { fundingCategory: string|null, usableForHousing: boolean, refundPotential: boolean }
 */
export function inferHousingClassification(rawOpp) {
  const text = `${rawOpp?.title || ''} ${rawOpp?.description || ''} ${rawOpp?.keywords || ''}`.toLowerCase()

  // Explicit database fields take precedence
  if (rawOpp?.funding_category) {
    const cat = rawOpp.funding_category
    const usable = ['refund_eligible', 'stipend', 'housing_direct', 'faith_based', 'talent_based', 'coa_adjustment'].includes(cat)
    return {
      fundingCategory: cat,
      usableForHousing: Boolean(rawOpp.usable_for_housing) || usable,
      refundPotential: Boolean(rawOpp.refund_potential) || cat === 'refund_eligible',
    }
  }

  if (HOUSING_DIRECT_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'housing_direct', usableForHousing: true, refundPotential: false }
  }
  if (STIPEND_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'stipend', usableForHousing: true, refundPotential: false }
  }
  if (REFUND_ELIGIBLE_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'refund_eligible', usableForHousing: true, refundPotential: true }
  }
  if (COA_ADJUSTMENT_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'coa_adjustment', usableForHousing: true, refundPotential: false }
  }
  if (FAITH_BASED_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'faith_based', usableForHousing: false, refundPotential: false }
  }
  if (TALENT_BASED_PATTERNS.some((p) => p.test(text))) {
    return { fundingCategory: 'talent_based', usableForHousing: false, refundPotential: false }
  }

  return { fundingCategory: null, usableForHousing: false, refundPotential: false }
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
    requiresGender: normalizedOpp.requiresGender ?? null,
    requiresEthnicity: (normalizedOpp.requiresEthnicity ?? []).slice().sort(),
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16)
}
