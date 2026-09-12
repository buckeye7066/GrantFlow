/**
 * staleMatchExplainRefresh — residue drain that UPDATEs explain in place and
 * keeps matcher_version (must not rebrand through catalog-rescore).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runStaleMatchExplainRefresh } from '../services/matching/staleMatchExplainRefresh.js'
import { PROFILE_SIGNAL_VERSION } from '../config/profileSignalVersion.js'
import { qualifiesForDisplay } from '../config/matchSurfacing.js'

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
        scoring_policy_version: 'need_first_v2', signal_version: PROFILE_SIGNAL_VERSION,
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

const PROVEN = Object.freeze({
  why: 'crawler-os accept',
  matched_needs: ['veteran', 'education'],
  matched_location: 'state',
  four_truth_proof: {
    direct_funding: true,
    all_passed: true,
    real: {
      gate: 'crawler_os.realityGate.enforceReality', passed: true, reality_status: 'verified',
      evidence_url: 'https://example.org/apply', evidence_captured_at: '2026-09-07T17:34:30.628Z',
      content_hash_present: true,
    },
    relatable: { passed: true, canonical_decision: 'ACCEPT', score: 80 },
    meets_profile_need: { passed: true, matched_needs: ['veteran', 'education'], profile_needs_defaulted: false },
    profile_qualifies: {
      passed: true, eligibility: true, applicant_type_evidence: ['student'],
      eligibility_prose_evidence: ['Transfer students'], missing_eligibility_fields: [],
    },
  },
})

function stubProvingEngine({ decision = 'accept', eligible = true, matchedNeeds = ['education'], signals = ['applicant_type', 'geo:state'] } = {}) {
  return () => ({
    decision,
    score: 91,
    eligible,
    matchedNeeds,
    missingEligibilityFields: [],
    explanation: 'engine-refresh',
    scoringPolicyVersion: 'need_first_v2',
    scoreScaleId: 'data_point_test_v1',
    matcherVersion: 'matcher-test-v1',
    match_explain: {
      matchedSignals: signals,
      matchedNeeds,
      scoreBreakdown: { total: 91, scoring_policy_version: 'need_first_v2' },
    },
  })
}

describe('four-truth proof survives the drain', () => {
  it('carries the REAL leg forward, recomputes the profile legs, keeps ACCEPT when all four still pass', async () => {
    const raw = makeDb()
    seedPair(raw, { matcherVersion: 'crawler-os', explain: PROVEN })
    const db = wrap(raw)
    const summary = await runStaleMatchExplainRefresh(db, {
      pairBudget: 10, writeEnabled: true, deps: { thesisNeedsDefaulted: async () => false, computeMatchDecision: stubProvingEngine() },
    })
    expect(summary.refreshed).toBe(1)
    expect(summary.proofs_carried).toBe(1)
    expect(summary.held_at_review).toBe(0)
    const row = raw.prepare('SELECT match_decision, match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    const explain = JSON.parse(row.match_explain_json)
    expect(explain.signal_version).toBe(PROFILE_SIGNAL_VERSION)
    expect(explain.four_truth_proof.real).toEqual(PROVEN.four_truth_proof.real)
    // The stale "veteran" need is gone from the proof; needs come from THIS decision.
    expect(explain.four_truth_proof.meets_profile_need.matched_needs).toEqual(['education'])
    expect(explain.four_truth_proof.all_passed).toBe(true)
    expect(row.match_decision).toBe('accept')
  })

  it('holds a direct ACCEPT at REVIEW and names the failed truth when the refreshed proof no longer passes', async () => {
    const raw = makeDb()
    seedPair(raw, { matcherVersion: 'crawler-os', explain: PROVEN })
    const db = wrap(raw)
    // Engine still says ACCEPT but matched no need this time.
    const summary = await runStaleMatchExplainRefresh(db, {
      pairBudget: 10, writeEnabled: true, deps: { thesisNeedsDefaulted: async () => false, computeMatchDecision: stubProvingEngine({ matchedNeeds: [] }) },
    })
    expect(summary.held_at_review).toBe(1)
    const row = raw.prepare('SELECT match_decision, match_explanation, match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(row.match_decision).toBe('review')
    expect(row.match_explanation).toMatch(/four-truth gate held at REVIEW: meets_profile_need/)
    expect(JSON.parse(row.match_explain_json).four_truth_proof.all_passed).toBe(false)
  })

  it('a crawler-os direct row with NO proof on record cannot be written as ACCEPT', async () => {
    const raw = makeDb()
    seedPair(raw, { matcherVersion: 'crawler-os', explain: { why: 'old stub' } })
    const db = wrap(raw)
    const summary = await runStaleMatchExplainRefresh(db, {
      pairBudget: 10, writeEnabled: true, deps: { thesisNeedsDefaulted: async () => false, computeMatchDecision: stubProvingEngine() },
    })
    expect(summary.held_at_review).toBe(1)
    const row = raw.prepare('SELECT match_decision, match_explanation FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(row.match_decision).toBe('review')
    expect(row.match_explanation).toMatch(/no four-truth proof on record/)
  })

  it.each(['accept', 'reject'])('retains linker provenance but refuses stale positive proof after a fresh %s with failed truths', async (decision) => {
    const raw = makeDb()
    seedPair(raw, { matcherVersion: 'catalog-rescore-link', explain: PROVEN })
    const db = wrap(raw)
    const summary = await runStaleMatchExplainRefresh(db, {
      pairBudget: 10,
      writeEnabled: true,
      deps: { thesisNeedsDefaulted: async () => false, computeMatchDecision: stubProvingEngine({ decision, eligible: decision !== 'reject', matchedNeeds: [] }) },
    })
    expect(summary.refreshed).toBe(1)
    const row = raw.prepare('SELECT match_decision, match_explanation, match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    // Admission belongs to the linker; current display eligibility belongs to
    // the refreshed proof, even when the admission column is retained.
    expect(row.match_decision).toBe('accept')
    const explain = JSON.parse(row.match_explain_json)
    expect(explain.four_truth_proof.all_passed).toBe(false)
    expect(explain.four_truth_proof.meets_profile_need.matched_needs).toEqual([])
    expect(explain.previous_four_truth_proof).toEqual(PROVEN.four_truth_proof)
    expect(qualifiesForDisplay({ ...row, opportunity_kind: 'SCHOLARSHIP' })).toBe(false)
    // Retain the row for recovery through its owning linker, without exposing
    // historical eligibility as if the current evaluation had proved it.
    const { normalizePersistedMatchDecisionIntegrity } = await import('../services/matching/matchDecisionIntegrity.js')
    await normalizePersistedMatchDecisionIntegrity(db, { profileId: 'p1' })
    const survivor = raw.prepare('SELECT id FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(survivor).toBeTruthy()
  })

  it('a linker lane without proof keeps its documented behaviour (ACCEPT written, no proof invented)', async () => {
    const raw = makeDb()
    seedPair(raw, { matcherVersion: 'institution-link', explain: { gate: 'attendance', institution: 'MTSU' } })
    const db = wrap(raw)
    const summary = await runStaleMatchExplainRefresh(db, {
      pairBudget: 10, writeEnabled: true, deps: { thesisNeedsDefaulted: async () => false, computeMatchDecision: stubProvingEngine() },
    })
    expect(summary.held_at_review).toBe(0)
    const row = raw.prepare('SELECT match_decision, match_explain_json FROM profile_opportunity_matches WHERE id = ?').get('m1')
    expect(row.match_decision).toBe('accept')
    expect(JSON.parse(row.match_explain_json).four_truth_proof).toBeUndefined()
  })
})


it('real canonical rescore preserves an unrestricted directory through integrity cleanup', async () => {
  const { normalizePersistedMatchDecisionIntegrity } = await import('../services/matching/matchDecisionIntegrity.js')
  const raw = makeDb()
  try {
    raw.exec('ALTER TABLE funding_opportunities ADD COLUMN entity_types_allowed TEXT')
    seedPair(raw, { matcherVersion: 'crawler-os', explain: { legacy: true } })
    raw.prepare(`UPDATE funding_opportunities SET title = ?, description = ?, sponsor = 'USA.gov', opportunity_kind = 'DIRECTORY', entity_types_allowed = '["*"]', state = 'TN', is_national = 0, source_url = ?, application_url = NULL WHERE id = 'o1'`).run(
      'Bradley County, TN — County & city government assistance programs (USA.gov directory)',
      'Official USA.gov index of city, county, and town government websites — the front door to locally administered assistance (housing, utility, emergency, human services) that never appears in federal or state catalogs.',
      'https://www.usa.gov/local-governments',
    )
    raw.prepare("UPDATE profile_opportunity_matches SET match_score = 7, match_decision = 'review' WHERE id = 'm1'").run()
    const db = wrap(raw)
    const result = await runStaleMatchExplainRefresh(db, { deps: { loadProfileContext: async () => ({
      profile: { id: 'p1', primary_type: 'individual', state: 'TN' },
      sections: { basic_information: { state: 'TN' }, needs: { needs: ['housing', 'utility assistance'] } },
    }) } })
    expect(result.refreshed).toBe(1)
    await normalizePersistedMatchDecisionIntegrity(db, { profileId: 'p1' })
    const match = raw.prepare("SELECT * FROM profile_opportunity_matches WHERE id = 'm1'").get()
    expect(match).toBeTruthy()
    expect(match.match_decision).toBe('review')
    expect(match.match_score).toBeGreaterThanOrEqual(7)
  } finally { raw.close() }
})
