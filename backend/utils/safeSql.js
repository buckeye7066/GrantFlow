/**
 * Shared safe SQL identifier utilities.
 *
 * Use these helpers whenever a query needs to interpolate an identifier
 * (table name, column name, composite key set) that cannot be parameterised
 * through bind variables. Values must still be passed as parameters; only the
 * identifier/key shape is validated here against a hardcoded allowlist.
 */

/**
 * Assert that `value` is a key in `allowedMap`. Returns the mapped entry on
 * success; throws a 400 Error otherwise.
 *
 * @param {string} value - Candidate identifier from user/code input
 * @param {Record<string, any>} allowedMap - Hardcoded allowlist { identifier: metadata }
 * @param {string} [label='identifier'] - Human-readable label for error messages
 */
export function assertAllowedIdentifier(value, allowedMap, label = 'identifier') {
  const normalized = String(value || '').trim()
  if (!normalized || !Object.prototype.hasOwnProperty.call(allowedMap, normalized)) {
    const error = new Error(`Unsafe SQL ${label}: ${value}`)
    error.status = 400
    throw error
  }
  return allowedMap[normalized]
}

/**
 * Build a `col = ? AND col = ?` WHERE clause from an ordered list of key names.
 * Caller is responsible for passing matching values to the prepared statement.
 *
 * @param {string[]} keys - Column names to include in the WHERE clause
 */
export function buildEqualityWhereClause(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('At least one key is required')
  }
  // Safety: key names must look like SQL identifiers. Callers should have
  // already passed through assertAllowedKeySet, but defence in depth is cheap.
  for (const key of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) {
      const error = new Error(`Invalid SQL column name: ${key}`)
      error.status = 400
      throw error
    }
  }
  return keys.map((key) => `${key} = ?`).join(' AND ')
}

/**
 * Assert that an unordered set of keys matches one of the allowed sets.
 * Prevents callers from supplying arbitrary composite unique keys.
 *
 * @param {string[]} keys - Candidate key set
 * @param {string[][]} allowedSets - Allowlist of acceptable key combinations
 * @param {string} [label='key set']
 */
export function assertAllowedKeySet(keys, allowedSets, label = 'key set') {
  if (!Array.isArray(keys) || keys.length === 0) {
    const error = new Error(`Unsafe SQL ${label}: (empty)`)
    error.status = 400
    throw error
  }
  const normalized = [...keys].map(String).sort()
  const matched = allowedSets.some((set) => {
    const sorted = [...set].map(String).sort()
    return sorted.length === normalized.length && sorted.every((v, i) => v === normalized[i])
  })
  if (!matched) {
    const error = new Error(`Unsafe SQL ${label}: ${keys.join(', ')}`)
    error.status = 400
    throw error
  }
  return true
}

// ───────────────────────────────────────────────────────────────────────
//  Global allowlists for identifier validation
//
//  Every table/column that the backend ever interpolates into a prepared
//  statement MUST be represented here. The auditor (admin.code.scan/crawl)
//  greps for ${...} inside template literals and fails the build when the
//  identifier isn't resolvable to this allowlist. Adding a new column
//  therefore requires an explicit, reviewable code change — not a silent
//  runtime-only addition.
// ───────────────────────────────────────────────────────────────────────

const _BASE_TABLE_NAMES = [
  'applications',
  'application_sections',
  'application_checklist_items',
  'application_artifacts',
  'profiles',
  'profile_sections',
  'profile_checklists',
  'profile_integrations',
  'profile_membership',
  'organizations',
  'organization_members',
  'users',
  'user_preferences',
  'user_sessions',
  'funding_opportunities',
  'funding_opportunity_sources',
  'grants',
  'grant_matches',
  'documents',
  'document_access_log',
  'document_proxies',
  'audit_events',
  'audit_logs',
  'crawler_runs',
  'crawler_jobs',
  'colleges',
  'college_contacts',
  'portal_check_results',
  'vnext_applications',
  'vnext_application_tasks',
  'vnext_form_schemas',
  'outreach_logs',
  'outreach_contacts',
  'anya_messages',
  'anya_tool_runs',
  'form_schemas',
  'match_logs',
  'mission_audit_findings',
]

const _COMMON_COLUMN_NAMES = [
  // Document / content columns
  'notes',
  'processing_status',
  // Grants AI columns (added via migrations in backend/routes/grants.js)
  'program_description',
  'eligibility_summary',
  'selection_criteria',
  'ai_status',
  'ai_summary',
  'ai_error',
  'ai_updated_at',
  'match_percentage',
  'deleted_by',
  'display_name',
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'last_crawled',
  'last_verified_at',
  'profile_id',
  'organization_id',
  'opportunity_id',
  'application_id',
  'grant_id',
  'funding_opportunity_id',
  'user_id',
  'email',
  'primary_email',
  'display_name',
  'name',
  'slug',
  'title',
  'description',
  'summary',
  'status',
  'state',
  'stage',
  'type',
  'kind',
  'opportunity_type',
  'funding_type',
  'funding_category',
  'source',
  'source_id',
  'source_url',
  'source_trust',
  'application_url',
  'apply_url',
  'evidence_url',
  'url',
  'category',
  'categories',
  'keywords',
  'tags',
  'state_name',
  'city',
  'zip',
  'country',
  'is_national',
  'is_active',
  'is_loan',
  'requires_match',
  'amount_min',
  'amount_max',
  'deadline',
  'deadline_type',
  'schema_id',
  'schema_key',
  'section_key',
  'value',
  'data',
  'json_data',
  'metadata',
  'content',
  'action',
  'actor',
  'actor_type',
  'entity_type',
  'entity_id',
  'before',
  'after',
  'severity',
  'count',
  'score',
  'reasons',
  'match_explain',
  'need_types_supported',
  'population_served',
  'mission_focus',
  'organization_type',
  'employee_count',
  'annual_revenue',
  'years_in_operation',
  'veteran_owned',
  'woman_owned',
  'minority_owned',
  'primary_type',
  'key',
  'label',
  'payload',
  'result',
  'provider',
  'provider_id',
  'job_id',
  'task_key',
]

