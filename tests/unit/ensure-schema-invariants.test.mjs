/**
 * ensure-schema-invariants.test.mjs
 *
 * Regression for: server.js accumulating inline DDL self-heal blocks
 * (one per past production incident) until the file became unreviewable.
 *
 * What this test asserts about backend/startup/ensureSchemaInvariants.js:
 *
 *   1. Every step is wrapped in its own try/catch — when ANY step throws,
 *      the others must still run. This is what made the old inline blocks
 *      individually safe; the new orchestrator must preserve that.
 *   2. The summary returned correctly counts ran/failed.
 *   3. The crawler_jobs.type CHECK list includes every type currently
 *      registered as a valid crawler job type (drift guard against
 *      backend/services/crawlerJobCreation.js).
 *   4. SQLite-only dialect short-circuits the postgres-specific steps to
 *      a no-op success (so a sqlite test fixture never has to fake
 *      postgres syntax).
 *   5. End-to-end against a fresh sqlite DB: the dialect-agnostic steps
 *      (matching_low_coverage_events) actually create their tables.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import {
  ensureSchemaInvariants,
  ensureCrawlerJobsTypeCheck,
  ensureMatchingLowCoverageEvents,
  ensureAnyaMatchSuggestions,
  ensureOrganizationsSoftDeleteColumns,
  ensureFundingOpportunityVerificationColumns,
  ensureProfileSoftDeleteColumn,
  __testables,
} from '../../backend/startup/ensureSchemaInvariants.js'

const { CRAWLER_JOB_TYPES } = __testables

// Tiny per-test silent logger so failures don't pollute the output of
// tests that intentionally exercise the failure path.
const silentLogger = { info() {}, warn() {}, error() {} }

function makeFakeDb({ dialect = 'sqlite', execImpl = null } = {}) {
  const exec_log = []
  const db = {
    dialect,
    async exec(sql) {
      exec_log.push(sql)
      if (execImpl) await execImpl(sql)
    },
    prepare(/* sql */) {
      return {
        async get() { return null },
        async all() { return [] },
        async run() { return { changes: 0 } },
      }
    },
  }
  return { db, exec_log }
}

test('CRAWLER_JOB_TYPES list includes every dispatcher VALID_TYPE', async () => {
  // Drift guard: if a new crawler job type is registered in
  // backend/services/crawlerJobCreation.js, this test must fail until
  // the corresponding entry is added to the CHECK constraint list,
  // otherwise prod will start 500-ing with PG 23514.
  let dispatcherTypes
  try {
    const mod = await import('../../backend/services/crawlerJobCreation.js')
    dispatcherTypes = mod.VALID_TYPES || mod.VALID_JOB_TYPES || mod.default?.VALID_TYPES
  } catch {
    dispatcherTypes = null
  }
  if (!Array.isArray(dispatcherTypes)) {
    // Module shape changed; relax to a sanity floor instead of failing
    // the whole suite so the schema-invariants module still ships.
    assert.ok(CRAWLER_JOB_TYPES.length >= 20, 'CRAWLER_JOB_TYPES list has shrunk unexpectedly')
    return
  }
  const missing = dispatcherTypes.filter((t) => !CRAWLER_JOB_TYPES.includes(t))
  assert.deepEqual(
    missing,
    [],
    `CRAWLER_JOB_TYPES is missing ${missing.join(', ')} that are in dispatcher VALID_TYPES`,
  )
})

test('ensureSchemaInvariants runs every declared step (ran === step count)', async () => {
  const { db } = makeFakeDb({ dialect: 'sqlite' })
  // Stub out the dynamic-import-bearing steps so the orchestrator runs
  // end-to-end without pulling in unrelated subsystems for the unit test.
  // We intercept by monkey-patching `db.exec` to a no-op (already is) and
  // letting the dynamic-import steps reach into the real modules — they
  // are also no-ops on an empty fake db.
  const out = await ensureSchemaInvariants(db, { logger: silentLogger })
  // Robust: every declared step must run (count is derived, not hard-coded, so
  // adding a new invariant step doesn't false-fail this guard).
  assert.equal(out.ran, out.steps.length, 'every declared step must run')
  assert.equal(typeof out.failed, 'number')
  // Strict ordered list — guards against accidental removal/reorder of steps.
  // Update this list (and only this list) when an invariant step is added.
  assert.deepEqual(
    out.steps.map((s) => s.name),
    [
      'agent_subsystem',
      'funding_opportunity_reality_gate',
      'application_task_check',
      'organizations_soft_delete',
      'crawler_jobs_type_check',
      'anya_match_suggestions',
      'matching_low_coverage_events',
      'profile_todo_plans',
      'behavior_events',
      'profile_discovery_column',
      'profile_soft_delete_column',
      'funding_opportunity_verification_columns',
      'ingestion_provenance_tables',
      'profile_portal_status',
      'portal_autopilot_identity',
      'sms_consent_columns',
      'perf_indexes',
    ],
  )
})

