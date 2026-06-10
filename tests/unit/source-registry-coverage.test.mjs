// RC-16 contract tests: every source in the registry must carry the
// operational metadata required by the coverage dashboard, and
// buildCoverageReport must surface those fields on each per-source entry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  SOURCES,
  SOURCE_IDS,
  listSources,
  planCoverage,
  buildCoverageReport,
  loadCrawlerSourceRuntimeStatus,
} from '../../backend/services/sourceRegistry.js'

const REQUIRED_FIELDS = [
  'base_url',
  'crawl_method',
  'rate_limit',
  'robots_note',
  'locations',
]

const VALID_CRAWL_METHODS = new Set([
  'api',
  'feed',
  'html_scrape',
  'directory_lookup',
  'manual_curated',
])

test('every source has the RC-16 operational metadata fields', () => {
  for (const src of listSources()) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(src, field),
        `source ${src.id} is missing field ${field}`,
      )
    }
    assert.ok(
      VALID_CRAWL_METHODS.has(src.crawl_method),
      `source ${src.id} has invalid crawl_method: ${src.crawl_method}`,
    )
    assert.ok(
      Array.isArray(src.locations),
      `source ${src.id} locations must be an array`,
    )
    assert.equal(typeof src.robots_note, 'string')
    if (src.rate_limit !== null) {
      assert.equal(typeof src.rate_limit.requests_per_minute, 'number')
      assert.equal(typeof src.rate_limit.requests_per_hour, 'number')
    }
  }
})

test('canonical federal sources have an explicit base_url', () => {
  const mustHaveBaseUrl = [
    SOURCE_IDS.GRANTS_GOV,
    SOURCE_IDS.SAM_GOV_ASSISTANCE_LISTINGS,
    SOURCE_IDS.FEMA_AFG,
    SOURCE_IDS.SBA_GRANTS,
    SOURCE_IDS.USDA_RURAL_DEV,
    SOURCE_IDS.UNITED_WAY_211,
    SOURCE_IDS.HRSA_HEALTH_CENTERS,
    SOURCE_IDS.SNAP,
    SOURCE_IDS.MEDICAID,
  ]
  for (const id of mustHaveBaseUrl) {
    const src = SOURCES[id]
    assert.ok(src, `expected source ${id} to exist`)
    assert.ok(
      typeof src.base_url === 'string' && src.base_url.startsWith('http'),
      `${id} must have an http(s) base_url, got ${src.base_url}`,
    )
  }
})

test('rate_limit is filled in from crawl_method defaults when not overridden', () => {
  const grantsGov = SOURCES[SOURCE_IDS.GRANTS_GOV]
  assert.equal(grantsGov.crawl_method, 'api')
  assert.equal(grantsGov.rate_limit.requests_per_minute, 60)

  const cof = SOURCES[SOURCE_IDS.COF_FOUNDATION_LOCATOR]
  assert.equal(cof.crawl_method, 'directory_lookup')
  assert.equal(cof.rate_limit.requests_per_minute, 10)
})

test('overpass uses the explicit, lower rate limit override', () => {
  const overpass = SOURCES[SOURCE_IDS.OVERPASS_LOCAL]
  assert.equal(overpass.rate_limit.requests_per_minute, 6)
  assert.equal(overpass.rate_limit.requests_per_hour, 100)
})

test('SOURCES is frozen — registry tampering is impossible at runtime', () => {
  assert.ok(Object.isFrozen(SOURCES))
  for (const src of listSources()) {
    assert.ok(Object.isFrozen(src), `source ${src.id} must be frozen`)
  }
})

test('buildCoverageReport surfaces operational metadata + runtime status per source', () => {
  const plan = planCoverage({ profile: { primary_type: 'individual' } })
  const outcomes = [
    {
      source_id: SOURCE_IDS.UNITED_WAY_211,
      queried: true,
      failed: false,
      found: 5,
      duration_ms: 412,
    },
    {
      source_id: SOURCE_IDS.COMMUNITY_ACTION,
      queried: true,
      failed: true,
      found: 0,
      error: 'HTTP 503',
    },
  ]
  const runtimeStatus = new Map([
    [SOURCE_IDS.UNITED_WAY_211, { last_crawl: '2026-05-28T12:00:00Z', failure_status: 'ok', last_error: null }],
    [SOURCE_IDS.COMMUNITY_ACTION, { last_crawl: '2026-05-28T12:00:00Z', failure_status: 'failed', last_error: 'HTTP 503' }],
  ])

  const report = buildCoverageReport(plan, outcomes, { runtimeStatus })

  assert.ok(Array.isArray(report.sources))
  assert.ok(report.sources.length >= 2, 'report.sources should include all planned + run sources')

  const unitedWay = report.sources.find((s) => s.source_id === SOURCE_IDS.UNITED_WAY_211)
  assert.ok(unitedWay, 'United Way 211 must appear in report.sources')
  assert.equal(unitedWay.queried, true)
  assert.equal(unitedWay.failed, false)
  assert.equal(unitedWay.found, 5)
  assert.equal(unitedWay.crawl_method, 'directory_lookup')
  assert.equal(typeof unitedWay.base_url, 'string')
  assert.ok(unitedWay.rate_limit, 'rate_limit must be present')
  assert.equal(unitedWay.last_crawl, '2026-05-28T12:00:00Z')
  assert.equal(unitedWay.failure_status, 'ok')

  const cap = report.sources.find((s) => s.source_id === SOURCE_IDS.COMMUNITY_ACTION)
  assert.ok(cap, 'Community Action must appear in report.sources')
  assert.equal(cap.failed, true)
  assert.equal(cap.failure_status, 'failed')
  assert.equal(cap.last_error, 'HTTP 503')
})

