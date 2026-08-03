import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  buildGapLearningUpdate,
  classifyGaps,
  isCrawlerGapLearningEnabled,
  getCrawlerGapLearning,
  learnFromCrawlGaps,
  summarizeGapWindow,
  RECENT_CAP,
  WINDOW_RETENTION_DAYS,
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

// ── Windowed daily buckets (the decay the lifetime totals lack) ─────────────

describe('liveCrawlGapLearning — daily buckets + window summary', () => {
  const dayIso = (offsetDays, nowMs) => new Date(nowMs - offsetDays * 86400000).toISOString()
  const NOW = Date.parse('2026-07-05T12:00:00.000Z')

  it('buckets calls by UTC day and only real ISO timestamps', () => {
    let store = null
    store = buildGapLearningUpdate(store, { hyperlocal_gap: true }, { profileId: 'a', at: '2026-07-05T01:00:00Z' })
    store = buildGapLearningUpdate(store, { has_gap: false }, { profileId: 'b', at: '2026-07-05T02:00:00Z' })
    store = buildGapLearningUpdate(store, { low_results: true }, { profileId: 'c', at: 'not-a-date' })
    expect(store.days['2026-07-05']).toMatchObject({ calls: 2, with_gap: 1 })
    expect(store.days['2026-07-05'].by_class.hyperlocal_gap).toBe(1)
    expect(Object.keys(store.days)).toHaveLength(1) // bogus timestamp not bucketed
    expect(store.totals.calls).toBe(3) // …but still counted in lifetime totals
  })

  it('prunes daily buckets past WINDOW_RETENTION_DAYS', () => {
    let store = null
    for (let d = WINDOW_RETENTION_DAYS + 5; d >= 0; d--) {
      store = buildGapLearningUpdate(store, { hyperlocal_gap: true }, { profileId: 'p', at: dayIso(d, NOW) })
    }
    expect(Object.keys(store.days)).toHaveLength(WINDOW_RETENTION_DAYS)
    // Oldest keys are the ones dropped.
    expect(store.days[dayIso(WINDOW_RETENTION_DAYS + 5, NOW).slice(0, 10)]).toBeUndefined()
    expect(store.days[dayIso(0, NOW).slice(0, 10)]).toBeDefined()
  })

  it('summarizeGapWindow sums only the last N days and computes the rate', () => {
    let store = null
    // 10 days ago: 4 gappy calls (outside a 7-day window).
    for (let i = 0; i < 4; i++) {
      store = buildGapLearningUpdate(store, { hyperlocal_gap: true }, { profileId: 'old', at: dayIso(10, NOW) })
    }
    // Yesterday + today: 3 healthy, 1 gappy.
    store = buildGapLearningUpdate(store, { has_gap: false }, { profileId: 'h1', at: dayIso(1, NOW) })
    store = buildGapLearningUpdate(store, { has_gap: false }, { profileId: 'h2', at: dayIso(1, NOW) })
    store = buildGapLearningUpdate(store, { has_gap: false }, { profileId: 'h3', at: dayIso(0, NOW) })
    store = buildGapLearningUpdate(store, { institution_gap: true }, { profileId: 'g1', at: dayIso(0, NOW) })

    const win = summarizeGapWindow(store, { days: 7, nowMs: NOW })
    expect(win.calls).toBe(4)
    expect(win.with_gap).toBe(1)
    expect(win.rate).toBeCloseTo(0.25)
    expect(win.by_class.institution_gap).toBe(1)
    expect(win.by_class.hyperlocal_gap).toBeUndefined()
  })

  it('returns null for a pre-window store (no daily buckets) so callers fall back to lifetime', () => {
    expect(summarizeGapWindow(null)).toBeNull()
    expect(summarizeGapWindow({ totals: { calls: 100, with_gap: 60 } })).toBeNull()
    expect(summarizeGapWindow({ days: {} })).toBeNull()
  })
})

// ── Sam check judges the WINDOW, not lifetime totals ─────────────────────────

