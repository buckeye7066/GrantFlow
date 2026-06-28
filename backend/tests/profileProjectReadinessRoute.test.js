import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

const profilesRouter = (await import('../routes/profiles.js')).default

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.ctx = { userId: 'admin-1', isAdmin: true, accessibleProfileIds: null }
    next()
  })
  app.use('/api/profiles', profilesRouter)
  return app
}

describe('profile project readiness route', () => {
  it('returns a plan with direct documents when optional linked-document schema is absent', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT
        );

        CREATE TABLE profiles (
          id TEXT PRIMARY KEY,
          created_at TEXT,
          updated_at TEXT,
          created_by TEXT,
          organization_id TEXT,
          user_id TEXT,
          primary_type TEXT,
          display_name TEXT,
          status TEXT,
          tags TEXT,
          avatar_url TEXT
        );

        CREATE TABLE profile_sections (
          profile_id TEXT NOT NULL,
          section_key TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT,
          updated_by TEXT
        );

        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          profile_id TEXT,
          name TEXT,
          type TEXT,
          mime_type TEXT,
          extracted_text TEXT,
          ai_summary TEXT,
          notes TEXT,
          processing_status TEXT,
          created_at TEXT
        );
      `)

      db.prepare(`
        INSERT INTO profiles (
          id, created_at, updated_at, created_by, organization_id, user_id,
          primary_type, display_name, status, tags, avatar_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'profile-1',
        '2026-06-20T00:00:00.000Z',
        '2026-06-20T00:00:00.000Z',
        'admin-1',
        null,
        'user-1',
        'high_school_student',
        'Ready Student',
        'active',
        '[]',
        null,
      )

      db.prepare(`
        INSERT INTO profile_sections (profile_id, section_key, data, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'profile-1',
        'education',
        JSON.stringify({ school_name: 'State University', field_of_study: 'Nursing' }),
        '2026-06-20T00:00:00.000Z',
        'admin-1',
      )

      db.prepare(`
        INSERT INTO documents (
          id, profile_id, name, type, mime_type, extracted_text,
          ai_summary, notes, processing_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'doc-1',
        'profile-1',
        'Proof packet.pdf',
        'student_record',
        'application/pdf',
        'FAFSA and enrollment proof are available.',
        'Student proof packet',
        '{}',
        'completed',
        '2026-06-21T00:00:00.000Z',
      )

      const res = await request(createApp(db)).get('/api/profiles/profile-1/project-readiness-plan')

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.plan.profile_id).toBe('profile-1')
      expect(res.body.plan.document_evidence).toContainEqual(
        expect.objectContaining({ id: 'doc-1', name: 'Proof packet.pdf' }),
      )
    } finally {
      db.close()
    }
  })

  it('does not silently drop evidence when the direct documents table is unavailable', async () => {
    const db = new Database(':memory:')
    try {
      db.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT
        );

        CREATE TABLE profiles (
          id TEXT PRIMARY KEY,
          created_at TEXT,
          updated_at TEXT,
          created_by TEXT,
          organization_id TEXT,
          user_id TEXT,
          primary_type TEXT,
          display_name TEXT,
          status TEXT,
          tags TEXT,
          avatar_url TEXT
        );

        CREATE TABLE profile_sections (
          profile_id TEXT NOT NULL,
          section_key TEXT NOT NULL,
          data TEXT NOT NULL,
          updated_at TEXT,
          updated_by TEXT
        );
      `)

      db.prepare(`
        INSERT INTO profiles (
          id, created_at, updated_at, created_by, organization_id, user_id,
          primary_type, display_name, status, tags, avatar_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'profile-broken-docs',
        '2026-06-20T00:00:00.000Z',
        '2026-06-20T00:00:00.000Z',
        'admin-1',
        null,
        'user-1',
        'individual',
        'Evidence Required',
        'active',
        '[]',
        null,
      )

      const res = await request(createApp(db)).get('/api/profiles/profile-broken-docs/project-readiness-plan')

      expect(res.status).toBe(500)
    } finally {
      db.close()
    }
  })
})
