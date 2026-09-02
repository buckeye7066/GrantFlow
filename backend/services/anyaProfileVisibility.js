/**
 * Canonical access-scoped profile projection for Anya.
 *
 * Both the first chat response and profile.getSnapshot use this projection.
 * It keeps every non-empty profile fact that fits the bounded context while
 * redacting credentials and government/account identifiers before LLM use.
 */

export const ANYA_PROFILE_CONTEXT_MAX_CHARS = 30000
export const ANYA_PROFILE_TOOL_MAX_CHARS = 60000
export const ANYA_APPLICATION_CONTEXT_MAX_CHARS = 45000

const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 100

const INTERNAL_PROFILE_KEYS = new Set([
  'id',
  'user_id',
  'organization_id',
  'created_by',
  'deleted_at',
  'merged_into_profile_id',
])

const SECRET_KEY_RX = /(?:^|_)(?:ssn|social_security_number|password|passphrase|secret|token|api_key|routing_number|account_number|medicaid_id|medicare_id|member_id|policy_number|passport_number|driver_license_number|tax_id|ein)(?:$|_)/i
const BINARY_KEY_RX = /(?:avatar|image|file|document)_(?:data|bytes|blob)$|ciphertext|encrypted_value/i

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).length === 0
  }
  return false
}

function normalizeCollection(value) {
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

function sanitizeValue(value, path, audit, depth = 0) {
  if (depth > MAX_DEPTH) {
    audit.omitted.push(path || '(root)')
    return undefined
  }

  const normalized = normalizeCollection(parseMaybeJson(value))
  if (normalized === null || normalized === undefined || normalized === '') return undefined
  if (normalized instanceof Date) return normalized.toISOString()
  if (typeof normalized === 'string') return normalized.slice(0, 8000)
  if (typeof normalized === 'number' || typeof normalized === 'boolean') return normalized

  if (Array.isArray(normalized)) {
    const out = normalized
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry, index) => sanitizeValue(entry, path + '[' + index + ']', audit, depth + 1))
      .filter((entry) => entry !== undefined)
    if (normalized.length > MAX_ARRAY_ITEMS) audit.omitted.push(path + '[' + MAX_ARRAY_ITEMS + '+]')
    return out.length > 0 ? out : undefined
  }

  if (typeof normalized === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(normalized)) {
      const fieldPath = path ? path + '.' + key : key
      if (BINARY_KEY_RX.test(key)) {
        audit.omitted.push(fieldPath)
        continue
      }
      if (SECRET_KEY_RX.test(key)) {
        if (!isEmpty(entry)) {
          out[key] = '[redacted: value is on file]'
          audit.redacted.push(fieldPath)
        }
        continue
      }
      const safe = sanitizeValue(entry, fieldPath, audit, depth + 1)
      if (safe !== undefined && !isEmpty(safe)) out[key] = safe
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  return String(normalized).slice(0, 8000)
}

function safeProfileRow(profile, audit) {
  const filtered = {}
  for (const [key, value] of Object.entries(profile || {})) {
    if (INTERNAL_PROFILE_KEYS.has(key)) continue
    filtered[key] = value
  }
  return sanitizeValue(filtered, 'profile', audit) || {}
}

function safeDocuments(documents, audit) {
  if (!Array.isArray(documents)) return []
  const metadata = documents.map((document) => ({
    name: document?.title ?? document?.name ?? null,
    type: document?.mime_type ?? document?.type ?? null,
    processing_status: document?.processing_status ?? document?.status ?? null,
    summary: document?.summary ?? null,
  }))
  return sanitizeValue(metadata, 'documents', audit) || []
}

function countLeaves(value) {
  if (value === null || value === undefined) return 0
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + countLeaves(entry), 0)
  if (typeof value === 'object') {
    return Object.values(value).reduce((sum, entry) => sum + countLeaves(entry), 0)
  }
  return 1
}

function serializedLength(value) {
  try { return JSON.stringify(value).length } catch { return Number.POSITIVE_INFINITY }
}

function stringify(value, fallback = '{}') {
  try { return JSON.stringify(value) } catch { return fallback }
}

