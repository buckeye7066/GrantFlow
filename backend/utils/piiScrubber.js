/**
 * PHI/PII scrubbing helpers for logs and audit trails.
 * This does not guarantee perfect detection, but provides strong defaults:
 * - Redacts emails
 * - Redacts phone-like sequences
 * - Redacts SSN-like sequences
 * - Redacts long digit strings that could be identifiers
 *
 * IMPORTANT: Do not pass raw page HTML/PDF text into logs. Prefer hashes + URLs.
 */

// Use factory functions so each call to scrubPII gets fresh RegExp instances
// with lastIndex === 0, preventing stale state across invocations.
function makeRegexes() {
  return {
    EMAIL_RE: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    PHONE_RE: /\b(?:\+?1[\s.-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    SSN_RE: /\b\d{3}-\d{2}-\d{4}\b/g,
    LONG_DIGITS_RE: /\b\d{9,}\b/g,
  }
}

export function scrubPII(value) {
  if ((value === null || value === undefined)) return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const { EMAIL_RE, PHONE_RE, SSN_RE, LONG_DIGITS_RE } = makeRegexes()
  return text
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(SSN_RE, '[REDACTED_SSN]')
    .replace(PHONE_RE, '[REDACTED_PHONE]')
    .replace(LONG_DIGITS_RE, '[REDACTED_ID]')
}

export function safeLogObject(obj) {
  try {
    return JSON.parse(scrubPII(obj))
  } catch {
    return { message: scrubPII(obj) }
  }
}

