/**
 * Regression + behavior tests for backend/startup/enforceInvariants.js —
 * the canonical product-invariant enforcement choke point.
 *
 * These tests are the GUARD that makes the invariants rule-by-construction:
 * each canonical_rules.md invariant has a test that proves the boot sweep
 * actually re-asserts it, so a future code path that re-introduces a
 * violation is caught here instead of in production.
 *
 * Invariants covered:
 *   1. Sticky deletes — a dismissed (tombstoned) grant cannot survive the
 *      sweep, no matter how it was re-inserted, and a tombstone in one profile
 *      NEVER deletes another profile's grant.
 *   2. No cross-profile / cross-tenant bleed — a grant whose organization_id
 *      disagrees with its profile's organization_id is re-aligned.
 *   3. No duplicate grants — within a profile, duplicate grants (same opp-id,
 *      fingerprint, or title+funder) collapse to ONE best survivor; never
 *      across profiles.
 *   4. Relevance floor — below-floor discovery grants are PURGED by default,
 *      while NULL scores, user-progressed (protected-status) grants, and
 *      MTSU/portal-named rows are never touched; ENFORCE_RELEVANCE_FLOOR=0
 *      disables the purge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import {
  runEnforceInvariants,
  enforceStickyDeletes,
  enforceNoCrossProfileBleed,
  enforceNoDuplicateGrants,
  enforceRelevanceFloor,
  enforceProfileScopedPipeline,
  getRelevanceFloor,
  __resetFloorCache,
  RELEVANCE_FLOOR,
  PROTECTED_PIPELINE_STATUSES,
} from '../startup/enforceInvariants.js'
import { recordDismissal } from '../services/pipelineDismissals.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT NOT NULL,
      funder TEXT,
      status TEXT DEFAULT 'discovered',
      match_score INTEGER,
      amount_awarded NUMERIC,
      fingerprint TEXT,
      url TEXT,
      application_url TEXT,
      source_url TEXT
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT
    );
  `)
  // better-sqlite3 is synchronous; the enforcement module awaits results,
  // and awaiting a non-promise simply resolves to its value — so the raw
  // handle is a valid stand-in for the async prod db wrapper here.
  return raw
}

function insertProfile(db, { id, orgId }) {
  db.prepare('INSERT INTO profiles (id, organization_id) VALUES (?, ?)').run(id, orgId)
}

function insertGrant(db, g) {
  const id = g.id || crypto.randomUUID()
  db.prepare(
    `INSERT INTO grants (id, created_at, organization_id, profile_id, funding_opportunity_id, title, funder, status, match_score, amount_awarded, fingerprint)
     VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    g.created_at ?? null,
    g.organization_id ?? null,
    g.profile_id ?? null,
    g.funding_opportunity_id ?? null,
    g.title ?? 'Grant',
    g.funder ?? null,
    g.status ?? 'discovered',
    g.match_score ?? null,
    g.amount_awarded ?? null,
    g.fingerprint ?? null,
  )
  return id
}

function count(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)
}

function ids(db) {
  return db.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)
}

describe('enforceInvariants — sticky deletes', () => {
  it('purges a grant that matches a recorded dismissal (cannot be re-inserted)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })

    // User dismisses an opportunity for profile p1.
    await recordDismissal(db, {
      profileId: 'p1',
      opportunity: { id: 'opp-1', title: 'Dead Grant', sponsor: 'X' },
    })

    // A rogue code path re-inserts it into the pipeline.
    insertGrant(db, {
      profile_id: 'p1',
      organization_id: 'org1',
      funding_opportunity_id: 'opp-1',
      title: 'Dead Grant',
      match_score: 90,
    })
    expect(count(db)).toBe(1)

    const res = await enforceStickyDeletes(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1)
    expect(count(db)).toBe(0)
  })

  it('a tombstone in one profile never deletes another profile\'s grant', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertProfile(db, { id: 'p2', orgId: 'org2' })

    await recordDismissal(db, {
      profileId: 'p1',
      opportunity: { id: 'opp-1', title: 'Shared Title', sponsor: 'X' },
    })

    // Same title/opp, but belongs to a DIFFERENT profile — must survive.
    insertGrant(db, {
      profile_id: 'p2',
      organization_id: 'org2',
      funding_opportunity_id: 'opp-1',
      title: 'Shared Title',
      match_score: 90,
    })

    const res = await enforceStickyDeletes(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })
})

describe('enforceInvariants — no cross-profile / cross-tenant bleed', () => {
  it('re-aligns a grant whose org disagrees with its profile org', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'orgCORRECT' })
    const gid = insertGrant(db, {
      profile_id: 'p1',
      organization_id: 'orgWRONG', // bleed: belongs to another tenant
      title: 'Bled Grant',
      match_score: 80,
    })

    const res = await enforceNoCrossProfileBleed(db)
    expect(res.ok).toBe(true)
    expect(res.quarantined).toBe(1)

    const row = db.prepare('SELECT organization_id FROM grants WHERE id = ?').get(gid)
    expect(row.organization_id).toBe('orgCORRECT')
  })

  it('leaves correctly-tenanted grants untouched', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'OK', match_score: 80 })

    const res = await enforceNoCrossProfileBleed(db)
    expect(res.quarantined).toBe(0)
  })

  it('does not touch grants whose profile has no known org (neutral, G4)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: null })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'orgX', title: 'Keep', match_score: 80 })

    const res = await enforceNoCrossProfileBleed(db)
    expect(res.quarantined).toBe(0)
    const row = db.prepare('SELECT organization_id FROM grants WHERE id = ?').get(gid)
    expect(row.organization_id).toBe('orgX')
  })
})

describe('enforceInvariants — no duplicate grants', () => {
  it('collapses duplicates in one profile to a single best-kept row (same funding_opportunity_id)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })

    // Three rows that are the SAME opportunity for p1. Best survivor by rule:
    // most-progressed status first (drafting > discovered), so the "interested"
    // one is NOT here; tie-break oldest. Here a drafting row should win.
    const oldDiscovered = insertGrant(db, {
      id: 'g-old',
      profile_id: 'p1',
      organization_id: 'org1',
      funding_opportunity_id: 'opp-1',
      title: 'Dup Grant',
      funder: 'NIH',
      status: 'discovered',
      match_score: 70,
      created_at: '2024-01-01 00:00:00',
    })
    const worked = insertGrant(db, {
      id: 'g-worked',
      profile_id: 'p1',
      organization_id: 'org1',
      funding_opportunity_id: 'opp-1',
      title: 'Dup Grant',
      funder: 'NIH',
      status: 'drafting', // user-progressed → most-progressed → wins
      match_score: 70,
      created_at: '2024-06-01 00:00:00',
    })
    insertGrant(db, {
      id: 'g-new',
      profile_id: 'p1',
      organization_id: 'org1',
      funding_opportunity_id: 'opp-1',
      title: 'Dup Grant',
      funder: 'NIH',
      status: 'discovered',
      match_score: 70,
      created_at: '2024-12-01 00:00:00',
    })
    expect(count(db)).toBe(3)

    const res = await enforceNoDuplicateGrants(db)
    expect(res.ok).toBe(true)
    expect(res.duplicatesRemoved).toBe(2)
    expect(res.profilesAffected).toBe(1)
    expect(ids(db)).toEqual([worked])
    expect(oldDiscovered).toBeTruthy()
  })

  it('treats same lower(title)+lower(funder) as duplicates and keeps the oldest when status ties', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const oldest = insertGrant(db, {
      id: 'g-a',
      profile_id: 'p1',
      organization_id: 'org1',
      title: 'Community Health Fund',
      funder: 'HRSA',
      status: 'discovered',
      match_score: 80,
      created_at: '2024-01-01 00:00:00',
    })
    insertGrant(db, {
      id: 'g-b',
      profile_id: 'p1',
      organization_id: 'org1',
      title: 'community health FUND', // case-insensitive dupe
      funder: 'hrsa',
      status: 'discovered',
      match_score: 80,
      created_at: '2024-02-01 00:00:00',
    })

    const res = await enforceNoDuplicateGrants(db)
    expect(res.duplicatesRemoved).toBe(1)
    expect(ids(db)).toEqual([oldest])
  })

  it('never merges duplicates across different profiles', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertProfile(db, { id: 'p2', orgId: 'org2' })
    insertGrant(db, {
      profile_id: 'p1',
      organization_id: 'org1',
      funding_opportunity_id: 'opp-1',
      title: 'Same Opp',
      funder: 'NIH',
    })
    insertGrant(db, {
      profile_id: 'p2',
      organization_id: 'org2',
      funding_opportunity_id: 'opp-1',
      title: 'Same Opp',
      funder: 'NIH',
    })

    const res = await enforceNoDuplicateGrants(db)
    expect(res.duplicatesRemoved).toBe(0)
    expect(count(db)).toBe(2)
  })

  it('is idempotent — a second pass removes nothing', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', fingerprint: 'fp-1', title: 'A' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', fingerprint: 'fp-1', title: 'B' })

    const first = await enforceNoDuplicateGrants(db)
    expect(first.duplicatesRemoved).toBe(1)
    const second = await enforceNoDuplicateGrants(db)
    expect(second.duplicatesRemoved).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('prefers a non-null match_score when status and age tie', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, {
      id: 'g-null',
      profile_id: 'p1',
      organization_id: 'org1',
      fingerprint: 'fp-x',
      title: 'A',
      status: 'discovered',
      match_score: null,
      created_at: '2024-01-01 00:00:00',
    })
    const scored = insertGrant(db, {
      id: 'g-scored',
      profile_id: 'p1',
      organization_id: 'org1',
      fingerprint: 'fp-x',
      title: 'A',
      status: 'discovered',
      match_score: 88,
      created_at: '2024-01-01 00:00:00',
    })
    const res = await enforceNoDuplicateGrants(db)
    expect(res.duplicatesRemoved).toBe(1)
    expect(ids(db)).toEqual([scored])
  })
})

describe('enforceInvariants — relevance floor', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
    __resetFloorCache()
  })
  afterEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
    __resetFloorCache()
  })

  it('resolves a numeric floor with a recorded source (from the shared config)', async () => {
    const { value, source } = await getRelevanceFloor()
    expect(Number.isFinite(value)).toBe(true)
    expect(typeof source).toBe('string')
    // backend/config/relevanceFloor.js is now present (merged) → resolves from it.
    expect(value).toBe(55)
    expect(source).toMatch(/config\/relevanceFloor\.js/)
  })

  it('PURGES below-floor discovery grants by DEFAULT (no opt-in needed)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const { value: floor } = await getRelevanceFloor()
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: floor - 1, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)
    expect(count(db)).toBe(0)
  })

  it('does NOT purge when ENFORCE_RELEVANCE_FLOOR=0 (explicit disable)', async () => {
    process.env.ENFORCE_RELEVANCE_FLOOR = '0'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const { value: floor } = await getRelevanceFloor()
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: floor - 1, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.enforced).toBe(false)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('never touches NULL match_score (no score is not junk; G4)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Manual', match_score: null, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('never touches user-progressed grants even below the floor (protected status)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    for (const status of ['submitted', 'awarded', 'pending_review', 'gathering_documents', 'drafting']) {
      insertGrant(db, {
        profile_id: 'p1',
        organization_id: 'org1',
        title: `Working ${status}`,
        match_score: 1,
        status,
      })
    }
    expect(PROTECTED_PIPELINE_STATUSES).toContain('submitted')
    expect(PROTECTED_PIPELINE_STATUSES).toContain('gathering_documents')

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(5)
  })

  it('never deletes MTSU / portal-named rows even when below floor & discovered', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const { value: floor } = await getRelevanceFloor()
    insertGrant(db, { id: 'm1', profile_id: 'p1', organization_id: 'org1', title: 'MTSU Research Award', match_score: floor - 5, status: 'discovered' })
    insertGrant(db, { id: 'm2', profile_id: 'p1', organization_id: 'org1', title: 'Middle Tennessee State University grant', match_score: floor - 5, status: 'discovered' })
    insertGrant(db, { id: 'm3', profile_id: 'p1', organization_id: 'org1', title: 'Generic award', funder: 'TN Portal System', match_score: floor - 5, status: 'discovered' })
    // A genuine junk row alongside, to prove the purge still fires for non-protected names.
    insertGrant(db, { id: 'junk', profile_id: 'p1', organization_id: 'org1', title: 'Random low score', match_score: floor - 5, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(1)
    expect(ids(db).sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('does not delete rows in an unrecognized (non-discovery) status', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const { value: floor } = await getRelevanceFloor()
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Weird', match_score: floor - 1, status: 'some_future_status' })

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })
})

describe('enforceInvariants — profile-scoped pipeline (orphan purge)', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_PROFILE_SCOPED_PIPELINE
  })
  afterEach(() => {
    delete process.env.ENFORCE_PROFILE_SCOPED_PIPELINE
  })

  it('purges orphan profile-less grants by DEFAULT (the org-PDF leak source)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    // Curated, profile-attached grant — must survive.
    insertGrant(db, { id: 'keep', profile_id: 'p1', organization_id: 'org1', title: 'Real pipeline item', status: 'pending_review' })
    // Orphans with the SAME org but no profile — the rows the org-scoped print
    // surfaced and the user could never delete from the board.
    insertGrant(db, { id: 'orphan1', profile_id: null, organization_id: 'org1', title: 'Food Bank near X', status: 'discovered' })
    insertGrant(db, { id: 'orphan2', profile_id: null, organization_id: 'org1', title: 'United Way near Y', status: 'deadline_passed' })
    insertGrant(db, { id: 'orphan3', profile_id: null, organization_id: 'org1', title: 'Auto-advanced junk', status: 'submitted' })

    const res = await enforceProfileScopedPipeline(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(3)
    expect(ids(db)).toEqual(['keep'])
  })

  it('preserves an orphan that records a real AWARD (amount_awarded > 0)', async () => {
    const db = makeDb()
    // No profile, but real money — never collateral damage.
    insertGrant(db, { id: 'awarded', profile_id: null, organization_id: 'org1', title: 'Org-level awarded grant', status: 'awarded', amount_awarded: 25000 })
    insertGrant(db, { id: 'junk', profile_id: null, organization_id: 'org1', title: 'No-money discovery', status: 'discovered' })

    const res = await enforceProfileScopedPipeline(db)
    expect(res.repaired).toBe(1)
    expect(ids(db)).toEqual(['awarded'])
  })

  it('does NOT purge when ENFORCE_PROFILE_SCOPED_PIPELINE=0 (explicit disable)', async () => {
    process.env.ENFORCE_PROFILE_SCOPED_PIPELINE = '0'
    const db = makeDb()
    insertGrant(db, { id: 'orphan', profile_id: null, organization_id: 'org1', title: 'Orphan', status: 'discovered' })

    const res = await enforceProfileScopedPipeline(db)
    expect(res.enforced).toBe(false)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('never touches profile-attached grants (only orphans are in scope)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { id: 'a', profile_id: 'p1', organization_id: 'org1', title: 'Discovered but owned', status: 'discovered' })
    insertGrant(db, { id: 'b', profile_id: 'p1', organization_id: 'org1', title: 'Expired but owned', status: 'deadline_passed' })

    const res = await enforceProfileScopedPipeline(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(2)
  })
})

describe('enforceInvariants — runner', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
    __resetFloorCache()
  })
  afterEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
    __resetFloorCache()
  })

  it('runs every invariant, never throws, and returns a structured summary', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Clean', match_score: 90 })

    const summary = await runEnforceInvariants(db, { logger: { info() {}, warn() {} } })
    expect(summary.ran).toBe(5)
    expect(summary.failed).toBe(0)
    expect(summary.steps.map((s) => s.name)).toEqual([
      'sticky_deletes',
      'no_cross_profile_bleed',
      'profile_scoped_pipeline',
      'no_duplicate_grants',
      'relevance_floor',
    ])
  })

  it('is a no-op on a clean DB (idempotent / safe to re-run every boot)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Clean', match_score: 90 })

    const a = await runEnforceInvariants(db, { logger: { info() {}, warn() {} } })
    const b = await runEnforceInvariants(db, { logger: { info() {}, warn() {} } })
    expect(a.totalRepaired).toBe(0)
    expect(b.totalRepaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('returns empty result for a missing db handle (no crash at boot)', async () => {
    const summary = await runEnforceInvariants(null, { logger: { info() {}, warn() {} } })
    expect(summary.ran).toBe(0)
  })
})
