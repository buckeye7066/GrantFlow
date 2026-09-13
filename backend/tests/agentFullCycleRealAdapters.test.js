import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import {
  startRun,
  getControlCenterStatus,
  getCanonicalAdminEmail,
} from '../services/agentControl/agentControlOrchestrator.js'
import { getRun, listSteps } from '../services/agentControl/agentControlStore.js'
import { resetRegistry, setAdapter } from '../services/agentControl/agentAdapters/agentAdapterRegistry.js'
import { SamAgentAdapter } from '../services/agentControl/agentAdapters/samAgentAdapter.js'
import { runSam } from '../services/sam/samAgent.js'

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

  it("REAL SERVER: a readyz 503 preflight finalises as terminal blocked on the migrated sqlite schema, names the prerequisite, and emits exactly ONE admin notification", async () => {
    // The unit harness builds agent_control_runs from agentControlStore's own
    // DDL (no CHECK). The real server bootstraps sqlite from schema.sql, whose
    // status CHECK is the one a deployment actually hits — if 'blocked' is not
    // in it, setRunStatus throws and the orchestrator demotes the run to
    // 'failed' ("Orchestrator crashed: CHECK constraint failed"). This drives
    // the REAL adapter + REAL runSam (persist:true → sam_runs row → escalation
    // path) with only the loopback probe injected.
    const READYZ_MISSION_GATE_BODY = {
      ok: false,
      status: 'not_ready',
      reason: 'mission_gate_failed',
      release_blockers: ['release_catalog_verified_pct_below_target', 'visible_direct_link_requirement_failed'],
    }
    setAdapter('sam', new SamAgentAdapter({
      runSam: (args) => runSam({ ...args, checkIds: ['http.readyz', 'agent.hamilton.security'], emailReport: false }),
      httpProbe: async ({ path }) => (path === '/readyz'
        ? { status: 503, body: READYZ_MISSION_GATE_BODY }
        : { status: 200, body: { ok: true } }),
      env: { NODE_ENV: 'production', PORT: '3911', ADMIN_TOKEN: 'test-admin-token' },
    }))

    // Notifications persist across resetDb (the previous full cycle left its
    // agent_control_started/completed rows), so count only the rows THIS run
    // adds.
    const notificationIdsBefore = new Set(db.prepare('SELECT id FROM notifications').all().map((r) => r.id))

    const { run } = await startRun(db, {
      runType: 'full_cycle',
      user: adminUser(),
      options: {
        stop_on_critical_sam_finding: true,
        allow_robert_ingest: false,
        allow_hamilton_autopilot: false,
        allow_john_send: false,
      },
    })
    const finalRun = await waitForTerminal(db, run.id, 60_000)
    expect(finalRun, 'run should exist').toBeTruthy()
    expect(finalRun.status, `run must be terminal 'blocked', not '${finalRun.status}': ${finalRun.error_message || ''}`).toBe('blocked')
    for (const needle of ['http.readyz', 'mission_gate_failed', 'release_catalog_verified_pct_below_target', 'visible_direct_link_requirement_failed', 'POST /api/admin/verify-links']) {
      expect(String(finalRun.error_message), `run.error_message names ${needle}`).toContain(needle)
    }
    expect(finalRun.summary?.blocked_by?.blocked_detail?.prerequisites?.map((p) => p.code)).toEqual([
      'release_catalog_verified_pct_below_target',
      'visible_direct_link_requirement_failed',
    ])

    const steps = await listSteps(db, run.id)
    expect(steps.find((s) => s.step_name === 'sam_preflight')?.status).toBe('blocked')
    const robert = steps.find((s) => s.step_name === 'robert_main')
    expect(robert?.status).toBe('skipped')
    expect(robert?.error_message).toBe('sam_preflight_blocked')

    // The Sam run persisted on the real DB and is linked from the block.
    const samRunId = finalRun.summary?.blocked_by?.sam_run_id
    expect(samRunId, 'blocked_by.sam_run_id').toBeTruthy()
    const samRow = db.prepare('SELECT id, status FROM sam_runs WHERE id = ?').get(samRunId)
    expect(samRow?.status).toBe('completed')

    // Exactly ONE admin notification for the block (the named one).
    const rows = db.prepare("SELECT id, type, message FROM notifications WHERE type LIKE 'agent_control_%' ORDER BY created_at").all()
      .filter((r) => !notificationIdsBefore.has(r.id) && r.type !== 'agent_control_started')
    expect(rows.map((r) => r.type), rows.map((r) => `${r.type}: ${r.message}`).join(' || ')).toEqual(['agent_control_agent_blocked'])
    expect(rows[0].message).toContain('http.readyz')
  }, 120_000)

  it('status snapshot reports all six status agents (5 canonical + anya)', async () => {
    const status = await getControlCenterStatus(db)
    expect(status.admin_email).toBe(getCanonicalAdminEmail())
    expect(Object.keys(status.agents).sort()).toEqual(
      ['anya', 'hamilton', 'john', 'robert', 'sam', 'yana'],
    )
  })
})
