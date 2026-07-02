/**
 * Regression: GET /api/profiles/:id/sections must return a real JSON ARRAY.
 *
 * The Object-keyed shape ('0'..'N' instead of []) was observed in prod when the
 * rows reached res.json() as a non-array (e.g. a { rows } driver shape spread
 * into an object). coerceDbRows + this contract test lock the array shape in —
 * every frontend consumer (ProfileGapGate, client.profileSectionsClient().list())
 * iterates it as an array.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

describe('GET /api/profiles/:id/sections response shape', () => {
  let app
  let db

  beforeAll(async () => {
    ;({ app, db } = await getAppAndDb())
  })

  beforeEach(() => {
    resetDb(db)
    db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('prof-sect-1', 'Sections Shape', 'active')`).run()
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('prof-sect-1', 'basic_information', ?, 'tester')`)
      .run(JSON.stringify({ full_name: 'Array Shape' }))
    db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES ('prof-sect-1', 'location_focus', ?, 'tester')`)
      .run(JSON.stringify({ state: 'TN' }))
  })

  it('returns a JSON array (never an object keyed 0..N) with the documented row shape', async () => {
    const res = await request(app)
      .get('/api/profiles/prof-sect-1/sections')
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(2)
    // Raw body must serialize as an array literal, not {"0":...}
    expect(res.text.trim().startsWith('[')).toBe(true)

    const keys = res.body.map((s) => s.section_key)
    expect(keys).toEqual(['basic_information', 'location_focus'])
    for (const section of res.body) {
      expect(section).toHaveProperty('section_key')
      expect(section).toHaveProperty('data')
      expect(section).toHaveProperty('updated_at')
      expect(section).toHaveProperty('updated_by')
      expect(typeof section.data).toBe('object')
    }
  })

  it('returns an EMPTY array for a profile with no sections', async () => {
    db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('prof-sect-2', 'No Sections', 'active')`).run()
    const res = await request(app)
      .get('/api/profiles/prof-sect-2/sections')
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBe(0)
    expect(res.text.trim()).toBe('[]')
  })
})
