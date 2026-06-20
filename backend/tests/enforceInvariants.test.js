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
 *      sweep, no matter how it was re-inserted.
 *   2. No cross-profile / cross-tenant bleed — a grant whose organization_id
 *      disagrees with its profile's organization_id is re-aligned, and a
 *      tombstone in one profile NEVER deletes another profile's grant.
 *   3. Relevance floor — below-floor discovery grants are detected (and
 *      purged when ENFORCE_RELEVANCE_FLOOR=1), while NULL scores and
 *      user-progressed (protected-status) grants are never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'crypto'
import {
  runEnforceInvariants,
  enforceStickyDeletes,
  enforceNoCrossProfileBleed,
  enforceRelevanceFloor,
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
    `INSERT INTO grants (id, organization_id, profile_id, funding_opportunity_id, title, funder, status, match_score, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    g.organization_id ?? null,
    g.profile_id ?? null,
    g.funding_opportunity_id ?? null,
    g.title ?? 'Grant',
    g.funder ?? null,
    g.status ?? 'discovered',
    g.match_score ?? null,
    g.fingerprint ?? null,
  )
  return id
}

function count(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n)
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

describe('enforceInvariants — relevance floor', () => {
  beforeEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
  })
  afterEach(() => {
    delete process.env.ENFORCE_RELEVANCE_FLOOR
  })

  it('counts below-floor discovery grants but does NOT delete when enforcement is off (default)', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: RELEVANCE_FLOOR - 1 })

    const res = await enforceRelevanceFloor(db)
    expect(res.ok).toBe(true)
    expect(res.enforced).toBe(false)
    expect(res.scanned).toBe(1)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(1)
  })

  it('purges below-floor discovery grants when ENFORCE_RELEVANCE_FLOOR=1', async () => {
    process.env.ENFORCE_RELEVANCE_FLOOR = '1'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Junk', match_score: RELEVANCE_FLOOR - 1 })

    const res = await enforceRelevanceFloor(db)
    expect(res.enforced).toBe(true)
    expect(res.repaired).toBe(1)
    expect(count(db)).toBe(0)
  })

  it('never touches NULL match_score (no score is not junk; G4)', async () => {
    process.env.ENFORCE_RELEVANCE_FLOOR = '1'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Manual', match_score: null })

    await enforceRelevanceFloor(db)
    expect(count(db)).toBe(1)
  })

  it('never touches user-progressed grants even below the floor (protected status)', async () => {
    process.env.ENFORCE_RELEVANCE_FLOOR = '1'
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    for (const status of ['submitted', 'awarded', 'pending_review', 'drafting']) {
      insertGrant(db, {
        profile_id: 'p1',
        organization_id: 'org1',
        title: `Working ${status}`,
        match_score: 1,
        status,
      })
    }
    expect(PROTECTED_PIPELINE_STATUSES).toContain('submitted')

    const res = await enforceRelevanceFloor(db)
    expect(res.repaired).toBe(0)
    expect(count(db)).toBe(4)
  })
})

describe('enforceInvariants — runner', () => {
  it('runs every invariant, never throws, and returns a structured summary', async () => {
    const db = makeDb()
    insertProfile(db, { id: 'p1', orgId: 'org1' })
    insertGrant(db, { profile_id: 'p1', organization_id: 'org1', title: 'Clean', match_score: 90 })

    const summary = await runEnforceInvariants(db, { logger: { info() {}, warn() {} } })
    expect(summary.ran).toBe(3)
    expect(summary.failed).toBe(0)
    expect(summary.steps.map((s) => s.name)).toEqual([
      'sticky_deletes',
      'no_cross_profile_bleed',
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
