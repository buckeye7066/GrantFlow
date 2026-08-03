import { normalizeState } from '../../utils/stateNormalization.js'
import {
  classifyFundingResult,
  isRelevantGeo,
  passesEligibility,
  RESULT_BUCKETS,
} from '../../config/fundingResultFilters.js'
import { classifyProductionProfile } from '../../config/productionProfileScope.js'
import { cleanExtractedText } from '../../utils/htmlTextHygiene.js'
import { computeMatchDecision } from '../matchEngine.js'
import {
  applyNeedFirstScoring,
  NEED_FIRST_SCORING_VERSION,
} from './needFirstScoringAdapter.js'

/**
 * Read-only fallback over REAL catalog programs. It never invents a grant,
 * inserts a match row, or changes the canonical score. The owner-facing route
 * consults it only when a real profile would otherwise have no visible result.
 *
 * The active/visible predicate is in SQL BEFORE LIMIT. A post-limit JS filter
 * would let a large stale row set permanently starve the valid baseline rows.
 * TRUE/FALSE literals work for both Postgres booleans and SQLite integers.
 */
export const COLD_START_CATALOG_SQL = `
SELECT *
  FROM funding_opportunities
 WHERE COALESCE(is_active, TRUE) = TRUE
   AND COALESCE(is_hidden, FALSE) = FALSE
   AND (
        lower(COALESCE(title, '')) LIKE '%medicaid%'
     OR lower(COALESCE(description, '')) LIKE '%medicaid%'
     OR lower(COALESCE(title, '')) LIKE '%tenncare%'
     OR lower(COALESCE(title, '')) LIKE '%liheap%'
     OR lower(COALESCE(description, '')) LIKE '%low income home energy assistance%'
     OR lower(COALESCE(title, '')) LIKE '%supplemental nutrition assistance%'
     OR lower(COALESCE(title, '')) LIKE '%snap%'
     OR lower(COALESCE(title, '')) LIKE '%supplemental security income%'
     OR lower(COALESCE(title, '')) LIKE '%social security disability insurance%'
     OR lower(COALESCE(title, '')) LIKE '%federal pell grant%'
     OR lower(COALESCE(title, '')) LIKE '%federal work-study%'
     OR lower(COALESCE(title, '')) LIKE '%federal work study%'
   )
 ORDER BY updated_at DESC, id
 LIMIT ?`

const ORGANIZATION_TYPES = new Set([
  'business', 'small_business', 'nonprofit', 'church', 'ministry', 'school',
  'college', 'university', 'government', 'government_agency', 'municipality',
  'county', 'tribe', 'tribal_government', 'foundation', 'corporation', 'llc',
])

const GOVERNMENT_TYPES = new Set([
  'government', 'government_agency', 'municipality', 'county', 'state_agency',
  'federal_agency', 'public_agency', 'tribal_government',
])

const STUDENT_TYPES = new Set([
  'student', 'high_school_student', 'college_student', 'undergraduate_student',
  'graduate_student', 'adult_learner',
])

const CORE_FAMILIES = new Set(['medicaid', 'snap', 'liheap'])

function normalizeType(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value.answers && typeof value.answers === 'object' ? value.answers : value
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined || value === '') return []
  if (typeof value !== 'string') return [value]
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return trimmed.split(/[,;|]/).map((entry) => entry.trim()).filter(Boolean)
}

function parseArrayField(value) {
  return asArray(value).map((entry) => String(entry ?? '').trim()).filter(Boolean)
}

function truthfulEvidenceText(value, key = '', depth = 0) {
  if (value === null || value === undefined || depth > 5) return ''
  if (value === true) return key.replace(/[_-]+/g, ' ')
  if (value === false) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    return value.map((entry) => truthfulEvidenceText(entry, key, depth + 1)).join(' ')
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([childKey, child]) => truthfulEvidenceText(child, childKey, depth + 1))
      .join(' ')
  }
  return ''
}

