import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import opportunitiesRouter from '../routes/opportunities.js'

function createDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      record_origin TEXT,
      description TEXT,
      application_url TEXT,
      opportunity_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      amount_min REAL,
      amount_max REAL,
      deadline TEXT,
      deadline_type TEXT,
      is_national INTEGER DEFAULT 0,
      state TEXT,
      geo_zip TEXT,
      geo_county TEXT,
      categories TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      eligibility_bullets TEXT DEFAULT '[]',
      regions TEXT DEFAULT '[]',
      requires_match INTEGER DEFAULT 0,
      match_percentage REAL,
      match_reasons TEXT DEFAULT '[]',
      is_loan INTEGER DEFAULT 0,
      is_hidden INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      link_status TEXT,
      reality_status TEXT,
      reality_reasons TEXT,
      source_trust_tier TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE funding_opportunity_geo_index (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT NOT NULL,
      geo_run_id TEXT,
      state TEXT,
      zip TEXT,
      county TEXT,
      source TEXT
    );
  `)
  return db
}

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { userId: 'route-test-admin', role: 'admin' }
    req.ctx = { userId: 'route-test-admin', isAdmin: true }
    next()
  })
  app.use('/api/opportunities', opportunitiesRouter)
  return app
}

function seedOpportunity(db, overrides = {}) {
  const row = {
    id: 'a'.repeat(64),
    title: 'Lifecycle Funding Program',
    sponsor: 'Ohio Public Agency',
    source: 'lifecycle-visible',
    source_id: 'lifecycle-visible',
    opportunity_kind: 'DIRECT_GRANT',
    opportunity_type: 'grant',
    type: 'GRANT',
    is_hidden: 0,
    is_active: 1,
    state: 'OH',
    categories: ['housing'],
    ...overrides,
  }
  db.prepare(`
    INSERT INTO funding_opportunities (
      id, title, sponsor, source, source_id, record_origin, description,
      application_url, source_url, opportunity_kind, opportunity_type, type,
      deadline_type, is_national, state, geo_zip, geo_county, categories,
      keywords, link_status, reality_status, source_trust_tier,
      is_hidden, is_active
    ) VALUES (?, ?, ?, ?, ?, 'verified_real', ?, ?, ?, ?, ?, ?, 'rolling', 1,
              ?, '43215', 'Franklin', ?, '[]', 'verified', 'allowed',
              'official_api', ?, ?)
  `).run(
    row.id,
    row.title,
    row.sponsor,
    row.source,
    row.source_id,
    `Official lifecycle fixture for ${row.title}.`,
    `https://ohio.gov/funding/${row.id}/apply`,
    `https://ohio.gov/funding/${row.id}`,
    row.opportunity_kind,
    row.opportunity_type,
    row.type,
    row.state,
    JSON.stringify(row.categories),
    row.is_hidden,
    row.is_active,
  )
  return row
}

