/**
 * pipelineGoalCleanupProfileScope.test.js
 *
 * GUARD: `auditPipelinesAgainstGoals` may never classify — let alone DELETE —
 * a grant that belongs to a DIFFERENT profile.
 *
 * The candidate query used to be
 *   `WHERE g.profile_id = ? OR (g.organization_id IS NOT NULL AND g.organization_id = ?)`
 * so every profile sharing an organization loaded every org-mate's grants and
 * judged them against its OWN sections/state/seenTitles. In non-dry-run mode
 * (`POST /api/admin/clean-pipelines-against-goals` with `dry_run:false`) the
 * loop then ran `DELETE FROM grants WHERE id = ?` on the loser — so two
 * org-mates holding the same real program was enough for the first profile's
 * pass to delete the SECOND profile's row as a `duplicate_title`.
 *
 * These tests FAIL on the pre-fix predicate and pass on
 * `profile_id = ? OR (profile_id IS NULL AND organization_id = ?)`.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { auditPipelinesAgainstGoals } from '../services/pipelineGoalCleanupService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT,
      organization_id TEXT,
      tags TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      source TEXT,
      application_url TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      title TEXT,
      funder TEXT,
      notes TEXT,
      status TEXT,
      deadline TEXT,
      created_at TEXT,
      application_url TEXT,
      url TEXT,
      portal_url TEXT,
      profile_id TEXT,
      organization_id TEXT,
      funding_opportunity_id TEXT
    );
  `)
  return db
}

function addProfile(db, id, orgId, state) {
  db.prepare(
    'INSERT INTO profiles (id, display_name, primary_type, organization_id, tags) VALUES (?, ?, ?, ?, ?)',
  ).run(id, id, 'individual', orgId, '[]')
  db.prepare(
    'INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)',
  ).run(id, 'basic_information', JSON.stringify({ state }))
}

function addGrant(db, { id, title, profileId, orgId, createdAt }) {
  db.prepare(
    `INSERT INTO grants (id, title, funder, status, created_at, application_url, profile_id, organization_id)
     VALUES (?, ?, ?, 'interested', ?, 'https://example.org/apply', ?, ?)`,
  ).run(id, title, 'Example Foundation', createdAt, profileId, orgId)
}

describe('auditPipelinesAgainstGoals — profile scope', () => {
  it('never loads or deletes another profile\'s grant just because they share an organization', async () => {
    const db = makeDb()
    addProfile(db, 'p1', 'org1', 'TN')
    addProfile(db, 'p2', 'org1', 'TN')
    // Same title in two DIFFERENT profiles' pipelines. Both are real, both
    // must survive: the dedupe rule is scoped to ONE profile's pipeline.
    addGrant(db, { id: 'g1', title: 'Example Grant', profileId: 'p1', orgId: 'org1', createdAt: '2026-01-01T00:00:00.000Z' })
    addGrant(db, { id: 'g2', title: 'Example Grant', profileId: 'p2', orgId: 'org1', createdAt: '2026-01-02T00:00:00.000Z' })

    const report = await auditPipelinesAgainstGoals(db, { dryRun: false })

    // p1's pass must only ever see its OWN row.
    const p1 = report.per_profile.find((r) => r.profile_id === 'p1')
    const p2 = report.per_profile.find((r) => r.profile_id === 'p2')
    expect(p1.total).toBe(1)
    expect(p2.total).toBe(1)
    expect(report.removed).toBe(0)

    // The decisive assertion: BOTH rows still exist in the database.
    const survivors = db.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)
    expect(survivors).toEqual(['g1', 'g2'])
  })

  it('does not judge an org-mate\'s grant against the wrong profile\'s state', async () => {
    const db = makeDb()
    addProfile(db, 'tn', 'org1', 'TN')
    addProfile(db, 'oh', 'org1', 'OH')
    // A legitimate Ohio grant in the OHIO profile's pipeline. Under the old
    // predicate the TN profile's pass loaded it and removed it as wrong_state.
    addGrant(db, { id: 'g-oh', title: 'Ohio Family and Children First Grant', profileId: 'oh', orgId: 'org1', createdAt: '2026-01-01T00:00:00.000Z' })

    const report = await auditPipelinesAgainstGoals(db, { dryRun: false })

    const tn = report.per_profile.find((r) => r.profile_id === 'tn')
    expect(tn).toBeUndefined() // TN has no pipeline of its own
    expect(db.prepare('SELECT id FROM grants').all().map((r) => r.id)).toEqual(['g-oh'])
  })

  it('still reaches an ORG-LEVEL ORPHAN grant (profile_id IS NULL) — the reason the org branch exists', async () => {
    const db = makeDb()
    addProfile(db, 'p1', 'org1', 'TN')
    addGrant(db, { id: 'orphan', title: 'Org Level Grant', profileId: null, orgId: 'org1', createdAt: '2026-01-01T00:00:00.000Z' })

    const report = await auditPipelinesAgainstGoals(db, { dryRun: true })

    const p1 = report.per_profile.find((r) => r.profile_id === 'p1')
    expect(p1).toBeDefined()
    expect(p1.total).toBe(1)
  })
})
