/**
 * Tests for sweepProfilePipelineApplicantType — the cleanup that removes
 * applicant-type-ineligible rows already sitting in a profile's pipeline.
 *
 * Verifies: an institution-only federal grant is removed from a graduate
 * student's pipeline, while a legitimate individual scholarship and a directory
 * resource are kept (directories must always survive; demographic/field
 * mismatches are not swept). Dry-run reports without deleting.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { sweepProfilePipelineApplicantType } = await import('../services/pipelineEligibilitySweep.js')

const PROFILE_ID = 'sweep-profile-1'

function seed() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, applicant_type TEXT, primary_type TEXT, status TEXT, created_at DATETIME);
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, description TEXT, eligibility TEXT,
      eligibility_bullets TEXT, applicant_types TEXT, eligible_applicants TEXT,
      eligibility_types TEXT, opportunity_kind TEXT, type TEXT, opportunity_type TEXT,
      source TEXT, source_url TEXT, is_directory_resource INTEGER
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, funder TEXT, deadline TEXT,
      application_url TEXT, funding_opportunity_id TEXT, fingerprint TEXT, status TEXT
    );
  `)
  sqlite.prepare('INSERT INTO profiles (id, primary_type, status) VALUES (?, ?, ?)')
    .run(PROFILE_ID, 'graduate_student', 'active')

  const fo = sqlite.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, is_directory_resource) VALUES (?, ?, ?, ?)')
  fo.run('fo-inst', 'OSEP Personnel Preparation of Special Education Personnel', 'GRANT', 0)
  fo.run('fo-legit', 'Coca-Cola Scholars', 'SCHOLARSHIP', 0)
  fo.run('fo-dir', 'Niche Scholarships', 'DIRECTORY', 1)

  const g = sqlite.prepare('INSERT INTO grants (id, profile_id, title, funding_opportunity_id, status) VALUES (?, ?, ?, ?, ?)')
  g.run('g-inst', PROFILE_ID, 'OSEP Personnel Preparation of Special Education Personnel', 'fo-inst', 'discovered')
  g.run('g-legit', PROFILE_ID, 'Coca-Cola Scholars', 'fo-legit', 'discovered')
  g.run('g-dir', PROFILE_ID, 'Niche Scholarships', 'fo-dir', 'discovered')
  return { sqlite, db: wrapSqlite(sqlite) }
}

describe('sweepProfilePipelineApplicantType', () => {
  let sqlite
  let db
  beforeEach(() => { ({ sqlite, db } = seed()) })

  it('removes the institution-only grant, keeps the scholarship and the directory', async () => {
    const res = await sweepProfilePipelineApplicantType(db, PROFILE_ID, { apply: true })
    expect(res.applicantType).toBe('graduate_student')
    expect(res.flagged.map((f) => f.grant_id)).toEqual(['g-inst'])
    expect(res.removed).toBe(1)

    const remaining = sqlite.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)
    expect(remaining).toEqual(['g-dir', 'g-legit'])
  })

  it('dry run reports the ineligible row without deleting anything', async () => {
    const res = await sweepProfilePipelineApplicantType(db, PROFILE_ID, { apply: false })
    expect(res.flagged.map((f) => f.grant_id)).toEqual(['g-inst'])
    expect(res.removed).toBe(0)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM grants').get().n).toBe(3)
  })
})
