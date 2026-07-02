/**
 * Per-profile discovery min-match-score preference — the truthful wiring for
 * the product's only min-score slider (previously persisted into a dead legacy
 * Base44 entity nothing read).
 *
 *   - stored on the automation_preferences profile section (discovery sub-key),
 *     preserving portal_access / automations;
 *   - GET/PUT /api/profiles/:id/discovery-preferences round-trips it;
 *   - run-smart resolves: explicit request min > stored preference > DEFAULT_MIN_SCORE.
 *
 * Canonical guardrail: DEFAULT_MIN_SCORE (display floor >= 75) is never
 * lowered — a stored preference feeds the sanctioned EXPLICIT-min path.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import Database from 'better-sqlite3'
import {
  normalizeMinMatchScore,
  getDiscoveryPreferences,
  saveDiscoveryMinMatchScore,
  resolveRunSmartMinScore,
} from '../services/discoveryPreferences.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
  return db
}

describe('discoveryPreferences service', () => {
  it('normalizes/clamps scores and rejects garbage', () => {
    expect(normalizeMinMatchScore(60)).toBe(60)
    expect(normalizeMinMatchScore('72')).toBe(72)
    expect(normalizeMinMatchScore(150)).toBe(100)
    expect(normalizeMinMatchScore(-5)).toBe(0)
    expect(normalizeMinMatchScore('abc')).toBe(null)
    expect(normalizeMinMatchScore(null)).toBe(null)
    expect(normalizeMinMatchScore(undefined)).toBe(null)
  })

  it('round-trips a preference and preserves sibling automation_preferences keys', async () => {
    const db = createDb()
    try {
      db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p1', 'automation_preferences', ?)`)
        .run(JSON.stringify({ portal_access: { enabled: true }, automations: { hamilton_autopilot: false } }))

      await saveDiscoveryMinMatchScore(db, 'p1', 60, 'tester')
      expect((await getDiscoveryPreferences(db, 'p1')).min_match_score).toBe(60)

      const blob = JSON.parse(db.prepare(`SELECT data FROM profile_sections WHERE profile_id = 'p1'`).get().data)
      expect(blob.portal_access).toEqual({ enabled: true })
      expect(blob.automations).toEqual({ hamilton_autopilot: false })
      expect(blob.discovery.min_match_score).toBe(60)
    } finally { db.close() }
  })

  it('creates the section when absent and clears on null', async () => {
    const db = createDb()
    try {
      await saveDiscoveryMinMatchScore(db, 'p2', 85, null)
      expect((await getDiscoveryPreferences(db, 'p2')).min_match_score).toBe(85)
      await saveDiscoveryMinMatchScore(db, 'p2', null, null)
      expect((await getDiscoveryPreferences(db, 'p2')).min_match_score).toBe(null)
    } finally { db.close() }
  })

  describe('resolveRunSmartMinScore precedence', () => {
    it('explicit request min always wins (including below-75 values)', async () => {
      const db = createDb()
      try {
        await saveDiscoveryMinMatchScore(db, 'p3', 90, null)
        expect(await resolveRunSmartMinScore(db, 'p3', 40)).toBe(40)
        expect(await resolveRunSmartMinScore(db, 'p3', '65')).toBe(65)
      } finally { db.close() }
    })

    it('uses the stored preference when the request has none (legacy 0/NaN never counted as explicit)', async () => {
      const db = createDb()
      try {
        await saveDiscoveryMinMatchScore(db, 'p4', 60, null)
        expect(await resolveRunSmartMinScore(db, 'p4', undefined)).toBe(60)
        expect(await resolveRunSmartMinScore(db, 'p4', null)).toBe(60)
        expect(await resolveRunSmartMinScore(db, 'p4', 0)).toBe(60)
        expect(await resolveRunSmartMinScore(db, 'p4', 'not-a-number')).toBe(60)
      } finally { db.close() }
    })

    it('falls back to DEFAULT_MIN_SCORE with no request min and no stored preference', async () => {
      const db = createDb()
      try {
        expect(await resolveRunSmartMinScore(db, 'p5', undefined)).toBe(DEFAULT_MIN_SCORE)
        // A stored 0 means "no usable floor preference" — never a 0 floor.
        await saveDiscoveryMinMatchScore(db, 'p5', 0, null)
        expect(await resolveRunSmartMinScore(db, 'p5', undefined)).toBe(DEFAULT_MIN_SCORE)
      } finally { db.close() }
    })

    it('never lowers the DISPLAY floor constant itself', () => {
      expect(DEFAULT_MIN_SCORE).toBeGreaterThanOrEqual(75)
    })
  })
})

describe('GET/PUT /api/profiles/:id/discovery-preferences', () => {
  let app
  let db

  beforeAll(async () => {
    ;({ app, db } = await getAppAndDb())
  })

  beforeEach(() => {
    resetDb(db)
    db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('prof-disc-1', 'Disc Prefs', 'active')`).run()
  })

  it('defaults to null (no stored preference), round-trips a PUT, and clears on null', async () => {
    const initial = await request(app)
      .get('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(initial.status).toBe(200)
    expect(initial.body.discovery.min_match_score).toBe(null)

    const put = await request(app)
      .put('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ min_match_score: 60 })
    expect(put.status).toBe(200)
    expect(put.body.discovery.min_match_score).toBe(60)

    const after = await request(app)
      .get('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(after.body.discovery.min_match_score).toBe(60)

    const cleared = await request(app)
      .put('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ min_match_score: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.discovery.min_match_score).toBe(null)
  })

  it('rejects a non-numeric score with 400', async () => {
    const res = await request(app)
      .put('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ min_match_score: 'high' })
    expect(res.status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await request(app).get('/api/profiles/prof-disc-1/discovery-preferences')
    expect(res.status).toBe(401)
  })
})
