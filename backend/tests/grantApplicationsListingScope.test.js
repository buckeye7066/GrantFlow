import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import router from '../routes/grantApplications.js'
import { assertProfileScopedSql, runProfileContext } from '../db/scopedQuery.js'

// The browser reaches this route with an active-profile claim even when the
// tracker filter is "all". Keep the real SQL isolation guard enabled here.
describe('application tracker under a real profile-scoped request', () => {
  let db
  let app
  let failTaskRead
  beforeEach(() => {
    failTaskRead = false
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE grant_applications (id TEXT, profile_id TEXT, user_id TEXT, opportunity_id TEXT, status TEXT, grant_name TEXT, updated_at TEXT);
      CREATE TABLE application_tasks (id TEXT, profile_id TEXT, user_id TEXT, opportunity_id TEXT, grant_id TEXT, status TEXT, submitted_at TEXT, created_at TEXT, updated_at TEXT, output_document_id TEXT);
      CREATE TABLE funding_opportunities (id TEXT, title TEXT, sponsor TEXT);
      CREATE TABLE grants (id TEXT, profile_id TEXT, title TEXT, funder TEXT);
      INSERT INTO grants VALUES ('g-a','p-a','First private title','Funder A'),('g-b','p-b','Second private title','Funder B'),('g-other','p-other','Other tenant secret','Other funder');
      INSERT INTO application_tasks VALUES
        ('t-a','p-a','u-a',NULL,'g-a','queued',NULL,'2026-09-18','2026-09-18',NULL),
        ('t-b','p-b','u-a',NULL,'g-b','queued',NULL,'2026-09-18','2026-09-18',NULL),
        ('t-poison','p-a','u-a',NULL,'g-other','queued',NULL,'2026-09-18','2026-09-18',NULL),
        ('t-other','p-other','u-other',NULL,'g-other','queued',NULL,'2026-09-18','2026-09-18',NULL);
    `)
    const guardedDb = {
      prepare(sql) {
        assertProfileScopedSql(sql)
        if (failTaskRead && /FROM application_tasks/i.test(sql)) throw new Error('Task database unavailable')
        return db.prepare(sql)
      },
    }
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = guardedDb
      req.user = { role: 'user', userId: 'u-a', profileId: 'p-a' }
      req.ctx = { userId: 'u-a', identityResolved: true, isAdmin: false, activeProfileId: 'p-a' }
      runProfileContext({ profileId: 'p-a', userId: 'u-a', role: 'user' }, next)
    })
    app.use('/api/grant-applications', router)
  })
  afterEach(() => db.close())

  it('keeps Hamilton applications from both of the caller\'s profiles in the all-profiles list', async () => {
    const result = await request(app).get('/api/grant-applications').expect(200)
    expect(result.body.map(row => row.id)).toEqual(['t-a', 't-b', 't-poison'])
    expect(result.body.find(row => row.id === 't-a').grant_name).toBe('First private title')
    expect(result.body.find(row => row.id === 't-b').grant_name).toBe('Second private title')
  })

  it('never follows a task\'s poisoned grant pointer into another profile', async () => {
    const result = await request(app).get('/api/grant-applications').expect(200)
    const poisoned = result.body.find(row => row.id === 't-poison')
    expect(poisoned).toBeDefined()
    expect(poisoned.grant_name).toBe('Untitled application')
    expect(JSON.stringify(result.body)).not.toContain('Other tenant secret')
    expect(result.body.some(row => row.id === 't-other')).toBe(false)
  })

  it('does not turn a task-read failure into a successful empty tracker', async () => {
    failTaskRead = true
    const result = await request(app).get('/api/grant-applications')
    expect(result.status).toBe(500)
    expect(result.body).toHaveProperty('error')
  })
})
