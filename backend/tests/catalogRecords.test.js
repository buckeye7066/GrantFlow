/**
 * catalogRecords.test.js — PartnerSource / SearchJob / Taxonomy persist,
 * and AiArtifact is a real grant-scoped resource. These four were the last
 * declared in-memory stubs; writes must survive a fresh router instance.
 */
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createCatalogRecordsRouter, CATALOG_RESOURCES, resolveSortCol } from '../routes/catalogRecords.js'
import { createGrantScopedRecordsRouter } from '../routes/grantScopedRecords.js'
import { applyWorkspacePersistenceTablesSync } from '../db/applyWorkspacePersistenceTables.js'

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
      ('u1', 'owner@example.org', 'user', 0);
    INSERT INTO profiles (id, organization_id, user_id) VALUES
      ('p1', 'org1', 'u1');
    INSERT INTO grants (id, profile_id, organization_id, title, funder, status) VALUES
      ('g1', 'p1', 'org1', 'Roof Repair Grant', 'Example Fund', 'awarded');
  `)
  db.exec(migrationBySuffix('_workspace_catalog_and_invoice_counters.sql'))
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
  app.use('/api/partner-sources', createCatalogRecordsRouter('partner-sources'))
  app.use('/api/search-jobs', createCatalogRecordsRouter('search-jobs'))
  app.use('/api/taxonomy', createCatalogRecordsRouter('taxonomy'))
  app.use('/api/ai-artifacts', createGrantScopedRecordsRouter('ai-artifacts'))
  return app
}

const ADMIN = { user: { id: 'admin', role: 'admin' }, ctx: { userId: 'admin', isAdmin: true } }
const USER = {
  user: { id: 'u1', role: 'user' },
  ctx: { userId: 'u1', isAdmin: false, accessibleOrgIds: new Set(['org1']), accessibleProfileIds: new Set(['p1']) },
}

describe('catalog records — last declared stubs persist', () => {
  it('a taxonomy item survives a fresh read and maps group ↔ group_name', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/taxonomy')
      .send({ group: 'assistance_categories', label: 'Housing', slug: 'housing', active: true, sort_order: 0 })
    expect(created.status).toBe(201)
    expect(created.body.group).toBe('assistance_categories')
    expect(created.body.group_name).toBeUndefined()
    expect(created.body.active).toBe(1)

    const stored = db.prepare('SELECT group_name, label FROM workspace_taxonomy WHERE id = ?').get(created.body.id)
    expect(stored.group_name).toBe('assistance_categories')

    const fresh = createApp(db, USER)
    const listed = await request(fresh).get('/api/taxonomy').query({ group: 'assistance_categories', active: 'true' })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].label).toBe('Housing')
  })

  it('a non-admin cannot write taxonomy or partner sources', async () => {
    const db = createDb()
    const app = createApp(db, USER)
    const tax = await request(app).post('/api/taxonomy').send({ group: 'x', label: 'Y' })
    expect(tax.status).toBe(403)
    const partner = await request(app).post('/api/partner-sources').send({ name: 'Ford' })
    expect(partner.status).toBe(403)
  })

  it('a partner source and search job persist', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const partner = await request(app)
      .post('/api/partner-sources')
      .send({ name: 'Ford Foundation', org_type: 'foundation', status: 'inactive' })
    expect(partner.status).toBe(201)
    const job = await request(app)
      .post('/api/search-jobs')
      .send({ profile_id: 'backfill_1', status: 'running', progress: 0.2 })
    expect(job.status).toBe(201)

    const listed = await request(createApp(db, ADMIN)).get('/api/partner-sources')
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].name).toBe('Ford Foundation')
    const jobs = await request(createApp(db, ADMIN)).get('/api/search-jobs').query({ sort: 'created_date', order: 'desc' })
    expect(jobs.status).toBe(200)
    expect(jobs.body[0].profile_id).toBe('backfill_1')
  })

  it('an AiArtifact on a grant survives reload', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/ai-artifacts')
      .send({ grant_id: 'g1', kind: 'analysis', content: '{"ok":true}' })
    expect(created.status).toBe(201)
    expect(created.body.kind).toBe('analysis')
    const listed = await request(createApp(db, ADMIN)).get('/api/ai-artifacts').query({ grant_id: 'g1' })
    expect(listed.status).toBe(200)
    expect(listed.body).toHaveLength(1)
    expect(listed.body[0].content).toBe('{"ok":true}')
  })

  it('fresh SQLite extras create catalog tables without numbered migrate', () => {
    const db = new Database(':memory:')
    applyWorkspacePersistenceTablesSync(db)
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('consultant_invoices', 'consultant_invoice_counters',
                      'grant_ai_artifacts', 'workspace_partner_sources',
                      'workspace_search_jobs', 'workspace_taxonomy')
       ORDER BY name`,
    ).all().map((row) => row.name)
    expect(tables).toEqual([
      'consultant_invoice_counters',
      'consultant_invoices',
      'grant_ai_artifacts',
      'workspace_partner_sources',
      'workspace_search_jobs',
      'workspace_taxonomy',
    ])
  })

  it('registry totality: required/updatable are subsets of columns', () => {
    for (const [key, spec] of Object.entries(CATALOG_RESOURCES)) {
      expect(spec.table, key).toMatch(/^[a-z_]+$/)
      for (const col of spec.required) expect(spec.columns, `${key}.required`).toContain(col)
      for (const col of spec.updatable) expect(spec.columns, `${key}.updatable`).toContain(col)
      for (const col of spec.sortable) expect(col, `${key}.sortable`).toMatch(/^[a-z_]+$/)
    }
  })

  it('?sort= is allowlisted: an injection attempt falls back instead of erroring', async () => {
    const db = createDb()
    const app = createApp(db, ADMIN)
    const created = await request(app)
      .post('/api/partner-sources')
      .send({ name: 'Acme' })
    expect(created.status).toBe(201)

    const res = await request(app)
      .get('/api/partner-sources')
      .query({ sort: 'name; DROP TABLE workspace_partner_sources;--', order: 'desc' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    // The table the injected statement targeted is still there.
    expect(
      db.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='workspace_partner_sources'",
      ).get().n,
    ).toBe(1)
  })

  it('the resolved sort column is an ELEMENT of the frozen sortable list, never the request string', () => {
    // The ORDER BY identifier is interpolated, so it must never be a value the
    // caller supplied — it must be identity-equal to a frozen allowlist member.
    for (const [key, spec] of Object.entries(CATALOG_RESOURCES)) {
      for (const attempt of ['name; DROP TABLE x;--', 'created_at', 'created_date', 'group', '', 'nope']) {
        const resolved = resolveSortCol(spec, attempt)
        const fromList = spec.sortable.some((c) => c === resolved)
        expect(fromList || resolved === 'created_at', `${key} <- ${attempt}`).toBe(true)
        expect(resolved, `${key} <- ${attempt}`).toMatch(/^[a-z_]+$/)
      }
    }
  })
})
