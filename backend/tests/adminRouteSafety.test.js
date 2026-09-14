import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), encrypt: vi.fn(), opportunities: vi.fn(),
}))
vi.mock('../utils/openaiClient.js', async (importOriginal) => ({
  ...(await importOriginal()), createOpenAIClient: mocks.create,
}))
vi.mock('../utils/runtimeSecrets.js', async (importOriginal) => ({
  ...(await importOriginal()), encryptRuntimeSecret: mocks.encrypt,
}))
vi.mock('../services/knowledgeBaseProcessor.js', async (importOriginal) => ({
  ...(await importOriginal()), extractFundingOpportunitiesFromKB: mocks.opportunities,
}))
const adminRouter = (await import('../routes/admin.js')).default
const ACTIVE = 'unit-test-active-credential'
const CANDIDATE = 'unit-test-candidate-credential'
const originalKey = process.env.OPENAI_API_KEY
let db
let scratch
let uploadsDir

function createApp(database = db, { admin = true, authenticated = true, uploads = uploadsDir } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = database
    req.uploadsDir = uploads
    if (authenticated) {
      req.user = { id: 'test-user', userId: 'test-user', role: admin ? 'admin' : 'user', is_admin: admin ? 1 : 0 }
      req.ctx = { userId: 'test-user', isAdmin: admin }
    }
    next()
  })
  app.use('/api/admin', adminRouter)
  return app
}
function savedSecret() {
  return db.prepare('SELECT value_ciphertext FROM app_runtime_secrets WHERE key = ?').get('OPENAI_API_KEY').value_ciphertext
}
function applyKey(body = { apiKey: CANDIDATE }, database = db, options = {}) {
  return request(createApp(database, options)).post('/api/admin/openai/apply-key').send(body)
}
function addDocument(id, filePath = null, type = 'knowledge') {
  db.prepare('INSERT INTO documents (id, name, type, file_path) VALUES (?, ?, ?, ?)').run(id, id, type, filePath)
}
function deleteDocument(filePath, options = {}) {
  addDocument('delete-target', filePath)
  return request(createApp(db, options)).delete('/api/admin/knowledge/delete-target')
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE app_runtime_secrets (key TEXT PRIMARY KEY, value_ciphertext TEXT, iv TEXT, tag TEXT, updated_at TEXT); CREATE TABLE documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, file_path TEXT);')
  db.prepare('INSERT INTO app_runtime_secrets (key, value_ciphertext) VALUES (?, ?)').run('OPENAI_API_KEY', 'original-ciphertext')
  scratch = fs.mkdtempSync(join(os.tmpdir(), 'gf-admin-safety-'))
  uploadsDir = join(scratch, 'uploads')
  fs.mkdirSync(uploadsDir)
  process.env.OPENAI_API_KEY = ACTIVE
  mocks.list.mockReset().mockResolvedValue({ data: [{ id: 'test-model' }] })
  mocks.create.mockReset().mockImplementation(() => ({ openai: { models: { list: mocks.list } }, diagnostics: { present: true } }))
  mocks.encrypt.mockReset().mockReturnValue({ value_ciphertext: 'new-ciphertext', iv: 'test-iv', tag: 'test-tag' })
  mocks.opportunities.mockReset().mockResolvedValue([{ title: 'Test funding opportunity' }])
})
afterEach(() => {
  db.close()
  fs.rmSync(scratch, { recursive: true, force: true })
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalKey
  vi.restoreAllMocks()
})

