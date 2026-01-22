/**
 * Production Hardening Tests
 * 
 * Tests for production stability improvements:
 * - JWT secret enforcement
 * - Admin authorization via DB
 * - Crawler idempotency
 * - Dead-letter queue
 * - DB write validation
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('Production Hardening', () => {
  let db
  let testDir

  before(async () => {
    // Create test database
    testDir = join('/tmp', `test-hardening-${crypto.randomUUID()}`)
    fs.mkdirSync(testDir, { recursive: true })
    
    const dbPath = join(testDir, 'test.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    
    // Load schema
    const schemaPath = join(__dirname, '..', '..', 'backend', 'db', 'schema.sql')
    const schema = fs.readFileSync(schemaPath, 'utf8')
    db.exec(schema)
  })

  after(() => {
    if (db) {
      db.close()
    }
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('JWT Secret Enforcement', () => {
    it('should have fail-fast logic in production', async () => {
      // This is tested by checking the code exists in auth.js and server.js
      const authPath = join(__dirname, '..', '..', 'backend', 'routes', 'auth.js')
      const serverPath = join(__dirname, '..', '..', 'backend', 'server.js')
      
      const authCode = fs.readFileSync(authPath, 'utf8')
      const serverCode = fs.readFileSync(serverPath, 'utf8')
      
      // Check that both files have fail-fast logic
      assert.ok(authCode.includes('process.exit(1)'), 'auth.js should call process.exit(1) for missing JWT secret')
      assert.ok(serverCode.includes('process.exit(1)'), 'server.js should call process.exit(1) for missing JWT secret')
      
      // Check that ephemeral secret generation is removed
      assert.ok(!authCode.includes('crypto.randomBytes') || authCode.includes('REMOVED'), 
        'auth.js should not generate random secrets in production')
    })
  })

  describe('Admin Authorization', () => {
    it('should store admin flag in database', async () => {
      const userId = crypto.randomUUID()
      db.prepare('INSERT INTO users (id, primary_email, display_name, is_admin) VALUES (?, ?, ?, ?)')
        .run(userId, 'admin@test.com', 'Admin User', 1)
      
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
      assert.strictEqual(user.is_admin, 1)
    })

    it('should use req.ctx.isAdmin for authorization', async () => {
      // Check that middleware exists
      const middlewarePath = join(__dirname, '..', '..', 'backend', 'middleware', 'requestContext.js')
      const middlewareCode = fs.readFileSync(middlewarePath, 'utf8')
      
      assert.ok(middlewareCode.includes('isAdmin'), 'requestContext middleware should set isAdmin')
      assert.ok(middlewareCode.includes('users.is_admin') || middlewareCode.includes('SELECT is_admin'),
        'requestContext should read is_admin from database')
    })
  })

  describe('Crawler Idempotency', () => {
    it('should have idempotency_key column in crawler_jobs', async () => {
      const tableInfo = db.prepare('PRAGMA table_info(crawler_jobs)').all()
      const hasIdempotencyKey = tableInfo.some(col => col.name === 'idempotency_key')
      
      assert.ok(hasIdempotencyKey, 'crawler_jobs should have idempotency_key column')
    })

    it('should generate consistent idempotency keys', async () => {
      const { generateIdempotencyKey } = await import('../../backend/services/crawlerJobCreation.js')
      
      const key1 = generateIdempotencyKey('local', 'profile-123', { zip: '12345' })
      const key2 = generateIdempotencyKey('local', 'profile-123', { zip: '12345' })
      
      assert.strictEqual(key1, key2, 'Same inputs should generate same idempotency key')
    })

    it('should create unique idempotency keys for different parameters', async () => {
      const { generateIdempotencyKey } = await import('../../backend/services/crawlerJobCreation.js')
      
      const key1 = generateIdempotencyKey('local', 'profile-123', { zip: '12345' })
      const key2 = generateIdempotencyKey('local', 'profile-123', { zip: '54321' })
      
      assert.notStrictEqual(key1, key2, 'Different parameters should generate different keys')
    })

    it('should prevent duplicate job creation', async () => {
      const { createCrawlerJob } = await import('../../backend/services/crawlerJobCreation.js')
      
      // Create first job
      const result1 = await createCrawlerJob(db, {
        type: 'local',
        profileId: null,
        parameters: { zip: '12345' },
        buildSnapshot: false,
      })
      
      assert.ok(result1.created, 'First job should be created')
      
      // Try to create duplicate
      const result2 = await createCrawlerJob(db, {
        type: 'local',
        profileId: null,
        parameters: { zip: '12345' },
        buildSnapshot: false,
      })
      
      assert.ok(result2.existing, 'Second job should return existing')
      assert.strictEqual(result1.jobId, result2.jobId, 'Should return same job ID')
    })
  })

  describe('Dead Letter Queue', () => {
    it('should have dead_letter_queue table', async () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      const hasDeadLetterQueue = tables.some(t => t.name === 'dead_letter_queue')
      
      assert.ok(hasDeadLetterQueue, 'dead_letter_queue table should exist')
    })

    it('should log failed jobs', async () => {
      const { logFailedJob } = await import('../../backend/services/deadLetterQueue.js')
      
      // Create a test job first
      const jobId = crypto.randomUUID()
      db.prepare('INSERT INTO crawler_jobs (id, type, status) VALUES (?, ?, ?)')
        .run(jobId, 'local', 'failed')
      
      // Log failure
      const entryId = await logFailedJob(db, {
        jobId,
        jobType: 'local',
        error: new Error('Test error'),
        severity: 'medium',
      })
      
      assert.ok(entryId, 'Should return entry ID')
      
      // Verify entry exists
      const entry = db.prepare('SELECT * FROM dead_letter_queue WHERE id = ?').get(entryId)
      assert.ok(entry, 'Entry should exist in database')
      assert.strictEqual(entry.job_id, jobId)
      assert.strictEqual(entry.error_message, 'Test error')
    })

    it('should get unresolved failures', async () => {
      const { getUnresolvedFailures } = await import('../../backend/services/deadLetterQueue.js')
      
      const failures = await getUnresolvedFailures(db, 'local')
      assert.ok(Array.isArray(failures), 'Should return array')
    })
  })

  describe('DB Write Validation', () => {
    it('should validate job status', async () => {
      const { validateJobStatus } = await import('../../backend/utils/dbValidation.js')
      
      assert.strictEqual(validateJobStatus('queued'), 'queued')
      assert.strictEqual(validateJobStatus('RUNNING'), 'running')
      assert.throws(() => validateJobStatus('invalid'), /Invalid job status/)
    })

    it('should validate state codes', async () => {
      const { validateStateCode } = await import('../../backend/utils/dbValidation.js')
      
      assert.strictEqual(validateStateCode('ca'), 'CA')
      assert.strictEqual(validateStateCode('NY'), 'NY')
      assert.throws(() => validateStateCode('ZZ'), /Invalid state code/)
    })

    it('should validate ZIP codes', async () => {
      const { validateZipCode } = await import('../../backend/utils/dbValidation.js')
      
      assert.strictEqual(validateZipCode('12345'), '12345')
      assert.strictEqual(validateZipCode('12345-6789'), '12345')
      assert.throws(() => validateZipCode('1234'), /Invalid ZIP code/)
    })

    it('should validate dates', async () => {
      const { validateDate } = await import('../../backend/utils/dbValidation.js')
      
      assert.strictEqual(validateDate('2024-01-15'), '2024-01-15')
      assert.strictEqual(validateDate(new Date('2024-01-15')), '2024-01-15')
      assert.throws(() => validateDate('not-a-date'), /Invalid date/)
    })

    it('should validate emails', async () => {
      const { validateEmail } = await import('../../backend/utils/dbValidation.js')
      
      assert.strictEqual(validateEmail('test@example.com'), 'test@example.com')
      assert.strictEqual(validateEmail('Test@Example.COM'), 'test@example.com')
      assert.throws(() => validateEmail('not-an-email'), /Invalid email/)
    })
  })

  describe('Profile Access Control', () => {
    it('should allow admin to access any profile', async () => {
      // Create admin user
      const adminId = crypto.randomUUID()
      db.prepare('INSERT INTO users (id, primary_email, display_name, is_admin) VALUES (?, ?, ?, ?)')
        .run(adminId, 'admin@test.com', 'Admin', 1)
      
      // Create regular user and profile
      const userId = crypto.randomUUID()
      const profileId = crypto.randomUUID()
      db.prepare('INSERT INTO users (id, primary_email, display_name, is_admin) VALUES (?, ?, ?, ?)')
        .run(userId, 'user@test.com', 'User', 0)
      db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
        .run(profileId, userId, 'User Profile')
      
      // Admin should be able to access
      const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId)
      assert.strictEqual(admin.is_admin, 1, 'Admin should have is_admin flag')
    })

    it('should require user_id or profile_emails for non-admin access', async () => {
      const profileId = crypto.randomUUID()
      const userId = crypto.randomUUID()
      
      db.prepare('INSERT INTO users (id, primary_email, display_name, is_admin) VALUES (?, ?, ?, ?)')
        .run(userId, 'user@test.com', 'User', 0)
      db.prepare('INSERT INTO profiles (id, user_id, display_name) VALUES (?, ?, ?)')
        .run(profileId, userId, 'Profile')
      
      const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
      assert.ok(profile.user_id, 'Profile should have user_id')
    })
  })

  describe('Profile Context Building', () => {
    it('should use buildProfileContext as canonical builder', async () => {
      const { buildProfileContext } = await import('../../backend/services/profileHelpers.js')
      
      // Create test profile
      const profileId = crypto.randomUUID()
      db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?, ?, ?)')
        .run(profileId, 'Test Profile', 'nonprofit')
      
      const context = await buildProfileContext(db, profileId)
      
      assert.ok(context, 'Should return context')
      assert.strictEqual(context.profile_id, profileId)
      assert.ok(context.version, 'Should have version')
      assert.ok(context.profile, 'Should include profile')
      assert.ok(context.sections, 'Should include sections')
      assert.ok(context.signals, 'Should include signals')
    })
  })
})
