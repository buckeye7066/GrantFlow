/**
 * The autopilot run ledger's status set is declared in THREE places that must
 * never drift: AUTOPILOT_RUN_STATUSES (code, enforced in every dialect), the
 * Postgres CHECK (0185), and schema.sql (fresh SQLite databases). And every
 * status literal the orchestrator actually writes must be in that set.
 *
 * Why this test exists (2026-08-22, prod): the orchestrator wrote
 * `submit_attempt_started` at the irreversible click boundary; Postgres'
 * CHECK knew only the original eight statuses; every live submit fail-closed
 * into `submission_verification_required` ("could not persist the run
 * receipt"). The SQLite test schema has no CHECK, so the e2e proof passed.
 * This test would have failed on that commit.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => fs.readFileSync(path.resolve(here, rel), 'utf8')

const Database = (await import('better-sqlite3')).default
const {
  AUTOPILOT_RUN_STATUSES,
  serializeRunJson,
  createAutopilotRun,
  updateAutopilotRun,
  getAutopilotRun,
  _resetAuthSchemaCache,
} = await import('../services/hamilton/hamiltonAuthorizationStore.js')

function checkSetFrom(sql, label) {
  // The CHECK (status IN (...)) list for hamilton_autopilot_runs.
  const idx = sql.indexOf('hamilton_autopilot_runs')
  expect(idx, `${label} mentions hamilton_autopilot_runs`).toBeGreaterThan(-1)
  const after = sql.slice(idx)
  const m = after.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i)
  expect(m, `${label} has a CHECK (status IN (...)) for hamilton_autopilot_runs`).toBeTruthy()
  return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]))
}

describe('hamilton_autopilot_runs status lockstep', () => {
  const code = new Set(AUTOPILOT_RUN_STATUSES)

  it('the Postgres CHECK (0185) equals AUTOPILOT_RUN_STATUSES', () => {
    const pg = checkSetFrom(read('../db/postgres/migrations/0185_hamilton_autopilot_run_statuses.sql'), '0185')
    expect([...pg].sort()).toEqual([...code].sort())
  })

  it('schema.sql equals AUTOPILOT_RUN_STATUSES', () => {
    const sq = checkSetFrom(read('../db/schema.sql'), 'schema.sql')
    expect([...sq].sort()).toEqual([...code].sort())
  })

  it('every status the orchestrator writes to the run ledger is allowed', () => {
    const src = read('../services/hamilton/hamiltonAutomationOrchestrator.js')
    const written = new Set()
    for (const fn of ['updateAutopilotRun(', 'createAutopilotRun(']) {
      let from = 0
      for (;;) {
        const at = src.indexOf(fn, from)
        if (at === -1) break
        // The patch object follows the call; its first `status:` literal is
        // the run status (task writes use updateApplicationTask, not this).
        const close = src.indexOf('})', at)
        const window = src.slice(at, close === -1 ? at + 450 : close + 2)
        const m = window.match(/status:\s*'([a-z_]+)'/)
        if (m) written.add(m[1])
        from = at + fn.length
      }
    }
    // Sanity: the boundary statuses that broke prod are really written.
    expect(written.has('submit_attempt_started')).toBe(true)
    expect(written.has('deferred')).toBe(true)
    const illegal = [...written].filter((s) => !code.has(s))
    expect(illegal, `orchestrator writes statuses outside AUTOPILOT_RUN_STATUSES: ${illegal.join(', ')}`).toEqual([])
  })
})

describe('run ledger: validation and serialisation', () => {
  let db
  beforeEach(async () => {
    _resetAuthSchemaCache()
    db = new Database(':memory:')
  })

  it('refuses an unknown status with a named error (every dialect, not only Postgres)', async () => {
    const run = await createAutopilotRun(db, { taskId: 't1', profileId: 'p1' })
    await expect(updateAutopilotRun(db, run.id, { status: 'no_such_status' }))
      .rejects.toThrow(/invalid autopilot run status: no_such_status/)
    await expect(createAutopilotRun(db, { taskId: 't1', profileId: 'p1', status: 'bogus' }))
      .rejects.toThrow(/invalid autopilot run status: bogus/)
  })

  it('accepts every boundary status the orchestrator writes', async () => {
    const run = await createAutopilotRun(db, { taskId: 't1', profileId: 'p1' })
    for (const status of ['deferred', 'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required']) {
      const updated = await updateAutopilotRun(db, run.id, { status })
      expect(updated.status).toBe(status)
    }
  })

  it('strips NUL bytes, survives circular references and BigInt, and always yields JSON', () => {
    const circular = { a: 1 }
    circular.self = circular
    const out = JSON.parse(serializeRunJson({
      text: 'before\u0000after',
      big: 10n,
      circular,
    }))
    expect(out.text).toBe('beforeafter')
    expect(out.big).toBe('10')
    expect(out.circular.self).toBe('[circular]')
    expect(serializeRunJson(undefined)).toBe('{}')
  })

  it('a result carrying a NUL byte is persisted, not dropped', async () => {
    const run = await createAutopilotRun(db, { taskId: 't1', profileId: 'p1' })
    await updateAutopilotRun(db, run.id, { status: 'completed', result: { snapshot: 'x\u0000y', ok: true } })
    const got = await getAutopilotRun(db, run.id)
    expect(got.status).toBe('completed')
    expect(got.result).toEqual({ snapshot: 'xy', ok: true })
  })
})