function ageFromContext(profileContext = {}) {
  const profile = profileContext.profile ?? {}
  const demographics = asObject(profileContext.sections?.demographics)
  const direct = Number(profile.age ?? demographics.age)
  if (Number.isFinite(direct) && direct > 0) return direct
  const birth = profile.date_of_birth ?? profile.dob ?? demographics.date_of_birth ?? demographics.dob
  if (!birth) return null
  const parsed = new Date(birth)
  if (Number.isNaN(parsed.getTime())) return null
  const now = new Date()
  let age = now.getUTCFullYear() - parsed.getUTCFullYear()
  const birthdayPassed =
    now.getUTCMonth() > parsed.getUTCMonth() ||
    (now.getUTCMonth() === parsed.getUTCMonth() && now.getUTCDate() >= parsed.getUTCDate())
  if (!birthdayPassed) age -= 1
  return age >= 0 ? age : null
}

export function classifyColdStartProfile(profileContext = {}) {
  const production = classifyProductionProfile(profileContext)
  if (!production.production) {
    return {
      eligible: false,
      reason: production.reason,
      type: null,
      individualRoot: false,
      publicAgencyRoot: false,
      states: [],
      isStudent: false,
      hasDisabilityEvidence: false,
      isSenior: false,
    }
  }

  const profile = profileContext.profile ?? profileContext ?? {}
  const sections = profileContext.sections ?? {}
  const education = asObject(sections.education)
  const organization = asObject(sections.organization_details)
  const type = normalizeType(
    profile.primary_type ??
    profile.profile_type ??
    profile.applicant_type ??
    profile.entity_type ??
    organization.organization_type,
  )
  const publicAgencyRoot = GOVERNMENT_TYPES.has(type)
  const organizationEvidence = Boolean(
    ORGANIZATION_TYPES.has(type) ||
    profile.ein ||
    organization.ein ||
    organization.is_nonprofit === true ||
    organization.is_for_profit === true ||
    organization.is_faith_based === true,
  )
  if (organizationEvidence) {
    return {
      eligible: false,
      reason: publicAgencyRoot ? 'public_agency_profile' : 'organization_profile',
      type,
      individualRoot: false,
      publicAgencyRoot,
      states: [],
      isStudent: false,
      hasDisabilityEvidence: false,
      isSenior: false,
    }
  }

  const stateCandidates = [
    profile.state,
    profile.geo_state,
    profileContext.signals?.location?.state,
    asObject(sections.contact_information).state,
    asObject(sections.demographics).state,
  ]
  const states = [...new Set(stateCandidates.map(normalizeState).filter(Boolean))]
  const applications = asObject(sections.university_applications).applications
  const isStudent = Boolean(
    STUDENT_TYPES.has(type) ||
    education.student_status === true ||
    education.current_institution ||
    education.current_college ||
    education.intended_major ||
    education.field_of_study ||
    Number(education.gpa) > 0 ||
    (Array.isArray(applications) && applications.length > 0),
  )
  const evidence = truthfulEvidenceText({ profile, sections, signals: profileContext.signals })
  const hasDisabilityEvidence = /\b(disabilit|disabled|impairment|mobility limitation|wheelchair|developmental delay|intellectual disability|ssdi|supplemental security income|ssi)\b/i.test(evidence)
  const age = ageFromContext(profileContext)
  const isSenior = Number.isFinite(age) && age >= 65

  return {
    eligible: true,
    reason: null,
    type,
    individualRoot: true,
    publicAgencyRoot: false,
    states,
    isStudent,
    hasDisabilityEvidence,
    isSenior,
  }
}

