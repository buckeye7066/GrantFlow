/**
 * Regression test for the dialect divergence class (the ingestionService/#946
 * shape): POST /api/services/purchases used to build its purchase + milestone
 * writes with `req.db.transaction(fn)()` and call it WITHOUT awaiting.
 * better-sqlite3's `db.transaction(fn)` is synchronous, so it happened to work
 * locally/in CI (SQLite). The Postgres shim's `db.transaction(fn)` returns an
 * async function and its `.prepare().run()` is itself async, so under
 * PRODUCTION the write was fire-and-forget: the route could respond 201 with
 * a purchase id before the INSERTs ever executed, and an error inside the
 * transaction became an unhandled rejection.
 *
 * This test drives the real route through a db double whose run/get/all
 * resolve on a real microtask delay and whose withTransaction uses genuine
 * BEGIN/COMMIT, so an un-awaited write is observable: the row would not exist
 * yet immediately after the awaited HTTP response.
 */
import { describe, expect, it, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'

import servicesRouter from '../routes/services.js'
import { ensureServiceCatalogSchema } from '../services/serviceCatalogStore.js'

function delay() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * A SQLite-backed db handle whose statement methods are genuinely async
 * (unlike better-sqlite3's native sync API) so a caller that forgets to
 * await a write is provably racing it, the same way the Postgres shim's
 * async prepare()/transaction() would.
 *
 * dialect stays 'sqlite' so ensureServiceCatalogSchema emits plain SQLite
 * DDL (Postgres-only DDL like now()/BOOLEAN/TIMESTAMPTZ needs the real
 * driver, not this simulator). The bug under test is orthogonal to dialect
 * labeling -- it is about run/get/all/transaction() being ASYNC, which is
 * what the shim actually does for Postgres in prod.
 */
function makeAsyncSemanticsDb() {
  const sqlite = new Database(':memory:')

  const makeHandle = () => ({
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = sqlite.prepare(sql)
      return {
        get: async (...args) => { await delay(); return stmt.get(...args) },
        all: async (...args) => { await delay(); return stmt.all(...args) },
        run: async (...args) => { await delay(); return stmt.run(...args) },
      }
    },
    async exec(sql) { await delay(); return sqlite.exec(sql) },
    transaction(fn) {
      // Mirrors backend/db/index.js PostgresDb.transaction(): returns an
      // async function; the callback is invoked WITHOUT an injected tx
      // (closes over the outer db), matching the pre-fix call sites this
      // test exists to catch if they regress.
      return async (...args) => this.withTransaction(() => fn(...args))
    },
  })

  const handle = makeHandle()

  return {
    ...handle,
    _sqlite: sqlite,
    async withTransaction(fn) {
      sqlite.exec('BEGIN')
      try {
        const result = await fn(makeHandle())
        await delay()
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        try { sqlite.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      }
    },
    close() { sqlite.close() },
  }
}

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { userId: 'test-user' }
    req.ctx = { userId: 'test-user' }
    req.db = db
    next()
  })
  app.use('/api/services', servicesRouter)
  app.use((err, _req, res, _next) => {
    res.status(500).json({ ok: false, error: err?.message || String(err) })
  })
  return app
}

let openDb = null
afterEach(() => {
  if (openDb) { openDb.close(); openDb = null }
})

describe('POST /api/services/purchases -- async db write completion', () => {
  it('writes the purchase and every milestone row before responding (Postgres-async semantics)', async () => {
    const db = makeAsyncSemanticsDb()
    openDb = db
    db._sqlite.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT)')
    await ensureServiceCatalogSchema(db)

    db._sqlite.prepare(
      "INSERT INTO service_catalog_items (id, slug, name, pricing_model, is_active) VALUES ('svc-1', 'grant-writing', 'Grant Writing', 'milestone', 1)"
    ).run()
    for (const phase of ['kickoff', 'draft', 'submission']) {
      db._sqlite.prepare(
        "INSERT INTO service_prices (id, service_id, client_category, milestone_phase, amount_cents, active) VALUES (?, 'svc-1', 'individual', ?, 10000, 1)"
      ).run(`price-${phase}`, phase)
    }

    const app = createApp(db)
    const response = await request(app)
      .post('/api/services/purchases')
      .send({ service_slug: 'grant-writing', client_category: 'individual' })

    expect(response.status).toBe(201)
    expect(response.body.ok).toBe(true)
    const purchaseId = response.body.purchase.id
    expect(purchaseId).toBeTruthy()

    // If the transaction were fire-and-forget (the pre-fix bug), these rows
    // could still be missing at this point even though the HTTP response
    // already came back with a 201 and a purchase id.
    const purchaseRow = db._sqlite.prepare('SELECT * FROM service_purchases WHERE id = ?').get(purchaseId)
    expect(purchaseRow).toBeTruthy()
    expect(purchaseRow.status).toBe('draft')

    const milestoneRows = db._sqlite.prepare('SELECT phase FROM milestone_payments WHERE purchase_id = ? ORDER BY phase').all(purchaseId)
    expect(milestoneRows.map((r) => r.phase)).toEqual(['draft', 'kickoff', 'submission'])
  })
})