/**
 * Opportunity scope helper for user-facing SELECTs on funding_opportunities.
 *
 * Why this exists:
 *   The mission audit repeatedly flags "Opportunity query may lack trust /
 *   source / profile scope protections" because large parts of the backend
 *   read `SELECT * FROM funding_opportunities` without any constraints on
 *   source trust, profile ownership, or geographic relevance. Crawler
 *   ingestion legitimately needs that kind of unrestricted access, but
 *   user-facing read paths (discovery, matching, opportunities list) must
 *   never broaden scope silently.
 *
 *   `withOpportunityScope(sql, opts)` composes a scoped WHERE clause onto an
 *   existing SELECT so user-facing routes share one canonical definition of
 *   "visible to this caller".
 *
 * Shape of the return value:
 *   { sql, params }   // sql is the original SQL with scope appended,
 *                     // params is an array of positional bindings to append
 *                     // to the caller's existing params array.
 *
 * Options:
 *   - profileId       If provided, include opportunities owned by this
 *                     profile (profile_id) OR opportunities that are public
 *                     (profile_id IS NULL).
 *   - minSourceTrust  Numeric threshold; rows with source_trust strictly
 *                     lower are excluded. Rows whose source_trust is NULL
 *                     are treated as "unknown" and kept (so legacy imports
 *                     without a trust score are not dropped).
 *   - states          Array of two-letter state codes; rows whose `state`
 *                     matches OR whose `is_national` is truthy are kept.
 *   - excludeInactive If true (default), require is_active = 1 / TRUE.
 *   - isAdmin         When true, all scope restrictions collapse to
 *                     is_active-only. Callers must explicitly opt into
 *                     admin scope; the helper NEVER infers it from a
 *                     missing profile id.
 *   - dialect         'postgres' or 'sqlite' (default). Affects boolean
 *                     literal syntax.
 *
 * The helper is intentionally side-effect-free and parameterises every
 * dynamic value. It never interpolates user input into SQL.
 */

export function withOpportunityScope(sql, opts = {}) {
  const {
    profileId = null,
    minSourceTrust = null,
    states = null,
    excludeInactive = true,
    isAdmin = false,
    dialect = 'sqlite',
    alias = null,
  } = opts || {}

  const isPostgres = dialect === 'postgres'
  const TRUE = isPostgres ? 'TRUE' : '1'
  const col = (name) => (alias ? `${alias}.${name}` : name)

  const clauses = []
  const params = []

  if (excludeInactive) {
    clauses.push(`${col('is_active')} = ${TRUE}`)
  }

  if (isAdmin) {
    return appendWhere(sql, clauses, params)
  }

  if (profileId !== null && profileId !== undefined && String(profileId).length > 0) {
    clauses.push(`(${col('profile_id')} IS NULL OR ${col('profile_id')} = ?)`)
    params.push(String(profileId))
  } else {
    clauses.push(`${col('profile_id')} IS NULL`)
  }

  if (minSourceTrust !== null && minSourceTrust !== undefined && Number.isFinite(Number(minSourceTrust))) {
    clauses.push(`(${col('source_trust')} IS NULL OR ${col('source_trust')} >= ?)`)
    params.push(Number(minSourceTrust))
  }

  if (Array.isArray(states) && states.length > 0) {
    const cleaned = states
      .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
      .filter(Boolean)
    if (cleaned.length > 0) {
      const placeholders = cleaned.map(() => '?').join(',')
      clauses.push(
        `(${col('is_national')} = ${TRUE} OR ${col('state')} IS NULL OR ${col('state')} IN (${placeholders}))`,
      )
      params.push(...cleaned)
    }
  }

  return appendWhere(sql, clauses, params)
}

function appendWhere(sql, clauses, params) {
  if (clauses.length === 0) return { sql, params }
  const joined = clauses.join(' AND ')
  const hasWhere = /\bWHERE\b/i.test(sql)
  const connector = hasWhere ? ' AND ' : ' WHERE '
  // Insert scope before ORDER BY / GROUP BY / LIMIT if present.
  const tailRx = /\b(ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET)\b/i
  const tail = tailRx.exec(sql)
  if (tail) {
    return {
      sql: sql.slice(0, tail.index) + connector + joined + ' ' + sql.slice(tail.index),
      params,
    }
  }
  return { sql: sql + connector + joined, params }
}

/**
 * Resolve admin scope intent from an Express `req` object. Returns true only
 * when the caller is explicitly authenticated as admin. Everything else
 * (unknown caller, missing user, non-admin user) returns false. This helper
 * exists so route code has one obvious way to ask "should I broaden scope?"
 * rather than every file inlining its own check.
 */
export function resolveIsAdmin(req) {
  // DB-backed admin only (req.ctx.isAdmin, resolved from users.is_admin by
  // requestContext middleware). Never trust raw JWT claims (req.user.role /
  // .roles / .isAdmin) — a demoted admin's unexpired token must not broaden scope.
  return req?.ctx?.isAdmin === true
}
