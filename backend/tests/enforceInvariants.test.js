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
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import fs from 'node:fs'
import path from 'node:path'
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
  enforceIndividualOrgSectionConflict,
  enforceProfileIdIntegrity,
  enforceNoSearchEngineApplicationTargets,
  enforceApplicationUrlRescue,
  enforceImportedStatusHonesty,
  enforceAmountEnrichment,
  enforceGrantDirectAmountEnrichment,
  enforceDeadUrlRepair,
  enforceLocatorKindClassification,
  partitionSystemicStableFailures,
  AMOUNT_ENRICH_FAILURE_LOG_KEY,
  enforceGrantCatalogLink,
  enforceGrantAmountBackfill,
  enforceAmySyntheticExpiry,
  getRelevanceFloor,
  __resetFloorCache,
  RELEVANCE_FLOOR,
  PROTECTED_PIPELINE_STATUSES,
  __testables,
} from '../startup/enforceInvariants.js'
import { recordDismissal } from '../services/pipelineDismissals.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import {
  RELEVANCE_FLOOR as INSERT_RELEVANCE_FLOOR,
  TRUSTED_RELEVANCE_FLOOR,
} from '../config/relevanceFloor.js'

// The boot purge uses the LENIENT floor min(insertFloor, PURGE_FLOOR_CAP);
// the cap is pinned to the TRUSTED insert floor by design (data-point scale:
// insert 7, trusted/purge 5) — see startup/enforceInvariants.js PURGE_FLOOR_CAP.
const PURGE_FLOOR = Math.min(INSERT_RELEVANCE_FLOOR, TRUSTED_RELEVANCE_FLOOR)

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
    // Data-point scale (2026-07-06 evening): insert floor = RELEVANCE_FLOOR (7).
    expect(value).toBe(INSERT_RELEVANCE_FLOOR)
    expect(source).toMatch(/config\/relevanceFloor\.js/)
  })

  it('PURGES below-floor discovery grants by DEFAULT (no opt-in needed)', async () => {
    // The boot purge uses the LENIENT floor (min(insertFloor, purge cap)) so it
    // can never delete a row the insert gate admitted. A clearly-junk score
    // below that lenient floor is purged.
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: PURGE_FLOOR - 1, status: 'discovered' })

    const res = await enforceRelevanceFloor(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)
    expect(count(db)).toBe(0)
  })

  it('does NOT purge a trusted-band row the insert gate would admit (lenient purge floor)', async () => {
    // Regression for the audit's "floor collapse": purge floor must be <= insert
    // floor, so a row in [TRUSTED_RELEVANCE_FLOOR, RELEVANCE_FLOOR) — e.g. a
    // trusted-origin row admitted at the trusted floor (data-point scale: 5–6)
    // — is NOT destroyed by the boot net.
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Borderline', match_score: TRUSTED_RELEVANCE_FLOOR + 1, status: 'discovered' })

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
    insertGrant(db, { id: 'm1', profile_id: 'p1', organization_id: 'org1', title: 'MTSU Research Award', match_score: PURGE_FLOOR - 1, status: 'discovered' })
    insertGrant(db, { id: 'm2', profile_id: 'p1', organization_id: 'org1', title: 'Middle Tennessee State University grant', match_score: PURGE_FLOOR - 1, status: 'discovered' })
    insertGrant(db, { id: 'm3', profile_id: 'p1', organization_id: 'org1', title: 'Generic award', funder: 'TN Portal System', match_score: PURGE_FLOOR - 1, status: 'discovered' })
    // A genuine junk row alongside, to prove the purge still fires for non-protected names.
    insertGrant(db, { id: 'junk', profile_id: 'p1', organization_id: 'org1', title: 'Random low score', match_score: PURGE_FLOOR - 1, status: 'discovered' })

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

describe('enforceIndividualOrgSectionConflict', () => {
  it('clears organization_type + business_name — the Kimberly Botts class (structured self-denial)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'individual' })
    setSection(db, 'p1', 'organization_details', {
      organization_type: 'nonprofit',
      mission: 'To support underrepresented founders...',
      is_minority_serving: true,
    })
    setSection(db, 'p1', 'small_business_details', { business_name: 'Kimberly Botts Nonprofit' })
    setSection(db, 'p1', 'occupation', {
      nonprofit_employee: false,
      small_business_owner: false,
      notes: 'Not a business owner, not a nonprofit employee. Disabled and unable to work.',
    })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(1)
    expect(res.flagged).toBe(0)
    expect(getSection(db, 'p1', 'organization_details').organization_type).toBe(null)
    expect(getSection(db, 'p1', 'small_business_details').business_name).toBe(null)
    // Untouched fields survive.
    expect(getSection(db, 'p1', 'organization_details').is_minority_serving).toBe(true)
  })

  it('NEVER touches an actual organization/business profile', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'org1', primaryType: 'nonprofit' })
    setSection(db, 'org1', 'organization_details', { organization_type: 'nonprofit' })
    setSection(db, 'org1', 'occupation', { nonprofit_employee: false, small_business_owner: false })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(getSection(db, 'org1', 'organization_details').organization_type).toBe('nonprofit')
  })

  it('FLAGS (does not change) an individual with an org section but no structured denial — genuinely may run both', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'individual' })
    setSection(db, 'p1', 'organization_details', { organization_type: 'nonprofit' })
    // No occupation section at all — nothing contradicts the org claim.
    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(res.flagged).toBe(1)
    expect(getSection(db, 'p1', 'organization_details').organization_type).toBe('nonprofit')
  })

  it('FLAGS when occupation flags are present but do not both explicitly deny', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'family' })
    setSection(db, 'p1', 'organization_details', { organization_type: 'nonprofit' })
    setSection(db, 'p1', 'occupation', { nonprofit_employee: true, small_business_owner: false })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(res.flagged).toBe(1)
  })

  it('is a no-op when organization_details has no organization_type', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'individual' })
    setSection(db, 'p1', 'organization_details', { is_minority_serving: true })
    setSection(db, 'p1', 'occupation', { nonprofit_employee: false, small_business_owner: false })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(res.scanned).toBe(0)
  })

  it('is idempotent (a second run repairs nothing)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'p1', primaryType: 'individual' })
    setSection(db, 'p1', 'organization_details', { organization_type: 'nonprofit' })
    setSection(db, 'p1', 'occupation', { nonprofit_employee: false, small_business_owner: false })

    const first = await enforceIndividualOrgSectionConflict(db)
    expect(first.repaired).toBe(1)
    const second = await enforceIndividualOrgSectionConflict(db)
    expect(second.repaired).toBe(0)
  })

  it('degrades silently when profile_sections is absent (no crash at boot)', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE profiles (id TEXT PRIMARY KEY, primary_type TEXT, applicant_type TEXT);')
    raw.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
    const res = await enforceIndividualOrgSectionConflict(raw)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(0)
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
    // Pipeline promotion is intentionally off this boot invariant path.
    expect(summary.ran).toBe(31)
    expect(summary.failed).toBe(0)
    expect(summary.steps.map((s) => s.name)).toEqual([
      'sticky_deletes',
      'profile_id_integrity',
      'no_cross_profile_bleed',
      'profile_scoped_pipeline',
      'no_duplicate_grants',
      'imported_status_honesty',
      'relevance_floor',
      'grant_catalog_link',
      // Positive locator/benefit kind classification (sam.gov /fal/ listings,
      // ssa.gov benefit sections) BEFORE amount acquisition.
      'locator_kind_classification',
      // Dead-URL repair BEFORE amount acquisition so a repaired row is read
      // by the sweeps in this same boot.
      'dead_url_repair',
      'amount_enrichment',
      'grant_amount_backfill',
      'grant_direct_amount',
      'individual_amount_ceiling',
      'student_aid_eligibility',
      'no_dangling_matches',
      'profession_eligibility',
      'funder_backfill',
      'profile_display_name_not_doubled',
      'profile_income_reconciliation',
      'individual_org_section_conflict',
      'hamilton_task_self_heal',
      'no_search_engine_application_targets',
      'live_crawl_verified_at_honesty',
      'application_url_rescue',
      'grant_score_backfill',
      'converted_applications_have_profiles',
      'admin_reinterview_suppression',
      'amy_synthetic_expiry',
      'lead_contact_plausibility',
      // The mailbox residue of a bad lead: a draft already addressed to the
      // wrong org. Runs after the lead repair so it can be re-drafted correctly.
      'john_draft_plausibility',
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
    expect(row.match_score).toBeLessThan(DEFAULT_MIN_SCORE) // below the display floor → no longer surfaces
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

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: application-URL rescue — a candidate rejected ONLY for a missing
// URL gets ONE bounded chance to be re-driven with a real, liveness-verified
// page found by title+sponsor search (never invented); a search-provider
// outage never burns candidates (cursor does not advance).
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceApplicationUrlRescue', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

  // Real production schema so the re-drive exercises the REAL upsert path
  // (provenance/policy/validation/reviewer/reality/dedupe gates all live).
  function makeRescueDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }

  const TITLE = 'Rural Fire Department Equipment Grant'
  const FOUND_URL = 'https://www.fema.gov/grants/rural-fire-department-equipment'
  const CANDIDATE = {
    sponsor: 'FEMA',
    description: 'Funds protective equipment and apparatus for volunteer fire departments serving rural communities.',
    deadline: null,
    amount_min: 5000,
    amount_max: 25000,
    categories: ['equipment', 'community'],
    source: 'grants_gov',
    record_origin: 'grants_gov',
  }

  // candidate: null seeds a LEGACY row (raw_meta without a candidate snapshot).
  function seedRejection(db, { title = TITLE, candidate = CANDIDATE, source = 'grants_gov', reason = 'missing_application_url', stage = 'url' } = {}) {
    const rawMeta = candidate === null
      ? JSON.stringify({ record_origin: 'grants_gov' }) // legacy row: no candidate snapshot
      : JSON.stringify({ record_origin: 'grants_gov', candidate })
    const res = db.prepare(
      'INSERT INTO rejection_log (source, source_url, title, reason, stage, raw_meta) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(source, title, reason, stage, rawMeta)
    return Number(res.lastInsertRowid)
  }

  function cursorValue(db) {
    try {
      const row = db.prepare("SELECT value FROM system_kv WHERE key = 'url_rescue_last_rejection_id'").get()
      return row ? Number(row.value) : null
    } catch {
      return null
    }
  }

  function catalogRows(db) {
    return db.prepare('SELECT * FROM funding_opportunities ORDER BY created_at').all()
  }

  const finderFound = (overrides = {}) => async () => ({
    url: FOUND_URL,
    hit: { url: FOUND_URL, title: TITLE, snippet: 'equipment funding' },
    probe: { status: 'ok', code: 200 },
    searched: true,
    hits: 3,
    ...overrides,
  })

  afterEach(() => {
    delete process.env.ENFORCE_URL_RESCUE
    delete process.env.URL_RESCUE_BOOT_LIMIT
    delete process.env.URL_RESCUE_TIME_BUDGET_MS
  })

  it('rescues a url-less rejection through the REAL upsert path and advances the cursor', async () => {
    const db = makeRescueDb()
    const rejectionId = seedRejection(db)
    const finderCalls = []
    const res = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async (args) => { finderCalls.push(args); return finderFound()() },
    })

    expect(res.ok).toBe(true)
    expect(res.scanned).toBe(1)
    expect(res.attempted).toBe(1)
    expect(res.rescued).toBe(1)
    expect(res.enforced).toBe(true)

    // The finder searched for the candidate's OWN title+sponsor — never invented.
    expect(finderCalls).toEqual([{ title: TITLE, sponsor: 'FEMA' }])

    // The rescued row landed in the catalog via the full gate stack.
    const rows = catalogRows(db)
    expect(rows.length).toBe(1)
    expect(rows[0].title).toBe(TITLE)
    expect(rows[0].sponsor).toBe('FEMA')
    expect(rows[0].source_url).toBe(FOUND_URL)

    // One chance each: the cursor advanced past the rescued row, and a second
    // run scans/attempts nothing.
    expect(cursorValue(db)).toBe(rejectionId)
    const second = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => { throw new Error('must not re-attempt') },
    })
    expect(second.scanned).toBe(0)
    expect(second.attempted).toBe(0)
  })

  it('provider outage (zero hits or failed search) never advances the cursor — a later run retries', async () => {
    const db = makeRescueDb()
    seedRejection(db)

    // Run 1: search provider honestly returns zero hits → outage guard.
    const emptyRun = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => ({ url: null, searched: true, hits: 0 }),
    })
    expect(emptyRun.attempted).toBe(1)
    expect(emptyRun.notFound).toBe(1)
    expect(cursorValue(db)).toBe(null)

    // Run 2: search provider threw (searched:false) → still no advance.
    const failedRun = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => ({ url: null, searched: false, error: 'searxng down' }),
    })
    expect(failedRun.attempted).toBe(1)
    expect(cursorValue(db)).toBe(null)

    // Run 3: providers back up → the same candidate is still rescuable.
    const rescueRun = await enforceApplicationUrlRescue(db, { findOfficialUrl: finderFound() })
    expect(rescueRun.rescued).toBe(1)
    expect(catalogRows(db).length).toBe(1)
  })

  it('a genuine not-found (search worked, hits > 0) consumes the row\'s one chance', async () => {
    const db = makeRescueDb()
    const rejectionId = seedRejection(db)
    const res = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => ({ url: null, searched: true, hits: 5 }),
    })
    expect(res.notFound).toBe(1)
    expect(res.rescued).toBe(0)
    expect(cursorValue(db)).toBe(rejectionId)

    const second = await enforceApplicationUrlRescue(db, { findOfficialUrl: finderFound() })
    expect(second.scanned).toBe(0)
    expect(catalogRows(db).length).toBe(0)
  })

  it('skips rows without a title, and legacy no-meta rows with generic titles; distinctive legacy titles are attempted title-only', async () => {
    const db = makeRescueDb()
    seedRejection(db, { title: null }) // no title → skippedNoTitle
    seedRejection(db, { title: 'Community Grant', candidate: null }) // legacy + generic (1 significant token) → skippedNoMeta
    const distinctiveId = seedRejection(db, {
      title: 'Rural Volunteer Firefighter Equipment Modernization Award',
      candidate: null, // legacy row: title-only rescue allowed (>=4 significant tokens)
      source: 'web_search',
    })

    const finderCalls = []
    const res = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async (args) => { finderCalls.push(args); return { url: null, searched: true, hits: 4 } },
    })

    expect(res.scanned).toBe(3)
    expect(res.skippedNoTitle).toBe(1)
    expect(res.skippedNoMeta).toBe(1)
    expect(res.attempted).toBe(1)
    expect(finderCalls).toEqual([
      { title: 'Rural Volunteer Firefighter Equipment Modernization Award', sponsor: null },
    ])
    // Skips + the honestly-not-found attempt all consumed their chance.
    expect(cursorValue(db)).toBe(distinctiveId)
  })

  it('respects the boot limit without burning un-attempted rows', async () => {
    const db = makeRescueDb()
    const first = seedRejection(db, { title: 'Alpha Volunteer Firefighter Equipment Award One' })
    seedRejection(db, { title: 'Beta Volunteer Firefighter Equipment Award Two' })
    process.env.URL_RESCUE_BOOT_LIMIT = '1'

    const res = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => ({ url: null, searched: true, hits: 2 }),
    })
    expect(res.attempted).toBe(1)
    expect(res.scanned).toBe(1)
    // Cursor stops at the last PROCESSED row — the second row keeps its chance.
    expect(cursorValue(db)).toBe(first)

    delete process.env.URL_RESCUE_BOOT_LIMIT
    const second = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => ({ url: null, searched: true, hits: 2 }),
    })
    expect(second.attempted).toBe(1)
  })

  it('is count-only when ENFORCE_URL_RESCUE=0 (no searches, no inserts, no cursor writes)', async () => {
    const db = makeRescueDb()
    seedRejection(db)
    process.env.ENFORCE_URL_RESCUE = '0'

    const res = await enforceApplicationUrlRescue(db, {
      findOfficialUrl: async () => { throw new Error('must not search in count-only mode') },
    })
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(false)
    expect(res.scanned).toBe(1)
    expect(res.attempted).toBe(0)
    expect(res.rescued).toBe(0)
    expect(catalogRows(db).length).toBe(0)
    expect(cursorValue(db)).toBe(null)
  })

  it('only ever considers stage=url / reason=missing_application_url rows, and tolerates a missing rejection_log table', async () => {
    const db = makeRescueDb()
    seedRejection(db, { reason: 'dead_application_url' })
    seedRejection(db, { stage: 'validation', reason: 'missing_application_url' })
    const res = await enforceApplicationUrlRescue(db, { findOfficialUrl: finderFound() })
    expect(res.scanned).toBe(0)
    expect(res.attempted).toBe(0)

    // Missing tables (fresh/test schema) never fail the sweep.
    const bare = new Database(':memory:')
    const bareRes = await enforceApplicationUrlRescue(bare, { findOfficialUrl: finderFound() })
    expect(bareRes.ok).toBe(true)
    expect(bareRes.scanned).toBe(0)
  })
})

