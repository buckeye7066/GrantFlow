/**
 * adminKnowledgeIngestUrl.test.js
 *
 * POST /api/admin/knowledge/ingest-url — the admin Knowledge Base
 * "Ingest from URL" feature (owner defect report 2026-08-14: the browser
 * showed a bare 400 on one attempt and a bare 415 on another).
 *
 * Root causes under regression here:
 *   • 415 — the download allowlist was the KB DOCUMENT mime list
 *     (PDF/Word/images) + octet-stream; text/html was absent, so ingesting
 *     any ordinary WEB PAGE — the primary use of a URL-ingest box — failed
 *     with unsupported_content_type → 415. The route's own Accept header
 *     requested text/html, so the intent had drifted from the allowlist.
 *   • 400 — a bare domain typed without a scheme ("example.org/grants")
 *     reached isSafeUrl unparseable, and an http:// URL reached
 *     https_required; both are normal inputs for a URL box and neither was
 *     normalized or explained.
 *
 * Contract now under test:
 *   • an HTML page ingests: 201, stored as text/html with extracted_text
 *     from the page body and the <title> as the default document name
 *   • scheme-less and http:// URLs are normalized to https:// server-side
 *   • a target serving a truly unsupported type still 415s, but the error
 *     NAMES the received content type (a bare reason token tells the admin
 *     nothing)
 *   • an unparseable URL still 400s with an actionable message
 *   • a direct PDF link still ingests (no regression)
 */
import express from 'express'
import request from 'supertest'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

// Route the real fetchPublicResource pipeline (isSafeUrl, https-only, redirect
// and content-type policy) over a canned transport + DNS resolver, so the
// tests exercise the genuine validation/refusal logic without the network.
const fetchCalls = []
let fakeTransport = async () => {
  throw new Error('fakeTransport not configured')
}

vi.mock('../utils/safeRemoteFetch.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchPublicResource: (url, opts = {}) => {
      fetchCalls.push(url)
      return actual.fetchPublicResource(url, {
        ...opts,
        resolve: async () => ['93.184.216.34'],
        transport: (current, transportOpts) => fakeTransport(current, transportOpts),
      })
    },
  }
})

const adminRouter = (await import('../routes/admin.js')).default

const uploadsDir = await fsp.mkdtemp(join(os.tmpdir(), 'gf-kb-ingest-test-'))

afterAll(async () => {
  await fsp.rm(uploadsDir, { recursive: true, force: true }).catch(() => {})
})

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      organization_id TEXT,
      grant_id TEXT,
      profile_id TEXT,
      name TEXT NOT NULL,
      type TEXT,
      file_url TEXT,
      file_path TEXT,
      file_size INTEGER,
      mime_type TEXT,
      extracted_text TEXT,
      processing_status TEXT,
      notes TEXT
    );
  `)
  return db
}

function createApp(db) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.uploadsDir = uploadsDir
    req.user = { id: 'admin-1', userId: 'admin-1', role: 'admin', is_admin: 1 }
    req.ctx = { userId: 'admin-1', isAdmin: true }
    next()
  })
  app.use('/api/admin', adminRouter)
  return app
}

function htmlResponse(body, contentType = 'text/html; charset=utf-8') {
  const buffer = Buffer.from(body, 'utf8')
  return {
    status: 200,
    headers: { 'content-type': contentType, 'content-length': String(buffer.length) },
    body: buffer,
  }
}

const SAMPLE_PAGE = `<!doctype html>
<html>
  <head><title>Tennessee HOPE Scholarship — Award Rules</title><style>.x{color:red}</style></head>
  <body>
    <nav>Home | About</nav>
    <script>console.log('tracker')</script>
    <main>
      <h1>Tennessee HOPE Scholarship</h1>
      <p>Award amounts are $2,850 per semester for university students meeting the GPA requirement.</p>
    </main>
    <footer>Copyright</footer>
  </body>
</html>`

describe('POST /api/admin/knowledge/ingest-url', () => {
  beforeEach(() => {
    fetchCalls.length = 0
    fakeTransport = async () => {
      throw new Error('fakeTransport not configured')
    }
  })

  it('ingests an ordinary web page (text/html) instead of 415ing on it', async () => {
    fakeTransport = async () => htmlResponse(SAMPLE_PAGE)
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'https://example.org/hope-scholarship' })

      expect(res.status).toBe(201)
      expect(res.body.ok).toBe(true)
      const doc = res.body.document
      expect(doc.mime_type).toBe('text/html')
      // The page <title> becomes the default name when the admin gives none.
      expect(doc.name).toBe('Tennessee HOPE Scholarship — Award Rules')
      // Real text extraction ran: page copy present, chrome/script stripped.
      expect(doc.extracted_text).toContain('$2,850 per semester')
      expect(doc.extracted_text).not.toContain('tracker')
      expect(doc.processing_status).toBe('completed')
    } finally {
      db.close()
    }
  })

  it('normalizes a scheme-less URL to https:// instead of 400 unparseable', async () => {
    fakeTransport = async () => htmlResponse(SAMPLE_PAGE)
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'example.org/hope-scholarship' })

      expect(res.status).toBe(201)
      expect(fetchCalls[0]).toBe('https://example.org/hope-scholarship')
    } finally {
      db.close()
    }
  })

  it('upgrades http:// to https:// instead of 400 https_required', async () => {
    fakeTransport = async () => htmlResponse(SAMPLE_PAGE)
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'http://example.org/hope-scholarship' })

      expect(res.status).toBe(201)
      expect(fetchCalls[0]).toBe('https://example.org/hope-scholarship')
    } finally {
      db.close()
    }
  })

  it('still refuses a truly unsupported content type, but NAMES it in the error', async () => {
    fakeTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'video/mp4' },
      body: Buffer.from('0000', 'utf8'),
    })
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'https://example.org/video.mp4' })

      expect(res.status).toBe(415)
      expect(res.body.ok).toBe(false)
      expect(res.body.error).toContain('video/mp4')
      expect(res.body.code).toBe('REMOTE_FETCH_UNSUPPORTED_CONTENT_TYPE')
      // Nothing was stored for a refused ingest.
      expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('400s an unparseable URL with an actionable message, not a bare token', async () => {
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'not a real url' })

      expect(res.status).toBe(400)
      expect(res.body.ok).toBe(false)
      expect(res.body.error).toMatch(/valid URL/i)
    } finally {
      db.close()
    }
  })

  it('still ingests a direct PDF link (no regression)', async () => {
    // Not a parseable PDF body — extraction degrades to pending, but the
    // ingest itself must succeed and record the PDF identity.
    fakeTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 fake body for ingest test', 'utf8'),
    })
    const db = createDb()
    try {
      const res = await request(createApp(db))
        .post('/api/admin/knowledge/ingest-url')
        .send({ url: 'https://example.org/rules.pdf', name: 'Rules PDF' })

      expect(res.status).toBe(201)
      expect(res.body.document.mime_type).toBe('application/pdf')
      expect(res.body.document.name).toBe('Rules PDF')
      expect(res.body.document.file_url).toMatch(/^\/uploads\/kb-.*\.pdf$/)
    } finally {
      db.close()
    }
  })
})