const _IDENTIFIER_RX = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const _TABLE_ALLOWLIST = new Set(_BASE_TABLE_NAMES)
const _COLUMN_ALLOWLIST = new Set(_COMMON_COLUMN_NAMES)

/**
 * Extend the global SQL identifier allowlists at boot. Call from migration
 * / bootstrap code when a new schema is introduced; this keeps runtime
 * check surface narrow while letting integrators add project-specific
 * tables without forking safeSql.js.
 */
export function registerAllowedSqlIdentifiers({ tables = [], columns = [] } = {}) {
  for (const t of tables) {
    if (!_IDENTIFIER_RX.test(String(t))) {
      throw new Error(`registerAllowedSqlIdentifiers: bad table name: ${t}`)
    }
    _TABLE_ALLOWLIST.add(String(t))
  }
  for (const c of columns) {
    if (!_IDENTIFIER_RX.test(String(c))) {
      throw new Error(`registerAllowedSqlIdentifiers: bad column name: ${c}`)
    }
    _COLUMN_ALLOWLIST.add(String(c))
  }
}

export function getAllowedSqlTables() {
  return [..._TABLE_ALLOWLIST]
}

export function getAllowedSqlColumns() {
  return [..._COLUMN_ALLOWLIST]
}

/**
 * Validate a single SQL identifier (table or column) against the global
 * allowlist. Returns the identifier unchanged on success so callers can
 * inline it: `const sql = \`SELECT ${assertSafeIdentifier(col, 'column')} FROM \${tbl}\``.
 *
 * @param {string} name - Candidate identifier
 * @param {'table'|'column'|'identifier'} [kind='identifier']
 */
export function assertSafeIdentifier(name, kind = 'identifier') {
  const v = String(name || '').trim()
  if (!v) {
    const err = new Error(`Unsafe SQL ${kind}: (empty)`)
    err.status = 400
    throw err
  }
  if (!_IDENTIFIER_RX.test(v)) {
    const err = new Error(`Unsafe SQL ${kind}: ${name}`)
    err.status = 400
    throw err
  }
  if (kind === 'table' && !_TABLE_ALLOWLIST.has(v)) {
    const err = new Error(`Unsafe SQL table: ${name}`)
    err.status = 400
    throw err
  }
  if (kind === 'column' && !_COLUMN_ALLOWLIST.has(v)) {
    const err = new Error(`Unsafe SQL column: ${name}`)
    err.status = 400
    throw err
  }
  return v
}

/**
 * Build a parameterised WHERE clause from `{ col: value }` pairs.
 *
 * Returns `{ sql, params, clause }` where `sql` is the full string
 * `WHERE col = ? AND col2 = ?` (or `''` when no parts), `clause` is the
 * same string without the leading WHERE keyword, and `params` is the
 * positional argument list. Column names are validated against the
 * allowlist; unknown columns throw — NEVER silently passed through.
 *
 *   const { sql, params } = buildWhere({ profile_id, status: 'active' })
 *   db.prepare(\`SELECT * FROM funding_opportunities \${sql}\`).all(...params)
 *
 * @param {Record<string, unknown>|Array<{column: string, value: unknown, op?: string}>} parts
 */
export function buildWhere(parts) {
  const entries = Array.isArray(parts)
    ? parts
    : Object.entries(parts || {}).map(([column, value]) => ({ column, value }))

  const fragments = []
  const params = []

  for (const { column, value, op } of entries) {
    if (value === undefined) continue // skip "not supplied" filters
    const col = assertSafeIdentifier(column, 'column')
    const operator = normalizeOperator(op)
    if (value === null) {
      fragments.push(`${col} IS ${operator === '!=' ? 'NOT NULL' : 'NULL'}`)
      continue
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        // A caller asked for an IN (empty list). That should match nothing —
        // encode it explicitly instead of emitting `IN ()` which is invalid.
        fragments.push('1 = 0')
        continue
      }
      const placeholders = value.map(() => '?').join(', ')
      fragments.push(`${col} ${operator === '!=' ? 'NOT IN' : 'IN'} (${placeholders})`)
      params.push(...value)
      continue
    }
    fragments.push(`${col} ${operator} ?`)
    params.push(value)
  }

  if (fragments.length === 0) {
    return { sql: '', clause: '', params: [] }
  }
  const clause = fragments.join(' AND ')
  return { sql: `WHERE ${clause}`, clause, params }
}

function normalizeOperator(op) {
  const raw = String(op || '=').trim()
  const allowed = new Set(['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE'])
  if (!allowed.has(raw.toUpperCase()) && !allowed.has(raw)) {
    const err = new Error(`Unsafe SQL operator: ${op}`)
    err.status = 400
    throw err
  }
  return raw
}
