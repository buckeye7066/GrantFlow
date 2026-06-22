/**
 * Sanitize a database/driver error into a friendly, non-leaky message that is
 * safe to PERSIST and SHOW to end users.
 *
 * Why this exists (information disclosure + UX):
 *   The async document-ingestion worker persists a per-document failure message
 *   into `documents.processing_error`, which the UI renders verbatim under
 *   Proposals & Files. Storing `error.message` directly leaked raw Postgres
 *   text to users, e.g.:
 *     "new row for relation 'document_extracts' violates check constraint
 *      'document_extracts_source_type_check'"
 *   That exposes internal relation/constraint names (information disclosure) and
 *   is meaningless to a user. The HTTP `errorHandler`/`formatError` middleware
 *   only sanitizes the HTTP RESPONSE in production — it does not touch values we
 *   persist for later display. This helper is the persisted-message counterpart.
 *
 * Contract:
 *   - Always returns a short, human-readable string (never null/empty).
 *   - Never includes SQL text, relation names, constraint names, SQLSTATE codes,
 *     stack frames, or driver internals.
 *   - The FULL error must still be logged server-side by the caller (we never
 *     silently swallow the real cause — see the project's silent-failure
 *     aversion). This helper only governs what the USER sees.
 */

// Patterns that indicate a low-level DB/driver fault whose raw text must never
// reach the UI. Matching any of these collapses the message to a friendly one.
const DB_FAULT_SIGNATURES = [
  /violates (?:check|not-null|foreign key|unique) constraint/i,
  /duplicate key value/i,
  /new row for relation/i,
  /constraint ["'][a-z0-9_]+["']/i,
  /relation ["'][a-z0-9_.]+["']/i,
  /\bsqlite_/i,
  /\bSQLITE_[A-Z]+/,
  /CHECK constraint failed/i,
  /no such (?:table|column)/i,
  /syntax error at or near/i,
  /column ["'][a-z0-9_]+["'] (?:does not exist|of relation)/i,
]

const DEFAULT_FRIENDLY = "Couldn't import or parse this source."

function rawMessageOf(error) {
  if (error === null || error === undefined) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  try {
    return String(error)
  } catch {
    return ''
  }
}

/**
 * @param {unknown} error - The raw Error / message / value.
 * @param {string} [fallback] - Friendly message to use when the raw text looks
 *   like an internal DB fault (or is empty/unsafe).
 * @returns {string} A safe-to-display message.
 */
export function sanitizeDbErrorMessage(error, fallback = DEFAULT_FRIENDLY) {
  const raw = rawMessageOf(error).trim()
  if (!raw) return fallback

  // Postgres node-pg errors expose a SQLSTATE in error.code; anything in the
  // 22xxx/23xxx (data/integrity) class is a DB-shape fault, not user-facing.
  const code = typeof error === 'object' && error ? String(error.code || '') : ''
  if (/^(22|23|42)/.test(code)) return fallback

  if (DB_FAULT_SIGNATURES.some((re) => re.test(raw))) return fallback

  return raw
}

export { DEFAULT_FRIENDLY as DEFAULT_FRIENDLY_DB_ERROR }
