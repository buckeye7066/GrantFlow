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
  enforceIndividualAmountCeiling,
  enforceStudentAidEligibility,
  enforceProfileEligibility,
  enforceFunderBackfill,
  resolveIndividualAmountCeiling,
  enforceProfileScopedPipeline,
  enforceProfileDisplayNameNotDoubled,
  enforceProfileIncomeReconciliation,
  enforceProfileIdIntegrity,
  enforceNoSearchEngineApplicationTargets,
  getRelevanceFloor,
  __resetFloorCache,
  RELEVANCE_FLOOR,
  PROTECTED_PIPELINE_STATUSES,
  __testables,
} from '../startup/enforceInvariants.js'
import { recordDismissal } from '../services/pipelineDismissals.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'

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
      amount_requested NUMERIC,
      fingerprint TEXT,
      url TEXT,
      application_url TEXT,
      source_url TEXT
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      display_name TEXT,
      primary_type TEXT,
      applicant_type TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  // better-sqlite3 is synchronous; the enforcement module awaits results,
  // and awaiting a non-promise simply resolves to its value — so the raw
  // handle is a valid stand-in for the async prod db wrapper here.
  return raw
}

function insertProfile(db, { id, orgId, primaryType = null, applicantType = null }) {
  db.prepare(
    'INSERT INTO profiles (id, organization_id, primary_type, applicant_type) VALUES (?, ?, ?, ?)',
  ).run(id, orgId, primaryType, applicantType)
}

