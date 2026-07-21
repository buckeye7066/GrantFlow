// EVA (End-user Validation Agent) — shared types, validators, fingerprinting,
// and redaction. Pure module: no DB, no IO, no GrantFlow-runtime imports, so it
// is trivially unit-testable and safe to import from the edge runner too.
//
// EVA proves whether a *person* can use each program. This file defines the
// versioned result contract (mirrors qa/eva-result.schema.json), the finding
// lifecycle vocabulary, the stable dedup fingerprint, and the redaction pass
// that keeps secrets / PHI / private Windows paths out of anything persisted or
// emailed.

export const EVA_SCHEMA_VERSION = 1

// ---- Vocabularies ---------------------------------------------------------

export const APP_STATUS = Object.freeze([
  'tested',
  'blocked',
  'not_run',
  'startup_failed',
  'source_unavailable',
  'runtime_unavailable',
  'unsafe_to_automate',
  'manual_required',
  'not_implemented',
])

export const JOURNEY_STATUS = Object.freeze(['passed', 'failed', 'blocked', 'skipped'])

export const SEVERITY = Object.freeze(['critical', 'high', 'medium', 'low', 'info'])

export const SEVERITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
})

export const RETRY_CLASSIFICATION = Object.freeze([
  'reproducible',
  'intermittent',
  'environmental',
  'not-retried',
])

// Finding lifecycle. These are DIFFERENT states and the morning email must
// never collapse them — an untested feature is not green, a stale run is not a
// pass, yesterday's pass is not today's pass.
export const FINDING_STATE = Object.freeze([
  'new',
  'recurring',
  'worsened',
  'intermittent',
  'resolved',
  'blocked',
  'stale',
])

// Normalized failure classes for the fingerprint. An unknown/free-text class is
// bucketed to 'other' so a paraphrased error message can't fork one real defect
// into many findings.
export const FAILURE_CLASS = Object.freeze([
  'startup-failed',
  'console-error',
  'uncaught-page-error',
  'network-5xx',
  'network-4xx',
  'network-failed',
  'assertion',
  'timeout',
  'unexpected-redirect',
  'overflow',
  'validation-missing',
  'persistence-lost',
  'a11y-keyboard',
  'other',
])

// ---- Limits (defence-in-depth; the ingest route also enforces the body cap) -

export const LIMITS = Object.freeze({
  MAX_PAYLOAD_BYTES: 2 * 1024 * 1024, // 2 MB structured results (evidence is by-reference)
  MAX_APPS: 100,
  MAX_JOURNEYS_PER_APP: 200,
  MAX_EVIDENCE_PER_JOURNEY: 30,
  MAX_REPRO_STEPS: 40,
  MAX_STRING: 2000,
  SIGNATURE_MAX_SKEW_MS: 5 * 60 * 1000, // 5 minutes clock skew tolerance
  DEFAULT_STALE_MS: 30 * 60 * 60 * 1000, // 30 hours
  CONFIDENCE_FLOOR: 0.7, // below this, a diagnosis must name its missing evidence
})

// ---- Redaction ------------------------------------------------------------

