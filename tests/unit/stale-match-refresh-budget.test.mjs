import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../../backend/services/matching/staleMatchExplainRefresh.js'
import { PROFILE_SIGNAL_VERSION } from '../../backend/config/profileSignalVersion.js'

const originalEnforcement = process.env.ENFORCE_STALE_MATCH_EXPLAIN
beforeEach(() => { delete process.env.ENFORCE_STALE_MATCH_EXPLAIN })
afterEach(() => {
  if (originalEnforcement === undefined) delete process.env.ENFORCE_STALE_MATCH_EXPLAIN
  else process.env.ENFORCE_STALE_MATCH_EXPLAIN = originalEnforcement
})

function fixture(size = 3) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, opportunity_kind TEXT, application_url TEXT,
      source_url TEXT, is_active INTEGER
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      matcher_version TEXT, match_decision TEXT, match_score INTEGER,
      match_explanation TEXT, match_explain_json TEXT, updated_at TEXT, evaluated_at TEXT
    );
  `)
  for (let index = 0; index < size; index += 1) {
    raw.prepare('INSERT INTO funding_opportunities VALUES (?, ?, ?, ?, ?, ?)')
      .run(`o${index}`, 'Example award', 'SCHOLARSHIP', 'https://example.org/apply', 'https://example.org/program', 1)
    raw.prepare('INSERT INTO profile_opportunity_matches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`m${index}`, 'private-profile', `o${index}`, 'institution-link', 'accept', 80, 'original', JSON.stringify({ gate: 'attendance', institution: 'Example College' }), 'original', 'original')
  }
  const adapter = {
    dialect: 'sqlite',
    prepare(sql) {
      const statement = raw.prepare(sql)
      return {
        all: (...args) => statement.all(...args),
        get: (...args) => statement.get(...args),
        run: (...args) => statement.run(...args),
      }
    },
  }
  const deps = {
    loadProfileContext: async () => ({ profile: { id: 'private-profile' }, sections: {} }),
    computeMatchDecision: () => ({
      decision: 'accept', score: 81, explanation: 'current',
      scoringPolicyVersion: 'need_first_test', matcherVersion: 'test-engine',
      match_explain: { matchedNeeds: ['education'], matchedSignals: [], scoring_policy_version: 'need_first_test' },
    }),
  }
  const snapshot = () => JSON.stringify(raw.prepare('SELECT * FROM profile_opportunity_matches ORDER BY id').all())
  return { raw, adapter, deps, snapshot }
}

function faultAdapter(adapter, intercept) {
  return { ...adapter, prepare(sql) { return intercept(sql, () => adapter.prepare(sql)) } }
}

// The SQL limit must fetch one lookahead row, never score/write beyond the budget.
test('a full page with further candidates is truncated, not a completed drain', async () => {
  const { raw, adapter, deps } = fixture()
  try {
    const result = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
    assert.equal(result.scanned, 2)
    assert.equal(result.refreshed, 2)
    assert.equal(result.truncated, true)
    assert.equal(result.remaining_candidates, 1)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'pending')
    assert.equal(raw.prepare('SELECT match_explanation FROM profile_opportunity_matches WHERE id=?').get('m2').match_explanation, 'original')
  } finally { raw.close() }
})

test('the next bounded invocation finishes without changing source rows or lane provenance', async () => {
  const { raw, adapter, deps } = fixture()
  try {
    await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
    const second = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
    assert.equal(second.refreshed, 1)
    assert.equal(second.remaining_candidates, 0)
    assert.equal(second.complete, true)
    assert.equal(second.status, 'complete')
    const third = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
    assert.equal(third.refreshed, 0)
    assert.equal(third.complete, true)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM funding_opportunities').get().n, 3)
    for (const row of raw.prepare('SELECT * FROM profile_opportunity_matches').all()) {
      assert.equal(row.matcher_version, 'institution-link')
      assert.equal(row.match_decision, 'accept')
      const explain = JSON.parse(row.match_explain_json)
      assert.equal(explain.signal_version, PROFILE_SIGNAL_VERSION)
      assert.equal(explain.gate, 'attendance')
      assert.equal(explain.four_truth_proof, undefined)
    }
  } finally { raw.close() }
})

test('an exact-budget page with nothing left is complete and not truncated', async () => {
  const { raw, adapter, deps } = fixture(2)
  try {
    const result = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
    assert.equal(result.truncated, false)
    assert.equal(result.remaining_candidates, 0)
    assert.equal(result.complete, true)
  } finally { raw.close() }
})

test('disabled writes report the unchanged backlog, never successful completion', async () => {
  const { raw, adapter, deps, snapshot } = fixture()
  try {
    const before = snapshot()
    const result = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, writeEnabled: false, deps })
    assert.equal(result.refreshed, 0)
    assert.equal(result.would_refresh, 2)
    assert.equal(result.remaining_candidates, 3)
    assert.equal(result.status, 'disabled')
    assert.equal(result.complete, false)
    assert.equal(snapshot(), before)
  } finally { raw.close() }
})

test('time exhaustion preserves the bound and reports the backlog', async () => {
  const { raw, adapter, deps, snapshot } = fixture(2)
  try {
    const before = snapshot()
    const result = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, timeBudgetMs: 0, deps })
    assert.equal(result.scanned, 0)
    assert.equal(result.truncated, true)
    assert.equal(result.remaining_candidates, 2)
    assert.equal(result.complete, false)
    assert.equal(snapshot(), before)
  } finally { raw.close() }
})

for (const reason of ['missing profile', 'engine exception', 'missing policy']) {
  test(`${reason} remains visible as unresolved work`, async () => {
    const { raw, adapter, deps, snapshot } = fixture(1)
    try {
      const before = snapshot()
      if (reason === 'missing profile') deps.loadProfileContext = async () => null
      if (reason === 'engine exception') deps.computeMatchDecision = () => { throw Error('unscorable fixture') }
      if (reason === 'missing policy') deps.computeMatchDecision = () => ({ decision: 'accept', score: 81, match_explain: {} })
      const result = await runStaleMatchExplainRefresh(adapter, { pairBudget: 2, deps })
      assert.equal(result.refreshed, 0)
      assert.equal(result.remaining_candidates, 1)
      assert.equal(result.complete, false)
      assert.equal(result.status, 'pending')
      assert.equal(result.skipped_no_profile + result.unscorable, 1)
      assert.equal(snapshot(), before)
    } finally { raw.close() }
  })
}

test('candidate-query failure cannot be reported complete even if a count returns zero', async () => {
  const { raw, adapter, deps } = fixture(0)
  try {
    const fault = faultAdapter(adapter, (sql, prepare) => {
      if (sql.includes('m.id AS match_id')) throw Error('candidate query failure')
      return prepare()
    })
    const result = await runStaleMatchExplainRefresh(fault, { deps })
    assert.equal(result.ok, false)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.skipped, 'query')
  } finally { raw.close() }
})

test('failed completion readback means unknown, never a fabricated zero', async () => {
  const { raw, adapter, deps } = fixture(1)
  try {
    const fault = faultAdapter(adapter, (sql, prepare) => {
      if (sql.includes('COUNT(*)')) throw Error('readback failure')
      return prepare()
    })
    const result = await runStaleMatchExplainRefresh(fault, { deps })
    assert.equal(result.refreshed, 1)
    assert.equal(result.remaining_candidates, null)
    assert.equal(result.verification_failed, true)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.ok, false)
  } finally { raw.close() }
})

test('a concurrent update is preserved and cannot be counted as refreshed', async () => {
  const { raw, adapter, deps, snapshot } = fixture(1)
  try {
    const before = snapshot()
    const fault = faultAdapter(adapter, (sql, prepare) => {
      if (sql.trimStart().startsWith('UPDATE')) return { run: () => ({ changes: 0 }) }
      return prepare()
    })
    const result = await runStaleMatchExplainRefresh(fault, { deps })
    assert.equal(result.concurrent_changes_skipped, 1)
    assert.equal(result.refreshed, 0)
    assert.equal(result.remaining_candidates, 1)
    assert.equal(result.complete, false)
    assert.equal(snapshot(), before)
  } finally { raw.close() }
})

test('failed writes remain failed even when completion verification succeeds', async () => {
  const { raw, adapter, deps } = fixture(1)
  try {
    const fault = faultAdapter(adapter, (sql, prepare) => {
      if (sql.trimStart().startsWith('UPDATE')) return { run: () => { throw Error('write failure') } }
      return prepare()
    })
    const result = await runStaleMatchExplainRefresh(fault, { deps })
    assert.equal(result.convergence_errors, 1)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.remaining_candidates, 1)
  } finally { raw.close() }
})

test('completion counts use the same active-catalog scope as candidate selection', async () => {
  const { raw, adapter, deps } = fixture(2)
  try {
    raw.prepare('UPDATE funding_opportunities SET is_active=0 WHERE id=?').run('o1')
    const result = await runStaleMatchExplainRefresh(adapter, { deps })
    assert.equal(result.refreshed, 1)
    assert.equal(result.remaining_candidates, 0)
    assert.equal(result.complete, true)
    assert.equal(raw.prepare('SELECT match_explanation FROM profile_opportunity_matches WHERE id=?').get('m1').match_explanation, 'original')
  } finally { raw.close() }
})

test('SQL-candidate false positives stay explicit rather than becoming a zero-stale claim', async () => {
  const { raw, adapter, deps } = fixture(1)
  try {
    raw.prepare('UPDATE profile_opportunity_matches SET match_explain_json=?').run(JSON.stringify({
      scoring_policy_version: 'current', signal_version: PROFILE_SIGNAL_VERSION,
      matchedNeeds: [], old: { scoring_policy_version: null },
    }))
    const result = await runStaleMatchExplainRefresh(adapter, { deps })
    assert.equal(result.refreshed, 0)
    assert.equal(result.remaining_candidates, 1)
    assert.equal(result.complete, false)
    assert.equal(result.status, 'pending')
  } finally { raw.close() }
})

test('receipt contains aggregate metrics and no applicant or source content', async () => {
  const { raw, adapter, deps } = fixture(1)
  try {
    const result = await runStaleMatchExplainRefresh(adapter, { deps })
    assert.equal(result.complete, true)
    assert.equal(/private-profile|Example College|example\.org|Example award/.test(JSON.stringify(result)), false)
    assert.equal(Number.isFinite(Date.parse(result.verified_at)), true)
  } finally { raw.close() }
})

test('PostgreSQL-style string counts are accepted without mistaking them for unknown', async () => {
  const { raw, adapter, deps } = fixture(1)
  try {
    const stringCounts = faultAdapter(adapter, (sql, prepare) => {
      const statement = prepare()
      if (!sql.includes('COUNT(*)')) return statement
      return { get: () => ({ remaining_candidates: String(statement.get().remaining_candidates) }) }
    })
    const result = await runStaleMatchExplainRefresh(stringCounts, { deps })
    assert.equal(result.remaining_candidates, 0)
    assert.equal(result.complete, true)
  } finally { raw.close() }
})

for (const invalid of [null, undefined, '', false, -1, 'not-a-count']) {
  test(`invalid count ${String(invalid)} is unknown rather than cleared`, async () => {
    const { raw, adapter, deps } = fixture(0)
    try {
      const malformed = faultAdapter(adapter, (sql, prepare) => sql.includes('COUNT(*)')
        ? { get: () => ({ remaining_candidates: invalid }) } : prepare())
      const result = await runStaleMatchExplainRefresh(malformed, { deps })
      assert.equal(result.remaining_candidates, null)
      assert.equal(result.complete, false)
      assert.equal(result.verification_failed, true)
    } finally { raw.close() }
  })
}
