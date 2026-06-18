/**
 * Service catalog — resilient load + dialect-safe listing.
 *
 * Regression for the Services-tab HTTP 500. The /catalog route used to run a
 * write-on-read seed (reads a markdown extract from disk + upserts) and any
 * failure 500'd the read. loadServiceCatalogResilient() now seeds best-effort
 * and degrades gracefully so the tab always renders.
 *
 * Also pins the dialect-safe boolean fix: listServiceCatalog with
 * includeInactive:false must not emit a bare `is_active = 1` that errors on
 * Postgres (it now uses an explicit per-dialect literal).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  ensureServiceCatalogSchema,
  listServiceCatalog,
  loadServiceCatalogResilient,
  seedServiceCatalogFromExtract,
} from '../../backend/services/serviceCatalogStore.js'

const silentLogger = { error: () => {} }

function makeDb() {
  return wrapSqlite(new Database(':memory:'))
}

test('listServiceCatalog is dialect-safe for includeInactive both true and false', async () => {
  const db = makeDb()
  await ensureServiceCatalogSchema(db)
  // Empty catalog both ways — must not throw on the boolean comparison.
  assert.deepEqual(await listServiceCatalog(db, { includeInactive: true }), [])
  assert.deepEqual(await listServiceCatalog(db, { includeInactive: false }), [])
})

test('resilient load returns the real catalog on the happy path', async () => {
  const db = makeDb()
  const result = await loadServiceCatalogResilient(db, { logger: silentLogger })
  assert.equal(result.degraded, false)
  assert.ok(Array.isArray(result.catalog), 'catalog is an array')
  // The disk extract seeds real services; if it loaded, we expect > 0.
  assert.ok(result.catalog.length > 0, 'seeded catalog has services')
})

test('a seed failure does NOT fail the read (best-effort seed)', async () => {
  // A db whose first write (seed) throws, but reads still work: list returns [].
  const realDb = makeDb()
  await ensureServiceCatalogSchema(realDb)
  let firstPrepareThrown = false
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      // Make any INSERT/UPDATE (seed path) blow up once, but allow SELECTs.
      if (/INSERT|UPDATE|ALTER|CREATE/i.test(sql) && !firstPrepareThrown) {
        firstPrepareThrown = true
        throw new Error('simulated seed write failure')
      }
      return realDb.prepare(sql)
    },
    exec: (sql) => realDb.exec(sql),
  }
  const result = await loadServiceCatalogResilient(db, { logger: silentLogger })
  // Seed failed, but listing the (empty) catalog still succeeds — no 500.
  assert.equal(result.degraded, false)
  assert.ok(Array.isArray(result.catalog))
})

test('seeding is throttled per-db: re-seed within TTL is skipped, force bypasses', async () => {
  const db = makeDb()
  const first = await seedServiceCatalogFromExtract(db)
  assert.notEqual(first.skipped, true, 'first seed actually runs')
  assert.ok(first.service_count > 0)

  const second = await seedServiceCatalogFromExtract(db)
  assert.equal(second.skipped, true, 'a second seed within the TTL is skipped (no disk read / upserts)')

  const forced = await seedServiceCatalogFromExtract(db, { force: true })
  assert.notEqual(forced.skipped, true, 'force re-seeds regardless of throttle')
})

test('a list failure degrades gracefully (degraded:true, empty catalog, no throw)', async () => {
  // A db that throws on every prepare → both seed and list fail. The loader
  // must still resolve with a soft degraded payload, never throw.
  const db = {
    dialect: 'sqlite',
    prepare() { throw new Error('db unavailable') },
    exec() { throw new Error('db unavailable') },
  }
  const result = await loadServiceCatalogResilient(db, { logger: silentLogger })
  assert.equal(result.degraded, true)
  assert.deepEqual(result.catalog, [])
  assert.match(result.error || '', /unavailable/)
})
