/**
 * orgScopedRecords.test.js — real persistence for the consultant workspace
 * entities that previously fell through to the frontend's in-memory stub
 * store (Invoice / InvoiceLine / Project / TimeEntry / TimeLog) and lost
 * every write on reload. Contract under test:
 *   • records actually persist and round-trip through the REST resource
 *   • invoiced=false (boolean query) matches INTEGER 0 rows
 *   • tenancy: a non-admin cannot read another org's record
 *   • unauthenticated callers get 401
 *   • unknown body keys are dropped, never persisted
 *   • ?sort= is allowlisted — an injection attempt falls back, never 500s
 *   • deleting an invoice cascades to its lines
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createOrgScopedRecordsRouter, ORG_SCOPED_RESOURCES } from '../routes/orgScopedRecords.js'

// Located by SUFFIX, not number, so a renumbering session cannot orphan this.
function migrationBySuffix(suffix) {
  const dir = path.join(process.cwd(), 'backend/db/migrations')
  const matches = fs.readdirSync(dir).filter((f) => f.endsWith(suffix))
  if (matches.length !== 1) throw new Error(`expected exactly one *${suffix}, found ${matches.join(', ') || 'none'}`)
  return fs.readFileSync(path.join(dir, matches[0]), 'utf8')
}

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
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
      status TEXT
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
  db.exec(migrationBySuffix('_org_scoped_workspace_entities.sql'))
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
  app.use('/api/invoices', createOrgScopedRecordsRouter('invoices'))
  app.use('/api/invoice-lines', createOrgScopedRecordsRouter('invoice-lines'))
  app.use('/api/projects', createOrgScopedRecordsRouter('projects'))
  app.use('/api/time-entries', createOrgScopedRecordsRouter('time-entries'))
  app.use('/api/time-logs', createOrgScopedRecordsRouter('time-logs'))
  return app
}

const ADMIN = { user: { id: 'admin', role: 'admin' }, ctx: { userId: 'admin', isAdmin: true } }
const ORG1_USER = {
  user: { id: 'u1', role: 'user' },
  ctx: { userId: 'u1', isAdmin: false, accessibleOrgIds: new Set(['org1']), accessibleProfileIds: new Set(['p1']) },
}

describe('org-scoped records — persistence is REAL (the stub-store regression)', () => {
  it('a created invoice survives a fresh read (no in-memory store)', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)

    const created = await request(app)
      .post('/api/invoices')
      .send({ organization_id: 'org1', invoice_number: 'INV-202608-0001', total: 399, service_type: 'quick_scan' })
    expect(created.status).toBe(201)
    expect(created.body.id).toBeTruthy()
    expect(created.body.invoice_number).toBe('INV-202608-0001')

    const fresh = createApp(db, ADMIN)
    const listed = await request(fresh).get('/api/invoices').query({ organization_id: 'org1' })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].invoice_number).toBe('INV-202608-0001')

    const row = db.prepare('SELECT * FROM consultant_invoices WHERE id = ?').get(created.body.id)
    expect(row).toBeTruthy()
    expect(row.organization_id).toBe('org1')
    expect(row.service_type).toBe('quick_scan')
  })

  it('updates persist and unknown body keys are dropped, never stored', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/projects')
      .send({ organization_id: 'org1', project_name: 'Dossier', evil_column: 'x' })
    expect(created.status).toBe(201)
    expect(created.body.evil_column).toBeUndefined()

    const updated = await request(app)
      .put(`/api/projects/${created.body.id}`)
      .send({ status: 'active', another_unknown: 'y' })
    expect(updated.status).toBe(200)
    expect(updated.body.status).toBe('active')
    expect(updated.body.another_unknown).toBeUndefined()
  })

  it('invoiced=false filters INTEGER 0 rows (Create Invoice unbilled-time query)', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    await request(app).post('/api/time-entries').send({
      organization_id: 'org1', rounded_minutes: 60, invoiced: false, note: 'draft',
    })
    await request(app).post('/api/time-entries').send({
      organization_id: 'org1', rounded_minutes: 30, invoiced: true, note: 'billed',
    })

    const unbilled = await request(app)
      .get('/api/time-entries')
      .query({ organization_id: 'org1', invoiced: 'false' })
    expect(unbilled.status).toBe(200)
    expect(unbilled.body).toHaveLength(1)
    expect(unbilled.body[0].note).toBe('draft')
  })

  it('invoice lines inherit the invoice org and cascade on invoice delete', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const invoice = await request(app)
      .post('/api/invoices')
      .send({ organization_id: 'org1', invoice_number: 'INV-1', total: 149 })
    expect(invoice.status).toBe(201)

    const line = await request(app)
      .post('/api/invoice-lines')
      .send({ invoice_id: invoice.body.id, description: 'Quick scan', quantity: 1, amount: 149 })
    expect(line.status).toBe(201)
    expect(line.body.organization_id).toBe('org1')

    const listed = await request(app).get('/api/invoice-lines').query({ invoice_id: invoice.body.id })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)

    const del = await request(app).delete(`/api/invoices/${invoice.body.id}`)
    expect(del.status).toBe(200)
    const leftover = db.prepare('SELECT COUNT(*) AS n FROM consultant_invoice_lines').get()
    expect(leftover.n).toBe(0)
  })

  it('time logs inherit the project org', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const project = await request(app)
      .post('/api/projects')
      .send({ organization_id: 'org1', project_name: 'Hourly work' })
    expect(project.status).toBe(201)

    const log = await request(app)
      .post('/api/time-logs')
      .send({ project_id: project.body.id, hours: 2, description: 'Research', billable: true })
    expect(log.status).toBe(201)
    expect(log.body.organization_id).toBe('org1')
    expect(log.body.hours).toBe(2)
  })

  it('an unauthenticated caller gets 401 on every verb', async () => {
    const db = createDb()
    const app = createApp(db, { user: null })
    for (const call of [
      request(app).get('/api/invoices'),
      request(app).post('/api/invoices').send({ organization_id: 'org1' }),
      request(app).put('/api/invoices/nope').send({ status: 'Paid' }),
      request(app).delete('/api/invoices/nope'),
    ]) {
      const res = await call
      expect(res.status).toBe(401)
    }
  })

  it('tenancy: a non-admin cannot read or write another org\'s record', async () => {
    const db = createDb()
    const admin = createApp(db, ADMIN)
    const foreign = await request(admin)
      .post('/api/invoices')
      .send({ organization_id: 'org2', invoice_number: 'INV-OTHER' })
    expect(foreign.status).toBe(201)

    const org1App = createApp(db, ORG1_USER)
    const read = await request(org1App).get(`/api/invoices/${foreign.body.id}`)
    expect([403, 404]).toContain(read.status)
    const write = await request(org1App)
      .put(`/api/invoices/${foreign.body.id}`)
      .send({ status: 'Paid' })
    expect([403, 404]).toContain(write.status)
    const create = await request(org1App)
      .post('/api/invoices')
      .send({ organization_id: 'org2', invoice_number: 'sneaky' })
    expect([403, 404]).toContain(create.status)
    const row = db.prepare('SELECT status FROM consultant_invoices WHERE id = ?').get(foreign.body.id)
    expect(row.status).toBe('Draft')
  })

  it('?sort= is allowlisted: an injection attempt falls back instead of erroring', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    await request(app).post('/api/invoices').send({ organization_id: 'org1', invoice_number: 'a' })
    const res = await request(app)
      .get('/api/invoices')
      .query({ organization_id: 'org1', sort: 'title; DROP TABLE consultant_invoices;--', order: 'desc' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM consultant_invoices').get().n).toBe(1)
  })

  it('registry totality: every resource declares required/sortable subsets of its columns', () => {
    for (const [key, spec] of Object.entries(ORG_SCOPED_RESOURCES)) {
      expect(spec.table, key).toMatch(/^[a-z_]+$/)
      for (const col of spec.required) expect(spec.columns, `${key}.required`).toContain(col)
      for (const col of spec.updatable) expect(spec.columns, `${key}.updatable`).toContain(col)
      for (const col of spec.sortable) expect(col, `${key}.sortable`).toMatch(/^[a-z_]+$/)
    }
  })
})
