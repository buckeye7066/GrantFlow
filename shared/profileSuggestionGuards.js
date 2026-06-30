import { SECTION_METADATA } from '../src/config/sectionMetadata.js'

const LONG_TEXT_FIELDS = new Set(['notes', 'personal_statement', 'goals', 'mission', 'needs_description'])
const HOUSEHOLD_EVIDENCE = /\b(dependent child|household (?:member )?receives|parent gets|parent receives|child of|spouse receives)\b/i
const BENEFIT_BASES = ['medicaid', 'medicare', 'ssi', 'ssdi', 'snap', 'tanf', 'section8']
const OCCUPATION_FLAGS = new Set([
  'healthcare_worker',
  'ems_worker',
  'educator',
  'firefighter',
  'law_enforcement',
  'public_servant',
  'clergy',
  'missionary',
  'nonprofit_employee',
  'small_business_owner',
  'minority_owned_business',
  'women_owned_business',
  'union_member',
  'farmer',
  'truck_driver',
  'veteran',
  'active_duty',
  'active_duty_military',
  'reservist',
  'national_guard',
  'first_responder',
])

export const PROFILE_FIELD_ALIASES = Object.freeze({
  basic_information: {
    // Legacy forms / quick-fill / AI writes used short keys that don't match the
    // canonical section schema, so the guard silently dropped them as
    // "unknown_field" — a real data-loss bug (ZIP especially, which matching
    // depends on). Route them to the canonical field instead of discarding.
    zip: 'zip_code',
    postal_code: 'zip_code',
    postal: 'zip_code',
    profile_category: 'profile_type',
    category: 'profile_type',
  },
  education: {
    // Older imports used current_school inside education; keep the education section canonical.
    current_school: 'current_institution',
  },
  location_focus: {
    // Conversational tools sometimes say "location"; matching uses geographic_focus.
    location: 'geographic_focus',
  },
})

