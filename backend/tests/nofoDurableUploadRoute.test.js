import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readValidatedUploadBytes,
  verifyDurableDocumentBytes,
} from '../services/durableDocumentBytes.js'

const routeMocks = vi.hoisted(() => ({
  fetchPublicResource: vi.fn(),
  pdfParse: vi.fn(async (buffer) => ({ text: buffer.toString('utf8') })),
  extractDocx: vi.fn(async ({ buffer }) => ({ value: buffer.toString('utf8') })),
  createCompletion: vi.fn(async () => ({
    choices: [{
      message: {
        content: JSON.stringify({
          opportunity: {
            title: 'Durable Community Program',
            funder: 'Example Foundation',
            program_description: 'Supports community programs.',
          },
          requirements: [],
        }),
      },
    }],
  })),
}))

vi.mock('pdf-parse', () => ({ default: routeMocks.pdfParse }))
vi.mock('mammoth', () => ({ default: { extractRawText: routeMocks.extractDocx } }))
vi.mock('../utils/safeRemoteFetch.js', () => ({
  fetchPublicResource: routeMocks.fetchPublicResource,
  publicFetchFailureStatus: vi.fn(() => 502),
}))
vi.mock('../utils/openaiClient.js', () => ({
  createOpenAIClient: vi.fn(() => ({
    openai: { chat: { completions: { create: routeMocks.createCompletion } } },
  })),
  summarizeOpenAIError: vi.fn((error) => ({ message: error?.message || String(error) })),
}))
vi.mock('../services/opportunityMatcher.js', () => ({ saveToProfilePipeline: vi.fn() }))
vi.mock('../services/profileHelpers.js', () => ({ loadProfileContext: vi.fn() }))

delete process.env.ANTHROPIC_API_KEY

const Database = (await import('better-sqlite3')).default
const { attachRequestContext } = await import('../middleware/requestContext.js')
const nofoRouter = (await import('../routes/nofo.js')).default

const here = dirname(fileURLToPath(import.meta.url))

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
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, mime_type TEXT,
      file_size INTEGER, file_bytes BLOB, content_hash TEXT
    );

    INSERT INTO users (id, primary_email) VALUES
      ('user-1', 'owner@example.test'),
      ('user-2', 'other@example.test');
    INSERT INTO profiles (id, user_id, created_by, display_name) VALUES
      ('profile-1', 'user-1', 'user-1', 'Authorized profile'),
      ('profile-2', 'user-2', 'user-2', 'Other tenant');
  `)
  return db
}

function addDocument(db, { id, profileId, name, mimeType, bytes, contentHash = null }) {
  const digest = contentHash || createHash('sha256').update(bytes).digest('hex')
  db.prepare(
    `INSERT INTO documents
      (id, profile_id, name, mime_type, file_size, file_bytes, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, profileId, name, mimeType, bytes.length, bytes, digest)
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
const temporaryDirectories = []
afterEach(() => {
  db?.close()
  db = null
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

describe('durable document byte integrity', () => {
  it('returns only the exact bytes approved by upload security validation', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'grantflow-nofo-upload-'))
    temporaryDirectories.push(directory)
    const path = resolve(directory, 'notice.pdf')
    const bytes = Buffer.from('%PDF-1.4\nValidated upload bytes.')
    const digest = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(path, bytes)

    const durable = await readValidatedUploadBytes({
      path,
      size: bytes.length,
      securityValidation: { sha256: digest },
    })

    expect(durable.bytes).toEqual(bytes)
    expect(durable.contentHash).toBe(digest)
    expect(verifyDurableDocumentBytes({
      file_bytes: durable.bytes,
      file_size: bytes.length,
      content_hash: durable.contentHash,
    }).bytes).toEqual(bytes)
  })

  it('rejects bytes that changed after the security scan', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'grantflow-nofo-upload-'))
    temporaryDirectories.push(directory)
    const path = resolve(directory, 'notice.pdf')
    const original = Buffer.from('%PDF-1.4\nOriginal bytes.')
    const changed = Buffer.from('%PDF-1.4\nChanged bytes!')
    writeFileSync(path, changed)

    await expect(readValidatedUploadBytes({
      path,
      size: changed.length,
      securityValidation: {
        sha256: createHash('sha256').update(original).digest('hex'),
      },
    })).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY_MISMATCH', status: 422 })
  })
})

