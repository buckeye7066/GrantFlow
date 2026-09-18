import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../services/matching/staleMatchExplainRefresh.js'
import { enforceStaleMatchExplainRefresh } from '../startup/enforceInvariants.js'
import { getCheckById } from '../services/sam/samRegistry.js'

const opened = []
afterEach(() => { for (const db of opened.splice(0)) db.close() })
const KEY = 'stale_match_explain_last_run'
function fixture(count = 3) {
  const raw = new Database(':memory:'); opened.push(raw)
  raw.exec(`
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, is_active INTEGER);
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, matcher_version TEXT,
      match_explain_json TEXT, match_decision TEXT, match_score INTEGER,
      match_explanation TEXT, updated_at TEXT, evaluated_at TEXT
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `)
  for (let index = 0; index < count; index += 1) {
    const id = String(index).padStart(4, '0')
    raw.prepare('INSERT INTO funding_opportunities VALUES (?, ?, 1)').run(id, 'Education award')
    raw.prepare("INSERT INTO profile_opportunity_matches VALUES (?, 'profile', ?, 'institution-link', '{}', 'accept', 80, '', NULL, NULL)").run(id, id)
  }
  const db = { dialect: 'sqlite', prepare: sql => raw.prepare(sql) }
  const deps = {
    loadProfileContext: async () => ({ profile: { id: 'profile' }, sections: {} }),
    thesisNeedsDefaulted: async () => false,
    computeMatchDecision: () => ({ decision: 'accept', score: 80, scoringPolicyVersion: 'need_first_test',
      scoreScaleId: 'data_point_test', matcherVersion: 'test',
      match_explain: { matchedSignals: [], matchedNeeds: [], scoring_policy_version: 'need_first_test' } }),
  }
  const stored = () => { const row = raw.prepare('SELECT value FROM system_kv WHERE key = ?').get(KEY); return row ? JSON.parse(row.value) : null }
  const store = (key, value) => raw.prepare('INSERT OR REPLACE INTO system_kv VALUES (?, ?, ?)').run(key, JSON.stringify(value), new Date().toISOString())
  return { db, raw, deps, stored, store }
}
function completeReceipt(overrides = {}) {
  const at = new Date().toISOString()
  return { name: 'stale_match_explain_refresh', at, started_at: at, completed_at: at,
    ok: true, complete: true, status: 'complete', remaining_candidates: 0, remaining_stale: 0,
    verification_failed: false, verification_truncated: false, repaired: 3, scanned: 3, ...overrides }
}
function seedBoot(store, age = 3600000, extra = {}) {
  const boot = { at: new Date(Date.now() - age).toISOString(), ran: 70, totalRepaired: 4,
    steps: [{ name: 'other_step', ok: true, repaired: 4 },
      { name: 'stale_match_explain_refresh', ok: true, repaired: 2, status: 'pending', complete: false }], ...extra }
  store('enforce_invariants_last_run', boot)
  return boot
}

describe('recurring stored-match continuation', () => {
  it('uses caller budgets, persists pending then exact completion, and preserves catalog rows', async () => {
    const { db, raw, deps, stored } = fixture()
    const first = await enforceStaleMatchExplainRefresh(db, { pairBudget: 2, deps, persistReceipt: true })
    expect(first).toMatchObject({ repaired: 2, remaining_candidates: 1, status: 'pending', complete: false })
    expect(stored()).toMatchObject({ repaired: 2, remaining_candidates: 1, remaining_stale: null, status: 'pending', complete: false })
    const second = await enforceStaleMatchExplainRefresh(db, { pairBudget: 2, deps, persistReceipt: true })
    expect(second).toMatchObject({ repaired: 1, remaining_candidates: 0, remaining_stale: 0, complete: true })
    expect(stored()).toMatchObject({ status: 'complete', complete: true, remaining_stale: 0 })
    expect(raw.prepare('SELECT COUNT(*) n FROM funding_opportunities').get().n).toBe(3)
  })
  it('a pre-cancelled lease performs no database access', async () => {
    const controller = new AbortController(); controller.abort(new Error('lease lost'))
    let calls = 0
    await expect(runStaleMatchExplainRefresh({ prepare() { calls++; throw Error('unexpected access') } },
      { signal: controller.signal, deps: { computeMatchDecision() {}, loadProfileContext: async () => null } })).rejects.toThrow('lease lost')
    expect(calls).toBe(0)
  })
  it('cancellation during profile loading prevents a new write and leaves an honest running receipt', async () => {
    const { db, raw, deps, stored } = fixture(1)
    const controller = new AbortController()
    deps.loadProfileContext = async () => { controller.abort(new Error('lease lost')); return { profile: { id: 'profile' }, sections: {} } }
    await expect(enforceStaleMatchExplainRefresh(db, { signal: controller.signal, deps, persistReceipt: true })).rejects.toThrow('lease lost')
    expect(raw.prepare('SELECT match_explain_json FROM profile_opportunity_matches').get().match_explain_json).toBe('{}')
    expect(stored()).toMatchObject({ status: 'running', complete: false, completed_at: null })
  })
  it('stops before subsequent writes when the lease is lost after an in-flight write', async () => {
    const { raw, deps } = fixture(3); const controller = new AbortController(); let writes = 0
    const db = { dialect: 'sqlite', prepare(sql) {
      const statement = raw.prepare(sql)
      if (!sql.includes('UPDATE profile_opportunity_matches')) return statement
      return { run(...args) { const result = statement.run(...args); writes++; controller.abort(new Error('lease lost')); return result } }
    } }
    await expect(runStaleMatchExplainRefresh(db, { deps, signal: controller.signal })).rejects.toThrow('lease lost')
    expect(writes).toBe(1)
  })
  it('records disabled work as disabled, not complete', async () => {
    const { db, deps, stored } = fixture(1)
    await enforceStaleMatchExplainRefresh(db, { deps, persistReceipt: true, writeEnabled: false })
    expect(stored()).toMatchObject({ status: 'disabled', complete: false, repaired: 0, wouldRepair: 1 })
  })
  it('records a query failure rather than retaining a prior green receipt', async () => {
    const { raw, deps, stored, store } = fixture(1)
    store(KEY, completeReceipt())
    const db = { dialect: 'sqlite', prepare(sql) { if (sql.includes('m.id AS match_id')) throw Error('private detail must not enter receipt'); return raw.prepare(sql) } }
    const result = await enforceStaleMatchExplainRefresh(db, { deps, persistReceipt: true })
    expect(result.ok).toBe(false)
    expect(stored()).toMatchObject({ status: 'failed', complete: false })
    expect(JSON.stringify(stored())).not.toContain('private detail')
  })
  it('refuses to overwrite a newer receipt', async () => {
    const { db, deps, store, stored } = fixture(1)
    deps.loadProfileContext = async () => { store(KEY, completeReceipt({ run_id: 'newer-owner' })); return { profile: { id: 'profile' }, sections: {} } }
    await expect(enforceStaleMatchExplainRefresh(db, { deps, persistReceipt: true })).rejects.toThrow(/superseded/i)
    expect(stored().run_id).toBe('newer-owner')
  })
})

