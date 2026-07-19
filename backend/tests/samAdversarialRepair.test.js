/**
 * Sam's opt-in adversarial-repair path. Gated OFF by default so it never fires
 * on the scheduler; only manual-strategy findings with SAFE affected files are
 * eligible; only a clean verdict lands (via the injected landPatch). No network.
 */
import { describe, it, expect } from 'vitest'
import { runAdversarialRepairs, isManualCodeEditPlan } from '../services/sam/samAdversarialRepair.js'

const manualFinding = {
  id: 'f1',
  title: 'unhandled 500',
  description: 'route throws unstructured',
  category: 'route_integrity',
  severity: 'high',
  affected_files: ['src/components/Example.jsx'], // under an ALLOWED root for Sam
}
const manualPlan = { finding_id: 'f1', strategy: 'investigate-route (manual)' }

describe('isManualCodeEditPlan', () => {
  it('true only for a manual strategy', () => {
    expect(isManualCodeEditPlan({ strategy: 'restore-build (manual)' })).toBe(true)
    expect(isManualCodeEditPlan({ strategy: 'safe-fix:lint.eslint-fix-file' })).toBe(false)
    expect(isManualCodeEditPlan(null)).toBe(false)
  })
})

describe('runAdversarialRepairs — gating', () => {
  it('is INERT when SAM_ADVERSARIAL_REPAIR is off (default)', async () => {
    let generated = false
    const out = await runAdversarialRepairs({
      findings: [manualFinding],
      repairPlan: [manualPlan],
      env: {}, // flag off
      generateRepair: async () => { generated = true; return { status: 'clean', diff: 'x' } },
      landPatch: async () => ({ ok: true }),
      isEditLockPresent: () => false,
      readFile: async () => 'code',
    })
    expect(out.enabled).toBe(false)
    expect(out.attempted).toBe(0)
    expect(generated).toBe(false)
  })

  it('refuses to run while the edit lock is held', async () => {
    const out = await runAdversarialRepairs({
      findings: [manualFinding],
      repairPlan: [manualPlan],
      env: { SAM_ADVERSARIAL_REPAIR: '1' },
      isEditLockPresent: () => true,
      generateRepair: async () => ({ status: 'clean', diff: 'x' }),
      landPatch: async () => ({ ok: true }),
      readFile: async () => 'code',
    })
    expect(out.enabled).toBe(true)
    expect(out.skipped).toBe('edit_lock_held')
  })

  it('a clean verdict lands via landPatch (branch/PR); a non-clean verdict lands nothing', async () => {
    const landed = []
    const out = await runAdversarialRepairs({
      findings: [manualFinding, { ...manualFinding, id: 'f2', title: 'flaky test' }],
      repairPlan: [manualPlan, { finding_id: 'f2', strategy: 'fix-failing-test (manual)' }],
      env: { SAM_ADVERSARIAL_REPAIR: 'true', SAM_AUTO_COMMIT_ALLOWED: 'true' },
      isEditLockPresent: () => false,
      readFile: async () => 'code',
      generateRepair: async ({ finding }) =>
        finding.title === manualFinding.title
          ? { status: 'clean', diff: 'diff --git a/src/x b/src/x', rounds: 1 }
          : { status: 'unverified', diff: null, rounds: 1, reason: 'verifier down' },
      landPatch: async (a) => { landed.push(a); return { ok: true, dispatched: true, land_mode: 'pr' } },
    })
    expect(out.proposals.length).toBe(1)
    expect(landed.length).toBe(1)
    // the unverified finding is recorded as a note, applied nothing
    expect(out.notes.some((n) => n.outcome === 'unverified')).toBe(true)
  })

  it('skips a finding whose affected files are NOT all safe (forbidden path)', async () => {
    let generated = false
    const out = await runAdversarialRepairs({
      findings: [{ ...manualFinding, affected_files: ['backend/db/migrations/9.sql'] }],
      repairPlan: [manualPlan],
      env: { SAM_ADVERSARIAL_REPAIR: '1' },
      isEditLockPresent: () => false,
      generateRepair: async () => { generated = true; return { status: 'clean', diff: 'x' } },
      landPatch: async () => ({ ok: true }),
      readFile: async () => 'code',
    })
    expect(generated).toBe(false)
    expect(out.notes.some((n) => n.reason === 'affected_files_not_all_safe')).toBe(true)
  })
})

describe('runAdversarialRepairs — DB-authoritative config wiring', () => {
  it('config.enabled=false makes it INERT even if env says ON (DB wins)', async () => {
    let generated = false
    const out = await runAdversarialRepairs({
      findings: [manualFinding],
      repairPlan: [manualPlan],
      env: { SAM_ADVERSARIAL_REPAIR: '1' }, // env ON...
      config: { enabled: false, landMode: 'pr', allowCritical: false }, // ...but DB config OFF
      isEditLockPresent: () => false,
      generateRepair: async () => { generated = true; return { status: 'clean', diff: 'x' } },
      landPatch: async () => ({ ok: true }),
      readFile: async () => 'code',
    })
    expect(out.enabled).toBe(false)
    expect(generated).toBe(false)
  })

  it('config land mode + allowCritical are threaded into landPatch', async () => {
    let landArgs = null
    const out = await runAdversarialRepairs({
      findings: [manualFinding],
      repairPlan: [manualPlan],
      env: {},
      config: { enabled: true, landMode: 'direct', allowCritical: true },
      isEditLockPresent: () => false,
      readFile: async () => 'code',
      policy: { auto_commit_allowed: true, direct_main_commit: false, auto_fix_safe: true, auto_branch_risky: true },
      generateRepair: async () => ({ status: 'clean', diff: 'diff --git a/src/x b/src/x', rounds: 1 }),
      landPatch: async (a) => { landArgs = a; return { ok: true, dispatched: true, land_mode: 'direct' } },
    })
    expect(out.enabled).toBe(true)
    expect(out.land_mode).toBe('direct')
    expect(landArgs.landMode).toBe('direct')
    expect(landArgs.allowCritical).toBe(true)
  })
})