function normalizeSentence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitSentences(value) {
  return String(value || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function jaccard(a, b) {
  const aTokens = new Set(normalizeSentence(a).split(' ').filter(Boolean))
  const bTokens = new Set(normalizeSentence(b).split(' ').filter(Boolean))
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length
  const union = new Set([...aTokens, ...bTokens]).size
  return intersection / union
}

/**
 * Merge an AI-suggested long-text update into an existing value without
 * duplicating sentences the user already has.
 *
 * IMPORTANT — explicit-clear semantics (Mission goal 9: explainable,
 * Mission goal 7: clear discovery UI, plus the user-facing rule
 * "If results are found but not displayed, treat this as a bug, not a
 * UX choice"):
 *   - If `suggestionValue` is explicitly an empty string (user cleared
 *     the textarea), or only whitespace, the user wants the field
 *     CLEARED — return `''` so the save round-trips a delete.
 *   - If `suggestionValue` is `null` or `undefined` (no signal at all,
 *     e.g. an AI suggestion that omitted the field), preserve the
 *     existing value so AI augmentation never wipes user prose.
 *   - Otherwise, splice in only the new sentences (existing behaviour).
 *
 * Without this distinction, every clear of `notes` / `mission` / `goals`
 * / `personal_statement` / `needs_description` was silently reverted to
 * the pre-edit value the moment the form re-saved — which is exactly
 * the regression Kimberly's profile hit when the user tried to remove
 * the incorrect "nonprofit employee and small business owner" line
 * from her Occupational notes.
 */
export function dedupeLongText(existingValue, suggestionValue, threshold = 0.85) {
  if (suggestionValue === null || suggestionValue === undefined) {
    return existingValue ?? ''
  }
  if (typeof suggestionValue === 'string' && suggestionValue.trim() === '') {
    return ''
  }
  const existingSentences = splitSentences(existingValue)
  const nextSentences = splitSentences(suggestionValue)
  const additions = nextSentences.filter((candidate) =>
    existingSentences.every((existing) => jaccard(existing, candidate) < threshold),
  )
  return [...existingSentences, ...additions].join(' ').trim()
}

function evidenceFor(payload, key) {
  const evidence = payload?.evidence
  if (evidence && typeof evidence === 'object' && evidence[key]) return String(evidence[key])
  return String(payload?.[`${key}_evidence`] ?? payload?.supporting_evidence ?? payload?.evidence_text ?? '')
}

function evidenceText(payload) {
  const parts = []
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (key === 'evidence_text' || key === 'supporting_evidence' || key.endsWith('_evidence')) parts.push(String(value))
  }
  if (payload?.evidence && typeof payload.evidence === 'object') {
    parts.push(...Object.values(payload.evidence).map((value) => String(value)))
  } else if (typeof payload?.evidence === 'string') {
    parts.push(payload.evidence)
  }
  return parts.join(' ')
}

function householdTargetFor(key) {
  for (const base of BENEFIT_BASES) {
    if (key === `${base}_recipient_self` || key === `${base}_recipient`) return `${base}_recipient_household`
    if (base === 'medicaid' && key === 'medicaid_enrolled') return 'medicaid_recipient_household'
    if (base === 'section8' && key === 'section8_housing') return 'section8_recipient_household'
  }
  return null
}

function selfTargetFor(key) {
  if (key === 'medicaid_enrolled') return 'medicaid_recipient_self'
  if (key === 'section8_housing') return 'section8_recipient_self'
  if (key.endsWith('_recipient')) return `${key}_self`
  return key
}

function normalizeProfileSectionAliases(data, sectionKey) {
  const aliases = PROFILE_FIELD_ALIASES[sectionKey] ?? {}
  const normalized = {}
  const aliasRejections = []
  for (const [rawKey, value] of Object.entries(data ?? {})) {
    const key = aliases[rawKey] ?? rawKey
    if (key !== rawKey) {
      aliasRejections.push({ key: rawKey, reason: 'normalized_alias', routedTo: key })
    }
    normalized[key] = value
  }
  return { data: normalized, rejected: aliasRejections }
}

export function isHighSchoolProfile(profile, sections = {}) {
  const primaryType = String(profile?.primary_type || profile?.primaryType || '').toLowerCase()
  const education = Array.isArray(profile?.sections)
    ? profile.sections.find((section) => section.section_key === 'education')?.data
    : sections?.education ?? profile?.sections?.education
  const highestLevel = String(education?.highest_level || '').toLowerCase()
  return primaryType === 'high_school_student' || highestLevel.includes('high_school') || highestLevel.includes('high school')
}

export function hasEmployerEvidence(payload, key) {
  const evidence = `${evidenceFor(payload, key)} ${evidenceText(payload)}`
  return /\b(employer|works at|hired by|employed by|job at|start(?:ed)? date|since \d{4}|\d{4}-\d{2}(?:-\d{2})?)\b/i.test(evidence)
}

function hasAnyEmployerEvidence(payload) {
  return /\b(employer|works at|hired by|employed by|job at|start(?:ed)? date|since \d{4}|\d{4}-\d{2}(?:-\d{2})?)\b/i.test(
    evidenceText(payload),
  )
}

function hasEmploymentRecord(profile, sections = {}, payload = {}) {
  const employment = Array.isArray(profile?.sections)
    ? profile.sections.find((section) => section.section_key === 'employment')?.data
    : sections?.employment ?? profile?.sections?.employment ?? {}
  const candidates = [employment, payload].filter(Boolean)
  return candidates.some((source) =>
    Boolean(
      (String(source.current_status || '').trim() && String(source.current_status || '').trim() !== 'unknown') ||
        String(source.employer_name || source.employer || source.company || '').trim() ||
        String(source.start_date || source.employment_start_date || '').trim(),
    ),
  )
}

function hasStudentContradiction(payload) {
  const notes = String(payload?.notes ?? payload?.occupational_notes ?? '')
  return /\b(student|academics)\b/i.test(notes) && !hasAnyEmployerEvidence(payload)
}

function sectionFieldMap(sectionKey, metadata = SECTION_METADATA) {
  const fields = metadata?.[sectionKey]?.fields
  if (!Array.isArray(fields)) return null
  return new Map(fields.map((field) => [field.name, field]))
}

function coerceBooleanTri(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null
  if (typeof value === 'object') return undefined
  const normalized = String(value).trim().toLowerCase()
  if (['true', 'yes', 'y', '1'].includes(normalized)) return true
  if (['false', 'no', 'n', '0'].includes(normalized)) return false
  if (['unknown', 'n/a', 'none', 'null', 'undefined'].includes(normalized)) return null
  return undefined
}

function reject(rejected, key, reason, extra = {}) {
  rejected.push({ key, reason, ...extra })
}

export function deriveEmploymentStatusForSave(sectionKey, values, profile, sections = {}) {
  if (sectionKey !== 'employment') return values
  if (values?.current_status && values.current_status !== 'unknown') return values
  if (isHighSchoolProfile(profile, sections)) return { ...values, current_status: 'student' }
  return values
}

function coerceFieldValue(value, field) {
  const format = field?.format ?? 'string'
  if (value === null || value === undefined || value === '') return { ok: true, value: value === '' ? '' : value }
  if (format === 'boolean_tri') {
    const coerced = coerceBooleanTri(value)
    return coerced === undefined ? { ok: false } : { ok: true, value: coerced }
  }
  if (format === 'currency_usd' || format === 'currency_cents_usd' || format === 'percent') {
    if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value.replace(/[$,%]/g, '')))) {
      return { ok: true, value: Number(value.replace(/[$,%]/g, '')) }
    }
    return { ok: false }
  }
  if (format === 'string_array') {
    if (Array.isArray(value)) return { ok: true, value: value.map((entry) => String(entry)).filter(Boolean) }
    if (typeof value === 'string') return { ok: true, value: value.split(',').map((entry) => entry.trim()).filter(Boolean) }
    if (typeof value === 'object') {
      return {
        ok: true,
        value: Object.values(value)
          .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
          .map((entry) => String(entry).trim())
          .filter(Boolean),
      }
    }
    return { ok: false }
  }
  if (format === 'json') {
    if (typeof value === 'object') return { ok: true, value }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return { ok: true, value: '' }
      try {
        return { ok: true, value: JSON.parse(trimmed) }
      } catch {
        return { ok: true, value }
      }
    }
    return { ok: false }
  }
  if (['text', 'long_text', 'url', 'email', 'phone', 'enum', 'date', 'datetime', 'string'].includes(format)) {
    if (typeof value === 'string') return { ok: true, value }
    return { ok: false }
  }
  if (typeof value === 'string') return { ok: true, value }
  return { ok: false }
}

