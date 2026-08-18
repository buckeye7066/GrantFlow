/**
 * Idempotent SQLite schema application for standalone scripts.
 *
 * Background / root cause this solves
 * -----------------------------------
 * `schema.sql` declares tables with `CREATE TABLE IF NOT EXISTS`. When a script
 * applies the schema to a DB file that already exists but was created BEFORE a
 * column was added (e.g. `funding_opportunities.opportunity_kind`, migration
 * 068), the `CREATE TABLE IF NOT EXISTS` is a no-op — it does NOT add the new
 * column to the existing table. A later `CREATE INDEX ... ON
 * funding_opportunities(opportunity_kind)` then crashes with
 * "no such column: opportunity_kind".
 *
 * Numbered migrations (`backend/db/migrations/*.sql` via `migrate.js`) handle
 * this for the app, but lightweight standalone scripts such as `crawler:doctor`
 * and `opps:check-national-minimum` apply `schema.sql` directly and must be
 * resilient to pre-existing/old DB files on their own.
 *
 * This module reconciles a table's columns against the canonical `schema.sql`
 * CREATE block — ALTER-adding any missing columns (base type only, no
 * constraints/defaults, which SQLite forbids on ADD COLUMN) — and only then
 * applies the full schema. This mirrors the established `adminSchemaRepair.js`
 * pattern but is keyed off the schema text so it self-maintains as columns are
 * added.
 *
 * Synchronous on purpose: the consuming scripts use the synchronous
 * better-sqlite3 API.
 */

import { applyWorkspacePersistenceTablesSync } from './applyWorkspacePersistenceTables.js'

const SQLITE_BASE_TYPES = new Set([
  'TEXT',
  'INTEGER',
  'INT',
  'REAL',
  'NUMERIC',
  'BLOB',
  'BOOLEAN',
  'DATETIME',
  'DATE',
  'TIME',
  'TIMESTAMP',
])

const CONSTRAINT_KEYWORDS = new Set([
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
  'CONSTRAINT',
])

/**
 * Extract the body (text between the outermost parentheses) of a
 * `CREATE TABLE [IF NOT EXISTS] <table> ( ... )` statement from a schema string.
 * Returns null when the table is not found.
 */
function extractCreateTableBody(schemaSql, tableName) {
  const re = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\u0060]?${tableName}["'\u0060]?\\s*\\(`,
    'i',
  )
  const match = re.exec(schemaSql)
  if (!match) return null

  let depth = 0
  let started = false
  let body = ''
  for (let i = match.index + match[0].length - 1; i < schemaSql.length; i += 1) {
    const ch = schemaSql[i]
    if (ch === '(') {
      depth += 1
      if (depth === 1 && !started) {
        started = true
        continue // skip the opening paren itself
      }
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) break
    }
    if (started) body += ch
  }
  return started ? body : null
}

/**
 * Split a CREATE TABLE body into top-level definitions, respecting parentheses
 * (so commas inside `CHECK(... IN (...))` or `DEFAULT (...)` do not split a
 * definition). Line comments (`-- ...`) are stripped first.
 */
function splitTopLevelDefinitions(body) {
  const withoutComments = body
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')

  const defs = []
  let depth = 0
  let current = ''
  for (const ch of withoutComments) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      defs.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) defs.push(current.trim())
  return defs.filter(Boolean)
}

/**
 * Parse a CREATE TABLE body into a list of { name, type } column descriptors,
 * skipping table-level constraint clauses.
 */
export function parseDesiredColumns(schemaSql, tableName) {
  const body = extractCreateTableBody(schemaSql, tableName)
  if (!body) return []
  const columns = []
  for (const def of splitTopLevelDefinitions(body)) {
    const tokens = def.split(/\s+/)
    if (tokens.length === 0) continue
    const firstUpper = tokens[0].toUpperCase()
    if (CONSTRAINT_KEYWORDS.has(firstUpper)) continue
    const name = tokens[0].replace(/["'`]/g, '')
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    const typeToken = (tokens[1] || 'TEXT').toUpperCase().replace(/\(.*$/, '')
    const type = SQLITE_BASE_TYPES.has(typeToken) ? typeToken : 'TEXT'
    columns.push({ name, type })
  }
  return columns
}

/**
 * Extract every table name declared via `CREATE TABLE [IF NOT EXISTS] <name>`
 * in a schema string, in declaration order.
 */
export function extractTableNames(schemaSql) {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?\s*\(/gi
  const names = []
  let m
  while ((m = re.exec(schemaSql)) !== null) {
    if (!names.includes(m[1])) names.push(m[1])
  }
  return names
}

function sqliteTableExists(db, tableName) {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName)
  return Boolean(row?.name)
}

function sqliteColumnNames(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all()
  return new Set(rows.map((r) => String(r.name)))
}

/**
 * Reconcile a single table's columns against the canonical schema, ALTER-adding
 * any missing columns. No-op when the table does not yet exist (the subsequent
 * full schema apply will create it fresh with every column).
 *
 * @returns {string[]} names of columns added.
 */
export function reconcileTableColumns(db, schemaSql, tableName) {
  if (!sqliteTableExists(db, tableName)) return []
  const desired = parseDesiredColumns(schemaSql, tableName)
  if (desired.length === 0) return []
  const existing = sqliteColumnNames(db, tableName)
  const added = []
  for (const { name, type } of desired) {
    if (existing.has(name)) continue
    try {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${name}" ${type}`)
      added.push(name)
    } catch (error) {
      const message = String(error?.message || error)
      // Already present (race) — fine. Anything else is a real problem.
      if (!/duplicate column|already exists/i.test(message)) throw error
    }
  }
  return added
}

/**
 * Apply `schema.sql` to a (possibly pre-existing/old) SQLite DB idempotently.
 * Reconciles the listed tables' columns first so that index/constraint
 * statements referencing newer columns succeed, then execs the full schema.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} schemaSql full contents of schema.sql
 * @param {object} [opts]
 * @param {string[]} [opts.reconcileTables] tables to column-reconcile before exec
 * @returns {{ addedColumns: Record<string, string[]> }}
 */
export function applySqliteSchema(db, schemaSql, opts = {}) {
  // Default: reconcile EVERY table declared in the schema. Old DB files can be
  // missing newer columns on any table, and an index/constraint referencing one
  // of them would otherwise crash the whole schema apply.
  const reconcileTables = opts.reconcileTables ?? extractTableNames(schemaSql)
  const addedColumns = {}
  for (const table of reconcileTables) {
    const added = reconcileTableColumns(db, schemaSql, table)
    if (added.length > 0) addedColumns[table] = added
  }
  db.exec(schemaSql)
  // Consultant + catalog tables live outside schema.sql. Apply them here so a
  // fresh local SQLite file has Invoice / AiArtifact / PartnerSource / SearchJob
  // / Taxonomy without a separate `npm run migrate`.
  applyWorkspacePersistenceTablesSync(db)
  return { addedColumns }
}

export default applySqliteSchema
