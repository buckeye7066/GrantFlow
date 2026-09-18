import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../services/matching/staleMatchExplainRefresh.js'
import { PROFILE_SIGNAL_VERSION } from '../config/profileSignalVersion.js'

const previousEnforce = process.env.ENFORCE_STALE_MATCH_EXPLAIN
const databases = []
beforeEach(() => { delete process.env.ENFORCE_STALE_MATCH_EXPLAIN })
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const db of databases.splice(0)) db.close()
  if (previousEnforce === undefined) delete process.env.ENFORCE_STALE_MATCH_EXPLAIN
  else process.env.ENFORCE_STALE_MATCH_EXPLAIN = previousEnforce
})

function fixture(count = 3) {
  const raw = new Database(':memory:')
  databases.push(raw)
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, is_active INTEGER,
      opportunity_kind TEXT, application_url TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score REAL, match_decision TEXT, match_explanation TEXT,
      match_explain_json TEXT, matcher_version TEXT, updated_at TEXT, evaluated_at TEXT
    );
    CREATE TABLE grants (id TEXT PRIMARY KEY, status TEXT, history TEXT);
    INSERT INTO grants VALUES ('protected-history', 'submitted', 'receipt-preserved');
  `)
  for (let i = 0; i < count; i += 1) {
    raw.prepare('INSERT INTO funding_opportunities VALUES (?, ?, 1, ?, ?)')
      .run(`o${i}`, 'Education award', 'SCHOLARSHIP', 'https://example-rcf.org/apply')
    raw.prepare('INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json, matcher_version) VALUES (?, ?, ?, 80, ?, ?, ?)')
      .run(`m${i}`, 'p1', `o${i}`, 'accept', JSON.stringify({ gate: 'attendance' }), 'institution-link')
  }
  const db = { dialect: 'sqlite', prepare: sql => raw.prepare(sql) }
  const deps = {
    loadProfileContext: async () => ({ profile: { id: 'p1' }, sections: {} }),
    thesisNeedsDefaulted: async () => false,
    computeMatchDecision: () => ({
      decision: 'ACCEPT', score: 81, explanation: 'fresh engine result',
      scoringPolicyVersion: 'need_first_v2', matcherVersion: 'test-engine',
      match_explain: { matchedSignals: [], matchedNeeds: [] },
    }),
  }
  const run = opts => runStaleMatchExplainRefresh(db, { pairBudget: 1, autoContinue: false, deps, ...opts })
  return { raw, db, deps, run }
}

describe('stale explanation batches prove completion instead of assuming it', () => {
  it('reports overflow beyond the SQL limit without exceeding the write budget', async () => {
    const f = fixture()
    const result = await f.run()
    expect(result).toMatchObject({ scanned: 1, refreshed: 1, truncated: true, stale_before: 3, remaining_stale: 2, complete: false })
    expect(f.raw.prepare('SELECT COUNT(*) AS n FROM funding_opportunities').get().n).toBe(3)
    expect(f.raw.prepare('SELECT * FROM grants').get()).toMatchObject({ status: 'submitted', history: 'receipt-preserved' })
  })

  it('exactly one final row proves zero residue without a false overflow flag', async () => {
    const f = fixture(1)
    expect(await f.run()).toMatchObject({ scanned: 1, refreshed: 1, truncated: false, remaining_stale: 0, complete: true })
    const row = f.raw.prepare('SELECT * FROM profile_opportunity_matches').get()
    expect(row.matcher_version).toBe('institution-link')
    expect(JSON.parse(row.match_explain_json).signal_version).toBe(PROFILE_SIGNAL_VERSION)
  })

  it('automatically finishes all batches through the same persisted writer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = await f.run({ autoContinue: true })
    expect(first.continuation_status).toBe('scheduled')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(60000)
    expect(vi.getTimerCount()).toBe(0)
    const rows = f.raw.prepare('SELECT * FROM profile_opportunity_matches').all()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.matcher_version).toBe('institution-link')
      expect(JSON.parse(row.match_explain_json).signal_version).toBe(PROFILE_SIGNAL_VERSION)
    }
    expect(await f.run()).toMatchObject({ remaining_stale: 0, scanned: 0, complete: true })
  })

  it('count-only mode leaves every stored match unchanged and creates no timers', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const before = f.raw.prepare('SELECT * FROM profile_opportunity_matches').all()
    expect(await f.run({ writeEnabled: false, autoContinue: true })).toMatchObject({ refreshed: 0, would_refresh: 1, complete: false, remaining_stale: 3 })
    expect(f.raw.prepare('SELECT * FROM profile_opportunity_matches').all()).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an unscorable first batch stops without inventing completion or rescheduling forever', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.deps.computeMatchDecision = () => { throw new Error('fixture engine failure') }
    expect(await f.run({ autoContinue: true })).toMatchObject({ refreshed: 0, unscorable: 1, remaining_stale: 3, complete: false, continuation_status: 'blocked_no_progress' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('verification query failure remains unknown, never zero', async () => {
    const f = fixture()
    let counts = 0
    const prepare = f.db.prepare
    f.db.prepare = sql => {
      if (sql.includes('COUNT(*)') && ++counts === 2) throw new Error('fixture recount failure')
      return prepare(sql)
    }
    expect(await f.run()).toMatchObject({ ok: false, complete: false, remaining_stale: null, skipped: 'verification_query', continuation_status: 'failed' })
  })

  it('a concurrent correction wins over the refresh snapshot', async () => {
    const f = fixture(1)
    const prepare = f.db.prepare
    f.db.prepare = sql => {
      if (sql.trim().startsWith('UPDATE profile_opportunity_matches')) {
        f.raw.prepare('UPDATE profile_opportunity_matches SET match_score=99 WHERE id=?').run('m0')
      }
      return prepare(sql)
    }
    expect(await f.run()).toMatchObject({ refreshed: 0, concurrent_changes_skipped: 1, remaining_stale: 1, complete: false })
    expect(f.raw.prepare('SELECT match_score FROM profile_opportunity_matches').get().match_score).toBe(99)
  })
})
