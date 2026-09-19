import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}), resolve: vi.fn() }))
vi.mock('../services/crawlerDispatcher.js', async () => ({ ...await vi.importActual('../services/crawlerDispatcher.js'), dispatchCrawlerJob: mock.dispatch }))
vi.mock('../utils/profileResolver.js', async () => ({ ...await vi.importActual('../utils/profileResolver.js'), resolveProfileForId: mock.resolve }))
import { createCrawlerJob } from '../services/crawlerJobCreation.js'
import { adminCrawlerRetry } from '../services/anyaAdminTools.js'
import { initializeAnyaOnLogin } from '../services/anyaLoginTrigger.js'
import { repairOrphanedJobProfiles } from '../utils/repairOrphanedJobProfiles.js'
import * as policy from '../services/ownerAi/ownerAiScope.js'
let db
const request = () => ({ ctx: { identityResolved: true, isAdmin: true, userId: 'owner-proof', email: 'owner@example.test' }, res: new EventEmitter() })
const ownerJob = async (profileId = null) => policy.runWithOwnerAiScope(request(), () => createCrawlerJob(db, { type: 'document_ingest', profileId, buildSnapshot: false, skipIdempotencyCheck: true }))
const rowFor = id => db.prepare('SELECT * FROM crawler_jobs WHERE id = ?').get(id)
beforeEach(() => {
  vi.stubEnv('OWNER_AI_EMAIL', 'owner@example.test'); vi.stubEnv('OWNER_AI_USER_ID', '')
  vi.stubEnv('ADMIN_EMAIL', 'platform-admin@example.test'); vi.stubEnv('ADMIN_EMAILS', '')
  vi.stubEnv('AUTH_JWT_SECRET', 'durable-proof-fixture-key-more-than-thirty-two-characters')
  db = new Database(':memory:'); db.dialect = 'sqlite'
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  db.prepare('INSERT INTO users (id, primary_email, is_admin) VALUES (?, ?, ?)').run('owner-proof', 'owner@example.test', 1)
  mock.resolve.mockReset(); mock.dispatch.mockClear()
})
afterEach(async () => { await new Promise(resolve => setImmediate(resolve)); db.close(); vi.unstubAllEnvs() })
it.each(['demoted', 'deleted'])('recovered owner work refuses an account that was %s', async action => {
  const created = await ownerJob(); const row = rowFor(created.jobId)
  if (action === 'demoted') db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run('owner-proof')
  else db.prepare('DELETE FROM users WHERE id = ?').run('owner-proof')
  await expect(Promise.resolve().then(() => policy.durableOwnerAiRunner(row, db))).rejects.toThrow(/owner|policy|revoked/i)
})
it('supports the same JWT_SECRET fallback as the authentication layer', async () => {
  vi.stubEnv('AUTH_JWT_SECRET', ''); vi.stubEnv('JWT_SECRET', 'jwt-fallback-fixture-key-that-is-not-a-production-credential')
  const created = await ownerJob()
  expect(JSON.parse(rowFor(created.jobId).parameters)._owner_ai.signature).toMatch(/^[a-f0-9]{64}$/)
})
it('an owner manually retrying customer work does not change its billing identity', async () => {
  const original = await createCrawlerJob(db, { type: 'document_ingest', buildSnapshot: false })
  const result = await policy.runWithOwnerAiScope(request(), () => adminCrawlerRetry({ jobId: original.jobId }, { db }))
  expect(JSON.parse(rowFor(result.new_job_id).parameters)._owner_ai).toBeUndefined()
})
it('an ordinary administrator retrying owner work preserves its validated durable intent', async () => {
  const original = await ownerJob()
  const result = await policy.runWithoutOwnerAiScope(() => adminCrawlerRetry({ jobId: original.jobId }, { db }))
  const retry = rowFor(result.new_job_id)
  expect(JSON.parse(retry.parameters)._owner_ai).toBeDefined()
  const runner = await policy.durableOwnerAiRunner(retry, db)
  expect(await runner(() => Boolean(policy.getOwnerAiScope()), { timeoutMs: 1000 })).toBe(true)
  expect(result.new_job.parameters._owner_ai).toBeUndefined()
})
it('owner proof never appears in public retry responses', async () => {
  const original = await ownerJob()
  const result = await policy.runWithOwnerAiScope(request(), () => adminCrawlerRetry({ jobId: original.jobId }, { db }))
  expect(JSON.parse(rowFor(result.new_job_id).parameters)._owner_ai).toBeDefined()
  expect(JSON.stringify(result)).not.toContain('_owner_ai')
  expect(JSON.stringify(result)).not.toContain('owner@example.test')
})
it('cold-login jobs derive owner intent from the verified database account', async () => {
  // Supply the legacy flat profile fields this existing login service reads.
  const columns = new Set(db.prepare('PRAGMA table_info(profiles)').all().map(row => row.name))
  for (const name of ['state', 'zip_code', 'needs', 'applicant_type', 'military', 'education', 'health', 'housing', 'business', 'family', 'emergency']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE profiles ADD COLUMN ${name} TEXT`)
  }
  db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)').run('login-profile', 'Synthetic login profile', 'individual')
  const user = { id: 'owner-proof', primary_email: 'owner@example.test', is_admin: 1, role: 'admin' }
  await policy.runWithoutOwnerAiScope(() => initializeAnyaOnLogin(db, user, 'login-profile'))
  const job = db.prepare("SELECT * FROM crawler_jobs WHERE type = 'profile_enrichment'").get()
  expect(job).toBeDefined(); expect(JSON.parse(job.parameters)._owner_ai).toBeDefined()
})
it('boot alias repair re-signs a valid original owner job for its canonical profile', async () => {
  db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)').run('canonical-profile', 'Synthetic canonical profile', 'individual')
  const original = await ownerJob()
  const job = rowFor(original.jobId)
  const stale = { ...job, profile_id: 'stale-profile' }
  const parameters = await policy.runWithOwnerAiScope(request(), () => policy.ownerAiJobParameters({}, stale))
  db.pragma('foreign_keys = OFF')
  db.prepare("UPDATE crawler_jobs SET profile_id = ?, parameters = ?, status = 'failed', error = ? WHERE id = ?").run('stale-profile', JSON.stringify(parameters), 'Profile stale-profile not found', job.id)
  mock.resolve.mockResolvedValue({ resolvedId: 'canonical-profile', originalId: 'stale-profile', repaired: true, strategy: 'fixture' })
  const repair = await repairOrphanedJobProfiles(db, { log: () => {} })
  expect(repair.repaired).toBe(1)
  const fixed = rowFor(job.id); expect(fixed.profile_id).toBe('canonical-profile')
  const restored = await policy.durableOwnerAiRunner(fixed, db)
  expect(await restored(() => Boolean(policy.getOwnerAiScope()), { timeoutMs: 1000 })).toBe(true)
})

it('HTTP job detail and list never publish signed owner billing provenance', async () => {
  const express = (await import('express')).default
  const router = (await import('../routes/crawlers.js')).default
  const created = await ownerJob()
  const app = express()
  app.use((req, res, next) => { req.db = db; req.user = { userId: 'owner-proof' }; req.ctx = request().ctx; next() })
  app.use('/crawlers', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    for (const path of ['/jobs', '/jobs/' + created.jobId]) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/crawlers' + path)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain('_owner_ai'); expect(text).not.toContain('owner@example.test')
    }
    expect(JSON.parse(rowFor(created.jobId).parameters)._owner_ai).toBeDefined()
  } finally { await new Promise(resolve => server.close(resolve)) }
})
it('database failures cannot restore or silently charge an owner job', async () => {
  const created = await ownerJob()
  const failedDb = { prepare() { throw new Error('fixture database unavailable') } }
  await expect(policy.durableOwnerAiRunner(rowFor(created.jobId), failedDb)).rejects.toThrow(/policy|owner/i)
})