export function coldStartProgramFamily(row = {}) {
  const text = `${row.title ?? ''} ${row.sponsor ?? ''} ${row.description ?? ''}`.toLowerCase()
  if (/\bmedicaid\b|\btenncare\b/.test(text)) return 'medicaid'
  if (/\bliheap\b|\blow income home energy assistance program\b/.test(text)) return 'liheap'
  if (/\bsupplemental nutrition assistance program\b|\bsnap\b/.test(text)) return 'snap'
  if (/\bsocial security disability insurance\b|\bssdi\b/.test(text)) return 'ssdi'
  if (/\bsupplemental security income\b|\bssi\b/.test(text)) return 'ssi'
  if (/\bfederal pell grants?\b|\bpell grants?\b/.test(text)) return 'pell'
  if (/\bfederal work[- ]study\b/.test(text)) return 'work_study'
  return null
}

export function familyAllowedForColdStart(family, classification) {
  if (!classification?.eligible || !family) return false
  if (CORE_FAMILIES.has(family)) return true
  if (family === 'ssdi') return classification.hasDisabilityEvidence === true
  if (family === 'ssi') return classification.hasDisabilityEvidence === true || classification.isSenior === true
  if (family === 'pell' || family === 'work_study') return classification.isStudent === true
  return false
}

function isActiveCatalogRow(row = {}) {
  const active = row.is_active
  const hidden = row.is_hidden
  const activeEnough = active === null || active === undefined || active === true || active === 1 || active === '1'
  const visibleEnough = hidden === null || hidden === undefined || hidden === false || hidden === 0 || hidden === '0'
  return activeEnough && visibleEnough
}

function completeness(row = {}, classification = {}) {
  const rowState = normalizeState(row.state)
  let score = 0
  if (rowState && classification.states.includes(rowState)) score += 12
  if (row.is_national === true || row.is_national === 1) score += 6
  if (String(row.application_url ?? row.apply_url ?? '').trim()) score += 5
  if (String(row.source_url ?? '').trim()) score += 2
  if (Number(row.amount_min) > 0 || Number(row.amount_max) > 0) score += 2
  if (String(row.deadline ?? row.deadline_type ?? '').trim()) score += 2
  if (String(row.sponsor ?? '').trim()) score += 2
  if (String(row.description ?? '').trim().length > 80) score += 1
  return score
}

function canonicalDecision(profileContext, opportunity) {
  const canonical = computeMatchDecision(
    profileContext.profile ?? profileContext,
    opportunity,
    {
      profileSections: profileContext.sections ?? {},
      signals: profileContext.signals ?? {},
    },
  )
  return applyNeedFirstScoring({
    canonical,
    profileContext,
    opportunity,
  })
}

function sourceFromCandidate(row, decision, family) {
  const matchExplain = {
    ...(decision.match_explain ?? {}),
    cold_start_fallback: true,
    cold_start_program_family: family,
    eligibility_unconfirmed: true,
  }
  return {
    id: row.id,
    title: cleanExtractedText(row.title),
    sponsor: cleanExtractedText(row.sponsor),
    summary: cleanExtractedText(row.description),
    url: row.application_url ?? row.apply_url ?? row.source_url ?? null,
    application_url: row.application_url ?? row.apply_url ?? null,
    source_url: row.source_url ?? null,
    external_id: row.external_id ?? null,
    source: row.source ?? null,
    deadline: row.deadline ?? null,
    deadline_type: row.deadline_type ?? null,
    is_rolling: String(row.deadline_type ?? '').toLowerCase() === 'rolling',
    amount_min: row.amount_min ?? null,
    amount_max: row.amount_max ?? null,
    geography: row.is_national ? 'National' : (row.state || null),
    categories: parseArrayField(row.categories),
    match_score: Number.isFinite(Number(decision.score)) ? Math.round(Number(decision.score)) : 0,
    raw_match_score: Number.isFinite(Number(decision.score)) ? Math.round(Number(decision.score)) : 0,
    match_decision: 'review',
    why: 'Verified baseline program retained for a sparse profile; confirm program eligibility before applying.',
    match_reasons: [
      ...(Array.isArray(decision.reasons) ? decision.reasons : []),
      'Cold-start baseline from the verified funding catalog',
      'Eligibility is not confirmed by the sparse profile',
    ],
    match_explain_json: matchExplain,
    opportunity_kind: String(row.opportunity_kind ?? row.opportunity_type ?? row.type ?? '').toUpperCase() || null,
    is_directory: false,
    trust_tier: row.source_trust_tier ?? null,
    matcher_version: decision.matcherVersion ?? null,
    scoring_policy_version: decision.scoringPolicyVersion ?? NEED_FIRST_SCORING_VERSION,
    cold_start_fallback: true,
    cold_start_program_family: family,
    eligibility_confirmed: false,
  }
}

