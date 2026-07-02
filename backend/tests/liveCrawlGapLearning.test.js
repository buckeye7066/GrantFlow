import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildGapLearningUpdate,
  classifyGaps,
  isCrawlerGapLearningEnabled,
  getCrawlerGapLearning,
  learnFromCrawlGaps,
  RECENT_CAP,
} from '../services/coverageAudit/liveCrawlGapLearning.js'

// ── Pure fold + classification (no I/O) ──────────────────────────────────────

describe('liveCrawlGapLearning — pure fold', () => {
  it('classifyGaps maps an audit to its gap-class keys (worst first)', () => {
    expect(classifyGaps({ low_results: true })).toEqual(['low_results'])
    expect(classifyGaps({ surfacing_gap: true, low_results: true }))
      .toEqual(['surfacing_regression', 'low_results'])
    expect(classifyGaps({ institution_gap: true, hyperlocal_gap: true }))
      .toEqual(['institution_gap', 'hyperlocal_gap'])
    expect(classifyGaps(null)).toEqual([])
    expect(classifyGaps({})).toEqual([])
  })

  it('counts every call but only records a recent entry + class tallies on a gap', () => {
    let store = buildGapLearningUpdate(null, { has_gap: false }, { profileId: 'p1', at: 't1' })
    expect(store.totals.calls).toBe(1)
    expect(store.totals.with_gap).toBe(0)
    expect(store.recent).toEqual([])

    store = buildGapLearningUpdate(store, { low_results: true, gaps: ['low_results:0'], surfaced_qualifying: 0, needs_rediscovery: true }, { profileId: 'p2', displayName: 'Kathy', at: 't2' })
    expect(store.totals.calls).toBe(2)
    expect(store.totals.with_gap).toBe(1)
    expect(store.totals.by_class.low_results).toBe(1)
    expect(store.recent).toHaveLength(1)
    expect(store.recent[0]).toMatchObject({ profile_id: 'p2', display_name: 'Kathy', classes: ['low_results'] })
    expect(store.updated_at).toBe('t2')
  })

  it('accumulates class tallies across calls and puts newest recent first', () => {
    let store = null
    store = buildGapLearningUpdate(store, { institution_gap: true }, { profileId: 'a', at: '1' })
    store = buildGapLearningUpdate(store, { institution_gap: true, low_results: true }, { profileId: 'b', at: '2' })
    expect(store.totals.calls).toBe(2)
    expect(store.totals.with_gap).toBe(2)
    expect(store.totals.by_class.institution_gap).toBe(2)
    expect(store.totals.by_class.low_results).toBe(1)
    expect(store.recent[0].profile_id).toBe('b') // newest first
  })

  it('caps the recent buffer at RECENT_CAP', () => {
    let store = null
    for (let i = 0; i < RECENT_CAP + 15; i++) {
      store = buildGapLearningUpdate(store, { low_results: true }, { profileId: `p${i}`, at: String(i) })
    }
    expect(store.recent).toHaveLength(RECENT_CAP)
    expect(store.totals.calls).toBe(RECENT_CAP + 15)
    expect(store.totals.with_gap).toBe(RECENT_CAP + 15)
  })
})

describe('liveCrawlGapLearning — enable gate', () => {
  const prev = process.env.CRAWLER_GAP_LEARNING_ENABLED
  afterEach(() => { process.env.CRAWLER_GAP_LEARNING_ENABLED = prev })

  it('is ON by default and OFF only when explicitly false', () => {
    delete process.env.CRAWLER_GAP_LEARNING_ENABLED
    expect(isCrawlerGapLearningEnabled()).toBe(true)
    process.env.CRAWLER_GAP_LEARNING_ENABLED = 'false'
    expect(isCrawlerGapLearningEnabled()).toBe(false)
    process.env.CRAWLER_GAP_LEARNING_ENABLED = 'true'
    expect(isCrawlerGapLearningEnabled()).toBe(true)
  })
})

