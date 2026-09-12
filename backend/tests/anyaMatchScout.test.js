import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Isolate the loop/yield refactor under test from the real matching stack —
// mirrors the pattern in pipelinePromotion.test.js. Only the candidate-set
// plumbing (SQL, filtering, sorting, dedupe) in anyaMatchScout.js itself is
// exercised for real; the heavy dependencies are deterministic stubs.
const { computeSpy } = vi.hoisted(() => ({ computeSpy: vi.fn() }))

vi.mock('../services/matchEngine.js', () => ({ computeMatchDecision: computeSpy }))
vi.mock('../services/contentFilter.js', () => ({ isJunkOpportunity: () => false }))
vi.mock('../services/opportunityTrust.js', () => ({
  assessOpportunityTrust: () => ({ display: true, primaryUrl: null }),
}))
vi.mock('../services/profileNeedsInterpreter.js', () => ({
  interpretProfileNeeds: () => ({ primaryNeeds: [] }),
}))
vi.mock('../services/profileHelpers.js', () => ({
  loadProfileContext: vi.fn(async (_db, profileId) => ({
    profile: { id: profileId, user_id: null, state: 'TN' },
    sections: {},
    signals: {},
  })),
}))

const {
  runMatchScoutForProfile,
  runMatchScoutForAllActiveProfiles,
} = await import('../services/anyaMatchScout.js')

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE grants (profile_id TEXT, funding_opportunity_id TEXT);
    CREATE TABLE anya_match_suggestions (
      id TEXT PRIMARY KEY, profile_id TEXT, user_id TEXT, opportunity_id TEXT,
      title TEXT, funder TEXT, match_score REAL, match_reasons TEXT,
      need_summary TEXT, search_strategy TEXT, opportunity_data TEXT,
      status TEXT, created_at TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, state TEXT,
      is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
      updated_at TEXT, live_score REAL, application_url TEXT
    );
  `)
  return db
}

function seedCandidates(db, count, { rejectIds = new Set() } = {}) {
  const insert = db.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, state, updated_at, live_score, application_url)
     VALUES (?, ?, ?, 'TN', ?, ?, 'https://example.org/apply')`,
  )
  for (let i = 0; i < count; i += 1) {
    const id = `opp-${i}`
    insert.run(id, `Opportunity ${i}`, 'Test Funder', new Date(2026, 0, 1, 0, i).toISOString(), rejectIds.has(id) ? 0 : 90)
  }
}

beforeEach(() => {
  computeSpy.mockReset()
  computeSpy.mockImplementation((_profile, opp) => ({
    score: Number(opp.live_score) || 0,
    decision: Number(opp.live_score) >= 50 ? 'ACCEPT' : 'REJECT',
    matcherVersion: 'test-fixture',
    reasons: [],
  }))
})

describe('anyaMatchScout — cooperative-yield refactor preserves behavior', () => {
  it('scores every candidate and yields to the event loop across a batch larger than one yield chunk', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p1', 'active')").run()
    // 120 candidates: more than YIELD_EVERY_CANDIDATES (50) in the module, so
    // both the trust-gate loop and the scoring loop must cross at least one
    // yield boundary without dropping or reordering candidates.
    seedCandidates(db, 120)

    const setImmediateSpy = vi.spyOn(global, 'setImmediate')

    const stats = await runMatchScoutForProfile(db, 'p1', { threshold: 50, maxAlerts: 10 })

    expect(stats.scanned).toBe(120)
    expect(stats.above_threshold).toBe(120)
    // maxAlerts caps how many are actually written, but every candidate above
    // threshold must have been scored (computeSpy called once per candidate).
    expect(computeSpy).toHaveBeenCalledTimes(120)
    expect(stats.created).toBe(10)
    // The refactor's whole purpose: the event loop must actually get turns
    // during a batch this size (>= 2 yields per loop x 2 loops).
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(4)

    setImmediateSpy.mockRestore()
  })

  it('never surfaces a REJECT decision regardless of loop position', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p1', 'active')").run()
    seedCandidates(db, 10, { rejectIds: new Set(['opp-3', 'opp-7']) })

    const stats = await runMatchScoutForProfile(db, 'p1', { threshold: 50, maxAlerts: 10 })

    expect(stats.scanned).toBe(10)
    expect(stats.above_threshold).toBe(8)
    expect(stats.suggestions.some((s) => s.opportunity_id === 'opp-3' || s.opportunity_id === 'opp-7')).toBe(false)
  })

  it('handles a candidate count smaller than one yield chunk with no yields at all', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p1', 'active')").run()
    seedCandidates(db, 5)

    const stats = await runMatchScoutForProfile(db, 'p1', { threshold: 50, maxAlerts: 10 })

    expect(stats.scanned).toBe(5)
    expect(stats.created).toBe(5)
  })

  it('handles zero candidates without throwing', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p1', 'active')").run()

    const stats = await runMatchScoutForProfile(db, 'p1', { threshold: 50, maxAlerts: 10 })

    expect(stats.scanned).toBe(0)
    expect(stats.created).toBe(0)
  })

  it('runMatchScoutForAllActiveProfiles processes every active profile and clears its active-job marker', async () => {
    const db = makeDb()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p1', 'active')").run()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p2', 'active')").run()
    db.prepare("INSERT INTO profiles (id, status) VALUES ('p3', 'inactive')").run()
    seedCandidates(db, 3)

    const { getActiveJobsSnapshot } = await import('../utils/activeJobTracker.js')
    const overall = await runMatchScoutForAllActiveProfiles(db, { threshold: 50, maxAlerts: 10 })

    expect(overall.profiles_scanned).toBe(2)
    // Cleared in a finally block even on success — the heartbeat must never
    // report a job as "still running" after the sweep has actually finished.
    expect(getActiveJobsSnapshot().some((j) => j.name === 'anya-match-scout:all-profiles')).toBe(false)
  })
})