/**
 * Return a bounded, de-duplicated baseline for a sparse real profile.
 * Every returned row is an existing active catalog record and has passed the
 * same global junk, applicant-type, geography, and canonical match gates.
 */
export async function buildColdStartFundingFallback(db, profileContext, { limit = 6, scanLimit = 200 } = {}) {
  const classification = classifyColdStartProfile(profileContext)
  const telemetry = {
    attempted: true,
    eligible_profile: classification.eligible,
    profile_reason: classification.reason,
    scanned: 0,
    kept: 0,
    removed: 0,
    families: [],
    errors: [],
  }
  if (!classification.eligible) return { sources: [], telemetry }

  let rows
  try {
    rows = await db.prepare(COLD_START_CATALOG_SQL).all(Math.max(limit, scanLimit))
  } catch (error) {
    telemetry.errors.push(error?.message || String(error))
    return { sources: [], telemetry }
  }
  const candidates = Array.isArray(rows) ? rows : []
  telemetry.scanned = candidates.length

  const bestByFamily = new Map()
  for (const row of candidates) {
    if (!isActiveCatalogRow(row)) {
      telemetry.removed += 1
      continue
    }
    const family = coldStartProgramFamily(row)
    if (!familyAllowedForColdStart(family, classification)) {
      telemetry.removed += 1
      continue
    }
    const classResult = classifyFundingResult(row)
    if (classResult.bucket !== RESULT_BUCKETS.FUNDABLE) {
      telemetry.removed += 1
      continue
    }
    const eligibility = passesEligibility(row, {
      individualRoot: classification.individualRoot,
      publicAgencyRoot: classification.publicAgencyRoot,
    })
    if (!eligibility.eligible) {
      telemetry.removed += 1
      continue
    }
    const geo = isRelevantGeo(row, { states: classification.states })
    if (!geo.relevant) {
      telemetry.removed += 1
      continue
    }

    let decision
    try {
      decision = canonicalDecision(profileContext, row)
    } catch (error) {
      telemetry.errors.push(`${row.id ?? row.title ?? 'candidate'}: ${error?.message || String(error)}`)
      telemetry.removed += 1
      continue
    }
    if (String(decision?.decision ?? '').toLowerCase() === 'reject') {
      telemetry.removed += 1
      continue
    }

    const candidate = {
      row,
      family,
      decision,
      rank: completeness(row, classification),
    }
    const current = bestByFamily.get(family)
    if (!current || candidate.rank > current.rank ||
      (candidate.rank === current.rank && Number(candidate.decision.score ?? 0) > Number(current.decision.score ?? 0))) {
      bestByFamily.set(family, candidate)
    }
  }

  const familyOrder = ['medicaid', 'snap', 'liheap', 'ssdi', 'ssi', 'pell', 'work_study']
  const sources = familyOrder
    .map((family) => bestByFamily.get(family))
    .filter(Boolean)
    .slice(0, Math.max(1, limit))
    .map(({ row, decision, family }) => sourceFromCandidate(row, decision, family))

  telemetry.kept = sources.length
  telemetry.families = sources.map((source) => source.cold_start_program_family)
  return { sources, telemetry }
}

export default {
  COLD_START_CATALOG_SQL,
  classifyColdStartProfile,
  coldStartProgramFamily,
  familyAllowedForColdStart,
  buildColdStartFundingFallback,
}