function insertGrant(db, g) {
  const id = g.id || crypto.randomUUID()
  db.prepare(
    `INSERT INTO grants (id, created_at, organization_id, profile_id, funding_opportunity_id, title, funder, status, match_score, amount_awarded, amount_requested, fingerprint, url)
     VALUES (?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    g.amount_requested ?? null,
    g.fingerprint ?? null,
    g.url ?? null,
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

  it('treats same lower(title)+lower(funder)+corroborator as duplicates and keeps the oldest when status ties', async () => {
    // NOTE: the title+funder dedup key is now STRENGTHENED (recall guard): it
    // requires a NON-EMPTY funder AND one more agreeing field (amount, deadline,
    // or url-host) before merging. These two rows share a url host, so they are
    // still recognized as the same program and collapse to one survivor.
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
      url: 'https://hrsa.gov/community-health-fund',
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
      url: 'https://hrsa.gov/community-health-fund',
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
    // Need-anchored scale (2026-07-06): insert floor = 20.
    expect(value).toBe(20)
    expect(source).toMatch(/config\/relevanceFloor\.js/)
  })

  it('PURGES below-floor discovery grants by DEFAULT (no opt-in needed)', async () => {
    // The boot purge uses the LENIENT floor (min(insertFloor, 12)) so it can
    // never delete a row the insert gate admitted. A clearly-junk 8 is below
    // that lenient floor and is purged.
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: 8, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)
    expect(count(db)).toBe(0)
  })

  it('does NOT purge a 12–19 row the insert gate would admit (lenient purge floor)', async () => {
    // Regression for the audit's "floor collapse": purge floor must be <= insert
    // floor, so a 15 (below the 20 insert floor but at/above the 12 purge floor —
    // e.g. a trusted-origin row admitted at the 12 trusted floor)
    // is NOT destroyed by the boot net.
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Borderline', match_score: 15, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('does NOT purge when ENFORCE_RELEVANCE_FLOOR=0 (explicit disable)', async () => {
    process.env.ENFORCE_RELEVANCE_FLOOR = '0'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: 8, status: 'discovered' })

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
    insertGrant(db, { id: 'm1', profile_id: 'p1', organization_id: 'org1', title: 'MTSU Research Award', match_score: 8, status: 'discovered' })
    insertGrant(db, { id: 'm2', profile_id: 'p1', organization_id: 'org1', title: 'Middle Tennessee State University grant', match_score: 8, status: 'discovered' })
    insertGrant(db, { id: 'm3', profile_id: 'p1', organization_id: 'org1', title: 'Generic award', funder: 'TN Portal System', match_score: 8, status: 'discovered' })
    // A genuine junk row alongside, to prove the purge still fires for non-protected names.
    insertGrant(db, { id: 'junk', profile_id: 'p1', organization_id: 'org1', title: 'Random low score', match_score: 8, status: 'discovered' })

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

describe('enforceInvariants — individual amount ceiling', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_INDIVIDUAL_AMOUNT_CEILING
    delete process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING
  })
  afterEach(() => {
    delete process.env.ENFORCE_INDIVIDUAL_AMOUNT_CEILING
    delete process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING
  })

  it('resolves the default ceiling ($100k) and honors the env override', () => {
    expect(resolveIndividualAmountCeiling()).toBe(100000)
    process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING = '250000'
    expect(resolveIndividualAmountCeiling()).toBe(250000)
    process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING = 'garbage'
    expect(resolveIndividualAmountCeiling()).toBe(100000)
  })

  it('purges an institutional-scale grant mis-matched into a STUDENT pipeline (the >$3M bug)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    // A $650k NSF institutional research grant, NULL match_score (funding_api),
    // in an early status — exactly the row that inflated Robert's total.
    insertGrant(db, {
      id: 'nsf',
      profile_id: 'p1',
      organization_id: 'org1',
      title: 'RUI: Protein-Protein Interactions of Protein Kinase C',
      funder: 'NSF',
      status: 'interested',
      match_score: null,
      amount_requested: 650000,
    })
    // A realistic student scholarship — must survive.
    insertGrant(db, {
      id: 'schol',
      profile_id: 'p1',
      organization_id: 'org1',
      title: 'NAEMT EMS Scholarship',
      status: 'interested',
      amount_requested: 5000,
    })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)
    expect(ids(db)).toEqual(['schol'])
  })

  it('NEVER touches an organization/business profile (large grant asks are legitimate)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'org', orgId: 'org1', primaryType: 'nonprofit' })
    insertGrant(db, { id: 'big', profile_id: 'org', organization_id: 'org1', title: 'Capacity Building Grant', status: 'interested', amount_requested: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('never touches user-progressed (protected-status) grants even above the ceiling', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'sub', profile_id: 'p1', organization_id: 'org1', title: 'Big submitted', status: 'submitted', amount_requested: 650000 })
    insertGrant(db, { id: 'awd', profile_id: 'p1', organization_id: 'org1', title: 'Big awarded', status: 'awarded', amount_requested: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(2)
  })

  it('preserves a row that records a real AWARD (amount_awarded > 0) even if large', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'realmoney', profile_id: 'p1', organization_id: 'org1', title: 'Big but real', status: 'interested', amount_requested: 650000, amount_awarded: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(ids(db)).toEqual(['realmoney'])
  })

  it('never deletes an at/below-ceiling grant (boundary)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'atceil', profile_id: 'p1', organization_id: 'org1', title: 'At ceiling', status: 'interested', amount_requested: 100000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('never touches MTSU/portal-named rows even above the ceiling', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'mtsu', profile_id: 'p1', organization_id: 'org1', title: 'MTSU Portal Award', status: 'interested', amount_requested: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('does NOT purge when ENFORCE_INDIVIDUAL_AMOUNT_CEILING=0 (explicit disable → count-only)', async () => {
    process.env.ENFORCE_INDIVIDUAL_AMOUNT_CEILING = '0'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'nsf', profile_id: 'p1', organization_id: 'org1', title: 'Big NSF', status: 'interested', amount_requested: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.enforced).toBe(false)
    expect(res.scanned).toBe(1)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('does not touch an unknown-type profile (conservative: not individual)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: null })
    insertGrant(db, { id: 'x', profile_id: 'p1', organization_id: 'org1', title: 'Big unknown', status: 'interested', amount_requested: 650000 })

    const res = await enforceIndividualAmountCeiling(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('is idempotent — a second pass removes nothing', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1', primaryType: 'student' })
    insertGrant(db, { id: 'nsf', profile_id: 'p1', organization_id: 'org1', title: 'Big NSF', status: 'interested', amount_requested: 650000 })

    const first = await enforceIndividualAmountCeiling(db)
    expect(first.repaired).toBe(1)
    const second = await enforceIndividualAmountCeiling(db)
    expect(second.repaired).toBe(0)
    expect(count(db)).toBe(0)
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

// ─────────────────────────────────────────────────────────────────────────────
// INCOME RECONCILIATION — one canonical income per individual profile.
// Profiles store income in profile_sections; the SAME field can land in two
// sections ('financial' vs 'financial_information') with conflicting values
// (a captured parent income vs the student's own). The sweep collapses them to
// the applicant's own (need-consistent / lower) figure for INDIVIDUAL profiles,
// never touches orgs, and FLAGS (doesn't guess) when the conflict is ambiguous.
// ─────────────────────────────────────────────────────────────────────────────
function makeProfileDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      primary_type TEXT,
      applicant_type TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return raw
}

function insertTypedProfile(db, { id, primaryType = null, applicantType = null }) {
  db.prepare(
    'INSERT INTO profiles (id, primary_type, applicant_type) VALUES (?, ?, ?)',
  ).run(id, primaryType, applicantType)
}

function setSection(db, profileId, sectionKey, data) {
  db.prepare(
    'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
  ).run(profileId, sectionKey, JSON.stringify(data))
}

function getSection(db, profileId, sectionKey) {
  const row = db
    .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get(profileId, sectionKey)
  return row ? JSON.parse(row.data) : null
}

describe('enforceProfileIncomeReconciliation', () => {
  it('keeps the applicant-own (lower) income for an individual with need flags — the canonical bug', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'student' })
    // Inflated parent income captured into the legacy 'financial' section.
    setSection(db, 'p1', 'financial', { household_income: '$310,000' })
    // Student's own income + need flags in the canonical section.
    setSection(db, 'p1', 'financial_information', {
      household_income: 28000,
      low_income: true,
      household_size: 5,
    })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(1)
    expect(res.flagged).toBe(0)
    // Both sections now agree on the applicant's own (lower) income.
    expect(getSection(db, 'p1', 'financial_information').household_income).toBe(28000)
    expect(getSection(db, 'p1', 'financial').household_income).toBe(28000)
    // Need flag preserved / kept truthful.
    expect(getSection(db, 'p1', 'financial_information').low_income).toBe(true)
    expect(getSection(db, 'p1', 'financial').low_income).toBe(true)
    // Untouched fields survive.
    expect(getSection(db, 'p1', 'financial_information').household_size).toBe(5)
  })

  it('reconciles when the inflated value is in the canonical section instead', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', applicantType: 'individual' })
    setSection(db, 'p1', 'financial_information', { household_income: 310000 })
    setSection(db, 'p1', 'financial', { household_income: 22000, low_income: true })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(1)
    expect(getSection(db, 'p1', 'financial_information').household_income).toBe(22000)
    expect(getSection(db, 'p1', 'financial_information').low_income).toBe(true)
  })

  it('NEVER touches an organization/business profile (high revenue is legitimate)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'org1', primaryType: 'business' })
    setSection(db, 'org1', 'financial', { household_income: '$2,000,000' })
    setSection(db, 'org1', 'financial_information', { household_income: 500000 })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(0)
    expect(getSection(db, 'org1', 'financial').household_income).toBe('$2,000,000')
    expect(getSection(db, 'org1', 'financial_information').household_income).toBe(500000)
  })

  it('FLAGS (does not change) an individual conflict with NO need signal — left for human review', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'individual' })
    // Two comfortable incomes, nothing marks need → genuinely ambiguous.
    setSection(db, 'p1', 'financial', { household_income: 180000 })
    setSection(db, 'p1', 'financial_information', { household_income: 95000 })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(0)
    expect(res.flagged).toBe(1)
    // Data left untouched for a human.
    expect(getSection(db, 'p1', 'financial').household_income).toBe(180000)
    expect(getSection(db, 'p1', 'financial_information').household_income).toBe(95000)
  })

  it('is a no-op when the two sections already agree (no contradiction)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'student' })
    setSection(db, 'p1', 'financial', { household_income: 28000 })
    setSection(db, 'p1', 'financial_information', { household_income: 28000, low_income: true })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(0)
    expect(res.scanned).toBe(0)
  })

  it('is a no-op when only one financial section exists', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'student' })
    setSection(db, 'p1', 'financial_information', { household_income: 28000, low_income: true })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(0)
    expect(res.scanned).toBe(0)
  })

  it('uses annual_income as the income figure when household_income is absent', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'student' })
    setSection(db, 'p1', 'financial', { household_income: 200000 })
    setSection(db, 'p1', 'financial_information', { annual_income: 18000, low_income: true })

    const res = await enforceProfileIncomeReconciliation(db)
    expect(res.repaired).toBe(1)
    // Canonical household_income is set to the reconciled own income.
    expect(getSection(db, 'p1', 'financial_information').household_income).toBe(18000)
  })

  it('is idempotent (a second run repairs nothing)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'student' })
    setSection(db, 'p1', 'financial', { household_income: '$310,000' })
    setSection(db, 'p1', 'financial_information', { household_income: 28000, low_income: true })

    const first = await enforceProfileIncomeReconciliation(db)
    expect(first.repaired).toBe(1)
    const second = await enforceProfileIncomeReconciliation(db)
    expect(second.repaired).toBe(0)
  })

  it('degrades silently when profile_sections is absent (no crash at boot)', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, primary_type TEXT, applicant_type TEXT);')
    raw.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'student')
    const res = await enforceProfileIncomeReconciliation(raw)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(0)
  })

  it('classifies and parses money correctly (unit guards)', () => {
    expect(__testables.isIndividualProfileType('student')).toBe(true)
    expect(__testables.isIndividualProfileType('individual')).toBe(true)
    expect(__testables.isIndividualProfileType('veteran')).toBe(true)
    expect(__testables.isIndividualProfileType('business')).toBe(false)
    expect(__testables.isIndividualProfileType('nonprofit')).toBe(false)
    expect(__testables.isIndividualProfileType('totally_unknown_type')).toBe(false)
    expect(__testables.parseIncomeValue('$310,000')).toBe(310000)
    expect(__testables.parseIncomeValue('28000')).toBe(28000)
    expect(__testables.parseIncomeValue(28000)).toBe(28000)
    expect(__testables.parseIncomeValue('')).toBe(null)
    expect(__testables.parseIncomeValue(null)).toBe(null)
    expect(__testables.parseIncomeValue('not money')).toBe(null)
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
    expect(summary.ran).toBe(18)
    expect(summary.failed).toBe(0)
    expect(summary.steps.map((s) => s.name)).toEqual([
      'sticky_deletes',
      'profile_id_integrity',
      'no_cross_profile_bleed',
      'profile_scoped_pipeline',
      'no_duplicate_grants',
      'relevance_floor',
      'grant_amount_backfill',
      'individual_amount_ceiling',
      'student_aid_eligibility',
      'no_dangling_matches',
      'profession_eligibility',
      'funder_backfill',
      'profile_display_name_not_doubled',
      'profile_income_reconciliation',
      'hamilton_task_self_heal',
      'no_search_engine_application_targets',
      'grant_score_backfill',
      'pipeline_refill',
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

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: profiles.display_name + basic_information.full_name are never a
// DOUBLED personal name (the "Jordan Lane Jordan Michael Lane" bug).
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceProfileDisplayNameNotDoubled', () => {
  function makeProfileDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT
      );
      CREATE TABLE profile_sections (
        profile_id TEXT,
        section_key TEXT,
        data TEXT,
        PRIMARY KEY (profile_id, section_key)
      );
    `)
    return raw
  }
  const setName = (db, id, name) =>
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run(id, name)
  const setBasic = (db, id, full) =>
    db
      .prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)")
      .run(id, JSON.stringify({ full_name: full, email: 'x@y.com' }))
  const nameOf = (db, id) => db.prepare('SELECT display_name FROM profiles WHERE id = ?').get(id)?.display_name
  const fullOf = (db, id) =>
    JSON.parse(
      db.prepare("SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'basic_information'").get(id)?.data || '{}',
    ).full_name

  it('collapses a production-style double in both fields (newline-joined)', async () => {
    const db = makeProfileDb()
    setName(db, 'p1', 'Jordan Lane\nJordan Michael Lane')
    setBasic(db, 'p1', 'Jordan Lane\nJordan Michael Lane')

    const r = await enforceProfileDisplayNameNotDoubled(db)
    expect(r.ok).toBe(true)
    expect(r.repaired).toBe(2)
    expect(nameOf(db, 'p1')).toBe('Jordan Michael Lane')
    expect(fullOf(db, 'p1')).toBe('Jordan Michael Lane')
  })

  it('leaves legitimate names (and org names) untouched', async () => {
    const db = makeProfileDb()
    setName(db, 'p1', 'Jordan Michael Lane')
    setName(db, 'p2', 'Mary Jane Watson')
    setName(db, 'p3', 'Church of God of Prophecy')
    setBasic(db, 'p1', 'Jordan Michael Lane')

    const r = await enforceProfileDisplayNameNotDoubled(db)
    expect(r.repaired).toBe(0)
    expect(nameOf(db, 'p1')).toBe('Jordan Michael Lane')
    expect(nameOf(db, 'p2')).toBe('Mary Jane Watson')
    expect(nameOf(db, 'p3')).toBe('Church of God of Prophecy')
    expect(fullOf(db, 'p1')).toBe('Jordan Michael Lane')
  })

  it('is idempotent — a second pass repairs nothing', async () => {
    const db = makeProfileDb()
    setName(db, 'p1', 'Jane Doe Jane Doe')
    setBasic(db, 'p1', 'Jane Doe Jane Doe')

    const first = await enforceProfileDisplayNameNotDoubled(db)
    expect(first.repaired).toBe(2)
    const second = await enforceProfileDisplayNameNotDoubled(db)
    expect(second.repaired).toBe(0)
    expect(nameOf(db, 'p1')).toBe('Jane Doe')
    expect(fullOf(db, 'p1')).toBe('Jane Doe')
  })

  it('degrades safely when profiles has no display_name column (legacy schema)', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY)')
    const r = await enforceProfileDisplayNameNotDoubled(raw)
    expect(r.ok).toBe(true)
    expect(r.repaired).toBe(0)
  })
})

