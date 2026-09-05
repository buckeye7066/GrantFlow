// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'

// Classification has its own integration suite. This suite exercises the
// repair's actual SQL, including on native Postgres, without portal/network work.
const store = vi.hoisted(() => ({
  appendTaskEvent: vi.fn(),
  assessApplicationTaskPointerSource: vi.fn(),
}))
vi.mock('../services/hamilton/applicationTaskStore.js', () => store)
import { repairLegacyPointerApplicationTasks } from '../services/hamilton/pointerTaskRepair.js'

const instructions = 'Synthetic referral: no application surface is available.'
const protectedStatuses = [
  'submitted', 'completed', 'cancelled', 'submit_attempt_started',
  'submit_evidence_pending', 'submission_verification_required',
]

beforeEach(() => {
  vi.resetAllMocks()
  store.appendTaskEvent.mockResolvedValue(undefined)
  store.assessApplicationTaskPointerSource.mockResolvedValue({ kind: 'referral', instructions })
})

function task(status = 'queued') {
  return {
    id: 'synthetic-task', profile_id: 'synthetic-profile', opportunity_id: 'synthetic-pointer',
    automation_type: 'portal', status, current_step: status,
    audit_summary_json: '{"retained":"synthetic-evidence"}',
    output_document_id: 'synthetic-document',
  }
}

function captureDb(dialect, rows = [task()], writeError = null) {
  const writes = []
  return {
    dialect, writes,
    prepare(sql) {
      return {
        all: async () => rows,
        run: async (...params) => {
          if (writeError) throw writeError
          writes.push({ sql, params })
          return { changes: 1 }
        },
      }
    },
  }
}

describe('pointer repair dialect contract', () => {
  it.each(['postgres', 'sqlite', undefined])('writes correctly typed false for %s', async dialect => {
    const db = captureDb(dialect)
    const report = await repairLegacyPointerApplicationTasks(db)
    expect(report.repaired).toBe(1)
    expect(db.writes).toHaveLength(1)
    const literal = dialect === 'postgres' ? 'FALSE' : '0'
    for (const column of ['auto_submit_enabled', 'allow_auto_submit']) {
      expect(db.writes[0].sql).toMatch(new RegExp(`${column}\\s*=\\s*${literal}\\b`))
    }
    const audit = JSON.parse(db.writes[0].params[1])
    expect(audit.retained).toBe('synthetic-evidence')
    expect(audit.pointer_research_lead_repair.submission_intent_disabled).toBe(true)
  })

  it('leaves every submission-evidence status untouched', async () => {
    const db = captureDb('postgres', protectedStatuses.map(task))
    const report = await repairLegacyPointerApplicationTasks(db)
    expect(report.protected_terminal).toBe(protectedStatuses.length)
    expect(report.repaired).toBe(0)
    expect(db.writes).toHaveLength(0)
    expect(store.appendTaskEvent).not.toHaveBeenCalled()
  })

  it('retains count-only behavior without writes or events', async () => {
    const db = captureDb('postgres')
    const report = await repairLegacyPointerApplicationTasks(db, { dryRun: true })
    expect(report.would_repair).toBe(1)
    expect(report.repaired).toBe(0)
    expect(db.writes).toHaveLength(0)
    expect(store.appendTaskEvent).not.toHaveBeenCalled()
  })

  it('still propagates database write failures instead of reporting a successful repair', async () => {
    const failure = Object.assign(new Error('synthetic write failure'), { code: '23514' })
    await expect(repairLegacyPointerApplicationTasks(captureDb('postgres', [task()], failure)))
      .rejects.toBe(failure)
    expect(store.appendTaskEvent).not.toHaveBeenCalled()
  })
})

// CI injects only this synthetic DATABASE_URL after stripping inherited live
// credentials with buildIsolatedTestEnv. Ordinary isolated suites have no URL.
// A real/local application's DATABASE_URL must never activate this test lane.
function isDisposableTestUrl(value) {
  try {
    const url = new URL(value)
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.pathname === '/grantflow_pointer_test'
  } catch {
    return false
  }
}

it('only enables native SQL tests for the explicitly named loopback fixture database', () => {
  expect(isDisposableTestUrl(undefined)).toBe(false)
  expect(isDisposableTestUrl('not-a-url')).toBe(false)
  expect(isDisposableTestUrl('postgres://example.invalid/grantflow_pointer_test')).toBe(false)
  expect(isDisposableTestUrl('postgres://127.0.0.1/production')).toBe(false)
  expect(isDisposableTestUrl('postgres://127.0.0.1/grantflow_pointer_test')).toBe(true)
})

