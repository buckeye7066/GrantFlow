/**
 * Mission test suite — production health dashboard (Phase 10)
 *
 * Mission rule: production must have a real-time health view of the
 * mission metrics, and CI must fail when placeholder/synthetic rows are
 * present. This suite seeds a fixture DB, runs buildMissionHealth, and
 * asserts every metric and alert behaves correctly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const missionHealthModule = await import('../../backend/services/' + 'missionHealthService.js')
const {
  buildMissionHealth,
  MISSION_TARGETS,
  normalizeCount,
  pct,
} = missionHealthModule

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
      last_verified_at TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE verification_events (
      id TEXT PRIMARY KEY,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      user_id TEXT,
      grant_name TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return wrapDb(raw)
}

function wrapDb(raw) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        async get(...args) { return stmt.get(...args) },
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
    raw,
  }
}

function seedRow(db, {
  id,
  title = 'Test',
  source = 'grants.gov',
  record_origin = 'live_crawl',
  kind = 'direct',
  link_status = 'verified',
  last_verified_at = new Date().toISOString(),
  is_active = 1,
  is_hidden = 0,
} = {}) {
  db.raw
    .prepare(
      `INSERT INTO funding_opportunities
        (id, title, source, record_origin, opportunity_kind, link_status,
         last_verified_at, is_active, is_hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, source, record_origin, kind, link_status, last_verified_at, is_active, is_hidden)
}

test('mission-health: empty DB returns ok=true and zero counts', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.ok, true)
  assert.equal(h.counts.direct_opportunities_total, 0)
  assert.equal(h.counts.placeholder_opportunities, 0)
  assert.equal(h.alerts.length, 0)
  assert.ok(h.matcher_version)
  assert.ok(h.targets)
})

test('mission-health: 100% verified direct opps → no warn alerts', async () => {
  const db = createDb()
  for (let i = 0; i < 5; i++) seedRow(db, { id: `v-${i}`, kind: 'direct', link_status: 'verified' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.direct_opportunities_total, 5)
  assert.equal(h.counts.direct_opportunities_verified, 5)
  assert.equal(h.rates.verified_pct, 100)
  assert.equal(h.alerts.length, 0)
  assert.equal(h.ok, true)
})

test('mission-health: low verified % triggers a warn alert', async () => {
  const db = createDb()
  // 1 verified out of 10 = 10% → far below the 95% target
  seedRow(db, { id: 'v-1', kind: 'direct', link_status: 'verified' })
  for (let i = 0; i < 9; i++) seedRow(db, { id: `u-${i}`, kind: 'direct', link_status: 'unverified' })
  const h = await buildMissionHealth(db)
  assert.equal(h.rates.verified_pct, 10)
  assert.ok(h.alerts.find((a) => a.code === 'verified_pct_below_target'))
  assert.equal(h.ok, true, 'warn-only alerts must NOT make ok=false')
})

test('mission-health: high broken-link % triggers a warn alert', async () => {
  const db = createDb()
  seedRow(db, { id: 'v-1', kind: 'direct', link_status: 'verified' })
  for (let i = 0; i < 4; i++) seedRow(db, { id: `b-${i}`, kind: 'direct', link_status: 'broken' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.direct_opportunities_broken, 4)
  assert.ok(h.alerts.find((a) => a.code === 'broken_pct_above_target'))
})

test('mission-health: placeholder/synthetic rows trigger an ERROR alert (mission rule: must be 0)', async () => {
  const db = createDb()
  seedRow(db, { id: 'p-1', source: 'synthetic', record_origin: 'synthetic', kind: 'direct' })
  seedRow(db, { id: 'p-2', title: 'placeholder grant', source: 'something', record_origin: 'live_crawl', kind: 'direct' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.placeholder_opportunities, 2)
  const errAlert = h.alerts.find((a) => a.code === 'placeholder_opportunities_present')
  assert.ok(errAlert)
  assert.equal(errAlert.level, 'error')
  assert.equal(h.ok, false, 'error alerts must flip ok to false (mission rule: CI fails)')
})

test('mission-health: directory opportunities counted separately', async () => {
  const db = createDb()
  seedRow(db, { id: 'dir-1', kind: 'directory', link_status: 'verified' })
  seedRow(db, { id: 'ref-1', kind: 'referral', link_status: 'verified' })
  seedRow(db, { id: 'sp-1', kind: 'school_portal', link_status: 'verified' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.directory_opportunities_total, 3)
  // Directories are not counted as direct opps
  assert.equal(h.counts.direct_opportunities_total, 0)
})

test('mission-health: coverage_by_source surfaces grouped counts', async () => {
  const db = createDb()
  for (let i = 0; i < 3; i++) seedRow(db, { id: `g-${i}`, source: 'grants.gov' })
  for (let i = 0; i < 2; i++) seedRow(db, { id: `f-${i}`, source: 'fema_afg' })
  const h = await buildMissionHealth(db)
  assert.ok(Array.isArray(h.coverage_by_source))
  const grants = h.coverage_by_source.find((s) => s.source === 'grants.gov')
  const fema = h.coverage_by_source.find((s) => s.source === 'fema_afg')
  assert.equal(grants.n, 3)
  assert.equal(fema.n, 2)
})

test('mission-health: application_funnel surfaces status counts', async () => {
  const db = createDb()
  db.raw.prepare(`INSERT INTO grant_applications (id, profile_id, user_id, grant_name, status) VALUES (?, ?, ?, ?, ?)`)
    .run('a1', 'p', 'u', 'g', 'discovered')
  db.raw.prepare(`INSERT INTO grant_applications (id, profile_id, user_id, grant_name, status) VALUES (?, ?, ?, ?, ?)`)
    .run('a2', 'p', 'u', 'g', 'submitted')
  db.raw.prepare(`INSERT INTO grant_applications (id, profile_id, user_id, grant_name, status) VALUES (?, ?, ?, ?, ?)`)
    .run('a3', 'p', 'u', 'g', 'submitted')
  const h = await buildMissionHealth(db)
  const submitted = h.application_funnel.find((f) => f.status === 'submitted')
  assert.equal(submitted.n, 2)
})

test('mission-health: verification_events_24h uses the canonical ts column', async () => {
  const db = createDb()
  const recent = new Date().toISOString()
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  db.raw.prepare('INSERT INTO verification_events (id, ts) VALUES (?, ?)').run('recent', recent)
  db.raw.prepare('INSERT INTO verification_events (id, ts) VALUES (?, ?)').run('old', old)

  const h = await buildMissionHealth(db)

  assert.equal(h.counts.verification_events_24h, 1)
})

test('mission-health: targets export matches the production minimums', () => {
  assert.equal(MISSION_TARGETS.verified_pct_min, 95)
  assert.equal(MISSION_TARGETS.broken_pct_max, 5)
  assert.equal(MISSION_TARGETS.placeholder_max, 0)
})

test('mission-health: missing db is handled safely without throwing', async () => {
  const h = await buildMissionHealth(null)
  assert.equal(h.ok, false)
  assert.ok(h.error)
})

// ── Phase F — strict production release gate ────────────────────────────
test('mission-health: empty DB has production_gate=true and release_blockers=[]', async () => {
  const db = createDb()
  const h = await buildMissionHealth(db)
  assert.equal(h.production_gate, true, 'empty/clean DB must clear the release gate')
  assert.deepEqual(h.release_blockers, [])
})

test('mission-health: placeholder rows trip the production gate (release_blockers includes placeholder code)', async () => {
  const db = createDb()
  seedRow(db, { id: 'p-1', source: 'synthetic', record_origin: 'synthetic', kind: 'direct' })
  const h = await buildMissionHealth(db)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((b) => b.code === 'placeholder_opportunities_present'))
})

test('mission-health: low verified % trips the production gate even though ok stays true', async () => {
  const db = createDb()
  // 1 verified out of 10 = 10%
  seedRow(db, { id: 'v-1', kind: 'direct', link_status: 'verified' })
  for (let i = 0; i < 9; i++) seedRow(db, { id: `u-${i}`, kind: 'direct', link_status: 'unverified' })
  const h = await buildMissionHealth(db)
  // ok stays true because verified_pct_below_target is a warn alert. The
  // production gate is strict and refuses the deploy.
  assert.equal(h.ok, true, 'live API must not 503 on a slow-degrading signal')
  assert.equal(h.production_gate, false, 'release gate must refuse deploy when verified % < 95')
  assert.ok(h.release_blockers.some((b) => b.code === 'verified_pct_below_target'))
})

test('mission-health: high broken-link % trips the production gate', async () => {
  const db = createDb()
  seedRow(db, { id: 'v-1', kind: 'direct', link_status: 'verified' })
  for (let i = 0; i < 4; i++) seedRow(db, { id: `b-${i}`, kind: 'direct', link_status: 'broken' })
  const h = await buildMissionHealth(db)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((b) => b.code === 'broken_pct_above_target'))
})

test('mission-health: PostgreSQL-shaped string counts produce real percentages', () => {
  assert.equal(normalizeCount('5678'), 5678)
  assert.equal(pct('652', '5678'), 11.5)
})

test('mission-health: canonical verifier statuses count as verified', async () => {
  const db = createDb()
  seedRow(db, { id: 'ok-1', link_status: 'ok' })
  seedRow(db, { id: 'redirect-1', link_status: 'redirect' })
  seedRow(db, { id: 'legacy-1', link_status: 'verified' })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.direct_opportunities_verified, 3)
  assert.equal(h.rates.verified_pct, 100)
})

test('mission-health: quarantined broken rows do not poison visible rates', async () => {
  const db = createDb()
  seedRow(db, { id: 'ok-1', link_status: 'ok' })
  seedRow(db, { id: 'hidden', link_status: 'broken', is_hidden: 1 })
  seedRow(db, { id: 'inactive', link_status: 'broken', is_active: 0 })
  const h = await buildMissionHealth(db)
  assert.equal(h.counts.catalog_direct_opportunities_total, 3)
  assert.equal(h.counts.direct_opportunities_total, 1)
  assert.equal(h.counts.quarantined_broken_direct_opportunities, 2)
  assert.equal(h.rates.verified_pct, 100)
  assert.equal(h.rates.broken_pct, 0)
})

test('mission-health: TARGETS exposes the release-gate code list', () => {
  assert.ok(Array.isArray(MISSION_TARGETS.release_blocking_codes))
  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('placeholder_opportunities_present'))
  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('pii_external_query_violation'))
  assert.ok(MISSION_TARGETS.release_blocking_codes.includes('crawler_source_outcomes_stale'))
  assert.equal(typeof MISSION_TARGETS.crawler_source_runs_max_age_hours, 'number')
})
