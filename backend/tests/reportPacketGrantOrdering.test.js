// Live finding 2026-09-11: GET /api/profiles/:id/report-packet logged
// "rich grants query failed, using fallback ... column g.created_date does not
// exist" on EVERY call. grants has only created_at (SQLite and Postgres), so
// the status-priority ordering never ran and the packet listed pipeline grants
// in id order (random UUIDs). The packet must list active work first.
import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { getAppAndDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

let app
let db

beforeAll(async () => {
  const loaded = await getAppAndDb()
  app = loaded.app
  db = loaded.db
})

describe('GET /api/profiles/:id/report-packet grant ordering', () => {
  it('orders grants by pipeline status priority, not by id', async () => {
    db.prepare("INSERT INTO organizations (id, name) VALUES ('org-rp', 'Report Packet Org')").run()
    db.prepare("INSERT INTO profiles (id, display_name, primary_type, organization_id, status) VALUES ('prof-rp', 'Report Packet Fixture', 'individual', 'org-rp', 'active')").run()
    // ids chosen so id DESC order is the WRONG order (discovered first).
    db.prepare("INSERT INTO grants (id, organization_id, profile_id, title, status) VALUES ('zzz-discovered', 'org-rp', 'prof-rp', 'Discovered grant', 'discovered')").run()
    db.prepare("INSERT INTO grants (id, organization_id, profile_id, title, status) VALUES ('aaa-drafting', 'org-rp', 'prof-rp', 'Drafting grant', 'drafting')").run()

    const res = await request(app).get('/api/profiles/prof-rp/report-packet').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    const drafting = body.indexOf('Drafting grant')
    const discovered = body.indexOf('Discovered grant')
    expect(drafting).toBeGreaterThan(-1)
    expect(discovered).toBeGreaterThan(-1)
    expect(drafting).toBeLessThan(discovered)
  })
})
