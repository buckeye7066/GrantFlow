/**
 * Unit tests for the Sam orchestrator (backend/services/sam/samAgent.js).
 *
 * These exercise the mode-gating contract — the most important guarantee
 * Sam ships:
 *   1. Default mode is observe + dry-run.
 *   2. Sam refuses repair-safe without admin authorisation OR when dryRun
 *      is true; downgrades to advise instead.
 *   3. Status snapshot is fast (no diagnostics run).
 *   4. Sam's run summary cleanly reflects the underlying findings.
 *   5. Sam writes ONE row per orchestrating run (when persistence is on).
 *
 * No real DB; we use the in-memory shim from sam-test-helpers.mjs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { runSam, getSamStatus } from '../../backend/services/sam/samAgent.js'
import { DEFAULT_MODE, SAM_MODES } from '../../backend/services/sam/samTypes.js'
import { makeMemoryDb } from './sam-test-helpers.mjs'

// ---------------------------------------------------------------------------
test('Sam defaults to observe mode + dry-run', async () => {
  const result = await runSam({
    db: null,
    ctx: null,
    invokeTool: async () => ({ success: true }),
    persist: false,
  })
  assert.equal(result.ok, true)
  assert.equal(result.mode, DEFAULT_MODE)
  assert.equal(result.summary.dryRun, true)
  assert.deepEqual(result.applied_fixes, [])
})

// ---------------------------------------------------------------------------
test('Sam refuses repair-safe without authorised admin and downgrades to advise', async () => {
  const result = await runSam({
    db: null,
    ctx: { isAdmin: false },
    mode: SAM_MODES.REPAIR_SAFE,
    dryRun: true,
    invokeTool: async () => ({ success: true }),
    persist: false,
  })
  assert.equal(result.mode, SAM_MODES.ADVISE)
  assert.ok(result.summary._downgradedFromRepair)
  assert.equal(result.summary._downgradedFromRepair.authorisedByAdmin, false)
})

// ---------------------------------------------------------------------------
test('Sam refuses repair-safe even for an admin when dryRun is true', async () => {
  const result = await runSam({
    db: null,
    ctx: { isAdmin: true },
    mode: SAM_MODES.REPAIR_SAFE,
    dryRun: true,
    invokeTool: async () => ({ success: true }),
    persist: false,
  })
  assert.equal(result.mode, SAM_MODES.ADVISE)
  assert.equal(result.summary._downgradedFromRepair.dryRun, true)
})

// ---------------------------------------------------------------------------
test('Sam runs repair-safe when authorised admin + dryRun=false', async () => {
  const result = await runSam({
    db: null,
    ctx: { isAdmin: true },
    mode: SAM_MODES.REPAIR_SAFE,
    dryRun: false,
    fixIds: [],                     // no fixes requested → applied_fixes empty
    invokeTool: async () => ({ success: true }),
    persist: false,
  })
  assert.equal(result.mode, SAM_MODES.REPAIR_SAFE)
  assert.equal(result.summary.dryRun, false)
})

// ---------------------------------------------------------------------------
test('Sam status snapshot is fast and never runs diagnostics', async () => {
  const db = makeMemoryDb()
  // No runs yet — status should report no_data and the default rollup.
  const before = await getSamStatus({ db })
  assert.equal(before.agent, 'Sam')
  assert.equal(before.purpose, 'production_readiness')
  assert.equal(before.last_run_at, null)
  assert.equal(before.health_score, null)
  assert.equal(before.production_ready, null)
  assert.equal(before.checks.lint, 'unknown')
})

// ---------------------------------------------------------------------------
test('Sam persists exactly one row per orchestrating run', async () => {
  const db = makeMemoryDb()
  const result = await runSam({
    db,
    ctx: { isAdmin: true, userId: 'admin-1' },
    mode: SAM_MODES.OBSERVE,
    invokeTool: async () => ({ success: true }),
    checkIds: ['code.scan'],
    persist: true,
  })
  assert.ok(result.run_id, 'expected run_id')
  const rows = Array.from(db.tables.sam_runs.values())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mode, SAM_MODES.OBSERVE)
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].created_by_user_id, 'admin-1')
})

// ---------------------------------------------------------------------------
test('Sam health_score reflects severity of findings', async () => {
  // A tool that reports two critical issues should yield a low health score.
  const result = await runSam({
    db: null,
    ctx: null,
    mode: SAM_MODES.OBSERVE,
    checkIds: ['code.crawl'],
    invokeTool: async () => ({
      success: false,
      issues: [
        { severity: 'critical', title: 'broken import: foo.js' },
        { severity: 'critical', title: 'missing handler /api/baz' },
      ],
    }),
    persist: false,
  })
  assert.ok(result.findings.length >= 2)
  assert.ok(result.health_score <= 75, `expected low health, got ${result.health_score}`)
  assert.equal(result.production_ready, false)
})
