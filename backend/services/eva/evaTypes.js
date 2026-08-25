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
    // CodeQL js/remote-property-injection (#750): plain-object accumulator
    // built from EVA run data with no key guard — Object.create(null) has no
    // prototype for a "__proto__" key to swap.
    const out = Object.create(null)
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
  return 'evf_' + fnv1a(parts.join('\u0001'))
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

const ENVIRONMENT = Object.freeze(['local-windows', 'ci', 'fixture', 'staging'])
const EVIDENCE_KIND = Object.freeze([
  'trace',
  'screenshot',
  'video',
  'console',
  'network',
  'server-log',
  'steps',
  'timing',
])

const ROOT_PROPERTIES = Object.freeze([
  'schema_version',
  'run_id',
  'runner_id',
  'started_at',
  'completed_at',
  'environment',
  'runner_version',
  'catchup',
  'apps',
])
const ROOT_REQUIRED = Object.freeze([
  'schema_version',
  'run_id',
  'runner_id',
  'started_at',
  'completed_at',
  'environment',
  'apps',
])
const APP_PROPERTIES = Object.freeze([
  'app_id',
  'display_name',
  'repo',
  'commit_sha',
  'app_status',
  'blocker_reason',
  'duration_ms',
  'feature_coverage',
  'journeys',
])
const APP_REQUIRED = Object.freeze(['app_id', 'display_name', 'app_status', 'duration_ms', 'journeys'])
const FEATURE_COVERAGE_PROPERTIES = Object.freeze([
  'features_total',
  'features_covered',
  'unautomated_features',
])
const JOURNEY_PROPERTIES = Object.freeze([
  'journey_id',
  'name',
  'status',
  'severity',
  'retry_classification',
  'duration_ms',
  'route_or_control',
  'failure_class',
  'error_signature',
  'expected_behavior',
  'observed_behavior',
  'repro_steps',
  'user_impact',
  'likely_root_cause',
  'recommended_fix',
  'candidate_files',
  'diagnostic_confidence',
  'missing_evidence',
  'evidence',
])
const JOURNEY_REQUIRED = Object.freeze(['journey_id', 'name', 'status'])
const FAILED_JOURNEY_REQUIRED = Object.freeze([
  'severity',
  'retry_classification',
  'failure_class',
  'expected_behavior',
  'observed_behavior',
  'repro_steps',
  'user_impact',
  'diagnostic_confidence',
])
const EVIDENCE_PROPERTIES = Object.freeze(['kind', 'ref', 'sha256', 'bytes'])
const EVIDENCE_REQUIRED = Object.freeze(['kind', 'ref'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property)
}

function codePointLength(value) {
  return [...value].length
}

function validateObjectShape(value, where, allowed, required, error) {
  if (!isObject(value)) {
    error(`${where} must be an object`)
    return false
  }
  const allowedSet = new Set(allowed)
  for (const property of Object.keys(value)) {
    if (!allowedSet.has(property)) error(`${where}.${property} is an unknown property`)
  }
  for (const property of required) {
    if (!hasOwn(value, property)) error(`${where}.${property} is required`)
  }
  return true
}

function validateString(value, where, error, { minLength = 0, maxLength, pattern, choices } = {}) {
  if (typeof value !== 'string') {
    error(`${where} must be a string`)
    return
  }
  const length = codePointLength(value)
  if (length < minLength) error(`${where} must have at least ${minLength} characters`)
  if (maxLength !== undefined && length > maxLength) error(`${where} must have at most ${maxLength} characters`)
  if (pattern && !pattern.test(value)) error(`${where} has an invalid pattern`)
  if (choices && !choices.includes(value)) error(`${where} is invalid`)
}

function validateInteger(value, where, error, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) error(`${where} must be an integer >= ${minimum}`)
}

function validateNumber(value, where, error, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    error(`${where} must be a finite number between ${minimum} and ${maximum}`)
  }
}

function validateArray(value, where, error, maxItems) {
  if (!Array.isArray(value)) {
    error(`${where} must be an array`)
    return false
  }
  if (value.length > maxItems) error(`${where} must contain at most ${maxItems} items`)
  return true
}

function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zoneHourText, zoneMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const zoneHour = zoneHourText === undefined ? 0 : Number(zoneHourText)
  const zoneMinute = zoneMinuteText === undefined ? 0 : Number(zoneMinuteText)

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  const validSecond = second <= 59 || (second === 60 && hour === 23 && minute === 59)
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && validSecond
    && zoneHour <= 23 && zoneMinute <= 59
}

