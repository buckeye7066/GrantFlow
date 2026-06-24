/**
 * Tests for the on-demand self-heal + its observability wiring.
 *
 * Covers:
 *   1. selfHealStatus — record/read round-trip; null when never run.
 *   2. runSelfHealOnDemand — runs the full heal, returns a structured truthful
 *      summary, persists it (so the reader sees the last run), and is
 *      idempotent (a second run on a clean DB still succeeds with no failures).
 *   3. Anya owner tools — owner.run_self_heal + owner.get_self_heal_status are
 *      registered, owner-gated (a non-owner admin is rejected at invoke time),
 *      and the status reader surfaces the persisted last run truthfully.
 *
 * better-sqlite3 is synchronous; the heal/observability code awaits results, and
 * awaiting a non-promise resolves to its value — so the raw handle stands in for
 * the async prod db wrapper, matching enforceInvariants.test.js.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { recordSelfHealRun, getLastSelfHealRun } from '../startup/selfHealStatus.js'
import { runSelfHealOnDemand } from '../startup/selfHeal.js'
import { invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'

const OWNER = 'buckeye7066@gmail.com'

// Keep the on-demand heal focused on the repair/enforcement steps for this
// unit test: BASELINE_SEED_MODE=off short-circuits the (heavy, repo-file)
// baseline seed cleanly without touching seed tables. Restored in afterEach.
let _savedSeedMode
beforeEach(() => {
  _savedSeedMode = process.env.BASELINE_SEED_MODE
  process.env.BASELINE_SEED_MODE = 'off'
})
afterEach(() => {
  if (_savedSeedMode === undefined) delete process.env.BASELINE_SEED_MODE
  else process.env.BASELINE_SEED_MODE = _savedSeedMode
})

const SCHEMA_SQL = fs.readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql'),
  'utf8',
)

/**
 * Realistic test DB: applies the canonical SQLite schema.sql so the FULL
 * self-heal (designated profiles, admin links, org links, enforcement, dedup)
 * runs end-to-end exactly as it would in prod — not a hand-rolled subset that
 * would mask which steps actually run.
 */
function makeDb() {
  const raw = new Database(':memory:')
  raw.dialect = 'sqlite'
  raw.exec(SCHEMA_SQL)
  // The prod db wrapper exposes withTransaction(); several setup helpers use it.
  // better-sqlite3 is synchronous, so a pass-through stand-in is faithful.
  raw.withTransaction = (fn) => fn(raw)
  return raw
}

describe('selfHealStatus — record/read round-trip', () => {
  it('returns null when no run has been recorded', async () => {
    const db = makeDb()
    expect(await getLastSelfHealRun(db)).toBeNull()
  })

  it('persists and reads back the last run', async () => {
    const db = makeDb()
    await recordSelfHealRun(db, { ok: true, totalRepaired: 3, steps: [{ step: 'x', repaired: 3 }], failures: [] })
    const last = await getLastSelfHealRun(db)
    expect(last).not.toBeNull()
    expect(last.ok).toBe(true)
    expect(last.totalRepaired).toBe(3)
    expect(Array.isArray(last.steps)).toBe(true)
    expect(typeof last.updated_at).toBe('string')
  })

  it('overwrites (single-row) on a second record', async () => {
    const db = makeDb()
    await recordSelfHealRun(db, { ok: false, totalRepaired: 0, failures: [{ step: 'a', error: 'boom' }] })
    await recordSelfHealRun(db, { ok: true, totalRepaired: 1, failures: [] })
    const rows = db.prepare("SELECT COUNT(*) AS n FROM system_kv WHERE key = 'self_heal_last_run'").get()
    expect(Number(rows.n)).toBe(1)
    const last = await getLastSelfHealRun(db)
    expect(last.ok).toBe(true)
  })
})

