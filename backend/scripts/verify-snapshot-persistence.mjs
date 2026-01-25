import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

// Force an in-memory SQLite DB so this script is deterministic and self-contained.
process.env.DB_PROVIDER = 'sqlite'
process.env.DB_DIALECT = 'sqlite'
process.env.SQLITE_DB_PATH = ':memory:'
// Force non-production so DB bootstrap allows ephemeral SQLite.
process.env.NODE_ENV = 'test'
process.env.ALLOW_EPHEMERAL_SQLITE = 'true'
process.env.ALLOW_SQLITE_IN_PROD = 'true'

const { db } = await import('../db/index.js')
const { dispatchCrawlerJob } = await import('../services/crawlerDispatcher.js')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql')
const schemaSql = fs.readFileSync(schemaPath, 'utf8')
await db.exec(schemaSql)

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-upload-'))

const profileId = 'test-profile-snapshot'
const jobId = 'test-job-missing-snapshot'
const createdAt = '2026-01-01T00:00:00.000Z'

// Minimal profile + sections so profile context is non-empty.
await db.prepare(
  `
    INSERT INTO profiles (id, display_name, primary_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
).run(profileId, 'Snapshot Test Profile', 'nonprofit', 'active', createdAt, createdAt)

await db.prepare(
  `
    INSERT INTO profile_sections (profile_id, section_key, data, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
).run(
  profileId,
  'basic_information',
  JSON.stringify({ city: 'Nashville', state: 'TN', zip: '37201' }),
  createdAt,
  createdAt,
  'test',
)

// Create a queued job WITHOUT snapshot (this simulates legacy/broken producers).
await db.prepare(
  `
    INSERT INTO crawler_jobs (id, type, status, profile_id, parameters, created_at)
    VALUES (?, ?, 'queued', ?, ?, ?)
  `,
).run(jobId, 'avatar_lookup', profileId, JSON.stringify({}), createdAt)

// Run dispatcher once: should persist snapshot deterministically.
await dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI: null })

const row1 = await db
  .prepare('SELECT profile_context_snapshot FROM crawler_jobs WHERE id = ? LIMIT 1')
  .get(jobId)

if (!row1?.profile_context_snapshot) {
  throw new Error('FAIL: snapshot was not persisted after first dispatch')
}

const snap1 = String(row1.profile_context_snapshot)
const hash1 = crypto.createHash('sha256').update(snap1).digest('hex')

// Reset job back to queued without touching snapshot to verify we do not rebuild/alter it.
await db.prepare(
  `
    UPDATE crawler_jobs
    SET status = 'queued',
        started_at = NULL,
        completed_at = NULL,
        error = NULL
    WHERE id = ?
  `,
).run(jobId)

await dispatchCrawlerJob({ db, jobId, uploadDir, getOpenAI: null })

const row2 = await db
  .prepare('SELECT profile_context_snapshot FROM crawler_jobs WHERE id = ? LIMIT 1')
  .get(jobId)

const snap2 = String(row2?.profile_context_snapshot || '')
const hash2 = crypto.createHash('sha256').update(snap2).digest('hex')

if (!snap2) throw new Error('FAIL: snapshot missing after second dispatch')
if (hash1 !== hash2) throw new Error('FAIL: snapshot changed between dispatch runs')

console.log('[verify-snapshot-persistence] OK', {
  jobId,
  profileId,
  snapshot_bytes: snap1.length,
  snapshot_sha256_prefix: hash1.slice(0, 12),
})

