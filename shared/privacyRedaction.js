const DEFAULT_MAX_STRING_LENGTH = 8_000
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_ENTRIES = 60

const SENSITIVE_KEY_PATTERN = /(?:^|_)(?:authorization|password|passcode|token|secret|cookie|session|api[_-]?key|private[_-]?key|access[_-]?key|refresh[_-]?token|credit[_-]?card|card[_-]?number|cvv|ssn|social[_-]?security|email|phone|ip[_-]?address|remote[_-]?address|username|user[_-]?name|full[_-]?name|first[_-]?name|last[_-]?name|user[_-]?id|profile[_-]?id|applicant[_-]?id)(?:$|_)/i

const REDACTION_RULES = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b(?:eyJ[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})\.(?:[A-Za-z0-9_-]{8,})\b/g, '[REDACTED_JWT]'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
  [/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_PAYMENT_NUMBER]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  [/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[REDACTED_PHONE]'],
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, '[REDACTED_IP]'],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|session|authorization)\b\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]'],
  [/([?&](?:token|key|secret|signature|code|session|auth|password)=)[^&#\s]+/gi, '$1[REDACTED]'],
]

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

export function isSensitiveTelemetryKey(key) {
  const normalized = String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
  return SENSITIVE_KEY_PATTERN.test(normalized)
}

export function redactTelemetryString(value, { maxLength = DEFAULT_MAX_STRING_LENGTH } = {}) {
  let redacted = String(value ?? '')
  for (const [pattern, replacement] of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement)
  }
  return truncate(redacted, Math.max(0, Number(maxLength) || DEFAULT_MAX_STRING_LENGTH))
}

export function sanitizeTelemetryValue(
  value,
  {
    maxDepth = DEFAULT_MAX_DEPTH,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxStringLength = DEFAULT_MAX_STRING_LENGTH,
  } = {},
  state = { depth: 0, seen: new WeakSet() },
) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactTelemetryString(value, { maxLength: maxStringLength })
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`

  if (state.depth >= maxDepth) return '[TRUNCATED_DEPTH]'
  if (typeof value !== 'object') return redactTelemetryString(String(value), { maxLength: maxStringLength })
  if (state.seen.has(value)) return '[CIRCULAR]'

  state.seen.add(value)
  const nextState = { depth: state.depth + 1, seen: state.seen }

  if (value instanceof Error) {
    const result = {
      name: redactTelemetryString(value.name || 'Error', { maxLength: 120 }),
      message: redactTelemetryString(value.message || '', { maxLength: maxStringLength }),
      stack: redactTelemetryString(value.stack || '', { maxLength: maxStringLength }),
    }
    state.seen.delete(value)
    return result
  }

  if (Array.isArray(value)) {
    const result = value
      .slice(0, Math.max(0, maxEntries))
      .map((item) => sanitizeTelemetryValue(item, { maxDepth, maxEntries, maxStringLength }, nextState))
    state.seen.delete(value)
    return result
  }

  const result = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, Math.max(0, maxEntries))) {
    result[key] = isSensitiveTelemetryKey(key)
      ? '[REDACTED]'
      : sanitizeTelemetryValue(item, { maxDepth, maxEntries, maxStringLength }, nextState)
  }
  state.seen.delete(value)
  return result
}

export function sanitizeTelemetryEvent(event) {
  if (!event || typeof event !== 'object') return event
  const sanitized = sanitizeTelemetryValue(event, {
    maxDepth: 8,
    maxEntries: 100,
    maxStringLength: DEFAULT_MAX_STRING_LENGTH,
  })

  // SDK integrations can add request/user fields after call-site context has
  // already been scrubbed. Preserve the operational request shape, but never
  // transport identity, headers, cookies, query strings, or submitted bodies.
  if (sanitized && typeof sanitized === 'object') {
    delete sanitized.user
    if (sanitized.request && typeof sanitized.request === 'object') {
      delete sanitized.request.data
      delete sanitized.request.cookies
      delete sanitized.request.headers
      delete sanitized.request.env
      delete sanitized.request.query_string
      if (typeof sanitized.request.url === 'string') {
        sanitized.request.url = sanitized.request.url.split('?')[0]
      }
    }
  }
  return sanitized
}

export default {
  isSensitiveTelemetryKey,
  redactTelemetryString,
  sanitizeTelemetryEvent,
  sanitizeTelemetryValue,
}
