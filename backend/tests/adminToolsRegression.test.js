import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  adminCrawlerList,
  adminCrawlerRun,
  adminCrawlerRetry,
  adminCodeEdit,
  adminCodeScan,
  adminDbQuery,
  adminHealthLogs,
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
    expect(result.job_id).toBe(result.job.id)
    expect(result.job.job_id).toBe(result.job.id)
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

describe('admin code and health tools', () => {
  it('ignores debugger mentions inside comments', async () => {
    const result = await adminCodeScan(
      { directory: 'backend/services', filePattern: '*.js', issueTypes: ['debugger'] },
      { user: { isAdmin: true } },
    )
    expect(result.findings.debugger_statements).toEqual([])
  })

  it('treats empty dry-run code edits as a no-op metadata request', async () => {
    const result = await adminCodeEdit({
      filePath: 'backend/services/anyaAdminTools.js',
      changes: [],
      dryRun: true,
    }, {})
    expect(result.no_op).toBe(true)
    expect(result.lines).toBeGreaterThan(0)
  })

  it('reads persisted warn logs when DB drivers return wrapped rows', async () => {
    const db = {
      prepare() {
        return {
          all() {
            return {
              rows: [{
                id: 'log-1',
                created_at: '2026-04-25T00:00:00.000Z',
                category: 'test',
                action: 'warned',
                severity: 'warn',
                details: '{}',
              }],
            }
          },
        }
      },
    }
    const result = await adminHealthLogs({ level: 'warn' }, { user: { isAdmin: true }, db })
    expect(result.persisted_count).toBe(1)
    expect(result.count).toBeGreaterThanOrEqual(1)
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

  it('coerces wrapped rows during brain cleanup dry runs', () => {
    const statements = {
      anya_brain_memory: { rows: [{ id: 'mem-1' }] },
      anya_context: { rows: [{ id: 'ctx-1' }] },
      anya_tool_usage: { rows: [{ id: 'tool-1' }] },
    }
    const db = {
      dialect: 'postgres',
      prepare(sql) {
        return {
          all() {
            if (sql.includes('anya_brain_memory')) return statements.anya_brain_memory
            if (sql.includes('anya_context')) return statements.anya_context
            if (sql.includes('anya_tool_usage')) return statements.anya_tool_usage
            return { rows: [] }
          },
          run() {
            throw new Error('dryRun should not delete')
          },
        }
      },
    }
    const result = cleanupBrain(db, { dryRun: true })
    expect(result.expiredMemories).toBe(1)
    expect(result.oldContext).toBe(1)
    expect(result.oldToolUsage).toBe(1)
    expect(result.removed_ids.expiredMemories).toEqual(['mem-1'])
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

  it('joined URL backfill migration repairs grants from funding_opportunities', () => {
    const sql = readFileSync(path.join(process.cwd(), 'backend/db/migrations/062_grants_joined_url_backfill.sql'), 'utf8')
    expect(sql).toContain('FROM funding_opportunities fo')
    expect(sql).toContain('fo.id = grants.funding_opportunity_id')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS crawler_logs')
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
