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
      result_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      link_status TEXT,
      last_verified_at TIMESTAMP,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      verification_error TEXT,
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
  result_kind = 'direct',
  opportunity_type = 'grant',
  type = 'OPPORTUNITY',
  link_status = 'verified',
  last_verified_at = new Date().toISOString(),
  is_active = 1,
  is_hidden = 0,
  lifecycle_status = 'active',
  verification_error = null,
} = {}) {
  db.raw
    .prepare(
      `INSERT INTO funding_opportunities
        (id, title, source, record_origin, opportunity_kind, result_kind,
         opportunity_type, type, link_status, last_verified_at, is_active,
         is_hidden, status, verification_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      source,
      record_origin,
      kind,
      result_kind,
      opportunity_type,
      type,
      link_status,
      last_verified_at,
      is_active,
      is_hidden,
      lifecycle_status,
      verification_error,
    )
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

test('mission-health: canonical six-kind denominator is case-insensitive, trimmed, and explicit about legacy defaults', async () => {
  const db = createDb()
  const kinds = [' direct ', ' direct_grant ', 'Program', 'SCHOLARSHIP', ' in_kind ', 'benefit']
  for (const [index, kind] of kinds.entries()) {
    seedRow(db, { id: `kind-${index}`, kind })
  }
  seedRow(db, { id: 'legacy-null', kind: null })
  seedRow(db, { id: 'legacy-blank', kind: '   ' })
  seedRow(db, { id: 'pointer-kind', kind: 'DIRECTORY', result_kind: 'directory', type: 'DIRECTORY' })
  seedRow(db, { id: 'pointer-result', kind: null, result_kind: ' referral ' })
  seedRow(db, { id: 'pointer-type', kind: 'DIRECT', type: 'SCHOOL_PORTAL' })
  seedRow(db, { id: 'pointer-action', kind: 'DIRECT', result_kind: ' action_step ' })
  seedRow(db, { id: 'unknown-kind', kind: 'OTHER' })

  const h = await buildMissionHealth(db)

  assert.equal(h.link_lifecycle.denominator_total, 8)
  assert.equal(h.link_lifecycle.visible_total, 8)
  assert.equal(h.link_lifecycle.legacy_defaulted, 2)
  assert.equal(h.link_lifecycle.buckets.verified_visible, 8)
  assert.equal(h.link_lifecycle.partition_total, 8)
  assert.equal(h.link_lifecycle.partition_reconciles, true)
  assert.equal(h.counts.directory_opportunities_total, 4)
  assert.equal(h.rates.verified_fresh_visible_pct, 100)
})

test('mission-health: lifecycle buckets are mutually exclusive and reconcile to the denominator', async () => {
  const db = createDb()
  const staleVerifiedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
  seedRow(db, { id: 'verified-visible', kind: 'DIRECT', link_status: 'ok' })
  seedRow(db, { id: 'broken-visible', kind: 'DIRECT_GRANT', link_status: 'broken' })
  seedRow(db, {
    id: 'unverified-visible',
    kind: 'PROGRAM',
    link_status: 'verified',
    last_verified_at: staleVerifiedAt,
  })
  seedRow(db, {
    id: 'active-quarantine',
    kind: 'SCHOLARSHIP',
    link_status: 'broken',
    is_hidden: 1,
  })
  seedRow(db, {
    id: 'repair-pending',
    kind: 'IN_KIND',
    link_status: 'broken',
    is_hidden: 1,
    is_active: 0,
    lifecycle_status: 'paused',
  })
  seedRow(db, {
    id: 'scheduled-retry',
    kind: 'BENEFIT',
    link_status: 'skipped',
    is_hidden: 1,
    is_active: 0,
    lifecycle_status: 'paused',
    verification_error: 'retry_scheduled_after_bounded_recheck:attempts=2',
  })
  seedRow(db, {
    id: 'permanently-retired',
    kind: 'DIRECT',
    link_status: 'skipped',
    is_hidden: 1,
    is_active: 0,
    lifecycle_status: 'expired',
    verification_error: 'retired_after_definitive_recheck:permanent_http_gone',
  })
  seedRow(db, {
    id: 'other-nonvisible',
    kind: 'PROGRAM',
    link_status: 'ok',
    is_hidden: 1,
    lifecycle_status: 'quarantined',
  })

  const h = await buildMissionHealth(db)

  assert.deepEqual(h.link_lifecycle.buckets, {
    verified_visible: 1,
    broken_visible: 1,
    unverified_visible: 1,
    active_quarantine: 1,
    repair_pending: 1,
    scheduled_retry: 1,
    permanently_retired: 1,
    other_nonvisible: 1,
  })
  assert.equal(h.link_lifecycle.denominator_total, 8)
  assert.equal(h.link_lifecycle.partition_total, 8)
  assert.equal(h.link_lifecycle.partition_reconciles, true)
  assert.equal(h.counts.direct_opportunities_total, 3)
  assert.equal(h.counts.direct_opportunities_verified, 1)
  assert.equal(h.rates.verified_pct, 33.3)
  assert.equal('restored' in h.link_lifecycle, false)
})

test('mission-health: lifecycle snapshot failure blocks release instead of reporting a reconciled zero', async () => {
  const healthyDb = createDb()
  const db = {
    ...healthyDb,
    prepare(sql) {
      if (String(sql).includes('WITH lifecycle_rows AS')) {
        throw new Error('forced lifecycle snapshot failure')
      }
      return healthyDb.prepare(sql)
    },
  }

  const h = await buildMissionHealth(db)

  assert.equal(h.link_lifecycle.denominator_total, 0)
  assert.equal(h.link_lifecycle.partition_reconciles, false)
  assert.match(h.link_lifecycle.error, /forced lifecycle snapshot failure/)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some((blocker) => blocker.code === 'link_lifecycle_partition_mismatch'))
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
  assert.equal(MISSION_TARGETS.release_catalog_verified_pct_min, 95)
  assert.equal(MISSION_TARGETS.visible_direct_verified_pct_min, 100)
  assert.equal(MISSION_TARGETS.verified_max_age_days, 30)
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

test('mission-health: complete release catalog denominator includes pointer resources', async () => {
  const db = createDb()
  for (let i = 0; i < 18; i++) {
    seedRow(db, { id: `verified-direct-${i}`, kind: 'direct', link_status: 'verified' })
  }
  seedRow(db, { id: 'unverified-directory', kind: 'directory', link_status: 'unverified' })
  seedRow(db, { id: 'stale-referral', kind: 'referral', link_status: 'verified', last_verified_at: '2020-01-01T00:00:00Z' })

  const h = await buildMissionHealth(db)

  assert.equal(h.release_catalog.denominator_total, 20)
  assert.equal(h.release_catalog.verified_fresh, 18)
  assert.equal(h.release_catalog.unverified_or_stale, 2)
  assert.equal(h.release_catalog.visible_direct.total, 18)
  assert.equal(h.release_catalog.visible_direct.all_verified, true)
  assert.equal(h.release_catalog.visible_pointer.total, 2)
  assert.equal(h.rates.release_catalog_verified_pct, 90)
  assert.ok(h.release_blockers.some(
    (blocker) => blocker.code === 'release_catalog_verified_pct_below_target',
  ))
})

test('mission-health: every visible direct opportunity must be freshly verified', async () => {
  const db = createDb()
  for (let i = 0; i < 19; i++) {
    seedRow(db, { id: `verified-${i}`, kind: 'direct', link_status: 'verified' })
  }
  seedRow(db, { id: 'one-unverified-direct', kind: 'direct', link_status: 'unverified' })

  const h = await buildMissionHealth(db)

  assert.equal(h.rates.release_catalog_verified_pct, 95)
  assert.equal(h.release_catalog.visible_direct.verified_pct, 95)
  assert.equal(h.release_catalog.visible_direct.all_verified, false)
  assert.equal(
    h.release_blockers.some(
      (blocker) => blocker.code === 'release_catalog_verified_pct_below_target',
    ),
    false,
    '95% complete-catalog verification meets the catalog threshold',
  )
  assert.ok(h.release_blockers.some(
    (blocker) => blocker.code === 'visible_direct_link_requirement_failed',
  ))
})

test('mission-health: release-catalog snapshot failure blocks release', async () => {
  const healthyDb = createDb()
  const db = {
    ...healthyDb,
    prepare(sql) {
      if (String(sql).includes('WITH visible_catalog AS')) {
        throw new Error('forced release catalog snapshot failure')
      }
      return healthyDb.prepare(sql)
    },
  }

  const h = await buildMissionHealth(db)

  assert.match(h.release_catalog.error, /forced release catalog snapshot failure/)
  assert.equal(h.production_gate, false)
  assert.ok(h.release_blockers.some(
    (blocker) => blocker.code === 'release_catalog_snapshot_unavailable',
  ))
})
