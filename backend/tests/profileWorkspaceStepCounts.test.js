/**
 * GET /api/profiles/:id must return the Workspace step-completion signals
 * (document_count, pipeline_count, action_plan_count) that the shared
 * src/utils/workspaceSteps.js selector reads to decide which step cards are
 * green and which one pulses. Each count is a FACT read off real rows — green
 * is never a stamp — so this test proves the counts reflect actual data and
 * default to 0 (step not-yet-complete) when there is nothing there.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import { getAppAndDb, resetDb, TEST_ADMIN_AUTH_HEADER } from './testServer.js'

describe('GET /api/profiles/:id workspace step counts', () => {
  let app
  let db

  beforeAll(async () => {
    ;({ app, db } = await getAppAndDb())
  })

  beforeEach(() => {
    resetDb(db)
  })

  it('reports 0 for every step signal on a brand-new profile', async () => {
    db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('ws-empty', 'Empty', 'active')`).run()
    const res = await request(app).get('/api/profiles/ws-empty').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    expect(res.body.document_count).toBe(0)
    expect(res.body.pipeline_count).toBe(0)
    expect(res.body.action_plan_count).toBe(0)
  })

  it('counts real documents, active pipeline grants, and generated action plans', async () => {
    db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('ws-full', 'Full', 'active')`).run()

    // A profile document (a general upload) — links profile → documents.
    db.prepare(`INSERT INTO documents (id, profile_id, name, type) VALUES ('doc-1', 'ws-full', 'letter.pdf', 'letter')`).run()
    db.prepare(`INSERT INTO profile_documents (profile_id, document_id) VALUES ('ws-full', 'doc-1')`).run()

    // A generated Anya/Hamilton action plan (type = 'project_action_plan').
    db.prepare(`INSERT INTO documents (id, profile_id, name, type) VALUES ('plan-1', 'ws-full', 'Plan.md', 'project_action_plan')`).run()

    // Two active pipeline grants + one dead (rejected) grant that must NOT count.
    db.prepare(`INSERT INTO grants (id, profile_id, title, status) VALUES ('g-1', 'ws-full', 'Active A', 'discovered')`).run()
    db.prepare(`INSERT INTO grants (id, profile_id, title, status) VALUES ('g-2', 'ws-full', 'Active B', 'submitted')`).run()
    db.prepare(`INSERT INTO grants (id, profile_id, title, status) VALUES ('g-3', 'ws-full', 'Dead', 'rejected')`).run()

    const res = await request(app).get('/api/profiles/ws-full').set(TEST_ADMIN_AUTH_HEADER)
    expect(res.status).toBe(200)
    // document_count counts profile_documents links (the action-plan doc is not
    // linked via profile_documents, so it is not double-counted here).
    expect(res.body.document_count).toBe(1)
    expect(res.body.action_plan_count).toBe(1)
    // Only the two ACTIVE grants count toward pipeline completion.
    expect(res.body.pipeline_count).toBe(2)
  })
})