// ── DB-backed end-to-end (real audit → store + Anya brain) ───────────────────

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT,
      status TEXT DEFAULT 'active', created_by TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      categories TEXT, opportunity_kind TEXT, is_active INTEGER DEFAULT 1,
      -- The #779 actionable-coverage audit selects deadline columns; the
      -- fixture must carry them or every learnFromCrawlGaps call fails with
      -- "no such column: o.deadline" (this test was merged while CI was red
      -- and never actually passed).
      deadline TEXT, deadline_at TEXT, deadline_type TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score REAL,
      match_decision TEXT, matcher_version TEXT
    );
    CREATE TABLE anya_brain_memory (
      id TEXT PRIMARY KEY, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','profile','user')),
      scope_id TEXT,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('fact','preference','context','learned_pattern')),
      memory_key TEXT NOT NULL, content TEXT NOT NULL DEFAULT '{}',
      confidence REAL DEFAULT 1.0, expires_at DATETIME, source TEXT DEFAULT 'system',
      access_count INTEGER DEFAULT 0, last_accessed_at DATETIME
    );
    CREATE UNIQUE INDEX idx_anya_brain_unique ON anya_brain_memory(scope, scope_id, memory_key);
    CREATE TABLE matching_low_coverage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT, search_terms TEXT,
      free_text TEXT, qualified_count INTEGER, min_score INTEGER,
      intent_label TEXT, branded_program TEXT, recorded_at TEXT
    );
  `)
  return db
}

const emptyThesis = { is_student: false, schools: [], location: {}, needs: [] }

describe('liveCrawlGapLearning — learnFromCrawlGaps (DB)', () => {
  let db
  beforeEach(() => { db = createDb(); process.env.CRAWLER_GAP_LEARNING_ENABLED = 'true' })
  afterEach(() => { db.close() })

  it('records a low_results gap into the store AND Anya brain', async () => {
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)")
      .run('kathy', 'Kathy Marie Daniel', 'system')
    // No matches → 0 qualifying < MIN_HEALTHY_SURFACED → low_results gap.

    const res = await learnFromCrawlGaps(db, { profileId: 'kathy', thesis: emptyThesis, displayName: 'Kathy Marie Daniel' })
    expect(res.ok).toBe(true)
    expect(res.has_gap).toBe(true)
    expect(res.classes).toContain('low_results')

    const store = await getCrawlerGapLearning(db)
    expect(store.totals.calls).toBe(1)
    expect(store.totals.with_gap).toBe(1)
    expect(store.totals.by_class.low_results).toBe(1)
    expect(store.recent[0]).toMatchObject({ profile_id: 'kathy', classes: ['low_results'] })

    // Anya learned it.
    const mem = db.prepare(
      "SELECT * FROM anya_brain_memory WHERE scope='profile' AND scope_id='kathy' AND memory_key='crawler_gap'",
    ).get()
    expect(mem).toBeTruthy()
    expect(mem.memory_type).toBe('learned_pattern')
    expect(mem.source).toBe('crawler_gap_learning')
    expect(JSON.parse(mem.content).classes).toContain('low_results')

    // Sam telemetry captured.
    const lc = db.prepare('SELECT COUNT(*) AS c FROM matching_low_coverage_events').get()
    expect(lc.c).toBe(1)
  })

  it('counts a healthy crawl (3 ACCEPTs) as a call with NO gap and NO brain write', async () => {
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)")
      .run('healthy', 'Healthy Profile', 'system')
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?, ?, 'GRANT', 1)")
        .run(`o${i}`, `Real Award ${i}`)
      db.prepare("INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES (?, ?, ?, 'accept', 'crawler-os')")
        .run('healthy', `o${i}`, 82)
    }

    const res = await learnFromCrawlGaps(db, { profileId: 'healthy', thesis: emptyThesis, displayName: 'Healthy Profile' })
    expect(res.ok).toBe(true)
    expect(res.has_gap).toBe(false)

    const store = await getCrawlerGapLearning(db)
    expect(store.totals.calls).toBe(1)
    expect(store.totals.with_gap).toBe(0)
    expect(store.recent).toEqual([])

    const mem = db.prepare("SELECT COUNT(*) AS c FROM anya_brain_memory WHERE scope_id='healthy'").get()
    expect(mem.c).toBe(0)
  })

  it('is a no-op when disabled by env, and returns null store', async () => {
    process.env.CRAWLER_GAP_LEARNING_ENABLED = 'false'
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)").run('x', 'X', 'system')
    const res = await learnFromCrawlGaps(db, { profileId: 'x', thesis: emptyThesis })
    expect(res.skipped).toBe(true)
    expect(await getCrawlerGapLearning(db)).toBeNull()
  })
})