function validateStringArray(value, where, error, maxItems, itemMaxLength) {
  if (!validateArray(value, where, error, maxItems)) return
  value.forEach((item, index) => validateString(item, `${where}[${index}]`, error, { maxLength: itemMaxLength }))
}

function validateEvidence(value, where, error) {
  if (!validateObjectShape(value, where, EVIDENCE_PROPERTIES, EVIDENCE_REQUIRED, error)) return
  if (hasOwn(value, 'kind')) validateString(value.kind, `${where}.kind`, error, { choices: EVIDENCE_KIND })
  if (hasOwn(value, 'ref')) validateString(value.ref, `${where}.ref`, error, { maxLength: 400 })
  if (hasOwn(value, 'sha256')) validateString(value.sha256, `${where}.sha256`, error, { pattern: /^[a-f0-9]{64}$/ })
  if (hasOwn(value, 'bytes')) validateInteger(value.bytes, `${where}.bytes`, error)
}

function validateFeatureCoverage(value, where, error) {
  if (!validateObjectShape(value, where, FEATURE_COVERAGE_PROPERTIES, [], error)) return
  if (hasOwn(value, 'features_total')) validateInteger(value.features_total, `${where}.features_total`, error)
  if (hasOwn(value, 'features_covered')) validateInteger(value.features_covered, `${where}.features_covered`, error)
  if (hasOwn(value, 'unautomated_features')) {
    validateStringArray(value.unautomated_features, `${where}.unautomated_features`, error, 200, 200)
  }
}

function validateJourney(value, where, error) {
  if (!validateObjectShape(value, where, JOURNEY_PROPERTIES, JOURNEY_REQUIRED, error)) return

  if (hasOwn(value, 'journey_id')) validateString(value.journey_id, `${where}.journey_id`, error, { maxLength: 128, pattern: /^[a-z0-9._-]+$/ })
  if (hasOwn(value, 'name')) validateString(value.name, `${where}.name`, error, { maxLength: 200 })
  if (hasOwn(value, 'status')) validateString(value.status, `${where}.status`, error, { choices: JOURNEY_STATUS })
  if (hasOwn(value, 'severity')) validateString(value.severity, `${where}.severity`, error, { choices: SEVERITY })
  if (hasOwn(value, 'retry_classification')) {
    validateString(value.retry_classification, `${where}.retry_classification`, error, { choices: RETRY_CLASSIFICATION })
  }
  if (hasOwn(value, 'duration_ms')) validateInteger(value.duration_ms, `${where}.duration_ms`, error)
  if (hasOwn(value, 'route_or_control')) validateString(value.route_or_control, `${where}.route_or_control`, error, { maxLength: 300 })
  if (hasOwn(value, 'failure_class')) validateString(value.failure_class, `${where}.failure_class`, error, { maxLength: 80 })
  if (hasOwn(value, 'error_signature')) validateString(value.error_signature, `${where}.error_signature`, error, { maxLength: 500 })
  if (hasOwn(value, 'expected_behavior')) validateString(value.expected_behavior, `${where}.expected_behavior`, error, { maxLength: 1000 })
  if (hasOwn(value, 'observed_behavior')) validateString(value.observed_behavior, `${where}.observed_behavior`, error, { maxLength: 1000 })
  if (hasOwn(value, 'repro_steps')) validateStringArray(value.repro_steps, `${where}.repro_steps`, error, 40, 300)
  if (hasOwn(value, 'user_impact')) validateString(value.user_impact, `${where}.user_impact`, error, { maxLength: 1000 })
  if (hasOwn(value, 'likely_root_cause')) validateString(value.likely_root_cause, `${where}.likely_root_cause`, error, { maxLength: 1000 })
  if (hasOwn(value, 'recommended_fix')) validateString(value.recommended_fix, `${where}.recommended_fix`, error, { maxLength: 1000 })
  if (hasOwn(value, 'candidate_files')) validateStringArray(value.candidate_files, `${where}.candidate_files`, error, 20, 300)
  if (hasOwn(value, 'diagnostic_confidence')) validateNumber(value.diagnostic_confidence, `${where}.diagnostic_confidence`, error, 0, 1)
  if (hasOwn(value, 'missing_evidence')) validateString(value.missing_evidence, `${where}.missing_evidence`, error, { maxLength: 500 })
  if (hasOwn(value, 'evidence') && validateArray(value.evidence, `${where}.evidence`, error, LIMITS.MAX_EVIDENCE_PER_JOURNEY)) {
    value.evidence.forEach((item, index) => validateEvidence(item, `${where}.evidence[${index}]`, error))
  }

  if (value.status === 'failed') {
    for (const property of FAILED_JOURNEY_REQUIRED) {
      if (!hasOwn(value, property)) error(`${where}.${property} required for a failed journey`)
    }
    if (typeof value.diagnostic_confidence === 'number' && Number.isFinite(value.diagnostic_confidence) && value.diagnostic_confidence < LIMITS.CONFIDENCE_FLOOR && !value.missing_evidence) {
      error(`${where}.missing_evidence required when confidence < ${LIMITS.CONFIDENCE_FLOOR}`)
    }
    // A candidate-file claim must be evidence-backed, never manufactured.
    if (Array.isArray(value.candidate_files) && value.candidate_files.length > 0 && typeof value.diagnostic_confidence === 'number' && Number.isFinite(value.diagnostic_confidence) && value.diagnostic_confidence < 0.4) {
      error(`${where}: candidate_files asserted at implausibly low confidence`)
    }
  }
}

