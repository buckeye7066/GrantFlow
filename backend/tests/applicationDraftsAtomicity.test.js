import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const persistDraftRequirementCoverageFailure = vi.hoisted(() => vi.fn())

vi.mock('../services/groundedDrafting.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    persistDraftRequirementCoverage: persistDraftRequirementCoverageFailure,
  }
})

describe('application draft write atomicity', () => {
  let app
  let db

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.DB_PROVIDER = 'sqlite'
    process.env.SQLITE_DB_PATH = ':memory:'

    const [{ SqliteDb }, { default: applicationDraftsRouter }] = await Promise.all([
      import('../db/index.js'),
      import('../routes/applicationDrafts.js'),
    ])

    db = new SqliteDb(':memory:')
    db.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT
      );
      CREATE TABLE profile_sections (
        profile_id TEXT NOT NULL,
        section_key TEXT NOT NULL,
        data TEXT
      );
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        organization_id TEXT,
        funding_opportunity_id TEXT
      );
      CREATE TABLE grant_applications (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT,
        pipeline_grant_id TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        grant_id TEXT,
        name TEXT,
        type TEXT,
        mime_type TEXT,
        status TEXT,
        version INTEGER,
        content_hash TEXT,
        file_bytes BLOB,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE application_drafts (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        section_name TEXT,
        section_order INTEGER,
        prompt TEXT,
        content TEXT,
        ai_suggestions TEXT,
        word_limit INTEGER,
        word_count INTEGER,
        status TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)

    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.db = db
      req.user = { id: 'user-1', role: 'user' }
      req.ctx = {
        isAdmin: true,
        identityResolved: true,
        accessibleProfileIds: null,
        accessibleOrgIds: null,
      }
      next()
    })
    app.use('/api/application-drafts', applicationDraftsRouter)
  })

  beforeEach(() => {
    persistDraftRequirementCoverageFailure.mockReset()
    const error = new Error('simulated coverage persistence failure')
    error.code = 'GROUNDING_COVERAGE_PERSIST_FAILED'
    persistDraftRequirementCoverageFailure.mockRejectedValue(error)

    db.exec(`
      DELETE FROM application_drafts;
      DELETE FROM grant_applications;
      DELETE FROM grants;
      DELETE FROM profile_sections;
      DELETE FROM profiles;
    `)
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)')
      .run('profile-1', 'Atomicity Test Applicant')
    db.prepare('INSERT INTO grants (id, profile_id, organization_id) VALUES (?, ?, ?)')
      .run('grant-1', 'profile-1', 'org-1')
    db.prepare(
      'INSERT INTO grant_applications (id, profile_id, pipeline_grant_id) VALUES (?, ?, ?)',
    ).run('application-1', 'profile-1', 'grant-1')
    db.prepare(
      `INSERT INTO application_drafts
        (id, grant_id, section_name, section_order, prompt, content,
         ai_suggestions, word_limit, word_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'draft-1',
      'grant-1',
      'Need statement',
      1,
      'Describe the need.',
      'Original draft text.',
      'Original suggestion.',
      500,
      3,
      'draft',
    )
  })

  afterAll(() => {
    db?.close()
  })

  it('rolls back every application_drafts change when coverage persistence fails', async () => {
    const before = db.prepare('SELECT * FROM application_drafts WHERE id = ?').get('draft-1')

    const response = await request(app)
      .put('/api/application-drafts/draft-1')
      .send({
        section_name: 'Changed section',
        section_order: 9,
        prompt: 'Changed prompt.',
        content: 'Changed draft text.',
        ai_suggestions: 'Changed suggestion.',
        word_limit: 900,
        word_count: 4,
        status: 'review',
        requirement_responses: [],
        claim_evidence: [],
      })

    expect(response.status).toBe(500)
    expect(response.body.error).toBe('GROUNDING_COVERAGE_PERSIST_FAILED')
    expect(persistDraftRequirementCoverageFailure).toHaveBeenCalledOnce()
    expect(persistDraftRequirementCoverageFailure.mock.calls[0][0]).toBe(db)
    expect(persistDraftRequirementCoverageFailure.mock.calls[0][1]).toMatchObject({
      applicationId: 'application-1',
      draftId: 'draft-1',
    })

    const after = db.prepare('SELECT * FROM application_drafts WHERE id = ?').get('draft-1')
    expect(after).toEqual(before)
    expect(after.status).toBe('draft')
    expect(after.content).toBe('Original draft text.')
  })
})