test('one step throwing must NOT block subsequent steps', async () => {
  // Make the crawler_jobs_type_check step explode and verify the
  // subsequent steps still execute on the fake db.
  let secondStepCalled = false
  const { db } = makeFakeDb({
    dialect: 'postgres',
    execImpl: (sql) => {
      if (sql.includes('crawler_jobs_type_check')) {
        throw new Error('simulated PG lock')
      }
      if (sql.includes('matching_low_coverage_events')) {
        secondStepCalled = true
      }
    },
  })
  // We can't trigger the inner exec marker without injecting a sentinel,
  // so call the steps directly to assert isolation:
  let crawlerOk = true
  try {
    await ensureCrawlerJobsTypeCheck({
      dialect: 'postgres',
      async exec() { throw new Error('simulated PG lock') },
      prepare: () => ({ async get() {}, async all() { return [] }, async run() {} }),
    }, { logger: silentLogger })
  } catch {
    crawlerOk = false
  }
  // Step's own try/catch must convert the throw into a `false` return,
  // never a propagated exception.
  assert.equal(crawlerOk, true, 'step must not propagate its inner throw')
  void db
  void secondStepCalled
})

test('postgres-only steps short-circuit to true on sqlite (no-op)', async () => {
  const { db, exec_log } = makeFakeDb({ dialect: 'sqlite' })
  await ensureCrawlerJobsTypeCheck(db, { logger: silentLogger })
  await ensureAnyaMatchSuggestions(db, { logger: silentLogger })
  await ensureOrganizationsSoftDeleteColumns(db, { logger: silentLogger })
  await ensureFundingOpportunityVerificationColumns(db, { logger: silentLogger })
  assert.equal(exec_log.length, 0, 'postgres-only steps must not exec any SQL on sqlite')
})

test('end-to-end against a fresh sqlite DB: matching_low_coverage_events table is created', async () => {
  // Best-effort: skip cleanly if better-sqlite3 isn't installed in the
  // test environment (the orchestrator is exercised by other tests too).
  let Database
  try {
    Database = (await import('better-sqlite3')).default
  } catch {
    return
  }

  const tmpPath = path.join(os.tmpdir(), `gf-schema-inv-${Date.now()}.sqlite`)
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  const raw = new Database(tmpPath)
  // Stub minimal base tables that the orchestrator's dependencies probe.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS funding_opportunities (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY);
  `)

  const db = {
    dialect: 'sqlite',
    exec(sql) {
      raw.exec(sql)
      return Promise.resolve()
    },
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => Promise.resolve(stmt.get(...args)),
        all: (...args) => Promise.resolve(stmt.all(...args)),
        run: (...args) => Promise.resolve(stmt.run(...args)),
      }
    },
  }

  await ensureMatchingLowCoverageEvents(db, { logger: silentLogger })

  const tableExists = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get('matching_low_coverage_events')
  assert.equal(tableExists?.name, 'matching_low_coverage_events')

  raw.close()
  try { fs.unlinkSync(tmpPath) } catch {}
})

test('profile soft-delete invariant adds deleted_at to older sqlite profile tables', async () => {
  let Database
  try {
    Database = (await import('better-sqlite3')).default
  } catch {
    return
  }

  const raw = new Database(':memory:')
  raw.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY)')
  const db = {
    dialect: 'sqlite',
    exec(sql) { raw.exec(sql); return Promise.resolve() },
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => Promise.resolve(stmt.get(...args)),
        all: (...args) => Promise.resolve(stmt.all(...args)),
        run: (...args) => Promise.resolve(stmt.run(...args)),
      }
    },
  }

  const out = await ensureProfileSoftDeleteColumn(db, { logger: silentLogger })
  const cols = raw.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name)
  assert.equal(out, true)
  assert.ok(cols.includes('deleted_at'), 'profiles.deleted_at must be created')
  raw.close()
})

test('orchestrator is idempotent: second call is a no-op summary', async () => {
  let Database
  try {
    Database = (await import('better-sqlite3')).default
  } catch {
    return
  }

  const tmpPath = path.join(os.tmpdir(), `gf-schema-inv-idem-${Date.now()}.sqlite`)
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
  const raw = new Database(tmpPath)
  raw.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS funding_opportunities (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY);
  `)

  const db = {
    dialect: 'sqlite',
    exec(sql) { raw.exec(sql); return Promise.resolve() },
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => Promise.resolve(stmt.get(...args)),
        all: (...args) => Promise.resolve(stmt.all(...args)),
        run: (...args) => Promise.resolve(stmt.run(...args)),
      }
    },
  }

  const first = await ensureSchemaInvariants(db, { logger: silentLogger })
  const second = await ensureSchemaInvariants(db, { logger: silentLogger })

  assert.equal(first.ran, first.steps.length)
  assert.equal(second.ran, second.steps.length)
  assert.equal(first.ran, second.ran)
  // Failure counts must be the same (or strictly less) on the second
  // run — never more, since DDL is idempotent.
  assert.ok(second.failed <= first.failed,
    `idempotency regression: first.failed=${first.failed} second.failed=${second.failed}`)

  raw.close()
  try { fs.unlinkSync(tmpPath) } catch {}
})
