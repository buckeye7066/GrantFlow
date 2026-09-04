import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeFeatureFlags } from '../services/featureFlagService.js'
import {
  loadVnextGuidanceByOpportunity,
  VNEXT_GUIDANCE_QUERY_CHUNK_SIZE,
} from '../services/matching/vnextApplicationGuidance.js'
import { deduplicateOpportunities } from '../services/opportunityMatcher.js'

let sqlite = null
const originalShouldersVnext = process.env.SHOULDERS_VNEXT

beforeEach(() => {
  process.env.SHOULDERS_VNEXT = 'true'
})

afterEach(() => {
  sqlite?.close()
  sqlite = null
  if (originalShouldersVnext === undefined) delete process.env.SHOULDERS_VNEXT
  else process.env.SHOULDERS_VNEXT = originalShouldersVnext
})

describe('profile-scoped vNext application guidance loading', () => {
  it('does not query or publish persisted guidance while the vNext gate is disabled', async () => {
    delete process.env.SHOULDERS_VNEXT
    const db = { dialect: 'postgres', prepare: vi.fn() }
    initializeFeatureFlags(db)

    await expect(
      loadVnextGuidanceByOpportunity(db, 'profile-1', ['opp-1'], {
        userId: 'user-1',
      }),
    ).resolves.toEqual(new Map())
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns only the requested profile application for a shared opportunity', async () => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE vnext_applications (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        state TEXT NOT NULL,
        stage TEXT NOT NULL,
        UNIQUE(profile_id, opportunity_id)
      );
      INSERT INTO vnext_applications (id, profile_id, opportunity_id, state, stage) VALUES
        ('app-p1', 'profile-1', 'opp-shared', 'DEDUPED', 'DEDUPED'),
        ('app-p2', 'profile-2', 'opp-shared', 'MAPPED', 'MAPPED');
    `)

    const applications = await loadVnextGuidanceByOpportunity(
      sqlite,
      'profile-1',
      ['opp-shared'],
    )

    expect(applications.get('opp-shared')).toEqual({
      vnext_application_id: 'app-p1',
      vnext_application_state: 'DEDUPED',
      vnext_application_stage: 'DEDUPED',
    })
  })

  it('keeps profile application guidance when a higher-trust duplicate wins', () => {
    const applicationBearing = {
      id: 'catalog-low-trust',
      title: 'Community Health Grant',
      state: 'TN',
      application_url: 'https://example.org/apply',
      fingerprint: 'canonical-grant-1',
      vnext_application_id: 'app-1',
      vnext_application_state: 'DEDUPED',
      vnext_application_stage: 'DEDUPED',
      next_steps: [{ id: 'qualify_application', category: 'application' }],
    }
    const higherTrustDuplicate = {
      id: 'catalog-official',
      title: 'Community Health Grant',
      state: 'TN',
      application_url: 'https://agency.gov/apply',
      fingerprint: 'canonical-grant-1',
      next_steps: [{ id: 'save_to_pipeline', category: 'application' }],
    }

    expect(deduplicateOpportunities([
      applicationBearing,
      higherTrustDuplicate,
    ])).toEqual([
      expect.objectContaining({
        id: 'catalog-official',
        vnext_application_id: 'app-1',
        vnext_application_state: 'DEDUPED',
        next_steps: [{ id: 'qualify_application', category: 'application' }],
      }),
    ])
  })

  it('does not move application guidance onto a similarly titled different-funder row', () => {
    const applicationBearing = {
      id: 'foundation-a-row',
      title: 'Community Support Grant',
      sponsor: 'Foundation A',
      state: 'TN',
      application_url: 'https://foundation-a.org/apply',
      opportunity_fingerprint: 'shared-scoring-shape',
      vnext_application_id: 'app-foundation-a',
      vnext_application_state: 'MAPPED',
      vnext_application_stage: 'MAPPED',
      next_steps: [{ id: 'resolve_missing', category: 'application' }],
    }
    const superficiallySimilar = {
      id: 'foundation-b-row',
      title: 'Community Support Grant',
      sponsor: 'Foundation B',
      state: 'TN',
      application_url: 'https://foundation-b.gov/apply',
      opportunity_fingerprint: 'shared-scoring-shape',
      next_steps: [{ id: 'save_to_pipeline', category: 'application' }],
    }

    expect(deduplicateOpportunities([
      applicationBearing,
      superficiallySimilar,
    ])).toEqual([
      expect.objectContaining({
        id: 'foundation-a-row',
        vnext_application_id: 'app-foundation-a',
        next_steps: [{ id: 'resolve_missing', category: 'application' }],
      }),
    ])
  })

  it('keeps both application rows when loose display similarity lacks canonical identity', () => {
    const foundationA = {
      id: 'foundation-a-row',
      title: 'Community Support Grant',
      sponsor: 'Foundation A',
      state: 'TN',
      application_url: 'https://foundation-a.org/apply',
      vnext_application_id: 'app-foundation-a',
      vnext_application_state: 'QUALIFIED',
    }
    const foundationB = {
      id: 'foundation-b-row',
      title: 'Community Support Grant',
      sponsor: 'Foundation B',
      state: 'TN',
      application_url: 'https://foundation-b.gov/apply',
      vnext_application_id: 'app-foundation-b',
      vnext_application_state: 'MAPPED',
    }

    expect(deduplicateOpportunities([foundationA, foundationB])).toEqual([
      expect.objectContaining({
        id: 'foundation-a-row',
        vnext_application_id: 'app-foundation-a',
      }),
      expect.objectContaining({
        id: 'foundation-b-row',
        vnext_application_id: 'app-foundation-b',
      }),
    ])
  })

  it('deduplicates and chunks large result sets below legacy SQLite bind limits', async () => {
    const calls = []
    const db = {
      prepare: vi.fn((sql) => ({
        all: vi.fn((...args) => {
          calls.push({ sql, args })
          return []
        }),
      })),
    }
    const ids = Array.from(
      { length: VNEXT_GUIDANCE_QUERY_CHUNK_SIZE * 2 + 1 },
      (_, index) => `opp-${index}`,
    )

    await loadVnextGuidanceByOpportunity(db, 'profile-1', [...ids, ids[0], ''])

    expect(calls).toHaveLength(3)
    expect(calls.every(({ sql }) => /WHERE profile_id = \? AND opportunity_id IN/.test(sql))).toBe(true)
    expect(calls.every(({ args }) => args[0] === 'profile-1')).toBe(true)
    expect(Math.max(...calls.map(({ args }) => args.length))).toBeLessThanOrEqual(
      VNEXT_GUIDANCE_QUERY_CHUNK_SIZE + 1,
    )
    expect(calls.flatMap(({ args }) => args.slice(1))).toEqual(ids)
  })

  it('degrades only when the vNext table is absent and keeps unrelated failures loud', async () => {
    sqlite = new Database(':memory:')
    await expect(
      loadVnextGuidanceByOpportunity(sqlite, 'profile-1', ['opp-1']),
    ).resolves.toEqual(new Map())

    const unavailable = {
      prepare() {
        return {
          all() {
            const error = new Error('database connection lost')
            error.code = 'ECONNRESET'
            throw error
          },
        }
      },
    }
    await expect(
      loadVnextGuidanceByOpportunity(unavailable, 'profile-1', ['opp-1']),
    ).rejects.toThrow('database connection lost')
  })
})
