/**
 * The skipped-query CARRY-OVER on the nightly heal path, and the recall
 * scorecard snapshot the sweep records (result-quality PR4, 2026-09-17).
 *
 * Measured on prod: every real profile planned 28 web queries and executed 7,
 * skipping the SAME 21 every night because the plan is rebuilt identically.
 * A heal run that re-executes the seven queries that already failed to fill
 * the target learns nothing new. Proves, through the REAL sweep:
 *
 *   - the heal call carries a bounded slice of LAST run's budget-skipped
 *     queries as `extraQueries`, and records how many on `healed[]`
 *   - after a run whose extraction was dead, NOTHING is carried (those queries
 *     were never evaluated) and `extraQueries` is null
 *   - with no prior lane record the call is unchanged (null)
 *   - the sweep result carries a `recall_scorecard` block and persists the
 *     snapshot to system_kv
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

let runLiveMock = vi.fn(async () => ({ ok: true }))
vi.mock('../services/crawlerOsService.js', async (importOriginal) => {
  const actual = await importOriginal().catch(() => ({}))
  return { ...actual, runProfileDiscoveryLive: (...a) => runLiveMock(...a) }
})

const { runProfileCoverageSweep } = await import('../services/coverageAudit/profileResultCoverageAudit.js')
const { recordWebLaneRun } = await import('../services/coverageAudit/webLaneHealth.js')
const { CARRY_OVER_LIMIT, RECALL_SCORECARD_KV_KEY } = await import('../services/coverageAudit/recallScorecard.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER,
      match_decision TEXT, matcher_version TEXT, match_explain_json TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, categories TEXT,
      opportunity_kind TEXT, deadline TEXT, deadline_at TEXT, deadline_type TEXT, is_active INTEGER
    );
  `)
  return db
}

function seed(db, profileId, { awards = 0, locators = 0 } = {}) {
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) {
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?,?)').run(profileId, profileId)
  }
  let i = db.prepare('SELECT COUNT(*) c FROM profile_opportunity_matches WHERE profile_id = ?').get(profileId).c
  const put = (kind, decision) => {
    const oid = `${profileId}-o${i++}`
    db.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?,?,?,1)').run(oid, `${kind} ${i}`, kind)
    db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?)')
      .run(profileId, oid, 40, decision, 'crawler-os', decision === 'ACCEPT' ? verifiedFourTruthExplain() : null)
  }
  for (let k = 0; k < awards; k++) put('direct_grant', 'ACCEPT')
  for (let k = 0; k < locators; k++) put('directory', 'REVIEW')
}

const PLANNED = Array.from({ length: 28 }, (_, i) => `q${i + 1} tennessee student aid`)
function telemetry(over = {}) {
  return {
    ok: true,
    queries: PLANNED.slice(0, 7),
    queries_planned: PLANNED,
    query_ledger: { planned: PLANNED.map((q) => ({ query: q })), executed: PLANNED.slice(0, 7).map((q) => ({ query: q })), skipped_budget: PLANNED.slice(7).map((q) => ({ query: q })), skipped_duplicate: [] },
    stage_ledger: { query_generated: 28, query_skipped_budget: 21, provider_attempted: 7, candidates_extracted: 24, qualified_admitted: 0, apply_target_rejected: 9 },
    fetched: 44, extracted: 24, stored: 0,
    provider_health: { search: 'healthy', llm: 'healthy' },
    primary_attribution: 'apply_target_rejected',
    extraction_available: true,
    ...over,
  }
}

function liveResult() {
  return {
    run: { run_id: 'r', profile_id: 'p', planned: 1, stored: 0, rejected: 0, sources: [], zero_result: null },
    persisted: { opportunities: 0, matches: 0, sources: 0, rejected: 0, pipelinePruned: 0 },
    thesis: {},
    opportunities: [],
  }
}

beforeEach(() => { runLiveMock = vi.fn(async () => liveResult()) })

describe('heal-path skipped-query carry-over', () => {
  it(`carries the first ${CARRY_OVER_LIMIT} budget-skipped queries of the LAST run into the heal call`, async () => {
    const db = makeDb()
    try {
      seed(db, 'padded', { locators: 25 })
      await recordWebLaneRun(db, { profileId: 'padded', telemetry: telemetry(), trigger: 'nightly' })

      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      const call = runLiveMock.mock.calls[0][0]
      expect(call.profileId).toBe('padded')
      expect(call.trigger).toBe('heal')
      expect(call.extraQueries).toEqual(PLANNED.slice(7, 7 + CARRY_OVER_LIMIT))
      expect(res.healed[0]).toMatchObject({ profile_id: 'padded', carried_queries: CARRY_OVER_LIMIT })
    } finally { db.close() }
  })

  it('carries NOTHING after a run whose extraction was dead — extraQueries is null, carried_queries 0', async () => {
    const db = makeDb()
    try {
      seed(db, 'padded', { locators: 25 })
      await recordWebLaneRun(db, {
        profileId: 'padded',
        telemetry: telemetry({
          stage_ledger: { query_generated: 28, query_skipped_budget: 21, provider_attempted: 7, candidates_extracted: 0, extraction_failed: 31, extraction_failed_by_class: { llm_quota: 31 } },
          extracted: 0, provider_health: { search: 'healthy', llm: 'unavailable' },
          primary_attribution: 'extraction_failed:llm_quota', extraction_available: false,
        }),
      })
      const res = await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(runLiveMock.mock.calls[0][0].extraQueries).toBeNull()
      expect(res.healed[0].carried_queries).toBe(0)
    } finally { db.close() }
  })

  it('with no prior lane record the heal call is unchanged (null extraQueries)', async () => {
    const db = makeDb()
    try {
      seed(db, 'padded', { locators: 25 })
      await runProfileCoverageSweep(db, { autoheal: true, maxHeal: 1 })
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(runLiveMock.mock.calls[0][0].extraQueries).toBeNull()
    } finally { db.close() }
  })
})

describe('the sweep records a recall scorecard snapshot', () => {
  it('reports the fleet block on the result and persists it to system_kv', async () => {
    const db = makeDb()
    try {
      seed(db, 'padded', { locators: 25 })
      seed(db, 'served', { awards: 20 })
      await recordWebLaneRun(db, { profileId: 'padded', telemetry: telemetry() })
      const res = await runProfileCoverageSweep(db, { autoheal: false })
      expect(res.recall_scorecard).toMatchObject({ profiles_measured: 2, persisted: true })
      expect(res.recall_scorecard.totals).toMatchObject({ candidates_extracted: 24, qualified_admitted: 0 })
      expect(res.recall_scorecard.blockers).toMatchObject({ gated_at_apply_target: 1, met_target: 1 })
      const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(RECALL_SCORECARD_KV_KEY)
      expect(JSON.parse(row.value).profiles_measured).toBe(2)
    } finally { db.close() }
  })
})
