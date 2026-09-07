/**
 * staleMatchExplainRefresh — residue drain that UPDATEs explain in place and
 * keeps matcher_version (must not rebrand through catalog-rescore).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../services/matching/staleMatchExplainRefresh.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT, created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT,
      source_url TEXT, application_url TEXT,
      is_directory_resource INTEGER, excluded_from_grant_scoring INTEGER,
      profile_id TEXT, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score INTEGER, match_decision TEXT, match_explanation TEXT,
      match_reasons TEXT, match_explain_json TEXT, source_query TEXT,
      discovered_via TEXT, matcher_version TEXT,
      computed_at DATETIME, updated_at DATETIME, evaluated_at DATETIME
    );
  `)
  return db
}

function wrap(db) {
  return {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        all: (...args) => stmt.all(...args),
        get: (...args) => stmt.get(...args),
        run: (...args) => {
          const info = stmt.run(...args)
          return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
        },
      }
    },
  }
}

function seedPair(db, {
  matchId = 'm1',
  profileId = 'p1',
  oppId = 'o1',
  matcherVersion = 'institution-link',
  explain = { gate: 'attendance', institution: 'MTSU' },
} = {}) {
  db.prepare('INSERT INTO profiles (id, display_name, status) VALUES (?, ?, ?)')
    .run(profileId, profileId, 'active')
  db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)")
    .run(profileId, JSON.stringify({ first_name: 'Demo', location: { state: 'TN' } }))
  db.prepare(
    `INSERT INTO funding_opportunities
      (id, title, sponsor, opportunity_kind, application_url, is_active)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(oppId, 'MTSU Guaranteed Scholarship', 'Middle Tennessee State University', 'SCHOLARSHIP', 'https://example.org/apply')
  db.prepare(
    `INSERT INTO profile_opportunity_matches
      (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json, matcher_version)
     VALUES (?, ?, ?, 80, 'accept', ?, ?)`,
  ).run(matchId, profileId, oppId, JSON.stringify(explain), matcherVersion)
}

function stubEngine(policy = 'need_first_v2') {
  return () => ({
    decision: 'accept',
    score: 91,
    explanation: 'engine-refresh',
    scoringPolicyVersion: policy,
    scoreScaleId: 'data_point_test_v1',
    matcherVersion: 'matcher-test-v1',
    match_explain: {
      scoreBreakdown: { total: 91, scoring_policy_version: policy },
    },
  })
}

const prevEnforce = process.env.ENFORCE_STALE_MATCH_EXPLAIN

beforeEach(() => {
  delete process.env.ENFORCE_STALE_MATCH_EXPLAIN
})

afterEach(() => {
  if (prevEnforce === undefined) delete process.env.ENFORCE_STALE_MATCH_EXPLAIN
  else process.env.ENFORCE_STALE_MATCH_EXPLAIN = prevEnforce
})

describe('runStaleMatchExplainRefresh', () => {
  it('refreshes a gate-only stub in place and keeps matcher_version', async () => {
    const raw = makeDb()
    seedPair(raw)
    const res = await runStaleMatchExplainRefresh(wrap(raw), {
      deps: {
        computeMatchDecision: stubEngine(),
        loadProfileContext: async () => ({
          profile: { id: 'p1' },
          sections: {},
        }),
      },
    })
    expect(res.refreshed).toBe(1)
    const row = raw.prepare('SELECT matcher_version, match_explain_json, match_score FROM profile_opportunity_matches WHERE id = ?')
      .get('m1')
    expect(row.matcher_version).toBe('institution-link')
    expect(row.match_score).toBe(91)
    const explain = JSON.parse(row.match_explain_json)
    expect(explain.scoring_policy_version).toBe('need_first_v2')
    expect(explain.gate).toBe('attendance')
    expect(explain.institution).toBe('MTSU')
  })

  it('count-only mode reports would_refresh and writes nothing', async () => {
    process.env.ENFORCE_STALE_MATCH_EXPLAIN = '0'
    const raw = makeDb()
    seedPair(raw)
    const before = raw.prepare('SELECT match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    const res = await runStaleMatchExplainRefresh(wrap(raw), {
      deps: {
        computeMatchDecision: stubEngine(),
        loadProfileContext: async () => ({ profile: { id: 'p1' }, sections: {} }),
      },
    })
    expect(res.write_enabled).toBe(false)
    expect(res.would_refresh).toBe(1)
    expect(res.refreshed).toBe(0)
    const after = raw.prepare('SELECT match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(after.match_explain_json).toBe(before.match_explain_json)
  })

  it('skips rows that already carry scoring_policy_version AND match evidence', async () => {
    const raw = makeDb()
    seedPair(raw, {
      explain: {
        gate: 'attendance',
        scoring_policy_version: 'need_first_v2',
        // Evidence keys are load-bearing since the pointer gates read them;
        // an explain carrying a policy but no evidence is stale (2026-09-06).
        matchedSignals: ['geo:state'],
      },
    })
    const res = await runStaleMatchExplainRefresh(wrap(raw), {
      deps: {
        computeMatchDecision: stubEngine(),
        loadProfileContext: async () => ({ profile: { id: 'p1' }, sections: {} }),
      },
    })
    // Candidate SQL may still SELECT the row (LIKE is a superset), but
    // isStaleMatchExplain must refuse to rewrite a current explain.
    expect(res.refreshed).toBe(0)
    expect(res.would_refresh).toBe(0)
  })

  it('does not invent policy when the engine returns none', async () => {
    const raw = makeDb()
    seedPair(raw)
    const res = await runStaleMatchExplainRefresh(wrap(raw), {
      deps: {
        computeMatchDecision: () => ({
          decision: 'accept',
          score: 50,
          match_explain: { gate: 'attendance' },
        }),
        loadProfileContext: async () => ({ profile: { id: 'p1' }, sections: {} }),
      },
    })
    expect(res.unscorable).toBe(1)
    expect(res.refreshed).toBe(0)
    const row = raw.prepare('SELECT match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(JSON.parse(row.match_explain_json).scoring_policy_version).toBeUndefined()
  })
})
