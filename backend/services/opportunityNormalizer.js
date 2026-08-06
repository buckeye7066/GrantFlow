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
// Flatten eligibility_json (object or JSON string) into plain search text so
// the pattern matchers can read structured applicant-eligibility statements.
function eligibilityJsonToText(val) {
  if (!val) return ''
  let obj = val
  if (typeof val === 'string') {
    try { obj = JSON.parse(val) } catch { return val }
  }
  const parts = []
  const walk = (v) => {
    if (v === null || v === undefined) return
    if (typeof v === 'string' || typeof v === 'number') parts.push(String(v))
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(obj)
  return parts.join(' ').slice(0, 4000)
}

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
  // 'freshman'/'sophomore'/'dual enrollment': unambiguous student words that
  // were missing — "MTSU Freshman Guaranteed Scholarships" ("academic merit
  // scholarship ... for first-time incoming freshmen") inferred NO student type
  // (verified in prod, 2026-07-01). NOTE: 'scholarship' itself must NOT be a
  // student pattern — professional-development scholarships (e.g. NAEMT
  // EMT-Paramedic) would become student-ONLY and hard-reject the working
  // professionals they exist for.
  { type: 'student', patterns: ['student', 'undergraduate', 'graduate', 'college student', 'k-12', 'high school', 'university student', 'enrolled student', 'freshman', 'freshmen', 'sophomore', 'dual enrollment'] },
  { type: 'veteran', patterns: ['veteran', 'military', 'armed forces', 'service member', 'vets', 'active duty', 'military personnel'] },
  { type: 'nonprofit', patterns: ['nonprofit', 'non-profit', '501(c)(3)', '501c3', 'charitable organization', 'charity', 'faith-based', 'church', 'religious organization', 'ministry', 'faith organization', 'volunteer fire', 'fire department', 'fire station', 'ems organization', 'first responder organization', 'rescue squad', 'emergency services organization'] },
  { type: 'business', patterns: ['business', 'small business', 'entrepreneur', 'startup', 'self-employed', 'sole proprietor', 'llc', 'corporation', 'microenterprise', 'business owner', 'for-profit'] },
  { type: 'individual', patterns: ['individual', 'person', 'resident', 'household', 'family', 'low-income', 'adult', 'senior'] },
  // NOT 'academic'/'university': those words are pervasive in ordinary student
  // scholarship copy ("academic merit", any university-sponsored award), and as
  // researcher indicators they typed such awards researcher-ONLY → hard reject
  // for students. Genuinely institutional/research-only calls are still caught
  // by INSTITUTIONAL_PATTERNS / RESEARCH_ONLY_PATTERNS below (which retain
  // 'academic institution', 'university grants', 'research institution', …).
  { type: 'researcher', patterns: ['researcher', 'faculty', 'scientist', 'investigator', 'principal investigator', 'research institution', 'postdoc', 'postdoctoral'] },
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
// TITLE-scoped research/TA program tells (precise-detector class).
//
// The INSTITUTIONAL/RESEARCH patterns above scan the FULL text (title +
// description + eligibility), which is the right recall posture for the
// person-profile hard gate but too noisy to drive a score-crushing mismatch
// for organization profiles (a legit nonprofit grant whose description says
// "nonprofits and local governments may apply" contains 'local government').
// These regexes look at the TITLE ONLY, where federal research/TA programs
// announce themselves unambiguously:
//   • a parenthesized federal activity code — "(U18)", "(R01)", "(T32)". The
//     Vet-LIRN class: nothing else in the title says "research", but no
//     individual or service nonprofit can ever hold a federal cooperative
//     agreement. K12 is excluded (education pattern, not the career award).
//   • "Research Projects/Program/Grants/Center" as a title phrase — the DRRP
//     class. Fellowships/scholarships are deliberately NOT matched: those fund
//     people, not institutions.
//   • "Communities of Practice" — federal TA/peer-network cooperative
//     agreements (the CSBG COP class): they fund ONE national TA provider,
//     never services for a local applicant.
const RE_TITLE_FEDERAL_ACTIVITY_CODE = /\(\s*(?!k12\b)[rpukt]\d{2}[a-z]?\s*\)/i
const RE_TITLE_RESEARCH_PROGRAM = /\bresearch (?:projects?|programs?|grants?|awards?|centers?)\b/i
const RE_TITLE_COMMUNITIES_OF_PRACTICE = /\bcommunities of practice\b/i
// SBIR/STTR carve-out: "Small Business Innovation Research" grants ARE for
// small businesses — the applicant does R&D by definition of applying, so the
// institutional-research tell must not crush them for business profiles.
// (Ordinary individuals are still rejected via the full-text RESEARCH_ONLY
// patterns, which match 'research grant' in these titles.)
const RE_TITLE_SMALL_BUSINESS_RESEARCH = /\bsmall business\b|\bsbir\b|\bsttr\b/i

// Federal Register / Paperwork Reduction Act procedural documents. A "30-Day
// Notice of Proposed Information Collection: … Funding Grants" is a comment
// period on FORM PAPERWORK about a program — there is nothing to apply to, for
// anyone. These leak in through Federal Register ingest because their titles
// name real funding programs.
// Exported for the drift tripwire: the Federal Register adapter
// (backend/crawler-os/adapters/federalRegisterAdapter.js) keeps a LOCAL copy
// (crawler-os is deliberately self-contained) and a test asserts the two stay
// identical, so ingest and match-time judgments can never disagree.
// 2026-08-03 owner QA pass across all 36 profiles: SEC self-regulatory rule
// changes, IRS/OMB comment requests, DOL prohibited-transaction exemptions,
// DOJ antitrust filings and Privacy Act system-of-records notices were still
// surfacing as funding results (Aiyana Begay, Axiom BioLabs, Focus Forward
// Ministry, Marisol Vega, Sasquatch Conservancy, Vermilion Church). The owner's
// verbatim junk-title list is appended below; every phrase is a Federal
// Register document-type label no real funding program uses as its own title.
export const RE_PROCEDURAL_NOTICE_TITLE =
  /\b(?:30|60)[- ]day notice\b|\bnotice of proposed information collection\b|\bproposed information collection\b|\bpaperwork reduction act\b|\brequest for (?:comments?|information)\b|\bnotice of a federal advisory\b|\bnotice of re[sc]+ission\b|\bregulatory waiver requests?\b|\bmodification of .{0,80}(?:eligibility|guidelines)\b|\bagency information collection activities\b|\binformation collection\b|\bself-regulatory organizations?\b|\bnotice of filing\b|\bproposed rule change\b|\bprivacy act of 1974\b|\bsystems? of records\b|\bproposed final judgment\b|\bpublic hearing\b|\bprohibited transactions?\b|\bsolicitation of nominations?\b/i

// ---------------------------------------------------------------------------
// Senior/aging service programs (Area Agencies on Aging, eldercare locators,
// senior centers). NOT an eligibility gate — a family/caregiver profile
// legitimately reaches these for a household elder — but a young student with
// no aging/caregiving signal must not see them ACCEPT at 75 (the Demo Student
// class). matchEngine caps the score when the profile lacks any senior signal.
// ---------------------------------------------------------------------------
const SENIOR_PROGRAM_PATTERNS = [
  'area agency on aging', 'area agencies on aging', 'eldercare',
  'senior services', 'senior citizens', 'senior center', 'older adults',
  'meals on wheels', 'aging services', 'aging and disability resource',
]

// ---------------------------------------------------------------------------
// Already-awarded research/award records.
//
// NSF AwardSearch (api.nsf.gov), NIH RePORTER, and USASpending records describe
// grants that have ALREADY been awarded to an institution + a named Principal
// Investigator. They are funder/lead intelligence, NOT open opportunities — and
// they are NEVER available to an ordinary individual (you cannot apply to an
// award that an institution already holds). The connector ingest (`wantsResearch`
// gate) keeps these out of an individual's *ingest*, but the funding_opportunities
// catalog is shared across profiles, so a row that entered for a research-seeking
// org must still be hard-rejected when the matcher scores it against an individual.
//
// We treat these as institutional-research-only by construction. The single
// downstream gate (evaluateEligibility: isInstitutionalOnly || isResearchOnly)
// then rejects them for ordinary individuals while still letting genuine
// research orgs/businesses see them.
const AWARD_RECORD_SOURCES = new Set([
  'nsf.awards', 'nsf_awards', 'nih.reporter', 'nih_reporter',
  'usaspending.gov', 'usaspending', 'usa_spending',
])

// "Awardee: <Institution>" + "PI: <Name>" is the structural fingerprint the
// award adapters emit (see backend/src/integrations/nsfAwards.js). A row that
// names an awardee institution is, by definition, already awarded.
const ALREADY_AWARDED_TEXT_RX = /\bawardee:\s*\S|\bprincipal investigator:\s*\S|\bpi:\s*[a-z]/i

function isAlreadyAwardedRecord(rawOpp, text) {
  const source = String(rawOpp?.source ?? '').toLowerCase().trim()
  const oppType = String(rawOpp?.opportunity_type ?? '').toLowerCase().trim()
  if (AWARD_RECORD_SOURCES.has(source)) return true
  // Generic award record from any source: an explicit "award" type that also
  // names an awardee/PI in its text. We require BOTH so a normal grant whose
  // title merely contains the word "award" (e.g. "Excellence Award Scholarship")
  // is not misclassified.
  if (oppType === 'award' && ALREADY_AWARDED_TEXT_RX.test(text)) return true
  return false
}

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
// Education-level indicators.
//
// K-12 / elementary / middle-school awards are for children, not an adult
// college student. They keyword-collide with college aid ("scholarship",
// "education") and were scoring 90%+/ACCEPT for an out-of-state adult college
// profile. We detect an opportunity that is SPECIFICALLY for K-12 / pre-college
// learners so the eligibility gate can decline to ACCEPT it for an adult higher-ed
// profile (per canonical G4: education-level mismatch reduces fit; an
// elementary-only award is effectively exclusive to children).
//
// Higher-ed-only signals are tracked too (college/university/postsecondary) so a
// K-12 student is not auto-ACCEPTed into a college-only award.
// ---------------------------------------------------------------------------
const K12_EDUCATION_PATTERNS = [
  'elementary school', 'middle school', 'elementary & middle', 'elementary and middle',
  'primary school', 'grade school', 'k-12', 'k12', 'pre-k', 'prek', 'pre-school',
  'preschool', 'kindergarten', 'grades k', 'high schoolers', 'grade level',
  'children in grades', 'students in grades', 'young learners', 'gifted children',
  'advanced learners', 'summer seminars for', 'elementary students', 'middle schoolers',
]
const HIGHER_ED_PATTERNS = [
  'undergraduate', 'graduate student', 'college student', 'university student',
  'postsecondary', 'post-secondary', 'community college', 'higher education',
  'associate degree', "bachelor's", "master's", 'doctoral', 'phd', 'tuition',
  'two-year college', 'four-year college', 'vocational', 'trade school',
]

function detectEducationLevel(text) {
  const lower = String(text || '').toLowerCase()
  const isK12 = K12_EDUCATION_PATTERNS.some((p) => containsSearchPhrase(lower, p))
  const isHigherEd = HIGHER_ED_PATTERNS.some((p) => containsSearchPhrase(lower, p))
  // An award that mentions BOTH (e.g. "scholarships for K-12 and college") is not
  // exclusively either — treat as neutral so it is never hard-capped.
  if (isK12 && !isHigherEd) return 'k12'
  if (isHigherEd && !isK12) return 'higher_ed'
  return null
}

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
  // 2026-08-03 (the Demo Student audit): the condition-specific block her bare
  // "Has disability" flag admitted — Brain Injury Association, Autism Speaks,
  // Arthritis Foundation, Amputee Coalition, Reeve Foundation (paralysis),
  // HLAA (hearing loss) — was invisible to this detection, so the engine's
  // condition gate never even LOOKED at those rows. These are the named
  // conditions of the shipped disease-specific source lanes
  // (config/sourceLanes.js); like the entries above, each is a condition
  // identity, not a support/descriptor word.
  'autism', 'arthritis', 'brain injury', 'traumatic brain injury',
  'amputee', 'amputation', 'limb loss', 'paralysis', 'spinal cord injury',
  'hearing loss', 'kidney disease', 'dialysis', 'hemophilia',
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
    // Military-transition program language ("for separating and transitioning
    // service members, veterans, and military spouses") — the DOL TAP / Boots
    // to Business phrasing that names the military audience without the word
    // "only". A program FOR the military-affiliated is military-only.
    /\b(?:separating|transitioning)\s+service\s+members?\b/i,
    /\bveterans?,?\s+and\s+military\s+spouses?\b/i,
    /\bveteran[-\s]owned\s+business/i,
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
// Population / sector restriction flags (2026-07-06 — the persistent
// ineligible_surfaced_match / relevance_precision classes: domestic-violence
// survivor, agricultural cooperative, community development corporation, faith
// affiliation, age, income).
//
// Two tiers, mirroring the veteran/senior precedent:
//   - `is*Program` TOPICAL flags: the opportunity is ABOUT this population.
//     Used by the engine to CAP (not reject) scores for profiles with no
//     matching signal (G4: mismatches reduce score).
//   - `requires*` EXCLUSIVE flags: the text explicitly restricts eligibility.
//     Only these may hard-gate, and only when the profile clearly lacks the
//     trait (unknown = neutral, per G4 "missing fields are neutral").
// ---------------------------------------------------------------------------

// Topical DV mention — victim services, shelters, VAWA/OVW programs.
const DV_PROGRAM_PATTERNS = [
  /\bdomestic\s+violence\b/i,
  /\bintimate\s+partner\s+violence\b/i,
  /\bfamily\s+violence\b/i,
  /\bvictim\s+services\b/i,
  /\bvawa\b/i,
  /\bbattered\s+women\b/i,
]
// Explicit individual-side survivor restriction ("must be a survivor of...").
// Deliberately does NOT match "organizations serving victims of domestic
// violence" — that is an ORG grant, not a survivor-only individual program.
const DV_SURVIVOR_RESTRICTION_PATTERNS = [
  /\bmust\s+be\s+a?\s*(?:survivor|victim)\s+of\s+(?:domestic|intimate\s+partner|family)\s+(?:violence|abuse)\b/i,
  /\b(?:for|to)\s+(?:survivors?|victims?)\s+of\s+(?:domestic|intimate\s+partner|family)\s+(?:violence|abuse)\s+(?:only|and\s+their\s+children)?\b/i,
  /\bsurvivors?\s+of\s+(?:domestic|family)\s+(?:violence|abuse)\s+(?:only|are\s+eligible)\b/i,
  /\bfleeing\s+(?:domestic|family)\s+(?:violence|abuse)\b/i,
]

// Agriculture-only restriction ("farmers and ranchers only", "must operate a farm").
const FARMER_RESTRICTION_PATTERNS = [
  /\b(?:farmers?|ranchers?|agricultural\s+producers?)\s+(?:only|are\s+eligible)\b/i,
  /\bmust\s+(?:be|operate)\s+(?:an?\s+)?(?:farm|ranch|agricultural\s+(?:producer|operation|cooperative))\b/i,
  /\beligible\s+(?:applicants?|producers?)\s+(?:are|include)\s+(?:farmers?|ranchers?|agricultural\s+producers?)\b/i,
  /\bfamily\s+farms?\s+only\b/i,
  /\b(?:limited|exclusively|only)\s+(?:to|for)\s+(?:farmers?|ranchers?|agricultural\s+producers?)\b/i,
  /\bfsa\s+farm\s+number\s+(?:is\s+)?required\b/i,
]

// Faith-affiliation restriction (org-side "churches only" AND individual-side
// "must be an active member of a church/congregation").
const FAITH_RESTRICTION_PATTERNS = [
  /\b(?:churches|congregations|faith[-\s]based\s+organizations?|ministries|religious\s+organizations?)\s+(?:only|are\s+eligible)\b/i,
  /\bmust\s+be\s+a\s+(?:church|congregation|ministry|faith[-\s]based\s+organization|religious\s+organization)\b/i,
  /\b(?:limited|exclusively|only)\s+(?:to|for)\s+(?:churches|congregations|faith[-\s]based|religious)\b/i,
  /\bmust\s+be\s+an?\s+(?:active\s+)?member\s+of\s+(?:a\s+)?(?:church|congregation|parish)\b/i,
]

// Community-development-corporation restriction ("certified CHDOs", "CDCs only").
const CDC_RESTRICTION_PATTERNS = [
  /\bcommunity\s+development\s+corporations?\s+(?:only|are\s+eligible)\b/i,
  /\bmust\s+be\s+a\s+(?:certified\s+)?(?:community\s+development\s+corporation|chdo)\b/i,
  /\bcertified\s+chdos?\b/i,
  /\b(?:limited|exclusively|only)\s+(?:to|for)\s+(?:certified\s+)?(?:community\s+development\s+corporations?|chdos?)\b/i,
]

// Foster-youth restriction — programs statutorily limited to current/former
// foster youth (Chafee, ETV, "aging out of foster care"). These are among the
// most audience-exclusive programs in the catalog, yet their restriction lived
// only in prose: Chafee ranked top-10 for a 73-year-old widow and a homeschool
// family (2026-07-13 benchmark cohort). Phrases are anchored so a program that
// merely SERVES foster families alongside others does not trip the flag.
const FOSTER_YOUTH_RESTRICTION_PATTERNS = [
  /\b(?:current(?:ly)?\s+(?:and|or)\s+former(?:ly)?|former(?:ly)?\s+(?:and|or)\s+current(?:ly)?)\s+(?:in\s+)?foster\s+(?:care|youth)\b/i,
  /\bfor\s+(?:current|former|eligible)\s+foster\s+(?:youth|care\s+youth)\b/i,
  /\byouth\s+(?:aging|who\s+age[d]?)\s+out\s+of\s+(?:the\s+)?foster\s+care\b/i,
  /\bmust\s+(?:be|have\s+been)\s+in\s+foster\s+care\b/i,
  /\bchafee\b/i,
  /\beducation\s+and\s+training\s+vouchers?\b/i,
]

// Income restriction — explicit means-tests only ("income at or below 200% of
// FPL", "low-income households only"). A passing mention of serving low-income
// communities is NOT a restriction.
const INCOME_RESTRICTION_PATTERNS = [
  /\bincome\s+(?:at\s+or\s+)?below\s+\d{1,3}\s*%/i,
  /\b\d{1,3}\s*%\s+of\s+(?:the\s+)?(?:federal\s+poverty|area\s+median\s+income|ami\b|fpl\b)/i,
  /\blow[-\s]income\s+(?:households?|families|individuals?)\s+only\b/i,
  /\bincome\s+eligibility\s+(?:limits?|requirements?|guidelines?)\s+appl/i,
  /\bmeans[-\s]tested\b/i,
  /\bmust\s+meet\s+income\s+(?:eligibility\s+)?(?:limits?|requirements?|guidelines?)\b/i,
]

// RegExp-array matcher (matchesAnyPattern above takes string PHRASES; the
// restriction corpora in this section are anchored regexes).
function matchesAnyRegex(text, patterns) {
  const t = String(text || '')
  if (!t) return false
  return patterns.some((rx) => rx.test(t))
}

/**
 * Detect an explicit AGE restriction ("must be at least 60 years of age",
 * "ages 14 to 18", "under the age of 25", "65+"). Returns { min, max } (either
 * side may be null) or null when the text states no age restriction. Bounds
 * are sanity-clamped to 5–99; anything else is ignored (likely a false hit).
 */
export function detectAgeRestriction(text) {
  const t = String(text || '')
  const plausible = (n) => (Number.isFinite(n) && n >= 5 && n <= 99 ? n : null)
  let min = null
  let max = null
  const range =
    /\bages?\s+(\d{1,2})\s*(?:to|through|[-–])\s*(\d{1,2})\b/i.exec(t) ||
    /\bbetween\s+(?:the\s+ages\s+of\s+)?(\d{1,2})\s+and\s+(\d{1,2})\s+years?\b/i.exec(t)
  if (range) {
    min = plausible(Number(range[1]))
    max = plausible(Number(range[2]))
  }
  if (min === null) {
    const atLeast =
      /\bmust\s+be\s+(?:at\s+least\s+)?(\d{1,2})\s+years?\s+(?:of\s+age|old)/i.exec(t) ||
      /\b(\d{1,2})\s+years?\s+of\s+age\s+or\s+older\b/i.exec(t) ||
      /\bages?\s+(\d{1,2})\s+(?:and|or)\s+(?:older|above|up)\b/i.exec(t) ||
      /\b([5-9]\d)\s*\+/.exec(t)
    if (atLeast) min = plausible(Number(atLeast[1]))
  }
  if (max === null) {
    const under = /\bunder\s+(?:the\s+)?age\s+(?:of\s+)?(\d{1,2})\b/i.exec(t)
    if (under) {
      const n = plausible(Number(under[1]))
      max = n === null ? null : n - 1
    }
  }
  if (min === null && max === null) return null
  if (min !== null && max !== null && min > max) return null
  return { min, max }
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
    // Structured eligibility (grants.gov "eligible applicants: institutions of
    // higher education", etc.). Without it, the institutional/exclusivity
    // patterns above never see the one field that states who may apply — which
    // is how a universities-only grants.gov notice scored 90+ for a student.
    eligibilityJsonToText(rawOpp.eligibility_json),
    // Free-text "who may apply" prose written by the crawler-os blind
    // extractors (2026-08-03). This was the ONE eligibility field the
    // restriction detectors never read, so a demographic exclusivity stated
    // only here (and not in title/bullets) was invisible to every gate.
    typeof rawOpp.eligibility_text === 'string' ? rawOpp.eligibility_text : '',
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
  const loanAssistanceExempt = /loan\s+(forgiveness|repayment|discharge|cancellation|redemption|relief|assistance)|repay\w*\s+\w*\s*loan|pslf|income.driven repayment|\bloan\s+(?:and|&)\s+grant\b|\bgrants?\s+(?:and|&)\s+loans?\b/i.test(loanText)
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

  // -- Education level the opportunity targets ('k12' | 'higher_ed' | null) --
  const educationLevel = detectEducationLevel(text)

  // -- Already-awarded research/award record (NSF/NIH/USASpending) --
  // These name an awardee institution + PI and are never open to an individual.
  // Classify them as institutional-research-only so the single eligibility gate
  // hard-rejects them for ordinary individuals (but not for research orgs).
  const isAlreadyAwarded = isAlreadyAwardedRecord(rawOpp, text)

  // -- Institutional / research-only flags --
  //
  // STRUCTURAL-KIND OVERRIDE (the MTSU off-campus-housing class, 2026-07-27):
  // a row DECLARED as a resource/pointer kind (school portal, directory,
  // benefit, past-award intel) exists FOR the profile's benefit, and its
  // prose naturally mentions institutions ("many institutions partner with
  // the listing service… institutional housing voucher") — the full-text
  // INSTITUTIONAL/RESEARCH patterns include bare 'institution', so an MTSU
  // student's own housing portal hard-rejected as "institutions or research
  // organizations only". The declared kind is the stronger structural fact
  // (same doctrine as the locator kind tug-of-war): prose-based restriction
  // tells never fire on resource kinds. Explicit DB flags and the
  // already-awarded fingerprint still win — those are structural too.
  const kindLowerForFlags = String(rawOpp.opportunity_kind ?? rawOpp.kind ?? '').toLowerCase()
  const isResourceKind = ['directory', 'benefit', 'past_award_intel', 'school_portal'].includes(kindLowerForFlags)

  const isInstitutionalOnly = Boolean(rawOpp.is_institutional_only) ||
    isAlreadyAwarded ||
    (!isResourceKind && matchesAnyPattern(text, INSTITUTIONAL_PATTERNS))

  const isResearchOnly = Boolean(rawOpp.is_research_only) ||
    isAlreadyAwarded ||
    (!isResourceKind && matchesAnyPattern(text, RESEARCH_ONLY_PATTERNS))

  // -- TITLE-scoped research/TA program + procedural-notice tells --
  // (see the pattern block above for why these read the title only)
  const rawTitle = String(rawOpp.title ?? '')
  // Resource kinds are exempt here too: a "Research Grants Directory" is a
  // pointer to funders, not an institutional program someone applies to.
  const titleIsResearchProgram =
    !isResourceKind &&
    (RE_TITLE_FEDERAL_ACTIVITY_CODE.test(rawTitle) ||
      RE_TITLE_RESEARCH_PROGRAM.test(rawTitle) ||
      RE_TITLE_COMMUNITIES_OF_PRACTICE.test(rawTitle)) &&
    !RE_TITLE_SMALL_BUSINESS_RESEARCH.test(rawTitle)
  const isProceduralNotice = RE_PROCEDURAL_NOTICE_TITLE.test(rawTitle)

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

  // -- Senior/aging program (score-capped for profiles with no senior signal) --
  const isSeniorProgram = matchesAnyPattern(text, SENIOR_PROGRAM_PATTERNS)

  // -- Population / sector restrictions (2026-07-06) --
  // Topical flags cap; requires* flags may hard-gate (explicit exclusivity only).
  const isDvProgram = Boolean(rawOpp.is_dv_program) ||
    matchesAnyRegex(text, DV_PROGRAM_PATTERNS)
  const requiresDvSurvivor = Boolean(rawOpp.requires_dv_survivor) ||
    matchesAnyRegex(text, DV_SURVIVOR_RESTRICTION_PATTERNS)
  const requiresFarmer = Boolean(rawOpp.requires_farmer) ||
    matchesAnyRegex(text, FARMER_RESTRICTION_PATTERNS)
  const requiresFaithBased = Boolean(rawOpp.requires_faith_based) ||
    matchesAnyRegex(text, FAITH_RESTRICTION_PATTERNS)
  const requiresCdc = Boolean(rawOpp.requires_cdc) ||
    matchesAnyRegex(text, CDC_RESTRICTION_PATTERNS)
  const requiresLowIncome = Boolean(rawOpp.requires_low_income) ||
    matchesAnyRegex(text, INCOME_RESTRICTION_PATTERNS)
  const requiresFosterYouth = Boolean(rawOpp.requires_foster_youth) ||
    matchesAnyRegex(text, FOSTER_YOUTH_RESTRICTION_PATTERNS)
  const ageRestriction = detectAgeRestriction(text)

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
    // matchesAnyRegex, NOT matchesAnyPattern (2026-08-03): matchesAnyPattern
    // stringifies its patterns for phrase search, so a RegExp list passed to
    // it can NEVER match — these gates were dead since they shipped, which is
    // how "Society of Women Engineers" reached a male student's task list.
    matchesAnyRegex(text, [
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
  else if (matchesAnyRegex(text, MEN_ONLY_PATTERNS)) requiresGender = 'male'
  else if (requiresWomen || matchesAnyRegex(text, WOMEN_ONLY_RESTRICTION_PATTERNS)) requiresGender = 'female'

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
    titleIsResearchProgram,
    isProceduralNotice,
    isAlreadyAwarded,
    educationLevel,
    diseaseSpecific,
    requiresDisasterContext,
    isDmeOrEquipment,
    isCaregiverProgram,
    isSeniorProgram,
    isDvProgram,
    requiresDvSurvivor,
    requiresFarmer,
    requiresFaithBased,
    requiresCdc,
    requiresLowIncome,
    requiresFosterYouth,
    ageRestriction,
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
    titleIsResearchProgram: normalizedOpp.titleIsResearchProgram,
    isProceduralNotice: normalizedOpp.isProceduralNotice,
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