/**
 * Serialize Anya's untrusted application context without ever cutting JSON in
 * the middle. If the page snapshot makes the context too large, omit that
 * transient view first and preserve the canonical profile snapshot. The final
 * fallback keeps profile identity/section inventory and tells Anya to use the
 * access-scoped snapshot tool for section facts.
 */
export function serializeAnyaApplicationContext(applicationContext = {}, {
  maxChars = ANYA_APPLICATION_CONTEXT_MAX_CHARS,
} = {}) {
  const budget = Math.max(10000, Math.min(Number(maxChars) || ANYA_APPLICATION_CONTEXT_MAX_CHARS, 100000))
  const full = stringify(applicationContext, '{"context_unavailable":true}')
  if (full.length <= budget) return full

  const currentPage = applicationContext?.current_page
  const compact = {
    ...applicationContext,
    current_page: currentPage && typeof currentPage === 'object'
      ? {
          name: currentPage.name ?? null,
          guidance: currentPage.guidance ?? null,
          snapshot: null,
          snapshot_omitted_for_context_budget: true,
        }
      : currentPage ?? null,
    context_notice: 'The transient page snapshot was omitted to preserve the canonical profile facts.',
  }
  const withoutPageSnapshot = stringify(compact, '{"context_unavailable":true}')
  if (withoutPageSnapshot.length <= budget) return withoutPageSnapshot

  const active = applicationContext?.active_profile
  const inventoryOnly = active && typeof active === 'object'
    ? {
        profile: active.profile ?? {},
        organization: active.organization ?? null,
        matching_signals: active.matching_signals ?? null,
        documents: active.documents ?? [],
        available_sections: active.available_sections ?? [],
        sections: {},
        truncated_sections: active.available_sections ?? active.truncated_sections ?? [],
        truncated_components: active.truncated_components ?? [],
        complete: false,
      }
    : active ?? null
  return stringify({
    current_user: applicationContext?.current_user ?? null,
    preferred_language: applicationContext?.preferred_language ?? 'en',
    active_profile: inventoryOnly,
    accessible_profiles: Array.isArray(applicationContext?.accessible_profiles)
      ? applicationContext.accessible_profiles.slice(0, 20)
      : applicationContext?.accessible_profiles ?? null,
    current_page: compact.current_page,
    student_profile: applicationContext?.student_profile === true,
    student_guidance: applicationContext?.student_guidance ?? null,
    context_notice: 'Profile sections exceeded the context budget. Call profile.getSnapshot for the required sections before answering.',
  }, '{"context_unavailable":true}')
}

/**
 * Project a loadProfileContext result into complete, bounded, LLM-safe facts.
 * Empty fields are omitted; false and zero remain because they are real facts.
 */
