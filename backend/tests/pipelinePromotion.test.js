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
  getPromotionOutcomeSummary,
  runQualifiedPipelinePromotion,
} from '../services/pipelinePromotion.js'
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
      profile_id TEXT, source_trust_tier TEXT, test_decision TEXT, live_score REAL
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      match_score REAL, match_decision TEXT, matcher_version TEXT, updated_at TEXT
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
     opportunity_kind, is_active, test_decision, live_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rolling', ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      id, '2026-07-01', overrides.updated_at || '2026-07-01', title,
      overrides.sponsor || 'Community Foundation', overrides.source || 'grants_gov',
      overrides.record_origin || 'curated_verified',
      overrides.description || 'Emergency housing assistance for individuals and families in need.',
      overrides.amount_min ?? null, overrides.amount_max ?? null,
      overrides.url || `https://example.org/${id}`, overrides.url || `https://example.org/${id}`,
      JSON.stringify(['emergency', 'housing']), overrides.kind || 'DIRECT_GRANT',
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
    score: Number(opp.live_score ?? 90),
    reasons: ['fresh live score'],
    ineligibilityReasons: opp.test_decision === 'REJECT' ? ['live policy rejected'] : [],
    explanation: 'test decision',
    matchedNeeds: ['housing'],
    matcherVersion: 'test-live',
    evaluatedAt: '2026-07-21T00:00:00Z',
    confidence: 0.9,
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
      enabled: true,
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

    const result = await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })

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

    await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })

    expect(grantsFor(db, 'real')).toHaveLength(0)
    expect(db.prepare('SELECT outcome, reason FROM pipeline_promotion_outcomes').get()).toEqual({ outcome: 'live_reject', reason: 'live_reject' })
    expect(computeSpy).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('promotes the positive-control twin, records tombstoned, and fails closed on tombstone read errors', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    const tombstoned = seedCandidate(db, 'real', { id: 'dismissed' })
    seedCandidate(db, 'real', { id: 'control' })
    await recordDismissal(db, { profileId: 'real', opportunity: tombstoned, reason: 'user_deleted' })

    await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
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
    await runQualifiedPipelinePromotion(failingDb, { enabled: true, batch: 10, amountFollowup: false })
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

    const result = await runQualifiedPipelinePromotion(db, { enabled: true, batch: 20, amountFollowup: false })

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

    const result = await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
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

  it('derives UI counts/reasons from live outcomes, including an above-bar source rejection', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'accepted' })
    seedCandidate(db, 'real', { id: 'locator', kind: 'DIRECTORY' })
    seedCandidate(db, 'real', { id: 'denied', source: 'fake_source', storedScore: 99, liveScore: 99 })

    await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
    db.prepare("UPDATE pipeline_promotion_outcomes SET outcome='promoted', reason='accepted' WHERE opportunity_id='locator'").run()
    const summary = await getPromotionOutcomeSummary(db, 'real')

    expect(summary).toMatchObject({ qualified: 1, more_places_to_look: 1 })
    expect(summary.reasons.source_excluded).toBe(1)
    expect(db.prepare("SELECT score FROM pipeline_promotion_outcomes WHERE opportunity_id='denied'").get().score).toBe(99)
    expect(computeSpy.mock.calls.map((call) => call[1].id).sort()).toEqual(['accepted', 'denied', 'locator'])
    db.close()
  })

  it('isolates dry-run rows and deletes them before live enablement', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'projected' })

    const dry = await runQualifiedPipelinePromotion(db, { enabled: false, batch: 10, amountFollowup: false })
    expect(dry.mode).toBe('dry_run')
    expect(grantsFor(db, 'real')).toHaveLength(0)
    expect(db.prepare('SELECT mode FROM pipeline_promotion_outcomes').get().mode).toBe('dry_run')
    expect(JSON.parse(db.prepare("SELECT value FROM system_kv WHERE key='promotion_projection'").get().value))
      .toMatchObject({ projected_rows: 1, projected_null_amounts: 1 })

    const live = await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
    expect(live.deletedDryRun).toBe(1)
    expect(grantsFor(db, 'real')).toHaveLength(1)
    expect(db.prepare('SELECT mode FROM pipeline_promotion_outcomes').get().mode).toBe('live')
    db.close()
  })

  it('reopens a terminal outcome when an admission fingerprint drifts', async () => {
    const db = makeDb()
    seedProfile(db, 'real')
    seedCandidate(db, 'real', { id: 'drift', liveDecision: 'REJECT' })
    await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
    expect(grantsFor(db, 'real')).toHaveLength(0)

    db.prepare("UPDATE funding_opportunities SET test_decision='ACCEPT', live_score=90, updated_at='2026-07-22' WHERE id='drift'").run()
    await runQualifiedPipelinePromotion(db, { enabled: true, batch: 10, amountFollowup: false })
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
})
