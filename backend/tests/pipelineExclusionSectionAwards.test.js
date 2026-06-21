/**
 * Regression tests for the "discovery re-surfaces awards already saved in a
 * profile" production bug.
 *
 * Two root causes, both covered here:
 *
 *   1. pipelineExclusion only indexed the `grants` table + dismissals. Awards
 *      the user already secured/imported live in the profile's
 *      `university_applications` section JSON (applications[].financial_aid_pipeline[]
 *      and applications[].imported_portal_awards[]), NOT in `grants`, so they
 *      re-surfaced as "new" matches. filterOutPipelineMembers must now exclude
 *      them by title.
 *
 *   2. Two endpoints returned opportunity lists WITHOUT calling
 *      filterOutPipelineMembers(): POST /api/ai/ecf-service-search and
 *      POST /api/discovery/discoverECFServices. Both must now filter pipeline
 *      members (with an include_pipeline escape hatch).
 */

import express from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

import { filterOutPipelineMembers } from '../services/pipelineExclusion.js'
import aiRouter from '../routes/ai.js'
import discoveryRouter from '../routes/discovery.js'

// ---------------------------------------------------------------------------
// Shared in-memory schema: the canonical tables these code paths touch.
// ---------------------------------------------------------------------------
function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      user_id TEXT,
      created_by TEXT,
      state TEXT,
      tags TEXT DEFAULT '[]'
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(profile_id, section_key)
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT,
      fingerprint TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      funder TEXT,
      source TEXT,
      record_origin TEXT,
      categories TEXT DEFAULT '[]',
      state TEXT,
      is_active INTEGER DEFAULT 1,
      profile_id TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return db
}

function seedUniversityApplications(db, profileId, applications) {
  db.prepare(
    `INSERT INTO profile_sections (id, profile_id, section_key, data)
     VALUES (lower(hex(randomblob(16))), ?, 'university_applications', ?)`,
  ).run(profileId, JSON.stringify({ applications }))
}