export function buildAnyaProfileSnapshot(profileContext = {}, {
  sectionKeys = null,
  maxChars = ANYA_PROFILE_CONTEXT_MAX_CHARS,
} = {}) {
  const audit = { redacted: [], omitted: [] }
  const rawSections = profileContext?.sectionsByKey || profileContext?.sections || {}
  const availableSections = Object.keys(rawSections).sort()
  const requested = Array.isArray(sectionKeys) && sectionKeys.length > 0
    ? [...new Set(sectionKeys.map((key) => String(key).trim()).filter(Boolean))]
    : availableSections

  const snapshot = {
    profile: safeProfileRow(profileContext?.profile || {}, audit),
    organization: sanitizeValue(profileContext?.organization || null, 'organization', audit) || null,
    matching_signals: sanitizeValue(profileContext?.signals || null, 'signals', audit) || null,
    documents: safeDocuments(profileContext?.documents, audit),
    available_sections: availableSections,
    sections: {},
    truncated_sections: [],
    truncated_components: [],
    unknown_requested_sections: requested.filter((key) => !availableSections.includes(key)),
    redacted_fields: [...new Set(audit.redacted)].sort(),
    omitted_binary_or_oversize_fields: [...new Set(audit.omitted)].sort(),
  }

  const budget = Math.max(4000, Math.min(Number(maxChars) || ANYA_PROFILE_CONTEXT_MAX_CHARS, 100000))
  // Leave room for fact_count/complete and any redaction paths discovered
  // while sanitizing sections.
  const fitBudget = Math.max(3500, budget - 512)
  const markTruncated = (component) => {
    if (!snapshot.truncated_components.includes(component)) snapshot.truncated_components.push(component)
  }

  // Derived matching signals can be a large, redundant bag of normalized
  // values. They are useful context, but they must never crowd the profile's
  // own section facts out of Anya's bounded preload. Compact lower-priority
  // components in a deterministic order before fitting sections, and say
  // exactly what was compacted instead of silently cutting JSON.
  if (serializedLength(snapshot) > fitBudget && snapshot.matching_signals) {
    snapshot.matching_signals = null
    markTruncated('matching_signals')
  }
  if (serializedLength(snapshot) > fitBudget && snapshot.documents.length > 0) {
    snapshot.documents = snapshot.documents.map((document) => ({
      name: document?.name ?? null,
      type: document?.type ?? null,
      processing_status: document?.processing_status ?? null,
    }))
    markTruncated('document_summaries')
  }
  if (serializedLength(snapshot) > fitBudget && snapshot.organization) {
    const organization = snapshot.organization
    snapshot.organization = {
      name: organization.name ?? organization.display_name ?? null,
      organization_type: organization.organization_type ?? organization.type ?? null,
      state: organization.state ?? null,
      city: organization.city ?? null,
    }
    markTruncated('organization_details')
  }
  if (serializedLength(snapshot) > fitBudget) {
    const profile = snapshot.profile
    snapshot.profile = {
      display_name: profile.display_name ?? profile.name ?? null,
      primary_type: profile.primary_type ?? profile.applicant_type ?? null,
      state: profile.state ?? null,
      city: profile.city ?? null,
      zip: profile.zip ?? profile.postal_code ?? profile.zip_code ?? null,
      status: profile.status ?? null,
    }
    markTruncated('profile_row_details')
  }

  for (const key of requested) {
    if (!Object.prototype.hasOwnProperty.call(rawSections, key)) continue
    const safe = sanitizeValue(rawSections[key], 'sections.' + key, audit)
    if (safe === undefined) continue
    snapshot.redacted_fields = [...new Set(audit.redacted)].sort()
    snapshot.omitted_binary_or_oversize_fields = [...new Set(audit.omitted)].sort()
    const candidate = { ...snapshot.sections, [key]: safe }

    // Section facts outrank derived/duplicative context. If a section does not
    // fit, shed the signal bag first and retry before declaring that section
    // truncated.
    if (serializedLength({ ...snapshot, sections: candidate }) > fitBudget && snapshot.matching_signals) {
      snapshot.matching_signals = null
      markTruncated('matching_signals')
    }
    if (serializedLength({ ...snapshot, sections: candidate }) <= fitBudget) snapshot.sections[key] = safe
    else snapshot.truncated_sections.push(key)
  }

  snapshot.fact_count = countLeaves({
    profile: snapshot.profile,
    organization: snapshot.organization,
    matching_signals: snapshot.matching_signals,
    documents: snapshot.documents,
    sections: snapshot.sections,
  })
  snapshot.complete = snapshot.truncated_sections.length === 0
    && snapshot.truncated_components.length === 0
    && snapshot.unknown_requested_sections.length === 0
  return Object.freeze(snapshot)
}

/** Load through the production profile-context path, then apply the projection. */
export async function loadAnyaProfileSnapshot(db, profileId, options = {}) {
  if (!db || !profileId) throw new Error('db and profileId are required')
  const { loadProfileContext } = await import('./profileHelpers.js')
  const context = await loadProfileContext(db, String(profileId))
  if (!context?.profile) {
    const error = new Error('Profile not found')
    error.status = 404
    throw error
  }
  return buildAnyaProfileSnapshot(context, options)
}

export default {
  buildAnyaProfileSnapshot,
  loadAnyaProfileSnapshot,
  serializeAnyaApplicationContext,
}
