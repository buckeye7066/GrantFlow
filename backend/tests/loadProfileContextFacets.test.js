import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { loadProfileContext } from '../services/profileHelpers.js'

/**
 * Regression test for the scoring bug where loadProfileContext returned EMPTY
 * facets ({}) and NULL profileNorm for real profiles. The canonical matcher
 * (scoreOpportunity) reads profileContext.facets directly (facet-intent
 * alignment, ~15 pts of need + eligibility) and profileContext.profileNorm.
 * When both were absent, every opportunity silently lost those points.
 *
 * loadProfileContext must now build a populated `facets` object (via
 * buildProfileFacets) and a `profileNorm` (via normalizeProfile) when sections
 * are available — and degrade gracefully (never throw) on schema drift.
 */

let db

beforeAll(async () => {
  ;({ db } = await getAppAndDb())
}, 60_000)

beforeEach(() => {
  resetDb(db)
})

function seedProfileWithSections(overrides = {}) {
  const userId = 'u-fac-' + Math.random().toString(36).slice(2, 10)
  db.prepare(
    `INSERT INTO users (id, primary_email, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(userId, `${userId}@test.local`)

  const profileId = 'p-fac-' + Math.random().toString(36).slice(2, 10)
  db.prepare(
    `INSERT INTO profiles (id, user_id, display_name, primary_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(
    profileId,
    userId,
    overrides.display_name || 'Demo Student',
    overrides.primary_type || 'student',
  )

  const sections = overrides.sections || {
    basic_information: { state: 'TN', zip: '38501', city: 'Cookeville', profile_category: 'student' },
    education: { highest_level: 'high school', intended_major: 'nursing', gpa: 3.6, act_score: 28 },
    financial_information: { financial_need_level: 'high', is_low_income: true },
  }
  for (const [key, data] of Object.entries(sections)) {
    db.prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run('ps-' + Math.random().toString(36).slice(2, 10), profileId, key, JSON.stringify(data))
  }
  return profileId
}

describe('loadProfileContext populates facets + profileNorm', () => {
  it('returns a non-empty facet object with real facet keys for a profile with sections', async () => {
    const profileId = seedProfileWithSections()
    const ctx = await loadProfileContext(db, profileId)

    expect(ctx).toBeTruthy()
    expect(ctx.facets && typeof ctx.facets === 'object').toBe(true)

    const facetKeys = Object.keys(ctx.facets)
    expect(facetKeys.length).toBeGreaterThan(0)
    // Canonical facet groups the matcher reads from.
    expect(facetKeys).toEqual(expect.arrayContaining(['profile', 'geo', 'intent']))

    // The matcher reads facet-intent alignment; intent must resolve, not stay unknown.
    expect(ctx.facets.intent?.primary_need_category).toBeTruthy()
    expect(ctx.facets.intent.primary_need_category).not.toBe('unknown')

    // Geo facet should be derived from sections (state/zip) so geo gating works.
    expect(ctx.facets.geo?.state).toBe('TN')
  })

  it('returns a normalized profileNorm (not null) for a profile with sections', async () => {
    const profileId = seedProfileWithSections()
    const ctx = await loadProfileContext(db, profileId)

    expect(ctx.profileNorm).toBeTruthy()
    expect(ctx.profileNorm.entityType).toBeTruthy()
    // Student sections must surface in the normalized profile for eligibility scoring.
    expect(ctx.profileNorm.isStudent).toBe(true)
    expect(Array.isArray(ctx.profileNorm.needCategories)).toBe(true)
  })

  it('degrades to empty facets without throwing when a profile has no sections', async () => {
    const userId = 'u-bare-' + Math.random().toString(36).slice(2, 10)
    db.prepare(
      `INSERT INTO users (id, primary_email, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(userId, `${userId}@test.local`)
    const profileId = 'p-bare-' + Math.random().toString(36).slice(2, 10)
    db.prepare(
      `INSERT INTO profiles (id, user_id, display_name, primary_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(profileId, userId, 'Bare Profile', 'individual')

    const ctx = await loadProfileContext(db, profileId)
    expect(ctx.facets && typeof ctx.facets === 'object').toBe(true)
    // No throw is the contract; facet object exists even when sections are empty.
    expect(Object.keys(ctx.facets)).toEqual(expect.arrayContaining(['profile', 'geo', 'intent']))
  })
})