const postgresUrl = process.env.DATABASE_URL
describe.runIf(isDisposableTestUrl(postgresUrl))('pointer repair on native PostgreSQL', () => {
  let client
  let db

  beforeAll(async () => {
    if (!isDisposableTestUrl(postgresUrl)) {
      throw new Error('Refusing a non-disposable pointer repair test database')
    }
    client = new pg.Client({ connectionString: postgresUrl, connectionTimeoutMillis: 5000 })
    await client.connect()
    // TEMP tables and a dedicated connection prevent the fixture from touching
    // durable application tables even in the dedicated test database.
    await client.query(`
      CREATE TEMP TABLE funding_opportunities (
        id TEXT PRIMARY KEY, opportunity_kind TEXT, title TEXT
      );
      CREATE TEMP TABLE grants (
        id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT
      );
      CREATE TEMP TABLE application_tasks (
        id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT, grant_id TEXT,
        automation_type TEXT, status TEXT, current_step TEXT,
        portal_url TEXT, application_url TEXT, audit_summary_json TEXT,
        output_document_id TEXT, output_pdf_document_id TEXT,
        output_docx_document_id TEXT, output_proposal_document_id TEXT,
        auto_submit_enabled BOOLEAN NOT NULL, allow_auto_submit BOOLEAN NOT NULL,
        next_retry_at TIMESTAMPTZ, last_agent_message TEXT,
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
      );
    `)
    // Deliberately no boolean-integer compatibility rewriting: the production
    // repair statement itself must satisfy Postgres's real column types.
    db = {
      dialect: 'postgres',
      prepare(sql) {
        let index = 0
        const nativeSql = sql.replace(/\?/g, () => `$${++index}`)
        return {
          all: async (...params) => (await client.query(nativeSql, params)).rows,
          run: async (...params) => ({ rowCount: (await client.query(nativeSql, params)).rowCount }),
        }
      },
    }
  })

  beforeEach(async () => {
    await client.query('TRUNCATE application_tasks, grants, funding_opportunities')
    await client.query(`INSERT INTO funding_opportunities (id, opportunity_kind, title)
      VALUES ('synthetic-pointer', 'referral', 'Synthetic Referral Directory')`)
    await seed('synthetic-task', 'queued')
  })

  afterAll(async () => {
    if (client) await client.end()
  })

  async function seed(id, status) {
    await client.query(`INSERT INTO application_tasks
      (id, profile_id, opportunity_id, automation_type, status, current_step,
       auto_submit_enabled, allow_auto_submit, output_document_id, audit_summary_json)
      VALUES ($1, 'synthetic-profile', 'synthetic-pointer', 'portal', $2, $2,
              TRUE, TRUE, 'synthetic-document', '{"retained":"synthetic-evidence"}')`, [id, status])
  }

  it('demonstrates that the old integer assignment is rejected with SQLSTATE 42804', async () => {
    for (const column of ['auto_submit_enabled', 'allow_auto_submit']) {
      // Column identifiers are from the fixed local allowlist above, not input.
      await expect(client.query(`UPDATE application_tasks SET ${column} = 0`))
        .rejects.toMatchObject({ code: '42804' })
    }
    const { rows } = await client.query('SELECT auto_submit_enabled, allow_auto_submit FROM application_tasks')
    expect(rows).toEqual([{ auto_submit_enabled: true, allow_auto_submit: true }])
  })

  it('repairs BOOLEAN flags, preserves evidence, and is idempotent on a fresh rerun', async () => {
    const first = await repairLegacyPointerApplicationTasks(db)
    expect(first.repaired).toBe(1)
    const { rows } = await client.query('SELECT * FROM application_tasks WHERE id = $1', ['synthetic-task'])
    expect(rows[0]).toMatchObject({
      status: 'blocked', automation_type: 'research_lead', current_step: 'no_application_surface',
      auto_submit_enabled: false, allow_auto_submit: false,
      output_document_id: 'synthetic-document',
    })
    expect(JSON.parse(rows[0].audit_summary_json).retained).toBe('synthetic-evidence')
    const second = await repairLegacyPointerApplicationTasks(db)
    expect(second.repaired).toBe(0)
    expect(second.already_repaired).toBe(1)
    expect(store.appendTaskEvent).toHaveBeenCalledTimes(1)
  })

  it('preserves all protected task states and their true flags on Postgres', async () => {
    for (const status of protectedStatuses) await seed(`protected-${status}`, status)
    const report = await repairLegacyPointerApplicationTasks(db)
    expect(report.repaired).toBe(1)
    expect(report.protected_terminal).toBe(protectedStatuses.length)
    const { rows } = await client.query("SELECT status, auto_submit_enabled, allow_auto_submit FROM application_tasks WHERE id LIKE 'protected-%' ORDER BY status")
    expect(rows).toEqual([...protectedStatuses].sort().map(status => ({
      status, auto_submit_enabled: true, allow_auto_submit: true,
    })))
  })

  it('honors optimistic concurrency if a task crosses the submission boundary after discovery', async () => {
    store.assessApplicationTaskPointerSource.mockImplementationOnce(async () => {
      await client.query("UPDATE application_tasks SET status = 'submit_attempt_started' WHERE id = 'synthetic-task'")
      return { kind: 'referral', instructions }
    })
    const report = await repairLegacyPointerApplicationTasks(db)
    expect(report.conflicts).toBe(1)
    expect(report.repaired).toBe(0)
    const { rows } = await client.query('SELECT status, auto_submit_enabled, allow_auto_submit FROM application_tasks')
    expect(rows).toEqual([{ status: 'submit_attempt_started', auto_submit_enabled: true, allow_auto_submit: true }])
    expect(store.appendTaskEvent).not.toHaveBeenCalled()
  })
})