function validateApp(value, where, error) {
  if (!validateObjectShape(value, where, APP_PROPERTIES, APP_REQUIRED, error)) return

  if (hasOwn(value, 'app_id')) validateString(value.app_id, `${where}.app_id`, error, { maxLength: 64, pattern: /^[a-z0-9-]+$/ })
  if (hasOwn(value, 'display_name')) validateString(value.display_name, `${where}.display_name`, error, { maxLength: 128 })
  if (hasOwn(value, 'repo')) validateString(value.repo, `${where}.repo`, error, { maxLength: 128 })
  if (hasOwn(value, 'commit_sha')) validateString(value.commit_sha, `${where}.commit_sha`, error, { maxLength: 64 })
  if (hasOwn(value, 'app_status')) validateString(value.app_status, `${where}.app_status`, error, { choices: APP_STATUS })
  if (hasOwn(value, 'blocker_reason')) validateString(value.blocker_reason, `${where}.blocker_reason`, error, { maxLength: 500 })
  if (hasOwn(value, 'duration_ms')) validateInteger(value.duration_ms, `${where}.duration_ms`, error)
  if (hasOwn(value, 'feature_coverage')) validateFeatureCoverage(value.feature_coverage, `${where}.feature_coverage`, error)
  if (hasOwn(value, 'journeys') && validateArray(value.journeys, `${where}.journeys`, error, LIMITS.MAX_JOURNEYS_PER_APP)) {
    value.journeys.forEach((journey, index) => validateJourney(journey, `${where}.journeys[${index}]`, error))
  }
}

/**
 * Validate a full edge-runner result payload against the v1 contract. Returns
 * { ok, errors[] }. Structural only — signature/replay/idempotency are the
 * ingest layer's job. Fails closed: a failed journey MUST carry its diagnostic
 * bundle, and a low-confidence diagnosis MUST name its missing evidence.
 */
export function validateResultPayload(payload) {
  const errors = []
  const error = (message) => errors.push(message)

  if (!validateObjectShape(payload, 'payload', ROOT_PROPERTIES, ROOT_REQUIRED, error)) {
    return { ok: false, errors }
  }

  if (hasOwn(payload, 'schema_version') && payload.schema_version !== EVA_SCHEMA_VERSION) {
    error(`schema_version must be ${EVA_SCHEMA_VERSION}`)
  }
  if (hasOwn(payload, 'run_id')) validateString(payload.run_id, 'run_id', error, { minLength: 8, maxLength: 128, pattern: /^[A-Za-z0-9._:-]+$/ })
  if (hasOwn(payload, 'runner_id')) validateString(payload.runner_id, 'runner_id', error, { minLength: 3, maxLength: 64, pattern: /^[A-Za-z0-9._-]+$/ })
  if (hasOwn(payload, 'started_at') && !isRfc3339DateTime(payload.started_at)) error('started_at must be an RFC 3339 date-time')
  if (hasOwn(payload, 'completed_at') && !isRfc3339DateTime(payload.completed_at)) error('completed_at must be an RFC 3339 date-time')
  if (hasOwn(payload, 'environment')) validateString(payload.environment, 'environment', error, { choices: ENVIRONMENT })
  if (hasOwn(payload, 'runner_version')) validateString(payload.runner_version, 'runner_version', error, { maxLength: 32 })
  if (hasOwn(payload, 'catchup') && typeof payload.catchup !== 'boolean') error('catchup must be a boolean')
  if (hasOwn(payload, 'apps') && validateArray(payload.apps, 'apps', error, LIMITS.MAX_APPS)) {
    payload.apps.forEach((app, index) => validateApp(app, `apps[${index}]`, error))
  }

  return { ok: errors.length === 0, errors }
}