describe('enforceInvariants — profile_id integrity', () => {
  // A real designated profile (slug id + display_name) to drive slug->UUID resolution.
  const designated = (Array.isArray(DESIGNATED_PROFILES) ? DESIGNATED_PROFILES : [])
    .find((p) => p?.id && p?.display_name)

  it('normalizes a grant carrying a designated slug to the live canonical id', async () => {
    expect(designated).toBeTruthy() // config must define at least one designated profile
    const db = makeDb()
    const liveId = 'uuid-live-1'
    // Seed the live profile under a UUID with the designated display_name, so the
    // resolver maps the slug -> this id (the real "slug re-keyed to UUID" case).
    db.prepare('INSERT INTO profiles (id, organization_id, display_name) VALUES (?, ?, ?)')
      .run(liveId, 'org1', designated.display_name)
    const gid = insertGrant(db, { profile_id: designated.id, organization_id: 'org1', title: 'Slug grant', match_score: 80 })

    const res = await enforceProfileIdIntegrity(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1)
    expect(db.prepare('SELECT profile_id FROM grants WHERE id = ?').get(gid).profile_id).toBe(liveId)
  })

  it('leaves a grant with a valid (direct) profile_id untouched', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'OK', match_score: 80 })
    const res = await enforceProfileIdIntegrity(db)
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT profile_id FROM grants WHERE id = ?').get(gid).profile_id).toBe('p1')
  })

  it('does NOT null/delete a dangling-but-unmappable profile_id (safety: no cascade)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'totally-unknown-id', organization_id: 'org1', title: 'Dangling', match_score: 80 })
    const res = await enforceProfileIdIntegrity(db)
    expect(res.ok).toBe(true)
    // Unmappable id is left as-is (scoped to a non-existent profile → invisible, not destroyed).
    expect(db.prepare('SELECT profile_id FROM grants WHERE id = ?').get(gid).profile_id).toBe('totally-unknown-id')
  })

  it('is idempotent — a second pass repairs nothing', async () => {
    expect(designated).toBeTruthy()
    const db = makeDb()
    db.prepare('INSERT INTO profiles (id, organization_id, display_name) VALUES (?, ?, ?)')
      .run('uuid-live-2', 'org1', designated.display_name)
    insertGrant(db, { profile_id: designated.id, organization_id: 'org1', title: 'Slug grant', match_score: 80 })
    const first = await enforceProfileIdIntegrity(db)
    expect(first.repaired).toBe(1)
    const second = await enforceProfileIdIntegrity(db)
    expect(second.repaired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT 8: student-aid opportunities do not surface to a non-student profile
// (the "senior widow with student scholarships" defect — stale web-llm ACCEPTs).
// ---------------------------------------------------------------------------

function makeMatchDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, categories TEXT,
      opportunity_kind TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
      match_score REAL, match_decision TEXT, match_explanation TEXT,
      matcher_version TEXT, updated_at TEXT
    );
  `)
  return raw
}

let _oppSeq = 0
function insertMatch(db, { profileId, title, description = '', categories = '', kind = 'DIRECT_GRANT', score, decision, matcher = 'web-llm' }) {
  _oppSeq += 1
  const oid = `opp-${_oppSeq}`
  const mid = `m-${_oppSeq}`
  db.prepare('INSERT INTO funding_opportunities (id, title, description, categories, opportunity_kind) VALUES (?, ?, ?, ?, ?)')
    .run(oid, title, description, categories, kind)
  db.prepare('INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES (?, ?, ?, ?, ?, ?)')
    .run(mid, profileId, oid, score, decision, matcher)
  return { mid, oid }
}

describe('enforceStudentAidEligibility — student-aid on non-student profiles', () => {
  // Inject the thesis resolver so we don't need the full loadProfileContext schema.
  const theses = {
    'p-senior': { profile_id: 'p-senior', is_student: false, needs: ['education', 'tuition', 'professional_development', 'medical'] },
    'p-student': { profile_id: 'p-student', is_student: true, needs: ['scholarship', 'tuition', 'education'] },
    'p-adult-aid': { profile_id: 'p-adult-aid', is_student: false, needs: ['scholarship', 'education'] },
  }
  const resolveThesis = (_db, pid) => theses[pid] ?? null

  it('demotes a stale student-aid ACCEPT on a non-student individual (Liubov class)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-senior', title: 'Tennessee HOPE Scholarship', description: 'Lottery scholarship for enrolled TN undergraduates', score: 81, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1)
    const row = db.prepare('SELECT match_decision, match_score FROM profile_opportunity_matches WHERE id = ?').get(mid)
    expect(String(row.match_decision).toLowerCase()).toBe('reject')
    expect(row.match_score).toBeLessThan(75) // below the display floor → no longer surfaces
  })

  it('demotes a TN HOPE-family award whose title has no generic student-aid word ("HOPE Access Grant")', async () => {
    const db = makeMatchDb()
    // Title carries neither "scholarship" nor "tuition" — only the program brand.
    const { mid } = insertMatch(db, { profileId: 'p-senior', title: 'Tennessee HOPE Access Grant', description: 'TN lottery-funded aid program', score: 87, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.repaired).toBe(1)
    expect(String(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id = ?').get(mid).match_decision).toLowerCase()).toBe('reject')
  })

  it('does NOT touch the SAME scholarship for a real student (recall preserved)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-student', title: 'Tennessee HOPE Scholarship', description: 'Lottery scholarship for enrolled TN undergraduates', score: 81, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.repaired).toBe(0)
    const row = db.prepare('SELECT match_decision, match_score FROM profile_opportunity_matches WHERE id = ?').get(mid)
    expect(String(row.match_decision).toLowerCase()).toBe('accept')
    expect(row.match_score).toBe(81)
  })

  it('does NOT touch a non-student who declares a student-aid NEED (adult learner)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-adult-aid', title: 'Federal Pell Grant', description: 'Need-based federal student aid', score: 80, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id = ?').get(mid).match_decision).toBe('accept')
  })

  it('leaves a non-student\'s NON-student-aid match alone (e.g. a food-bank grant)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-senior', title: 'Cleveland Emergency Food Assistance', description: 'Groceries for seniors', score: 82, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id = ?').get(mid).match_decision).toBe('accept')
  })

  it('does NOT demote a directory/referral scholarship platform (directories always survive)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-senior', title: 'Fastweb Scholarship Search', description: 'Scholarship directory', kind: 'DIRECTORY', score: 78, decision: 'accept' })
    const res = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(res.repaired).toBe(0)
    expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id = ?').get(mid).match_decision).toBe('accept')
  })

  it('count-only when ENFORCE_STUDENT_AID_ELIGIBILITY=0 (no mutation)', async () => {
    const db = makeMatchDb()
    const { mid } = insertMatch(db, { profileId: 'p-senior', title: 'HOPE Lottery Scholarship (TELS)', description: 'TN student aid', score: 81, decision: 'accept' })
    process.env.ENFORCE_STUDENT_AID_ELIGIBILITY = '0'
    try {
      const res = await enforceStudentAidEligibility(db, { resolveThesis })
      expect(res.enforced).toBe(false)
      expect(res.scanned).toBe(1)
      expect(res.repaired).toBe(0)
      expect(db.prepare('SELECT match_decision FROM profile_opportunity_matches WHERE id = ?').get(mid).match_decision).toBe('accept')
    } finally {
      delete process.env.ENFORCE_STUDENT_AID_ELIGIBILITY
    }
  })

  it('is idempotent — a second pass demotes nothing (demoted row no longer surfaces)', async () => {
    const db = makeMatchDb()
    insertMatch(db, { profileId: 'p-senior', title: 'Tennessee Student Assistance Award', description: 'TSAA student aid', score: 81, decision: 'accept' })
    const first = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(first.repaired).toBe(1)
    const second = await enforceStudentAidEligibility(db, { resolveThesis })
    expect(second.repaired).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: Hamilton task lifecycle self-heal — a blocked task whose
// missing-profile-field preflight blocker no longer reproduces is re-queued,
// and already-stacked duplicate OPEN hard-stops collapse to one (extras are
// RESOLVED as 'duplicate', never deleted).
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceHamiltonTaskSelfHeal', () => {
  let taskStore
  let blockerStore

  async function makeHamiltonDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        display_name TEXT
      );
      CREATE TABLE profile_sections (
        profile_id TEXT,
        section_key TEXT,
        data TEXT
      );
    `)
    taskStore = await import('../services/hamilton/applicationTaskStore.js')
    blockerStore = await import('../services/hamilton/hamiltonBlockerStore.js')
    // applicationTaskStore caches "schema ensured" in a module-global flag; a
    // fresh in-memory db per test needs it reset so its tables get created.
    taskStore._resetSchemaCache()
    await taskStore.ensureApplicationTaskSchema(raw)
    return raw
  }

  async function makeBlockedTask(db, {
    profileId = 'p-heal', grantId = crypto.randomUUID(),
    message = 'Hamilton Autopilot stopped at preflight: Profile is missing first name',
    missing = [{ kind: 'field', key: 'first_name', label: 'Profile is missing first name' }],
  } = {}) {
    const task = await taskStore.ensureApplicationTask(db, {
      profileId, grantId, automationType: 'portal', initialStatus: 'queued',
    })
    await taskStore.updateApplicationTask(db, task.id, { status: 'blocked', lastAgentMessage: message })
    if (missing.length > 0) await taskStore.setMissingInfo(db, task.id, missing)
    return task
  }

  beforeEach(() => {
    delete process.env.ENFORCE_HAMILTON_TASK_SELF_HEAL
    delete process.env.HAMILTON_SELF_HEAL_REQUEUE_CAP
  })
  afterEach(() => {
    delete process.env.ENFORCE_HAMILTON_TASK_SELF_HEAL
    delete process.env.HAMILTON_SELF_HEAL_REQUEUE_CAP
  })

  it('re-queues a blocked task whose flagged name field is now derivable from display_name', async () => {
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Robert White')
    const task = await makeBlockedTask(db, {})

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.ok).toBe(true)
    expect(res.requeued).toBe(1)

    const after = await taskStore.getApplicationTask(db, task.id)
    expect(after.status).toBe('ready')
    expect(after.next_retry_at).toBe(null)
    // Stale blocker text is replaced, not carried into the re-queued task.
    expect(after.last_agent_message).not.toMatch(/missing first name/i)

    const items = await taskStore.listMissingInfo(db, task.id, { includeResolved: false })
    expect(items.length).toBe(0)

    // Idempotent: the task is no longer blocked, so a second pass is a no-op.
    const again = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(again.requeued).toBe(0)
  })

  it('leaves a task blocked when the flagged field is STILL missing', async () => {
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', null)
    const task = await makeBlockedTask(db, {})

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.requeued).toBe(0)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('never touches a blocked task with a non-profile-field outstanding item (conservative class gate)', async () => {
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Robert White')
    const task = await makeBlockedTask(db, {
      missing: [
        { kind: 'field', key: 'first_name', label: 'Profile is missing first name' },
        { kind: 'login', key: 'portal_login', label: 'Sign in to the portal' },
      ],
    })

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.requeued).toBe(0)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('heals a LEGACY blocked task (no missing-info rows) by parsing the preflight message', async () => {
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Anastasia White')
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p-heal', 'basic_information', JSON.stringify({ email: 'ana@example.com' }))
    const task = await makeBlockedTask(db, {
      message: 'Hamilton Autopilot stopped at preflight: Profile is missing first name; Profile is missing email',
      missing: [],
    })

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.requeued).toBe(1)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('ready')
  })

  it('skips a legacy blocked task whose message includes a NON-profile-field blocker', async () => {
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Robert White')
    const task = await makeBlockedTask(db, {
      message: 'Hamilton Autopilot stopped at preflight: Profile is missing first name; Portal URL is missing',
      missing: [],
    })

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.requeued).toBe(0)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('collapses duplicate OPEN hard-stops to one (extras resolved as duplicate, never deleted)', async () => {
    const db = await makeHamiltonDb()
    const taskId = crypto.randomUUID()
    // First blocker via the store (creates the hamilton_blockers schema), then
    // stack two raw identical duplicates the way the pre-dedup insert path did.
    const first = await blockerStore.recordBlocker(db, {
      taskId, profileId: 'p-dup', blockerType: 'unknown_application_method',
      blockerText: 'no signup form found', metadata: { key: 'application_method' },
    })
    // Make the first stop clearly the OLDEST (CURRENT_TIMESTAMP has 1s
    // resolution, so all three rows would otherwise tie on detected_at).
    db.prepare('UPDATE hamilton_blockers SET detected_at = ? WHERE id = ?')
      .run('2026-06-20T00:00:00.000Z', first.id)
    for (let i = 0; i < 2; i += 1) {
      db.prepare(
        `INSERT INTO hamilton_blockers (id, task_id, profile_id, blocker_type, blocker_text, metadata_json, detected_at)
         VALUES (?, ?, 'p-dup', 'unknown_application_method', 'no signup form found', ?, CURRENT_TIMESTAMP)`,
      ).run(crypto.randomUUID(), taskId, JSON.stringify({ key: 'application_method' }))
    }
    // A different-key open blocker on the same task must survive untouched.
    db.prepare(
      `INSERT INTO hamilton_blockers (id, task_id, profile_id, blocker_type, blocker_text, metadata_json, detected_at)
       VALUES (?, ?, 'p-dup', 'unknown_application_method', 'other stop', ?, CURRENT_TIMESTAMP)`,
    ).run(crypto.randomUUID(), taskId, JSON.stringify({ key: 'something_else' }))

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.dedupedBlockers).toBe(2)

    const open = db.prepare('SELECT * FROM hamilton_blockers WHERE resolved_at IS NULL').all()
    expect(open.length).toBe(2) // one survivor per key group
    expect(open.some((b) => b.id === first.id)).toBe(true) // oldest kept
    const resolved = db.prepare('SELECT * FROM hamilton_blockers WHERE resolved_at IS NOT NULL').all()
    expect(resolved.length).toBe(2)
    expect(resolved.every((b) => b.resolution_strategy === 'duplicate')).toBe(true)

    // Idempotent: one open row per group left, so a second pass dedupes nothing.
    const again = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(again.dedupedBlockers).toBe(0)
  })

  it('ENFORCE_HAMILTON_TASK_SELF_HEAL=0 counts candidates but writes nothing', async () => {
    process.env.ENFORCE_HAMILTON_TASK_SELF_HEAL = '0'
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Robert White')
    const task = await makeBlockedTask(db, {})

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.enforced).toBe(false)
    expect(res.repaired).toBe(0)
    expect(res.scanned).toBeGreaterThan(0)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('caps requeues per boot (HAMILTON_SELF_HEAL_REQUEUE_CAP)', async () => {
    process.env.HAMILTON_SELF_HEAL_REQUEUE_CAP = '1'
    const db = await makeHamiltonDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-heal', 'Robert White')
    await makeBlockedTask(db, { grantId: 'g-cap-1' })
    await makeBlockedTask(db, { grantId: 'g-cap-2' })

    const res = await __testables.enforceHamiltonTaskSelfHeal(db)
    expect(res.requeued).toBe(1)
    expect(res.requeueCapped).toBe(true)
    const blocked = db.prepare("SELECT COUNT(*) AS n FROM application_tasks WHERE status = 'blocked'").get()
    expect(Number(blocked.n)).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: a search-engine RESULTS url is never a portal/application target
// (URL hygiene — the "Hamilton retried login against google.com/search" bug).
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceNoSearchEngineApplicationTargets', () => {
  const SEARCH_URL = 'https://www.google.com/search?q=Middle+Tennessee+State+University+financial+aid+office'
  const REAL_URL = 'https://www.mtsu.edu/financial-aid/'

  function makeUrlDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE application_tasks (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        status TEXT,
        automation_type TEXT DEFAULT 'unknown',
        portal_url TEXT,
        application_url TEXT,
        next_retry_at TEXT,
        last_agent_message TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        title TEXT,
        application_url TEXT,
        apply_url TEXT,
        source_url TEXT
      );
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        title TEXT,
        status TEXT,
        application_url TEXT,
        url TEXT
      );
    `)
    return db
  }

  function insertTask(db, { id, status = 'waiting_for_login', portalUrl = null, applicationUrl = null }) {
    db.prepare(
      `INSERT INTO application_tasks (id, profile_id, status, automation_type, portal_url, application_url, next_retry_at)
       VALUES (?, 'p1', ?, 'portal', ?, ?, '2099-01-01T00:00:00Z')`,
    ).run(id, status, portalUrl, applicationUrl)
  }

  afterEach(() => {
    delete process.env.ENFORCE_URL_HYGIENE
  })

  it('nulls search-result task URLs and reclassifies the blocker to unknown_application_method', async () => {
    const db = makeUrlDb()
    insertTask(db, { id: 't-bad', portalUrl: SEARCH_URL, applicationUrl: SEARCH_URL })

    const res = await enforceNoSearchEngineApplicationTargets(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBeGreaterThanOrEqual(1)

    const row = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get('t-bad')
    expect(row.portal_url).toBe(null)
    expect(row.application_url).toBe(null)
    expect(row.status).toBe('blocked')
    expect(row.automation_type).toBe('unknown')
    expect(row.next_retry_at).toBe(null)
    expect(row.last_agent_message).toContain('unknown_application_method')
  })

  it('never touches a task with a real portal URL, and never rewrites terminal-task history', async () => {
    const db = makeUrlDb()
    insertTask(db, { id: 't-real', portalUrl: REAL_URL, applicationUrl: REAL_URL })
    insertTask(db, { id: 't-done', status: 'submitted', portalUrl: SEARCH_URL })

    await enforceNoSearchEngineApplicationTargets(db)

    const real = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get('t-real')
    expect(real.portal_url).toBe(REAL_URL)
    expect(real.status).toBe('waiting_for_login')

    // Terminal task: URL nulled (junk data healed) but status/history untouched.
    const done = db.prepare('SELECT * FROM application_tasks WHERE id = ?').get('t-done')
    expect(done.portal_url).toBe(null)
    expect(done.status).toBe('submitted')
    expect(done.automation_type).toBe('portal')
  })

  it('nulls search-result URLs on funding_opportunities and grants without deleting rows', async () => {
    const db = makeUrlDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, application_url, apply_url, source_url)
       VALUES ('fo-bad', 'MTSU Financial Aid', ?, ?, ?)`,
    ).run(SEARCH_URL, SEARCH_URL, REAL_URL)
    db.prepare(
      `INSERT INTO grants (id, profile_id, title, status, application_url, url)
       VALUES ('g-bad', 'p1', 'MTSU Financial Aid', 'discovered', ?, ?)`,
    ).run(SEARCH_URL, REAL_URL)

    const res = await enforceNoSearchEngineApplicationTargets(db)
    expect(res.repaired).toBeGreaterThanOrEqual(2)

    const fo = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get('fo-bad')
    expect(fo.application_url).toBe(null)
    expect(fo.apply_url).toBe(null)
    expect(fo.source_url).toBe(REAL_URL) // real URL preserved
    expect(fo.title).toBe('MTSU Financial Aid') // row never deleted

    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get('g-bad')
    expect(g.application_url).toBe(null)
    expect(g.url).toBe(REAL_URL)
  })

  it('is count-only when ENFORCE_URL_HYGIENE=0, idempotent otherwise, and tolerant of missing tables', async () => {
    const db = makeUrlDb()
    insertTask(db, { id: 't-bad', portalUrl: SEARCH_URL })

    process.env.ENFORCE_URL_HYGIENE = '0'
    const counted = await enforceNoSearchEngineApplicationTargets(db)
    expect(counted.enforced).toBe(false)
    expect(counted.scanned).toBe(1)
    expect(counted.repaired).toBe(0)
    expect(db.prepare('SELECT portal_url FROM application_tasks WHERE id = ?').get('t-bad').portal_url).toBe(SEARCH_URL)

    delete process.env.ENFORCE_URL_HYGIENE
    const first = await enforceNoSearchEngineApplicationTargets(db)
    expect(first.repaired).toBeGreaterThanOrEqual(1)
    const second = await enforceNoSearchEngineApplicationTargets(db)
    expect(second.scanned).toBe(0)
    expect(second.repaired).toBe(0)

    // Missing tables (fresh/test schema) never fail the sweep.
    const bare = new Database(':memory:')
    const res = await enforceNoSearchEngineApplicationTargets(bare)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT: pipeline grants carry the funder's name when it is knowable
// (grants.funder backfilled from the linked funding_opportunities.sponsor —
// the #725 sponsor/funder naming-drift class; never invents a value).
// ---------------------------------------------------------------------------

function makeFunderDb() {
  const db = makeDb()
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT
    );
  `)
  return db
}

describe('enforceFunderBackfill — grants.funder from linked catalog sponsor', () => {
  it('backfills an empty grants.funder from the linked opportunity sponsor', async () => {
    const db = makeFunderDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor) VALUES (?, ?, ?)')
      .run('opp-1', 'STEM Access Grant', 'Volunteer Foundation')
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'STEM Access Grant',
      funder: null, match_score: 90,
    })

    const result = await enforceFunderBackfill(db)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(1)
    expect(db.prepare('SELECT funder FROM grants WHERE id = ?').get(gid).funder)
      .toBe('Volunteer Foundation')
  })

  it('treats a whitespace-only funder as empty', async () => {
    const db = makeFunderDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor) VALUES (?, ?, ?)')
      .run('opp-1', 'Grant', 'Real Sponsor')
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Grant', funder: '   ', match_score: 90,
    })

    const result = await enforceFunderBackfill(db)
    expect(result.repaired).toBe(1)
    expect(db.prepare('SELECT funder FROM grants WHERE id = ?').get(gid).funder).toBe('Real Sponsor')
  })

  it('NEVER invents a funder: unlinked rows and empty-sponsor links are counted, not guessed', async () => {
    const db = makeFunderDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    // Linked opportunity whose sponsor is itself empty.
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor) VALUES (?, ?, ?)')
      .run('opp-empty', 'No Sponsor Opp', '')
    const g1 = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-empty', title: 'A', funder: null, match_score: 90,
    })
    // No link at all.
    const g2 = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      title: 'B', funder: null, match_score: 90,
    })

    const result = await enforceFunderBackfill(db)
    expect(result.repaired).toBe(0)
    expect(result.missingFunder).toBe(2)
    expect(db.prepare('SELECT funder FROM grants WHERE id = ?').get(g1).funder).toBeNull()
    expect(db.prepare('SELECT funder FROM grants WHERE id = ?').get(g2).funder).toBeNull()
  })

  it('never overwrites an existing funder value', async () => {
    const db = makeFunderDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor) VALUES (?, ?, ?)')
      .run('opp-1', 'Grant', 'Catalog Sponsor')
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Grant',
      funder: 'Hand-Entered Funder', match_score: 90,
    })

    const result = await enforceFunderBackfill(db)
    expect(result.repaired).toBe(0)
    expect(db.prepare('SELECT funder FROM grants WHERE id = ?').get(gid).funder)
      .toBe('Hand-Entered Funder')
  })

  it('is idempotent (second run repairs nothing)', async () => {
    const db = makeFunderDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, sponsor) VALUES (?, ?, ?)')
      .run('opp-1', 'Grant', 'Sponsor Inc')
    insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Grant', funder: null, match_score: 90,
    })

    const first = await enforceFunderBackfill(db)
    const second = await enforceFunderBackfill(db)
    expect(first.repaired).toBe(1)
    expect(second.repaired).toBe(0)
  })

  it('degrades to count-only when funding_opportunities is absent (never throws)', async () => {
    const db = makeDb() // no funding_opportunities table
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', funder: null, match_score: 90 })

    const result = await enforceFunderBackfill(db)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(0)
    expect(result.missingFunder).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// INVARIANT: pipeline grants carry a dollar value when one is knowable
// (amount_min/max inherited from the linked catalog row; amount_requested
// defaulted from the ceiling/floor — the pipeline-$ visibility class; never
// invents a value).
// ---------------------------------------------------------------------------

function makeAmountDb() {
  const db = makeDb()
  db.exec(`
    ALTER TABLE grants ADD COLUMN amount_min NUMERIC;
    ALTER TABLE grants ADD COLUMN amount_max NUMERIC;
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      amount_min NUMERIC,
      amount_max NUMERIC
    );
  `)
  return db
}

function amountRow(db, id) {
  return db.prepare('SELECT amount_requested, amount_min, amount_max FROM grants WHERE id = ?').get(id)
}

describe('enforceGrantAmountBackfill — pipeline-$ visibility', () => {
  const { enforceGrantAmountBackfill } = __testables

  it('defaults amount_requested from the grant\'s own ceiling (amount_max wins over amount_min)', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', match_score: 90 })
    db.prepare('UPDATE grants SET amount_min = 1000, amount_max = 5000 WHERE id = ?').run(gid)

    const result = await enforceGrantAmountBackfill(db)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(1)
    expect(amountRow(db, gid).amount_requested).toBe(5000)
  })

  it('inherits amount_min/max from the linked catalog row, then defaults amount_requested', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, amount_min, amount_max) VALUES (?, ?, ?, ?)')
      .run('opp-1', 'Scholarship', 500, 2500)
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Scholarship', match_score: 90,
    })

    const result = await enforceGrantAmountBackfill(db)
    const row = amountRow(db, gid)
    expect(result.repaired).toBe(2) // catalog-inherit + requested-default
    expect(row.amount_min).toBe(500)
    expect(row.amount_max).toBe(2500)
    expect(row.amount_requested).toBe(2500)
  })

  it('NEVER invents an amount: unlinked no-amount rows are counted, not guessed', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', status: 'discovered', match_score: 90 })

    const result = await enforceGrantAmountBackfill(db)
    expect(result.repaired).toBe(0)
    expect(result.missingAmount).toBe(1)
    expect(amountRow(db, gid).amount_requested).toBeNull()
  })

  it('never overwrites a user-entered amount_requested', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1', title: 'A',
      amount_requested: 1234, match_score: 90,
    })
    db.prepare('UPDATE grants SET amount_max = 99999 WHERE id = ?').run(gid)

    const result = await enforceGrantAmountBackfill(db)
    expect(result.repaired).toBe(0)
    expect(amountRow(db, gid).amount_requested).toBe(1234)
  })

  it('is idempotent (second run repairs nothing)', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', match_score: 90 })
    db.prepare('UPDATE grants SET amount_max = 5000 WHERE id = ?').run(gid)

    const first = await enforceGrantAmountBackfill(db)
    const second = await enforceGrantAmountBackfill(db)
    expect(first.repaired).toBe(1)
    expect(second.repaired).toBe(0)
  })

  // ── Amount VISIBILITY (migrations 132/0136): amount_text/status/confidence ──

  function makeAmountStatusDb() {
    const db = makeAmountDb()
    db.exec(`
      ALTER TABLE grants ADD COLUMN amount_text TEXT;
      ALTER TABLE grants ADD COLUMN amount_status TEXT;
      ALTER TABLE grants ADD COLUMN amount_confidence NUMERIC;
      ALTER TABLE funding_opportunities ADD COLUMN amount_text TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN amount_status TEXT;
      ALTER TABLE funding_opportunities ADD COLUMN amount_confidence NUMERIC;
    `)
    return db
  }

  function statusRow(db, id) {
    return db.prepare('SELECT amount_text, amount_status, amount_confidence FROM grants WHERE id = ?').get(id)
  }

  it('mirrors amount_text/status from the linked catalog row (the "varies / contact funder" class)', async () => {
    const db = makeAmountStatusDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, amount_text, amount_status) VALUES (?, ?, ?, ?)')
      .run('opp-1', 'Local Fund', 'amounts vary based on need', 'varies')
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Local Fund', status: 'discovered', match_score: 90,
    })

    const result = await enforceGrantAmountBackfill(db)
    expect(result.ok).toBe(true)
    const row = statusRow(db, gid)
    expect(row.amount_status).toBe('varies')
    expect(row.amount_text).toBe('amounts vary based on need')
    // no numeric value was invented
    expect(amountRow(db, gid).amount_requested).toBeNull()
  })

  it('derives amount_status from numeric amounts (catalog + grant) when the column is blank', async () => {
    const db = makeAmountStatusDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, amount_min, amount_max) VALUES (?, ?, ?, ?)')
      .run('opp-1', 'Scholarship', 500, 2500)
    const gid = insertGrant(db, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Scholarship', status: 'discovered', match_score: 90,
    })

    await enforceGrantAmountBackfill(db)
    const catStatus = db.prepare('SELECT amount_status FROM funding_opportunities WHERE id = ?').get('opp-1')
    expect(catStatus.amount_status).toBe('range')
    expect(statusRow(db, gid).amount_status).toBe('range')
  })

  it('catalog TEXT sweep: extracts amounts/status from already-stored text (bounded, converging)', async () => {
    const db = makeAmountStatusDb()
    db.exec('ALTER TABLE funding_opportunities ADD COLUMN description TEXT; ALTER TABLE funding_opportunities ADD COLUMN amount_description TEXT;')
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    db.prepare('INSERT INTO funding_opportunities (id, title, description) VALUES (?, ?, ?)')
      .run('opp-text', 'Rural Fire Grant', 'Departments may request up to $7,500 for turnout gear.')
    db.prepare('INSERT INTO funding_opportunities (id, title, description) VALUES (?, ?, ?)')
      .run('opp-varies', 'Community Fund', 'Award amounts vary based on need.')
    db.prepare('INSERT INTO funding_opportunities (id, title, description) VALUES (?, ?, ?)')
      .run('opp-nothing', 'Local Partner Page', 'Serving our neighbors since 1985.')

    await enforceGrantAmountBackfill(db)
    const get = (id) => db.prepare('SELECT amount_min, amount_max, amount_text, amount_status FROM funding_opportunities WHERE id = ?').get(id)

    const dollars = get('opp-text')
    expect(dollars.amount_max).toBe(7500)
    expect(dollars.amount_status).toBe('range')

    const varies = get('opp-varies')
    expect(varies.amount_max).toBeNull() // never invents a number
    expect(varies.amount_status).toBe('varies')
    expect(varies.amount_text).toBeTruthy()

    // Nothing found → explicit not_listed, so the sweep CONVERGES (row no
    // longer matches the backlog WHERE on the next boot).
    const nothing = get('opp-nothing')
    expect(nothing.amount_status).toBe('not_listed')
    expect(nothing.amount_max).toBeNull()

    const again = await enforceGrantAmountBackfill(db)
    expect(again.ok).toBe(true)
    expect(get('opp-text').amount_max).toBe(7500) // stable on re-run
  })

  it('stamps truly amount-less ACTIVE grants not_listed (honest label, never a number)', async () => {
    const db = makeAmountStatusDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', status: 'discovered', match_score: 90 })

    const result = await enforceGrantAmountBackfill(db)
    expect(result.missingAmount).toBe(1)
    expect(statusRow(db, gid).amount_status).toBe('not_listed')
    expect(amountRow(db, gid).amount_requested).toBeNull()
  })

  it('status mirroring is idempotent and skips cleanly when the columns are absent', async () => {
    const withCols = makeAmountStatusDb()
    insertProfile(withCols, { id: 'p1', orgId: 'org1' })
    withCols.prepare('INSERT INTO funding_opportunities (id, title, amount_status) VALUES (?, ?, ?)')
      .run('opp-1', 'Fund', 'contact_required')
    const gid = insertGrant(withCols, {
      profile_id: 'p1', organization_id: 'org1',
      funding_opportunity_id: 'opp-1', title: 'Fund', status: 'discovered', match_score: 90,
    })
    await enforceGrantAmountBackfill(withCols)
    const second = await enforceGrantAmountBackfill(withCols)
    expect(statusRow(withCols, gid).amount_status).toBe('contact_required')
    expect(second.repaired).toBe(0)

    // legacy DB without the columns: guarded skip, never throws
    const legacy = makeAmountDb()
    insertProfile(legacy, { id: 'p1', orgId: 'org1' })
    insertGrant(legacy, { profile_id: 'p1', organization_id: 'org1', title: 'A', match_score: 90 })
    const legacyResult = await enforceGrantAmountBackfill(legacy)
    expect(legacyResult.ok).toBe(true)
  })

  it('count-only when ENFORCE_GRANT_AMOUNT_BACKFILL=0', async () => {
    const db = makeAmountDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    const gid = insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', match_score: 90 })
    db.prepare('UPDATE grants SET amount_max = 5000 WHERE id = ?').run(gid)

    process.env.ENFORCE_GRANT_AMOUNT_BACKFILL = '0'
    try {
      const result = await enforceGrantAmountBackfill(db)
      expect(result.repaired).toBe(0)
      expect(result.enforced).toBe(false)
      expect(amountRow(db, gid).amount_requested).toBeNull()
    } finally {
      delete process.env.ENFORCE_GRANT_AMOUNT_BACKFILL
    }
  })

  it('degrades to skip on a legacy schema without amount_max (never throws)', async () => {
    const db = makeDb() // grants table has no amount_min/amount_max
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'A', match_score: 90 })

    const result = await enforceGrantAmountBackfill(db)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe('schema')
  })
})

// ---------------------------------------------------------------------------
// INVARIANT: no dangling profile-opportunity matches (a surfaced match must
// point at a catalog row that still exists; ghosts inflate the matches view
// and waste promote passes with opportunity_not_found).
// ---------------------------------------------------------------------------

function makeMatchesDb() {
  const db = makeAmountDb()
  db.exec(`
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      matcher_version TEXT
    );
  `)
  return db
}

describe('enforceNoDanglingMatches — surface-table hygiene', () => {
  const { enforceNoDanglingMatches } = __testables

  function insertMatch(db, { id, profileId, oppId, score = 80, version = 'crawler-os' }) {
    db.prepare('INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, matcher_version) VALUES (?, ?, ?, ?, ?)')
      .run(id, profileId, oppId, score, version)
  }

  it('deletes matches whose catalog row is gone; keeps resolvable ones (any matcher_version)', async () => {
    const db = makeMatchesDb()
    db.prepare('INSERT INTO funding_opportunities (id, title) VALUES (?, ?)').run('opp-live', 'Real Grant')
    insertMatch(db, { id: 'm1', profileId: 'p1', oppId: 'opp-live' })
    insertMatch(db, { id: 'm2', profileId: 'p1', oppId: 'opp-deleted' })
    insertMatch(db, { id: 'm3', profileId: 'p2', oppId: 'opp-also-gone', version: 'web-llm' })

    const result = await enforceNoDanglingMatches(db)
    expect(result.ok).toBe(true)
    expect(result.repaired).toBe(2)
    const left = db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)
    expect(left).toEqual(['m1'])
  })

  it('count-only when ENFORCE_NO_DANGLING_MATCHES=0', async () => {
    const db = makeMatchesDb()
    insertMatch(db, { id: 'm1', profileId: 'p1', oppId: 'opp-gone' })
    process.env.ENFORCE_NO_DANGLING_MATCHES = '0'
    try {
      const result = await enforceNoDanglingMatches(db)
      expect(result.repaired).toBe(0)
      expect(result.scanned).toBe(1)
      expect(result.enforced).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM profile_opportunity_matches').get().n).toBe(1)
    } finally {
      delete process.env.ENFORCE_NO_DANGLING_MATCHES
    }
  })

  it('is idempotent and a no-op on a clean table', async () => {
    const db = makeMatchesDb()
    db.prepare('INSERT INTO funding_opportunities (id, title) VALUES (?, ?)').run('opp-live', 'Real Grant')
    insertMatch(db, { id: 'm1', profileId: 'p1', oppId: 'opp-live' })
    const first = await enforceNoDanglingMatches(db)
    const second = await enforceNoDanglingMatches(db)
    expect(first.repaired).toBe(0)
    expect(second.repaired).toBe(0)
  })

  it('degrades to skip when the matches table is absent (never throws)', async () => {
    const db = makeAmountDb() // no profile_opportunity_matches table
    const result = await enforceNoDanglingMatches(db)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe('schema')
  })
})

// ── Profession-eligibility invariant ──────────────────────────────────────────
import {
  ensureApplicationTaskSchema,
  _resetSchemaCache,
} from '../services/hamilton/applicationTaskStore.js'

describe('profession eligibility invariant', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    _resetSchemaCache()
    await ensureApplicationTaskSchema(db) // real application_tasks/events schema
  })

  const insertTask = (id, profileId, grantId, status) =>
    db.prepare('INSERT INTO application_tasks (id, profile_id, grant_id, status) VALUES (?, ?, ?, ?)')
      .run(id, profileId, grantId, status)
  const grantExists = (id) => Boolean(db.prepare('SELECT id FROM grants WHERE id = ?').get(id))
  const taskStatus = (id) => db.prepare('SELECT status FROM application_tasks WHERE id = ?').get(id)?.status

  it('cancels tasks + purges early-status grants for a profession mismatch, conservatively', async () => {
    insertProfile(db, { id: 'p-para', orgId: 'o1', primaryType: 'student' })
    insertProfile(db, { id: 'p-nurse', orgId: 'o1', primaryType: 'student' })
    insertProfile(db, { id: 'p-unknown', orgId: 'o1', primaryType: 'individual' })

    const nursingBad = insertGrant(db, { profile_id: 'p-para', title: 'Ohio Nurses Foundation — CE Scholarships', status: 'interested' })
    const nursingProtected = insertGrant(db, { profile_id: 'p-para', title: 'Nursing & Healthcare Scholarship Resources', status: 'submitted' })
    const relevant = insertGrant(db, { profile_id: 'p-para', title: 'Coca-Cola Scholars Foundation', status: 'interested' })
    const nurseOk = insertGrant(db, { profile_id: 'p-nurse', title: 'Ohio Nurses Foundation — CE Scholarships', status: 'interested' })
    const unknownNursing = insertGrant(db, { profile_id: 'p-unknown', title: 'Ohio Nurses Foundation — CE Scholarships', status: 'interested' })

    insertTask('t-bad', 'p-para', nursingBad, 'blocked')
    insertTask('t-prot', 'p-para', nursingProtected, 'waiting_for_review')
    insertTask('t-rel', 'p-para', relevant, 'blocked')

    const signals = { 'p-para': 'paramedic', 'p-nurse': 'nursing bsn', 'p-unknown': '' }
    const res = await enforceProfileEligibility(db, { resolveSignals: (pid) => signals[pid] ?? '' })
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)

    // Early-status nursing item for the paramedic → purged, task cancelled.
    expect(grantExists(nursingBad)).toBe(false)
    expect(taskStatus('t-bad')).toBe('cancelled')
    // Protected (submitted) nursing grant → KEPT (never destroy user work), but its task cancelled.
    expect(grantExists(nursingProtected)).toBe(true)
    expect(taskStatus('t-prot')).toBe('cancelled')
    // Relevant grant + its task → untouched.
    expect(grantExists(relevant)).toBe(true)
    expect(taskStatus('t-rel')).toBe('blocked')
    // Nursing student's nursing grant → untouched (profession matches).
    expect(grantExists(nurseOk)).toBe(true)
    // Unknown-field profile → never touched.
    expect(grantExists(unknownNursing)).toBe(true)

    expect(res.tasksCancelled).toBe(2)
    expect(res.repaired).toBe(1) // one grant purged
  })

  it('is idempotent (a second run repairs nothing)', async () => {
    insertProfile(db, { id: 'p-para', orgId: 'o1' })
    insertGrant(db, { profile_id: 'p-para', title: 'Ohio Nurses Foundation — CE', status: 'interested' })
    const first = await enforceProfileEligibility(db, { resolveSignals: () => 'paramedic' })
    const second = await enforceProfileEligibility(db, { resolveSignals: () => 'paramedic' })
    expect(first.repaired).toBe(1)
    expect(second.repaired).toBe(0)
  })

  it('is count-only when ENFORCE_PROFESSION_ELIGIBILITY=0', async () => {
    insertProfile(db, { id: 'p-para', orgId: 'o1' })
    const bad = insertGrant(db, { profile_id: 'p-para', title: 'Ohio Nurses Foundation — CE', status: 'interested' })
    process.env.ENFORCE_PROFESSION_ELIGIBILITY = '0'
    try {
      const res = await enforceProfileEligibility(db, { resolveSignals: () => 'paramedic' })
      expect(res.enforced).toBe(false)
      expect(res.scanned).toBeGreaterThan(0)
      expect(grantExists(bad)).toBe(true)
    } finally {
      delete process.env.ENFORCE_PROFESSION_ELIGIBILITY
    }
  })
})
