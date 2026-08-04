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
  enforceCanonicalProgramApplicationTargets,
  enforceApplicationUrlRescue,
  enforceImportedStatusHonesty,
  enforceAmountEnrichment,
  enforceGrantDirectAmountEnrichment,
  enforceDeadUrlRepair,
  enforceSourceUrlSelfRepair,
  enforceLocatorKindClassification,
  partitionSystemicStableFailures,
  AMOUNT_ENRICH_FAILURE_LOG_KEY,
  enforceGrantCatalogLink,
  enforceGrantAmountBackfill,
  enforceAmySyntheticExpiry,
  enforceDeclaredGeoScope,
  enforceStateAgencyGeoScope,
  enforceCrossProfileMatchPrecision,
  enforceConditionLaneMatchScope,
  enforceDeclaredPlaceScopeMatches,
  enforceForeignJurisdictionMatches,
  enforceNonGrantNoticePipeline,
  enforcePointerTaskReclassification,
  enforceGrantScoreBackfill,
  enforceIndividualMatchAwardCeiling,
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

  // ── Match-list side (profile_opportunity_matches — the Funding Sources
  //    card). The crawler-os pipeline upserts match rows on every discovery
  //    run with no knowledge of dismissals; the sweep is what makes an
  //    owner's delete stick (2026-07-27 owner report).
  function makeMatchTables(db) {
    db.exec(`
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        match_score REAL,
        match_decision TEXT,
        matcher_version TEXT
      );
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);
    `)
  }
  function insertMatch(db, { id, profileId, oppId, title }) {
    db.prepare(
      'INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision) VALUES (?, ?, ?, 18, ?)',
    ).run(id, profileId, oppId, 'accept')
    if (title) {
      db.prepare('INSERT OR IGNORE INTO funding_opportunities (id, title) VALUES (?, ?)').run(oppId, title)
    }
  }
  function matchIds(db) {
    return db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)
  }

  it('purges a dismissed opportunity\'s MATCH row, profile-scoped (funding-sources side)', async () => {
    const db = makeDb()
    makeMatchTables(db)
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertProfile(db, { id: 'p2', orgId: 'org2' })

    await recordDismissal(db, {
      profileId: 'p1',
      opportunity: { id: 'opp-drrp', title: 'DRRP Research Program', sponsor: 'ACL' },
    })

    // Discovery re-upserts the match row for p1; p2 legitimately keeps its own.
    insertMatch(db, { id: 'm1', profileId: 'p1', oppId: 'opp-drrp', title: 'DRRP Research Program' })
    insertMatch(db, { id: 'm2', profileId: 'p2', oppId: 'opp-drrp', title: 'DRRP Research Program' })

    const res = await enforceStickyDeletes(db)
    expect(res.ok).toBe(true)
    expect(res.matchRowsRemoved).toBe(1)
    expect(matchIds(db)).toEqual(['m2'])
  })

  it('title tier: purges a match row whose catalog row was re-keyed under a new id', async () => {
    const db = makeDb()
    makeMatchTables(db)
    insertProfile(db, { id: 'p1', orgId: 'org1' })

    await recordDismissal(db, {
      profileId: 'p1',
      opportunity: { id: 'opp-old', title: 'Vet-LIRN Capacity Grants', sponsor: 'FDA' },
    })

    // Re-crawl created the same real-world source under a NEW catalog id.
    insertMatch(db, { id: 'm1', profileId: 'p1', oppId: 'opp-new', title: 'Vet-LIRN Capacity Grants' })

    const res = await enforceStickyDeletes(db)
    expect(res.matchRowsRemoved).toBe(1)
    expect(matchIds(db)).toEqual([])
  })

  it('tolerates databases without the match tables (older/minimal schemas)', async () => {
    const db = makeDb() // no profile_opportunity_matches table at all
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    await recordDismissal(db, { profileId: 'p1', opportunity: { id: 'opp-1', title: 'X' } })
    const res = await enforceStickyDeletes(db)
    expect(res.ok).toBe(true)
    expect(res.matchRowsRemoved).toBe(0)
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

  // THE INVERSE CASE (the Anita class, 2026-08-01). A person who runs a FARM
  // legitimately IS also a business. Most farmers tick `occupation.farmer` and
  // leave `small_business_owner` at its schema DEFAULT of false — they are
  // farmers, not "small business owners". Reading that default as a structured
  // DENIAL wipes a real farm identity, and the farm identity is exactly what
  // makes USDA/FSA/NRCS/SARE reachable through the applicant-type gate.
  it('NEVER strips the org identity of a person who DECLARES a farm (occupation.farmer)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'anita', primaryType: 'individual' })
    setSection(db, 'anita', 'organization_details', { organization_type: 'farm' })
    setSection(db, 'anita', 'small_business_details', { business_name: 'Anita Family Farm' })
    setSection(db, 'anita', 'occupation', {
      farmer: true,
      nonprofit_employee: false,
      small_business_owner: false,
    })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(res.flagged).toBe(1) // ambiguous → logged for human review, never changed
    expect(getSection(db, 'anita', 'organization_details').organization_type).toBe('farm')
    expect(getSection(db, 'anita', 'small_business_details').business_name).toBe('Anita Family Farm')
  })

  it('NEVER strips the org identity of a person whose NAICS code is agricultural', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'anita2', primaryType: 'individual' })
    setSection(db, 'anita2', 'organization_details', { organization_type: 'business' })
    setSection(db, 'anita2', 'small_business_details', { business_name: 'Bluegrass Cattle Co', naics_code: '112111' })
    setSection(db, 'anita2', 'occupation', { nonprofit_employee: false, small_business_owner: false })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(0)
    expect(getSection(db, 'anita2', 'small_business_details').business_name).toBe('Bluegrass Cattle Co')
  })

  it('STILL clears the Kimberly Botts case when no farm is declared (fix stays narrow)', async () => {
    const db = makeProfileDb()
    insertTypedProfile(db, { id: 'kb2', primaryType: 'individual' })
    setSection(db, 'kb2', 'organization_details', { organization_type: 'nonprofit' })
    setSection(db, 'kb2', 'small_business_details', { business_name: 'Hallucinated Nonprofit' })
    setSection(db, 'kb2', 'occupation', {
      farmer: false,
      nonprofit_employee: false,
      small_business_owner: false,
    })

    const res = await enforceIndividualOrgSectionConflict(db)
    expect(res.repaired).toBe(1)
    expect(getSection(db, 'kb2', 'organization_details').organization_type).toBe(null)
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
    // 37 on main (incl. #1081 portal_session_lifetime_stamp) + 4 scope nets
    // + the institution-aid RECALL net (institution_recall_miss)
    // + the recorded-discovery-provenance RECALL net
    // + the declared-field-of-study RECALL net
    // + the stage-of-life eligibility nets (#1093)
    // + the unconfigured-profile geography net (#1094)
    // + the county/crisis-need RECALL net (local help that already exists)
    // + the 3 global match-scope nets (2026-08-03, the Robert White report:
    //   per-state HFA geo scope, cross-profile ACCEPT-only precision, and the
    //   condition-lane match-store scope) here.
    // + the non-grant notice net (2026-08-03 owner QA: regulatory/lead-gen/
    //   clearly-expired junk purged from the match store)
    // + the non-grant notice PIPELINE net (2026-08-04: the grants-table twin —
    //   pre-gate writers left regulatory notices in pipelines as work items)
    // + the pointer-task reclassification net (2026-08-04: a URL-less pointer
    //   task is a research lead with handoff instructions, never a silent one)
    // + the catalog-rescore convergence census/sweep (2026-08-03, the general
    //   re-scoring sweep for the rolling snapshot; writes env-gated OFF).
    expect(summary.ran).toBe(56)
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
      // Source-level same-domain self-repair, then row-level dead-URL repair,
      // both BEFORE amount acquisition so repairs are read this same boot.
      'source_url_self_repair',
      'dead_url_repair',
      'amount_enrichment',
      'grant_amount_backfill',
      'grant_direct_amount',
      'individual_amount_ceiling',
      // SCOPE of a surfaced match (2026-08-01, the GeneMac report). Geo scope is
      // repaired on the CATALOG first, so every later geo comparison — and both
      // match-store purges below — read the corrected state this same boot.
      'declared_geo_scope',
      // A per-state housing finance agency row declares its state as a FULL
      // NAME in its curated title/sponsor — invisible to the "<Place>, XX —"
      // rule above. Re-scoped from the SAME registry that minted it, right
      // after the general geo repair (the Robert White HFA class).
      'state_agency_geo_scope',
      'declared_place_scope_matches',
      'foreign_jurisdiction_matches',
      // Non-grant junk net (2026-08-03 owner QA): regulatory notices, lead-gen
      // "scholarships", clearly-expired programs — purged from the match store.
      'non_grant_notice_matches',
      'non_grant_notice_pipeline',
      'individual_match_award_ceiling',
      // A profile that was NEVER FILLED IN is not shown geography the system
      // invented from its placeholder address ("Anytown, SA"). Last in the
      // scope family so the profile-agnostic nets take their rows first.
      'unconfigured_profile_matches',
      // A cross-profile (xmatch) row is a match only on the engine's ACCEPT
      // (2026-08-03: 95.5% of prod xmatch rows were REVIEW junk the
      // resource-preserving reconcile made immortal).
      'cross_profile_match_precision',
      // …and the match-store half of the #1102 condition-lane gate: a
      // disease-specific lane's rows reach only a profile that DECLARES the
      // condition.
      'condition_lane_match_scope',
      'student_aid_eligibility',
      // The RECALL direction of the same store: a student's OWN school's aid.
      // Placed before the two hygiene sweeps so the rows it adds are validated
      // by them in the SAME boot.
      'institution_aid_linkage',
      // Same class one level up: a catalog row that RECORDS the profile it was
      // discovered for (funding_opportunities.profile_id) is re-offered to that
      // profile. Also before the hygiene sweeps, for the same reason.
      'profile_discovered_catalog_linkage',
      'declared_field_of_study_recall',
      'student_aid_instate_recall',
      // The same class for the OTHER half of the fleet: a household in crisis
      // and the local help its own county already holds in the catalog.
      'county_crisis_need_recall',
      // The GENERAL recall case: continuous catalog-wide re-matching, count-only
      // until the fundability chain lands (ENFORCE_CATALOG_RESCORE=1 to write).
      'catalog_rescore_convergence',
      'stage_of_life_match_scope',
      'no_dangling_matches',
      // RESULT FLOOR census (owner rule 2026-08-01, third clause). After every
      // scope/eligibility/linkage net AND after the dangling cleanup, so the
      // count is of the store as it will be READ.
      'profile_result_floor',
      'persisted_match_decision_integrity',
      'profession_eligibility',
      'funder_backfill',
      'profile_display_name_not_doubled',
      'profile_income_reconciliation',
      'individual_org_section_conflict',
      'hamilton_task_self_heal',
      // AFTER self-heal: a just-requeued task's remaining flags reconcile the
      // same boot (the Anastasia stale first-name class).
      'stale_missing_field_resolution',
      // System-side stops re-checked with the producer's own code; zombie
      // tasks for purged sources closed (the Robert White 41-stop class).
      'hamilton_stop_recheck',
      // A pointer task decomposition cannot reach is a research lead with
      // owner handoff instructions, never a silently-dying application task.
      'pointer_task_reclassification',
      'no_search_engine_application_targets',
      // Right after URL hygiene: a registered canonical program's application
      // target is repointed to its official URL (the "TN Promise opens a
      // paramedic page" class) the same boot the hygiene net runs.
      'canonical_program_application_targets',
      'live_crawl_verified_at_honesty',
      'application_url_rescue',
      'grant_score_backfill',
      'converted_applications_have_profiles',
      // A saved portal session with no session_established_at is structurally
      // invisible to the lifetime ledger — stamp it from its own created_at.
      'portal_session_lifetime_stamp',
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
// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: a task-flagged profile field the profile can now answer is
// resolved EVERYWHERE (the Anastasia first-name class, 2026-07-27): prod held
// 30+ unresolved "Profile is missing first name" rows across portal tasks
// while basic_information.first_name sat filled — flags are per-task, the fix
// is profile-wide, and only the document-parse path ever reconciled them.
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceStaleMissingFieldResolution', () => {
  let taskStore

  async function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    `)
    taskStore = await import('../services/hamilton/applicationTaskStore.js')
    taskStore._resetSchemaCache()
    await taskStore.ensureApplicationTaskSchema(raw)
    return raw
  }

  async function makeTaskWithFlag(db, {
    profileId = 'p-ana', grantId = crypto.randomUUID(), status = 'waiting_for_review',
    missing = [{ kind: 'field', key: 'first_name', label: 'Profile is missing first name' }],
  } = {}) {
    const task = await taskStore.ensureApplicationTask(db, {
      profileId, grantId, automationType: 'portal', initialStatus: 'queued',
    })
    await taskStore.updateApplicationTask(db, task.id, { status })
    await taskStore.setMissingInfo(db, task.id, missing)
    return task
  }

  async function unresolvedKeys(db, taskId) {
    const rows = await taskStore.listMissingInfo(db, taskId, { includeResolved: false })
    return rows.map((r) => r.key).sort()
  }

  beforeEach(() => { delete process.env.ENFORCE_STALE_MISSING_FIELDS })
  afterEach(() => { delete process.env.ENFORCE_STALE_MISSING_FIELDS })

  it('resolves the SAME stale flag across many portal tasks once the profile has the field', async () => {
    const db = await makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-ana', 'Anastasia Nicole White')
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p-ana', 'basic_information', JSON.stringify({ first_name: 'Anastasia', last_name: 'White' }))

    // Three portals, three tasks, each with its own stale first/last-name flag
    // — including a waiting_for_review task the blocked-task self-heal never
    // touches.
    const t1 = await makeTaskWithFlag(db, { status: 'waiting_for_review' })
    const t2 = await makeTaskWithFlag(db, {
      status: 'blocked',
      missing: [{ kind: 'field', key: 'last_name', label: 'Profile is missing last name' }],
    })
    const t3 = await makeTaskWithFlag(db, { status: 'waiting_for_missing_info' })

    const res = await __testables.enforceStaleMissingFieldResolution(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(3)
    expect(await unresolvedKeys(db, t1.id)).toEqual([])
    expect(await unresolvedKeys(db, t2.id)).toEqual([])
    expect(await unresolvedKeys(db, t3.id)).toEqual([])
    // The fully-answered resumable task is re-queued for Hamilton.
    expect((await taskStore.getApplicationTask(db, t3.id)).status).toBe('ready')
  })

  it('derives first/last name from display_name when sections never stored parts', async () => {
    const db = await makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-ana', 'Anastasia Nicole White')

    const t = await makeTaskWithFlag(db, {
      missing: [
        { kind: 'field', key: 'first_name', label: 'Profile is missing first name' },
        { kind: 'field', key: 'last_name', label: 'Profile is missing last name' },
      ],
    })
    const res = await __testables.enforceStaleMissingFieldResolution(db)
    expect(res.repaired).toBe(2)
    expect(await unresolvedKeys(db, t.id)).toEqual([])
  })

  it('a field the profile still does NOT have stays flagged (never fabricates)', async () => {
    const db = await makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-ana', 'Anastasia White')
    const t = await makeTaskWithFlag(db, {
      missing: [
        { kind: 'field', key: 'first_name', label: 'Profile is missing first name' },
        { kind: 'field', key: 'social_security_number', label: 'Profile is missing SSN' },
      ],
    })
    const res = await __testables.enforceStaleMissingFieldResolution(db)
    expect(res.repaired).toBe(1)
    expect(await unresolvedKeys(db, t.id)).toEqual(['social_security_number'])
    // Not fully answered → never resumed.
    expect((await taskStore.getApplicationTask(db, t.id)).status).toBe('waiting_for_review')
  })

  it('ENFORCE_STALE_MISSING_FIELDS=0 counts but never writes', async () => {
    const db = await makeDb()
    process.env.ENFORCE_STALE_MISSING_FIELDS = '0'
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-ana', 'Anastasia White')
    const t = await makeTaskWithFlag(db, {})

    const res = await __testables.enforceStaleMissingFieldResolution(db)
    expect(res.repaired).toBe(0)
    expect(res.scannedProfiles).toBe(1)
    expect(await unresolvedKeys(db, t.id)).toEqual(['first_name'])
  })

  it('ignores flags on terminal tasks (submitted history is not rewritten)', async () => {
    const db = await makeDb()
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-ana', 'Anastasia White')
    const t = await makeTaskWithFlag(db, { status: 'submitted' })

    const res = await __testables.enforceStaleMissingFieldResolution(db)
    expect(res.repaired).toBe(0)
    expect(await unresolvedKeys(db, t.id)).toEqual(['first_name'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: a system-side task stop that no longer reproduces is cleared, and
// a task whose funding source was purged is closed (the Robert White 41-stop
// class, 2026-07-27): 'crawler_profile_rules' / 'application_url' stops were
// permanent by construction — nothing re-ran the check, and the blocked-task
// self-heal deliberately skips non-profile-field items.
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceHamiltonStopRecheck', () => {
  let taskStore

  async function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT, display_name TEXT);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
      CREATE TABLE grants (
        id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT,
        title TEXT, application_url TEXT, url TEXT, record_origin TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
        application_url TEXT, source_url TEXT, deadline TEXT, deadline_type TEXT,
        record_origin TEXT, is_national INTEGER DEFAULT 1, profile_id TEXT,
        link_status TEXT, last_verified_at TEXT
      );
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        profile_id TEXT, opportunity_id TEXT, match_score REAL,
        match_decision TEXT, match_explanation TEXT, matcher_version TEXT,
        updated_at DATETIME, computed_at DATETIME
      );
    `)
    taskStore = await import('../services/hamilton/applicationTaskStore.js')
    taskStore._resetSchemaCache()
    await taskStore.ensureApplicationTaskSchema(raw)
    raw.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('p-rob', 'Robert Michael White')
    return raw
  }

  const TSAA_OPP = {
    id: 'opp-tsaa',
    title: 'Tennessee Student Assistance Award (TSAA)',
    sponsor: 'TSAC',
    application_url: 'https://www.tn.gov/collegepays/tsaa.html',
    source_url: 'https://www.tn.gov/collegepays/tsaa.html',
    deadline_type: 'rolling',
    record_origin: 'live_crawl',
  }

  function insertOpp(db, opp = {}) {
    const o = { ...TSAA_OPP, ...opp }
    db.prepare(
      'INSERT INTO funding_opportunities (id, title, sponsor, description, application_url, source_url, deadline_type, record_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(o.id, o.title, o.sponsor, o.description ?? null, o.application_url, o.source_url, o.deadline_type, o.record_origin)
    return o
  }

  async function makeStoppedTask(db, {
    oppId = null, grantId = null, key = 'crawler_profile_rules',
    label = 'Funding source does not meet GrantFlow rules',
  } = {}) {
    const task = await taskStore.ensureApplicationTask(db, {
      profileId: 'p-rob', grantId, opportunityId: oppId, automationType: 'portal', initialStatus: 'queued',
    })
    await taskStore.updateApplicationTask(db, task.id, { status: 'blocked' })
    await taskStore.setMissingInfo(db, task.id, [{ kind: 'other', key, label }])
    return task
  }

  const unresolved = async (db, taskId) =>
    (await taskStore.listMissingInfo(db, taskId, { includeResolved: false })).map((m) => m.key)

  beforeEach(() => { delete process.env.ENFORCE_HAMILTON_STOP_RECHECK })
  afterEach(() => { delete process.env.ENFORCE_HAMILTON_STOP_RECHECK })

  it('clears a policy stop once the engine endorses the pair, and resumes the task', async () => {
    const db = await makeDb()
    insertOpp(db)
    db.prepare(
      "INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES ('p-rob', 'opp-tsaa', 14, 'accept', 'crawler-os')",
    ).run()
    const task = await makeStoppedTask(db, { oppId: 'opp-tsaa' })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.ok).toBe(true)
    expect(res.itemsResolved).toBe(1)
    expect(await unresolved(db, task.id)).toEqual([])
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('ready')
  })

  it('cancels a zombie task whose grant AND catalog row are both gone', async () => {
    const db = await makeDb()
    const task = await makeStoppedTask(db, { grantId: 'g-purged-long-ago' })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.tasksCancelled).toBe(1)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('cancelled')
  })

  it('clears a stop via the LIVE engine when the snapshot row was reconciled away (the TSAA class)', async () => {
    // NO stored match row at all — the crawler reconcile wiped it — but the
    // live engine endorses the pair, so the stop resolves and the task runs.
    const db = await makeDb()
    insertOpp(db, {
      description: 'Grant assistance for Tennessee students with financial need attending eligible colleges.',
    })
    db.prepare("UPDATE profiles SET display_name = 'Robert Michael White' WHERE id = 'p-rob'").run()
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run('p-rob', 'basic_information', JSON.stringify({ first_name: 'Robert', state: 'TN', profile_category: 'student' }))
    const task = await makeStoppedTask(db, { oppId: 'opp-tsaa' })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.itemsResolved).toBe(1)
    expect(await unresolved(db, task.id)).toEqual([])
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('ready')
  })

  it('leaves an honest stop untouched when the live engine REJECTS the pair', async () => {
    const db = await makeDb()
    insertOpp(db, {
      id: 'opp-vetlirn',
      title: 'Vet-LIRN Capacity-Building Project and Equipment Grants (U18)',
      description: 'Cooperative agreement to expand veterinary diagnostic laboratory capacity.',
    })
    const task = await makeStoppedTask(db, { oppId: 'opp-vetlirn' })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.itemsResolved).toBe(0)
    expect(res.tasksCancelled).toBe(0)
    expect(await unresolved(db, task.id)).toEqual(['crawler_profile_rules'])
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('resolves a portal-URL stop when the catalog row now has a real URL, and stamps it on the task', async () => {
    const db = await makeDb()
    insertOpp(db)
    const task = await makeStoppedTask(db, {
      oppId: 'opp-tsaa', key: 'application_url', label: 'Portal URL is missing',
    })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.itemsResolved).toBe(1)
    const after = await taskStore.getApplicationTask(db, task.id)
    expect(after.application_url).toBe(TSAA_OPP.application_url)
    expect(after.status).toBe('ready')
  })

  it('never accepts a search-results page as the portal URL', async () => {
    const db = await makeDb()
    insertOpp(db, {
      application_url: 'https://www.google.com/search?q=tsaa',
      source_url: 'https://www.google.com/search?q=tsaa',
    })
    const task = await makeStoppedTask(db, {
      oppId: 'opp-tsaa', key: 'application_url', label: 'Portal URL is missing',
    })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.itemsResolved).toBe(0)
    expect(await unresolved(db, task.id)).toEqual(['application_url'])
  })

  it('re-probes a stale broken-link mark blocking a task and clears the stop when the URL is alive', async () => {
    // Insert-time HEAD probe failed once → link_status='broken' WITH
    // last_verified_at set → the recurring verifier won't revisit for its
    // window, and trust blocks every task on the row the whole time (the
    // MTSU off-campus-housing-portal chain).
    const db = await makeDb()
    insertOpp(db)
    db.prepare("UPDATE funding_opportunities SET link_status = 'broken', last_verified_at = '2026-07-26T00:00:00Z' WHERE id = 'opp-tsaa'").run()
    db.prepare(
      "INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES ('p-rob', 'opp-tsaa', 14, 'accept', 'crawler-os')",
    ).run()
    const task = await makeStoppedTask(db, { oppId: 'opp-tsaa' })

    // Canonical-shaped stub: persists the verdict like verifyOpportunityLinkNow.
    const verifyLink = async (dbi, opp) => {
      await dbi.prepare("UPDATE funding_opportunities SET link_status = 'ok' WHERE id = ?").run(opp.id)
      return { status: 'ok', code: 200, updated: true }
    }
    const res = await __testables.enforceHamiltonStopRecheck(db, { verifyLink })
    expect(res.linksReverified).toBe(1)
    expect(res.itemsResolved).toBe(1)
    expect(await unresolved(db, task.id)).toEqual([])
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('ready')
  })

  it('a link that is REALLY dead keeps the stop (probe persists the broken verdict, nothing resolves)', async () => {
    const db = await makeDb()
    insertOpp(db)
    db.prepare("UPDATE funding_opportunities SET link_status = 'broken' WHERE id = 'opp-tsaa'").run()
    const task = await makeStoppedTask(db, { oppId: 'opp-tsaa' })

    const verifyLink = async () => ({ status: 'broken', code: 404, updated: true })
    const res = await __testables.enforceHamiltonStopRecheck(db, { verifyLink })
    expect(res.linksReverified).toBe(1)
    expect(res.itemsResolved).toBe(0)
    expect(await unresolved(db, task.id)).toEqual(['crawler_profile_rules'])
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })

  it('count-only mode never probes links (no verification writes)', async () => {
    const db = await makeDb()
    process.env.ENFORCE_HAMILTON_STOP_RECHECK = '0'
    insertOpp(db)
    db.prepare("UPDATE funding_opportunities SET link_status = 'broken' WHERE id = 'opp-tsaa'").run()
    await makeStoppedTask(db, { oppId: 'opp-tsaa' })

    let probed = 0
    const verifyLink = async () => { probed += 1; return { status: 'ok', code: 200, updated: true } }
    const res = await __testables.enforceHamiltonStopRecheck(db, { verifyLink })
    expect(probed).toBe(0)
    expect(res.linksReverified).toBe(0)
  })

  it('ENFORCE_HAMILTON_STOP_RECHECK=0 counts but never writes', async () => {
    const db = await makeDb()
    process.env.ENFORCE_HAMILTON_STOP_RECHECK = '0'
    const task = await makeStoppedTask(db, { grantId: 'g-purged-long-ago' })

    const res = await __testables.enforceHamiltonStopRecheck(db)
    expect(res.repaired).toBe(0)
    expect((await taskStore.getApplicationTask(db, task.id)).status).toBe('blocked')
  })
})

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

