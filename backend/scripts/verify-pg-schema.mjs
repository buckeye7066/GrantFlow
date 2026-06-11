/**
 * verify-pg-schema.mjs
 *
 * Post-migration schema assertions for Postgres. Run after `npm run migrate`
 * against a freshly-migrated Postgres database (see the `postgres-migrations`
 * CI job). Guards the canonical column types and key tables that have drifted
 * before, so a future migration can't silently reintroduce the
 * TEXT-vs-JSONB / missing-table bugs that made the chain unreplayable.
 *
 * Requires DATABASE_URL (+ DB_PROVIDER=postgres) in the environment. Exits 0
 * when every expectation holds, non-zero (with a diff) otherwise.
 */

import { getDb } from '../db/index.js'

const db = getDb()

if (db.dialect !== 'postgres') {
  console.error(`[verify-pg-schema] expected a postgres DB, got dialect=${db.dialect}`)
  process.exit(2)
}

// [table, column, expected information_schema.data_type]. A column expectation
// of `null` means "the table must exist" (no specific column checked).
const columnExpectations = [
  // grants JSON-as-text columns — canonical TEXT (0001_init + matcher writes
  // JSON.stringify(...)). Declaring them JSONB in a later migration is a no-op
  // on the existing TEXT column but makes backfills crash.
  ['grants', 'match_explanation', 'text'],
  ['grants', 'match_reasons', 'text'],
  ['grants', 'matched_needs', 'jsonb'],
  // funding_opportunities boolean columns must be real BOOLEANs so the shim's
  // fixBooleanIntegers rewrite is the single source of truth (see
  // backend/db/index.js KNOWN_BOOLEAN_COLUMNS).
  ['funding_opportunities', 'is_active', 'boolean'],
  ['funding_opportunities', 'is_national', 'boolean'],
  ['funding_opportunities', 'is_loan', 'boolean'],
  ['funding_opportunities', 'requires_match', 'boolean'],
]

// Tables that must exist after a full replay (grant_applications was the one
// that lived only in the SQLite migration set and broke 0064's FK).
const requiredTables = ['grants', 'funding_opportunities', 'grant_applications', 'profiles']

const failures = []

for (const table of requiredTables) {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM information_schema.tables WHERE table_name = ? LIMIT 1`,
    )
    .get(table)
  if (!row) failures.push(`missing table: ${table}`)
}

for (const [table, column, expectedType] of columnExpectations) {
  const row = await db
    .prepare(
      `SELECT data_type FROM information_schema.columns WHERE table_name = ? AND column_name = ?`,
    )
    .get(table, column)
  if (!row) {
    failures.push(`missing column: ${table}.${column} (expected ${expectedType})`)
  } else if (row.data_type !== expectedType) {
    failures.push(`${table}.${column} is ${row.data_type}, expected ${expectedType}`)
  }
}

if (failures.length > 0) {
  console.error('[verify-pg-schema] FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log(
  `[verify-pg-schema] OK — ${requiredTables.length} tables and ${columnExpectations.length} column types match the canonical Postgres schema.`,
)
process.exit(0)
