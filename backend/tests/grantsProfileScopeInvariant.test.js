import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import grantsRouter from '../routes/grants.js'
import { recordDismissal } from '../services/pipelineDismissals.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, primary_email TEXT, is_admin INTEGER DEFAULT 0
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, primary_profile_type TEXT,
      tags TEXT, interests TEXT, state TEXT, city TEXT, zip TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, state TEXT, city TEXT, zip TEXT
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      status TEXT DEFAULT 'discovered',
      priority TEXT,
      amount_requested REAL,
      amount_awarded REAL,
      amount_min REAL,
      amount_max REAL,
      application_url TEXT,
      url TEXT,
      fingerprint TEXT,
      fingerprint_version INTEGER,
      match_score REAL,
      match_decision TEXT,
      matched_needs TEXT,
      match_explanation TEXT,
      matcher_version TEXT,
      evaluated_at TEXT,
      match_reasons TEXT,
      notes TEXT,
      submitted_date TEXT,
      award_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      title TEXT,
      sponsor TEXT,
      description TEXT,
      eligibility_text TEXT,
      application_url TEXT,
      source_url TEXT,
      evidence_url TEXT,
      url TEXT,
      source TEXT,
      record_origin TEXT,
      source_trust_tier TEXT,
      opportunity_kind TEXT,
      opportunity_type TEXT,
      deadline TEXT,
      deadline_type TEXT,
      is_active INTEGER DEFAULT 1
    );

    INSERT INTO users (id, primary_email) VALUES
      ('user-1', 'one@example.test'),
      ('user-2', 'two@example.test');
    INSERT INTO organizations (id, name) VALUES
      ('org-1', 'Organization One'),
      ('org-2', 'Organization Two');
    INSERT INTO profiles
      (id, user_id, organization_id, display_name, primary_type, applicant_type, tags, interests)
    VALUES
      ('profile-1', 'user-1', 'org-1', 'Profile One', 'individual', 'individual', '[]', '[]'),
      ('profile-2', 'user-2', 'org-2', 'Profile Two', 'individual', 'individual', '[]', '[]');
    INSERT INTO profile_sections (profile_id, section_key, data) VALUES
      ('profile-1', 'basic_information', '{"state":"TN","city":"Murfreesboro"}'),
      ('profile-1', 'education', '{"intended_major":"Paramedic"}');
  `)
  return db
}

function appWith(db, { admin = true } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = admin
      ? { role: 'admin', userId: 'user-1' }
      : { role: 'user', userId: 'user-1' }
    req.ctx = admin
      ? { isAdmin: true }
      : {
          isAdmin: false,
          identityResolved: true,
          accessibleProfileIds: new Set(['profile-1']),
          accessibleOrgIds: new Set(['org-1']),
        }
    next()
  })
  app.use('/api/grants', grantsRouter)
  return app
}

describe('grant profile identity and profile-aware raw-create paths', () => {
  let db

  beforeEach(() => {
    db = makeDb()
  })

  it('persists an authorized profile_id and reaches canonical scoring', async () => {
    const response = await request(appWith(db, { admin: false }))
      .post('/api/grants')
      .send({
        title: 'Tennessee Student Support',
        organization_id: 'org-1',
        profile_id: 'profile-1',
        funder: 'Tennessee Student Assistance Corporation',
        application_url: 'https://www.tn.gov/collegepays/apply.html',
      })

    expect(response.status).toBe(201)
    const row = db.prepare('SELECT * FROM grants WHERE id = ?').get(response.body.id)
    expect(row.profile_id).toBe('profile-1')
    expect(Number.isFinite(Number(row.match_score))).toBe(true)
    expect(row.matcher_version).toBe('manual-create-scored')
  })

  it('rejects a profile outside the caller scope before it can be persisted', async () => {
    const response = await request(appWith(db, { admin: false }))
      .post('/api/grants')
      .send({ title: 'Cross-profile attempt', organization_id: 'org-1', profile_id: 'profile-2' })

    expect(response.status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants').get().count).toBe(0)
  })

  it('rejects a profile/organization mismatch even when an admin can access both', async () => {
    const response = await request(appWith(db))
      .post('/api/grants')
      .send({ title: 'Cross-tenant attempt', organization_id: 'org-2', profile_id: 'profile-1' })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('profile_organization_mismatch')
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants').get().count).toBe(0)
  })

  it('makes the profile-scoped duplicate guard reachable', async () => {
    const payload = {
      title: 'One Profile Opportunity',
      organization_id: 'org-1',
      profile_id: 'profile-1',
      funding_opportunity_id: 'catalog-1',
    }
    const first = await request(appWith(db)).post('/api/grants').send(payload)
    const second = await request(appWith(db)).post('/api/grants').send(payload)

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(second.body.already_exists).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants WHERE profile_id = ?').get('profile-1').count).toBe(1)
  })

  it('makes the profile-scoped dismissal guard reachable', async () => {
    await recordDismissal(db, {
      profileId: 'profile-1',
      opportunity: {
        id: 'catalog-dismissed',
        title: 'Dismissed Source',
        sponsor: 'Official Funder',
        application_url: 'https://www.tn.gov/dismissed-source',
      },
      userId: 'user-1',
    })

    const response = await request(appWith(db))
      .post('/api/grants')
      .send({
        title: 'Dismissed Source',
        funder: 'Official Funder',
        organization_id: 'org-1',
        profile_id: 'profile-1',
        funding_opportunity_id: 'catalog-dismissed',
        application_url: 'https://www.tn.gov/dismissed-source',
      })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('dismissed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants').get().count).toBe(0)
  })
})

describe('grant identity is immutable after create', () => {
  let db

  beforeEach(() => {
    db = makeDb()
    db.prepare(
      `INSERT INTO grants (id, organization_id, profile_id, title, status)
       VALUES ('grant-1', 'org-1', 'profile-1', 'Existing Grant', 'discovered')`,
    ).run()
  })

  it('accepts a repeated current profile id but never writes it', async () => {
    const response = await request(appWith(db))
      .put('/api/grants/grant-1')
      .send({ profile_id: 'profile-1', title: 'Renamed Grant' })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT profile_id, title FROM grants WHERE id = ?').get('grant-1'))
      .toMatchObject({ profile_id: 'profile-1', title: 'Renamed Grant' })
  })

  it('rejects a PUT that tries to re-parent the grant and applies no partial edit', async () => {
    const response = await request(appWith(db))
      .put('/api/grants/grant-1')
      .send({ profile_id: 'profile-2', title: 'Must Not Apply' })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('grant_profile_immutable')
    expect(db.prepare('SELECT profile_id, title FROM grants WHERE id = ?').get('grant-1'))
      .toMatchObject({ profile_id: 'profile-1', title: 'Existing Grant' })
  })

  it('rejects an organization change that would diverge from the existing profile', async () => {
    const response = await request(appWith(db))
      .put('/api/grants/grant-1')
      .send({ organization_id: 'org-2' })

    expect(response.status).toBe(409)
    expect(response.body.error).toBe('profile_organization_mismatch')
    expect(db.prepare('SELECT organization_id FROM grants WHERE id = ?').get('grant-1').organization_id).toBe('org-1')
  })

  it('a status PATCH ignores a supplied profile_id and cannot re-parent', async () => {
    const response = await request(appWith(db))
      .patch('/api/grants/grant-1/status')
      .send({ status: 'interested', profile_id: 'profile-2' })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT profile_id, status FROM grants WHERE id = ?').get('grant-1'))
      .toMatchObject({ profile_id: 'profile-1', status: 'interested' })
  })
})

describe('from-opportunity delegates hard eligibility to the canonical saver', () => {
  let db

  beforeEach(() => {
    db = makeDb()
  })

  it.each([
    [
      'institution applicant restriction',
      'Institution Research Program',
      'Eligible applicants are institutions of higher education only.',
    ],
    [
      'profession lock',
      'Ohio Nurses Foundation — CE Scholarships',
      'Scholarships for continuing education.',
    ],
  ])('rejects %s through DECISION_ENGINE, not a route-local second trial', async (_label, title, description) => {
    db.prepare(
      `INSERT INTO funding_opportunities
         (id, title, sponsor, description, application_url, source, record_origin, source_trust_tier)
       VALUES (?, ?, 'Official Funder', ?, 'https://www.nsf.gov/funding/opportunities',
               'curated_verified', 'curated_verified', 'OFFICIAL_API')`,
    ).run(`opportunity-${title.length}`, title, description)

    const response = await request(appWith(db))
      .post('/api/grants/from-opportunity')
      .send({
        opportunity_id: `opportunity-${title.length}`,
        profile_id: 'profile-1',
        organization_id: 'org-1',
      })

    expect(response.status).toBe(422)
    expect(response.body.error).toBe('pipeline_gate_failed')
    expect(response.body.gate).toBe('DECISION_ENGINE')
    expect(db.prepare('SELECT COUNT(*) AS count FROM grants').get().count).toBe(0)
  })
})