describe('Sam crawler.gapLearning — windowed rate', () => {
  it('stays green when lifetime totals are terrible but the recent window is healthy', async () => {
    const { getCheckById } = await import('../services/sam/samRegistry.js')
    const check = getCheckById('crawler.gapLearning')
    expect(check).toBeTruthy()

    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    const db = raw

    // Lifetime: 58% gappy (the July 2026 standing-red state). Window: healthy.
    const today = new Date().toISOString().slice(0, 10)
    const store = {
      totals: { calls: 477, with_gap: 277, by_class: { hyperlocal_gap: 277 } },
      days: { [today]: { calls: 10, with_gap: 1, by_class: { hyperlocal_gap: 1 } } },
      recent: [],
      updated_at: new Date().toISOString(),
    }
    raw.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run('crawler_gap_learning', JSON.stringify(store), store.updated_at)

    const res = await check.run({ db })
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('1/10')
    raw.close()
  })

  it('still alerts on a gappy recent window, and falls back to lifetime for pre-window stores', async () => {
    const { getCheckById } = await import('../services/sam/samRegistry.js')
    const check = getCheckById('crawler.gapLearning')

    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    const today = new Date().toISOString().slice(0, 10)

    // Gappy window → alert.
    const gappy = {
      totals: { calls: 20, with_gap: 12, by_class: { hyperlocal_gap: 12 } },
      days: { [today]: { calls: 12, with_gap: 10, by_class: { hyperlocal_gap: 10 } } },
      recent: [],
    }
    raw.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run('crawler_gap_learning', JSON.stringify(gappy), new Date().toISOString())
    let res = await check.run({ db: raw })
    expect(res.ok).toBe(false)
    expect(res.evidence.windowed).toBe(true)

    // Pre-window store (no days) → lifetime fallback still alerts.
    const preWindow = { totals: { calls: 100, with_gap: 60, by_class: { hyperlocal_gap: 60 } }, recent: [] }
    raw.prepare('UPDATE system_kv SET value = ? WHERE key = ?')
      .run(JSON.stringify(preWindow), 'crawler_gap_learning')
    res = await check.run({ db: raw })
    expect(res.ok).toBe(false)
    expect(res.evidence.windowed).toBe(false)
    expect(res.summary).toContain('lifetime')
    raw.close()
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
    // A profile with nothing is also below its requested result number, so the
    // per-profile RESULT FLOOR class rides alongside (owner rule 2026-08-01).
    expect(res.classes).toContain('result_floor_shortfall')

    const store = await getCrawlerGapLearning(db)
    expect(store.totals.calls).toBe(1)
    expect(store.totals.with_gap).toBe(1)
    expect(store.totals.by_class.low_results).toBe(1)
    expect(store.recent[0].profile_id).toBe('kathy')
    expect(store.recent[0].classes).toContain('low_results')

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

  // "Healthy" now means AT THE PROFILE'S REQUESTED RESULT NUMBER (default 20
  // since the 2026-08-03 recall audit; was 10),
  // counting only rows that name money the profile could actually receive.
  // Three real awards used to read as healthy because the old bar was
  // MIN_HEALTHY_SURFACED (3) on a count that also admitted directories.
  it('counts a healthy crawl (22 real awards) as a call with NO gap and NO brain write', async () => {
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)")
      .run('healthy', 'Healthy Profile', 'system')
    for (let i = 0; i < 22; i++) {
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

  it('a profile with only THREE real awards is now a gap — it is below its requested result number', async () => {
    // The old bar called this healthy. It is the same shape as prod's
    // "Josh Dasher / Caleb Hart / Tasha Reynolds" cohort: 39–103 stored matches,
    // 4 that name money. This test FAILS on the pre-floor classifier.
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)")
      .run('thin', 'Thin Profile', 'system')
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?, ?, 'GRANT', 1)")
        .run(`t${i}`, `Real Award ${i}`)
      db.prepare("INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES (?, ?, ?, 'accept', 'crawler-os')")
        .run('thin', `t${i}`, 82)
    }
    const res = await learnFromCrawlGaps(db, { profileId: 'thin', thesis: emptyThesis, displayName: 'Thin Profile' })
    expect(res.has_gap).toBe(true)
    expect(res.classes).toContain('result_floor_shortfall')
  })

  it('a profile padded with TWENTY-FIVE directories and zero awards is a gap — the Melissa Justus shape', async () => {
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)")
      .run('padded', 'Padded Profile', 'system')
    for (let i = 0; i < 25; i++) {
      db.prepare("INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?, ?, 'directory', 1)")
        .run(`d${i}`, `Local assistance directory ${i}`)
      db.prepare("INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES (?, ?, ?, 'review', 'crawler-os')")
        .run('padded', `d${i}`, 40)
    }
    const res = await learnFromCrawlGaps(db, { profileId: 'padded', thesis: emptyThesis, displayName: 'Padded Profile' })
    expect(res.has_gap).toBe(true)
    expect(res.classes).toContain('result_floor_shortfall')
    // …and the OLD alarm still reads it as healthy, which is the whole defect.
    expect(res.classes).not.toContain('surfacing_regression')
  })

  it('is a no-op when disabled by env, and returns null store', async () => {
    process.env.CRAWLER_GAP_LEARNING_ENABLED = 'false'
    db.prepare("INSERT INTO profiles (id, display_name, created_by) VALUES (?, ?, ?)").run('x', 'X', 'system')
    const res = await learnFromCrawlGaps(db, { profileId: 'x', thesis: emptyThesis })
    expect(res.skipped).toBe(true)
    expect(await getCrawlerGapLearning(db)).toBeNull()
  })
})
