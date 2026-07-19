/**
 * SECURITY REGRESSION (IDOR via Anya tool).
 *
 * application.completeStep is a NON-admin-invokable Anya tool. It previously
 * called completeApplicationStep(db, stepId) with NO authorization, so any user
 * who can invoke Anya tools could complete another profile's step by guessing
 * stepId, and a NULL-profile (orphan) step bypassed the applicationWorkflow.js
 * admin-only guard. The tool must resolve the owning application, verify a
 * supplied applicationId matches, and enforce profile access BEFORE mutating.
 */

import { describe, expect, it } from 'vitest'
import { invokeTool } from '../services/anyaToolRegistry.js'

// DB stub: `owner` is the resolved step→application row. Records whether the
// UPDATE (completeApplicationStep) actually ran.
function makeDb(owner) {
  const state = { mutated: false }
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const norm = String(sql).replace(/\s+/g, ' ').trim().toLowerCase()
      if (norm.includes('from application_steps s') && norm.includes('join grant_applications a')) {
        return { get: () => owner }
      }
      if (norm.startsWith('update application_steps')) {
        return { run: () => { state.mutated = true; return { changes: 1 } } }
      }
      if (norm.includes("status = 'pending'")) {
        return { get: () => null }
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) }
    },
  }
  return { db, state }
}

const NONADMIN = { userId: 'attacker', isAdmin: false, accessibleProfileIds: new Set(['own-profile']) }

describe('application.completeStep authorization', () => {
  it("DENIES a non-admin completing another profile's step (no mutation)", async () => {
    const { db, state } = makeDb({ application_id: 'app1', profile_id: 'victim-profile' })
    await expect(
      invokeTool('application.completeStep', { stepId: 's1' }, { db, ctx: NONADMIN }),
    ).rejects.toThrow(/not authorized/i)
    expect(state.mutated).toBe(false)
  })

  it('DENIES a non-admin completing an orphan (NULL profile_id) step', async () => {
    const { db, state } = makeDb({ application_id: 'app1', profile_id: null })
    await expect(
      invokeTool('application.completeStep', { stepId: 's1' }, { db, ctx: NONADMIN }),
    ).rejects.toThrow(/not authorized/i)
    expect(state.mutated).toBe(false)
  })

  it('rejects a spoofed applicationId that does not match the step', async () => {
    const { db, state } = makeDb({ application_id: 'realApp', profile_id: 'own-profile' })
    await expect(
      invokeTool('application.completeStep', { stepId: 's1', applicationId: 'someone-elses-app' }, { db, ctx: NONADMIN }),
    ).rejects.toThrow(/does not match/i)
    expect(state.mutated).toBe(false)
  })

  it('ALLOWS a user with access to the owning profile (mutation runs)', async () => {
    const { db, state } = makeDb({ application_id: 'app1', profile_id: 'own-profile' })
    const res = await invokeTool('application.completeStep', { stepId: 's1' }, { db, ctx: NONADMIN })
    expect(state.mutated).toBe(true)
    // invokeTool wraps the handler result as { id, tool, output }.
    expect(res.output.step_id).toBe('s1')
    expect(res.output.application_id).toBe('app1')
  })

  it('ALLOWS an admin to complete an orphan (NULL profile_id) step', async () => {
    const { db, state } = makeDb({ application_id: 'app1', profile_id: null })
    await invokeTool('application.completeStep', { stepId: 's1' }, { db, ctx: { userId: 'root', isAdmin: true, accessibleProfileIds: null } })
    expect(state.mutated).toBe(true)
  })

  it('returns 404 when the step does not exist', async () => {
    const { db, state } = makeDb(undefined)
    await expect(
      invokeTool('application.completeStep', { stepId: 'missing' }, { db, ctx: NONADMIN }),
    ).rejects.toThrow(/not found/i)
    expect(state.mutated).toBe(false)
  })
})