test('buildCoverageReport derives failure_status from outcomes when no DB runtime is provided', () => {
  const plan = planCoverage({ profile: { primary_type: 'individual' } })
  const outcomes = [
    { source_id: SOURCE_IDS.UNITED_WAY_211, queried: true, failed: false, found: 1 },
  ]
  const report = buildCoverageReport(plan, outcomes)
  const united = report.sources.find((s) => s.source_id === SOURCE_IDS.UNITED_WAY_211)
  assert.ok(united)
  assert.equal(united.failure_status, 'ok', 'queried+not-failed -> failure_status=ok')
  assert.equal(united.last_crawl, null, 'last_crawl null without DB runtime')
})

test('buildCoverageReport marks unqueried planned sources as never_run', () => {
  const plan = {
    profile_type: 'individual',
    needs: [],
    sources_planned: [SOURCE_IDS.SNAP, SOURCE_IDS.UNITED_WAY_211],
    sources_required: [SOURCE_IDS.SNAP],
    directory_sources: [SOURCE_IDS.UNITED_WAY_211],
    direct_sources: [SOURCE_IDS.SNAP],
    notes: [],
  }
  const report = buildCoverageReport(plan, [])
  const snap = report.sources.find((s) => s.source_id === SOURCE_IDS.SNAP)
  assert.ok(snap)
  assert.equal(snap.failure_status, 'never_run')
  assert.equal(snap.queried, false)
  assert.equal(snap.planned, true)
})

test('loadCrawlerSourceRuntimeStatus reads last_crawl and failure_status from crawler_source_runs', async () => {
  const db = new Database(':memory:')
  // Wrap better-sqlite3 in a thin shim that matches the registry helper's
  // expected prepare().all() shape.
  const wrapped = {
    prepare: (sql) => {
      const stmt = db.prepare(sql)
      return {
        all: (...args) => stmt.all(...args),
      }
    },
  }
  db.exec(`
    CREATE TABLE crawler_source_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crawler_run_id TEXT NOT NULL,
      profile_id TEXT,
      crawler_type TEXT,
      source_id TEXT NOT NULL,
      source_label TEXT,
      planned INTEGER NOT NULL DEFAULT 0,
      queried INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      found INTEGER NOT NULL DEFAULT 0,
      directory INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      error TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO crawler_source_runs
      (crawler_run_id, source_id, queried, failed, found, error, created_at)
    VALUES
      ('run-1', 'grants_gov', 1, 0, 12, NULL, '2026-05-28 10:00:00'),
      ('run-2', 'grants_gov', 1, 0, 14, NULL, '2026-05-28 12:00:00'),
      ('run-3', 'community_action', 1, 1, 0, 'HTTP 503', '2026-05-28 11:00:00');
  `)
  const status = await loadCrawlerSourceRuntimeStatus(wrapped)
  const grants = status.get('grants_gov')
  assert.ok(grants)
  assert.equal(grants.last_crawl, '2026-05-28 12:00:00')
  assert.equal(grants.failure_status, 'ok')
  const cap = status.get('community_action')
  assert.ok(cap)
  assert.equal(cap.failure_status, 'failed')
  assert.equal(cap.last_error, 'HTTP 503')
})

test('loadCrawlerSourceRuntimeStatus returns empty map when crawler_source_runs is missing', async () => {
  const db = new Database(':memory:')
  const wrapped = {
    prepare: (sql) => {
      const stmt = db.prepare(sql)
      return { all: (...args) => stmt.all(...args) }
    },
  }
  const status = await loadCrawlerSourceRuntimeStatus(wrapped)
  assert.ok(status instanceof Map)
  assert.equal(status.size, 0)
})
