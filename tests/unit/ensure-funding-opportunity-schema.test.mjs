/**
 * Regression for the production outage where funding_opportunities was missing
 * `reality_status` (migration 0073 never applied because the strict boot
 * migration chain aborted earlier), so every crawler/connector/Robert write
 * failed with `column "reality_status" ... does not exist` and the Funding
 * Library could not take in new data.
 *
 * The self-heal must: add missing reality-gate columns idempotently, be a
 * no-op when present, tolerate "already exists", and never throw fatally.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureFundingOpportunitySchema } from '../../backend/utils/ensureFundingOpportunitySchema.js'

const REALITY_COLS = ['reality_status', 'reality_reasons', 'final_url', 'http_status']

function makeFakeDb({ dialect = 'postgres', existingCols = new Set(), failCols = new Set() } = {}) {
  const cols = new Set(existingCols)
  const execLog = []
  return {
    dialect,
    _cols: cols,
    _execLog: execLog,
    async exec(sql) {
      execLog.push(sql)
      const m = /ADD COLUMN (?:IF NOT EXISTS )?(\w+)/i.exec(sql)
      if (m) {
        const col = m[1]
        if (failCols.has(col)) throw new Error(`boom adding ${col}`)
        cols.add(col)
      }
      // CREATE INDEX etc. — no-op
    },
    prepare(sql) {
      return {
        async get(table, col) {
          // postgres information_schema.columns probe
          if (/information_schema\.columns/i.test(sql)) {
            return cols.has(col) ? { ok: 1 } : undefined
          }
          return undefined
        },
        async all() {
          // sqlite PRAGMA table_info
          if (/table_info/i.test(sql)) {
            return [...cols].map((name) => ({ name }))
          }
          return []
        },
      }
    },
  }
}

test('adds all reality columns when none exist (postgres)', async () => {
  const db = makeFakeDb({ dialect: 'postgres' })
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.deepEqual(out.added.sort(), [...REALITY_COLS].sort())
  assert.equal(out.failed.length, 0)
  for (const c of REALITY_COLS) assert.ok(db._cols.has(c), `expected ${c} present`)
  // reality_status added with IF NOT EXISTS guard on postgres
  assert.ok(db._execLog.some((s) => /ADD COLUMN IF NOT EXISTS reality_status/i.test(s)))
})

test('is a no-op when all columns already present', async () => {
  const db = makeFakeDb({ dialect: 'postgres', existingCols: new Set(REALITY_COLS) })
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.equal(out.added.length, 0)
  assert.deepEqual(out.present.sort(), [...REALITY_COLS].sort())
  // no ALTER statements emitted
  assert.ok(!db._execLog.some((s) => /ALTER TABLE/i.test(s)))
})

test('only adds the missing subset', async () => {
  const db = makeFakeDb({ dialect: 'postgres', existingCols: new Set(['reality_status']) })
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.ok(out.present.includes('reality_status'))
  assert.deepEqual(out.added.sort(), ['final_url', 'http_status', 'reality_reasons'])
})

test('a single column failure is non-fatal and recorded', async () => {
  const db = makeFakeDb({ dialect: 'postgres', failCols: new Set(['reality_reasons']) })
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.equal(out.failed.length, 1)
  assert.equal(out.failed[0].column, 'reality_reasons')
  // the others still got added despite the one failure
  assert.ok(out.added.includes('reality_status'))
  assert.ok(out.added.includes('http_status'))
})

test('sqlite path adds columns without IF NOT EXISTS', async () => {
  const db = makeFakeDb({ dialect: 'sqlite' })
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.deepEqual(out.added.sort(), [...REALITY_COLS].sort())
  assert.ok(db._execLog.some((s) => /ADD COLUMN reality_status/i.test(s) && !/IF NOT EXISTS/i.test(s)))
})

test('treats "already exists" as present, not a failure', async () => {
  const db = makeFakeDb({ dialect: 'postgres' })
  // Force exec to throw an already-exists error for one column
  const origExec = db.exec.bind(db)
  db.exec = async (sql) => {
    if (/ADD COLUMN IF NOT EXISTS final_url/i.test(sql)) throw new Error('column "final_url" already exists')
    return origExec(sql)
  }
  const out = await ensureFundingOpportunitySchema(db, { logger: { info() {}, warn() {} } })
  assert.equal(out.failed.length, 0)
  assert.ok(out.present.includes('final_url'))
})
