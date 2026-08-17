/**
 * Lifecycle reads follow an application's pipeline_grant_id to durable
 * documents and drafts. A poisoned legacy pointer must be rejected before that
 * aggregate is loaded or another profile's artifacts become readable.
 */

import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

// This focused route test does not exercise matching/profile hydration. Mock
// those direct NOFO dependencies so the intentionally partial local snapshot
// need not reconstruct their unrelated dependency trees.
vi.mock('../services/opportunityMatcher.js', () => ({ saveToProfilePipeline: vi.fn() }))
vi.mock('../services/profileHelpers.js', () => ({ loadProfileContext: vi.fn() }))

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const nofoRouter = (await import('../routes/nofo.js')).default

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 0, primary_email TEXT,
      display_name TEXT, primary_phone TEXT, avatar_url TEXT
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, user_id TEXT, created_by TEXT, organization_id TEXT,
      display_name TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE user_credentials (
      id TEXT PRIMARY KEY, user_id TEXT, type TEXT, identifier TEXT, verified_at DATETIME
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      pipeline_grant_id TEXT, user_id TEXT, status TEXT, grant_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, organization_id TEXT,
      funding_opportunity_id TEXT, title TEXT, status TEXT
    );
    CREATE TABLE application_lifecycle_subjects (
      application_id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      pipeline_grant_id TEXT, canonical_task_id TEXT, solicitation_id TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, grant_id TEXT, name TEXT,
      type TEXT, file_size INTEGER, mime_type TEXT, content_hash TEXT,
      status TEXT, version INTEGER, file_bytes BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_drafts (
      id TEXT PRIMARY KEY, grant_id TEXT, section_name TEXT, section_order INTEGER,
      content TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO users (id, primary_email) VALUES
      ('user-1', 'owner@example.test'),
      ('user-2', 'other@example.test');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES
      ('profile-1', 'user-1', 'user-1', 'Authorized profile'),
      ('profile-2', 'user-2', 'user-2', 'Other tenant'),
      ('profile-3', 'user-1', 'user-1', 'Second authorized profile');
    INSERT INTO grants (id, profile_id, title, status) VALUES
      ('grant-2', 'profile-2', 'Private grant', 'drafting'),
      ('grant-3', 'profile-3', 'Wrong-profile grant', 'drafting');
    INSERT INTO grant_applications
      (id, profile_id, pipeline_grant_id, user_id, status, grant_name)
      VALUES ('app-poisoned', 'profile-1', 'grant-2', 'user-1', 'draft', 'Poisoned application');
    INSERT INTO grant_applications
      (id, profile_id, pipeline_grant_id, user_id, status, grant_name)
      VALUES ('app-wrong-accessible', 'profile-1', 'grant-3', 'user-1', 'draft', 'Wrong accessible grant');
    INSERT INTO grant_applications
      (id, profile_id, pipeline_grant_id, user_id, status, grant_name)
      VALUES ('app-poisoned-subject', 'profile-1', NULL, 'user-1', 'draft', 'Poisoned lifecycle subject');
    INSERT INTO application_lifecycle_subjects
      (application_id, profile_id, pipeline_grant_id)
      VALUES ('app-poisoned-subject', 'profile-1', 'grant-2');
    INSERT INTO documents
      (id, profile_id, grant_id, name, type, file_size, mime_type, content_hash, status, version, file_bytes)
      VALUES ('secret-doc', 'profile-2', 'grant-2', 'other-tenant-budget.pdf', 'budget', 6,
              'application/pdf', 'secret-hash', 'ready', 1, X'736563726574');
    INSERT INTO application_drafts
      (id, grant_id, section_name, section_order, content, status)
      VALUES ('secret-draft', 'grant-2', 'Narrative', 1, 'OTHER TENANT SECRET', 'draft');
  `)
  return db
}

function appWith(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { role: 'user', userId: 'user-1' }
    next()
  })
  app.use(attachRequestContext())
  app.use('/api', nofoRouter)
  app.use((error, _req, res, _next) => res.status(error?.status || 500).json({ error: error?.message }))
  return app
}

let db
afterEach(() => {
  db?.close()
  db = null
})

describe('GET /api/applications/:applicationId/lifecycle tenant scope', () => {
  it('rejects a cross-profile grant pointer before returning documents or drafts', async () => {
    db = makeDb()
    const foreignTenant = await request(appWith(db)).get('/api/applications/app-poisoned/lifecycle')
    const wrongAccessibleProfile = await request(appWith(db)).get('/api/applications/app-wrong-accessible/lifecycle')
    const poisonedSubject = await request(appWith(db)).get('/api/applications/app-poisoned-subject/lifecycle')

    expect(foreignTenant.status).toBe(403)
    expect(wrongAccessibleProfile.status).toBe(403)
    expect(poisonedSubject.status).toBe(403)
    expect(JSON.stringify(foreignTenant.body)).not.toContain('other-tenant-budget.pdf')
    expect(JSON.stringify(foreignTenant.body)).not.toContain('OTHER TENANT SECRET')
    expect(JSON.stringify(poisonedSubject.body)).not.toContain('other-tenant-budget.pdf')
  })

  it('rejects a poisoned legacy grant pointer before grounding can join or persist draft coverage', async () => {
    db = makeDb()
    const response = await request(appWith(db))
      .post('/api/applications/app-poisoned/grounding-audit')
      .send({ draft_id: 'secret-draft', draft_text: 'OTHER TENANT SECRET' })

    expect(response.status).toBe(403)
    expect(JSON.stringify(response.body)).not.toContain('OTHER TENANT SECRET')
  })
})
