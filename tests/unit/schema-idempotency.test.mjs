/**
 * Schema idempotency tests for backend/db/ensureSqliteSchema.js
 *
 * Root cause guarded here: `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so
 * applying it to a DB file created BEFORE a column was added never backfills the
 * column. A later `CREATE INDEX ... ON <table>(<new_column>)` then crashes with
 * "no such column". This broke `crawler:doctor` and `opps:check-national-minimum`
 * on any pre-existing/old SQLite DB. applySqliteSchema() reconciles columns first.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  applySqliteSchema,
  parseDesiredColumns,
  extractTableNames,
  reconcileTableColumns,
} from '../../backend/db/ensureSqliteSchema.js'

// A schema where the table gains a NEW column (opportunity_kind) plus an index
// that references it — exactly the shape that crashed in production.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS funding_opportunities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT,
  fingerprint TEXT,
  opportunity_kind TEXT,
  source_trust_tier TEXT,
  is_active BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_fo_kind ON funding_opportunities(opportunity_kind);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fo_fingerprint ON funding_opportunities(fingerprint);
`

test('applySqliteSchema heals an OLD table missing newer columns without throwing', () => {
  const db = new Database(':memory:')
  // Simulate a stale DB: the table exists but predates opportunity_kind / trust tier.
  db.exec(`CREATE TABLE funding_opportunities (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_url TEXT
  )`)

  const before = db.prepare('PRAGMA table_info(funding_opportunities)').all().map((c) => c.name)
  assert.ok(!before.includes('opportunity_kind'), 'precondition: column missing')

  // Without reconciliation the raw index-creating schema would throw; this must not.
  const result = applySqliteSchema(db, SCHEMA)

  const after = db.prepare('PRAGMA table_info(funding_opportunities)').all().map((c) => c.name)
  assert.ok(after.includes('opportunity_kind'), 'opportunity_kind backfilled')
  assert.ok(after.includes('source_trust_tier'), 'source_trust_tier backfilled')
  assert.ok(after.includes('fingerprint'), 'fingerprint backfilled')
  assert.ok(result.addedColumns.funding_opportunities.includes('opportunity_kind'))

  // The index referencing the new column must now exist.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fo_kind'").get()
  assert.ok(idx, 'index on new column created successfully')
  db.close()
})

test('applySqliteSchema on a FRESH db creates everything from scratch', () => {
  const db = new Database(':memory:')
  assert.doesNotThrow(() => applySqliteSchema(db, SCHEMA))
  const cols = db.prepare('PRAGMA table_info(funding_opportunities)').all().map((c) => c.name)
  assert.ok(cols.includes('opportunity_kind'))
  db.close()
})

test('applySqliteSchema is repeatable (second apply is a no-op, no throw)', () => {
  const db = new Database(':memory:')
  applySqliteSchema(db, SCHEMA)
  const r2 = applySqliteSchema(db, SCHEMA)
  assert.deepEqual(r2.addedColumns, {}, 'nothing to add on re-apply')
  db.close()
})

test('parseDesiredColumns extracts columns and skips table-level constraints', () => {
  const cols = parseDesiredColumns(
    `CREATE TABLE t (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       kind TEXT,
       CHECK(kind IN ('a','b')),
       FOREIGN KEY (id) REFERENCES other(id)
     )`,
    't',
  )
  const names = cols.map((c) => c.name)
  assert.deepEqual(names, ['id', 'name', 'kind'])
})

test('extractTableNames finds every declared table', () => {
  const names = extractTableNames(SCHEMA)
  assert.deepEqual(names, ['funding_opportunities'])
})

test('reconcileTableColumns is a no-op when the table does not yet exist', () => {
  const db = new Database(':memory:')
  const added = reconcileTableColumns(db, SCHEMA, 'funding_opportunities')
  assert.deepEqual(added, [])
  db.close()
})
