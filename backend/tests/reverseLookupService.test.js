/**
 * Reverse-lookup ("Funders Like You") must return catalog funders even when
 * ProPublica is unavailable, and must not use invalid wildcard queries.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { findSimilarOrgsFunders } from '../services/reverseLookupService.js'
import { seedNationalPrograms } from '../services/seed/seedNationalPrograms.js'

const JOHN_WHITE = {
  id: 'profile-john-white-funders',
  display_name: 'Dr. John White',
  primary_type: 'individual',
  status: 'active',
  tags: ['healthcare professional', 'educator', 'food security', 'community advocate'],
  sections: {
    basic_information: {
      full_name: 'John White',
      address: '3940 Eveningside Dr. NE\nCleveland, TN 37312',
    },
    narrative: {
      mission: 'Address food insecurity and health disparities in Bradley County.',
      primary_goal: 'Expand community nutrition and health education programs.',
    },
    demographics: { disability_status: 'Has disability' },
  },
}

vi.mock('../src/integrations/propublica990.js', () => ({
  searchOrganizations: vi.fn(async () => ({ total_results: 0, organizations: [] })),
  getOrganization: vi.fn(),
}))

function seedJohn(db) {
  db.prepare(
    'INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?,?,?,?,?)',
  ).run(
    JOHN_WHITE.id,
    JOHN_WHITE.display_name,
    JOHN_WHITE.primary_type,
    JOHN_WHITE.status,
    JSON.stringify(JOHN_WHITE.tags),
  )
  for (const [sectionKey, data] of Object.entries(JOHN_WHITE.sections)) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?,?,?)').run(
      JOHN_WHITE.id,
      sectionKey,
      JSON.stringify(data),
    )
  }
  db.prepare(
    `INSERT INTO funding_opportunities (
      id, title, sponsor, description, source_url, application_url, state, categories, keywords, is_active, is_national, record_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'curated_verified')`,
  ).run(
    'tn-community-foundation-test',
    'Community Foundation of Greater Chattanooga Grants',
    'Community Foundation of Greater Chattanooga',
    'Private foundation funding human services, health, and food security in Southeast Tennessee.',
    'https://cfgc.org/grants/',
    'https://cfgc.org/grants/',
    'TN',
    JSON.stringify(['foundation_grants', 'health', 'food']),
    JSON.stringify(['foundation', 'grantmaker', 'health', 'food', 'human services']),
  )
}

describe('reverseLookupService', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 120_000)

  beforeEach(async () => {
    resetDb(db)
    seedJohn(db)
    await seedNationalPrograms(db, { skipUrlVerification: true })
  })

  // This case does ~11-13s of real DB work and reliably exceeds vitest's 5s
  // default testTimeout under full-suite load (it passes in isolation). Give it
  // an explicit generous timeout so the gate is deterministic.
  it('returns local catalog funders when ProPublica returns no rows', async () => {
    const result = await findSimilarOrgsFunders(db, JOHN_WHITE.id, { maxResults: 10 })
    expect(result.suggested_funders.length).toBeGreaterThan(0)
    expect(result.suggested_funders.some((f) => /Community Foundation/i.test(f.name))).toBe(true)
    expect(result.ntee_codes_used.length).toBeGreaterThan(0)
  }, 30000)
})
