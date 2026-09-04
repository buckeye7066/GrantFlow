import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadVnextGuidanceByOpportunity,
  VNEXT_GUIDANCE_QUERY_CHUNK_SIZE,
} from '../services/matching/vnextApplicationGuidance.js'

let sqlite = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('profile-scoped vNext application guidance loading', () => {
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

