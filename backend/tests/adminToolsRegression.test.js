import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  adminCrawlerList,
  adminCrawlerCheck,
  adminCrawlerRun,
  adminCrawlerRetry,
  adminCodeEdit,
  adminCodeScan,
  adminDbQuery,
  adminHealthLogs,
} from '../services/anyaAdminTools.js'
import { cleanupBrain } from '../services/anyaBrainService.js'
import { invokeTool } from '../services/anyaToolRegistry.js'
import { formatAuditSummary, getAuditSummary } from '../services/codeGuardService.js'
import { runGrantFlowDomainAudits } from '../services/anyaGrantFlowAudits.js'
import { testButtonFunctionality } from '../services/anyaAutonomousFunctionTesting.js'
import { extractButtons } from '../services/anyaButtonScanner.js'
import { ensureAdminSchemaRepair } from '../services/adminSchemaRepair.js'

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
    CREATE TABLE profiles (id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, tags TEXT);
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
    expect(result.new_job_id).toBe(result.new_job.id)
    expect(result.new_job.job_id).toBe(result.new_job.id)
    expect(result.new_job.parameters.retried_from_job_id).toBe('failed-1')
  })

  it('checks crawler jobs with since/status filters without backfilling defaults', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)').run('old-1', 'local', 'queued', '2020-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO crawler_jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)').run('recent-ok', 'local', 'completed', '2026-04-24T12:00:00.000Z')
    db.prepare('INSERT INTO crawler_jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)').run('recent-failed', 'local', 'failed', '2026-04-24T13:00:00.000Z')

    const result = await adminCrawlerCheck({ since: '2026-04-24T00:00:00.000Z', status: 'failed', limit: 10 }, { db })
    expect(result.checked).toBe(1)
    expect(result.summary.failed).toBe(1)
    expect(result.errors[0].job_id).toBe('recent-failed')
  })

  it('honors since by returning fewer rows than an unbounded check', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO crawler_jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)').run('old-1', 'local', 'queued', '2020-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO crawler_jobs (id, type, status, created_at) VALUES (?, ?, ?, ?)').run('new-1', 'local', 'queued', '2026-04-25T12:00:00.000Z')

    const unbounded = await adminCrawlerCheck({ limit: 10 }, { db })
    const bounded = await adminCrawlerCheck({ since: '2026-04-25T00:00:00Z', limit: 10 }, { db })
    expect(unbounded.checked).toBe(2)
    expect(bounded.checked).toBe(1)
  })

  it('returns standard HTTP 400 validation errors for profile-scoped crawler tools', async () => {
    await expect(
      invokeTool('admin.crawler.triggerAll', {}, { db: makeDb(), ctx: { isAdmin: true }, user: { role: 'admin' } }),
    ).rejects.toMatchObject({ status: 400, message: 'Missing required parameter: profileId' })

    await expect(
      invokeTool('admin.crawler.schedule', {}, { db: makeDb(), ctx: { isAdmin: true }, user: { role: 'admin' } }),
    ).rejects.toMatchObject({ status: 400, message: 'Missing required parameter: profileId' })
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
  // Recursively scans every .js file under backend/services (hundreds of files)
  // and is filesystem-bound — under heavy parallel test load on Windows it can
  // exceed the default 15s vitest timeout, so give it room to breathe.
  it('ignores debugger mentions inside comments', { timeout: 60_000 }, async () => {
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
                created_at: new Date().toISOString(),
                category: 'test',
                action: 'warned',
                severity: 30,
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

  it('reads persisted warn logs from audit_logs with numeric severity levels', async () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        category TEXT,
        action TEXT,
        severity TEXT,
        severity_level INTEGER,
        user_id TEXT,
        profile_id TEXT,
        details TEXT
      );
    `)
    db.prepare('INSERT INTO audit_logs (id, created_at, category, action, severity_level, details) VALUES (?, ?, ?, ?, ?, ?)').run(
      'log-warn',
      new Date().toISOString(),
      'test',
      'warn_inserted',
      1,
      '{}',
    )

    const result = await adminHealthLogs({ level: 'warn', limit: 10 }, { user: { isAdmin: true }, db })
    expect(result.persisted_count).toBe(1)
    expect(result.count).toBeGreaterThan(0)
  })

  it('filters string audit_log severities at warn by default and includes info when requested', async () => {
    const db = makeDb()
    db.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT,
        category TEXT,
        action TEXT,
        severity TEXT,
        user_id TEXT,
        profile_id TEXT,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT
      );
    `)
    db.prepare('INSERT INTO audit_logs (id, created_at, category, action, severity, details) VALUES (?, ?, ?, ?, ?, ?)').run(
      'log-info',
      '2026-04-25T18:00:00.000Z',
      'test',
      'info_inserted',
      'info',
      '{}',
    )
    db.prepare('INSERT INTO audit_logs (id, created_at, category, action, severity, details) VALUES (?, ?, ?, ?, ?, ?)').run(
      'log-warn',
      '2026-04-25T18:01:00.000Z',
      'test',
      'warn_inserted',
      'warn',
      '{}',
    )

    const warnResult = await adminHealthLogs({}, { user: { isAdmin: true }, db })
    expect(warnResult.persisted_count).toBe(1)
    expect(warnResult.logs.map((log) => log.event)).toEqual(['warn_inserted'])

    const infoResult = await adminHealthLogs({ level: 'info', limit: 10 }, { user: { isAdmin: true }, db })
    expect(infoResult.persisted_count).toBe(2)
    expect(infoResult.logs.map((log) => log.event)).toEqual(['warn_inserted', 'info_inserted'])
  })

  // Walks the default component search roots — filesystem-bound, can run long
  // under heavy parallel test load on Windows. Bump above the 15s default that
  // was previously set on this case.
  it('finds component files from the default button-test search roots', async () => {
    const result = await testButtonFunctionality({ probe: false }, { user: { isAdmin: true } })
    expect(result.files_scanned).toBeGreaterThan(0)
    expect(result.component_path).toBeTruthy()
  }, 60000)

  it('extracts shadcn buttons plus role/onClick non-button controls', () => {
    const buttons = extractButtons(`
      <Button onClick={handleSave}>Save</Button>
      <div role="button" onClick={() => runThing()}>Run</div>
      <span onClick={handleSpan}>Clickable text</span>
    `)
    expect(buttons).toHaveLength(3)
  })

  it('counts each supported JSX button pattern from a fixture', () => {
    const buttons = extractButtons(`
      <button onClick={nativeClick}>Native</button>
      <Button onClick={() => wrappedClick()}>Wrapped</Button>
      <DropdownMenuItem onClick={menuClick}>Menu</DropdownMenuItem>
      <div role="button" onClick={roleClick}>Role</div>
      <span onClick={spanClick}>Span</span>
    `)
    expect(buttons).toHaveLength(5)
  })
})

