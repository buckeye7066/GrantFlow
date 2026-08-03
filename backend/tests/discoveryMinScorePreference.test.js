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
 * Canonical guardrail: DEFAULT_MIN_SCORE (display floor = the engine REVIEW
 * bar, REVIEW_SCORE = 7 on the data-point scale, per the 2026-08-03 recall
 * directive) is the default — a stored preference feeds the sanctioned
 * EXPLICIT-min path, and an owner may TIGHTEN via the slider.
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
import {
  DEFAULT_MIN_SCORE,
  DISCOVERY_MIN_SCORE_FLOOR,
  REVIEW_SCORE,
  GOOD_MATCH_SCORE,
  STRONG_MATCH_SCORE,
  MIN_SCORE_SLIDER_MAX,
  translateLegacyMinScore,
} from '../config/matchThresholds.js'
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
  it('normalizes/clamps scores and rejects garbage (data-point scale)', () => {
    expect(normalizeMinMatchScore(12)).toBe(12)
    expect(normalizeMinMatchScore('23')).toBe(23)
    expect(normalizeMinMatchScore(MIN_SCORE_SLIDER_MAX)).toBe(MIN_SCORE_SLIDER_MAX)
    expect(normalizeMinMatchScore(-5)).toBe(0)
    expect(normalizeMinMatchScore('abc')).toBe(null)
    expect(normalizeMinMatchScore(null)).toBe(null)
    expect(normalizeMinMatchScore(undefined)).toBe(null)
  })

  it('translates retired-scale (>30) values to their data-point band', () => {
    // The mapping itself (the owner's stuck "85" = the dead-slider class).
    expect(normalizeMinMatchScore(85)).toBe(STRONG_MATCH_SCORE)
    expect(normalizeMinMatchScore(75)).toBe(STRONG_MATCH_SCORE)
    expect(normalizeMinMatchScore(60)).toBe(GOOD_MATCH_SCORE)
    expect(normalizeMinMatchScore(50)).toBe(GOOD_MATCH_SCORE)
    expect(normalizeMinMatchScore(40)).toBe(GOOD_MATCH_SCORE)
    expect(normalizeMinMatchScore(31)).toBe(GOOD_MATCH_SCORE)
    expect(normalizeMinMatchScore(150)).toBe(STRONG_MATCH_SCORE) // clamped to 100, then translated
    // Live-scale values pass through untouched.
    expect(translateLegacyMinScore(25)).toBe(25)
    expect(translateLegacyMinScore(8)).toBe(8)
    expect(translateLegacyMinScore(0)).toBe(0)
  })

  it('round-trips a preference and preserves sibling automation_preferences keys', async () => {
    const db = createDb()
    try {
      db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('p1', 'automation_preferences', ?)`)
        .run(JSON.stringify({ portal_access: { enabled: true }, automations: { hamilton_autopilot: false } }))

      await saveDiscoveryMinMatchScore(db, 'p1', 12, 'tester')
      expect((await getDiscoveryPreferences(db, 'p1')).min_match_score).toBe(12)

      const blob = JSON.parse(db.prepare(`SELECT data FROM profile_sections WHERE profile_id = 'p1'`).get().data)
      expect(blob.portal_access).toEqual({ enabled: true })
      expect(blob.automations).toEqual({ hamilton_autopilot: false })
      expect(blob.discovery.min_match_score).toBe(12)
    } finally { db.close() }
  })

  it('creates the section when absent and clears on null', async () => {
    const db = createDb()
    try {
      await saveDiscoveryMinMatchScore(db, 'p2', 20, null)
      expect((await getDiscoveryPreferences(db, 'p2')).min_match_score).toBe(20)
      await saveDiscoveryMinMatchScore(db, 'p2', null, null)
      expect((await getDiscoveryPreferences(db, 'p2')).min_match_score).toBe(null)
    } finally { db.close() }
  })

  describe('legacy-scale stored preference migration (dead-slider class)', () => {
    /** Seed a RAW legacy blob, bypassing the save-path translation. */
    function seedLegacyBlob(db, profileId, minScore) {
      db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'automation_preferences', ?)`)
        .run(profileId, JSON.stringify({ portal_access: { enabled: true }, discovery: { min_match_score: minScore } }))
    }

    it('translates a stored old-scale 85 to STRONG on read and persists it back once', async () => {
      const db = createDb()
      try {
        seedLegacyBlob(db, 'p-legacy', 85)
        expect((await getDiscoveryPreferences(db, 'p-legacy')).min_match_score).toBe(STRONG_MATCH_SCORE)
        // Persisted back (one-time migration), sibling keys preserved.
        const blob = JSON.parse(db.prepare(`SELECT data FROM profile_sections WHERE profile_id = 'p-legacy'`).get().data)
        expect(blob.discovery.min_match_score).toBe(STRONG_MATCH_SCORE)
        expect(blob.portal_access).toEqual({ enabled: true })
      } finally { db.close() }
    })

    it('maps stored 50 and 40 to GOOD; live-scale values are never rewritten', async () => {
      const db = createDb()
      try {
        seedLegacyBlob(db, 'p-50', 50)
        seedLegacyBlob(db, 'p-40', 40)
        seedLegacyBlob(db, 'p-live', 23)
        expect((await getDiscoveryPreferences(db, 'p-50')).min_match_score).toBe(GOOD_MATCH_SCORE)
        expect((await getDiscoveryPreferences(db, 'p-40')).min_match_score).toBe(GOOD_MATCH_SCORE)
        expect((await getDiscoveryPreferences(db, 'p-live')).min_match_score).toBe(23)
        const liveBlob = JSON.parse(db.prepare(`SELECT data FROM profile_sections WHERE profile_id = 'p-live'`).get().data)
        expect(liveBlob.discovery.min_match_score).toBe(23)
      } finally { db.close() }
    })

    it('run-smart resolves a stored legacy preference to its translated band', async () => {
      const db = createDb()
      try {
        seedLegacyBlob(db, 'p-run', 85)
        expect(await resolveRunSmartMinScore(db, 'p-run', undefined)).toBe(STRONG_MATCH_SCORE)
      } finally { db.close() }
    })
  })

  describe('resolveRunSmartMinScore precedence', () => {
    it('explicit request min always wins (including below-floor values)', async () => {
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
        await saveDiscoveryMinMatchScore(db, 'p4', 12, null)
        expect(await resolveRunSmartMinScore(db, 'p4', undefined)).toBe(12)
        expect(await resolveRunSmartMinScore(db, 'p4', null)).toBe(12)
        expect(await resolveRunSmartMinScore(db, 'p4', 0)).toBe(12)
        expect(await resolveRunSmartMinScore(db, 'p4', 'not-a-number')).toBe(12)
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

    it('pins the DISPLAY floor to the engine REVIEW bar (recall over suppression)', () => {
      // OWNER DIRECTIVE 2026-08-03: the display floor is the engine REVIEW bar
      // (REVIEW_SCORE = 7, "some real coverage worth a human look"), NOT the
      // stricter pipeline/auto-add bar (AUTO_ADD_SCORE = 8). Every review-worthy
      // source surfaces in Discover so GrantFlow beats a free Google search.
      // Drift tripwire: the floor must equal REVIEW_SCORE so the two cannot
      // silently diverge (reversible via GRANTFLOW_DISCOVERY_MIN_SCORE_FLOOR).
      expect(DISCOVERY_MIN_SCORE_FLOOR).toBe(REVIEW_SCORE)
      expect(DEFAULT_MIN_SCORE).toBeGreaterThanOrEqual(DISCOVERY_MIN_SCORE_FLOOR)
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
      .send({ min_match_score: 12 })
    expect(put.status).toBe(200)
    expect(put.body.discovery.min_match_score).toBe(12)

    const after = await request(app)
      .get('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
    expect(after.body.discovery.min_match_score).toBe(12)

    const cleared = await request(app)
      .put('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ min_match_score: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.discovery.min_match_score).toBe(null)
  })

  it('translates a legacy-scale PUT (old 85) to the STRONG band', async () => {
    const put = await request(app)
      .put('/api/profiles/prof-disc-1/discovery-preferences')
      .set(TEST_ADMIN_AUTH_HEADER)
      .send({ min_match_score: 85 })
    expect(put.status).toBe(200)
    expect(put.body.discovery.min_match_score).toBe(STRONG_MATCH_SCORE)
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
