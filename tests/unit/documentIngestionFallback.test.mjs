import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { processDocumentIngestionJob } from '../../backend/services/documentIngestion.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      primary_type TEXT
    );

    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(profile_id, section_key)
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      name TEXT NOT NULL,
      type TEXT,
      extracted_text TEXT,
      file_path TEXT,
      mime_type TEXT,
      processing_status TEXT DEFAULT 'pending',
      processing_error TEXT,
      ai_summary TEXT,
      ai_sections TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','review','final','submitted')),
      university_application_id TEXT,
      university_application_name TEXT
    );
  `)
  return db
}

test('documentIngestion: fallback completes when OpenAI missing and updates university status', async () => {
  const db = createDb()

  const profileId = 'p1'
  db.prepare(`INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)`).run(
    profileId,
    'Student One',
    'high_school_student',
  )

  const applicationId = 'u1'
  const universityPayload = {
    applications: [
      {
        id: applicationId,
        name: 'The Ohio State University',
        status: 'planning',
        financial_aid_pipeline: [],
      },
    ],
  }
  db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, 'university_applications', ?, ?)`,
  ).run(profileId, JSON.stringify(universityPayload), 'seed')

  const docId = 'd1'
  db.prepare(
    `
      INSERT INTO documents (id, profile_id, name, type, extracted_text, status, university_application_id, university_application_name)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
    `,
  ).run(
    docId,
    profileId,
    'OSU Acceptance Letter.pdf',
    'university_acceptance_letter',
    `
      Congratulations!
      The Ohio State University is pleased to offer you admission for the Fall term.
    `,
    applicationId,
    'The Ohio State University',
  )

  const job = { parameters: { document_id: docId } }
  const profileContext = {
    profile: { id: profileId },
    sections: {
      university_applications: universityPayload,
    },
  }

  const res = await processDocumentIngestionJob({
    db,
    job,
    profileContext,
    getOpenAI: () => {
      throw new Error('OpenAI is not configured. Set OPENAI_API_KEY')
    },
    uploadDir: '.',
  })

  assert.equal(res.document_id, docId)

  const docRow = db.prepare(`SELECT processing_status, status, ai_summary FROM documents WHERE id = ?`).get(docId)
  assert.equal(docRow.processing_status, 'completed')
  assert.equal(docRow.status, 'draft') // must not violate DB CHECK constraint
  assert.ok(docRow.ai_summary && docRow.ai_summary.includes('Parsed locally'))

  const sectionRow = db
    .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'university_applications'`)
    .get(profileId)
  const updated = JSON.parse(sectionRow.data)
  assert.equal(updated.applications[0].status, 'accepted')
})

