/**
 * Parse a value that may arrive as any of the shapes JSON-bearing columns
 * return across our two drivers:
 *   - Postgres json/jsonb: already-parsed object or array
 *   - Postgres TEXT holding a JSON string: plain string
 *   - Postgres TEXT holding a double-encoded JSON blob (a string whose first
 *     character is `"` and whose payload is itself JSON): happens when
 *     something called JSON.stringify on an already-stringified value
 *   - better-sqlite3 bytea-ish: Buffer of UTF-8 JSON
 *
 * Callers should not care which of these they got — they just want the parsed
 * value, or the fallback if nothing sensible can be produced.
 */
export function safeParseJSON(value, fallback = null) {
  if (value == null || value === '') return fallback

  // Already-parsed (pg json/jsonb): arrays and plain objects pass through.
  if (typeof value === 'object' && !(value instanceof Buffer)) {
    return value
  }

  // Buffer of UTF-8 JSON text.
  if (value instanceof Buffer) {
    const text = value.toString('utf8')
    return safeParseJSON(text, fallback)
  }

  if (typeof value !== 'string') return fallback

  try {
    const parsed = JSON.parse(value)
    // Double-encoded: JSON.parse returned another JSON string. Parse again.
    if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        return JSON.parse(parsed)
      } catch {
        return parsed
      }
    }
    return parsed
  } catch {
    return fallback
  }
}

export function safeStringifyJSON(value, fallback = '{}') {
  if (value == null) return fallback
  try {
    return JSON.stringify(value)
  } catch (error) {
    console.warn('Failed to stringify JSON:', error.message)
    return fallback
  }
}
