/**
 * Canonical opportunity read contract for the existing JavaScript catalog.
 *
 * This module does not create a second opportunity model. It projects the
 * long-lived `funding_opportunities` row into one stable API shape, preserving
 * the legacy columns while naming missing facts and deriving lifecycle labels
 * deterministically. Derivations never manufacture source facts: a derived
 * status includes its basis, and an absent source field stays absent.
 */

export const OPPORTUNITY_STATUS = Object.freeze({
  OPEN: 'open',
  CLOSING_SOON: 'closing_soon',
  CLOSED: 'closed',
  FORECASTED: 'forecasted',
  ROLLING: 'rolling',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
  UNKNOWN: 'unknown',
})

export const OPPORTUNITY_STATUS_VALUES = Object.freeze(Object.values(OPPORTUNITY_STATUS))

export const CANONICAL_OPPORTUNITY_FIELDS = Object.freeze([
  'canonical_opportunity_id',
  'source_id',
  'title',
  'funder',
  'description',
  'category',
  'purpose',
  'applicant_types',
  'geographic_limitations',
  'eligibility_requirements',
  'funding_range',
  'estimated_award',
  'open_date',
  'deadline',
  'recurrence',
  'required_documents',
  'application_method',
  'authoritative_application_url',
  'source_url',
  'provenance',
  'first_published_at',
  'last_verified_at',
  'current_status',
])

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_CLOSING_SOON_DAYS = 14

function nonEmptyString(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text : null
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = nonEmptyString(value)?.toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  return null
}

export function parseOpportunityJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

export function opportunityStringList(value) {
  const parsed = parseOpportunityJson(value, value)
  const raw = Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed]
  return [...new Set(raw
    .filter((item) => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter(Boolean))]
}

function structuredValue(value, fallback = null) {
  const parsed = parseOpportunityJson(value, value)
  if (parsed === null || parsed === undefined || parsed === '') return fallback
  if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : fallback
  if (typeof parsed === 'object') return Object.keys(parsed).length > 0 ? parsed : fallback
  return nonEmptyString(parsed) ?? fallback
}