describe('enforceImportedStatusHonesty', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  function seedGrant(db, g = {}) {
    const id = g.id || crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, submitted_date, notes, match_explanation, profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, g.title ?? 'G', g.status ?? 'submitted', g.submitted_date ?? null, g.notes ?? null, g.match_explanation ?? null, g.profile_id ?? null)
    return id
  }
  const statusOf = (db, id) => db.prepare('SELECT status FROM grants WHERE id = ?').get(id).status

  it('demotes import-stamped submitted rows (adapter "(posted)" notes, no submitted_date) to discovered', async () => {
    const db = makeRealDb()
    const id = seedGrant(db, { notes: 'Funding opportunity CPD-2600-DC-0007 (posted).' })
    const res = await enforceImportedStatusHonesty(db)
    expect(res.repaired).toBe(1)
    expect(statusOf(db, id)).toBe('discovered')
  })

  it('demotes admin_schema_repair-stamped submitted rows', async () => {
    const db = makeRealDb()
    const id = seedGrant(db, { match_explanation: JSON.stringify({ source: 'admin_schema_repair', reason: 'Runtime repair backfill' }) })
    const res = await enforceImportedStatusHonesty(db)
    expect(res.repaired).toBe(1)
    expect(statusOf(db, id)).toBe('discovered')
  })

  it('NEVER touches a real submission or human-noted work', async () => {
    const db = makeRealDb()
    const real = seedGrant(db, { submitted_date: '2026-07-01', notes: 'Funding opportunity ABC-1 (posted).' })
    const human = seedGrant(db, { notes: 'Submitted via the state portal, confirmation #123' })
    const pend = seedGrant(db, { status: 'pending_review', notes: 'Funding opportunity XYZ-2 (posted).' })
    const res = await enforceImportedStatusHonesty(db)
    expect(res.repaired).toBe(0)
    expect(statusOf(db, real)).toBe('submitted')
    expect(statusOf(db, human)).toBe('submitted')
    expect(statusOf(db, pend)).toBe('pending_review')
  })

  it('count-only mode via ENFORCE_STATUS_PROVENANCE=0', async () => {
    const db = makeRealDb()
    const id = seedGrant(db, { notes: 'Funding opportunity Q-9 (posted).' })
    process.env.ENFORCE_STATUS_PROVENANCE = '0'
    try {
      const res = await enforceImportedStatusHonesty(db)
      expect(res.scanned).toBe(1)
      expect(res.repaired).toBe(0)
      expect(res.enforced).toBe(false)
      expect(statusOf(db, id)).toBe('submitted')
    } finally {
      delete process.env.ENFORCE_STATUS_PROVENANCE
    }
  })
})