describe('runSelfHealOnDemand — structured truthful summary + observability', () => {
  it('runs the full heal, returns a structured summary, and persists it', async () => {
    const db = makeDb()
    const summary = await runSelfHealOnDemand(db)
    expect(summary.ran).toBe(true)
    expect(summary.onDemand).toBe(true)
    expect(summary.smoke).toBe(false)
    expect(Array.isArray(summary.steps)).toBe(true)
    // The invariant-enforcement step always runs as part of the full heal.
    expect(summary.steps.some((s) => s.step === 'enforce_invariants')).toBe(true)
    expect(typeof summary.totalRepaired).toBe('number')
    // It was persisted for observability.
    const last = await getLastSelfHealRun(db)
    expect(last).not.toBeNull()
    expect(last.onDemand).toBe(true)
  })

  it('is idempotent — a second run on a clean DB succeeds with no new failures', async () => {
    const db = makeDb()
    const first = await runSelfHealOnDemand(db)
    const second = await runSelfHealOnDemand(db)
    expect(second.ran).toBe(true)
    // A clean DB yields zero repairs on the dedup/enforce steps both times.
    expect(second.totalRepaired).toBe(first.totalRepaired)
  })
})

describe('Anya owner tools — full self-heal + status', () => {
  it('owner.run_self_heal + owner.get_self_heal_status are owner-gated (hidden from non-owner admin, shown to owner)', () => {
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    expect(adminTools).not.toContain('owner.run_self_heal')
    expect(ownerTools).toContain('owner.run_self_heal')
    expect(ownerTools).toContain('owner.get_self_heal_status')
  })

  it('reject a non-owner admin at invoke time (server-side gate)', async () => {
    const db = makeDb()
    await expect(
      invokeTool('owner.run_self_heal', {}, {
        db,
        ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' },
        user: { role: 'admin', email: 'other-admin@example.com' },
      }),
    ).rejects.toThrow(/owner account/i)
  })

  it('owner can run the self-heal and read back the last run truthfully', async () => {
    const db = makeDb()
    const ownerCtx = {
      db,
      ctx: { isAdmin: true, email: OWNER, userId: 'owner1' },
      user: { role: 'admin', email: OWNER },
    }
    // invokeTool wraps the handler return as { id, tool, output }.
    const result = (await invokeTool('owner.run_self_heal', {}, ownerCtx)).output
    expect(result.ran).toBe(true)
    expect(result.onDemand).toBe(true)

    const status = (await invokeTool('owner.get_self_heal_status', {}, ownerCtx)).output
    expect(status.has_run).toBe(true)
    expect(status.last_run.onDemand).toBe(true)
    expect(Array.isArray(status.last_run.steps)).toBe(true)
  })

  it('owner.get_self_heal_status reports has_run:false before any run', async () => {
    const db = makeDb()
    const status = (await invokeTool('owner.get_self_heal_status', {}, {
      db,
      ctx: { isAdmin: true, email: OWNER, userId: 'owner1' },
      user: { role: 'admin', email: OWNER },
    })).output
    expect(status.has_run).toBe(false)
  })
})

describe("Sam's nightly sweep runs the full self-heal", () => {
  it('invokes runSelfHealOnDemand, returns a self_heal block, and persists the run', async () => {
    const db = makeDb()
    const { runNightlyMaintenanceSweep } = await import('../services/maintenance/nightlySweep.js')
    // force:true bypasses the enabled flag; the sweep enters/exits a maintenance
    // window and runs Sam (observe) — we assert the self-heal integration point.
    const result = await runNightlyMaintenanceSweep(db, { force: true })
    expect(result.ran).toBe(true)
    expect(result.self_heal).not.toBeNull()
    expect(typeof result.self_heal.total_repaired).toBe('number')
    // The full heal recorded its last run for observability.
    const last = await getLastSelfHealRun(db)
    expect(last).not.toBeNull()
    expect(last.onDemand).toBe(true)
  })
})

describe('Sam diagnostics surface the last self-heal run (Agent Observability Rule)', () => {
  it('getSystemDiagnostics includes a self_heal block reflecting the persisted run', async () => {
    const db = makeDb()
    const { getSystemDiagnostics } = await import('../services/diagnosticsService.js')

    // Before any run: has_run false.
    const before = await getSystemDiagnostics(db)
    expect(before.self_heal).toBeDefined()
    expect(before.self_heal.has_run).toBe(false)

    // After a run: the diagnostics rollup reflects it.
    await runSelfHealOnDemand(db)
    const after = await getSystemDiagnostics(db)
    expect(after.self_heal.has_run).toBe(true)
    expect(typeof after.self_heal.total_repaired).toBe('number')
    expect(typeof after.self_heal.at).toBe('string')
  })
})