describe('admin brain cleanup and CodeGuard summary', () => {
  it('supports dryRun and reports cleanup counts plus ids', async () => {
    const db = makeDb()
    const id = randomUUID()
    db.prepare('INSERT INTO anya_brain_memory (id, scope, memory_key, content, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'global',
      'expired',
      '{}',
      '2000-01-01T00:00:00.000Z',
    )

    const dry = await cleanupBrain(db, { dryRun: true })
    expect(dry.expiredMemories).toBe(1)
    expect(dry.removed_ids.expiredMemories).toContain(id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM anya_brain_memory').get().count).toBe(1)
  })

  it('coerces wrapped rows during brain cleanup dry runs', async () => {
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
    const result = await cleanupBrain(db, { dryRun: true })
    expect(result.expiredMemories).toBe(1)
    expect(result.oldContext).toBe(1)
    expect(result.oldToolUsage).toBe(1)
    expect(result.removed_ids.expiredMemories).toEqual(['mem-1'])
  })

  it('formats stored audit shapes without undefined', async () => {
    const db = makeDb()
    db.prepare('INSERT INTO anya_brain_memory (id, scope, memory_key, content) VALUES (?, ?, ?, ?)').run(
      'm1',
      'global',
      'codeguard.endpoint_health',
      JSON.stringify({ endpoints: { passed: 24, failed: 0, skipped: 0, total: 24 } }),
    )

    expect(await getAuditSummary(db)).not.toContain('undefined')
  })

  it('formats inline CodeGuard status from fresh sub-tool results', () => {
    const summary = formatAuditSummary({
      endpoints: { passed: 24, failed: 0, skipped: 0, total: 24, timestamp: '2026-04-25T00:00:00.000Z' },
      matchQuality: { totalProfiles: 23, grades: { A: 0, B: 0, C: 0, D: 21, F: 2 }, timestamp: '2026-04-25T00:00:00.000Z' },
      mission: { score: 92, pass: 14, warn: 1, fail: 0, total: 15, timestamp: '2026-04-25T00:00:00.000Z' },
    })

    expect(summary).toContain('24 pass')
    expect(summary).toContain('23 profiles')
    expect(summary).toContain('Mission Score (2026-04-25T00:00:00.000Z): 92%')
    expect(summary).not.toContain('(unknown)')
    expect(summary).not.toContain('0 pass, 0 fail')
  })
})

describe('admin schema migration and domain audits', () => {
  it('runtime schema repair applies grants columns, crawler_logs, and URL backfill', async () => {
    const db = makeDb()
    db.exec(`
      DROP TABLE crawler_jobs;
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
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        funding_opportunity_id TEXT,
        title TEXT,
        application_url TEXT,
        portal_url TEXT
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        application_url TEXT,
        apply_url TEXT,
        source_url TEXT,
        evidence_url TEXT
      );
    `)
    db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run('profile-1', 'Profile 1')
    db.prepare('INSERT INTO funding_opportunities (id, application_url) VALUES (?, ?)').run('opp-1', 'https://example.test/apply')
    db.prepare('INSERT INTO grants (id, profile_id, funding_opportunity_id, title) VALUES (?, ?, ?, ?)').run('grant-1', 'profile-1', 'opp-1', 'Grant')
    db.prepare('INSERT INTO crawler_jobs (id, type, profile_id, status) VALUES (?, ?, ?, ?)').run('job-1', 'local', 'profile-1', 'completed')

    const repair = await ensureAdminSchemaRepair(db)
    expect(repair.applied).toBe(true)
    const columns = db.prepare('PRAGMA table_info(grants)').all().map((row) => row.name)
    for (const column of ['url', 'matched_needs', 'match_decision', 'match_explanation', 'fingerprint', 'fingerprint_version']) {
      expect(columns).toContain(column)
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawler_logs'").get()).toBeTruthy()
    expect(db.prepare('SELECT url, matched_needs, match_decision FROM grants WHERE id = ?').get('grant-1')).toMatchObject({
      url: 'https://example.test/apply',
      matched_needs: '[]',
      match_decision: 'review',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM crawler_logs WHERE profile_id = ?').get('profile-1').count).toBeGreaterThan(0)
  })

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

  it('force schema repair migration repeats admin grants/crawler_logs fixes', () => {
    const sql = readFileSync(path.join(process.cwd(), 'backend/db/migrations/063_force_admin_schema_repair.sql'), 'utf8')
    expect(sql).toContain('ALTER TABLE grants ADD COLUMN url TEXT')
    expect(sql).toContain('matched_needs JSONB')
    expect(sql).toContain('FROM funding_opportunities fo')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS crawler_logs')
    expect(sql).toContain('INSERT INTO crawler_logs')
  })

  it('runtime schema repair migration repeats admin grants/crawler_logs fixes', () => {
    const sqliteSql = readFileSync(path.join(process.cwd(), 'backend/db/migrations/064_runtime_admin_schema_repair.sql'), 'utf8')
    const pgSql = readFileSync(path.join(process.cwd(), 'backend/db/postgres/migrations/0057_runtime_admin_schema_repair.sql'), 'utf8')
    for (const sql of [sqliteSql, pgSql]) {
      expect(sql).toContain('ALTER TABLE grants ADD COLUMN')
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS crawler_logs')
      expect(sql).toContain('FROM funding_opportunities fo')
      expect(sql).toContain('INSERT INTO crawler_logs')
    }
  })

  it('Postgres crawler_logs migrations match TEXT crawler/profile IDs', () => {
    for (const filename of [
      'backend/db/postgres/migrations/0051_grants_url_fingerprint_crawler_logs.sql',
      'backend/db/postgres/migrations/0052_admin_tool_schema_backfill.sql',
      'backend/db/postgres/migrations/0055_grants_joined_url_backfill.sql',
      'backend/db/postgres/migrations/0056_force_admin_schema_repair.sql',
      'backend/db/postgres/migrations/0057_runtime_admin_schema_repair.sql',
    ]) {
      const sql = readFileSync(path.join(process.cwd(), filename), 'utf8')
      expect(sql).toMatch(/\bid\s+TEXT PRIMARY KEY DEFAULT gen_random_uuid\(\)::text/)
      expect(sql).toMatch(/\bjob_id\s+TEXT REFERENCES crawler_jobs\(id\) ON DELETE CASCADE/)
      expect(sql).toMatch(/\bprofile_id\s+TEXT REFERENCES profiles\(id\) ON DELETE SET NULL/)
      expect(sql).not.toMatch(/\bjob_id\s+UUID REFERENCES crawler_jobs\(id\)/)
      expect(sql).not.toMatch(/\bprofile_id\s+UUID REFERENCES profiles\(id\)/)
    }
  })

  it('admin tools dialog renders schema-driven profile and textarea inputs', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/components/anya/AnyaChat.jsx'), 'utf8')
    expect(source).toContain('isProfileSchemaField')
    expect(source).toContain('Select profile...')
    expect(source).toContain('name.toLowerCase().includes("sql")')
    expect(source).toContain('<Textarea')
  })

  // runGrantFlowDomainAudits scans the repo from disk, which can exceed the 5s
  // default under full-suite CPU contention (it passes in ~3s in isolation).
  // Matches the 60s budget the other repo-scanning tests in this file use.
  it('domain audits use prepare-compatible DB clients instead of db.query-only calls', { timeout: 60_000 }, async () => {
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