describe('enforceAmountEnrichment', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  function seedLinkedPair(db, { foId = crypto.randomUUID(), sourceUrl = 'https://funder.org/grants' } = {}) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, description, source_url) VALUES (?, ?, ?, ?)`,
    ).run(foId, 'Community Grant', 'A grant.', sourceUrl)
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id) VALUES (?, ?, 'interested', NULL, ?)`,
    ).run(crypto.randomUUID(), 'Community Grant', foId)
    return foId
  }
  const foRow = (db, id) => db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id)

  it('does NOT burn a row when the amount WRITE fails (the "will retry" must be true)', async () => {
    // REGRESSION (prod 2026-07-16). recordAttempt used to run BEFORE the write.
    // The grants.gov adapter shipped `amount_confidence: 'high'` into a REAL
    // column; Postgres threw, the catch logged "non-fatal, will retry" — and the
    // row was ALREADY marked, so the candidate query (which excludes marked
    // rows) could never hand it back. 10 rows whose amounts the API had already
    // returned were burned holding nothing, and the log said it was fine.
    //
    // A row may only be burned for an answer we actually STORED.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    // Force the write to fail the way Postgres did, without needing Postgres.
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/UPDATE funding_opportunities\s+SET amount_min/i.test(sql)) {
        return { run: () => { throw new Error('invalid input syntax for type real: "high"') } }
      }
      return realPrepare(sql)
    }
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 4500000, amount_max: 9000000, amount_text: null, amount_status: 'range', amount_confidence: 'high' },
      }),
      limit: 1,
    })
    db.prepare = realPrepare

    const row = foRow(db, foId)
    expect(row.amount_enrich_attempted_at, 'a failed write must NOT burn the row').toBeNull()
    expect(res.repaired).toBe(0)
    // And it is still a candidate next run — the whole point.
    const again = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 4500000, amount_max: 9000000, amount_text: null, amount_status: 'range', amount_confidence: 0.95 },
      }),
      limit: 1,
    })
    expect(again.repaired).toBe(1)
    expect(foRow(db, foId).amount_max).toBe(9000000)
  })

  it('RECORDS the denial when the page was read and states no per-award figure', async () => {
    // REGRESSION (prod 2026-07-17). The sweep fetched the funder's page, the
    // extractor scanned real copy, and the answer — "this funder publishes no
    // per-award figure" — was thrown away: the write branch only persisted a
    // status when it was NOT 'not_listed', which is exactly what the extractor
    // returns for that case. So the row stayed blank and indistinguishable from
    // one nothing had ever looked at, and every consumer downstream
    // (pipeline.amountCoverage, Amy's amount_recall_miss) had to treat a funder
    // that pays no stated award as a CRAWLER MISS. 28 of 50 synthetic profiles
    // failed on that conflation.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: false,
        reason: 'no_per_award_amount_on_page', amount_text: null, amount_status: 'not_listed',
      }),
      limit: 1,
    })
    const row = foRow(db, foId)
    expect(row.amount_status, 'a READ page that states no figure must record the denial').toBe('none_published')
    expect(res.nonePublished).toBe(1)
    // It is an ANSWER, so the row is burned — and stays out of future candidacy.
    expect(row.amount_enrich_attempted_at).not.toBeNull()
  })

  it('does NOT record a denial when the page could not be READ (thin page / JS shell)', async () => {
    // The guard that keeps `none_published` honest. A JS shell means the
    // extractor never saw award copy, so we have learned NOTHING about whether
    // this funder publishes a figure. Recording a denial here would fabricate
    // evidence and silently retire the row from the coverage metric — the very
    // rows that need an API ADAPTER would be the ones that vanish from the
    // report. Reaching them is grants.gov's lesson, not a status write.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page',
      }),
      limit: 1,
    })
    const row = foRow(db, foId)
    expect(row.amount_status, 'an UNREAD page must never manufacture a denial').not.toBe('none_published')
    expect(res.nonePublished ?? 0).toBe(0)
  })

  it('prefers an honest label the page stated over the bare denial', async () => {
    // "amounts vary" is strictly more informative than "no figure published",
    // so a real label wins; none_published is the floor, not an override.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: false,
        reason: 'no_per_award_amount_on_page', amount_text: 'amounts vary by need', amount_status: 'varies',
      }),
      limit: 1,
    })
    const row = foRow(db, foId)
    expect(row.amount_status).toBe('varies')
    expect(row.amount_text).toBe('amounts vary by need')
  })

  it('never downgrades a row that already carries a real amount', async () => {
    // A denial must not overwrite a figure that landed between scan and write
    // (the #950 class: the least-informed writer must never win).
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    db.prepare('UPDATE funding_opportunities SET amount_max = 9000, amount_status = ? WHERE id = ?')
      .run('known', foId)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: false,
        reason: 'no_per_award_amount_on_page', amount_text: null, amount_status: 'not_listed',
      }),
      limit: 1,
    })
    const row = foRow(db, foId)
    expect(row.amount_max).toBe(9000)
    expect(row.amount_status).toBe('known')
  })

  it('persists per-award amounts learned from the funder page', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 1000, amount_max: 5000, amount_text: 'grants of $1,000 to $5,000', amount_status: 'range', amount_confidence: 0.9 },
      }),
    })
    expect(res.repaired).toBe(1)
    const row = foRow(db, foId)
    expect(row.amount_min).toBe(1000)
    expect(row.amount_max).toBe(5000)
    expect(row.amount_status).toBe('range')
  })

  it('persists an honest text/status label when the page has no per-award number', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page', amount_text: 'Amounts vary', amount_status: 'varies' }),
    })
    expect(res.repaired).toBe(0)
    expect(res.textOnly).toBe(1)
    const row = foRow(db, foId)
    expect(row.amount_text).toBe('Amounts vary')
    expect(row.amount_status).toBe('varies')
  })

  it('remembers attempted rows so a dry page is not re-fetched every boot', async () => {
    const db = makeRealDb()
    seedLinkedPair(db)
    let calls = 0
    const deps = {
      enrichImpl: async () => { calls++; return { attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' } },
    }
    await enforceAmountEnrichment(db, deps)
    await enforceAmountEnrichment(db, deps)
    expect(calls).toBe(1)
  })

  // The burn bug. The service is documented "never throws" and RETURNS its
  // failures, but the sweep called markAttempted() unconditionally and put the
  // retry rule in a catch block that could therefore never run. A 503 burned
  // the row's one and only chance, forever. Prod 2026-07-15: 30 rows marked
  // attempted, 0 amounts extracted, 0 retried.
  it('does NOT burn a row when the fetch failed transiently — it retries it', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    let calls = 0
    const deps = {
      enrichImpl: async () => {
        calls++
        return { attempted: true, page_read: false, transient: true, found: false, reason: 'fetch_failed:503' }
      },
    }
    const first = await enforceAmountEnrichment(db, deps)
    expect(first.retryable).toBe(1)
    // Unmarked, so it is still a candidate...
    expect(foRow(db, foId).amount_enrich_attempted_at).toBeNull()
    expect(foRow(db, foId).amount_enrich_attempts).toBe(1)
    // ...and the next pass actually tries it again. On the old code the row was
    // marked on the first pass and calls stuck at 1 forever.
    await enforceAmountEnrichment(db, deps)
    expect(calls).toBe(2)
  })

  it('gives up on a permanently-down host after MAX_ATTEMPTS so it cannot be re-fetched forever', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    let calls = 0
    const deps = {
      maxAttempts: 2,
      enrichImpl: async () => { calls++; return { attempted: true, page_read: false, transient: true, found: false, reason: 'fetch_failed:503' } },
    }
    await enforceAmountEnrichment(db, deps)
    expect(foRow(db, foId).amount_enrich_attempted_at).toBeNull()
    await enforceAmountEnrichment(db, deps)
    // Second strike hits maxAttempts: burned, so the budget moves on.
    expect(foRow(db, foId).amount_enrich_attempted_at).not.toBeNull()
    await enforceAmountEnrichment(db, deps)
    expect(calls).toBe(2)
  })

  it('burns a row whose page was READ but stated no per-award amount', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    const deps = {
      enrichImpl: async () => ({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page' }),
    }
    await enforceAmountEnrichment(db, deps)
    // We learned this row's answer, so we stop asking — the one-shot mark is
    // correct HERE, and only here.
    expect(foRow(db, foId).amount_enrich_attempted_at).not.toBeNull()
  })

  it('an ENVIRONMENT-blocked failure (WAF 403) NEVER burns the row — not even via out-of-retries', async () => {
    // REGRESSION (prod 2026-07-21). The grants.gov adapter has effectively
    // never succeeded from Railway: a WAF 403 blocks every datacenter-egress
    // call while the identical keyless request works from a residential
    // machine. The old adapter read the 403 as "stable" → transient:false →
    // this sweep's burn rule permanently burned each knowable row answerless.
    // Even with the adapter fixed to transient:true, MAX_ATTEMPTS bad nights
    // would burn the row via out-of-retries — but a blocked ENVIRONMENT fails
    // every row identically until an owner action (API key / egress) fixes it,
    // so it must not consume the row's retry budget at all.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    let calls = 0
    const deps = {
      maxAttempts: 2, // tight budget: the old rule burns on the 2nd strike
      enrichImpl: async () => {
        calls++
        return {
          attempted: true, page_read: false, transient: true, environment: true,
          status: 403, found: false, reason: 'grants_gov_api_failed:http_403',
        }
      },
    }
    for (let i = 0; i < 5; i++) await enforceAmountEnrichment(db, deps)
    expect(calls, 'the row stays a candidate every pass').toBe(5)
    const row = foRow(db, foId)
    expect(row.amount_enrich_attempted_at, 'an egress block must never burn the row').toBeNull()
    expect(row.amount_enrich_attempts, 'an egress block must not consume the retry budget').toBe(0)
    // The SEPARATE env counter (migration 151/0155) is what accumulated instead
    // — 5 consecutive environment failures, each one visible to the census.
    expect(row.amount_enrich_env_attempts, 'consecutive env failures must be COUNTED, or the block is invisible').toBe(5)
    // And once the environment clears, the row still converts normally.
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 1000, amount_max: 5000, amount_text: null, amount_status: 'range', amount_confidence: 0.9 },
      }),
    })
    expect(res.repaired).toBe(1)
    expect(foRow(db, foId).amount_max).toBe(5000)
    // …and the successful probe LIFTS the block: the env counter resets to 0.
    expect(foRow(db, foId).amount_enrich_env_attempts, 'any non-environment outcome must reset the env counter').toBe(0)
  })

  it('a BLOCKED row (env failures >= ENV_MAX) leaves the main batch but stays re-probed on the slow lane', async () => {
    // Fix-cycle 2 (2026-07-21): before the lane split, low-id blocked rows
    // re-entered the bounded batch every run (attempts=0 sorts first) and
    // STARVED valid never-attempted rows out of the budget entirely. The
    // blocked row must (a) stop occupying the main batch, (b) still be
    // re-probed — bounded — so the block lifts on its own when egress heals.
    const db = makeRealDb()
    const blockedId = seedLinkedPair(db, { sourceUrl: 'https://www.grants.gov/search-results-detail/1' })
    // Pre-blocked: 3 consecutive env failures already recorded.
    db.prepare('UPDATE funding_opportunities SET amount_enrich_env_attempts = 3 WHERE id = ?').run(blockedId)
    const freshId = seedLinkedPair(db, { sourceUrl: 'https://funder.org/fresh-grant' })
    const seen = []
    const deps = {
      limit: 1, // batch budget of ONE: the starvation scenario
      envMaxAttempts: 3,
      envReprobeLimit: 1,
      enrichImpl: async (row) => {
        seen.push(row.id)
        return row.id === blockedId
          ? { attempted: true, page_read: false, transient: true, environment: true, status: 403, found: false, reason: 'grants_gov_api_failed:http_403' }
          : { attempted: true, page_read: true, transient: false, found: true, amounts: { amount_min: null, amount_max: 2500, amount_text: null, amount_status: 'range', amount_confidence: 0.9 } }
      },
    }
    const res = await enforceAmountEnrichment(db, deps)
    // The single main-batch slot went to the FRESH row (the blocked row could
    // not occupy it), AND the blocked row still got its bounded re-probe.
    expect(seen).toContain(freshId)
    expect(seen).toContain(blockedId)
    expect(res.repaired, 'the fresh row converts — not starved by the blocked one').toBe(1)
    expect(foRow(db, blockedId).amount_enrich_env_attempts, 'the failed re-probe keeps counting').toBe(4)
    // A later successful probe lifts the block entirely.
    await enforceAmountEnrichment(db, {
      ...deps,
      enrichImpl: async () => ({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page' }),
    })
    expect(foRow(db, blockedId).amount_enrich_env_attempts).toBe(0)
  })

  it('RECORDS failure telemetry (status + reason) to the system_kv ring so the outage class is diagnosable', async () => {
    // The other half of the 2026-07-21 fix: the WAF block was invisible —
    // `fetchFailed` counted THAT rows failed but nothing recorded WHY, so
    // diagnosing "every call is http_403 from this egress" needed a prod DB
    // spelunk. Every failed enrich attempt must leave its status/reason in
    // system_kv `amount_enrich_failure_log` (Sam/Anya-visible).
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: false, transient: true, environment: true,
        status: 403, found: false, reason: 'grants_gov_api_failed:http_403',
      }),
    })
    const kv = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ENRICH_FAILURE_LOG_KEY)
    const ring = JSON.parse(kv.value)
    expect(ring.failures).toHaveLength(1)
    expect(ring.failures[0]).toMatchObject({
      lane: 'catalog',
      id: String(foId),
      status: 403,
      reason: 'grants_gov_api_failed:http_403',
      transient: true,
      environment: true,
    })
    // Stable failures are recorded too (a thin_page names adapter work).
    // Scoped to the new row: the env-blocked row above is DELIBERATELY still a
    // candidate (that is the fix), so an unscoped pass would re-read it too.
    const fo2 = seedLinkedPair(db, { sourceUrl: 'https://shell.example/opp' })
    await enforceAmountEnrichment(db, {
      opportunityIds: [fo2],
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }),
    })
    const ring2 = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ENRICH_FAILURE_LOG_KEY).value)
    expect(ring2.failures).toHaveLength(2)
    expect(ring2.failures[1]).toMatchObject({ lane: 'catalog', id: String(fo2), status: null, reason: 'thin_page', environment: false })
  })

  it('the failure ring is BOUNDED (oldest entries fall off, sweep never fails on it)', async () => {
    const db = makeRealDb()
    // Pre-seed a full ring; the next failure must displace the oldest.
    db.exec('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    const old = Array.from({ length: 50 }, (_, i) => ({ at: 'x', lane: 'catalog', id: `old-${i}`, status: 503, reason: 'fetch_failed:503', transient: true, environment: false }))
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(AMOUNT_ENRICH_FAILURE_LOG_KEY, JSON.stringify({ updated_at: 'x', failures: old }), 'x')
    seedLinkedPair(db)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: true, environment: true, status: 403, found: false, reason: 'grants_gov_api_failed:http_403' }),
    })
    const ring = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ENRICH_FAILURE_LOG_KEY).value)
    expect(ring.failures).toHaveLength(50)
    expect(ring.failures[0].id).toBe('old-1') // oldest displaced
    expect(ring.failures.at(-1)).toMatchObject({ status: 403, environment: true }) // newest appended
  })

  it('retries never starve never-tried rows out of the budget', async () => {
    const db = makeRealDb()
    // Ids are PINNED, and pinned adversarially: the stale row sorts FIRST by id.
    // The old sweep ordered by fo.id alone, so with random UUIDs this test
    // passed ~half the time by luck — vacuously green, asserting nothing. The
    // retried row must lose to the fresh one on ATTEMPTS despite winning on id.
    const stale = seedLinkedPair(db, { foId: '00000000-0000-4000-8000-000000000001', sourceUrl: 'https://down.example/grants' })
    db.prepare('UPDATE funding_opportunities SET amount_enrich_attempts = 2 WHERE id = ?').run(stale)
    // ...must not crowd out a fresh one when the budget is a single fetch.
    const fresh = seedLinkedPair(db, { foId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sourceUrl: 'https://fresh.example/grants' })
    const seen = []
    await enforceAmountEnrichment(db, {
      limit: 1,
      enrichImpl: async (cand) => {
        seen.push(cand.id)
        return { attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page' }
      },
    })
    expect(seen).toEqual([fresh])
  })

  it('reports `exhausted` so remaining=0 cannot pass for success when nothing was learned', async () => {
    const db = makeRealDb()
    seedLinkedPair(db)
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page' }),
    })
    // Backlog drained, but the coverage gap is INTACT — the report must be able
    // to tell that apart from every row having gotten an amount.
    expect(res.remaining).toBe(0)
    expect(res.exhausted).toBe(1)
  })

  it('only targets amount-less rows linked to ACTIVE pipeline grants', async () => {
    const db = makeRealDb()
    const valued = crypto.randomUUID()
    db.prepare(`INSERT INTO funding_opportunities (id, title, source_url, amount_max) VALUES (?, 'V', 'https://x.org', 5000)`).run(valued)
    db.prepare(`INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id) VALUES (?, 'V', 'interested', NULL, ?)`).run(crypto.randomUUID(), valued)
    db.prepare(`INSERT INTO funding_opportunities (id, title, source_url) VALUES (?, 'U', 'https://y.org')`).run(crypto.randomUUID())
    let calls = 0
    const res = await enforceAmountEnrichment(db, { enrichImpl: async () => { calls++; return { attempted: true, found: false } } })
    expect(calls).toBe(0)
    expect(res.scanned).toBe(0)
  })

  it('count-only mode via ENFORCE_AMOUNT_ENRICHMENT=0', async () => {
    const db = makeRealDb()
    seedLinkedPair(db)
    process.env.ENFORCE_AMOUNT_ENRICHMENT = '0'
    try {
      let calls = 0
      const res = await enforceAmountEnrichment(db, { enrichImpl: async () => { calls++; return {} } })
      expect(calls).toBe(0)
      expect(res.scanned).toBe(1)
      expect(res.enforced).toBe(false)
    } finally {
      delete process.env.ENFORCE_AMOUNT_ENRICHMENT
    }
  })

  // REGRESSION (the "pinned at 12% coverage" class): the sweep must reach rows
  // beyond its first batch. The original implementation SELECTed a hardcoded
  // `LIMIT 200` and then dropped already-attempted rows in JS, so once those
  // 200 rows were attempted every later run filtered them all away, reported
  // zero candidates, and never reached row 201 — enrichment looked green while
  // permanently stalled. Seeding >200 rows is what makes this observable; a
  // 1-2 row fixture passes against the broken code.
  it('reaches rows beyond the first batch instead of wedging on one window', async () => {
    const db = makeRealDb()
    const TOTAL = 210
    // Distinct hosts: 210 identical failures against ONE host is the systemic
    // outage signature (burns withheld by design — see the systemic-burn guard
    // suite); the realistic drained-backlog shape this test pins is many
    // different funders each honestly thin.
    for (let i = 0; i < TOTAL; i++) seedLinkedPair(db, { sourceUrl: `https://funder-${i}.org/g/${i}` })

    const seen = new Set()
    const deps = {
      enrichImpl: async (cand) => { seen.add(String(cand.id)); return { attempted: true, found: false, reason: 'thin_page' } },
    }
    // First pass takes a full 200-row batch — the exact window the old code
    // could never escape. The second must pick up the remaining 10.
    const first = await enforceAmountEnrichment(db, { ...deps, limit: 200 })
    expect(first.attempted).toBe(200)

    const second = await enforceAmountEnrichment(db, { ...deps, limit: 200 })
    expect(second.attempted).toBe(TOTAL - 200) // old code: 0 — stalled forever
    expect(seen.size).toBe(TOTAL)

    // Exhausted, and stays exhausted: no page is re-fetched.
    const third = await enforceAmountEnrichment(db, { ...deps, limit: 200 })
    expect(third.attempted ?? 0).toBe(0)
    expect(seen.size).toBe(TOTAL)
  })

  it('does not burn a row when the fetch itself fails (a transient outage is retried)', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    let calls = 0
    // First pass: the fetcher throws (timeout/5xx). The row must stay eligible.
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => { calls++; throw new Error('ETIMEDOUT') },
    })
    expect(calls).toBe(1)
    expect(foRow(db, foId).amount_enrich_attempted_at).toBeNull()

    // Second pass: the page is reachable and the amount lands.
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, found: true,
        amounts: { amount_min: 500, amount_max: 2500, amount_text: '$500 to $2,500', amount_status: 'range', amount_confidence: 0.9 },
      }),
    })
    expect(res.repaired).toBe(1)
    expect(foRow(db, foId).amount_max).toBe(2500)
    expect(foRow(db, foId).amount_enrich_attempted_at).not.toBeNull()
  })

  // Per-row LAST-reason observability (migration 153/0157). The rolling
  // system_kv failure-log ring ages out, so a source that burned weeks ago is
  // faceless — its counter says "burned once", nothing says WHY. Pinning the
  // service's reason to the row turns the backlog into a triage table.
  it('PINS the enrich reason to the row for a STABLE WAF-403 burn (so the faceless backlog self-documents)', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: false, transient: false, found: false, reason: 'fetch_failed:403',
      }),
      limit: 1,
    })
    const row = foRow(db, foId)
    expect(row.amount_enrich_attempted_at, 'a stable 4xx is a learned answer → burned').not.toBeNull()
    // The headline assertion: the reason is now durable ON THE ROW, not just in
    // a rolling ring that drops it. `SELECT last_reason, COUNT(*) GROUP BY` IS
    // the triage of "adapter work vs egress fix vs genuinely dead".
    expect(row.amount_enrich_last_reason).toBe('fetch_failed:403')
  })

  it('PINS a thin_page reason so an answerless JS-shell source names itself', async () => {
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }),
      limit: 1,
    })
    expect(foRow(db, foId).amount_enrich_last_reason).toBe('thin_page')
  })

  it('records the reason for a transient NON-burn too, then CLEARS it to null once the amount lands (no stale reason on an answered row)', async () => {
    // The reason is the LAST outcome, not just the burn outcome — so a row still
    // in flight shows why it is failing (a 503 tonight), and that must not fossilize
    // once the row is answered: a row that eventually gets an amount has NO failure
    // reason, and `last_reason` must read null there, not the long-gone 503.
    const db = makeRealDb()
    const foId = seedLinkedPair(db)
    // Pass 1: transient 503 — retried, NOT burned, but its reason IS the last outcome.
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: true, found: false, reason: 'fetch_failed:503' }),
      limit: 1,
    })
    const after503 = foRow(db, foId)
    expect(after503.amount_enrich_attempted_at, 'a transient failure is NOT a burn').toBeNull()
    expect(after503.amount_enrich_last_reason, 'the latest outcome is still recorded even when not burned').toBe('fetch_failed:503')
    // Pass 2: the page comes up, the amount lands. A found result carries no
    // `reason`, so the column must reset to null — not keep the stale 503.
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 1000, amount_max: 5000, amount_text: '$1k–$5k', amount_status: 'range', amount_confidence: 0.9 },
      }),
      limit: 1,
    })
    const answered = foRow(db, foId)
    expect(answered.amount_max).toBe(5000)
    expect(answered.amount_enrich_last_reason, 'an ANSWERED row must not carry a stale failure reason').toBeNull()
  })
})

