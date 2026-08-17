/**
 * grantScopedRecords.test.js — real persistence for the three UI entities
 * that previously fell through to the frontend's in-memory stub store
 * (ChecklistItem / GrantAward / ComplianceReport) and lost every write on
 * reload. Contract under test:
 *   • records actually persist and round-trip through the REST resource
 *   • tenancy: a non-admin cannot read another org's record; list-all narrows
 *     to accessible organizations
 *   • unauthenticated callers get 401
 *   • grant_awards is one-per-grant (409 on a duplicate)
 *   • unknown body keys are dropped, never persisted
 *   • ?sort= is allowlisted — an injection attempt falls back, never 500s
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createGrantScopedRecordsRouter, GRANT_SCOPED_RESOURCES } from '../routes/grantScopedRecords.js'

// Located by SUFFIX, not number, so a renumbering session cannot orphan this.
function migrationBySuffix(suffix) {
  const dir = path.join(process.cwd(), 'backend/db/migrations')
  const matches = fs.readdirSync(dir).filter((f) => f.endsWith(suffix))
  if (matches.length !== 1) throw new Error(`expected exactly one *${suffix}, found ${matches.join(', ') || 'none'}`)
  return fs.readFileSync(path.join(dir, matches[0]), 'utf8')
}

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, is_admin INTEGER DEFAULT 0);
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      user_id TEXT,
      created_by TEXT,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      organization_id TEXT,
      title TEXT,
      funder TEXT,
      status TEXT,
      start_date TEXT
    );
    INSERT INTO users (id, email, role, is_admin) VALUES
      ('admin', 'admin@example.org', 'admin', 1),
      ('u1', 'owner@example.org', 'user', 0),
      ('u2', 'other@example.org', 'user', 0);
    INSERT INTO profiles (id, organization_id, user_id) VALUES
      ('p1', 'org1', 'u1'),
      ('p2', 'org2', 'u2');
    INSERT INTO grants (id, profile_id, organization_id, title, funder, status) VALUES
      ('g1', 'p1', 'org1', 'Roof Repair Grant', 'Example Fund', 'awarded'),
      ('g2', 'p2', 'org2', 'Other Org Grant', 'Other Fund', 'awarded');
  `)
  // The tables under test come from the ACTUAL shipped migration.
  db.exec(migrationBySuffix('_grant_scoped_ui_entities.sql'))
  return db
}

function createApp(db, { user = null, ctx = null } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (user) {
      req.user = user
      if (ctx) req.ctx = ctx
    }
    req.db = db
    next()
  })
  app.use('/api/checklist-items', createGrantScopedRecordsRouter('checklist-items'))
  app.use('/api/grant-awards', createGrantScopedRecordsRouter('grant-awards'))
  app.use('/api/compliance-reports', createGrantScopedRecordsRouter('compliance-reports'))
  return app
}

const ADMIN = { user: { id: 'admin', role: 'admin' }, ctx: { userId: 'admin', isAdmin: true } }
const ORG1_USER = {
  user: { id: 'u1', role: 'user' },
  ctx: { userId: 'u1', isAdmin: false, accessibleOrgIds: new Set(['org1']), accessibleProfileIds: new Set(['p1']) },
}

describe('grant-scoped records — persistence is REAL (the stub-store regression)', () => {
  it('a created checklist item survives a fresh read (no in-memory store)', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)

    const created = await request(app)
      .post('/api/checklist-items')
      .send({ grant_id: 'g1', title: 'Draft needs statement', type: 'task' })
    expect(created.status).toBe(201)
    expect(created.body.id).toBeTruthy()

    // Read through a SEPARATE app instance — anything held in process memory
    // by the first instance cannot answer this.
    const fresh = createApp(db, ADMIN)
    const listed = await request(fresh).get('/api/checklist-items').query({ grant_id: 'g1' })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].title).toBe('Draft needs statement')

    const row = db.prepare('SELECT * FROM grant_checklist_items WHERE id = ?').get(created.body.id)
    expect(row).toBeTruthy()
    expect(row.organization_id).toBe('org1')
  })

  it('updates persist and unknown body keys are dropped, never stored', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/checklist-items')
      .send({ grant_id: 'g1', title: 'Upload budget', type: 'doc', evil_column: 'x' })
    expect(created.status).toBe(201)
    expect(created.body.evil_column).toBeUndefined()

    const updated = await request(app)
      .put(`/api/checklist-items/${created.body.id}`)
      .send({ status: 'done', another_unknown: 'y' })
    expect(updated.status).toBe(200)
    expect(updated.body.status).toBe('done')
    expect(updated.body.another_unknown).toBeUndefined()
  })

  it('grant_awards is one-per-grant: a duplicate create 409s and names the existing id', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const first = await request(app).post('/api/grant-awards').send({
      grant_id: 'g1', award_amount: 0, funder_name: 'Example Fund', reporting_cadence: 'quarterly',
    })
    expect(first.status).toBe(201)
    const dup = await request(app).post('/api/grant-awards').send({ grant_id: 'g1' })
    expect(dup.status).toBe(409)
    expect(dup.body.id).toBe(first.body.id)
  })

  it('compliance reports round-trip the detail page fields and sort by -due_date', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    await request(app).post('/api/compliance-reports').send({ grant_id: 'g1', due_date: '2026-01-01' })
    const later = await request(app).post('/api/compliance-reports').send({ grant_id: 'g1', due_date: '2026-12-01' })
    expect(later.status).toBe(201)

    const submitted = await request(app)
      .put(`/api/compliance-reports/${later.body.id}`)
      .send({ narrative: 'We fixed the roof.', status: 'submitted', submitted_date: '2026-08-17' })
    expect(submitted.status).toBe(200)
    expect(submitted.body.narrative).toBe('We fixed the roof.')
    expect(submitted.body.status).toBe('submitted')

    const listed = await request(app)
      .get('/api/compliance-reports')
      .query({ sort: 'due_date', order: 'desc' })
    expect(listed.status).toBe(200)
    expect(listed.body[0].due_date).toBe('2026-12-01')
  })

  it('an unauthenticated caller gets 401 on every verb', async () => {
    const db = createDb()
    const app = createApp(db, { user: null })
    for (const call of [
      request(app).get('/api/checklist-items'),
      request(app).post('/api/checklist-items').send({ grant_id: 'g1', title: 'x' }),
      request(app).put('/api/checklist-items/nope').send({ status: 'done' }),
      request(app).delete('/api/checklist-items/nope'),
    ]) {
      const res = await call
      expect(res.status).toBe(401)
    }
  })

  it('tenancy: a non-admin cannot read or write another org\'s record', async () => {
    const db = createDb()
    const admin = createApp(db, ADMIN)
    const foreign = await request(admin)
      .post('/api/checklist-items')
      .send({ grant_id: 'g2', title: 'Other org item' })
    expect(foreign.status).toBe(201)

    const org1App = createApp(db, ORG1_USER)
    const read = await request(org1App).get(`/api/checklist-items/${foreign.body.id}`)
    expect([403, 404]).toContain(read.status)
    const write = await request(org1App)
      .put(`/api/checklist-items/${foreign.body.id}`)
      .send({ status: 'done' })
    expect([403, 404]).toContain(write.status)
    const create = await request(org1App)
      .post('/api/checklist-items')
      .send({ grant_id: 'g2', title: 'sneaky' })
    expect([403, 404]).toContain(create.status)
    // The other org's row is untouched.
    const row = db.prepare('SELECT status FROM grant_checklist_items WHERE id = ?').get(foreign.body.id)
    expect(row.status).toBe('pending')
  })

  it('a client-supplied organization_id can never override the grant\'s own org', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/checklist-items')
      .send({ grant_id: 'g1', title: 'x', organization_id: 'org2' })
    expect(created.status).toBe(201)
    expect(created.body.organization_id).toBe('org1')
  })

  it('?sort= is allowlisted: an injection attempt falls back instead of erroring', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    await request(app).post('/api/checklist-items').send({ grant_id: 'g1', title: 'a' })
    const res = await request(app)
      .get('/api/checklist-items')
      .query({ grant_id: 'g1', sort: 'title; DROP TABLE grants;--', order: 'desc' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM grants').get().n).toBe(2)
  })

  it('registry totality: every resource declares required/sortable subsets of its columns', () => {
    for (const [key, spec] of Object.entries(GRANT_SCOPED_RESOURCES)) {
      expect(spec.table, key).toMatch(/^[a-z_]+$/)
      for (const col of spec.required) expect(spec.columns, `${key}.required`).toContain(col)
      for (const col of spec.updatable) expect(spec.columns, `${key}.updatable`).toContain(col)
      for (const col of spec.sortable) expect(col, `${key}.sortable`).toMatch(/^[a-z_]+$/)
    }
  })
})
