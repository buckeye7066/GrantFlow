/**
 * GET /api/admin/recall-scorecard and /recall-scorecard/:profileId
 * (result-quality PR4). Proves through the real app: admin-only, 404 on an
 * unknown profile, the per-profile card shape, and that the fleet route
 * serves the persisted snapshot when one exists and computes live otherwise.
 */
import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'crypto'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'
import { RECALL_SCORECARD_KV_KEY } from '../services/coverageAudit/recallScorecard.js'

describe('admin recall scorecard routes', () => {
  let app
  let db
  let profileId

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    app = loaded.app
    db = loaded.db
  })

  beforeEach(async () => {
    await resetDb()
    profileId = crypto.randomUUID()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, 'college_student', 'active')").run(profileId, 'Scorecard Test Profile')
    // system_kv is created lazily by the first writer; make the pre-clean safe on a fresh db.
    db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    // The match store ships via migration; the fresh test sqlite may not have replayed it.
    db.prepare(`CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER, match_decision TEXT,
      matcher_version TEXT, match_explain_json TEXT, match_confidence REAL
    )`).run()
    db.prepare('DELETE FROM system_kv WHERE key = ?').run(RECALL_SCORECARD_KV_KEY)
  })

  it('refuses a non-admin caller', async () => {
    const res = await request(app).get(`/api/admin/recall-scorecard/${profileId}`)
    expect([401, 403]).toContain(res.status)
  })

  it('404s an unknown profile', async () => {
    const res = await request(app).get('/api/admin/recall-scorecard/does-not-exist').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(404)
  })

  it('returns one profile card with every funnel section present', async () => {
    const res = await request(app).get(`/api/admin/recall-scorecard/${profileId}`).set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const card = res.body.scorecard
    expect(card.profile_id).toBe(profileId)
    for (const key of ['lane', 'stages', 'catalog', 'surfaced', 'pipeline', 'applications', 'binding_constraint']) expect(card).toHaveProperty(key)
    expect(card.stages).toMatchObject({ queries_generated: 0, candidates_extracted: 0, qualified_admitted: 0 })
    expect(card.catalog).toEqual({ surfaced_lanes: { accept: 0, review: 0, reject: 0, other: 0 }, unsurfaced_lanes: 0, proven_direct_accepts: 0 })
    expect(card.pipeline.verified_external_submissions).toBeNull()
    expect(typeof card.binding_constraint.blocker).toBe('string')
  })

  it('fleet: computes LIVE when no snapshot exists, persists on request, then serves the PERSISTED one', async () => {
    const live = await request(app).get('/api/admin/recall-scorecard?limit=10&persist=1').set(TEST_ADMIN_AUTH_HEADER)
    expect(live.status).toBe(200)
    expect(live.body.source).toBe('live')
    expect(live.body.scorecard.profiles_measured).toBeGreaterThanOrEqual(1)
    expect(live.body.scorecard.metric_envelope.evaluated_population.kind).toBe('active_profiles')
    expect(Array.isArray(live.body.history)).toBe(true)

    const persisted = await request(app).get('/api/admin/recall-scorecard').set(TEST_ADMIN_AUTH_HEADER)
    expect(persisted.status).toBe(200)
    expect(persisted.body.source).toBe('persisted')
    expect(persisted.body.scorecard.generated_at).toBe(live.body.scorecard.generated_at)
    // History entries are compacted for the wire: row count instead of rows.
    expect(persisted.body.history[0]).toMatchObject({ row_count: live.body.scorecard.profiles_measured })
    expect(persisted.body.history[0].rows).toBeUndefined()
  })
})
