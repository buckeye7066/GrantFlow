import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { computeSpy } = vi.hoisted(() => ({ computeSpy: vi.fn() }))

vi.mock('../services/matchEngine.js', async () => {
  const actual = await vi.importActual('../services/matchEngine.js')
  return { ...actual, computeMatchDecision: computeSpy }
})

import {
  __testables,
  getPromotionOutcomeSummary,
  runQualifiedPipelinePromotion, assertNoPromotionDryRunOption } from '../services/pipelinePromotion.js'
import { recordDismissal } from '../services/pipelineDismissals.js'
import { grantFingerprintFromOpportunity } from '../utils/grantFingerprint.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.withTransaction = async (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, status TEXT, deleted_at TEXT,
      created_by TEXT, tags TEXT, primary_type TEXT, applicant_type TEXT,
      display_name TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT
    );
    CREATE TABLE documents (id TEXT, profile_id TEXT, name TEXT, mime_type TEXT, extracted_text TEXT, uploaded_at TEXT, created_at TEXT);
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE exclusion_rules (id TEXT, action TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, title TEXT NOT NULL,
      sponsor TEXT, source TEXT, source_id TEXT, source_url TEXT, record_origin TEXT,
      description TEXT, eligibility_bullets TEXT, amount_min REAL, amount_max REAL,
      amount_text TEXT, amount_status TEXT, amount_confidence REAL,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0,
      deadline TEXT, deadline_type TEXT, application_url TEXT, evidence_url TEXT,
      contact_info TEXT, is_national INTEGER, state TEXT, regions TEXT, categories TEXT,
      keywords TEXT, opportunity_type TEXT, opportunity_kind TEXT, type TEXT,
      requires_501c3 INTEGER, requires_match INTEGER, is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      link_status TEXT DEFAULT 'unverified', reality_status TEXT,
      profile_id TEXT, source_trust_tier TEXT, test_decision TEXT, live_score REAL
    );
    CREATE TABLE profile_opportunity_matches (
      -- NOT NULL mirrors production PostgreSQL (0123): SQLite alone lets a
      -- TEXT PRIMARY KEY hold NULL, which is exactly how an id-less INSERT
      -- passed every test here while poisoning every live run in prod.
      id TEXT PRIMARY KEY NOT NULL, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      match_score REAL, match_confidence REAL, match_decision TEXT,
      match_explanation TEXT, match_reasons TEXT, match_explain_json TEXT,
      matcher_version TEXT, computed_at TEXT, updated_at TEXT, evaluated_at TEXT,
      UNIQUE (profile_id, opportunity_id)
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, organization_id TEXT, profile_id TEXT,
      funding_opportunity_id TEXT, title TEXT, description TEXT, funder TEXT,
      status TEXT, deadline TEXT, match_score REAL, match_reasons TEXT, notes TEXT,
      application_url TEXT, application_method TEXT, contact_name TEXT,
      contact_email TEXT, contact_phone TEXT, amount_requested REAL,
      amount_min REAL, amount_max REAL, url TEXT, fingerprint TEXT,
      fingerprint_version INTEGER, amount_status TEXT, amount_text TEXT,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0
    );
    CREATE TABLE pipeline_promotion_outcomes (
      profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('live','dry_run')),
      outcome TEXT NOT NULL, reason TEXT NOT NULL, score REAL,
      attempted_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
      profile_facts_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      opportunity_updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, opportunity_id)
    );
  `)
  return db
}

function seedProfile(db, id, overrides = {}, metadata = null) {
  db.prepare(`INSERT INTO profiles
    (id, status, created_by, tags, primary_type, applicant_type, display_name, created_at, updated_at)
    VALUES (?, 'active', ?, ?, 'individual', 'individual', ?, ?, ?)`)
    .run(id, overrides.created_by ?? null, JSON.stringify(overrides.tags ?? ['emergency', 'housing']), id, '2026-07-01', '2026-07-01')
  db.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, 'basic_information', JSON.stringify({ profile_category: 'individual', needs: ['emergency', 'housing'] }), '2026-07-01')
  if (metadata !== null) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, 'amy_metadata', JSON.stringify(metadata), '2026-07-01')
  }
}

let seq = 0
function seedCandidate(db, profileId, overrides = {}) {
  seq++
  const id = overrides.id || `opp-${seq}`
  const title = overrides.title || `Emergency Housing Support ${seq}`
  db.prepare(`INSERT INTO funding_opportunities
    (id, created_at, updated_at, title, sponsor, source, record_origin, description,
     amount_min, amount_max, deadline_type, application_url, source_url, categories,
     opportunity_kind, is_active, is_hidden, status, link_status, reality_status,
     test_decision, live_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rolling', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, '2026-07-01', overrides.updated_at || '2026-07-01', title,
      overrides.sponsor || 'Community Foundation', overrides.source || 'grants_gov',
      overrides.record_origin || 'curated_verified',
      overrides.description || 'Emergency housing assistance for individuals and families in need.',
      overrides.amount_min ?? null, overrides.amount_max ?? null,
      overrides.url || `https://example.org/${id}`, overrides.url || `https://example.org/${id}`,
      JSON.stringify(['emergency', 'housing']), overrides.kind || 'DIRECT_GRANT',
      overrides.is_active ?? 1, overrides.is_hidden ?? 0, overrides.status ?? 'active',
      overrides.link_status ?? 'unverified', overrides.reality_status ?? null,
      overrides.liveDecision || 'ACCEPT', overrides.liveScore ?? 90,
    )
  db.prepare(`INSERT INTO profile_opportunity_matches
    (id, profile_id, opportunity_id, match_score, match_decision, matcher_version, updated_at)
    VALUES (?, ?, ?, ?, ?, 'crawler-os', ?)`)
    .run(`match-${id}-${profileId}`, profileId, id, overrides.storedScore ?? 90, overrides.storedDecision || 'ACCEPT', '2026-07-01')
  return db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id)
}

