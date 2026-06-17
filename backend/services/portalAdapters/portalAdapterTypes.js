/**
 * portalAdapterTypes.js
 *
 * Shared type-style constants used by all Yana portal adapters. Adapters
 * never mutate these objects — they are frozen.
 */

export const ADAPTER_OUTCOMES = Object.freeze({
  READY: 'ready',
  WAITING_FOR_USER: 'waiting_for_user',
  WAITING_FOR_ADMIN: 'waiting_for_admin',
  BLOCKED_LOGIN: 'blocked_login_required',
  BLOCKED_2FA: 'blocked_2fa',
  BLOCKED_CAPTCHA: 'blocked_captcha',
  BLOCKED_TERMS: 'blocked_terms_or_policy',
  BLOCKED_MISSING: 'blocked_missing_info',
  DRAFT_COMPLETED: 'draft_completed',
  SUBMITTED: 'submitted',
  FAILED: 'failed',
})

export const REQUIREMENT_KINDS = Object.freeze([
  'field',
  'document',
  'login',
  'consent',
  'signature',
  'attestation',
  'admin_review',
  'other',
])

/**
 * Shape of the context passed to every adapter method:
 *
 * {
 *   profile,            // normalized student profile object
 *   opportunity,        // funding opportunity row
 *   portalLink,         // application_portal_links row
 *   portal,             // student_portals row (may be null for manual)
 *   task,               // application_tasks row
 *   knownSchool,        // knownSchools entry, or null
 *   documents,          // [{ id, type, filename, ... }] available docs
 *   options,            // { allowSubmit: boolean, browserAutomation: bool }
 * }
 *
 * Each adapter method returns an `AdapterResult`:
 *
 * {
 *   outcome,                // one of ADAPTER_OUTCOMES
 *   message,                // plain-language status for the user
 *   requirements,           // [{ kind, key, label, description, required }]
 *   filled_fields,          // map { fieldKey: value } that were filled
 *   submission_method,      // 'portal' | 'email' | 'manual' | 'paper' | 'fax'
 *   submission_reference,   // e.g. confirmation number after submit
 *   blocking_reason,        // detailed reason when outcome is blocked_*
 *   safe_to_proceed,        // boolean — false stops the run
 * }
 */
export function makeAdapterResult({
  outcome,
  message = '',
  requirements = [],
  filledFields = {},
  submissionMethod = null,
  submissionReference = null,
  blockingReason = null,
  safeToProceed = true,
} = {}) {
  return {
    outcome,
    message: String(message ?? ''),
    requirements: Array.isArray(requirements) ? requirements.filter(Boolean) : [],
    filled_fields: filledFields && typeof filledFields === 'object' ? { ...filledFields } : {},
    submission_method: submissionMethod ?? null,
    submission_reference: submissionReference ?? null,
    blocking_reason: blockingReason ?? null,
    safe_to_proceed: Boolean(safeToProceed),
  }
}

/**
 * Helper for adapters: list missing fields on a profile by walking a
 * required-fields spec. Returns an array of missing-info requirements
 * the agent can persist.
 */
export function detectMissingProfileFields(profile, requiredFieldSpecs = []) {
  if (!profile || typeof profile !== 'object') {
    return requiredFieldSpecs.map((spec) => ({
      kind: 'field',
      key: spec.key,
      label: spec.label || spec.key,
      description: spec.description || `Required field: ${spec.key}`,
      required: true,
    }))
  }
  const missing = []
  for (const spec of requiredFieldSpecs) {
    if (!spec || !spec.key) continue
    const path = spec.path || spec.key
    const value = readPath(profile, path)
    if (isEmpty(value)) {
      missing.push({
        kind: 'field',
        key: spec.key,
        label: spec.label || spec.key,
        description: spec.description || `Required field "${spec.label || spec.key}" not found on profile`,
        required: spec.required !== false,
      })
    }
  }
  return missing
}

export function detectMissingDocuments(documents, requiredDocSpecs = []) {
  const docs = Array.isArray(documents) ? documents : []
  const missing = []
  for (const spec of requiredDocSpecs) {
    if (!spec || !spec.key) continue
    // Optional documents (`required: false`) never block an adapter.
    if (spec.required === false) continue
    const found = docs.some(
      (d) => d && (
        d.type === spec.key
        || d.kind === spec.key
        || (spec.match && spec.match(d))
      ),
    )
    if (!found) {
      missing.push({
        kind: 'document',
        key: spec.key,
        label: spec.label || spec.key,
        description: spec.description || `Required document "${spec.label || spec.key}" not uploaded`,
        required: true,
      })
    }
  }
  return missing
}

function readPath(obj, path) {
  if (!obj) return undefined
  if (typeof path !== 'string') return undefined
  const parts = path.split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}

function isEmpty(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}