describe('enforceAmountEnrichment — systemic-burn guard (the 2026-07-22 mass burn)', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  function seedLinkedPair(db, { foId = crypto.randomUUID(), sourceUrl } = {}) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, description, source_url) VALUES (?, ?, ?, ?)`,
    ).run(foId, 'Grant ' + foId.slice(0, 6), 'A grant.', sourceUrl)
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id) VALUES (?, ?, 'interested', NULL, ?)`,
    ).run(crypto.randomUUID(), 'Grant', foId)
    return foId
  }
  const foRow = (db, id) => db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(id)
  const STABLE_FAIL = {
    attempted: true, page_read: false, transient: false, found: false,
    reason: 'grants_gov_api_failed:no_synopsis_or_forecast',
  }

  it('withholds ALL burns when every row of a host fails identically and none was read', async () => {
    // REGRESSION (prod 2026-07-22 16:45Z). Eleven minutes after #1006 deployed,
    // one run burned 34 grants.gov rows in ~5 seconds — each API call failing
    // ~150ms apart with the SAME stable-class reason — while every one of those
    // ids answers perfectly today (verified live from the prod egress,
    // 2026-07-25). A "stable" failure is a per-ROW judgment; 34 identical ones
    // against one host, with not a single successful read of that host, is a
    // fact about the RUN. Burning on it converted one degraded afternoon at the
    // API into permanently answerless rows the (later-deployed) triage
    // instrumentation could never even reach — the sweep saw 0 candidates.
    const db = makeRealDb()
    const ids = Array.from({ length: 4 }, (_, i) =>
      seedLinkedPair(db, { sourceUrl: `https://www.grants.gov/search-results-detail/36000${i}` }))
    const res = await enforceAmountEnrichment(db, {
      enrichImpl: async () => STABLE_FAIL,
      limit: 4,
      systemicStreakLimit: 4,
    })
    for (const id of ids) {
      const row = foRow(db, id)
      expect(row.amount_enrich_attempted_at, 'a systemic failure must NOT burn the row').toBeNull()
      expect(row.amount_enrich_env_attempts, 'systemic failures park on the environment lane').toBe(1)
      expect(row.amount_enrich_attempts, 'systemic failures spend no ordinary retry budget').toBe(0)
      expect(row.amount_enrich_last_reason, 'the reason breadcrumb is still recorded').toBe(STABLE_FAIL.reason)
    }
    expect(res.envBlocked).toBe(4)
  })

  it('still burns when the same host ALSO produced a real read this run', async () => {
    // A live host is proof the failures are genuinely row-specific: if one
    // grants.gov row answered, the other rows' stable failures are facts about
    // those rows, and withholding their burns would let dead ids be re-fetched
    // nightly forever.
    const db = makeRealDb()
    const failIds = Array.from({ length: 4 }, (_, i) =>
      seedLinkedPair(db, { foId: `aa-fail-${i}`, sourceUrl: `https://www.grants.gov/search-results-detail/36100${i}` }))
    seedLinkedPair(db, { foId: 'zz-ok', sourceUrl: 'https://www.grants.gov/search-results-detail/361999' })
    await enforceAmountEnrichment(db, {
      enrichImpl: async (cand) =>
        cand.id === 'zz-ok'
          ? {
              attempted: true, page_read: true, transient: false, found: true,
              amounts: { amount_min: 1000, amount_max: 5000, amount_text: null, amount_status: 'range', amount_confidence: 0.9 },
            }
          : STABLE_FAIL,
      limit: 5,
      systemicStreakLimit: 4,
    })
    for (const id of failIds) {
      expect(foRow(db, id).amount_enrich_attempted_at, 'row-specific stable failures on a LIVE host still burn').not.toBeNull()
    }
  })

  it('burns normally below the streak limit', async () => {
    const db = makeRealDb()
    const ids = Array.from({ length: 2 }, (_, i) =>
      seedLinkedPair(db, { sourceUrl: `https://www.grants.gov/search-results-detail/36200${i}` }))
    await enforceAmountEnrichment(db, {
      enrichImpl: async () => STABLE_FAIL,
      limit: 2,
      systemicStreakLimit: 4,
    })
    for (const id of ids) {
      expect(foRow(db, id).amount_enrich_attempted_at, 'an isolated stable failure is still a real burn').not.toBeNull()
    }
  })

  it('partitionSystemicStableFailures groups by host AND reason', () => {
    // Two hosts failing 2× each with the same reason must not pool into one
    // 4-row "systemic" group — the signature is per-host uniformity.
    const pending = [
      { id: '1', host: 'a.gov', reason: 'x' },
      { id: '2', host: 'a.gov', reason: 'x' },
      { id: '3', host: 'b.gov', reason: 'x' },
      { id: '4', host: 'b.gov', reason: 'x' },
    ]
    const { burnNow, systemic } = partitionSystemicStableFailures(pending, new Set(), 4)
    expect(systemic).toHaveLength(0)
    expect(burnNow).toHaveLength(4)
    const uniform = pending.map((p) => ({ ...p, host: 'a.gov' }))
    const split = partitionSystemicStableFailures(uniform, new Set(), 4)
    expect(split.systemic).toHaveLength(4)
    // ...unless that host proved alive this run.
    const alive = partitionSystemicStableFailures(uniform, new Set(['a.gov']), 4)
    expect(alive.systemic).toHaveLength(0)
  })
})