function grantsFor(db, profileId) {
  return db.prepare('SELECT * FROM grants WHERE profile_id = ? ORDER BY title').all(profileId)
}

beforeEach(() => {
  seq = 0
  computeSpy.mockReset()
  computeSpy.mockImplementation((_profile, opp) => ({
    decision: opp.test_decision || 'ACCEPT',
    eligible: opp.test_decision !== 'REJECT',
    score: opp.test_decision === 'REJECT' ? 0 : Number(opp.live_score ?? 90),
    reasons: ['fresh live score'],
    ineligibilityReasons: opp.test_decision === 'REJECT' ? ['live policy rejected'] : [],
    explanation: 'test decision',
    matchedNeeds: ['housing'],
    matcherVersion: 'test-live',
    evaluatedAt: '2026-07-21T00:00:00Z',
    confidence: 0.9,
    scoreScaleId: 'data_point_v1',
    scoringPolicyVersion: 'need-first-v1',
    match_explain: {
      score_scale_id: 'data_point_v1',
      scoring_policy_version: 'need-first-v1',
    },
  }))
})

describe('qualified pipeline promotion', () => {
  it('rolls back a promoted grant when its required live outcome cannot be recorded', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'atomic-outcome' })
    db.exec(`CREATE TRIGGER reject_promotion_outcome
      BEFORE INSERT ON pipeline_promotion_outcomes
      BEGIN
        SELECT RAISE(ABORT, 'injected outcome sink failure');
      END`)

    await expect(runQualifiedPipelinePromotion(db, {
      
      batch: 1,
      amountFollowup: false,
    })).rejects.toThrow('injected outcome sink failure')
    expect(grantsFor(db, 'real')).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(0)
    db.close()
  })

  it('promotes stale-LOW and stale-REJECT rows after a fresh live rescore', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'low', storedScore: 1, storedDecision: 'LOW' })
    seedCandidate(db, 'real', { id: 'reject', storedScore: 99, storedDecision: 'REJECT' })

    const result = await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })

    expect(result.promoted).toBe(2)
    expect(grantsFor(db, 'real')).toHaveLength(2)
    expect(computeSpy).toHaveBeenCalledTimes(2)
    expect(computeSpy.mock.calls.map((call) => call[1].id).sort()).toEqual(['low', 'reject'])
    db.close()
  })

  it('records a fresh live REJECT even when the stored row was accepted/above-bar', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'fresh-reject', storedScore: 99, storedDecision: 'ACCEPT', liveDecision: 'REJECT' })

    await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })

    expect(grantsFor(db, 'real')).toHaveLength(0)
    expect(db.prepare('SELECT outcome, reason FROM pipeline_promotion_outcomes').get()).toEqual({ outcome: 'live_reject', reason: 'live_reject' })
    // The rescore replaces the pair TRUTH but never the pair's SURFACING LANE.
    // `matcher_version` names the lane a row was discovered through and is read
    // back through the `SURFACED_MATCHER_VERSIONS` allowlist; writing the engine
    // version here is what stranded 142 prod pairs (38 ACCEPT) in a '4.1.2' lane
    // no read path knows, so a re-proved pair silently vanished from Discover.
    expect(db.prepare(`SELECT match_score, match_decision, matcher_version
                         FROM profile_opportunity_matches
                        WHERE opportunity_id = 'fresh-reject'`).get())
      .toEqual({ match_score: 0, match_decision: 'reject', matcher_version: 'crawler-os' })
    expect(computeSpy).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('a pair with NO lane is given one the read paths actually surface', async () => {
    // A row that recorded no lane is invisible to every read path, because
    // SURFACED_MATCHER_VERSIONS is an allowlist. The rescore preserves a real
    // lane and FILLS an empty one with its own reconcile-surviving lane; writing
    // the engine version there is what stranded 142 prod pairs (prod 2026-09-06).
    const { SURFACED_MATCHER_VERSIONS } = await import('../config/matchSurfacing.js')
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'laneless', storedScore: 1, storedDecision: 'LOW' })
    db.prepare(`UPDATE profile_opportunity_matches SET matcher_version = NULL
                 WHERE opportunity_id = 'laneless'`).run()

    await runQualifiedPipelinePromotion(db, { batch: 1, amountFollowup: false })

    const lane = db.prepare(`SELECT matcher_version FROM profile_opportunity_matches
                              WHERE opportunity_id = 'laneless'`).get()?.matcher_version
    expect(lane).toBe('canonical-rescore-link')
    expect(SURFACED_MATCHER_VERSIONS).toContain(lane)
    db.close()
  })

  it('atomically replaces stale persisted truth with the fresh promoted decision', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', {
      id: 'fresh-accept',
      storedScore: 1,
      storedDecision: 'REJECT',
      liveDecision: 'ACCEPT',
      liveScore: 18,
    })

    await runQualifiedPipelinePromotion(db, {
      
      batch: 1,
      amountFollowup: false,
    })

    const persisted = db.prepare(`SELECT match_score, match_confidence, match_decision,
                                         matcher_version, match_explain_json
                                    FROM profile_opportunity_matches
                                   WHERE opportunity_id = 'fresh-accept'`).get()
    const grant = db.prepare(`SELECT match_score
                                FROM grants
                               WHERE funding_opportunity_id = 'fresh-accept'`).get()
    expect(persisted).toMatchObject({
      match_score: 18,
      match_confidence: 0.9,
      match_decision: 'accept',
      // The discovery lane survives the rescore (see the note above); the ENGINE
      // version travels in match_explain_json, where it always did.
      matcher_version: 'crawler-os',
    })
    expect(JSON.parse(persisted.match_explain_json).matcher_version).toBe('test-live')
    expect(JSON.parse(persisted.match_explain_json)).toMatchObject({
      score_scale_id: 'data_point_v1',
      scoring_policy_version: 'need-first-v1',
      canonical_decision: 'ACCEPT',
    })
    expect(grant.match_score).toBe(persisted.match_score)
    db.close()
  })

  it('never re-promotes catalog rows whose lifecycle says hidden, inactive, broken, expired, or rejected', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'active-control' })
    seedCandidate(db, 'real', { id: 'hidden', is_hidden: 1 })
    seedCandidate(db, 'real', { id: 'inactive', is_active: 0 })
    seedCandidate(db, 'real', { id: 'expired', status: 'expired' })
    seedCandidate(db, 'real', { id: 'broken', link_status: 'broken' })
    seedCandidate(db, 'real', { id: 'quarantined', link_status: 'quarantined' })
    seedCandidate(db, 'real', { id: 'reality-rejected', reality_status: 'rejected' })

    const result = await runQualifiedPipelinePromotion(db, {
      
      batch: 20,
      amountFollowup: false,
    })

    expect(result.promoted).toBe(1)
    expect(result.remaining).toBe(0)
    expect(grantsFor(db, 'real').map((grant) => grant.funding_opportunity_id))
      .toEqual(['active-control'])
    expect(computeSpy).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('promotes the positive-control twin, records tombstoned, and fails closed on tombstone read errors', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    const tombstoned = seedCandidate(db, 'real', { id: 'dismissed' })
    seedCandidate(db, 'real', { id: 'control' })
    await recordDismissal(db, { profileId: 'real', opportunity: tombstoned, reason: 'user_deleted' })

    await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    expect(grantsFor(db, 'real').map((g) => g.funding_opportunity_id)).toEqual(['control'])
    expect(db.prepare("SELECT outcome FROM pipeline_promotion_outcomes WHERE opportunity_id = 'dismissed'").get().outcome).toBe('tombstoned')

    seedCandidate(db, 'real', { id: 'lookup-error' })
    const failingDb = {
      dialect: 'sqlite',
      prepare(sql) {
        if (/FROM pipeline_dismissals/i.test(String(sql))) {
          return { get() { throw new Error('injected tombstone failure') } }
        }
        return db.prepare(sql)
      },
      withTransaction(fn) {
        return db.withTransaction(() => fn(failingDb))
      },
    }
    await runQualifiedPipelinePromotion(failingDb, { batch: 10, amountFollowup: false })
    expect(grantsFor(db, 'real').some((g) => g.funding_opportunity_id === 'lookup-error')).toBe(false)
    expect(db.prepare("SELECT outcome, reason FROM pipeline_promotion_outcomes WHERE opportunity_id = 'lookup-error'").get())
      .toEqual({ outcome: 'error', reason: 'error:transient' })
    db.close()
  })

  it('excludes every Amy marker independently while a real positive-control twin promotes', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedProfile(db, 'created-by', { created_by: 'agent:amy' })
    seedProfile(db, 'tag-only', { tags: ['synthetic'] })
    seedProfile(db, 'flag-only', {}, { synthetic: true })
    seedProfile(db, 'conflicting', {}, { synthetic: false, allow_sam_cleanup: true })
    for (const id of ['real', 'created-by', 'tag-only', 'flag-only', 'conflicting']) seedCandidate(db, id, { id: `candidate-${id}` })

    const result = await runQualifiedPipelinePromotion(db, { batch: 20, amountFollowup: false })

    expect(result.promoted).toBe(1)
    expect(grantsFor(db, 'real')).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n).toBe(1)
    db.close()
  })

  it('computes remaining from durable DB state and terminal duplicates do not recount', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    const duplicate = seedCandidate(db, 'real', { id: 'dup', title: 'Stable Duplicate', url: 'https://example.org/stable' })
    seedCandidate(db, 'real', { id: 'positive' })
    db.prepare(`INSERT INTO grants
      (id, profile_id, funding_opportunity_id, title, funder, status, application_url, url, fingerprint)
      VALUES ('existing', 'real', NULL, ?, ?, 'discovered', ?, ?, ?)`)
      .run(duplicate.title, duplicate.sponsor, duplicate.application_url, duplicate.application_url, grantFingerprintFromOpportunity(duplicate))

    const result = await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    const independentlyRemaining = db.prepare(`SELECT COUNT(*) AS n
      FROM profile_opportunity_matches m
      LEFT JOIN pipeline_promotion_outcomes po
        ON po.profile_id=m.profile_id AND po.opportunity_id=m.opportunity_id AND po.mode='live'
      WHERE NOT EXISTS (SELECT 1 FROM grants g WHERE g.profile_id=m.profile_id AND g.funding_opportunity_id=m.opportunity_id)
        AND (po.outcome IS NULL OR po.outcome NOT IN ('promoted','tombstoned','duplicate','source_excluded','live_reject','below_bar'))`).get().n

    expect(db.prepare("SELECT outcome, reason FROM pipeline_promotion_outcomes WHERE opportunity_id='dup'").get())
      .toEqual({ outcome: 'duplicate', reason: 'duplicate:fingerprint' })
    expect(result.remaining).toBe(independentlyRemaining)
    expect(result.remaining).toBe(0)
    db.close()
  })

  it('counts cooldown errors but not expired terminal duplicates as remaining', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'cooldown-error' })
    db.prepare(`INSERT INTO pipeline_promotion_outcomes
      (profile_id, opportunity_id, mode, outcome, reason, score, attempted_at, attempts,
       profile_facts_hash, policy_version, opportunity_updated_at)
      VALUES ('real', 'cooldown-error', 'live', 'error', 'error:transient', NULL, ?, 1, 'facts', 'policy', '2026-07-01')`)
      .run(new Date().toISOString())
    const profiles = [{ profile: { id: 'real' }, context: { profile: { id: 'real' }, sections: {} } }]

    expect(await __testables.remainingFromDb(db, profiles)).toBe(1)

    db.prepare("DELETE FROM pipeline_promotion_outcomes WHERE opportunity_id='cooldown-error'").run()
    db.prepare("DELETE FROM profile_opportunity_matches WHERE opportunity_id='cooldown-error'").run()
    seedCandidate(db, 'real', { id: 'expired-duplicate' })
    db.prepare(`INSERT INTO pipeline_promotion_outcomes
      (profile_id, opportunity_id, mode, outcome, reason, score, attempted_at, attempts,
       profile_facts_hash, policy_version, opportunity_updated_at)
      VALUES ('real', 'expired-duplicate', 'live', 'duplicate', 'duplicate:fingerprint', 90, ?, 1, 'facts', 'policy', '2026-07-01')`)
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString())

    expect(await __testables.remainingFromDb(db, profiles)).toBe(0)
    db.close()
  })

  it('keeps a live promoted outcome sticky when a stale loser later reports duplicate', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    const candidate = seedCandidate(db, 'real', { id: 'sticky-promoted' })
    await runQualifiedPipelinePromotion(db, { batch: 1, amountFollowup: false })
    const promotedGrant = grantsFor(db, 'real')[0]
    expect(db.prepare("SELECT outcome FROM pipeline_promotion_outcomes WHERE opportunity_id='sticky-promoted'").get().outcome)
      .toBe('promoted')

    db.prepare('DELETE FROM grants WHERE id = ?').run(promotedGrant.id)
    db.prepare(`INSERT INTO grants
      (id, profile_id, funding_opportunity_id, title, funder, status, application_url, url, fingerprint)
      VALUES ('concurrent-winner', 'real', NULL, ?, ?, 'discovered', ?, ?, ?)`)
      .run(candidate.title, candidate.sponsor, candidate.application_url, candidate.application_url, grantFingerprintFromOpportunity(candidate))

    await runQualifiedPipelinePromotion(db, { batch: 1, amountFollowup: false })

    expect(db.prepare("SELECT outcome, reason FROM pipeline_promotion_outcomes WHERE opportunity_id='sticky-promoted'").get())
      .toEqual({ outcome: 'promoted', reason: 'accepted' })
    db.close()
  })

  it('derives UI counts/reasons from live outcomes, including an above-bar source rejection', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'accepted' })
    seedCandidate(db, 'real', { id: 'locator', kind: 'DIRECTORY' })
    seedCandidate(db, 'real', { id: 'denied', source: 'fake_source', storedScore: 99, liveScore: 99 })

    await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    db.prepare("UPDATE pipeline_promotion_outcomes SET outcome='promoted', reason='accepted' WHERE opportunity_id='locator'").run()
    const summary = await getPromotionOutcomeSummary(db, 'real')

    expect(summary).toMatchObject({ qualified: 1, more_places_to_look: 1 })
    expect(summary.reasons.source_excluded).toBe(1)
    expect(db.prepare("SELECT score FROM pipeline_promotion_outcomes WHERE opportunity_id='denied'").get().score).toBe(99)
    expect(computeSpy.mock.calls.map((call) => call[1].id).sort()).toEqual(['accepted', 'denied', 'locator'])
    db.close()
  })

  it('one candidate whose transaction throws is recorded as an error and the run continues (PostgreSQL aborted-transaction class)', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'boom' })
    seedCandidate(db, 'real', { id: 'fine' })
    let calls = 0
    const flakyDb = new Proxy(db, {
      get(target, key) {
        if (key === 'withTransaction') {
          return async (fn) => {
            calls += 1
            if (calls === 1) throw new Error('current transaction is aborted, commands ignored until end of transaction block')
            return target.withTransaction(fn)
          }
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const result = await runQualifiedPipelinePromotion(flakyDb, { batch: 10, amountFollowup: false })

    expect(result.attempted).toBe(2)
    expect(result.promoted).toBe(1)
    expect(grantsFor(db, 'real').map((g) => g.funding_opportunity_id)).toEqual(['fine'])
    const boom = db.prepare("SELECT outcome, reason FROM pipeline_promotion_outcomes WHERE opportunity_id = 'boom'").get()
    expect(boom.outcome).toBe('error')
    expect(boom.reason).toMatch(/^error:transient:current transaction is aborted/)
    db.close()
  })

  it('a profile whose candidate listing throws is skipped this run; the run itself completes', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'unreached' })
    const failingDb = {
      dialect: 'sqlite',
      prepare(sql) {
        if (/FROM profile_opportunity_matches m\s+JOIN funding_opportunities o/i.test(String(sql)) && /LEFT JOIN pipeline_promotion_outcomes po/i.test(String(sql)) && !/COUNT\(\*\)/i.test(String(sql))) {
          return { all() { throw new Error('current transaction is aborted, commands ignored until end of transaction block') } }
        }
        return db.prepare(sql)
      },
      withTransaction(fn) {
        return db.withTransaction(() => fn(failingDb))
      },
    }
    const result = await runQualifiedPipelinePromotion(failingDb, { batch: 10, amountFollowup: false })
    expect(result).toMatchObject({ mode: 'live', attempted: 0, promoted: 0 })
    expect(grantsFor(db, 'real')).toHaveLength(0)
    db.close()
  })

  it('dry-run is REMOVED: naming the old switch fails before any candidate is read', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'never-read' })
    // Even enabled:true is refused — the option no longer exists, and silently
    // accepting it would let a caller believe a "disabled" mode still exists.
    await expect(runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false }))
      .rejects.toThrowError(/removed/)
    await expect(runQualifiedPipelinePromotion(db, { enabled: false, batch: 10, amountFollowup: false }))
      .rejects.toThrowError(/removed/)
    expect(() => assertNoPromotionDryRunOption({}, { ENFORCE_QUALIFIED_PROMOTION: '1' })).toThrowError(/removed/)
    expect(() => assertNoPromotionDryRunOption({}, { ENFORCE_QUALIFIED_PROMOTION: '' })).toThrowError(/removed/)
    expect(() => assertNoPromotionDryRunOption({ batch: 5 }, {})).not.toThrow()
    let status = null
    try { assertNoPromotionDryRunOption({ enabled: false }) } catch (e) { status = e.status }
    expect(status).toBe(400)
    expect(grantsFor(db, 'real')).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(0)
    db.close()
  })

  it('every run is live: legacy dry-run rows are cleared and no projection is left behind', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'late-dry' })
    db.prepare(`INSERT INTO pipeline_promotion_outcomes
      (profile_id, opportunity_id, mode, outcome, reason, score, attempted_at, attempts,
       profile_facts_hash, policy_version, opportunity_updated_at)
      VALUES ('real', 'late-dry', 'dry_run', 'promoted', 'accepted', 90, ?, 1, 'legacy', 'legacy', '2026-07-01')`)
      .run(new Date().toISOString())
    db.prepare("INSERT INTO system_kv (key, value, updated_at) VALUES ('promotion_projection', '{\"projected_rows\":1}', ?)")
      .run(new Date().toISOString())

    const live = await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    expect(live.mode).toBe('live')
    expect(live.deletedDryRun).toBe(1)
    expect(grantsFor(db, 'real')).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes WHERE mode='dry_run'").get().n).toBe(0)
    expect(db.prepare("SELECT outcome FROM pipeline_promotion_outcomes WHERE opportunity_id='late-dry'").get().outcome)
      .toBe('promoted')
    expect(db.prepare("SELECT value FROM system_kv WHERE key='promotion_projection'").get()).toBeUndefined()
    db.close()
  })

  it('cascades SQLite promotion outcomes when either parent row is deleted', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY); CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY);')
    db.exec(fs.readFileSync(path.resolve(process.cwd(), 'backend/db/migrations/150_pipeline_promotion_outcomes.sql'), 'utf8'))
    const insertOutcome = db.prepare(`INSERT INTO pipeline_promotion_outcomes
      (profile_id, opportunity_id, mode, outcome, reason, profile_facts_hash, policy_version, opportunity_updated_at)
      VALUES (?, ?, 'live', 'promoted', 'accepted', 'facts', 'policy', '2026-07-01')`)

    db.prepare("INSERT INTO profiles (id) VALUES ('profile-delete')").run()
    db.prepare("INSERT INTO funding_opportunities (id) VALUES ('opp-profile-delete')").run()
    insertOutcome.run('profile-delete', 'opp-profile-delete')
    db.prepare("DELETE FROM profiles WHERE id='profile-delete'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(0)

    db.prepare("INSERT INTO profiles (id) VALUES ('profile-opp-delete')").run()
    db.prepare("INSERT INTO funding_opportunities (id) VALUES ('opp-delete')").run()
    insertOutcome.run('profile-opp-delete', 'opp-delete')
    db.prepare("DELETE FROM funding_opportunities WHERE id='opp-delete'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM pipeline_promotion_outcomes').get().n).toBe(0)
    db.close()
  })

  it('reopens a terminal outcome when an admission fingerprint drifts', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'drift', liveDecision: 'REJECT' })
    await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    expect(grantsFor(db, 'real')).toHaveLength(0)

    db.prepare("UPDATE funding_opportunities SET test_decision='ACCEPT', live_score=90, updated_at='2026-07-22' WHERE id='drift'").run()
    await runQualifiedPipelinePromotion(db, { batch: 10, amountFollowup: false })
    expect(grantsFor(db, 'real')).toHaveLength(1)
    expect(db.prepare("SELECT outcome FROM pipeline_promotion_outcomes WHERE opportunity_id='drift'").get().outcome).toBe('promoted')
    db.close()
  })

  it('keeps admitToPipeline private to the matcher service and schedules only after listen', () => {
    const root = path.resolve(process.cwd())
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(js|jsx|mjs)$/.test(entry.name)) files.push(full)
      }
    }
    walk(path.join(root, 'backend'))
    const illegal = files
      .filter((file) => !file.endsWith(path.join('services', 'opportunityMatcher.js')))
      .filter((file) => /import[\s\S]{0,200}\badmitToPipeline\b/.test(fs.readFileSync(file, 'utf8')))
    expect(illegal).toEqual([])

    const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8')
    const listen = server.indexOf("server.on('listening'")
    const promotion = server.indexOf('runQualifiedPipelinePromotion', listen)
    const immediate = server.indexOf('setImmediate', listen)
    expect(listen).toBeGreaterThan(-1)
    expect(immediate).toBeGreaterThan(listen)
    expect(promotion).toBeGreaterThan(immediate)
  })

  it('routes post-listen and nightly promotion through one lock-and-marker wrapper', () => {
    const server = fs.readFileSync(path.resolve(process.cwd(), 'backend', 'server.js'), 'utf8')
    const postListenStart = server.indexOf('app.locals.runQualifiedPipelinePromotion =')
    const postListenEnd = server.indexOf('\n  // Register the lead sources', postListenStart)
    const nightlyStart = server.indexOf('function scheduleQualifiedPipelinePromotion')
    const nightlyEnd = server.indexOf('\n  // Sam\'s daily FULL code/function sweep', nightlyStart)

    expect(postListenStart).toBeGreaterThan(-1)
    expect(nightlyStart).toBeGreaterThan(-1)
    expect(server.slice(postListenStart, postListenEnd)).toContain('runScheduledQualifiedPipelinePromotion')
    expect(server.slice(nightlyStart, nightlyEnd)).toContain('runScheduledQualifiedPipelinePromotion')
  })
})