describe('opportunities lifecycle visibility routes', () => {
  let db
  let app

  beforeEach(() => {
    db = createDb()
    app = createApp(db)
  })

  afterEach(() => db.close())

  it('excludes quarantine from list, search fallback, detail, facets, and similar', async () => {
    const visibleDirect = seedOpportunity(db)
    const hiddenDirect = seedOpportunity(db, {
      id: 'b'.repeat(64), title: 'Lifecycle Funding Hidden Direct',
      source: 'lifecycle-hidden', source_id: 'lifecycle-hidden', is_hidden: 1,
    })
    const inactiveDirect = seedOpportunity(db, {
      id: 'c'.repeat(64), title: 'Lifecycle Funding Inactive Direct',
      source: 'lifecycle-inactive', source_id: 'lifecycle-inactive', is_active: 0,
    })
    const visiblePointer = seedOpportunity(db, {
      id: 'd'.repeat(64), title: 'Lifecycle Funding Directory',
      source: 'lifecycle-directory', source_id: 'lifecycle-directory',
      opportunity_kind: 'directory', opportunity_type: 'directory', type: 'DIRECTORY',
    })
    const hiddenPointer = seedOpportunity(db, {
      id: 'e'.repeat(64), title: 'Lifecycle Funding Hidden Directory',
      source: 'lifecycle-hidden-directory', source_id: 'lifecycle-hidden-directory',
      opportunity_kind: 'directory', opportunity_type: 'directory', type: 'DIRECTORY',
      is_hidden: 1,
    })

    const list = await request(app)
      .get('/api/opportunities')
      .query({ search: 'Lifecycle Funding', compliance: 'all', limit: 50 })
    expect(list.status).toBe(200)
    expect(list.body.data.map((row) => row.id).sort()).toEqual([
      visibleDirect.id,
      visiblePointer.id,
    ].sort())
    expect(list.body.total).toBe(2)
    expect(list.body.data.find((row) => row.id === visiblePointer.id)).toMatchObject({
      opportunity_kind: 'directory',
      type: 'DIRECTORY',
    })
    expect(JSON.stringify(list.body)).not.toMatch(new RegExp(
      `${hiddenDirect.id}|${inactiveDirect.id}|${hiddenPointer.id}`,
    ))

    const fallback = await request(app)
      .get('/api/opportunities')
      .query({ search: 'Lifecycle Program', compliance: 'all', limit: 50 })
    expect(fallback.status).toBe(200)
    expect(fallback.body.fallback_applied).toBe(true)
    expect(fallback.body.data.map((row) => row.id)).toEqual([visibleDirect.id])

    expect((await request(app).get(`/api/opportunities/${visibleDirect.id}`)).status).toBe(200)
    expect((await request(app).get(`/api/opportunities/${hiddenDirect.id}`)).status).toBe(404)
    expect((await request(app).get(`/api/opportunities/${inactiveDirect.id}`)).status).toBe(404)
    expect((await request(app)
      .get(`/api/opportunities/${hiddenDirect.id}/explain`)
      .query({ profileId: 'not-reached' })).status).toBe(404)

    const sources = await request(app)
      .get('/api/opportunities/meta/sources')
      .query({ compliance: 'all' })
    expect(sources.status).toBe(200)
    expect(sources.body.map((row) => row.source)).toEqual(expect.arrayContaining([
      visibleDirect.source,
      visiblePointer.source,
    ]))
    expect(sources.body.map((row) => row.source)).not.toEqual(expect.arrayContaining([
      hiddenDirect.source,
      inactiveDirect.source,
      hiddenPointer.source,
    ]))

    const similar = await request(app).get(`/api/opportunities/${visibleDirect.id}/similar`)
    expect(similar.status).toBe(200)
    expect(similar.body.similar.map((row) => row.id)).not.toEqual(expect.arrayContaining([
      hiddenDirect.id,
      inactiveDirect.id,
      hiddenPointer.id,
    ]))
  })

  it('excludes quarantine from geo summary, scored rows, and totals', async () => {
    const visible = seedOpportunity(db, { id: '1'.repeat(64), title: 'Visible Ohio Geo Grant' })
    const hidden = seedOpportunity(db, {
      id: '2'.repeat(64), title: 'Hidden Ohio Geo Grant', is_hidden: 1,
    })
    const inactive = seedOpportunity(db, {
      id: '3'.repeat(64), title: 'Inactive Ohio Geo Grant', is_active: 0,
    })
    for (const row of [visible, hidden, inactive]) {
      db.prepare(`
        INSERT INTO funding_opportunity_geo_index
          (id, opportunity_id, geo_run_id, state, zip, county, source)
        VALUES (?, ?, 'lifecycle-geo-run', 'OH', '43215', 'Franklin', 'lifecycle-test')
      `).run(`geo-${row.id.slice(0, 8)}`, row.id)
    }

    const summary = await request(app).get('/api/opportunities/geo/summary')
    expect(summary.status).toBe(200)
    expect(summary.body.total_opportunities).toBe(1)
    expect(summary.body.states).toEqual([
      expect.objectContaining({ state: 'OH', opportunity_count: 1 }),
    ])

    const scored = await request(app)
      .get('/api/opportunities/geo/scored')
      .query({ state: 'OH', geo_zip: '43215', limit: 50 })
    expect(scored.status).toBe(200)
    expect(scored.body.total).toBe(1)
    expect(scored.body.data.map((row) => row.id)).toEqual([visible.id])
  })
})