// ---------------------------------------------------------------------------
// Root fix: section-only awards are excluded by title.
// ---------------------------------------------------------------------------
describe('filterOutPipelineMembers — university_applications section awards', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    db.prepare(`INSERT INTO profiles (id, display_name) VALUES ('p1', 'Student')`).run()
  })

  it('excludes an award present ONLY in financial_aid_pipeline (by title)', async () => {
    seedUniversityApplications(db, 'p1', [
      {
        id: 'app-1',
        name: 'State University',
        status: 'committed',
        financial_aid_pipeline: [
          { id: 'aid-1', title: 'UNCF Scholarships', status: 'awarded', amount: 5000 },
        ],
      },
    ])
    // Discovery surfaces the same scholarship under a different funder label and
    // a fresh catalog id — it is NOT in the grants table at all.
    const opportunities = [
      { id: 'opp-uncf', title: 'UNCF Scholarships', funder: 'United Negro College Fund' },
      { id: 'opp-other', title: 'Fresh Grant', funder: 'Other' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results.map((o) => o.id)).toEqual(['opp-other'])
  })

  it('excludes an award present ONLY in imported_portal_awards (by award_name)', async () => {
    seedUniversityApplications(db, 'p1', [
      {
        id: 'app-1',
        name: 'State University',
        status: 'committed',
        financial_aid_pipeline: [],
        imported_portal_awards: [
          { id: 'pa-1', award_name: 'Provost Merit Award', portal_name: 'StateU Portal' },
        ],
      },
    ])
    const opportunities = [
      { id: 'opp-provost', title: 'Provost Merit Award', funder: 'State University' },
      { id: 'opp-keep', title: 'Keep Me', funder: 'Somewhere' },
    ]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(1)
    expect(results.map((o) => o.id)).toEqual(['opp-keep'])
  })

  it('is profile-scoped — another profile section award never suppresses this profile', async () => {
    db.prepare(`INSERT INTO profiles (id, display_name) VALUES ('p2', 'Other')`).run()
    seedUniversityApplications(db, 'p2', [
      {
        id: 'app-x',
        status: 'committed',
        financial_aid_pipeline: [{ id: 'a', title: 'UNCF Scholarships', status: 'awarded' }],
      },
    ])
    const opportunities = [{ id: 'opp-uncf', title: 'UNCF Scholarships', funder: 'UNCF' }]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(0)
    expect(results.map((o) => o.id)).toEqual(['opp-uncf'])
  })

  it('does not blank results when the section JSON is malformed (recall over suppression)', async () => {
    db.prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data)
       VALUES (lower(hex(randomblob(16))), 'p1', 'university_applications', ?)`,
    ).run('{ not valid json')
    const opportunities = [{ id: 'opp-1', title: 'Anything', funder: 'X' }]
    const { results, excluded } = await filterOutPipelineMembers(db, 'p1', opportunities)
    expect(excluded).toBe(0)
    expect(results).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Endpoint fix: both ECF endpoints now filter pipeline members.
// ---------------------------------------------------------------------------
function makeApp(db, router, mountPath) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    // Authenticated admin so access gates pass without seeding ownership rows.
    req.user = { role: 'admin', id: 'admin-1', userId: 'admin-1' }
    req.ctx = { isAdmin: true }
    next()
  })
  app.use(mountPath, router)
  return app
}

describe('POST /api/ai/ecf-service-search — filters pipeline members', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    db.prepare(`INSERT INTO profiles (id, display_name, state) VALUES ('p1', 'Student', 'TN')`).run()
    // One ECF service in the catalog.
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, funder, source, record_origin, categories, state, is_active, profile_id)
       VALUES ('ecf-1', 'UNCF Scholarships', 'UNCF', 'ecf_choices', 'live_crawl', '["ecf"]', NULL, 1, NULL)`,
    ).run()
    // The user already secured it (section-only award, not in grants table).
    seedUniversityApplications(db, 'p1', [
      {
        id: 'app-1',
        status: 'committed',
        financial_aid_pipeline: [{ id: 'a', title: 'UNCF Scholarships', status: 'awarded' }],
      },
    ])
  })

  it('drops a service already secured in the profile section', async () => {
    const app = makeApp(db, aiRouter, '/api/ai')
    const res = await request(app)
      .post('/api/ai/ecf-service-search')
      .send({ profile_id: 'p1', profile: { id: 'p1', state: 'TN' } })
    expect(res.status).toBe(200)
    expect(res.body.services.map((s) => s.title)).not.toContain('UNCF Scholarships')
  })

  it('keeps it when include_pipeline=true (escape hatch)', async () => {
    const app = makeApp(db, aiRouter, '/api/ai')
    const res = await request(app)
      .post('/api/ai/ecf-service-search')
      .send({ profile_id: 'p1', profile: { id: 'p1', state: 'TN' }, include_pipeline: true })
    expect(res.status).toBe(200)
    expect(res.body.services.map((s) => s.title)).toContain('UNCF Scholarships')
  })
})

describe('POST /api/discovery/discoverECFServices — filters pipeline members', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    db.prepare(
      `INSERT INTO profiles (id, display_name, state, tags) VALUES ('p1', 'Student', 'TN', ?)`,
    ).run(JSON.stringify(['ecf_choices']))
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, funder, source, record_origin, state, is_active, profile_id)
       VALUES ('ecf-2', 'UNCF Scholarships', 'UNCF', 'ecf_choices_discovery', 'live_crawl', 'TN', 1, NULL)`,
    ).run()
    seedUniversityApplications(db, 'p1', [
      {
        id: 'app-1',
        status: 'committed',
        financial_aid_pipeline: [{ id: 'a', title: 'UNCF Scholarships', status: 'awarded' }],
      },
    ])
  })

  it('drops a service already secured in the profile section', async () => {
    const app = makeApp(db, discoveryRouter, '/api/discovery')
    const res = await request(app)
      .post('/api/discovery/discoverECFServices')
      .send({ profile_id: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.services.map((s) => s.title)).not.toContain('UNCF Scholarships')
    expect(res.body.excluded_already_in_pipeline).toBe(1)
  })

  it('keeps it when include_pipeline=true (escape hatch)', async () => {
    const app = makeApp(db, discoveryRouter, '/api/discovery')
    const res = await request(app)
      .post('/api/discovery/discoverECFServices')
      .send({ profile_id: 'p1', include_pipeline: true })
    expect(res.status).toBe(200)
    expect(res.body.services.map((s) => s.title)).toContain('UNCF Scholarships')
  })
})
