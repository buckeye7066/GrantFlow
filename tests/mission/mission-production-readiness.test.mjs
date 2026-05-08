/**
 * Mission test suite — Phase I: production deployment checks.
 *
 * Mission rules:
 *   - NODE_ENV=production with SQLite must trip the release gate
 *     unless ALLOW_SQLITE_IN_PROD=true.
 *   - Persistent uploads storage must be configured in production.
 *   - URL_VERIFICATION_ENABLED must be on in production.
 *   - Pending migrations must trip the release gate.
 *   - Stale crawler_source_runs must trip the release gate.
 *   - Mission-health route must be reachable.
 *   - All checks aggregate into a single buildProductionReadinessReport
 *     payload that mission health embeds.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  buildProductionReadinessReport,
  checkSqliteInProduction,
  checkPersistentUploads,
  checkUrlVerificationEnabled,
  checkPendingMigrations,
  checkCrawlerFreshness,
  checkMissionHealthAvailability,
} from '../../backend/services/productionReadinessChecks.js'

import { buildMissionHealth } from '../../backend/services/missionHealthService.js'

// ── checkSqliteInProduction ─────────────────────────────────────────────
test('phase-i: SQLite in production with no override → error', () => {
  const r = checkSqliteInProduction({ env: { NODE_ENV: 'production' }, dbDialect: 'sqlite' })
  assert.equal(r.level, 'error')
  assert.equal(r.ok, false)
  assert.match(r.detail, /SQLite/i)
})

test('phase-i: SQLite in production with ALLOW_SQLITE_IN_PROD=true → warn but ok', () => {
  const r = checkSqliteInProduction({
    env: { NODE_ENV: 'production', ALLOW_SQLITE_IN_PROD: 'true' },
    dbDialect: 'sqlite',
  })
  assert.equal(r.level, 'warn')
  assert.equal(r.ok, true)
})

test('phase-i: Postgres in production → info', () => {
  const r = checkSqliteInProduction({ env: { NODE_ENV: 'production' }, dbDialect: 'postgres' })
  assert.equal(r.level, 'info')
  assert.equal(r.ok, true)
})

test('phase-i: dev environment → info regardless of dialect', () => {
  const r = checkSqliteInProduction({ env: { NODE_ENV: 'development' }, dbDialect: 'sqlite' })
  assert.equal(r.level, 'info')
})

// ── checkPersistentUploads ──────────────────────────────────────────────
test('phase-i: production + missing storageStatus → warn (cannot prove safety)', () => {
  const r = checkPersistentUploads({ env: { NODE_ENV: 'production' }, storageStatus: null })
  assert.equal(r.level, 'warn')
  assert.equal(r.ok, false)
})

test('phase-i: production + ephemeral upload override → warn', () => {
  const r = checkPersistentUploads({
    env: { NODE_ENV: 'production', ALLOW_EPHEMERAL_UPLOADS: 'true' },
    storageStatus: null,
  })
  assert.equal(r.level, 'warn')
  assert.equal(r.ok, true)
})

test('phase-i: production + non-persistent storage → error', () => {
  const r = checkPersistentUploads({
    env: { NODE_ENV: 'production' },
    storageStatus: { uploads_dir: '/tmp/uploads', likely_persistent: false, writable: true },
  })
  assert.equal(r.level, 'error')
  assert.equal(r.ok, false)
})

test('phase-i: production + persistent + writable → info', () => {
  const r = checkPersistentUploads({
    env: { NODE_ENV: 'production' },
    storageStatus: { uploads_dir: '/data/uploads', likely_persistent: true, writable: true },
  })
  assert.equal(r.level, 'info')
  assert.equal(r.ok, true)
})

// ── checkUrlVerificationEnabled ─────────────────────────────────────────
test('phase-i: production + URL_VERIFICATION_ENABLED=false (no skip flag) → error', () => {
  const r = checkUrlVerificationEnabled({
    env: { NODE_ENV: 'production', URL_VERIFICATION_ENABLED: 'false' },
  })
  assert.equal(r.level, 'error')
  assert.equal(r.ok, false)
})

test('phase-i: production + URL_VERIFICATION_ENABLED=false + GRANTFLOW_SKIP_VERIFICATION_GATE=true → warn (acknowledged)', () => {
  const r = checkUrlVerificationEnabled({
    env: { NODE_ENV: 'production', URL_VERIFICATION_ENABLED: 'false', GRANTFLOW_SKIP_VERIFICATION_GATE: 'true' },
  })
  assert.equal(r.level, 'warn')
  assert.equal(r.ok, true)
})

test('phase-i: production with verification on (default) → info', () => {
  const r = checkUrlVerificationEnabled({ env: { NODE_ENV: 'production', URL_VERIFICATION_ENABLED: 'true' } })
  assert.equal(r.level, 'info')
})

// ── checkPendingMigrations ──────────────────────────────────────────────
test('phase-i: empty pending migration list → info', () => {
  const r = checkPendingMigrations({ pendingMigrations: [] })
  assert.equal(r.level, 'info')
})

test('phase-i: ≥1 pending migration → error with names listed', () => {
  const r = checkPendingMigrations({ pendingMigrations: ['072_crawler_source_runs.sql', '073_index_x.sql'] })
  assert.equal(r.level, 'error')
  assert.match(r.detail, /072_crawler_source_runs/)
})

// ── checkCrawlerFreshness ───────────────────────────────────────────────
test('phase-i: missing ageHours → info in dev, warn in production', () => {
  const dev = checkCrawlerFreshness({ ageHours: null, maxAgeHours: 48, env: { NODE_ENV: 'development' } })
  assert.equal(dev.level, 'info')
  const prod = checkCrawlerFreshness({ ageHours: null, maxAgeHours: 48, env: { NODE_ENV: 'production' } })
  assert.equal(prod.level, 'warn')
})

test('phase-i: ageHours within window → info', () => {
  const r = checkCrawlerFreshness({ ageHours: 12, maxAgeHours: 48 })
  assert.equal(r.level, 'info')
})

test('phase-i: ageHours past window → warn', () => {
  const r = checkCrawlerFreshness({ ageHours: 100, maxAgeHours: 48 })
  assert.equal(r.level, 'warn')
})

// ── checkMissionHealthAvailability ──────────────────────────────────────
test('phase-i: missing mission health payload → error', () => {
  const r = checkMissionHealthAvailability(null)
  assert.equal(r.level, 'error')
})

test('phase-i: mission health with ok=true → info', () => {
  const r = checkMissionHealthAvailability({ ok: true })
  assert.equal(r.level, 'info')
})

test('phase-i: mission health with error field → error', () => {
  const r = checkMissionHealthAvailability({ ok: false, error: 'db_unavailable' })
  assert.equal(r.level, 'error')
})

// ── Aggregator ──────────────────────────────────────────────────────────
test('phase-i: buildProductionReadinessReport aggregates all checks', () => {
  const report = buildProductionReadinessReport({
    env: { NODE_ENV: 'production' },
    dbDialect: 'postgres',
    storageStatus: { uploads_dir: '/data', likely_persistent: true, writable: true },
    pendingMigrations: [],
    crawlerSourceRunsAgeHours: 5,
    crawlerSourceRunsMaxAgeHours: 48,
    missionHealth: { ok: true },
  })
  assert.equal(report.production_ready, true)
  assert.equal(report.safe_to_boot, true)
  assert.equal(report.error_count, 0)
  assert.equal(report.warning_count, 0)
  assert.ok(Array.isArray(report.checks) && report.checks.length === 6)
})

test('phase-i: buildProductionReadinessReport flips production_ready=false on any warning', () => {
  const report = buildProductionReadinessReport({
    env: { NODE_ENV: 'production', URL_VERIFICATION_ENABLED: 'true' },
    dbDialect: 'postgres',
    storageStatus: { uploads_dir: '/data', likely_persistent: true, writable: true },
    pendingMigrations: [],
    crawlerSourceRunsAgeHours: 100, // → warn (past 48h window)
    crawlerSourceRunsMaxAgeHours: 48,
    missionHealth: { ok: true },
  })
  assert.equal(report.production_ready, false)
  assert.equal(report.safe_to_boot, true) // warns don't block boot
  assert.ok(report.warning_count >= 1)
})

test('phase-i: buildProductionReadinessReport flips safe_to_boot=false on any error', () => {
  const report = buildProductionReadinessReport({
    env: { NODE_ENV: 'production', URL_VERIFICATION_ENABLED: 'false' },
    dbDialect: 'sqlite', // also produces an error
    storageStatus: null,
    pendingMigrations: ['072_x.sql'],
    crawlerSourceRunsAgeHours: 5,
    missionHealth: { ok: true },
  })
  assert.equal(report.safe_to_boot, false)
  assert.equal(report.production_ready, false)
  assert.ok(report.error_count >= 2)
})

// ── Integration: mission health embeds production_readiness + the
//                release gate trips on every readiness warn/error.
function createDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT,
      record_origin TEXT,
      opportunity_kind TEXT,
      link_status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE verification_events (id TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT, grant_name TEXT, status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        async get(...args) { return stmt.get(...args) },
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
  }
}

test('phase-i: mission health embeds production_readiness on the response', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.ok(h.production_readiness, 'mission health must embed production_readiness')
  assert.ok(Array.isArray(h.production_readiness.checks))
  assert.ok(h.production_readiness.checks.length === 6)
})