// Ordered redaction rules. Each turns a matched secret / private locator into a
// stable placeholder so the *shape* survives (useful for fingerprints) without
// leaking the value. Applied to every free-text field before persistence.
const REDACTION_RULES = [
  // Bearer tokens / API keys (sk-, gh, xox, AIza, long hex/base64 secrets)
  [/\b(sk|rk|pk)[-_][A-Za-z0-9]{16,}\b/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  // Authorization / secret assignments (Authorization: Bearer x, KEY=value)
  [/\b(authorization|bearer)\b\s*[:=]?\s*[^\s"']{8,}/gi, 'authorization [REDACTED]'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY|HMAC)[A-Z0-9_]*)\s*[:=]\s*[^\s"']+/gi, '$1=[REDACTED]'],
  // Emails -> keep domain-less placeholder (avoid leaking real recipients/PII)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  // US SSN
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  // Credit-card-like 13-19 digit runs
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CARD]'],
  // Private Windows user paths -> collapse to a non-identifying root
  [/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '[USER_HOME]'],
  [/\/(?:c|g)\/Users\/[^/\s"']+/gi, '[USER_HOME]'],
  [/[A-Za-z]:\\[^\s"']*/g, '[WIN_PATH]'],
]

/**
 * Redact secrets, PII, and private paths from a single string. Idempotent and
 * bounded to LIMITS.MAX_STRING. Non-strings pass through as-is.
 */
export function redactText(value) {
  if (typeof value !== 'string') return value
  let out = value.length > LIMITS.MAX_STRING ? value.slice(0, LIMITS.MAX_STRING) : value
  for (const [re, repl] of REDACTION_RULES) out = out.replace(re, repl)
  return out
}

/** Deep-redact every string in a JSON-safe value (arrays/objects/strings). */
export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out
  }
  return value
}

// ---- Normalization + fingerprint -----------------------------------------

export function normalizeFailureClass(raw) {
  if (typeof raw !== 'string') return 'other'
  const v = raw.trim().toLowerCase()
  return FAILURE_CLASS.includes(v) ? v : 'other'
}

// Reduce an error message to a stable signature: lowercase, redacted, with
// volatile tokens (numbers, uuids, hex, quoted values) collapsed so the same
// defect fingerprints identically across runs.
export function normalizeErrorSignature(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  let s = redactText(raw).toLowerCase()
  s = s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\b\d[\d,.]*\b/g, '<n>')
    .replace(/"[^"]*"/g, '"<v>"')
    .replace(/'[^']*'/g, "'<v>'")
    .replace(/\s+/g, ' ')
    .trim()
  return s.slice(0, 300)
}

function normalizeRoute(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  // Strip query/hash and collapse numeric/uuid path segments so /grant/123 and
  // /grant/456 are the same control.
  let r = raw.trim().toLowerCase().split(/[?#]/)[0]
  r = r
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
  return r.slice(0, 200)
}

/**
 * Stable finding fingerprint. Deterministic FNV-1a hash over the identity
 * tuple (app, journey, normalized failure class, normalized route/control,
 * normalized error signature). Same real-world defect -> same fingerprint,
 * regardless of paraphrased message text, ids in the URL, or run.
 */
export function computeFingerprint({ app_id, journey_id, failure_class, route_or_control, error_signature }) {
  const parts = [
    String(app_id || '').toLowerCase(),
    String(journey_id || '').toLowerCase(),
    normalizeFailureClass(failure_class),
    normalizeRoute(route_or_control),
    normalizeErrorSignature(error_signature),
  ]
  return 'evf_' + fnv1a(parts.join(''))
}

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---- Result-payload validation (the versioned contract) -------------------

function isIso(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

/**
 * Validate a full edge-runner result payload against the v1 contract. Returns
 * { ok, errors[] }. Structural only — signature/replay/idempotency are the
 * ingest layer's job. Fails closed: a failed journey MUST carry its diagnostic
 * bundle, and a low-confidence diagnosis MUST name its missing evidence.
 */
export function validateResultPayload(payload) {
  const errors = []
  const e = (m) => errors.push(m)

  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: ['payload is not an object'] }
  }
  if (payload.schema_version !== EVA_SCHEMA_VERSION) e(`schema_version must be ${EVA_SCHEMA_VERSION}`)
  if (!payload.run_id || typeof payload.run_id !== 'string') e('run_id required')
  if (!payload.runner_id || typeof payload.runner_id !== 'string') e('runner_id required')
  if (!isIso(payload.started_at)) e('started_at must be ISO datetime')
  if (!isIso(payload.completed_at)) e('completed_at must be ISO datetime')
  if (!['local-windows', 'ci', 'fixture', 'staging'].includes(payload.environment)) e('environment invalid')
  if (!Array.isArray(payload.apps)) {
    e('apps must be an array')
    return { ok: errors.length === 0, errors }
  }
  if (payload.apps.length > LIMITS.MAX_APPS) e(`too many apps (>${LIMITS.MAX_APPS})`)

  payload.apps.forEach((app, ai) => {
    const where = `apps[${ai}]`
    if (!app || typeof app !== 'object') return e(`${where} not an object`)
    if (!/^[a-z0-9-]+$/.test(String(app.app_id || ''))) e(`${where}.app_id invalid`)
    if (!app.display_name) e(`${where}.display_name required`)
    if (!APP_STATUS.includes(app.app_status)) e(`${where}.app_status invalid`)
    if (!Number.isInteger(app.duration_ms) || app.duration_ms < 0) e(`${where}.duration_ms invalid`)
    if (!Array.isArray(app.journeys)) return e(`${where}.journeys must be an array`)
    if (app.journeys.length > LIMITS.MAX_JOURNEYS_PER_APP) e(`${where}.journeys too many`)

    app.journeys.forEach((j, ji) => {
      const jw = `${where}.journeys[${ji}]`
      if (!j || typeof j !== 'object') return e(`${jw} not an object`)
      if (!/^[a-z0-9._-]+$/.test(String(j.journey_id || ''))) e(`${jw}.journey_id invalid`)
      if (!j.name) e(`${jw}.name required`)
      if (!JOURNEY_STATUS.includes(j.status)) e(`${jw}.status invalid`)
      if (j.severity && !SEVERITY.includes(j.severity)) e(`${jw}.severity invalid`)
      if (j.diagnostic_confidence != null && (typeof j.diagnostic_confidence !== 'number' || j.diagnostic_confidence < 0 || j.diagnostic_confidence > 1)) {
        e(`${jw}.diagnostic_confidence out of range`)
      }
      if (Array.isArray(j.evidence) && j.evidence.length > LIMITS.MAX_EVIDENCE_PER_JOURNEY) e(`${jw}.evidence too many`)

      if (j.status === 'failed') {
        for (const req of ['severity', 'retry_classification', 'failure_class', 'expected_behavior', 'observed_behavior', 'user_impact']) {
          if (!j[req]) e(`${jw}.${req} required for a failed journey`)
        }
        if (!Array.isArray(j.repro_steps) || j.repro_steps.length === 0) e(`${jw}.repro_steps required for a failed journey`)
        if (typeof j.diagnostic_confidence !== 'number') e(`${jw}.diagnostic_confidence required for a failed journey`)
        else if (j.diagnostic_confidence < LIMITS.CONFIDENCE_FLOOR && !j.missing_evidence) {
          e(`${jw}.missing_evidence required when confidence < ${LIMITS.CONFIDENCE_FLOOR}`)
        }
        // A candidate-file claim must be evidence-backed, never manufactured.
        if (Array.isArray(j.candidate_files) && j.candidate_files.length > 0 && typeof j.diagnostic_confidence === 'number' && j.diagnostic_confidence < 0.4) {
          e(`${jw}: candidate_files asserted at implausibly low confidence`)
        }
      }
    })
  })

  return { ok: errors.length === 0, errors }
}