describe('enforceDeadUrlRepair', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    // The repair-attempt state rides in system_kv (created by boot elsewhere).
    db.exec(`CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`)
    return db
  }
  const DEAD = { status: 'broken', code: null, method: null, error: 'ENOTFOUND' }
  const ALIVE = { status: 'ok', code: 200, method: 'head', error: null, finalUrl: null }
  const insDeadOrphan = (db, { url = 'https://pacfcf.org/scholarships', reason = 'fetch_failed:ssrf_guard', title = 'Polish American Congress Charitable Foundation Scholarships' } = {}) => {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, url,
                           amount_enrich_attempted_at, amount_enrich_attempts, amount_enrich_last_reason)
       VALUES (?, ?, 'interested', NULL, NULL, ?, '2026-07-25T12:00:00.000Z', 3, ?)`,
    ).run(id, title, url, reason)
    return id
  }
  const grantRow = (db, id) => db.prepare('SELECT * FROM grants WHERE id = ?').get(id)

  it('repairs a dead orphan URL with a live, plausibility-gated page and resets the enrich state', async () => {
    // The pacfcf.org / 1stresponderchildren.org class: NXDOMAIN forever, but
    // the ORGANIZATION is real and its page is findable by the row's own
    // title+sponsor. Repair the URL, reset the burn — the amount lane reads
    // the real page next.
    const db = makeRealDb()
    const gId = insDeadOrphan(db)
    const res = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => ({ url: 'https://pac1944.org/charitable-foundation/scholarships', searched: true, hits: 4 }),
    })
    const g = grantRow(db, gId)
    expect(g.url).toBe('https://pac1944.org/charitable-foundation/scholarships')
    expect(g.amount_enrich_attempted_at, 'a new URL is a new claim — the burn resets').toBeNull()
    expect(g.amount_enrich_attempts).toBe(0)
    expect(g.amount_enrich_last_reason).toBe('dead_url_repaired')
    expect(res.repaired).toBe(1)
  })

  it('repairs a LINKED row on its catalog side (source_url), scoped to active real pipelines', async () => {
    const db = makeRealDb()
    const foId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source_url, is_active,
                                          amount_enrich_attempted_at, amount_enrich_attempts, amount_enrich_last_reason)
       VALUES (?, 'Tennessee STEP UP Scholarship', 'TSAC', 'https://www.tn.gov/old-dead-path.html', 1,
               '2026-07-25T12:00:00.000Z', 3, 'fetch_failed:404')`,
    ).run(foId)
    db.prepare(`INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id) VALUES (?, 'STEP UP', 'interested', NULL, ?)`)
      .run(crypto.randomUUID(), foId)
    const res = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => ({ url: 'https://www.tn.gov/collegepays/new-path.html', searched: true, hits: 2 }),
    })
    const fo = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(foId)
    expect(fo.source_url).toBe('https://www.tn.gov/collegepays/new-path.html')
    expect(fo.amount_enrich_attempted_at).toBeNull()
    expect(res.repaired).toBe(1)
  })

  it('a "dead" URL that answers today is un-burned, not rewritten (transient-404 recovery)', async () => {
    const db = makeRealDb()
    const gId = insDeadOrphan(db, { reason: 'fetch_failed:404' })
    let searches = 0
    const res = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => ALIVE,
      findOfficialUrl: async () => { searches++; return { url: null, searched: true, hits: 0 } },
    })
    const g = grantRow(db, gId)
    expect(searches, 'an alive URL never spends a search').toBe(0)
    expect(g.url, 'the URL was never the problem').toBe('https://pacfcf.org/scholarships')
    expect(g.amount_enrich_attempted_at, 'un-burned for an ordinary re-read').toBeNull()
    expect(g.amount_enrich_attempts, 'counters preserved — MAX_ATTEMPTS still bounds a flapping host').toBe(3)
    expect(res.recoveredAlive).toBe(1)
  })

  it('a provider OUTAGE spends no attempt; a genuine not-found spends one and exhausts at the cap', async () => {
    const db = makeRealDb()
    insDeadOrphan(db)
    // Outage: searched:false → state untouched.
    await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => ({ url: null, searched: false, error: 'provider down' }),
      maxAttempts: 1,
    })
    const afterOutage = db.prepare(`SELECT value FROM system_kv WHERE key = 'dead_url_repair_state'`).get()
    expect(JSON.stringify(Object.keys(JSON.parse(afterOutage?.value ?? '{"entries":{}}').entries))).toBe('[]')
    // Genuine not-found at maxAttempts=1 → exhausted; a later run skips it.
    const r2 = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => ({ url: null, searched: true, hits: 3 }),
      maxAttempts: 1,
    })
    expect(r2.notFound).toBe(1)
    let searches = 0
    const r3 = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => { searches++; return { url: 'https://real.org/x', searched: true, hits: 1 } },
      maxAttempts: 1,
    })
    expect(searches, 'an exhausted row never searches again').toBe(0)
    expect(r3.skippedCooldown).toBe(1)
  })

  it('refuses a search-engine URL and never writes it (canonical URL hygiene)', async () => {
    const db = makeRealDb()
    const gId = insDeadOrphan(db)
    const res = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => DEAD,
      findOfficialUrl: async () => ({ url: 'https://www.google.com/search?q=pacfcf+scholarships', searched: true, hits: 5 }),
    })
    expect(grantRow(db, gId).url).toBe('https://pacfcf.org/scholarships')
    expect(res.refused).toBe(1)
    expect(res.repaired).toBe(0)
  })

  it('a burned row with a NON-dead reason (thin_page) is never a candidate', async () => {
    const db = makeRealDb()
    const gId = insDeadOrphan(db, { reason: 'thin_page' })
    let probes = 0
    const res = await enforceDeadUrlRepair(db, {
      checkUrlImpl: async () => { probes++; return DEAD },
      findOfficialUrl: async () => ({ url: 'https://real.org/x', searched: true, hits: 1 }),
    })
    expect(probes, 'a JS-shell burn is adapter work, not URL rot').toBe(0)
    expect(res.scanned).toBe(0)
    expect(grantRow(db, gId).url).toBe('https://pacfcf.org/scholarships')
  })

  it('count-only mode scans without probing, searching, or writing', async () => {
    const db = makeRealDb()
    const gId = insDeadOrphan(db)
    const prev = process.env.ENFORCE_DEAD_URL_REPAIR
    process.env.ENFORCE_DEAD_URL_REPAIR = '0'
    try {
      let network = 0
      const res = await enforceDeadUrlRepair(db, {
        checkUrlImpl: async () => { network++; return DEAD },
        findOfficialUrl: async () => { network++; return { url: 'https://real.org/x', searched: true, hits: 1 } },
      })
      expect(network).toBe(0)
      expect(res.scanned).toBe(1)
      expect(res.enforced).toBe(false)
      expect(grantRow(db, gId).amount_enrich_attempted_at).not.toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_DEAD_URL_REPAIR
      else process.env.ENFORCE_DEAD_URL_REPAIR = prev
    }
  })
})