describe('admin OpenAI key activation is verify-then-save-then-apply', () => {
  it('verifies the candidate without changing the active key or stored recovery key', async () => {
    let observed
    mocks.list.mockImplementation(async () => {
      observed = { active: process.env.OPENAI_API_KEY, saved: savedSecret() }
      return { data: [{ id: 'test-model' }] }
    })
    const res = await applyKey({ apiKey: CANDIDATE, persist: true })
    expect(res.status).toBe(200)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKeyOverride: CANDIDATE }))
    expect(observed).toEqual({ active: ACTIVE, saved: 'original-ciphertext' })
    expect(process.env.OPENAI_API_KEY).toBe(CANDIDATE)
    expect(savedSecret()).toBe('new-ciphertext')
    expect(res.body).toMatchObject({ ok: true, applied: true, persisted: true, sample_model: 'test-model' })
  })
  it.each([401, 403, 429, 500])('leaves both old keys intact after provider status %i', async (status) => {
    mocks.list.mockRejectedValue(Object.assign(new Error('Provider rejected verification'), { status }))
    const res = await applyKey({ apiKey: CANDIDATE, persist: true })
    expect(res.status).toBe(status === 401 || status === 403 ? 422 : 500)
    expect(res.body).toMatchObject({ ok: false, applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
    expect(mocks.encrypt).not.toHaveBeenCalled()
  })
  it('keeps an absent active key absent after failed verification', async () => {
    delete process.env.OPENAI_API_KEY
    mocks.list.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    const res = await applyKey()
    expect(res.status).toBe(422)
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('reports persistence failure rather than activating a key or claiming it was saved', async () => {
    const failingDb = { prepare(sql) {
      if (sql.includes('INSERT INTO app_runtime_secrets')) {
        return { run() { throw new Error('Database unavailable') } }
      }
      return db.prepare(sql)
    } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await applyKey({ apiKey: CANDIDATE, persist: true }, failingDb)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ ok: false, applied: false, persisted: false, code: 'RUNTIME_SECRET_PERSISTENCE_FAILED' })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('does not activate the key if encryption fails', async () => {
    mocks.encrypt.mockImplementation(() => { throw new Error('Encryption unavailable') })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await applyKey({ apiKey: CANDIDATE, persist: true })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('handles candidate-client construction failure without mutating either key', async () => {
    mocks.create.mockImplementation(() => { throw new Error('Invalid candidate configuration') })
    const res = await applyKey({ apiKey: CANDIDATE, persist: true })
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ ok: false, applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('can activate a verified key without changing the saved recovery key', async () => {
    const res = await applyKey()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, applied: true, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(CANDIDATE)
    expect(savedSecret()).toBe('original-ciphertext')
    expect(mocks.encrypt).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain(CANDIDATE)
  })
  it('rejects an empty key before any provider call or mutation', async () => {
    const res = await applyKey({ apiKey: '  ', persist: true })
    expect(res.status).toBe(400)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it.each([{ authenticated: false }, { admin: false }])('retains authorization for key changes: %j', async (options) => {
    const res = await applyKey({ apiKey: CANDIDATE, persist: true }, db, options)
    expect(res.status).toBe(options.authenticated === false ? 401 : 403)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
})

describe('generic OpenAI environment edits use the same verification gate', () => {
  function editKey(value, persist = true, database = db, options = {}) {
    return request(createApp(database, options)).post('/api/admin/env/apply').send({ key: 'OPENAI_API_KEY', value, persist })
  }
  it('rejects an invalid generic edit without changing either key', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    const res = await editKey(CANDIDATE)
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ ok: false, applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('verifies and persists a generic edit before activation and preserves its response fields', async () => {
    let activeDuringVerification
    mocks.list.mockImplementation(async () => {
      activeDuringVerification = process.env.OPENAI_API_KEY
      return { data: [] }
    })
    const res = await editKey(CANDIDATE)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ key: 'OPENAI_API_KEY', cleared: false, applied: true, persisted: true })
    expect(activeDuringVerification).toBe(ACTIVE)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ apiKeyOverride: CANDIDATE }))
    expect(savedSecret()).toBe('new-ciphertext')
    expect(process.env.OPENAI_API_KEY).toBe(CANDIDATE)
  })
  it('does not activate a generic edit when saving fails', async () => {
    const failingDb = { prepare(sql) {
      if (sql.includes('INSERT INTO app_runtime_secrets')) return { run() { throw new Error('DB unavailable') } }
      return db.prepare(sql)
    } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await editKey(CANDIDATE, true, failingDb)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('preserves intentional key clearing and removes recovery only when requested', async () => {
    const res = await editKey('')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ key: 'OPENAI_API_KEY', cleared: true, persisted: true })
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_runtime_secrets').get().n).toBe(0)
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('leaves both keys unchanged if persisted clearing fails', async () => {
    const failingDb = { prepare(sql) {
      if (sql.includes('DELETE FROM app_runtime_secrets')) return { run() { throw new Error('DB unavailable') } }
      return db.prepare(sql)
    } }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await editKey('', true, failingDb)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ applied: false, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('can clear only the active key without deleting recovery', async () => {
    const res = await editKey('', false)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ cleared: true, persisted: false })
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(savedSecret()).toBe('original-ciphertext')
  })
  it('keeps custom provider credential names deployment-managed', async () => {
    const res = await request(createApp()).post('/api/admin/env/apply').send({ key: 'FREE_AI_ROUTE_UNAPPROVED_API_KEY', value: CANDIDATE })
    expect(res.status).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('still rejects generic key changes from non-admin users', async () => {
    const res = await editKey(CANDIDATE, true, db, { admin: false })
    expect(res.status).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(process.env.OPENAI_API_KEY).toBe(ACTIVE)
  })
})

describe('admin knowledge route ordering', () => {
  it('routes opportunities to the collection handler even when that document id exists', async () => {
    addDocument('opportunities')
    const res = await request(createApp()).get('/api/admin/knowledge/opportunities')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, count: 1, opportunities: [{ title: 'Test funding opportunity' }] })
    expect(mocks.opportunities).toHaveBeenCalledWith(db)
  })
  it('still returns individual documents and 404 for a missing id', async () => {
    addDocument('doc-1')
    expect((await request(createApp()).get('/api/admin/knowledge/doc-1')).body.document.id).toBe('doc-1')
    expect((await request(createApp()).get('/api/admin/knowledge/not-found')).status).toBe(404)
  })
  it('does not expose opportunities to non-admin users', async () => {
    const res = await request(createApp(db, { admin: false })).get('/api/admin/knowledge/opportunities')
    expect(res.status).toBe(403)
    expect(mocks.opportunities).not.toHaveBeenCalled()
  })
})

describe('admin knowledge file deletion containment', () => {
  it('deletes a regular file within uploads', async () => {
    const target = join(uploadsDir, 'inside.txt')
    fs.writeFileSync(target, 'temporary test content')
    const res = await deleteDocument(target)
    expect(res.status).toBe(200)
    expect(res.body.deleted_file).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })
  it('does not mistake an uploads-prefixed sibling directory for uploads', async () => {
    const sibling = join(scratch, 'uploads-backup')
    fs.mkdirSync(sibling)
    const target = join(sibling, 'keep.txt')
    fs.writeFileSync(target, 'keep')
    const res = await deleteDocument(target)
    expect(res.status).toBe(200)
    expect(res.body.deleted_file).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })
  it('refuses traversal to a file outside uploads', async () => {
    const outside = join(scratch, 'outside.txt')
    fs.writeFileSync(outside, 'keep')
    const res = await deleteDocument(uploadsDir + '/../outside.txt')
    expect(res.body.deleted_file).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
  })
  it('refuses a directory symlink or Windows junction escaping uploads', async () => {
    const outside = join(scratch, 'outside')
    fs.mkdirSync(outside)
    const target = join(outside, 'keep.txt')
    fs.writeFileSync(target, 'keep')
    const link = join(uploadsDir, 'escape')
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const res = await deleteDocument(join(link, 'keep.txt'))
    expect(res.body.deleted_file).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep')
  })
  it('allows a configured uploads root that is itself a symlink or junction', async () => {
    const alias = join(scratch, 'uploads-alias')
    fs.symlinkSync(uploadsDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const target = join(uploadsDir, 'inside.txt')
    fs.writeFileSync(target, 'temporary test content')
    const res = await deleteDocument(join(alias, 'inside.txt'), { uploads: alias })
    expect(res.body.deleted_file).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })
  it('returns false for a missing file and never deletes the uploads root', async () => {
    const missing = await deleteDocument(join(uploadsDir, 'missing.txt'))
    expect(missing.body.deleted_file).toBe(false)
    db.prepare('DELETE FROM documents').run()
    const root = await deleteDocument(uploadsDir)
    expect(root.body.deleted_file).toBe(false)
    expect(fs.statSync(uploadsDir).isDirectory()).toBe(true)
  })
})
