import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../services/matching/staleMatchExplainRefresh.js'

function fixture(count) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, is_active INTEGER);
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, matcher_version TEXT,
      match_explain_json TEXT, match_decision TEXT, match_score INTEGER,
      match_explanation TEXT, updated_at TEXT, evaluated_at TEXT
    );
  `)
  for (let index = 0; index < count; index += 1) {
    const id = String(index).padStart(4, '0')
    raw.prepare('INSERT INTO funding_opportunities VALUES (?, ?, 1)').run(id, 'Local education award')
    raw.prepare("INSERT INTO profile_opportunity_matches VALUES (?, 'profile', ?, 'institution-link', '{}', 'accept', 80, '', NULL, NULL)").run(id, id)
  }
  const db = { dialect: 'sqlite', prepare: sql => raw.prepare(sql) }
  const deps = {
    loadProfileContext: async () => ({ profile: { id: 'profile' }, sections: {} }),
    computeMatchDecision: () => ({
      decision: 'accept', score: 80, scoringPolicyVersion: 'need_first_test',
      scoreScaleId: 'data_point_test', matcherVersion: 'test',
      match_explain: { matchedSignals: [], matchedNeeds: [], scoring_policy_version: 'need_first_test' },
    }),
  }
  return { raw, db, deps }
}

describe('bounded stored-explanation refresh', () => {
  it('reports a backlog beyond the SQL limit without writing its sentinel row', async () => {
    const { raw, db, deps } = fixture(3)
    try {
      const first = await runStaleMatchExplainRefresh(db, { pairBudget: 2, deps })
      expect(first).toMatchObject({ ok: true, scanned: 2, refreshed: 2, truncated: true })
      expect(raw.prepare("SELECT match_explain_json FROM profile_opportunity_matches WHERE id='0002'").get().match_explain_json).toBe('{}')
      const second = await runStaleMatchExplainRefresh(db, { pairBudget: 2, deps })
      expect(second).toMatchObject({ ok: true, scanned: 1, refreshed: 1, truncated: false })
      expect((await runStaleMatchExplainRefresh(db, { pairBudget: 2, deps })).refreshed).toBe(0)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM funding_opportunities').get().n).toBe(3)
    } finally { raw.close() }
  })

  it.each([0, 1, 2])('does not call an exhausted population of %i rows truncated', async count => {
    const { raw, db, deps } = fixture(count)
    try {
      expect(await runStaleMatchExplainRefresh(db, { pairBudget: 2, deps }))
        .toMatchObject({ scanned: count, refreshed: count, truncated: false })
    } finally { raw.close() }
  })

  it('count-only mode still reports the bounded backlog without changing records', async () => {
    const { raw, db, deps } = fixture(3)
    try {
      expect(await runStaleMatchExplainRefresh(db, { pairBudget: 2, writeEnabled: false, deps }))
        .toMatchObject({ write_enabled: false, scanned: 2, refreshed: 0, would_refresh: 2, truncated: true })
      expect(raw.prepare("SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE match_explain_json='{}'").get().n).toBe(3)
    } finally { raw.close() }
  })

  it('a pre-cancelled maintenance lease never queries or writes the database', async () => {
    const controller = new AbortController()
    controller.abort(new Error('lease cancelled'))
    let touched = false
    const db = { prepare() { touched = true; throw new Error('unexpected database access') } }
    await expect(runStaleMatchExplainRefresh(db, { signal: controller.signal, deps: {
      computeMatchDecision: () => ({}), loadProfileContext: async () => null,
    } })).rejects.toThrow('lease cancelled')
    expect(touched).toBe(false)
  })

  it('cancellation while loading profile data prevents a subsequent match write', async () => {
    const { raw, db, deps } = fixture(1)
    const controller = new AbortController()
    deps.loadProfileContext = async () => {
      controller.abort(new Error('lease cancelled'))
      return { profile: { id: 'profile' }, sections: {} }
    }
    try {
      await expect(runStaleMatchExplainRefresh(db, { pairBudget: 2, signal: controller.signal, deps })).rejects.toThrow('lease cancelled')
      expect(raw.prepare('SELECT match_explain_json FROM profile_opportunity_matches').get().match_explain_json).toBe('{}')
    } finally { raw.close() }
  })
})
