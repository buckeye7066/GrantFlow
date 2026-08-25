/**
 * Dry-run is REMOVED OUTRIGHT from agent-control runs (owner order
 * 2026-08-13: "I don't want dry runs, I want work"). Removed means an
 * invocation NAMING the old flag FAILS — never silently proceeds, never a
 * confirmation gate. The concrete defect this retires: samAgentAdapter
 * DEFAULTED dry_run to true, so every Control-Center Sam run did nothing by
 * default while reporting success — the silent-no-op class.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const { DEFAULT_RUN_OPTIONS, assertNoDryRunOption } = await import(
  '../services/agentControl/agentControlTypes.js'
)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { startRun } = await import('../services/agentControl/agentControlOrchestrator.js')

describe('dry_run is removed from agent-control', () => {
  it('DEFAULT_RUN_OPTIONS carries NO dry_run key', () => {
    expect('dry_run' in DEFAULT_RUN_OPTIONS).toBe(false)
  })

  it('naming the flag FAILS — even dry_run:false is refused, never silently accepted', () => {
    expect(() => assertNoDryRunOption({ dry_run: true })).toThrowError(/removed/)
    expect(() => assertNoDryRunOption({ dry_run: false })).toThrowError(/removed/)
    let status = null
    try { assertNoDryRunOption({ dry_run: true }) } catch (e) { status = e.status }
    expect(status).toBe(400)
  })

  it('options without the flag pass the assert untouched', () => {
    expect(() => assertNoDryRunOption({ allow_john_send: false })).not.toThrow()
    expect(() => assertNoDryRunOption(undefined)).not.toThrow()
  })

  it('startRun refuses a dry_run-carrying request before creating any run', async () => {
    const db = wrapSqlite(new Database(':memory:'))
    await expect(
      startRun(db, { runType: 'full_cycle', options: { dry_run: true } }),
    ).rejects.toThrowError(/removed/)
    // No run row was created by the refused request — the refusal fires so
    // early the runs table was never even created on this bare DB.
    let count = 0
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS c FROM agent_control_runs`).get()
      count = Number(row?.c || 0)
    } catch { /* table absent = zero runs, which is the point */ }
    expect(count).toBe(0)
  })

  it('STATIC TRIPWIRE: no agent-control adapter consults dry_run again', () => {
    const dir = path.join(process.cwd(), 'backend', 'services', 'agentControl')
    const files = []
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.js')) files.push(p)
      }
    }
    walk(dir)
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      // The only permitted mentions are the removal guard itself and its
      // documentation — never an options read.
      expect(src.includes('options?.dry_run') || src.includes('options.dry_run'),
        `${path.basename(f)} reads options.dry_run`).toBe(false)
    }
  })
})