function dayNumber(value) {
  if (!value) return null
  const raw = nonEmptyString(value)
  if (!raw) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  const parsed = iso
    ? new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`)
    : new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
}

function todayNumber(now) {
  const value = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(value.getTime())) return todayNumber(new Date())
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
}

export function normalizeOpportunitySourceStatus(value) {
  const raw = nonEmptyString(value)?.toLowerCase().replace(/[\s-]+/g, '_')
  if (!raw) return null
  if (['posted', 'active', 'opened', 'open'].includes(raw)) return OPPORTUNITY_STATUS.OPEN
  if (['forecast', 'forecasted', 'upcoming', 'planned'].includes(raw)) return OPPORTUNITY_STATUS.FORECASTED
  if (['rolling', 'ongoing'].includes(raw)) return OPPORTUNITY_STATUS.ROLLING
  if (['closed', 'expired', 'deadline_expired', 'deadline_passed'].includes(raw)) return OPPORTUNITY_STATUS.CLOSED
  if (['paused', 'suspended'].includes(raw)) return OPPORTUNITY_STATUS.PAUSED
  if (['archived', 'retired', 'permanently_retired', 'quarantined'].includes(raw)) return OPPORTUNITY_STATUS.ARCHIVED
  if (raw === OPPORTUNITY_STATUS.CLOSING_SOON) return OPPORTUNITY_STATUS.CLOSING_SOON
  if (raw === OPPORTUNITY_STATUS.UNKNOWN) return OPPORTUNITY_STATUS.UNKNOWN
  return null
}

function firstKnownSourceStatus(row = {}) {
  // `current_status` is this module's derived projection and is written back to
  // the row after every sync. Feeding it into the next derivation makes an old
  // deadline-derived `closed` value sticky after a funder extends the deadline.
  // Only source/legacy source fields may act as lifecycle evidence here.
  const candidates = [row.source_status, row.opp_status, row.opportunity_status, row.status]
  for (const candidate of candidates) {
    const normalized = normalizeOpportunitySourceStatus(candidate)
    if (normalized && normalized !== OPPORTUNITY_STATUS.UNKNOWN) return normalized
  }
  return OPPORTUNITY_STATUS.UNKNOWN
}

function statusResult(code, label, basis, extra = {}) {
  return Object.freeze({ code, label, basis, ...extra })
}

/**
 * Derive the user-facing lifecycle status from stored source facts.
 *
 * Fixed dates are compared at UTC calendar-day precision so the same row gets
 * the same label regardless of the server timezone. `now` is injectable for
 * tests and audit replays.
 */
export function deriveOpportunityStatus(row = {}, options = {}) {
  const nowDay = todayNumber(options.now ?? new Date())
  const closingSoonDays = Number.isFinite(Number(options.closingSoonDays))
    ? Math.max(0, Number(options.closingSoonDays))
    : DEFAULT_CLOSING_SOON_DAYS
  const sourceStatus = firstKnownSourceStatus(row)
  const deadlineDay = dayNumber(row.deadline ?? row.deadline_at)
  const openDay = dayNumber(row.open_date)
  const deadlineType = nonEmptyString(row.deadline_type)?.toLowerCase()
  const active = booleanValue(row.is_active)

  if (sourceStatus === OPPORTUNITY_STATUS.ARCHIVED) {
    return statusResult(OPPORTUNITY_STATUS.ARCHIVED, 'Archived', 'source_status')
  }
  if (sourceStatus === OPPORTUNITY_STATUS.PAUSED) {
    return statusResult(OPPORTUNITY_STATUS.PAUSED, 'Paused', 'source_status')
  }
  if (sourceStatus === OPPORTUNITY_STATUS.CLOSED) {
    return statusResult(OPPORTUNITY_STATUS.CLOSED, 'Closed', 'source_status')
  }
  if (deadlineDay !== null && deadlineDay < nowDay) {
    return statusResult(OPPORTUNITY_STATUS.CLOSED, 'Closed', 'deadline_passed', {
      days_until_deadline: Math.floor((deadlineDay - nowDay) / DAY_MS),
    })
  }
  if (openDay !== null && openDay > nowDay) {
    return statusResult(OPPORTUNITY_STATUS.FORECASTED, 'Opens soon', 'open_date', {
      days_until_open: Math.ceil((openDay - nowDay) / DAY_MS),
    })
  }
  if (sourceStatus === OPPORTUNITY_STATUS.FORECASTED) {
    return statusResult(OPPORTUNITY_STATUS.FORECASTED, 'Forecasted', 'source_status')
  }
  if (sourceStatus === OPPORTUNITY_STATUS.ROLLING || ['rolling', 'ongoing'].includes(deadlineType)) {
    return statusResult(OPPORTUNITY_STATUS.ROLLING, 'Rolling', sourceStatus === OPPORTUNITY_STATUS.ROLLING ? 'source_status' : 'deadline_type')
  }
  if (active === false) {
    return statusResult(OPPORTUNITY_STATUS.CLOSED, 'Closed', 'inactive_record')
  }
  if (deadlineDay !== null) {
    const days = Math.ceil((deadlineDay - nowDay) / DAY_MS)
    if (days <= closingSoonDays) {
      return statusResult(OPPORTUNITY_STATUS.CLOSING_SOON, 'Closing soon', 'deadline_window', {
        days_until_deadline: days,
      })
    }
    return statusResult(OPPORTUNITY_STATUS.OPEN, 'Open', 'future_deadline', {
      days_until_deadline: days,
    })
  }
  if (sourceStatus === OPPORTUNITY_STATUS.OPEN) {
    return statusResult(OPPORTUNITY_STATUS.OPEN, 'Open', 'source_status')
  }
  return statusResult(OPPORTUNITY_STATUS.UNKNOWN, 'Status not confirmed', 'insufficient_evidence')
}

export function deriveOpportunityVerification(row = {}, options = {}) {
  const linkStatus = nonEmptyString(row.link_status)?.toLowerCase() ?? 'unverified'
  const verifiedAt = nonEmptyString(row.last_verified_at)
  const verifiedDay = dayNumber(verifiedAt)
  const nowDay = todayNumber(options.now ?? new Date())
  const ageDays = verifiedDay === null ? null : Math.max(0, Math.floor((nowDay - verifiedDay) / DAY_MS))

  if (['broken', 'dead', 'failed'].includes(linkStatus)) {
    return Object.freeze({ code: 'needs_review', label: 'Link needs review', link_status: linkStatus, verified_at: verifiedAt, age_days: ageDays })
  }
  if (verifiedAt && ['ok', 'redirect'].includes(linkStatus)) {
    return Object.freeze({ code: 'verified', label: 'Verified', link_status: linkStatus, verified_at: verifiedAt, age_days: ageDays })
  }
  if (verifiedAt) {
    return Object.freeze({ code: 'checked_unconfirmed', label: 'Checked; not confirmed', link_status: linkStatus, verified_at: verifiedAt, age_days: ageDays })
  }
  return Object.freeze({ code: 'unverified', label: 'Not yet verified', link_status: linkStatus, verified_at: null, age_days: null })
}

function geographicLimitations(row) {
  const explicit = structuredValue(row.geographic_limitations ?? row.geo_eligibility)
  if (explicit) return explicit
  const regions = opportunityStringList(row.regions)
  const state = nonEmptyString(row.state)
  const national = booleanValue(row.is_national)
  if (national === null && !state && regions.length === 0 && !row.geo_county && !row.geo_zip) return null
  return {
    national: national === true,
    states: state && state.toLowerCase() !== 'nationwide' ? [state] : [],
    regions,
    counties: row.geo_county ? [String(row.geo_county)] : [],
    zips: row.geo_zip ? [String(row.geo_zip)] : [],
  }
}

function eligibilityRequirements(row) {
  const explicit = structuredValue(row.eligibility_requirements)
  if (explicit) return explicit
  const text = nonEmptyString(row.eligibility_text)
  const bullets = opportunityStringList(row.eligibility_bullets)
  if (!text && bullets.length === 0) return null
  return { text, bullets }
}

function provenanceFor(row) {
  const fieldProvenance = structuredValue(row.field_provenance)
  const source = nonEmptyString(row.source)
  const recordOrigin = nonEmptyString(row.record_origin)
  const evidenceUrl = nonEmptyString(row.evidence_url)
  const sourceUrl = nonEmptyString(row.source_url)
  if (!source && !recordOrigin && !evidenceUrl && !sourceUrl && !fieldProvenance) return null
  return {
    source,
    source_id: nonEmptyString(row.source_id),
    record_origin: recordOrigin,
    evidence_url: evidenceUrl,
    field_provenance: fieldProvenance,
  }
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function findMissingOpportunityFields(model = {}) {
  return CANONICAL_OPPORTUNITY_FIELDS.filter((field) => {
    if (field === 'current_status') return model.current_status === OPPORTUNITY_STATUS.UNKNOWN
    return !hasMeaningfulValue(model[field])
  })
}

/** Build the canonical API projection while retaining the legacy row fields. */
export function buildOpportunityReadModel(row = {}, options = {}) {
  const category = opportunityStringList(row.category ?? row.categories)
  const applicantTypes = opportunityStringList(row.applicant_types ?? row.entity_types_allowed)
  const requiredDocuments = opportunityStringList(row.required_documents)
  const dataQualityFlags = opportunityStringList(row.data_quality_flags)
  const lifecycle = deriveOpportunityStatus(row, options)
  const verification = deriveOpportunityVerification(row, options)
  const amountMin = finiteNumber(row.amount_min)
  const amountMax = finiteNumber(row.amount_max)
  const fundingRange = amountMin === null && amountMax === null
    ? null
    : { min: amountMin, max: amountMax, currency: nonEmptyString(row.currency) ?? 'USD' }
  const sourceStatus = firstKnownSourceStatus(row)

  const canonical = {
    canonical_opportunity_id: nonEmptyString(row.canonical_opportunity_id ?? row.id),
    source_id: nonEmptyString(row.source_id),
    title: nonEmptyString(row.title),
    funder: nonEmptyString(row.funder ?? row.sponsor),
    description: nonEmptyString(row.description ?? row.summary),
    category,
    purpose: nonEmptyString(row.purpose),
    applicant_types: applicantTypes,
    geographic_limitations: geographicLimitations(row),
    eligibility_requirements: eligibilityRequirements(row),
    funding_range: fundingRange,
    estimated_award: finiteNumber(row.estimated_award),
    open_date: nonEmptyString(row.open_date),
    deadline: nonEmptyString(row.deadline ?? row.deadline_at),
    recurrence: nonEmptyString(row.recurrence),
    required_documents: requiredDocuments,
    application_method: nonEmptyString(row.application_method ?? row.application_mode),
    authoritative_application_url: nonEmptyString(row.authoritative_application_url ?? row.application_url ?? row.apply_url),
    source_url: nonEmptyString(row.source_url),
    provenance: provenanceFor(row),
    first_published_at: nonEmptyString(row.first_published_at),
    first_seen_at: nonEmptyString(row.discovered_at ?? row.created_at),
    last_verified_at: nonEmptyString(row.last_verified_at),
    source_status: sourceStatus,
    current_status: lifecycle.code,
    status_label: lifecycle.label,
    lifecycle_status: lifecycle,
    verification,
    change_history: Array.isArray(options.changeHistory)
      ? options.changeHistory
      : Array.isArray(row.change_history) ? row.change_history : [],
  }

  const missing = findMissingOpportunityFields(canonical)
  const explicitQualityScore = finiteNumber(row.data_quality_score)
  const completenessScore = Number(((CANONICAL_OPPORTUNITY_FIELDS.length - missing.length) / CANONICAL_OPPORTUNITY_FIELDS.length).toFixed(3))
  const generatedFlags = []
  if (missing.length > 0) generatedFlags.push('missing_canonical_fields')
  if (verification.code === 'unverified') generatedFlags.push('unverified_source')
  if (verification.code === 'needs_review') generatedFlags.push('broken_or_unreachable_link')
  if (lifecycle.code === OPPORTUNITY_STATUS.UNKNOWN) generatedFlags.push('status_not_confirmed')
  const flags = [...new Set([...dataQualityFlags, ...generatedFlags])]

  return {
    ...row,
    ...canonical,
    missing_fields: missing,
    data_quality_flags: flags,
    data_quality_score: explicitQualityScore ?? completenessScore,
    data_quality: {
      score: explicitQualityScore ?? completenessScore,
      basis: explicitQualityScore === null ? 'canonical_field_completeness' : 'source_or_review_score',
      missing_fields: missing,
      flags,
    },
  }
}

export function opportunityContractSnapshot(row = {}, options = {}) {
  const model = buildOpportunityReadModel(row, options)
  return {
    title: model.title,
    funder: model.funder,
    description: model.description,
    purpose: model.purpose,
    category: model.category,
    applicant_types: model.applicant_types,
    geographic_limitations: model.geographic_limitations,
    eligibility_requirements: model.eligibility_requirements,
    funding_range: model.funding_range,
    estimated_award: model.estimated_award,
    open_date: model.open_date,
    deadline: model.deadline,
    recurrence: model.recurrence,
    required_documents: model.required_documents,
    application_method: model.application_method,
    authoritative_application_url: model.authoritative_application_url,
    source_url: model.source_url,
    first_published_at: model.first_published_at,
    source_status: model.source_status,
    last_verified_at: model.last_verified_at,
    link_status: nonEmptyString(row.link_status),
    reality_status: nonEmptyString(row.reality_status),
  }
}

export default {
  OPPORTUNITY_STATUS,
  OPPORTUNITY_STATUS_VALUES,
  CANONICAL_OPPORTUNITY_FIELDS,
  normalizeOpportunitySourceStatus,
  deriveOpportunityStatus,
  deriveOpportunityVerification,
  buildOpportunityReadModel,
  findMissingOpportunityFields,
  opportunityContractSnapshot,
}
