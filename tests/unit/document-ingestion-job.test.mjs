import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import { processDocumentIngestionJob } from '../../backend/services/documentIngestion.js'

function createMockOpenAI({ responseJsonBySectionKey = {} } = {}) {
  return {
    chat: {
      completions: {
        create: async ({ messages }) => {
          const prompt = String(messages?.[1]?.content || '')
          // Section key is embedded in prompt: `Your task is to suggest updated values for the "<Title>" section ...`
          // We keep this extremely simple and default to basic_information fields.
          const match = prompt.match(/suggest updated values for the "([^"]+)"/i)
          const title = match?.[1] || ''

          const payload =
            responseJsonBySectionKey[title] ??
            responseJsonBySectionKey.default ??
            {
              full_name: 'Smoke User',
              email: 'smoke.user@example.com',
              phone: '555-555-1212',
            }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify(payload),
                },
              },
            ],
          }
        },
      },
    },
  }
}

async function withTempSqliteDb() {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'grantflow-doc-ingest-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      organization_id TEXT,
      name TEXT,
      type TEXT,
      status TEXT,
      notes TEXT,
      extracted_text TEXT,
      processing_status TEXT,
      processing_error TEXT,
      ai_summary TEXT,
      ai_sections TEXT,
      file_path TEXT,
      mime_type TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_by TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
  `)

  return {
    dir,
    db,
    close: async () => {
      try {
        db.close()
      } finally {
        await fsp.rm(dir, { recursive: true, force: true })
      }
    },
  }
}

test('document_ingest job: updates profile sections and marks document ready for review', async () => {
  const { db, close } = await withTempSqliteDb()
  try {
    const profileId = 'profile-1'
    const documentId = 'doc-1'

    db.prepare('INSERT INTO profiles (id) VALUES (?)').run(profileId)
    db.prepare(
      `
        INSERT INTO documents (id, profile_id, name, type, status, extracted_text, processing_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      documentId,
      profileId,
      'sample.pdf',
      'source_material',
      'draft',
      'Name: Smoke User\nEmail: smoke.user@example.com\nPhone: 555-555-1212',
      'pending',
    )

    const result = await processDocumentIngestionJob({
      db,
      job: { id: 'job-1', parameters: { document_id: documentId, handwriting: true } },
      profileContext: { profile: { id: profileId }, sections: {} },
      getOpenAI: () => createMockOpenAI(),
      uploadDir: null,
    })

    assert.equal(result?.document_id, documentId)

    const docRow = db.prepare('SELECT processing_status, status, ai_summary, ai_sections FROM documents WHERE id = ?').get(documentId)
    assert.equal(docRow.processing_status, 'completed')
    assert.equal(docRow.status, 'review')
    assert.ok(typeof docRow.ai_summary === 'string' && docRow.ai_summary.length > 0)
    assert.ok(typeof docRow.ai_sections === 'string' && docRow.ai_sections.length > 0)

    const sectionRow = db
      .prepare('SELECT section_key, data, updated_by FROM profile_sections WHERE profile_id = ? AND section_key = ?')
      .get(profileId, 'basic_information')

    assert.equal(sectionRow.section_key, 'basic_information')
    assert.ok(String(sectionRow.updated_by || '').startsWith(`document:${documentId}`))

    const data = JSON.parse(sectionRow.data)
    assert.equal(data.email, 'smoke.user@example.com')
    assert.equal(data.full_name, 'Smoke User')
  } finally {
    await close()
  }
})

