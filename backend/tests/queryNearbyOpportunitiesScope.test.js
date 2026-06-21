/**
 * Profile-isolation guard for queryNearbyOpportunities (realCrawlers.js).
 *
 * funding_opportunities is a SHARED table: rows are either global catalog
 * (profile_id IS NULL) or tagged to the profile whose crawl produced them.
 * The "near you" merge in the live /api/real-crawlers path historically read
 * the table filtered only by state/national, so another profile's crawl
 * output leaked into this profile's discovery results ("funding sources from
 * a previous search"). These tests pin the scope so that regression cannot
 * silently return: a profile must see global rows + its OWN rows, never
 * another profile's rows.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { queryNearbyOpportunities } from '../routes/realCrawlers.js'

function seed(db) {
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      description TEXT,
      sponsor TEXT,
      source TEXT,
      source_url TEXT,
      application_url TEXT,
      apply_url TEXT,
      state TEXT,
      is_national INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      opportunity_type TEXT,
      type TEXT,
      deadline_type TEXT,
      amount_max TEXT,
      contact_info TEXT,
      categories TEXT,
      keywords TEXT,
      match_reasons TEXT,
      funding_type TEXT,
      record_origin TEXT,
      requires_match INTEGER DEFAULT 0,
      match_percentage TEXT,
      is_loan INTEGER DEFAULT 0,
      funding_category TEXT,
      usable_for_housing INTEGER,
      refund_potential TEXT,
      eligibility_signals TEXT,
      verification_status TEXT,
      last_verified_at TEXT
    );
  `)
  const insert = db.prepare(`
    INSERT INTO funding_opportunities
      (id, profile_id, title, state, is_national, is_active, record_origin, source, application_url)
    VALUES (@id, @profile_id, @title, @state, @is_national, 1, 'geo_crawl', 'discovered', @application_url)
  `)
  insert.run({ id: 'global-1', profile_id: null, title: 'Global Catalog Grant', state: 'TN', is_national: 0, application_url: 'https://example.org/global' })
  insert.run({ id: 'mine-1', profile_id: 'profile-A', title: 'My Own Crawl Result', state: 'TN', is_national: 0, application_url: 'https://example.org/mine' })
  insert.run({ id: 'other-1', profile_id: 'profile-B', title: 'Other Profile Crawl Result', state: 'TN', is_national: 0, application_url: 'https://example.org/other' })
  insert.run({ id: 'other-natl', profile_id: 'profile-B', title: 'Other Profile National Result', state: null, is_national: 1, application_url: 'https://example.org/other-natl' })
}

const analysisTN = { location: { state: 'TN' } }

describe('queryNearbyOpportunities profile isolation', () => {
  it('returns global rows + this profile, never another profile (including national)', async () => {
    const db = new Database(':memory:')
    seed(db)
    const ctx = { profile_id: 'profile-A', profile: { id: 'profile-A' } }
    const rows = await queryNearbyOpportunities(db, analysisTN, [], ctx, 50)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('global-1') // shared catalog is always visible
    expect(ids).toContain('mine-1') // this profile's own crawl results
    expect(ids).not.toContain('other-1') // another profile's crawl must not leak
    expect(ids).not.toContain('other-natl') // not even via the national scope
  })

  it('falls back to global-only when no profile id is resolvable (never leaks)', async () => {
    const db = new Database(':memory:')
    seed(db)
    const rows = await queryNearbyOpportunities(db, analysisTN, [], null, 50)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('global-1')
    expect(ids).not.toContain('mine-1')
    expect(ids).not.toContain('other-1')
    expect(ids).not.toContain('other-natl')
  })
})
