/**
 * robertOpportunityNormalizer.js
 *
 * Maps a Robert opportunity candidate (output of
 * `robertOpportunityExtractor.extractCandidates`) into the canonical
 * `funding_opportunities` row shape that
 * `backend/services/opportunityInserter.upsertFundingOpportunity`
 * already accepts. Robert never invents new opportunity columns.
 *
 * The normalizer is PURE — no DB writes, no network. Returns an
 * object that should be passed straight into upsertFundingOpportunity.
 */

const RECORD_ORIGIN = 'discovered'

export function normalizeForCanonicalInsert(candidate, { now = new Date() } = {}) {
  if (!candidate) return null

  const geo = candidate.geography || {}
  const isNational = Boolean(geo.is_national) || (!geo.state && (Array.isArray(candidate.applicant_types) ? candidate.applicant_types.length === 0 : true))

  const normalized = {
    title: trim(candidate.title),
    sponsor: trim(candidate.sponsor),
    description: trim(candidate.description),
    amount_min: numberOrNull(candidate.amount_min),
    amount_max: numberOrNull(candidate.amount_max),
    amount_description: trim(candidate.amount_description),
    deadline: trim(candidate.deadline),
    deadline_type: trim(candidate.deadline_type) || (candidate.deadline ? 'fixed' : 'unknown'),
    application_url: trim(candidate.application_url),
    apply_url: trim(candidate.application_url),
    source_url: trim(candidate.source_url) || trim(candidate.application_url),
    categories: Array.isArray(candidate.categories) ? candidate.categories.slice() : [],
    keywords: Array.isArray(candidate.keywords) ? candidate.keywords.slice() : [],
    eligibility_bullets: Array.isArray(candidate.eligibility) ? candidate.eligibility.slice() : [],
    applicant_types: Array.isArray(candidate.applicant_types) ? candidate.applicant_types.slice() : [],
    need_categories: Array.isArray(candidate.need_categories) ? candidate.need_categories.slice() : [],
    state: trim(geo.state),
    is_national: isNational,
    source: 'robert',
    source_id: trim(candidate.source_url) || trim(candidate.application_url) || null,
    record_origin: RECORD_ORIGIN,
    raw_source_payload: candidate.raw_payload || null,
    verification_method: trim(candidate.extraction_method) || 'robert_extractor',
    last_verified_at: now.toISOString(),
    discovered_at: now.toISOString(),
  }

  // Strip empties so downstream insert validation gets a clean object.
  for (const k of Object.keys(normalized)) {
    if (normalized[k] === null || normalized[k] === undefined || normalized[k] === '') delete normalized[k]
  }
  return normalized
}

function trim(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s.length === 0 ? null : s
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export const ROBERT_RECORD_ORIGIN = RECORD_ORIGIN
export const __testing__ = { trim, numberOrNull }
