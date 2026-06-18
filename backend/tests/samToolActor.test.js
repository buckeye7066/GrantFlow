import { describe, expect, it, vi } from 'vitest'
import { runDiagnostics, samToolActor } from '../services/sam/samDiagnostics.js'

// Mirrors anyaOrchestrator.invokeTool's gate: it throws unless the actor is an
// authenticated admin. Sam must pass such an actor even when run autonomously.
function assertAuthenticatedAdmin(user) {
  if (!user || !user.userId) {
    const e = new Error('Authentication required')
    e.status = 401
    throw e
  }
  if (user.isAdmin !== true && user.is_admin !== true && user.role !== 'admin') {
    const e = new Error('admin privileges required')
    e.status = 403
    throw e
  }
}

describe('samToolActor', () => {
  it('synthesizes a trusted system admin when there is no request ctx (scheduler/agent-control)', () => {
    const actor = samToolActor(null)
    expect(actor.userId).toBe('system_admin_token')
    expect(actor.isAdmin).toBe(true)
    expect(actor.is_admin).toBe(true)
    expect(actor.role).toBe('admin')
    expect(() => assertAuthenticatedAdmin(actor)).not.toThrow()
  })

  it('preserves the caller identity but guarantees admin flags for an admin request', () => {
    const actor = samToolActor({ userId: 'real-admin-1', email: 'admin@example.com', isAdmin: true })
    expect(actor.userId).toBe('real-admin-1')
    expect(actor.email).toBe('admin@example.com')
    expect(actor.isAdmin).toBe(true)
    expect(() => assertAuthenticatedAdmin(actor)).not.toThrow()
  })
})

describe('Sam tool checks invoke the dispatcher as an authenticated admin', () => {
  it('does NOT produce "Tool invocation failed" when ctx is null (the scheduler case)', async () => {
    const seen = []
    // Stand-in dispatcher that enforces the same auth contract as the real
    // anyaOrchestrator.invokeTool. Under the old code (ctx passed straight
    // through as null) this would throw -> "Tool invocation failed".
    const invokeTool = vi.fn(async (db, user, toolName) => {
      seen.push({ toolName, user })
      assertAuthenticatedAdmin(user)
      return { success: true, ok: true, message: `${toolName} ran` }
    })

    const { findings, results } = await runDiagnostics({
      db: null,
      ctx: null, // <- exactly what samScheduler passes for autonomous runs
      checkIds: ['health.check'],
      invokeTool,
    })

    expect(invokeTool).toHaveBeenCalledTimes(1)
    // The dispatcher received an authenticated admin actor, not null.
    expect(seen[0].user.userId).toBeTruthy()
    expect(seen[0].user.isAdmin).toBe(true)

    const failed = findings.filter((f) => /Tool invocation failed/i.test(f.title || ''))
    expect(failed).toHaveLength(0)
    expect(results[0]).toMatchObject({ check_id: 'health.check', ok: true })
  })
})