export function guardProfileSectionPayload(data, { profile, sections = {}, sectionKey, existing = {}, metadata = SECTION_METADATA } = {}) {
  const fieldMap = sectionFieldMap(sectionKey, metadata)
  const guarded = {}
  const normalizedPayload = normalizeProfileSectionAliases(data ?? {}, sectionKey)
  const rejected = [...normalizedPayload.rejected]
  const payload = normalizedPayload.data
  const requiresOccupationEvidence =
    sectionKey === 'occupation' &&
    (isHighSchoolProfile(profile, sections) || !hasEmploymentRecord(profile, sections, payload) || hasStudentContradiction(payload))

  for (const [rawKey, rawValue] of Object.entries(payload)) {
    if (rawKey === 'evidence' || rawKey.endsWith('_evidence') || rawKey === 'supporting_evidence' || rawKey === 'evidence_text') continue
    const key = selfTargetFor(rawKey)
    const field = fieldMap?.get(key)
    if (fieldMap && !field) {
      reject(rejected, rawKey, 'unknown_field', { evidence: evidenceFor(payload, rawKey) })
      continue
    }

    const coerced = coerceFieldValue(rawValue, field)
    if (!coerced.ok) {
      reject(rejected, key, 'format_mismatch', { expected: field?.format ?? 'string', evidence: evidenceFor(payload, rawKey) })
      continue
    }
    let value = coerced.value

    if (field?.applies_to_field) {
      const dependencyValue = payload[field.applies_to_field] ?? guarded[field.applies_to_field] ?? sections?.[sectionKey]?.[field.applies_to_field]
      if (dependencyValue !== true) {
        reject(rejected, key, 'field_not_applicable', { depends_on: field.applies_to_field })
        continue
      }
    }

    if (field?.format === 'enum' && Array.isArray(field.options) && typeof value === 'string' && value) {
      if (!field.options.includes(value)) {
        reject(rejected, key, 'invalid_enum', { value })
        continue
      }
    }

    if (value === true) {
      const householdTarget = householdTargetFor(rawKey)
      if (householdTarget && HOUSEHOLD_EVIDENCE.test(evidenceFor(payload, rawKey))) {
        guarded[householdTarget] = true
        reject(rejected, rawKey, 'household_evidence', { routedTo: householdTarget, evidence: evidenceFor(payload, rawKey) })
        continue
      }
    }

    if (sectionKey === 'occupation' && value === true && OCCUPATION_FLAGS.has(key) && requiresOccupationEvidence) {
      if (!hasEmployerEvidence(payload, key)) {
        reject(rejected, key, 'missing_employer_evidence', { evidence: evidenceFor(payload, key) })
        continue
      }
    }

    if (LONG_TEXT_FIELDS.has(key) && typeof value === 'string') {
      value = dedupeLongText(existing?.[key], value)
    }

    guarded[key] = value
  }

  return {
    data: deriveEmploymentStatusForSave(sectionKey, guarded, profile, sections),
    rejected,
  }
}

export function guardProfileSectionSuggestion(existing, suggestion, { sectionKey, profile, sections = {}, metadata = SECTION_METADATA } = {}) {
  const guarded = guardProfileSectionPayload(suggestion, {
    sectionKey,
    profile,
    sections,
    existing,
    metadata,
  })
  return {
    data: { ...(existing ?? {}), ...guarded.data },
    rejected: guarded.rejected,
  }
}

export { OCCUPATION_FLAGS }
