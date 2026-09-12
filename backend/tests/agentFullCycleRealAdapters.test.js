import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import {
  startRun,
  getControlCenterStatus,
  getCanonicalAdminEmail,
} from '../services/agentControl/agentControlOrchestrator.js'
import { getRun, listSteps } from '../services/agentControl/agentControlStore.js'
import { resetRegistry } from '../services/agentControl/agentAdapters/agentAdapterRegistry.js'

/**
 * Part 2 mission guard: every agent (Sam, Robert, Yana, John, Hamilton) must
 * complete ONE FULL Agent-Control cycle ERROR-FREE using its REAL adapter —
 * not the mocks the orchestrator unit test installs.
 *
 * The orchestrator unit test proves ordering/stop semantics with MockAdapter;
 * it does NOT prove the real agent code runs without throwing on a migrated DB.
 * This test closes that gap: it boots the real server (SMOKE_MODE, in-memory
 * sqlite, full migrations), then drives a full_cycle through the real registry
 * adapters in SAFE mode (no live web, no browser autopilot, Sam findings do not
 * block) and asserts:
 *   - the run reaches a terminal state that is NOT 'failed',
 *   - every step ends 'completed' / 'skipped' / 'noop' (never 'failed'),
 *   - no step carries an error_message,
 *   - the status snapshot reports all six status agents (5 + anya).
 *
 * Anya is intentionally outside the automated cycle (STATUS_AGENTS, not
 * ALL_AGENTS) — her loop is covered by the interview-engine + chat tests.
 */

// 'blocked' is the terminal status a Sam-preflight refusal lands on (2026-09-12);
// listing it here means a refusal is DIAGNOSED (below) rather than timing out.
const TERMINAL = new Set(['completed', 'completed_noop', 'failed', 'blocked', 'cancelled', 'stopped', 'emergency_stopped'])
const OK_STEP_STATUSES = new Set([
  'completed', 'skipped', 'noop', 'completed_noop', 'completed_no_drafts',
])

function adminUser() {
  return {
    userId: 'u_admin_fullcycle',
    email: getCanonicalAdminEmail(),
    role: 'admin',
    is_admin: 1,
    controlCenterAuthorized: true,
  }
}

async function waitForTerminal(db, runId, timeoutMs = 30_000) {
  const start = Date.now()
  let run = null
  while (Date.now() - start < timeoutMs) {
    run = await getRun(db, runId)
    if (run && TERMINAL.has(run.status)) return run
    await new Promise((r) => setTimeout(r, 150))
  }
  return run
}

describe('Agent Control Center — real adapters complete one full cycle error-free', () => {
  let db

  beforeAll(async () => {
    const loaded = await getAppAndDb()
    db = loaded.db
  }, 60_000)

  beforeEach(() => {
    resetDb(db)
    // Ensure the REAL adapters are in the registry (other suites may have
    // swapped in mocks and not restored).
    resetRegistry()
    // Canonical admin must exist for the control-center email gate.
    try {
      db.prepare(
        `INSERT INTO users (id, primary_email, is_admin, role, created_at, updated_at)
         VALUES (?, ?, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      ).run('u_admin_fullcycle', getCanonicalAdminEmail())
    } catch {
      /* already present */
    }
  })

  it('runs Sam→Robert→Yana→John→Hamilton with no failed step', async () => {
    const { run } = await startRun(db, {
      runType: 'full_cycle',
      user: adminUser(),
      options: {
        // Safe, deterministic, no-network full loop:
        run_sam_preflight: true,
        run_sam_postflight: true,
        // The preflight gate stays ON (the production default). This harness
        // boots with PORT='0' (testServer.js), so Sam's two CRITICAL HTTP
        // checks have no loopback probe: in NODE_ENV=test that must be
        // RECORDED on the step as skipped_critical_checks — never a silent
        // green, and never a block (sam-preflight-4). Disabling the gate here
        // used to hide exactly that vacuous pass.
        stop_on_critical_sam_finding: true,
        stop_on_agent_failure: false,
        allow_robert_ingest: false,          // observe mode (no live web)
        allow_hamilton_autopilot: false,     // skip browser automation
        allow_john_send: false,              // draft-only
      },
    })

    const finalRun = await waitForTerminal(db, run.id, 90_000)
    if (!finalRun || !TERMINAL.has(finalRun.status)) {
      const dbg = await listSteps(db, run.id)
      console.log('[fullcycle-debug] run status:', finalRun?.status,
        'steps:', dbg.map((s) => `${s.agent_name}:${s.step_name}=${s.status}`).join(' | '))
    }
    expect(finalRun, 'run should exist').toBeTruthy()
    expect(TERMINAL.has(finalRun.status), `run terminal? got ${finalRun.status}`).toBe(true)
    expect(finalRun.status, `run must not fail: ${finalRun.error_message || ''}`).not.toBe('failed')
    expect(finalRun.status, `preflight must not block the smoke cycle: ${finalRun.error_message || ''}`).not.toBe('blocked')

    const steps = await listSteps(db, run.id)
    expect(steps.length).toBeGreaterThanOrEqual(6) // sam pre, robert, yana, john, hamilton, sam post

    // sam-preflight-4: with no loopback probe (PORT='0') the two CRITICAL HTTP
    // checks are VISIBLY skipped on the preflight step's durable result.
    const preflight = steps.find((s) => s.step_name === 'sam_preflight')
    expect(preflight?.status).toBe('completed')
    const skipped = Array.isArray(preflight?.result?.skipped_critical_checks) ? preflight.result.skipped_critical_checks : []
    expect(skipped.map((s) => s.check_id).sort()).toEqual(['agent.hamilton.security', 'http.readyz'])
    for (const s of skipped) expect(s.reason).toBe('http_probe_unavailable')
    expect(preflight?.result?.critical_findings).toBe(0)

    for (const s of steps) {
      expect(
        OK_STEP_STATUSES.has(s.status),
        `step ${s.agent_name}:${s.step_name} ended '${s.status}' (error: ${s.error_message || 'none'})`,
      ).toBe(true)
      expect(
        s.error_message === undefined || s.error_message === null || s.error_message === '',
        `step ${s.agent_name}:${s.step_name} carried an error: ${s.error_message}`,
      ).toBe(true)
    }
  }, 120_000)

  it('status snapshot reports all six status agents (5 canonical + anya)', async () => {
    const status = await getControlCenterStatus(db)
    expect(status.admin_email).toBe(getCanonicalAdminEmail())
    expect(Object.keys(status.agents).sort()).toEqual(
      ['anya', 'hamilton', 'john', 'robert', 'sam', 'yana'],
    )
  })
})