describe('Sam consumes current recurring evidence without rewriting boot history', () => {
  it.each(['pending', 'running', 'disabled', 'failed'])('does not claim a healthy sweep for %s recurring evidence', async status => {
    const { db, raw, store } = fixture(0); const boot = seedBoot(store)
    store(KEY, completeReceipt({ status, complete: false, remaining_stale: null, remaining_candidates: 4 }))
    const result = await getCheckById('pipeline.invariantSweepOutcomes').run({ db })
    expect(result.ok).toBe(false)
    expect(result.evidence.failed).toContainEqual(expect.objectContaining({ name: 'stale_match_explain_refresh', status }))
    expect(JSON.parse(raw.prepare('SELECT value FROM system_kv WHERE key=?').get('enforce_invariants_last_run').value)).toEqual(boot)
  })
  it('exposes verified exact completion and its counts in the existing diagnostic', async () => {
    const { db, store } = fixture(0); seedBoot(store); store(KEY, completeReceipt())
    const result = await getCheckById('pipeline.invariantSweepOutcomes').run({ db })
    expect(result.ok).toBe(true)
    expect(result.evidence.stale_match_refresh).toMatchObject({ status: 'complete', remaining_stale: 0, complete: true })
  })
  it('does not reuse a stale completion receipt as current proof', async () => {
    const { db, store } = fixture(0); seedBoot(store, 7 * 3600000)
    const at = new Date(Date.now() - 5 * 3600000).toISOString()
    store(KEY, completeReceipt({ at, started_at: at }))
    expect((await getCheckById('pipeline.invariantSweepOutcomes').run({ db })).ok).toBe(false)
  })
  it('does not hide another failed invariant after a clean refresh', async () => {
    const { db, store } = fixture(0)
    seedBoot(store, 3600000, { steps: [{ name: 'another_failure', ok: false }] }); store(KEY, completeReceipt())
    const result = await getCheckById('pipeline.invariantSweepOutcomes').run({ db })
    expect(result.ok).toBe(false)
    expect(result.evidence.failed).toContainEqual(expect.objectContaining({ name: 'another_failure' }))
  })
  it('does not hide a newer boot failure with older recurring evidence', async () => {
    const { db, store } = fixture(0)
    seedBoot(store, 1000, { steps: [{ name: 'stale_match_explain_refresh', ok: false }] })
    const at = new Date(Date.now() - 3600000).toISOString(); store(KEY, completeReceipt({ started_at: at, at }))
    expect((await getCheckById('pipeline.invariantSweepOutcomes').run({ db })).ok).toBe(false)
  })
  it('does not silently discard malformed recurring evidence', async () => {
    const { db, raw, store } = fixture(0); seedBoot(store)
    raw.prepare('INSERT INTO system_kv VALUES (?, ?, ?)').run(KEY, '{not json', new Date().toISOString())
    expect((await getCheckById('pipeline.invariantSweepOutcomes').run({ db })).ok).toBe(false)
  })
  it('reads a recurring failure even when no boot record is available', async () => {
    const { db, store } = fixture(0); store(KEY, completeReceipt({ ok: false, status: 'failed', complete: false }))
    expect((await getCheckById('pipeline.invariantSweepOutcomes').run({ db })).ok).toBe(false)
  })
})