describe('enforceCanonicalProgramApplicationTargets', () => {
  // The real prod rows behind the 2026-07-31 report: "TN Promise Scholarship"
  // extracted from a Cleveland State PARAMEDIC program page, with the page's
  // URL persisted as the application target — clicking "Open" launched a
  // secure login for a page where TN Promise cannot be applied for at all.
  const PARAMEDIC_URL = 'https://www.clevelandstatecc.edu/academic-programs/healthcare/paramedic/'
  const OFFICIAL_TN_PROMISE = 'https://www.tnpromise.gov/'

  function makeProgramDb() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        title TEXT,
        sponsor TEXT,
        application_url TEXT,
        source_url TEXT
      );
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        title TEXT,
        funding_opportunity_id TEXT,
        application_url TEXT,
        url TEXT
      );
    `)
    return db
  }

  afterEach(() => {
    delete process.env.ENFORCE_CANONICAL_PROGRAM_TARGETS
  })

  it('repoints a TN Promise row extracted from an unrelated program page to the official URL — evidence stays untouched', async () => {
    const db = makeProgramDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-tnp', 'TN Promise Scholarship', 'Tennessee Promise', ?, ?)`,
    ).run(PARAMEDIC_URL, PARAMEDIC_URL)

    const res = await enforceCanonicalProgramApplicationTargets(db)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(1)

    const fo = db.prepare("SELECT * FROM funding_opportunities WHERE id = 'fo-tnp'").get()
    expect(fo.application_url).toBe(OFFICIAL_TN_PROMISE)
    // Where we READ the mention stays honest provenance.
    expect(fo.source_url).toBe(PARAMEDIC_URL)
  })

  it('echoes the fix onto linked grants still carrying the exact old junk target — never a user-entered URL', async () => {
    const db = makeProgramDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-tnp', 'TN Promise Scholarship', 'Tennessee Promise', ?, ?)`,
    ).run(PARAMEDIC_URL, PARAMEDIC_URL)
    db.prepare(
      `INSERT INTO grants (id, profile_id, title, funding_opportunity_id, application_url, url)
       VALUES ('g-junk', 'pA', 'TN Promise Scholarship', 'fo-tnp', ?, ?)`,
    ).run(PARAMEDIC_URL, PARAMEDIC_URL)
    db.prepare(
      `INSERT INTO grants (id, profile_id, title, funding_opportunity_id, application_url, url)
       VALUES ('g-user', 'pB', 'TN Promise Scholarship', 'fo-tnp', 'https://my-counselor-link.example.org/tnp', 'https://my-counselor-link.example.org/tnp')`,
    ).run()

    await enforceCanonicalProgramApplicationTargets(db)

    const junk = db.prepare("SELECT * FROM grants WHERE id = 'g-junk'").get()
    expect(junk.application_url).toBe(OFFICIAL_TN_PROMISE)
    expect(junk.url).toBe(OFFICIAL_TN_PROMISE)
    const user = db.prepare("SELECT * FROM grants WHERE id = 'g-user'").get()
    expect(user.application_url).toBe('https://my-counselor-link.example.org/tnp')
  })

  it('never claims a same-word STRANGER (Bank of Hope / AGC Hope), and leaves official-host rows exactly alone', async () => {
    const db = makeProgramDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-bank', 'Bank of Hope Scholarship', 'Bank of Hope', 'https://www.bankofhope.com/scholarship', 'https://www.bankofhope.com/scholarship')`,
    ).run()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-agc', 'AGC Hope Scholarship', 'AGC Scholarship Foundation', 'https://familyequality.org/whatever', 'https://familyequality.org/whatever')`,
    ).run()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-official', 'Tennessee Promise', 'TSAC', 'https://www.tnachieves.org/tn-promise', 'https://www.tnachieves.org/tn-promise')`,
    ).run()

    const res = await enforceCanonicalProgramApplicationTargets(db)
    expect(res.scanned).toBe(0)
    expect(res.repaired).toBe(0)
    expect(db.prepare("SELECT application_url FROM funding_opportunities WHERE id = 'fo-bank'").get().application_url)
      .toBe('https://www.bankofhope.com/scholarship')
    expect(db.prepare("SELECT application_url FROM funding_opportunities WHERE id = 'fo-agc'").get().application_url)
      .toBe('https://familyequality.org/whatever')
    // tnachieves.org is an official TN Promise property — untouched.
    expect(db.prepare("SELECT application_url FROM funding_opportunities WHERE id = 'fo-official'").get().application_url)
      .toBe('https://www.tnachieves.org/tn-promise')
  })

  it('a TN HOPE row pointing at a forum thread is repointed (the prod College Confidential row)', async () => {
    const db = makeProgramDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-hope', 'TN HOPE Scholarship', 'State of Tennessee', 'https://talk.collegeconfidential.com/t/some-thread/3685739', 'https://talk.collegeconfidential.com/t/some-thread/3685739')`,
    ).run()

    const res = await enforceCanonicalProgramApplicationTargets(db)
    expect(res.repaired).toBe(1)
    expect(db.prepare("SELECT application_url FROM funding_opportunities WHERE id = 'fo-hope'").get().application_url)
      .toBe('https://www.tn.gov/collegepays')
  })

  it('count-only when ENFORCE_CANONICAL_PROGRAM_TARGETS=0; idempotent otherwise; tolerant of missing tables', async () => {
    const db = makeProgramDb()
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, application_url, source_url)
       VALUES ('fo-tnp', 'TN Promise Scholarship', 'Tennessee Promise', ?, ?)`,
    ).run(PARAMEDIC_URL, PARAMEDIC_URL)

    process.env.ENFORCE_CANONICAL_PROGRAM_TARGETS = '0'
    const counted = await enforceCanonicalProgramApplicationTargets(db)
    expect(counted.enforced).toBe(false)
    expect(counted.scanned).toBe(1)
    expect(counted.repaired).toBe(0)
    expect(db.prepare("SELECT application_url FROM funding_opportunities WHERE id = 'fo-tnp'").get().application_url).toBe(PARAMEDIC_URL)

    delete process.env.ENFORCE_CANONICAL_PROGRAM_TARGETS
    const first = await enforceCanonicalProgramApplicationTargets(db)
    expect(first.repaired).toBe(1)
    const second = await enforceCanonicalProgramApplicationTargets(db)
    expect(second.scanned).toBe(0)
    expect(second.repaired).toBe(0)

    const bare = new Database(':memory:')
    const res = await enforceCanonicalProgramApplicationTargets(bare)
    expect(res.ok).toBe(true)
    expect(res.repaired).toBe(0)
  })

  it('wiring tripwire: the inserter (per-call gate) consults canonicalProgramTargetRepair', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = await import('node:path')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = await readFile(path.join(here, '..', 'services', 'opportunityInserter.js'), 'utf8')
    expect(src).toContain('canonicalProgramTargetRepair')
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
// INVARIANT: a non-grant notice is never a profile PIPELINE row (2026-08-04 —
// the grants-table twin of enforceNonGrantNoticeMatches). Pre-gate writers
// left Federal Register notices sitting in pipelines as live work items (the
// prod HRSA "Agency Information Collection … Public Comment Request" at 82).
// Mirrors enforceProfileEligibility's conservatism: purge ONLY on positive
// junk evidence + early status + no protected name + no recorded award;
// FR-source-only rows are FLAGGED (counted), never auto-purged.
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceNonGrantNoticePipeline', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    // The invariant's candidate SELECT + repair paths read columns the shared
    // minimal schema omits (real schema has both).
    db.exec(`ALTER TABLE grants ADD COLUMN deadline TEXT`)
    db.exec(`ALTER TABLE grants ADD COLUMN eligibility_status TEXT`)
    _resetSchemaCache()
    await ensureApplicationTaskSchema(db) // real application_tasks/events schema
  })
  afterEach(() => {
    delete process.env.ENFORCE_NON_GRANT_PIPELINE
    delete process.env.NON_GRANT_PIPELINE_LIMIT
  })

  const insertTask = (id, profileId, grantId, status) =>
    db.prepare('INSERT INTO application_tasks (id, profile_id, grant_id, status) VALUES (?, ?, ?, ?)')
      .run(id, profileId, grantId, status)
  const grantExists = (id) => Boolean(db.prepare('SELECT id FROM grants WHERE id = ?').get(id))
  const taskStatus = (id) => db.prepare('SELECT status FROM application_tasks WHERE id = ?').get(id)?.status
  const grantRow = (id) => db.prepare('SELECT * FROM grants WHERE id = ?').get(id)
  const tombstones = (profileId) => {
    try {
      return db.prepare('SELECT * FROM pipeline_dismissals WHERE profile_id = ?').all(profileId)
    } catch { return [] }
  }

  // The real prod titles the net exists for (2026-08-04, Axiom BioLabs).
  const REGULATORY_TITLE = 'Agency Information Collection Activities: Proposed Collection: Public Comment Request'
  const FR_BENIGN_TITLE = 'Innovation Challenge: Alternatives to Conventional Pesticides for Crop Desiccation; Notice of Availability'

  it('PURGES a discovered-status regulatory notice: tombstone recorded, row deleted, non-terminal task cancelled; a real grant is untouched', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    const junk = insertGrant(db, { profile_id: 'p1', title: REGULATORY_TITLE, funder: 'HRSA', status: 'discovered' })
    const real = insertGrant(db, {
      profile_id: 'p1', title: 'HOPE Scholarship', funder: 'TSAC', status: 'discovered',
      amount_requested: 5000,
    })
    insertTask('t-junk', 'p1', junk, 'ready_to_start')
    insertTask('t-real', 'p1', real, 'ready_to_start')

    const res = await enforceNonGrantNoticePipeline(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.purged).toBe(1)
    expect(res.repaired).toBe(1)
    expect(res.tasksCancelled).toBe(1)
    expect(res.profilesAffected).toBe(1)

    // The deletion is REAL (mutation posture: a no-op body fails here).
    expect(grantExists(junk)).toBe(false)
    expect(taskStatus('t-junk')).toBe('cancelled')
    // The purge left a sticky-delete tombstone so no writer re-inserts it.
    const stones = tombstones('p1')
    expect(stones).toHaveLength(1)
    expect(String(stones[0].reason)).toMatch(/^non_grant_notice: regulatory_notice_title/)
    // The clean fundable grant + its task are untouched.
    expect(grantExists(real)).toBe(true)
    expect(taskStatus('t-real')).toBe('ready_to_start')
  })

  it('an FR-source-only row (benign title) is COUNTED frSourceFlagged and NEVER deleted', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    const frOnly = insertGrant(db, { profile_id: 'p1', title: FR_BENIGN_TITLE, funder: 'EPA', status: 'discovered' })
    // insertGrant's shared column set omits application_url — set the FR
    // provenance explicitly (it is the row's ONLY junk evidence, by design).
    db.prepare('UPDATE grants SET application_url = ? WHERE id = ?')
      .run('https://www.federalregister.gov/documents/2026/07/02/x', frOnly)

    const res = await enforceNonGrantNoticePipeline(db)
    expect(res.ok).toBe(true)
    expect(res.scanned).toBe(1)
    expect(res.frSourceFlagged).toBe(1)
    expect(res.purged).toBe(0)
    expect(res.repaired).toBe(0)
    expect(grantExists(frOnly)).toBe(true)
    expect(tombstones('p1')).toHaveLength(0)
  })

  it('a protected-status junk row is NEVER deleted — eligibility_status becomes ineligible', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    const submitted = insertGrant(db, {
      profile_id: 'p1', status: 'submitted',
      title: 'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change',
    })
    const awarded = insertGrant(db, {
      profile_id: 'p1', status: 'discovered', amount_awarded: 500,
      title: REGULATORY_TITLE,
    })

    const res = await enforceNonGrantNoticePipeline(db)
    expect(res.purged).toBe(0)
    expect(res.flaggedProtected).toBe(2)
    expect(grantExists(submitted)).toBe(true)
    expect(grantExists(awarded)).toBe(true)
    expect(grantRow(submitted).eligibility_status).toBe('ineligible')
    expect(grantRow(awarded).eligibility_status).toBe('ineligible')
  })

  it('count-only (ENFORCE_NON_GRANT_PIPELINE=0): wouldRepair counted, ZERO writes', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    const junk = insertGrant(db, { profile_id: 'p1', title: REGULATORY_TITLE, status: 'discovered' })
    insertTask('t-junk', 'p1', junk, 'ready_to_start')
    process.env.ENFORCE_NON_GRANT_PIPELINE = '0'

    const res = await enforceNonGrantNoticePipeline(db)
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBe(1)
    expect(res.repaired).toBe(0)
    expect(grantExists(junk)).toBe(true)
    expect(taskStatus('t-junk')).toBe('ready_to_start')
    expect(tombstones('p1')).toHaveLength(0)
  })

  it('CONVERGES: a second run repairs 0', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    insertGrant(db, { profile_id: 'p1', title: REGULATORY_TITLE, status: 'discovered' })
    const first = await enforceNonGrantNoticePipeline(db)
    const second = await enforceNonGrantNoticePipeline(db)
    expect(first.repaired).toBe(1)
    expect(second.repaired).toBe(0)
  })

  it('the bound limits DELETES, never DISCOVERY: scanned reflects the full superset (#944 posture)', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    insertGrant(db, { id: 'g-a', profile_id: 'p1', title: REGULATORY_TITLE, status: 'discovered' })
    insertGrant(db, { id: 'g-b', profile_id: 'p1', title: 'Privacy Act of 1974; System of Records', status: 'discovered' })
    insertGrant(db, { id: 'g-c', profile_id: 'p1', title: 'Notice of Public Hearing and Request for Comments', status: 'discovered' })
    process.env.NON_GRANT_PIPELINE_LIMIT = '1'

    const res = await enforceNonGrantNoticePipeline(db)
    // Discovery is NOT starved by the bound: every candidate was scanned…
    expect(res.scanned).toBe(3)
    // …while deletes stay bounded.
    expect(res.purged).toBe(1)
    expect(count(db)).toBe(2)
    // And a follow-up run converges on the remainder rather than stalling.
    const again = await enforceNonGrantNoticePipeline(db)
    expect(again.purged).toBe(1)
    expect(count(db)).toBe(1)
  })

  it('a clean fundable grant never even enters the candidate superset', async () => {
    insertProfile(db, { id: 'p1', orgId: 'o1' })
    const real = insertGrant(db, {
      profile_id: 'p1', title: 'Coca-Cola Scholars Program Scholarship',
      funder: 'Coca-Cola Scholars Foundation', status: 'interested',
      amount_requested: 20000, url: 'https://www.coca-colascholarsfoundation.org/apply',
    })
    const res = await enforceNonGrantNoticePipeline(db)
    expect(res.scanned).toBe(0)
    expect(res.repaired).toBe(0)
    expect(grantExists(real)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: a pointer-kind source that decomposition cannot reach is a
// RESEARCH LEAD, never a silently-dying application task (2026-08-04, the
// manual-handoff rule). The create-time policy gate refuses NEW tasks; this
// boot net converges the ones every pre-gate writer already minted.
// Adjudication is the policy gate's own assessPointerResearchLead, so the two
// can never drift.
// ─────────────────────────────────────────────────────────────────────────────
describe('enforcePointerTaskReclassification', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    // The sweep JOINs the catalog; the shared minimal schema has no
    // funding_opportunities table (real schema does; fo.url deliberately
    // absent — the #946/#954 SQLite/Postgres drift the sweep must not read).
    db.exec(`CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, opportunity_kind TEXT,
      application_url TEXT, source_url TEXT, evidence_url TEXT
    )`)
    _resetSchemaCache()
    await ensureApplicationTaskSchema(db) // real application_tasks schema
  })
  afterEach(() => {
    delete process.env.ENFORCE_POINTER_TASK_RECLASS
    delete process.env.POINTER_TASK_RECLASS_LIMIT
    delete process.env.HAMILTON_DECOMPOSE_POINTER_LISTINGS
  })

  const insertOpp = (id, kind, { title = 'Local scholarship directory', application_url = null, source_url = null, evidence_url = null } = {}) =>
    db.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, application_url, source_url, evidence_url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, title, kind, application_url, source_url, evidence_url)
  const insertTask = (id, oppId, { status = 'ready_to_start', automationType = 'portal', portalUrl = null } = {}) =>
    db.prepare('INSERT INTO application_tasks (id, profile_id, opportunity_id, status, automation_type, portal_url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'p1', oppId, status, automationType, portalUrl)
  const task = (id) => db.prepare('SELECT * FROM application_tasks WHERE id = ?').get(id)

  it('RECLASSIFIES a URL-less pointer task to a research lead carrying the handoff instructions (uppercase prod kind included)', async () => {
    insertOpp('opp-dir', 'DIRECTORY', { title: 'Bradley County assistance programs' })
    insertTask('t-dir', 'opp-dir')

    const res = await enforcePointerTaskReclassification(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)

    const t = task('t-dir')
    expect(t.automation_type).toBe('research_lead')
    expect(t.status).toBe('blocked')
    // The message is the policy gate's OWN generated handoff — it names the
    // source and tells the owner what to do (research, then add via Discovery).
    expect(t.last_agent_message).toContain('Bradley County assistance programs')
    expect(t.last_agent_message).toContain('Discovery')
  })

  it('LEAVES ALONE a pointer whose catalog row has a usable URL — decomposition reaches it', async () => {
    insertOpp('opp-listing', 'directory', { source_url: 'https://bold.org/scholarships/' })
    insertTask('t-listing', 'opp-listing')

    const res = await enforcePointerTaskReclassification(db)
    expect(res.repaired).toBe(0)
    expect(res.scanned).toBe(1) // it WAS a candidate; the URL is what saved it
    expect(task('t-listing').automation_type).toBe('portal')
    expect(task('t-listing').status).toBe('ready_to_start')
  })

  it("LEAVES ALONE a pointer whose TASK carries the portal URL even when the catalog row has none — the engine can still reach it", async () => {
    insertOpp('opp-bare', 'referral')
    insertTask('t-bare', 'opp-bare', { portalUrl: 'https://apply.example.org/portal' })

    const res = await enforcePointerTaskReclassification(db)
    expect(res.repaired).toBe(0)
    expect(task('t-bare').status).toBe('ready_to_start')
  })

  it('never touches a NON-pointer task or a TERMINAL pointer task (history is not rewritten)', async () => {
    insertOpp('opp-grant', 'direct_grant')
    insertTask('t-grant', 'opp-grant')
    insertOpp('opp-done', 'directory')
    insertTask('t-done', 'opp-done', { status: 'submitted' })

    const res = await enforcePointerTaskReclassification(db)
    expect(res.repaired).toBe(0)
    expect(task('t-grant').automation_type).toBe('portal')
    expect(task('t-done').status).toBe('submitted')
    expect(task('t-done').automation_type).toBe('portal')
  })

  it('COUNT-ONLY mode reports wouldRepair and writes nothing', async () => {
    process.env.ENFORCE_POINTER_TASK_RECLASS = '0'
    insertOpp('opp-dir', 'directory')
    insertTask('t-dir', 'opp-dir')

    const res = await enforcePointerTaskReclassification(db)
    expect(res.enforced).toBe(false)
    expect(res.repaired).toBe(0)
    expect(res.wouldRepair).toBe(1)
    expect(task('t-dir').automation_type).toBe('portal')
    expect(task('t-dir').status).toBe('ready_to_start')
  })

  it('is IDEMPOTENT: a reclassified task leaves the candidate set on the next boot', async () => {
    insertOpp('opp-dir', 'directory')
    insertTask('t-dir', 'opp-dir')

    const first = await enforcePointerTaskReclassification(db)
    expect(first.repaired).toBe(1)
    const second = await enforcePointerTaskReclassification(db)
    expect(second.repaired).toBe(0)
    expect(second.scanned).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT: grant_score_backfill — a NULL-score row is re-scored through the
// canonical engine, and the fresh decision is written UNCONDITIONALLY (the
// migration-stamped 'review' + '["general funding support"]' rows, 2026-08-04:
// COALESCE froze the cosmetic stamp forever even when the fresh canonical
// decision is REJECT).
// ─────────────────────────────────────────────────────────────────────────────
describe('enforceGrantScoreBackfill', () => {
  // The invariant's candidate SELECT + write touch columns the shared minimal
  // schema omits; the real grants schema has all of them.
  function makeScoreDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        funding_opportunity_id TEXT,
        title TEXT,
        description TEXT,
        funder TEXT,
        deadline TEXT,
        amount_min NUMERIC,
        amount_max NUMERIC,
        match_score INTEGER,
        match_decision TEXT,
        matcher_version TEXT,
        matched_needs TEXT
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        display_name TEXT,
        primary_type TEXT,
        state TEXT,
        status TEXT
      );
    `)
    raw.prepare(`INSERT INTO profiles (id, organization_id, primary_type, state) VALUES ('p1', 'o1', 'individual', 'TN')`).run()
    return raw
  }

  const insertScoreGrant = (db, g) => {
    const id = g.id || crypto.randomUUID()
    db.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, match_score, match_decision, matcher_version, matched_needs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, g.profile_id ?? 'p1', g.title, g.funder ?? null, g.match_score ?? null,
      g.match_decision ?? null, g.matcher_version ?? null, g.matched_needs ?? null)
    return id
  }
  const row = (db, id) => db.prepare('SELECT * FROM grants WHERE id = ?').get(id)

  it('OVERWRITES a migration-stamped review with the FRESH engine decision (REJECT reads REJECT; the needs stamp is replaced with the fresh JSON)', async () => {
    const db = makeScoreDb()
    try {
      // A regulatory notice: the canonical engine's junk chain REJECTs it for
      // any profile, so the fresh decision is deterministically REJECT — the
      // exact class the COALESCE froze as 'review' in prod.
      const id = insertScoreGrant(db, {
        title: 'Agency Information Collection Activities: Proposed Collection: Public Comment Request',
        funder: 'HRSA',
        match_decision: 'review', // cosmetic migration stamp, never a verdict
        matched_needs: '["general funding support"]', // the migration stamp
      })

      const res = await enforceGrantScoreBackfill(db)
      expect(res.ok).toBe(true)
      expect(res.repaired).toBe(1)

      const g = row(db, id)
      // The stamp did NOT survive via COALESCE — the fresh verdict is stored.
      expect(g.match_decision).toBe('REJECT')
      // SQLite is typeless: assert the persisted score's TYPE, not just truthiness.
      expect(typeof g.match_score).toBe('number')
      expect(Number.isInteger(g.match_score)).toBe(true)
      // The migration-stamped needs are replaced with the fresh decision's needs
      // JSON (computed by the same canonical engine on the same inputs).
      const { computeMatchDecision } = await import('../services/matchEngine.js')
      const fresh = computeMatchDecision(
        db.prepare(`SELECT * FROM profiles WHERE id = 'p1'`).get(),
        { id, title: g.title, description: null, sponsor: g.funder, deadline: null, amount_min: null, amount_max: null },
        { profileSections: {} },
      )
      expect(g.matched_needs).not.toBe('["general funding support"]')
      expect(g.matched_needs).toBe(JSON.stringify(fresh.matchedNeeds ?? []))
    } finally { db.close() }
  })

  it('any OTHER stored matched_needs value is left alone', async () => {
    const db = makeScoreDb()
    try {
      const id = insertScoreGrant(db, {
        title: 'Community Housing Assistance Grant',
        funder: 'Example Foundation',
        matched_needs: '["housing"]',
      })
      const res = await enforceGrantScoreBackfill(db)
      expect(res.repaired).toBe(1)
      const g = row(db, id)
      expect(typeof g.match_score).toBe('number')
      expect(g.matched_needs).toBe('["housing"]') // untouched — not the stamp
      expect(typeof g.match_decision).toBe('string') // fresh decision still written
    } finally { db.close() }
  })

  it('matcher_version backfills to score-backfill ONLY when NULL', async () => {
    const db = makeScoreDb()
    try {
      const wasNull = insertScoreGrant(db, { title: 'Community Arts Grant', funder: 'Arts Council' })
      const wasSet = insertScoreGrant(db, {
        title: 'Community Garden Grant', funder: 'Garden Trust', matcher_version: 'crawler-os',
      })
      const res = await enforceGrantScoreBackfill(db)
      expect(res.repaired).toBe(2)
      expect(row(db, wasNull).matcher_version).toBe('score-backfill')
      expect(row(db, wasSet).matcher_version).toBe('crawler-os') // never overwritten
    } finally { db.close() }
  })

  it('a row that already carries a score is never a candidate (scored rows untouched)', async () => {
    const db = makeScoreDb()
    try {
      const scored = insertScoreGrant(db, {
        title: 'Agency Information Collection Activities: Proposed Collection: Public Comment Request',
        match_score: 82, match_decision: 'review', matched_needs: '["general funding support"]',
      })
      const res = await enforceGrantScoreBackfill(db)
      expect(res.scanned).toBe(0)
      const g = row(db, scored)
      expect(g.match_decision).toBe('review')
      expect(g.matched_needs).toBe('["general funding support"]')
    } finally { db.close() }
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

describe('enforceSourceUrlSelfRepair', () => {
  function makeDb() {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)')
    return db
  }
  const FAILING = [{ source_id: 'tn_state_portal', source_label: 'TN One DHS', last_error: '404' }]
  const SRC = { id: 'tn_state_portal', name: 'Tennessee One DHS Portal', base_url: 'https://www.tn.gov/humanservices/old-portal.html' }
  const overridesOf = (db) => {
    const row = db.prepare(`SELECT value FROM system_kv WHERE key = 'source_url_overrides'`).get()
    return row ? JSON.parse(row.value) : { overrides: {}, proposals: {} }
  }
  const makeDbRef = {}
  const base = (deps) => enforceSourceUrlSelfRepair(makeDbRef.db, deps)

  it('a host redirect ON the same registrable domain becomes an autonomous override', async () => {
    const db = (makeDbRef.db = makeDb())
    const res = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async () => ({ status: 'redirect', finalUrl: 'https://www.tn.gov/humanservices/new-portal/' }),
      searchWebImpl: async () => { throw new Error('must not search when the host answered') },
    })
    expect(res.repaired).toBe(1)
    const s = overridesOf(db)
    expect(s.overrides.tn_state_portal.to_prefix).toBe('https://www.tn.gov/humanservices/new-portal/')
    expect(s.overrides.tn_state_portal.evidence.kind).toBe('host_redirect')
  })

  it('a CROSS-domain redirect becomes a PROPOSAL, never an override', async () => {
    const db = (makeDbRef.db = makeDb())
    const res = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async () => ({ status: 'redirect', finalUrl: 'https://www.newstateportal.org/' }),
      searchWebImpl: async () => [],
    })
    expect(res.proposed).toBe(1)
    expect(res.repaired).toBe(0)
    const s = overridesOf(db)
    expect(s.overrides.tn_state_portal).toBeUndefined()
    expect(s.proposals.tn_state_portal.to_prefix).toBe('https://www.newstateportal.org/')
  })

  it('a dead page repaired by DOMAIN-PINNED search: off-domain hits can never win the override', async () => {
    const db = (makeDbRef.db = makeDb())
    const probes = []
    const res = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async (url) => {
        probes.push(url)
        if (url === SRC.base_url) return { status: 'broken', finalUrl: null }
        return { status: 'ok', finalUrl: url }
      },
      searchWebImpl: async () => [
        { url: 'https://lookalike-dhs.com/tennessee', title: 'Tennessee One DHS Portal' }, // plausible lookalike
        { url: 'https://www.tn.gov/humanservices/one-dhs/', title: 'One DHS | TN.gov' },
      ],
    })
    expect(res.repaired).toBe(1)
    const s = overridesOf(db)
    expect(s.overrides.tn_state_portal.to_prefix).toBe('https://www.tn.gov/humanservices/one-dhs/')
    expect(s.overrides.tn_state_portal.evidence.kind).toBe('domain_pinned_search')
    expect(probes, 'the lookalike is filtered BEFORE any probe').not.toContain('https://lookalike-dhs.com/tennessee')
  })

  it('a trailing-slash-only redirect is NOT a move — aliveNoRepair, no degenerate override', async () => {
    // Prod caught this on the lane's FIRST boot: sbir.gov redirected to
    // sbir.gov/ and the sweep minted a no-op override that would have
    // double-slashed every deeper URL and parked the source as "overridden".
    const db = (makeDbRef.db = makeDb())
    const res = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => ({ ...SRC, base_url: 'https://www.sbir.gov' }),
      checkUrlImpl: async () => ({ status: 'redirect', finalUrl: 'https://www.sbir.gov/' }),
      searchWebImpl: async () => [],
    })
    expect(res.repaired).toBe(0)
    expect(res.aliveNoRepair).toBe(1)
    expect(overridesOf(db).overrides?.tn_state_portal).toBeUndefined()
  })

  it('search-provider outage spends no attempt; alive-at-curated-URL spends one (converges to exhausted)', async () => {
    const db = (makeDbRef.db = makeDb())
    await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async () => ({ status: 'broken', finalUrl: null }),
      searchWebImpl: async () => { throw new Error('provider down') },
    })
    const afterOutage = db.prepare(`SELECT value FROM system_kv WHERE key = 'source_url_self_repair_state'`).get()
    expect(Object.keys(JSON.parse(afterOutage?.value ?? '{"entries":{}}').entries)).toHaveLength(0)
    const r2 = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async () => ({ status: 'ok', finalUrl: SRC.base_url }),
      searchWebImpl: async () => [],
      maxAttempts: 1,
    })
    expect(r2.aliveNoRepair).toBe(1)
    const st = JSON.parse(db.prepare(`SELECT value FROM system_kv WHERE key = 'source_url_self_repair_state'`).get().value)
    expect(st.entries.tn_state_portal.exhausted).toBe(true)
  })

  it('an already-overridden source is never churned, and count-only mode never writes', async () => {
    const db = (makeDbRef.db = makeDb())
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'source_url_overrides',
      JSON.stringify({ overrides: { tn_state_portal: { from_prefix: SRC.base_url, to_prefix: 'https://www.tn.gov/x/' } } }),
      new Date().toISOString(),
    )
    const r = await base({
      detectorImpl: async () => FAILING,
      getSourceImpl: () => SRC,
      checkUrlImpl: async () => { throw new Error('must not probe an overridden source') },
      searchWebImpl: async () => [],
    })
    expect(r.repaired).toBe(0)
    expect(r.skippedCooldown).toBe(1)

    const db2 = (makeDbRef.db = makeDb())
    const prev = process.env.ENFORCE_SOURCE_URL_SELF_REPAIR
    process.env.ENFORCE_SOURCE_URL_SELF_REPAIR = '0'
    try {
      const rc = await base({
        detectorImpl: async () => FAILING,
        getSourceImpl: () => SRC,
        checkUrlImpl: async () => { throw new Error('count-only must not probe') },
        searchWebImpl: async () => [],
      })
      expect(rc.enforced).toBe(false)
      expect(overridesOf(db2).overrides.tn_state_portal).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_SOURCE_URL_SELF_REPAIR
      else process.env.ENFORCE_SOURCE_URL_SELF_REPAIR = prev
    }
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

/* ────────────────────────────────────────────────────────────────────────────
 * SCOPE OF A SURFACED MATCH — the 2026-08-01 GeneMac report.
 *
 * Producer gates (matchEngine.makeDecision, osOppToLiveRow) stop NEW bad rows.
 * These three sweeps are what reaches the rows the owner is looking at RIGHT
 * NOW, for EVERY profile — the match store is a rolling snapshot rebuilt per
 * run, so without them a fix only lands for a profile after its next crawl.
 *
 * Every behavioral test below FAILS on a no-op sweep body.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('enforce: scope of a surfaced match (geo + award scale)', () => {
  function makeScopeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        display_name TEXT,
        primary_type TEXT,
        applicant_type TEXT,
        status TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        title TEXT,
        sponsor TEXT,
        state TEXT,
        is_national INTEGER,
        amount_min NUMERIC,
        amount_max NUMERIC,
        source_url TEXT,
        application_url TEXT,
        evidence_url TEXT
      );
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        match_score REAL,
        match_decision TEXT,
        matcher_version TEXT
      );
    `)
    return raw
  }
  function opp(db, row) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, state, is_national, amount_min, amount_max, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.title ?? null, row.sponsor ?? null, row.state ?? null,
      row.is_national ?? 0, row.amount_min ?? null, row.amount_max ?? null, row.source_url ?? null,
    )
  }
  function match(db, id, profileId, oppId) {
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES (?, ?, ?, 13, 'review', 'crawler-os-xmatch')`,
    ).run(id, profileId, oppId)
  }
  const matchIdsOf = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => {
    delete process.env.ENFORCE_DECLARED_GEO_SCOPE
    delete process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE
    delete process.env.ENFORCE_INDIVIDUAL_MATCH_CEILING
    delete process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING
  })

  // ── enforceDeclaredGeoScope ────────────────────────────────────────────────
  it('re-scopes a catalog row from the state it declares in its OWN title', async () => {
    const db = makeScopeDb()
    try {
      opp(db, { id: 'o-polk', title: 'Polk County, TN — Local assistance programs near you (findhelp)', state: null, is_national: 1 })
      opp(db, { id: 'o-lagrange', title: 'La Grange County, IN — Local housing help — HUD Resource Locator', state: null, is_national: 1 })

      const res = await enforceDeclaredGeoScope(db)
      expect(res.repaired).toBe(2)
      const rows = db.prepare('SELECT id, state, is_national FROM funding_opportunities ORDER BY id').all()
      expect(rows.find((r) => r.id === 'o-polk')).toMatchObject({ state: 'TN', is_national: 0 })
      expect(rows.find((r) => r.id === 'o-lagrange')).toMatchObject({ state: 'IN', is_national: 0 })
    } finally { db.close() }
  })

  it('never overrides a scope the SOURCE supplied, and never invents one', async () => {
    const db = makeScopeDb()
    try {
      // Source already said GA — a title coincidence must not rewrite it.
      opp(db, { id: 'o-src', title: 'Polk County, TN — Local assistance', state: 'GA', is_national: 1 })
      // Genuinely national: declares nothing.
      opp(db, { id: 'o-natl', title: '211 - Local help with rent, utilities, food & emergencies', state: null, is_national: 1 })
      // Not a real state code (prod contains "Anytown, SA — …").
      opp(db, { id: 'o-junk', title: 'Anytown, SA — Local assistance programs near you (findhelp)', state: null, is_national: 1 })

      const res = await enforceDeclaredGeoScope(db)
      expect(res.repaired).toBe(0)
      const rows = db.prepare('SELECT id, state, is_national FROM funding_opportunities ORDER BY id').all()
      expect(rows.find((r) => r.id === 'o-src')).toMatchObject({ state: 'GA', is_national: 1 })
      expect(rows.find((r) => r.id === 'o-natl')).toMatchObject({ state: null, is_national: 1 })
      expect(rows.find((r) => r.id === 'o-junk')).toMatchObject({ state: null, is_national: 1 })
    } finally { db.close() }
  })

  it('CONVERGES: a second run finds nothing (no nightly tug-of-war)', async () => {
    const db = makeScopeDb()
    try {
      opp(db, { id: 'o-polk', title: 'Polk County, TN — Local assistance', state: null, is_national: 1 })
      expect((await enforceDeclaredGeoScope(db)).repaired).toBe(1)
      expect((await enforceDeclaredGeoScope(db)).repaired).toBe(0)
      expect((await enforceDeclaredGeoScope(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('ENFORCE_DECLARED_GEO_SCOPE=0 counts without repairing', async () => {
    const db = makeScopeDb()
    try {
      opp(db, { id: 'o-polk', title: 'Polk County, TN — Local assistance', state: null, is_national: 1 })
      process.env.ENFORCE_DECLARED_GEO_SCOPE = '0'
      const off = await enforceDeclaredGeoScope(db)
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldRepair).toBe(1)
      expect(db.prepare('SELECT state FROM funding_opportunities WHERE id = ?').get('o-polk').state).toBe(null)

      delete process.env.ENFORCE_DECLARED_GEO_SCOPE
      expect((await enforceDeclaredGeoScope(db)).repaired).toBe(1)
    } finally { db.close() }
  })

  // ── enforceForeignJurisdictionMatches ──────────────────────────────────────
  it('removes matches to foreign-jurisdiction programs, for EVERY profile', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-senior', 'senior')
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-org', 'nonprofit')
      opp(db, { id: 'o-ie', title: 'Housing Adaptation Grant for People with a Disability', sponsor: 'Local Authorities', source_url: 'https://www.citizensinformation.ie/en/housing/housing-grants-and-schemes/', state: null, is_national: 1 })
      opp(db, { id: 'o-uk', title: 'Disabled Facilities Grant', source_url: 'https://www.gov.uk/disabled-facilities-grants', state: null, is_national: 1 })
      opp(db, { id: 'o-us', title: 'Indiana FSSA Benefits Portal', source_url: 'https://fssabenefits.in.gov', state: 'IN', is_national: 0 })
      opp(db, { id: 'o-short', title: 'Alaska Fellows Program', source_url: 'https://lnkd.in/dC6VRfHD', state: null, is_national: 1 })
      match(db, 'm1', 'p-senior', 'o-ie')
      match(db, 'm2', 'p-org', 'o-ie')
      match(db, 'm3', 'p-senior', 'o-uk')
      match(db, 'm4', 'p-senior', 'o-us')
      match(db, 'm5', 'p-senior', 'o-short')

      const res = await enforceForeignJurisdictionMatches(db)
      expect(res.repaired).toBe(3)
      expect(res.profilesAffected).toBe(2)
      expect(matchIdsOf(db)).toEqual(['m4', 'm5'])
      // The CATALOG row survives — it is a true record of a real program.
      expect(db.prepare('SELECT id FROM funding_opportunities WHERE id = ?').get('o-ie')).toBeTruthy()
    } finally { db.close() }
  })

  it('foreign purge is idempotent and count-only under ENFORCE_FOREIGN_JURISDICTION_SCOPE=0', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
      opp(db, { id: 'o-ie', title: 'Irish scheme', source_url: 'https://www.citizensinformation.ie/x', state: null, is_national: 1 })
      match(db, 'm1', 'p1', 'o-ie')

      process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE = '0'
      const off = await enforceForeignJurisdictionMatches(db)
      expect(off.enforced).toBe(false)
      expect(off.wouldRepair).toBe(1)
      expect(matchIdsOf(db)).toEqual(['m1'])

      delete process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE
      expect((await enforceForeignJurisdictionMatches(db)).repaired).toBe(1)
      expect((await enforceForeignJurisdictionMatches(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  // ── enforceIndividualMatchAwardCeiling ─────────────────────────────────────
  it('removes institutional-scale awards from a PERSON match set (the HUD FHIP class)', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-senior', 'senior')
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-student', 'student')
      opp(db, { id: 'o-fhip', title: 'Fair Housing Initiative Program - Education and Outreach Initiative', sponsor: 'HUD', amount_min: 0, amount_max: 1250000 })
      opp(db, { id: 'o-nsf', title: 'Oceanographic Facilities and Equipment Support', amount_min: 5000, amount_max: 47500000 })
      match(db, 'm1', 'p-senior', 'o-fhip')
      match(db, 'm2', 'p-student', 'o-nsf')

      const res = await enforceIndividualMatchAwardCeiling(db)
      expect(res.repaired).toBe(2)
      expect(res.ceiling).toBe(100000)
      expect(matchIdsOf(db)).toEqual([])
    } finally { db.close() }
  })

  it('never touches an ORG, an unknown type, or a row that states NO amount', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-org', 'nonprofit')
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-unknown', 'wat')
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-senior', 'senior')
      opp(db, { id: 'o-big', title: 'PRO Housing', amount_min: 5000000, amount_max: 10000000 })
      opp(db, { id: 'o-silent', title: 'Area Agency on Aging & Eldercare Locator', amount_min: null, amount_max: null })
      opp(db, { id: 'o-small', title: 'Housing repair assistance', amount_min: 500, amount_max: 25000 })
      match(db, 'm-org', 'p-org', 'o-big')
      match(db, 'm-unknown', 'p-unknown', 'o-big')
      match(db, 'm-silent', 'p-senior', 'o-silent')
      match(db, 'm-small', 'p-senior', 'o-small')

      const res = await enforceIndividualMatchAwardCeiling(db)
      expect(res.repaired).toBe(0)
      expect(matchIdsOf(db)).toEqual(['m-org', 'm-silent', 'm-small', 'm-unknown'])
    } finally { db.close() }
  })

  it('ceiling purge is idempotent and count-only under ENFORCE_INDIVIDUAL_MATCH_CEILING=0', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
      opp(db, { id: 'o-big', title: 'Title X', amount_min: 200000, amount_max: 22000000 })
      match(db, 'm1', 'p1', 'o-big')

      process.env.ENFORCE_INDIVIDUAL_MATCH_CEILING = '0'
      const off = await enforceIndividualMatchAwardCeiling(db)
      expect(off.enforced).toBe(false)
      expect(off.wouldRepair).toBe(1)
      expect(matchIdsOf(db)).toEqual(['m1'])

      delete process.env.ENFORCE_INDIVIDUAL_MATCH_CEILING
      expect((await enforceIndividualMatchAwardCeiling(db)).repaired).toBe(1)
      expect((await enforceIndividualMatchAwardCeiling(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('honours the SHARED env ceiling (one bar with the pipeline sweep, not two)', async () => {
    const db = makeScopeDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
      opp(db, { id: 'o-mid', title: 'Mid-size award', amount_max: 150000 })
      match(db, 'm1', 'p1', 'o-mid')

      process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING = '200000'
      expect((await enforceIndividualMatchAwardCeiling(db)).repaired).toBe(0)
      delete process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING
      expect((await enforceIndividualMatchAwardCeiling(db)).repaired).toBe(1)
    } finally { db.close() }
  })

  it('all three degrade to a schema skip (never a failure) on a minimal DB', async () => {
    const db = makeDb() // grants/profiles only — no match or catalog tables
    try {
      for (const res of [
        await enforceForeignJurisdictionMatches(db),
        await enforceIndividualMatchAwardCeiling(db),
        await enforceDeclaredGeoScope(db),
      ]) {
        expect(res.ok).toBe(true)
        expect(res.repaired).toBe(0)
      }
    } finally { db.close() }
  })
})

describe('enforce: an out-of-area locator is not surfaced to a profile somewhere else', () => {
  function makePlaceDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, primary_type TEXT, applicant_type TEXT);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, state TEXT, is_national INTEGER);
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  const seed = (db) => {
    db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-in', 'senior')
    db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-nostate', 'individual')
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p-in','basic_information',?)")
      .run(JSON.stringify({ city: 'Lagrange', state: 'IN', county: 'La Grange' }))
    // Locators, exactly as prod stores them (place ONLY in the title).
    for (const [id, title] of [
      ['o-polk', 'Polk County, TN — Local assistance programs near you (findhelp)'],
      ['o-raleigh', 'Raleigh County, WV — Local housing help — HUD Resource Locator'],
      ['o-lagrange', 'La Grange County, IN — Local assistance programs near you (findhelp)'],
      ['o-211', '211 - Local help with rent, utilities, food & emergencies'],
    ]) {
      db.prepare('INSERT INTO funding_opportunities (id, title, state, is_national) VALUES (?, ?, NULL, 1)').run(id, title)
    }
    for (const [mid, pid, oid] of [
      ['m-polk', 'p-in', 'o-polk'],
      ['m-raleigh', 'p-in', 'o-raleigh'],
      ['m-lagrange', 'p-in', 'o-lagrange'],
      ['m-211', 'p-in', 'o-211'],
      ['m-polk-nostate', 'p-nostate', 'o-polk'],
    ]) {
      db.prepare(
        `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
         VALUES (?, ?, ?, 13, 'review', 'crawler-os-xmatch')`,
      ).run(mid, pid, oid)
    }
  }
  const idsOf = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => { delete process.env.ENFORCE_DECLARED_PLACE_SCOPE })

  it('removes another state’s locators and KEEPS the profile’s own + genuinely national ones', async () => {
    const db = makePlaceDb()
    try {
      seed(db)
      const res = await enforceDeclaredPlaceScopeMatches(db)
      expect(res.repaired).toBe(2)
      expect(res.profilesAffected).toBe(1)
      // m-lagrange (own county), m-211 (national), m-polk-nostate (profile state
      // UNKNOWN → neutral, exactly as the engine treats it) all survive.
      expect(idsOf(db)).toEqual(['m-211', 'm-lagrange', 'm-polk-nostate'])
    } finally { db.close() }
  })

  it('reads the state from location_focus too, not just basic_information', async () => {
    const db = makePlaceDb()
    try {
      seed(db)
      db.prepare("DELETE FROM profile_sections WHERE profile_id = 'p-in'").run()
      db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p-in','location_focus',?)")
        .run(JSON.stringify({ focus_state: 'IN', focus_county: 'La Grange' }))
      expect((await enforceDeclaredPlaceScopeMatches(db)).repaired).toBe(2)
      expect(idsOf(db)).toEqual(['m-211', 'm-lagrange', 'm-polk-nostate'])
    } finally { db.close() }
  })

  it('a MULTI-state profile keeps locators in every state it declares', async () => {
    const db = makePlaceDb()
    try {
      seed(db)
      db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p-in','location_focus',?)")
        .run(JSON.stringify({ focus_state: 'WV' }))
      const res = await enforceDeclaredPlaceScopeMatches(db)
      expect(res.repaired).toBe(1) // only TN is now out of area
      expect(idsOf(db)).toEqual(['m-211', 'm-lagrange', 'm-polk-nostate', 'm-raleigh'])
    } finally { db.close() }
  })

  it('is idempotent and count-only under ENFORCE_DECLARED_PLACE_SCOPE=0', async () => {
    const db = makePlaceDb()
    try {
      seed(db)
      process.env.ENFORCE_DECLARED_PLACE_SCOPE = '0'
      const off = await enforceDeclaredPlaceScopeMatches(db)
      expect(off.enforced).toBe(false)
      expect(off.wouldRepair).toBe(2)
      expect(idsOf(db)).toHaveLength(5)

      delete process.env.ENFORCE_DECLARED_PLACE_SCOPE
      expect((await enforceDeclaredPlaceScopeMatches(db)).repaired).toBe(2)
      expect((await enforceDeclaredPlaceScopeMatches(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('degrades to a schema skip (never a failure) on a minimal DB', async () => {
    const db = makeDb()
    try {
      const res = await enforceDeclaredPlaceScopeMatches(db)
      expect(res.ok).toBe(true)
      expect(res.repaired).toBe(0)
    } finally { db.close() }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * GLOBAL MATCH SCOPE — the 2026-08-03 Robert White report ("the matching
 * engine casts far too wide a net"). Three sweeps, each on REAL prod shapes.
 * Every behavioral test below FAILS on a no-op sweep body.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('enforceStateAgencyGeoScope — a per-state HFA row IS state-scoped', () => {
  function makeHfaDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, primary_type TEXT, applicant_type TEXT);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, source TEXT, state TEXT, is_national INTEGER);
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  // REAL prod rows, verbatim: 18 catalog rows, ALL state NULL / is_national 1.
  const seed = (db) => {
    db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-tn', 'student')
    db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p-nostate', 'individual')
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p-tn','basic_information',?)")
      .run(JSON.stringify({ city: 'Cleveland', state: 'TN', county: 'Bradley' }))
    for (const [id, sponsor] of [
      ['o-wv', 'West Virginia Housing Development Fund'],
      ['o-tn', 'Tennessee Housing Development Agency'],
      ['o-oh', 'Ohio Housing Finance Agency'],
    ]) {
      db.prepare(
        `INSERT INTO funding_opportunities (id, title, sponsor, source, state, is_national)
         VALUES (?, ?, ?, 'state_housing_finance_agency', NULL, 1)`,
      ).run(id, `${sponsor} — homeowner & renter housing programs`, sponsor)
    }
    // The generic national fallback resolves to NOTHING and stays national.
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, sponsor, source, state, is_national)
       VALUES ('o-generic', 'State housing agency — homeowner & renter programs', 'State housing finance agency', 'state_housing_finance_agency', NULL, 1)`,
    ).run()
    for (const [mid, pid, oid] of [
      ['m-tn-wv', 'p-tn', 'o-wv'],       // TENNESSEE student ↔ West Virginia fund: the owner's row
      ['m-tn-tn', 'p-tn', 'o-tn'],       // his OWN agency: kept
      ['m-tn-oh', 'p-tn', 'o-oh'],
      ['m-tn-gen', 'p-tn', 'o-generic'], // generic national row: kept
      ['m-ns-wv', 'p-nostate', 'o-wv'],  // UNKNOWN profile state: NEUTRAL, kept
    ]) {
      db.prepare(
        `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
         VALUES (?, ?, ?, 17, 'review', 'crawler-os-xmatch')`,
      ).run(mid, pid, oid)
    }
  }
  const idsOf = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => { delete process.env.ENFORCE_STATE_AGENCY_GEO_SCOPE })

  it('re-scopes the minted rows from the registry that minted them, and purges out-of-state agency matches', async () => {
    const db = makeHfaDb()
    try {
      seed(db)
      const res = await enforceStateAgencyGeoScope(db)
      expect(res.repaired).toBe(3)
      expect(res.purged).toBe(2) // WV + OH for the TN student
      const rows = db.prepare('SELECT id, state, is_national FROM funding_opportunities ORDER BY id').all()
      expect(rows.find((r) => r.id === 'o-wv')).toMatchObject({ state: 'WV', is_national: 0 })
      expect(rows.find((r) => r.id === 'o-tn')).toMatchObject({ state: 'TN', is_national: 0 })
      expect(rows.find((r) => r.id === 'o-generic')).toMatchObject({ state: null, is_national: 1 })
      // His own agency, the generic national row, and the stateless profile's
      // row all survive (MISSING = NEUTRAL).
      expect(idsOf(db)).toEqual(['m-ns-wv', 'm-tn-gen', 'm-tn-tn'])
    } finally { db.close() }
  })

  it('CONVERGES and is idempotent', async () => {
    const db = makeHfaDb()
    try {
      seed(db)
      await enforceStateAgencyGeoScope(db)
      const second = await enforceStateAgencyGeoScope(db)
      expect(second.repaired).toBe(0)
      expect(second.purged).toBe(0)
    } finally { db.close() }
  })

  it('never touches rows from OTHER sources, even with a state-name title', async () => {
    const db = makeHfaDb()
    try {
      seed(db)
      // A web_search row whose title merely CONTAINS a state agency name —
      // not this sweep's row to judge (the source id is the SQL predicate).
      db.prepare(
        `INSERT INTO funding_opportunities (id, title, sponsor, source, state, is_national)
         VALUES ('o-web', 'Guide to the Ohio Housing Finance Agency', 'Some Blog', 'web_search', NULL, 1)`,
      ).run()
      await enforceStateAgencyGeoScope(db)
      expect(db.prepare("SELECT state, is_national FROM funding_opportunities WHERE id = 'o-web'").get())
        .toMatchObject({ state: null, is_national: 1 })
    } finally { db.close() }
  })

  it('ENFORCE_STATE_AGENCY_GEO_SCOPE=0 counts without repairing or purging', async () => {
    const db = makeHfaDb()
    try {
      seed(db)
      process.env.ENFORCE_STATE_AGENCY_GEO_SCOPE = '0'
      const off = await enforceStateAgencyGeoScope(db)
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldRepair).toBe(3)
      expect(off.wouldPurge).toBe(0) // purge candidates need the state repaired first
      expect(idsOf(db)).toHaveLength(5)
      expect(db.prepare("SELECT state FROM funding_opportunities WHERE id = 'o-wv'").get().state).toBe(null)

      delete process.env.ENFORCE_STATE_AGENCY_GEO_SCOPE
      const on = await enforceStateAgencyGeoScope(db)
      expect(on.repaired).toBe(3)
      expect(on.purged).toBe(2)
    } finally { db.close() }
  })
})

describe('enforceCrossProfileMatchPrecision — a cross-match is a match only on ACCEPT', () => {
  function makeXmDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  const seedRow = (db, id, pid, decision, version) => {
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES (?, ?, ?, 14, ?, ?)`,
    ).run(id, pid, `opp-${id}`, decision, version)
  }
  const idsOf = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => { delete process.env.ENFORCE_XMATCH_PRECISION })

  it('purges non-ACCEPT xmatch rows and NOTHING else (the 95.5%-REVIEW prod flood)', async () => {
    const db = makeXmDb()
    try {
      seedRow(db, 'xm-review', 'p1', 'review', 'crawler-os-xmatch')   // the flood
      seedRow(db, 'xm-null', 'p2', null, 'crawler-os-xmatch')         // decision-less xmatch is not evidence either
      seedRow(db, 'xm-accept', 'p1', 'accept', 'crawler-os-xmatch')   // endorsed — kept
      seedRow(db, 'own-review', 'p1', 'review', 'crawler-os')         // the profile's OWN locator band — untouchable
      seedRow(db, 'webllm-review', 'p1', 'review', 'web-llm')         // other versions — not this sweep's rows
      const res = await enforceCrossProfileMatchPrecision(db)
      expect(res.repaired).toBe(2)
      expect(res.profilesAffected).toBe(2)
      expect(idsOf(db)).toEqual(['own-review', 'webllm-review', 'xm-accept'])
      // Converges.
      expect((await enforceCrossProfileMatchPrecision(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('ENFORCE_XMATCH_PRECISION=0 counts without deleting', async () => {
    const db = makeXmDb()
    try {
      seedRow(db, 'xm-review', 'p1', 'review', 'crawler-os-xmatch')
      process.env.ENFORCE_XMATCH_PRECISION = '0'
      const off = await enforceCrossProfileMatchPrecision(db)
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldRepair).toBe(1)
      expect(idsOf(db)).toEqual(['xm-review'])

      delete process.env.ENFORCE_XMATCH_PRECISION
      expect((await enforceCrossProfileMatchPrecision(db)).repaired).toBe(1)
    } finally { db.close() }
  })
})

describe('enforceConditionLaneMatchScope — a disease lane reaches only a declared condition', () => {
  function makeCondDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT, source TEXT);
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  // REAL prod rows, verbatim (Robert White's surviving pre-gate set + the
  // xmatch kidney fund; evaluated 2026-08-02T04:10Z, restored across his
  // 2026-08-03 crawl by the resource-preserving reconcile).
  const seed = (db) => {
    for (const [id, source, title] of [
      ['o-amputee', 'amputee_coalition_resources', 'Amputee Coalition limb loss & limb difference resources'],
      ['o-kidney', 'american_kidney_fund', 'American Kidney Fund financial assistance (dialysis & kidney disease)'],
      ['o-arthritis', 'arthritis_foundation_help', 'Arthritis Foundation help line & financial-resource navigation'],
      ['o-hlaa', 'hlaa_financial_assistance', 'HLAA financial assistance for hearing aids & hearing care'],
      ['o-ecf', 'tn_ecf_choices', 'Employment and Community First CHOICES (ECF CHOICES)'], // NOT a disease lane
    ]) {
      db.prepare('INSERT INTO funding_opportunities (id, title, source) VALUES (?, ?, ?)').run(id, title, source)
    }
    for (const [mid, pid, oid, version] of [
      ['m-r-amputee', 'p-robert', 'o-amputee', 'crawler-os'],
      ['m-r-kidney', 'p-robert', 'o-kidney', 'crawler-os-xmatch'],
      ['m-r-arthritis', 'p-robert', 'o-arthritis', 'crawler-os'],
      ['m-r-ecf', 'p-robert', 'o-ecf', 'crawler-os'],
      ['m-j-arthritis', 'p-john', 'o-arthritis', 'crawler-os'],
      ['m-j-hlaa', 'p-john', 'o-hlaa', 'crawler-os'],
      ['m-u-kidney', 'p-unreadable', 'o-kidney', 'crawler-os'],
    ]) {
      db.prepare(
        `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
         VALUES (?, ?, ?, 31, 'review', ?)`,
      ).run(mid, pid, oid, version)
    }
  }
  // The SAME shape buildThesisForProfile returns; injectable exactly like
  // enforceStudentAidEligibility's resolveThesis.
  const theses = {
    'p-robert': { declared_health_terms: [] },              // a READ that found nothing → purge
    'p-john': { declared_health_terms: ['arthritis'] },     // SUPPORT-declared arthritis keeps his lane
    'p-unreadable': null,                                    // thesis unavailable → NEUTRAL
  }
  const resolveThesis = async (db, pid) => {
    const t = theses[pid]
    if (t === null) throw new Error('profile unreadable')
    return t
  }
  const idsOf = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => { delete process.env.ENFORCE_CONDITION_LANE_SCOPE })

  it('purges disease-lane rows for a profile with an EMPTY declared-health read; keeps a declared condition and every non-disease lane', async () => {
    const db = makeCondDb()
    try {
      seed(db)
      const res = await enforceConditionLaneMatchScope(db, { resolveThesis })
      // Robert (empty read): amputee + kidney + arthritis purged; ECF CHOICES
      // (state_programs, not a disease lane) never a candidate.
      // John (arthritis in SUPPORT): arthritis kept, HLAA (hearing) purged.
      expect(res.repaired).toBe(4)
      expect(res.profilesSkipped).toBe(1)
      expect(idsOf(db)).toEqual(['m-j-arthritis', 'm-r-ecf', 'm-u-kidney'])
      // Converges.
      expect((await enforceConditionLaneMatchScope(db, { resolveThesis })).repaired).toBe(0)
    } finally { db.close() }
  })

  it('MISSING = NEUTRAL: an unreadable thesis or a non-array declared_health_terms adjudicates nothing', async () => {
    const db = makeCondDb()
    try {
      seed(db)
      const neutral = async () => ({ declared_health_terms: undefined })
      const res = await enforceConditionLaneMatchScope(db, { resolveThesis: neutral })
      expect(res.repaired).toBe(0)
      expect(idsOf(db)).toHaveLength(7)
    } finally { db.close() }
  })

  it('ENFORCE_CONDITION_LANE_SCOPE=0 counts without deleting', async () => {
    const db = makeCondDb()
    try {
      seed(db)
      process.env.ENFORCE_CONDITION_LANE_SCOPE = '0'
      const off = await enforceConditionLaneMatchScope(db, { resolveThesis })
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldRepair).toBe(4)
      expect(idsOf(db)).toHaveLength(7)

      delete process.env.ENFORCE_CONDITION_LANE_SCOPE
      expect((await enforceConditionLaneMatchScope(db, { resolveThesis })).repaired).toBe(4)
    } finally { db.close() }
  })

  it('a GENERIC descriptor ("disability") does not keep a named-condition lane (the #937 floor)', async () => {
    const db = makeCondDb()
    try {
      seed(db)
      const generic = async () => ({ declared_health_terms: ['disability'] })
      const res = await enforceConditionLaneMatchScope(db, { resolveThesis: generic })
      // Every disease-lane row goes: `disability` is a category of person,
      // not a condition (GENERIC_HEALTH_DESCRIPTORS, same rule as the planner).
      expect(res.repaired).toBe(6)
      expect(idsOf(db)).toEqual(['m-r-ecf'])
    } finally { db.close() }
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * THE POST-LIMIT REGRESSION (prod 2026-08-01, #944 class, one level down).
 *
 * `enforceForeignJurisdictionMatches` shipped selecting MATCH rows with NO
 * WHERE clause and deciding foreign-ness in JS *after* `LIMIT ?`. Prod recorded
 *   {"name":"foreign_jurisdiction_matches","ok":true,"repaired":1,"scanned":2000}
 * — `scanned` equal to the bound exactly. 515 of 516 foreign rows were
 * structurally unreachable no matter how many times the sweep ran, while it
 * reported ok:true. The three sibling sweeps written in the same PR all carried
 * a SQL predicate and all converged (84/87, 494/875, 157/506).
 *
 * These tests pin the DISCOVERY property, not just the delete: the sweep must
 * find foreign rows that sit BEYOND the bound in insertion order. Every one
 * FAILS on the pre-fix candidate query.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('enforce: foreign-jurisdiction purge is not starved by its own bound', () => {
  function makeFjDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, primary_type TEXT, applicant_type TEXT);
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, state TEXT, is_national INTEGER,
        amount_min NUMERIC, amount_max NUMERIC,
        source_url TEXT, application_url TEXT, evidence_url TEXT
      );
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  const addOpp = (db, id, url, title = 'Opportunity') =>
    db.prepare('INSERT INTO funding_opportunities (id, title, source_url) VALUES (?, ?, ?)').run(id, title, url)
  const addMatch = (db, id, pid, oid) =>
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES (?, ?, ?, 13, 'review', 'crawler-os-xmatch')`,
    ).run(id, pid, oid)
  const remaining = (db) =>
    db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => {
    delete process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE
    delete process.env.MATCH_SCOPE_PURGE_LIMIT
  })

  it('finds foreign rows that sit BEYOND the bound in insertion order (the prod bug)', async () => {
    const db = makeFjDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'senior')
      // 60 innocuous US rows FIRST, then the foreign ones — with a bound of 50 the
      // pre-fix query's unordered slice never reaches them.
      for (let i = 0; i < 60; i += 1) {
        addOpp(db, `us-${i}`, `https://example${i}.org/grant`)
        addMatch(db, `m-us-${i}`, 'p1', `us-${i}`)
      }
      addOpp(db, 'ie-1', 'https://www.citizensinformation.ie/en/housing/', 'Housing Adaptation Grant')
      addOpp(db, 'uk-1', 'https://www.gov.uk/disabled-facilities-grants', 'Disabled Facilities Grant')
      addMatch(db, 'm-ie-1', 'p1', 'ie-1')
      addMatch(db, 'm-uk-1', 'p1', 'uk-1')

      process.env.MATCH_SCOPE_PURGE_LIMIT = '50'
      const res = await enforceForeignJurisdictionMatches(db)

      expect(res.repaired).toBe(2)
      expect(res.foreignOpportunities).toBe(2)
      // `scanned` must be the CATALOG candidate count, never the bound.
      expect(res.scanned).toBeLessThan(50)
      const left = remaining(db)
      expect(left).not.toContain('m-ie-1')
      expect(left).not.toContain('m-uk-1')
      expect(left).toHaveLength(60) // every US match survives
    } finally { db.close() }
  })

  it('scales past the bound: 2 500 US matches never hide 3 foreign ones', async () => {
    const db = makeFjDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
      const insOpp = db.prepare('INSERT INTO funding_opportunities (id, title, source_url) VALUES (?, ?, ?)')
      const insM = db.prepare(
        `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
         VALUES (?, 'p1', ?, 13, 'review', 'crawler-os')`,
      )
      db.transaction(() => {
        for (let i = 0; i < 2500; i += 1) {
          insOpp.run(`us-${i}`, 'US Program', `https://example${i}.org/x`)
          insM.run(`m-us-${i}`, `us-${i}`)
        }
        for (const [id, url] of [['ie-9', 'https://www.seai.ie/grants/'], ['za-9', 'https://srd.sassa.gov.za/'], ['hk-9', 'https://www.housingauthority.gov.hk/en/']]) {
          insOpp.run(id, 'Foreign scheme', url)
          insM.run(`m-${id}`, id)
        }
      })()

      const res = await enforceForeignJurisdictionMatches(db) // default bound 2000
      expect(res.repaired).toBe(3)
      expect(db.prepare('SELECT COUNT(*) AS c FROM profile_opportunity_matches').get().c).toBe(2500)
    } finally { db.close() }
  })

  it('CONVERGES: a second run finds nothing (no treadmill)', async () => {
    const db = makeFjDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'senior')
      addOpp(db, 'ie-1', 'https://www.citizensinformation.ie/en/housing/', 'Irish scheme')
      addMatch(db, 'm1', 'p1', 'ie-1')
      expect((await enforceForeignJurisdictionMatches(db)).repaired).toBe(1)
      expect((await enforceForeignJurisdictionMatches(db)).repaired).toBe(0)
      expect((await enforceForeignJurisdictionMatches(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('the SQL prefilter is a SUPERSET — the JS detector still has the final say', async () => {
    const db = makeFjDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'individual')
      // Matches the LIKE list (contains ".in/") but is a US-fronting shortener.
      addOpp(db, 'short-1', 'https://lnkd.in/dC6VRfHD', 'Alaska Fellows Program')
      // Matches ".ie/" only inside a PATH segment on a US host.
      addOpp(db, 'path-1', 'https://www.hud.gov/reports/report.ie/summary', 'HUD report')
      addOpp(db, 'ie-1', 'https://www.citizensinformation.ie/en/housing/', 'Irish scheme')
      addMatch(db, 'm-short', 'p1', 'short-1')
      addMatch(db, 'm-path', 'p1', 'path-1')
      addMatch(db, 'm-ie', 'p1', 'ie-1')

      const res = await enforceForeignJurisdictionMatches(db)
      expect(res.repaired).toBe(1)
      expect(remaining(db)).toEqual(['m-path', 'm-short'])
    } finally { db.close() }
  })

  it('count-only mode reports the TRUE total, not a bound-truncated one', async () => {
    const db = makeFjDb()
    try {
      db.prepare('INSERT INTO profiles (id, primary_type) VALUES (?, ?)').run('p1', 'senior')
      for (let i = 0; i < 5; i += 1) {
        addOpp(db, `ie-${i}`, `https://www.citizensinformation.ie/page${i}/`, 'Irish scheme')
        addMatch(db, `m-${i}`, 'p1', `ie-${i}`)
      }
      process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE = '0'
      const off = await enforceForeignJurisdictionMatches(db)
      expect(off.enforced).toBe(false)
      expect(off.wouldRepair).toBe(5)
      expect(off.foreignOpportunities).toBe(5)
      expect(remaining(db)).toHaveLength(5)
    } finally { db.close() }
  })
})
