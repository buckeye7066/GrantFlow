/**
 * Guards for the Anya live-run controls (watch-her-work feed + Stop/Escape):
 *   - schema.sql's anya_runs carries progress_json + cancel_requested
 *   - requestAnyaRunCancel flags only RUNNING runs and is owner-scoped
 *   - isAnyaRunCancelRequested reads the flag (false on missing runs)
 *   - setAnyaRunProgress round-trips through getAnyaRun().progress
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

const {
  createAnyaRun,
  getAnyaRun,
  requestAnyaRunCancel,
  isAnyaRunCancelRequested,
  setAnyaRunProgress,
  completeAnyaRun,
} = await import('../services/anyaRuns.js')

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  // The runs table FKs users/sessions; this test exercises run bookkeeping,
  // not referential integrity, so skip seeding a full user graph.
  sqlite.pragma('foreign_keys = OFF')
  sqlite.dialect = 'sqlite'
  // anyaRuns.js expects the app's prepared-statement wrapper shape; the raw
  // better-sqlite3 API matches (.prepare().run/.get) except async-ness, which
  // the service tolerates (awaiting a sync value is a no-op).
  return sqlite
}

describe('anya live-run controls', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('anya_runs has the live-run columns', () => {
    const cols = new Set(db.prepare('PRAGMA table_info(anya_runs)').all().map((r) => r.name))
    expect(cols.has('progress_json')).toBe(true)
    expect(cols.has('cancel_requested')).toBe(true)
  })

  it('cancel flags a running run; orchestrator-side check sees it', async () => {
    const runId = await createAnyaRun(db, { mode: 'copilot', kind: 'assistant_message', sessionId: null, userId: 'u1', request: {} })
    expect(await isAnyaRunCancelRequested(db, runId)).toBe(false)

    const res = await requestAnyaRunCancel(db, runId, { userId: 'u1' })
    expect(res.ok).toBe(true)
    expect(await isAnyaRunCancelRequested(db, runId)).toBe(true)

    const run = await getAnyaRun(db, runId, { userId: 'u1' })
    expect(run.cancel_requested).toBe(true)
  })

  it('cancel is owner-scoped and refuses non-running runs', async () => {
    const runId = await createAnyaRun(db, { mode: 'copilot', kind: 'assistant_message', userId: 'owner', request: {} })

    const wrongUser = await requestAnyaRunCancel(db, runId, { userId: 'someone-else' })
    expect(wrongUser.ok).toBe(false)
    expect(wrongUser.reason).toBe('not_found')

    await completeAnyaRun(db, runId, { status: 'completed', response: { assistantText: 'done' } })
    const late = await requestAnyaRunCancel(db, runId, { userId: 'owner' })
    expect(late.ok).toBe(false)
    expect(late.reason).toBe('not_running')
  })

  it('retries the delivery marker when run completion hits transient contention', async () => {
    const runId = await createAnyaRun(db, {
      mode: 'copilot',
      kind: 'assistant_message',
      userId: 'u1',
      request: {},
    })
    let attempts = 0
    const retryingDb = {
      prepare(sql) {
        const stmt = db.prepare(sql)
        return {
          run(...args) {
            if (/UPDATE anya_runs\s+SET status/i.test(sql)) {
              attempts += 1
              if (attempts < 3) throw new Error('database is locked')
            }
            return stmt.run(...args)
          },
          get(...args) { return stmt.get(...args) },
          all(...args) { return stmt.all(...args) },
        }
      },
    }

    const completed = await completeAnyaRun(retryingDb, runId, {
      status: 'completed',
      response: { assistantText: 'durable answer', assistant_message_id: 'm-1' },
    })

    expect(completed).toBe(true)
    expect(attempts).toBe(3)
    const run = await getAnyaRun(db, runId, { userId: 'u1' })
    expect(run).toMatchObject({
      status: 'completed',
      assistant_text: 'durable answer',
      assistant_message_id: 'm-1',
    })
  })

  it('progress round-trips through getAnyaRun', async () => {
    const runId = await createAnyaRun(db, { mode: 'copilot', kind: 'assistant_message', userId: 'u1', request: {} })
    const steps = [
      { label: 'Saving information to the profile', status: 'done', at: 'x' },
      { label: 'Working out the best next step', status: 'running', at: 'y' },
    ]
    await setAnyaRunProgress(db, runId, steps)
    const run = await getAnyaRun(db, runId, { userId: 'u1' })
    expect(run.progress).toEqual(steps)
  })
})