describe('POST /api/parseNOFO durable document path', () => {
  it.each([
    {
      id: 'pdf-doc',
      name: 'notice.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\nFull PDF solicitation text.'),
      method: 'pdf-parse',
    },
    {
      id: 'docx-doc',
      name: 'notice.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: Buffer.from('PK\u0003\u0004Full DOCX solicitation text.'),
      method: 'mammoth',
    },
  ])('extracts authorized $name bytes without self-fetching a public URL', async (fixture) => {
    db = makeDb()
    addDocument(db, { ...fixture, profileId: 'profile-1' })

    const response = await request(appWith(db))
      .post('/api/parseNOFO')
      .send({
        document_id: fixture.id,
        profile_id: 'profile-1',
        file_url: 'http://127.0.0.1:5179/uploads/private-file',
        source_filename: 'spoofed-name.pdf',
        mime_type: 'text/plain',
      })

    expect(response.status).toBe(200)
    expect(response.body.success).toBe(true)
    expect(response.body.solicitation_draft).toMatchObject({
      document_id: fixture.id,
      source_url: null,
      source_filename: fixture.name,
      mime_type: fixture.mimeType,
    })
    expect(response.body.extraction_meta.source_extraction_method).toBe(fixture.method)
    expect(routeMocks.fetchPublicResource).not.toHaveBeenCalled()
  })

  it('rejects a document owned by another profile before reading its bytes', async () => {
    db = makeDb()
    addDocument(db, {
      id: 'foreign-doc',
      profileId: 'profile-2',
      name: 'private.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\nOther tenant secret.'),
    })

    const response = await request(appWith(db))
      .post('/api/parseNOFO')
      .send({ document_id: 'foreign-doc', profile_id: 'profile-2' })
    const scopedLookup = await request(appWith(db))
      .post('/api/parseNOFO')
      .send({ document_id: 'foreign-doc', profile_id: 'profile-1' })

    expect(response.status).toBe(403)
    expect(scopedLookup.status).toBe(404)
    expect(routeMocks.pdfParse).not.toHaveBeenCalled()
    expect(routeMocks.fetchPublicResource).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain('Other tenant secret')
  })

  it('fails closed when durable bytes do not match their stored SHA-256', async () => {
    db = makeDb()
    addDocument(db, {
      id: 'tampered-doc',
      profileId: 'profile-1',
      name: 'tampered.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\nTampered bytes.'),
      contentHash: '0'.repeat(64),
    })

    const response = await request(appWith(db))
      .post('/api/parseNOFO')
      .send({ document_id: 'tampered-doc', profile_id: 'profile-1' })

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('NOFO_DOCUMENT_INTEGRITY_FAILED')
    expect(routeMocks.pdfParse).not.toHaveBeenCalled()
    expect(routeMocks.fetchPublicResource).not.toHaveBeenCalled()
  })
})

describe('NOFO parser UI durable upload contract', () => {
  it('uploads the document field with a profile and parses by document_id, never Core.UploadFile', () => {
    const source = readFileSync(resolve(here, '../../src/pages/NOFOParser.jsx'), 'utf8')
    expect(source).toContain("uploadPayload.append('document', file)")
    expect(source).toContain("uploadPayload.append('profile_id', selectedProfileId)")
    expect(source).toContain('document_id: uploadedDocumentId')
    expect(source).toContain("profile_id: inputMode === 'file' ? selectedProfileId : null")
    expect(source).not.toContain('client.integrations.Core.UploadFile')
  })

  it('keeps the diagnostics caller on the same profile-bound durable path', () => {
    const source = readFileSync(resolve(here, '../../src/pages/Diagnostics.jsx'), 'utf8')
    expect(source).toContain("uploadPayload.append('document', testFile)")
    expect(source).toContain("uploadPayload.append('profile_id', profileId)")
    expect(source).toContain('document_id: uploaded.id')
    expect(source).not.toContain('client.integrations.Core.UploadFile')
  })

  it('stores the validated bytes and digest in the document INSERT', () => {
    const source = readFileSync(resolve(here, '../routes/documents.js'), 'utf8')
    expect(source).toContain('readValidatedUploadBytes(file)')
    expect(source).toContain('file_url, file_path, file_size, mime_type, file_bytes, content_hash')
    expect(source).toContain('durableFileBytes')
    expect(source).toContain('durableContentHash')
  })
})