describe('enforceGrantDirectAmountEnrichment', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  // An ORPHAN grant: active pipeline, a URL, no catalog link, no amount, silent.
  const insOrphan = (db, { url = 'https://swe.org/scholarship', status = 'interested' } = {}) => {
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, url) VALUES (?, ?, ?, NULL, NULL, ?)`,
    ).run(id, 'Scholarship', status, url)
    return id
  }
  const grantRow = (db, id) => db.prepare('SELECT * FROM grants WHERE id = ?').get(id)

  it('reads an orphan grant\'s own page and writes the amount ONTO THE GRANT', async () => {
    // THE LAST-MILE GAP. A grant with no catalog twin is invisible to the catalog
    // sweep (which JOINs through funding_opportunity_id). Reading its own url is
    // the only way it ever gets an amount. Coca-Cola Scholars / HSF / Elks are
    // real scholarships that publish a figure — this is how it lands.
    const db = makeRealDb()
    const gId = insOrphan(db)
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: true,
        amounts: { amount_min: 5000, amount_max: 20000, amount_text: '$5,000–$20,000', amount_status: 'range', amount_confidence: 0.9 },
      }),
    })
    const g = grantRow(db, gId)
    expect(g.amount_max).toBe(20000)
    expect(g.amount_status).toBe('range')
    expect(res.repaired).toBe(1)
    expect(g.amount_enrich_attempted_at).not.toBeNull()
  })

  it('records none_published ON THE GRANT when the page states no figure (a locator)', async () => {
    // Eldercare Locator / FAFSA / AAAD: read, no per-award figure → an honest
    // denial on the grant, which is an ANSWER (the coverage census stops
    // counting it as unanswered).
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://eldercare.acl.gov/' })
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({
        attempted: true, page_read: true, transient: false, found: false,
        reason: 'no_per_award_amount_on_page', amount_text: null, amount_status: 'not_listed',
      }),
    })
    expect(grantRow(db, gId).amount_status).toBe('none_published')
    expect(res.nonePublished).toBe(1)
  })

  it('does NOT record a denial when the page could not be READ (JS shell → needs adapter)', async () => {
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://sam.gov/fal/abc/view' })
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }),
    })
    expect(grantRow(db, gId).amount_status, 'an unread page must never fabricate a denial').not.toBe('none_published')
    expect(res.nonePublished ?? 0).toBe(0)
  })

  it('answers an orphan grant on a BENEFIT host structurally, without fetching', async () => {
    // studentaid.gov (Pell / work-study / FSEOG) is a JS shell to the fetcher,
    // and the census can only see opportunity_kind on CATALOG rows — so an
    // orphan grant there sat "unreadable" forever while the locator classifier
    // had a verified positive claim about the page all along. 'benefit' kind's
    // stated semantic IS the honest amount answer: award varies by applicant.
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://studentaid.gov/understand-aid/types/grants/pell' })
    let fetches = 0
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => { fetches++; return { attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' } },
    })
    const g = grantRow(db, gId)
    expect(fetches, 'a structural claim answers the row without a doomed fetch').toBe(0)
    expect(g.amount_status).toBe('varies')
    expect(g.amount_text).toMatch(/varies by applicant/i)
    expect(g.amount_enrich_attempted_at, 'a structural fact is a stable answer — the row is done').not.toBeNull()
    expect(g.amount_enrich_last_reason).toBe('locator_kind:benefit_program_host')
    expect(res.textOnly).toBe(1)
  })

  it('labels an orphan grant on a DIRECTORY shape honestly, without a fabricated status', async () => {
    // A directory is a pointer, never an award — so it gets the honest text
    // label (which the census counts as an answer) but NO 'varies' status: a
    // pointer does not "vary", it simply has no per-award figure by design.
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://projects.propublica.org/nonprofits/organizations/911140642' })
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => { throw new Error('must not fetch') },
    })
    const g = grantRow(db, gId)
    expect(g.amount_status).toBeNull()
    expect(g.amount_text).toMatch(/directory\/locator/i)
    expect(g.amount_enrich_attempted_at).not.toBeNull()
    expect(res.textOnly).toBe(1)
  })

  it('re-claims an already-BURNED orphan the moment a rule exists — no migration, no fetch', async () => {
    // THE ANTI-MIGRATION NET (2026-07-26). A burn mark says FETCHING was tried;
    // a structural claim needs no fetch — yet the candidate scan's
    // `amount_enrich_attempted_at IS NULL` hid burned rows from the short-circuit,
    // so every new locatorUrlKind rule (a new STATE's paths, a new benefit host)
    // needed a hand-written un-burn migration to reach rows burned before it
    // shipped (138/152/156 — three instances). The Katie Beckett / caregiver
    // class: burned 2026-07-17, claimable by the tn.gov path rules of 07-26.
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://www.tn.gov/tenncare/long-term-services-supports/katie-beckett-program.html' })
    db.prepare(
      `UPDATE grants SET amount_enrich_attempted_at = '2026-07-17T12:00:00.000Z', amount_enrich_attempts = 2 WHERE id = ?`,
    ).run(gId)
    let fetches = 0
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => { fetches++; return { attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' } },
    })
    const g = grantRow(db, gId)
    expect(fetches, 'a burned row is never re-fetched by the re-claim net').toBe(0)
    expect(g.amount_status, 'the structural claim answers the burned row').toBe('varies')
    expect(g.amount_text).toMatch(/varies by applicant/i)
    expect(g.amount_enrich_attempted_at, 'the burn mark is preserved, not reset').toBe('2026-07-17T12:00:00.000Z')
    expect(g.amount_enrich_attempts, 'attempt counters are untouched').toBe(2)
    expect(g.amount_enrich_last_reason).toBe('locator_kind:state_benefit_program_path:tn.gov')
    expect(res.structural_reclaimed).toBe(1)
  })

  it('a burned orphan the classifier does NOT claim stays exactly as it was', async () => {
    // The load-bearing negative: /collegepays/ is a real fixed-award page —
    // the re-claim net must neither answer it nor un-burn it (its honest state
    // is unreadable-until-the-egress-block clears, and fabricating 'varies'
    // there would hide a knowable dollar figure).
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://www.tn.gov/collegepays/money-for-college/tn-education-lottery-programs/tennessee-hope-aspire-award.html' })
    db.prepare(
      `UPDATE grants SET amount_enrich_attempted_at = '2026-07-18T12:00:00.000Z', amount_enrich_attempts = 2 WHERE id = ?`,
    ).run(gId)
    const res = await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: true, found: false, reason: 'fetch_failed:reset' }),
    })
    const g = grantRow(db, gId)
    expect(g.amount_status).toBeNull()
    expect(g.amount_text).toBeNull()
    expect(g.amount_enrich_attempted_at).toBe('2026-07-18T12:00:00.000Z')
    expect(res.structural_reclaimed ?? 0).toBe(0)
  })

  it('count-only mode counts would-be re-claims without writing', async () => {
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://studentaid.gov/understand-aid/types/grants/pell' })
    db.prepare(
      `UPDATE grants SET amount_enrich_attempted_at = '2026-07-17T12:00:00.000Z', amount_enrich_attempts = 1 WHERE id = ?`,
    ).run(gId)
    const prev = process.env.ENFORCE_GRANT_DIRECT_AMOUNT
    process.env.ENFORCE_GRANT_DIRECT_AMOUNT = '0'
    try {
      const res = await enforceGrantDirectAmountEnrichment(db, {
        enrichImpl: async () => ({ attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }),
      })
      expect(res.structural_reclaimed).toBe(1)
      expect(res.enforced).toBe(false)
      expect(grantRow(db, gId).amount_status, 'count-only must not write').toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_GRANT_DIRECT_AMOUNT
      else process.env.ENFORCE_GRANT_DIRECT_AMOUNT = prev
    }
  })

  it('the structural short-circuit loses the race to a real amount (guarded write)', async () => {
    // The WHERE guard must hold even when an amount lands BETWEEN the candidate
    // scan and the structural write — simulated by injecting the amount right
    // before the structural UPDATE executes. The least-informed writer never wins.
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://studentaid.gov/understand-aid/types/grants/pell' })
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/SET amount_status = COALESCE\(\?, amount_status\)/i.test(sql)) {
        const stmt = realPrepare(sql)
        return {
          run: (...args) => {
            realPrepare(`UPDATE grants SET amount_max = 7395, amount_status = 'known' WHERE id = ?`).run(args[2])
            return stmt.run(...args)
          },
        }
      }
      return realPrepare(sql)
    }
    await enforceGrantDirectAmountEnrichment(db, { enrichImpl: async () => ({ attempted: false }) })
    db.prepare = realPrepare
    const g = grantRow(db, gId)
    expect(g.amount_max).toBe(7395)
    expect(g.amount_status, 'a landed amount is never downgraded to a structural label').toBe('known')
    expect(g.amount_enrich_attempted_at, 'a write the guard rejected must not burn the row').toBeNull()
  })

  it('never touches a LINKED grant (that is the catalog sweep\'s job)', async () => {
    const db = makeRealDb()
    const foId = crypto.randomUUID()
    db.prepare(`INSERT INTO funding_opportunities (id, title, source_url) VALUES (?, ?, ?)`).run(foId, 'X', 'https://x.org')
    const gId = crypto.randomUUID()
    db.prepare(`INSERT INTO grants (id, title, status, funding_opportunity_id, url) VALUES (?, ?, 'interested', ?, ?)`)
      .run(gId, 'X', foId, 'https://x.org')
    let called = false
    const res = await enforceGrantDirectAmountEnrichment(db, { enrichImpl: async () => { called = true; return { attempted: true, page_read: true, found: false } } })
    expect(called, 'a linked grant must not be read directly').toBe(false)
    expect(res.scanned).toBe(0)
  })

  it('excludes Amy synthetic-profile grants', async () => {
    const db = makeRealDb()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, created_by) VALUES ('amy-1', 'amy', 'individual', 'agent:amy')").run()
    const gId = crypto.randomUUID()
    db.prepare(`INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, url) VALUES (?, ?, 'interested', 'amy-1', NULL, ?)`)
      .run(gId, 'Synthetic', 'https://swe.org/s')
    const res = await enforceGrantDirectAmountEnrichment(db, { enrichImpl: async () => ({ attempted: true, page_read: true, found: false }) })
    expect(res.scanned).toBe(0)
  })

  it('does NOT burn the grant when the amount WRITE fails (the "will retry" must be true)', async () => {
    // The #946 rule, on the grant path: mark AFTER the write, never before.
    const db = makeRealDb()
    const gId = insOrphan(db)
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (/UPDATE grants\s+SET amount_min/i.test(sql)) {
        return { run: () => { throw new Error('invalid input syntax for type real: "high"') } }
      }
      return realPrepare(sql)
    }
    await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: true, transient: false, found: true, amounts: { amount_min: 5000, amount_max: 9000, amount_text: null, amount_status: 'range', amount_confidence: 0.9 } }),
    })
    db.prepare = realPrepare
    expect(grantRow(db, gId).amount_enrich_attempted_at, 'a failed write must NOT burn the grant').toBeNull()
  })

  it('is idempotent — a read grant is not re-read next run', async () => {
    const db = makeRealDb()
    insOrphan(db)
    const impl = async () => ({ attempted: true, page_read: true, transient: false, found: false, reason: 'no_per_award_amount_on_page', amount_status: 'not_listed' })
    const first = await enforceGrantDirectAmountEnrichment(db, { enrichImpl: impl })
    const second = await enforceGrantDirectAmountEnrichment(db, { enrichImpl: impl })
    expect(first.attempted).toBe(1)
    expect(second.scanned).toBe(0)
  })

  it('count-only mode reads nothing (ENFORCE_GRANT_DIRECT_AMOUNT=0)', async () => {
    const db = makeRealDb()
    const gId = insOrphan(db)
    const prev = process.env.ENFORCE_GRANT_DIRECT_AMOUNT
    process.env.ENFORCE_GRANT_DIRECT_AMOUNT = '0'
    try {
      let called = false
      const res = await enforceGrantDirectAmountEnrichment(db, { enrichImpl: async () => { called = true; return { attempted: true, page_read: true, found: false } } })
      expect(called).toBe(false)
      expect(res.enforced).toBe(false)
      expect(grantRow(db, gId).amount_enrich_attempted_at).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_GRANT_DIRECT_AMOUNT
      else process.env.ENFORCE_GRANT_DIRECT_AMOUNT = prev
    }
  })

  it('an ENVIRONMENT-blocked failure never burns the grant, and its telemetry lands on the grant_direct lane', async () => {
    // Same 2026-07-21 egress-block rule as the catalog sweep, on the orphan-
    // grant path (identical burn semantics is the whole reason grants carry
    // their own attempt columns — migration 142/0146).
    const db = makeRealDb()
    const gId = insOrphan(db)
    const deps = {
      maxAttempts: 2,
      enrichImpl: async () => ({
        attempted: true, page_read: false, transient: true, environment: true,
        status: 403, found: false, reason: 'fetch_failed:403',
      }),
    }
    for (let i = 0; i < 4; i++) await enforceGrantDirectAmountEnrichment(db, deps)
    const g = grantRow(db, gId)
    expect(g.amount_enrich_attempted_at, 'an egress block must never burn the grant').toBeNull()
    expect(g.amount_enrich_attempts, 'an egress block must not consume the retry budget').toBe(0)
    const ring = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ENRICH_FAILURE_LOG_KEY).value)
    expect(ring.failures.at(-1)).toMatchObject({ lane: 'grant_direct', id: String(gId), status: 403, environment: true })
  })

  it('PINS the enrich reason onto an orphan grant (same per-row observability as the catalog sweep)', async () => {
    // The grants-direct sweep mirrors the catalog columns so its burn/retry is
    // identical — and the per-row reason (migration 153/0157) belongs here too,
    // so an `unanswered_unreadable` orphan self-documents instead of aging out of
    // the global failure-log ring.
    const db = makeRealDb()
    const gId = insOrphan(db, { url: 'https://grants.gov/synopsis/12345' })
    await enforceGrantDirectAmountEnrichment(db, {
      enrichImpl: async () => ({ attempted: true, page_read: false, transient: false, found: false, reason: 'thin_page' }),
    })
    const g = grantRow(db, gId)
    expect(g.amount_enrich_attempted_at, 'a thin JS shell is a stable fact → burned').not.toBeNull()
    expect(g.amount_enrich_last_reason).toBe('thin_page')
  })
})

describe('enforceLocatorKindClassification', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  const insFo = (db, { url, kind = null } = {}) => {
    const id = crypto.randomUUID()
    db.prepare('INSERT INTO funding_opportunities (id, title, source_url, opportunity_kind) VALUES (?, ?, ?, ?)')
      .run(id, 'Row', url, kind)
    return id
  }
  const kindOf = (db, id) => db.prepare('SELECT opportunity_kind, result_kind FROM funding_opportunities WHERE id = ?').get(id)

  it('classifies a sam.gov /fal/<uuid>/view assistance listing as DIRECTORY by positive URL shape', async () => {
    // Prod triage 2026-07-21: 43 such rows sat in the census's `unreadable`
    // bucket forever. An assistance listing is the CFDA PROGRAM directory —
    // a locator/pointer, never an award. It leaves the census denominator via
    // THIS positive structural classification, never via a fabricated denial.
    const db = makeRealDb()
    const foId = insFo(db, { url: 'https://sam.gov/fal/6a147f795dbb41ee85172f42934ca55f/view' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(1)
    expect(kindOf(db, foId)).toMatchObject({ opportunity_kind: 'directory', result_kind: 'directory' })
  })

  it('classifies ssa.gov benefit sections (/survivor, /disability) as BENEFIT', async () => {
    // The 30-row ssa.gov block: federal benefit programs with no fixed
    // per-applicant award — the FAFSA/Pell/SSI "no amount by design" class the
    // census's own recommended_fix names.
    const db = makeRealDb()
    const survivor = insFo(db, { url: 'https://www.ssa.gov/survivor' })
    const disability = insFo(db, { url: 'https://www.ssa.gov/disability/apply' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(2)
    expect(kindOf(db, survivor).opportunity_kind).toBe('benefit')
    expect(kindOf(db, disability).opportunity_kind).toBe('benefit')
  })

  it('NEVER claims a row outside the positive shape (no fuzzy matching, no guessing)', async () => {
    const db = makeRealDb()
    // sam.gov but NOT an assistance listing; ssa.gov but not a benefit section;
    // a lookalike host that merely contains the substring.
    const opp = insFo(db, { url: 'https://sam.gov/opp/abc123/view' })
    const ssaHome = insFo(db, { url: 'https://www.ssa.gov/thirdparty/materials.html' })
    const lookalike = insFo(db, { url: 'https://notsam.gov/fal/6a147f795dbb41ee85172f42934ca55f/view' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(0)
    for (const id of [opp, ssaHome, lookalike]) expect(kindOf(db, id).opportunity_kind).toBeNull()
  })

  it('the sweep PREFILTER covers every classifier rule — a fix-cycle-3 shape actually persists', async () => {
    // Gate finding: the sweep's hand-copied LIKE list knew only the two
    // original hosts, so the newer classifier rules were pure dead code on
    // prod rows — classifyLocatorKindFromRow was never handed a candidate.
    // The prefilter list now lives in the classifier module; this pins that a
    // rule added there is scanned AND persisted here.
    const db = makeRealDb()
    const fafsa = insFo(db, { url: 'https://studentaid.gov/h/apply-for-aid/fafsa' })
    const directory = insFo(db, { url: 'https://tn211.org/search?need=rent' })
    const propublica = insFo(db, { url: 'https://projects.propublica.org/nonprofits/organizations/340714585' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(3)
    expect(kindOf(db, fafsa).opportunity_kind).toBe('benefit')
    expect(kindOf(db, directory).opportunity_kind).toBe('directory')
    expect(kindOf(db, propublica).opportunity_kind).toBe('directory')
  })

  it('never overwrites a CURATED or unknown kind — only the generic machine-stamped allowlist', async () => {
    const db = makeRealDb()
    // A canonical curated kind and an unknown future value are both protected,
    // even on a URL the structural rule fully owns.
    const curated = insFo(db, { url: 'https://sam.gov/fal/6a147f795dbb41ee85172f42934ca55f/view', kind: 'benefit' })
    const unknown = insFo(db, { url: 'https://www.ssa.gov/ssi', kind: 'custom_kind' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(0)
    expect(kindOf(db, curated).opportunity_kind).toBe('benefit')
    expect(kindOf(db, unknown).opportunity_kind).toBe('custom_kind')
  })

  it('DOES override a generic machine-stamped kind on a structurally-proven shape', async () => {
    // Prod 2026-07-22: 12 studentaid.gov FAFSA rows sat forever in the
    // census's unreadable bucket because ingest had stamped them
    // 'PROGRAM'/'direct' — a generated default the blanket never-overwrite
    // rule froze in place. The verified structural claim outranks a generated
    // default (and ONLY a generated default — see the test above).
    const db = makeRealDb()
    const fafsa = insFo(db, { url: 'https://studentaid.gov/h/apply-for-aid/fafsa', kind: 'PROGRAM' })
    const fal = insFo(db, { url: 'https://sam.gov/fal/6a147f795dbb41ee85172f42934ca55f/view', kind: 'direct' })
    const propublica = insFo(db, { url: 'https://projects.propublica.org/nonprofits/organizations/340714585', kind: 'DIRECT_GRANT' })
    const res = await enforceLocatorKindClassification(db)
    expect(res.repaired).toBe(3)
    expect(kindOf(db, fafsa).opportunity_kind).toBe('benefit')
    expect(kindOf(db, fal).opportunity_kind).toBe('directory')
    expect(kindOf(db, propublica).opportunity_kind).toBe('directory')
  })

  it('is idempotent (a classified row leaves the candidate set) and count-only when disabled', async () => {
    const db = makeRealDb()
    const foId = insFo(db, { url: 'https://sam.gov/fal/6a147f795dbb41ee85172f42934ca55f/view' })
    const first = await enforceLocatorKindClassification(db)
    expect(first.repaired).toBe(1)
    const second = await enforceLocatorKindClassification(db)
    expect(second.scanned).toBe(0)
    // Count-only mode: reports what WOULD classify, writes nothing.
    const other = insFo(db, { url: 'https://www.ssa.gov/ssi' })
    process.env.ENFORCE_LOCATOR_KIND_CLASSIFICATION = '0'
    try {
      const res = await enforceLocatorKindClassification(db)
      expect(res.repaired).toBe(0)
      expect(res.wouldRepair).toBe(1)
      expect(kindOf(db, other).opportunity_kind).toBeNull()
    } finally {
      delete process.env.ENFORCE_LOCATOR_KIND_CLASSIFICATION
    }
    expect(kindOf(db, foId).opportunity_kind).toBe('directory')
  })
})

describe('enforceGrantCatalogLink', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }
  const insFo = (db, o = {}) => {
    const id = o.id || crypto.randomUUID()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, source_url, is_active, profile_id, amount_max, amount_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, o.title || 'Prog', o.source_url ?? null, o.is_active ?? 1, o.profile_id ?? null, o.amount_max ?? null, o.amount_status ?? null)
    return id
  }
  const insGrant = (db, o = {}) => {
    const id = o.id || crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, url, application_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, o.title || 'Prog', o.status || 'interested', o.profile_id ?? null, o.funding_opportunity_id ?? null, o.url ?? null, o.application_url ?? null)
    return id
  }
  const insProfile = (db, id) =>
    db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)').run(id, id, 'individual')
  const link = (db, id) => db.prepare('SELECT funding_opportunity_id FROM grants WHERE id = ?').get(id).funding_opportunity_id

  it('links an unlinked active grant to the single catalog row at the same URL', async () => {
    // THE GAP #954 SURFACED. An unlinked grant is invisible to every amount net
    // (they only reach a grant through funding_opportunity_id). 27 such grants in
    // prod had an exact catalog twin at the same URL and were never linked.
    const db = makeRealDb()
    const foId = insFo(db, { source_url: 'https://swe.org/scholarships', amount_max: 15000, amount_status: 'range' })
    const gId = insGrant(db, { url: 'https://swe.org/scholarships' })
    const res = await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBe(foId)
    expect(res.repaired).toBe(1)
  })

  it('normalizes a trailing slash and case before matching', async () => {
    const db = makeRealDb()
    const foId = insFo(db, { source_url: 'https://Good360.org/' })
    const gId = insGrant(db, { url: 'https://good360.org' })
    await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBe(foId)
  })

  it('matches the grant application_url against any catalog URL column', async () => {
    const db = makeRealDb()
    const foId = insFo(db, { source_url: null })
    db.prepare('UPDATE funding_opportunities SET application_url = ? WHERE id = ?').run('https://elks.org/mvs', foId)
    const gId = insGrant(db, { url: null, application_url: 'https://elks.org/mvs' })
    await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBe(foId)
  })

  it('NEVER guesses when two catalog rows share the URL (ambiguous)', async () => {
    // A shared directory URL. Linking to either would be a coin flip — leave it.
    const db = makeRealDb()
    insFo(db, { source_url: 'https://grantwatch.com/' })
    insFo(db, { source_url: 'https://grantwatch.com/' })
    const gId = insGrant(db, { url: 'https://grantwatch.com/' })
    const res = await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBeNull()
    expect(res.ambiguous).toBe(1)
    expect(res.repaired).toBe(0)
  })

  it('NEVER links across a profile boundary (URL coincidence is not identity)', async () => {
    // The catalog row belongs to profile B; the grant to profile A. Same URL,
    // different pipelines — linking would be cross-profile bleed (G4/G8).
    const db = makeRealDb()
    insProfile(db, 'prof-A'); insProfile(db, 'prof-B')
    insFo(db, { source_url: 'https://shared.org/prog', profile_id: 'prof-B' })
    const gId = insGrant(db, { url: 'https://shared.org/prog', profile_id: 'prof-A' })
    const res = await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBeNull()
    expect(res.unlinkable).toBe(1)
  })

  it('links when the catalog row is profile-agnostic (NULL profile) even if the grant has one', async () => {
    const db = makeRealDb()
    insProfile(db, 'prof-A')
    const foId = insFo(db, { source_url: 'https://nfb.org/resources', profile_id: null })
    const gId = insGrant(db, { url: 'https://nfb.org/resources', profile_id: 'prof-A' })
    await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBe(foId)
  })

  it('does not link to an INACTIVE catalog row', async () => {
    const db = makeRealDb()
    insFo(db, { source_url: 'https://dead.org/x', is_active: 0 })
    const gId = insGrant(db, { url: 'https://dead.org/x' })
    const res = await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBeNull()
    expect(res.unlinkable).toBe(1)
  })

  it('never overwrites an existing link', async () => {
    const db = makeRealDb()
    const already = insFo(db, { source_url: 'https://a.org/x' })
    insFo(db, { source_url: 'https://a.org/x' }) // a second row at the same URL exists
    const gId = insGrant(db, { url: 'https://a.org/x', funding_opportunity_id: already })
    await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBe(already) // untouched — an existing link is never re-evaluated
  })

  it('leaves an unlinkable grant (no catalog twin) alone', async () => {
    const db = makeRealDb()
    const gId = insGrant(db, { url: 'https://orphan.org/x' })
    const res = await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBeNull()
    expect(res.unlinkable).toBe(1)
    expect(res.repaired).toBe(0)
  })

  it('is idempotent — a second run links nothing new', async () => {
    const db = makeRealDb()
    insFo(db, { source_url: 'https://swe.org/s' })
    insGrant(db, { url: 'https://swe.org/s' })
    const first = await enforceGrantCatalogLink(db)
    const second = await enforceGrantCatalogLink(db)
    expect(first.repaired).toBe(1)
    expect(second.repaired).toBe(0)
  })

  it('count-only mode reports what WOULD link without writing (ENFORCE_GRANT_CATALOG_LINK=0)', async () => {
    const db = makeRealDb()
    insFo(db, { source_url: 'https://swe.org/s' })
    const gId = insGrant(db, { url: 'https://swe.org/s' })
    const prev = process.env.ENFORCE_GRANT_CATALOG_LINK
    process.env.ENFORCE_GRANT_CATALOG_LINK = '0'
    try {
      const res = await enforceGrantCatalogLink(db)
      expect(res.repaired).toBe(1) // would-link count
      expect(res.enforced).toBe(false)
      expect(link(db, gId)).toBeNull() // but nothing written
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_GRANT_CATALOG_LINK
      else process.env.ENFORCE_GRANT_CATALOG_LINK = prev
    }
  })

  it('only touches ACTIVE-pipeline grants', async () => {
    const db = makeRealDb()
    insFo(db, { source_url: 'https://swe.org/s' })
    const gId = insGrant(db, { url: 'https://swe.org/s', status: 'declined' })
    await enforceGrantCatalogLink(db)
    expect(link(db, gId)).toBeNull()
  })
})

describe('enforceGrantAmountBackfill wide-range default (program-envelope guard)', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  it('defaults amount_requested to the FLOOR when the range is wider than the ratio, ceiling otherwise', async () => {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    const wide = crypto.randomUUID()
    const normal = crypto.randomUUID()
    db.prepare(`INSERT INTO grants (id, title, status, profile_id, amount_min, amount_max) VALUES (?, 'Wide', 'interested', NULL, 1000000, 42000000)`).run(wide)
    db.prepare(`INSERT INTO grants (id, title, status, profile_id, amount_min, amount_max) VALUES (?, 'Normal', 'interested', NULL, 1000, 5000)`).run(normal)
    await enforceGrantAmountBackfill(db)
    const req = (id) => Number(db.prepare('SELECT amount_requested FROM grants WHERE id = ?').get(id).amount_requested)
    expect(req(wide)).toBe(1000000)
    expect(req(normal)).toBe(5000)
  })
})

describe('enforceGrantAmountBackfill catalog amount-sanity net (untrusted implausible amounts)', () => {
  const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')
  function makeRealDb() {
    const db = new Database(':memory:')
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    return db
  }

  it('strips fabricated program-appropriation numerics from untrusted rows and cleans inherited grant values', async () => {
    const db = makeRealDb()
    const foId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, source, amount_min, amount_max) VALUES (?, 'HUD Section 4 Capacity Building', 'web_search', 1000000, 42000000)`,
    ).run(foId)
    const gId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, amount_requested, amount_min, amount_max)
       VALUES (?, 'HUD Section 4 Capacity Building', 'submitted', NULL, ?, 42000000, 1000000, 42000000)`,
    ).run(gId, foId)
    // A grant with a USER-entered ask on the same opportunity must keep it.
    const userG = crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, title, status, profile_id, funding_opportunity_id, amount_requested)
       VALUES (?, 'HUD Section 4 Capacity Building', 'interested', NULL, ?, 50000)`,
    ).run(userG, foId)

    await enforceGrantAmountBackfill(db)

    const fo = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(foId)
    expect(fo.amount_min).toBe(null)
    expect(fo.amount_max).toBe(null)
    expect(fo.amount_status).toBe('not_listed')
    expect(fo.amount_text).toContain('42,000,000')
    const g = db.prepare('SELECT * FROM grants WHERE id = ?').get(gId)
    expect(g.amount_requested).toBe(null)
    expect(g.amount_max).toBe(null)
    const ug = db.prepare('SELECT amount_requested FROM grants WHERE id = ?').get(userG)
    expect(Number(ug.amount_requested)).toBe(50000)
  })

  it('keeps implausibly large amounts on OFFICIAL-source rows', async () => {
    const db = makeRealDb()
    const foId = crypto.randomUUID()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, source, amount_max) VALUES (?, 'State DOT Bridge Program', 'grants_gov', 25000000)`,
    ).run(foId)
    await enforceGrantAmountBackfill(db)
    const fo = db.prepare('SELECT amount_max FROM funding_opportunities WHERE id = ?').get(foId)
    expect(Number(fo.amount_max)).toBe(25000000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: Amy synthetic profiles expire (owner directive 2026-07-06 — "make
// sure those profiles are getting deleted afterwards"). The boot net calls the
// SAME guarded cleanupExpiredAmyProfiles sweep the end-of-run pass uses, so an
// expired leftover from ANY prior run is reaped regardless of whether Amy's
// own run-scoped cleanup ever fired (in prod it no-oped every run).
// ─────────────────────────────────────────────────────────────────────────────

describe('enforceAmySyntheticExpiry', () => {
  function makeAmyDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        primary_type TEXT,
        status TEXT DEFAULT 'active',
        tags TEXT DEFAULT '[]',
        created_by TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE profile_sections (
        profile_id TEXT NOT NULL,
        section_key TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_by TEXT,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(profile_id, section_key)
      );
    `)
    return db
  }

  async function seedExpiredCrawledSynthetic(db, { hoursAgo = 30, ttlHours = 24, runId = 'amy-prior-run' } = {}) {
    const { createAmyProfile, markProfileCrawled } = await import('../services/amy/amyProfileStore.js')
    const { generateScenarios } = await import('../services/amy/syntheticProfileCatalog.js')
    const past = new Date(Date.now() - hoursAgo * 60 * 60 * 1000)
    const { profileId } = await createAmyProfile(db, generateScenarios({ runId })[0], { runId, ttlHours, now: past })
    await markProfileCrawled(db, profileId, { now: past })
    return profileId
  }

  beforeEach(() => {
    delete process.env.ENFORCE_AMY_SYNTHETIC_EXPIRY
    delete process.env.AMY_NEVER_CRAWLED_MAX_AGE_HOURS
  })
  afterEach(() => {
    delete process.env.ENFORCE_AMY_SYNTHETIC_EXPIRY
    delete process.env.AMY_NEVER_CRAWLED_MAX_AGE_HOURS
  })

  it('reaps an EXPIRED, crawled leftover from a prior run; never touches real profiles; idempotent', async () => {
    const db = makeAmyDb()
    try {
      // Real (non-Amy) profile that must survive no matter what.
      db.prepare(
        `INSERT INTO profiles (id, display_name, primary_type, status, tags, created_by, created_at, updated_at)
         VALUES ('real-1', 'Real Org', 'nonprofit', 'active', '[]', 'real-user', '2020-01-01', '2020-01-01')`,
      ).run()
      const expired = await seedExpiredCrawledSynthetic(db, { hoursAgo: 30, ttlHours: 24 })

      const first = await enforceAmySyntheticExpiry(db)
      expect(first.ok).toBe(true)
      expect(first.enforced).toBe(true)
      expect(first.repaired).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(expired)).toBeUndefined()
      expect(db.prepare(`SELECT id FROM profiles WHERE id = 'real-1'`).get()).toBeTruthy()

      // Idempotent: a second boot sweep finds nothing left to repair.
      const second = await enforceAmySyntheticExpiry(db)
      expect(second.repaired).toBe(0)
    } finally {
      db.close()
    }
  })

  it('keeps a NOT-yet-expired synthetic and a never-crawled one inside the TTL escape window', async () => {
    const db = makeAmyDb()
    try {
      const { createAmyProfile } = await import('../services/amy/amyProfileStore.js')
      const { generateScenarios } = await import('../services/amy/syntheticProfileCatalog.js')
      // Fresh, crawled, unexpired.
      const fresh = await seedExpiredCrawledSynthetic(db, { hoursAgo: 1, ttlHours: 48, runId: 'amy-fresh' })
      // Never crawled, 10h old — far below the 96h never-crawled cutoff.
      const { profileId: young } = await createAmyProfile(db, generateScenarios({ runId: 'amy-young' })[0], {
        runId: 'amy-young',
        ttlHours: 48,
        now: new Date(Date.now() - 10 * 60 * 60 * 1000),
      })

      const res = await enforceAmySyntheticExpiry(db)
      expect(res.repaired).toBe(0)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(fresh)).toBeTruthy()
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(young)).toBeTruthy()
    } finally {
      db.close()
    }
  })

  it('reaps a never-crawled leftover ONLY once far past TTL (96h escape hatch)', async () => {
    const db = makeAmyDb()
    try {
      const { createAmyProfile } = await import('../services/amy/amyProfileStore.js')
      const { generateScenarios } = await import('../services/amy/syntheticProfileCatalog.js')
      const { profileId: stale } = await createAmyProfile(db, generateScenarios({ runId: 'amy-stale' })[0], {
        runId: 'amy-stale',
        ttlHours: 48,
        now: new Date(Date.now() - 100 * 60 * 60 * 1000), // 100h > 96h cutoff
      })
      const res = await enforceAmySyntheticExpiry(db)
      expect(res.repaired).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(stale)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('is count-only when ENFORCE_AMY_SYNTHETIC_EXPIRY=0 (reports wouldReap, deletes nothing)', async () => {
    const db = makeAmyDb()
    try {
      const expired = await seedExpiredCrawledSynthetic(db)
      process.env.ENFORCE_AMY_SYNTHETIC_EXPIRY = '0'
      const off = await enforceAmySyntheticExpiry(db)
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldReap).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(expired)).toBeTruthy()

      // Flip back on: the same row is reaped.
      delete process.env.ENFORCE_AMY_SYNTHETIC_EXPIRY
      const on = await enforceAmySyntheticExpiry(db)
      expect(on.repaired).toBe(1)
      expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(expired)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('degrades to a schema skip (never a failure) on DBs without the Amy profile shape', async () => {
    const db = makeDb() // the minimal grants/profiles schema (no created_by / profile_sections)
    try {
      const res = await enforceAmySyntheticExpiry(db)
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe('schema')
      expect(res.repaired).toBe(0)
    } finally {
      db.close()
    }
  })
})
