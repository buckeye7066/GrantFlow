import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  adminCrawlerList,
  adminCrawlerRun,
  adminCrawlerRetry,
  adminDbQuery,
} from '../services/anyaAdminTools.js'
import { cleanupBrain } from '../services/anyaBrainService.js'
import { invokeTool } from '../services/anyaToolRegistry.js'
import { getAuditSummary } from '../services/codeGuardService.js'
import { runGrantFlowDomainAudits } from '../services/anyaGrantFlowAudits.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT,
      profile_id TEXT,
      status TEXT,
      parameters TEXT,
      result_meta TEXT,
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      last_retry_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE anya_brain_memory (
      id TEXT PRIMARY KEY,
      scope TEXT,
      scope_id TEXT,
      memory_key TEXT,
      content TEXT,
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE anya_context (id TEXT PRIMARY KEY, created_at TEXT);
    CREATE TABLE anya_tool_usage (id TEXT PRIMARY KEY, created_at TEXT);
  `)
  db.dialect = 'sqlite'
  return db
}

describe('admin crawler tools', () => {
  it('lists crawler jobs when the driver returns rows arrays', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run('job-1', 'local', 'queued', '{"zip":"37311"}')

    const result = await adminCrawlerList({}, { db })
    expect(result.count).toBe(1)
    expect(result.jobs[0].parameters).toEqual({ zip: '37311' })
  })

  it('standardizes crawler run on crawlerType', async () => {
    const db = makeDb()
    const result = await adminCrawlerRun({ crawlerType: 'local', parameters: { zip: '37311' } }, { db })
    expect(result.job.crawlerType).toBe('local')
    expect(result.job.parameters).toEqual({ zip: '37311' })
  })

  it('retries failed jobs using the parameters column with a null-safe fallback', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, parameters) VALUES (?, ?, ?, ?)').run('failed-1', 'local', 'failed', null)

    const result = await adminCrawlerRetry({ jobId: 'failed-1' }, { db })
    expect(result.original_job_id).toBe('failed-1')
    expect(result.new_job.parameters.retried_from_job_id).toBe('failed-1')
  })
})

describe('admin db/query and validation', () => {
  it('returns rows for the documented sql parameter', async () => {
    const db = makeDb()
    const result = await adminDbQuery({ sql: 'SELECT 1 as x' }, { db })
    expect(result.rows_returned).toBe(1)
    expect(result.results[0].x).toBe(1)
  })

  it('turns missing required tool parameters into HTTP 400 errors', async () => {
    await expect(
      invokeTool('admin.db.query', {}, { db: makeDb(), ctx: { isAdmin: true }, user: { role: 'admin' } }),
    ).rejects.toMatchObject({ status: 400, message: 'Missing required parameter: sql' })
  })
})

describe('admin brain cleanup and CodeGuard summary', () => {
  it('supports dryRun and reports cleanup counts plus ids', () => {
    const db = makeDb()
    const id = randomUUID()
    db.prepare('INSERT INTO anya_brain_memory (id, scope, memory_key, content, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'global',
      'expired',
      '{}',
      '2000-01-01T00:00:00.000Z',
    )

    const dry = cleanupBrain(db, { dryRun: true })
    expect(dry.expiredMemories).toBe(1)
    expect(dry.removed_ids.expiredMemories).toContain(id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM anya_brain_memory').get().count).toBe(1)
  })

  it('formats stored audit shapes without undefined', () => {
    const db = makeDb()
    db.prepare('INSERT INTO anya_brain_memory (id, scope, memory_key, content) VALUES (?, ?, ?, ?)').run(
      'm1',
      'global',
      'codeguard.endpoint_health',
      JSON.stringify({ endpoints: { passed: 24, failed: 0, skipped: 0, total: 24 } }),
    )

    expect(getAuditSummary(db)).not.toContain('undefined')
  })
})

describe('admin schema migration and domain audits', () => {
  it('migration includes all grants columns and crawler_logs repair', () => {
    const sql = readFileSync(path.join(process.cwd(), 'backend/db/migrations/059_admin_tool_schema_backfill.sql'), 'utf8')
    for (const column of ['url', 'matched_needs', 'match_decision', 'match_explanation', 'fingerprint', 'fingerprint_version']) {
      expect(sql).toContain(`ADD COLUMN ${column}`)
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS crawler_logs')
  })

  it('mission metadata migration backfills profile grant audit fields', () => {
    const sql = readFileSync(path.join(process.cwd(), 'backend/db/migrations/061_admin_mission_metadata_backfill.sql'), 'utf8')
    for (const fragment of ['matched_needs', 'match_reasons', 'profile_fingerprint', 'opportunity_fingerprint', 'matcher_version']) {
      expect(sql).toContain(fragment)
    }
    expect(sql).toContain('INSERT INTO crawler_logs')
    expect(sql).toContain('profile_id IS NOT NULL')
  })

  it('Postgres crawler_logs migrations match TEXT crawler/profile IDs', () => {
    for (const filename of [
      'backend/db/postgres/migrations/0051_grants_url_fingerprint_crawler_logs.sql',
      'backend/db/postgres/migrations/0052_admin_tool_schema_backfill.sql',
    ]) {
      const sql = readFileSync(path.join(process.cwd(), filename), 'utf8')
      expect(sql).toMatch(/\bid\s+TEXT PRIMARY KEY DEFAULT gen_random_uuid\(\)::text/)
      expect(sql).toMatch(/\bjob_id\s+TEXT REFERENCES crawler_jobs\(id\) ON DELETE CASCADE/)
      expect(sql).toMatch(/\bprofile_id\s+TEXT REFERENCES profiles\(id\) ON DELETE SET NULL/)
      expect(sql).not.toMatch(/\bjob_id\s+UUID REFERENCES crawler_jobs\(id\)/)
      expect(sql).not.toMatch(/\bprofile_id\s+UUID REFERENCES profiles\(id\)/)
    }
  })

  it('domain audits use prepare-compatible DB clients instead of db.query-only calls', async () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT,
        title TEXT,
        application_url TEXT,
        deadline TEXT,
        deadline_type TEXT,
        is_active INTEGER,
        description TEXT,
        opportunity_type TEXT,
        eligibility TEXT,
        eligibility_criteria TEXT,
        is_loan INTEGER
      );
      CREATE TABLE audit_logs (category TEXT, action TEXT, created_at TEXT);
    `)

    const report = await runGrantFlowDomainAudits({ rootDir: process.cwd(), db })
    const messages = report.errors.map((err) => err.message).join('\n')
    expect(messages).not.toContain('db.query is not a function')
    expect(messages).not.toContain('missing_file')
  })
})
